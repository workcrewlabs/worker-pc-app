import { describe, expect, it } from "vitest";
import type { AutomationAction } from "@workcrew/contracts";
import {
  REPEAT_STOP_AT,
  REPEAT_WARN_AT,
  actionSignature,
  consecutiveRepeats,
  repeatVerdict
} from "./hooks/useAutomationRunner";
import { actionDetail, actionLabel, summarizeActivity } from "./lib/automation";

// Asked to work out a subtraction on the Calculator, a run could not read the
// app's controls, fell back to clicking by eye, and then repeated near-identical
// clicks until it hit the 24 step ceiling. The user watched seventeen steps go by
// and got no answer. Nothing was watching for the one thing obvious from outside
// the machine: it was doing the same thing over and over.

const clickAt = (x: number, y: number): AutomationAction => ({ kind: "windows", command: "click-at", x, y });

describe("noticing a run going in circles", () => {
  it("lets a repeat or two through, because a click that misses is worth retrying", () => {
    expect(repeatVerdict(1)).toBe("run");
    expect(repeatVerdict(2)).toBe("run");
  });

  it("speaks up once the same step keeps coming back", () => {
    expect(repeatVerdict(REPEAT_WARN_AT)).toBe("warn");
  });

  it("gives up when the warning does not land", () => {
    expect(repeatVerdict(REPEAT_STOP_AT)).toBe("stop");
    expect(repeatVerdict(REPEAT_STOP_AT + 4)).toBe("stop");
  });

  it("counts a run of the same step, and only a run of it", () => {
    const a = actionSignature(clickAt(100, 200));
    const b = actionSignature(clickAt(300, 400));
    expect(consecutiveRepeats([], a)).toBe(1);
    expect(consecutiveRepeats([a, a], a)).toBe(3);
    // Something different in between means it is making progress, not looping.
    expect(consecutiveRepeats([a, a, b], a)).toBe(1);
  });

  it("tells two nearby clicks apart, so aiming somewhere new is not a loop", () => {
    expect(actionSignature(clickAt(100, 200))).not.toBe(actionSignature(clickAt(101, 200)));
  });

  it("would have caught the Calculator run well before the ceiling", () => {
    // Seventeen identical steps ran. The fifth is where this now stops.
    const signature = actionSignature(clickAt(640, 400));
    const history: string[] = [];
    let stoppedAt = 0;
    for (let step = 1; step <= 17; step += 1) {
      if (repeatVerdict(consecutiveRepeats(history, signature)) === "stop") { stoppedAt = step; break; }
      history.push(signature);
    }
    expect(stoppedAt).toBe(REPEAT_STOP_AT);
    expect(stoppedAt).toBeLessThan(17);
  });
});

describe("saying what a screen step actually did", () => {
  it("names every screen-level command instead of calling it a Desktop step", () => {
    // These are the ones a run reaches for when an app names none of its
    // controls, which is exactly when things go wrong and the log matters most.
    const commands = [
      "click-at", "double-click-at", "right-click-at", "drag", "scroll-at",
      "key-combo", "type-text", "press-key", "record-start", "record-stop"
    ] as const;
    for (const command of commands) {
      const label = actionLabel({ kind: "windows", command } as AutomationAction);
      expect(label, `${command} still reads as a bare step`).not.toBe("Desktop step");
    }
  });

  it("shows where on screen it clicked, since there is no control to name", () => {
    expect(actionDetail(clickAt(640, 400))).toBe("at 640, 400");
  });

  it("still prefers a real name when there is one", () => {
    expect(actionDetail({ kind: "windows", command: "click", control: "OK" })).toBe("OK");
  });
});

describe("counting the work honestly", () => {
  it("reports edits as edits, not as commands", () => {
    // A run that read 2 files, ran 3 commands and made 2 edits reported
    // "Ran 5 commands, read 2 files" and never mentioned changing anything.
    const steps = [
      { label: "Read invoice.js", status: "ok" },
      { label: "Read invoice.test.js", status: "ok" },
      { label: "Ran node invoice.test.js", status: "ok" },
      { label: "Edited invoice.js", status: "ok" },
      { label: "Ran node invoice.test.js", status: "ok" },
      { label: "Edited invoice.js", status: "ok" },
      { label: "Ran node invoice.test.js", status: "ok" }
    ];
    expect(summarizeActivity(steps)).toBe("Ran 3 commands, read 2 files, edited 2 files");
  });
});
