import { describe, expect, it } from "vitest";
import { stripOlderScreenshots } from "./server.js";

// A run can look at the screen a dozen times. Images cost far more input tokens
// than the text around them, and the model history is resent on every step, so
// keeping every screenshot would multiply the cost of a long task and eventually
// breach the request size. Only the newest picture is worth anything anyway: the
// planner acts on what is on screen NOW.

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

describe("stripOlderScreenshots", () => {
  it("removes the pixels but keeps what happened", () => {
    const messages = [toolResultWithImage("Screenshot of the window.")];
    stripOlderScreenshots(messages);

    const parts = (messages[0] as { content: Record<string, unknown>[] }).content[0]!.content as Record<string, unknown>[];
    expect(parts.some((part) => part.type === "image")).toBe(false);
    // The text of the step survives, so the model still knows a screenshot was
    // taken and what it said at the time.
    expect(parts.some((part) => part.type === "text" && part.text === "Screenshot of the window.")).toBe(true);
    expect(parts.some((part) => typeof part.text === "string" && /earlier step/.test(part.text as string))).toBe(true);
  });

  it("clears every older screenshot, not just the first", () => {
    const messages = [toolResultWithImage("first"), toolResultWithImage("second"), toolResultWithImage("third")];
    stripOlderScreenshots(messages);

    const images = messages.flatMap((message) =>
      ((message as { content: Record<string, unknown>[] }).content[0]!.content as Record<string, unknown>[])
        .filter((part) => part.type === "image")
    );
    expect(images).toHaveLength(0);
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
