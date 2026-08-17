import { describe, expect, it } from "vitest";
import { conversationDigest, turnFromRun, type ChatTurn, type TurnActivity } from "./chat";

// The work a run did used to live in the runner, which renders under the newest
// message. So "Ran 76 commands, read 5 files" slid down the chat as the
// conversation continued and ended up below messages sent long after it, miles
// from the request that caused it. Moving it onto a turn pins it where it
// happened.

const WORK: TurnActivity[] = [
  { id: "1", label: "Ran npm run typecheck", status: "ok" },
  { id: "2", label: "Read App.tsx", status: "ok" }
];

describe("what a finished run leaves in the transcript", () => {
  it("keeps the work with the answer", () => {
    const turn = turnFromRun("Added the feedback box.", WORK);
    expect(turn?.text).toBe("Added the feedback box.");
    expect(turn?.activity).toEqual(WORK);
    expect(turn?.role).toBe("assistant");
  });

  it("still records a run that did work but said nothing", () => {
    // An interrupted run has no closing words. Dropping it would erase the
    // evidence of everything it had already done.
    const turn = turnFromRun("", WORK);
    expect(turn).not.toBeNull();
    expect(turn?.activity).toEqual(WORK);
    expect(turn?.text).toBe("");
  });

  it("still records a run that only failed", () => {
    const turn = turnFromRun("", [], "The command could not run.");
    expect(turn?.error).toBe("The command could not run.");
  });

  it("drops a run that left nothing at all", () => {
    expect(turnFromRun("", [], "")).toBeNull();
    expect(turnFromRun("   ")).toBeNull();
  });

  it("carries no empty activity field when nothing was done", () => {
    // An ordinary chat answer must not sprout an empty work summary.
    const turn = turnFromRun("The sign in details are in auth-local.ts.", []);
    expect(turn?.activity).toBeUndefined();
  });

  it("gives every turn its own id, so the transcript keeps its order", () => {
    const first = turnFromRun("one", WORK);
    const second = turnFromRun("two", WORK);
    expect(first?.id).not.toBe(second?.id);
  });
});

// A run is created from scratch every time, so it knew nothing of the
// conversation it was part of. Asked to "give me them", it replied that it had
// no earlier context, in a chat the user could read on screen.

function turn(role: "user" | "assistant", text: string): ChatTurn {
  return { id: `${role}-${text.slice(0, 8)}-${text.length}`, role, text };
}

describe("the conversation handed to a run", () => {
  const history: ChatTurn[] = [
    turn("user", "what are the dev sign in details"),
    turn("assistant", "They are in apps/api/src/auth-local.ts."),
    turn("user", "give me them")
  ];

  it("reads in order, with each side named", () => {
    expect(conversationDigest(history)).toBe(
      "User: what are the dev sign in details\nWorkCrew: They are in apps/api/src/auth-local.ts.\nUser: give me them"
    );
  });

  it("keeps the newest exchange when it cannot keep everything", () => {
    const long: ChatTurn[] = [turn("user", "x".repeat(400)), ...history];
    const digest = conversationDigest(long, 160);
    expect(digest).toContain("give me them");
    expect(digest).not.toContain("x".repeat(400));
  });

  it("clips one long answer rather than letting it crowd out the rest", () => {
    const wordy: ChatTurn[] = [turn("assistant", "y".repeat(5_000)), turn("user", "and now do it")];
    const digest = conversationDigest(wordy, 3_500, 100);
    expect(digest).toContain("and now do it");
    expect(digest).toContain("...");
    expect(digest.length).toBeLessThan(300);
  });

  it("skips turns that carry no words, like a run that only did work", () => {
    const withWork: ChatTurn[] = [turn("user", "fix the tests"), turn("assistant", ""), turn("user", "did it pass")];
    expect(conversationDigest(withWork)).toBe("User: fix the tests\nUser: did it pass");
  });

  it("is empty for a conversation that has not started", () => {
    expect(conversationDigest([])).toBe("");
  });
});
