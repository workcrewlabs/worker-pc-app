import { describe, expect, it } from "vitest";
import { isQuestionLike, looksLikeAutomation, shouldRunOnComputer } from "./routing";

// Routing decides whether a typed message is answered in chat or run on the user's
// computer. The composer toggle makes that choice explicit, so the cases here pin
// the two rules that matter: Chat mode never reaches the computer, and Computer use
// mode acts on everything except a plain question. The leading-punctuation cases
// stay pinned too: a typed `"whats in this folder` must still read as a question.

describe("isQuestionLike", () => {
  it("recognizes plain questions", () => {
    expect(isQuestionLike("what do you see in this folder")).toBe(true);
    expect(isQuestionLike("whats in this folder")).toBe(true);
    expect(isQuestionLike("How does this work?")).toBe(true);
  });

  it("ignores leading quotes and brackets", () => {
    expect(isQuestionLike('"whats in this folder')).toBe(true);
    expect(isQuestionLike("'what is this'")).toBe(true);
    expect(isQuestionLike("(which file is biggest)")).toBe(true);
  });

  it("treats instructions as not question-like", () => {
    expect(isQuestionLike("add a totals row to the excel")).toBe(false);
    expect(isQuestionLike("create a file called notes.txt")).toBe(false);
  });
});

describe("shouldRunOnComputer", () => {
  it("never touches the computer in chat mode", () => {
    // The whole point of the toggle: asking for a spreadsheet in Chat mode is
    // answered with a file to download, never by driving Excel on screen.
    expect(shouldRunOnComputer("chat", "make me an excel sheet of my expenses")).toBe(false);
    expect(shouldRunOnComputer("chat", "open tiktok in my browser")).toBe(false);
  });

  it("acts on instructions in computer use mode", () => {
    expect(shouldRunOnComputer("computer", "open tiktok in my browser")).toBe(true);
    expect(shouldRunOnComputer("computer", "tidy up my downloads folder")).toBe(true);
  });

  it("still answers plain questions in chat, even in computer use mode", () => {
    expect(shouldRunOnComputer("computer", "what is on my screen")).toBe(false);
    expect(shouldRunOnComputer("computer", "explain how this works")).toBe(false);
  });
});

describe("looksLikeAutomation", () => {
  // Only used to offer the "Do it on my computer" switch from Chat mode.
  it("keeps questions in chat even when quoted", () => {
    expect(looksLikeAutomation('"what is on my screen')).toBe(false);
  });

  it("still recognizes imperative machine phrasing", () => {
    expect(looksLikeAutomation("open tiktok in my browser")).toBe(true);
  });

  it("does not flag a request for a file to download", () => {
    expect(looksLikeAutomation("make me an excel sheet of my expenses")).toBe(false);
  });
});
