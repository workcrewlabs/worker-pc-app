import { describe, expect, it } from "vitest";
import { actionDetail, actionLabel, activityLine } from "./automation";

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

// The activity list read "Ran a command" twelve times in a row while WorkCrew
// worked on a repository. Watching that, the user cannot tell whether it is
// reading the right files, running the tests, or looping. Each line now names
// what it touched.
describe("activityLine", () => {
  it("says which file it read", () => {
    const action = { kind: "shell", command: "type WORKCREW.md" } as const;
    expect(activityLine(action, false)).toBe("Reading WORKCREW.md");
    expect(activityLine(action, true)).toBe("Read WORKCREW.md");
  });

  it("says which file it wrote, with enough path to recognise it", () => {
    const action = { kind: "write_file", path: "apps/desktop/src/renderer/src/App.tsx", content: "x" } as const;
    expect(activityLine(action, true)).toBe("Wrote src/App.tsx");
  });

  it("names the command it ran", () => {
    const action = { kind: "shell", command: "npm run typecheck" } as const;
    expect(activityLine(action, false)).toBe("Running npm run typecheck");
    expect(activityLine(action, true)).toBe("Ran npm run typecheck");
  });

  it("reads plainly for listing and searching", () => {
    expect(activityLine({ kind: "shell", command: "dir" } as const, true)).toBe("Listed the folder");
    expect(activityLine({ kind: "shell", command: "findstr /s ok *.ts" } as const, true)).toBe("Searched the files");
  });

  it("keeps a very long command readable", () => {
    const long = `node -e "${"x".repeat(300)}"`;
    const line = activityLine({ kind: "shell", command: long } as const, true);
    expect(line.length).toBeLessThan(80);
    expect(line.endsWith("...")).toBe(true);
  });

  it("never leaves a line empty", () => {
    expect(activityLine({ kind: "finish", summary: "done" } as const, true)).toBe("Finished");
  });
});
