import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } from "electron";
import {
  APP_NAME,
  SUPPORT_EMAIL,
  recordedEventSchema,
  summarizeRecordingRequestSchema,
  chatSendSchema,
  chatDeltaFrameSchema,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  type RecordedEvent,
  type ChatDeltaFrame
} from "@workcrew/contracts";
import { z } from "zod";
import { ApiClient } from "./api-client.js";
import { AuthVault } from "./auth-vault.js";
import { BrowserCli } from "./browser-cli.js";
import { getBackendUrl, setBackendUrl } from "./settings.js";
import { transcribeSamples } from "./transcription.js";
import { checkForUpdates, installUpdate, startupUpdateCheck } from "./updater.js";
import { closeAutomationOverlay, setAutomationOverlay } from "./overlay.js";
import { WindowsAgent } from "./windows-agent.js";

const auth = new AuthVault();
const api = new ApiClient(auth);
const browserCli = new BrowserCli();
const windowsAgent = new WindowsAgent();
let mainWindow: BrowserWindow | null = null;

// One AbortController per in-flight chat stream, keyed by the renderer-supplied
// request id so chat:stop can cancel exactly the right stream.
const chatStreams = new Map<string, AbortController>();

// Attachment uploads are serialized through this promise chain. Dragging in many
// files fires one upload call per file at the same time; running them one after
// another avoids concurrent attachment writes on the backend (which can fail
// under SQLite write contention), so a multi-file drop no longer drops files.
let attachmentUploadChain: Promise<unknown> = Promise.resolve();

console.info("[WorkCrew] main process loaded");

// The shape the renderer sends for a chat turn. requestId is generated in the
// preload; the rest matches chatSendSchema so the body can be validated before
// it leaves the desktop.
const chatSendIpcSchema = chatSendSchema.extend({
  requestId: z.string().min(1).max(200)
}).strict();

// Deliver a single frame for a request id to the renderer. The webContents may
// have gone away (window closed), in which case the send is simply dropped.
function sendChatFrame(requestId: string, frame: ChatDeltaFrame): void {
  const target = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (target && !target.isDestroyed()) {
    target.webContents.send("chat:delta", { requestId, frame });
  }
}

// Open the streaming chat endpoint, read the text/event-stream body, split it on
// blank lines, parse each "data:" line as a ChatDeltaFrame, and forward every
// frame to the renderer. Any failure is reported to the renderer as an error
// frame carrying the same request id so the UI can recover.
async function streamChat(requestId: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  chatStreams.set(requestId, controller);
  try {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("Sign in is required");

    const response = await fetch(`${getBackendUrl()}/v1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      let message = "The chat service is unavailable";
      try {
        const text = await response.text();
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // Non-JSON or empty error body; keep the generic message.
      }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Frames are separated by a blank line. We accumulate bytes and flush each
    // complete event (everything up to the next blank line) as it arrives.
    const flush = (chunk: string): void => {
      const events = chunk.split(/\n\n/);
      for (const event of events) {
        const line = event.split(/\n/).find((entry) => entry.startsWith("data:"));
        if (!line) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const frame = chatDeltaFrameSchema.parse(JSON.parse(json));
          sendChatFrame(requestId, frame);
        } catch {
          // A malformed or unrecognized frame is skipped rather than aborting
          // the whole stream.
        }
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary !== -1) {
        flush(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) flush(buffer);
  } catch (error) {
    // An abort is an intentional stop, not a failure, so no error frame is sent.
    if (controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : "The chat request failed";
    sendChatFrame(requestId, { type: "error", message });
  } finally {
    chatStreams.delete(requestId);
  }
}

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(128)
}).strict();

// The list of picked files the renderer asks to upload.
const pickedFilesSchema = z.array(z.object({
  path: z.string().min(1).max(4_096),
  name: z.string().min(1).max(500),
  size: z.number().int().min(0)
}).strict()).max(20);

// Largest file the desktop will read and upload, mirroring the backend limit so
// an oversized file is rejected with a clear message before any network call.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// A small extension to mime-type guess. The backend classifies primarily by
// extension, so this is a friendly hint rather than the source of truth.
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "text/xml"
};

function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function createWindow(): void {
  console.info("[WorkCrew] creating main window");
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    icon: join(__dirname, "../../resources/icon.ico"),
    width: 1_440,
    height: 920,
    minWidth: 1_040,
    minHeight: 700,
    show: false,
    backgroundColor: "#1F1E1D",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  });
  mainWindow.setTitle(APP_NAME);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL;
    if (!allowed || !url.startsWith(allowed)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Destroy the overlay when the main window closes. It is a separate top-level
  // window, so leaving it alive would stop "window-all-closed" from firing and the
  // app would never quit on Windows/Linux.
  mainWindow.on("closed", () => { closeAutomationOverlay(); mainWindow = null; });

  const capturePath = process.env.WORKCREW_CAPTURE;
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      void (async () => {
        const target = ".app-shell, .paywall-shell, .auth-shell";
        const deadline = Date.now() + 45_000;
        try {
          while (Date.now() < deadline) {
            const ready = await mainWindow!.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(target)}))`);
            if (ready) break;
            await new Promise((done) => setTimeout(done, 400));
          }
          await new Promise((done) => setTimeout(done, 600));
          const image = await mainWindow!.webContents.capturePage();
          await import("node:fs/promises").then((fs) => fs.writeFile(capturePath, image.toPNG()));
          console.info(`[WorkCrew] capture written to ${capturePath}`);
        } catch (error) {
          console.error("[WorkCrew] capture failed", error);
        } finally {
          app.quit();
        }
      })();
    });
  }
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[WorkCrew] renderer failed to load (${code}): ${description}`);
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function registerIpc(): void {
  // app:info reports the auth and billing modes of the BACKEND the app is
  // pointed at (not this PC's local env), so the paywall renders the correct
  // flow: real Stripe checkout against a stripe-mode backend, or test activation
  // against a simulated-mode one. Falls back to local env if the backend is
  // unreachable.
  ipcMain.handle("app:info", async () => {
    let authMode = process.env.AUTH_MODE ?? "local";
    let billingMode = process.env.BILLING_MODE ?? "simulated";
    try {
      const response = await fetch(`${getBackendUrl()}/health`, { signal: AbortSignal.timeout(8_000) });
      if (response.ok) {
        const health = (await response.json()) as { authMode?: string; billingMode?: string };
        if (health.authMode) authMode = health.authMode;
        if (health.billingMode) billingMode = health.billingMode;
      }
    } catch {
      // Backend unreachable; keep the local-env fallback so the app still loads.
    }
    return { name: APP_NAME, version: app.getVersion(), authMode, billingMode };
  });

  // Settings: the user-configurable backend URL. get returns the active URL,
  // set validates and persists a new one (taking effect on the next request).
  ipcMain.handle("settings:get-backend-url", () => getBackendUrl());
  ipcMain.handle("settings:set-backend-url", (_event, raw) => setBackendUrl(z.string().min(1).max(2_048).parse(raw)));

  // Auto-update: check on demand and install a downloaded update. Both are safe
  // no-ops in an unpackaged (development) build.
  ipcMain.handle("updates:check", (_event, manual?: boolean) => checkForUpdates(manual === true));
  ipcMain.handle("updates:install", () => installUpdate());
  ipcMain.handle("auth:session", () => auth.getSession());
  ipcMain.handle("auth:sign-in", async (_event, raw) => {
    const value = credentialsSchema.parse(raw);
    await auth.signIn(value.email, value.password);
    return auth.getSession();
  });
  ipcMain.handle("auth:sign-up", async (_event, raw) => {
    const value = credentialsSchema.extend({ referralCode: z.string().max(40).optional() }).parse(raw);
    return auth.signUp(value.email, value.password, value.referralCode);
  });
  ipcMain.handle("auth:reset", async (_event, email) => auth.sendPasswordReset(z.string().email().max(320).parse(email)));
  ipcMain.handle("auth:sign-out", async () => auth.signOut());

  ipcMain.handle("api:entitlement", () => api.request("/v1/entitlement"));
  ipcMain.handle("api:referral", () => api.request("/v1/referral"));
  // Simulated checkout: writes a Stripe-shaped active entitlement through the
  // backend. Used when BILLING_MODE is "simulated" (no real payment).
  ipcMain.handle("api:simulate", (_event, raw) => api.request("/v1/billing/simulate", { method: "POST", body: createCheckoutSchema.parse(raw) }));
  ipcMain.handle("api:checkout", async (_event, raw) => {
    const result = await api.request<{ url: string }>("/v1/billing/checkout", { method: "POST", body: createCheckoutSchema.parse(raw) });
    await shell.openExternal(result.url);
    return { opened: true };
  });
  // Change an existing subscription's plan in place (Pro to Ultra) and return the
  // updated entitlement, instead of opening a second checkout.
  ipcMain.handle("api:change-plan", (_event, raw) => api.request("/v1/billing/change-plan", { method: "POST", body: createCheckoutSchema.parse(raw) }));
  ipcMain.handle("api:portal", async () => {
    const result = await api.request<{ url: string }>("/v1/billing/portal", { method: "POST" });
    await shell.openExternal(result.url);
    return { opened: true };
  });
  ipcMain.handle("api:create-run", (_event, raw) => api.request("/v1/runs", { method: "POST", body: createRunSchema.parse(raw) }));
  ipcMain.handle("api:next-run", (_event, runId, raw) => {
    const safeRunId = z.string().uuid().parse(runId);
    return api.request(`/v1/runs/${safeRunId}/next`, { method: "POST", body: nextRunStepSchema.parse(raw ?? {}) });
  });

  ipcMain.handle("dialog:open-files", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Add files or photos",
      buttonLabel: "Add",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Documents and images", extensions: ["pdf", "txt", "md", "csv", "doc", "docx", "xls", "xlsx", "png", "jpg", "jpeg", "gif", "webp"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled) return [];
    const fs = await import("node:fs/promises");
    return Promise.all(result.filePaths.map(async (filePath) => {
      const stat = await fs.stat(filePath).catch(() => null);
      return { path: filePath, name: filePath.split(/[\\/]/).pop() ?? filePath, size: stat?.size ?? 0 };
    }));
  });

  // Read each picked file from disk, guard its size, and post its bytes to the
  // backend, returning a reference per successfully stored file. Files are read
  // sequentially so a large selection cannot spike memory all at once.
  ipcMain.handle("attachments:upload", async (_event, raw) => {
    const files = pickedFilesSchema.parse(raw);
    // Queue behind any in-flight upload so concurrent calls (a multi-file drop)
    // store one at a time. The chain keeps going even if one upload throws.
    const run = attachmentUploadChain.then(async () => {
      const fs = await import("node:fs/promises");
      const refs = [];
      for (const file of files) {
        const buffer = await fs.readFile(file.path);
        if (buffer.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`${file.name} is too large. The limit is 10 MB per file.`);
        }
        const ref = await api.request("/v1/attachments", {
          method: "POST",
          body: {
            filename: file.name,
            mimeType: guessMimeType(file.name),
            base64: buffer.toString("base64")
          }
        });
        refs.push(ref);
      }
      return refs;
    });
    attachmentUploadChain = run.catch(() => {});
    return run;
  });

  // Copy text to the OS clipboard from the sandboxed renderer, which cannot use
  // the browser clipboard API (not a secure context). Used by the invite link.
  ipcMain.handle("clipboard:write", (_event, text: unknown) => {
    clipboard.writeText(typeof text === "string" ? text.slice(0, 100_000) : "");
    return { ok: true };
  });

  // Chat streaming. The renderer fires chat:send and then listens on the
  // chat:delta channel for frames carrying the matching request id. chat:stop
  // aborts the in-flight stream for a request id.
  ipcMain.handle("chat:send", (_event, raw) => {
    const value = chatSendIpcSchema.parse(raw);
    const { requestId, ...payload } = value;
    // Fire and forget: frames are pushed to the renderer as they arrive. The
    // promise here only needs to resolve so the invoke settles immediately.
    void streamChat(requestId, payload);
    return { requestId };
  });
  ipcMain.handle("chat:stop", (_event, requestId) => {
    const id = z.string().min(1).max(200).parse(requestId);
    chatStreams.get(id)?.abort();
    chatStreams.delete(id);
    return { stopped: true };
  });

  // Conversations proxy to the backend JSON API for the Recents list and reload.
  // The backend wraps the list and nests the conversation, so normalize both
  // here to the flat shapes the renderer and preload types expect.
  ipcMain.handle("conversations:list", async () => {
    const result = await api.request("/v1/conversations") as { conversations?: unknown[] };
    return Array.isArray(result?.conversations) ? result.conversations : [];
  });
  ipcMain.handle("conversations:get", async (_event, id) => {
    const safeId = z.string().uuid().parse(id);
    const result = await api.request(`/v1/conversations/${safeId}`) as { conversation?: Record<string, unknown>; messages?: unknown[] };
    return { ...(result?.conversation ?? {}), messages: Array.isArray(result?.messages) ? result.messages : [] };
  });
  ipcMain.handle("conversations:delete", (_event, id) => {
    const safeId = z.string().uuid().parse(id);
    return api.request(`/v1/conversations/${safeId}`, { method: "DELETE" });
  });

  // Contact support: open a Gmail compose window addressed to the support inbox.
  // Opening an external URL goes through the OS browser, not the sandboxed
  // renderer, so it is handled here like the other external-link actions. Gmail
  // is used directly (rather than a mailto) so it works without a configured
  // desktop mail client.
  ipcMain.handle("support:contact", async () => {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(SUPPORT_EMAIL)}&su=${encodeURIComponent("WorkCrew support")}`;
    await shell.openExternal(url);
    return { opened: true };
  });

  // Opens the WorkCrew website at its Help section, where support and billing
  // (payment changes and cancellation) live. Billing is managed on the website,
  // not through an in-app portal, so the Help button lands the user right there.
  ipcMain.handle("support:billing", async () => {
    await shell.openExternal("https://getworkcrew.com/#help");
    return { opened: true };
  });

  ipcMain.handle("automation:browser", (_event, action) => browserCli.execute(action));
  ipcMain.handle("automation:windows", (_event, action) => windowsAgent.execute(action));
  // Voice input: transcribe 16 kHz mono PCM samples sent from the renderer.
  ipcMain.handle("dictation:transcribe", (_event, buffer: ArrayBuffer) => transcribeSamples(new Float32Array(buffer)));
  ipcMain.handle("automation:launch-browser", () => browserCli.launchBrowser());
  ipcMain.handle("automation:stop", async () => {
    // The overlay is lowered by the renderer's run-exit path (or the safety timer)
    // after the in-flight action settles, so it stays up until the mouse actually
    // stops moving rather than disappearing the instant Stop is pressed.
    await Promise.allSettled([browserCli.stop(), windowsAgent.stop()]);
    return { stopped: true };
  });
  // The renderer turns the "do not touch the mouse" overlay on before a Windows
  // automation acts and off when the run ends.
  ipcMain.handle("automation:overlay", (_event, active: boolean) => {
    setAutomationOverlay(active === true);
    return { shown: active === true };
  });

  // Click recording. Start begins capturing what the user does (in the automation
  // browser or in their desktop apps); stop returns a readable trace of events.
  // The renderer sends that trace to recorder:summarize, where the model writes a
  // reusable instruction that is saved as a routine and run by the model loop.
  ipcMain.handle("recorder:start", async (_event, target: "browser" | "windows") => {
    if (target === "windows") await windowsAgent.recordStart();
    else await browserCli.recordStart();
    return { started: true };
  });
  ipcMain.handle("recorder:stop", async (_event, target: "browser" | "windows") => {
    const events: RecordedEvent[] = [];
    if (target === "windows") {
      // The Windows helper returns clicks as { kind: "click", window, control,
      // controlType } and typing as { kind: "type", window, text }. Normalize each
      // into a descriptive event, clamping to the contract limits so a long name
      // is kept (truncated) rather than failing validation and dropping the event.
      for (const item of await windowsAgent.recordStop()) {
        const it = item as { kind?: unknown; window?: unknown; control?: unknown; controlType?: unknown; text?: unknown };
        const window = typeof it.window === "string" ? it.window.slice(0, 300) : undefined;
        if (it.kind === "type") {
          const parsed = recordedEventSchema.safeParse({
            kind: "type",
            window,
            value: typeof it.text === "string" ? it.text.slice(0, 2000) : undefined
          });
          if (parsed.success && parsed.data.value) events.push(parsed.data);
          continue;
        }
        const parsed = recordedEventSchema.safeParse({
          kind: "click",
          window,
          target: typeof it.control === "string" ? it.control.slice(0, 300) : undefined,
          role: typeof it.controlType === "string" && it.controlType ? it.controlType.slice(0, 80) : undefined
        });
        if (parsed.success && parsed.data.target) events.push(parsed.data);
      }
      // Cap to the summarize request limit so a very long recording still
      // summarizes (truncated) instead of being rejected by the request schema.
      return { surface: "windows" as const, events: events.slice(0, 400) };
    }
    for (const event of await browserCli.recordStop()) {
      const parsed = recordedEventSchema.safeParse(event);
      if (parsed.success) events.push(parsed.data);
    }
    return { surface: "browser" as const, events: events.slice(0, 400) };
  });
  // Turn a recorded trace into one reusable instruction via the backend model.
  ipcMain.handle("recorder:summarize", async (_event, payload: unknown) => {
    const body = summarizeRecordingRequestSchema.parse(payload);
    return api.request<{ task: string }>("/v1/recordings/summarize", { method: "POST", body });
  });
}

const hasLock = app.requestSingleInstanceLock();
console.info(`[WorkCrew] single instance lock: ${hasLock}`);
if (!hasLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    console.info("[WorkCrew] Electron ready");
    app.setAppUserModelId("com.workcrew.desktop");
    if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient("workcrew", process.execPath, [process.argv[1]]);
    else app.setAsDefaultProtocolClient("workcrew");
    // Deny every web permission except the microphone, which the voice-input
    // button needs for on-device speech to text. The audio is transcribed locally
    // and never leaves the machine.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === "media"));
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media");
    await auth.load();
    console.info("[WorkCrew] secure session loaded");
    registerIpc();
    createWindow();
    startupUpdateCheck();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  for (const controller of chatStreams.values()) controller.abort();
  chatStreams.clear();
  closeAutomationOverlay();
  void browserCli.stop();
  void windowsAgent.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
