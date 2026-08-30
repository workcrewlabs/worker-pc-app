import { useRef, useState } from "react";
import type { AutomationAction, ModelTier, RunKind } from "@workcrew/contracts";
import { actionDetail, actionLabel, activityLine } from "../lib/automation";
import { redactResult, requiresApproval } from "../security";
import { addHistory } from "../lib/storage";
import { track } from "../lib/analytics";
import { browserRefLabel, buildRecipe, getRecipe, isReplayEnabled, normalizeTaskKey, parseWindowsSnapshot, saveRecipe, type Recipe } from "../lib/recipes";

// The shared automation engine. It runs one plan-act loop at a time: create a
// run, then repeatedly ask the backend for the next action, execute it (asking
// approval for write actions), and feed the result back, until the run finishes
// or hits the safety ceiling. A single instance is shared by the Automation
// panel and the routine scheduler so only one task ever runs at once.

// How many planning steps a run may take, by what it is doing. Driving the
// screen keeps the short ceiling: a loop that will not stop is clicking on the
// user's own desktop. Work inside a folder they attached is ordinary engineering
// (read a dozen files, write several, run the tests, fix what failed) which
// genuinely takes that many small steps, and stopping partway leaves a
// half-finished edit. The backend enforces the same two numbers.
const MAX_STEPS: Record<RunKind, number> = { screen: 24, folder: 120 };

// Whether an action drives the user's real mouse, keyboard or screen, and so
// cannot happen while its conversation is off screen. Running a command,
// writing a file and finishing touch none of those: they are ordinary work in a
// folder the user attached, and stopping them the moment somebody opens another
// chat is what froze a spreadsheet halfway through being built.
export function needsTheMachine(action: AutomationAction): boolean {
  return action.kind === "windows" || action.kind === "browser";
}

// Windows commands that do NOT move the mouse or type (read-only or app launch).
// The overlay is raised for every OTHER windows command, so a future command that
// drives input cannot silently bypass the "do not move the mouse" overlay.
const WINDOWS_NON_INPUT_COMMANDS = new Set([
  "launch", "list-windows", "connect", "inspect", "get-text", "screenshot", "record-start", "record-stop"
]);

export type StepStatus = "running" | "ok" | "error" | "declined";
export type RunStep = {
  id: string;
  /** What this step did, past tense, shown once it has finished. */
  label: string;
  /** The same thing in progress, shown while it is the step in flight. */
  doing?: string;
  detail?: string;
  status: StepStatus;
};
export type RunStatus = "idle" | "running" | "complete" | "failed" | "stopped";

/**
 * How a run ended, returned by run() itself.
 *
 * The caller moves a finished run into the transcript the instant run()
 * resolves, which is before React has re-rendered with the final summary. Read
 * from state at that moment it was still the PREVIOUS value (usually empty), so
 * a completed run could be filed away with no words at all. Reporting the
 * outcome directly removes the race rather than hoping to win it.
 */
export type RunOutcome = {
  status: RunStatus;
  summary: string;
  error: string;
  steps: RunStep[];
  /** The conversation the backend recorded this run in. The transcript is filed
   *  under it, so reopening from Recents finds the run card rather than a bare
   *  line of text. Absent on an older backend. */
  conversationId?: string;
};

function stepId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// A capture of the screen plus the size of the PICTURE itself. The planner gives
// coordinates in that picture's pixels, so the approval marker can be placed
// directly against it with no conversion.
export type ScreenCapture = { data: string; imageWidth: number; imageHeight: number };

export type AutomationRunner = {
  steps: RunStep[];
  status: RunStatus;
  summary: string;
  error: string;
  running: boolean;
  /** Output tokens this run has produced so far, for the live working line. */
  tokens: number;
  label: string;
  // screenshot is the newest capture of the screen, and point the spot about to
  // be clicked, so a screen-level approval can show WHERE rather than a number.
  pending: { action: AutomationAction; label: string; screenshot?: ScreenCapture; point?: { x: number; y: number } } | null;
  // workingFolder, when set, is the absolute path of the user's chosen folder; any
  // shell command in this run executes inside it instead of the hidden workspace.
  run: (task: string, model: ModelTier, label?: string, workingFolder?: string) => Promise<RunOutcome>;
  /** Hand a message the user typed mid-run to the model with the next step.
   * Returns false when no run is in flight to hear it. */
  say: (text: string) => boolean;
  /** Drain the mid-run messages that the run ended before it could hear. */
  takeUnsaid: () => string[];
  decide: (approved: boolean) => void;
  stop: () => void;
  clear: () => void;
  /** Drop the summary once it has been moved into the transcript. */
  clearSummary: () => void;
  setAutoApprove: (value: boolean) => void;
  setPermissions: (permissions: Record<string, boolean>) => void;
  // Live, synchronous "is a run in progress" check. Unlike `running` (derived
  // from React state, which lags a tick), this is set the instant a run starts,
  // so callers can avoid launching a second run in the same tick.
  isBusy: () => boolean;
  // True only while the run has actually stopped, waiting for its conversation to
  // come back on screen. That happens when the next action drives the real mouse
  // and screen, or needs an approval nobody can give from a pane they cannot see.
  // Work that needs neither keeps going in the background and never reports this.
  paused: boolean;
  pause: () => void;
  resume: () => void;
};

export function useAutomationRunner(): AutomationRunner {
  const [steps, setSteps] = useState<RunStep[]>([]);
  // A mirror of the step list that is current the moment it changes. React state
  // lags a render behind, and the caller reads the finished work as soon as the
  // run resolves, which is sooner than that.
  const stepsRef = useRef<RunStep[]>([]);
  function writeSteps(next: (current: RunStep[]) => RunStep[]): void {
    stepsRef.current = next(stepsRef.current);
    setSteps(stepsRef.current);
  }
  const [status, setStatus] = useState<RunStatus>("idle");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [tokens, setTokens] = useState(0);
  const [pending, setPending] = useState<{ action: AutomationAction; label: string; screenshot?: ScreenCapture; point?: { x: number; y: number } } | null>(null);
  // Whether this run's conversation is off screen. On its own this stops nothing:
  // it is the loop that decides, per action, whether that matters.
  const backgroundedRef = useRef(false);
  // Whether the loop is actually parked, waiting for its conversation to come
  // back. Only this is reported as "paused", because it is the only state where
  // the run really has stopped moving and opening the chat is what restarts it.
  const [paused, setPaused] = useState(false);
  const resumeResolve = useRef<(() => void) | null>(null);

  // The user's chosen working folder for the current run (absolute path), passed to
  // the shell so a command runs inside their folder. Held in a ref so the execute
  // calls read the latest without threading it through every step.
  const workingFolderRef = useRef<string | undefined>(undefined);
  const stoppedRef = useRef(false);
  // Set synchronously the instant a run begins and cleared on every exit path.
  // The React `status` state lags a tick, so two callers (a manual send and the
  // 30-second scheduler firing together) could both read status !== "running"
  // and start two runs that drive the mouse at once and double-bill. This ref is
  // the authoritative guard against that.
  const runningRef = useRef(false);
  const approvalResolve = useRef<((approved: boolean) => void) | null>(null);
  // Messages typed while a run is working, waiting to ride out with the next
  // step. Drained in one batch so two quick corrections arrive together.
  const interjections = useRef<string[]>([]);
  function say(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || !runningRef.current) return false;
    interjections.current.push(trimmed);
    return true;
  }
  /**
   * Messages that were typed during the run but never reached the model, handed
   * back so the caller can answer them.
   *
   * A steer only rides out with the NEXT step, so anything typed while the run
   * was finishing had no step left to ride. Those messages used to sit in the
   * queue until the next run cleared it, which is why asking twice for something
   * as a run ended got no reply at all: both messages were shown in the chat and
   * neither was ever heard.
   */
  function takeUnsaid(): string[] {
    return interjections.current.splice(0);
  }
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

  // Park the loop until this run's conversation is back on screen. Called only
  // before an action that genuinely needs it, so a pause never interrupts an
  // action mid-flight and never stalls work that did not need the user present.
  // The mouse overlay is lowered while parked so the user has their cursor back,
  // and re-raised by the next input action.
  async function waitIfPaused(): Promise<void> {
    if (!backgroundedRef.current) return;
    hideOverlay();
    setPaused(true);
    await new Promise<void>((resolve) => {
      resumeResolve.current = resolve;
    });
    resumeResolve.current = null;
    setPaused(false);
  }

  // This run's conversation left the screen. Nothing stops here: the loop keeps
  // planning, reading and writing, and parks only when it reaches something that
  // needs the screen or the user.
  function pause(): void {
    if (!runningRef.current) return;
    backgroundedRef.current = true;
  }

  // The conversation is on screen again: let a parked run carry on from exactly
  // where it stopped.
  function resume(): void {
    if (!backgroundedRef.current) return;
    backgroundedRef.current = false;
    const release = resumeResolve.current;
    resumeResolve.current = null;
    release?.();
  }

  function requestApproval(action: AutomationAction, screenshot?: ScreenCapture | null): Promise<boolean> {
    return new Promise((resolve) => {
      approvalResolve.current = resolve;
      // A coordinate means nothing to a person, so when the action targets a
      // screen point, hand the popup the latest screenshot and that point and let
      // it show the user exactly what is about to be clicked.
      const point =
        action.kind === "windows" && typeof action.x === "number" && typeof action.y === "number"
          ? { x: action.x, y: action.y }
          : undefined;
      setPending({
        action,
        label: actionLabel(action),
        ...(point && screenshot ? { screenshot, point } : {})
      });
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
  //
  // Guarded on the live ref alone. The `status` state lags a render behind, so
  // also testing it made a clear() issued the instant a run resolved a silent
  // no-op, which left the finished work pinned to the bottom of the chat after
  // it had already been moved into the transcript.
  function clear(): void {
    if (runningRef.current) return;
    writeSteps(() => []);
    setSummary("");
    setError("");
    setLabel("");
    setStatus("idle");
    setPending(null);
  }

  function stop(): void {
    stoppedRef.current = true;
    // If the loop is parked waiting for its conversation, release it so it wakes,
    // sees the stop flag, and exits cleanly instead of hanging on the promise.
    backgroundedRef.current = false;
    setPaused(false);
    const release = resumeResolve.current;
    resumeResolve.current = null;
    release?.();
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
      const action = step.action;
      // Same rule as the model loop: wait for the conversation only when this
      // step needs the screen or an approval.
      if (needsTheMachine(action) || shouldPrompt(action)) await waitIfPaused();
      if (stoppedRef.current) return "stopped";
      const id = stepId();
      writeSteps((current) => [...current, { id, label: activityLine(action, true), doing: activityLine(action, false), detail: actionDetail(action), status: "running" }]);

      // Re-derive approval from the action itself rather than trusting the stored
      // flag (a tampered recipe could lie); shell is gated by the main process.
      if (shouldPrompt(action)) {
        const approved = await requestApproval(action);
        if (!approved) {
          writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "declined" } : item)));
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
        await window.workcrew.automation.execute(action, workingFolderRef.current);
        writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "ok" } : item)));
      } catch {
        writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
        return "failed";
      }
    }
    return "complete";
  }

  async function run(task: string, model: ModelTier, runLabel = "", workingFolder?: string): Promise<RunOutcome> {
    // Tracked alongside every setState below, so the outcome is known here and
    // not read back out of React.
    const outcome: RunOutcome = { status: "idle", summary: "", error: "", steps: [] };
    const settle = (status: RunStatus, text = outcome.summary): RunOutcome => {
      outcome.status = status;
      outcome.summary = text;
      outcome.steps = stepsRef.current;
      return outcome;
    };
    const trimmed = task.trim();
    // Synchronous guard: if a run is already in flight, do nothing. This is set
    // before any await so a second caller in the same tick cannot slip past it.
    if (trimmed.length < 3 || runningRef.current) return outcome;
    runningRef.current = true;
    workingFolderRef.current = workingFolder;
    // Event name only; never the task text or any on-screen content.
    track("automation_started");
    // Wrap the whole run in try/finally so the in-flight guard is cleared on
    // EVERY exit path, including an unexpected throw from the replay section
    // below (which runs before the main loop's own try). Missing this would
    // strand the runner with isBusy() stuck true until an app restart.
    try {
    stoppedRef.current = false;
    backgroundedRef.current = false;
    setPaused(false);
    mouseActiveRef.current = false;
    writeSteps(() => []);
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
      // Named apart from the run's own outcome, which it must not shadow.
      const replayed = await replayRecipe(recipe);
      hideOverlay();
      if (replayed === "complete") {
        setSummary(recipe.summary || "Task complete.");
        setStatus("complete");
        settle("complete", recipe.summary || "Task complete.");
        saveRecipe({ ...recipe, runCount: recipe.runCount + 1, updatedAtMs: Date.now() });
        addHistory({ task: trimmed, timestamp: Date.now(), outcome: "complete", activityCount: recipe.steps.length });
        track("automation_completed", { via: "replay" });
        return outcome;
      }
      if (replayed === "stopped") {
        setStatus("stopped");
        settle("stopped", "Stopped.");
        setSummary("Stopped.");
        addHistory({ task: trimmed, timestamp: Date.now(), outcome: "stopped", activityCount: 0 });
        return outcome;
      }
      // replayed === "failed": clear the partial replay activity and let the model
      // drive the task from a clean slate.
      writeSteps(() => []);
    }

    // Recording buffers. A clean completed model run is saved as a recipe so the
    // next identical task can skip the model entirely. snapshot is the inspect
    // output current when each action was chosen, used to turn a numeric control
    // reference into a stable name at record time.
    const recorded: { action: AutomationAction; snapshot: string | null; ok: boolean }[] = [];
    let lastSnapshot: string | null = null;
    // The newest screenshot taken during this run, shown in the approval popup
    // when the next action targets a bare screen coordinate.
    let lastScreenshot: ScreenCapture | null = null;
    let finishSummary = "Task complete.";

    try {
      setTokens(0);
      interjections.current = [];
      const kind: RunKind = workingFolder ? "folder" : "screen";
      const created = await window.workcrew.api.createRun(trimmed, model, kind);
      const runId = created.runId;
      if (created.conversationId) outcome.conversationId = created.conversationId;
      let result: { toolUseId: string; ok: boolean; output: string; imageBase64?: string } | undefined;
      // Whether the loop reached a real ending. Running out of steps is not one,
      // and used to fall out of the loop in silence.
      let ended = false;

      for (let step = 0; step < MAX_STEPS[kind]; step += 1) {
        // Deliberately no park here. The loop used to stop dead at the top of
        // every step whenever its conversation was off screen, which meant
        // opening a new chat froze folder work that never needed the screen at
        // all. It now parks further down, and only for an action that does.
        if (stoppedRef.current) {
          // Say so. A stopped run used to end with no words at all, so the chat
          // showed the work it had done and then nothing, which reads exactly
          // like being ignored.
          setSummary("Stopped.");
          setStatus("stopped");
          settle("stopped", "Stopped.");
          ended = true;
          break;
        }
        const say = result && interjections.current.length > 0 ? interjections.current.splice(0).join("\n") : undefined;
        let response;
        try {
          response = await window.workcrew.api.nextRun(runId, result, say);
        } catch (stepError) {
          // A backend from before mid-run messages rejects the say field
          // outright. Losing one steer is recoverable; losing the run is not,
          // so deliver the step bare rather than dying on the extra field.
          if (!say) throw stepError;
          // The steer was drained to send it, so put it back rather than losing
          // what the user typed: it rides the next step instead.
          interjections.current.unshift(say);
          response = await window.workcrew.api.nextRun(runId, result);
        }
        if (typeof response.tokens === "number") setTokens(response.tokens);
        if (response.status === "complete") {
          finishSummary = response.message ?? "Task complete.";
          setSummary(finishSummary);
          setStatus("complete");
          settle("complete", finishSummary);
          ended = true;
          break;
        }
        if (response.status === "failed") {
          setSummary(response.message ?? "This task stopped.");
          setStatus("failed");
          settle("failed", response.message ?? "This task stopped.");
          ended = true;
          break;
        }
        if (!response.action || !response.toolUseId) {
          // A step that is neither an action nor an ending. Bailing out quietly
          // left the run with no summary and a status still reading "running",
          // so the chat sat there with a spinner that never resolved.
          setSummary("I could not work out the next step, so I stopped here.");
          setStatus("failed");
          settle("failed", "I could not work out the next step, so I stopped here.");
          ended = true;
          break;
        }

        const action = response.action;
        // Park here, at the one boundary where being off screen actually
        // matters: an action that drives the mouse cannot run while the user is
        // elsewhere, and an action needing approval cannot be approved from a
        // pane nobody can see. Everything else (planning, reading, writing,
        // running a command) carries on in the background. Resume picks up the
        // same run, since the backend run id stays valid, so no work is lost.
        if (needsTheMachine(action) || shouldPrompt(action, lastSnapshot)) {
          await waitIfPaused();
          if (stoppedRef.current) {
            setSummary("Stopped.");
            setStatus("stopped");
            settle("stopped", "Stopped.");
            ended = true;
            break;
          }
        }
        // Tracked per action so a failed or declined step is excluded from the
        // saved recipe (only the clean successful path is cached).
        const recordEntry = { action, snapshot: lastSnapshot, ok: true };
        recorded.push(recordEntry);
        const id = stepId();
        writeSteps((current) => [...current, { id, label: activityLine(action, true), doing: activityLine(action, false), detail: actionDetail(action), status: "running" }]);

        // Shell commands are approved by the main process itself (a native prompt
        // that cannot be bypassed), so they are not prompted again here. Other
        // writes use the in-app approval based on Always allow and the per-category
        // Permissions toggles.
        if (shouldPrompt(action, lastSnapshot)) {
          const approved = await requestApproval(action, lastScreenshot);
          if (!approved) {
            recordEntry.ok = false;
            writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "declined" } : item)));
            result = { toolUseId: response.toolUseId, ok: false, output: "You declined this action." };
            continue;
          }
        }

        try {
          showOverlayFor(action);
          const executed = await window.workcrew.automation.execute(action, workingFolderRef.current);
          const output = executed.output;
          writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "ok" } : item)));
          // A screenshot travels back as the picture itself, so the planner can
          // see an app that publishes no named controls. Everything else is text.
          result = {
            toolUseId: response.toolUseId,
            ok: true,
            output: redactResult(output),
            ...(executed.imageBase64 ? { imageBase64: executed.imageBase64 } : {})
          };
          // Keep the newest screenshot so the approval popup for the next screen
          // click can show the user WHERE it is about to click, rather than a
          // pair of numbers they cannot judge.
          if (executed.imageBase64 && executed.imageWidth && executed.imageHeight) {
            lastScreenshot = { data: executed.imageBase64, imageWidth: executed.imageWidth, imageHeight: executed.imageHeight };
          }
          // Remember the latest snapshot so a following click can be resolved to
          // a stable name (recipe recording) and to its real label (approval
          // gate). Windows inspect lists controls; every browser command returns
          // a fresh aria snapshot, so capture both. The raw output is kept (not
          // the redacted copy) so refs and names survive.
          if (action.kind === "windows" && action.command === "inspect") lastSnapshot = output;
          else if (action.kind === "browser") lastSnapshot = output;
        } catch (caught) {
          recordEntry.ok = false;
          writeSteps((current) => current.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
          const message = caught instanceof Error ? caught.message : "That step could not be completed.";
          result = { toolUseId: response.toolUseId, ok: false, output: redactResult(message) };
        }
      }
      if (!ended) {
        settle("failed", `I stopped after ${MAX_STEPS[kind]} steps without finishing. Ask me to carry on and I will pick it up.`);
        // The safety ceiling, reached. It ends the run like any other ending, out
        // loud: falling out of the loop in silence left the work on screen with
        // no word about why it had stopped, and a status still reading "running".
        setSummary(`I stopped after ${MAX_STEPS[kind]} steps without finishing. Ask me to carry on and I will pick it up.`);
        setStatus("failed");
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The task could not be started.";
      setError(message);
      setStatus("failed");
      settle("failed");
      outcome.error = message;
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
      backgroundedRef.current = false;
      setPaused(false);
    }
    outcome.steps = stepsRef.current;
    return outcome;
  }

  return { steps, status, summary, error, tokens, label, pending, run, say, takeUnsaid, decide, stop, clear, clearSummary: () => setSummary(""), setAutoApprove, setPermissions, isBusy: () => runningRef.current, running: status === "running", paused, pause, resume };
}
