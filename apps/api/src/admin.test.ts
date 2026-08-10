import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addMonths,
  adminCreateCustomer,
  adminGrantAccess,
  adminRevokeAccess,
  adminSetPassword,
  type AdminActor
} from "./admin.js";
import { client, createUser, getSubscription, getUserByEmail, getUserById, initializeDatabase, listAdminAudit, upsertSubscription } from "./db.js";
import { createPasswordCredential } from "./auth-local.js";

// The admin dashboard sells access by hand, so these tests pin the rules that
// decide whether someone can use the product and for how long: time stacks
// instead of being overwritten, extending never hands out a second monthly
// allowance, revoking leaves the account intact on the free plan, and every
// action lands in the audit trail. They run the real SQL against fresh users.

const actor: AdminActor = { userId: randomUUID(), email: "owner@example.com" };

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeUser(): Promise<{ userId: string; email: string }> {
  const userId = randomUUID();
  const email = `member-${userId}@example.com`;
  const { passwordHash, passwordSalt } = await createPasswordCredential("a-long-enough-password");
  await createUser({ id: userId, email, passwordHash, passwordSalt, emailVerified: true });
  return { userId, email };
}

describe("addMonths", () => {
  it("adds whole calendar months", () => {
    const from = new Date("2026-01-10T12:00:00Z").getTime();
    expect(new Date(addMonths(from, 1)).getUTCMonth()).toBe(1);
    expect(new Date(addMonths(from, 3)).getUTCMonth()).toBe(3);
  });

  it("clamps a day that does not exist in the target month", () => {
    // 31 January plus one month must land in February, never skip to March.
    const from = new Date(2026, 0, 31, 12, 0, 0).getTime();
    const result = new Date(addMonths(from, 1));
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });
});

describe("admin access control", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("grants paid access that expires on its own", async () => {
    const { userId } = await makeUser();
    const before = Date.now();
    const { currentPeriodEndMs } = await adminGrantAccess(actor, userId, "pro", 1);

    const subscription = await getSubscription(userId);
    expect(subscription?.plan).toBe("pro");
    expect(subscription?.active).toBe(true);
    // The same status the Stripe path writes, so every entitlement guard treats
    // a hand-sold account exactly like a card-paid one.
    expect(subscription?.status).toBe("active");
    expect(subscription?.stripeSubscriptionId).toBeNull();
    expect(currentPeriodEndMs).toBeGreaterThan(before + 27 * DAY_MS);
    expect(currentPeriodEndMs).toBeLessThan(before + 32 * DAY_MS);
  });

  it("stacks a second month on top of remaining time instead of overwriting it", async () => {
    const { userId } = await makeUser();
    const first = await adminGrantAccess(actor, userId, "pro", 1);
    const second = await adminGrantAccess(actor, userId, "pro", 1);
    expect(second.currentPeriodEndMs).toBeGreaterThan(first.currentPeriodEndMs + 27 * DAY_MS);
  });

  it("keeps the budget anchor when extending, so no extra allowance is handed out", async () => {
    const { userId } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    const anchor = (await getSubscription(userId))?.budgetAnchorMs;
    await adminGrantAccess(actor, userId, "ultra", 1);
    expect((await getSubscription(userId))?.budgetAnchorMs).toBe(anchor);
  });

  it("restarts the budget window for a customer whose access had lapsed", async () => {
    const { userId } = await makeUser();
    const staleAnchor = Date.now() - 400 * DAY_MS;
    await upsertSubscription({
      userId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: "pro",
      interval: "month",
      status: "active",
      active: true,
      budgetAnchorMs: staleAnchor,
      // Already expired: the guard treats this as no access.
      currentPeriodEndMs: Date.now() - DAY_MS
    });
    await adminGrantAccess(actor, userId, "pro", 1);
    const subscription = await getSubscription(userId);
    expect(subscription?.budgetAnchorMs).toBeGreaterThan(staleAnchor);
    expect(subscription?.currentPeriodEndMs).toBeGreaterThan(Date.now());
  });

  it("revokes to the free plan without deleting the account", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "ultra", 2);
    await adminRevokeAccess(actor, userId);

    const subscription = await getSubscription(userId);
    expect(subscription?.plan).toBe("free");
    expect(subscription?.status).toBe("free");
    // The free tier is a usable plan, so the row stays active; the small free
    // allowance is what limits them now.
    expect(subscription?.active).toBe(true);
    // The account itself survives, so paying again is one action away.
    expect((await getUserById(userId))?.email).toBe(email);
  });

  it("creates a customer who can sign in immediately, with access already on", async () => {
    const email = `cash-${randomUUID()}@example.com`;
    const created = await adminCreateCustomer(actor, {
      email: email.toUpperCase(),
      password: "cash-customer-password",
      plan: "pro",
      months: 1
    });
    // Email is normalized, so a capitalised address cannot create a second row.
    expect(created.email).toBe(email.toLowerCase());
    const user = await getUserByEmail(email.toLowerCase());
    expect(user?.emailVerified).toBe(true);
    expect((await getSubscription(created.userId))?.active).toBe(true);
  });

  it("refuses to create a second account for an existing email", async () => {
    const { email } = await makeUser();
    await expect(
      adminCreateCustomer(actor, { email, password: "another-long-password", plan: "pro", months: 1 })
    ).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
  });

  it("rejects input outside the allowed bounds", async () => {
    const { userId } = await makeUser();
    // Months is bounded even when called directly (0 would grant access that has
    // already expired), a password must meet the sign-up policy, and unknown
    // fields are rejected outright.
    await expect(adminGrantAccess(actor, userId, "pro", 0)).rejects.toBeTruthy();
    await expect(adminGrantAccess(actor, userId, "pro", 999)).rejects.toBeTruthy();
    await expect(adminSetPassword(actor, userId, { password: "short" })).rejects.toBeTruthy();
    await expect(
      adminCreateCustomer(actor, { email: "x@example.com", password: "a-long-enough-password", plan: "pro", months: 99 })
    ).rejects.toBeTruthy();
    await expect(
      adminCreateCustomer(actor, { email: "x@example.com", password: "a-long-enough-password", plan: "pro", months: 1, isAdmin: true })
    ).rejects.toBeTruthy();
  });

  it("records every action in the audit trail", async () => {
    const { userId, email } = await makeUser();
    await adminGrantAccess(actor, userId, "pro", 1);
    await adminRevokeAccess(actor, userId);

    const audit = await listAdminAudit(50);
    const mine = audit.filter((entry) => entry.targetEmail === email);
    expect(mine.map((entry) => entry.action)).toEqual(expect.arrayContaining(["grant_access", "revoke_access"]));
    expect(mine.every((entry) => entry.actorEmail === actor.email)).toBe(true);
    // The trail must never carry a credential, only what happened.
    expect(mine.every((entry) => !/password[^ ]*=|secret/i.test(entry.detail ?? ""))).toBe(true);
  });

  it("sets a password that replaces the old one", async () => {
    const { userId } = await makeUser();
    const before = await getUserById(userId);
    await adminSetPassword(actor, userId, { password: "a-brand-new-password" });
    const after = await getUserById(userId);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordSalt).not.toBe(before?.passwordSalt);
  });

  it("refuses to act on a customer that does not exist", async () => {
    await expect(adminGrantAccess(actor, randomUUID(), "pro", 1)).rejects.toMatchObject({ statusCode: 404 });
    await expect(adminRevokeAccess(actor, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
  });
});
