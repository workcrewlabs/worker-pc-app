import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { actualCostMicrodollars, budgetLimitedOutputTokens, chooseModel, maximumReservationMicrodollars } from "./anthropic.js";
import { budgetHeadroom, getBudgetUsage, getBudgetWindow, releaseBudget, reserveBudget, rollingUsage, settleBudget } from "./budget.js";
import { client, initializeDatabase, type SubscriptionRow } from "./db.js";

describe("monthly allowance windows", () => {
  it("creates monthly windows for annual subscriptions", () => {
    const anchor = Date.UTC(2026, 0, 15, 10, 0, 0);
    const window = getBudgetWindow(anchor, Date.UTC(2026, 5, 20));
    expect(new Date(window.startMs).toISOString()).toBe("2026-06-15T10:00:00.000Z");
    expect(new Date(window.endMs).toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("clamps anchors at the end of shorter months", () => {
    const anchor = Date.UTC(2026, 0, 31);
    const window = getBudgetWindow(anchor, Date.UTC(2026, 1, 28));
    expect(window.startMs).toBe(Date.UTC(2026, 1, 28));
  });
});

describe("model accounting", () => {
  it("reserves more than actual usage for bounded output", () => {
    const payload = { messages: [{ role: "user", content: "Open example.com" }] };
    const reserved = maximumReservationMicrodollars("sonnet", payload, 1_200);
    const actual = actualCostMicrodollars("sonnet", { input_tokens: 100, output_tokens: 50 });
    expect(reserved).toBeGreaterThan(actual);
  });

  it("routes simple requests to Haiku and harder ones up the ladder", () => {
    expect(chooseModel("auto", "Open example.com")).toBe("haiku");
    expect(chooseModel("auto", "Plan a complex workflow across multiple applications")).toBe("sonnet");
    expect(chooseModel("auto", "Use deep reasoning to root cause this difficult failure")).toBe("opus");
  });

  it("caps output tokens to what the remaining budget can pay for", () => {
    // Output price: opus 25, haiku 5 microdollars/token. The cap is remaining /
    // output price, floored, never negative. This is what stops a turn generating
    // past the budget.
    expect(budgetLimitedOutputTokens("opus", 250_000)).toBe(10_000);
    expect(budgetLimitedOutputTokens("haiku", 1_000)).toBe(200);
    expect(budgetLimitedOutputTokens("opus", 24)).toBe(0); // less than one token's price
    expect(budgetLimitedOutputTokens("opus", 0)).toBe(0);
  });
});

// The ledger is the hard cost cap. These tests exercise the real reservation
// SQL against an isolated user and billing window so they never collide with
// other rows. Money is in integer microdollars throughout.
describe("budget ledger invariants", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  function makeSubscription(): SubscriptionRow {
    return {
      userId: randomUUID(),
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      plan: "pro",
      interval: "month",
      status: "active",
      active: true,
      // A unique anchor per test keeps each test inside its own billing window.
      budgetAnchorMs: Date.now(),
      currentPeriodEndMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
      autoReloadEnabled: false,
      autoReloadPack: "small",
      monthlyTopupLimitMicro: 0,
      stripePaymentMethodId: null,
      pendingPlan: null,
      pendingInterval: null,
      pendingEffectiveMs: null
    };
  }

  const HOUR = 60 * 60 * 1000;

  // Insert a settled usage row directly, at a chosen time, to set up a window
  // state without going through reserve (used to fill the monthly window).
  async function seedSettled(userId: string, amount: number, createdAtMs: number, anchorMs: number) {
    const window = getBudgetWindow(anchorMs, createdAtMs);
    await client.execute({
      sql: `INSERT INTO usage_ledger(id, user_id, run_id, period_start_ms, period_end_ms, model, reserved_microdollars, actual_microdollars, status, created_at_ms, settled_at_ms)
            VALUES (?, ?, 'seed', ?, ?, 'haiku', 0, ?, 'settled', ?, ?)`,
      args: [randomUUID(), userId, window.startMs, window.endMs, amount, createdAtMs, createdAtMs]
    });
  }

  it("never lets concurrent reservations exceed the daily cap", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Pro's daily cap is 400_000. Each asks for a tenth, so at most 10 succeed.
    const cap = 400_000;
    const perReservation = cap / 10;
    const attempts = 25;

    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: perReservation, nowMs })
      )
    );

    const accepted = results.filter((result) => result.status === "fulfilled").length;
    expect(accepted).toBeLessThanOrEqual(10);
    const used = await rollingUsage(subscription.userId, nowMs - 24 * HOUR);
    expect(used).toBeLessThanOrEqual(cap);
    expect(used).toBe(accepted * perReservation);
  });

  it("blocks at the daily cap", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Use the whole daily cap, then a further reservation is rejected.
    await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 400_000, nowMs });
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs })
    ).rejects.toMatchObject({ code: "RATE_LIMIT_DAY" });
  });

  it("accumulates toward the daily cap across the 24-hour window", async () => {
    const subscription = makeSubscription();
    const t = subscription.budgetAnchorMs;
    // Pro daily cap is 400_000; three 130k reservations (390k) still leave headroom.
    for (const offset of [0, 6, 12]) {
      await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 130_000, nowMs: t + offset * HOUR });
    }
    // A fourth 130k is allowed (390k < 400k) but is CLAMPED to the remaining 10k,
    // so committed lands exactly on the cap and never over. The window is now full,
    // so a fifth is refused.
    const fourth = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 130_000, nowMs: t + 15 * HOUR });
    expect(fourth.reservationId).toBeTruthy();
    expect(await rollingUsage(subscription.userId, t + 15 * HOUR - 24 * HOUR)).toBe(400_000);
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 130_000, nowMs: t + 18 * HOUR })
    ).rejects.toMatchObject({ code: "RATE_LIMIT_DAY" });
  });

  it("blocks at the monthly cap", async () => {
    const subscription = makeSubscription();
    const anchor = subscription.budgetAnchorMs;
    // Fill the whole monthly cap as old usage, outside the rolling windows, so only
    // the monthly cap is binding.
    await seedSettled(subscription.userId, 12_000_000, anchor, anchor);
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs: anchor + 48 * HOUR })
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  });

  it("gives the bigger plan bigger caps", async () => {
    // After 400k of usage a Pro user is at their daily cap and is blocked, while an
    // Ultra user (1.95M daily cap) still has plenty of headroom for more.
    const pro = makeSubscription();
    await reserveBudget({ subscription: pro, runId: randomUUID(), model: "haiku", amountMicrodollars: 400_000, nowMs: pro.budgetAnchorMs });
    await expect(
      reserveBudget({ subscription: pro, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs: pro.budgetAnchorMs })
    ).rejects.toMatchObject({ code: "RATE_LIMIT_DAY" });

    const ultra = { ...makeSubscription(), plan: "ultra" as const };
    await reserveBudget({ subscription: ultra, runId: randomUUID(), model: "haiku", amountMicrodollars: 400_000, nowMs: ultra.budgetAnchorMs });
    const stillOk = await reserveBudget({ subscription: ultra, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs: ultra.budgetAnchorMs });
    expect(stillOk.reservationId).toBeTruthy();
  });

  it("lets a user with headroom start a turn whose worst-case reservation exceeds it", async () => {
    // The reported bug: a Pro user sitting at 58% of the daily cap was blocked from
    // an Opus turn because the turn's worst-case reservation (near the whole 400k
    // cap) did not "fit" the remaining headroom, even though real usage was far
    // under the limit. The gate must allow a request while any headroom remains,
    // and the oversized reservation must settle back down to the true cost.
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Seed the day at 58% used (232k of the 400k Pro cap).
    await seedSettled(subscription.userId, 232_000, nowMs, subscription.budgetAnchorMs);
    // A worst-case Opus reservation of 300k would not fit the remaining 168k, but
    // it is still allowed because the day is not yet exhausted.
    const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "opus", amountMicrodollars: 300_000, nowMs });
    expect(reservation.reservationId).toBeTruthy();
    // It settles to the true, far smaller cost, so the user keeps real headroom.
    await settleBudget(reservation.reservationId, 5_000);
    expect(await rollingUsage(subscription.userId, nowMs - 24 * HOUR)).toBe(237_000);
  });

  it("never lets settled spend exceed the daily cap, even when a turn costs more than the headroom", async () => {
    // The hard-cap guarantee. Near the cap the reservation is clamped to the
    // remaining headroom, and settleBudget clamps the charge to that reservation,
    // so a turn whose real cost is larger still cannot push committed spend over
    // the cap. This is what stops the number ever ticking past the limit.
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Pro at 350k of the 400k cap: only 50k of headroom remains.
    await seedSettled(subscription.userId, 350_000, nowMs, subscription.budgetAnchorMs);
    const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "opus", amountMicrodollars: 300_000, nowMs });
    expect(reservation.reservationId).toBeTruthy();
    // The real cost lands far above the 50k of headroom; it must be clamped to 50k.
    await settleBudget(reservation.reservationId, 300_000);
    expect(await rollingUsage(subscription.userId, nowMs - 24 * HOUR)).toBe(400_000);
    // The day is now exactly full, so the next request is refused.
    await expect(
      reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 1_000, nowMs })
    ).rejects.toMatchObject({ code: "RATE_LIMIT_DAY" });
  });

  it("reports daily and monthly headroom separately", async () => {
    // A turn's output cap is derived from the smaller of these, so an expensive
    // turn near the limit is bounded to the money actually left; both are returned
    // so the caller can say "frees up tomorrow" (daily) vs "used all your tokens"
    // (monthly) accurately.
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    // Pro caps: daily 400k, monthly 12M. Seed 300k of settled usage today.
    await seedSettled(subscription.userId, 300_000, nowMs, subscription.budgetAnchorMs);
    const headroom = await budgetHeadroom(subscription.userId, subscription, nowMs);
    expect(headroom.daily).toBe(100_000); // 400k cap - 300k used today
    expect(headroom.monthly).toBe(11_700_000); // 12M cap - 300k used
  });

  it("returns the clamped reserved amount so callers can size output to it", async () => {
    // Near the cap the reservation is clamped below the requested worst case; the
    // returned reservedMicrodollars is what a turn may actually spend.
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    await seedSettled(subscription.userId, 350_000, nowMs, subscription.budgetAnchorMs); // 50k left
    const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "opus", amountMicrodollars: 300_000, nowMs });
    expect(reservation.reservedMicrodollars).toBe(50_000);
  });

  it("releases the difference when actual usage settles below the reservation", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
    const reserved = 80_000;
    const actual = 20_000;

    const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "sonnet", amountMicrodollars: reserved, nowMs });

    const afterReserve = await getBudgetUsage(subscription.userId, window);
    expect(afterReserve.reserved).toBe(reserved);
    expect(afterReserve.used).toBe(0);

    await settleBudget(reservation.reservationId, actual);

    const afterSettle = await getBudgetUsage(subscription.userId, window);
    expect(afterSettle.reserved).toBe(0);
    expect(afterSettle.used).toBe(actual);
  });

  it("charges nothing and frees the caps when a reservation is released", async () => {
    const subscription = makeSubscription();
    const nowMs = subscription.budgetAnchorMs;
    const window = getBudgetWindow(subscription.budgetAnchorMs, nowMs);
    const reserved = 90_000;

    const reservation = await reserveBudget({ subscription, runId: randomUUID(), model: "sonnet", amountMicrodollars: reserved, nowMs });
    expect((await getBudgetUsage(subscription.userId, window)).reserved).toBe(reserved);
    expect(await rollingUsage(subscription.userId, nowMs - HOUR)).toBe(reserved);

    // A failed turn releases the reservation: it must cost zero and must not
    // count against the monthly or daily caps, so the user is never billed or
    // rate-limited for work they did not receive.
    await releaseBudget(reservation.reservationId);

    const after = await getBudgetUsage(subscription.userId, window);
    expect(after.reserved).toBe(0);
    expect(after.used).toBe(0);
    expect(await rollingUsage(subscription.userId, nowMs - HOUR)).toBe(0);

    // The freed headroom is usable: a fresh reservation for the full daily cap succeeds.
    const next = await reserveBudget({ subscription, runId: randomUUID(), model: "haiku", amountMicrodollars: 400_000, nowMs });
    expect(next.reservationId).toBeTruthy();
  });
});
