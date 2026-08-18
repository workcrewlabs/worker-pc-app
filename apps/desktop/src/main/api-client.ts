import type { AuthVault } from "./auth-vault.js";
import { getBackendUrl } from "./settings.js";

// Thrown when the session cannot be refreshed after a 401. The renderer treats
// this as a signal to return to the auth screen.
export class AuthExpiredError extends Error {
  readonly code = "AUTH_EXPIRED";
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
  }
}

/**
 * Whether a failure is worth trying once more.
 *
 * These are the answers that mean "nobody handled this", not "this was refused":
 * a gateway with no healthy instance behind it (502/503/504) while the service
 * restarts, or a request that timed out on the way. A 4xx is a decision about
 * the request itself and repeating it would only get the same decision, and 429
 * is explicitly being told to slow down, so retrying it is the one thing that
 * makes it worse.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 502 || status === 503 || status === 504;
}

/**
 * What to say when the backend did not answer in its own words.
 *
 * The user used to get the raw parse failure, "Unexpected token '<', "<!DOCTYPE"
 * ... is not valid JSON", which describes our code's disappointment rather than
 * anything they can act on. What actually happened is that something in front of
 * WorkCrew answered with a web page: an outage page, or the seconds during which
 * the service is restarting.
 */
export function backendUnavailableMessage(status: number): string {
  if (status === 0) return "Could not reach WorkCrew. Check your internet connection and try again.";
  if (isTransientStatus(status)) return "WorkCrew is briefly unavailable. Please try again in a moment.";
  if (status === 429) return "That was too many requests at once. Please wait a moment and try again.";
  return "WorkCrew could not complete that request. Please try again.";
}

/** How long to wait before the single retry. Long enough to let a restarting
 *  service finish coming up, short enough that nobody watches a spinner over
 *  it. */
export const RETRY_DELAY_MS = 1_200;

export class ApiClient {
  // Resolved per request so a backend URL saved in Settings takes effect without
  // an app restart.
  private get baseUrl(): string {
    return getBackendUrl();
  }

  constructor(private readonly auth: AuthVault) {}

  async request<T>(path: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new AuthExpiredError("Sign in is required");

    let response = await this.send(path, options, token);

    // On a 401 the access token is stale or revoked. Refresh once and retry. If
    // the refresh itself fails the session is unrecoverable, so surface an auth
    // error that sends the renderer back to the auth screen.
    if (response.status === 401) {
      let fresh: string;
      try {
        fresh = await this.auth.refresh();
      } catch {
        throw new AuthExpiredError();
      }
      response = await this.send(path, options, fresh);
      if (response.status === 401) throw new AuthExpiredError();
      // Every later step uses the refreshed token.
      return this.resolve<T>(response, path, options, fresh);
    }

    return this.resolve<T>(response, path, options, token);
  }

  /**
   * Turn a response into the answer, retrying once when nothing actually
   * handled it.
   *
   * A restart takes seconds, and losing a whole run to those seconds is the
   * failure the user sees. One retry covers it without pretending a refusal is
   * a hiccup: only the statuses that mean "unhandled" are tried again.
   */
  private async resolve<T>(
    response: Response,
    path: string,
    options: { method?: string; body?: unknown; timeoutMs?: number },
    token: string
  ): Promise<T> {
    const first = await this.readBody<T>(response);
    if (first.ok) return first.payload as T;
    if (!first.retryable) throw first.error;

    await new Promise((settle) => setTimeout(settle, RETRY_DELAY_MS));
    let retried: Response;
    try {
      retried = await this.send(path, options, token);
    } catch {
      throw first.error; // still unreachable: report the original failure
    }
    const second = await this.readBody<T>(retried);
    if (second.ok) return second.payload as T;
    throw second.error;
  }

  /**
   * Read a response as the JSON it should be, or as the failure it is.
   *
   * The body is read as text first, deliberately. Calling response.json()
   * straight out threw a raw SyntaxError whenever anything other than WorkCrew
   * answered, and that error travelled all the way to the user mid-task.
   */
  private async readBody<T>(response: Response): Promise<
    { ok: true; payload: T } | { ok: false; error: Error; retryable: boolean }
  > {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return {
        ok: false,
        retryable: isTransientStatus(response.status),
        error: Object.assign(new Error(backendUnavailableMessage(response.status)), { code: "BACKEND_UNAVAILABLE" })
      };
    }

    let payload: (T & { error?: string; code?: string }) | null = null;
    try {
      payload = text ? JSON.parse(text) as T & { error?: string; code?: string } : null;
    } catch {
      payload = null;
    }

    // Not JSON at all: a proxy, an outage page, or a service still starting.
    // Never surface the page itself, which can run to kilobytes of markup.
    if (payload === null) {
      return {
        ok: false,
        retryable: isTransientStatus(response.status) || response.ok,
        error: Object.assign(new Error(backendUnavailableMessage(response.status)), { code: "BACKEND_UNAVAILABLE" })
      };
    }

    if (response.ok) return { ok: true, payload: payload as T };
    return {
      ok: false,
      // WorkCrew answered in its own words, so this is a decision, not a hiccup.
      retryable: false,
      error: Object.assign(new Error(payload.error ?? "WorkCrew request failed"), { code: payload.code })
    };
  }

  /**
   * A GET against a public backend route, with no token attached. Used for the
   * handful of facts a client needs before it has a session (how plans are paid
   * for, and the billing contact address). Never send anything user-specific
   * through here: the request carries no credential and proves nothing.
   */
  async requestPublic<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(backendUnavailableMessage(response.status)), { code: "BACKEND_UNAVAILABLE" });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw Object.assign(new Error(backendUnavailableMessage(response.status)), { code: "BACKEND_UNAVAILABLE" });
    }
  }

  private send(path: string, options: { method?: string; body?: unknown; timeoutMs?: number }, token: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // A planning step on a large project genuinely thinks for a while, and
      // aborting it kills the whole run with a timeout the user can do nothing
      // about. Callers that plan pass a longer one; everything else keeps this.
      signal: AbortSignal.timeout(options.timeoutMs ?? 75_000)
    });
  }
}
