import { BrowserWindow, screen } from "electron";

// A small, frameless, always-on-top, click-through banner shown while WorkCrew is
// physically driving the mouse and keyboard during a Windows automation. It tells
// the user not to touch the mouse so they do not knock the automation off course.
// It is click-through (setIgnoreMouseEvents) so it never blocks the app underneath,
// and shown without focus so it does not steal focus from the app being automated.

let overlay: BrowserWindow | null = null;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;

// If the renderer ever fails to turn the overlay off (a crash or reload mid-run),
// hide it on our own after this long so it can never get stuck on screen. Kept
// well above the Windows agent's 30s per-action timeout so this backstop can only
// fire after an action has surely ended, never mid-action.
const SAFETY_HIDE_MS = 60_000;

function overlayHtml(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif}
  .bar{margin:10px auto 0;max-width:520px;display:flex;align-items:center;gap:12px;
    background:#221F2E;border:1px solid #7c3aed;border-radius:12px;padding:12px 18px;
    box-shadow:0 14px 36px rgba(0,0,0,.55)}
  .dot{width:11px;height:11px;border-radius:50%;background:#a78bfa;flex:0 0 auto;animation:p 1.2s ease-in-out infinite}
  .txt{color:#f1efec;font-size:14px;font-weight:600;line-height:1.3}
  @keyframes p{0%,100%{box-shadow:0 0 0 0 rgba(167,139,250,.5)}50%{box-shadow:0 0 0 7px rgba(167,139,250,0)}}
  </style></head><body><div class="bar"><span class="dot"></span>
  <span class="txt">WorkCrew is controlling the mouse and keyboard. Please do not move the mouse or type until it finishes.</span>
  </div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createOverlay(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 560;
  const height = 78;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 18,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true }
  });
  // Click-through so it never blocks the app being automated.
  win.setIgnoreMouseEvents(true);
  // Keep it above normal windows, including most full-screen apps.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadURL(overlayHtml());
  win.on("closed", () => { overlay = null; });
  return win;
}

/**
 * Turn the do-not-touch overlay on or off. The renderer calls this around a
 * Windows automation: on before the mouse/keyboard actions, off when the run
 * ends. Each "on" also resets a safety timer so a renderer that never calls "off"
 * cannot leave the banner stuck on screen. Failures are swallowed: the overlay is
 * a nicety and must never break an automation.
 */
export function setAutomationOverlay(active: boolean): void {
  try {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (active) {
      if (!overlay || overlay.isDestroyed()) overlay = createOverlay();
      if (!overlay.isVisible()) overlay.showInactive();
      safetyTimer = setTimeout(() => { setAutomationOverlay(false); }, SAFETY_HIDE_MS);
    } else if (overlay && !overlay.isDestroyed()) {
      overlay.hide();
    }
  } catch {
    // Never let the overlay interfere with the run.
  }
}

/**
 * Fully tear down the overlay window. Must be called when the main window closes
 * or the app quits: the overlay is a top-level BrowserWindow, so a lingering
 * hidden one would keep the app alive and stop "window-all-closed" from firing.
 */
export function closeAutomationOverlay(): void {
  try {
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
  } catch {
    // Best effort teardown.
  }
}
