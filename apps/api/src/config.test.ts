import { afterEach, describe, expect, it, vi } from "vitest";

// Guards the deploy-safety fix: an empty optional URL env var must be treated as
// unset, not crash the server at boot. A malformed value must still be rejected.
describe("config env validation tolerates empty optional URLs", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("treats an empty WORKCREW_DOWNLOAD_URL as unset instead of crashing", async () => {
    vi.resetModules();
    process.env.WORKCREW_DOWNLOAD_URL = "";
    const { config } = await import("./config.js");
    expect(config.downloadUrl).toBe("");
  });

  it("falls back to the default POSTHOG_HOST when the env var is empty", async () => {
    vi.resetModules();
    process.env.POSTHOG_HOST = "";
    const { config } = await import("./config.js");
    expect(config.analytics.host).toBe("https://us.i.posthog.com");
  });

  it("still rejects a malformed download URL", async () => {
    vi.resetModules();
    process.env.WORKCREW_DOWNLOAD_URL = "not a url";
    await expect(import("./config.js")).rejects.toThrow();
  });
});

// Manual billing means there is no payment processor behind this deployment:
// customers pay the operator and an admin grants access. Production must boot
// that way with no Stripe configuration at all, while every other production
// guard stays exactly as strict.
describe("manual billing mode in production", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  function productionEnv(): void {
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "local";
    process.env.WORKCREW_LOCAL_AUTH_SECRET = "a".repeat(48);
    process.env.DATABASE_URL = "postgres://user:pass@db.example.com:5432/workcrew";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.WORKCREW_PUBLIC_URL = "https://workcrew-backend.example.com";
    // Nothing Stripe-shaped is present, exactly as it looks after the Stripe
    // account is closed and its settings are removed.
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRO_MONTHLY_PRICE_ID;
    delete process.env.STRIPE_PRO_YEARLY_PRICE_ID;
    delete process.env.STRIPE_ULTRA_MONTHLY_PRICE_ID;
    delete process.env.STRIPE_ULTRA_YEARLY_PRICE_ID;
    delete process.env.WORKCREW_DEV_AUTH;
    delete process.env.WORKCREW_DEV_BILLING;
    delete process.env.WORKCREW_MOCK_AI;
  }

  it("boots with no Stripe configuration", async () => {
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "manual";
    const { config } = await import("./config.js");
    expect(config.billingMode).toBe("manual");
    expect(config.billingContactEmail).toBe("workcrew.support@gmail.com");
  });

  it("still refuses to boot Stripe mode without Stripe configuration", async () => {
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "stripe";
    await expect(import("./config.js")).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it("still refuses simulated billing in production", async () => {
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "simulated";
    await expect(import("./config.js")).rejects.toThrow(/Simulated billing/);
  });

  it("still boots, with a warning, if a Stripe key is left behind", async () => {
    // A stale environment variable must never take the product offline: under
    // manual billing no code path can reach Stripe at all, so this warns rather
    // than refusing to start.
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "manual";
    process.env.STRIPE_SECRET_KEY = "sk_live_leftover";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await import("./config.js");
    expect(config.billingMode).toBe("manual");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/STRIPE_SECRET_KEY is set while BILLING_MODE is manual/));
    warn.mockRestore();
  });

  it("still refuses a live Stripe key in a simulated-billing process", async () => {
    vi.resetModules();
    productionEnv();
    process.env.NODE_ENV = "development";
    process.env.BILLING_MODE = "simulated";
    process.env.STRIPE_SECRET_KEY = "sk_live_leftover";
    await expect(import("./config.js")).rejects.toThrow(/live Stripe secret key/);
  });

  it("closes the admin dashboard when no admin emails are configured", async () => {
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "manual";
    delete process.env.WORKCREW_ADMIN_EMAILS;
    const { config } = await import("./config.js");
    expect(config.adminEmails.size).toBe(0);
  });

  it("reads the admin allowlist case-insensitively", async () => {
    vi.resetModules();
    productionEnv();
    process.env.BILLING_MODE = "manual";
    process.env.WORKCREW_ADMIN_EMAILS = " Owner@Example.com , second@example.com ";
    const { config } = await import("./config.js");
    expect(config.adminEmails.has("owner@example.com")).toBe(true);
    expect(config.adminEmails.has("second@example.com")).toBe(true);
    expect(config.adminEmails.size).toBe(2);
  });
});
