import { randomUUID } from "node:crypto";
import type { ChatDeltaFrame } from "@workcrew/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  attachmentContentBlocks,
  classifyAttachment,
  estimateMediaTokens,
  processAndStoreAttachment
} from "./attachments.js";
import { streamChat } from "./chat.js";
import { client, getMessages, initializeDatabase, type SubscriptionRow } from "./db.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeSubscription(): SubscriptionRow {
  return {
    userId: randomUUID(),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    // Ultra so a sonnet chat turn with an attachment fits the daily cap.
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
    pendingEffectiveMs: null,
    modelMode: "economy"
  };
}

async function collect(generator: AsyncGenerator<ChatDeltaFrame>): Promise<ChatDeltaFrame[]> {
  const frames: ChatDeltaFrame[] = [];
  for await (const frame of generator) frames.push(frame);
  return frames;
}

describe("classifyAttachment", () => {
  it("recognizes pdf, image, and text by extension", () => {
    expect(classifyAttachment("report.pdf", "application/octet-stream")).toEqual({ kind: "pdf", mediaType: "application/pdf" });
    expect(classifyAttachment("photo.PNG", "application/octet-stream")).toEqual({ kind: "image", mediaType: "image/png" });
    expect(classifyAttachment("notes.md", "application/octet-stream")).toEqual({ kind: "text", mediaType: "text/plain" });
  });

  it("falls back to the mime type when the extension is unknown", () => {
    expect(classifyAttachment("scan", "image/jpeg")).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(classifyAttachment("data", "text/csv")).toEqual({ kind: "text", mediaType: "text/plain" });
  });

  it("returns null for unsupported binary office formats", () => {
    expect(classifyAttachment("sheet.xlsx", "application/octet-stream")).toBeNull();
    expect(classifyAttachment("memo.docx", "application/octet-stream")).toBeNull();
  });
});

describe("estimateMediaTokens", () => {
  it("is zero for text and bounded for images and pdfs", () => {
    expect(estimateMediaTokens({ kind: "text", sizeBytes: 5_000 })).toBe(0);
    expect(estimateMediaTokens({ kind: "image", sizeBytes: 5_000 })).toBe(2_000);
    expect(estimateMediaTokens({ kind: "pdf", sizeBytes: 100_000_000 })).toBeLessThanOrEqual(120_000);
  });
});

describe("processAndStoreAttachment", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("stores a text file as decoded text and builds a text content block", async () => {
    const userId = randomUUID();
    const ref = await processAndStoreAttachment({
      userId,
      filename: "hello.txt",
      mimeType: "text/plain",
      base64: Buffer.from("the secret number is 42", "utf8").toString("base64")
    });
    expect(ref.kind).toBe("text");
    expect(ref.sizeBytes).toBeGreaterThan(0);

    const blocks = await attachmentContentBlocks(ref.attachmentId, userId);
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).toContain("the secret number is 42");
  });

  it("stores an image as a base64 image block", async () => {
    const userId = randomUUID();
    const ref = await processAndStoreAttachment({
      userId,
      filename: "dot.png",
      mimeType: "image/png",
      base64: PNG_BASE64
    });
    expect(ref.kind).toBe("image");

    const blocks = (await attachmentContentBlocks(ref.attachmentId, userId)) as { type: string; source: { media_type: string } }[];
    expect(blocks?.[0]?.type).toBe("image");
    expect(blocks?.[0]?.source.media_type).toBe("image/png");
  });

  it("rejects unsupported types and empty files", async () => {
    const userId = randomUUID();
    await expect(
      processAndStoreAttachment({ userId, filename: "book.xlsx", mimeType: "application/octet-stream", base64: Buffer.from("x").toString("base64") })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ATTACHMENT" });
    await expect(
      processAndStoreAttachment({ userId, filename: "empty.txt", mimeType: "text/plain", base64: "" })
    ).rejects.toBeTruthy();
  });

  it("does not return another user's attachment", async () => {
    const owner = randomUUID();
    const ref = await processAndStoreAttachment({
      userId: owner,
      filename: "owned.txt",
      mimeType: "text/plain",
      base64: Buffer.from("private", "utf8").toString("base64")
    });
    const blocks = await attachmentContentBlocks(ref.attachmentId, randomUUID());
    expect(blocks).toBeNull();
  });
});

describe("streamChat with an attachment", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
    if (process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY must be unset for the mock attachment test");
  });

  it("persists the attachment ref on the user turn and completes the turn", async () => {
    const subscription = makeSubscription();
    const ref = await processAndStoreAttachment({
      userId: subscription.userId,
      filename: "brief.txt",
      mimeType: "text/plain",
      base64: Buffer.from("quarterly brief contents", "utf8").toString("base64")
    });

    const frames = await collect(
      streamChat({
        userId: subscription.userId,
        subscription,
        body: { text: "Summarize this", attachments: [ref], model: "sonnet", effort: "high", thinking: false }
      })
    );

    const done = frames.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("expected a done frame");

    const messages = await getMessages(done.conversationId, subscription.userId);
    expect(messages[0]?.role).toBe("user");
    expect(JSON.stringify(messages[0]?.content)).toContain("attachment_ref");
    expect(JSON.stringify(messages[0]?.content)).toContain(ref.attachmentId);
  });
});
