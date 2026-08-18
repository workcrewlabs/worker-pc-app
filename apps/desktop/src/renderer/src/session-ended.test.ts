import { describe, expect, it } from "vitest";
import { SESSION_ENDED_TEXT, isSessionEnded } from "./App";
import { SESSION_EXPIRED_MESSAGE } from "../../main/api-client";

// The owner was sent back to the sign-in page after every restart and update.
// The app decided he was signed out by pattern-matching the error text
// (session, auth, expired, 401) and then SIGNING HIM OUT, which deletes the
// stored credentials from disk. A token refresh that merely failed to reach the
// server reported "your session has expired" as well, so restarting during a
// deploy, or a moment of bad wifi, destroyed a perfectly good session and made
// him type his password again.

describe("deciding that a session is really over", () => {
  it("agrees with the message the main process actually raises", () => {
    // The two sides cannot import a shared constant across the process boundary
    // at runtime, so this test is what keeps them identical. If one is reworded
    // without the other, users get signed out (or never do) and this fails.
    expect(SESSION_ENDED_TEXT).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("recognises it through Electron's wrapper", () => {
    // Errors cross as "Error invoking remote method 'x': Error: <message>".
    expect(isSessionEnded(new Error(
      `Error invoking remote method 'api:entitlement': Error: ${SESSION_EXPIRED_MESSAGE}`
    ))).toBe(true);
  });

  it("does not sign anyone out because the service was unreachable", () => {
    expect(isSessionEnded(new Error("Could not reach WorkCrew. Check your internet connection and try again."))).toBe(false);
    expect(isSessionEnded(new Error("WorkCrew is briefly unavailable. Please try again in a moment."))).toBe(false);
  });

  it("does not sign anyone out over a word that merely looks like auth", () => {
    // Every one of these matched the old pattern and cost a stored session.
    expect(isSessionEnded(new Error("The service could not complete the request"))).toBe(false);
    expect(isSessionEnded(new Error("Failed to authorize the payment"))).toBe(false);
    expect(isSessionEnded(new Error("Could not read the author field"))).toBe(false);
    expect(isSessionEnded(new Error("Rate limit exceeded, 401 requests queued"))).toBe(false);
    expect(isSessionEnded(new Error("This session file could not be written"))).toBe(false);
  });

  it("copes with whatever it is handed", () => {
    expect(isSessionEnded(undefined)).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
    expect(isSessionEnded("")).toBe(false);
    expect(isSessionEnded({ message: SESSION_EXPIRED_MESSAGE })).toBe(false);
  });
});
