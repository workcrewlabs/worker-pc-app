import { describe, expect, it } from "vitest";
import { withAnsweredToolUseOnly } from "./anthropic.js";

// A folder run died mid-task with a raw provider error: "tool_use ids were found
// without tool_result blocks immediately after: call_879cf99b...". It had already
// run 50 commands and read 6 files. The planner had asked for two tools in one
// turn; only the first is ever executed, so only the first got a tool_result, and
// the second sat in the history unanswered. The provider checks that pairing on
// the NEXT request and refuses the whole conversation, so the run could not
// continue and the work was lost.

const TEXT = { type: "text" as const, text: "I will read the file." };
const FIRST = { type: "tool_use" as const, id: "call_1", name: "run_command", input: { command: "dir" } };
const SECOND = { type: "tool_use" as const, id: "call_2", name: "run_command", input: { command: "type a.txt" } };

describe("what gets recorded as the assistant's turn", () => {
  it("drops the tool calls that will never be answered", () => {
    const kept = withAnsweredToolUseOnly([TEXT, FIRST, SECOND], "call_1");
    expect(kept).toEqual([TEXT, FIRST]);
  });

  it("keeps the reasoning that came with them", () => {
    // The words are why the next step makes sense; only the unanswered calls go.
    const kept = withAnsweredToolUseOnly([TEXT, FIRST, SECOND], "call_1");
    expect(kept).toContainEqual(TEXT);
  });

  it("leaves an ordinary single-call turn exactly as it was", () => {
    const content = [TEXT, FIRST];
    expect(withAnsweredToolUseOnly(content, "call_1")).toEqual(content);
  });

  it("answers by id, not by position", () => {
    // The executed call is whichever one the loop actually ran.
    expect(withAnsweredToolUseOnly([FIRST, SECOND], "call_2")).toEqual([SECOND]);
  });

  it("drops every call when none was answered", () => {
    // A text-only finish answers nothing, so nothing may be left dangling.
    expect(withAnsweredToolUseOnly([TEXT, FIRST], undefined)).toEqual([TEXT]);
  });

  it("never records an empty turn", () => {
    // Some providers reject a message with no content, which would swap one
    // broken history for another.
    const kept = withAnsweredToolUseOnly([FIRST, SECOND], undefined);
    expect(kept.length).toBe(1);
    expect(kept[0]).toMatchObject({ type: "text" });
  });

  it("leaves a turn with no tool calls untouched", () => {
    expect(withAnsweredToolUseOnly([TEXT], undefined)).toEqual([TEXT]);
  });

  it("guarantees every recorded tool call has an id that will be answered", () => {
    // The invariant the provider actually enforces, stated directly.
    for (const answered of ["call_1", "call_2", undefined]) {
      const kept = withAnsweredToolUseOnly([TEXT, FIRST, SECOND], answered);
      const calls = kept.filter((block) => block.type === "tool_use");
      expect(calls.every((call) => (call as { id: string }).id === answered)).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(1);
    }
  });
});
