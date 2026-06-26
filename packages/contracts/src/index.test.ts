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
    // Pro: $0.70 / 5h, $2.50 / day, $12 / month. The 5-hour and daily caps are the
    // everyday rolling gate sized so a few high-effort messages fit; the monthly
    // cap is a rarely-hit safety net that is the real per-user cost ceiling.
    expect(PLAN_CATALOG.pro.fiveHourMicrodollars).toBe(700_000);
    expect(PLAN_CATALOG.pro.dailyMicrodollars).toBe(2_500_000);
    expect(PLAN_CATALOG.pro.monthlyApiBudgetMicrodollars).toBe(12_000_000);
    // Ultra: $0.75 / 5h, $3 / day, $60 / month.
    expect(PLAN_CATALOG.ultra.fiveHourMicrodollars).toBe(750_000);
    expect(PLAN_CATALOG.ultra.dailyMicrodollars).toBe(3_000_000);
    expect(PLAN_CATALOG.ultra.monthlyApiBudgetMicrodollars).toBe(60_000_000);
  });

  it("keeps each plan's caps consistent (5h below daily below monthly)", () => {
    for (const plan of [PLAN_CATALOG.pro, PLAN_CATALOG.ultra]) {
      expect(plan.fiveHourMicrodollars).toBeLessThan(plan.dailyMicrodollars);
      expect(plan.dailyMicrodollars).toBeLessThan(plan.monthlyApiBudgetMicrodollars);
    }
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
