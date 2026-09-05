/**
 * What a user is told when a chat turn fails.
 *
 * A failed turn used to hand the user whatever text the failure happened to
 * carry. When the connection to the model provider dropped, the answer to the
 * question they asked was the words "Connection error." That is the provider
 * library talking to itself: it names no cause the user could act on, and it
 * describes our plumbing rather than their message.
 *
 * The rule this encodes is the project's own: only errors raised deliberately
 * for a person are shown as written. Everything else is a fault on our side of
 * the line, so the user gets a plain sentence and a reason to try again, while
 * the detail goes to the log where it can be diagnosed.
 */

/**
 * An error we raised on purpose to be read by the user.
 *
 * Every deliberate one carries a `code` (BUDGET_EXHAUSTED, MODEL_UNAVAILABLE,
 * AUTH_REQUIRED, and so on). A provider library's own failures never do, which
 * is what makes this a reliable line rather than a guess about wording.
 */
export function isDeliberateMessage(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0;
}

/** The status a provider replied with, when it replied at all. */
function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

/** Whether the request never got an answer from the provider at all. */
function neverReachedTheProvider(error: unknown): boolean {
  const err = error as { name?: unknown; cause?: { code?: unknown } } | null;
  const name = typeof err?.name === "string" ? err.name : "";
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "APIUserAbortError") return true;
  const cause = typeof err?.cause?.code === "string" ? err.cause.code : "";
  return ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(cause);
}

/**
 * The sentence to show for a failed turn.
 *
 * Each one says what happened in the user's terms and whether trying again is
 * worth their time, because that is the only decision they have to make.
 */
export function chatFailureMessage(error: unknown): string {
  if (isDeliberateMessage(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  if (neverReachedTheProvider(error)) {
    return "WorkCrew could not reach the AI service just then. Please send that again.";
  }

  const status = statusOf(error);
  if (status === 429) return "The AI service is busy right now. Please wait a moment and send that again.";
  if (status >= 500 || status === 408) return "The AI service is briefly unavailable. Please send that again in a moment.";

  return "That message could not be completed. Please try again.";
}

/**
 * The detail kept for the log, never shown to the user.
 *
 * Names the failure precisely enough to diagnose it while carrying nothing
 * about the user, their message, or any key.
 */
export function chatFailureDetail(error: unknown): string {
  const err = error as { name?: unknown; message?: unknown; status?: unknown; cause?: { code?: unknown } } | null;
  const parts = [
    typeof err?.name === "string" ? err.name : "Error",
    typeof err?.status === "number" ? `status=${err.status}` : "",
    typeof err?.cause?.code === "string" ? `cause=${err.cause.code}` : "",
    typeof err?.message === "string" ? err.message.slice(0, 200) : ""
  ];
  return parts.filter(Boolean).join(" ");
}
