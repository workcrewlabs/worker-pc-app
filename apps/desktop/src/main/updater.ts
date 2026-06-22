import { app, BrowserWindow } from "electron";

// In-app auto-update, like the Claude desktop app: the app checks for a newer
// version, downloads it in the background, and installs it on restart. It only
// runs in an installed (packaged) build; in development it is a safe no-op.
// electron-updater is loaded lazily so dev and tests never touch it.

export type UpdateStatus =
  | { state: "checking" }
  | { state: "available"; version?: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version?: string }
  | { state: "unsupported" }
  | { state: "error"; message: string };

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("updates:status", status);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutoUpdaterLike = any;

let initialized = false;
let updater: AutoUpdaterLike | null = null;

async function getUpdater(): Promise<AutoUpdaterLike | null> {
  // Updates only apply to an installed build. An unpackaged run (development and
  // the e2e harness) has no update feed, so it stays a no-op.
  if (!app.isPackaged) return null;
  if (initialized) return updater;
  initialized = true;
  try {
    const mod = (await import("electron-updater")) as { autoUpdater?: AutoUpdaterLike; default?: { autoUpdater?: AutoUpdaterLike } };
    updater = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
  } catch {
    updater = null;
  }
  if (!updater) return null;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => broadcast({ state: "checking" }));
  updater.on("update-available", (info: { version?: string }) => broadcast({ state: "available", version: info?.version }));
  updater.on("update-not-available", () => broadcast({ state: "none" }));
  updater.on("download-progress", (progress: { percent?: number }) => broadcast({ state: "downloading", percent: Math.round(progress?.percent ?? 0) }));
  updater.on("update-downloaded", (info: { version?: string }) => broadcast({ state: "ready", version: info?.version }));
  updater.on("error", (error: { message?: string }) => broadcast({ state: "error", message: error?.message ?? "The update could not be completed." }));
  return updater;
}

// Set while a development preview "update" is pending, so the matching install
// simulates a restart. Real builds never touch this.
let devSimulatedReady = false;

// Development preview of the whole update flow so the in-app button can be seen
// and tried without a packaged build or a real release feed. Only ever runs on a
// manual check in an unpackaged build.
function simulateDevUpdate(): void {
  devSimulatedReady = true;
  const steps: UpdateStatus[] = [
    { state: "checking" },
    { state: "available", version: "0.1.1" },
    { state: "downloading", percent: 40 },
    { state: "downloading", percent: 80 },
    { state: "downloading", percent: 100 },
    { state: "ready", version: "0.1.1" }
  ];
  steps.forEach((status, index) => setTimeout(() => broadcast(status), 600 * (index + 1)));
}

/**
 * Check for an update now. Returns whether updates are supported in this build.
 * `manual` is true when the user clicked Check for updates (vs the quiet startup
 * check); a manual check in development runs the preview so the button is
 * testable.
 */
export async function checkForUpdates(manual = false): Promise<{ supported: boolean }> {
  const instance = await getUpdater();
  if (!instance) {
    if (manual && !app.isPackaged) {
      simulateDevUpdate();
      return { supported: true };
    }
    broadcast({ state: "unsupported" });
    return { supported: false };
  }
  try {
    await instance.checkForUpdates();
  } catch (error) {
    broadcast({ state: "error", message: error instanceof Error ? error.message : "The update check failed." });
  }
  return { supported: true };
}

/** Quit and install a downloaded update. No-op when nothing is ready. */
export async function installUpdate(): Promise<void> {
  const instance = await getUpdater();
  if (instance) {
    instance.quitAndInstall();
    return;
  }
  // Development preview: there is nothing to install, so reload the windows to
  // demonstrate the restart-into-the-new-version behavior.
  if (devSimulatedReady) {
    devSimulatedReady = false;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reload();
    }
  }
}

/** Quietly check shortly after launch in packaged builds. */
export function startupUpdateCheck(): void {
  if (!app.isPackaged) return;
  setTimeout(() => {
    void checkForUpdates();
  }, 4_000);
}
