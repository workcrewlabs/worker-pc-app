import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// Local desktop settings, persisted as a small JSON file in the per-user app
// data directory. The only user-facing setting is the backend URL: where the
// app sends sign in, billing, chat, and automation requests. Everything else
// (secret keys, provider names) stays on the backend, never here.

type DesktopSettings = {
  backendUrl?: string;
};

// The production cloud backend. Packaged installs talk to this by default.
// Development overrides it via the WORKCREW_API_URL environment variable.
const DEFAULT_BACKEND_URL = "https://workcrew-backend.onrender.com";

let cache: DesktopSettings | null = null;

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function load(): DesktopSettings {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(settingsPath(), "utf8")) as DesktopSettings;
  } catch {
    cache = {};
  }
  return cache;
}

// Validate and canonicalize a backend URL. Only http and https are allowed, and
// a trailing slash is stripped so paths concatenate cleanly.
export function normalizeBackendUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid web address, for example https://your-backend.onrender.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The backend address must start with http:// or https://");
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

/**
 * The backend URL the app should talk to. A user-saved value wins, then the
 * WORKCREW_API_URL environment variable (used in development and tests), then
 * the local default. Trailing slash removed.
 */
export function getBackendUrl(): string {
  const stored = load().backendUrl;
  const value = stored || process.env.WORKCREW_API_URL || DEFAULT_BACKEND_URL;
  return value.replace(/\/$/, "");
}

/** Persist a new backend URL after validating it, returning the stored value. */
export function setBackendUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  const next: DesktopSettings = { ...load(), backendUrl: normalized };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  cache = next;
  return normalized;
}

/** Whether the user has saved a custom backend URL (vs. the env or default). */
export function hasCustomBackendUrl(): boolean {
  return typeof load().backendUrl === "string" && load().backendUrl !== "";
}
