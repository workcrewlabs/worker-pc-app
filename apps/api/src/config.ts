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
  // When false (the default, strict pre-launch mode) a subscription only grants
  // access while it is active or trialing. Set to "true" to intentionally extend
  // access through Stripe's past_due payment-retry window as a grace period.
  WORKCREW_BILLING_GRACE_PAST_DUE: booleanText,
  // Number of trusted reverse-proxy hops in front of the API in production (the
  // platform load balancer). Used to derive the real client IP for rate limiting
  // from X-Forwarded-For without trusting client-supplied entries. One hop (the
  // default) matches a single Render proxy; raise it if you add another proxy.
  WORKCREW_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  // Where the landing page "Download for Windows" button points. Set this to the
  // installer link once a release is published.
  // Treat an empty value as unset so a blank Render env var does not fail boot;
  // a non-empty value must still be a real URL.
  WORKCREW_DOWNLOAD_URL: z.preprocess(
    (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
    z.string().url().optional()
  ),
  // Product analytics (PostHog cloud), backend side. POSTHOG_KEY is the public
  // project key (safe to expose); there is no analytics secret. Analytics is a
  // no-op unless a key is set, and WORKCREW_ANALYTICS_DISABLED=true turns it off
  // entirely regardless. Only safe event names and low-cardinality properties are
  // ever sent; never prompt text, file contents, tokens, or email.
  POSTHOG_KEY: z.string().optional(),
  // Empty/unset falls back to the default; a non-empty value must be a real URL.
  POSTHOG_HOST: z.preprocess(
    (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
    z.string().url().default("https://us.i.posthog.com")
  ),
  WORKCREW_ANALYTICS_DISABLED: booleanText
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

  // A production deployment must use a durable database. If no Postgres URL
  // (DATABASE_URL, the Supabase path) is set and WORKCREW_DATA_URL still points
  // at a local SQLite file, the server would silently run on an ephemeral file
  // that is wiped on every redeploy, destroying all accounts, subscriptions, and
  // history. A remote libsql endpoint (a non-file WORKCREW_DATA_URL) is also
  // acceptable; only the local-file fallback is refused.
  const usingLocalSqlite = !env.DATABASE_URL && /^file:/i.test(env.WORKCREW_DATA_URL);
  if (usingLocalSqlite) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    throw new Error(`Production configuration is incomplete: ${missing.join(", ")}`);
  }

  // Production must use a LIVE Stripe key. A test key here boots silently on test
  // mode (paid signups never actually charge), so fail fast instead.
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    throw new Error("Production requires a live Stripe secret key (sk_live_...).");
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

// A live Stripe secret key must never sit in a development or simulated-billing
// process, where test traffic could trigger real customer charges and the live
// secret is more exposed. This complements the production live-key requirement.
if (
  env.STRIPE_SECRET_KEY?.startsWith("sk_live_") &&
  (env.NODE_ENV !== "production" || env.BILLING_MODE !== "stripe")
) {
  throw new Error("A live Stripe secret key (sk_live_) must only be used in production Stripe billing.");
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

// In production the public URL backs the email verify/reset links and the Stripe
// success/cancel redirects, so it must be https and not localhost. A plaintext or
// localhost value would mint interceptable links and break the post-checkout
// return path. Fail fast at boot rather than ship broken links.
if (env.NODE_ENV === "production" && (!/^https:\/\//i.test(publicUrl) || /^https:\/\/(localhost|127\.0\.0\.1)/i.test(publicUrl))) {
  throw new Error("In production WORKCREW_PUBLIC_URL (or RENDER_EXTERNAL_URL) must be an https, non-localhost URL.");
}

// The backend serves its own browser pages (password reset, email verification,
// billing result, landing), and those pages POST back to the API from the same
// origin. The browser sends an Origin header on those POSTs, so the backend must
// allow its own public origins or it rejects its own pages with a CORS error.
// This is in addition to any origins set via WORKCREW_ALLOWED_ORIGINS (which is
// where the desktop app's app://workcrew origin comes from).
const selfOrigins = [
  publicUrl,
  process.env.RENDER_EXTERNAL_URL,
  "https://workcrew-backend.onrender.com",
  "https://getworkcrew.com",
  "https://www.getworkcrew.com"
].filter((value): value is string => Boolean(value)).map((value) => value.replace(/\/$/, ""));

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
  allowedOrigins: new Set([
    ...env.WORKCREW_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    ...selfOrigins
  ]),
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
  billingGracePastDue: env.WORKCREW_BILLING_GRACE_PAST_DUE,
  trustedProxyHops: env.WORKCREW_TRUSTED_PROXY_HOPS,
  downloadUrl: env.WORKCREW_DOWNLOAD_URL ?? "",
  analytics: {
    key: env.POSTHOG_KEY,
    host: env.POSTHOG_HOST.replace(/\/$/, ""),
    // Off by default; on only when a key is present and not explicitly disabled.
    enabled: Boolean(env.POSTHOG_KEY) && !env.WORKCREW_ANALYTICS_DISABLED
  }
} as const;

export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_ACCESS_TOKEN = "workcrew-local-development-only";
