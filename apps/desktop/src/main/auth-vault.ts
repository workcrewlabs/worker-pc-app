import { readFile, rm, writeFile } from "node:fs/promises";
import { app, safeStorage } from "electron";
import { getBackendUrl } from "./settings.js";

// The session shape returned by the WorkCrew auth backend. The vault stores this
// verbatim (encrypted) so a refresh or sign-out can be performed on next launch.
export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  userId: string;
  email: string;
  name: string | null;
};

type AuthResponse = {
  session?: StoredSession;
  needsVerification?: boolean;
  error?: string;
  code?: string;
};

export class AuthVault {
  private session: StoredSession | null = null;
  // A single shared in-flight refresh. The refresh token is single-use, so if two
  // callers exchanged it at the same time the backend would see it reused and
  // revoke the whole session. Coalescing guarantees one exchange per cycle.
  private refreshInFlight: Promise<string> | null = null;

  // Resolved per request so a backend URL saved in Settings takes effect without
  // an app restart.
  private get baseUrl(): string {
    return getBackendUrl();
  }

  private get filePath(): string {
    return `${app.getPath("userData")}\\session.bin`;
  }

  // Load any previously stored session from disk. The session is encrypted with
  // Electron safeStorage, which is bound to the OS user account.
  async load(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = await readFile(this.filePath);
      this.session = JSON.parse(safeStorage.decryptString(encrypted)) as StoredSession;
    } catch {
      this.session = null;
    }
  }

  // The renderer only ever learns whether a session exists and which email it
  // belongs to. It never receives the tokens. A stored session that is expired
  // but still has a refresh token counts as authenticated, because the next API
  // call will refresh it transparently.
  getSession(): { authenticated: boolean; email?: string; name?: string | null } {
    return { authenticated: Boolean(this.session), email: this.session?.email, name: this.session?.name ?? null };
  }

  // Update just the display name on the stored session after the backend profile
  // update succeeds, so the renderer reflects the new name without a re-login.
  async updateStoredName(name: string | null): Promise<void> {
    if (this.session) await this.store({ ...this.session, name });
  }

  // The internal user id of the current session. Used only as a privacy-safe
  // analytics identity (never the email) and never sent to the renderer. Null
  // when signed out.
  getUserId(): string | null {
    return this.session?.userId ?? null;
  }

  // Return a usable access token for the API client, refreshing first if the
  // stored token is within one minute of expiry. Returns null when there is no
  // session at all (the renderer should then show the auth screen).
  async getAccessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (this.session.expiresAtMs <= Date.now() + 60_000) {
      try {
        return await this.refresh();
      } catch {
        return this.session?.accessToken ?? null;
      }
    }
    return this.session.accessToken;
  }

  private async request(path: string, body: unknown): Promise<AuthResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json() as AuthResponse;
    if (!response.ok) {
      throw Object.assign(new Error(payload.error ?? "Authentication failed"), { code: payload.code });
    }
    return payload;
  }

  private async store(session: StoredSession): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable");
    this.session = session;
    await writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 });
  }

  async signIn(email: string, password: string): Promise<void> {
    const payload = await this.request("/v1/auth/sign-in", { email, password });
    if (!payload.session) throw new Error("Sign in did not return a session");
    await this.store(payload.session);
  }

  async signUp(email: string, password: string, name?: string, referralCode?: string): Promise<{ needsVerification: boolean }> {
    const payload = await this.request("/v1/auth/sign-up", { email, password, name, referralCode });
    // When verification is required the backend returns no session. Otherwise it
    // returns a session and the user proceeds straight to the paywall.
    if (payload.session) await this.store(payload.session);
    return { needsVerification: payload.needsVerification === true || !payload.session };
  }

  async sendPasswordReset(email: string): Promise<void> {
    await this.request("/v1/auth/reset", { email });
  }

  // Ask the backend to re-send the email-verification link (for when the original
  // link expired). The backend always responds ok, so this never reveals whether
  // the address has an account.
  async resendVerification(email: string): Promise<void> {
    await this.request("/v1/auth/resend-verification", { email });
  }

  // POST the stored refresh token, persist the new session, and return the new
  // access token. The API client calls this on a 401 to retry once, and
  // getAccessToken() calls it when the token is near expiry. Both share ONE
  // in-flight exchange: a burst of API calls on startup (common right after an
  // auto-update, once the 1-hour access token has expired) would otherwise each
  // send the same single-use refresh token, which the backend treats as reuse and
  // revokes the session, signing the user out on every update. Coalescing sends
  // the token exactly once; every concurrent caller awaits the same result.
  async refresh(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<string> {
    if (!this.session) throw new Error("Sign in is required");
    const payload = await this.request("/v1/auth/refresh", { refreshToken: this.session.refreshToken });
    if (!payload.session) throw new Error("Refresh did not return a session");
    await this.store(payload.session);
    return payload.session.accessToken;
  }

  async signOut(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    if (refreshToken) {
      try {
        await this.request("/v1/auth/sign-out", { refreshToken });
      } catch {
        // The local session is cleared regardless of the server result.
      }
    }
    this.session = null;
    await rm(this.filePath, { force: true });
  }
}
