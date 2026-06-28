import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

// Local desktop settings, persisted as a small JSON file in the per-user app
// data directory. The only user-facing setting is the backend URL: where the
// app sends sign in, billing, chat, and automation requests. Everything else
// (secret keys, provider names) stays on the backend, never here.

type DesktopSettings = {
  backendUrl?: string;
  // A random per-install id used as the anonymous analytics distinct id before
  // login. Not tied to the machine, the OS user, or any personal data.
  analyticsDeviceId?: string;
  // When true, the user has opted out of anonymous product analytics.
  analyticsOptOut?: boolean;
};

// The production cloud backend. Packaged installs talk to this by default.
// Development overrides it via the WORKCREW_API_URL environment variable.
const DEFAULT_BACKEND_URL = "https://workcrew-backend.onrender.com";

// In a packaged production build the app must only ever talk to the official
// backend. Otherwise a tampered settings.json, or a user socially engineered into
// pasting a "new server" address, could point the app at an attacker host that
// harvests the login token. The allowlist is matched by ORIGIN (scheme, host,
// port). A developer testing a packaged build can opt out with the explicit
// WORKCREW_ALLOW_CUSTOM_BACKEND=1 environment override. Outside a packaged
// install (development, e2e, tests) any backend is allowed.
const ALLOWED_BACKEND_ORIGINS = [new URL(DEFAULT_BACKEND_URL).origin];

function isAllowedBackendUrl(raw: string): boolean {
  if (!app.isPackaged) return true;
  if (process.env.WORKCREW_ALLOW_CUSTOM_BACKEND === "1") return true;
  try {
    return ALLOWED_BACKEND_ORIGINS.includes(new URL(raw).origin);
  } catch {
    return false;
  }
}

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
  // Require https for any real host so login credentials and tokens are never
  // sent in clear text. Plain http is allowed only for a local loopback backend
  // used in development.
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("For your security the backend address must use https://");
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
  const candidate = stored || process.env.WORKCREW_API_URL || DEFAULT_BACKEND_URL;
  // Defense in depth: even if a disallowed URL reached settings.json or the env
  // on a packaged build, ignore it and fall back to the official backend rather
  // than send credentials somewhere untrusted.
  const value = isAllowedBackendUrl(candidate) ? candidate : DEFAULT_BACKEND_URL;
  return value.replace(/\/$/, "");
}

/** Persist a new backend URL after validating it, returning the stored value. */
export function setBackendUrl(raw: string): string {
  const normalized = normalizeBackendUrl(raw);
  if (!isAllowedBackendUrl(normalized)) {
    throw new Error("This build connects only to the official WorkCrew backend.");
  }
  const next: DesktopSettings = { ...load(), backendUrl: normalized };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  cache = next;
  return normalized;
}

/** Whether the user has saved a custom backend URL (vs. the env or default). */
export function hasCustomBackendUrl(): boolean {
  return typeof load().backendUrl === "string" && load().backendUrl !== "";
}

function persist(next: DesktopSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  cache = next;
}

/**
 * The anonymous analytics device id, created and persisted on first use. This is
 * a plain random id, not derived from any hardware, account, or personal data.
 */
export function getAnalyticsDeviceId(): string {
  const current = load();
  if (current.analyticsDeviceId && current.analyticsDeviceId.length > 0) return current.analyticsDeviceId;
  const id = randomUUID();
  persist({ ...current, analyticsDeviceId: id });
  return id;
}

/** Whether the user has opted out of anonymous product analytics. */
export function getAnalyticsOptOut(): boolean {
  return load().analyticsOptOut === true;
}

/** Persist the analytics opt-out choice, returning the stored value. */
export function setAnalyticsOptOut(value: boolean): boolean {
  persist({ ...load(), analyticsOptOut: value === true });
  return value === true;
}
