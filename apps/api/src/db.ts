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
  /** Number of model planning steps consumed by this run, capped server side. */
  stepCount: number;
  /** Normalized signature of the previous assistant action, for loop detection. */
  lastActionSignature: string | null;
  /** Number of consecutive identical actions seen so far (1 means seen once). */
  repeatCount: number;
};

const client = createClient({
  url: config.dataUrl,
  authToken: config.dataAuthToken
});

/**
 * Ask SQLite to wait when the database is momentarily locked instead of failing
 * immediately with SQLITE_BUSY. A single file database can have only one writer
 * at a time, so concurrent writers (for example separate test workers or two
 * in-flight requests) need to queue briefly rather than error out. This is a
 * no-op for remote libsql endpoints.
 */
async function setBusyTimeout(db: Client): Promise<void> {
  try {
    await db.execute("PRAGMA busy_timeout = 5000");
  } catch {
    // Remote libsql endpoints may not accept PRAGMA; ignore in that case.
  }
}

export async function initializeDatabase(db: Client = client): Promise<void> {
  await setBusyTimeout(db);
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
      step_count INTEGER NOT NULL DEFAULT 0,
      last_action_signature TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, updated_at_ms DESC)`,
    `CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL
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
      created_at_ms INTEGER NOT NULL
    )`,
    // A login session. Refresh tokens hang off a session so that a single reuse
    // can revoke the whole session at once.
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    // Single-use rotating refresh tokens. Only the hash of the opaque token is
    // stored. used_at_ms marks a token as already consumed, and replaced_by
    // points at the token it was rotated into.
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      used_at_ms INTEGER,
      replaced_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_refresh_session ON refresh_tokens(session_id)`
  ], "write");

  // Migrate databases created before the run safety columns existed. SQLite
  // has no ADD COLUMN IF NOT EXISTS, so each ALTER is attempted and a duplicate
  // column error is treated as already migrated. workcrew.db is gitignored and
  // rebuilt by this function, so this only matters for long lived local files.
  await addColumnIfMissing(db, "runs", "step_count", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(db, "runs", "last_action_signature", "TEXT");
  await addColumnIfMissing(db, "runs", "repeat_count", "INTEGER NOT NULL DEFAULT 0");
}

async function addColumnIfMissing(db: Client, table: string, column: string, definition: string): Promise<void> {
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    // A duplicate column name means the migration already ran. Anything else is
    // a real failure and must surface.
    if (!message.includes("duplicate column")) throw error;
  }
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
    sql: `INSERT INTO runs(
        id, user_id, model, status, messages_json, pending_tool_use_id,
        step_count, last_action_signature, repeat_count, created_at_ms, updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      run.userId,
      run.model,
      run.status,
      JSON.stringify(run.messages),
      run.pendingToolUseId,
      run.stepCount,
      run.lastActionSignature,
      run.repeatCount,
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
    status: String(row.status),
    messages: JSON.parse(String(row.messages_json)) as unknown[],
    pendingToolUseId: row.pending_tool_use_id ? String(row.pending_tool_use_id) : null,
    stepCount: asNumber(row.step_count),
    lastActionSignature: row.last_action_signature ? String(row.last_action_signature) : null,
    repeatCount: asNumber(row.repeat_count)
  };
}

export async function updateRun(run: RunRow): Promise<void> {
  await client.execute({
    sql: `UPDATE runs SET
        model = ?, status = ?, messages_json = ?, pending_tool_use_id = ?,
        step_count = ?, last_action_signature = ?, repeat_count = ?, updated_at_ms = ?
      WHERE id = ? AND user_id = ?`,
    args: [
      run.model,
      run.status,
      JSON.stringify(run.messages),
      run.pendingToolUseId,
      run.stepCount,
      run.lastActionSignature,
      run.repeatCount,
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
}): Promise<void> {
  await client.execute({
    sql: `INSERT INTO users(id, email, email_verified, password_hash, password_salt, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.email,
      input.emailVerified ? 1 : 0,
      input.passwordHash,
      input.passwordSalt,
      Date.now()
    ]
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

export { client };
