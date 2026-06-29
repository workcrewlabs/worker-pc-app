import { describe, expect, it } from "vitest";
import { downgradeSchedulePhases, isEntitledStatus, isPlanUpgrade } from "./billing.js";

// Pre-launch strict mode: entitlement comes only from a live subscription or a
// live trial. past_due (Stripe's payment-retry window) is NOT entitled unless the
// WORKCREW_BILLING_GRACE_PAST_DUE grace flag is intentionally enabled, which it is
// not in the test environment.
describe("subscription entitlement policy", () => {
  it("entitles active and trialing", () => {
    expect(isEntitledStatus("active")).toBe(true);
    expect(isEntitledStatus("trialing")).toBe(true);
  });

  it("does not entitle past_due in strict mode (default)", () => {
    expect(isEntitledStatus("past_due")).toBe(false);
  });

  it("never entitles ended, paused, or incomplete statuses", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "anything-else"]) {
      expect(isEntitledStatus(status)).toBe(false);
    }
  });
});

// An upgrade must be paid before it is granted; a downgrade is applied in place.
// The classification is by the plan's monthly allowance (capacity), NOT by raw
// recurring price, because the cheaper interval of the higher tier can cost less
// than the pricier interval of the lower tier.
describe("isPlanUpgrade", () => {
  it("treats any move to the higher-capacity plan as an upgrade, whatever the interval", () => {
    expect(isPlanUpgrade("pro", "month", "ultra", "month")).toBe(true);
    expect(isPlanUpgrade("pro", "month", "ultra", "year")).toBe(true);
    expect(isPlanUpgrade("pro", "year", "ultra", "year")).toBe(true);
    // The regression that was found: Pro yearly ($270) -> Ultra monthly ($200) is
    // cheaper per the recurring price yet is a tier upgrade that must pay first.
    expect(isPlanUpgrade("pro", "year", "ultra", "month")).toBe(true);
  });

  it("treats any move to the lower-capacity plan as a downgrade", () => {
    expect(isPlanUpgrade("ultra", "month", "pro", "month")).toBe(false);
    expect(isPlanUpgrade("ultra", "year", "pro", "month")).toBe(false);
    expect(isPlanUpgrade("ultra", "month", "pro", "year")).toBe(false);
    expect(isPlanUpgrade("ultra", "year", "pro", "year")).toBe(false);
  });

  it("within the same plan, only a costlier interval (monthly to yearly) is an upgrade", () => {
    expect(isPlanUpgrade("pro", "month", "pro", "year")).toBe(true);
    expect(isPlanUpgrade("ultra", "month", "ultra", "year")).toBe(true);
    expect(isPlanUpgrade("pro", "year", "pro", "month")).toBe(false);
    expect(isPlanUpgrade("ultra", "year", "ultra", "month")).toBe(false);
  });

  it("treats an unchanged plan and interval as not an upgrade (no free grant)", () => {
    expect(isPlanUpgrade("pro", "month", "pro", "month")).toBe(false);
    expect(isPlanUpgrade("ultra", "year", "ultra", "year")).toBe(false);
  });
});

// A downgrade must not drop the limit mid-period: the current (paid) price runs to
// the end of the period, then the new lower price starts.
describe("downgradeSchedulePhases", () => {
  it("keeps the current price until period end, then starts the new price", () => {
    const phases = downgradeSchedulePhases(
      "price_ultra_month",
      "price_pro_month",
      { start: 1_000, end: 2_000 },
      { userId: "user_1", plan: "pro", interval: "month" }
    );
    expect(phases).toHaveLength(2);
    const [first, second] = phases;
    // Phase 1: still on the higher (paid) plan until the period ends.
    expect(first?.items?.[0]?.price).toBe("price_ultra_month");
    expect(first?.start_date).toBe(1_000);
    expect(first?.end_date).toBe(2_000);
    // Phase 2: the new lower plan, starting right after, with the user mapping.
    expect(second?.items?.[0]?.price).toBe("price_pro_month");
    expect(second?.metadata?.workcrew_user_id).toBe("user_1");
    expect(second?.metadata?.workcrew_plan).toBe("pro");
  });
});
