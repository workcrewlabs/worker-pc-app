import type { SubscriptionState } from "@workcrew/contracts";

// How the user stands against their usage caps. There are three hard caps (a
// rolling 5-hour rate cap, a daily cap, and a monthly cap); this reports the
// tightest one, so the low/empty banner appears for whichever is closest. "low"
// is 80% or more of a cap committed (used plus reserved), "empty" is nothing left.
// Everything is in internal usage units, shown to the user as plain tokens.
export type UsageLevel = "ok" | "low" | "empty";
export type UsageWindow = "5h" | "day" | "month";

export type UsageStatus = {
  used: number;
  budget: number;
  remaining: number;
  percent: number;
  level: UsageLevel;
  window: UsageWindow;
};

// The threshold at which we start warning the user they are running low.
export const LOW_USAGE_PERCENT = 80;

function windowStatus(used: number, reserved: number, limit: number, window: UsageWindow): UsageStatus {
  const budget = Math.max(0, limit);
  const u = Math.max(0, Math.min(used, budget));
  const committed = Math.min(budget, u + Math.max(0, reserved));
  const remaining = Math.max(0, budget - committed);
  const percent = budget > 0 ? Math.min(100, (committed / budget) * 100) : 0;
  const level: UsageLevel = budget > 0 && remaining <= 0 ? "empty" : percent >= LOW_USAGE_PERCENT ? "low" : "ok";
  return { used: u, budget, remaining, percent, level, window };
}

const SEVERITY: Record<UsageLevel, number> = { ok: 0, low: 1, empty: 2 };

export function usageStatus(entitlement: SubscriptionState, liveUsed?: number): UsageStatus {
  // Monthly can use the live figure (it reflects the latest turn before a refresh).
  const monthly = windowStatus(liveUsed ?? entitlement.usedMicrodollars, entitlement.reservedMicrodollars, entitlement.budgetMicrodollars, "month");
  // The rolling caps already include reserved usage in their totals.
  const daily = windowStatus(entitlement.dailyUsedMicrodollars, 0, entitlement.dailyLimitMicrodollars, "day");
  const fiveHour = windowStatus(entitlement.fiveHourUsedMicrodollars, 0, entitlement.fiveHourLimitMicrodollars, "5h");

  // Report the tightest cap: worst level first, then highest percent.
  return [monthly, daily, fiveHour].reduce((worst, candidate) => {
    if (SEVERITY[candidate.level] > SEVERITY[worst.level]) return candidate;
    if (SEVERITY[candidate.level] === SEVERITY[worst.level] && candidate.percent > worst.percent) return candidate;
    return worst;
  });
}
