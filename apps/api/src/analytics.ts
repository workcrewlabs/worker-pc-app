import { config } from "./config.js";

// Server-side product analytics via PostHog cloud, capture-only over HTTP (no SDK
// dependency, in keeping with the project's least-dependency rule).
//
// Privacy first: we send event NAMES and a few safe, low-cardinality properties,
// keyed by the verified user id. We never send prompt text, file contents,
// screenshots, secrets, API keys, tokens, passwords, or email. There is no
// analytics secret; the PostHog project key is write-only/public.
//
// Every call is fire-and-forget and swallows its own errors, so analytics can
// never slow down or break a request. It is a no-op unless a key is configured
// and WORKCREW_ANALYTICS_DISABLED is not set.

type AnalyticsProps = Record<string, string | number | boolean | null>;

export function analyticsEnabled(): boolean {
  return config.analytics.enabled && Boolean(config.analytics.key);
}

function send(body: unknown): void {
  void fetch(`${config.analytics.host}/capture/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000)
  }).catch(() => {
    // Best effort only. A failed analytics call must never surface to the caller.
  });
}

/** Capture an event for a known user, keyed by their internal user id. */
export function captureEvent(distinctId: string, event: string, properties: AnalyticsProps = {}): void {
  if (!analyticsEnabled()) return;
  send({
    api_key: config.analytics.key,
    event,
    distinct_id: distinctId,
    properties: { ...properties, $lib: "workcrew-backend" }
  });
}

/**
 * Capture an event with no identified user (for example a failed login before any
 * identity is known). Uses a single shared anonymous id rather than anything
 * derived from the request, so no email or IP is ever sent.
 */
export function captureAnonymous(event: string, properties: AnalyticsProps = {}): void {
  captureEvent("anonymous", event, properties);
}

/**
 * Reduce an arbitrary thrown value to a coarse, non-sensitive category so an
 * error event can never leak a message that might contain identifiers or input.
 * Prefers an uppercase error code, then an HTTP status, then the error class.
 */
export function safeErrorCategory(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,39}$/.test(code)) return code;
  const status = Number((error as { statusCode?: unknown })?.statusCode);
  if (Number.isFinite(status) && status >= 100 && status < 600) return `http_${status}`;
  if (error instanceof Error && error.name) return error.name;
  return "unknown";
}
