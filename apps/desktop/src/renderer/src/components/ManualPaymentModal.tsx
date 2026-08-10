import { useState } from "react";

// Shown wherever the app would normally open a card checkout, on a backend whose
// billing is handled by hand: there is no payment page to send anyone to, so the
// honest answer is who to write to. The team then switches the plan on, and the
// app picks it up on its next check with nothing for the user to do.
export function ManualPaymentModal({ email, onClose }: { email: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const address = email || "the WorkCrew team";

  function copyEmail(): void {
    if (!email) return;
    // Clipboard access can be refused; the address is on screen either way, so a
    // failure just leaves the button unchanged rather than raising an error.
    void navigator.clipboard.writeText(email).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false)
    );
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-pay-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="modal-badge">Getting a plan</span>
        <h2 id="manual-pay-title">We activate your plan by hand</h2>
        <p className="modal-text">
          Card payments are not switched on yet. To get a plan, email {address} from the address you signed up
          with and say which plan you want. We reply with how to pay and switch your account on.
        </p>
        <p className="modal-text">
          Once it is on, WorkCrew picks it up on its own. There is nothing to install and nothing to enter here.
        </p>
        {email && (
          <div className="manual-pay-address">
            <code>{email}</code>
            <button className="secondary" type="button" onClick={copyEmail}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
        <div className="modal-buttons">
          <button className="primary" onClick={onClose}>Got it</button>
        </div>
      </section>
    </div>
  );
}
