import { useRef, useState } from "react";
import type { AutomationAction, ModelTier } from "@workcrew/contracts";
import { actionDetail, actionLabel } from "../lib/automation";
import { redactResult, requiresApproval } from "../security";
import { addHistory } from "../lib/storage";
import { track } from "../lib/analytics";
import { browserRefLabel, buildRecipe, getRecipe, isReplayEnabled, normalizeTaskKey, parseWindowsSnapshot, saveRecipe, type Recipe } from "../lib/recipes";

// The shared automation engine. It runs one plan-act loop at a time: create a
// run, then repeatedly ask the backend for the next action, execute it (asking
// approval for write actions), and feed the result back, until the run finishes
// or hits the safety ceiling. A single instance is shared by the Automation
// panel and the routine scheduler so only one task ever runs at once.

const MAX_STEPS = 24;

// Windows commands that do NOT move the mouse or type (read-only or app launch).
// The overlay is raised for every OTHER windows command, so a future command that
// drives input cannot silently bypass the "do not move the mouse" overlay.
const WINDOWS_NON_INPUT_COMMANDS = new Set([
  "launch", "list-windows", "connect", "inspect", "get-text", "screenshot", "record-start", "record-stop"
]);

export type StepStatus = "running" | "ok" | "error" | "declined";
export type RunStep = { id: string; label: string; detail?: string; status: StepStatus };
export type RunStatus = "idle" | "running" | "complete" | "failed" | "stopped";

function stepId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export type AutomationRunner = {
  steps: RunStep[];
  status: RunStatus;
  summary: string;
  error: string;
  running: boolean;
  label: string;
  pending: { action: AutomationAction; label: string } | null;
  run: (task: string, model: ModelTier, label?: string) => Promise<void>;
  decide: (approved: boolean) => void;
  stop: () => void;
  clear: () => void;
  setAutoApprove: (value: boolean) => void;
  setPermissions: (permissions: Record<string, boolean>) => void;
  // Live, synchronous "is a run in progress" check. Unlike `running` (derived
  // from React state, which lags a tick), this is set the instant a run starts,
  // so callers can avoid launching a second run in the same tick.
  isBusy: () => boolean;
};

export function useAutomationRunner(): AutomationRunner {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState<{ action: AutomationAction; label: string } | null>(null);

  const stoppedRef = useRef(false);
  // Set synchronously the instant a run begins and cleared on every exit path.
  // The React `status` state lags a tick, so two callers (a manual send and the
  // 30-second scheduler firing together) could both read status !== "running"
  // and start two runs that drive the mouse at once and double-bill. This ref is
  // the authoritative guard against that.
  const runningRef = useRef(false);
  const approvalResolve = useRef<((approved: boolean) => void) | null>(null);
  // When on, write actions run without prompting ("Always allow").
  const autoApproveRef = useRef(false);
  function setAutoApprove(value: boolean): void {
    autoApproveRef.current = value;
  }
  // The per-category Permissions toggles. A category left on can be covered by
  // "Always allow"; a category turned off keeps asking. Held in a ref so the
  // approval decision always sees the latest settings mid-run.
  const permissionsRef = useRef<Record<string, boolean>>({});
  function setPermissions(permissions: Record<string, boolean>): void {
    permissionsRef.current = permissions;
  }
  // Resolve a click's opaque target into the human label the model actually saw,
  // using the snapshot that was current when it chose the action. A windows click
  // carries a numeric control id; a browser click carries an aria ref like e12.
  // Without this the consequential-action gate would test a bare id/ref and never
  // match a real "Pay"/"Delete" label. Recipe replay passes no snapshot because
  // its controls are already stable names (and browser steps use CSS selectors).
  function resolveLabel(action: AutomationAction, snapshot: string | null): string | undefined {
    if (action.kind === "windows" && action.command === "click") {
      const control = action.control ?? "";
      if (/^\d+$/.test(control)) return parseWindowsSnapshot(snapshot).get(control) ?? control;
      return control;
    }
    if (action.kind === "browser" && (action.command === "click" || action.command === "click-selector")) {
      const target = action.target ?? "";
      if (/^e\d{1,6}$/.test(target)) return browserRefLabel(snapshot, target) ?? target;
      return target;
    }
    return undefined;
  }

  // Whether to show the in-app approval prompt for an action, given current
  // settings. Centralized so the model loop and recipe replay decide identically.
  // `snapshot` is the most recent inspect/snapshot output, used to resolve a
  // click target to its real label for the consequential-action gate.
  function shouldPrompt(action: AutomationAction, snapshot: string | null = null): boolean {
    return requiresApproval(action, {
      alwaysAllow: autoApproveRef.current,
      permissions: permissionsRef.current,
      label: resolveLabel(action, snapshot)
    });
  }

  // While a Windows automation physically uses the mouse/keyboard, show an
  // on-screen overlay telling the user not to move the mouse. Tracked in a ref so
  // it is raised once and reliably lowered when the run ends, on every exit path.
  const mouseActiveRef = useRef(false);
  function showOverlayFor(action: AutomationAction): void {
    if (action.kind === "windows" && !WINDOWS_NON_INPUT_COMMANDS.has(action.command)) {
      mouseActiveRef.current = true;
      void window.workcrew.automation.overlay(true);
    }
  }
  function hideOverlay(): void {
    if (mouseActiveRef.current) {
      mouseActiveRef.current = false;
      void window.workcrew.automation.overlay(false);
    }
  }

  function requestApproval(action: AutomationAction): Promise<boolean> {
    return new Promise((resolve) => {
      approvalResolve.current = resolve;
      setPending({ action, label: actionLabel(action) });
    });
  }

  function decide(approved: boolean): void {
    setPending(null);
    const resolve = approvalResolve.current;
    approvalResolve.current = null;
    resolve?.(approved);
  }

  // Reset the inline run activity (steps, status, summary) so it does not linger
  // into a new chat or the next message. A no-op while a run is in progress.
  function clear(): void {
    if (runningRef.current || status === "running") return;
    setSteps([]);
    setSummary("");
    setError("");
    setLabel("");
    setStatus("idle");
    setPending(null);
  }

  function stop(): void {
    stoppedRef.current = true;
    // Stop the mouse-driving helper first; the overlay is lowered by the run's
    // exit path (or the main-process safety timer) once the in-flight action has
    // actually settled, so it never disappears while the mouse is still moving.
    void window.workcrew.automation.stop();
    setStatus("stopped");
  }

  // Replay a saved recipe with no model call. Each step is shown in the activity
  // list, writes are still routed through the approval gate, and any failure to
  // execute a step (a missing control, a changed screen) returns "failed" so the
  // caller falls back to the model loop. Returns "stopped" if the user declines
  // a step or stops the run.
  async function replayRecipe(recipe: Recipe): Promise<"complete" | "failed" | "stopped"> {
    for (const step of recipe.steps) {
      if (stoppedRef.current) return "stopped";
      const action = step.action;
      const id = stepId();
      setSteps((current) => [...current, { id, label: actionLabel(action), detail: actionDetail(action), status: "running" }]);

      // Re-derive approval from the action itself rather than trusting the stored
      // flag (a tampered recipe could lie); shell is gated by the main process.
      if (shouldPrompt(action)) {
        const approved = await requestApproval(action);
        if (!approved) {
          setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "declined" } : item)));
          return "stopped";
        }
      }

      try {
        showOverlayFor(action);
        // type-text and press-key act on whatever is focused and do not wait on a
        // control like other commands, so on fast replay give the app a brief
        // moment to settle the focus the previous step set (e.g. a cell jump).
        if (action.kind === "windows" && (action.command === "type-text" || action.command === "press-key")) {
          await new Promise((settle) => setTimeout(settle, 150));
        }
        await window.workcrew.automation.execute(action);
        setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "ok" } : item)));
      } catch {
        setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
        return "failed";
      }
    }
    return "complete";
  }

  async function run(task: string, model: ModelTier, runLabel = ""): Promise<void> {
    const trimmed = task.trim();
    // Synchronous guard: if a run is already in flight, do nothing. This is set
    // before any await so a second caller in the same tick cannot slip past it.
    if (trimmed.length < 3 || runningRef.current) return;
    runningRef.current = true;
    // Event name only; never the task text or any on-screen content.
    track("automation_started");
    // Wrap the whole run in try/finally so the in-flight guard is cleared on
    // EVERY exit path, including an unexpected throw from the replay section
    // below (which runs before the main loop's own try). Missing this would
    // strand the runner with isBusy() stuck true until an app restart.
    try {
    stoppedRef.current = false;
    mouseActiveRef.current = false;
    setSteps([]);
    setSummary("");
    setError("");
    setLabel(runLabel);
    setStatus("running");

    // Replay path: if a saved recipe matches this exact task, replay it with no
    // model call at all. Money-affecting writes are still approved, and any
    // mismatch falls through to the model loop below, which re-saves a corrected
    // recipe on success.
    const recipe = isReplayEnabled() ? getRecipe(normalizeTaskKey(trimmed)) : null;
    if (recipe) {
      const outcome = await replayRecipe(recipe);
      hideOverlay();
      if (outcome === "complete") {
        setSummary(recipe.summary || "Task complete.");
        setStatus("complete");
        saveRecipe({ ...recipe, runCount: recipe.runCount + 1, updatedAtMs: Date.now() });
        addHistory({ task: trimmed, timestamp: Date.now(), outcome: "complete", activityCount: recipe.steps.length });
        track("automation_completed", { via: "replay" });
        return;
      }
      if (outcome === "stopped") {
        setStatus("stopped");
        addHistory({ task: trimmed, timestamp: Date.now(), outcome: "stopped", activityCount: 0 });
        return;
      }
      // outcome === "failed": clear the partial replay activity and let the model
      // drive the task from a clean slate.
      setSteps([]);
    }

    // Recording buffers. A clean completed model run is saved as a recipe so the
    // next identical task can skip the model entirely. snapshot is the inspect
    // output current when each action was chosen, used to turn a numeric control
    // reference into a stable name at record time.
    const recorded: { action: AutomationAction; snapshot: string | null; ok: boolean }[] = [];
    let lastSnapshot: string | null = null;
    let finishSummary = "Task complete.";

    try {
      const { runId } = await window.workcrew.api.createRun(trimmed, model);
      let result: { toolUseId: string; ok: boolean; output: string } | undefined;

      for (let step = 0; step < MAX_STEPS; step += 1) {
        if (stoppedRef.current) {
          setStatus("stopped");
          break;
        }
        const response = await window.workcrew.api.nextRun(runId, result);
        if (response.status === "complete") {
          finishSummary = response.message ?? "Task complete.";
          setSummary(finishSummary);
          setStatus("complete");
          break;
        }
        if (response.status === "failed") {
          setSummary(response.message ?? "This task stopped.");
          setStatus("failed");
          break;
        }
        if (!response.action || !response.toolUseId) break;

        const action = response.action;
        // Tracked per action so a failed or declined step is excluded from the
        // saved recipe (only the clean successful path is cached).
        const recordEntry = { action, snapshot: lastSnapshot, ok: true };
        recorded.push(recordEntry);
        const id = stepId();
        setSteps((current) => [...current, { id, label: actionLabel(action), detail: actionDetail(action), status: "running" }]);

        // Shell commands are approved by the main process itself (a native prompt
        // that cannot be bypassed), so they are not prompted again here. Other
        // writes use the in-app approval based on Always allow and the per-category
        // Permissions toggles.
        if (shouldPrompt(action, lastSnapshot)) {
          const approved = await requestApproval(action);
          if (!approved) {
            recordEntry.ok = false;
            setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "declined" } : item)));
            result = { toolUseId: response.toolUseId, ok: false, output: "You declined this action." };
            continue;
          }
        }

        try {
          showOverlayFor(action);
          const output = await window.workcrew.automation.execute(action);
          setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "ok" } : item)));
          result = { toolUseId: response.toolUseId, ok: true, output: redactResult(output) };
          // Remember the latest snapshot so a following click can be resolved to
          // a stable name (recipe recording) and to its real label (approval
          // gate). Windows inspect lists controls; every browser command returns
          // a fresh aria snapshot, so capture both. The raw output is kept (not
          // the redacted copy) so refs and names survive.
          if (action.kind === "windows" && action.command === "inspect") lastSnapshot = output;
          else if (action.kind === "browser") lastSnapshot = output;
        } catch (caught) {
          recordEntry.ok = false;
          setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
          const message = caught instanceof Error ? caught.message : "That step could not be completed.";
          result = { toolUseId: response.toolUseId, ok: false, output: redactResult(message) };
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The task could not be started.");
      setStatus("failed");
    } finally {
      hideOverlay();
      setStatus((current) => {
        addHistory({
          task: trimmed,
          timestamp: Date.now(),
          outcome: current === "complete" ? "complete" : current === "stopped" ? "stopped" : "failed",
          activityCount: 0
        });
        // Safe outcome only. A user-stopped run is neither completed nor failed.
        if (current === "complete") track("automation_completed", { via: "model" });
        else if (current === "failed") track("automation_failed", { category: "run_failed" });
        // Only a clean, fully-deterministic completed run becomes a recipe. A run
        // with any failed or declined step is never cached: dropping such a step
        // could replay a path that silently skips a write yet reports success.
        if (current === "complete" && !recorded.some((entry) => entry.ok === false)) {
          const recipe = buildRecipe(trimmed, recorded, finishSummary);
          if (recipe) saveRecipe(recipe);
        }
        return current;
      });
    }
    } finally {
      runningRef.current = false;
    }
  }

  return { steps, status, summary, error, label, pending, run, decide, stop, clear, setAutoApprove, setPermissions, isBusy: () => runningRef.current, running: status === "running" };
}
