import { getAnalyticsDeviceId, getAnalyticsOptOut } from "./settings.js";
import type { AnalyticsProps } from "../shared/analytics-events.js";

// Desktop product analytics via PostHog cloud, capture-only over HTTP from the
// MAIN process. Doing the network here (not the renderer) means there is no
// renderer CSP to relax and the key is never handled in page context.
//
// Privacy first: only event names and safe, low-cardinality properties are sent.
// Never prompt text, file contents, screenshots, secrets, tokens, passwords, or
// email. The distinct id is the internal user id after login (passed in by the
// caller) or an anonymous per-install device id; identity is set only after a
// successful login.
//
// No-op unless a PUBLIC PostHog project key is configured and the user has not
// opted out. The project key is public/write-only; there is no analytics secret.

// The public PostHog project key. Read from the environment in development; for a
// packaged build, set WORKCREW_POSTHOG_KEY at build time or paste the public
// "phc_..." key here. Empty means analytics is disabled.
const POSTHOG_KEY = process.env.WORKCREW_POSTHOG_KEY ?? "";
const POSTHOG_HOST = (process.env.WORKCREW_POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
const DISABLED_BY_ENV = process.env.WORKCREW_ANALYTICS_DISABLED === "true";

/** Whether analytics should run: a key is set, not disabled, and not opted out. */
export function analyticsEnabled(): boolean {
  return POSTHOG_KEY.length > 0 && !DISABLED_BY_ENV && !getAnalyticsOptOut();
}

/** The anonymous distinct id for events before login. */
export function deviceId(): string {
  return getAnalyticsDeviceId();
}

function send(body: unknown): void {
  void fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000)
  }).catch(() => {
    // Best effort only; a failed analytics call must never affect the app.
  });
}

/** Capture one safe product event for the given distinct id. */
export function capture(distinctId: string, event: string, properties: AnalyticsProps = {}): void {
  if (!analyticsEnabled()) return;
  send({
    api_key: POSTHOG_KEY,
    event,
    distinct_id: distinctId,
    properties: { ...properties, $lib: "workcrew-desktop" }
  });
}

/**
 * After a successful login, link the anonymous device id to the internal user id
 * so events before and after sign-in belong to the same person. Never sends the
 * email, only the internal id.
 */
export function identify(userId: string): void {
  if (!analyticsEnabled() || !userId) return;
  send({
    api_key: POSTHOG_KEY,
    event: "$identify",
    distinct_id: userId,
    properties: { $anon_distinct_id: getAnalyticsDeviceId(), $lib: "workcrew-desktop" }
  });
}
