import { describe, expect, it } from "vitest";
import { DAILY_BURST, adaptiveDailyLimit } from "./budget.js";

// An Ultra customer was told he was running low for today while nearly the whole
// month sat unused, because the daily cap was a fixed one thirtieth of the month
// no matter what was left. A daily limit exists to stop the month vanishing on
// day one, not to ration a balance nobody has touched.

const DAY = 24 * 60 * 60 * 1000;
const ULTRA_DAILY = 1_950_000;
const ULTRA_MONTHLY = 60_000_000;

describe("the daily allowance", () => {
  it("opens up when the month is barely touched", () => {
    // Day one of the period: the old rule gave 1.95, the even share is 2 a day,
    // and the burst makes a heavy day possible.
    const limit = adaptiveDailyLimit(ULTRA_DAILY, ULTRA_MONTHLY, 30 * DAY);
    expect(limit).toBe(Math.floor((ULTRA_MONTHLY / 30) * DAILY_BURST));
    expect(limit).toBeGreaterThan(ULTRA_DAILY);
  });

  it("never falls below what the plan promised", () => {
    // Most of the month spent, a fortnight to go: the even share is now tiny,
    // so the plan's own daily figure holds the floor.
    const limit = adaptiveDailyLimit(ULTRA_DAILY, 5_000_000, 14 * DAY);
    expect(limit).toBe(ULTRA_DAILY);
  });

  it("never lets a day exceed what the month has left", () => {
    // The monthly cap is the real limit; this one only shapes the pace.
    expect(adaptiveDailyLimit(ULTRA_DAILY, 400_000, 9 * DAY)).toBe(400_000);
    expect(adaptiveDailyLimit(ULTRA_DAILY, 1_000_000, DAY)).toBe(1_000_000);
  });

  it("gives nothing when the month is spent", () => {
    expect(adaptiveDailyLimit(ULTRA_DAILY, 0, 10 * DAY)).toBe(0);
    expect(adaptiveDailyLimit(ULTRA_DAILY, -5, 10 * DAY)).toBe(0);
  });

  it("treats the last hours of a period as a whole day", () => {
    // Never divide by zero days, and never punish someone for being near the
    // end of their period.
    const limit = adaptiveDailyLimit(ULTRA_DAILY, 8_000_000, 60_000);
    expect(limit).toBe(8_000_000);
  });

  it("leaves the free plan exactly as it was", () => {
    // Free is a one-time trial on a century-long window: the even share rounds
    // to nothing, so the floor is the whole allowance, unchanged.
    const FREE = 300_000;
    const century = 100 * 365 * DAY;
    expect(adaptiveDailyLimit(FREE, FREE, century)).toBe(FREE);
  });

  it("spends a healthy month faster than thirty days, which is the point", () => {
    // Burst above the even share is deliberate: a heavy day is allowed when
    // there is plenty left, and the monthly cap still bounds the total.
    expect(DAILY_BURST).toBeGreaterThan(1);
    expect(adaptiveDailyLimit(ULTRA_DAILY, ULTRA_MONTHLY, 30 * DAY))
      .toBeLessThanOrEqual(ULTRA_MONTHLY);
  });
});
