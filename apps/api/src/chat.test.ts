import { randomUUID } from "node:crypto";
import type { ChatDeltaFrame } from "@workcrew/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { streamChat } from "./chat.js";
import { client, getMessages, initializeDatabase, type SubscriptionRow } from "./db.js";

// A fake active subscription for an isolated user. A unique anchor per call keeps
// each test inside its own billing window so reservations never collide with
// other rows in the shared local database file.
function makeSubscription(): SubscriptionRow {
  return {
    userId: randomUUID(),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    // Ultra so a sonnet chat turn's worst-case reservation fits the daily cap.
    plan: "ultra",
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: Date.now(),
    currentPeriodEndMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    autoReloadEnabled: false,
    autoReloadPack: "small",
    monthlyTopupLimitMicro: 0,
    stripePaymentMethodId: null,
    pendingPlan: null,
    pendingInterval: null,
    pendingEffectiveMs: null
  };
}

async function collect(generator: AsyncGenerator<ChatDeltaFrame>): Promise<ChatDeltaFrame[]> {
  const frames: ChatDeltaFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("streamChat mock path", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
    // The mock path is selected when there is no Anthropic key configured, which
    // is the case in the test environment. This guards against an accidental
    // network call: the suite would fail rather than reach the live SDK.
    if (process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY must be unset for the mock chat test");
    }
  });

  it("yields one or more text frames then a done frame for a new conversation", async () => {
    const subscription = makeSubscription();
    const frames = await collect(
      streamChat({
        userId: subscription.userId,
        subscription,
        body: { text: "Hello there", attachments: [], model: "sonnet", effort: "high", thinking: false }
      })
    );

    const textFrames = frames.filter((frame) => frame.type === "text");
    expect(textFrames.length).toBeGreaterThanOrEqual(1);

    const last = frames.at(-1);
    expect(last?.type).toBe("done");
    if (last?.type !== "done") throw new Error("expected a terminal done frame");
    expect(last.conversationId).toMatch(/[0-9a-f-]{36}/);
    expect(last.messageId).toMatch(/[0-9a-f-]{36}/);
    expect(last.usage.budgetMicrodollars).toBe(60_000_000);
    // The mock turn settles a small fixed cost, so used is positive but tiny.
    expect(last.usage.usedMicrodollars).toBeGreaterThan(0);
    expect(last.usage.usedMicrodollars).toBeLessThanOrEqual(last.usage.budgetMicrodollars);

    // No error frame is emitted on the happy path.
    expect(frames.some((frame) => frame.type === "error")).toBe(false);
  });

  it("persists the user and assistant messages and continues the conversation", async () => {
    const subscription = makeSubscription();
    const first = await collect(
      streamChat({
        userId: subscription.userId,
        subscription,
        body: { text: "First question", attachments: [], model: "sonnet", effort: "high", thinking: false }
      })
    );
    const done = first.at(-1);
    if (done?.type !== "done") throw new Error("expected a done frame");

    // After one turn there is a user message and an assistant message.
    const afterFirst = await getMessages(done.conversationId);
    expect(afterFirst.map((message) => message.role)).toEqual(["user", "assistant"]);

    // A second turn into the same conversation appends two more messages.
    const second = await collect(
      streamChat({
        userId: subscription.userId,
        subscription,
        body: {
          conversationId: done.conversationId,
          text: "Follow up",
          attachments: [],
          model: "sonnet",
          effort: "high",
          thinking: false
        }
      })
    );
    expect(second.at(-1)?.type).toBe("done");

    const afterSecond = await getMessages(done.conversationId);
    expect(afterSecond.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("yields an error frame for an unknown conversation id without throwing", async () => {
    const subscription = makeSubscription();
    const frames = await collect(
      streamChat({
        userId: subscription.userId,
        subscription,
        body: {
          conversationId: randomUUID(),
          text: "Hello",
          attachments: [],
          model: "sonnet",
          effort: "high",
          thinking: false
        }
      })
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "error" });
  });
});
