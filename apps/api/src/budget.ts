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

// Settled (actually incurred) real usage since a point in time: only 'settled'
// non-credit rows, excluding in-flight reservations. This is what we DISPLAY for
// the daily cap. Enforcement (reserveBudget) still counts reservations so spend
// stays bounded, but the shown number must move only as real cost lands. If the
// display included a worst-case reservation, a single turn would push the daily
// total to the cap while it ran and drop back once it settled, making the banner
// flip between "running low" and "limit reached". Settled-only is stable and
// monotonic within the day.
export async function rollingSettledUsage(userId: string, sinceMs: number): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COALESCE(SUM(CASE
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

// The budget still available right now, in microdollars, for each window: daily
// and monthly headroom, each measured exactly as the reserveBudget gate does
// (committed = in-flight reservations plus settled real usage). Never negative.
// Callers use the smaller of the two to cap a single request's cost to what the
// remaining money can pay for, so an expensive turn (a long file/spreadsheet
// generation, an automation step, or a chat answer) stops when the budget runs out
// instead of generating to completion and pushing real spend past the cap. The two
// values are returned separately so the caller can say "frees up tomorrow" (daily)
// versus "used all your tokens for this period" (monthly) accurately.
export async function budgetHeadroom(userId: string, subscription: SubscriptionRow, nowMs = Date.now()): Promise<{ daily: number; monthly: number }> {
  const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
  const limits = planLimits(subscription.plan);
  const [monthly, daily] = await Promise.all([
    getBudgetUsage(userId, window),
    rollingUsage(userId, nowMs - DAY_MS)
  ]);
  return {
    monthly: Math.max(0, limits.monthly - (monthly.used + monthly.reserved)),
    daily: Math.max(0, limits.daily - daily)
  };
}

export async function reserveBudget(input: {
  subscription: SubscriptionRow;
  runId: string;
  model: string;
  amountMicrodollars: number;
  nowMs?: number;
}): Promise<{ reservationId: string; window: BudgetWindow; reservedMicrodollars: number }> {
  const nowMs = input.nowMs ?? Date.now();
  const window = getBudgetWindow(input.subscription.budgetAnchorMs, nowMs);
  const limits = planLimits(input.subscription.plan);
  const amount = input.amountMicrodollars;
  const dayStart = nowMs - DAY_MS;
  const id = randomUUID();

  // One atomic conditional insert that is a HARD cap: real spend can never exceed
  // either window (the monthly window, which nets credits so a top-up adds
  // headroom, and the rolling daily cap, which counts real usage only so a top-up
  // cannot lift this absolute rate limit).
  //
  // Two properties combined:
  //  1. GATE: the row is inserted only while BOTH windows still have headroom
  //     (committed < cap). So once a window is full, every new request is refused.
  //  2. CLAMP: the reserved amount is not the raw worst case; it is
  //     min(worstCase, monthlyRemaining, dailyRemaining). Because settleBudget
  //     clamps the settled cost to the reserved amount, a turn can be charged at
  //     most the headroom that was left, so committed spend lands on the cap
  //     exactly and never a cent over. This is why we can allow a request whenever
  //     there is ANY headroom (never blocking a user sitting under their limit,
  //     e.g. an Opus turn at 58%) while still guaranteeing the number never passes
  //     the cap. The caller keeps its own worst-case estimate for the
  //     USAGE_RESERVATION_BREACH check, so a turn whose true cost is under the
  //     worst case (the normal case) still settles cleanly at the clamped ceiling.
  const rollingSum = `SUM(CASE
        WHEN status = 'reserved' THEN reserved_microdollars
        WHEN status = 'settled' AND model NOT IN (${CREDIT_MODELS}) THEN actual_microdollars
        ELSE 0 END)`;
  const monthlySum = `SUM(CASE WHEN status = 'reserved' THEN reserved_microdollars WHEN status = 'settled' THEN actual_microdollars ELSE 0 END)`;
  // SQLite exposes a scalar min(a,b,c); Postgres spells it LEAST(a,b,c).
  const leastFn = client.dialect === "postgres" ? "LEAST" : "min";
  const insert = {
    sql: `INSERT INTO usage_ledger(
      id, user_id, run_id, period_start_ms, period_end_ms, model,
      reserved_microdollars, actual_microdollars, status, created_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ?,
      ${leastFn}(
        ?,
        ? - COALESCE((SELECT ${monthlySum} FROM usage_ledger WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?), 0),
        ? - COALESCE((SELECT ${rollingSum} FROM usage_ledger WHERE user_id = ? AND created_at_ms >= ?), 0)
      ),
      0, 'reserved', ?
    WHERE COALESCE((SELECT ${monthlySum} FROM usage_ledger WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?), 0) < ?
      AND COALESCE((SELECT ${rollingSum} FROM usage_ledger WHERE user_id = ? AND created_at_ms >= ?), 0) < ?`,
    args: [
      id, input.subscription.userId, input.runId, window.startMs, window.endMs, input.model,
      // reserved = min(worstCase, monthlyRemaining, dailyRemaining)
      amount,
      limits.monthly, input.subscription.userId, window.startMs, window.endMs,
      limits.daily, input.subscription.userId, dayStart,
      nowMs,
      // gate: both windows must still have headroom
      input.subscription.userId, window.startMs, window.endMs, limits.monthly,
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
  // Read back the amount actually reserved. The SQL clamps it to the headroom that
  // was left at insert time (serialized by the advisory lock), so this is the real
  // budget this turn may spend. Callers size the response length from it, so the
  // whole turn (input plus output) stays within the money that is left even when a
  // concurrent turn consumed budget between here and the caller's own read.
  const back = await client.execute({
    sql: "SELECT reserved_microdollars FROM usage_ledger WHERE id = ?",
    args: [id]
  });
  const reservedMicrodollars = Number(back.rows[0]?.reserved_microdollars ?? amount);
  return { reservationId: id, window, reservedMicrodollars };
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
