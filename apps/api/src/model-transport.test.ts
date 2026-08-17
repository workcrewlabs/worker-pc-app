import { describe, expect, it } from "vitest";
import { MODEL_REQUEST_TIMEOUT_MS, transportFailure } from "./anthropic.js";

// A folder run died seventeen steps in with "The service could not complete the
// request": WorkCrew's own generic 5xx message. The provider had not answered
// (slow, reset, or a gateway's HTML page), and that raw throw was never the
// MODEL_REQUEST_FAILED error the run loop knows. So the Economy-to-Claude
// fallback never fired, the catch-all marked the run permanently failed, and
// every step of work before it was lost over one slow answer.

describe("a provider that fails to answer at all", () => {
  it("becomes the provider error the run loop knows how to handle", () => {
    // MODEL_REQUEST_FAILED is what triggers the fallback to Claude and what the
    // run loop treats as resumable. Anything else is a dead end.
    const error = transportFailure(new TypeError("fetch failed"));
    expect(error.code).toBe("MODEL_REQUEST_FAILED");
    expect(error.statusCode).toBe(502);
  });

  it("names a timeout for what it is", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(transportFailure(timeout).message).toBe("The model did not answer in time");
  });

  it("describes an unreachable provider plainly, without the internals", () => {
    // The message reaches logs; a connection reset's raw text can carry hosts
    // and ports, which have no business there.
    const message = transportFailure(new Error("connect ECONNRESET 10.0.0.5:443")).message;
    expect(message).toBe("The model could not be reached");
    expect(message).not.toContain("10.0.0.5");
  });

  it("copes with a non-error being thrown", () => {
    // response.json() on an HTML page rejects with a SyntaxError; other paths
    // can throw strings. Neither may escape as a raw 500.
    expect(transportFailure("something odd").code).toBe("MODEL_REQUEST_FAILED");
    expect(transportFailure(undefined).code).toBe("MODEL_REQUEST_FAILED");
  });

  it("gives a slow engine longer than a minute, but not forever", () => {
    // The Economy engine gets slow on a long history, so a minute cut off real
    // answers. A step still running past this is not coming back.
    expect(MODEL_REQUEST_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(MODEL_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(3 * 60_000);
  });
});
