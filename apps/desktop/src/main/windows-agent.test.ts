import { describe, expect, it } from "vitest";
import { looksLikeLostSession } from "./windows-agent";

// A client's ERP was open on screen. WorkCrew connected to it, then insisted he
// had not connected: read the window, error; take a screenshot, error; connect
// again, fine; and round again. The connected window lives in the helper
// process, so it dies when the helper is killed, which happens on any transport
// failure. Every step after that talks to a fresh helper that has never
// connected to anything. These are the two messages that say so, captured from
// the real helper.

describe("recognising a helper that has forgotten its window", () => {
  it("matches what the helper says when a step needs a window", () => {
    expect(looksLikeLostSession("Connect to a window first")).toBe(true);
  });

  it("matches what it says when a capture needs one", () => {
    expect(looksLikeLostSession(
      "Connect to the app's window first; WorkCrew only captures the app it is working in"
    )).toBe(true);
  });

  it("does not treat an ordinary failure as a lost session", () => {
    // Retrying these would be wrong: the action may already have happened, and
    // repeating a click is worse than reporting the failure.
    expect(looksLikeLostSession("Windows helper action failed")).toBe(false);
    expect(looksLikeLostSession("The Windows action failed")).toBe(false);
    expect(looksLikeLostSession("Those coordinates are off the screen")).toBe(false);
    expect(looksLikeLostSession("")).toBe(false);
  });

  it("does not match the advice given when a window is genuinely missing", () => {
    // That case is a real dead end and must be reported, not retried forever.
    expect(looksLikeLostSession(
      '"Libra Financials" is open on screen, but Windows will not let WorkCrew see inside it'
    )).toBe(false);
  });
});
