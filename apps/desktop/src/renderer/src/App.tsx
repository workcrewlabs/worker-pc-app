import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLAN_CATALOG,
  type AutomationAction,
  type BillingInterval,
  type ModelTier,
  type PlanId,
  type SubscriptionState
} from "@workcrew/contracts";
import { actionNeedsApproval, redactResult } from "./security";
import {
  type HistoryEntry,
  type PermissionState,
  type RunOutcome,
  type Schedule,
  type Workflow,
  addHistory,
  clearHistory,
  loadHistory,
  loadPermissions,
  loadSchedules,
  loadWorkflows
} from "./lib/storage";
import { ApprovalModal } from "./components/ApprovalModal";
import { HistoryPanel } from "./components/HistoryPanel";
import { WorkflowsPanel } from "./components/WorkflowsPanel";
import { ScheduledPanel } from "./components/ScheduledPanel";
import { PermissionsPanel } from "./components/PermissionsPanel";
import { AccountDialog } from "./components/AccountDialog";

type AppInfo = { name: string; version: string; authMode: string; billingMode: string };
type Phase = "loading" | "auth" | "paywall" | "workspace";
type Activity = { id: number; title: string; detail?: string; tone?: "good" | "warn" | "bad" };
type PanelView = "new" | "workflows" | "scheduled" | "history" | "permissions";
type PendingApproval = {
  action: AutomationAction;
  label: string;
  resolve: (approved: boolean) => void;
};

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

function formatMoney(microdollars: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(microdollars / 1_000_000);
}

function actionLabel(action: AutomationAction): string {
  if (action.kind === "finish") return "Finished";
  if (action.kind === "browser") return `Browser: ${action.command}`;
  return `Windows: ${action.command}`;
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
                <li>{formatMoney(item.monthlyApiBudgetMicrodollars)} monthly Claude allowance</li>
                <li>{item.devices} Windows {item.devices === 1 ? "device" : "devices"}</li>
                <li>Playwright CLI browser automation</li>
                <li>Secure pywinauto desktop actions</li>
                <li>Saved and scheduled workflows</li>
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

function Workspace({ entitlement, onSignOut }: { entitlement: SubscriptionState; onSignOut: () => Promise<void> }) {
  const [task, setTask] = useState("");
  const [model, setModel] = useState<ModelTier>("auto");
  const [running, setRunning] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [usage, setUsage] = useState(entitlement.usedMicrodollars);
  const [view, setView] = useState<PanelView>("new");
  const [accountOpen, setAccountOpen] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [workflows, setWorkflows] = useState<Workflow[]>(() => loadWorkflows());
  const [schedules, setSchedules] = useState<Schedule[]>(() => loadSchedules());
  const [permissions, setPermissions] = useState<PermissionState>(() => loadPermissions());
  const stopRef = useRef(false);
  const activityId = useRef(0);
  const activityCount = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const percent = Math.min(100, ((usage + entitlement.reservedMicrodollars) / entitlement.budgetMicrodollars) * 100 || 0);

  function addActivity(title: string, detail?: string, tone?: Activity["tone"]) {
    activityId.current += 1;
    activityCount.current += 1;
    setActivities((current) => [...current, { id: activityId.current, title, detail, tone }]);
  }

  // Open the approval modal and wait for the user to allow or decline.
  function requestApproval(action: AutomationAction): Promise<boolean> {
    return new Promise((resolve) => {
      setPending({
        action,
        label: actionLabel(action),
        resolve: (approved) => {
          setPending(null);
          resolve(approved);
        }
      });
    });
  }

  function loadIntoComposer(nextTask: string) {
    setTask(nextTask);
    setView("new");
    setAccountOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function runTask(taskText: string = task) {
    const trimmed = taskText.trim();
    if (trimmed.length < 3 || running) return;
    setView("new");
    setRunning(true);
    stopRef.current = false;
    setActivities([]);
    activityCount.current = 0;
    addActivity("Task received", trimmed);
    let outcome: RunOutcome = "failed";
    try {
      const created = await window.workcrew.api.createRun(trimmed, model);
      let result: { toolUseId: string; ok: boolean; output: string } | undefined;
      for (let count = 0; count < 24 && !stopRef.current; count += 1) {
        addActivity("Planning next step");
        const step = await window.workcrew.api.nextRun(created.runId, result);
        if (step.usage) setUsage(step.usage.usedMicrodollars);
        if (step.status === "complete" || step.action?.kind === "finish") {
          addActivity("Task complete", step.message ?? (step.action?.kind === "finish" ? step.action.summary : undefined), "good");
          outcome = "complete";
          return;
        }
        if (!step.action || !step.toolUseId) throw new Error("The task service returned an incomplete step");
        addActivity(actionLabel(step.action));
        let approved = true;
        if (actionNeedsApproval(step.action)) {
          approved = await requestApproval(step.action);
        }
        if (!approved) {
          addActivity("Action declined", actionLabel(step.action), "warn");
          result = { toolUseId: step.toolUseId, ok: false, output: "The user declined this action." };
          continue;
        }
        try {
          const output = redactResult(await window.workcrew.automation.execute(step.action));
          addActivity("Action completed", output.slice(0, 500), "good");
          result = { toolUseId: step.toolUseId, ok: true, output };
        } catch (error) {
          const message = errorMessage(error);
          addActivity("Action could not complete", message, "bad");
          result = { toolUseId: step.toolUseId, ok: false, output: message };
        }
      }
      if (stopRef.current) {
        addActivity("Task stopped", "No further actions will run.", "warn");
        outcome = "stopped";
      } else {
        throw new Error("WorkCrew stopped the run after reaching the safety step limit");
      }
    } catch (error) {
      addActivity("Run stopped", errorMessage(error), "bad");
      outcome = stopRef.current ? "stopped" : "failed";
    } finally {
      setRunning(false);
      // Persist the run to local history. The activity count is tracked in a
      // ref so the recorded number matches what the user saw in the timeline.
      setHistory(addHistory({ task: trimmed, timestamp: Date.now(), outcome, activityCount: activityCount.current }));
    }
  }

  async function stop() {
    stopRef.current = true;
    await window.workcrew.automation.stop();
    setRunning(false);
  }

  const suggestions = [
    "Organize the files in my Downloads folder",
    "Open a website and collect the key details",
    "Prepare a report from a downloaded file"
  ];

  const navItems: { id: PanelView; glyph: string; label: string }[] = [
    { id: "new", glyph: "+", label: "New task" },
    { id: "workflows", glyph: "W", label: "Workflows" },
    { id: "scheduled", glyph: "S", label: "Scheduled" },
    { id: "history", glyph: "H", label: "History" },
    { id: "permissions", glyph: "P", label: "Permissions" }
  ];

  const planLabel = entitlement.plan ? PLAN_CATALOG[entitlement.plan].name : "No plan";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand compact />
        <nav aria-label="Workspace sections">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <span>{item.glyph}</span> {item.label}
            </button>
          ))}
        </nav>
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
          <div className="usage-box">
            <div><span>AI allowance</span><strong>{formatMoney(Math.max(0, entitlement.budgetMicrodollars - usage))} left</strong></div>
            <div className="usage-track"><span style={{ width: `${percent}%` }} /></div>
          </div>
        </header>
        <div className="workspace-content">
          <p className="eyebrow">YOUR WINDOWS WORK CREW</p>
          <h1>{running ? "WorkCrew is on it" : "What should WorkCrew handle?"}</h1>
          <p className="workspace-subtitle">Describe an outcome. WorkCrew will plan the steps and ask before making changes.</p>
          <div className={`composer ${running ? "composer-running" : ""}`}>
            <textarea ref={composerRef} value={task} onChange={(event) => setTask(event.target.value)} placeholder="Ask WorkCrew to complete a task on your PC..." disabled={running} />
            <div className="composer-tools">
              <button className="tool-button" title="Attachments are added in the next release" aria-label="Add attachment">+</button>
              <select value={model} onChange={(event) => setModel(event.target.value as ModelTier)} disabled={running} aria-label="Model preference">
                <option value="auto">Auto model</option>
                <option value="haiku">Haiku</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
              </select>
              {running ? <button className="stop-button" onClick={stop}>Stop</button> : <button className="run-button" onClick={() => runTask()} disabled={task.trim().length < 3}>Run task</button>}
            </div>
          </div>
          {activities.length > 0 ? (
            <section className="activity-panel" aria-live="polite">
              <div className="activity-title"><h2>Live run</h2><span>{running ? "Running" : "Ended"}</span></div>
              {activities.map((item) => <div className={`activity-row ${item.tone ?? ""}`} key={item.id}><span className="activity-dot" /><div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}
            </section>
          ) : (
            <section className="suggestions">
              <span>Start with a task</span>
              {suggestions.map((suggestion) => <button key={suggestion} onClick={() => setTask(suggestion)}><span className="suggestion-icon">A</span>{suggestion}<span className="arrow">&gt;</span></button>)}
            </section>
          )}
        </div>
        <footer>WorkCrew can make mistakes. Review important actions before approving them.</footer>
      </section>

      {view === "workflows" && (
        <WorkflowsPanel
          workflows={workflows}
          currentTask={task}
          onClose={() => setView("new")}
          onChange={setWorkflows}
          onRun={(workflowTask) => loadIntoComposer(workflowTask)}
        />
      )}
      {view === "scheduled" && (
        <ScheduledPanel
          schedules={schedules}
          currentTask={task}
          onClose={() => setView("new")}
          onChange={setSchedules}
        />
      )}
      {view === "history" && (
        <HistoryPanel
          entries={history}
          onClose={() => setView("new")}
          onReuse={(historyTask) => loadIntoComposer(historyTask)}
          onCleared={() => setHistory(clearHistory())}
        />
      )}
      {view === "permissions" && (
        <PermissionsPanel
          permissions={permissions}
          onClose={() => setView("new")}
          onChange={setPermissions}
        />
      )}
      {accountOpen && (
        <AccountDialog
          entitlement={entitlement}
          usedMicrodollars={usage}
          onClose={() => setAccountOpen(false)}
          onSignOut={onSignOut}
        />
      )}
      {pending && (
        <ApprovalModal action={pending.action} label={pending.label} onDecide={pending.resolve} />
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
      const state = await window.workcrew.api.entitlement();
      setEntitlement(state);
      setPhase(state.active ? "workspace" : "paywall");
    } catch (error) {
      setFatal(errorMessage(error));
      setPhase("loading");
    }
  }

  useEffect(() => { void refresh(); }, []);

  const loadingMessage = useMemo(() => fatal || "Starting WorkCrew securely...", [fatal]);
  if (phase === "loading" || !info) return <main className="loading-shell"><Brand /><div className="loading-line" /><p>{loadingMessage}</p>{fatal && <button className="secondary" onClick={() => { setFatal(""); void refresh(); }}>Try again</button>}</main>;
  if (phase === "auth") return <AuthScreen onReady={refresh} />;
  if (phase === "paywall") return <Paywall info={info} onActivated={(state) => { setEntitlement(state); setPhase("workspace"); }} />;
  return <Workspace entitlement={entitlement} onSignOut={async () => { await window.workcrew.auth.signOut(); setPhase("auth"); }} />;
}
