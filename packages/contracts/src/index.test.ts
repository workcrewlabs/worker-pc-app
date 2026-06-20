import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  browserActionSchema,
  createCheckoutSchema
} from "./index.js";

describe("plan catalog", () => {
  it("gives two months free on annual plans", () => {
    expect(PLAN_CATALOG.pro.yearlyPriceUsd).toBe(PLAN_CATALOG.pro.monthlyPriceUsd * 10);
    expect(PLAN_CATALOG.ultra.yearlyPriceUsd).toBe(PLAN_CATALOG.ultra.monthlyPriceUsd * 10);
  });

  it("keeps API budgets at 25 percent of monthly list price", () => {
    expect(PLAN_CATALOG.pro.monthlyApiBudgetMicrodollars).toBe(6_750_000);
    expect(PLAN_CATALOG.ultra.monthlyApiBudgetMicrodollars).toBe(50_000_000);
  });
});

describe("security schemas", () => {
  it("rejects unsupported browser commands", () => {
    expect(() => browserActionSchema.parse({ kind: "browser", command: "run-code" })).toThrow();
  });

  it("rejects extra checkout fields", () => {
    expect(() => createCheckoutSchema.parse({ plan: "pro", interval: "year", admin: true })).toThrow();
  });
});
