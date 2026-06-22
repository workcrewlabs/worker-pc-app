import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const booleanText = z.string().optional().transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  HOST: z.string().default("127.0.0.1"),
  WORKCREW_DATA_URL: z.string().default("file:workcrew.db"),
  WORKCREW_DATA_AUTH_TOKEN: z.string().optional(),
  // Production database. When set, the API uses Postgres (Supabase) instead of
  // the local SQLite file. Backend only; never shipped to the desktop.
  DATABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  WORKCREW_DEV_AUTH: booleanText,
  WORKCREW_DEV_BILLING: booleanText,
  WORKCREW_MOCK_AI: booleanText,
  AUTH_MODE: z.enum(["local", "supabase"]).default("local"),
  BILLING_MODE: z.enum(["simulated", "stripe"]).default("simulated"),
  WORKCREW_LOCAL_AUTH_SECRET: z.string().optional(),
  WORKCREW_ALLOWED_ORIGINS: z.string().default("http://127.0.0.1:5173"),
  WORKCREW_LOG_LEVEL: z.string().default("info"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_PRO_YEARLY_PRICE_ID: z.string().optional(),
  STRIPE_ULTRA_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_ULTRA_YEARLY_PRICE_ID: z.string().optional(),
  WORKCREW_BILLING_SUCCESS_URL: z.string().optional(),
  WORKCREW_BILLING_CANCEL_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_HAIKU_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_SONNET_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_OPUS_MODEL: z.string().default("claude-opus-4-8"),
  // Transactional email (sign-up verification and password reset). When
  // RESEND_API_KEY is set the backend sends real email; otherwise it logs the
  // link to the server output so the flow is testable locally. WORKCREW_PUBLIC_URL
  // is the backend's own public address, used to build verify and reset links.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("WorkCrew <onboarding@resend.dev>"),
  WORKCREW_PUBLIC_URL: z.string().optional(),
  WORKCREW_REQUIRE_EMAIL_VERIFICATION: booleanText,
  // Where the landing page "Download for Windows" button points. Set this to the
  // installer link once a release is published.
  WORKCREW_DOWNLOAD_URL: z.string().optional()
});

const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production") {
  // STRIPE_WEBHOOK_SECRET is intentionally not required at boot. It is only
  // available after the backend is deployed and a webhook endpoint is created
  // in Stripe, so the server must start without it and then be redeployed once
  // the secret is added. The webhook handler rejects events until it is set.
  const missing = [
    ["STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY],
    ["STRIPE_PRO_MONTHLY_PRICE_ID", env.STRIPE_PRO_MONTHLY_PRICE_ID],
    ["STRIPE_PRO_YEARLY_PRICE_ID", env.STRIPE_PRO_YEARLY_PRICE_ID],
    ["STRIPE_ULTRA_MONTHLY_PRICE_ID", env.STRIPE_ULTRA_MONTHLY_PRICE_ID],
    ["STRIPE_ULTRA_YEARLY_PRICE_ID", env.STRIPE_ULTRA_YEARLY_PRICE_ID],
    ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY]
  ].filter(([, value]) => !value).map(([name]) => name);

  // Supabase is only required in production when the Supabase auth provider is
  // selected. The local provider needs its own signing secret instead.
  if (env.AUTH_MODE === "supabase" && !env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (env.AUTH_MODE === "local" && !env.WORKCREW_LOCAL_AUTH_SECRET) missing.push("WORKCREW_LOCAL_AUTH_SECRET");

  if (missing.length > 0) {
    throw new Error(`Production configuration is incomplete: ${missing.join(", ")}`);
  }

  if (env.WORKCREW_DEV_AUTH || env.WORKCREW_DEV_BILLING || env.WORKCREW_MOCK_AI) {
    throw new Error("Development bypasses cannot be enabled in production");
  }

  // The simulated billing provider is a local development convenience and must
  // never run in production. Real revenue always goes through Stripe.
  if (env.BILLING_MODE === "simulated") {
    throw new Error("Simulated billing cannot be used in production; set BILLING_MODE=stripe");
  }
}

/**
 * Resolve the secret used to sign local access tokens. In production it must be
 * supplied explicitly (already enforced above). Outside production, if no
 * secret is configured we derive a stable one and persist it next to the
 * database file so tokens stay valid across restarts during development. The
 * secret is never logged.
 */
function resolveLocalAuthSecret(): string {
  if (env.WORKCREW_LOCAL_AUTH_SECRET && env.WORKCREW_LOCAL_AUTH_SECRET.length > 0) {
    return env.WORKCREW_LOCAL_AUTH_SECRET;
  }

  // In tests we do not want to touch the filesystem. A fresh per-process secret
  // is fine because tests sign and verify within the same process.
  if (env.NODE_ENV === "test") {
    return randomBytes(32).toString("hex");
  }

  // Persist a generated secret alongside the database. The data URL may be a
  // remote libsql endpoint, in which case fall back to the working directory.
  const fileMatch = /^file:(.+)$/.exec(env.WORKCREW_DATA_URL);
  const dataPath = fileMatch?.[1] ? resolve(fileMatch[1]) : resolve("workcrew.db");
  const secretPath = resolve(dirname(dataPath), ".local-auth-secret");

  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    const generated = randomBytes(32).toString("hex");
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, generated, { encoding: "utf8", mode: 0o600 });
    return generated;
  } catch {
    // If the filesystem is not writable, fall back to an in-memory secret so
    // the server still starts. Tokens will not survive a restart in this case.
    return randomBytes(32).toString("hex");
  }
}

const localAuthSecret = resolveLocalAuthSecret();

// The backend's own public address: an explicit override, then Render's
// auto-provided URL, then the local default. Used for email links and the
// Stripe success/cancel pages.
const publicUrl = (env.WORKCREW_PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  // In production (for example on Render) the service must listen on all
  // interfaces. Locally it stays on the loopback address for safety.
  host: env.NODE_ENV === "production" ? (process.env.HOST ?? "0.0.0.0") : env.HOST,
  dataUrl: env.WORKCREW_DATA_URL,
  dataAuthToken: env.WORKCREW_DATA_AUTH_TOKEN,
  databaseUrl: env.DATABASE_URL,
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  devAuth: env.WORKCREW_DEV_AUTH,
  devBilling: env.WORKCREW_DEV_BILLING,
  mockAi: env.WORKCREW_MOCK_AI,
  authMode: env.AUTH_MODE,
  billingMode: env.BILLING_MODE,
  localAuthSecret,
  allowedOrigins: new Set(env.WORKCREW_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean)),
  logLevel: env.WORKCREW_LOG_LEVEL,
  supabaseUrl: env.SUPABASE_URL,
  supabaseAnonKey: env.SUPABASE_ANON_KEY,
  stripeSecretKey: env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  stripePrices: {
    pro: { month: env.STRIPE_PRO_MONTHLY_PRICE_ID, year: env.STRIPE_PRO_YEARLY_PRICE_ID },
    ultra: { month: env.STRIPE_ULTRA_MONTHLY_PRICE_ID, year: env.STRIPE_ULTRA_YEARLY_PRICE_ID }
  },
  // After Stripe checkout, send the browser to a normal web page on the backend
  // (not a workcrew:// deep link, which misfires in development and shows an OS
  // error). The desktop re-checks entitlement when the user switches back.
  billingSuccessUrl: env.WORKCREW_BILLING_SUCCESS_URL ?? `${publicUrl}/billing/success`,
  billingCancelUrl: env.WORKCREW_BILLING_CANCEL_URL ?? `${publicUrl}/billing/cancel`,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  models: {
    haiku: env.ANTHROPIC_HAIKU_MODEL,
    sonnet: env.ANTHROPIC_SONNET_MODEL,
    opus: env.ANTHROPIC_OPUS_MODEL
  },
  resendApiKey: env.RESEND_API_KEY,
  emailFrom: env.EMAIL_FROM,
  publicUrl,
  requireEmailVerification: env.WORKCREW_REQUIRE_EMAIL_VERIFICATION,
  downloadUrl: env.WORKCREW_DOWNLOAD_URL ?? ""
} as const;

export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_ACCESS_TOKEN = "workcrew-local-development-only";
