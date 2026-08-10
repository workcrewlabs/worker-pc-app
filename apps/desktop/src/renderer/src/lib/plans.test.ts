import { describe, expect, it } from "vitest";
import { planName } from "./plans";

// This pins a real outage. An app built before the free plan existed looked up
// PLAN_CATALOG["free"] the moment the backend started reporting that plan, got
// undefined, and threw while rendering, which blanked the entire window. The app
// and the backend ship separately, so the backend can always name a plan the
// installed app has never heard of; a lookup must never be able to crash a screen.

describe("planName", () => {
  it("names the plans it knows", () => {
    expect(planName("pro")).toBe("Pro");
    expect(planName("ultra")).toBe("Ultra");
    expect(planName("free")).toBe("Free");
  });

  it("survives a plan this build has never heard of", () => {
    // The exact shape of the crash: a plan id that is not in this build's catalog.
    expect(() => planName("team-plan-from-the-future")).not.toThrow();
    expect(planName("enterprise")).toBe("Enterprise");
  });

  it("uses the caller's wording when there is no plan at all", () => {
    expect(planName(null, "No plan")).toBe("No plan");
    expect(planName(undefined, "No active plan")).toBe("No active plan");
    expect(planName("")).toBe("No plan");
  });
});
