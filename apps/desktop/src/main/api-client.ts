import type { AuthVault } from "./auth-vault.js";

// Thrown when the session cannot be refreshed after a 401. The renderer treats
// this as a signal to return to the auth screen.
export class AuthExpiredError extends Error {
  readonly code = "AUTH_EXPIRED";
  constructor(message = "Your session has expired. Please sign in again.") {
    super(message);
  }
}

export class ApiClient {
  private readonly baseUrl = (process.env.WORKCREW_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

  constructor(private readonly auth: AuthVault) {}

  async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
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

  private send(path: string, options: { method?: string; body?: unknown }, token: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(75_000)
    });
  }
}
