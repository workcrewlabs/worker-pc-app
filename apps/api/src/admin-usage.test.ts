import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminGrantAccess, type AdminActor } from "./admin.js";
import { adminListCustomers } from "./admin.js";
import { budgetWindowFor, getBudgetUsage, planBudget } from "./budget.js";
import { createPasswordCredential } from "./auth-local.js";
import { client, createUser, getSubscription, initializeDatabase, upsertSubscription } from "./db.js";

// The dashboard sells access by hand, so the operator needs the other half of
// that trade on the same row: what an account costs to serve against what it is
// allowed to spend. These pin that the figure is the SAME one the product holds
// the customer to, because a dashboard that quietly measures spend its own way
// is worse than no dashboard at all.

const actor: AdminActor = { userId: randomUUID(), email: "owner@example.com" };

async function makeUser(): Promise<{ userId: string; email: string }> {
  const userId = randomUUID();
  const email = `usage-${userId}@example.com`;
  const { passwordHash, passwordSalt } = await createPasswordCredential("a-long-enough-password");
  await createUser({ id: userId, email, passwordHash, passwordSalt, emailVerified: true });
  return { userId, email };
}

/** Put one row in the ledger inside the user's current budget window. */
async function spend(
  userId: string,
  amounts: { settled?: number; reserved?: number }
): Promise<void> {
  const subscription = await getSubscription(userId);
  if (!subscription) throw new Error("no subscription to spend against");
  const window = budgetWindowFor(subscription);
  const settled = amounts.settled ?? 0;
  const reserved = amounts.reserved ?? 0;
  await client.execute({
    sql: `INSERT INTO usage_ledger(
        id, user_id, run_id, period_start_ms, period_end_ms, model,
        reserved_microdollars, actual_microdollars, status, created_at_ms
      ) VALUES (?, ?, 'run', ?, ?, 'haiku', ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      userId,
      window.startMs,
      window.endMs,
      reserved,
      settled,
      reserved > 0 ? "reserved" : "settled",
      Date.now()
    ]
  });
}

async function rowFor(email: string) {
  const { customers } = await adminListCustomers({ search: email });
  const row = customers.find((customer) => customer.email === email);
  if (!row) throw new Error(`no row for ${email}`);
  return row;
}

describe("what each account has spent of its monthly allowance", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("reports the spend and the cap for a paying account", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    await spend(userId, { settled: 12_000_000 });

    const row = await rowFor(email);
    expect(row.monthlySpentMicrodollars).toBe(12_000_000);
    expect(row.monthlyLimitMicrodollars).toBe(planBudget("pro"));
    expect(row.monthlyPercent).toBe(25);
  });

  it("counts money held for a run in flight, not only money already charged", async () => {
    // This is what reserveBudget measures the cap against. Showing settled only
    // would read low mid-run and disagree with the wall the customer just hit.
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    await spend(userId, { settled: 1_000_000 });
    await spend(userId, { reserved: 2_000_000 });

    expect((await rowFor(email)).monthlySpentMicrodollars).toBe(3_000_000);
  });

  it("never disagrees with the figure the customer is actually held to", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "ultra", 1);
    await spend(userId, { settled: 7_500_000 });
    await spend(userId, { reserved: 500_000 });

    const subscription = await getSubscription(userId);
    const enforced = await getBudgetUsage(userId, budgetWindowFor(subscription!));
    expect((await rowFor(email)).monthlySpentMicrodollars).toBe(enforced.used + enforced.reserved);
  });

  it("measures a free account against the free allowance", async () => {
    const { userId, email } = await makeUser();
    await upsertSubscription({
      userId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: "free",
      interval: "month",
      status: "free",
      active: true,
      budgetAnchorMs: Date.now(),
      currentPeriodEndMs: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000
    });
    await spend(userId, { settled: 600_000 });

    const row = await rowFor(email);
    expect(row.monthlyLimitMicrodollars).toBe(planBudget("free"));
    expect(row.monthlyPercent).toBe(50);
  });

  it("shows nothing rather than zero for an account with no plan at all", async () => {
    // A bar sitting at 0% reads as "they have spent nothing", which is a claim.
    // No subscription row means there is no allowance to be a share of.
    const { email } = await makeUser();
    const row = await rowFor(email);
    expect(row.monthlyPercent).toBeNull();
    expect(row.monthlyLimitMicrodollars).toBe(0);
  });

  it("does not report a negative spend when credits outweigh usage", async () => {
    // Referral credits are written as negative settled rows.
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    await spend(userId, { settled: 100_000 });
    await spend(userId, { settled: -900_000 });

    expect((await rowFor(email)).monthlySpentMicrodollars).toBe(0);
  });

  it("ignores spend from a period that has already rolled over", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    const subscription = await getSubscription(userId);
    const window = budgetWindowFor(subscription!);
    await client.execute({
      sql: `INSERT INTO usage_ledger(
          id, user_id, run_id, period_start_ms, period_end_ms, model,
          reserved_microdollars, actual_microdollars, status, created_at_ms
        ) VALUES (?, ?, 'run', ?, ?, 'haiku', 0, ?, 'settled', ?)`,
      args: [randomUUID(), userId, window.startMs - 1, window.startMs, 9_000_000, Date.now()]
    });

    expect((await rowFor(email)).monthlySpentMicrodollars).toBe(0);
  });

  it("caps the share at 100 so a full month cannot draw a bar off the end", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    await spend(userId, { settled: planBudget("pro") * 2 });

    expect((await rowFor(email)).monthlyPercent).toBe(100);
  });
});
