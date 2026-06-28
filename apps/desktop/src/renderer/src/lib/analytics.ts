import type { AnalyticsEvent, AnalyticsProps } from "../../../shared/analytics-events";

// The single place the renderer records product analytics. Every UI tracking
// call goes through track()/identifyUser() so what is captured stays centralized
// and easy to audit. The actual send happens in the main process (which attaches
// identity and the PostHog key); this is just a thin, fail-safe bridge.
//
// Privacy: only pass safe, low-cardinality properties (a plan name, a file
// extension, a coarse category). Never pass prompt text, file contents, file
// names, error messages, secrets, tokens, or email.

// Fire-and-forget. Guarded so it is a harmless no-op in any context without the
// desktop bridge (tests, a stripped build) and so analytics can never throw into
// the UI.
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  try {
    void window.workcrew?.analytics?.capture(event, props);
  } catch {
    // Ignore: analytics must never affect the user experience.
  }
}

// Identify the signed-in user (by internal id, handled in main) after a
// successful login, so pre- and post-login events belong to the same person.
export function identifyUser(): void {
  try {
    void window.workcrew?.analytics?.identify();
  } catch {
    // Ignore.
  }
}
