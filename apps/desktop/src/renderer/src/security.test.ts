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

  it("never prompts in-app for shell (the main process confirms it natively)", () => {
    expect(requiresApproval({ kind: "shell", command: "git status" }, { alwaysAllow: false, permissions: {} })).toBe(false);
  });
});

describe("consequential actions are never silenced by Always allow", () => {
  const launchTerminal: AutomationAction = { kind: "windows", command: "launch", application: "powershell.exe" };
  const launchExcel: AutomationAction = { kind: "windows", command: "launch", application: "excel" };
  const payButton: AutomationAction = { kind: "browser", command: "click", target: "Pay $49 now" };
  const deleteButton: AutomationAction = { kind: "windows", command: "click", control: "Delete account" };
  const safeButton: AutomationAction = { kind: "browser", command: "click", target: "Next" };

  it("flags terminal launches and money/destructive clicks as consequential", () => {
    expect(isConsequentialAction(launchTerminal)).toBe(true);
    expect(isConsequentialAction(payButton)).toBe(true);
    expect(isConsequentialAction(deleteButton)).toBe(true);
    expect(isConsequentialAction(launchExcel)).toBe(false);
    expect(isConsequentialAction(safeButton)).toBe(false);
  });

  it("still prompts for consequential actions even with Always allow on and the category on", () => {
    expect(requiresApproval(launchTerminal, { alwaysAllow: true, permissions: ALL_ON })).toBe(true);
    expect(requiresApproval(payButton, { alwaysAllow: true, permissions: ALL_ON })).toBe(true);
    expect(requiresApproval(deleteButton, { alwaysAllow: true, permissions: ALL_ON })).toBe(true);
  });

  it("leaves ordinary launches and clicks coverable by Always allow", () => {
    expect(requiresApproval(launchExcel, { alwaysAllow: true, permissions: ALL_ON })).toBe(false);
    expect(requiresApproval(safeButton, { alwaysAllow: true, permissions: ALL_ON })).toBe(false);
  });
});

describe("desktop result redaction", () => {
  it("redacts credentials and payment numbers", () => {
    const result = redactResult("token=abc123 card 4242 4242 4242 4242");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("4242 4242");
  });
});
