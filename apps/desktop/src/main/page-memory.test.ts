import { describe, expect, it } from "vitest";
import { FOLLOW_UP_TURNS, MAX_CONVERSATIONS, PageMemory, REMEMBER_FOR_MS } from "./page-memory";

// The failure this exists for: the user pasted a link, the app read it, and
// then the very next question, "tell me whats in the link", was answered with
// "I do not actually have the contents of that page". The page had been read
// into that turn's context, and context does not survive the turn it came with.

const NOW = 1_700_000_000_000;
const CHAT = "6f1c6f2a-0000-4000-8000-000000000001";
const OTHER = "6f1c6f2a-0000-4000-8000-000000000002";

describe("keeping a page for the questions that follow it", () => {
  it("gives the page back on the next turn", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "PAGE", NOW);
    expect(memory.recall(CHAT, NOW + 1_000)?.block).toBe("PAGE");
  });

  it("does not hand one conversation's page to another", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "PAGE", NOW);
    expect(memory.recall(OTHER, NOW + 1_000)).toBeNull();
  });

  it("has nothing to give when no link was ever read", () => {
    expect(new PageMemory().recall(CHAT, NOW)).toBeNull();
  });

  it("fades out instead of following the conversation forever", () => {
    // A page kept indefinitely would be paid for on every later request and
    // would end up answering questions that have nothing to do with it.
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "PAGE", NOW);
    for (let turn = 0; turn < FOLLOW_UP_TURNS; turn += 1) {
      expect(memory.recall(CHAT, NOW)).not.toBeNull();
    }
    expect(memory.recall(CHAT, NOW)).toBeNull();
  });

  it("forgets a page the conversation left behind long ago", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "PAGE", NOW);
    expect(memory.recall(CHAT, NOW + REMEMBER_FOR_MS + 1)).toBeNull();
  });

  it("replaces the page when the user pastes a different link", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "FIRST", NOW);
    memory.remember(CHAT, "https://example.com/b", "SECOND", NOW);
    expect(memory.recall(CHAT, NOW)?.block).toBe("SECOND");
  });

  it("starts the count again for the new link", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "FIRST", NOW);
    memory.recall(CHAT, NOW);
    memory.recall(CHAT, NOW);
    memory.remember(CHAT, "https://example.com/b", "SECOND", NOW);
    for (let turn = 0; turn < FOLLOW_UP_TURNS; turn += 1) {
      expect(memory.recall(CHAT, NOW)?.block).toBe("SECOND");
    }
  });
});

describe("a link pasted as the very first message of a chat", () => {
  // This is the case the user actually hit. A new chat has no conversation id
  // until the backend creates one and reports it back, so the page read on that
  // first turn has nothing to be filed under until the turn finishes.
  it("is filed under the conversation once the backend names it", () => {
    const memory = new PageMemory();
    memory.remember(undefined, "https://example.com/a", "PAGE", NOW);
    expect(memory.recall(CHAT, NOW)).toBeNull();

    memory.adopt(CHAT, NOW);
    expect(memory.recall(CHAT, NOW)?.block).toBe("PAGE");
  });

  it("is adopted only once, so a second chat does not inherit it", () => {
    const memory = new PageMemory();
    memory.remember(undefined, "https://example.com/a", "PAGE", NOW);
    memory.adopt(CHAT, NOW);
    memory.adopt(OTHER, NOW);
    expect(memory.recall(OTHER, NOW)).toBeNull();
  });

  it("never overwrites a page the conversation already has", () => {
    // A turn that finishes late must not replace something read since.
    const memory = new PageMemory();
    memory.remember(undefined, "https://example.com/old", "OLD", NOW);
    memory.remember(CHAT, "https://example.com/new", "NEW", NOW);
    memory.adopt(CHAT, NOW);
    expect(memory.recall(CHAT, NOW)?.block).toBe("NEW");
  });

  it("is dropped if the turn took longer than the page is kept for", () => {
    const memory = new PageMemory();
    memory.remember(undefined, "https://example.com/a", "PAGE", NOW);
    memory.adopt(CHAT, NOW + REMEMBER_FOR_MS + 1);
    expect(memory.recall(CHAT, NOW + REMEMBER_FOR_MS + 1)).toBeNull();
  });
});

describe("not growing without limit", () => {
  it("keeps only the most recent conversations", () => {
    const memory = new PageMemory();
    for (let index = 0; index < MAX_CONVERSATIONS + 4; index += 1) {
      memory.remember(`chat-${index}`, "https://example.com/a", `PAGE ${index}`, NOW + index);
    }
    expect(memory.size()).toBe(MAX_CONVERSATIONS);
    expect(memory.recall("chat-0", NOW)).toBeNull();
    expect(memory.recall(`chat-${MAX_CONVERSATIONS + 3}`, NOW)).not.toBeNull();
  });

  it("drops a page on request", () => {
    const memory = new PageMemory();
    memory.remember(CHAT, "https://example.com/a", "PAGE", NOW);
    memory.forget(CHAT);
    expect(memory.recall(CHAT, NOW)).toBeNull();
  });
});
