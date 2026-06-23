import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { browserActionSchema, type BrowserAction } from "@workcrew/contracts";
import { dedupeRecordedSteps, recordStepFromPayload } from "./recorder-steps.js";

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

// A recorded CSS selector for replay. It is only ever passed to a Playwright
// locator (which cannot execute it as code), so the guard just ensures it is a
// present, bounded string rather than an empty or oversized value.
function safeSelector(value: string | undefined): string {
  const selector = (value ?? "").trim();
  if (!selector || selector.length > 500) throw new Error("A recorded element selector is required.");
  return selector;
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

// The in-page recorder. Installed once per page; idempotent so a re-injection on
// navigation does not double-bind. It listens (capture phase) for clicks and for
// committed input changes, builds a stable CSS selector for each target, and
// reports it to the Node side through the __wcRecord binding. Password fields are
// never read. It does nothing unless window.__wcRecording is true.
const RECORDER_INSTALL = `(() => {
  window.__wcRecording = true;
  if (window.__wcInstalled) return;
  window.__wcInstalled = true;
  function uniq(q){ try { return document.querySelectorAll(q).length === 1; } catch (e) { return false; } }
  function esc(v){ return String(v).replace(/(["\\\\])/g, '\\\\$1'); }
  function selector(el){
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && uniq('#' + el.id)) return '#' + el.id;
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute && el.getAttribute('name');
    if (name && uniq(tag + '[name="' + esc(name) + '"]')) return tag + '[name="' + esc(name) + '"]';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && uniq(tag + '[aria-label="' + esc(aria) + '"]')) return tag + '[aria-label="' + esc(aria) + '"]';
    var testid = el.getAttribute && el.getAttribute('data-testid');
    if (testid && uniq('[data-testid="' + esc(testid) + '"]')) return '[data-testid="' + esc(testid) + '"]';
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && depth < 8){
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id) && uniq('#' + node.id)){ parts.unshift('#' + node.id); break; }
      var part = node.tagName.toLowerCase(), p = node.parentElement;
      if (p){
        var same = [], c = p.firstElementChild;
        while (c){ if (c.tagName === node.tagName) same.push(c); c = c.nextElementSibling; }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part); node = p; depth++;
    }
    return parts.join(' > ');
  }
  function clickable(el){
    var n = el;
    while (n && n !== document.body){
      if (n.matches && n.matches('a,button,input,select,textarea,label,[role=button],[role=link],[onclick]')) return n;
      n = n.parentElement;
    }
    return el;
  }
  function report(payload){ if (typeof window.__wcRecord === 'function') { try { window.__wcRecord(payload); } catch (e) {} } }
  document.addEventListener('click', function(e){
    if (!window.__wcRecording) return;
    var s = selector(clickable(e.target));
    if (s) report({ type: 'click', selector: s });
  }, true);
  document.addEventListener('change', function(e){
    if (!window.__wcRecording) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    if (el.type === 'password') return;
    var s = selector(el);
    if (s) report({ type: 'fill', selector: s, value: String(el.value == null ? '' : el.value).slice(0, 2000) });
  }, true);
})()`;


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
  // Click recording state. recordBuffer collects steps reported by the in-page
  // recorder; recordBound is true once the __wcRecord binding is installed on the
  // context; recordOnLoad re-injects the recorder after a navigation.
  private recordBuffer: BrowserAction[] = [];
  private recordBound = false;
  private recordOnLoad: (() => void) | null = null;

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
      // The binding lives on the context, so it is gone once we disconnect.
      this.recordBound = false;
      this.recordOnLoad = null;
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
      case "click-selector":
        // Replay of a recorded click: target is a stable CSS selector, not an
        // ephemeral snapshot ref. first() guards against a selector that widened
        // to more than one match since recording.
        await page.locator(safeSelector(action.target)).first().click({ timeout: 15_000 });
        return "Clicked.";
      case "fill-selector":
        await page.locator(safeSelector(action.target)).first().fill(action.value ?? "", { timeout: 15_000 });
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

  // Begin recording the user's clicks and field edits in the automation browser.
  // The recording starts from a goto to the current page so replay opens the
  // right place first, then captures each interaction as a selector-targeted
  // action. Re-injects the recorder after navigations so a multi-page flow is
  // captured end to end.
  async recordStart(): Promise<void> {
    // Make sure the automation browser is up, just like a normal action, so the
    // user can start recording without clicking Connect browser first.
    if (!(await this.isReachable())) await this.launchBrowser();
    const page = await this.connect();
    this.recordBuffer = [];
    if (!this.recordBound) {
      await this.context!.exposeBinding("__wcRecord", (_source, payload: unknown) => {
        const step = recordStepFromPayload(payload);
        if (step) this.recordBuffer.push(step);
      });
      this.recordBound = true;
    }
    try {
      const url = page.url();
      if (/^https?:/i.test(url)) this.recordBuffer.push({ kind: "browser", command: "goto", url });
    } catch {
      // No usable current URL; the recording simply starts from wherever replay is.
    }
    const reinstall = (): void => { void page.evaluate(RECORDER_INSTALL).catch(() => {}); };
    this.recordOnLoad = reinstall;
    page.on("load", reinstall);
    await page.evaluate(RECORDER_INSTALL);
  }

  // Stop recording and return the captured steps (deduplicated), ready to be
  // saved as a replayable recipe. Safe to call when nothing was recording.
  async recordStop(): Promise<BrowserAction[]> {
    const page = this.page;
    if (page && this.recordOnLoad) page.off("load", this.recordOnLoad);
    this.recordOnLoad = null;
    try { await page?.evaluate("window.__wcRecording = false"); } catch { /* page gone */ }
    const steps = dedupeRecordedSteps(this.recordBuffer);
    this.recordBuffer = [];
    return steps;
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
