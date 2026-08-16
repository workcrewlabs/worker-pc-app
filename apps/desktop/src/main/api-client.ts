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
    }

    const payload = await response.json() as T & { error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(payload.error ?? "WorkCrew request failed"), { code: payload.code });
    return payload;
  }

  /**
   * A GET against a public backend route, with no token attached. Used for the
   * handful of facts a client needs before it has a session (how plans are paid
   * for, and the billing contact address). Never send anything user-specific
   * through here: the request carries no credential and proves nothing.
   */
  async requestPublic<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("WorkCrew request failed");
    return await response.json() as T;
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
