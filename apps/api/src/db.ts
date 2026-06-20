import { createClient, type Client } from "@libsql/client";
import type { BillingInterval, ModelTier, PlanId } from "@workcrew/contracts";
import { config } from "./config.js";

export type SubscriptionRow = {
  userId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: PlanId;
  interval: BillingInterval;
  status: string;
  active: boolean;
  budgetAnchorMs: number;
  currentPeriodEndMs: number;
};

export type RunRow = {
  id: string;
  userId: string;
  model: ModelTier;
  status: string;
  messages: unknown[];
  pendingToolUseId: string | null;
};

const client = createClient({
  url: config.dataUrl,
  authToken: config.dataAuthToken
});

export async function initializeDatabase(db: Client = client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL CHECK (plan IN ('pro', 'ultra')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      status TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      budget_anchor_ms INTEGER NOT NULL,
      current_period_end_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      period_start_ms INTEGER NOT NULL,
      period_end_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      reserved_microdollars INTEGER NOT NULL,
      actual_microdollars INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
      provider_request_id TEXT,
      created_at_ms INTEGER NOT NULL,
      settled_at_ms INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_user_period
      ON usage_ledger(user_id, period_start_ms, period_end_ms, status)`,
    `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      pending_tool_use_id TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, updated_at_ms DESC)`,
    `CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL
    )`
  ], "write");
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function mapSubscription(row: Record<string, unknown>): SubscriptionRow {
  return {
    userId: String(row.user_id),
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
    plan: String(row.plan) as PlanId,
    interval: String(row.interval) as BillingInterval,
    status: String(row.status),
    active: asNumber(row.active) === 1,
    budgetAnchorMs: asNumber(row.budget_anchor_ms),
    currentPeriodEndMs: asNumber(row.current_period_end_ms)
  };
}

export async function getSubscription(userId: string): Promise<SubscriptionRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
    args: [userId]
  });
  const row = result.rows[0];
  return row ? mapSubscription(row as unknown as Record<string, unknown>) : null;
}

export async function getSubscriptionByStripeId(subscriptionId: string): Promise<SubscriptionRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM subscriptions WHERE stripe_subscription_id = ? LIMIT 1",
    args: [subscriptionId]
  });
  const row = result.rows[0];
  return row ? mapSubscription(row as unknown as Record<string, unknown>) : null;
}

export async function upsertSubscription(input: SubscriptionRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, plan, interval,
      status, active, budget_anchor_ms, current_period_end_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan = excluded.plan,
      interval = excluded.interval,
      status = excluded.status,
      active = excluded.active,
      budget_anchor_ms = excluded.budget_anchor_ms,
      current_period_end_ms = excluded.current_period_end_ms,
      updated_at_ms = excluded.updated_at_ms`,
    args: [
      input.userId,
      input.stripeCustomerId,
      input.stripeSubscriptionId,
      input.plan,
      input.interval,
      input.status,
      input.active ? 1 : 0,
      input.budgetAnchorMs,
      input.currentPeriodEndMs,
      Date.now()
    ]
  });
}

export async function recordStripeEvent(eventId: string, eventType: string): Promise<boolean> {
  const result = await client.execute({
    sql: "INSERT OR IGNORE INTO stripe_events(event_id, event_type, received_at_ms) VALUES (?, ?, ?)",
    args: [eventId, eventType, Date.now()]
  });
  return result.rowsAffected === 1;
}

export async function createRun(run: RunRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO runs(id, user_id, model, status, messages_json, pending_tool_use_id, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [run.id, run.userId, run.model, run.status, JSON.stringify(run.messages), run.pendingToolUseId, Date.now(), Date.now()]
  });
}

export async function getRun(runId: string, userId: string): Promise<RunRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM runs WHERE id = ? AND user_id = ? LIMIT 1",
    args: [runId, userId]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    model: String(row.model) as ModelTier,
    status: String(row.status),
    messages: JSON.parse(String(row.messages_json)) as unknown[],
    pendingToolUseId: row.pending_tool_use_id ? String(row.pending_tool_use_id) : null
  };
}

export async function updateRun(run: RunRow): Promise<void> {
  await client.execute({
    sql: `UPDATE runs SET model = ?, status = ?, messages_json = ?, pending_tool_use_id = ?, updated_at_ms = ?
      WHERE id = ? AND user_id = ?`,
    args: [run.model, run.status, JSON.stringify(run.messages), run.pendingToolUseId, Date.now(), run.id, run.userId]
  });
}

export { client };
