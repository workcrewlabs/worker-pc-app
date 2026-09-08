import { describe, expect, it } from "vitest";
import { browserActionSchema } from "./index.js";

const batch = (steps: unknown) => browserActionSchema.safeParse({ kind: "browser", command: "batch", steps });

describe("running several browser steps in one round trip", () => {
  it("accepts an ordinary sequence", () => {
    const parsed = batch([
      { command: "click", target: "e4" },
      { command: "fill", target: "e4", value: "hello@example.com" },
      { command: "press", key: "Enter" }
    ]);
    expect(parsed.success).toBe(true);
  });

  it("refuses a batch inside a batch, so work stays bounded", () => {
    // Without this a single action could nest its way to unlimited steps.
    expect(batch([{ command: "batch" }]).success).toBe(false);
  });

  it("refuses an empty or oversized batch", () => {
    expect(batch([]).success).toBe(false);
    expect(batch(Array.from({ length: 21 }, () => ({ command: "snapshot" }))).success).toBe(false);
    expect(batch(Array.from({ length: 20 }, () => ({ command: "snapshot" }))).success).toBe(true);
  });

  it("still rejects unknown fields inside a step", () => {
    expect(batch([{ command: "click", target: "e1", script: "alert(1)" }]).success).toBe(false);
  });

  it("keeps every existing single command working unchanged", () => {
    expect(browserActionSchema.safeParse({ kind: "browser", command: "snapshot" }).success).toBe(true);
    expect(browserActionSchema.safeParse({ kind: "browser", command: "goto", url: "https://example.com" }).success).toBe(true);
  });

  it("holds a step to the same limits as a single action", () => {
    expect(batch([{ command: "goto", url: "not-a-url" }]).success).toBe(false);
    expect(batch([{ command: "fill", target: "e1", value: "x".repeat(10_001) }]).success).toBe(false);
  });
});
