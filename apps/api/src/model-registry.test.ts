import { describe, expect, it } from "vitest";

// Enable the Economy engine for these routing tests BEFORE the config module is
// evaluated. config reads process.env at import time, so the key must be set first
// and the registry imported dynamically afterwards. ANTHROPIC_API_KEY is left
// UNSET (other test files require that); the High-effort test toggles the Claude
// key on the config object directly, isolated with try/finally.
process.env.ZAI_API_KEY = "test-economy-key";
const { routeAutomationTier, routeChatTier, provider, economyEngineAvailable, minimaxAvailable, MODEL_PRICES } = await import("./model-registry.js");
const { config } = await import("./config.js");

describe("engine routing", () => {
  it("reports the Economy engine as available when its key is set", () => {
    expect(economyEngineAvailable()).toBe(true);
    expect(provider("glm")).toBe("zai");
    expect(provider("glm-flash")).toBe("zai");
    expect(provider("minimax")).toBe("minimax");
    expect(provider("haiku")).toBe("anthropic");
    expect(provider("sonnet")).toBe("anthropic");
    expect(provider("opus")).toBe("anthropic");
  });

  it("reports the second Economy provider as unavailable until its own key is set", () => {
    // Only ZAI_API_KEY is set for this suite; MiniMax needs its own separate key,
    // and Medium effort must not silently assume the zai key covers it too.
    expect(minimaxAvailable()).toBe(false);
  });

  it("prices the Economy engine below Sonnet and Opus so the shared budget goes further", () => {
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.sonnet.output);
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.opus.output);
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.haiku.output);
  });

  it("prices the flash and second-provider tiers below the flagship, so Auto's ladder actually saves money by using them", () => {
    expect(MODEL_PRICES["glm-flash"].output).toBeLessThan(MODEL_PRICES.glm.output);
    expect(MODEL_PRICES.minimax.output).toBeLessThan(MODEL_PRICES.glm.output);
  });

  describe("routeAutomationTier", () => {
    it("runs the loop on the Economy engine in Economy mode", () => {
      expect(routeAutomationTier({ mode: "economy", escalated: false, ultra: false })).toBe("glm");
      expect(routeAutomationTier({ mode: "economy", escalated: false, ultra: true })).toBe("glm");
    });

    it("runs the loop on cheap Claude Haiku in Privacy mode (never the Economy engine)", () => {
      expect(routeAutomationTier({ mode: "privacy", escalated: false, ultra: false })).toBe("haiku");
      expect(routeAutomationTier({ mode: "privacy", escalated: false, ultra: true })).toBe("haiku");
    });

    it("hands off to Claude once escalated: Sonnet normally, Opus for Ultra", () => {
      expect(routeAutomationTier({ mode: "economy", escalated: true, ultra: false })).toBe("sonnet");
      expect(routeAutomationTier({ mode: "economy", escalated: true, ultra: true })).toBe("opus");
      // Escalation target is the same regardless of mode.
      expect(routeAutomationTier({ mode: "privacy", escalated: true, ultra: false })).toBe("sonnet");
    });
  });

  describe("routeChatTier", () => {
    it("runs a plain short question on the cheapest Economy tier", () => {
      expect(routeChatTier({ mode: "economy", requested: "auto", task: "hi" })).toBe("glm-flash");
    });

    it("moves a genuinely long or hard-reading request straight to the flagship", () => {
      // Long enough, or reading as deep reasoning, to skip the middle tier
      // entirely: two engines were only ever going to hand it upward anyway.
      expect(routeChatTier({ mode: "economy", requested: "auto", task: "a".repeat(5_000) })).toBe("glm");
      expect(routeChatTier({ mode: "economy", requested: "auto", task: "think step by step and derive the root cause" })).toBe("glm");
    });

    it("moves ordinary planning-shaped work up one step, to the second Economy provider when it is configured", () => {
      const task = "please analyze this and coordinate across multiple pages";
      const mutable = config as unknown as { minimax?: { enabled: boolean } };
      const original = mutable.minimax;
      try {
        mutable.minimax = { enabled: true };
        expect(routeChatTier({ mode: "economy", requested: "auto", task })).toBe("minimax");
        mutable.minimax = { enabled: false };
        // Not configured yet: stays inside Economy on the flagship, not blocked.
        expect(routeChatTier({ mode: "economy", requested: "auto", task })).toBe("glm");
      } finally {
        mutable.minimax = original;
      }
    });

    it("uses capability-aware Claude routing in Privacy mode", () => {
      expect(routeChatTier({ mode: "privacy", requested: "auto", task: "hi" })).toBe("haiku");
      expect(routeChatTier({ mode: "privacy", requested: "auto", task: "please analyze this across multiple pages" })).toBe("sonnet");
      // A pinned tier is always honored.
      expect(routeChatTier({ mode: "privacy", requested: "opus", task: "hi" })).toBe("opus");
    });

    it("pins each effort level to its own Economy tier", () => {
      expect(routeChatTier({ mode: "economy", requested: "haiku", task: "x" })).toBe("glm-flash");
      // Medium falls back to the flagship, not Claude, when the second provider
      // has no key yet: still cheaper, and still inside Economy mode's own chain.
      expect(routeChatTier({ mode: "economy", requested: "sonnet", task: "x" })).toBe("glm");
      expect(routeChatTier({ mode: "economy", requested: "opus", task: "x" })).toBe("glm");
    });

    it("never sends High effort to Claude in Economy mode, whether or not a Claude key exists", () => {
      // Economy mode's whole point is staying off Claude. The flagship Economy
      // model used to need a Claude escape hatch for hard work; it no longer
      // does, and a Claude key being configured must not quietly bring that
      // escape back.
      const mutable = config as unknown as { anthropicApiKey?: string };
      const original = mutable.anthropicApiKey;
      try {
        mutable.anthropicApiKey = "test-claude-key";
        expect(routeChatTier({ mode: "economy", requested: "opus", task: "make a budget" })).toBe("glm");
        mutable.anthropicApiKey = undefined;
        expect(routeChatTier({ mode: "economy", requested: "opus", task: "make a budget" })).toBe("glm");
      } finally {
        mutable.anthropicApiKey = original;
      }
    });
  });
});
