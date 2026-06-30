import { createHash, randomBytes, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { localAuthProvider } from "./auth-local.js";
import { client, createEmailToken, createUser, getUserByEmail, initializeDatabase } from "./db.js";

function makeToken(): { raw: string; hash: string } {
  const raw = randomBytes(16).toString("hex");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

describe("email verification and password reset", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("verifyEmail marks the account verified and is single use", async () => {
    const email = `verify+${Date.now()}@workcrew.test`;
    const userId = randomUUID();
    await createUser({ id: userId, email, passwordHash: "x", passwordSalt: "y", emailVerified: false });
    const { raw, hash } = makeToken();
    await createEmailToken({ id: randomUUID(), userId, email, purpose: "verify", tokenHash: hash, expiresAtMs: Date.now() + 60_000 });

    const result = await localAuthProvider.verifyEmail(raw);
    expect(result.email).toBe(email);
    const user = await getUserByEmail(email);
    expect(user?.emailVerified).toBe(true);

    // The same link cannot be used a second time.
    await expect(localAuthProvider.verifyEmail(raw)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("rejects an expired verification link", async () => {
    const email = `expired+${Date.now()}@workcrew.test`;
    const userId = randomUUID();
    await createUser({ id: userId, email, passwordHash: "x", passwordSalt: "y", emailVerified: false });
    const { raw, hash } = makeToken();
    await createEmailToken({ id: randomUUID(), userId, email, purpose: "verify", tokenHash: hash, expiresAtMs: Date.now() - 1_000 });
    await expect(localAuthProvider.verifyEmail(raw)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("confirmReset sets a new password that signs in and retires the old one", async () => {
    const email = `reset+${Date.now()}@workcrew.test`;
    await localAuthProvider.signUp(email, "originalpass1");
    const user = await getUserByEmail(email);
    expect(user).toBeTruthy();

    const { raw, hash } = makeToken();
    await createEmailToken({ id: randomUUID(), userId: user!.id, email, purpose: "reset", tokenHash: hash, expiresAtMs: Date.now() + 60_000 });

    await localAuthProvider.confirmReset(raw, "brandnewpass9");
    await expect(localAuthProvider.signIn(email, "originalpass1")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    const session = await localAuthProvider.signIn(email, "brandnewpass9");
    expect(session.accessToken).toBeTruthy();
  });

  it("a reset token cannot be used as a verify token (purpose is enforced)", async () => {
    const email = `purpose+${Date.now()}@workcrew.test`;
    const userId = randomUUID();
    await createUser({ id: userId, email, passwordHash: "x", passwordSalt: "y", emailVerified: false });
    const { raw, hash } = makeToken();
    await createEmailToken({ id: randomUUID(), userId, email, purpose: "reset", tokenHash: hash, expiresAtMs: Date.now() + 60_000 });
    await expect(localAuthProvider.verifyEmail(raw)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("reset resolves whether or not the email exists, revealing nothing", async () => {
    await expect(localAuthProvider.reset(`missing+${Date.now()}@workcrew.test`)).resolves.toBeUndefined();
  });

  it("resendVerification issues a fresh, working verification link for an unverified account", async () => {
    const email = `resend+${Date.now()}@workcrew.test`;
    const userId = randomUUID();
    await createUser({ id: userId, email, passwordHash: "x", passwordSalt: "y", emailVerified: false });

    // The console email provider logs the link; capture it to prove the resent
    // link actually verifies the account end to end.
    const logs: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
    try {
      await localAuthProvider.resendVerification(email);
    } finally {
      spy.mockRestore();
    }

    const token = logs.join("\n").match(/\/v1\/auth\/verify\?token=([a-f0-9]+)/)?.[1];
    expect(token).toBeTruthy();
    const result = await localAuthProvider.verifyEmail(token!);
    expect(result.email).toBe(email);
    expect((await getUserByEmail(email))?.emailVerified).toBe(true);
  });

  it("resendVerification is a silent no-op for a verified account and for an unknown email", async () => {
    const email = `resend-verified+${Date.now()}@workcrew.test`;
    const userId = randomUUID();
    await createUser({ id: userId, email, passwordHash: "x", passwordSalt: "y", emailVerified: true });
    await expect(localAuthProvider.resendVerification(email)).resolves.toBeUndefined();
    await expect(localAuthProvider.resendVerification(`nobody+${Date.now()}@workcrew.test`)).resolves.toBeUndefined();
  });
});
