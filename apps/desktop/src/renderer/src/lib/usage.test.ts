import { describe, expect, it } from "vitest";
import { type SubscriptionState } from "@workcrew/contracts";
import { usageStatus } from "./usage";

function entitlement(over: Partial<SubscriptionState>): SubscriptionState {
  return {
    active: true,
    plan: "pro",
    interval: "month",
    status: "active",
    currentPeriodEnd: null,
    budgetPeriodStart: null,
    budgetPeriodEnd: null,
    budgetMicrodollars: 1_000_000,
    usedMicrodollars: 0,
    reservedMicrodollars: 0,
    dailyLimitMicrodollars: 1_000_000,
    dailyUsedMicrodollars: 0,
    pendingPlan: null,
    pendingInterval: null,
    pendingEffective: null,
    modelMode: "economy",
    ...over
  };
}

describe("usageStatus", () => {
  it("is ok with comfortable headroom", () => {
    const status = usageStatus(entitlement({ usedMicrodollars: 500_000 }));
    expect(status.level).toBe("ok");
    expect(status.remaining).toBe(500_000);
    expect(status.percent).toBe(50);
  });

  it("warns low at the 80% threshold", () => {
    expect(usageStatus(entitlement({ usedMicrodollars: 800_000 })).level).toBe("low");
    expect(usageStatus(entitlement({ usedMicrodollars: 799_999 })).level).toBe("ok");
  });

  it("counts reserved tokens toward the committed total", () => {
    const status = usageStatus(entitlement({ usedMicrodollars: 700_000, reservedMicrodollars: 150_000 }));
    expect(status.level).toBe("low");
    expect(status.remaining).toBe(150_000);
  });

  it("is empty when nothing is left", () => {
    const status = usageStatus(entitlement({ usedMicrodollars: 1_000_000 }));
    expect(status.level).toBe("empty");
    expect(status.remaining).toBe(0);
  });

  it("reports the tightest window (a full daily cap with monthly headroom)", () => {
    const status = usageStatus(entitlement({
      usedMicrodollars: 100_000,
      dailyLimitMicrodollars: 100_000,
      dailyUsedMicrodollars: 100_000
    }));
    expect(status.level).toBe("empty");
    expect(status.window).toBe("day");
  });

  it("warns low on the daily window before it is empty", () => {
    const status = usageStatus(entitlement({
      usedMicrodollars: 10_000,
      dailyLimitMicrodollars: 350_000,
      dailyUsedMicrodollars: 300_000
    }));
    expect(status.level).toBe("low");
    expect(status.window).toBe("day");
  });

  it("prefers the live usage figure when provided", () => {
    const status = usageStatus(entitlement({ usedMicrodollars: 100_000 }), 950_000);
    expect(status.level).toBe("low");
  });

  it("treats a zero budget as not low (no active plan)", () => {
    const status = usageStatus(entitlement({ budgetMicrodollars: 0, usedMicrodollars: 0 }));
    expect(status.level).toBe("ok");
    expect(status.percent).toBe(0);
  });
});
