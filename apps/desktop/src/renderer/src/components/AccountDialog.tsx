import { useEffect, useRef, useState } from "react";
import { PLAN_CATALOG, type SubscriptionState } from "@workcrew/contracts";
import { formatTokens } from "../lib/storage";

function formatDate(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(date);
}

export function AccountDialog({
  entitlement,
  usedMicrodollars,
  onClose,
  onSignOut
}: {
  entitlement: SubscriptionState;
  usedMicrodollars: number;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"portal" | "signout" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const planName = entitlement.plan ? PLAN_CATALOG[entitlement.plan].name : "No active plan";
  const budget = entitlement.budgetMicrodollars;
  const used = Math.min(usedMicrodollars, budget);
  const remaining = Math.max(0, budget - used);
  const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;

  async function manageBilling() {
    setBusy("portal");
    setError("");
    try {
      await window.workcrew.api.portal();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open billing.");
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy("signout");
    setError("");
    try {
      await onSignOut();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign out.");
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="account-head">
          <h2 id="account-title">Account</h2>
          <button ref={closeRef} className="panel-close" onClick={onClose} aria-label="Close account">Close</button>
        </div>

        <div className="account-plan">
          <div>
            <span className="field-label">Current plan</span>
            <strong>{planName}</strong>
          </div>
          <span className="tag">{entitlement.interval === "year" ? "Billed yearly" : entitlement.interval === "month" ? "Billed monthly" : entitlement.status}</span>
        </div>

        <div className="account-usage">
          <div className="account-usage-head">
            <span className="field-label">Monthly tokens</span>
            <span>{formatTokens(remaining)} left</span>
          </div>
          <div className="usage-track"><span style={{ width: `${percent}%` }} /></div>
          <div className="account-usage-foot">
            <span>{formatTokens(used)} used of {formatTokens(budget)}</span>
            <span>Resets {formatDate(entitlement.budgetPeriodEnd)}</span>
          </div>
        </div>

        {error && <p className="error-banner inline">{error}</p>}

        <div className="account-buttons">
          <button className="secondary full" onClick={manageBilling} disabled={busy !== null}>
            {busy === "portal" ? "Opening..." : "Manage billing"}
          </button>
          <button className="primary full" onClick={signOut} disabled={busy !== null}>
            {busy === "signout" ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </section>
    </div>
  );
}
