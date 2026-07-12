import "dotenv/config";
import { join, resolve, sep } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } from "electron";
import {
  APP_NAME,
  SUPPORT_EMAIL,
  recordedEventSchema,
  shellActionSchema,
  summarizeRecordingRequestSchema,
  chatSendSchema,
  chatDeltaFrameSchema,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema,
  modelModeSchema,
  type ModelMode,
  type RecordedEvent,
  type ChatDeltaFrame
} from "@workcrew/contracts";
import { z } from "zod";
import { ApiClient } from "./api-client.js";
import { AuthVault } from "./auth-vault.js";
import { BrowserCli } from "./browser-cli.js";
import { getAnalyticsOptOut, getBackendUrl, setAnalyticsOptOut, setBackendUrl } from "./settings.js";
import { capture as analyticsCapture, deviceId as analyticsDeviceId, identify as analyticsIdentify } from "./analytics.js";
import { ANALYTICS_EVENTS } from "../shared/analytics-events.js";
import { transcribeSamples } from "./transcription.js";
import { checkForUpdates, installUpdate, startupUpdateCheck } from "./updater.js";
import { closeAutomationOverlay, setAutomationOverlay } from "./overlay.js";
import { extractOfficeText } from "./office.js";
import { EXPORT_EXTENSIONS, generateExport, sanitizeExportName, type ExportExtension } from "./file-export.js";
import { runShellCommand } from "./shell-cli.js";
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

// The app follows the OS display scaling (a Windows setting of 125% renders the
// app at 125%, and changing that setting changes the app to match). We do NOT
// force a fixed device scale factor, because forcing 100% made the app too small
// to read on a 125% display and stopped it responding to the Windows setting.

// The shape the renderer sends for a chat turn. requestId is generated in the
// preload; the rest matches chatSendSchema so the body can be validated before
// it leaves the desktop.
const chatSendIpcSchema = chatSendSchema.extend({
  requestId: z.string().min(1).max(200)
}).strict();

// The only property keys the renderer may attach to an event. Allow-listing the
// KEYS (not just the value types) means a compromised renderer cannot smuggle
// prompt text, filenames, or local paths under some arbitrary key, even though
// the event name is already allow-listed.
const ANALYTICS_PROP_KEYS = new Set(["mode", "via", "category", "ext", "cadence", "source"]);

// A renderer analytics call: the event must be a known safe event, and properties
// are a small, capped bag of allow-listed keys mapping to low-cardinality
// scalars. Strict so nothing unexpected reaches the capture call.
const analyticsCaptureSchema = z.object({
  event: z.enum(ANALYTICS_EVENTS),
  props: z.record(z.string().max(64), z.union([z.string().max(120), z.number(), z.boolean(), z.null()]))
    .refine(
      (obj) => {
        const keys = Object.keys(obj);
        return keys.length <= 8 && keys.every((key) => ANALYTICS_PROP_KEYS.has(key));
      },
      { message: "unexpected analytics property" }
    )
    .optional()
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

// Word/Excel/PowerPoint files are read locally and only their extracted text is
// uploaded, so the binary never leaves the machine (like Claude Code's skills).
const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

// A file the chat asked WorkCrew to generate for download. The extension is
// constrained to the formats the exporter understands, and the content is bounded
// so a runaway payload cannot exhaust memory. The renderer never names a path;
// the user picks it in the Save dialog.
const saveFileSchema = z.object({
  name: z.string().min(1).max(200),
  ext: z.enum(EXPORT_EXTENSIONS),
  content: z.string().max(2_000_000)
}).strict();

function createWindow(): void {
  console.info("[WorkCrew] creating main window");
  // A development (unpackaged) run is labelled "Dev WorkCrew" so it is obvious at
  // a glance which window is the local build versus the installed public app.
  const windowTitle = app.isPackaged ? APP_NAME : `Dev ${APP_NAME}`;
  mainWindow = new BrowserWindow({
    title: windowTitle,
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
  mainWindow.setTitle(windowTitle);
  // Keep the dev label sticky: the renderer never sets a document title, but guard
  // against it so a "Dev" build can't silently relabel itself as the public app.
  mainWindow.on("page-title-updated", (event) => {
    if (!app.isPackaged) {
      event.preventDefault();
      mainWindow?.setTitle(windowTitle);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL;
    if (!allowed || !url.startsWith(allowed)) event.preventDefault();
  });
  // Right-click menu with the standard editing actions. Without this, Electron
  // shows no context menu, so the user cannot right-click to paste text, files, or
  // images. The Paste role runs a real paste, which fires a paste event in the
  // renderer (handled there to attach pasted images and files).
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags;
    const editable = params.isEditable;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (editable || params.selectionText) {
      if (flags.canCut && editable) template.push({ role: "cut" });
      if (flags.canCopy) template.push({ role: "copy" });
      if (editable) template.push({ role: "paste" });
      if (template.length) template.push({ type: "separator" });
      template.push({ role: "selectAll" });
    }
    if (template.length && mainWindow) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
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
  ipcMain.handle("settings:get-analytics-opt-out", () => getAnalyticsOptOut());
  ipcMain.handle("settings:set-analytics-opt-out", (_event, raw) => setAnalyticsOptOut(z.boolean().parse(raw)));

  // Token-spend mode (Economy vs Privacy). Stored on the backend so a routing
  // decision is authoritative and follows the user across devices; the desktop just
  // reads and writes it. Falls back to the default if the read fails (e.g. offline).
  ipcMain.handle("settings:get-model-mode", async (): Promise<ModelMode> => {
    try {
      const res = await api.request<{ modelMode?: string }>("/v1/preferences", { method: "GET" });
      return res.modelMode === "privacy" ? "privacy" : "economy";
    } catch {
      return "economy";
    }
  });
  ipcMain.handle("settings:set-model-mode", async (_event, raw): Promise<ModelMode> => {
    const modelMode = modelModeSchema.parse(raw);
    const res = await api.request<{ modelMode?: string }>("/v1/preferences", { method: "PATCH", body: { modelMode } });
    return res.modelMode === "privacy" ? "privacy" : "economy";
  });

  // Product analytics. The renderer asks the main process to capture a safe,
  // allow-listed event; main attaches the distinct id (the internal user id after
  // login, otherwise the anonymous device id) and sends it. identify links the
  // two after a successful login. Both are no-ops when analytics is off.
  ipcMain.handle("analytics:capture", (_event, raw) => {
    const { event, props } = analyticsCaptureSchema.parse(raw);
    const distinctId = auth.getUserId() ?? analyticsDeviceId();
    analyticsCapture(distinctId, event, props ?? {});
    return { ok: true };
  });
  ipcMain.handle("analytics:identify", () => {
    const userId = auth.getUserId();
    if (userId) analyticsIdentify(userId);
    return { ok: true };
  });

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
    const value = credentialsSchema.extend({ name: z.string().max(120).optional(), referralCode: z.string().max(40).optional() }).parse(raw);
    return auth.signUp(value.email, value.password, value.name, value.referralCode);
  });
  // Set the signed-in user's display name via the authenticated API, then mirror
  // it onto the stored session so the account area updates without a re-login.
  ipcMain.handle("auth:set-name", async (_event, raw) => {
    const { name } = z.object({ name: z.string().max(120) }).strict().parse(raw);
    const result = await api.request("/v1/profile", { method: "POST", body: { name } }) as { name: string | null };
    await auth.updateStoredName(result.name);
    return result;
  });
  ipcMain.handle("auth:reset", async (_event, email) => auth.sendPasswordReset(z.string().email().max(320).parse(email)));
  ipcMain.handle("auth:resend-verification", async (_event, email) => auth.resendVerification(z.string().email().max(320).parse(email)));
  ipcMain.handle("auth:sign-out", async () => auth.signOut());
  // Permanently delete the account on the backend, then clear the local encrypted
  // session so the app returns to the sign-in screen. The backend cancels billing
  // and removes the user's data; if it fails (for example a subscription that
  // could not be canceled) the error propagates and the local session is kept.
  ipcMain.handle("auth:delete-account", async () => {
    await api.request("/v1/account", { method: "DELETE" });
    await auth.signOut();
    return { ok: true };
  });

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
  // Change an existing subscription's plan. An upgrade returns a hosted Stripe
  // payment URL: open it in the browser and report { opened: true } so the
  // renderer waits for the user to pay (the new plan arrives via the webhook and
  // is picked up on the next entitlement refresh). A downgrade returns the
  // refreshed entitlement directly, which is passed straight back.
  ipcMain.handle("api:change-plan", async (_event, raw) => {
    const result = await api.request<{ url?: string }>("/v1/billing/change-plan", { method: "POST", body: createCheckoutSchema.parse(raw) });
    if (result && typeof result.url === "string") {
      await shell.openExternal(result.url);
      return { opened: true };
    }
    return result;
  });
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
        { name: "Documents and images", extensions: ["pdf", "txt", "md", "csv", "docx", "xlsx", "pptx", "png", "jpg", "jpeg", "gif", "webp"] },
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

  // Save a file the chat generated (a spreadsheet, document, or text file) to
  // disk. This is a plain "Save As": the user always confirms the location in the
  // native dialog, the format is allow-listed, and the bytes are the model's own
  // chat output. It is not part of the automation surface and runs no code; it
  // only writes the file the user explicitly asked WorkCrew to make.
  ipcMain.handle("files:save", async (_event, raw) => {
    if (!mainWindow) return { canceled: true };
    const { name, ext, content } = saveFileSchema.parse(raw);
    const safeName = sanitizeExportName(name, ext as ExportExtension);
    const buffer = await generateExport(ext as ExportExtension, content);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save file",
      defaultPath: join(app.getPath("downloads"), safeName),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const fs = await import("node:fs/promises");
    await fs.writeFile(result.filePath, buffer);
    return { saved: true, path: result.filePath };
  });

  // Read each picked file from disk, guard its size, and post its bytes to the
  // backend, returning a reference per successfully stored file. Files are read
  // sequentially so a large selection cannot spike memory all at once.
  ipcMain.handle("attachments:upload", async (_event, raw) => {
    const files = pickedFilesSchema.parse(raw);
    // Queue behind any in-flight upload so concurrent calls (a multi-file drop)
    // store one at a time. The chain keeps going even if one upload throws.
    const userDataDir = resolve(app.getPath("userData"));
    const run = attachmentUploadChain.then(async () => {
      const fs = await import("node:fs/promises");
      const refs = [];
      for (const file of files) {
        const resolved = resolve(file.path);
        // Never read the app's own internal files (the encrypted session vault,
        // settings, workspace, model cache, all under userData). A user attaches
        // their own documents, never these, so blocking the app data directory
        // closes the path where a compromised renderer could try to read and
        // exfiltrate WorkCrew's own stored data through the upload channel.
        if (resolved === userDataDir || resolved.toLowerCase().startsWith(userDataDir.toLowerCase() + sep)) {
          throw new Error("That file cannot be attached.");
        }
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat || !stat.isFile()) {
          throw new Error(`${file.name} could not be read.`);
        }
        const buffer = await fs.readFile(resolved);
        if (buffer.byteLength > MAX_UPLOAD_BYTES) {
          throw new Error(`${file.name} is too large. The limit is 10 MB per file.`);
        }
        const ext = (file.name.split(".").pop() ?? "").toLowerCase();
        let body: { filename: string; mimeType: string; base64: string };
        if (OFFICE_EXTENSIONS.has(ext)) {
          let text = "";
          try { text = await extractOfficeText(ext, buffer); } catch { text = ""; }
          if (!text.trim()) throw new Error(`${file.name} could not be read, or it has no text.`);
          body = { filename: file.name, mimeType: "text/plain", base64: Buffer.from(text, "utf8").toString("base64") };
        } else {
          body = { filename: file.name, mimeType: guessMimeType(file.name), base64: buffer.toString("base64") };
        }
        const ref = await api.request("/v1/attachments", { method: "POST", body });
        refs.push(ref);
      }
      return refs;
    });
    attachmentUploadChain = run.catch(() => {});
    return run;
  });

  // Upload raw bytes (a pasted screenshot or any clipboard image the browser
  // decoded for the paste event). The renderer reads the image from the paste
  // event and sends its bytes here, which is more reliable than reading the OS
  // clipboard separately. Returns null for empty input.
  ipcMain.handle("attachments:upload-bytes", async (_event, raw) => {
    const input = raw as { name?: unknown; mimeType?: unknown; bytes?: unknown };
    if (!input || (!(input.bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(input.bytes as ArrayBufferView))) return null;
    const buffer = Buffer.from(input.bytes as ArrayBuffer);
    if (!buffer.byteLength) return null;
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error("That image is too large. The limit is 10 MB.");
    }
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : `pasted-image-${Date.now()}.png`;
    const mimeType = typeof input.mimeType === "string" && input.mimeType ? input.mimeType : "image/png";
    const body = { filename: name, mimeType, base64: buffer.toString("base64") };
    const run = attachmentUploadChain.then(() => api.request("/v1/attachments", { method: "POST", body }));
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
  ipcMain.handle("conversations:rename", (_event, id, title) => {
    const safeId = z.string().uuid().parse(id);
    const safeTitle = z.string().trim().min(1).max(200).parse(title);
    return api.request(`/v1/conversations/${safeId}`, { method: "PATCH", body: { title: safeTitle } });
  });
  ipcMain.handle("conversations:pin", (_event, id, pinned) => {
    const safeId = z.string().uuid().parse(id);
    return api.request(`/v1/conversations/${safeId}`, { method: "PATCH", body: { pinned: z.boolean().parse(pinned) } });
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

  // Run one shell command in the workspace. The main process itself shows the
  // approval here, so a command can never run without the user allowing the exact
  // command, even if some other renderer code tried to call this directly.
  ipcMain.handle("shell:run", async (_event, raw) => {
    const { command } = shellActionSchema.parse(raw);
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const options = {
      type: "warning" as const,
      buttons: ["Cancel", "Run"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: "Run a command?",
      message: "WorkCrew wants to run a command on your computer.",
      detail: `${command}\n\nThis runs in WorkCrew's workspace folder. Only allow commands you understand and trust.`
    };
    const { response } = target ? await dialog.showMessageBox(target, options) : await dialog.showMessageBox(options);
    if (response !== 1) return "The user declined to run this command.";
    return runShellCommand(command);
  });

  ipcMain.handle("automation:browser", (_event, action) => browserCli.execute(action));
  ipcMain.handle("automation:windows", (_event, action) => windowsAgent.execute(action));
  // Voice input: transcribe 16 kHz mono PCM samples sent from the renderer.
  ipcMain.handle("dictation:transcribe", (_event, buffer: unknown) => {
    // Validate and cap the audio before allocating. Without this, a renderer
    // could send an arbitrarily large buffer and exhaust memory. The cap is ~5
    // minutes of 16 kHz mono float32 samples (16000 * 300 * 4 bytes).
    const MAX_AUDIO_BYTES = 16_000 * 300 * 4;
    const ab = buffer instanceof ArrayBuffer
      ? buffer
      : ArrayBuffer.isView(buffer as ArrayBufferView)
        ? (buffer as ArrayBufferView).buffer
        : null;
    if (!ab) throw new Error("Invalid audio input.");
    if (ab.byteLength > MAX_AUDIO_BYTES) throw new Error("That recording is too long.");
    return transcribeSamples(new Float32Array(ab));
  });
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
      // controlType, screenshotPath? } and typing as { kind: "type", window,
      // text }. Normalize each into a descriptive event, clamping to the contract
      // limits so a long name is kept (truncated) rather than failing validation
      // and dropping the event. The first few clicks carry a small screenshot so
      // the summarizing model can SEE the button that was pressed; the temp file
      // is read once, attached as base64, and deleted.
      const MAX_ATTACHED_SHOTS = 6;
      let attachedShots = 0;
      const fs = await import("node:fs/promises");
      for (const item of await windowsAgent.recordStop()) {
        const it = item as { kind?: unknown; window?: unknown; control?: unknown; controlType?: unknown; text?: unknown; screenshotPath?: unknown };
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
        const control = typeof it.control === "string" ? it.control.slice(0, 300) : undefined;
        // The helper reads each button's text locally from the Windows
        // accessibility tree for free. A screenshot is only attached, for the AI
        // to read as a last resort, when that local read produced no usable label
        // (a custom-drawn or icon-only button). So a normal recording carries no
        // images and summarizes as a cheap text-only call; only the rare
        // unreadable click costs a vision read.
        const unlabeled = !control || control === "(unlabeled control)";
        let screenshot: string | undefined;
        if (typeof it.screenshotPath === "string" && it.screenshotPath) {
          try {
            if (unlabeled && attachedShots < MAX_ATTACHED_SHOTS) {
              const data = (await fs.readFile(it.screenshotPath)).toString("base64");
              // The contract bounds each image; skip an unexpectedly large one.
              if (data.length > 0 && data.length <= 90_000) {
                screenshot = data;
                attachedShots += 1;
              }
            }
          } catch {
            // A missing or unreadable crop never drops the click itself.
          }
          await fs.rm(it.screenshotPath, { force: true }).catch(() => {});
        }
        const parsed = recordedEventSchema.safeParse({
          kind: "click",
          window,
          target: control,
          role: typeof it.controlType === "string" && it.controlType ? it.controlType.slice(0, 80) : undefined,
          ...(screenshot ? { screenshot } : {})
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
    try {
      return await api.request<{ task: string }>("/v1/recordings/summarize", { method: "POST", body });
    } catch (error) {
      // A backend that predates click screenshots rejects the unknown field.
      // Retry once without them so recording keeps working across versions.
      const hadScreenshots = body.events.some((event) => "screenshot" in event && event.screenshot);
      if (!hadScreenshots) throw error;
      const stripped = { ...body, events: body.events.map(({ screenshot: _screenshot, ...rest }) => rest) };
      return api.request<{ task: string }>("/v1/recordings/summarize", { method: "POST", body: stripped });
    }
  });
}

// In development, do not contend for the single-instance lock: a dev build should
// be able to run alongside the installed public app rather than be blocked by it
// (they keep separate data). Packaged builds still enforce a single instance.
const hasLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
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
    // A distinct AppUserModelId for the dev build keeps its taskbar grouping and
    // notifications separate from the installed public app.
    app.setAppUserModelId(app.isPackaged ? "com.workcrew.desktop" : "com.workcrew.desktop.dev");
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
