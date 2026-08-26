import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import { turnFromCompletedRun, type ChatTurn, type TurnRun } from "../lib/chat";

// Save as a routine sat on the live run card but not on the same card once the
// run had been kept in the transcript, and the transcript is what you get back
// whenever you reopen a task from Recents. So the button was missing from every
// finished task anyone came back to, which is the only time you actually know
// the task worked well enough to be worth keeping.

const RUN: TurnRun = {
  task: "open utube",
  status: "complete",
  summary: "Opened YouTube in the browser.",
  steps: [{ id: "1", label: "Open a web page: https://www.youtube.com", status: "ok" }]
};

function markupFor(run: TurnRun, offer: { save?: boolean; rerun?: boolean } = { save: true, rerun: true }): string {
  const turn = turnFromCompletedRun(run) as ChatTurn;
  return renderToStaticMarkup(
    <MessageList
      turns={[turn]}
      onRerun={offer.rerun ? () => {} : undefined}
      onSaveRoutine={offer.save ? () => {} : undefined}
    />
  );
}

describe("a finished computer task kept in the transcript", () => {
  it("offers Save as a routine, not only Run again", () => {
    const html = markupFor(RUN);
    expect(html).toContain("Save as a routine");
    expect(html).toContain("Run again");
  });

  it("leaves the button out when there is nowhere to save it to", () => {
    expect(markupFor(RUN, { rerun: true })).not.toContain("Save as a routine");
  });

  it("does not offer to save a task too short to be worth naming", () => {
    expect(markupFor({ ...RUN, task: "hi" })).not.toContain("Save as a routine");
  });

  it("does not offer to save a run that failed or was stopped", () => {
    // Turning a run that did not work into a routine only schedules the failure.
    for (const status of ["failed", "stopped"] as const) {
      expect(markupFor({ ...RUN, status })).not.toContain("Save as a routine");
    }
  });
});
