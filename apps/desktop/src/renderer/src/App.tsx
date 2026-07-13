import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_CATALOG,
  REFERRAL_BONUS_MICRODOLLARS,
  type BillingInterval,
  type ConversationSummary,
  type ModelTier,
  type PlanId,
  type SubscriptionState
} from "@workcrew/contracts";
import { formatTokens } from "./lib/storage";
import { identifyUser, track } from "./lib/analytics";
import { DEFAULT_CHAT_MODEL, localId, turnsFromMessages, type ChatTurn } from "./lib/chat";
import { ConversationPane, type PaneStatus } from "./components/ConversationPane";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { AccountDialog } from "./components/AccountDialog";
import { InviteDialog } from "./components/InviteDialog";
import { RecorderDialog } from "./components/RecorderDialog";
import { UsageBanner } from "./components/UsageBanner";
import { UsageBoostBanner } from "./components/UsageBoostBanner";
import { usageStatus } from "./lib/usage";
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
  dailyLimitMicrodollars: 0,
  dailyUsedMicrodollars: 0,
  pendingPlan: null,
  pendingInterval: null,
  pendingEffective: null,
  modelMode: "economy"
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

  // Re-send the verification email when the first link expired. Reuses the
  // "Check your inbox" confirmation screen on success, with the email already in
  // state from the sign-in attempt.
  async function resendVerification() {
    if (!email) return;
    setBusy(true);
    setNotice("");
    try {
      await window.workcrew.auth.resendVerification(email);
      setSent("verify");
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
        {mode === "signin" && /verify your email/i.test(notice) && (
          <button type="button" className="auth-resend" onClick={resendVerification} disabled={busy || !email}>
            {busy ? "Sending new link" : "Send a new verification link"}
          </button>
        )}
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

// A small circular gauge of the rolling daily (24-hour) usage window. It shows
// how much of today's budget is used and frees up as the 24-hour window rolls
// forward.
// A full-screen, non-dismissable gate shown once an update has been out past its
// mandatory deadline. The user cannot return to the app without installing it;
// the only other option is to close the app (which installs the update on quit).
function UpdateGate({ update, appName }: { update: { version?: string; percent?: number; downloaded?: boolean }; appName: string }) {
  const ready = update.downloaded === true;
  const percent = Math.max(0, Math.min(100, Math.round(update.percent ?? 0)));
  return (
    <div className="update-gate" role="alertdialog" aria-modal="true" aria-labelledby="update-gate-title" aria-describedby="update-gate-body">
      <div className="update-gate-card">
        <span className="update-gate-glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 4 21 9.5 15.5 9.5" />
          </svg>
        </span>
        <h1 id="update-gate-title">Update required</h1>
        <p id="update-gate-body">
          A newer version of {appName}{update.version ? ` (${update.version})` : ""} is ready. To keep {appName} secure
          and running smoothly, please install this update to continue.
        </p>
        {ready ? (
          <button className="update-gate-primary" onClick={() => void window.workcrew.updates.install()} autoFocus>
            Update now
          </button>
        ) : (
          <div className="update-gate-progress" aria-live="polite">
            <div className="update-gate-track"><div className="update-gate-fill" style={{ width: `${percent}%` }} /></div>
            <span className="update-gate-progress-label">Preparing update… {percent}%</span>
          </div>
        )}
        <button className="update-gate-secondary" onClick={() => window.close()}>
          Close {appName}
        </button>
        <p className="update-gate-foot">It installs in a few seconds and reopens {appName} automatically.</p>
      </div>
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
  // Recents row menu (three dots) and inline rename state, keyed by conversation id.
  const [recentMenuId, setRecentMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Open conversation panes. Each stays mounted so its chat keeps streaming in the
  // background; only the active pane is on screen. A brand-new chat starts as one
  // blank pane.
  const firstKey = useRef(localId());
  const [panes, setPanes] = useState<{ key: string; conversationId?: string; initialTurns?: ChatTurn[]; initialAutomation?: { task: string; label: string } }[]>(
    () => [{ key: firstKey.current }]
  );
  const [activeKey, setActiveKey] = useState<string>(firstKey.current);
  // The status each pane reports up (streaming, computer-task phase, unread), used
  // for the sidebar indicators and to tell when the machine is busy. Mirrored into
  // a ref so the pruning and scheduler logic can read the latest without re-binding.
  const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({});
  const statusesRef = useRef(paneStatuses);
  statusesRef.current = paneStatuses;
  // Conversation ids already folded into the recents list, so a pane earning its id
  // refreshes recents exactly once.
  const knownConvIds = useRef<Set<string>>(new Set());
  // Text to drop into the chat composer (for example a just-recorded task), with a
  // nonce so the same text can be sent into the composer more than once.
  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number }>({ text: "", nonce: 0 });
  function seedComposer(text: string) {
    setComposerSeed((current) => ({ text, nonce: current.nonce + 1 }));
  }
  // A task being turned into a routine via "Save as a routine", carried into the
  // Routines form.
  const [routineSeed, setRoutineSeed] = useState("");
  // Auto-update status, surfaced as a sidebar button when an update is ready, or
  // as a full-screen blocking gate once a release is past its mandatory deadline.
  const [update, setUpdate] = useState<{ state: string; version?: string; percent?: number; deadline?: string; downloaded?: boolean } | null>(null);
  // "Always allow": when on, automations run without asking for each write action.
  const [alwaysAllow, setAlwaysAllowState] = useState<boolean>(() => {
    try { return localStorage.getItem("workcrew.alwaysAllow") === "1"; } catch { return false; }
  });
  function setAlwaysAllow(value: boolean) {
    setAlwaysAllowState(value);
    try { localStorage.setItem("workcrew.alwaysAllow", value ? "1" : "0"); } catch { /* storage unavailable */ }
  }

  // Fold a pane's reported status into the map, and refresh recents the first time
  // a pane earns a conversation id, so a brand-new chat appears in the sidebar.
  function handlePaneStatus(key: string, status: PaneStatus): void {
    setPaneStatuses((prev) => ({ ...prev, [key]: status }));
    if (status.conversationId && !knownConvIds.current.has(status.conversationId)) {
      knownConvIds.current.add(status.conversationId);
      setPanes((list) => list.map((pane) => (pane.key === key ? { ...pane, conversationId: status.conversationId } : pane)));
      void refreshRecents();
    }
  }

  // Whether any pane has a computer task running or paused (the machine is in use),
  // which blocks starting another one.
  const machineBusy = Object.values(paneStatuses).some((s) => s.automation === "running" || s.automation === "paused");

  // Drop empty, idle, background panes so opening new chats does not pile them up.
  // Only ever called alongside setting a new active pane.
  function prunePanes(list: typeof panes): typeof panes {
    return list.filter((pane) => {
      const st = statusesRef.current[pane.key];
      return Boolean(pane.conversationId) || Boolean(st?.hasConversation) || Boolean(st?.busy);
    });
  }

  // Open a fresh pane that runs a task immediately (a routine, run now or on a
  // schedule), and focus it since a computer task needs the mouse and screen.
  function runTaskInNewPane(task: string, label: string): void {
    if (task.trim().length < 3) return;
    const key = localId();
    setPanes((list) => [{ key, initialAutomation: { task, label } }, ...prunePanes(list)]);
    setActiveKey(key);
    setView("chat");
    setAccountOpen(false);
  }

  // Scheduler: while the app is open, check every 30 seconds for a due routine and,
  // when no computer task is already using the machine, run it in its own pane.
  // Held in a ref so the interval always sees the latest routines and pane statuses.
  const schedulerState = useRef({ routines, statuses: paneStatuses });
  schedulerState.current = { routines, statuses: paneStatuses };
  useEffect(() => {
    const timer = setInterval(() => {
      const { routines: current, statuses } = schedulerState.current;
      const busy = Object.values(statuses).some((s) => s.automation === "running" || s.automation === "paused");
      if (busy) return;
      const due = nextDueRoutine(current, Date.now());
      if (!due) return;
      setRoutines(markRoutineRan(due.id, Date.now()));
      runTaskInNewPane(due.task, due.name);
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Usage shown in the header, from the entitlement (refreshed each time a pane's
  // run finishes).
  const usage = entitlement.usedMicrodollars;
  const percent = Math.min(100, ((usage + entitlement.reservedMicrodollars) / entitlement.budgetMicrodollars) * 100 || 0);
  // The daily rolling-window meter, shown as its own bar next to the monthly one so
  // the two are never confused. Percent of the daily cap used in the last 24 hours.
  const dailyLimit = entitlement.dailyLimitMicrodollars;
  const dailyLeft = Math.max(0, dailyLimit - entitlement.dailyUsedMicrodollars);
  const dailyPercent = dailyLimit > 0 ? Math.min(100, (entitlement.dailyUsedMicrodollars / dailyLimit) * 100) : 0;
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

  // Close the open Recents menu on any outside click or Escape.
  useEffect(() => {
    if (!recentMenuId) return;
    const close = (): void => setRecentMenuId(null);
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setRecentMenuId(null); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [recentMenuId]);

  // Pin or unpin a conversation, then refresh so it jumps into or out of the
  // Pinned section. Optimistic-free: a failure just leaves the list as it was.
  async function togglePinRecent(item: ConversationSummary): Promise<void> {
    setRecentMenuId(null);
    try {
      await window.workcrew.conversations.setPinned(item.id, item.pinnedAtMs == null);
      await refreshRecents();
    } catch {
      // Non-fatal: the chat still works even if the pin did not persist.
    }
  }

  // Enter inline-rename mode for a conversation, seeding the editor with its title.
  function startRenameRecent(item: ConversationSummary): void {
    setRecentMenuId(null);
    setRenameDraft(item.title || "");
    setRenamingId(item.id);
  }

  // Save the edited title (unless empty or unchanged), then leave rename mode.
  async function commitRenameRecent(id: string): Promise<void> {
    const title = renameDraft.trim();
    const item = recents.find((entry) => entry.id === id);
    setRenamingId(null);
    if (!title || (item && title === item.title)) return;
    try {
      await window.workcrew.conversations.rename(id, title);
      await refreshRecents();
    } catch {
      // Non-fatal.
    }
  }

  // The conversation on screen (the active pane), for the header title and the
  // active row highlight.
  const activePane = panes.find((pane) => pane.key === activeKey);
  const activeConversationId = paneStatuses[activeKey]?.conversationId ?? activePane?.conversationId;
  // The live status of a saved conversation (matched by id), so its sidebar row can
  // show a running bar, a pause glyph (a backgrounded computer task), or a purple
  // dot (finished while you were elsewhere).
  function statusForConversation(id: string): PaneStatus | undefined {
    const pane = panes.find((entry) => entry.conversationId === id);
    return pane ? paneStatuses[pane.key] : undefined;
  }

  // One Recents row: opens on click, shows a three-dots menu (Rename, Pin/Unpin)
  // like Claude Code, and swaps to an inline text field while renaming.
  function renderRecent(item: ConversationSummary) {
    if (renamingId === item.id) {
      return (
        <div key={item.id} className="recent-item recent-renaming">
          <input
            className="recent-rename"
            value={renameDraft}
            autoFocus
            aria-label="Rename conversation"
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void commitRenameRecent(item.id); }
              else if (event.key === "Escape") setRenamingId(null);
            }}
            onBlur={() => void commitRenameRecent(item.id)}
          />
        </div>
      );
    }
    const st = statusForConversation(item.id);
    const running = Boolean(st?.streaming) || st?.automation === "running";
    const paused = st?.automation === "paused";
    const unread = Boolean(st?.unread) && item.id !== activeConversationId;
    return (
      <div
        key={item.id}
        className={`recent-item${item.id === activeConversationId ? " recent-active" : ""}${running ? " is-running" : ""}${paused ? " is-paused" : ""}${unread ? " is-unread" : ""}${recentMenuId === item.id ? " recent-menu-open" : ""}`}
      >
        <button className="recent-open" onClick={() => void openConversation(item.id)} title={item.title}>
          {item.pinnedAtMs != null && (
            <svg className="recent-pin" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path fill="currentColor" d="M9 4V2h6v2h-1v6l2 2v2h-4v6l-1 1-1-1v-6H6v-2l2-2V4z" />
            </svg>
          )}
          <span className="recent-title">{item.title || "New conversation"}</span>
          {paused ? (
            <span className="recent-status recent-pause" aria-label="Paused, open to resume" title="Paused, open to resume">
              <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            </span>
          ) : unread ? (
            <span className="recent-status recent-dot" aria-label="Finished" title="Finished" />
          ) : null}
        </button>
        <button
          className="recent-menu-trigger"
          aria-label="Chat options"
          aria-haspopup="menu"
          onClick={(event) => { event.stopPropagation(); setRecentMenuId(recentMenuId === item.id ? null : item.id); }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
          </svg>
        </button>
        {recentMenuId === item.id && (
          <div className="recent-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => startRenameRecent(item)}>Rename</button>
            <button type="button" role="menuitem" onClick={() => void togglePinRecent(item)}>
              {item.pinnedAtMs != null ? "Unpin" : "Pin"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Subscribe to auto-update status and check once on launch. In a packaged
  // build this downloads a newer version in the background and reports "ready";
  // in development it reports "unsupported" and the button never shows.
  useEffect(() => {
    const off = window.workcrew.updates.onStatus((status) => setUpdate(status));
    void window.workcrew.updates.check();
    return off;
  }, []);

  function startNewChat() {
    // Reuse an open blank pane if one exists; otherwise add a fresh pane and prune
    // any abandoned empty ones. Existing panes keep running in the background.
    const blank = panes.find((pane) => {
      const st = paneStatuses[pane.key];
      return !pane.conversationId && !st?.hasConversation && !st?.busy;
    });
    if (blank) {
      setActiveKey(blank.key);
    } else {
      const key = localId();
      setPanes((list) => [{ key }, ...prunePanes(list)]);
      setActiveKey(key);
    }
    setView("chat");
    setAccountOpen(false);
  }

  // Carry a task into the Routines form so it can be named and scheduled.
  function saveAsRoutine(task: string) {
    setRoutineSeed(task);
    setView("routines");
    setAccountOpen(false);
  }

  // Open a saved conversation. If it is already open in a pane, focus it (its
  // background run, if any, resumes); otherwise load its transcript into a new pane.
  async function openConversation(id: string) {
    const open = panes.find((pane) => pane.conversationId === id);
    if (open) {
      setActiveKey(open.key);
      setView("chat");
      setAccountOpen(false);
      return;
    }
    if (loadingId) return;
    setLoadingId(id);
    setView("chat");
    setAccountOpen(false);
    try {
      const detail = await window.workcrew.conversations.get(id);
      const key = `conv:${id}`;
      knownConvIds.current.add(id);
      setPanes((list) => [{ key, conversationId: id, initialTurns: turnsFromMessages(detail.messages) }, ...prunePanes(list)]);
      setActiveKey(key);
    } catch {
      // Leave the current panes in place if the load fails.
    } finally {
      setLoadingId(null);
    }
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
  const chatTitle = activeConversationId ? (recents.find((item) => item.id === activeConversationId)?.title ?? "") : "";

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
          <span className="version-stack">
            <span className="app-version" title="App version">v{info.version}</span>
            <span className="early-access-pill" title="Early access build">Early access</span>
          </span>
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
          {(() => {
            const pinned = recents.filter((item) => item.pinnedAtMs != null);
            const unpinned = recents.filter((item) => item.pinnedAtMs == null);
            if (recents.length === 0) {
              return <p className="recents-empty">Your conversations appear here.</p>;
            }
            return (
              <>
                {pinned.length > 0 && (
                  <>
                    <span className="recents-title">Pinned</span>
                    <div className="recents-list">{pinned.map(renderRecent)}</div>
                  </>
                )}
                {unpinned.length > 0 && (
                  <>
                    <span className="recents-title">Recents</span>
                    <div className="recents-list">{unpinned.map(renderRecent)}</div>
                  </>
                )}
              </>
            );
          })()}
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
            {dailyLimit > 0 && (
              <div className={`usage-box ${dailyPercent >= 80 ? "usage-box-high" : ""}`} title="Your daily limit. It frees up as the 24-hour window rolls forward.">
                <div><span>Today</span><strong>{formatTokens(dailyLeft)} left</strong></div>
                <div className="usage-track"><span style={{ width: `${dailyPercent}%` }} /></div>
              </div>
            )}
            <div className={`usage-box ${percent >= 80 ? "usage-box-high" : ""}`} title="Your monthly limit. It resets at the start of your billing period.">
              <div><span>This month</span><strong>{formatTokens(Math.max(0, entitlement.budgetMicrodollars - usage))} left</strong></div>
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
            canUpgrade={!isUltra}
          />
        )}
        <div className="panes">
          {panes.map((pane) => (
            <div key={pane.key} className={`pane${pane.key === activeKey ? " pane-active" : ""}`}>
              <ConversationPane
                paneKey={pane.key}
                active={pane.key === activeKey}
                model={model}
                onModelChange={setModel}
                alwaysAllow={alwaysAllow}
                onAlwaysAllowChange={setAlwaysAllow}
                permissions={permissions}
                initialTurns={pane.initialTurns}
                initialConversationId={pane.conversationId}
                initialAutomation={pane.initialAutomation}
                composerSeed={pane.key === activeKey ? composerSeed : undefined}
                onStatus={handlePaneStatus}
                onRefreshEntitlement={onRefreshEntitlement}
                onSaveRoutine={saveAsRoutine}
                onRecord={() => setRecorderOpen(true)}
              />
            </div>
          ))}
        </div>
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
        <RoutinesPanel onRun={(task, label) => runTaskInNewPane(task, label)} busy={machineBusy} routines={routines} initialTask={routineSeed} onChange={setRoutines} onClose={() => setView("chat")} />
      )}
      {view === "settings" && <SettingsPanel info={info} onClose={() => setView("chat")} />}
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
  // Mandatory-update status watched at the root so the blocking gate can sit above
  // every screen (loading, sign-in, paywall, and the app). The Workspace keeps its
  // own copy of this feed for the quiet "Restart to update" sidebar pill; here we
  // only act on the "required" state, which a release reaches past its deadline.
  const [update, setUpdate] = useState<{ state: string; version?: string; percent?: number; downloaded?: boolean } | null>(null);
  useEffect(() => {
    const off = window.workcrew.updates.onStatus((status) => {
      setUpdate((prev) => {
        // A mandatory update latches: once the gate is up, a later non-required
        // status (a routine "checking"/"none"/"unsupported") must never dismiss
        // it. Only a newer "required" update (download progress, downloaded)
        // replaces it.
        if (prev?.state === "required" && status.state !== "required") return prev;
        return status;
      });
    });
    void window.workcrew.updates.check();
    return off;
  }, []);

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
  // rolling daily figure (and the daily ring) reflects the latest usage rather
  // than the value from the last full load.
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
  // The mandatory-update gate is rendered above whichever screen is active, so a
  // required update blocks the loading, sign-in, and paywall screens too, not just
  // the signed-in app.
  const gate = update?.state === "required" ? <UpdateGate update={update} appName={info?.name ?? "WorkCrew"} /> : null;
  const screen =
    phase === "loading" || !info
      ? <main className="loading-shell"><Brand /><div className="loading-line" /><p>{loadingMessage}</p>{fatal && <button className="secondary" onClick={() => { setFatal(""); void refresh(); }}>Try again</button>}</main>
      : phase === "auth"
      ? <AuthScreen onReady={refresh} />
      : phase === "paywall"
      ? <Paywall info={info} onActivated={(state) => { setEntitlement(state); setPhase("workspace"); }} />
      : (
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
  // The one-time usage-upgrade announcement, shown only inside the signed-in app
  // and never while a required-update gate is covering the screen.
  const announce = phase === "workspace" && update?.state !== "required" ? <UsageBoostBanner /> : null;
  return <>{gate}{screen}{announce}</>;
}
