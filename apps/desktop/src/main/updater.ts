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
  // The update has been out longer than the grace window, so it is now
  // mandatory: the renderer shows a blocking gate until it is installed.
  // `downloaded` flips to true once the installer is ready to apply.
  | { state: "required"; version?: string; deadline?: string; downloaded: boolean; percent?: number }
  | { state: "unsupported" }
  | { state: "error"; message: string };

// An update older than this becomes mandatory. Until the grace window passes the
// update is simply offered (the quiet "Restart to update" pill); after it, the
// app blocks use until the user installs it.
const FORCE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// Tracks whether the update the app is currently aware of has crossed its grace
// window. `forceActive` is set from the release date in `update-available`, so
// every later event (download progress, downloaded) reports as "required".
let forceActive = false;
let forceDeadline: number | null = null;
let forceVersion: string | undefined;

// Read the release date off the available-update info and decide whether the
// 3-day grace window has already passed. A missing or unparseable release date
// is treated as not-yet-mandatory, so a malformed feed can never lock anyone out.
function evaluateForce(info: { version?: string; releaseDate?: string } | undefined): void {
  forceVersion = info?.version;
  const released = info?.releaseDate ? Date.parse(info.releaseDate) : NaN;
  if (!Number.isFinite(released)) {
    forceActive = false;
    forceDeadline = null;
    return;
  }
  forceDeadline = released + FORCE_AFTER_MS;
  forceActive = Date.now() >= forceDeadline;
}

function forceStatus(downloaded: boolean, percent?: number): UpdateStatus {
  return {
    state: "required",
    version: forceVersion,
    deadline: forceDeadline !== null ? new Date(forceDeadline).toISOString() : undefined,
    downloaded,
    percent
  };
}

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
  // The installer has a stable, version-less name (so the website download link
  // is permanent), which means electron-updater cannot compute a meaningful
  // old-vs-new blockmap diff. Skip the futile differential round-trips and just
  // download the full, signature- and sha512-verified installer.
  updater.disableDifferentialDownload = true;
  updater.on("checking-for-update", () => broadcast({ state: "checking" }));
  updater.on("update-available", (info: { version?: string; releaseDate?: string }) => {
    evaluateForce(info);
    if (forceActive) broadcast(forceStatus(false, 0));
    else broadcast({ state: "available", version: info?.version });
  });
  updater.on("update-not-available", () => broadcast({ state: "none" }));
  updater.on("download-progress", (progress: { percent?: number }) => {
    const percent = Math.round(progress?.percent ?? 0);
    if (forceActive) broadcast(forceStatus(false, percent));
    else broadcast({ state: "downloading", percent });
  });
  updater.on("update-downloaded", (info: { version?: string }) => {
    if (forceActive) {
      forceVersion = info?.version ?? forceVersion;
      broadcast(forceStatus(true));
    } else {
      broadcast({ state: "ready", version: info?.version });
    }
  });
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

// Development preview of the mandatory-update gate: pretends a version that has
// been out past its grace window is available, so the full blocking screen can be
// seen and tried without a packaged build or a real release. Only ever runs in an
// unpackaged build with WORKCREW_SIMULATE_FORCE_UPDATE=1.
function simulateDevForceUpdate(): void {
  devSimulatedReady = true;
  forceVersion = "0.1.10";
  // Pretend the release became mandatory yesterday (released four days ago).
  forceDeadline = Date.now() - 24 * 60 * 60 * 1000;
  forceActive = true;
  // Go straight to the gate (no "checking" flicker), then run a short fake
  // download so the "Update now" button appears.
  broadcast(forceStatus(false, 0));
  setTimeout(() => broadcast(forceStatus(false, 45)), 600);
  setTimeout(() => broadcast(forceStatus(false, 100)), 1_200);
  setTimeout(() => broadcast(forceStatus(true)), 1_700);
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
    // Force-gate preview: in development with the flag set, every check (re)plays
    // the mandatory-update gate, so it shows no matter which screen triggered the
    // check and is never replaced by an "unsupported" status. Runs for both the
    // quiet startup check and a manual one.
    if (!app.isPackaged && process.env.WORKCREW_SIMULATE_FORCE_UPDATE === "1") {
      simulateDevForceUpdate();
      return { supported: true };
    }
    // A development run has no real update feed. Only play the simulated flow
    // when explicitly asked for (WORKCREW_SIMULATE_UPDATE=1), so the normal app
    // never shows a fake "update found" animation. Without it, a manual check in
    // development simply reports that this is a development run.
    if (manual && !app.isPackaged && process.env.WORKCREW_SIMULATE_UPDATE === "1") {
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
    // (isSilent = true, isForceRunAfter = true): install the downloaded update
    // silently (no installer wizard) and relaunch the app straight into the new
    // version, so from the user's view the app simply restarts itself updated.
    instance.quitAndInstall(true, true);
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
  if (!app.isPackaged) {
    // In development, optionally play the mandatory-update gate so it can be seen
    // live. The delay lets the renderer mount and subscribe first, so the gate is
    // the last status it receives. Never runs without the explicit env flag.
    if (process.env.WORKCREW_SIMULATE_FORCE_UPDATE === "1") {
      setTimeout(() => simulateDevForceUpdate(), 2_000);
    }
    return;
  }
  setTimeout(() => {
    void checkForUpdates();
  }, 4_000);
}
