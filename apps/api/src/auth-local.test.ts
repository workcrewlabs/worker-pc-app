import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { localAuthProvider } from "./auth-local.js";
import { config } from "./config.js";
import { client, initializeDatabase } from "./db.js";

// A fresh, unique email per test so the suite never collides with other rows in
// the shared local database file.
function uniqueEmail(): string {
  return `user_${randomUUID()}@example.com`;
}

const PASSWORD = "correct horse battery"; // 21 chars, satisfies the 10 minimum.

describe("local auth provider", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("signs up then signs in and issues a verifiable access token", async () => {
    const email = uniqueEmail();
    const signUp = await localAuthProvider.signUp(email, PASSWORD);
    expect(signUp.needsVerification).toBe(false);
    if (!signUp.session) throw new Error("expected a session when verification is off");
    expect(signUp.session.email).toBe(email);
    expect(signUp.session.userId).toMatch(/[0-9a-f-]{36}/);
    expect(signUp.session.expiresAtMs).toBeGreaterThan(Date.now());

    // The access token must be a valid HS256 token signed with the server secret
    // and carry the user id as the sub claim.
    const secret = new TextEncoder().encode(config.localAuthSecret);
    const verified = await jwtVerify(signUp.session.accessToken, secret, { algorithms: ["HS256"] });
    expect(verified.payload.sub).toBe(signUp.session.userId);
    expect(verified.payload.email).toBe(email);

    const signIn = await localAuthProvider.signIn(email, PASSWORD);
    expect(signIn.userId).toBe(signUp.session.userId);
    expect(signIn.refreshToken).not.toBe(signUp.session.refreshToken);
  });

  it("rejects a duplicate email with EMAIL_IN_USE", async () => {
    const email = uniqueEmail();
    await localAuthProvider.signUp(email, PASSWORD);
    await expect(localAuthProvider.signUp(email, PASSWORD)).rejects.toMatchObject({
      code: "EMAIL_IN_USE",
      statusCode: 409
    });
  });

  it("rejects a wrong password without revealing which field was wrong", async () => {
    const email = uniqueEmail();
    await localAuthProvider.signUp(email, PASSWORD);
    await expect(localAuthProvider.signIn(email, "wrong password longer")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      statusCode: 401
    });
  });

  it("rejects an unknown email with the same INVALID_CREDENTIALS code", async () => {
    await expect(localAuthProvider.signIn(uniqueEmail(), PASSWORD)).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      statusCode: 401
    });
  });

  it("rotates refresh tokens on each refresh", async () => {
    const email = uniqueEmail();
    const { session } = await localAuthProvider.signUp(email, PASSWORD);
    if (!session) throw new Error("expected a session");

    const first = await localAuthProvider.refresh(session.refreshToken);
    expect(first.refreshToken).not.toBe(session.refreshToken);
    expect(first.userId).toBe(session.userId);

    // The rotated token works for a further refresh.
    const second = await localAuthProvider.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it("revokes the whole session when a used refresh token is replayed", async () => {
    const email = uniqueEmail();
    const { session } = await localAuthProvider.signUp(email, PASSWORD);
    if (!session) throw new Error("expected a session");

    // Use the original token once to rotate it.
    const rotated = await localAuthProvider.refresh(session.refreshToken);

    // Replaying the original (now used) token must be rejected and must revoke
    // the session.
    await expect(localAuthProvider.refresh(session.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
      statusCode: 401
    });

    // After the reuse-triggered revoke, even the most recent valid token can no
    // longer refresh because the session itself is revoked.
    await expect(localAuthProvider.refresh(rotated.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN",
      statusCode: 401
    });
  });

  it("signs out idempotently and blocks further refresh", async () => {
    const email = uniqueEmail();
    const { session } = await localAuthProvider.signUp(email, PASSWORD);
    if (!session) throw new Error("expected a session");

    await localAuthProvider.signOut(session.refreshToken);
    // Second sign-out with the same token is a no-op and does not throw.
    await expect(localAuthProvider.signOut(session.refreshToken)).resolves.toBeUndefined();

    await expect(localAuthProvider.refresh(session.refreshToken)).rejects.toMatchObject({
      code: "INVALID_REFRESH_TOKEN"
    });
  });

  it("treats reset as a stub that always resolves", async () => {
    await expect(localAuthProvider.reset(uniqueEmail())).resolves.toBeUndefined();
  });
});
