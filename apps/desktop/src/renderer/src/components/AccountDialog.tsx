import { useEffect, useRef, useState } from "react";
import { PLAN_CATALOG, type BillingInterval, type PlanId, type SubscriptionState } from "@workcrew/contracts";
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
  onSignOut,
  onAdjustPlan,
  onDeleteAccount
}: {
  entitlement: SubscriptionState;
  usedMicrodollars: number;
  onClose: () => void;
  onSignOut: () => Promise<void>;
  onAdjustPlan: (plan: PlanId, interval: BillingInterval) => Promise<void>;
  onDeleteAccount: () => Promise<void>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"adjust" | "signout" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState("");
  // Adjust plan is an in-place upgrade or downgrade only; cancellation lives in
  // Settings under Help, not on this screen.
  const [adjusting, setAdjusting] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>(entitlement.interval ?? "month");

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

  async function switchPlan(plan: PlanId) {
    setBusy("adjust");
    setError("");
    try {
      await onAdjustPlan(plan, interval);
      setAdjusting(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the plan.");
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

  async function deleteAccount() {
    setBusy("delete");
    setError("");
    try {
      // On success the app navigates to the sign-in screen and unmounts this
      // dialog, so there is no need to reset busy here.
      await onDeleteAccount();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the account.");
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

        {adjusting ? (
          <div className="plan-adjust">
            <div className="billing-toggle plan-interval">
              <button type="button" className={interval === "month" ? "is-active" : ""} onClick={() => setInterval("month")}>Monthly</button>
              <button type="button" className={interval === "year" ? "is-active" : ""} onClick={() => setInterval("year")}>Yearly</button>
            </div>
            {(["pro", "ultra"] as PlanId[]).map((plan) => {
              const catalog = PLAN_CATALOG[plan];
              const price = interval === "year" ? catalog.yearlyPriceUsd : catalog.monthlyPriceUsd;
              const isCurrent = entitlement.plan === plan && entitlement.interval === interval;
              return (
                <div key={plan} className="plan-option">
                  <div className="plan-option-info">
                    <strong>{catalog.name}</strong>
                    <span>${price}/{interval === "year" ? "year" : "month"}</span>
                  </div>
                  <button
                    type="button"
                    className={isCurrent ? "secondary" : "primary"}
                    onClick={() => switchPlan(plan)}
                    disabled={isCurrent || busy !== null}
                  >
                    {isCurrent ? "Current" : busy === "adjust" ? "Switching..." : "Switch"}
                  </button>
                </div>
              );
            })}
            <button type="button" className="secondary full" onClick={() => setAdjusting(false)} disabled={busy !== null}>Done</button>
          </div>
        ) : (
          <>
            <div className="account-buttons">
              <button className="secondary full" onClick={() => setAdjusting(true)} disabled={busy !== null}>
                Adjust plan
              </button>
              <button className="primary full" onClick={signOut} disabled={busy !== null}>
                {busy === "signout" ? "Signing out..." : "Sign out"}
              </button>
            </div>
            {confirmingDelete ? (
              <div className="account-delete-confirm" role="alertdialog" aria-label="Confirm account deletion">
                <p>This permanently deletes your account and all of your data, and cancels your subscription. This cannot be undone.</p>
                <div className="account-delete-actions">
                  <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)} disabled={busy !== null}>
                    Keep my account
                  </button>
                  <button type="button" className="danger" onClick={deleteAccount} disabled={busy !== null}>
                    {busy === "delete" ? "Deleting..." : "Yes, delete my account"}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="account-delete-link" onClick={() => setConfirmingDelete(true)} disabled={busy !== null}>
                Delete my account
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
