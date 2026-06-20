import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config, DEV_ACCESS_TOKEN, DEV_USER_ID } from "./config.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let localSecret: Uint8Array | null = null;

export async function authenticate(request: FastifyRequest): Promise<string> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401, code: "AUTH_REQUIRED" });
  }
  const token = header.slice(7);

  // The dev bypass token is only honored when explicitly enabled and never in
  // production. With local auth on by default this path is effectively off.
  if (config.devAuth && config.nodeEnv !== "production" && token === DEV_ACCESS_TOKEN) {
    return DEV_USER_ID;
  }

  // Local authentication: the access token is a jose HS256 token signed with the
  // server secret. We verify the signature and expiry and return the sub claim.
  if (config.authMode === "local") {
    localSecret ??= new TextEncoder().encode(config.localAuthSecret);
    try {
      const verified = await jwtVerify(token, localSecret, { algorithms: ["HS256"] });
      if (!verified.payload.sub) {
        throw Object.assign(new Error("Invalid identity token"), { statusCode: 401, code: "AUTH_INVALID" });
      }
      return verified.payload.sub;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode) throw error;
      throw Object.assign(new Error("Invalid identity token"), { statusCode: 401, code: "AUTH_INVALID" });
    }
  }

  // Supabase authentication: verify against the project JWKS.
  if (!config.supabaseUrl) {
    throw Object.assign(new Error("Authentication is not configured"), { statusCode: 503, code: "AUTH_UNAVAILABLE" });
  }

  jwks ??= createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
  const verified = await jwtVerify(token, jwks, {
    issuer: `${config.supabaseUrl}/auth/v1`,
    audience: "authenticated"
  });

  if (!verified.payload.sub) {
    throw Object.assign(new Error("Invalid identity token"), { statusCode: 401, code: "AUTH_INVALID" });
  }
  return verified.payload.sub;
}
