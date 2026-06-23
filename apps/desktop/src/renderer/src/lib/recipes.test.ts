import { describe, expect, it } from "vitest";
import type { AutomationAction } from "@workcrew/contracts";
import { buildRecipe, normalizeTaskKey, parseWindowsSnapshot, stabilizeAction } from "./recipes";

const SNAPSHOT = '1 Button "Create Invoice"\n12 Edit "Quantity"\n13 Button "Save & Close"';

describe("normalizeTaskKey", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeTaskKey("  Create   an Invoice  ")).toBe("create an invoice");
  });
  it("maps spacing/case variants to the same key", () => {
    expect(normalizeTaskKey("Open QuickBooks")).toBe(normalizeTaskKey("open   quickbooks"));
  });
});

describe("parseWindowsSnapshot", () => {
  it("maps numeric ids to control names", () => {
    const map = parseWindowsSnapshot(SNAPSHOT);
    expect(map.get("1")).toBe("Create Invoice");
    expect(map.get("12")).toBe("Quantity");
    expect(map.get("13")).toBe("Save & Close");
  });
  it("ignores non-matching lines and null input", () => {
    expect(parseWindowsSnapshot(null).size).toBe(0);
    expect(parseWindowsSnapshot("(no interactable controls found)").size).toBe(0);
  });
});

describe("stabilizeAction", () => {
  it("resolves a numeric control reference to its name", () => {
    const action: AutomationAction = { kind: "windows", command: "set-text", control: "12", value: "3" };
    const stable = stabilizeAction(action, SNAPSHOT);
    expect(stable).not.toBeNull();
    expect((stable as AutomationAction & { control: string }).control).toBe("Quantity");
  });
  it("keeps an already-stable name reference unchanged", () => {
    const action: AutomationAction = { kind: "windows", command: "click", control: "Save & Close" };
    expect(stabilizeAction(action, SNAPSHOT)).toEqual(action);
  });
  it("returns null for a numeric reference that the snapshot cannot resolve", () => {
    const action: AutomationAction = { kind: "windows", command: "click", control: "99" };
    expect(stabilizeAction(action, SNAPSHOT)).toBeNull();
  });
  it("keeps deterministic windows commands with no control", () => {
    const action: AutomationAction = { kind: "windows", command: "inspect" };
    expect(stabilizeAction(action, null)).toEqual(action);
  });
  it("keeps url-driven browser actions but rejects ref-targeted ones", () => {
    expect(stabilizeAction({ kind: "browser", command: "goto", url: "https://example.com" }, null)).not.toBeNull();
    expect(stabilizeAction({ kind: "browser", command: "click", target: "e12" }, null)).toBeNull();
  });
  it("keeps finish", () => {
    expect(stabilizeAction({ kind: "finish", summary: "done" }, null)).not.toBeNull();
  });
});

describe("buildRecipe", () => {
  const recorded = [
    { action: { kind: "windows", command: "connect", windowTitle: "QuickBooks" } as AutomationAction, snapshot: null },
    { action: { kind: "windows", command: "inspect" } as AutomationAction, snapshot: null },
    { action: { kind: "windows", command: "click", control: "1" } as AutomationAction, snapshot: SNAPSHOT },
    { action: { kind: "windows", command: "set-text", control: "12", value: "3" } as AutomationAction, snapshot: SNAPSHOT }
  ];

  it("builds a recipe with stable selectors and approval flags", () => {
    const recipe = buildRecipe("Create an invoice", recorded, "Invoice created.");
    expect(recipe).not.toBeNull();
    expect(recipe!.taskKey).toBe("create an invoice");
    expect(recipe!.steps).toHaveLength(4);
    // The numeric click "1" resolved to the control name.
    const click = recipe!.steps[2]!.action as AutomationAction & { control: string };
    expect(click.control).toBe("Create Invoice");
    // set-text is a write and must be approval-gated on replay.
    expect(recipe!.steps[3]!.needsApproval).toBe(true);
    // inspect is a read and must not need approval.
    expect(recipe!.steps[1]!.needsApproval).toBe(false);
  });

  it("refuses to record a run with an unresolvable step", () => {
    const bad = [...recorded, { action: { kind: "windows", command: "click", control: "777" } as AutomationAction, snapshot: SNAPSHOT }];
    expect(buildRecipe("x", bad, "")).toBeNull();
  });

  it("refuses to record a browser run that clicks ephemeral refs", () => {
    const browser = [{ action: { kind: "browser", command: "click", target: "e5" } as AutomationAction, snapshot: null }];
    expect(buildRecipe("x", browser, "")).toBeNull();
  });

  it("returns null for an empty run", () => {
    expect(buildRecipe("x", [], "")).toBeNull();
  });
});
