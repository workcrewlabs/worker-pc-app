import { describe, expect, it } from "vitest";
import type { AutomationAction } from "@workcrew/contracts";
import { actionNeedsApproval, isConsequentialAction, redactResult, requiresApproval } from "./security";

const ALL_ON = { "browser-writes": true, "windows-writes": true };
const browserWrite: AutomationAction = { kind: "browser", command: "click", target: "e1" };
const windowsWrite: AutomationAction = { kind: "windows", command: "set-text", control: "Editor", value: "Hi" };
const browserRead: AutomationAction = { kind: "browser", command: "snapshot" };

describe("desktop action approvals", () => {
  it("requires approval for browser writes", () => {
    expect(actionNeedsApproval({ kind: "browser", command: "click", target: "e12" })).toBe(true);
    expect(actionNeedsApproval({ kind: "browser", command: "snapshot" })).toBe(false);
  });

  it("requires approval for native text entry", () => {
    expect(actionNeedsApproval({ kind: "windows", command: "set-text", control: "Editor", value: "Hello" })).toBe(true);
    expect(actionNeedsApproval({ kind: "windows", command: "inspect" })).toBe(false);
  });

  it("always requires approval for shell commands", () => {
    expect(actionNeedsApproval({ kind: "shell", command: "git clone https://example.com/repo" })).toBe(true);
  });
});

describe("approval policy (requiresApproval)", () => {
  it("asks for every write when Always allow is off, regardless of toggles", () => {
    expect(requiresApproval(browserWrite, { alwaysAllow: false, permissions: ALL_ON })).toBe(true);
    expect(requiresApproval(windowsWrite, { alwaysAllow: false, permissions: ALL_ON })).toBe(true);
  });

  it("never asks for reads or finish", () => {
    expect(requiresApproval(browserRead, { alwaysAllow: false, permissions: ALL_ON })).toBe(false);
    expect(requiresApproval({ kind: "finish", summary: "done" }, { alwaysAllow: false, permissions: {} })).toBe(false);
  });

  it("skips the prompt when Always allow is on and the category is on", () => {
    expect(requiresApproval(browserWrite, { alwaysAllow: true, permissions: ALL_ON })).toBe(false);
    expect(requiresApproval(windowsWrite, { alwaysAllow: true, permissions: ALL_ON })).toBe(false);
  });

  it("still asks for a category turned off even when Always allow is on", () => {
    expect(requiresApproval(browserWrite, { alwaysAllow: true, permissions: { "browser-writes": false } })).toBe(true);
    // Windows is left on, so it is covered.
    expect(requiresApproval(windowsWrite, { alwaysAllow: true, permissions: { "browser-writes": false } })).toBe(false);
  });

  it("gates shell on the Always allow toggle: asks when off, runs freely when on", () => {
    // A folder command asks each time when Always allow is off...
    expect(requiresApproval({ kind: "shell", command: "git status" }, { alwaysAllow: false, permissions: {} })).toBe(true);
    // ...and runs without prompting when Always allow is on (the main process keeps
    // a separate native floor for obviously destructive commands).
    expect(requiresApproval({ kind: "shell", command: "git status" }, { alwaysAllow: true, permissions: {} })).toBe(false);
  });
});

describe("consequential actions are never silenced by Always allow", () => {
  // Real action shapes: a browser click carries an aria ref (e12), a windows
  // click carries a numeric id; the human label is resolved from the snapshot
  // and passed in as opts.label. Tests must use these shapes, not a fake label
  // in the ref field, or they would green-light a path the executor never sees.
  const launchTerminalExe: AutomationAction = { kind: "windows", command: "launch", application: "powershell.exe" };
  const launchTerminalAlias: AutomationAction = { kind: "windows", command: "launch", application: "terminal" };
  const launchCmdAlias: AutomationAction = { kind: "windows", command: "launch", application: "command prompt" };
  const launchExcel: AutomationAction = { kind: "windows", command: "launch", application: "excel" };
  const payClick: AutomationAction = { kind: "browser", command: "click", target: "e12" };
  const safeClick: AutomationAction = { kind: "browser", command: "click", target: "e8" };
  const deleteWinClick: AutomationAction = { kind: "windows", command: "click", control: "12" };
  const payLabel = 'button "Pay $49 now" [ref=e12]';
  const safeLabel = 'button "Next" [ref=e8]';

  it("flags every terminal launch, including the friendly aliases that resolve to a shell", () => {
    expect(isConsequentialAction(launchTerminalExe)).toBe(true);
    expect(isConsequentialAction(launchTerminalAlias)).toBe(true); // terminal -> wt
    expect(isConsequentialAction(launchCmdAlias)).toBe(true); // command prompt -> cmd
    expect(isConsequentialAction(launchExcel)).toBe(false);
  });

  it("flags money/destructive clicks by their RESOLVED label, not the opaque ref", () => {
    expect(isConsequentialAction(payClick, payLabel)).toBe(true);
    expect(isConsequentialAction(deleteWinClick, "Delete account")).toBe(true);
    expect(isConsequentialAction(safeClick, safeLabel)).toBe(false);
    // Without a resolved label a bare ref must not be mistaken for a safe label
    // by accident: e12 contains no consequential word, so it is not flagged, which
    // is why the runner must resolve and pass the label.
    expect(isConsequentialAction(payClick)).toBe(false);
  });

  it("still prompts for consequential actions even with Always allow on and the category on", () => {
    expect(requiresApproval(launchTerminalAlias, { alwaysAllow: true, permissions: ALL_ON })).toBe(true);
    expect(requiresApproval(payClick, { alwaysAllow: true, permissions: ALL_ON, label: payLabel })).toBe(true);
    expect(requiresApproval(deleteWinClick, { alwaysAllow: true, permissions: ALL_ON, label: "Delete account" })).toBe(true);
  });

  it("leaves ordinary launches and clicks coverable by Always allow", () => {
    expect(requiresApproval(launchExcel, { alwaysAllow: true, permissions: ALL_ON })).toBe(false);
    expect(requiresApproval(safeClick, { alwaysAllow: true, permissions: ALL_ON, label: safeLabel })).toBe(false);
  });
});

describe("desktop result redaction", () => {
  it("redacts credentials and payment numbers", () => {
    const result = redactResult("token=abc123 card 4242 4242 4242 4242");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("4242 4242");
  });
});
