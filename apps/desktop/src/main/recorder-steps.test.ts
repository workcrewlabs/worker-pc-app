import { describe, expect, it } from "vitest";
import type { RecordedEvent } from "@workcrew/contracts";
import { browserEventFromPayload, dedupeTrace } from "./recorder-steps";

describe("browserEventFromPayload", () => {
  it("maps a click payload to a descriptive click event", () => {
    expect(browserEventFromPayload({ type: "click", target: "Compose", role: "button", url: "https://mail.google.com", title: "Inbox" })).toEqual({
      kind: "click",
      target: "Compose",
      role: "button",
      url: "https://mail.google.com",
      title: "Inbox"
    });
  });

  it("maps a fill payload to a type event with its value", () => {
    expect(browserEventFromPayload({ type: "fill", target: "Search mail", value: "invoice" })).toEqual({
      kind: "type",
      target: "Search mail",
      value: "invoice"
    });
  });

  it("maps a navigate payload to a navigate event", () => {
    expect(browserEventFromPayload({ type: "navigate", url: "https://mail.google.com", title: "Inbox" })).toEqual({
      kind: "navigate",
      url: "https://mail.google.com",
      title: "Inbox"
    });
  });

  it("ignores payloads with no useful content or an unknown type", () => {
    expect(browserEventFromPayload({ type: "click" })).toBeNull();
    expect(browserEventFromPayload({ type: "navigate" })).toBeNull();
    expect(browserEventFromPayload({ type: "scroll", target: "x" })).toBeNull();
    expect(browserEventFromPayload(null)).toBeNull();
    expect(browserEventFromPayload("nope")).toBeNull();
  });
});

describe("dedupeTrace", () => {
  it("collapses consecutive identical clicks and navigates", () => {
    const events: RecordedEvent[] = [
      { kind: "navigate", url: "https://x.com", title: "X" },
      { kind: "navigate", url: "https://x.com", title: "X" },
      { kind: "click", target: "Open", url: "https://x.com" },
      { kind: "click", target: "Open", url: "https://x.com" },
      { kind: "click", target: "Next", url: "https://x.com" }
    ];
    expect(dedupeTrace(events)).toEqual([
      { kind: "navigate", url: "https://x.com", title: "X" },
      { kind: "click", target: "Open", url: "https://x.com" },
      { kind: "click", target: "Next", url: "https://x.com" }
    ]);
  });

  it("keeps only the last value when one field is typed into repeatedly in a row", () => {
    const events: RecordedEvent[] = [
      { kind: "type", target: "Search", value: "1" },
      { kind: "type", target: "Search", value: "12" },
      { kind: "type", target: "Search", value: "123" }
    ];
    expect(dedupeTrace(events)).toEqual([{ kind: "type", target: "Search", value: "123" }]);
  });

  it("leaves a non-consecutive repeat and distinct events intact", () => {
    const events: RecordedEvent[] = [
      { kind: "navigate", url: "https://example.com", title: "E" },
      { kind: "click", target: "A", url: "https://example.com" },
      { kind: "type", target: "Q", value: "x" },
      { kind: "click", target: "A", url: "https://example.com" }
    ];
    expect(dedupeTrace(events)).toHaveLength(4);
  });
});
