import { describe, expect, it, vi } from "vitest";

// GLM 5.3 and later ALWAYS think, and refuse any request that does not ask for
// it: "this model always engages in thinking and cannot be disabled; please use
// low, high, or max". Verified against the live API, along with the fact that
// 5.2 accepts the same field. So the field is sent for every z.ai model, and
// moving ZAI_MODEL between them needs nothing else changed.

vi.mock("./config.js", () => ({
  config: {
    zaiThinkingBudget: 1_024,
    zai: { apiKey: "test", baseUrl: "https://example.invalid", enabled: true },
    anthropicApiKey: "test",
    models: { haiku: "h", sonnet: "s", opus: "o", glm: "glm-5.3" },
    mockAi: false,
    nodeEnv: "test"
  }
}));

const { MIN_THINKING_TOKENS, thinkingBudgetFor } = await import("./anthropic.js");

describe("room to think on an Economy step", () => {
  it("asks for it on the Economy engine, which refuses the request without it", () => {
    expect(thinkingBudgetFor("glm", 4_000)).toBeGreaterThan(0);
  });

  it("never asks Claude for it, which is not what that field means there", () => {
    for (const tier of ["haiku", "sonnet", "opus"] as const) {
      expect(thinkingBudgetFor(tier, 4_000)).toBe(0);
    }
  });

  it("always leaves room for the answer itself", () => {
    // Thinking is spent FROM the step's ceiling. A budget at or above it would
    // consume every token before a single word of the answer.
    for (const ceiling of [256, 1_000, 4_000, 8_000]) {
      expect(thinkingBudgetFor("glm", ceiling)).toBeLessThan(ceiling);
    }
  });

  it("shrinks with the ceiling when the user is near their limit", () => {
    expect(thinkingBudgetFor("glm", 600)).toBeLessThan(thinkingBudgetFor("glm", 4_000));
  });

  it("drops it rather than sending a uselessly small amount", () => {
    // A token or two of thinking buys nothing and still costs a round trip.
    expect(thinkingBudgetFor("glm", 200)).toBe(0);
    expect(MIN_THINKING_TOKENS).toBeGreaterThanOrEqual(64);
  });
});
