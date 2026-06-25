import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { tokenPackGrant } from "@workcrew/contracts";
import {
  getBudgetUsage,
  getBudgetWindow,
  getTopupThisPeriod,
  grantTokenCredit,
  reserveBudget,
  settleBudget
} from "./budget.js";
import { client, getSubscription, initializeDatabase, setAutoReloadConfig, upsertSubscription } from "./db.js";

const HOUR = 60 * 60 * 1000;
// Pro plan monthly allowance, in microdollars (see PLAN_CATALOG).
const PRO_CAP = 6_000_000;

// Persist an active Pro subscriber anchored at the given time, so getSubscription
// and the credit/auto-reload helpers (which read the DB) work against a real row.
async function makeUser(anchorMs: number): Promise<string> {
  const userId = randomUUID();
  await upsertSubscription({
    userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: "pro",
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: anchorMs,
    currentPeriodEndMs: anchorMs + 30 * 24 * 60 * 60 * 1000
  });
  return userId;
}

// Fill the monthly window with settled usage at a chosen (old) time, so the
// monthly cap can be tested without tripping the rolling 5-hour and daily caps.
async function seedSettled(userId: string, amount: number, createdAtMs: number, anchorMs: number) {
  const window = getBudgetWindow(anchorMs, createdAtMs);
  await client.execute({
    sql: `INSERT INTO usage_ledger(id, user_id, run_id, period_start_ms, period_end_ms, model, reserved_microdollars, actual_microdollars, status, created_at_ms, settled_at_ms)
          VALUES (?, ?, 'seed', ?, ?, 'haiku', 0, ?, 'settled', ?, ?)`,
    args: [randomUUID(), userId, window.startMs, window.endMs, amount, createdAtMs, createdAtMs]
  });
}

describe("token top-up credits", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("grants purchased tokens as a credit in the current window", async () => {
    const anchorMs = Date.now();
    const userId = await makeUser(anchorMs);
    const window = getBudgetWindow(anchorMs, anchorMs);

    await grantTokenCredit({
      userId,
      grantedMicrodollars: 5_000_000,
      chargedMicrodollars: 19_000_000,
      source: "token_topup",
      nowMs: anchorMs
    });

    // A credit lowers the window's used total, freeing that many tokens.
    const usage = await getBudgetUsage(userId, window);
    expect(usage.used).toBe(-5_000_000);
    const topup = await getTopupThisPeriod(userId, window);
    expect(topup.purchased).toBe(5_000_000);
    expect(topup.autoReloaded).toBe(0);
  });

  it("lets a top-up extend usage past the monthly cap", async () => {
    const anchorMs = Date.now() + 1;
    const userId = await makeUser(anchorMs);
    const nowMs = anchorMs + 48 * HOUR;
    // Fill the monthly cap as old usage (outside the rolling windows).
    await seedSettled(userId, PRO_CAP, anchorMs, anchorMs);

    // Monthly is full, so a reservation is rejected.
    await expect(
      reserveBudget({ subscription: (await getSubscription(userId))!, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs })
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });

    // After a top-up there is headroom again.
    await grantTokenCredit({ userId, grantedMicrodollars: 1_000_000, chargedMicrodollars: 0, source: "token_topup", nowMs });
    const retry = await reserveBudget({ subscription: (await getSubscription(userId))!, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs });
    expect(retry.reservationId).toBeTruthy();
  });

  it("auto-reloads on monthly exhaustion, capped by the period limit", async () => {
    const anchorMs = Date.now() + 2;
    const userId = await makeUser(anchorMs);
    const nowMs = anchorMs + 48 * HOUR;
    const grant = tokenPackGrant("small"); // 5,000,000
    await seedSettled(userId, PRO_CAP, anchorMs, anchorMs);
    // Allow one auto-reload pack this period.
    await setAutoReloadConfig(userId, { enabled: true, pack: "small", monthlyLimitMicro: grant });

    // The reservation trips the monthly cap, auto-reload grants a pack (no charge
    // in simulated billing), and the reservation then succeeds.
    const reservation = await reserveBudget({ subscription: (await getSubscription(userId))!, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs });
    expect(reservation.reservationId).toBeTruthy();
    await settleBudget(reservation.reservationId, 1_000);

    const window = getBudgetWindow(anchorMs, nowMs);
    expect((await getTopupThisPeriod(userId, window)).autoReloaded).toBe(grant);
  });

  it("does not auto-reload when it is turned off", async () => {
    const anchorMs = Date.now() + 3;
    const userId = await makeUser(anchorMs);
    const nowMs = anchorMs + 48 * HOUR;
    await seedSettled(userId, PRO_CAP, anchorMs, anchorMs);
    await setAutoReloadConfig(userId, { enabled: false, pack: "small", monthlyLimitMicro: 5_000_000 });

    await expect(
      reserveBudget({ subscription: (await getSubscription(userId))!, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs })
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });
});
