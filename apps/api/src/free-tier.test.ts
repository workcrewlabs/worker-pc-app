import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_CATALOG } from "@workcrew/contracts";
import { budgetHeadroom, budgetWindowFor, exhaustionError, reserveBudget } from "./budget.js";
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

  it("caps a free user's spend at the $1.20 monthly allowance", async () => {
    const userId = randomUUID();
    await grantFreeSubscriptionIfAbsent(userId);
    const subscription = await getSubscription(userId);
    if (!subscription) throw new Error("free grant missing");

    const headroom = await budgetHeadroom(userId, subscription);
    expect(headroom.monthly).toBe(PLAN_CATALOG.free.monthlyApiBudgetMicrodollars);
    expect(headroom.monthly).toBe(1_200_000);

    // Reserve most of the allowance, then confirm the next reservation is
    // clamped to what is actually left, so the total can never pass $1.20.
    const first = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000_000 });
    expect(first.reservedMicrodollars).toBe(1_000_000);
    const second = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 400_000 });
    expect(second.reservedMicrodollars).toBeLessThanOrEqual(200_000);
  });

  // Every budget gate in the API reports exhaustion through this one helper. A
  // free user must never be told their tokens "free up tomorrow": their trial is
  // one-time, so the daily cap and the lifetime cap are the same number and a
  // spent trial would otherwise read as a temporary daily limit.
  it("never tells a free user their tokens come back tomorrow", () => {
    for (const dailyBinding of [true, false]) {
      const free = exhaustionError("free", dailyBinding) as Error & { code: string; statusCode: number };
      expect(free.message).toBe("You have used all your free tokens. Upgrade to keep going.");
      expect(free.code).toBe("BUDGET_EXHAUSTED");
      expect(free.statusCode).toBe(402);
      expect(free.message).not.toMatch(/tomorrow/i);
    }

    // A paid plan's rolling daily cap genuinely does refill, so it keeps saying so.
    const paidDaily = exhaustionError("pro", true) as Error & { code: string };
    expect(paidDaily.code).toBe("RATE_LIMIT_DAY");
    // Deliberately not "tomorrow": the paid daily cap is a rolling 24 hours, so
    // it eases as each charge ages out rather than resetting at midnight.
    expect(paidDaily.message).toMatch(/last 24 hours/i);
    expect(paidDaily.message).not.toMatch(/tomorrow/i);

    const paidPeriod = exhaustionError("pro", false) as Error & { code: string };
    expect(paidPeriod.code).toBe("BUDGET_EXHAUSTED");
    expect(paidPeriod.message).not.toMatch(/tomorrow/i);
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

    // Spend the whole $1.20 now.
    const now = Date.UTC(2026, 2, 1);
    const spend = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_200_000, nowMs: now });
    expect(spend.reservedMicrodollars).toBe(1_200_000);

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
