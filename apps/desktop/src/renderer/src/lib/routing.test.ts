import { describe, expect, it } from "vitest";
import { isQuestionLike, looksLikeAutomation, looksLikeFileRequest } from "./routing";

// Routing decides whether a typed message is answered in chat, run as an
// automation, or turned into a downloadable file. The cases here pin the
// boundaries that have bitten users, especially leading punctuation: a typed
// `"whats in this folder` must still read as a question.

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

describe("looksLikeAutomation", () => {
  it("keeps questions in chat even when quoted", () => {
    expect(looksLikeAutomation('"what is on my screen')).toBe(false);
  });

  it("still automates imperative machine phrasing", () => {
    expect(looksLikeAutomation("open tiktok in my browser")).toBe(true);
  });
});

describe("looksLikeFileRequest", () => {
  it("detects a file hand-off even when quoted", () => {
    expect(looksLikeFileRequest('"make me an excel file with a budget')).toBe(true);
  });
});
