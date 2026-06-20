import { describe, expect, it } from "vitest";
import { actualCostMicrodollars, chooseModel, maximumReservationMicrodollars } from "./anthropic.js";
import { getBudgetWindow } from "./budget.js";

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

  it("routes simple requests to Haiku", () => {
    expect(chooseModel("auto", "Open example.com")).toBe("haiku");
    expect(chooseModel("auto", "Plan a complex workflow across multiple applications")).toBe("sonnet");
  });
});
