import { describe, expect, it } from "vitest";
import { actionDetail, actionLabel, activityLine, summarizeActivity } from "./automation";
import { formatElapsed } from "../components/AutomationActivity";

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

// The activity list, collapsed. Twenty named lines are honest but nobody scrolls
// them while the work is going; the summary compresses the same information into
// one sentence and the click reveals the detail.
describe("summarizeActivity", () => {
  const step = (label: string, status = "ok") => ({ label, status });

  it("compresses a run into one sentence", () => {
    const text = summarizeActivity([
      step("Read WORKCREW.md"), step("Read src/App.tsx"),
      step("Ran npm run typecheck"), step("Searched the files"),
      step("Wrote src/FeedbackBox.tsx")
    ]);
    expect(text).toBe("Ran 2 commands, read 2 files, wrote 1 file");
  });

  it("says when something failed, so collapsing hides nothing that matters", () => {
    const text = summarizeActivity([step("Ran npm test", "error"), step("Read a.ts")]);
    expect(text).toBe("Ran 1 command, read 1 file, 1 failed");
  });

  it("reads naturally when the run only read", () => {
    expect(summarizeActivity([step("Read a.ts"), step("Read b.ts")])).toBe("Read 2 files");
  });

  it("does not count finishing as work", () => {
    expect(summarizeActivity([step("Finished")])).toBe("");
  });

  it("is empty for an empty run", () => {
    expect(summarizeActivity([])).toBe("");
  });
});

// A run that had been going eight minutes read "480s", which is a number nobody
// can feel. Past a minute it reads like a clock.
describe("formatElapsed", () => {
  it("counts seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("switches to minutes and seconds at a minute", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
    expect(formatElapsed(150)).toBe("2m 30s");
    expect(formatElapsed(480)).toBe("8m 0s");
  });

  it("switches to hours past an hour", () => {
    expect(formatElapsed(3600)).toBe("1h 0m");
    expect(formatElapsed(3840)).toBe("1h 4m");
  });
});
