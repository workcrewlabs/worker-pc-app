import { describe, expect, it } from "vitest";
import { mockLaunchTarget } from "./anthropic.js";

// The mock planner's app-name extraction must stay narrow: it exists so local
// runs can exercise the desktop launch path, and anything ambiguous must keep
// the inert browser step instead of launching something on the test machine.

const goal = (text: string): unknown[] => [{ role: "user", content: text }];

describe("mockLaunchTarget", () => {
  it("extracts the app name from a plain open-the-app request", () => {
    expect(mockLaunchTarget(goal("open adminsoft accounts App on my computer on my desktop"))).toBe("adminsoft accounts");
    expect(mockLaunchTarget(goal("Open Notepad"))).toBe("Notepad");
    expect(mockLaunchTarget(goal("open the calculator app"))).toBe("calculator");
  });

  it("leaves web-flavored goals on the browser step", () => {
    expect(mockLaunchTarget(goal("open https://example.com"))).toBeNull();
    expect(mockLaunchTarget(goal("open example.com in a new tab"))).toBeNull();
    expect(mockLaunchTarget(goal("open a web page and read it"))).toBeNull();
    expect(mockLaunchTarget(goal("open the workcrew website"))).toBeNull();
  });

  it("refuses multi-step goals and mid-sentence opens", () => {
    expect(mockLaunchTarget(goal("Open Excel and enter 5 into cell B2"))).toBeNull();
    expect(mockLaunchTarget(goal("open gmail, then read my latest email"))).toBeNull();
    expect(mockLaunchTarget(goal("Go to amazon and open my orders"))).toBeNull();
  });

  it("ignores goals that are not requests to open something", () => {
    expect(mockLaunchTarget(goal("make me an excel sheet"))).toBeNull();
    expect(mockLaunchTarget([{ role: "user", content: [{ type: "text", text: "open notepad" }] }])).toBeNull();
  });
});
