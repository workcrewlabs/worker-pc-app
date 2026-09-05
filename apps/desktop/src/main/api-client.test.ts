import { describe, expect, it } from "vitest";
import { RETRY_DELAY_MS, backendUnavailableMessage, isTransientStatus, neverReachedTheBackend } from "./api-client";

// A folder run died mid-task showing the user this:
//   SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
// Something in front of WorkCrew (a gateway, an outage page, the seconds while
// the service restarts) answered with a web page, and the app called .json() on
// it without looking. The raw parse failure then travelled all the way to the
// screen, describing our disappointment rather than anything the user could act
// on, after 26 commands of real work.

describe("what counts as worth trying again", () => {
  it("retries the answers that mean nobody handled the request", () => {
    // A gateway with no healthy instance behind it, which is what a restart
    // looks like from outside.
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(504)).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
  });

  it("never retries a refusal, which would only be refused again", () => {
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(402)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(409)).toBe(false);
  });

  it("never retries being told to slow down", () => {
    // Repeating a rate-limited request is the one response that makes it worse.
    expect(isTransientStatus(429)).toBe(false);
  });

  it("does not treat a plain server error as unhandled", () => {
    // A 500 means WorkCrew itself failed and answered in its own words; that
    // answer is the useful one, and repeating the request would repeat the bug.
    expect(isTransientStatus(500)).toBe(false);
  });
});

describe("what the user is told when the backend does not answer in its own words", () => {
  it("says the service is briefly unavailable, not that JSON failed to parse", () => {
    const message = backendUnavailableMessage(503);
    expect(message).toBe("WorkCrew is briefly unavailable. Please try again in a moment.");
    expect(message).not.toMatch(/JSON|token|DOCTYPE|SyntaxError/i);
  });

  it("names a lost connection as a connection problem", () => {
    expect(backendUnavailableMessage(0)).toMatch(/internet connection/i);
  });

  it("tells someone being rate limited to wait", () => {
    expect(backendUnavailableMessage(429)).toMatch(/wait a moment/i);
  });

  it("never leaks the page that was actually returned", () => {
    // An outage page can be kilobytes of markup, and none of it belongs on
    // screen or in a log.
    for (const status of [0, 408, 429, 500, 502, 503, 504, 599]) {
      const message = backendUnavailableMessage(status);
      expect(message).not.toMatch(/<|DOCTYPE|html/i);
      expect(message.length).toBeLessThan(120);
    }
  });

  it("always ends with something the user can do", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(backendUnavailableMessage(status)).toMatch(/try again|wait a moment/i);
    }
  });
});

describe("the pause before trying again", () => {
  it("waits long enough for a restart, briefly enough to sit through", () => {
    expect(RETRY_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(RETRY_DELAY_MS).toBeLessThanOrEqual(3_000);
  });
});

// The chat stream opens its own connection rather than going through
// ApiClient, so it needed the same judgement about what is safe to send twice.
// The failure that prompted this was a message answered with the word "fetch
// failed": the backend had been restarting, so nothing was ever delivered.

describe("what is safe to send a second time", () => {
  const withCode = (code: string): Error => Object.assign(new Error("fetch failed"), { cause: { code } });

  it("retries a connection that was refused outright", () => {
    // Nothing was delivered, so a second attempt cannot duplicate anything.
    expect(neverReachedTheBackend(withCode("ECONNREFUSED"))).toBe(true);
  });

  it("retries a hostname that did not resolve", () => {
    expect(neverReachedTheBackend(withCode("ENOTFOUND"))).toBe(true);
  });

  it("does not retry a connection dropped after it was opened", () => {
    // This is the dangerous one. The request may have landed and started
    // spending, so sending it again would file the message twice and charge
    // for both.
    expect(neverReachedTheBackend(withCode("ECONNRESET"))).toBe(false);
    expect(neverReachedTheBackend(withCode("ETIMEDOUT"))).toBe(false);
    expect(neverReachedTheBackend(withCode("EPIPE"))).toBe(false);
  });

  it("does not retry a failure that says nothing about delivery", () => {
    expect(neverReachedTheBackend(new Error("fetch failed"))).toBe(false);
    expect(neverReachedTheBackend(undefined)).toBe(false);
    expect(neverReachedTheBackend(null)).toBe(false);
    expect(neverReachedTheBackend("ECONNREFUSED")).toBe(false);
  });

  it("does not mistake a non-string code for one it recognises", () => {
    expect(neverReachedTheBackend({ cause: { code: 111 } })).toBe(false);
  });

  it("tells the user something they can act on instead of 'fetch failed'", () => {
    // The whole point of the change: Node's own wording never reaches a person.
    const shown = backendUnavailableMessage(0);
    expect(shown).not.toMatch(/fetch failed/i);
    expect(shown).toMatch(/connection/i);
  });
});
