import { readFile, rm, writeFile } from "node:fs/promises";
import { app, safeStorage } from "electron";

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
};

type SupabaseSessionResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { email?: string };
  error_description?: string;
  msg?: string;
};

export class AuthVault {
  private session: StoredSession | null = null;
  private readonly apiUrl = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;

  private get filePath(): string {
    return `${app.getPath("userData")}\\session.bin`;
  }

  async load(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = await readFile(this.filePath);
      this.session = JSON.parse(safeStorage.decryptString(encrypted)) as StoredSession;
    } catch {
      this.session = null;
    }
  }

  getSession(): { authenticated: boolean; email?: string } {
    if (process.env.WORKCREW_DEV_AUTH === "true") return { authenticated: true, email: "local@workcrew.test" };
    return { authenticated: Boolean(this.session), email: this.session?.email };
  }

  async accessToken(): Promise<string | null> {
    if (process.env.WORKCREW_DEV_AUTH === "true") return "workcrew-local-development-only";
    if (!this.session) return null;
    if (this.session.expiresAt <= Date.now() + 60_000) await this.refresh();
    return this.session?.accessToken ?? null;
  }

  private requireSupabase(): { url: string; key: string } {
    if (!this.apiUrl || !this.anonKey) throw new Error("WorkCrew authentication is not configured");
    return { url: this.apiUrl.replace(/\/$/, ""), key: this.anonKey };
  }

  private async request(path: string, body: unknown, token?: string): Promise<SupabaseSessionResponse> {
    const { url, key } = this.requireSupabase();
    const response = await fetch(`${url}/auth/v1/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: key,
        authorization: `Bearer ${token ?? key}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json() as SupabaseSessionResponse;
    if (!response.ok) throw new Error(payload.error_description ?? payload.msg ?? "Authentication failed");
    return payload;
  }

  private async save(payload: SupabaseSessionResponse): Promise<void> {
    if (!payload.access_token || !payload.refresh_token) return;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable");
    this.session = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3_600) * 1_000,
      email: payload.user?.email
    };
    await writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(this.session)), { mode: 0o600 });
  }

  async signIn(email: string, password: string): Promise<void> {
    const payload = await this.request("token?grant_type=password", { email, password });
    await this.save(payload);
  }

  async signUp(email: string, password: string): Promise<{ needsVerification: boolean }> {
    const payload = await this.request("signup", { email, password });
    await this.save(payload);
    return { needsVerification: !payload.access_token };
  }

  async sendPasswordReset(email: string): Promise<void> {
    await this.request("recover", { email, redirect_to: "workcrew://auth/recovery" });
  }

  async updatePassword(password: string, recoveryToken: string): Promise<void> {
    await this.request("user", { password }, recoveryToken);
  }

  private async refresh(): Promise<void> {
    if (!this.session) return;
    const payload = await this.request("token?grant_type=refresh_token", { refresh_token: this.session.refreshToken });
    await this.save(payload);
  }

  async signOut(): Promise<void> {
    if (this.session) {
      try { await this.request("logout", {}, this.session.accessToken); } catch { /* Local revocation still proceeds. */ }
    }
    this.session = null;
    await rm(this.filePath, { force: true });
  }
}
