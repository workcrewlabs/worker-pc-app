import type { WindowBounds } from "./settings.js";

// Where the main window opens: the size the user left it at, or a default fitted
// to this screen. Kept apart from the window itself so the geometry can be
// tested without an Electron display.

// The smallest window the interface still reads at. It is deliberately below
// half of a 1366-wide laptop screen (683) and below a quarter of a 1080p screen
// (960 by 540), because snapping WorkCrew to one side while working in another
// app is the normal way people use it. Below this the composer and the sidebar
// start colliding, so the layout stops shrinking.
export const MIN_WINDOW_WIDTH = 640;
export const MIN_WINDOW_HEIGHT = 520;

// What a first run gets, before being capped to the screen it opens on.
export const DEFAULT_WINDOW_WIDTH = 1_440;
export const DEFAULT_WINDOW_HEIGHT = 920;

// How much of the window must land on a real display for the saved position to
// be reused: enough title bar to grab with the mouse.
const VISIBLE_X = 120;
const VISIBLE_Y = 40;

export type Rect = { x: number; y: number; width: number; height: number };

export type StartingBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
};

function overlaps(bounds: Rect, area: Rect): boolean {
  const x = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const y = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return x >= VISIBLE_X && y >= VISIBLE_Y;
}

/**
 * Decide where the window should open.
 *
 * A remembered position is honoured only when it still lands on a display that
 * exists: unplugging the second monitor the window was on would otherwise
 * reopen it somewhere invisible, with no way to drag it back. In that case the
 * remembered SIZE is kept and the position dropped, so the window is centred on
 * the screen that is actually there.
 */
export function chooseStartingBounds(
  saved: WindowBounds | null,
  displays: Rect[],
  primaryWorkArea: { width: number; height: number }
): StartingBounds {
  if (!saved) {
    return {
      width: Math.max(MIN_WINDOW_WIDTH, Math.min(DEFAULT_WINDOW_WIDTH, primaryWorkArea.width)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.min(DEFAULT_WINDOW_HEIGHT, primaryWorkArea.height)),
      maximized: false
    };
  }
  const width = Math.max(MIN_WINDOW_WIDTH, saved.width);
  const height = Math.max(MIN_WINDOW_HEIGHT, saved.height);
  const placed = { x: saved.x, y: saved.y, width, height };
  if (!displays.some((area) => overlaps(placed, area))) {
    return { width, height, maximized: saved.maximized };
  }
  return { x: saved.x, y: saved.y, width, height, maximized: saved.maximized };
}
