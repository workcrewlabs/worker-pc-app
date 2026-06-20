import "dotenv/config";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import {
  APP_NAME,
  createCheckoutSchema,
  createRunSchema,
  nextRunStepSchema
} from "@workcrew/contracts";
import { z } from "zod";
import { ApiClient } from "./api-client.js";
import { AuthVault } from "./auth-vault.js";
import { BrowserCli } from "./browser-cli.js";
import { WindowsAgent } from "./windows-agent.js";

const auth = new AuthVault();
const api = new ApiClient(auth);
const browserCli = new BrowserCli();
const windowsAgent = new WindowsAgent();
let mainWindow: BrowserWindow | null = null;

console.info("[WorkCrew] main process loaded");

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(128)
}).strict();

function createWindow(): void {
  console.info("[WorkCrew] creating main window");
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1_440,
    height: 920,
    minWidth: 1_040,
    minHeight: 700,
    show: false,
    backgroundColor: "#0b0d10",
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

  const capturePath = process.env.WORKCREW_CAPTURE;
  if (capturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow!.webContents.capturePage();
          await import("node:fs/promises").then((fs) => fs.writeFile(capturePath, image.toPNG()));
          console.info(`[WorkCrew] capture written to ${capturePath}`);
        } catch (error) {
          console.error("[WorkCrew] capture failed", error);
        } finally {
          app.quit();
        }
      }, 6_500);
    });
  }
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[WorkCrew] renderer failed to load (${code}): ${description}`);
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function registerIpc(): void {
  ipcMain.handle("app:info", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    devAuth: process.env.WORKCREW_DEV_AUTH === "true",
    devBilling: process.env.WORKCREW_DEV_BILLING === "true"
  }));
  ipcMain.handle("auth:session", () => auth.getSession());
  ipcMain.handle("auth:sign-in", async (_event, raw) => {
    const value = credentialsSchema.parse(raw);
    await auth.signIn(value.email, value.password);
    return auth.getSession();
  });
  ipcMain.handle("auth:sign-up", async (_event, raw) => {
    const value = credentialsSchema.parse(raw);
    return auth.signUp(value.email, value.password);
  });
  ipcMain.handle("auth:reset", async (_event, email) => auth.sendPasswordReset(z.string().email().max(320).parse(email)));
  ipcMain.handle("auth:sign-out", async () => auth.signOut());

  ipcMain.handle("api:entitlement", () => api.request("/v1/entitlement"));
  ipcMain.handle("api:dev-activate", (_event, raw) => api.request("/v1/dev/activate", { method: "POST", body: createCheckoutSchema.parse(raw) }));
  ipcMain.handle("api:checkout", async (_event, raw) => {
    const result = await api.request<{ url: string }>("/v1/billing/checkout", { method: "POST", body: createCheckoutSchema.parse(raw) });
    await shell.openExternal(result.url);
    return { opened: true };
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

  ipcMain.handle("automation:browser", (_event, action) => browserCli.execute(action));
  ipcMain.handle("automation:windows", (_event, action) => windowsAgent.execute(action));
  ipcMain.handle("automation:stop", async () => {
    await Promise.allSettled([browserCli.stop(), windowsAgent.stop()]);
    return { stopped: true };
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
    if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient("workcrew", process.execPath, [process.argv[1]]);
    else app.setAsDefaultProtocolClient("workcrew");
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await auth.load();
    console.info("[WorkCrew] secure session loaded");
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  void browserCli.stop();
  void windowsAgent.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
