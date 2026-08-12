import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_LINK_TTL_MS, testLinksAllowed } from "./mpgs.js";
import {
  claimMpgsOrderGrant,
  client,
  createMpgsOrder,
  createMpgsTestLink,
  getMpgsOrder,
  getMpgsTestLink,
  initializeDatabase,
  revokeMpgsTestLink
} from "./db.js";

// A shareable link hands a stranger the ability to run a card payment with no
// account and no dashboard access, which is exactly what the bank's tester
// needs and exactly the sort of thing that must not be able to grant anyone a
// paid plan or outlive its usefulness.

describe("where shared links are allowed at all", () => {
  it("is refused unless the gateway is a test host", () => {
    // This deployment has no gateway configured, so the answer is no. The check
    // exists because a link anyone holding the URL can pay through has no place
    // pointed at production, and the bank issues a separate host for live.
    expect(testLinksAllowed()).toBe(false);
  });

  it("stays usable long enough for an email exchange", () => {
    expect(TEST_LINK_TTL_MS).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });
});

describe("a shared test link", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  async function makeLink(overrides: { expiresAtMs?: number } = {}) {
    const token = `tok-${randomUUID()}`;
    await createMpgsTestLink({
      token,
      label: "Bank of Beirut test",
      plan: "pro",
      interval: "month",
      createdBy: randomUUID(),
      expiresAtMs: overrides.expiresAtMs ?? Date.now() + TEST_LINK_TTL_MS
    });
    return token;
  }

  it("is stored with what it sells and who made it", async () => {
    const token = await makeLink();
    const link = await getMpgsTestLink(token);
    expect(link).toMatchObject({ label: "Bank of Beirut test", plan: "pro", interval: "month", revoked: false, uses: 0 });
  });

  it("can be revoked, and revoking is not repeatable", async () => {
    const token = await makeLink();
    expect(await revokeMpgsTestLink(token)).toBe(true);
    expect(await revokeMpgsTestLink(token)).toBe(false);
    expect((await getMpgsTestLink(token))?.revoked).toBe(true);
  });

  it("is unknown once it does not exist", async () => {
    expect(await getMpgsTestLink("tok-never-issued")).toBeNull();
  });

  it("produces orders that grant nothing, however they are settled", async () => {
    // The safety property that matters: even a fully paid order from a shared
    // link must leave every subscription untouched.
    const orderId = `wc-test-${randomUUID()}`;
    await createMpgsOrder({
      orderId,
      userId: randomUUID(),
      plan: "ultra",
      interval: "year",
      amountCents: 200_000,
      currency: "USD",
      grantsPlan: false
    });
    const order = await getMpgsOrder(orderId);
    expect(order?.grantsPlan).toBe(false);
  });

  it("keeps granting on for an ordinary customer checkout", async () => {
    const orderId = `wc-${randomUUID()}`;
    await createMpgsOrder({
      orderId, userId: randomUUID(), plan: "pro", interval: "month", amountCents: 2700, currency: "USD"
    });
    const order = await getMpgsOrder(orderId);
    expect(order?.grantsPlan).toBe(true);
    // And it still grants exactly once.
    expect(await claimMpgsOrderGrant(orderId)).toBe(true);
    expect(await claimMpgsOrderGrant(orderId)).toBe(false);
  });
});
