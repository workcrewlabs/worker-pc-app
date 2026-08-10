import { PLAN_CATALOG } from "@workcrew/contracts";

// Read a plan out of the catalog without assuming it is there.
//
// This exists because of a real outage: an app built before the free plan
// existed looked up PLAN_CATALOG["free"] when the backend started reporting that
// plan, got undefined, and threw while rendering, which blanked the whole window.
// The backend can always name a plan the installed app has never heard of, since
// the two ship separately, so every lookup has to tolerate a stranger.
export function planName(plan: string | null | undefined, fallback = "No plan"): string {
  if (!plan) return fallback;
  const known = (PLAN_CATALOG as Record<string, { name?: string } | undefined>)[plan];
  if (known?.name) return known.name;
  // An unknown plan still deserves a readable label: show the id capitalised
  // ("free" becomes "Free") rather than crashing or printing nothing.
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
