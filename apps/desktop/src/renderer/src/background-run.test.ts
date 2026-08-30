import { describe, expect, it } from "vitest";
import type { AutomationAction } from "@workcrew/contracts";
import { needsTheMachine } from "./hooks/useAutomationRunner";

// Opening a new chat used to freeze whatever the last one was doing. The run
// loop parked at the top of every step whenever its conversation went off
// screen, which is right for a task driving the mouse and wrong for everything
// else: a spreadsheet being built in the user's own folder stopped halfway
// through because they clicked New chat.
//
// This is the rule that decides. It is deliberately about the ACTION, not about
// which mode the run was started in, because a folder run is handed the same
// tools as any other and can still reach for the screen.

const windowsClick: AutomationAction = { kind: "windows", command: "click", control: "OK" };
const browserGoto: AutomationAction = { kind: "browser", command: "goto", url: "https://example.com" };
const shell: AutomationAction = { kind: "shell", command: "python build.py" };
const writeFile: AutomationAction = { kind: "write_file", path: "sheet.csv", content: "a,b\n1,2\n" };
const finish: AutomationAction = { kind: "finish", summary: "Done." };

describe("what has to wait for the conversation to be on screen", () => {
  it("waits for anything that drives the real mouse, keyboard or screen", () => {
    expect(needsTheMachine(windowsClick)).toBe(true);
    expect(needsTheMachine(browserGoto)).toBe(true);
  });

  it("does not hold up work that touches neither", () => {
    // The whole point: this is what a spreadsheet or a code change is made of.
    expect(needsTheMachine(shell)).toBe(false);
    expect(needsTheMachine(writeFile)).toBe(false);
    expect(needsTheMachine(finish)).toBe(false);
  });

  it("treats every windows command as needing the machine, including read-only ones", () => {
    // A screenshot or an inspect reads the user's actual screen, so it is still
    // theirs to be looking at. Only the input ones raise the overlay, but none of
    // them belong to a chat nobody is watching.
    for (const command of ["screenshot", "inspect", "type-text", "launch"] as const) {
      expect(needsTheMachine({ kind: "windows", command })).toBe(true);
    }
  });
});
