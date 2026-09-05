import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RESERVATION_TTL_MS,
  budgetHeadroom,
  releaseAbandonedReservations,
  reserveBudget,
  rollingUsage
} from "./budget.js";
import { client, initializeDatabase, type SubscriptionRow } from "./db.js";

// Every model step takes a worst-case hold up front and releases it when the
// step ends. When a run dies first (a client timeout, a killed app, a dropped
// connection) nothing releases it, and that hold counted against the user for a
// full 24 hours: money never spent, blocking real work, with no way to clear it.

const HOUR = 60 * 60 * 1000;

function makeSubscription(): SubscriptionRow {
  return {
    userId: randomUUID(),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: "pro",
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: Date.now(),
    currentPeriodEndMs: Date.now() + 30 * 24 * HOUR,
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

/** A hold left behind by a run that died, written straight into the ledger. */
async function seedAbandonedHold(userId: string, amount: number, createdAtMs: number) {
  await client.execute({
    sql: `INSERT INTO usage_ledger(id, user_id, run_id, period_start_ms, period_end_ms, model, reserved_microdollars, actual_microdollars, status, created_at_ms)
          VALUES (?, ?, 'dead-run', ?, ?, 'sonnet', ?, 0, 'reserved', ?)`,
    args: [randomUUID(), userId, createdAtMs, createdAtMs + 30 * 24 * HOUR, amount, createdAtMs]
  });
}

describe("a reservation left behind by a run that died", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("stops counting against the day once it is too old to be real", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // A step cannot legitimately run for an hour; this one died 60 minutes ago.
    await seedAbandonedHold(subscription.userId, 350_000, nowMs - 60 * 60 * 1000);
    expect(await rollingUsage(subscription.userId, nowMs - 24 * HOUR)).toBe(0);
  });

  it("still counts a hold from a step that is genuinely in flight", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Seconds old: a real step, mid-flight, and its money must stay held.
    await seedAbandonedHold(subscription.userId, 350_000, nowMs - 5_000);
    expect(await rollingUsage(subscription.userId, nowMs - 24 * HOUR)).toBe(350_000);
  });

  it("gives the day back in the headroom the user is shown", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    await seedAbandonedHold(subscription.userId, 400_000, nowMs - 2 * HOUR);
    const headroom = await budgetHeadroom(subscription.userId, subscription, nowMs);
    // The whole allowance is back: nothing was actually spent.
    expect(headroom.daily).toBeGreaterThan(0);
    expect(headroom.monthly).toBe(48_000_000);
  });

  it("does not block the next real reservation", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Enough dead holds to bury the daily cap several times over.
    for (let i = 0; i < 4; i += 1) {
      await seedAbandonedHold(subscription.userId, 400_000, nowMs - 3 * HOUR);
    }
    const reservation = await reserveBudget({
      subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 50_000, nowMs
    });
    expect(reservation.reservedMicrodollars).toBe(50_000);
  });

  it("sweeps the dead rows away rather than leaving them in the ledger", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    await seedAbandonedHold(subscription.userId, 100_000, nowMs - 3 * HOUR);
    await seedAbandonedHold(subscription.userId, 100_000, nowMs - 20_000); // still alive
    expect(await releaseAbandonedReservations(subscription.userId, nowMs)).toBe(1);
    // Idempotent: running it again finds nothing more to do.
    expect(await releaseAbandonedReservations(subscription.userId, nowMs)).toBe(0);
  });

  it("allows a step far longer than any step needs before calling it dead", () => {
    // Generous on purpose: killing a live hold would let real spend escape.
    expect(RESERVATION_TTL_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(RESERVATION_TTL_MS).toBeLessThan(HOUR);
  });
});
