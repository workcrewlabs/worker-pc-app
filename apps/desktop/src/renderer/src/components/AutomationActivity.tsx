import { useEffect, useState } from "react";
import type { AutomationRunner } from "../hooks/useAutomationRunner";
import { summarizeActivity } from "../lib/automation";

/** Elapsed time the way a clock reads it: 45s, 2m 30s, 1h 4m. 480s is not a
 *  number anyone can feel. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// A compact token count for the working line: 620, 1.4K, 12K.
function compactTokens(count: number): string {
  if (count >= 10_000) return `${Math.round(count / 1_000)}K`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// Folder-mode work rendered the way a coding assistant shows its own: one
// collapsed line summarising everything done so far ("Ran 12 commands, read 5
// files, wrote 3 files"), expandable to the named per-step lines, and a live
// working line with elapsed time, tokens, and what is happening right now.
// A long run reads as a sentence instead of a scroll.
export function FolderActivity({ runner }: { runner: AutomationRunner }) {
  const { steps, summary, status, error, running, tokens } = runner;

  // Elapsed seconds since the run started, part of the live working line.
  const [elapsed, setElapsed] = useState(0);
  // Whether the per-step detail is open. Collapsed by default; the summary line
  // carries the counts, including failures, so nothing is hidden that matters.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running && steps.length === 0 && !summary && !error) return null;

  const lineFor = (label: string, stepStatus: string): string => {
    if (stepStatus === "error") return `${label} (failed)`;
    if (stepStatus === "declined") return `${label} (skipped)`;
    return label;
  };

  const finished = steps.filter((step) => step.status !== "running");
  const grouped = summarizeActivity(finished);
  // The step in flight; between steps the model is deciding what to do next.
  const inFlight = steps.find((step) => step.status === "running");
  const doing = inFlight?.doing ?? inFlight?.label ?? "Thinking";

  return (
    <div className="folder-activity" aria-live="polite">
      {grouped && (
        <button
          type="button"
          className={`folder-group${expanded ? " folder-group-open" : ""}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <svg className="folder-group-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 6 15 12 9 18" />
          </svg>
          {grouped}
        </button>
      )}
      {expanded && finished.length > 0 && (
        <div className="folder-steps">
          {finished.map((step) => (
            <p key={step.id} className="folder-step" title={step.detail || undefined}>
              {lineFor(step.label, step.status)}
            </p>
          ))}
        </div>
      )}
      {running && (
        <p className="folder-working" title={inFlight?.detail || undefined}>
          <span className="chip-spinner" aria-hidden="true" />
          {elapsed >= 1 ? `${formatElapsed(elapsed)} · ` : ""}
          {tokens > 0 ? `${compactTokens(tokens)} tokens · ` : ""}
          {doing}...
        </p>
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
