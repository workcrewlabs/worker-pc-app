import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { REFERRAL_BONUS_MICRODOLLARS } from "@workcrew/contracts";
import {
  client,
  countReferrals,
  createUser,
  creditReferrer,
  ensureReferralCode,
  getSubscription,
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

  it("credits the inviter exactly once when a referred user pays", async () => {
    const inviter = await makeUser();
    const friend = await makeUser(inviter.referralCode);

    expect(await creditReferrer(friend.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(true);
    expect((await getUserById(inviter.id))?.referralBonusMicrodollars).toBe(REFERRAL_BONUS_MICRODOLLARS);

    // A second activation event for the same friend must not double-credit.
    expect(await creditReferrer(friend.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(false);
    expect((await getUserById(inviter.id))?.referralBonusMicrodollars).toBe(REFERRAL_BONUS_MICRODOLLARS);

    const stats = await countReferrals(inviter.referralCode!);
    expect(stats.invited).toBeGreaterThanOrEqual(1);
    expect(stats.credited).toBeGreaterThanOrEqual(1);
  });

  it("does not credit when the user was not referred", async () => {
    const solo = await makeUser();
    expect(await creditReferrer(solo.id, REFERRAL_BONUS_MICRODOLLARS)).toBe(false);
  });

  it("adds the earned bonus to the inviter's subscription budget", async () => {
    const inviter = await makeUser();
    const friend = await makeUser(inviter.referralCode);
    await creditReferrer(friend.id, REFERRAL_BONUS_MICRODOLLARS);

    await upsertSubscription({
      userId: inviter.id,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: "pro",
      interval: "month",
      status: "active",
      active: true,
      budgetAnchorMs: Date.now(),
      currentPeriodEndMs: Date.now() + 1_000_000
    });

    const subscription = await getSubscription(inviter.id);
    expect(subscription?.referralBonusMicrodollars).toBe(REFERRAL_BONUS_MICRODOLLARS);
  });

  it("returns the same code on repeated reads", async () => {
    const user = await makeUser();
    expect(await ensureReferralCode(user.id)).toBe(user.referralCode);
  });
});
