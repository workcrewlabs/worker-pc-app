import { describe, expect, it } from "vitest";
import { actionNeedsApproval, redactResult } from "./security";

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

describe("desktop result redaction", () => {
  it("redacts credentials and payment numbers", () => {
    const result = redactResult("token=abc123 card 4242 4242 4242 4242");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("4242 4242");
  });
});
