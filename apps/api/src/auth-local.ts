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
import {
  createSession,
  createUser,
  getSessionByRefreshToken,
  getUserByEmail,
  getUserById,
  revokeSession,
  rotateRefreshToken,
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
  signUp(email: string, password: string): Promise<{ session: Session; needsVerification: boolean }>;
  signIn(email: string, password: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  signOut(refreshToken: string): Promise<void>;
  reset(email: string): Promise<void>;
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
  async signUp(email: string, password: string): Promise<{ session: Session; needsVerification: boolean }> {
    const normalized = normalizeEmail(email);
    const salt = randomBytes(SCRYPT_SALT_BYTES).toString("hex");
    const passwordHash = await hashPassword(password, salt);
    const userId = randomUUID();

    try {
      await createUser({ id: userId, email: normalized, passwordHash, passwordSalt: salt });
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      // The UNIQUE constraint on email surfaces as a constraint error from
      // libsql. Translate it into the contract EMAIL_IN_USE response.
      if (message.includes("unique") || message.includes("constraint")) {
        throw authError("This email is already registered", 409, "EMAIL_IN_USE");
      }
      throw error;
    }

    const user: UserRow = {
      id: userId,
      email: normalized,
      emailVerified: false,
      passwordHash,
      passwordSalt: salt,
      createdAtMs: Date.now()
    };
    const session = await issueSession(user);
    // Local mode does not send verification email, so the account is usable now.
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

  async reset(_email: string): Promise<void> {
    // Local mode is a stub that does not send email. It always resolves so the
    // caller cannot tell whether the email exists.
    return;
  }
}

export const localAuthProvider = new LocalAuthProvider();
