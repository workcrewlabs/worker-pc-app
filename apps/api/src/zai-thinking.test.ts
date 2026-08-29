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

const { MIN_THINKING_TOKENS, thinkingBudgetFor, withoutForeignThinking } = await import("./anthropic.js");

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

// A run does not always stay on one engine. The moment a screenshot enters the
// history the rest of the run moves to Claude, because the Economy engine cannot
// see images. The history moved with it, still carrying the Economy engine's
// SIGNED thinking blocks, and Claude rejected the whole request on a signature
// it never issued: "messages.1.content.0: Invalid `signature` in `thinking`
// block". Every Economy task that took a screenshot part way through died
// mid-task, after real work, which is most tasks that look at the screen.

const THOUGHT = { type: "thinking", thinking: "let me look", signature: "sig-from-the-other-engine" };

describe("handing a run to a different engine", () => {
  it("strips thinking the receiving engine cannot validate", () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "open libra" }] },
      { role: "assistant", content: [THOUGHT, { type: "text", text: "opening it" }] }
    ];
    const sent = withoutForeignThinking(history, false) as typeof history;
    expect(sent[1].content).toEqual([{ type: "text", text: "opening it" }]);
  });

  it("strips redacted thinking too, which is signed the same way", () => {
    const history = [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "hi" }] }];
    expect((withoutForeignThinking(history, false) as typeof history)[0].content).toHaveLength(1);
  });

  it("keeps the answer and the tool call beside it", () => {
    // Only the private reasoning goes. Dropping a tool_use would break the
    // pairing the provider validates on the next request.
    const call = { type: "tool_use", id: "t1", name: "windows_action", input: {} };
    const history = [{ role: "assistant", content: [THOUGHT, { type: "text", text: "clicking" }, call] }];
    const sent = withoutForeignThinking(history, false) as typeof history;
    expect(sent[0].content).toEqual([{ type: "text", text: "clicking" }, call]);
  });

  it("never leaves an empty turn behind", () => {
    // A message with no content at all is rejected, which would trade one
    // broken history for another.
    const history = [{ role: "assistant", content: [THOUGHT] }];
    const sent = withoutForeignThinking(history, false) as { content: { type: string }[] }[];
    expect(sent[0].content).toHaveLength(1);
    expect(sent[0].content[0].type).toBe("text");
  });

  it("leaves the history alone while the run stays on the thinking engine", () => {
    // Same engine, so the signatures are its own and it needs them back.
    const history = [{ role: "assistant", content: [THOUGHT, { type: "text", text: "opening it" }] }];
    expect(withoutForeignThinking(history, true)).toBe(history);
  });

  it("returns the very same array when there was nothing to strip", () => {
    const history = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    expect(withoutForeignThinking(history, false)).toBe(history);
  });

  it("copes with whatever shape the history is in", () => {
    expect(withoutForeignThinking([null, "x", { role: "user" }, { role: "user", content: "plain" }], false))
      .toEqual([null, "x", { role: "user" }, { role: "user", content: "plain" }]);
  });
});
