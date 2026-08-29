import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { budgetHeadroom, budgetWindowFor, planBudget, reserveBudget } from "./budget.js";
import {
  client,
  expireLapsedPaidToFree,
  getSubscription,
  initializeDatabase,
  upsertSubscription
} from "./db.js";

// A paid plan does not change when its month runs out; the row just goes stale
// with a date in the past, and every guard reads it as inactive. So a customer
// who did not renew was locked out of an app they were still entitled to use on
// the free tier, staring at a dead end. Lapsing by time now lands them exactly
// where revoking by hand lands them: on the free plan, still able to work.

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

async function subscribe(plan: "pro" | "ultra" | "free", endsInMs: number): Promise<string> {
  const userId = randomUUID();
  await upsertSubscription({
    userId,
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: `sub_${userId}`,
    plan,
    interval: "month",
    status: plan === "free" ? "free" : "active",
    active: true,
    budgetAnchorMs: Date.now() - MONTH_MS,
    currentPeriodEndMs: Date.now() + endsInMs
  });
  return userId;
}

describe("a paid plan that ran out", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("drops onto the free plan instead of locking the person out", async () => {
    const userId = await subscribe("pro", -MONTH_MS);
    expect(await expireLapsedPaidToFree(userId)).toBe(true);

    const after = await getSubscription(userId);
    expect(after?.plan).toBe("free");
    expect(after?.status).toBe("free");
    // Active on purpose: the free tier is a real usable plan, and it is the
    // small allowance that limits it, not a dead flag.
    expect(after?.active).toBe(true);
    expect(after?.currentPeriodEndMs).toBeGreaterThan(Date.now());
  });

  it("leaves them able to actually run something", async () => {
    const userId = await subscribe("pro", -MONTH_MS);
    await expireLapsedPaidToFree(userId);
    const subscription = await getSubscription(userId);

    const headroom = await budgetHeadroom(userId, subscription!);
    expect(headroom.monthly).toBe(planBudget("free"));
    // The real test of "not locked out": a turn can be reserved.
    const reservation = await reserveBudget({
      subscription: subscription!,
      runId: randomUUID(),
      model: "haiku",
      amountMicrodollars: 1_000
    });
    expect(reservation.reservedMicrodollars).toBeGreaterThan(0);
  });

  it("clears the card details, so a future payment claims the account cleanly", async () => {
    const userId = await subscribe("ultra", -1);
    await expireLapsedPaidToFree(userId);
    const after = await getSubscription(userId);
    expect(after?.stripeSubscriptionId).toBeNull();
    expect(after?.stripeCustomerId).toBeNull();
  });

  it("never touches somebody who is still paying", async () => {
    const userId = await subscribe("pro", MONTH_MS);
    expect(await expireLapsedPaidToFree(userId)).toBe(false);
    expect((await getSubscription(userId))?.plan).toBe("pro");
  });

  it("never touches an account already on the free plan", async () => {
    const userId = await subscribe("free", 100 * 365 * 24 * 60 * 60 * 1000);
    expect(await expireLapsedPaidToFree(userId)).toBe(false);
  });

  it("changes nothing the second time it runs", async () => {
    const userId = await subscribe("pro", -MONTH_MS);
    expect(await expireLapsedPaidToFree(userId)).toBe(true);
    const first = await getSubscription(userId);
    expect(await expireLapsedPaidToFree(userId)).toBe(false);
    expect((await getSubscription(userId))?.currentPeriodEndMs).toBe(first?.currentPeriodEndMs);
  });

  it("does not hand out a fresh allowance for letting a plan lapse", async () => {
    // The anchor is what decides when the allowance renews. Resetting it would
    // make lapsing on purpose a way to mint tokens on demand.
    const userId = await subscribe("pro", -MONTH_MS);
    const before = await getSubscription(userId);
    await expireLapsedPaidToFree(userId);
    const after = await getSubscription(userId);
    expect(after?.budgetAnchorMs).toBe(before?.budgetAnchorMs);
  });

  it("drops any scheduled plan change, which can no longer happen", async () => {
    const userId = await subscribe("pro", -MONTH_MS);
    await client.execute({
      sql: "UPDATE subscriptions SET pending_plan = 'ultra', pending_interval = 'month', pending_effective_ms = ? WHERE user_id = ?",
      args: [Date.now() + MONTH_MS, userId]
    });
    await expireLapsedPaidToFree(userId);
    const after = await getSubscription(userId);
    expect(after?.pendingPlan).toBeNull();
  });

  it("puts the free plan's own budget window in place", async () => {
    const userId = await subscribe("pro", -MONTH_MS);
    await expireLapsedPaidToFree(userId);
    const subscription = await getSubscription(userId);
    const window = budgetWindowFor(subscription!);
    // The free window runs from the anchor for a century, so the spend recorded
    // against their old monthly pro windows does not follow them onto free.
    expect(window.startMs).toBe(subscription!.budgetAnchorMs);
    expect(window.endMs).toBeGreaterThan(Date.now() + 50 * 365 * 24 * 60 * 60 * 1000);
  });
});
