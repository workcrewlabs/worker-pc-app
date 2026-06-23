import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_CATALOG,
  REFERRAL_BONUS_MICRODOLLARS,
  type AttachmentRef,
  type BillingInterval,
  type ConversationSummary,
  type ModelTier,
  type PlanId,
  type SubscriptionState
} from "@workcrew/contracts";
import { formatTokens } from "./lib/storage";
import { DEFAULT_CHAT_MODEL, turnsFromMessages } from "./lib/chat";
import { useChatStream } from "./hooks/useChatStream";
import { ChatView } from "./components/ChatView";
import { AutomationPanel } from "./components/AutomationPanel";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AccountDialog } from "./components/AccountDialog";
import { InviteDialog } from "./components/InviteDialog";
import { RecorderDialog } from "./components/RecorderDialog";
import { ApprovalModal } from "./components/ApprovalModal";
import { useAutomationRunner } from "./hooks/useAutomationRunner";
import {
  loadPermissions,
  loadRoutines,
  markRoutineRan,
  nextDueRoutine,
  type PermissionState,
  type Routine
} from "./lib/storage";

type AppInfo = { name: string; version: string; authMode: string; billingMode: string };
type Phase = "loading" | "auth" | "paywall" | "workspace";
type PanelView = "chat" | "automation" | "routines" | "permissions" | "settings";

const EMPTY_ENTITLEMENT: SubscriptionState = {
  active: false,
  plan: null,
  interval: null,
  status: "none",
  currentPeriodEnd: null,
  budgetPeriodStart: null,
  budgetPeriodEnd: null,
  budgetMicrodollars: 0,
  usedMicrodollars: 0,
  reservedMicrodollars: 0
};

// Turn any raw error into one plain sentence a non-technical person can act on.
// Electron wraps anything thrown across the process boundary as
//   "Error invoking remote method 'channel': Error: <real message>"
// so we strip that wrapper and any leading "SomethingError:", then translate the
// few technical cases (network, timeout, server fault) into friendly language.
// Decide whether a typed message is a request to DO something on the user's
// computer (drive the browser or a Windows app) versus a question to answer in
// chat. Action requests are routed to the automation engine, which itself picks
// the browser (Playwright) or Windows (the Windows helper) tools as needed. The
// check is deliberately conservative: clear questions and writing requests stay
// in chat, and only imperative "do this on my machine" phrasing automates.
function looksLikeAutomation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 4) return false;
  // Plainly a question, or a writing/explaining request: keep it in chat.
  if (/^(how|what|whats|what's|why|when|who|where|which|is |are |do |does |can i|could you|would you|explain|tell me|write|draft|compose|summari|translate|define|describe|give me|list|brainstorm|suggest|recommend|help me (write|understand|learn|decide|with)|teach me|show me how)\b/.test(t)) {
    return false;
  }
  // Explicit machine or browser context always automates.
  if (/\b(in (my|the) browser|on (my|the) (computer|pc|laptop|desktop|machine)|on my screen)\b/.test(t)) return true;
  // Imperative automation verbs at the start: the user is telling WorkCrew to act.
  if (/^(open|launch|start|go to|navigate to|visit|sign ?in|log ?in|log into|search for|download|upload|play|pause|click|fill|select|book|order|buy|reserve|post|publish|reply to|forward|organi[sz]e|tidy|sort|rename|move|copy|scroll|browse|add to cart|check out)\b/.test(t)) {
    return true;
  }
  // A known app or site paired with an action verb anywhere in the sentence.
  if (
    /\b(tiktok|youtube|gmail|outlook|excel|word|powerpoint|spotify|whatsapp|instagram|twitter|amazon|netflix|linkedin|facebook|reddit|notion|slack|discord)\b/.test(t) &&
    /\b(open|play|search|post|message|send|go|sign|log|find|watch|download|like|follow|comment)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  message = message
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .trim();

  if (!message) return "Something went wrong. Please try again.";
  if (/abort|timed? ?out|ETIMEDOUT/i.test(message)) {
    return "The connection timed out. Check your internet and try again.";
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|failed to fetch/i.test(message)) {
    return "Could not reach WorkCrew. Check your internet connection and try again.";
  }
  if (/service could not complete|internal server|status 5\d\d/i.test(message)) {
    return "Something went wrong on our side. Please wait a moment and try again.";
  }
  return message;
}

function LogoMark() {
  return (
    <svg className="brand-glyph" viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="wc-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
        <mask id="wc-plus">
          <rect width="100" height="100" fill="white" />
          <rect x="41" y="29" width="18" height="42" rx="9" fill="black" />
          <rect x="29" y="41" width="42" height="18" rx="9" fill="black" />
        </mask>
      </defs>
      <g mask="url(#wc-plus)" fill="url(#wc-grad)">
        <circle cx="50" cy="28" r="22" />
        <circle cx="50" cy="72" r="22" />
        <circle cx="28" cy="50" r="22" />
        <circle cx="72" cy="50" r="22" />
        <rect x="28" y="28" width="44" height="44" rx="14" />
      </g>
    </svg>
  );
}

// A success checkmark in a soft ring, shown on the "check your inbox" screens.
function CheckBadge() {
  return (
    <svg className="auth-check" viewBox="0 0 52 52" role="img" aria-hidden="true" focusable="false">
      <circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <path d="M16 26.5l6.5 6.5L37 18" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`} aria-label="WorkCrew">
      <span className="brand-mark"><LogoMark /></span>
      <span className="brand-name">WorkCrew</span>
    </div>
  );
}

function AuthScreen({ onReady }: { onReady: () => Promise<void> }) {
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  // When set, we show a "check your inbox" confirmation instead of the form:
  // "verify" after creating an account, "reset" after asking for a reset link.
  const [sent, setSent] = useState<null | "verify" | "reset">(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      if (mode === "reset") {
        await window.workcrew.auth.reset(email);
        setSent("reset");
      } else if (mode === "signup") {
        const result = await window.workcrew.auth.signUp(email, password, referralCode.trim() || undefined) as { needsVerification?: boolean };
        // Show the inbox confirmation. The email and password stay in state so
        // that after verifying, "Back to sign in" lets the user sign in at once.
        if (result.needsVerification) setSent("verify");
        else await onReady();
      } else {
        await window.workcrew.auth.signIn(email, password);
        await onReady();
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    const isVerify = sent === "verify";
    return (
      <main className="auth-shell">
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <section className="auth-card auth-sent">
          <Brand />
          <span className="auth-check-badge"><CheckBadge /></span>
          <h1>Check your inbox</h1>
          <p className="muted">
            We sent {isVerify ? "a verification link" : "a password reset link"} to <strong>{email || "your email"}</strong>.{" "}
            {isVerify
              ? "Open it to confirm your account, then come back here and sign in."
              : "Open it to choose a new password, then come back here and sign in."}
          </p>
          <p className="auth-hint">The email can take a minute to arrive. If you do not see it, check your spam folder.</p>
          <button className="primary full" onClick={() => { setSent(null); setMode("signin"); setNotice(""); }}>Back to sign in</button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="auth-card">
        <Brand />
        <p className="eyebrow">SECURE WINDOWS AUTOMATION</p>
        <h1>{mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your crew" : "Reset your password"}</h1>
        <p className="muted">Your work stays under your control. WorkCrew acts only with the permissions you grant.</p>
        <form onSubmit={submit}>
          <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          {mode !== "reset" && (
            <label>Password
              <div className="password-field">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={10}
                  required
                />
                <button
                  type="button"
                  className="password-eye"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C5 20 1 12 1 12a21.6 21.6 0 0 1 5.06-6.94M9.9 4.24A11 11 0 0 1 12 4c7 0 11 8 11 8a21.8 21.8 0 0 1-3.16 4.19M1 1l22 22" /><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                  )}
                </button>
              </div>
            </label>
          )}
          {mode === "signup" && (
            <label>Referral code (optional)
              <input type="text" value={referralCode} onChange={(event) => setReferralCode(event.target.value)} autoComplete="off" maxLength={40} placeholder="Enter a friend's invite code" />
            </label>
          )}
          <button className="primary full" disabled={busy}>{busy ? "Please wait" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}</button>
        </form>
        {notice && <p className="notice notice-error" role="alert">{notice}</p>}
        <div className="auth-links">
          <button onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>{mode === "signup" ? "Already have an account" : "Create an account"}</button>
          <button onClick={() => setMode(mode === "reset" ? "signin" : "reset")}>{mode === "reset" ? "Back to sign in" : "Forgot password"}</button>
        </div>
      </section>
    </main>
  );
}

function Paywall({ info, onActivated }: { info: AppInfo; onActivated: (state: SubscriptionState) => void }) {
  const [interval, setInterval] = useState<BillingInterval>("year");
  const [busy, setBusy] = useState<PlanId | null>(null);
  const [error, setError] = useState("");
  const simulated = info.billingMode === "simulated";

  async function choose(plan: PlanId) {
    setBusy(plan);
    setError("");
    try {
      // In simulated mode the entitlement flips to active locally with no real
      // payment. Otherwise the system browser opens the real Stripe checkout and
      // the entitlement arrives later via the webhook (the user re-enters the
      // app already active).
      if (simulated) onActivated(await window.workcrew.api.simulateCheckout(plan, interval));
      else await window.workcrew.api.checkout(plan, interval);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="paywall-shell">
      <header className="paywall-header"><Brand /><span className="secure-pill">Secure checkout</span></header>
      <section className="pricing-intro">
        <p className="eyebrow">CHOOSE YOUR WORKCREW PLAN</p>
        <h1>Put routine work on autopilot</h1>
        <p>Every plan includes secure browser and Windows automation. Annual billing is selected by default and includes two months free.</p>
        <div className="billing-toggle" role="group" aria-label="Billing interval">
          <button className={interval === "year" ? "active" : ""} onClick={() => setInterval("year")}>Yearly <span>Save 17%</span></button>
          <button className={interval === "month" ? "active" : ""} onClick={() => setInterval("month")}>Monthly</button>
        </div>
      </section>
      <section className="price-grid">
        {(["pro", "ultra"] as const).map((plan) => {
          const item = PLAN_CATALOG[plan];
          const annual = interval === "year";
          const price = annual ? item.yearlyPriceUsd / 12 : item.monthlyPriceUsd;
          return (
            <article className={`price-card ${plan === "ultra" ? "featured" : ""}`} key={plan}>
              {plan === "ultra" && <span className="popular">MOST CAPABLE</span>}
              <h2>{item.name}</h2>
              <p className="plan-for">{plan === "pro" ? "For focused personal workflows" : "For demanding daily automation"}</p>
              <div className="price"><strong>${Math.round(price)}</strong><span>/ month</span></div>
              <p className="billed">{annual ? `$${item.yearlyPriceUsd.toLocaleString()} billed yearly` : "Billed monthly"}</p>
              <button className={plan === "ultra" ? "primary full" : "secondary full"} onClick={() => choose(plan)} disabled={Boolean(busy)}>
                {busy === plan ? "Preparing" : simulated ? `Activate ${item.name}` : `Subscribe to ${item.name}`}
              </button>
              <ul>
                <li>{formatTokens(item.monthlyApiBudgetMicrodollars)} tokens every month</li>
                <li>{item.devices} Windows {item.devices === 1 ? "device" : "devices"}</li>
                <li>Automate anything in your browser</li>
                <li>Automate your Windows apps and files</li>
                <li>Save tasks and run them on a schedule</li>
                {plan === "ultra" && <li>Priority automation and support</li>}
              </ul>
            </article>
          );
        })}
      </section>
      {error && <p className="error-banner">{error}</p>}
      {simulated && <p className="paywall-foot">Test activation. This unlocks the workspace with no real payment and no card charged.</p>}
      <p className="paywall-foot">No free tier. No API usage begins until payment is confirmed.</p>
    </main>
  );
}

function Workspace({ info, entitlement, onSignOut, onUpgrade, onAdjustPlan }: { info: AppInfo; entitlement: SubscriptionState; onSignOut: () => Promise<void>; onUpgrade: () => Promise<void>; onAdjustPlan: (plan: PlanId, interval: BillingInterval) => Promise<void> }) {
  const [model, setModel] = useState<ModelTier>(DEFAULT_CHAT_MODEL);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");
  const isUltra = entitlement.plan === "ultra";
  const [view, setView] = useState<PanelView>("chat");
  const [accountOpen, setAccountOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [permissions, setPermissions] = useState<PermissionState>(() => loadPermissions());
  const [routines, setRoutines] = useState<Routine[]>(() => loadRoutines());
  const [recents, setRecents] = useState<ConversationSummary[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // An example automation the user clicked on the home screen, carried into the
  // Automation panel as its starting task.
  const [automationSeed, setAutomationSeed] = useState("");
  // A task being turned into a routine via "Save as a routine", carried into the
  // Routines form.
  const [routineSeed, setRoutineSeed] = useState("");
  // Auto-update status, surfaced as a sidebar button when an update is ready.
  const [update, setUpdate] = useState<{ state: string; version?: string; percent?: number } | null>(null);
  // "Always allow": when on, automations run without asking for each write action.
  const [alwaysAllow, setAlwaysAllowState] = useState<boolean>(() => {
    try { return localStorage.getItem("workcrew.alwaysAllow") === "1"; } catch { return false; }
  });
  function setAlwaysAllow(value: boolean) {
    setAlwaysAllowState(value);
    try { localStorage.setItem("workcrew.alwaysAllow", value ? "1" : "0"); } catch { /* storage unavailable */ }
  }

  const chat = useChatStream();
  const runner = useAutomationRunner();
  const { conversationId, usedTokens } = chat;

  // Scheduler: while the app is open, check every 30 seconds for a routine that
  // is due, and run it through the shared runner when nothing else is running.
  // Held in a ref so the interval always sees the latest routines and run state.
  const schedulerState = useRef({ routines, running: runner.running });
  schedulerState.current = { routines, running: runner.running };
  useEffect(() => {
    const timer = setInterval(() => {
      const { routines: current, running } = schedulerState.current;
      if (running) return;
      const due = nextDueRoutine(current, Date.now());
      if (!due) return;
      setRoutines(markRoutineRan(due.id, Date.now()));
      void runner.run(due.task, model, due.name);
    }, 30_000);
    return () => clearInterval(timer);
    // runner.run and model are stable enough; the ref carries live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Usage shown in the header. It starts from the entitlement and updates to the
  // latest value reported by a completed chat turn (done frame usage).
  const usage = usedTokens ?? entitlement.usedMicrodollars;
  const percent = Math.min(100, ((usage + entitlement.reservedMicrodollars) / entitlement.budgetMicrodollars) * 100 || 0);

  // Load the Recents list. Failures are non-fatal: the chat surface still works
  // even if the conversations endpoint is unavailable.
  async function refreshRecents() {
    try {
      const list = await window.workcrew.conversations.list();
      setRecents(Array.isArray(list) ? list : []);
    } catch {
      setRecents([]);
    }
  }

  useEffect(() => {
    void refreshRecents();
  }, []);

  // Subscribe to auto-update status and check once on launch. In a packaged
  // build this downloads a newer version in the background and reports "ready";
  // in development it reports "unsupported" and the button never shows.
  useEffect(() => {
    const off = window.workcrew.updates.onStatus((status) => setUpdate(status));
    void window.workcrew.updates.check();
    return off;
  }, []);

  // Keep the runner's auto-approve in sync with the persisted setting.
  useEffect(() => {
    runner.setAutoApprove(alwaysAllow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alwaysAllow]);

  // Refresh Recents after a conversation finishes its first turn so a brand new
  // chat appears in the sidebar.
  useEffect(() => {
    if (conversationId) void refreshRecents();
  }, [conversationId]);

  function startNewChat() {
    chat.reset();
    setView("chat");
    setAccountOpen(false);
  }

  // Open the Automation panel with an example task filled in, ready to run.
  function startAutomation(task: string) {
    setAutomationSeed(task);
    setView("automation");
    setAccountOpen(false);
  }

  // Carry a just-run automation into the Routines form so it can be scheduled.
  function saveAsRoutine(task: string) {
    setRoutineSeed(task);
    setView("routines");
    setAccountOpen(false);
  }

  // Load a saved conversation into the transcript.
  async function openConversation(id: string) {
    if (loadingId) return;
    setLoadingId(id);
    setView("chat");
    setAccountOpen(false);
    try {
      const detail = await window.workcrew.conversations.get(id);
      chat.reset(turnsFromMessages(detail.messages), detail.id);
    } catch {
      // Leave the current transcript in place if the load fails.
    } finally {
      setLoadingId(null);
    }
  }

  function send(text: string, attachments: AttachmentRef[]) {
    // If the message is a request to act on the computer (and has no attachments
    // to reason over), hand it to the automation engine and open the Automation
    // view so the user sees it run. Otherwise answer it in chat.
    if (attachments.length === 0 && !runner.running && looksLikeAutomation(text)) {
      setAutomationSeed(text);
      setView("automation");
      setAccountOpen(false);
      void runner.run(text, model, "Task");
      return;
    }
    void chat.send({ text, model, attachments });
  }

  async function handleUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    setUpgradeError("");
    try {
      await onUpgrade();
    } catch (error) {
      // Surface the reason instead of failing silently (for example a price that
      // is not configured, or checkout being unavailable).
      setUpgradeError(error instanceof Error ? error.message : "The upgrade could not be started.");
    } finally {
      setUpgrading(false);
    }
  }

  const planLabel = entitlement.plan ? PLAN_CATALOG[entitlement.plan].name : "No plan";
  // The header shows the current conversation's auto-generated title, and stays
  // empty on a new chat (no duplicate brand logo).
  const chatTitle = conversationId ? (recents.find((item) => item.id === conversationId)?.title ?? "") : "";

  // The app checks for updates on its own when it opens (see the effect above),
  // downloads any new version in the background, and only then surfaces a single
  // "Restart to update" button. There is no manual "Check for updates" button to
  // press here; the sidebar control appears only while an update is downloading
  // or is ready to install, and is hidden otherwise. (Settings still offers a
  // manual check for anyone who wants one.)
  const updateState = update?.state ?? "idle";
  const updateReady = updateState === "ready";
  const updateDownloading = updateState === "downloading" || updateState === "available";
  const showUpdatePill = updateReady || updateDownloading;
  const updateText = updateReady ? "Restart to update" : `Downloading update ${update?.percent ?? 0}%`;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand compact />
        <button className="new-chat" onClick={startNewChat} aria-label="New chat">
          <span className="new-chat-plus" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span> New chat
        </button>
        <nav aria-label="Workspace sections">
          <button
            className={view === "automation" ? "nav-active" : ""}
            aria-current={view === "automation" ? "page" : undefined}
            onClick={() => { setAutomationSeed(""); setView("automation"); }}
          >
            <span>A</span> Automation
          </button>
          <button
            className={view === "routines" ? "nav-active" : ""}
            aria-current={view === "routines" ? "page" : undefined}
            onClick={() => { setRoutineSeed(""); setView("routines"); }}
          >
            <span>R</span> Routines
          </button>
          <button
            className={view === "permissions" ? "nav-active" : ""}
            aria-current={view === "permissions" ? "page" : undefined}
            onClick={() => setView("permissions")}
          >
            <span>P</span> Permissions
          </button>
          <button
            className={view === "settings" ? "nav-active" : ""}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            <span>S</span> Settings
          </button>
        </nav>
        <div className="recents" aria-label="Recent conversations">
          <span className="recents-title">Recents</span>
          {recents.length === 0 ? (
            <p className="recents-empty">Your conversations appear here.</p>
          ) : (
            <div className="recents-list">
              {recents.map((item) => (
                <button
                  key={item.id}
                  className={item.id === conversationId ? "recent-active" : ""}
                  onClick={() => void openConversation(item.id)}
                  title={item.title}
                >
                  {item.title || "New conversation"}
                </button>
              ))}
            </div>
          )}
        </div>
        {!isUltra && (
          <button className="upgrade-card" onClick={handleUpgrade} disabled={upgrading} aria-label="Upgrade to Ultra">
            <span className="upgrade-spark"><LogoMark /></span>
            <span>
              <strong>{upgrading ? "Upgrading..." : "Upgrade to Ultra"}</strong>
              <small>More devices and the largest token allowance</small>
            </span>
          </button>
        )}
        <button className="invite-button" onClick={() => setInviteOpen(true)} aria-label="Invite a friend and earn tokens">
          <span className="invite-gift" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 12 20 22 4 22 4 12" />
              <rect x="2" y="7" width="20" height="5" />
              <line x1="12" y1="22" x2="12" y2="7" />
              <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
              <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
            </svg>
          </span>
          <span><strong>Invite & earn</strong><small>Get {formatTokens(REFERRAL_BONUS_MICRODOLLARS)} tokens per friend</small></span>
        </button>
        {showUpdatePill && (
          <button
            className={`update-pill ${updateReady ? "update-ready" : ""}`}
            onClick={() => { if (updateReady) void window.workcrew.updates.install(); }}
            disabled={!updateReady}
            aria-label={updateText}
            title={updateText}
          >
            <span className="update-dot" aria-hidden="true" />
            <span>{updateText}</span>
          </button>
        )}
        <div className="sidebar-security"><span className="shield">S</span><div><strong>Protected locally</strong><small>Write actions ask first</small></div></div>
        <button className="account-button" onClick={() => setAccountOpen(true)} aria-label="Open account">
          <span className="avatar">A</span>
          <span><strong>Account</strong><small>{planLabel}</small></span>
          <span className="signout">View</span>
        </button>
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <h1 className="workspace-title" title={chatTitle}>{chatTitle}</h1>
          <div className="header-right">
            {!isUltra && (
              <button className="upgrade-pill" onClick={handleUpgrade} disabled={upgrading}>
                {upgrading ? "Upgrading..." : "Upgrade"}
              </button>
            )}
            <div className="usage-box">
              <div><span>Tokens</span><strong>{formatTokens(Math.max(0, entitlement.budgetMicrodollars - usage))} left</strong></div>
              <div className="usage-track"><span style={{ width: `${percent}%` }} /></div>
            </div>
          </div>
        </header>
        {upgradeError && <div className="upgrade-error-bar" role="alert">{upgradeError}</div>}
        <ChatView
          turns={chat.turns}
          streaming={chat.streaming}
          model={model}
          onModelChange={setModel}
          onSend={send}
          onStop={chat.stop}
          onAutomate={startAutomation}
          onRecord={() => setRecorderOpen(true)}
        />
        <footer>WorkCrew can make mistakes. Check important details.</footer>
      </section>

      {view === "permissions" && (
        <PermissionsPanel
          permissions={permissions}
          onClose={() => setView("chat")}
          onChange={setPermissions}
        />
      )}
      {view === "automation" && <AutomationPanel runner={runner} model={model} initialTask={automationSeed} onSaveRoutine={saveAsRoutine} alwaysAllow={alwaysAllow} onAlwaysAllowChange={setAlwaysAllow} onClose={() => setView("chat")} />}
      {view === "routines" && (
        <RoutinesPanel runner={runner} model={model} routines={routines} initialTask={routineSeed} onChange={setRoutines} onClose={() => setView("chat")} />
      )}
      {view === "settings" && <SettingsPanel info={info} onClose={() => setView("chat")} />}
      {runner.pending && (
        <ApprovalModal
          action={runner.pending.action}
          label={runner.pending.label}
          onDecide={runner.decide}
          onAllowAlways={() => { setAlwaysAllow(true); runner.setAutoApprove(true); runner.decide(true); }}
        />
      )}
      {accountOpen && (
        <AccountDialog
          entitlement={entitlement}
          usedMicrodollars={usage}
          onClose={() => setAccountOpen(false)}
          onSignOut={onSignOut}
          onAdjustPlan={onAdjustPlan}
        />
      )}
      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
      {recorderOpen && (
        <RecorderDialog
          onClose={() => setRecorderOpen(false)}
          onSaved={() => setRoutines(loadRoutines())}
        />
      )}
    </main>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [entitlement, setEntitlement] = useState<SubscriptionState>(EMPTY_ENTITLEMENT);
  const [fatal, setFatal] = useState("");

  async function refresh() {
    try {
      const [appInfo, session] = await Promise.all([window.workcrew.app.info(), window.workcrew.auth.session()]);
      setInfo(appInfo);
      if (!session.authenticated) {
        setPhase("auth");
        return;
      }
      try {
        const state = await window.workcrew.api.entitlement();
        setEntitlement(state);
        setPhase(state.active ? "workspace" : "paywall");
      } catch (entitlementError) {
        // A stored session can be invalid for the current backend, for example
        // after switching the backend address or when the token has expired. In
        // that case drop cleanly to the sign-in screen instead of a dead-end
        // error. Any other failure (a real outage) still shows Try again.
        const message = errorMessage(entitlementError).toLowerCase();
        const isAuthIssue = /session|sign in|expired|auth|401|unauthor/.test(message);
        if (isAuthIssue) {
          await window.workcrew.auth.signOut().catch(() => {});
          setPhase("auth");
          return;
        }
        throw entitlementError;
      }
    } catch (error) {
      setFatal(errorMessage(error));
      setPhase("loading");
    }
  }

  useEffect(() => { void refresh(); }, []);

  // After paying in the external browser, the user returns to this window. Re-run
  // the entitlement check on focus while on the paywall so a completed checkout
  // moves them into the workspace without a manual restart.
  useEffect(() => {
    function onFocus() {
      if (phase === "paywall") void refresh();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [phase]);

  const loadingMessage = useMemo(() => fatal || "Starting WorkCrew securely...", [fatal]);
  if (phase === "loading" || !info) return <main className="loading-shell"><Brand /><div className="loading-line" /><p>{loadingMessage}</p>{fatal && <button className="secondary" onClick={() => { setFatal(""); void refresh(); }}>Try again</button>}</main>;
  if (phase === "auth") return <AuthScreen onReady={refresh} />;
  if (phase === "paywall") return <Paywall info={info} onActivated={(state) => { setEntitlement(state); setPhase("workspace"); }} />;
  return (
    <Workspace
      info={info}
      entitlement={entitlement}
      onSignOut={async () => { await window.workcrew.auth.signOut(); setPhase("auth"); }}
      onUpgrade={async () => {
        if (info.billingMode === "simulated") {
          setEntitlement(await window.workcrew.api.simulateCheckout("ultra", "year"));
        } else if (entitlement.active) {
          // Already a paying subscriber: switch the existing plan in place (with
          // proration) instead of opening a second checkout and double charging.
          setEntitlement(await window.workcrew.api.changePlan("ultra", "year"));
        } else {
          await window.workcrew.api.checkout("ultra", "year");
        }
      }}
      onAdjustPlan={async (plan, interval) => {
        // The account dialog only opens for an active subscriber, so this either
        // switches the live Stripe plan in place (with proration) or, in test
        // mode, re-activates at the chosen plan. It never cancels.
        if (info.billingMode === "simulated") {
          setEntitlement(await window.workcrew.api.simulateCheckout(plan, interval));
        } else {
          setEntitlement(await window.workcrew.api.changePlan(plan, interval));
        }
      }}
    />
  );
}
