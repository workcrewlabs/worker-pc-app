import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_CATALOG } from "@workcrew/contracts";
import { budgetHeadroom, budgetWindowFor, reserveBudget } from "./budget.js";
import { client, getSubscription, grantFreeSubscriptionIfAbsent, initializeDatabase, upsertSubscription } from "./db.js";

// The free tier is granted once per user, renews its $0.30 allowance through
// the same monthly budget windows paid plans use, and must never interfere
// with a paid subscription. These tests run the real SQL against isolated
// users, like the budget ledger tests.
describe("free tier", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("grants the free plan once and is idempotent", async () => {
    const userId = randomUUID();
    await grantFreeSubscriptionIfAbsent(userId);
    const first = await getSubscription(userId);
    expect(first?.plan).toBe("free");
    expect(first?.active).toBe(true);
    expect(first?.stripeSubscriptionId).toBeNull();
    expect(first?.currentPeriodEndMs).toBeGreaterThan(Date.now());

    // A second grant must not reset the budget anchor (that would refresh the
    // monthly allowance) or change anything else.
    await grantFreeSubscriptionIfAbsent(userId);
    const second = await getSubscription(userId);
    expect(second?.budgetAnchorMs).toBe(first?.budgetAnchorMs);
  });

  it("never touches an existing paid subscription", async () => {
    const userId = randomUUID();
    const stripeSubscriptionId = `sub_test_${randomUUID()}`;
    await upsertSubscription({
      userId,
      stripeCustomerId: "cus_test",
      stripeSubscriptionId,
      plan: "pro",
      interval: "month",
      status: "active",
      active: true,
      budgetAnchorMs: Date.now(),
      currentPeriodEndMs: Date.now() + 30 * 24 * 60 * 60 * 1000
    });
    await grantFreeSubscriptionIfAbsent(userId);
    const row = await getSubscription(userId);
    expect(row?.plan).toBe("pro");
    expect(row?.stripeSubscriptionId).toBe(stripeSubscriptionId);
  });

  it("caps a free user's spend at the $0.30 monthly allowance", async () => {
    const userId = randomUUID();
    await grantFreeSubscriptionIfAbsent(userId);
    const subscription = await getSubscription(userId);
    if (!subscription) throw new Error("free grant missing");

    const headroom = await budgetHeadroom(userId, subscription);
    expect(headroom.monthly).toBe(PLAN_CATALOG.free.monthlyApiBudgetMicrodollars);
    expect(headroom.monthly).toBe(300_000);

    // Reserve most of the allowance, then confirm the next reservation is
    // clamped to what is actually left, so the total can never pass $0.30.
    const first = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 250_000 });
    expect(first.reservedMicrodollars).toBe(250_000);
    const second = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 100_000 });
    expect(second.reservedMicrodollars).toBeLessThanOrEqual(50_000);
  });

  it("uses one fixed lifetime window that never rolls over", () => {
    const subscription = { plan: "free" as const, budgetAnchorMs: Date.UTC(2026, 0, 10) };
    const now = budgetWindowFor(subscription, Date.UTC(2026, 0, 15));
    const muchLater = budgetWindowFor(subscription, Date.UTC(2027, 6, 1));
    // The window is identical no matter when it is asked for, so usage in a
    // later month lands in the same period and counts against the same cap.
    expect(now.startMs).toBe(muchLater.startMs);
    expect(now.endMs).toBe(muchLater.endMs);
    expect(now.startMs).toBe(subscription.budgetAnchorMs);
  });

  it("stays exhausted forever: spend does not free up in a later month", async () => {
    const userId = randomUUID();
    await grantFreeSubscriptionIfAbsent(userId);
    const subscription = await getSubscription(userId);
    if (!subscription) throw new Error("free grant missing");

    // Spend the whole $0.30 now.
    const now = Date.UTC(2026, 2, 1);
    const spend = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 300_000, nowMs: now });
    expect(spend.reservedMicrodollars).toBe(300_000);

    // 90 days later a paid plan's window would have rolled twice; the free plan
    // must still be blocked because the lifetime window never moves.
    const later = now + 90 * 24 * 60 * 60 * 1000;
    const headroomLater = await budgetHeadroom(userId, subscription, later);
    expect(headroomLater.monthly).toBe(0);
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 10_000, nowMs: later })
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });
});
