import { describe, expect, it } from "vitest";
import { chatFailureDetail, chatFailureMessage, isDeliberateMessage } from "./chat-errors.js";

// The failure these exist for: a chat turn died when the connection to the model
// provider dropped, and the answer shown in place of the reply was the provider
// library's own two words, "Connection error." It named nothing the user could
// act on and did not even tell them that sending again would work.

/** The shape the Anthropic SDK throws when it never reached the provider. */
function connectionError(): Error {
  return Object.assign(new Error("Connection error."), { name: "APIConnectionError" });
}

/** The shape an error we raised on purpose has. */
function deliberate(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, statusCode: status });
}

describe("which errors were written for the user", () => {
  it("recognises our own errors by the code they carry", () => {
    expect(isDeliberateMessage(deliberate("You have used all your free tokens.", "BUDGET_EXHAUSTED", 402))).toBe(true);
    expect(isDeliberateMessage(deliberate("The model provider is not configured", "MODEL_UNAVAILABLE", 503))).toBe(true);
  });

  it("does not mistake a provider library's failure for one of ours", () => {
    expect(isDeliberateMessage(connectionError())).toBe(false);
    expect(isDeliberateMessage(new Error("socket hang up"))).toBe(false);
    expect(isDeliberateMessage(null)).toBe(false);
    expect(isDeliberateMessage({ code: 42 })).toBe(false);
  });
});

describe("what the user is told when a turn fails", () => {
  it("shows a budget message exactly as it was written", () => {
    // These are the messages the product deliberately says, including the one
    // that tells the user when their allowance comes back.
    const written = "You have used your allowance for the last 24 hours. More becomes available in about 3 hours.";
    expect(chatFailureMessage(deliberate(written, "BUDGET_EXHAUSTED", 402))).toBe(written);
  });

  it("never repeats the provider library's own wording", () => {
    const shown = chatFailureMessage(connectionError());
    expect(shown).not.toMatch(/Connection error/i);
    expect(shown).toMatch(/could not reach/i);
  });

  it("says that sending again is worth doing when nothing got through", () => {
    // This is the whole point: the turn was lost before it started, so the user
    // needs to know the fix is to send it again, not to change what they asked.
    expect(chatFailureMessage(connectionError())).toMatch(/send that again/i);
  });

  it("treats a dropped socket the same way, whatever named it", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      const error = Object.assign(new Error("fetch failed"), { cause: { code } });
      expect(chatFailureMessage(error)).toMatch(/could not reach/i);
    }
  });

  it("tells the user to wait when the service is busy rather than to retry at once", () => {
    const busy = Object.assign(new Error("rate_limit_error"), { status: 429 });
    expect(chatFailureMessage(busy)).toMatch(/busy/i);
    expect(chatFailureMessage(busy)).toMatch(/wait a moment/i);
  });

  it("calls a provider outage brief, because it usually is", () => {
    for (const status of [500, 502, 503, 504]) {
      const down = Object.assign(new Error("upstream"), { status });
      expect(chatFailureMessage(down)).toMatch(/briefly unavailable/i);
    }
  });

  it("falls back to something plain rather than leaking an unknown message", () => {
    const odd = new Error("TypeError: Cannot read properties of undefined (reading 'usage')");
    const shown = chatFailureMessage(odd);
    expect(shown).not.toMatch(/undefined|TypeError/);
    expect(shown).toBe("That message could not be completed. Please try again.");
  });

  it("says something even when what failed was not an error at all", () => {
    expect(chatFailureMessage(null)).toBeTruthy();
    expect(chatFailureMessage("boom")).toBeTruthy();
  });
});

describe("what gets written to the log instead", () => {
  it("keeps the detail that makes the failure diagnosable", () => {
    const detail = chatFailureDetail(connectionError());
    expect(detail).toContain("APIConnectionError");
    expect(detail).toContain("Connection error.");
  });

  it("records the status and the socket code when there is one", () => {
    const error = Object.assign(new Error("fetch failed"), { status: 502, cause: { code: "ECONNRESET" } });
    const detail = chatFailureDetail(error);
    expect(detail).toContain("status=502");
    expect(detail).toContain("cause=ECONNRESET");
  });

  it("bounds the message so a huge provider body cannot flood the log", () => {
    const error = new Error("x".repeat(5_000));
    expect(chatFailureDetail(error).length).toBeLessThan(300);
  });
});
