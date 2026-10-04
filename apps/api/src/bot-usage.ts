import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MODEL_PRICES, type ConcreteModelTier } from "./model-registry.js";
import { client } from "./db.js";
import type { DatabaseClient } from "./database/driver.js";

// What each WhatsApp chatbot costs to run, per bot and per month.
//
// These bots are not WorkCrew accounts. They are n8n workflows that call the AI
// providers directly, so nothing about them passes through this backend and the
// usage ledger knows nothing of them. The providers bill one key for all of
// them together, which is exactly the thing that makes a provider dashboard
// useless here: it cannot say which customer spent what. So each bot reports
// its own token counts, and this module prices and totals them.
//
// Deliberately NOT trusting the reported cost. A bot sends token counts and the
// model it used; the price is applied here from the same table the rest of the
// backend uses. A bot that lied about its cost, or an old workflow using a
// stale price, could otherwise quietly distort what a customer is billed.

/** Models a bot may report. Anything else is refused, so a typo cannot land as
 * free usage, and the price always comes from a model we actually know. */
export const BOT_MODELS: readonly ConcreteModelTier[] = ["glm", "glm-flash", "minimax", "haiku", "sonnet", "opus"];

export type BotRow = {
  id: string;
  name: string;
  customer: string;
  active: boolean;
  createdAtMs: number;
};

export type BotUsageSummary = {
  id: string;
  name: string;
  customer: string;
  active: boolean;
  /** Spend inside the current calendar month, in microdollars. */
  monthMicrodollars: number;
  monthInputTokens: number;
  monthOutputTokens: number;
  monthMessages: number;
  /** Spend across every month on record, so a long-running bot can be judged. */
  totalMicrodollars: number;
  lastSeenMs: number | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** First millisecond of the calendar month containing nowMs, in UTC. Month
 * boundaries are UTC so a report never lands in two different months depending
 * on where the server happens to be running. */
export function monthStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** What a bot's reported tokens cost, in microdollars. The prices are per
 * million tokens expressed as microdollars per token, which is the same unit
 * the rest of the backend bills in. */
export function botCostMicrodollars(model: ConcreteModelTier, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICES[model];
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}

export async function initializeBotUsage(db: DatabaseClient = client): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      customer TEXT NOT NULL DEFAULT '',
      token_sha256 TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at_ms BIGINT NOT NULL
    )`,
    // One row per AI call a bot makes. Kept as events rather than a running
    // total so a month can be recomputed, and so a wrong price can be corrected
    // after the fact instead of being baked into a counter.
    `CREATE TABLE IF NOT EXISTS bot_usage (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens BIGINT NOT NULL,
      output_tokens BIGINT NOT NULL,
      cost_microdollars BIGINT NOT NULL,
      created_at_ms BIGINT NOT NULL,
      dedupe_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bot_usage_bot_time ON bot_usage(bot_id, created_at_ms)`,
    // A retrying workflow must not double-count. Both Postgres and SQLite allow
    // many NULLs in a unique index, so a report with no dedupe id is still fine.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_usage_dedupe ON bot_usage(dedupe_id)`
  ]);
}

/** Register a bot and return its reporting token ONCE. Only the hash is stored,
 * so the token cannot be read back out of the database later: if it is lost,
 * the bot gets a new one. */
export async function createBot(
  name: string,
  customer: string,
  nowMs = Date.now(),
  db: DatabaseClient = client
): Promise<{ bot: BotRow; token: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await db.execute({
    sql: `INSERT INTO bots(id, name, customer, token_sha256, active, created_at_ms)
          VALUES (?, ?, ?, ?, 1, ?)`,
    args: [id, name, customer, hashToken(token), nowMs]
  });
  return { bot: { id, name, customer, active: true, createdAtMs: nowMs }, token };
}

/** The bot a reporting token belongs to, or null. A disabled bot resolves to
 * null, so turning a bot off stops its reports without deleting its history. */
export async function botForToken(token: string, db: DatabaseClient = client): Promise<BotRow | null> {
  if (!token) return null;
  const result = await db.execute({
    sql: "SELECT id, name, customer, active, created_at_ms FROM bots WHERE token_sha256 = ?",
    args: [hashToken(token)]
  });
  const row = result.rows[0];
  if (!row) return null;
  const active = asNumber(row.active) === 1;
  if (!active) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    customer: String(row.customer ?? ""),
    active,
    createdAtMs: asNumber(row.created_at_ms)
  };
}

export async function setBotActive(id: string, active: boolean, db: DatabaseClient = client): Promise<boolean> {
  const result = await db.execute({
    sql: "UPDATE bots SET active = ? WHERE id = ?",
    args: [active ? 1 : 0, id]
  });
  return result.rowsAffected > 0;
}

/** Record one AI call. Returns the cost it was priced at, so the caller can
 * report it back without recomputing. A repeated dedupeId is ignored rather
 * than counted twice, which is what makes an n8n retry safe. */
export async function recordBotUsage(
  input: {
    botId: string;
    model: ConcreteModelTier;
    inputTokens: number;
    outputTokens: number;
    dedupeId?: string | null;
  },
  nowMs = Date.now(),
  db: DatabaseClient = client
): Promise<{ costMicrodollars: number }> {
  const cost = botCostMicrodollars(input.model, input.inputTokens, input.outputTokens);
  await db.execute({
    sql: `INSERT INTO bot_usage(id, bot_id, model, input_tokens, output_tokens, cost_microdollars, created_at_ms, dedupe_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dedupe_id) DO NOTHING`,
    args: [
      randomUUID(),
      input.botId,
      input.model,
      input.inputTokens,
      input.outputTokens,
      cost,
      nowMs,
      input.dedupeId ?? null
    ]
  });
  return { costMicrodollars: cost };
}

/** Every bot with its spend this month, newest activity first. Bots that have
 * never reported still appear, with zeros, so a freshly added bot is visibly
 * registered rather than missing. */
export async function botUsageSummary(nowMs = Date.now(), db: DatabaseClient = client): Promise<BotUsageSummary[]> {
  const since = monthStartMs(nowMs);
  const result = await db.execute({
    sql: `SELECT
            b.id, b.name, b.customer, b.active, b.created_at_ms,
            COALESCE(SUM(CASE WHEN u.created_at_ms >= ? THEN u.cost_microdollars ELSE 0 END), 0) AS month_cost,
            COALESCE(SUM(CASE WHEN u.created_at_ms >= ? THEN u.input_tokens ELSE 0 END), 0) AS month_input,
            COALESCE(SUM(CASE WHEN u.created_at_ms >= ? THEN u.output_tokens ELSE 0 END), 0) AS month_output,
            COALESCE(SUM(CASE WHEN u.created_at_ms >= ? THEN 1 ELSE 0 END), 0) AS month_messages,
            COALESCE(SUM(u.cost_microdollars), 0) AS total_cost,
            MAX(u.created_at_ms) AS last_seen
          FROM bots b
          LEFT JOIN bot_usage u ON u.bot_id = b.id
          GROUP BY b.id, b.name, b.customer, b.active, b.created_at_ms
          ORDER BY month_cost DESC, b.created_at_ms DESC`,
    args: [since, since, since, since]
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    customer: String(row.customer ?? ""),
    active: asNumber(row.active) === 1,
    monthMicrodollars: asNumber(row.month_cost),
    monthInputTokens: asNumber(row.month_input),
    monthOutputTokens: asNumber(row.month_output),
    monthMessages: asNumber(row.month_messages),
    totalMicrodollars: asNumber(row.total_cost),
    lastSeenMs: row.last_seen == null ? null : asNumber(row.last_seen)
  }));
}
