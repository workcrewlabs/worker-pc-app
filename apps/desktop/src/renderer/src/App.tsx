import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_CATALOG,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

function LogoMark() {
  return (
    <svg className="brand-glyph" viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="wc-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.55" stopColor="#8b5cf6" />
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      if (mode === "reset") {
        await window.workcrew.auth.reset(email);
        setNotice("A secure password reset link was sent.");
      } else if (mode === "signup") {
        const result = await window.workcrew.auth.signUp(email, password) as { needsVerification?: boolean };
        if (result.needsVerification) setNotice("Verify your email, then sign in.");
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
          {mode !== "reset" && <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={10} required /></label>}
          <button className="primary full" disabled={busy}>{busy ? "Please wait" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}</button>
        </form>
        {notice && <p className="notice">{notice}</p>}
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

function Workspace({ info, entitlement, onSignOut, onUpgrade }: { info: AppInfo; entitlement: SubscriptionState; onSignOut: () => Promise<void>; onUpgrade: () => Promise<void> }) {
  const [model, setModel] = useState<ModelTier>(DEFAULT_CHAT_MODEL);
  const [upgrading, setUpgrading] = useState(false);
  const isUltra = entitlement.plan === "ultra";
  const [view, setView] = useState<PanelView>("chat");
  const [accountOpen, setAccountOpen] = useState(false);
  const [permissions, setPermissions] = useState<PermissionState>(() => loadPermissions());
  const [routines, setRoutines] = useState<Routine[]>(() => loadRoutines());
  const [recents, setRecents] = useState<ConversationSummary[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);

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
    void chat.send({ text, model, attachments });
  }

  async function handleUpgrade() {
    if (upgrading) return;
    setUpgrading(true);
    try {
      await onUpgrade();
    } finally {
      setUpgrading(false);
    }
  }

  const planLabel = entitlement.plan ? PLAN_CATALOG[entitlement.plan].name : "No plan";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand compact />
        <button className="new-chat" onClick={startNewChat} aria-label="New chat">
          <span className="new-chat-spark"><LogoMark /></span> New chat
        </button>
        <nav aria-label="Workspace sections">
          <button
            className={view === "automation" ? "nav-active" : ""}
            aria-current={view === "automation" ? "page" : undefined}
            onClick={() => setView("automation")}
          >
            <span>A</span> Automation
          </button>
          <button
            className={view === "routines" ? "nav-active" : ""}
            aria-current={view === "routines" ? "page" : undefined}
            onClick={() => setView("routines")}
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
        <div className="sidebar-security"><span className="shield">S</span><div><strong>Protected locally</strong><small>Write actions ask first</small></div></div>
        <button className="account-button" onClick={() => setAccountOpen(true)} aria-label="Open account">
          <span className="avatar">A</span>
          <span><strong>Account</strong><small>{planLabel}</small></span>
          <span className="signout">View</span>
        </button>
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <Brand compact />
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
        <ChatView
          turns={chat.turns}
          streaming={chat.streaming}
          model={model}
          onModelChange={setModel}
          onSend={send}
          onStop={chat.stop}
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
      {view === "automation" && <AutomationPanel runner={runner} model={model} onClose={() => setView("chat")} />}
      {view === "routines" && (
        <RoutinesPanel runner={runner} model={model} routines={routines} onChange={setRoutines} onClose={() => setView("chat")} />
      )}
      {view === "settings" && <SettingsPanel info={info} onClose={() => setView("chat")} />}
      {runner.pending && <ApprovalModal action={runner.pending.action} label={runner.pending.label} onDecide={runner.decide} />}
      {accountOpen && (
        <AccountDialog
          entitlement={entitlement}
          usedMicrodollars={usage}
          onClose={() => setAccountOpen(false)}
          onSignOut={onSignOut}
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
        if (info.billingMode === "simulated") setEntitlement(await window.workcrew.api.simulateCheckout("ultra", "year"));
        else await window.workcrew.api.checkout("ultra", "year");
      }}
    />
  );
}
