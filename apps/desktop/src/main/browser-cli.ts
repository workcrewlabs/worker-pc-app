import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { browserActionSchema, type BrowserAction } from "@workcrew/contracts";

// Browser automation drives a real Chrome over the Chrome DevTools Protocol, so
// actions run in a visible window the user can watch. The model plans actions
// against an accessibility snapshot that tags each element with a stable ref
// (for example e12); actions target elements by that ref. No provider tooling
// is ever shown to the user.

const DEFAULT_CDP_PORT = 9222;
const MAX_OUTPUT_CHARS = 60_000;

function cdpEndpoint(): string {
  return process.env.WORKCREW_BROWSER_CDP_URL ?? `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
}

// A current accessibility reference, as produced by the snapshot. Refs look like
// e1, e2, ... The guard rejects anything else so a stale or invented ref fails
// clearly instead of matching the wrong element.
function safeRef(value: string | undefined): string {
  if (!value || !/^e\d{1,6}$/.test(value)) throw new Error("A current element reference is required. Take a snapshot first.");
  return value;
}

function safeUrl(value: string | undefined): string {
  if (!value) throw new Error("A web address is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses are allowed");
  return url.toString();
}

function clamp(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : text;
}

// Common Chrome install locations on Windows. The first that exists is used to
// launch a debugging-enabled window when one is not already running.
function findChrome(): string | null {
  const candidates = [
    process.env.WORKCREW_CHROME_PATH,
    join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe")
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export class BrowserCli {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * Launch a Chrome window with remote debugging enabled, using a dedicated
   * WorkCrew profile that persists the user's sign-ins across runs. This is the
   * one-time setup so automations can act with the user's accounts. If Chrome is
   * already reachable on the debugging port this is effectively a no-op.
   */
  async launchBrowser(): Promise<{ launched: boolean; message: string }> {
    if (await this.isReachable()) return { launched: false, message: "The automation browser is already running." };
    const chromePath = findChrome();
    if (!chromePath) {
      throw new Error("Google Chrome was not found. Install Chrome to use browser automation.");
    }
    const profileDir = join(app.getPath("userData"), "automation-profile");
    const child = spawn(chromePath, [
      `--remote-debugging-port=${DEFAULT_CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check"
    ], { detached: true, stdio: "ignore" });
    child.unref();
    // Wait briefly for the debugging endpoint to come up.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.isReachable()) return { launched: true, message: "Automation browser ready. Sign in to your accounts in this window." };
      await new Promise((done) => setTimeout(done, 300));
    }
    throw new Error("The automation browser did not start in time. Try again.");
  }

  // Whether the CDP endpoint is accepting connections.
  private async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${cdpEndpoint()}/json/version`, { signal: AbortSignal.timeout(1_500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<Page> {
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    try {
      this.browser = await chromium.connectOverCDP(cdpEndpoint(), { timeout: 10_000 });
    } catch {
      throw new Error("Could not connect to your browser. Use Connect browser to start it, then try again.");
    }
    this.browser.once("disconnected", () => {
      this.browser = null;
      this.context = null;
      this.page = null;
    });
    const contexts = this.browser.contexts();
    this.context = contexts[0] ?? (await this.browser.newContext());
    const pages = this.context.pages();
    this.page = pages[pages.length - 1] ?? (await this.context.newPage());
    return this.page;
  }

  private async snapshot(page: Page): Promise<string> {
    // The "ai" snapshot tags interactive elements with stable refs (e1, e2, ...)
    // that the planner targets and that aria-ref locators resolve.
    const yaml = await page.locator("body").ariaSnapshot({ mode: "ai" });
    return clamp(`Page: ${page.url()}\n${yaml}`);
  }

  private locate(page: Page, ref: string | undefined) {
    return page.locator(`aria-ref=${safeRef(ref)}`);
  }

  async execute(rawAction: unknown): Promise<string> {
    const action = browserActionSchema.parse(rawAction);
    // Auto-start the automation browser on the first action so the user does not
    // have to click Connect browser first. If Chrome is already running with the
    // debugging port open this is a no-op.
    if (!(await this.isReachable())) {
      await this.launchBrowser();
    }
    const page = await this.connect();

    switch (action.command) {
      case "open":
      case "goto":
        await page.goto(safeUrl(action.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
        return this.snapshot(page);
      case "snapshot":
        return this.snapshot(page);
      case "click":
        await this.locate(page, action.target).click({ timeout: 15_000 });
        return "Clicked.";
      case "fill":
        await this.locate(page, action.target).fill(action.value ?? "", { timeout: 15_000 });
        return "Filled.";
      case "type":
        await page.keyboard.type(action.value ?? "");
        return "Typed.";
      case "press":
        await page.keyboard.press(action.key ?? "Enter");
        return "Key pressed.";
      case "select":
        await this.locate(page, action.target).selectOption(action.value ?? "", { timeout: 15_000 });
        return "Selected.";
      case "check":
        await this.locate(page, action.target).check({ timeout: 15_000 });
        return "Checked.";
      case "uncheck":
        await this.locate(page, action.target).uncheck({ timeout: 15_000 });
        return "Unchecked.";
      case "hover":
        await this.locate(page, action.target).hover({ timeout: 15_000 });
        return "Hovered.";
      case "screenshot":
        await page.screenshot({ timeout: 15_000 });
        return "Screenshot captured.";
      case "go-back":
        await page.goBack({ timeout: 15_000 });
        return this.snapshot(page);
      case "go-forward":
        await page.goForward({ timeout: 15_000 });
        return this.snapshot(page);
      case "reload":
        await page.reload({ timeout: 30_000 });
        return this.snapshot(page);
      case "tab-list": {
        const pages = this.context?.pages() ?? [];
        return pages.map((tab, index) => `${index}: ${tab.url()}`).join("\n") || "No open tabs.";
      }
      case "tab-new": {
        const created = await this.context!.newPage();
        if (action.url) await created.goto(safeUrl(action.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
        this.page = created;
        return this.snapshot(created);
      }
      case "tab-select": {
        const pages = this.context?.pages() ?? [];
        const selected = pages[action.index ?? 0];
        if (!selected) throw new Error("That tab does not exist");
        this.page = selected;
        await selected.bringToFront();
        return this.snapshot(selected);
      }
      case "tab-close": {
        const pages = this.context?.pages() ?? [];
        const target = pages[action.index ?? 0];
        if (target) await target.close();
        this.page = this.context?.pages().at(-1) ?? null;
        return "Tab closed.";
      }
      default:
        throw new Error("Unsupported browser command");
    }
  }

  // Disconnect from the user's Chrome without closing it. Their browser window
  // stays open; only WorkCrew's control session ends.
  async stop(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {
      // Already disconnected.
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
