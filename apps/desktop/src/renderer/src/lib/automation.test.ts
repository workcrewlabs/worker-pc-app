import { describe, expect, it } from "vitest";
import { actionDetail, actionLabel } from "./automation";

describe("action labels", () => {
  it("labels a shell command and shows the command as the detail", () => {
    const action = { kind: "shell", command: "git clone https://example.com/repo" } as const;
    expect(actionLabel(action)).toBe("Run a command");
    expect(actionDetail(action)).toBe("git clone https://example.com/repo");
  });

  it("still labels browser and windows actions", () => {
    expect(actionLabel({ kind: "browser", command: "goto", url: "https://x.com" })).toBe("Open a web page");
    expect(actionLabel({ kind: "windows", command: "click", control: "Save" })).toBe("Click in a desktop app");
  });
});
