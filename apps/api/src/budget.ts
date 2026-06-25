import { randomUUID } from "node:crypto";
import { DAY_MS, FIVE_HOUR_MS, PLAN_CATALOG, TOKEN_PACKS, tokenPackGrant, tokenPackIdSchema, type PlanId, type TokenPackId } from "@workcrew/contracts";
import { config } from "./config.js";
import {
  addReferralEarned,
  claimReferralCredit,
  client,
  getSubscription,
  getUserByReferralCode,
  type SubscriptionRow
} from "./db.js";

// Dollars are tracked internally as microdollars (millionths of a dollar), and a
// microdollar is shown to the user as one token. So one dollar charged equals one
// million tokens of value.
const MICRODOLLARS_PER_USD = 1_000_000;

export type BudgetWindow = { startMs: number; endMs: number };

function addUtcMonths(timestamp: number, months: number): number {
  const source = new Date(timestamp);
  const target = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth() + months,
    1,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds()
  ));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(source.getUTCDate(), lastDay));
  return target.getTime();
}

export function getBudgetWindow(anchorMs: number, nowMs = Date.now()): BudgetWindow {
  if (nowMs < anchorMs) return { startMs: anchorMs, endMs: addUtcMonths(anchorMs, 1) };
  const anchor = new Date(anchorMs);
  const now = new Date(nowMs);
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth();
  let startMs = addUtcMonths(anchorMs, months);
  if (startMs > nowMs) {
    months -= 1;
    startMs = addUtcMonths(anchorMs, months);
  }
  return { startMs, endMs: addUtcMonths(anchorMs, months + 1) };
}

export function planBudget(plan: PlanId): number {
  return PLAN_CATALOG[plan].monthlyApiBudgetMicrodollars;
}

// The three hard caps for a plan, in microdollars.
export function planLimits(plan: PlanId): { fiveHour: number; daily: number; monthly: number } {
  const item = PLAN_CATALOG[plan];
  return { fiveHour: item.fiveHourMicrodollars, daily: item.dailyMicrodollars, monthly: item.monthlyApiBudgetMicrodollars };
}

// Real API usage (reservations plus settled model cost) since a point in time, for
// the rolling 5-hour and daily caps. Credit rows (top-ups, referral grants) are
// excluded so buying tokens can never lift a rate limit; these caps are absolute.
const CREDIT_MODELS = "'token_topup', 'auto_reload', 'referral_credit'";
export async function rollingUsage(userId: string, sinceMs: number): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COALESCE(SUM(CASE
        WHEN status = 'reserved' THEN reserved_microdollars
        WHEN status = 'settled' AND model NOT IN (${CREDIT_MODELS}) THEN actual_microdollars
        ELSE 0 END), 0) AS used
      FROM usage_ledger
      WHERE user_id = ? AND created_at_ms >= ?`,
    args: [userId, sinceMs]
  });
  return Number(result.rows[0]?.used ?? 0);
}

// Current usage against each of the three windows, for the entitlement and the
// banners. Monthly nets credits (a top-up adds headroom); the rolling windows do
// not (rate limits are absolute).
export async function getMultiWindowUsage(userId: string, anchorMs: number, nowMs = Date.now()): Promise<{ fiveHour: number; daily: number; monthly: number }> {
  const window = getBudgetWindow(anchorMs, nowMs);
  const monthly = await getBudgetUsage(userId, window);
  const fiveHour = await rollingUsage(userId, nowMs - FIVE_HOUR_MS);
  const daily = await rollingUsage(userId, nowMs - DAY_MS);
  return { fiveHour, daily, monthly: Math.max(0, monthly.used + monthly.reserved) };
}

export async function getBudgetUsage(userId: string, window: BudgetWindow): Promise<{ used: number; reserved: number }> {
  const result = await client.execute({
    sql: `SELECT
      COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_microdollars ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_microdollars ELSE 0 END), 0) AS reserved
      FROM usage_ledger
      WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?`,
    args: [userId, window.startMs, window.endMs]
  });
  const row = result.rows[0];
  return { used: Number(row?.used ?? 0), reserved: Number(row?.reserved ?? 0) };
}

export async function reserveBudget(input: {
  subscription: SubscriptionRow;
  runId: string;
  model: string;
  amountMicrodollars: number;
  nowMs?: number;
}): Promise<{ reservationId: string; window: BudgetWindow }> {
  const nowMs = input.nowMs ?? Date.now();
  const window = getBudgetWindow(input.subscription.budgetAnchorMs, nowMs);
  const limits = planLimits(input.subscription.plan);
  const amount = input.amountMicrodollars;
  const fiveHourStart = nowMs - FIVE_HOUR_MS;
  const dayStart = nowMs - DAY_MS;
  const id = randomUUID();

  // One atomic conditional insert that only succeeds when the new reservation
  // keeps ALL THREE caps satisfied: the monthly window (which nets credits, so a
  // top-up adds headroom), the rolling 5-hour cap, and the rolling daily cap. The
  // rolling caps count only real usage (credits excluded) so they are absolute
  // rate limits a top-up cannot lift. This bounds the operator's API spend hard.
  const rollingSum = `SUM(CASE
        WHEN status = 'reserved' THEN reserved_microdollars
        WHEN status = 'settled' AND model NOT IN (${CREDIT_MODELS}) THEN actual_microdollars
        ELSE 0 END)`;
  const insert = {
    sql: `INSERT INTO usage_ledger(
      id, user_id, run_id, period_start_ms, period_end_ms, model,
      reserved_microdollars, actual_microdollars, status, created_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?
    WHERE ? + COALESCE((
        SELECT SUM(CASE WHEN status = 'reserved' THEN reserved_microdollars WHEN status = 'settled' THEN actual_microdollars ELSE 0 END)
        FROM usage_ledger WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?
      ), 0) <= ?
      AND ? + COALESCE((SELECT ${rollingSum} FROM usage_ledger WHERE user_id = ? AND created_at_ms >= ?), 0) <= ?
      AND ? + COALESCE((SELECT ${rollingSum} FROM usage_ledger WHERE user_id = ? AND created_at_ms >= ?), 0) <= ?`,
    args: [
      id, input.subscription.userId, input.runId, window.startMs, window.endMs, input.model, amount, nowMs,
      // monthly
      amount, input.subscription.userId, window.startMs, window.endMs, limits.monthly,
      // rolling 5-hour
      amount, input.subscription.userId, fiveHourStart, limits.fiveHour,
      // rolling daily
      amount, input.subscription.userId, dayStart, limits.daily
    ]
  };

  // On Postgres, two simultaneous reservations could each read the window total
  // before either commits (READ COMMITTED) and both pass the cap, overspending.
  // A per-user transaction-scoped advisory lock serializes reservations for one
  // user so the second sees the first's row. SQLite (tests) has a single writer,
  // so the plain insert is already safe there.
  async function runInsert(): Promise<number> {
    if (client.dialect === "postgres") {
      const results = await client.batch([
        { sql: "SELECT pg_advisory_xact_lock(hashtext(?))", args: [input.subscription.userId] },
        insert
      ]);
      return results[1]?.rowsAffected ?? 0;
    }
    return (await client.execute(insert)).rowsAffected;
  }

  let rowsAffected = await runInsert();

  // If it failed because the MONTHLY allowance is used up, auto-reload (if on, under
  // its cap, and billing succeeds) and retry once. The rolling rate caps are never
  // lifted this way; they are absolute. At most one auto charge per reservation.
  if (rowsAffected !== 1) {
    const monthly = await getBudgetUsage(input.subscription.userId, window);
    const monthlyUsed = monthly.used + monthly.reserved;
    if (amount + monthlyUsed > limits.monthly) {
      const reloaded = await maybeAutoReload(input.subscription, window, nowMs);
      if (reloaded) rowsAffected = await runInsert();
    }
  }

  if (rowsAffected !== 1) {
    // Report which cap is binding so the user sees a clear, accurate message.
    const fiveHourUsed = await rollingUsage(input.subscription.userId, fiveHourStart);
    if (amount + fiveHourUsed > limits.fiveHour) {
      throw Object.assign(new Error("You have hit your usage limit for now. It will free up within a few hours."), { statusCode: 429, code: "RATE_LIMIT_5H" });
    }
    const dailyUsed = await rollingUsage(input.subscription.userId, dayStart);
    if (amount + dailyUsed > limits.daily) {
      throw Object.assign(new Error("You have hit your usage limit for today. It will free up tomorrow."), { statusCode: 429, code: "RATE_LIMIT_DAY" });
    }
    throw Object.assign(new Error("You have used all your tokens for this period."), { statusCode: 402, code: "BUDGET_EXHAUSTED" });
  }
  return { reservationId: id, window };
}

export async function settleBudget(reservationId: string, actualMicrodollars: number, providerRequestId?: string): Promise<void> {
  // Clamp the settled amount to the reserved amount. A CASE expression does this
  // in both SQLite and Postgres; SQLite's two-argument MIN() does not exist in
  // Postgres. The clamp amount is bound twice (once per branch).
  const amount = Math.max(0, Math.ceil(actualMicrodollars));
  await client.execute({
    sql: `UPDATE usage_ledger
      SET status = 'settled',
          actual_microdollars = CASE WHEN reserved_microdollars < ? THEN reserved_microdollars ELSE ? END,
          provider_request_id = ?, settled_at_ms = ?
      WHERE id = ? AND status = 'reserved'`,
    args: [amount, amount, providerRequestId ?? null, Date.now(), reservationId]
  });
}

export async function releaseBudget(reservationId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE usage_ledger SET status = 'released', settled_at_ms = ? WHERE id = ? AND status = 'reserved'",
    args: [Date.now(), reservationId]
  });
}

// The money charged for a pack, in microdollars, for receipts and the spend cap.
export function tokenPackCharge(pack: TokenPackId): number {
  return TOKEN_PACKS[pack].priceUsd * MICRODOLLARS_PER_USD;
}

/**
 * Add purchased tokens to the user's CURRENT budget window as a settled credit,
 * exactly like the referral credit: a negative-cost row lowers the window's used
 * total, freeing that many tokens for this period. The money charged is stored in
 * reserved_microdollars on the same settled row purely as a record; the
 * reservation cap reads `actual` on settled rows, so this never affects it.
 */
export async function grantTokenCredit(input: {
  userId: string;
  grantedMicrodollars: number;
  chargedMicrodollars: number;
  source: "token_topup" | "auto_reload";
  providerRequestId?: string;
  nowMs?: number;
}): Promise<{ window: BudgetWindow } | null> {
  const nowMs = input.nowMs ?? Date.now();
  const subscription = await getSubscription(input.userId);
  if (!subscription) return null;
  const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
  await client.execute({
    sql: `INSERT INTO usage_ledger(
        id, user_id, run_id, period_start_ms, period_end_ms, model,
        reserved_microdollars, actual_microdollars, status, provider_request_id, created_at_ms, settled_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?)`,
    args: [
      randomUUID(),
      input.userId,
      input.source,
      window.startMs,
      window.endMs,
      input.source,
      Math.max(0, Math.round(input.chargedMicrodollars)),
      -Math.abs(Math.round(input.grantedMicrodollars)),
      input.providerRequestId ?? null,
      nowMs,
      nowMs
    ]
  });
  return { window };
}

// Top-up totals for the current period, in token (usage) units. `purchased` is
// every top-up token added this period (manual and automatic); `autoReloaded` is
// only the automatic ones, which the monthly auto-reload cap is measured against.
export async function getTopupThisPeriod(userId: string, window: BudgetWindow): Promise<{ purchased: number; autoReloaded: number }> {
  const result = await client.execute({
    sql: `SELECT
        COALESCE(SUM(-actual_microdollars), 0) AS purchased,
        COALESCE(SUM(CASE WHEN model = 'auto_reload' THEN -actual_microdollars ELSE 0 END), 0) AS auto_reloaded
      FROM usage_ledger
      WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?
        AND status = 'settled' AND model IN ('token_topup', 'auto_reload')`,
    args: [userId, window.startMs, window.endMs]
  });
  const row = result.rows[0];
  return { purchased: Number(row?.purchased ?? 0), autoReloaded: Number(row?.auto_reloaded ?? 0) };
}

function parsePack(value: string): TokenPackId {
  const parsed = tokenPackIdSchema.safeParse(value);
  return parsed.success ? parsed.data : "small";
}

/**
 * When the plan allowance is exhausted, automatically add one top-up pack if the
 * user has turned auto-reload on and the period is still under its token cap. In
 * simulated billing there is no charge; in live billing an off-session charge is
 * made against the saved card first, and tokens are granted only if it succeeds.
 * Returns true when tokens were granted (the caller then retries the reservation).
 */
export async function maybeAutoReload(subscription: SubscriptionRow, window: BudgetWindow, nowMs: number): Promise<boolean> {
  if (!subscription.autoReloadEnabled) return false;
  const limit = subscription.monthlyTopupLimitMicro;
  if (limit <= 0) return false;

  const pack = parsePack(subscription.autoReloadPack);
  const grant = tokenPackGrant(pack);
  const { autoReloaded } = await getTopupThisPeriod(subscription.userId, window);
  // Never exceed the period cap on automatic spending.
  if (autoReloaded + grant > limit) return false;

  const charged = tokenPackCharge(pack);
  if (config.billingMode === "stripe") {
    // A saved card is required to charge off-session. Without one, auto-reload
    // quietly does nothing (the app prompts the user to add a payment method).
    if (!subscription.stripePaymentMethodId || !subscription.stripeCustomerId) return false;
    const { chargeAutoReload } = await import("./billing.js");
    const ok = await chargeAutoReload(subscription, pack);
    if (!ok) return false;
  }

  await grantTokenCredit({
    userId: subscription.userId,
    grantedMicrodollars: grant,
    chargedMicrodollars: charged,
    source: "auto_reload",
    nowMs
  });
  return true;
}

/**
 * When a referred user becomes a paying subscriber, grant their inviter a
 * one-time token bonus. Delivered as a single settled credit (a negative usage
 * entry) in the inviter's current budget window, so it adds available tokens
 * ONCE rather than raising the monthly cap every month. Idempotent via
 * claimReferralCredit. Returns true when a credit was granted this call.
 */
export async function creditReferralOnPayment(referredUserId: string, bonusMicrodollars: number): Promise<boolean> {
  const claim = await claimReferralCredit(referredUserId);
  if (!claim) return false;
  const referrer = await getUserByReferralCode(claim.referrerCode);
  if (!referrer) return true; // already marked credited; an unknown code grants nothing
  // Lifetime tokens earned, shown in the invite dialog.
  await addReferralEarned(referrer.id, bonusMicrodollars);
  // Deliver the one-time grant into the inviter's current budget window, if they
  // have an active subscription. A settled negative-cost row lowers their used
  // total for this period, freeing exactly that many tokens, one time.
  const subscription = await getSubscription(referrer.id);
  if (subscription) {
    const window = getBudgetWindow(subscription.budgetAnchorMs);
    await client.execute({
      sql: `INSERT INTO usage_ledger(
          id, user_id, run_id, period_start_ms, period_end_ms, model,
          reserved_microdollars, actual_microdollars, status, created_at_ms, settled_at_ms
        )
        VALUES (?, ?, 'referral', ?, ?, 'referral_credit', 0, ?, 'settled', ?, ?)`,
      args: [randomUUID(), referrer.id, window.startMs, window.endMs, -Math.abs(bonusMicrodollars), Date.now(), Date.now()]
    });
  }
  return true;
}
