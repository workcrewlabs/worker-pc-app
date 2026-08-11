import { describe, expect, it } from "vitest";
import { mpgsOrderQuerySchema } from "./server.js";

// A real payment was taken and the payer was shown "That payment link is not
// valid", because the return URL was validated strictly and the gateway appends
// its own parameters to it. Those parameters differ by gateway version and are
// outside our control, so the rule is: read the one parameter we put there and
// ignore everything else.

describe("the return URL the gateway sends the payer back to", () => {
  it("accepts the gateway's own parameters alongside ours", () => {
    // Exactly the shape that failed in production.
    const parsed = mpgsOrderQuerySchema.safeParse({
      order: "wc-2654dc0f-b87f-4483-9eca-174b8e885423",
      resultIndicator: "3ba502ab88494aa8",
      sessionVersion: "932a042a01",
      checkoutVersion: "1.0.0"
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.order).toBe("wc-2654dc0f-b87f-4483-9eca-174b8e885423");
  });

  it("accepts a plain return with nothing extra", () => {
    expect(mpgsOrderQuerySchema.safeParse({ order: "wc-1" }).success).toBe(true);
  });

  it("still refuses a return with no order at all", () => {
    expect(mpgsOrderQuerySchema.safeParse({ resultIndicator: "abc" }).success).toBe(false);
    expect(mpgsOrderQuerySchema.safeParse({}).success).toBe(false);
  });

  it("still bounds the order id", () => {
    expect(mpgsOrderQuerySchema.safeParse({ order: "x".repeat(500) }).success).toBe(false);
    expect(mpgsOrderQuerySchema.safeParse({ order: "" }).success).toBe(false);
  });
});
