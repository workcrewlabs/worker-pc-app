import { useEffect, useState } from "react";
import type { AutomationRunner } from "../hooks/useAutomationRunner";
import { Markdown } from "../lib/markdown";

// Folder-mode work rendered the quiet cowork way: a muted past-tense line per
// command, a small spinner with elapsed seconds while working, and the final
// answer as a normal chat message. Nothing boxed, no Stop button here (the
// composer's Send button becomes Stop), so answering a question about a folder
// feels like chat, not like the computer being taken over. The boxed panel
// below stays for headed automations (browser and app control).
export function FolderActivity({ runner }: { runner: AutomationRunner }) {
  const { steps, summary, status, error, running } = runner;

  // Elapsed seconds since the run started, shown next to the spinner like
  // "Working... 7s" so a long command visibly makes progress.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running && steps.length === 0 && !summary && !error) return null;

  // One muted line per action, naming what it acted on. Every line used to read
  // "Ran a command" with the command hidden in a tooltip, which told the user
  // nothing about whether the work was going well or going in circles.
  const lineFor = (label: string, stepStatus: string): string => {
    if (stepStatus === "error") return `${label} (failed)`;
    if (stepStatus === "declined") return `${label} (skipped)`;
    return label;
  };

  // The step in flight, shown live with the spinner instead of a bare "Working".
  const inFlight = steps.find((step) => step.status === "running");

  return (
    <div className="folder-activity" aria-live="polite">
      {steps
        .filter((step) => step.status !== "running")
        .map((step) => (
          <p key={step.id} className="folder-step" title={step.detail || undefined}>
            {lineFor(step.label, step.status)}
          </p>
        ))}
      {running && (
        <p className="folder-working" title={inFlight?.detail || undefined}>
          <span className="chip-spinner" aria-hidden="true" />
          {inFlight?.doing ?? inFlight?.label ?? "Working"}...{elapsed >= 3 ? ` ${elapsed}s` : ""}
        </p>
      )}
      {!running && summary && (
        <div className="turn turn-assistant">
          <div className="assistant-body">
            <Markdown text={summary} />
          </div>
        </div>
      )}
      {!running && error && status !== "stopped" && <p className="turn-error">{error}</p>}
    </div>
  );
}

// Shows an automation run inline inside the chat: the task being done, each step
// as it happens, and the final result. This replaces the old separate Automation
// panel, so the user just talks in one chat and watches the work unfold in place.
export function AutomationActivity({
  runner,
  task,
  onSaveRoutine,
  onRerun
}: {
  runner: AutomationRunner;
  task: string;
  onSaveRoutine?: () => void;
  onRerun?: () => void;
}) {
  const { steps, summary, status, error, running } = runner;

  // Nothing to show until a run has started or has left a result behind.
  if (!running && steps.length === 0 && !summary && !error) return null;

  const headline = running
    ? "Working on it"
    : status === "complete"
      ? "Done"
      : status === "stopped"
        ? "Stopped"
        : "Stopped early";

  return (
    <section className={`run-activity run-${status}`} aria-live="polite">
      <div className="run-head">
        <span className={`run-indicator ${running ? "run-indicator-busy" : ""}`} aria-hidden="true" />
        <div className="run-head-text">
          <strong>{headline}</strong>
          {task && <p className="run-task">{task}</p>}
        </div>
        {running && (
          <button type="button" className="stop-button" onClick={runner.stop}>Stop</button>
        )}
      </div>

      {steps.length > 0 && (
        <ul className="record-list run-steps">
          {steps.map((step) => (
            <li key={step.id} className={`automation-step step-${step.status}`}>
              <span className="step-dot" aria-hidden="true" />
              <div className="record-main">
                <p className="record-task"><strong>{step.label}</strong></p>
                {step.detail && <p className="record-sub">{step.detail}</p>}
              </div>
              <span className="step-status">{step.status}</span>
            </li>
          ))}
        </ul>
      )}

      {summary && <p className="run-summary">{summary}</p>}
      {error && <p className="error-banner inline">{error}</p>}

      {!running && (status === "complete" || status === "failed" || status === "stopped") && (onRerun || onSaveRoutine) && (
        <div className="run-card-actions">
          {onRerun && (
            <button type="button" className="run-save-btn" onClick={onRerun}>
              Run again
            </button>
          )}
          {onSaveRoutine && status === "complete" && (
            <button type="button" className="run-save-btn" onClick={onSaveRoutine}>
              Save as a routine
            </button>
          )}
        </div>
      )}
    </section>
  );
}
