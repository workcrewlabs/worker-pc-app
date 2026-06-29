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
  userName,
  onSaveName,
  onClose,
  onSignOut,
  onAdjustPlan,
  onDeleteAccount
}: {
  entitlement: SubscriptionState;
  usedMicrodollars: number;
  userName: string | null;
  onSaveName: (name: string) => Promise<void>;
  onClose: () => void;
  onSignOut: () => Promise<void>;
  onAdjustPlan: (plan: PlanId, interval: BillingInterval) => Promise<void>;
  onDeleteAccount: () => Promise<void>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"adjust" | "signout" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState("");
  const [nameDraft, setNameDraft] = useState(userName ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
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

  // Keep the editable name field in sync with the canonical saved value, so after
  // a save (which trims) or any backend normalization the input reflects what was
  // actually stored rather than stale draft text.
  useEffect(() => {
    setNameDraft(userName ?? "");
  }, [userName]);

  const planName = entitlement.plan ? PLAN_CATALOG[entitlement.plan].name : "No active plan";
  const budget = entitlement.budgetMicrodollars;
  const used = Math.min(usedMicrodollars, budget);
  const remaining = Math.max(0, budget - used);
  const percent = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;

  async function saveName() {
    const normalized = nameDraft.trim();
    setSavingName(true);
    setError("");
    setNameSaved(false);
    try {
      await onSaveName(normalized);
      setNameDraft(normalized);
      setNameSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save your name.");
    } finally {
      setSavingName(false);
    }
  }

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

  // Cancel a scheduled downgrade by re-selecting the current plan and interval,
  // which releases the Stripe schedule so renewals continue on the current plan.
  async function cancelDowngrade() {
    if (!entitlement.plan || !entitlement.interval) return;
    setBusy("adjust");
    setError("");
    try {
      await onAdjustPlan(entitlement.plan, entitlement.interval);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not cancel the scheduled change.");
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

        <div className="account-name">
          <label className="field-label" htmlFor="account-name-input">Your name</label>
          <div className="account-name-row">
            <input
              id="account-name-input"
              type="text"
              value={nameDraft}
              maxLength={120}
              placeholder="What should we call you?"
              onChange={(event) => { setNameDraft(event.target.value); setNameSaved(false); }}
            />
            <button
              type="button"
              className="secondary"
              onClick={saveName}
              disabled={savingName || nameDraft.trim() === (userName ?? "").trim()}
            >
              {savingName ? "Saving..." : nameSaved ? "Saved" : "Save"}
            </button>
          </div>
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

        {entitlement.pendingPlan && entitlement.plan && entitlement.pendingEffective && (
          <div className="account-pending" role="status">
            <strong>Scheduled plan change</strong>
            <p>
              You will switch to {PLAN_CATALOG[entitlement.pendingPlan].name} on {formatDate(entitlement.pendingEffective)}.
              You keep your current {PLAN_CATALOG[entitlement.plan].name} limit of {formatTokens(budget)} tokens until then,
              after which it becomes the {PLAN_CATALOG[entitlement.pendingPlan].name} limit. Nothing changes before that date.
            </p>
            <button type="button" className="secondary" onClick={cancelDowngrade} disabled={busy !== null}>
              {busy === "adjust" ? "Updating..." : `Keep ${PLAN_CATALOG[entitlement.plan].name}`}
            </button>
          </div>
        )}

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
              const isPending = entitlement.pendingPlan === plan && entitlement.pendingInterval === interval;
              return (
                <div key={plan} className="plan-option">
                  <div className="plan-option-info">
                    <strong>{catalog.name}</strong>
                    <span>${price}/{interval === "year" ? "year" : "month"}</span>
                  </div>
                  <button
                    type="button"
                    className={isCurrent || isPending ? "secondary" : "primary"}
                    onClick={() => switchPlan(plan)}
                    disabled={isCurrent || isPending || busy !== null}
                  >
                    {isCurrent ? "Current" : isPending ? "Scheduled" : busy === "adjust" ? "Switching..." : "Switch"}
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
