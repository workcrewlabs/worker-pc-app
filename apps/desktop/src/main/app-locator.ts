import { readdirSync } from "node:fs";
import { join } from "node:path";

// Finds an installed app's Start Menu or desktop shortcut from its everyday name
// ("Adminsoft Accounts", "Spotify"). Windows itself launches installed programs
// through these shortcuts, and a shortcut records the app's own start folder, so
// opening the shortcut is the most faithful equivalent of the user double-clicking
// the app. This module is pure Node (no Electron imports) so it can be unit tested.

export type ShortcutCandidate = { name: string; path: string };

// Shortcuts whose name contains one of these words are almost never the app the
// user asked to open, so they only match when the request itself names them.
const HELPER_WORDS = new Set([
  "uninstall", "uninstaller", "remove", "setup", "install", "installer", "reinstall",
  "update", "updater", "autoupdate", "repair", "help", "readme", "manual",
  "documentation", "docs", "website", "homepage"
]);

// Filler words a request may add around an app's name ("adminsoft accounts app").
// A looser request-side match is only allowed when every extra word is one of
// these, so "excel file manager" can never resolve to a shortcut named "Excel".
const NOISE_WORDS = new Set(["app", "application", "software", "program", "the", "my", "a", "an"]);

// Launchable Start Menu entry types: regular shortcuts and ClickOnce app
// references, both of which open like a double-click.
const SHORTCUT_EXTENSION = /\.(lnk|appref-ms)$/i;

// Lowercase, drop a shortcut/exe extension, and reduce to space-separated words.
// "+" and "#" stay part of a word so "Notepad++" and "C#" never collide with
// their plainer namesakes.
export function normalizeAppName(value: string): string {
  return value
    .toLowerCase()
    .replace(SHORTCUT_EXTENSION, "")
    .replace(/\.exe$/i, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

function words(value: string): string[] {
  const normalized = normalizeAppName(value);
  return normalized ? normalized.split(" ") : [];
}

// How well a shortcut name matches the requested app name. 3 is an exact match,
// 2 means the shortcut contains every requested word ("adminsoft" finds
// "Adminsoft Accounts"), 1 means the request is the shortcut name plus filler
// words only ("adminsoft accounts app"), 0 is no match. Helper shortcuts
// (uninstallers, readmes, and the like) never match unless asked for by name.
export function scoreShortcutName(query: string, shortcutName: string): number {
  const queryWords = words(query);
  const nameWords = words(shortcutName);
  if (queryWords.length === 0 || nameWords.length === 0) return 0;
  const querySet = new Set(queryWords);
  if (nameWords.some((word) => HELPER_WORDS.has(word) && !querySet.has(word))) return 0;
  const nameSet = new Set(nameWords);
  if (queryWords.length === nameWords.length && queryWords.every((word) => nameSet.has(word))) return 3;
  if (queryWords.every((word) => nameSet.has(word))) return 2;
  if (queryWords.filter((word) => !NOISE_WORDS.has(word)).every((word) => nameSet.has(word))) return 1;
  return 0;
}

// Walk the given folders for launchable shortcuts. Start Menu trees are small,
// but the depth and entry caps keep a pathological folder from stalling a launch.
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5_000;

export function collectShortcuts(roots: string[]): ShortcutCandidate[] {
  const found: ShortcutCandidate[] = [];
  let entries = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || entries >= MAX_ENTRIES) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable or missing folder just contributes nothing
    }
    for (const item of items) {
      if (++entries > MAX_ENTRIES) return;
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (SHORTCUT_EXTENSION.test(item.name)) {
        found.push({ name: item.name.replace(SHORTCUT_EXTENSION, ""), path: full });
      }
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

// The folders Windows itself presents apps from: both Start Menus (per-user and
// all-users) and both desktops. Callers pass the real per-user desktop from
// Electron, since it can be redirected (for example into OneDrive).
export function defaultShortcutRoots(extraRoots: string[] = []): string[] {
  const roots: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (!candidate) return;
    if (roots.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) return;
    roots.push(candidate);
  };
  const env = process.env;
  if (env.APPDATA) add(join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"));
  if (env.ProgramData) add(join(env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"));
  for (const extra of extraRoots) add(extra);
  if (env.USERPROFILE) add(join(env.USERPROFILE, "Desktop"));
  if (env.PUBLIC) add(join(env.PUBLIC, "Desktop"));
  return roots;
}

// The best-matching shortcuts for the requested name, strongest first, empty when
// nothing plausibly matches. Ties prefer the name closest in word count to the
// request (then the shorter name), so "Adminsoft Accounts" beats "Adminsoft
// Accounts Data Tools" for the query "adminsoft accounts". Returning a short
// ranked list (not just the winner) lets the caller skip a stale shortcut whose
// target no longer exists and try the next one.
export function findAppShortcuts(query: string, roots: string[], limit = 3): ShortcutCandidate[] {
  const queryWordCount = words(query).length;
  const scored: { candidate: ShortcutCandidate; score: number; tiebreak: number }[] = [];
  for (const candidate of collectShortcuts(roots)) {
    const score = scoreShortcutName(query, candidate.name);
    if (score === 0) continue;
    const tiebreak = Math.abs(words(candidate.name).length - queryWordCount) * 1_000 + candidate.name.length;
    scored.push({ candidate, score, tiebreak });
  }
  scored.sort((a, b) => b.score - a.score || a.tiebreak - b.tiebreak);
  return scored.slice(0, limit).map((entry) => entry.candidate);
}
