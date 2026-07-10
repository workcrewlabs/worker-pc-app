import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectShortcuts,
  defaultShortcutRoots,
  findAppShortcuts,
  normalizeAppName,
  scoreShortcutName
} from "./app-locator";

describe("normalizeAppName", () => {
  it("lowercases, strips shortcut extensions, and collapses separators", () => {
    expect(normalizeAppName("Adminsoft Accounts.lnk")).toBe("adminsoft accounts");
    expect(normalizeAppName("My-App_v2.exe")).toBe("my app v2");
    expect(normalizeAppName("Contoso Ledger.appref-ms")).toBe("contoso ledger");
  });

  it("keeps + and # so symbol apps stay distinct from plain namesakes", () => {
    expect(normalizeAppName("Notepad++")).toBe("notepad++");
    expect(normalizeAppName("C# Tools")).toBe("c# tools");
  });
});

describe("scoreShortcutName", () => {
  it("ranks exact matches highest", () => {
    expect(scoreShortcutName("adminsoft accounts", "Adminsoft Accounts")).toBe(3);
    expect(scoreShortcutName("Adminsoft Accounts", "adminsoft accounts.lnk")).toBe(3);
  });

  it("matches when the shortcut has extra words (partial request)", () => {
    expect(scoreShortcutName("adminsoft", "Adminsoft Accounts")).toBe(2);
  });

  it("tolerates filler words like 'app' but nothing else", () => {
    expect(scoreShortcutName("adminsoft accounts app", "Adminsoft Accounts")).toBe(1);
    expect(scoreShortcutName("the spotify app", "Spotify")).toBe(1);
    // Real extra words mean a different app: never resolve them to a shorter name.
    expect(scoreShortcutName("excel file manager", "Excel")).toBe(0);
    expect(scoreShortcutName("word perfect", "Word")).toBe(0);
    expect(scoreShortcutName("sage 50 accounts", "Accounts")).toBe(0);
  });

  it("keeps symbol apps apart from their plain namesakes", () => {
    expect(scoreShortcutName("notepad++", "Notepad++")).toBe(3);
    expect(scoreShortcutName("notepad++", "Notepad")).toBe(0);
    expect(scoreShortcutName("notepad", "Notepad++")).toBe(0);
  });

  it("does not match unrelated names or same-vendor other tools", () => {
    expect(scoreShortcutName("adminsoft accounts", "Adminsoft Help")).toBe(0);
    expect(scoreShortcutName("word", "WordPad")).toBe(0);
    expect(scoreShortcutName("excel", "Excellent Notes")).toBe(0);
  });

  it("never matches uninstallers or helper shortcuts unless asked for", () => {
    expect(scoreShortcutName("adminsoft", "Uninstall Adminsoft")).toBe(0);
    expect(scoreShortcutName("adminsoft", "Adminsoft Readme")).toBe(0);
    expect(scoreShortcutName("foo", "Install Foo")).toBe(0);
    expect(scoreShortcutName("bar", "Bar AutoUpdate")).toBe(0);
    expect(scoreShortcutName("uninstall adminsoft", "Uninstall Adminsoft")).toBe(3);
  });
});

describe("findAppShortcuts", () => {
  // A fake Start Menu tree with the shapes seen on real machines: nested vendor
  // folders, uninstallers next to the app, and similarly named neighbors.
  const root = mkdtempSync(join(tmpdir(), "workcrew-shortcuts-"));
  const programs = join(root, "Programs");
  const vendor = join(programs, "Adminsoft");
  const desktop = join(root, "Desktop");
  mkdirSync(vendor, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(programs, "Notepad.lnk"), "");
  writeFileSync(join(programs, "Notepad++.lnk"), "");
  writeFileSync(join(vendor, "Adminsoft Accounts.lnk"), "");
  writeFileSync(join(vendor, "Uninstall Adminsoft Accounts.lnk"), "");
  writeFileSync(join(vendor, "Adminsoft Accounts Data Tools.lnk"), "");
  writeFileSync(join(desktop, "Adminsoft Accounts.lnk"), "");
  writeFileSync(join(desktop, "Contoso Reports.appref-ms"), "");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const best = (query: string, roots: string[]): string | undefined => findAppShortcuts(query, roots)[0]?.path;

  it("finds a nested Start Menu shortcut by its exact name", () => {
    expect(best("adminsoft accounts", [programs])).toBe(join(vendor, "Adminsoft Accounts.lnk"));
  });

  it("prefers the exact app over uninstallers and longer siblings", () => {
    expect(best("Adminsoft Accounts", [programs, desktop])).toBe(join(vendor, "Adminsoft Accounts.lnk"));
  });

  it("resolves a partial name to the closest shortcut", () => {
    expect(best("adminsoft", [programs])).toBe(join(vendor, "Adminsoft Accounts.lnk"));
  });

  it("tolerates trailing words like 'app' in the request", () => {
    expect(best("adminsoft accounts app", [programs])).toBe(join(vendor, "Adminsoft Accounts.lnk"));
  });

  it("never opens the plain namesake of a symbol app", () => {
    expect(best("notepad++", [programs])).toBe(join(programs, "Notepad++.lnk"));
    expect(best("notepad", [programs])).toBe(join(programs, "Notepad.lnk"));
  });

  it("finds ClickOnce app references too", () => {
    expect(best("contoso reports", [desktop])).toBe(join(desktop, "Contoso Reports.appref-ms"));
  });

  it("returns ranked alternates so a stale winner can be skipped", () => {
    const ranked = findAppShortcuts("adminsoft accounts", [programs, desktop]);
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked[1]?.name).toBe("Adminsoft Accounts");
  });

  it("returns nothing when no shortcut plausibly matches", () => {
    expect(findAppShortcuts("quickbooks", [programs, desktop])).toEqual([]);
    expect(findAppShortcuts("adminsoft accounts", [join(root, "missing")])).toEqual([]);
  });
});

describe("collectShortcuts", () => {
  it("ignores unreadable roots instead of throwing", () => {
    expect(collectShortcuts([join(tmpdir(), "workcrew-no-such-dir")])).toEqual([]);
  });
});

describe("defaultShortcutRoots", () => {
  it("includes extra roots once, without duplicates", () => {
    const extra = join(tmpdir(), "SomeDesktop");
    const roots = defaultShortcutRoots([extra, extra.toUpperCase()]);
    expect(roots.filter((r) => r.toLowerCase() === extra.toLowerCase())).toHaveLength(1);
  });
});
