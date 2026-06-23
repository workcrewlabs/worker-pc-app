// Pure helpers for the browser click recorder. Kept free of Electron and
// Playwright imports so they can be unit tested directly. browser-cli.ts uses
// these to turn raw in-page recorder payloads into a descriptive trace, which is
// then sent to the model to be written up as one reusable instruction.

import type { RecordedEvent } from "@workcrew/contracts";

// The raw payload the in-page recorder posts through the __wcRecord binding.
export type RecordPayload = { type?: string; url?: string; title?: string; target?: string; role?: string; value?: string };

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

// Map one in-page recorder payload to a descriptive recorded event, or null if
// it carries nothing useful. Bounds every field to its contract limit.
export function browserEventFromPayload(payload: unknown): RecordedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as RecordPayload;
  const url = str(p.url, 2_048);
  const title = str(p.title, 300);
  const target = str(p.target, 300);
  const role = str(p.role, 80);
  const value = str(p.value, 2_000);
  if (p.type === "navigate") {
    if (!url && !title) return null;
    return { kind: "navigate", ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }
  if (p.type === "click") {
    if (!target) return null;
    return { kind: "click", target, ...(role ? { role } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }
  if (p.type === "fill") {
    if (!target) return null;
    return { kind: "type", target, ...(value ? { value } : {}), ...(url ? { url } : {}), ...(title ? { title } : {}) };
  }
  return null;
}

// Collapse recording noise: drop a navigate to the same place as the one before
// it, drop a click identical to the click just before it, and keep only the last
// edit when the same field is typed into repeatedly in a row. Pure for testing.
export function dedupeTrace(events: RecordedEvent[]): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && event.kind === "navigate" && prev.kind === "navigate" && prev.url === event.url && prev.title === event.title) {
      continue;
    }
    if (prev && event.kind === "click" && prev.kind === "click" && prev.target === event.target && prev.url === event.url) {
      continue;
    }
    if (prev && event.kind === "type" && prev.kind === "type" && prev.target === event.target) {
      out[out.length - 1] = event;
      continue;
    }
    out.push(event);
  }
  return out;
}
