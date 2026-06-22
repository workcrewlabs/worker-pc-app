import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
import { SignJWT } from "jose";
import { z } from "zod";
import { config } from "./config.js";
import { emailProvider, resetEmailMessage, sendEmail, verifyEmailMessage } from "./email.js";
import {
  consumeEmailToken,
  createEmailToken,
  createSession,
  createUser,
  getEmailToken,
  getSessionByRefreshToken,
  getUserByEmail,
  getUserById,
  revokeSession,
  revokeUserSessions,
  rotateRefreshToken,
  setUserEmailVerified,
  updateUserPassword,
  type UserRow
} from "./db.js";

const scrypt = promisify(scryptCallback);

// Access tokens live about one hour. Refresh tokens live thirty days.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// scrypt output length in bytes. 64 is a common, comfortably strong choice.
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 16;
const REFRESH_TOKEN_BYTES = 48;

// Email token sizes and lifetimes. Verification links last a day; reset links
// last an hour.
const EMAIL_TOKEN_BYTES = 32;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

// The exact session shape returned to the client. Mirrored by the desktop half.
export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  userId: string;
  email: string;
};

// The provider contract. A SupabaseAuthProvider can implement the same shape
// later so the rest of the server does not care which identity backend is live.
export interface AuthProvider {
  signUp(email: string, password: string): Promise<{ session: Session | null; needsVerification: boolean }>;
  signIn(email: string, password: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  signOut(refreshToken: string): Promise<void>;
  reset(email: string): Promise<void>;
  verifyEmail(token: string): Promise<{ email: string }>;
  confirmReset(token: string, newPassword: string): Promise<void>;
}

// Validation lives here so both the provider and the route share one rule set.
// Password minimum length is ten characters per the API contract.
export const signUpInputSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(10).max(1_024)
}).strict();

export const signInInputSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1_024)
}).strict();

export const refreshInputSchema = z.object({
  refreshToken: z.string().min(1).max(4_096)
}).strict();

export const signOutInputSchema = z.object({
  refreshToken: z.string().min(1).max(4_096)
}).strict();

export const resetInputSchema = z.object({
  email: z.string().trim().email().max(320)
}).strict();

export const resetConfirmInputSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(10).max(1_024)
}).strict();

export const verifyTokenSchema = z.object({
  token: z.string().min(1).max(512)
}).strict();

function authError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// scrypt is built into Node and needs no dependency. We store the salt and the
// derived hash as hex. The password itself is never stored or logged.
async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return derived.toString("hex");
}

async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(expectedHash, "hex");
  // Length guard before timingSafeEqual, which throws on length mismatch.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

// The refresh token is an opaque random string. Only its SHA-256 hash is stored
// in the database, so a database leak does not expose usable tokens.
function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
  return { token, hash: hashRefreshToken(token) };
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// An opaque email token (verification or reset). Only its hash is stored.
function newEmailToken(): { token: string; hash: string } {
  const token = randomBytes(EMAIL_TOKEN_BYTES).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

// Create and persist an email token, returning the raw value to put in a link.
async function issueEmailToken(user: UserRow, purpose: "verify" | "reset", ttlMs: number): Promise<string> {
  const { token, hash } = newEmailToken();
  await createEmailToken({
    id: randomUUID(),
    userId: user.id,
    email: user.email,
    purpose,
    tokenHash: hash,
    expiresAtMs: Date.now() + ttlMs
  });
  return token;
}

function verifyLink(token: string): string {
  return `${config.publicUrl}/v1/auth/verify?token=${token}`;
}

function resetLink(token: string): string {
  return `${config.publicUrl}/reset?token=${token}`;
}

async function signAccessToken(userId: string, email: string, expiresAtMs: number): Promise<string> {
  const secret = new TextEncoder().encode(config.localAuthSecret);
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(secret);
}

// Issue a brand new session (sign-up and sign-in). Creates the session row and
// its first refresh token, and returns the freshly signed access token.
async function issueSession(user: UserRow): Promise<Session> {
  const now = Date.now();
  const accessExpiresAtMs = now + ACCESS_TOKEN_TTL_MS;
  const sessionExpiresAtMs = now + REFRESH_TOKEN_TTL_MS;
  const sessionId = randomUUID();
  const refreshTokenId = randomUUID();
  const refresh = newRefreshToken();

  await createSession({
    sessionId,
    userId: user.id,
    expiresAtMs: sessionExpiresAtMs,
    refreshTokenId,
    refreshTokenHash: refresh.hash
  });

  const accessToken = await signAccessToken(user.id, user.email, accessExpiresAtMs);
  return {
    accessToken,
    refreshToken: refresh.token,
    expiresAtMs: accessExpiresAtMs,
    userId: user.id,
    email: user.email
  };
}

export class LocalAuthProvider implements AuthProvider {
  async signUp(email: string, password: string): Promise<{ session: Session | null; needsVerification: boolean }> {
    const normalized = normalizeEmail(email);
    const salt = randomBytes(SCRYPT_SALT_BYTES).toString("hex");
    const passwordHash = await hashPassword(password, salt);
    const userId = randomUUID();
    const requireVerification = config.requireEmailVerification;

    try {
      // When verification is required the account starts unverified and cannot
      // sign in until the emailed link is opened. Otherwise it is usable at once.
      await createUser({ id: userId, email: normalized, passwordHash, passwordSalt: salt, emailVerified: !requireVerification });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      // The UNIQUE constraint on email surfaces as a constraint error. Translate
      // it into the contract EMAIL_IN_USE response.
      if (message.includes("unique") || message.includes("constraint") || message.includes("duplicate")) {
        throw authError("This email is already registered", 409, "EMAIL_IN_USE");
      }
      throw error;
    }

    const user: UserRow = {
      id: userId,
      email: normalized,
      emailVerified: !requireVerification,
      passwordHash,
      passwordSalt: salt,
      createdAtMs: Date.now()
    };

    if (requireVerification) {
      const token = await issueEmailToken(user, "verify", VERIFY_TOKEN_TTL_MS);
      try {
        await sendEmail(verifyEmailMessage(user.email, verifyLink(token)));
      } catch (error) {
        // Do not fail the sign-up if the email send hiccups; the user can ask for
        // a new link. The error is logged, never the token.
        console.error("[WorkCrew] verification email failed to send", error instanceof Error ? error.message : error);
      }
      return { session: null, needsVerification: true };
    }

    const session = await issueSession(user);
    return { session, needsVerification: false };
  }

  async signIn(email: string, password: string): Promise<Session> {
    const normalized = normalizeEmail(email);
    const user = await getUserByEmail(normalized);

    if (!user) {
      // Spend roughly the same work hashing a throwaway value so that the
      // response time does not reveal whether the email exists.
      await hashPassword(password, randomBytes(SCRYPT_SALT_BYTES).toString("hex"));
      throw authError("The email or password is incorrect", 401, "INVALID_CREDENTIALS");
    }

    const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!ok) {
      throw authError("The email or password is incorrect", 401, "INVALID_CREDENTIALS");
    }

    // Block sign-in for an unverified address when verification is required.
    if (config.requireEmailVerification && !user.emailVerified) {
      throw authError("Please verify your email first. We sent you a verification link.", 403, "EMAIL_NOT_VERIFIED");
    }

    return issueSession(user);
  }

  async refresh(refreshToken: string): Promise<Session> {
    const tokenHash = hashRefreshToken(refreshToken);
    const found = await getSessionByRefreshToken(tokenHash);
    if (!found) {
      throw authError("The refresh token is invalid", 401, "INVALID_REFRESH_TOKEN");
    }

    const { session, token } = found;
    const now = Date.now();

    // A revoked or expired session can never refresh.
    if (session.revokedAtMs != null || session.expiresAtMs <= now) {
      throw authError("The session is no longer valid", 401, "INVALID_REFRESH_TOKEN");
    }

    // Reuse detection. A refresh token is single use. If this token was already
    // consumed, an attacker (or a buggy client) is replaying it, so revoke the
    // entire session and reject.
    if (token.usedAtMs != null) {
      await revokeSession(session.id);
      throw authError("The refresh token was already used", 401, "INVALID_REFRESH_TOKEN");
    }

    const newTokenId = randomUUID();
    const next = newRefreshToken();
    const rotated = await rotateRefreshToken({
      oldTokenId: token.id,
      newTokenId,
      sessionId: session.id,
      newTokenHash: next.hash
    });

    // The guarded UPDATE failing means another request rotated this same token
    // first. Treat it as reuse and revoke the session.
    if (!rotated) {
      await revokeSession(session.id);
      throw authError("The refresh token was already used", 401, "INVALID_REFRESH_TOKEN");
    }

    // Reload the user so the new access token carries the current email.
    const user = await getUserById(session.userId);
    if (!user) {
      throw authError("The session is no longer valid", 401, "INVALID_REFRESH_TOKEN");
    }
    const accessExpiresAtMs = now + ACCESS_TOKEN_TTL_MS;
    const accessToken = await signAccessToken(session.userId, user.email, accessExpiresAtMs);

    return {
      accessToken,
      refreshToken: next.token,
      expiresAtMs: accessExpiresAtMs,
      userId: session.userId,
      email: user.email
    };
  }

  async signOut(refreshToken: string): Promise<void> {
    // Idempotent. An unknown or already revoked token simply does nothing.
    const tokenHash = hashRefreshToken(refreshToken);
    const found = await getSessionByRefreshToken(tokenHash);
    if (found) await revokeSession(found.session.id);
  }

  async reset(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const masked = normalized.replace(/^(.).*(@.*)$/, "$1***$2");
    const user = await getUserByEmail(normalized);
    // Always resolve so the caller cannot tell whether the email exists. Only
    // send a link when there is actually an account. The diagnostics below make
    // the outcome visible in the server log without leaking the address.
    if (!user) {
      console.info(`[WorkCrew] password reset requested but NO ACCOUNT exists for ${masked} on this backend; nothing sent.`);
      return;
    }
    const token = await issueEmailToken(user, "reset", RESET_TOKEN_TTL_MS);
    try {
      await sendEmail(resetEmailMessage(user.email, resetLink(token)));
      console.info(`[WorkCrew] password reset email handed to the "${emailProvider().name}" provider for ${masked}.`);
    } catch (error) {
      console.error("[WorkCrew] reset email FAILED to send", error instanceof Error ? error.message : error);
    }
  }

  // Verify an email address from a link. Single use and time limited.
  async verifyEmail(rawToken: string): Promise<{ email: string }> {
    const hash = createHash("sha256").update(rawToken).digest("hex");
    const token = await getEmailToken(hash, "verify");
    if (!token || token.usedAtMs != null || token.expiresAtMs <= Date.now()) {
      throw authError("This verification link is invalid or has expired.", 400, "INVALID_TOKEN");
    }
    if (!(await consumeEmailToken(token.id))) {
      throw authError("This verification link was already used.", 400, "INVALID_TOKEN");
    }
    await setUserEmailVerified(token.userId);
    return { email: token.email };
  }

  // Set a new password from a reset link, then sign every existing session out.
  async confirmReset(rawToken: string, newPassword: string): Promise<void> {
    const hash = createHash("sha256").update(rawToken).digest("hex");
    const token = await getEmailToken(hash, "reset");
    if (!token || token.usedAtMs != null || token.expiresAtMs <= Date.now()) {
      throw authError("This reset link is invalid or has expired.", 400, "INVALID_TOKEN");
    }
    if (!(await consumeEmailToken(token.id))) {
      throw authError("This reset link was already used.", 400, "INVALID_TOKEN");
    }
    try {
      const salt = randomBytes(SCRYPT_SALT_BYTES).toString("hex");
      const passwordHash = await hashPassword(newPassword, salt);
      await updateUserPassword(token.userId, passwordHash, salt);
      await revokeUserSessions(token.userId);
    } catch (error) {
      // Surface the real cause in the server log; the client still gets a clean
      // 500. This is the step to inspect if a valid reset link ever fails.
      console.error("[WorkCrew] confirmReset failed after token validation:", error instanceof Error ? error.stack ?? error.message : error);
      throw error;
    }
  }
}

export const localAuthProvider = new LocalAuthProvider();
