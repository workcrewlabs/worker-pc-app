import { useRef, useState } from "react";
import type { AutomationAction, ModelTier } from "@workcrew/contracts";
import { actionDetail, actionLabel } from "../lib/automation";
import { actionNeedsApproval, redactResult } from "../security";
import { addHistory } from "../lib/storage";
import { buildRecipe, getRecipe, isReplayEnabled, normalizeTaskKey, saveRecipe, type Recipe } from "../lib/recipes";

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
  setAutoApprove: (value: boolean) => void;
};

export function useAutomationRunner(): AutomationRunner {
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState<{ action: AutomationAction; label: string } | null>(null);

  const stoppedRef = useRef(false);
  const approvalResolve = useRef<((approved: boolean) => void) | null>(null);
  // When on, write actions run without prompting ("Always allow").
  const autoApproveRef = useRef(false);
  function setAutoApprove(value: boolean): void {
    autoApproveRef.current = value;
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

      if (step.needsApproval && !autoApproveRef.current) {
        const approved = await requestApproval(action);
        if (!approved) {
          setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "declined" } : item)));
          return "stopped";
        }
      }

      try {
        showOverlayFor(action);
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
    if (trimmed.length < 3 || status === "running") return;
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
    const recorded: { action: AutomationAction; snapshot: string | null }[] = [];
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
        recorded.push({ action, snapshot: lastSnapshot });
        const id = stepId();
        setSteps((current) => [...current, { id, label: actionLabel(action), detail: actionDetail(action), status: "running" }]);

        if (actionNeedsApproval(action) && !autoApproveRef.current) {
          const approved = await requestApproval(action);
          if (!approved) {
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
          // Remember the latest desktop snapshot so a later numeric control
          // reference can be recorded as the stable control name.
          if (action.kind === "windows" && action.command === "inspect") lastSnapshot = output;
        } catch (caught) {
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
        // Only a clean, fully-deterministic completed run becomes a recipe;
        // buildRecipe returns null for anything that cannot be replayed safely.
        if (current === "complete") {
          const recipe = buildRecipe(trimmed, recorded, finishSummary);
          if (recipe) saveRecipe(recipe);
        }
        return current;
      });
    }
  }

  return { steps, status, summary, error, label, pending, run, decide, stop, setAutoApprove, running: status === "running" };
}
