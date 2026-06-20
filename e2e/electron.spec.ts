import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Playwright compiles this spec as CommonJS, so require and __dirname are
// available directly. The "electron" module exports the Electron binary path.
const desktopDir = path.join(__dirname, "..", "apps", "desktop");
const electronPath = require("electron") as unknown as string;

let app: ElectronApplication;
let page: Page;
const testEmail = `e2e+${Date.now()}@workcrew.local`;
const testPassword = "supersecret123";

test.beforeAll(async () => {
  // A fresh user-data dir guarantees no stored session, so the app starts at
  // the sign in screen every run.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "workcrew-e2e-"));
  app = await electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      WORKCREW_API_URL: "http://127.0.0.1:8787",
      AUTH_MODE: "local",
      BILLING_MODE: "simulated",
      WORKCREW_MOCK_AI: "true",
      WORKCREW_DEV_AUTH: "false",
      WORKCREW_DEV_BILLING: "false",
      NODE_ENV: "development"
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
});

test("opens to the sign in screen", async () => {
  await expect(page.locator(".auth-shell")).toBeVisible();
  await expect(page.getByText("Welcome back")).toBeVisible();
});

test("a new account can sign up and reaches the paywall", async () => {
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.locator('input[type="email"]').fill(testEmail);
  await page.locator('input[type="password"]').fill(testPassword);
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.locator(".paywall-shell")).toBeVisible();
  await expect(page.getByText("Put routine work on autopilot")).toBeVisible();
  // No provider or model brand names are shown to the user.
  await expect(page.locator(".paywall-shell")).not.toContainText("Claude");
  await expect(page.locator(".paywall-shell")).not.toContainText("Playwright");
  await expect(page.locator(".paywall-shell")).not.toContainText("pywinauto");
  await expect(page.getByText(/tokens every month/i).first()).toBeVisible();
  await page.screenshot({ path: "workcrew-paywall.png", fullPage: true });
});

test("plan prices are shown as whole dollars", async () => {
  const proPrice = page.locator(".price-card", { hasText: "Pro" }).locator(".price strong");
  const ultraPrice = page.locator(".price-card", { hasText: "Ultra" }).locator(".price strong");
  // Yearly is selected by default.
  await expect(proPrice).toHaveText("$23");
  await expect(ultraPrice).toHaveText("$167");
  await page.getByRole("button", { name: "Monthly" }).click();
  await expect(proPrice).toHaveText("$27");
  await expect(ultraPrice).toHaveText("$200");
});

test("the paywall can scroll to the footer", async () => {
  const foot = page.getByText("No free tier", { exact: false });
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toBeVisible();
});

test("activating Pro unlocks the workspace and shows upgrade prompts", async () => {
  await page.getByRole("button", { name: /Activate Pro/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByPlaceholder(/Ask WorkCrew/i)).toBeVisible();
  // A plan below Ultra sees upgrade prompts in the header and the sidebar.
  await expect(page.locator(".upgrade-pill")).toBeVisible();
  await expect(page.locator(".upgrade-card")).toBeVisible();
  // The effort selector uses plain names, not model brands.
  const effort = page.locator(".composer-tools select");
  await expect(effort).toContainText("Quick answer");
  await expect(effort).not.toContainText("Haiku");
  await page.screenshot({ path: "workcrew-workspace.png" });
});

test("upgrading to Ultra removes the upgrade prompts", async () => {
  await page.locator(".upgrade-pill").click();
  await expect(page.locator(".upgrade-pill")).toHaveCount(0);
  await expect(page.locator(".upgrade-card")).toHaveCount(0);
});

test("the session persists and the account can sign out", async () => {
  // Open the account dialog from the sidebar footer and sign out.
  await page.locator(".account-button").click();
  await page.getByRole("button", { name: /sign out/i }).first().click();
  await expect(page.locator(".auth-shell")).toBeVisible();
});
