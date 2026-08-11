import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_CATALOG } from "@workcrew/contracts";
import { planAmountCents, orderIsFresh, webhookSecretMatches } from "./mpgs.js";
import { claimMpgsOrderGrant, client, createMpgsOrder, getMpgsOrder, initializeDatabase } from "./db.js";

// Card payment is the one place where getting it wrong hands out paid access for
// nothing. These pin the rules that prevent that: the price comes from the
// catalog rather than the caller, a paid order can only ever grant once no matter
// how many notifications arrive, and an unauthenticated notification is refused.

describe("planAmountCents", () => {
  it("prices from the catalog, in minor units", () => {
    expect(planAmountCents("pro", "month")).toBe(PLAN_CATALOG.pro.monthlyPriceUsd * 100);
    expect(planAmountCents("ultra", "year")).toBe(PLAN_CATALOG.ultra.yearlyPriceUsd * 100);
  });

  it("never returns a fraction of a cent", () => {
    for (const plan of ["pro", "ultra"] as const) {
      for (const interval of ["month", "year"] as const) {
        expect(Number.isInteger(planAmountCents(plan, interval))).toBe(true);
      }
    }
  });
});

describe("webhookSecretMatches", () => {
  it("refuses everything when no secret is configured", () => {
    // The deployment under test has no MPGS_WEBHOOK_SECRET set. An endpoint that
    // granted plans without one would be worse than having no endpoint at all.
    expect(webhookSecretMatches("anything")).toBe(false);
    expect(webhookSecretMatches(undefined)).toBe(false);
    expect(webhookSecretMatches("")).toBe(false);
  });
});

describe("order freshness", () => {
  const order = {
    orderId: "wc-1", userId: "u", plan: "pro" as const, interval: "month" as const,
    amountCents: 2700, currency: "USD", sessionId: "s", successIndicator: null,
    status: "pending", grantedAtMs: null, createdAtMs: 1_000_000
  };

  it("accepts an order opened moments ago", () => {
    expect(orderIsFresh(order, order.createdAtMs + 60_000)).toBe(true);
  });

  it("rejects a link left sitting for a day", () => {
    expect(orderIsFresh(order, order.createdAtMs + 25 * 60 * 60 * 1000)).toBe(false);
  });
});

describe("granting a paid order exactly once", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("lets the first claim through and refuses every later one", async () => {
    const orderId = `wc-${randomUUID()}`;
    await createMpgsOrder({
      orderId, userId: randomUUID(), plan: "pro", interval: "month", amountCents: 2700, currency: "USD"
    });

    // The return page, the webhook and a retry all try to settle the same order.
    expect(await claimMpgsOrderGrant(orderId)).toBe(true);
    expect(await claimMpgsOrderGrant(orderId)).toBe(false);
    expect(await claimMpgsOrderGrant(orderId)).toBe(false);

    const stored = await getMpgsOrder(orderId);
    expect(stored?.status).toBe("paid");
    expect(stored?.grantedAtMs).not.toBeNull();
  });

  it("holds when several notifications arrive at the same moment", async () => {
    const orderId = `wc-${randomUUID()}`;
    await createMpgsOrder({
      orderId, userId: randomUUID(), plan: "ultra", interval: "year", amountCents: 200_000, currency: "USD"
    });

    // A gateway retrying while the payer refreshes the return page is a genuine
    // race, and the guard has to be the database's, not a check in JavaScript.
    const results = await Promise.all(Array.from({ length: 5 }, () => claimMpgsOrderGrant(orderId)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("records what was bought, so the grant cannot be influenced later", async () => {
    const orderId = `wc-${randomUUID()}`;
    const userId = randomUUID();
    await createMpgsOrder({
      orderId, userId, plan: "pro", interval: "year", amountCents: 27_000, currency: "USD"
    });
    const stored = await getMpgsOrder(orderId);
    expect(stored).toMatchObject({ userId, plan: "pro", interval: "year", amountCents: 27_000, currency: "USD" });
    expect(stored?.grantedAtMs).toBeNull();
  });
});
