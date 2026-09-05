import { randomUUID } from "node:crypto";
import { PLAN_CATALOG } from "@workcrew/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { adaptiveDailyLimit, budgetHeadroom, budgetWindowFor, dailyLimitFor, reserveBudget, settleBudget } from "./budget.js";
import { client, initializeDatabase, type SubscriptionRow } from "./db.js";

// The adaptive daily rule was written and tested, then wired into exactly one
// caller. The banner an Ultra customer reads and the gate that stops him both
// still used the plan's flat thirtieth, so he was warned he was running low on a
// day he had barely started, with the month nearly untouched. These tests hold
// every caller to the one function, so the cap shown and the cap applied cannot
// drift apart again.

const HOUR = 60 * 60 * 1000;
const ULTRA_FLAT_DAILY = PLAN_CATALOG.ultra.dailyMicrodollars;

/** `ageMs` backdates the billing anchor, so a test can place spend on an earlier
 *  day of the same month, outside the rolling 24 hours. */
function makeSubscription(plan: "free" | "pro" | "ultra", ageMs = 0): SubscriptionRow {
  const now = Date.now() - ageMs;
  return {
    userId: randomUUID(),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan,
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: now,
    currentPeriodEndMs: now + 30 * 24 * HOUR,
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

/** Settled spend written straight into the ledger, at a chosen time. */
async function seedSettled(subscription: SubscriptionRow, amount: number, createdAtMs: number) {
  const window = budgetWindowFor(subscription, createdAtMs);
  await client.execute({
    sql: `INSERT INTO usage_ledger(id, user_id, run_id, period_start_ms, period_end_ms, model, reserved_microdollars, actual_microdollars, status, created_at_ms, settled_at_ms)
          VALUES (?, ?, 'seed', ?, ?, 'sonnet', 0, ?, 'settled', ?, ?)`,
    args: [randomUUID(), subscription.userId, window.startMs, window.endMs, amount, createdAtMs, createdAtMs]
  });
}

describe("the day's allowance, everywhere it is used", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("gives an Ultra customer far more than the old flat thirtieth on a fresh month", async () => {
    const subscription = makeSubscription("ultra");
    const limit = await dailyLimitFor(subscription, subscription.budgetAnchorMs);
    expect(limit).toBeGreaterThan(ULTRA_FLAT_DAILY);
  });

  it("shrinks as the month is spent, and the flat figure becomes the floor", async () => {
    const subscription = makeSubscription("ultra", 5 * 24 * HOUR);
    const nowMs = subscription.budgetAnchorMs + 5 * 24 * HOUR;
    // Most of the month burned on earlier days, so only the month is squeezed.
    await seedSettled(subscription, 55_000_000, nowMs - 2 * 24 * HOUR);
    expect(await dailyLimitFor(subscription, nowMs)).toBe(ULTRA_FLAT_DAILY);
  });

  it("lets a turn through once the flat cap is passed but the month is healthy", async () => {
    const subscription = makeSubscription("ultra");
    const nowMs = subscription.budgetAnchorMs;
    // A full flat day's worth already spent: under the old rule the next turn
    // was refused outright. The month is barely touched, so it must go through.
    const first = await reserveBudget({
      subscription, runId: randomUUID(), model: "sonnet", amountMicrodollars: ULTRA_FLAT_DAILY, nowMs
    });
    await settleBudget(first.reservationId, ULTRA_FLAT_DAILY);
    const next = await reserveBudget({
      subscription, runId: randomUUID(), model: "sonnet", amountMicrodollars: 500_000, nowMs
    });
    expect(next.reservedMicrodollars).toBe(500_000);
  });

  it("shows headroom against the same limit it enforces", async () => {
    const subscription = makeSubscription("ultra");
    const nowMs = subscription.budgetAnchorMs;
    const spend = 3_000_000;
    const held = await reserveBudget({
      subscription, runId: randomUUID(), model: "sonnet", amountMicrodollars: spend, nowMs
    });
    await settleBudget(held.reservationId, spend);
    const [limit, headroom] = await Promise.all([
      dailyLimitFor(subscription, nowMs),
      budgetHeadroom(subscription.userId, subscription, nowMs)
    ]);
    expect(headroom.daily).toBe(limit - spend);
    // And the old flat cap would already have called this day nearly spent.
    expect(spend).toBeGreaterThan(ULTRA_FLAT_DAILY);
    expect(headroom.daily).toBeGreaterThan(0);
  });

  it("gives nothing, and blames the month, once the month itself is gone", async () => {
    const subscription = makeSubscription("pro", 5 * 24 * HOUR);
    const nowMs = subscription.budgetAnchorMs + 5 * 24 * HOUR;
    await seedSettled(subscription, PLAN_CATALOG.pro.monthlyApiBudgetMicrodollars, nowMs - 2 * 24 * HOUR);
    expect(await dailyLimitFor(subscription, nowMs)).toBe(0);
    // And the message must not promise it comes back tomorrow, because it does not.
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs })
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });

  it("does not charge today's spend to the day twice", async () => {
    // Deriving the day from what the MONTH has left shrinks the day by exactly
    // what the day has already spent, so a user with a healthy month gets locked
    // out mid-afternoon. The day is derived from where the month stood before
    // today instead, so a spent morning never narrows the afternoon.
    const subscription = makeSubscription("ultra");
    const nowMs = subscription.budgetAnchorMs;
    const before = await dailyLimitFor(subscription, nowMs);
    const spentThisMorning = 1_000_000;
    await seedSettled(subscription, spentThisMorning, nowMs);
    expect(await dailyLimitFor(subscription, nowMs)).toBe(before);
    const headroom = await budgetHeadroom(subscription.userId, subscription, nowMs);
    expect(headroom.daily).toBe(before - spentThisMorning);
  });

  it("leaves a free trial exactly as strict as it was", async () => {
    const subscription = makeSubscription("free");
    const nowMs = subscription.budgetAnchorMs;
    // The century-long window makes the even share round to nothing, so the
    // plan's own figure holds and the trial is never widened.
    expect(await dailyLimitFor(subscription, nowMs)).toBe(PLAN_CATALOG.free.monthlyApiBudgetMicrodollars);
    const held = await reserveBudget({
      subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: PLAN_CATALOG.free.monthlyApiBudgetMicrodollars, nowMs
    });
    await settleBudget(held.reservationId, PLAN_CATALOG.free.monthlyApiBudgetMicrodollars);
    // Spent for good: not tomorrow, not next month.
    expect(await dailyLimitFor(subscription, nowMs + 60 * 24 * HOUR)).toBe(0);
  });

  it("is the adaptive rule, not a second copy of it", async () => {
    const subscription = makeSubscription("ultra", 10 * 24 * HOUR);
    const nowMs = subscription.budgetAnchorMs + 10 * 24 * HOUR;
    const spend = 20_000_000;
    await seedSettled(subscription, spend, nowMs - 2 * 24 * HOUR);
    const window = budgetWindowFor(subscription, nowMs);
    expect(await dailyLimitFor(subscription, nowMs)).toBe(
      adaptiveDailyLimit(ULTRA_FLAT_DAILY, PLAN_CATALOG.ultra.monthlyApiBudgetMicrodollars - spend, window.endMs - nowMs)
    );
  });
});
