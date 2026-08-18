import { describe, expect, it } from "vitest";
import { turnFromCompletedRun, type TurnRun } from "./chat";

// A computer task lived only as live state, so starting the next one erased the
// last: the card with its steps and its Run again button was simply gone, and
// nothing was left of what had been done before. Kept as a turn, each run stays
// where it happened and they stack up the way messages do.

const RUN: TurnRun = {
  task: "open youtube",
  status: "complete",
  summary: "I opened YouTube in your web browser.",
  steps: [{ id: "1", label: "Open a web page: https://www.youtube.com", status: "ok" }]
};

describe("a finished computer task in the transcript", () => {
  it("keeps everything the card needs to redraw itself", () => {
    const turn = turnFromCompletedRun(RUN);
    expect(turn?.run).toEqual(RUN);
    // Empty text on purpose: it renders as a card, never as a chat message.
    expect(turn?.text).toBe("");
    expect(turn?.role).toBe("assistant");
  });

  it("keeps the task, which is what Run again needs", () => {
    expect(turnFromCompletedRun(RUN)?.run?.task).toBe("open youtube");
  });

  it("keeps a run that was stopped part way", () => {
    // The user stopping it does not make the work worth forgetting.
    const stopped: TurnRun = { ...RUN, status: "stopped", summary: "Stopped." };
    expect(turnFromCompletedRun(stopped)?.run?.status).toBe("stopped");
  });

  it("keeps a run that only failed, so the error stays on screen", () => {
    const failed: TurnRun = { task: "open youtube", status: "failed", summary: "", error: "That step could not be completed.", steps: [] };
    expect(turnFromCompletedRun(failed)).not.toBeNull();
  });

  it("drops a run that never actually did anything", () => {
    // A duplicate send or a task too short to start would otherwise leave an
    // empty card in the chat for no reason.
    expect(turnFromCompletedRun({ task: "x", status: "idle", summary: "", steps: [] })).toBeNull();
  });

  it("gives each run its own id, so two runs are two cards", () => {
    const first = turnFromCompletedRun(RUN);
    const second = turnFromCompletedRun({ ...RUN, task: "open my channel" });
    expect(first?.id).not.toBe(second?.id);
    expect(first?.run?.task).not.toBe(second?.run?.task);
  });
});
