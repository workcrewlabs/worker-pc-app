import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SAVED_TURNS, loadTranscript, saveTranscript, trimTranscript } from "./storage";

// Messages kept disappearing. Only chat turns are stored on the server, so
// everything a task produced (its card, the work it did, the answer written
// straight into the transcript) lived in the window and died with it: closing
// the app, or letting it update, erased messages the user could read a moment
// earlier. The transcript is kept on this machine now.

// These tests run without a DOM, so storage is stubbed in memory. The contract
// exercised is the one the real thing has: string in, string out, and a setItem
// that can throw when the quota is gone.
function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear()
  };
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: makeStorage() };
});

describe("keeping a transcript on this machine", () => {
  it("comes back exactly as it was", () => {
    const turns = [
      { id: "1", role: "user", text: "open youtube" },
      { id: "2", role: "assistant", text: "", run: { task: "open youtube", status: "complete", summary: "Done.", steps: [] } }
    ];
    saveTranscript("home", turns);
    expect(loadTranscript("home")).toEqual(turns);
  });

  it("keeps the run cards, which the server never had", () => {
    // The whole reason for storing locally: a task is not a chat message and the
    // backend transcript has no idea it happened.
    saveTranscript("home", [{ id: "1", role: "assistant", text: "", run: { task: "t", status: "complete", summary: "s", steps: [{ id: "a", label: "Ran a command", status: "ok" }] } }]);
    const back = loadTranscript<{ run?: { steps: unknown[] } }>("home");
    expect(back[0]?.run?.steps).toHaveLength(1);
  });

  it("keeps conversations apart", () => {
    saveTranscript("home", [{ id: "1", role: "user", text: "first" }]);
    saveTranscript("other", [{ id: "2", role: "user", text: "second" }]);
    expect(loadTranscript<{ text: string }>("home")[0]?.text).toBe("first");
    expect(loadTranscript<{ text: string }>("other")[0]?.text).toBe("second");
  });

  it("returns nothing for a conversation never saved", () => {
    expect(loadTranscript("nothing-here")).toEqual([]);
  });

  it("forgets a conversation that has been emptied", () => {
    saveTranscript("home", [{ id: "1", role: "user", text: "hi" }]);
    saveTranscript("home", []);
    expect(loadTranscript("home")).toEqual([]);
  });

  it("survives storage being unavailable rather than taking the app down", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(() => saveTranscript("home", [{ id: "1", role: "user", text: "hi" }])).not.toThrow();
    window.localStorage.setItem = original;
  });
});

describe("what gets trimmed to make it fit", () => {
  it("keeps the newest turns when a conversation runs long", () => {
    const many = Array.from({ length: MAX_SAVED_TURNS + 40 }, (_, index) => ({ id: String(index), role: "user", text: `m${index}` }));
    const trimmed = trimTranscript(many);
    expect(trimmed).toHaveLength(MAX_SAVED_TURNS);
    // The newest survive: losing the start of a long chat beats losing the end.
    expect((trimmed[trimmed.length - 1] as { text: string }).text).toBe(`m${many.length - 1}`);
  });

  it("clips one enormous message rather than letting it fill the quota", () => {
    const trimmed = trimTranscript([{ id: "1", role: "assistant", text: "x".repeat(80_000) }]);
    expect((trimmed[0] as { text: string }).text.length).toBeLessThan(21_000);
  });

  it("never restores a turn still pretending to stream", () => {
    // Saved mid-answer, it would come back with a cursor blinking forever.
    const trimmed = trimTranscript([{ id: "1", role: "assistant", text: "half", streaming: true, thinking: "..." }]);
    expect(trimmed[0]).not.toHaveProperty("streaming");
    expect(trimmed[0]).not.toHaveProperty("thinking");
  });

  it("bounds the steps kept on a very long run", () => {
    const steps = Array.from({ length: 300 }, (_, index) => ({ id: String(index), label: "Ran a command", status: "ok" }));
    const trimmed = trimTranscript([{ id: "1", role: "assistant", text: "", run: { task: "t", status: "complete", summary: "s", steps } }]);
    const kept = (trimmed[0] as { run: { steps: unknown[] } }).run.steps;
    expect(kept.length).toBeLessThanOrEqual(40);
  });
});
