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
