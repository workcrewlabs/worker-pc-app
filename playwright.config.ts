import { defineConfig } from "@playwright/test";

// End to end tests that launch the real built Electron app and drive it.
// The API is started automatically and reused if one is already running.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    command: "npm run dev:api",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: true,
    timeout: 60_000
  }
});
