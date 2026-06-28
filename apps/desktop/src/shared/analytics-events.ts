// The exact set of product events the DESKTOP app may send. Shared by the main
// process (to allow-list incoming IPC events) and the renderer (to type every
// track() call) so the two cannot drift and no arbitrary event name can be sent.
//
// Privacy: these are event NAMES only. Properties are always safe, low-cardinality
// values (a plan name, a file extension, a coarse error category). Never prompt
// text, file contents, screenshots, secrets, tokens, or email.
//
// Server-authoritative events (login_succeeded, login_failed,
// subscription_status_checked, chat_message_sent) are sent by the backend, not
// from here, so they are intentionally absent from this list.
export const ANALYTICS_EVENTS = [
  "app_opened",
  "login_started",
  "automation_started",
  "automation_completed",
  "automation_failed",
  "file_download_card_shown",
  "file_download_clicked",
  "routine_created",
  "routine_deleted",
  "app_error"
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

// The only property value types we ever send. Keeps payloads small and safe.
export type AnalyticsProps = Record<string, string | number | boolean | null>;
