import type { AuthVault } from "./auth-vault.js";

export class ApiClient {
  private readonly baseUrl = (process.env.WORKCREW_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

  constructor(private readonly auth: AuthVault) {}

  async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.auth.accessToken();
    if (!token) throw new Error("Sign in is required");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(75_000)
    });
    const payload = await response.json() as T & { error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(payload.error ?? "WorkCrew request failed"), { code: payload.code });
    return payload;
  }
}
