import { describe, expect, it } from "vitest";
import {
  PLAN_CATALOG,
  attachmentRefSchema,
  browserActionSchema,
  chatSendSchema,
  createCheckoutSchema,
  createRoutineSchema
} from "./index.js";

describe("plan catalog", () => {
  it("gives two months free on annual plans", () => {
    expect(PLAN_CATALOG.pro.yearlyPriceUsd).toBe(PLAN_CATALOG.pro.monthlyPriceUsd * 10);
    expect(PLAN_CATALOG.ultra.yearlyPriceUsd).toBe(PLAN_CATALOG.ultra.monthlyPriceUsd * 10);
  });

  it("sets the hard API-cost caps per plan", () => {
    // Pro: $0.40 / day, $12 / month. The daily cap is the everyday rolling gate,
    // sized as the monthly divided by 30; the monthly cap is the overall ceiling.
    expect(PLAN_CATALOG.pro.dailyMicrodollars).toBe(400_000);
    expect(PLAN_CATALOG.pro.monthlyApiBudgetMicrodollars).toBe(12_000_000);
    // Ultra: $1.95 / day (a small margin under the $2 pace so the shown daily spend
    // never ticks past two dollars), $60 / month.
    expect(PLAN_CATALOG.ultra.dailyMicrodollars).toBe(1_950_000);
    expect(PLAN_CATALOG.ultra.monthlyApiBudgetMicrodollars).toBe(60_000_000);
  });

  it("keeps each plan's caps consistent (daily below monthly, at or under monthly / 30)", () => {
    for (const plan of [PLAN_CATALOG.pro, PLAN_CATALOG.ultra]) {
      // Daily is the everyday gate: always below the monthly ceiling, and never
      // above the monthly-divided-by-30 pace (Ultra sits a little under it as a
      // display safety margin).
      expect(plan.dailyMicrodollars).toBeLessThan(plan.monthlyApiBudgetMicrodollars);
      expect(plan.dailyMicrodollars).toBeLessThanOrEqual(Math.round(plan.monthlyApiBudgetMicrodollars / 30));
    }
    // Pro is exactly monthly / 30; Ultra is $0.05/day under its $2 pace.
    expect(PLAN_CATALOG.pro.dailyMicrodollars).toBe(Math.round(PLAN_CATALOG.pro.monthlyApiBudgetMicrodollars / 30));
    expect(Math.round(PLAN_CATALOG.ultra.monthlyApiBudgetMicrodollars / 30) - PLAN_CATALOG.ultra.dailyMicrodollars).toBe(50_000);
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

describe("chat schemas", () => {
  it("applies chat send defaults", () => {
    const parsed = chatSendSchema.parse({ text: "hello" });
    expect(parsed.model).toBe("sonnet");
    expect(parsed.effort).toBe("high");
    expect(parsed.thinking).toBe(false);
    expect(parsed.attachments).toEqual([]);
  });

  it("rejects unknown chat send fields", () => {
    expect(() => chatSendSchema.parse({ text: "hi", surprise: true })).toThrow();
  });

  it("defaults attachment redaction to off", () => {
    const parsed = attachmentRefSchema.parse({
      attachmentId: "att_1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      kind: "pdf"
    });
    expect(parsed.redact).toBe(false);
  });

  it("rejects attachment kinds outside the allowlist", () => {
    expect(() =>
      attachmentRefSchema.parse({
        attachmentId: "att_1",
        filename: "movie.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        kind: "video"
      })
    ).toThrow();
  });
});

describe("routine schemas", () => {
  it("applies routine creation defaults", () => {
    const parsed = createRoutineSchema.parse({
      name: "Tidy downloads",
      instructions: "Move old files into folders",
      scheduleKind: "daily",
      scope: {}
    });
    expect(parsed.permissionMode).toBe("plan_first");
    expect(parsed.model).toBe("auto");
    expect(parsed.scope.network).toBe("allowlist");
    expect(parsed.scope.apps).toEqual([]);
  });

  it("rejects instructions that are too short", () => {
    expect(() =>
      createRoutineSchema.parse({
        name: "Tidy",
        instructions: "no",
        scheduleKind: "manual",
        scope: {}
      })
    ).toThrow();
  });

  it("rejects unknown routine fields", () => {
    expect(() =>
      createRoutineSchema.parse({
        name: "Tidy",
        instructions: "Move old files into folders",
        scheduleKind: "manual",
        scope: {},
        sneaky: true
      })
    ).toThrow();
  });
});
