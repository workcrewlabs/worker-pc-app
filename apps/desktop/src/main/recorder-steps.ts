// Pure helpers for the browser click recorder. Kept free of Electron and
// Playwright imports so they can be unit tested directly. browser-cli.ts uses
// these to turn raw in-page recorder events into replayable browser actions.

import type { BrowserAction } from "@workcrew/contracts";

export type RecordPayload = { type?: string; selector?: string; value?: string };

// Map one in-page recorder event to a replayable browser action, or null if it
// is not something we can replay (missing selector, unknown type).
export function recordStepFromPayload(payload: unknown): BrowserAction | null {
  if (!payload || typeof payload !== "object") return null;
  const { type, selector, value } = payload as RecordPayload;
  if (typeof selector !== "string" || !selector) return null;
  if (type === "click") return { kind: "browser", command: "click-selector", target: selector.slice(0, 500) };
  if (type === "fill") return { kind: "browser", command: "fill-selector", target: selector.slice(0, 500), value: String(value ?? "").slice(0, 10_000) };
  return null;
}

// Collapse noise from a raw recording: drop a click identical to the one just
// before it, and keep only the last value when the same field is edited in a row.
// Pure so it can be unit tested. Non-consecutive repeats are left alone.
export function dedupeRecordedSteps(steps: BrowserAction[]): BrowserAction[] {
  const out: BrowserAction[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (prev && step.command === "click-selector" && prev.command === "click-selector" && prev.target === step.target) {
      continue;
    }
    if (prev && step.command === "fill-selector" && prev.command === "fill-selector" && prev.target === step.target) {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}
