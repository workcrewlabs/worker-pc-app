import { describe, expect, it } from "vitest";
import { stripOlderScreenshots, withoutImageBytes } from "./server.js";

// The vision loop follows the reference computer-use implementations: every
// acting step carries a screenshot, only the newest few are kept in history,
// and the budget prices images by what the API actually charges rather than by
// their base64 size. These tests pin both halves, because each one failing is
// invisible until a run either goes blind or hits a phantom usage limit.

function toolResultWithImage(text: string): Record<string, unknown> {
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_1",
      is_error: false,
      content: [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }
      ]
    }]
  };
}

function imagesIn(messages: unknown[]): number {
  return messages.reduce<number>((count, message) => {
    const content = (message as { content?: Record<string, unknown>[] }).content;
    if (!Array.isArray(content)) return count;
    for (const block of content) {
      if (Array.isArray(block.content)) {
        count += (block.content as Record<string, unknown>[]).filter((part) => part.type === "image").length;
      }
    }
    return count;
  }, 0);
}

describe("stripOlderScreenshots", () => {
  it("keeps the newest screenshot and strips the older ones", () => {
    const messages = [toolResultWithImage("first"), toolResultWithImage("second"), toolResultWithImage("third")];
    stripOlderScreenshots(messages);

    expect(imagesIn(messages)).toBe(1);
    // The survivor must be the NEWEST one: the planner acts on what is on
    // screen now, and keeping an old picture instead would be worse than none.
    const parts = (messages[2] as { content: Record<string, unknown>[] }).content[0]!.content as Record<string, unknown>[];
    expect(parts.some((part) => part.type === "image")).toBe(true);
  });

  it("keeps what happened even where the pixels are dropped", () => {
    const messages = [toolResultWithImage("clicked the tile"), toolResultWithImage("newest")];
    stripOlderScreenshots(messages);

    const stripped = (messages[0] as { content: Record<string, unknown>[] }).content[0]!.content as Record<string, unknown>[];
    expect(stripped.some((part) => part.type === "text" && part.text === "clicked the tile")).toBe(true);
    expect(stripped.some((part) => typeof part.text === "string" && /earlier step/.test(part.text as string))).toBe(true);
  });

  it("can strip everything when asked to keep none", () => {
    const messages = [toolResultWithImage("only")];
    stripOlderScreenshots(messages, 0);
    expect(imagesIn(messages)).toBe(0);
  });

  it("leaves ordinary text results and assistant turns alone", () => {
    const messages: unknown[] = [
      { role: "assistant", content: [{ type: "text", text: "planning" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: false, content: "Clicked control 12" }] }
    ];
    const before = JSON.stringify(messages);
    stripOlderScreenshots(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("does not fall over on a malformed history", () => {
    const messages: unknown[] = [null, "nonsense", { role: "user" }, { role: "user", content: "plain string" }];
    expect(() => stripOlderScreenshots(messages)).not.toThrow();
  });
});

describe("withoutImageBytes", () => {
  it("counts the images and replaces their bytes with a stub", () => {
    const messages = [toolResultWithImage("first"), toolResultWithImage("second")];
    const { messages: cleaned, imageCount } = withoutImageBytes(messages);

    expect(imageCount).toBe(2);
    expect(imagesIn(cleaned)).toBe(0);
    // The whole point: the estimate payload must not carry base64, which the
    // byte-based budget bound would count as one token per byte and reject a
    // vision step against the daily cap.
    expect(JSON.stringify(cleaned)).not.toContain("AAAA");
  });

  it("never mutates the run's real messages", () => {
    const messages = [toolResultWithImage("only")];
    const before = JSON.stringify(messages);
    withoutImageBytes(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("reports zero images for a text-only history", () => {
    const messages: unknown[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", is_error: false, content: "Connected" }] }
    ];
    const { imageCount } = withoutImageBytes(messages);
    expect(imageCount).toBe(0);
  });
});
