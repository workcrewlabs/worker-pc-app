import { useEffect, useRef, useState } from "react";
import type { AutomationAction } from "@workcrew/contracts";
import { recipeFromSteps, saveRecipe } from "../lib/recipes";
import { addRoutine } from "../lib/storage";

// Record clicks: the user records their own clicks in the automation browser or
// in a desktop app, names the result, and it is saved as a routine that replays
// those exact steps with no model call (much faster, and free of model tokens).
// Writes are still approved on replay, like any other automation.

type Target = "browser" | "windows";
type Phase = "choose" | "recording" | "review";

function friendly(error: unknown): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  message = message.replace(/^Error invoking remote method '[^']*':\s*/i, "").replace(/^[A-Za-z]*Error:\s*/, "").trim();
  return message || "Something went wrong. Please try again.";
}

export function RecorderDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>("choose");
  const [target, setTarget] = useState<Target>("browser");
  const [steps, setSteps] = useState<AutomationAction[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && phase !== "recording") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase]);

  // A simple elapsed-seconds timer while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  async function start(which: Target) {
    setTarget(which);
    setError("");
    setBusy(true);
    try {
      await window.workcrew.recorder.start(which);
      setPhase("recording");
    } catch (caught) {
      setError(friendly(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError("");
    try {
      const result = await window.workcrew.recorder.stop(target);
      if (!result.steps.length) {
        setError("No clicks were recorded. Start again and click the buttons or fields you want to capture.");
        setPhase("choose");
        return;
      }
      setSteps(result.steps);
      setPhase("review");
    } catch (caught) {
      setError(friendly(caught));
      setPhase("choose");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Give this recorded task a name so you can run it later.");
      return;
    }
    const recipe = recipeFromSteps(trimmed, steps);
    if (!recipe) {
      setError("These steps could not be saved. Please record again.");
      return;
    }
    saveRecipe(recipe);
    // Also save it as a manual routine so it appears in Routines with a Run button.
    addRoutine({ name: trimmed, task: trimmed, cadence: "manual", hour: 9, minute: 0, weekday: 1, enabled: true });
    onSaved();
    onClose();
  }

  // The number of real clicks/edits captured (connect steps are setup, not clicks).
  const actionCount = steps.filter((step) => !(step.kind === "windows" && step.command === "connect")).length;

  return (
    <div className="modal-overlay" onMouseDown={() => { if (phase !== "recording") onClose(); }}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recorder-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="account-head">
          <h2 id="recorder-title">Record clicks</h2>
          <button ref={closeRef} className="panel-close" onClick={onClose} aria-label="Close recorder">Close</button>
        </div>

        {error && <p className="error-banner inline">{error}</p>}

        {phase === "choose" && (
          <>
            <p className="modal-text">Record yourself doing a task once. WorkCrew saves the steps and can repeat them for you, instantly, without using tokens.</p>
            <div className="recorder-choice">
              <button className="recorder-target" onClick={() => void start("browser")} disabled={busy}>
                <strong>My browser</strong>
                <span>Record clicks and typing on a website.</span>
              </button>
              <button className="recorder-target" onClick={() => void start("windows")} disabled={busy}>
                <strong>A Windows app</strong>
                <span>Open the app first, then record clicks in it.</span>
              </button>
            </div>
            {busy && <p className="field-hint">Getting ready...</p>}
          </>
        )}

        {phase === "recording" && (
          <div className="recorder-live">
            <span className="recorder-dot" aria-hidden="true" />
            <p className="modal-text">
              Recording your {target === "browser" ? "browser" : "app"} clicks. Do the task now, then press Stop.
            </p>
            <p className="field-hint">Recording time: {elapsed}s</p>
            <button className="primary full" onClick={() => void stop()} disabled={busy}>{busy ? "Saving..." : "Stop recording"}</button>
          </div>
        )}

        {phase === "review" && (
          <>
            <p className="modal-text">Captured {actionCount} {actionCount === 1 ? "step" : "steps"}. Name this task so you can run it again anytime.</p>
            <input
              className="invite-link"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="For example: Fill my daily timesheet"
              maxLength={80}
              autoFocus
              onKeyDown={(event) => { if (event.key === "Enter") save(); }}
              aria-label="Recorded task name"
            />
            <div className="account-buttons">
              <button className="secondary full" onClick={() => { setPhase("choose"); setSteps([]); setName(""); }}>Record again</button>
              <button className="primary full" onClick={save}>Save task</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
