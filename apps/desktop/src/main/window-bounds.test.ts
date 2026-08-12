import { describe, expect, it } from "vitest";
import {
  chooseStartingBounds,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Rect
} from "./window-bounds.js";

// The window has to come back the size the user left it, and it has to come
// back somewhere they can see. Both failures are the kind a user cannot work
// around: one silently resets their layout every launch, the other opens the
// app on a monitor that is no longer plugged in.

const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const LAPTOP: Rect = { x: 0, y: 0, width: 1366, height: 728 };

function saved(over: Partial<{ x: number; y: number; width: number; height: number; maximized: boolean }> = {}) {
  return { x: 100, y: 80, width: 900, height: 700, maximized: false, ...over };
}

describe("chooseStartingBounds", () => {
  it("uses the default size on a first run", () => {
    const bounds = chooseStartingBounds(null, [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds).toEqual({ width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, maximized: false });
  });

  it("never opens bigger than the screen it lands on", () => {
    const bounds = chooseStartingBounds(null, [LAPTOP], { width: 1366, height: 728 });
    expect(bounds.width).toBe(1366);
    expect(bounds.height).toBe(728);
  });

  it("gives back the exact size and position from last time", () => {
    const bounds = chooseStartingBounds(saved(), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds).toEqual({ x: 100, y: 80, width: 900, height: 700, maximized: false });
  });

  it("remembers a half-screen window, which is the whole point", () => {
    // 960 wide is exactly half of a 1080p screen: the size a user gets by
    // snapping WorkCrew to one side. It must survive a restart unchanged.
    const bounds = chooseStartingBounds(saved({ x: 960, y: 0, width: 960, height: 1040 }), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds.width).toBe(960);
    expect(bounds.x).toBe(960);
  });

  it("carries the maximized state back", () => {
    const bounds = chooseStartingBounds(saved({ maximized: true }), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds.maximized).toBe(true);
    // The restored size still comes back, so un-maximizing returns the window
    // the user sized rather than something arbitrary.
    expect(bounds.width).toBe(900);
  });

  it("drops a position on a monitor that is no longer connected", () => {
    // Saved on a second screen to the right, now unplugged.
    const bounds = chooseStartingBounds(saved({ x: 2400, y: 200 }), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds.x).toBeUndefined();
    expect(bounds.y).toBeUndefined();
    // The size is still honoured; only the unreachable position is discarded.
    expect(bounds.width).toBe(900);
    expect(bounds.height).toBe(700);
  });

  it("keeps a position on a second monitor that is still connected", () => {
    const second: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
    const bounds = chooseStartingBounds(saved({ x: 2400, y: 200 }), [PRIMARY, second], { width: 1920, height: 1040 });
    expect(bounds.x).toBe(2400);
  });

  it("rejects a position with only a sliver on screen", () => {
    // Dragged almost entirely off the right edge: not enough title bar left to
    // grab, so the window would be effectively lost.
    const bounds = chooseStartingBounds(saved({ x: 1880, y: 100 }), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds.x).toBeUndefined();
  });

  it("raises a stored size that is below the minimum", () => {
    const bounds = chooseStartingBounds(saved({ width: 200, height: 200 }), [PRIMARY], { width: 1920, height: 1040 });
    expect(bounds.width).toBe(MIN_WINDOW_WIDTH);
    expect(bounds.height).toBe(MIN_WINDOW_HEIGHT);
  });
});

describe("window minimums", () => {
  it("allows half of a 1366-wide laptop screen", () => {
    expect(MIN_WINDOW_WIDTH).toBeLessThanOrEqual(1366 / 2);
  });

  it("allows a quarter of a 1080p screen", () => {
    expect(MIN_WINDOW_WIDTH).toBeLessThanOrEqual(1920 / 2);
    expect(MIN_WINDOW_HEIGHT).toBeLessThanOrEqual(1080 / 2);
  });
});
