import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { client, deleteAccount, initializeDatabase, upsertSubscription } from "./db.js";

const now = 1_700_000_000_000;

// Seed one row in every user-owned table so the deletion can be checked end to end.
async function seedUser(userId: string): Promise<void> {
  await client.execute({
    sql: "INSERT INTO users(id, email, email_verified, password_hash, password_salt, created_at_ms) VALUES (?, ?, 0, 'h', 's', ?)",
    args: [userId, `${userId}@example.com`, now]
  });
  await upsertSubscription({
    userId, stripeCustomerId: null, stripeSubscriptionId: null, plan: "pro", interval: "month",
    status: "active", active: true, budgetAnchorMs: now, currentPeriodEndMs: now + 1000
  });
  const sessionId = randomUUID();
  await client.execute({
    sql: "INSERT INTO sessions(id, user_id, created_at_ms, last_seen_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
    args: [sessionId, userId, now, now, now + 1000]
  });
  await client.execute({
    sql: "INSERT INTO refresh_tokens(id, session_id, token_hash, created_at_ms) VALUES (?, ?, ?, ?)",
    args: [randomUUID(), sessionId, randomUUID(), now]
  });
  const conversationId = randomUUID();
  await client.execute({
    sql: "INSERT INTO conversations(id, user_id, project_id, title, model, created_at_ms, updated_at_ms) VALUES (?, ?, NULL, 't', 'haiku', ?, ?)",
    args: [conversationId, userId, now, now]
  });
  await client.execute({
    sql: "INSERT INTO messages(id, conversation_id, role, content_json, created_at_ms) VALUES (?, ?, 'user', '[]', ?)",
    args: [randomUUID(), conversationId, now]
  });
  await client.execute({
    sql: "INSERT INTO runs(id, user_id, model, status, messages_json, created_at_ms, updated_at_ms) VALUES (?, ?, 'haiku', 'complete', '[]', ?, ?)",
    args: [randomUUID(), userId, now, now]
  });
  await client.execute({
    sql: "INSERT INTO usage_ledger(id, user_id, run_id, period_start_ms, period_end_ms, model, reserved_microdollars, actual_microdollars, status, created_at_ms) VALUES (?, ?, 'r', 0, 1, 'haiku', 0, 100, 'settled', ?)",
    args: [randomUUID(), userId, now]
  });
  await client.execute({
    sql: "INSERT INTO attachments(id, user_id, conversation_id, filename, mime_type, size_bytes, kind, media_type, created_at_ms) VALUES (?, ?, ?, 'f', 'text/plain', 1, 'text', 'text/plain', ?)",
    args: [randomUUID(), userId, conversationId, now]
  });
  await client.execute({
    sql: "INSERT INTO email_tokens(id, user_id, email, purpose, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, 'verify', ?, ?, ?)",
    args: [randomUUID(), userId, `${userId}@example.com`, randomUUID(), now + 1000, now]
  });
}

const TABLES: Record<string, string> = {
  users: "SELECT COUNT(*) AS c FROM users WHERE id = ?",
  subscriptions: "SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = ?",
  sessions: "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?",
  conversations: "SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?",
  runs: "SELECT COUNT(*) AS c FROM runs WHERE user_id = ?",
  usage_ledger: "SELECT COUNT(*) AS c FROM usage_ledger WHERE user_id = ?",
  attachments: "SELECT COUNT(*) AS c FROM attachments WHERE user_id = ?",
  email_tokens: "SELECT COUNT(*) AS c FROM email_tokens WHERE user_id = ?",
  refresh_tokens: "SELECT COUNT(*) AS c FROM refresh_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)",
  messages: "SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)"
};

async function totalRows(userId: string): Promise<number> {
  let total = 0;
  for (const sql of Object.values(TABLES)) {
    const result = await client.execute({ sql, args: [userId] });
    total += Number(result.rows[0]?.c ?? 0);
  }
  return total;
}

describe("deleteAccount", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("removes every row the user owns and leaves other users untouched", async () => {
    const victim = randomUUID();
    const bystander = randomUUID();
    await seedUser(victim);
    await seedUser(bystander);

    // Both users have data across all ten tables before deletion (one row each).
    expect(await totalRows(victim)).toBe(10);
    expect(await totalRows(bystander)).toBe(10);

    await deleteAccount(victim);

    // The deleted user has nothing left anywhere; the other user is fully intact.
    expect(await totalRows(victim)).toBe(0);
    expect(await totalRows(bystander)).toBe(10);
  });
});
