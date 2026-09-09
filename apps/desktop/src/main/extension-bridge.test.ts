import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionBridge, newPairingToken } from "./extension-bridge.js";

const TOKEN = newPairingToken();
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

// A port of its own per test, so a poll left open by one test can never be
// mistaken for the next test's extension attaching.
let nextPort = 8400;
let bridge: ExtensionBridge | null = null;
let port = 0;
const openCalls: Array<{ abort: () => void }> = [];

type Reply = { status: number; body: string };

// node:http rather than fetch, because fetch treats Origin as a forbidden
// header and silently drops it, which would make every request here look like
// it came from something other than an extension.
function call(
  path: string,
  options: { method?: string; token?: string | null; origin?: string | null; body?: string; hold?: boolean } = {}
): Promise<Reply> & { abort: () => void } {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.origin !== null) headers.origin = options.origin ?? EXT_ORIGIN;
  let abort = (): void => undefined;
  const promise = new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    abort = () => req.destroy();
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  promise.catch(() => undefined);
  const handle = promise as Promise<Reply> & { abort: () => void };
  handle.abort = () => abort();
  return handle;
}

async function startBridge(): Promise<ExtensionBridge> {
  port = nextPort;
  nextPort += 1;
  const started = new ExtensionBridge();
  await started.start(TOKEN, port);
  bridge = started;
  return started;
}

/** Start a long poll the way the extension does, and wait until the bridge has
 * actually registered it, so a test never races the connection. */
async function attach(started: ExtensionBridge): Promise<{ poll: Promise<Reply> }> {
  const poll = call("/poll");
  openCalls.push(poll);
  for (let i = 0; i < 200 && !started.isConnected(); i += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  if (!started.isConnected()) throw new Error("the bridge never saw the poll");
  // Wrapped, because awaiting an async function that returns a promise unwraps
  // it, which would mean waiting out the whole 25 second hold.
  return { poll };
}

afterEach(async () => {
  for (const open of openCalls.splice(0)) open.abort();
  await bridge?.stop();
  bridge = null;
});

describe("the bridge to the browser the user already has open", () => {
  it("refuses a request with no token, a wrong token, or a wrong token of the right length", async () => {
    await startBridge();
    expect((await call("/poll", { token: null })).status).toBe(401);
    expect((await call("/poll", { token: "nope" })).status).toBe(401);
    // Same length as a real token, so the comparison itself is exercised rather
    // than only the length check standing in front of it.
    expect((await call("/poll", { token: "x".repeat(TOKEN.length) })).status).toBe(401);
  });

  it("refuses a correct token from anything that is not an extension", async () => {
    // This is what stops another program on the machine, or a web page, from
    // driving the browser even if it somehow learned the code.
    await startBridge();
    expect((await call("/poll", { origin: null })).status).toBe(401);
    expect((await call("/poll", { origin: "https://evil.example.com" })).status).toBe(401);
  });

  it("reports not connected until the extension polls", async () => {
    const started = await startBridge();
    expect(started.isConnected()).toBe(false);
    await attach(started);
    expect(started.isConnected()).toBe(true);
  });

  it("refuses to run anything while no extension is attached", async () => {
    const started = await startBridge();
    await expect(started.run({ kind: "browser", command: "snapshot" })).rejects.toThrow(/not connected/i);
  });

  it("hands an action to the waiting poll and resolves with its result", async () => {
    const started = await startBridge();
    const { poll } = await attach(started);
    const running = started.run({ kind: "browser", command: "snapshot" });
    const delivered = JSON.parse((await poll).body) as { id: string; action: { command: string } };
    expect(delivered.action.command).toBe("snapshot");
    await call("/result", {
      method: "POST",
      body: JSON.stringify({ id: delivered.id, ok: true, output: "Page: Example" })
    });
    await expect(running).resolves.toContain("Example");
  });

  it("turns a failed step into a rejection the run loop can report", async () => {
    const started = await startBridge();
    const { poll } = await attach(started);
    const running = started.run({ kind: "browser", command: "click", target: "e9" });
    // The expectation is attached before the result is posted. Attaching it
    // afterwards leaves the rejection briefly unhandled, which Node reports as
    // an unhandled rejection and fails the run even though every test passed.
    const settled = expect(running).rejects.toThrow(/no longer on the page/);
    const delivered = JSON.parse((await poll).body) as { id: string };
    await call("/result", {
      method: "POST",
      body: JSON.stringify({ id: delivered.id, ok: false, output: "That element is no longer on the page." })
    });
    await settled;
  });

  it("validates the action here, so the extension is never asked to run a shape the app rejects", async () => {
    const started = await startBridge();
    await attach(started);
    await expect(started.run({ kind: "browser", command: "evaluate", value: "alert(1)" })).rejects.toThrow();
    await expect(started.run({ kind: "browser", command: "batch", steps: [] })).rejects.toThrow();
  });

  it("ignores a result for something nobody is waiting on", async () => {
    // A late answer to a turn that already timed out must not error, or the
    // extension would retry forever against a caller that has gone.
    await startBridge();
    const reply = await call("/result", {
      method: "POST",
      body: JSON.stringify({ id: "does-not-exist", ok: true, output: "hi" })
    });
    expect(reply.status).toBe(200);
  });

  it("fails actions still in flight when it stops, instead of leaving the run hanging", async () => {
    const started = await startBridge();
    await attach(started);
    // Delivered to the extension but never answered: exactly the case where a
    // shutdown used to leave the caller waiting for its full timeout.
    const inFlight = started.run({ kind: "browser", command: "snapshot" });
    const settled = expect(inFlight).rejects.toThrow(/closed/i);
    await started.stop();
    bridge = null;
    await settled;
  });
});
