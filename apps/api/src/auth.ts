import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config, DEV_ACCESS_TOKEN, DEV_USER_ID } from "./config.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function authenticate(request: FastifyRequest): Promise<string> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401, code: "AUTH_REQUIRED" });
  }
  const token = header.slice(7);

  if (config.devAuth && config.nodeEnv !== "production" && token === DEV_ACCESS_TOKEN) {
    return DEV_USER_ID;
  }

  if (!config.supabaseUrl) {
    throw Object.assign(new Error("Production authentication is not configured"), { statusCode: 503, code: "AUTH_UNAVAILABLE" });
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
