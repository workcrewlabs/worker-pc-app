import { describe, expect, it, vi } from "vitest";

// Both engines fully configured, which is the only state in which this bug can
// happen: with no Economy key every route already returns Claude, so a test
// against the real config would pass without the fix being there at all.
vi.mock("./config.js", () => ({
  config: {
    anthropicApiKey: "sk-test-key",
    zai: { enabled: true, apiKey: "zai-test-key", baseUrl: "https://example.invalid" },
    // The second Economy provider left unconfigured here on purpose: this suite
    // is about the ONE zai engine that cannot see, so leaving MiniMax off keeps
    // that the only route off it, exactly as when this suite was first written.
    minimax: { enabled: false, apiKey: undefined, baseUrl: "https://example.invalid" },
    models: { glm: "glm-5.3", "glm-flash": "glm-5.3-flash", minimax: "MiniMax-M3", haiku: "claude-haiku", sonnet: "claude-sonnet", opus: "claude-opus" },
    mockAi: false,
    nodeEnv: "test"
  }
}));

import { withoutUnseeableImages } from "./anthropic.js";
import { engineSeesImages, routeAutomationTier, routeChatTier } from "./model-registry.js";

// A user pasted a screenshot and was told, confidently, what a completely
// different screenshot contained. The Economy engine does not read images and
// does not say so: sent one, it answers 200 OK with "I cannot see any image"
// only if asked directly, and otherwise invents a plausible description. So a
// request carrying a picture must never be sent to it.

describe("which engines can see", () => {
  it("knows the Economy engine cannot", () => {
    expect(engineSeesImages("glm")).toBe(false);
  });

  it("knows every Claude tier can", () => {
    expect(engineSeesImages("haiku")).toBe(true);
    expect(engineSeesImages("sonnet")).toBe(true);
    expect(engineSeesImages("opus")).toBe(true);
  });
});

describe("routing a chat turn that carries a picture", () => {
  it("still runs an ordinary text turn on the cheap engine", () => {
    // The saving that Economy mode exists for, unchanged: a plain short request
    // stays on the flash tier rather than the pricier flagship.
    expect(routeChatTier({ mode: "economy", requested: "auto", task: "write me a haiku" })).toBe("glm-flash");
  });

  it("moves a turn with an image off it", () => {
    const tier = routeChatTier({ mode: "economy", requested: "auto", task: "what is in this screenshot", hasImage: true });
    expect(tier).not.toBe("glm");
    expect(engineSeesImages(tier)).toBe(true);
  });

  it("leaves Privacy mode exactly as it was", () => {
    const tier = routeChatTier({ mode: "privacy", requested: "auto", task: "what is in this screenshot", hasImage: true });
    expect(engineSeesImages(tier)).toBe(true);
  });
});

describe("routing an automation step whose history holds screenshots", () => {
  it("still runs a screenshot-free run on the cheap engine", () => {
    // Coding in a folder takes no screenshots, so it keeps the Economy price.
    expect(routeAutomationTier({ mode: "economy", escalated: false, ultra: false, hasImage: false })).toBe("glm");
  });

  it("never plans clicks on an engine that cannot see the screen", () => {
    const tier = routeAutomationTier({ mode: "economy", escalated: false, ultra: false, hasImage: true });
    expect(tier).not.toBe("glm");
    expect(engineSeesImages(tier)).toBe(true);
  });

  it("keeps escalation to Claude unchanged", () => {
    expect(routeAutomationTier({ mode: "economy", escalated: true, ultra: true, hasImage: true })).toBe("opus");
    expect(routeAutomationTier({ mode: "economy", escalated: true, ultra: false, hasImage: false })).toBe("sonnet");
  });
});

describe("the layer underneath the routing", () => {
  const withPicture = [
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what do you see" }
    ] }
  ];

  it("tells a blind engine an image was there rather than letting it invent one", () => {
    const cleaned = withoutUnseeableImages(withPicture, "glm") as { content: { type: string; text?: string }[] }[];
    const kinds = cleaned[0]!.content.map((block) => block.type);
    expect(kinds).toEqual(["text", "text"]);
    expect(cleaned[0]!.content[0]!.text).toContain("cannot see images");
    // The user's own words survive: only the picture is replaced.
    expect(cleaned[0]!.content[1]!.text).toBe("what do you see");
  });

  it("never strips the picture from an engine that can see it", () => {
    expect(withoutUnseeableImages(withPicture, "sonnet")).toBe(withPicture);
    expect(withoutUnseeableImages(withPicture, "haiku")).toBe(withPicture);
  });

  it("returns text-only history untouched, so nothing is copied for nothing", () => {
    const plain = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(withoutUnseeableImages(plain, "glm")).toBe(plain);
  });

  it("survives history shapes it does not recognise", () => {
    expect(withoutUnseeableImages([null, 7, { role: "user" }], "glm")).toEqual([null, 7, { role: "user" }]);
  });
});
