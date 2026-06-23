import { describe, expect, it } from "vitest";
import type { BrowserAction } from "@workcrew/contracts";
import { dedupeRecordedSteps, recordStepFromPayload } from "./recorder-steps";

describe("recordStepFromPayload", () => {
  it("maps a click event to a selector-targeted click action", () => {
    expect(recordStepFromPayload({ type: "click", selector: "#submit" })).toEqual({
      kind: "browser",
      command: "click-selector",
      target: "#submit"
    });
  });

  it("maps a fill event to a selector-targeted fill action with its value", () => {
    expect(recordStepFromPayload({ type: "fill", selector: "#name", value: "Jo" })).toEqual({
      kind: "browser",
      command: "fill-selector",
      target: "#name",
      value: "Jo"
    });
  });

  it("ignores events with no selector or an unknown type", () => {
    expect(recordStepFromPayload({ type: "click" })).toBeNull();
    expect(recordStepFromPayload({ type: "scroll", selector: "#x" })).toBeNull();
    expect(recordStepFromPayload(null)).toBeNull();
    expect(recordStepFromPayload("nope")).toBeNull();
  });
});

describe("dedupeRecordedSteps", () => {
  it("collapses consecutive identical clicks", () => {
    const steps: BrowserAction[] = [
      { kind: "browser", command: "click-selector", target: "#a" },
      { kind: "browser", command: "click-selector", target: "#a" },
      { kind: "browser", command: "click-selector", target: "#b" }
    ];
    expect(dedupeRecordedSteps(steps)).toEqual([
      { kind: "browser", command: "click-selector", target: "#a" },
      { kind: "browser", command: "click-selector", target: "#b" }
    ]);
  });

  it("keeps only the last value when one field is edited repeatedly in a row", () => {
    const steps: BrowserAction[] = [
      { kind: "browser", command: "fill-selector", target: "#q", value: "1" },
      { kind: "browser", command: "fill-selector", target: "#q", value: "12" },
      { kind: "browser", command: "fill-selector", target: "#q", value: "123" }
    ];
    expect(dedupeRecordedSteps(steps)).toEqual([
      { kind: "browser", command: "fill-selector", target: "#q", value: "123" }
    ]);
  });

  it("leaves a non-consecutive repeat and other commands intact", () => {
    const steps: BrowserAction[] = [
      { kind: "browser", command: "goto", url: "https://example.com" },
      { kind: "browser", command: "click-selector", target: "#a" },
      { kind: "browser", command: "fill-selector", target: "#q", value: "x" },
      { kind: "browser", command: "click-selector", target: "#a" }
    ];
    expect(dedupeRecordedSteps(steps)).toHaveLength(4);
  });
});
