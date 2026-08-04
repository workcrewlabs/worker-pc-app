import { useEffect, useRef } from "react";
import type { AutomationAction } from "@workcrew/contracts";

// In app approval dialog that replaces window.confirm. It describes the exact
// action WorkCrew wants to take and resolves the run loop based on the choice.
// Escape declines, which keeps the safe default of not running the action.

export function ApprovalModal({
  action,
  label,
  onDecide,
  onAllowAlways
}: {
  action: AutomationAction;
  label: string;
  onDecide: (approved: boolean) => void;
  onAllowAlways: () => void;
}) {
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    allowRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onDecide(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecide]);

  const isShell = action.kind === "shell";
  const isWriteFile = action.kind === "write_file";
  // Shell and write_file are the local-folder work actions: both are confirmed
  // one at a time and governed by the global "Always allow" toggle, so neither
  // shows a per-action "Allow always" button.
  const isLocalAction = isShell || isWriteFile;
  const detail =
    action.kind === "shell"
      ? action.command
      : action.kind === "write_file"
        ? action.path
        : action.kind === "browser"
        ? action.url ?? action.value ?? action.target ?? action.key
        : action.kind === "windows"
          ? action.value ?? action.control ?? action.windowTitle ?? action.application
          : undefined;

  return (
    <div className="modal-overlay" onMouseDown={() => onDecide(false)}>
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-desc"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="modal-badge">Approval needed</span>
        <h2 id="approval-title">{isShell ? "WorkCrew wants to run a command" : isWriteFile ? "WorkCrew wants to write a file" : "WorkCrew wants to make a change"}</h2>
        <p id="approval-desc" className="modal-text">
          {isShell
            ? "This runs on your computer in WorkCrew's workspace folder. Only allow commands you understand and trust."
            : isWriteFile
              ? "This creates or overwrites a file in the folder you are working in. Only allow it if you trust this change."
              : "Review this action before it runs. WorkCrew will only proceed if you allow it."}
        </p>
        <div className="modal-action">
          <strong>{label}</strong>
          {detail && <code>{detail}</code>}
        </div>
        <div className="modal-buttons">
          <button className="secondary" onClick={() => onDecide(false)}>
            Decline
          </button>
          <button ref={allowRef} className="primary" onClick={() => onDecide(true)}>
            {isShell ? "Run it" : isWriteFile ? "Write it" : "Allow once"}
          </button>
        </div>
        {/* Local folder work (commands and file writes) is confirmed one at a
            time under the global toggle, so "Allow always" is hidden for it. */}
        {!isLocalAction && (
          <>
            <button className="modal-allow-always" onClick={onAllowAlways}>
              Allow always
            </button>
            <p className="modal-safe-note">
              Always allow lets WorkCrew act without asking each time.{" "}
              <a href="https://getworkcrew.com/safety" target="_blank" rel="noreferrer">See best practices for safe use</a>
            </p>
          </>
        )}
      </section>
    </div>
  );
}
