import { randomBytes, randomUUID } from "node:crypto";
import type { BillingInterval, ModelMode, ModelTier, PlanId, RunKind } from "@workcrew/contracts";
import { createDatabaseClient, type DatabaseClient } from "./database/driver.js";

// Referral codes use an unambiguous uppercase alphabet (no O/0, I/1, L) so a
// code copied from an invite link is easy to read and retype.
const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newReferralCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) code += REFERRAL_ALPHABET.charAt((bytes[i] ?? 0) % REFERRAL_ALPHABET.length);
  return code;
}

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
  /** Auto-reload settings. Managed separately from the Stripe webhook upsert so a
   * subscription sync never clobbers them. monthlyTopupLimitMicro is the cap on
   * automatic top-up spend per period (0 means auto-reload is not allowed to
   * spend). stripePaymentMethodId is the saved card used for off-session charges. */
  autoReloadEnabled: boolean;
  autoReloadPack: string;
  monthlyTopupLimitMicro: number;
  stripePaymentMethodId: string | null;
  /** A scheduled downgrade that has not taken effect yet: the lower plan/interval
   * the subscription moves to at the end of the current paid period, and when (ms).
   * Null when nothing is scheduled. Set by changePlan, cleared on upgrade or once
   * the schedule advances. Like auto-reload, the webhook upsert never writes these. */
  pendingPlan: PlanId | null;
  pendingInterval: BillingInterval | null;
  pendingEffectiveMs: number | null;
  /** The user's token-spend mode chosen in Settings. "economy" (default) uses the
   * cost-efficient engine for heavy work; "privacy" stays on Claude only. */
  modelMode: ModelMode;
  /** Referral bonus earned by this user (added to their monthly budget). Joined
   * from the users table on read; optional because it is not part of the
   * writable subscription row (upsert ignores it). */
  referralBonusMicrodollars?: number;
};

export type RunRow = {
  id: string;
  userId: string;
  model: ModelTier;
  /** Screen work, or work inside a folder the user attached. Sets the step ceiling. */
  kind: RunKind;
  status: string;
  messages: unknown[];
  pendingToolUseId: string | null;
  /** Number of model planning steps consumed by this run, capped server side. */
  stepCount: number;
  /** Normalized signature of the previous assistant action, for loop detection. */
  lastActionSignature: string | null;
  /** Number of consecutive identical actions seen so far (1 means seen once). */
  repeatCount: number;
  /** Whether this run has handed off to Claude after the Economy engine got stuck.
   * Once true, every remaining step uses Claude (the "solves what glm can't" net). */
  escalated: boolean;
  /** Cumulative model token usage across the run, for per-run cost and cache
   * effectiveness logging. Settled cost still lives in the usage ledger; these
   * are the raw token categories so a per-run total can be reported. */
  tokensInput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensOutput: number;
};

const client = createDatabaseClient();

/**
 * Ask SQLite to wait when the database is momentarily locked instead of failing
 * immediately with SQLITE_BUSY. A single file database can have only one writer
 * at a time, so concurrent writers (for example separate test workers or two
 * in-flight requests) need to queue briefly rather than error out. This is a
 * no-op for Postgres and for remote libsql endpoints.
 */
async function setBusyTimeout(db: DatabaseClient): Promise<void> {
  if (db.dialect !== "sqlite") return;
  try {
    await db.execute("PRAGMA busy_timeout = 5000");
  } catch {
    // Remote libsql endpoints may not accept PRAGMA; ignore in that case.
  }
}

export async function initializeDatabase(db: DatabaseClient = client): Promise<void> {
  await setBusyTimeout(db);
  // Millisecond timestamps and microdollar amounts use BIGINT so they fit in
  // Postgres (a 32-bit INTEGER overflows on epoch-ms values). SQLite treats
  // BIGINT as its 64-bit INTEGER affinity, so the same DDL runs on both.
  await db.batch([
    `CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'ultra')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      status TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      budget_anchor_ms BIGINT NOT NULL,
      current_period_end_ms BIGINT NOT NULL,
      auto_reload_enabled INTEGER NOT NULL DEFAULT 0,
      auto_reload_pack TEXT NOT NULL DEFAULT 'small',
      monthly_topup_limit_micro BIGINT NOT NULL DEFAULT 0,
      stripe_payment_method_id TEXT,
      pending_plan TEXT CHECK (pending_plan IN ('pro', 'ultra')),
      pending_interval TEXT CHECK (pending_interval IN ('month', 'year')),
      pending_effective_ms BIGINT,
      model_mode TEXT NOT NULL DEFAULT 'economy',
      updated_at_ms BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      period_start_ms BIGINT NOT NULL,
      period_end_ms BIGINT NOT NULL,
      model TEXT NOT NULL,
      reserved_microdollars BIGINT NOT NULL,
      actual_microdollars BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
      provider_request_id TEXT,
      created_at_ms BIGINT NOT NULL,
      settled_at_ms BIGINT,
      -- Stable key for credit grants that must happen at most once (Stripe top-up
      -- fulfilment, auto-reload). NULL for ordinary reservation/settlement rows.
      -- A unique index (created below) makes a duplicate grant a no-op.
      dedupe_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_user_period
      ON usage_ledger(user_id, period_start_ms, period_end_ms, status)`,
    `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'screen',
      status TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      pending_tool_use_id TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      last_action_signature TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      escalated INTEGER NOT NULL DEFAULT 0,
      tokens_input BIGINT NOT NULL DEFAULT 0,
      tokens_cache_read BIGINT NOT NULL DEFAULT 0,
      tokens_cache_write BIGINT NOT NULL DEFAULT 0,
      tokens_output BIGINT NOT NULL DEFAULT 0,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, updated_at_ms DESC)`,
    `CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at_ms BIGINT NOT NULL
    )`,
    // Local authentication identity. Passwords are only ever stored as a scrypt
    // hash plus a per-user random salt, never as plaintext. When the Supabase
    // auth provider owns identity these rows are simply unused.
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      referral_code TEXT,
      referred_by_code TEXT,
      referred_credited INTEGER NOT NULL DEFAULT 0,
      referral_bonus_microdollars BIGINT NOT NULL DEFAULT 0,
      name TEXT,
      created_at_ms BIGINT NOT NULL
    )`,
    // A login session. Refresh tokens hang off a session so that a single reuse
    // can revoke the whole session at once.
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL,
      last_seen_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      revoked_at_ms BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    // Single-use rotating refresh tokens. Only the hash of the opaque token is
    // stored. used_at_ms marks a token as already consumed, and replaced_by
    // points at the token it was rotated into.
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at_ms BIGINT NOT NULL,
      used_at_ms BIGINT,
      replaced_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_session ON refresh_tokens(session_id)`,
    // A chat conversation. project_id is nullable so a conversation can live
    // outside any project. title is a short label derived from the first user
    // message. model records the tier the conversation was started with.
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_user
      ON conversations(user_id, updated_at_ms DESC)`,
    // A single chat message. content_json holds the full Anthropic content block
    // array (text, thinking, citations, tool_use, and any attachment refs on the
    // user turn) so a reload preserves everything exactly.
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content_json TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at_ms ASC)`,
    // An uploaded file the user attached to a chat turn. Text files store their
    // decoded text in content_text; images and PDFs store canonical base64 in
    // content_base64. The bytes live here (not on local disk) so the backend can
    // feed them to the model from any host. conversation_id is optional.
    `CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pdf', 'image', 'text')),
      media_type TEXT NOT NULL,
      content_text TEXT,
      content_base64 TEXT,
      created_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_user
      ON attachments(user_id, created_at_ms DESC)`,
    // Single-use email tokens for address verification and password reset. Only
    // the hash of the opaque token is stored, like refresh tokens. purpose keeps
    // a verify token from being usable as a reset token and vice versa.
    `CREATE TABLE IF NOT EXISTS email_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at_ms BIGINT NOT NULL,
      used_at_ms BIGINT,
      created_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose)`,
    // Every action taken from the admin dashboard, so granting or removing paid
    // access is always attributable after the fact. Holds ids, an action name,
    // and a short plain detail string; never a password, token, or payload.
    `CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      target_email TEXT,
      detail TEXT,
      created_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at_ms)`,
    // One card checkout at the payment gateway. The row is written BEFORE the
    // payer is sent anywhere, so what they are buying is decided by the server
    // and cannot be influenced by anything that comes back afterwards. granted_at_ms
    // is the idempotency guard: a plan is handed out on the transition from NULL,
    // so a replayed notification, a refreshed return page and a webhook arriving
    // twice can between them grant access exactly once.
    `CREATE TABLE IF NOT EXISTS mpgs_orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('pro', 'ultra')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      amount_cents BIGINT NOT NULL,
      currency TEXT NOT NULL,
      session_id TEXT,
      success_indicator TEXT,
      status TEXT NOT NULL,
      granted_at_ms BIGINT,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_mpgs_orders_user ON mpgs_orders(user_id)`,
    // A shareable link that lets someone outside the business (the bank's own
    // tester, an auditor) run a card payment without an account and without any
    // access to the dashboard. The token is the whole credential, so it is long
    // and random; opening the link mints a FRESH order each time, so one link
    // covers as many test transactions as they want to run.
    `CREATE TABLE IF NOT EXISTS mpgs_test_links (
      token TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      plan TEXT NOT NULL CHECK (plan IN ('pro', 'ultra')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      created_by TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      expires_at_ms BIGINT NOT NULL,
      created_at_ms BIGINT NOT NULL
    )`
  ], "write");

  // Migrate databases created before the run safety columns existed. SQLite
  // has no ADD COLUMN IF NOT EXISTS, so each ALTER is attempted and a duplicate
  // column error is treated as already migrated. workcrew.db is gitignored and
  // rebuilt by this function, so this only matters for long lived local files.
  await addColumnIfMissing(db, "runs", "kind", "TEXT NOT NULL DEFAULT 'screen'");
  await addColumnIfMissing(db, "runs", "step_count", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "last_action_signature", "TEXT");
  await addColumnIfMissing(db, "runs", "repeat_count", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "escalated", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "tokens_input", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "tokens_cache_read", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "tokens_cache_write", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "tokens_output", "BIGINT NOT NULL DEFAULT 0");
  // Referral program columns on existing user rows.
  await addColumnIfMissing(db, "users", "referral_code", "TEXT");
  await addColumnIfMissing(db, "users", "referred_by_code", "TEXT");
  await addColumnIfMissing(db, "users", "referred_credited", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "users", "referral_bonus_microdollars", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "users", "name", "TEXT");
  // Token top-up and auto-reload columns on existing subscription rows.
  await addColumnIfMissing(db, "subscriptions", "auto_reload_enabled", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "subscriptions", "auto_reload_pack", "TEXT NOT NULL DEFAULT 'small'");
  await addColumnIfMissing(db, "subscriptions", "monthly_topup_limit_micro", "BIGINT NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "subscriptions", "stripe_payment_method_id", "TEXT");
  // A scheduled (not-yet-effective) downgrade on existing subscription rows.
  await addColumnIfMissing(db, "subscriptions", "pending_plan", "TEXT CHECK (pending_plan IN ('pro', 'ultra'))");
  await addColumnIfMissing(db, "subscriptions", "pending_interval", "TEXT CHECK (pending_interval IN ('month', 'year'))");
  await addColumnIfMissing(db, "subscriptions", "pending_effective_ms", "BIGINT");
  // Why a card checkout was refused, kept on the order so the operator can read
  // the gateway's own words in the dashboard instead of digging through logs.
  await addColumnIfMissing(db, "mpgs_orders", "failure_reason", "TEXT");
  // Whether settling this order should hand someone a paid plan. Orders opened
  // from a shared test link verify the payment but grant nothing: the point is
  // to prove the gateway works, not to put months on an account.
  await addColumnIfMissing(db, "mpgs_orders", "grants_plan", "INTEGER NOT NULL DEFAULT 1");
  // The user's token-spend mode (Economy vs Privacy), on existing subscription rows.
  await addColumnIfMissing(db, "subscriptions", "model_mode", "TEXT NOT NULL DEFAULT 'economy'");
  // Per-credit dedupe key on existing ledgers, so Stripe top-up fulfilment and
  // auto-reload can be made idempotent at the credit write itself.
  await addColumnIfMissing(db, "usage_ledger", "dedupe_id", "TEXT");
  // When a user pins a conversation. NULL means unpinned; a timestamp orders the
  // pinned chats (most recently pinned first) above the rest of Recents.
  await addColumnIfMissing(db, "conversations", "pinned_at_ms", "BIGINT");
  // Existing databases created before the free tier still carry a CHECK that
  // only allows 'pro' and 'ultra'; widen it so free-plan rows can be granted.
  await widenPlanCheckForFreeTier(db);
  // Created after the column migration so it also applies to databases whose
  // users table predates the referral columns. Multiple NULL codes are allowed
  // by both SQLite and Postgres, so legacy rows without a code do not collide.
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)");
  // The dedupe guard for one-time credit grants. NULL dedupe_id (every
  // reservation/settlement row) is allowed many times by both dialects; only a
  // repeated non-null key collides, which ON CONFLICT / INSERT OR IGNORE turns
  // into a no-op so a duplicate top-up or auto-reload cannot double-credit.
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedupe ON usage_ledger(dedupe_id)");
}

async function addColumnIfMissing(db: DatabaseClient, table: string, column: string, definition: string): Promise<void> {
  // Postgres supports ADD COLUMN IF NOT EXISTS directly, so the migration is a
  // no-op when the column is already present and never throws.
  if (db.dialect === "postgres") {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    return;
  }
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    // A duplicate column name means the migration already ran. Anything else is
    // a real failure and must surface.
    if (!message.includes("duplicate column") && !message.includes("already exists")) throw error;
  }
}

// Databases created before the free tier carry a CHECK that only allows the
// paid plans, which would reject every free-plan grant. Widen it to include
// 'free', per dialect: Postgres can drop and re-add the named constraint;
// SQLite cannot alter a CHECK, so the table is rebuilt once (rename, recreate
// with the current DDL, copy, drop). Both paths are idempotent: they detect
// the already-widened state and do nothing.
async function widenPlanCheckForFreeTier(db: DatabaseClient): Promise<void> {
  if (db.dialect === "postgres") {
    // Find check constraints that mention the plan column but not pending_plan
    // and do not already allow 'free'; those are the stale paid-only checks.
    const stale = await db.execute(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'subscriptions'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%plan%'
        AND pg_get_constraintdef(oid) NOT LIKE '%pending_plan%'
        AND pg_get_constraintdef(oid) NOT LIKE '%interval%'
        AND pg_get_constraintdef(oid) NOT LIKE '%free%'`);
    for (const row of stale.rows as unknown as { conname: string }[]) {
      await db.execute(`ALTER TABLE subscriptions DROP CONSTRAINT "${row.conname}"`);
    }
    if (stale.rows.length > 0) {
      await db.execute("ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('free', 'pro', 'ultra'))");
    }
    return;
  }
  const master = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'");
  const tableSql = String((master.rows[0] as unknown as { sql?: unknown })?.sql ?? "");
  if (!tableSql.includes("plan IN ('pro', 'ultra')")) return;
  const columns =
    "user_id, stripe_customer_id, stripe_subscription_id, plan, interval, status, active, " +
    "budget_anchor_ms, current_period_end_ms, auto_reload_enabled, auto_reload_pack, " +
    "monthly_topup_limit_micro, stripe_payment_method_id, pending_plan, pending_interval, " +
    "pending_effective_ms, model_mode, updated_at_ms";
  await db.batch([
    "ALTER TABLE subscriptions RENAME TO subscriptions_legacy_plan",
    `CREATE TABLE subscriptions (
      user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'ultra')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      status TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      budget_anchor_ms BIGINT NOT NULL,
      current_period_end_ms BIGINT NOT NULL,
      auto_reload_enabled INTEGER NOT NULL DEFAULT 0,
      auto_reload_pack TEXT NOT NULL DEFAULT 'small',
      monthly_topup_limit_micro BIGINT NOT NULL DEFAULT 0,
      stripe_payment_method_id TEXT,
      pending_plan TEXT CHECK (pending_plan IN ('pro', 'ultra')),
      pending_interval TEXT CHECK (pending_interval IN ('month', 'year')),
      pending_effective_ms BIGINT,
      model_mode TEXT NOT NULL DEFAULT 'economy',
      updated_at_ms BIGINT NOT NULL
    )`,
    `INSERT INTO subscriptions (${columns}) SELECT ${columns} FROM subscriptions_legacy_plan`,
    "DROP TABLE subscriptions_legacy_plan"
  ]);
}

// A strictly increasing millisecond clock for ordering rows written in quick
// succession within this process (for example a user turn and its assistant
// reply). When the wall clock has not advanced, the previous value is bumped by
// one so two inserts never share a timestamp.
let lastTimestampMs = 0;
function nextTimestampMs(): number {
  const now = Date.now();
  lastTimestampMs = now > lastTimestampMs ? now : lastTimestampMs + 1;
  return lastTimestampMs;
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
    currentPeriodEndMs: asNumber(row.current_period_end_ms),
    autoReloadEnabled: asNumber(row.auto_reload_enabled) === 1,
    autoReloadPack: row.auto_reload_pack ? String(row.auto_reload_pack) : "small",
    monthlyTopupLimitMicro: asNumber(row.monthly_topup_limit_micro),
    stripePaymentMethodId: row.stripe_payment_method_id ? String(row.stripe_payment_method_id) : null,
    pendingPlan: row.pending_plan ? (String(row.pending_plan) as PlanId) : null,
    pendingInterval: row.pending_interval ? (String(row.pending_interval) as BillingInterval) : null,
    pendingEffectiveMs: row.pending_effective_ms == null ? null : asNumber(row.pending_effective_ms),
    modelMode: String(row.model_mode) === "privacy" ? "privacy" : "economy",
    referralBonusMicrodollars: asNumber(row.referral_bonus_microdollars)
  };
}

// Save the user's token-spend mode chosen in Settings. A no-op (returns false) if
// the user has no subscription row, since the mode only affects paid model use.
export async function setModelMode(userId: string, mode: ModelMode): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE subscriptions SET model_mode = ?, updated_at_ms = ? WHERE user_id = ?",
    args: [mode, Date.now(), userId]
  });
  return result.rowsAffected > 0;
}

export async function getSubscription(userId: string): Promise<SubscriptionRow | null> {
  // Join the user's referral bonus so the effective monthly budget (plan budget
  // plus earned bonus) is available everywhere a subscription is read.
  const result = await client.execute({
    sql: `SELECT s.*, COALESCE(u.referral_bonus_microdollars, 0) AS referral_bonus_microdollars
      FROM subscriptions s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.user_id = ? LIMIT 1`,
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

// The Stripe webhook and the simulated provider write the subscription identity
// and budget window. They never touch the auto-reload settings or the saved
// payment method, so a subscription sync cannot clobber a user's auto-reload
// configuration. Those columns are managed by setAutoReloadConfig/setPaymentMethod.
type SubscriptionUpsert = Omit<
  SubscriptionRow,
  "autoReloadEnabled" | "autoReloadPack" | "monthlyTopupLimitMicro" | "stripePaymentMethodId"
    | "pendingPlan" | "pendingInterval" | "pendingEffectiveMs" | "modelMode" | "referralBonusMicrodollars"
>;

export async function upsertSubscription(input: SubscriptionUpsert): Promise<void> {
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

// Grant the no-card free plan to a user who has NO subscription row at all.
// ON CONFLICT DO NOTHING makes this strictly additive and idempotent: it can
// never touch, downgrade, or reset an existing row (free or paid), so calling
// it on every entitlement read is safe and a Stripe webhook still remains the
// only writer that can grant a paid tier. The budget anchor is set at grant
// time, so the $0.30 monthly free allowance renews on the user's own monthly
// anniversary through the same budget-window math paid plans use.
export async function grantFreeSubscriptionIfAbsent(userId: string): Promise<void> {
  const now = Date.now();
  // The free plan never expires on its own; access is bounded by the budget
  // caps, not by a billing period. A century out keeps every "still active"
  // comparison simple without a magic null.
  const FREE_PERIOD_END_MS = now + 100 * 365 * 24 * 60 * 60 * 1000;
  await client.execute({
    sql: `INSERT INTO subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, plan, interval,
      status, active, budget_anchor_ms, current_period_end_ms, updated_at_ms
    ) VALUES (?, NULL, NULL, 'free', 'month', 'free', 1, ?, ?, ?)
    ON CONFLICT(user_id) DO NOTHING`,
    args: [userId, now, FREE_PERIOD_END_MS, now]
  });
}

// Record a scheduled downgrade that takes effect at the end of the current paid
// period. The current (higher) plan and limit are untouched; only this marker is
// set, so the UI can show "switches to <plan> on <date>" while access stays high.
export async function setPendingDowngrade(
  userId: string,
  plan: PlanId,
  interval: BillingInterval,
  effectiveMs: number
): Promise<void> {
  await client.execute({
    sql: `UPDATE subscriptions
      SET pending_plan = ?, pending_interval = ?, pending_effective_ms = ?, updated_at_ms = ?
      WHERE user_id = ?`,
    args: [plan, interval, effectiveMs, Date.now(), userId]
  });
}

// Clear any scheduled downgrade, used when it is canceled (the user re-selects or
// upgrades) or once it has taken effect and the live plan already reflects it.
export async function clearPendingDowngrade(userId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE subscriptions
      SET pending_plan = NULL, pending_interval = NULL, pending_effective_ms = NULL, updated_at_ms = ?
      WHERE user_id = ?`,
    args: [Date.now(), userId]
  });
}

// Save the user's auto-reload preferences. A no-op if the user has no
// subscription row yet (auto-reload only matters for an active subscriber).
export async function setAutoReloadConfig(
  userId: string,
  config: { enabled: boolean; pack: string; monthlyLimitMicro: number }
): Promise<void> {
  await client.execute({
    sql: `UPDATE subscriptions
      SET auto_reload_enabled = ?, auto_reload_pack = ?, monthly_topup_limit_micro = ?, updated_at_ms = ?
      WHERE user_id = ?`,
    args: [config.enabled ? 1 : 0, config.pack, config.monthlyLimitMicro, Date.now(), userId]
  });
}

// Record the saved Stripe payment method used for off-session auto-reload charges.
export async function setPaymentMethod(userId: string, paymentMethodId: string | null): Promise<void> {
  await client.execute({
    sql: "UPDATE subscriptions SET stripe_payment_method_id = ?, updated_at_ms = ? WHERE user_id = ?",
    args: [paymentMethodId, Date.now(), userId]
  });
}

/** Whether a Stripe event id has already been processed and recorded. */
export async function hasStripeEvent(eventId: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM stripe_events WHERE event_id = ? LIMIT 1",
    args: [eventId]
  });
  return result.rows.length > 0;
}

export async function recordStripeEvent(eventId: string, eventType: string): Promise<boolean> {
  // Insert-or-ignore differs by dialect. Either way a fresh insert affects one
  // row (first time the event is seen) and a duplicate affects zero (idempotent).
  const sql = client.dialect === "postgres"
    ? "INSERT INTO stripe_events(event_id, event_type, received_at_ms) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING"
    : "INSERT OR IGNORE INTO stripe_events(event_id, event_type, received_at_ms) VALUES (?, ?, ?)";
  const result = await client.execute({ sql, args: [eventId, eventType, Date.now()] });
  return result.rowsAffected === 1;
}

export async function createRun(run: RunRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO runs(
        id, user_id, model, kind, status, messages_json, pending_tool_use_id,
        step_count, last_action_signature, repeat_count, escalated,
        tokens_input, tokens_cache_read, tokens_cache_write, tokens_output,
        created_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      run.userId,
      run.model,
      run.kind,
      run.status,
      JSON.stringify(run.messages),
      run.pendingToolUseId,
      run.stepCount,
      run.lastActionSignature,
      run.repeatCount,
      run.escalated ? 1 : 0,
      run.tokensInput,
      run.tokensCacheRead,
      run.tokensCacheWrite,
      run.tokensOutput,
      Date.now(),
      Date.now()
    ]
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
    // Rows written before this column existed are screen work, which is also
    // what the column defaults to.
    kind: row.kind === "folder" ? "folder" : "screen",
    status: String(row.status),
    messages: JSON.parse(String(row.messages_json)) as unknown[],
    pendingToolUseId: row.pending_tool_use_id ? String(row.pending_tool_use_id) : null,
    stepCount: asNumber(row.step_count),
    lastActionSignature: row.last_action_signature ? String(row.last_action_signature) : null,
    repeatCount: asNumber(row.repeat_count),
    escalated: asNumber(row.escalated) === 1,
    tokensInput: asNumber(row.tokens_input),
    tokensCacheRead: asNumber(row.tokens_cache_read),
    tokensCacheWrite: asNumber(row.tokens_cache_write),
    tokensOutput: asNumber(row.tokens_output)
  };
}

export async function updateRun(run: RunRow): Promise<void> {
  await client.execute({
    sql: `UPDATE runs SET
        model = ?, status = ?, messages_json = ?, pending_tool_use_id = ?,
        step_count = ?, last_action_signature = ?, repeat_count = ?, escalated = ?,
        tokens_input = ?, tokens_cache_read = ?, tokens_cache_write = ?, tokens_output = ?,
        updated_at_ms = ?
      WHERE id = ? AND user_id = ?`,
    args: [
      run.model,
      run.status,
      JSON.stringify(run.messages),
      run.pendingToolUseId,
      run.stepCount,
      run.lastActionSignature,
      run.repeatCount,
      run.escalated ? 1 : 0,
      run.tokensInput,
      run.tokensCacheRead,
      run.tokensCacheWrite,
      run.tokensOutput,
      Date.now(),
      run.id,
      run.userId
    ]
  });
}

// ---------------------------------------------------------------------------
// Local authentication: users, sessions, and refresh tokens
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string;
  emailVerified: boolean;
  passwordHash: string;
  passwordSalt: string;
  /** This user's own referral code (null only for legacy rows until assigned). */
  referralCode: string | null;
  /** The referral code that brought this user in, if any. */
  referredByCode: string | null;
  /** Whether the referrer has already been credited for this user's first payment. */
  referredCredited: boolean;
  /** Bonus this user has earned as a referrer, added to their monthly budget. */
  referralBonusMicrodollars: number;
  /** Display name, collected at sign-up or set later in account settings. */
  name: string | null;
  createdAtMs: number;
};

export type SessionRow = {
  id: string;
  userId: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
};

export type RefreshTokenRow = {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAtMs: number;
  usedAtMs: number | null;
  replacedBy: string | null;
};

function mapUser(row: Record<string, unknown>): UserRow {
  return {
    id: String(row.id),
    email: String(row.email),
    emailVerified: asNumber(row.email_verified) === 1,
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    referralCode: row.referral_code == null ? null : String(row.referral_code),
    referredByCode: row.referred_by_code == null ? null : String(row.referred_by_code),
    referredCredited: asNumber(row.referred_credited) === 1,
    referralBonusMicrodollars: asNumber(row.referral_bonus_microdollars),
    name: row.name == null ? null : String(row.name),
    createdAtMs: asNumber(row.created_at_ms)
  };
}

function mapSession(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    createdAtMs: asNumber(row.created_at_ms),
    lastSeenAtMs: asNumber(row.last_seen_at_ms),
    expiresAtMs: asNumber(row.expires_at_ms),
    revokedAtMs: row.revoked_at_ms == null ? null : asNumber(row.revoked_at_ms)
  };
}

function mapRefreshToken(row: Record<string, unknown>): RefreshTokenRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    tokenHash: String(row.token_hash),
    createdAtMs: asNumber(row.created_at_ms),
    usedAtMs: row.used_at_ms == null ? null : asNumber(row.used_at_ms),
    replacedBy: row.replaced_by == null ? null : String(row.replaced_by)
  };
}

/**
 * Insert a new user. Email is stored already normalized (lowercased and
 * trimmed) by the caller. The UNIQUE constraint on email surfaces as a libsql
 * error which the caller translates into EMAIL_IN_USE.
 */
export async function createUser(input: {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  emailVerified?: boolean;
  /** Optional display name collected at sign-up. */
  name?: string | null;
  /** The referral code that brought this user in (already validated by caller). */
  referredByCode?: string | null;
}): Promise<void> {
  await client.execute({
    sql: `INSERT INTO users(
        id, email, email_verified, password_hash, password_salt,
        referral_code, referred_by_code, referred_credited, referral_bonus_microdollars, name, created_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    args: [
      input.id,
      input.email,
      input.emailVerified ? 1 : 0,
      input.passwordHash,
      input.passwordSalt,
      newReferralCode(),
      input.referredByCode ?? null,
      input.name ?? null,
      Date.now()
    ]
  });
}

/** Set or clear a user's display name (sign-up or later in account settings). */
export async function setUserName(userId: string, name: string | null): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET name = ? WHERE id = ?",
    args: [name, userId]
  });
}

/** Look up a user by their referral code (used to validate a code at sign-up). */
export async function getUserByReferralCode(code: string): Promise<UserRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE referral_code = ? LIMIT 1",
    args: [code]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

/**
 * Return the user's referral code, assigning one if a legacy row never had it.
 * The guarded UPDATE plus a re-read makes concurrent calls converge on a single
 * code rather than racing.
 */
export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  if (user.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newReferralCode();
    const result = await client.execute({
      sql: "UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL",
      args: [code, userId]
    });
    if (result.rowsAffected === 1) return code;
    const fresh = await getUserById(userId);
    if (fresh?.referralCode) return fresh.referralCode;
  }
  throw new Error("Could not assign a referral code");
}

/** How many users a referral code has brought in, and how many have paid. */
export async function countReferrals(code: string): Promise<{ invited: number; credited: number }> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS invited, COALESCE(SUM(referred_credited), 0) AS credited FROM users WHERE referred_by_code = ?",
    args: [code]
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return { invited: asNumber(row?.invited ?? 0), credited: asNumber(row?.credited ?? 0) };
}

/**
 * Mark a referred user as credited, exactly once, and return the inviter's code
 * so the caller can grant the one-time bonus. The guarded UPDATE on
 * referred_credited makes this idempotent: a second activation event for the
 * same user returns null and grants nothing. The actual token grant (a one-time
 * credit, not a recurring budget bump) is delivered by the budget layer, which
 * is why this only resolves the inviter rather than crediting here.
 */
export async function claimReferralCredit(userId: string): Promise<{ referrerCode: string } | null> {
  const user = await getUserById(userId);
  if (!user || !user.referredByCode || user.referredCredited) return null;
  const guard = await client.execute({
    sql: "UPDATE users SET referred_credited = 1 WHERE id = ? AND referred_credited = 0 AND referred_by_code IS NOT NULL",
    args: [userId]
  });
  if (guard.rowsAffected !== 1) return null;
  return { referrerCode: user.referredByCode };
}

/** Add to a user's lifetime referral tokens earned (shown in the invite dialog). */
export async function addReferralEarned(referrerId: string, amountMicrodollars: number): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET referral_bonus_microdollars = referral_bonus_microdollars + ? WHERE id = ?",
    args: [amountMicrodollars, referrerId]
  });
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE email = ? LIMIT 1",
    args: [email]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE id = ? LIMIT 1",
    args: [id]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

/**
 * Create a session together with its first refresh token. Both the session and
 * the initial refresh token row are written so the very first refresh can be
 * validated and rotated.
 */
export async function createSession(input: {
  sessionId: string;
  userId: string;
  expiresAtMs: number;
  refreshTokenId: string;
  refreshTokenHash: string;
}): Promise<void> {
  const now = Date.now();
  await client.batch([
    {
      sql: `INSERT INTO sessions(id, user_id, created_at_ms, last_seen_at_ms, expires_at_ms, revoked_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL)`,
      args: [input.sessionId, input.userId, now, now, input.expiresAtMs]
    },
    {
      sql: `INSERT INTO refresh_tokens(id, session_id, token_hash, created_at_ms, used_at_ms, replaced_by)
        VALUES (?, ?, ?, ?, NULL, NULL)`,
      args: [input.refreshTokenId, input.sessionId, input.refreshTokenHash, now]
    }
  ], "write");
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM sessions WHERE id = ? LIMIT 1",
    args: [sessionId]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapSession(row) : null;
}

export async function getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1",
    args: [tokenHash]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapRefreshToken(row) : null;
}

/** Look up a refresh token by its id. Used to follow a rotation (replaced_by) to
 * the successor token when recovering a client that lost a rotation. */
export async function getRefreshTokenById(id: string): Promise<RefreshTokenRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM refresh_tokens WHERE id = ? LIMIT 1",
    args: [id]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapRefreshToken(row) : null;
}

/**
 * Look up the session that owns a refresh token, joining the token by its hash.
 * Returns both rows so the caller can validate freshness and rotation state in
 * one round trip.
 */
export async function getSessionByRefreshToken(tokenHash: string): Promise<{
  session: SessionRow;
  token: RefreshTokenRow;
} | null> {
  const token = await getRefreshTokenByHash(tokenHash);
  if (!token) return null;
  const session = await getSession(token.sessionId);
  if (!session) return null;
  return { session, token };
}

/**
 * Rotate a refresh token as a single atomic step. The old token is marked used
 * and pointed at the new token, the new token row is inserted, and the session
 * last_seen timestamp is bumped. The UPDATE is guarded by used_at_ms IS NULL so
 * two concurrent rotations of the same token cannot both succeed; the caller
 * checks rowsAffected to detect a reuse race.
 */
export async function rotateRefreshToken(input: {
  oldTokenId: string;
  newTokenId: string;
  sessionId: string;
  newTokenHash: string;
}): Promise<boolean> {
  const now = Date.now();
  const guard = await client.execute({
    sql: `UPDATE refresh_tokens SET used_at_ms = ?, replaced_by = ?
      WHERE id = ? AND used_at_ms IS NULL`,
    args: [now, input.newTokenId, input.oldTokenId]
  });
  if (guard.rowsAffected !== 1) return false;

  await client.batch([
    {
      sql: `INSERT INTO refresh_tokens(id, session_id, token_hash, created_at_ms, used_at_ms, replaced_by)
        VALUES (?, ?, ?, ?, NULL, NULL)`,
      args: [input.newTokenId, input.sessionId, input.newTokenHash, now]
    },
    {
      sql: "UPDATE sessions SET last_seen_at_ms = ? WHERE id = ?",
      args: [now, input.sessionId]
    }
  ], "write");
  return true;
}

/**
 * Revoke a whole session. Idempotent: revoking an already revoked session is a
 * no-op. Used both on explicit sign-out and on refresh-token reuse detection.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE sessions SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL",
    args: [Date.now(), sessionId]
  });
}

/** Revoke every active session for a user, e.g. after a password reset. */
export async function revokeUserSessions(userId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE sessions SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL",
    args: [Date.now(), userId]
  });
}

// ---------------------------------------------------------------------------
// Email tokens (verification and password reset) and user mutations
// ---------------------------------------------------------------------------

export type EmailTokenRow = {
  id: string;
  userId: string;
  email: string;
  purpose: "verify" | "reset";
  tokenHash: string;
  expiresAtMs: number;
  usedAtMs: number | null;
  createdAtMs: number;
};

function mapEmailToken(row: Record<string, unknown>): EmailTokenRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: String(row.email),
    purpose: String(row.purpose) as "verify" | "reset",
    tokenHash: String(row.token_hash),
    expiresAtMs: asNumber(row.expires_at_ms),
    usedAtMs: row.used_at_ms == null ? null : asNumber(row.used_at_ms),
    createdAtMs: asNumber(row.created_at_ms)
  };
}

/** Store a new single-use email token (only its hash is persisted). */
export async function createEmailToken(input: {
  id: string;
  userId: string;
  email: string;
  purpose: "verify" | "reset";
  tokenHash: string;
  expiresAtMs: number;
}): Promise<void> {
  await client.execute({
    sql: `INSERT INTO email_tokens(id, user_id, email, purpose, token_hash, expires_at_ms, used_at_ms, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    args: [input.id, input.userId, input.email, input.purpose, input.tokenHash, input.expiresAtMs, Date.now()]
  });
}

/**
 * Mark every still-unused token of a given purpose for a user as used. Called
 * before issuing a new verify or reset link so only the newest link is ever
 * valid, which narrows the window if an older email is intercepted.
 */
export async function invalidateUnusedEmailTokens(userId: string, purpose: "verify" | "reset"): Promise<void> {
  await client.execute({
    sql: "UPDATE email_tokens SET used_at_ms = ? WHERE user_id = ? AND purpose = ? AND used_at_ms IS NULL",
    args: [Date.now(), userId, purpose]
  });
}

/** Look up an email token by its hash and purpose, or null. */
export async function getEmailToken(tokenHash: string, purpose: "verify" | "reset"): Promise<EmailTokenRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? LIMIT 1",
    args: [tokenHash, purpose]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapEmailToken(row) : null;
}

/**
 * Mark a token consumed only if it was still unused. Returns true when this call
 * is the one that consumed it, so two concurrent uses cannot both succeed.
 */
export async function consumeEmailToken(id: string): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE email_tokens SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL",
    args: [Date.now(), id]
  });
  return result.rowsAffected === 1;
}

/** Mark a user's email address as verified. */
export async function setUserEmailVerified(userId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET email_verified = 1 WHERE id = ?",
    args: [userId]
  });
}

/** Replace a user's password hash and salt (used by password reset). */
export async function updateUserPassword(userId: string, passwordHash: string, passwordSalt: string): Promise<void> {
  await client.execute({
    sql: "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
    args: [passwordHash, passwordSalt, userId]
  });
}

/**
 * Apply a password reset as a single transaction: mark the token used, set the
 * new password, and revoke every existing session. Doing all three in one batch
 * means the whole unit either commits or rolls back together, and the driver can
 * safely retry the entire transaction if the connection drops, instead of
 * leaving the token consumed but the password unchanged. The token's single use
 * is enforced by the caller's prior lookup, so the consume here is best-effort.
 */
export async function applyPasswordReset(input: {
  tokenId: string;
  userId: string;
  passwordHash: string;
  passwordSalt: string;
  nowMs: number;
}): Promise<void> {
  await client.batch([
    {
      sql: "UPDATE email_tokens SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL",
      args: [input.nowMs, input.tokenId]
    },
    {
      sql: "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
      args: [input.passwordHash, input.passwordSalt, input.userId]
    },
    {
      sql: "UPDATE sessions SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL",
      args: [input.nowMs, input.userId]
    }
  ]);
}

// ---------------------------------------------------------------------------
// Chat: conversations and messages
// ---------------------------------------------------------------------------

export type ConversationRow = {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  model: ModelTier;
  createdAtMs: number;
  updatedAtMs: number;
  pinnedAtMs: number | null;
};

export type MessageRow = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  /** The full Anthropic content block array for this turn. */
  content: unknown[];
  createdAtMs: number;
};

function mapConversation(row: Record<string, unknown>): ConversationRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    title: String(row.title),
    model: String(row.model) as ModelTier,
    createdAtMs: asNumber(row.created_at_ms),
    updatedAtMs: asNumber(row.updated_at_ms),
    pinnedAtMs: row.pinned_at_ms == null ? null : asNumber(row.pinned_at_ms)
  };
}

function mapMessage(row: Record<string, unknown>): MessageRow {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as "user" | "assistant",
    content: JSON.parse(String(row.content_json)) as unknown[],
    createdAtMs: asNumber(row.created_at_ms)
  };
}

/** Insert a new conversation. created_at and updated_at start equal. */
export async function createConversation(input: {
  id: string;
  userId: string;
  projectId?: string | null;
  title: string;
  model: ModelTier;
}): Promise<ConversationRow> {
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO conversations(
        id, user_id, project_id, title, model, created_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [input.id, input.userId, input.projectId ?? null, input.title, input.model, now, now]
  });
  return {
    id: input.id,
    userId: input.userId,
    projectId: input.projectId ?? null,
    title: input.title,
    model: input.model,
    createdAtMs: now,
    updatedAtMs: now,
    pinnedAtMs: null
  };
}

/** Fetch a conversation owned by the given user, or null. Filters by user_id. */
export async function getConversation(id: string, userId: string): Promise<ConversationRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM conversations WHERE id = ? AND user_id = ? LIMIT 1",
    args: [id, userId]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapConversation(row) : null;
}

/** List a user's conversations newest first. Filters by user_id. Bounded so a
 * user with a very large history cannot force an unbounded result set into memory. */
export async function listConversations(userId: string): Promise<ConversationRow[]> {
  const result = await client.execute({
    // Pinned chats first (most recently pinned on top), then the rest by recency.
    // The CASE keeps the ordering identical on SQLite and Postgres, which differ on
    // where NULLs sort by default.
    sql: `SELECT * FROM conversations WHERE user_id = ?
      ORDER BY CASE WHEN pinned_at_ms IS NULL THEN 1 ELSE 0 END, pinned_at_ms DESC, updated_at_ms DESC
      LIMIT 500`,
    args: [userId]
  });
  return result.rows.map((row) => mapConversation(row as unknown as Record<string, unknown>));
}

/** Rename a conversation (title only; does not change its recency order). Scoped
 * by user_id. Returns true when the user owns and updated the conversation. */
export async function renameConversation(id: string, userId: string, title: string): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?",
    args: [title, id, userId]
  });
  return result.rowsAffected > 0;
}

/** Pin or unpin a conversation. Pinning stamps pinned_at_ms with now; unpinning
 * clears it. Scoped by user_id. Returns true when the user owns the conversation. */
export async function setConversationPinned(id: string, userId: string, pinned: boolean): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE conversations SET pinned_at_ms = ? WHERE id = ? AND user_id = ?",
    args: [pinned ? Date.now() : null, id, userId]
  });
  return result.rowsAffected > 0;
}

/** Append a message to a conversation. content is stored as a JSON block array. */
export async function addMessage(input: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: unknown[];
}): Promise<MessageRow> {
  // A process-monotonic timestamp guarantees the user turn sorts before the
  // assistant turn even if both land in the same millisecond, so transcript
  // order does not depend on a dialect-specific tiebreaker like SQLite rowid.
  const now = nextTimestampMs();
  await client.execute({
    sql: `INSERT INTO messages(id, conversation_id, role, content_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?)`,
    args: [input.id, input.conversationId, input.role, JSON.stringify(input.content), now]
  });
  return {
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAtMs: now
  };
}

/**
 * All messages in a conversation, oldest first, for replay and reload. Scoped by
 * owner via a join on conversations.user_id so ownership is enforced in the query
 * itself, not left to the caller. The messages table has no own user_id column, so
 * the join is how a message inherits its conversation's owner. This makes a future
 * caller physically unable to read another user's transcript.
 */
export async function getMessages(conversationId: string, userId: string): Promise<MessageRow[]> {
  const result = await client.execute({
    sql: `SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ? AND c.user_id = ?
      ORDER BY m.created_at_ms ASC, m.id ASC`,
    args: [conversationId, userId]
  });
  return result.rows.map((row) => mapMessage(row as unknown as Record<string, unknown>));
}

/**
 * Bump a conversation's updated_at timestamp, optionally renaming it. Used after
 * each turn so the Recents list orders by most recent activity. Filters by
 * user_id so one user can never touch another user's conversation.
 */
export async function touchConversation(input: {
  id: string;
  userId: string;
  title?: string;
}): Promise<void> {
  const now = Date.now();
  if (input.title === undefined) {
    await client.execute({
      sql: "UPDATE conversations SET updated_at_ms = ? WHERE id = ? AND user_id = ?",
      args: [now, input.id, input.userId]
    });
    return;
  }
  await client.execute({
    sql: "UPDATE conversations SET updated_at_ms = ?, title = ? WHERE id = ? AND user_id = ?",
    args: [now, input.title, input.id, input.userId]
  });
}

/**
 * Delete a conversation and all of its messages. Filters by user_id so deletion
 * is scoped to the owner. Returns true when a conversation was actually removed.
 * Messages are removed first so no orphan rows remain even without a foreign key.
 */
export async function deleteConversation(id: string, userId: string): Promise<boolean> {
  const owned = await getConversation(id, userId);
  if (!owned) return false;
  await client.batch([
    { sql: "DELETE FROM messages WHERE conversation_id = ?", args: [id] },
    { sql: "DELETE FROM conversations WHERE id = ? AND user_id = ?", args: [id, userId] }
  ], "write");
  return true;
}

// Permanently remove every row this user owns, for account deletion. Children are
// deleted before their parents (messages before conversations, refresh tokens
// before sessions) and the whole thing runs as one batch so a partial delete
// cannot leave orphaned data. Stripe billing records are intentionally NOT touched
// here (legal retention); the subscription is canceled at Stripe by the caller.
export async function deleteAccount(userId: string): Promise<void> {
  await client.batch([
    { sql: "DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)", args: [userId] },
    { sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)", args: [userId] },
    { sql: "DELETE FROM conversations WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM attachments WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM runs WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM usage_ledger WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM email_tokens WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM subscriptions WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM users WHERE id = ?", args: [userId] }
  ], "write");
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type AttachmentRow = {
  id: string;
  userId: string;
  conversationId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "pdf" | "image" | "text";
  mediaType: string;
  /** Decoded text for text files, otherwise null. */
  contentText: string | null;
  /** Canonical base64 for images and PDFs, otherwise null. */
  contentBase64: string | null;
  createdAtMs: number;
};

function mapAttachment(row: Record<string, unknown>): AttachmentRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: row.conversation_id == null ? null : String(row.conversation_id),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: asNumber(row.size_bytes),
    kind: String(row.kind) as "pdf" | "image" | "text",
    mediaType: String(row.media_type),
    contentText: row.content_text == null ? null : String(row.content_text),
    contentBase64: row.content_base64 == null ? null : String(row.content_base64),
    createdAtMs: asNumber(row.created_at_ms)
  };
}

/** Persist an uploaded attachment together with its stored content. */
export async function createAttachment(input: AttachmentRow): Promise<void> {
  await client.execute({
    sql: `INSERT INTO attachments(
        id, user_id, conversation_id, filename, mime_type, size_bytes,
        kind, media_type, content_text, content_base64, created_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.userId,
      input.conversationId,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.kind,
      input.mediaType,
      input.contentText,
      input.contentBase64,
      input.createdAtMs
    ]
  });
}

/** Fetch an attachment owned by the given user, or null. Scoped by user_id. */
export async function getAttachment(id: string, userId: string): Promise<AttachmentRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM attachments WHERE id = ? AND user_id = ? LIMIT 1",
    args: [id, userId]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapAttachment(row) : null;
}

// Admin dashboard queries ----------------------------------------------------
// Read-only listing plus the audit trail. Everything that CHANGES a customer's
// access goes through the existing upsertSubscription / user helpers above, so
// there is exactly one write path for entitlements.

/** One row of the admin customer list: the account plus its access state. */
export type AdminCustomerRow = {
  userId: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  createdAtMs: number;
  plan: string | null;
  status: string | null;
  active: boolean;
  currentPeriodEndMs: number | null;
};

function mapAdminCustomer(row: Record<string, unknown>): AdminCustomerRow {
  return {
    userId: String(row.id),
    email: String(row.email),
    name: row.name === null || row.name === undefined ? null : String(row.name),
    emailVerified: Number(row.email_verified) === 1,
    createdAtMs: Number(row.created_at_ms),
    plan: row.plan === null || row.plan === undefined ? null : String(row.plan),
    status: row.status === null || row.status === undefined ? null : String(row.status),
    active: Number(row.active ?? 0) === 1,
    currentPeriodEndMs:
      row.current_period_end_ms === null || row.current_period_end_ms === undefined
        ? null
        : Number(row.current_period_end_ms)
  };
}

/**
 * List accounts with their subscription state, newest first. `search` matches a
 * substring of the email (case-insensitive). The limit is applied by the caller's
 * validated bound; one extra row is never fetched, so paging is offset based.
 */
export async function listAdminCustomers(input: {
  search?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: AdminCustomerRow[]; total: number }> {
  const like = input.search ? `%${input.search.toLowerCase()}%` : null;
  const where = like ? "WHERE LOWER(u.email) LIKE ?" : "";
  const filterArgs = like ? [like] : [];

  const counted = await client.execute({
    sql: `SELECT COUNT(*) AS total FROM users u ${where}`,
    args: filterArgs
  });
  const total = Number((counted.rows[0] as unknown as { total?: unknown })?.total ?? 0);

  const result = await client.execute({
    sql: `SELECT u.id, u.email, u.name, u.email_verified, u.created_at_ms,
            s.plan, s.status, s.active, s.current_period_end_ms
          FROM users u
          LEFT JOIN subscriptions s ON s.user_id = u.id
          ${where}
          ORDER BY u.created_at_ms DESC
          LIMIT ? OFFSET ?`,
    args: [...filterArgs, input.limit, input.offset]
  });
  return { rows: (result.rows as unknown as Record<string, unknown>[]).map(mapAdminCustomer), total };
}

/** Record one admin action. Detail is a short plain string, never a secret. */
export async function recordAdminAction(input: {
  actorUserId: string;
  actorEmail: string;
  action: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  detail?: string | null;
}): Promise<void> {
  await client.execute({
    sql: `INSERT INTO admin_audit(id, actor_user_id, actor_email, action, target_user_id, target_email, detail, created_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      input.actorUserId,
      input.actorEmail,
      input.action,
      input.targetUserId ?? null,
      input.targetEmail ?? null,
      input.detail ?? null,
      Date.now()
    ]
  });
}

/** The most recent admin actions, newest first, for the dashboard's activity list. */
export async function listAdminAudit(limit: number): Promise<{
  actorEmail: string;
  action: string;
  targetEmail: string | null;
  detail: string | null;
  createdAtMs: number;
}[]> {
  const result = await client.execute({
    sql: `SELECT actor_email, action, target_email, detail, created_at_ms
          FROM admin_audit ORDER BY created_at_ms DESC LIMIT ?`,
    args: [limit]
  });
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    actorEmail: String(row.actor_email),
    action: String(row.action),
    targetEmail: row.target_email === null || row.target_email === undefined ? null : String(row.target_email),
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    createdAtMs: Number(row.created_at_ms)
  }));
}

// Card checkout orders ------------------------------------------------------

export type MpgsOrderRow = {
  orderId: string;
  userId: string;
  plan: "pro" | "ultra";
  interval: "month" | "year";
  amountCents: number;
  currency: string;
  sessionId: string | null;
  successIndicator: string | null;
  status: string;
  grantedAtMs: number | null;
  /** False when this order came from a shared test link and must grant nothing. */
  grantsPlan: boolean;
  createdAtMs: number;
};

function mapMpgsOrder(row: Record<string, unknown>): MpgsOrderRow {
  return {
    orderId: String(row.order_id),
    userId: String(row.user_id),
    plan: String(row.plan) as "pro" | "ultra",
    interval: String(row.interval) as "month" | "year",
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    successIndicator:
      row.success_indicator === null || row.success_indicator === undefined ? null : String(row.success_indicator),
    status: String(row.status),
    grantedAtMs: row.granted_at_ms === null || row.granted_at_ms === undefined ? null : Number(row.granted_at_ms),
    grantsPlan: Number(row.grants_plan ?? 1) === 1,
    createdAtMs: Number(row.created_at_ms)
  };
}

/** Record an intended purchase before the payer is sent to the gateway. */
export async function createMpgsOrder(input: {
  orderId: string;
  userId: string;
  plan: "pro" | "ultra";
  interval: "month" | "year";
  amountCents: number;
  currency: string;
  /** False for an order opened from a shared test link: verify, but grant nothing. */
  grantsPlan?: boolean;
}): Promise<void> {
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO mpgs_orders(order_id, user_id, plan, interval, amount_cents, currency,
            session_id, success_indicator, status, granted_at_ms, grants_plan, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'created', NULL, ?, ?, ?)`,
    args: [
      input.orderId, input.userId, input.plan, input.interval, input.amountCents, input.currency,
      input.grantsPlan === false ? 0 : 1, now, now
    ]
  });
}

/** Attach the gateway's session to an order once it has been opened. */
export async function attachMpgsSession(orderId: string, sessionId: string, successIndicator: string | null): Promise<void> {
  await client.execute({
    sql: "UPDATE mpgs_orders SET session_id = ?, success_indicator = ?, status = 'pending', updated_at_ms = ? WHERE order_id = ?",
    args: [sessionId, successIndicator, Date.now(), orderId]
  });
}

export async function getMpgsOrder(orderId: string): Promise<MpgsOrderRow | null> {
  const result = await client.execute({
    sql: "SELECT * FROM mpgs_orders WHERE order_id = ? LIMIT 1",
    args: [orderId]
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapMpgsOrder(row) : null;
}

export async function setMpgsOrderStatus(orderId: string, status: string, failureReason?: string): Promise<void> {
  await client.execute({
    sql: "UPDATE mpgs_orders SET status = ?, failure_reason = ?, updated_at_ms = ? WHERE order_id = ?",
    args: [status, failureReason ?? null, Date.now(), orderId]
  });
}

/**
 * The most recent card checkout attempts, for the dashboard. This exists because
 * a payment that fails at the gateway is otherwise invisible to the operator: the
 * generic 5xx message tells them nothing and the reason is buried in server logs
 * they have no reason to be reading.
 */
export async function listMpgsAttempts(limit: number): Promise<{
  orderId: string;
  plan: string;
  interval: string;
  amountCents: number;
  status: string;
  failureReason: string | null;
  createdAtMs: number;
}[]> {
  const result = await client.execute({
    sql: `SELECT order_id, plan, interval, amount_cents, status, failure_reason, created_at_ms
          FROM mpgs_orders ORDER BY created_at_ms DESC LIMIT ?`,
    args: [limit]
  });
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    orderId: String(row.order_id),
    plan: String(row.plan),
    interval: String(row.interval),
    amountCents: Number(row.amount_cents),
    status: String(row.status),
    failureReason:
      row.failure_reason === null || row.failure_reason === undefined ? null : String(row.failure_reason),
    createdAtMs: Number(row.created_at_ms)
  }));
}

/**
 * Claim the right to grant a plan for this order, exactly once.
 *
 * The UPDATE only matches while granted_at_ms IS NULL, and the database applies
 * that test and the write as one operation, so of two notifications arriving
 * together only one can come away with rowsAffected of 1. Whoever wins grants the
 * plan; everyone else is told it is already done. This is what stops a replayed
 * webhook, a refreshed return page, or a retry from stacking months onto an
 * account that paid once.
 */
export async function claimMpgsOrderGrant(orderId: string): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE mpgs_orders SET granted_at_ms = ?, status = 'paid', updated_at_ms = ? WHERE order_id = ? AND granted_at_ms IS NULL",
    args: [Date.now(), Date.now(), orderId]
  });
  return result.rowsAffected === 1;
}

// Shareable test links ------------------------------------------------------

export type MpgsTestLinkRow = {
  token: string;
  label: string;
  /** The admin who minted it: orders from this link are attributed to them. */
  createdBy: string;
  plan: "pro" | "ultra";
  interval: "month" | "year";
  uses: number;
  revoked: boolean;
  expiresAtMs: number;
  createdAtMs: number;
};

function mapTestLink(row: Record<string, unknown>): MpgsTestLinkRow {
  return {
    token: String(row.token),
    label: String(row.label),
    createdBy: String(row.created_by),
    plan: String(row.plan) as "pro" | "ultra",
    interval: String(row.interval) as "month" | "year",
    uses: Number(row.uses ?? 0),
    revoked: Number(row.revoked ?? 0) === 1,
    expiresAtMs: Number(row.expires_at_ms),
    createdAtMs: Number(row.created_at_ms)
  };
}

export async function createMpgsTestLink(input: {
  token: string;
  label: string;
  plan: "pro" | "ultra";
  interval: "month" | "year";
  createdBy: string;
  expiresAtMs: number;
}): Promise<void> {
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO mpgs_test_links(token, label, plan, interval, created_by, uses, revoked, expires_at_ms, created_at_ms)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    args: [input.token, input.label, input.plan, input.interval, input.createdBy, input.expiresAtMs, now]
  });
}

export async function getMpgsTestLink(token: string): Promise<MpgsTestLinkRow | null> {
  const result = await client.execute({ sql: "SELECT * FROM mpgs_test_links WHERE token = ? LIMIT 1", args: [token] });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? mapTestLink(row) : null;
}

export async function countMpgsTestLinkUse(token: string): Promise<void> {
  await client.execute({ sql: "UPDATE mpgs_test_links SET uses = uses + 1 WHERE token = ?", args: [token] });
}

export async function revokeMpgsTestLink(token: string): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE mpgs_test_links SET revoked = 1 WHERE token = ? AND revoked = 0",
    args: [token]
  });
  return result.rowsAffected === 1;
}

export async function listMpgsTestLinks(limit: number): Promise<MpgsTestLinkRow[]> {
  const result = await client.execute({
    sql: "SELECT * FROM mpgs_test_links ORDER BY created_at_ms DESC LIMIT ?",
    args: [limit]
  });
  return (result.rows as unknown as Record<string, unknown>[]).map(mapTestLink);
}

export { client };
