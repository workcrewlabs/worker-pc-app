import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_IMAGES, buildRecordingContent, mockLaunchTarget } from "./anthropic.js";
import type { RecordedEvent } from "@workcrew/contracts";

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

// The summary content mixes the readable trace with per-click screenshots so the
// vision model sees the button that was pressed; the caps and ordering matter.
describe("buildRecordingContent", () => {
  const click = (target: string, screenshot?: string): RecordedEvent => ({
    kind: "click",
    window: "Good afternoon First.  User ID: FIRST",
    target,
    role: "Group",
    ...(screenshot ? { screenshot } : {})
  });

  it("is text-only when no click has a screenshot", () => {
    const content = buildRecordingContent("windows", [click("Help")]) as { type: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
  });

  it("appends one labeled image block per screenshot, in order", () => {
    const content = buildRecordingContent("windows", [click("Adminsoft Accounts", "aaa"), click("Help", "bbb")]) as { type: string; text?: string; source?: { data?: string } }[];
    expect(content.map((b) => b.type)).toEqual(["text", "text", "image", "text", "image"]);
    expect(content[1]?.text).toContain("click 1");
    expect(content[1]?.text).toContain("Adminsoft Accounts");
    expect(content[2]?.source?.data).toBe("aaa");
    expect(content[4]?.source?.data).toBe("bbb");
  });

  it("caps the number of attached images", () => {
    const events = Array.from({ length: MAX_SUMMARY_IMAGES + 4 }, (_, i) => click(`B${i}`, "x"));
    const content = buildRecordingContent("windows", events) as { type: string }[];
    expect(content.filter((b) => b.type === "image")).toHaveLength(MAX_SUMMARY_IMAGES);
  });
});
