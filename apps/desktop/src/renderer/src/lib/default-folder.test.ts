import { beforeEach, describe, expect, it } from "vitest";
import { loadDefaultFolder, saveDefaultFolder } from "./storage";

// The default folder exists so opening the app is enough to be back in the
// project: the last folder the user chose is what a new chat opens in, and
// taking the folder off gives the default up. These tests pin that remembering,
// that giving up, and the validation that keeps a hand-edited localStorage value
// from ever becoming a run's working directory.

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

describe("the default working folder", () => {
  it("remembers the last folder the user chose", () => {
    saveDefaultFolder({ path: "D:\\invoices", name: "invoices" });
    expect(loadDefaultFolder()).toEqual({ path: "D:\\invoices", name: "invoices" });
  });

  it("is replaced, not collected: only the newest choice is the default", () => {
    saveDefaultFolder({ path: "D:\\a", name: "a" });
    saveDefaultFolder({ path: "D:\\b", name: "b" });
    expect(loadDefaultFolder()?.path).toBe("D:\\b");
  });

  it("is given up when the folder is taken off", () => {
    saveDefaultFolder({ path: "D:\\invoices", name: "invoices" });
    saveDefaultFolder(null);
    expect(loadDefaultFolder()).toBeNull();
  });

  it("returns nothing until a folder has been chosen", () => {
    expect(loadDefaultFolder()).toBeNull();
  });
});

describe("a stored value nobody wrote through the app", () => {
  // localStorage is readable and writable by anything in the renderer, so a
  // corrupted or hand-edited entry must be dropped, not trusted with a path
  // the engine would then run commands inside.
  function plant(raw: string): void {
    window.localStorage.setItem("workcrew:v1:defaultFolder", raw);
  }

  it("rejects a value that is not a folder at all", () => {
    plant(JSON.stringify({ path: 42, name: [] }));
    expect(loadDefaultFolder()).toBeNull();
    plant("not json");
    expect(loadDefaultFolder()).toBeNull();
  });

  it("rejects a folder with no path", () => {
    plant(JSON.stringify({ path: "", name: "somewhere" }));
    expect(loadDefaultFolder()).toBeNull();
  });

  it("bounds what it accepts, so an oversized path cannot ride in", () => {
    plant(JSON.stringify({ path: `C:\\${"x".repeat(5_000)}`, name: "x" }));
    expect(loadDefaultFolder()).toBeNull();
    plant(JSON.stringify({ path: "D:\\fine", name: "y".repeat(5_000) }));
    expect(loadDefaultFolder()).toBeNull();
  });
});

describe("when storage cannot be written", () => {
  it("survives a quota error rather than taking the app down", () => {
    window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(() => saveDefaultFolder({ path: "D:\\a", name: "a" })).not.toThrow();
    expect(loadDefaultFolder()).toBeNull();
  });
});
