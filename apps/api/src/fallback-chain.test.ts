import { describe, expect, it, vi } from "vitest";

const minimaxEnabled = { value: true };

vi.mock("./config.js", () => ({
  config: {
    anthropicApiKey: "sk-test",
    models: { haiku: "h", sonnet: "s", opus: "o", glm: "g", "glm-flash": "gf", minimax: "m" },
    zai: { apiKey: "z", baseUrl: "https://zai.test", enabled: true },
    get minimax() {
      return { apiKey: "m", baseUrl: "https://minimax.test", enabled: minimaxEnabled.value };
    }
  }
}));

const { fallbackChain } = await import("./model-registry.js");

describe("which engine a failed turn tries next", () => {
  it("crosses to the other provider before Claude", () => {
    // The two GLM tiers share one z.ai account. An empty or rate-limited
    // account fails both, so the other provider is the attempt that can still
    // work, and it must come first.
    expect(fallbackChain("glm", "sonnet")).toEqual(["glm", "minimax", "sonnet"]);
    expect(fallbackChain("glm-flash", "sonnet")).toEqual(["glm-flash", "minimax", "glm", "sonnet"]);
    expect(fallbackChain("minimax", "sonnet")).toEqual(["minimax", "glm", "sonnet"]);
  });

  it("always puts Claude last, never first", () => {
    for (const tier of ["glm", "glm-flash", "minimax"] as const) {
      const chain = fallbackChain(tier, "opus");
      expect(chain[chain.length - 1]).toBe("opus");
      expect(chain.indexOf("opus")).toBe(chain.length - 1);
    }
  });

  it("never leaves Claude once a turn is on it, so Privacy mode stays private", () => {
    for (const tier of ["haiku", "sonnet", "opus"] as const) {
      expect(fallbackChain(tier, "opus")).toEqual([tier]);
    }
  });

  it("skips MiniMax entirely when no MiniMax key is configured", () => {
    minimaxEnabled.value = false;
    try {
      expect(fallbackChain("glm", "sonnet")).toEqual(["glm", "sonnet"]);
      expect(fallbackChain("glm-flash", "sonnet")).toEqual(["glm-flash", "glm", "sonnet"]);
    } finally {
      minimaxEnabled.value = true;
    }
  });

  it("stands alone on Economy when no Claude key is configured", () => {
    expect(fallbackChain("glm", null)).toEqual(["glm", "minimax"]);
  });

  it("never repeats an engine", () => {
    for (const tier of ["glm", "glm-flash", "minimax"] as const) {
      const chain = fallbackChain(tier, "sonnet");
      expect(new Set(chain).size).toBe(chain.length);
    }
  });
});
