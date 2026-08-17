import { describe, expect, it } from "vitest";
import { TASK_MARKER, runTitle } from "./anthropic.js";

// Every user reported the same thing: switch to Computer use, give it a task,
// watch it work, and the chat is nowhere in Recents afterwards. Runs were kept
// in their own table with no conversation at all, so nothing ever reached the
// sidebar. They are recorded as conversations now, which makes the TITLE matter:
// a folder task carries a long engine preamble in front of the user's words, and
// titling from the raw task would fill the sidebar with identical instructions.

describe("the title a task gets in Recents", () => {
  it("uses what the user actually typed, not the engine preamble", () => {
    const task = `You are working inside the user's own folder at:\nD:\\worker pc app\n` +
      `Work with commands ONLY. Never repeat an action that just failed.\n\n${TASK_MARKER}Add a feedback box to the home page`;
    expect(runTitle(task)).toBe("Add a feedback box to the home page");
  });

  it("uses the whole message when there is no preamble, as in computer use", () => {
    expect(runTitle("open youtube")).toBe("open youtube");
  });

  it("keeps a long task readable in a narrow sidebar", () => {
    const long = "open my browser and sign in to the accounting system and then download every invoice from last month";
    const title = runTitle(long);
    expect(title.length).toBeLessThanOrEqual(63);
    expect(title.endsWith("...")).toBe(true);
    expect(title.startsWith("open my browser")).toBe(true);
  });

  it("takes the first line, so attached-file notes do not become the title", () => {
    const task = `${TASK_MARKER}fix the login bug\n\nThe user attached these files; work with them at "C:\\notes.txt"`;
    expect(runTitle(task)).toBe("fix the login bug");
  });

  it("never produces an empty title", () => {
    // An empty sidebar row is indistinguishable from a broken one.
    expect(runTitle(`${TASK_MARKER}   \n  \n`)).toBe("Computer task");
    expect(runTitle("")).toBe("Computer task");
  });

  it("reads the last marker, so the phrase appearing in the task cannot fool it", () => {
    const task = `${TASK_MARKER}tell me what "The user's request:" means`;
    expect(runTitle(task)).toBe('tell me what "The user\'s request:" means');
  });
});
