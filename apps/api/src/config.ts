import "dotenv/config";
import { z } from "zod";

const booleanText = z.string().optional().transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8_787),
  HOST: z.string().default("127.0.0.1"),
  WORKCREW_DATA_URL: z.string().default("file:workcrew.db"),
  WORKCREW_DATA_AUTH_TOKEN: z.string().optional(),
  WORKCREW_DEV_AUTH: booleanText,
  WORKCREW_DEV_BILLING: booleanText,
  WORKCREW_MOCK_AI: booleanText,
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
  WORKCREW_BILLING_SUCCESS_URL: z.string().default("workcrew://billing/success"),
  WORKCREW_BILLING_CANCEL_URL: z.string().default("workcrew://billing/cancel"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_HAIKU_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_SONNET_MODEL: z.string().default("claude-sonnet-4-6"),
  ANTHROPIC_OPUS_MODEL: z.string().default("claude-opus-4-8")
});

const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production") {
  const missing = [
    ["SUPABASE_URL", env.SUPABASE_URL],
    ["STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY],
    ["STRIPE_WEBHOOK_SECRET", env.STRIPE_WEBHOOK_SECRET],
    ["STRIPE_PRO_MONTHLY_PRICE_ID", env.STRIPE_PRO_MONTHLY_PRICE_ID],
    ["STRIPE_PRO_YEARLY_PRICE_ID", env.STRIPE_PRO_YEARLY_PRICE_ID],
    ["STRIPE_ULTRA_MONTHLY_PRICE_ID", env.STRIPE_ULTRA_MONTHLY_PRICE_ID],
    ["STRIPE_ULTRA_YEARLY_PRICE_ID", env.STRIPE_ULTRA_YEARLY_PRICE_ID],
    ["ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Production configuration is incomplete: ${missing.join(", ")}`);
  }

  if (env.WORKCREW_DEV_AUTH || env.WORKCREW_DEV_BILLING || env.WORKCREW_MOCK_AI) {
    throw new Error("Development bypasses cannot be enabled in production");
  }
}

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  dataUrl: env.WORKCREW_DATA_URL,
  dataAuthToken: env.WORKCREW_DATA_AUTH_TOKEN,
  devAuth: env.WORKCREW_DEV_AUTH,
  devBilling: env.WORKCREW_DEV_BILLING,
  mockAi: env.WORKCREW_MOCK_AI,
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
  billingSuccessUrl: env.WORKCREW_BILLING_SUCCESS_URL,
  billingCancelUrl: env.WORKCREW_BILLING_CANCEL_URL,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  models: {
    haiku: env.ANTHROPIC_HAIKU_MODEL,
    sonnet: env.ANTHROPIC_SONNET_MODEL,
    opus: env.ANTHROPIC_OPUS_MODEL
  }
} as const;

export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEV_ACCESS_TOKEN = "workcrew-local-development-only";
