import { randomUUID } from "node:crypto";
import { PLAN_CATALOG, type PlanId } from "@workcrew/contracts";
import { client, type SubscriptionRow } from "./db.js";

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
  // The effective monthly limit is the plan budget plus any referral bonus the
  // user has earned (joined onto the subscription row when it is read).
  const limit = planBudget(input.subscription.plan) + (input.subscription.referralBonusMicrodollars ?? 0);
  const id = randomUUID();
  // The conditional insert only succeeds when the new reservation keeps the
  // window total within the plan limit. The cap is evaluated by the SUM subquery.
  const insert = {
    sql: `INSERT INTO usage_ledger(
      id, user_id, run_id, period_start_ms, period_end_ms, model,
      reserved_microdollars, actual_microdollars, status, created_at_ms
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?
    WHERE ? + COALESCE((
      SELECT SUM(CASE
        WHEN status = 'reserved' THEN reserved_microdollars
        WHEN status = 'settled' THEN actual_microdollars
        ELSE 0 END)
      FROM usage_ledger
      WHERE user_id = ? AND period_start_ms = ? AND period_end_ms = ?
    ), 0) <= ?`,
    args: [
      id,
      input.subscription.userId,
      input.runId,
      window.startMs,
      window.endMs,
      input.model,
      input.amountMicrodollars,
      nowMs,
      input.amountMicrodollars,
      input.subscription.userId,
      window.startMs,
      window.endMs,
      limit
    ]
  };

  // On Postgres, two simultaneous reservations could each read the window total
  // before either commits (READ COMMITTED) and both pass the cap, overspending.
  // A per-user transaction-scoped advisory lock serializes reservations for one
  // user so the second sees the first's row. SQLite (tests) has a single writer,
  // so the plain insert is already safe there.
  let rowsAffected: number;
  if (client.dialect === "postgres") {
    const results = await client.batch([
      { sql: "SELECT pg_advisory_xact_lock(hashtext(?))", args: [input.subscription.userId] },
      insert
    ]);
    rowsAffected = results[1]?.rowsAffected ?? 0;
  } else {
    rowsAffected = (await client.execute(insert)).rowsAffected;
  }

  if (rowsAffected !== 1) {
    throw Object.assign(new Error("Monthly AI budget exhausted"), { statusCode: 402, code: "BUDGET_EXHAUSTED" });
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
