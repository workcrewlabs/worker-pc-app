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
  const detail =
    action.kind === "shell"
      ? action.command
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
        <h2 id="approval-title">{isShell ? "WorkCrew wants to run a command" : "WorkCrew wants to make a change"}</h2>
        <p id="approval-desc" className="modal-text">
          {isShell
            ? "This runs on your computer in WorkCrew's workspace folder. Only allow commands you understand and trust."
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
            {isShell ? "Run it" : "Allow once"}
          </button>
        </div>
        {/* Commands are always confirmed one at a time, so "Allow always" is hidden. */}
        {!isShell && (
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
