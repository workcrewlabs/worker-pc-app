import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { REFERRAL_BONUS_MICRODOLLARS } from "@workcrew/contracts";
import { creditReferralOnPayment, getBudgetUsage, getBudgetWindow } from "./budget.js";
import {
  client,
  countReferrals,
  createUser,
  ensureReferralCode,
  getUserById,
  getUserByReferralCode,
  initializeDatabase,
  upsertSubscription
} from "./db.js";

async function makeUser(referredByCode?: string | null) {
  const id = randomUUID();
  await createUser({ id, email: `${id}@test.local`, passwordHash: "h", passwordSalt: "s", emailVerified: true, referredByCode });
  const user = await getUserById(id);
  if (!user) throw new Error("user was not created");
  return user;
}

async function giveSubscription(userId: string, anchorMs: number) {
  await upsertSubscription({
    userId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    plan: "pro",
    interval: "month",
    status: "active",
    active: true,
    budgetAnchorMs: anchorMs,
    currentPeriodEndMs: anchorMs + 30 * 24 * 60 * 60 * 1000
  });
}

describe("referral program", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("assigns a unique, readable referral code at sign-up", async () => {
    const user = await makeUser();
    expect(user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    const found = await getUserByReferralCode(user.referralCode!);
    expect(found?.id).toBe(user.id);
  });

  it("records who referred a new user", async () => {
    const inviter = await makeUser();
    const friend = await makeUser(inviter.referralCode);
    expect(friend.referredByCode).toBe(inviter.referralCode);
  });

  it("grants the inviter a one-time credit when a referred user pays", async () => {
    const anchor = Date.now();
    const inviter = await makeUser();
    await giveSubscription(inviter.id, anchor);
    const friend = await makeUser(inviter.referralCode);

    expect(await creditReferralOnPayment(friend.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(true);

    // Lifetime tokens earned is tracked for display.
    expect((await getUserById(inviter.id))?.referralBonusMicrodollars).toBe(REFERRAL_BONUS_MICRODOLLARS);

    // The grant is a single negative-cost entry in the current window, so used
    // drops by exactly the bonus (freeing that many tokens, one time).
    const window = getBudgetWindow(anchor);
    const after = await getBudgetUsage(inviter.id, window);
    expect(after.used).toBe(-REFERRAL_BONUS_MICRODOLLARS);
  });

  it("never grants the credit twice for the same referred user", async () => {
    const anchor = Date.now();
    const inviter = await makeUser();
    await giveSubscription(inviter.id, anchor);
    const friend = await makeUser(inviter.referralCode);

    expect(await creditReferralOnPayment(friend.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(true);
    expect(await creditReferralOnPayment(friend.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(false);

    // Earned and the in-window credit both reflect a single grant, not two.
    expect((await getUserById(inviter.id))?.referralBonusMicrodollars).toBe(REFERRAL_BONUS_MICRODOLLARS);
    const used = (await getBudgetUsage(inviter.id, getBudgetWindow(anchor))).used;
    expect(used).toBe(-REFERRAL_BONUS_MICRODOLLARS);
  });

  it("does not grant anything when the user was not referred", async () => {
    const solo = await makeUser();
    expect(await creditReferralOnPayment(solo.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(false);
  });

  it("counts invited and subscribed referrals", async () => {
    const inviter = await makeUser();
    await giveSubscription(inviter.id, Date.now());
    const friend = await makeUser(inviter.referralCode);
    await creditReferralOnPayment(friend.id, REFERRAL_BONUS_MICRODOLLARS);

    const stats = await countReferrals(inviter.referralCode!);
    expect(stats.invited).toBeGreaterThanOrEqual(1);
    expect(stats.credited).toBeGreaterThanOrEqual(1);
  });

  it("returns the same code on repeated reads", async () => {
    const user = await makeUser();
    expect(await ensureReferralCode(user.id)).toBe(user.referralCode);
  });
});
