import { describe, expect, it } from "vitest";

// Enable the Economy engine for these routing tests BEFORE the config module is
// evaluated. config reads process.env at import time, so the key must be set first
// and the registry imported dynamically afterwards. ANTHROPIC_API_KEY is left
// UNSET (other test files require that); the High-effort test toggles the Claude
// key on the config object directly, isolated with try/finally.
process.env.ZAI_API_KEY = "test-economy-key";
const { routeAutomationTier, routeChatTier, provider, economyEngineAvailable, MODEL_PRICES } = await import("./model-registry.js");
const { config } = await import("./config.js");

describe("engine routing", () => {
  it("reports the Economy engine as available when its key is set", () => {
    expect(economyEngineAvailable()).toBe(true);
    expect(provider("glm")).toBe("zai");
    expect(provider("haiku")).toBe("anthropic");
    expect(provider("sonnet")).toBe("anthropic");
    expect(provider("opus")).toBe("anthropic");
  });

  it("prices the Economy engine below Sonnet and Opus so the shared budget goes further", () => {
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.sonnet.output);
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.opus.output);
    expect(MODEL_PRICES.glm.output).toBeLessThan(MODEL_PRICES.haiku.output);
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
    it("runs chats on the Economy engine in Economy mode", () => {
      expect(routeChatTier({ mode: "economy", requested: "auto", task: "hi" })).toBe("glm");
      expect(routeChatTier({ mode: "economy", requested: "auto", task: "a".repeat(5_000) })).toBe("glm");
    });

    it("uses capability-aware Claude routing in Privacy mode", () => {
      expect(routeChatTier({ mode: "privacy", requested: "auto", task: "hi" })).toBe("haiku");
      expect(routeChatTier({ mode: "privacy", requested: "auto", task: "please analyze this across multiple pages" })).toBe("sonnet");
      // A pinned tier is always honored.
      expect(routeChatTier({ mode: "privacy", requested: "opus", task: "hi" })).toBe("opus");
    });

    it("keeps Quick and Medium effort on the Economy engine", () => {
      expect(routeChatTier({ mode: "economy", requested: "haiku", task: "x" })).toBe("glm");
      expect(routeChatTier({ mode: "economy", requested: "sonnet", task: "x" })).toBe("glm");
    });

    it("sends High effort (opus) to Claude in Economy mode, only when a Claude key is configured", () => {
      // config is exposed read-only; toggle it through a mutable view for the test.
      const mutable = config as unknown as { anthropicApiKey?: string };
      const original = mutable.anthropicApiKey;
      try {
        mutable.anthropicApiKey = "test-claude-key";
        expect(routeChatTier({ mode: "economy", requested: "opus", task: "make a budget" })).toBe("opus");
        mutable.anthropicApiKey = undefined;
        // Without a Claude key it stays on the Economy engine rather than failing.
        expect(routeChatTier({ mode: "economy", requested: "opus", task: "make a budget" })).toBe("glm");
      } finally {
        mutable.anthropicApiKey = original;
      }
    });
  });
});
