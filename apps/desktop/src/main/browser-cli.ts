import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { browserActionSchema, type RecordedEvent } from "@workcrew/contracts";
import { browserEventFromPayload, dedupeTrace } from "./recorder-steps.js";

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

// The in-page recorder. It reports a READABLE description of what the user did
// (the element's visible text and role, the page url/title, typed text) rather
// than coordinates or brittle selectors, because the trace is summarized into a
// reusable instruction by the model, not replayed literally. Installed once per
// page and idempotent, so a re-injection after navigation does not double-bind;
// each (re)install also reports a navigate so multi-page flows are captured.
// Password fields are never read. It does nothing unless window.__wcRecording.
const RECORDER_INSTALL = `(() => {
  window.__wcRecording = true;
  function clean(s){ return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, 160); }
  function isPassword(el){ return !!el && el.tagName === 'INPUT' && el.type === 'password'; }
  function text(el){
    if (!el || el.nodeType !== 1) return '';
    var t = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (!t) t = (el.innerText || el.textContent || '');
    t = clean(t);
    // Never read the value of a password field.
    if (!t && el.value && !isPassword(el)) t = clean(el.value);
    if (!t && el.getAttribute) t = clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
    return t;
  }
  function role(el){
    if (!el || !el.tagName) return '';
    return (el.getAttribute && el.getAttribute('role')) || el.tagName.toLowerCase();
  }
  function clickable(el){
    var n = el;
    while (n && n !== document.body){
      if (n.matches && n.matches('a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]')) return n;
      n = n.parentElement;
    }
    return el;
  }
  function editableHost(el){
    var n = el;
    while (n && n !== document.body){
      if (n.isContentEditable) return n;
      n = n.parentElement;
    }
    return null;
  }
  function labelFor(el){
    var t = '';
    try { if (el.labels && el.labels[0]) t = el.labels[0].innerText; } catch (e) {}
    if (!t && el.getAttribute) t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    return clean(t);
  }
  function report(payload){ if (window.__wcRecording && typeof window.__wcRecord === 'function') { try { window.__wcRecord(payload); } catch (e) {} } }
  report({ type: 'navigate', url: location.href, title: clean(document.title) });
  if (window.__wcInstalled) return;
  window.__wcInstalled = true;
  document.addEventListener('click', function(e){
    if (!window.__wcRecording) return;
    var el = clickable(e.target);
    // A click on a password box is recorded as the action, never its contents.
    var target = isPassword(el) ? 'password field' : text(el);
    report({ type: 'click', target: target, role: role(el), url: location.href, title: clean(document.title) });
  }, true);
  document.addEventListener('input', function(e){
    if (!window.__wcRecording) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    // Rich-text editors (Gmail's body, Slack, Notion) are contenteditable, not inputs.
    var host = editableHost(el);
    if (host){
      var v = clean(host.innerText || host.textContent || '');
      if (v) report({ type: 'fill', target: labelFor(host) || 'text area', value: v, url: location.href, title: clean(document.title) });
      return;
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag !== 'input' && tag !== 'textarea') return;
    if (isPassword(el)) return;
    var val = clean(el.value);
    if (val) report({ type: 'fill', target: labelFor(el) || 'a field', value: val, url: location.href, title: clean(document.title) });
  }, true);
  document.addEventListener('change', function(e){
    if (!window.__wcRecording) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || !el.tagName || el.tagName.toLowerCase() !== 'select') return;
    report({ type: 'fill', target: labelFor(el) || 'a choice', value: clean(el.value), url: location.href, title: clean(document.title) });
  }, true);
})()`;


// Resolve a Chromium-based browser to drive: Chrome first, then Microsoft Edge if
// Chrome is not installed. Both are Chromium and speak the same remote-debugging
// (CDP) protocol, so the launch and connect logic below is identical for either.
// WORKCREW_CHROME_PATH / WORKCREW_EDGE_PATH force a specific executable.
function firstExisting(candidates: (string | undefined)[]): string | null {
  return candidates.filter((value): value is string => Boolean(value)).find((candidate) => existsSync(candidate)) ?? null;
}
function findBrowser(): { path: string; name: string } | null {
  const chrome = firstExisting([
    process.env.WORKCREW_CHROME_PATH,
    join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe")
  ]);
  if (chrome) return { path: chrome, name: "Chrome" };
  const edge = firstExisting([
    process.env.WORKCREW_EDGE_PATH,
    join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
    join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    join(process.env["LOCALAPPDATA"] ?? "", "Microsoft\\Edge\\Application\\msedge.exe")
  ]);
  if (edge) return { path: edge, name: "Edge" };
  return null;
}

export class BrowserCli {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  // Click recording state. recordBuffer collects the descriptive events reported
  // by the in-page recorder; recordBound is true once the __wcRecord binding is
  // installed on the context; recordOnPage injects the recorder into any new tab
  // opened while recording; recordPageHandlers tracks each page's load listener so
  // they can be detached on stop. Together these capture multi-tab, multi-page
  // flows (links opening new tabs, popups) end to end.
  private recordBuffer: RecordedEvent[] = [];
  private recordBound = false;
  private recordOnPage: ((page: Page) => void) | null = null;
  private recordPageHandlers = new Map<Page, () => void>();

  /**
   * Launch a Chrome (or Edge, if Chrome is not installed) window with remote
   * debugging enabled, using a dedicated WorkCrew profile that persists the user's
   * sign-ins across runs. This is the one-time setup so automations can act with
   * the user's accounts. If a browser is already reachable on the debugging port
   * this is effectively a no-op.
   */
  async launchBrowser(): Promise<{ launched: boolean; message: string }> {
    if (await this.isReachable()) return { launched: false, message: "The automation browser is already running." };
    const browser = findBrowser();
    if (!browser) {
      throw new Error("No supported browser was found. Install Google Chrome or Microsoft Edge to use browser automation.");
    }
    const profileDir = join(app.getPath("userData"), "automation-profile");
    const child = spawn(browser.path, [
      `--remote-debugging-port=${DEFAULT_CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check"
    ], { detached: true, stdio: "ignore" });
    child.unref();
    // Wait briefly for the debugging endpoint to come up.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.isReachable()) return { launched: true, message: `Automation browser (${browser.name}) ready. Sign in to your accounts in this window.` };
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
      // The binding and listeners live on the context/pages, so they are gone
      // once we disconnect; clear our tracking so a later recording re-installs.
      this.recordBound = false;
      this.recordOnPage = null;
      this.recordPageHandlers.clear();
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

  // Begin recording what the user does in the automation browser as a readable
  // trace (which elements, typed text, pages). The in-page script reports a
  // navigate on each (re)install, so the starting page and every later page are
  // captured; the recorder is re-injected after navigations for multi-page flows.
  async recordStart(): Promise<void> {
    // Make sure the automation browser is up, just like a normal action, so the
    // user can start recording without clicking Connect browser first.
    if (!(await this.isReachable())) await this.launchBrowser();
    await this.connect();
    this.recordBuffer = [];
    if (!this.recordBound) {
      await this.context!.exposeBinding("__wcRecord", (_source, payload: unknown) => {
        const event = browserEventFromPayload(payload);
        if (event) this.recordBuffer.push(event);
      });
      this.recordBound = true;
    }
    // Install the in-page recorder on every page, current and future. The binding
    // is context-wide but the listeners are per page, so each tab must be injected
    // (and re-injected on its own navigations) for its clicks to be captured.
    const installOn = (target: Page): void => {
      const onLoad = (): void => { void target.evaluate(RECORDER_INSTALL).catch(() => {}); };
      target.on("load", onLoad);
      this.recordPageHandlers.set(target, onLoad);
      void target.evaluate(RECORDER_INSTALL).catch(() => {});
    };
    const onNewPage = (target: Page): void => installOn(target);
    this.context!.on("page", onNewPage);
    this.recordOnPage = onNewPage;
    for (const open of this.context!.pages()) installOn(open);
  }

  // Stop recording and return the captured trace (deduplicated). The caller sends
  // it to the model to be written up as one reusable instruction. Safe to call
  // when nothing was recording (returns an empty trace).
  async recordStop(): Promise<RecordedEvent[]> {
    if (this.context && this.recordOnPage) this.context.off("page", this.recordOnPage);
    this.recordOnPage = null;
    for (const [open, onLoad] of this.recordPageHandlers) {
      try { open.off("load", onLoad); } catch { /* page gone */ }
      try { await open.evaluate("window.__wcRecording = false"); } catch { /* page gone */ }
    }
    this.recordPageHandlers.clear();
    const trace = dedupeTrace(this.recordBuffer);
    this.recordBuffer = [];
    return trace;
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
