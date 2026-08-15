import { describe, expect, it } from "vitest";
import { effectiveMode, isQuestionLike, looksLikeAutomation, shouldRunOnComputer } from "./routing";

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

// A folder was attached and the switch still read Chat, so an instruction to
// change the project came back as a description of it, followed by advice to
// attach the folder that was already attached. The two states cannot be allowed
// to disagree: the folder decides.
describe("effectiveMode", () => {
  it("treats a conversation with a folder as computer use, whatever the switch says", () => {
    expect(effectiveMode("chat", true)).toBe("computer");
    expect(effectiveMode("computer", true)).toBe("computer");
  });

  it("leaves a conversation with no folder exactly as the user set it", () => {
    expect(effectiveMode("chat", false)).toBe("chat");
    expect(effectiveMode("computer", false)).toBe("computer");
  });

  it("makes an instruction typed against a folder actually run", () => {
    // The failing case, end to end: switch on Chat, folder attached, a real
    // instruction. It has to route to the engine, not to a chat answer.
    const mode = effectiveMode("chat", true);
    expect(shouldRunOnComputer(mode, "add a feedback box to the home page")).toBe(true);
  });

  it("still answers a plain question in chat, folder or not", () => {
    const mode = effectiveMode("chat", true);
    expect(shouldRunOnComputer(mode, "what is in this folder?")).toBe(false);
  });
});

// In a folder, a polite request is an instruction. The owner asked three times
// for a change to his own app, phrased normally, and each time was told to flip
// a switch, because "can you" and "i want you to" were being read as questions.
describe("routing a message typed against a working folder", () => {
  const run = (text: string): boolean => shouldRunOnComputer("computer", text, true);

  it("acts on a polite request for a change", () => {
    expect(run("can you add a feedback box to the home page")).toBe(true);
    expect(run("could you fix the failing test")).toBe(true);
    expect(run("please update the version number")).toBe(true);
    expect(run("i want you to add a feedback box")).toBe(true);
  });

  it("acts on a plain instruction", () => {
    expect(run("add a feedback box to the home page")).toBe(true);
    expect(run("write a test for the routing logic")).toBe(true);
    expect(run("run the tests and fix what fails")).toBe(true);
  });

  it("still answers a real question in chat", () => {
    expect(run("what does ConversationPane do?")).toBe(false);
    expect(run("how do I run the tests?")).toBe(false);
    expect(run("why is the build failing")).toBe(false);
    expect(run("explain the routing logic")).toBe(false);
    expect(run("tell me what is in this folder")).toBe(false);
  });

  it("leaves screen automation outside a folder exactly as it was", () => {
    // Without a folder, "can you" stays a question, which is right for a
    // conversation that might otherwise start driving the mouse.
    expect(shouldRunOnComputer("computer", "can you open my email", false)).toBe(false);
    expect(shouldRunOnComputer("computer", "open my email", false)).toBe(true);
  });

  it("never acts while the pane is on Chat with no folder", () => {
    expect(shouldRunOnComputer("chat", "add a feedback box", false)).toBe(false);
  });
});
