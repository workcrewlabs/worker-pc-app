import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsEnabled, captureAnonymous, captureEvent, safeErrorCategory } from "./analytics.js";

describe("safeErrorCategory", () => {
  it("prefers an uppercase error code", () => {
    expect(safeErrorCategory({ code: "RATE_LIMITED" })).toBe("RATE_LIMITED");
  });

  it("falls back to an http status", () => {
    expect(safeErrorCategory({ statusCode: 503 })).toBe("http_503");
  });

  it("uses the error class name when there is no code or status", () => {
    expect(safeErrorCategory(new TypeError("nope"))).toBe("TypeError");
  });

  it("never echoes a raw message that could carry identifiers or input", () => {
    expect(safeErrorCategory("boom: secret path C:/Users/x")).toBe("unknown");
  });
});

describe("analytics is off unless configured", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is disabled with no PostHog key (the test environment default)", () => {
    expect(analyticsEnabled()).toBe(false);
  });

  it("sends nothing to the network when disabled", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    captureEvent("user-1", "login_succeeded", {});
    captureAnonymous("app_error", { category: "x" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
