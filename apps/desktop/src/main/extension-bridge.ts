import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { browserActionSchema } from "@workcrew/contracts";

// The bridge that lets WorkCrew drive the browser the user already has open.
//
// The other surface (browser-cli) launches a separate Chrome over the DevTools
// protocol, which can never reach the user's everyday profile: Chrome refuses
// remote debugging on it. An extension runs INSIDE that profile, so it inherits
// the sessions they are already signed into. An extension cannot open a port,
// so the app opens one and the extension talks to it.
//
// Plain HTTP rather than a WebSocket, so the app gains no new dependency.
// Delivery is still immediate: the extension holds a long poll open, and a
// queued command is handed straight to that waiting request.

const HOST = "127.0.0.1";
export const DEFAULT_EXTENSION_PORT = 8317;
// How long a poll is held before answering "nothing yet". Comfortably under the
// 30 second idle timeout that would otherwise stop the extension worker.
const POLL_HOLD_MS = 25_000;
// How long one action may take before the turn gives up. Long enough for a slow
// page load, short enough that a wedged tab cannot hang a run forever.
const COMMAND_TIMEOUT_MS = 60_000;
// A poll seen more recently than this means the extension is attached.
const CONNECTED_WINDOW_MS = 40_000;
const MAX_BODY_BYTES = 1_000_000;

type Pending = {
  id: string;
  action: unknown;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Waiter = (command: { id: string; action: unknown } | null) => void;

// Constant time, and it does not leak the length of the real token either.
function tokensMatch(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function newPairingToken(): string {
  return randomBytes(32).toString("base64url");
}

export class ExtensionBridge {
  private server: Server | null = null;
  private token = "";
  private port = DEFAULT_EXTENSION_PORT;
  private queue: Pending[] = [];
  private waiters: Waiter[] = [];
  private lastPollMs = 0;
  private byId = new Map<string, Pending>();

  // True when the extension has polled recently enough to count as attached.
  isConnected(): boolean {
    return this.lastPollMs > 0 && Date.now() - this.lastPollMs < CONNECTED_WINDOW_MS;
  }

  listenPort(): number {
    return this.port;
  }

  running(): boolean {
    return this.server !== null;
  }

  async start(token: string, port = DEFAULT_EXTENSION_PORT): Promise<void> {
    this.token = token;
    if (this.server) return;
    this.port = port;
    const server = createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Loopback only, so nothing off this machine can reach it.
      server.listen(port, HOST, () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    // Everything still in flight, including actions the extension has already
    // been handed but not answered. Rejecting them now turns a shutdown into an
    // immediate, explainable failure instead of a turn that sits there until
    // its timeout with nothing left to answer it.
    this.queue.length = 0;
    for (const pending of this.byId.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The browser connection was closed."));
    }
    this.byId.clear();
    this.lastPollMs = 0;
    if (server) {
      // A held poll is a live connection, and close() alone waits for it to end
      // on its own, which is up to the full hold time. Dropping the sockets
      // first is what makes quitting the app immediate.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // Hand one action to the extension and wait for its result. The action is
  // validated HERE, so the extension is only ever asked to run a shape the app
  // already accepts and is not a second place the allowlist could drift.
  async run(rawAction: unknown): Promise<string> {
    if (!this.server) throw new Error("The browser connection is not running.");
    if (!this.isConnected()) {
      throw new Error("Your browser is not connected. Open Chrome with the WorkCrew extension installed, then try again.");
    }
    const action = browserActionSchema.parse(rawAction);
    const id = randomBytes(9).toString("base64url");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.byId.delete(id);
        this.queue = this.queue.filter((item) => item.id !== id);
        reject(new Error("The browser did not answer in time."));
      }, COMMAND_TIMEOUT_MS);
      const pending: Pending = { id, action, resolve, reject, timer };
      this.byId.set(id, pending);
      const waiter = this.waiters.shift();
      if (waiter) waiter({ id, action });
      else this.queue.push(pending);
    });
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.token) return false;
    const header = request.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!supplied || !tokensMatch(supplied, this.token)) return false;
    // Only the extension should be calling this. A web page cannot forge this
    // origin, and a request with no origin at all (another local program) is
    // refused even if it somehow learned the token.
    return (request.headers.origin ?? "").startsWith("chrome-extension://");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, this.corsHeaders(request));
      response.end();
      return;
    }
    if (!this.authorized(request)) {
      response.writeHead(401, this.corsHeaders(request));
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/poll" && request.method === "GET") {
      this.lastPollMs = Date.now();
      await this.poll(request, response);
      return;
    }
    if (url.pathname === "/result" && request.method === "POST") {
      this.lastPollMs = Date.now();
      await this.result(request, response);
      return;
    }
    response.writeHead(404, this.corsHeaders(request));
    response.end();
  }

  private corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin ?? "";
    return {
      "content-type": "application/json",
      // Echoed back only for an extension origin, which authorized() already
      // requires, so this never opens the port up to an ordinary web page.
      "access-control-allow-origin": origin.startsWith("chrome-extension://") ? origin : "null",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    };
  }

  private async poll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const next = this.queue.shift();
    if (next) {
      response.writeHead(200, this.corsHeaders(request));
      response.end(JSON.stringify({ id: next.id, action: next.action }));
      return;
    }
    // Nothing queued: hold the request open, so a command issued a moment from
    // now goes out instantly instead of waiting for the next poll to come round.
    await new Promise<void>((done) => {
      let settled = false;
      const finish = (command: { id: string; action: unknown } | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        response.writeHead(command ? 200 : 204, this.corsHeaders(request));
        response.end(command ? JSON.stringify(command) : undefined);
        done();
      };
      const waiter: Waiter = (command) => finish(command);
      const timer = setTimeout(() => finish(null), POLL_HOLD_MS);
      request.on("close", () => finish(null));
      this.waiters.push(waiter);
    });
  }

  private async result(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    let parsed: { id?: unknown; ok?: unknown; output?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      response.writeHead(400, this.corsHeaders(request));
      response.end(JSON.stringify({ error: "bad json" }));
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const pending = this.byId.get(id);
    if (!pending) {
      // Late or unknown result. Accepted quietly: whatever turn it belonged to
      // has already timed out and reported, and erroring here would only make
      // the extension retry something nobody is waiting for.
      response.writeHead(200, this.corsHeaders(request));
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    this.byId.delete(id);
    this.queue = this.queue.filter((item) => item.id !== id);
    clearTimeout(pending.timer);
    const output = typeof parsed.output === "string" ? parsed.output : "";
    if (parsed.ok === false) pending.reject(new Error(output || "That step could not be completed."));
    else pending.resolve(output);
    response.writeHead(200, this.corsHeaders(request));
    response.end(JSON.stringify({ ok: true }));
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("The browser sent too much data."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
