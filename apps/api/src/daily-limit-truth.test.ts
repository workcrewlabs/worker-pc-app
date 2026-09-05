import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DAY_MS } from "@workcrew/contracts";
import {
  RESERVATION_TTL_MS,
  budgetWindowFor,
  dayAllowance,
  exhaustionError,
  getBudgetUsage,
  nextDailyRelief,
  relievesIn
} from "./budget.js";
import { client, initializeDatabase, upsertSubscription } from "./db.js";

// A Pro customer opened the app in the morning and was told his limit for the
// day was gone before he had done anything. Two separate things were wrong.
//
// One: the cap counts the last 24 HOURS, not the calendar day, so the burst he
// ran the previous evening was still inside the window. The message told him it
// would "free up tomorrow", which was not true either; it frees up piece by
// piece as each charge turns 24 hours old.
//
// Two: reservations left behind by a killed app were never released. The
// function to do it existed, was tested, and was called from nowhere. The daily
// sum ages them out inline, but the MONTHLY sum counts every reserved row for
// ever, and the day's allowance is derived from what the month has left. Seven
// dead holds across the accounts were keeping $1.25 of real budget, one of them
// seventeen days old, quietly shrinking those users' daily allowance.

const MONTH_MS = 31 * DAY_MS;

async function accountWithLedger(rows: { status: string; amount: number; ageMs: number }[]) {
  const userId = randomUUID();
  const now = Date.now();
  await upsertSubscription({
    userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: "pro",
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: now - DAY_MS,
    currentPeriodEndMs: now + MONTH_MS
  });
  const window = budgetWindowFor({ plan: "pro", budgetAnchorMs: now - DAY_MS }, now);
  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO usage_ledger(
          id, user_id, run_id, period_start_ms, period_end_ms, model,
          reserved_microdollars, actual_microdollars, status, created_at_ms
        ) VALUES (?, ?, 'run', ?, ?, 'sonnet', ?, ?, ?, ?)`,
      args: [
        randomUUID(), userId, window.startMs, window.endMs,
        row.status === "reserved" ? row.amount : 0,
        row.status === "settled" ? row.amount : 0,
        row.status, now - row.ageMs
      ]
    });
  }
  return { userId, now, window };
}

describe("holds left behind by a run that never finished", () => {
  beforeAll(async () => { await initializeDatabase(client); });

  it("stops eating the monthly budget once the allowance is worked out", async () => {
    // Seventeen days old, exactly the shape found on a real account.
    const { userId, now, window } = await accountWithLedger([
      { status: "reserved", amount: 140_700, ageMs: 17 * DAY_MS }
    ]);

    const before = await getBudgetUsage(userId, window);
    expect(before.reserved).toBe(140_700);

    // Reading the allowance heals the ledger first.
    await dayAllowance({ userId, plan: "pro", budgetAnchorMs: now - DAY_MS }, now);

    const after = await getBudgetUsage(userId, window);
    expect(after.reserved, "the dead hold is still counted against the month").toBe(0);
  });

  it("gives the money back to the day's allowance too", async () => {
    const { userId, now } = await accountWithLedger([
      { status: "reserved", amount: 900_000, ageMs: 10 * DAY_MS }
    ]);
    const day = await dayAllowance({ userId, plan: "pro", budgetAnchorMs: now - DAY_MS }, now);
    // With the hold released the whole monthly cap is available again.
    expect(day.monthlyLeft).toBe(12_000_000);
  });

  it("never forgives a hold on the free trial, which is one-time", async () => {
    // This is why the release was not wired in originally, and it is the one
    // case that must not change: the trial runs on a window that never rolls, so
    // handing a hold back would restore an exhausted trial and reward killing
    // the app mid-run. Only a paying customer gets money back.
    const userId = randomUUID();
    const now = Date.now();
    await upsertSubscription({
      userId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: "free",
      interval: "month",
      status: "free",
      active: true,
      budgetAnchorMs: now - 30 * DAY_MS,
      currentPeriodEndMs: now + 100 * 365 * DAY_MS
    });
    const window = budgetWindowFor({ plan: "free", budgetAnchorMs: now - 30 * DAY_MS }, now);
    await client.execute({
      sql: `INSERT INTO usage_ledger(
          id, user_id, run_id, period_start_ms, period_end_ms, model,
          reserved_microdollars, actual_microdollars, status, created_at_ms
        ) VALUES (?, ?, 'run', ?, ?, 'haiku', 300000, 0, 'reserved', ?)`,
      args: [randomUUID(), userId, window.startMs, window.endMs, now - 30 * DAY_MS]
    });

    const day = await dayAllowance({ userId, plan: "free", budgetAnchorMs: now - 30 * DAY_MS }, now);
    expect(day.monthlyLeft, "an exhausted trial must stay exhausted").toBe(0);
  });

  it("leaves a hold from a run that is genuinely still going", async () => {
    const { userId, now, window } = await accountWithLedger([
      { status: "reserved", amount: 50_000, ageMs: Math.floor(RESERVATION_TTL_MS / 3) }
    ]);
    await dayAllowance({ userId, plan: "pro", budgetAnchorMs: now - DAY_MS }, now);
    const after = await getBudgetUsage(userId, window);
    expect(after.reserved, "a live reservation must not be cancelled").toBe(50_000);
  });
});

describe("telling someone when they can work again", () => {
  beforeAll(async () => { await initializeDatabase(client); });

  it("points at 24 hours after the oldest charge, not at midnight", async () => {
    const { userId, now } = await accountWithLedger([
      { status: "settled", amount: 300_000, ageMs: 20 * 60 * 60 * 1000 },
      { status: "settled", amount: 300_000, ageMs: 2 * 60 * 60 * 1000 }
    ]);
    const relief = await nextDailyRelief(userId, now);
    expect(relief).not.toBeNull();
    // The oldest is 20 hours old, so relief is about 4 hours away.
    const hours = ((relief as number) - now) / 3_600_000;
    expect(hours).toBeGreaterThan(3.5);
    expect(hours).toBeLessThan(4.5);
  });

  it("promises nothing when there is nothing waiting to come back", async () => {
    const { userId, now } = await accountWithLedger([]);
    expect(await nextDailyRelief(userId, now)).toBeNull();
  });
});

describe("what the message actually says", () => {
  it("no longer claims the allowance returns tomorrow", () => {
    const message = exhaustionError("pro", true, 3 * 3_600_000).message;
    expect(message).not.toContain("tomorrow");
    expect(message).not.toContain("for today");
    expect(message).toContain("last 24 hours");
  });

  it("says how long the wait is, in hours", () => {
    expect(exhaustionError("pro", true, 3 * 3_600_000).message).toContain("about 3 hours");
  });

  it("switches to minutes when the wait is short", () => {
    expect(relievesIn(9 * 60_000)).toContain("about 9 minutes");
  });

  it("says nothing rather than something useless", () => {
    expect(relievesIn(null)).toBe("");
    expect(relievesIn(-5_000)).toBe("");
    expect(exhaustionError("pro", true, null).message).toBe("You have used your allowance for the last 24 hours.");
  });

  it("does not offer a wait when the month is what ran out", () => {
    // Waiting brings nothing back, so it must not imply otherwise.
    const message = exhaustionError("pro", false, 3 * 3_600_000).message;
    expect(message).toContain("this period");
    expect(message).not.toContain("frees up");
  });

  it("still tells a free user to upgrade rather than to wait", () => {
    const message = exhaustionError("free", true, 3 * 3_600_000).message;
    expect(message).toContain("Upgrade");
    expect(message).not.toContain("frees up");
  });
});
