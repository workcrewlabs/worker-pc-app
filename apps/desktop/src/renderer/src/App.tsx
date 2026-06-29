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
import { identifyUser, track } from "./lib/analytics";
import { DEFAULT_CHAT_MODEL, turnsFromMessages } from "./lib/chat";
import { useChatStream } from "./hooks/useChatStream";
import { ChatView } from "./components/ChatView";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AccountDialog } from "./components/AccountDialog";
import { InviteDialog } from "./components/InviteDialog";
import { RecorderDialog } from "./components/RecorderDialog";
import { ApprovalModal } from "./components/ApprovalModal";
import { UsageBanner } from "./components/UsageBanner";
import { usageStatus } from "./lib/usage";
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
type PanelView = "chat" | "routines" | "permissions" | "settings";

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
  reservedMicrodollars: 0,
  fiveHourLimitMicrodollars: 0,
  fiveHourUsedMicrodollars: 0,
  dailyLimitMicrodollars: 0,
  dailyUsedMicrodollars: 0,
  pendingPlan: null,
  pendingInterval: null,
  pendingEffective: null
};

// Tell a refreshed entitlement (returned by a downgrade) apart from the
// { opened: true } an upgrade returns when it opens a hosted payment page.
function isEntitlement(value: unknown): value is SubscriptionState {
  return Boolean(value) && typeof value === "object" && "budgetMicrodollars" in (value as Record<string, unknown>);
}

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
  if (/^(how|what|whats|what's|why|when|who|where|which|is |are |do |does |can i|can you|can u|could you|would you|explain|tell me|write|draft|compose|summari|translate|define|describe|give me|list|brainstorm|suggest|recommend|help me (write|understand|learn|decide|with)|teach me|show me how)\b/.test(t)) {
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
  // Clear coding actions (inherently imperative).
  if (/\b(clone|ffmpeg|run (the |a )?(script|command|tool))\b/.test(t)) return true;
  // git/github/repo only when paired with an action verb, so "my git is confusing"
  // stays in chat while "git pull the latest" or "set up the repo" automates.
  if (/\bgit\w*\b|\brepo\w*\b/.test(t) && /\b(clone|pull|push|commit|checkout|merge|rebase|init|fetch|set ?up|build|open|create|fix|run)\b/.test(t)) return true;
  // Media editing on a real media target near the verb (not the bare word "file").
  if (/\b(edit|crop|resize|trim|compress|rotate|convert|render|encode)\b(?:\s+\S+){0,4}\s+\b(image|images|photo|photos|picture|pictures|video|videos|clip|clips|gif)\b/.test(t)) return true;
  return false;
}

// A plain question or a writing request, as opposed to an instruction to redo a
// task. Used while iterating on an automation: a question is answered in chat,
// anything else is treated as a correction that re-runs the task.
function isQuestionLike(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(how|what|whats|what's|why|when|who|where|which|is |are |do |does |can i|can you|can u|could you|would you|explain|tell me|write|draft|compose|summari|translate|define|describe|give me|list|brainstorm|suggest|recommend|help me|teach me|show me how)\b/.test(t);
}

// Decide whether the user is asking WorkCrew to MAKE a file and hand it back to
// download (the Claude cowork style: "make me an excel file", "create a CSV",
// "give me a Word doc", "build a report"). This is always a chat request: the
// model generates the file's content and the chat shows a Download button. It
// must never seize the computer, even while a chat is in automation mode, so a
// file ask is checked before any automation routing. Asking to control an app
// ("open Excel and...", "in Excel", "on my computer") is the opposite and is
// left to the automation engine.
function looksLikeFileRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 5) return false;
  // Controlling an app or the machine is automation, not a file hand-off.
  if (/\b(open|launch|in|inside|using|control|automate)\s+(my\s+|the\s+)?(excel|word|powerpoint|sheets?|docs?)\b/.test(t)) return false;
  if (/\b(in (my|the) browser|on (my|the) (computer|pc|laptop|desktop|machine|screen))\b/.test(t)) return false;
  // A "produce and give me" verb paired with a file or document noun.
  const wants = /\b(make|create|build|generate|produce|prepare|put together|export|draft|write|give me|send me|i (?:need|want)|can you (?:make|create|build|generate|write|prepare))\b/;
  // Specific document nouns only. Bare "file" and "table" are deliberately left
  // out: paired with "i need"/"rename"/"sort" they would steal real automation
  // requests like "rename this file" or "sort this table" into the chat path.
  const fileNoun = /\b(excel|spreadsheet|spread sheet|workbook|csv|xlsx|word (?:doc\w*|file)|docx|document|report|text file|\.txt|markdown|\.md|json file|html file)\b/;
  return wants.test(t) && fileNoun.test(t);
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

// Sidebar nav icons: a lightning bolt for Routines, a lock for Permissions, and a
// gear for Settings, matching common app conventions.
function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" /></svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
  );
}
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
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
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    // The kind of auth attempt only; never the email or password.
    if (mode !== "reset") track("login_started", { mode });
    try {
      if (mode === "reset") {
        await window.workcrew.auth.reset(email);
        setSent("reset");
      } else if (mode === "signup") {
        const result = await window.workcrew.auth.signUp(email, password, name.trim() || undefined, referralCode.trim() || undefined) as { needsVerification?: boolean };
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
          {mode === "signup" && (
            <label>Your name<input type="text" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} placeholder="What should we call you?" /></label>
          )}
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

// A small circular gauge of the rolling 5-hour usage window, like the Claude
// desktop app. It shows how much of the 5-hour burst budget is used and frees up
// as the window rolls forward.
function FiveHourRing({ entitlement }: { entitlement: SubscriptionState }) {
  const limit = entitlement.fiveHourLimitMicrodollars;
  if (limit <= 0) return null;
  const pct = Math.min(100, Math.max(0, (entitlement.fiveHourUsedMicrodollars / limit) * 100));
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dash = (pct / 100) * circumference;
  const title = `5-hour limit: ${Math.round(pct)}% used. Frees up as the 5-hour window rolls forward.`;
  return (
    <div className={`five-hour-ring ${pct >= 80 ? "is-high" : ""}`} title={title} aria-label={title} role="img">
      <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
        <circle className="ring-bg" cx="11" cy="11" r={radius} fill="none" strokeWidth="2.5" />
        <circle className="ring-fg" cx="11" cy="11" r={radius} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${dash} ${circumference}`} transform="rotate(-90 11 11)" />
      </svg>
    </div>
  );
}

function Workspace({ info, entitlement, userName, onSetName, onRefreshEntitlement, onSignOut, onUpgrade, onAdjustPlan, onDeleteAccount }: { info: AppInfo; entitlement: SubscriptionState; userName: string | null; onSetName: (name: string) => Promise<void>; onRefreshEntitlement: () => void; onSignOut: () => Promise<void>; onUpgrade: () => Promise<void>; onAdjustPlan: (plan: PlanId, interval: BillingInterval) => Promise<void>; onDeleteAccount: () => Promise<void> }) {
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
  // The task of the automation currently shown inline in the chat (running or
  // just finished), used as the heading of the inline run activity.
  const [automationTask, setAutomationTask] = useState("");
  // Once a task has run in this chat, the chat is in "automation mode": typed
  // follow-ups that are not plain questions re-run the task (with the correction
  // added) so the user can refine and re-run repeatedly before saving a routine.
  const [automationMode, setAutomationMode] = useState(false);
  // Text to drop into the chat composer (for example a just-recorded task), with a
  // nonce so the same text can be sent into the composer more than once.
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  function seedComposer(text: string) {
    setComposerSeed((current) => ({ text, nonce: current.nonce + 1 }));
  }
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

  // When a chat turn or an automation run finishes it has consumed budget, so
  // re-fetch the entitlement to update the rolling 5-hour and daily figures (and
  // the 5-hour ring). The monthly "tokens left" already updates live from the
  // turn's done frame; this keeps the rolling windows honest right away instead
  // of waiting for the next window focus.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !chat.streaming) onRefreshEntitlement();
    wasStreaming.current = chat.streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.streaming]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !runner.running) onRefreshEntitlement();
    wasRunning.current = runner.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.running]);

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
      // Live guard: if a run started since the last state sync (e.g. the user
      // just sent a task), do not start the routine and do not mark it ran, so
      // it stays due and fires on the next free tick instead of silently being
      // skipped. No await separates this check from run(), so it is atomic.
      if (runner.isBusy()) return;
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
  // Token status drives the low/empty banner above the chat. It uses the live
  // usage figure so it appears as soon as a turn pushes the user near the limit.
  const usageState = usageStatus(entitlement, usage);

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

  // Keep the runner's per-category permissions in sync, so turning a category off
  // makes it ask again even while "Always allow" is on.
  useEffect(() => {
    runner.setPermissions(permissions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions]);

  // Refresh Recents after a conversation finishes its first turn so a brand new
  // chat appears in the sidebar.
  useEffect(() => {
    if (conversationId) void refreshRecents();
  }, [conversationId]);

  function startNewChat() {
    chat.reset();
    runner.clear();
    setAutomationTask("");
    setAutomationMode(false);
    setView("chat");
    setAccountOpen(false);
  }

  // Run an automation inline in the chat (from a typed task or an example chip).
  // The task auto-runs as soon as it is recognised; there is no separate "run"
  // button. The shared runner drives the steps and the chat shows them in place.
  // Running a task puts the chat in automation mode so follow-ups can re-run it.
  function runAutomation(task: string, label = "Task") {
    const trimmed = task.trim();
    if (trimmed.length < 3 || runner.isBusy()) return;
    setView("chat");
    setAccountOpen(false);
    setAutomationTask(trimmed);
    setAutomationMode(true);
    void runner.run(trimmed, model, label);
  }

  // Run the current task again unchanged (the "Run again" button on a finished
  // run), so the user can retry after fixing something on screen.
  function rerunAutomation() {
    if (automationTask.trim().length >= 3) runAutomation(automationTask, "Task");
  }

  // Carry a task into the Routines form so it can be named and scheduled.
  function saveAsRoutine(task: string) {
    setRoutineSeed(task);
    setView("routines");
    setAccountOpen(false);
  }

  // Save whatever the current chat is doing as a routine: prefer the automation
  // task in progress, otherwise the most recent thing the user asked. The
  // Routines form then lets the user name and schedule it.
  function saveCurrentAsRoutine() {
    const lastUser = [...chat.turns].reverse().find((turn) => turn.role === "user");
    const task = (automationTask || lastUser?.text || "").trim();
    if (task.length < 3) return;
    saveAsRoutine(task);
  }

  // Load a saved conversation into the transcript.
  async function openConversation(id: string) {
    if (loadingId) return;
    setLoadingId(id);
    setView("chat");
    setAccountOpen(false);
    runner.clear();
    setAutomationTask("");
    setAutomationMode(false);
    try {
      const detail = await window.workcrew.conversations.get(id);
      chat.reset(turnsFromMessages(detail.messages), detail.id);
    } catch {
      // Leave the current transcript in place if the load fails.
    } finally {
      setLoadingId(null);
    }
  }

  function send(text: string, attachments: AttachmentRef[], localPaths: string[] = []) {
    // A request to be handed a file ("make me an excel file", "give me a CSV")
    // is always a chat request: WorkCrew generates the file and shows a Download
    // button. It must never seize the computer, so it is checked first and wins
    // over automation, even while this chat is in automation mode.
    const fileRequest = looksLikeFileRequest(text);
    if (!runner.running && !fileRequest) {
      // Files attached with a request to act on them (for example "crop this
      // image" or "clean up this spreadsheet") run as an automation that works on
      // the real files on the computer, by passing their local paths to the model
      // so it can edit the originals with its tools rather than only the copy.
      if (localPaths.length > 0 && looksLikeAutomation(text)) {
        const list = localPaths.map((path) => `"${path}"`).join(", ");
        runAutomation(`${text}\n\nWork on these local files directly on the computer: ${list}`, "Task");
        return;
      }
      if (attachments.length === 0) {
        // While iterating on a task in this chat, a follow-up that is not a plain
        // question is treated as a correction: re-run the task with the fix added
        // so the user can keep refining and re-running before saving a routine.
        if (automationMode && !isQuestionLike(text)) {
          const combined = `${automationTask}\n\nThe last attempt was not right. Correction from the user: ${text}\nPlease do the whole task again with this fix.`;
          runAutomation(combined, "Task");
          return;
        }
        // A fresh request to act on the computer starts an inline automation.
        if (!automationMode && looksLikeAutomation(text)) {
          runAutomation(text, "Task");
          return;
        }
      }
    }
    // Otherwise answer in chat. A normal chat message (with no in-flight run)
    // clears any finished automation activity so the conversation stays tidy.
    if (!runner.running) {
      runner.clear();
      setAutomationTask("");
      setAutomationMode(false);
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
        <div className="sidebar-brand-row">
          <Brand compact />
          <span className="app-version" title="App version">v{info.version}</span>
        </div>
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
            className={view === "routines" ? "nav-active" : ""}
            aria-current={view === "routines" ? "page" : undefined}
            onClick={() => { setRoutineSeed(""); setView("routines"); }}
          >
            <span className="nav-icon"><BoltIcon /></span> Routines
          </button>
          <button
            className={view === "permissions" ? "nav-active" : ""}
            aria-current={view === "permissions" ? "page" : undefined}
            onClick={() => setView("permissions")}
          >
            <span className="nav-icon"><LockIcon /></span> Permissions
          </button>
          <button
            className={view === "settings" ? "nav-active" : ""}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            <span className="nav-icon"><GearIcon /></span> Settings
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
                  <span className="recent-title">{item.title || "New conversation"}</span>
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
        <button className="account-button" onClick={() => setAccountOpen(true)} aria-label="Open account">
          <span className="avatar">{(userName?.trim()?.[0] ?? "A").toUpperCase()}</span>
          <span><strong>{userName?.trim() || "Account"}</strong><small>{planLabel}</small></span>
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
            <FiveHourRing entitlement={entitlement} />
            <div className="usage-box">
              <div><span>Tokens</span><strong>{formatTokens(Math.max(0, entitlement.budgetMicrodollars - usage))} left</strong></div>
              <div className="usage-track"><span style={{ width: `${percent}%` }} /></div>
            </div>
          </div>
        </header>
        {upgradeError && <div className="upgrade-error-bar" role="alert">{upgradeError}</div>}
        {entitlement.active && (
          <UsageBanner
            status={usageState}
            onUpgrade={() => void handleUpgrade()}
            upgrading={upgrading}
          />
        )}
        <ChatView
          turns={chat.turns}
          streaming={chat.streaming}
          model={model}
          onModelChange={setModel}
          onSend={send}
          onStop={chat.stop}
          onAutomate={(task) => runAutomation(task, "Task")}
          onRecord={() => setRecorderOpen(true)}
          runner={runner}
          automationTask={automationTask}
          alwaysAllow={alwaysAllow}
          onAlwaysAllowChange={setAlwaysAllow}
          onSaveRoutine={saveCurrentAsRoutine}
          onRerun={rerunAutomation}
          composerSeed={composerSeed}
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
          userName={userName}
          onSaveName={onSetName}
          onClose={() => setAccountOpen(false)}
          onSignOut={onSignOut}
          onAdjustPlan={onAdjustPlan}
          onDeleteAccount={onDeleteAccount}
        />
      )}
      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
      {recorderOpen && (
        <RecorderDialog
          onClose={() => setRecorderOpen(false)}
          onUseInChat={(task) => { setRecorderOpen(false); seedComposer(task); }}
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
  const [userName, setUserName] = useState<string | null>(null);

  async function refresh() {
    try {
      const [appInfo, session] = await Promise.all([window.workcrew.app.info(), window.workcrew.auth.session()]);
      setInfo(appInfo);
      if (!session.authenticated) {
        setPhase("auth");
        return;
      }
      setUserName(session.name ?? null);
      try {
        const state = await window.workcrew.api.entitlement();
        setEntitlement(state);
        // The session is now proven valid (entitlement loaded). Identify once
        // here, the single post-validation point, so a stale stored session is
        // never identified and a fresh login does not double-fire identify.
        identifyUser();
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

  // Update the display name via the backend, then reflect it locally at once.
  async function setUserDisplayName(newName: string): Promise<void> {
    const result = await window.workcrew.auth.setName(newName);
    setUserName(result.name ?? null);
  }

  useEffect(() => { void refresh(); }, []);

  // Fire app_opened once, and record uncaught renderer errors as a coarse, safe
  // category (never the message, which could contain user input or paths).
  useEffect(() => {
    track("app_opened");
    const onError = (event: ErrorEvent): void => track("app_error", { source: "desktop", category: event.error?.name ?? "error" });
    const onRejection = (): void => track("app_error", { source: "desktop", category: "unhandledrejection" });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Re-fetch only the entitlement (not the whole phase flow). Used after a chat
  // turn or automation run finishes, and when the window regains focus, so the
  // rolling 5-hour and daily figures (and the 5-hour ring) reflect the latest
  // usage rather than the value from the last full load.
  function refreshEntitlement() {
    void window.workcrew.api.entitlement().then(setEntitlement).catch(() => {});
  }

  // After paying in the external browser, the user returns to this window. On the
  // paywall, re-run the full check so a completed first checkout moves them into
  // the workspace. In the workspace, refresh just the entitlement so a completed
  // plan upgrade (paid in the browser) is reflected without a manual restart.
  useEffect(() => {
    function onFocus() {
      if (phase === "paywall") void refresh();
      else if (phase === "workspace") refreshEntitlement();
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
      userName={userName}
      onSetName={setUserDisplayName}
      onRefreshEntitlement={refreshEntitlement}
      onSignOut={async () => { await window.workcrew.auth.signOut(); setPhase("auth"); }}
      onDeleteAccount={async () => { await window.workcrew.auth.deleteAccount(); setPhase("auth"); }}
      onUpgrade={async () => {
        // Upgrade to Ultra monthly ($200/mo), matching how the plan is presented,
        // rather than a surprise annual charge.
        if (info.billingMode === "simulated") {
          setEntitlement(await window.workcrew.api.simulateCheckout("ultra", "month"));
        } else if (entitlement.active) {
          // Already a paying subscriber: the upgrade opens a hosted Stripe payment
          // page. The backend grants Ultra only after that payment clears (via the
          // webhook), so this can never hand over the higher plan for free. The new
          // plan is picked up when the user returns to the window (focus refresh).
          const result = await window.workcrew.api.changePlan("ultra", "month");
          if (isEntitlement(result)) setEntitlement(result);
        } else {
          await window.workcrew.api.checkout("ultra", "month");
        }
      }}
      onAdjustPlan={async (plan, interval) => {
        // The account dialog only opens for an active subscriber. In test mode this
        // re-activates at the chosen plan. In live billing an upgrade opens a hosted
        // Stripe payment page (entitlement updates on return); a downgrade applies
        // immediately and returns the refreshed entitlement. It never cancels.
        if (info.billingMode === "simulated") {
          setEntitlement(await window.workcrew.api.simulateCheckout(plan, interval));
        } else {
          const result = await window.workcrew.api.changePlan(plan, interval);
          if (isEntitlement(result)) setEntitlement(result);
        }
      }}
    />
  );
}
