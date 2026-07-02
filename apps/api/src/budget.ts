import { randomUUID } from "node:crypto";
import { DAY_MS, PLAN_CATALOG, type PlanId } from "@workcrew/contracts";
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

// The two hard caps for a plan, in microdollars: a rolling daily cap and a
// monthly cap.
export function planLimits(plan: PlanId): { daily: number; monthly: number } {
  const item = PLAN_CATALOG[plan];
  return { daily: item.dailyMicrodollars, monthly: item.monthlyApiBudgetMicrodollars };
}

// Real API usage (reservations plus settled model cost) since a point in time, for
// the rolling daily cap. Credit rows (top-ups, referral grants) are excluded so
// buying tokens can never lift a rate limit; this cap is absolute.
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
export async function getMultiWindowUsage(userId: string, anchorMs: number, nowMs = Date.now()): Promise<{ daily: number; monthly: number }> {
  const window = getBudgetWindow(anchorMs, nowMs);
  const monthly = await getBudgetUsage(userId, window);
  const daily = await rollingUsage(userId, nowMs - DAY_MS);
  return { daily, monthly: Math.max(0, monthly.used + monthly.reserved) };
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
  const dayStart = nowMs - DAY_MS;
  const id = randomUUID();

  // One atomic conditional insert that succeeds while the user still has ANY
  // headroom left in BOTH windows: the monthly window (which nets credits, so a
  // top-up adds headroom) and the rolling daily cap (real usage only, so a top-up
  // cannot lift this absolute rate limit).
  //
  // We gate on "is the window already exhausted?" rather than "would this
  // request's worst case fit?" on purpose. A request reserves its worst-case cost
  // up front (the full output budget at the model's price plus a byte-based upper
  // bound on input); on a small daily cap that worst case can be a large fraction
  // of, or exceed, the whole cap by itself. The old "must fit" gate therefore
  // refused a user who was sitting well under their real limit (e.g. an Opus turn
  // at 58% of the Pro cap). Allowing a request whenever the window is not yet full
  // lets the user spend right up to the cap; the reservation then settles down to
  // the true, far smaller cost. The only overshoot is at most one in-flight
  // request's real cost per window, an accepted tradeoff for a usable limit. Spend
  // stays hard-bounded: once a window is full, every new request is refused.
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
    WHERE COALESCE((
        SELECT SUM(CASE WHEN status = 'reserved' THEN reserved_microdollars WHEN status = 'settled' THEN actual_microdollars ELSE 0 END)
        FROM usage_ledger WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?
      ), 0) < ?
      AND COALESCE((SELECT ${rollingSum} FROM usage_ledger WHERE user_id = ? AND created_at_ms >= ?), 0) < ?`,
    args: [
      id, input.subscription.userId, input.runId, window.startMs, window.endMs, input.model, amount, nowMs,
      // monthly: allow while the window is not already exhausted
      input.subscription.userId, window.startMs, window.endMs, limits.monthly,
      // rolling daily: allow while the day is not already exhausted
      input.subscription.userId, dayStart, limits.daily
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

  const rowsAffected = await runInsert();

  if (rowsAffected !== 1) {
    // The insert only fails when a window is already exhausted. Report which one
    // is binding so the user sees a clear, accurate message.
    const dailyUsed = await rollingUsage(input.subscription.userId, dayStart);
    if (dailyUsed >= limits.daily) {
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
