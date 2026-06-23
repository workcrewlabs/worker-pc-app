import { useEffect, useState } from "react";
import { SUPPORT_EMAIL } from "@workcrew/contracts";
import { PanelShell } from "./PanelShell";

// Settings shows app information and software updates. The backend address is
// fixed for the released app, so it is not editable here (developers override it
// with the WORKCREW_API_URL environment variable).

type AppInfo = { name: string; version: string; authMode: string; billingMode: string };

type UpdateStatus = { state: string; version?: string; percent?: number; message?: string };

function describeUpdate(status: UpdateStatus | null): string {
  if (!status) return "";
  switch (status.state) {
    case "checking":
      return "Checking for updates...";
    case "available":
      return `Update ${status.version ?? ""} found. Downloading...`.trim();
    case "downloading":
      return `Downloading update... ${status.percent ?? 0}%`;
    case "ready":
      return `Update ${status.version ?? ""} ready. Restart to finish.`.trim();
    case "none":
      return "You are on the latest version.";
    case "unsupported":
      return "Updates apply to the installed app. This is a development run.";
    case "error":
      return status.message ?? "The update could not be completed.";
    default:
      return "";
  }
}

export function SettingsPanel({ info, onClose }: { info: AppInfo; onClose: () => void }) {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState("");

  useEffect(() => window.workcrew.updates.onStatus((status) => setUpdate(status)), []);

  async function checkForUpdates() {
    setChecking(true);
    setUpdate({ state: "checking" });
    try {
      await window.workcrew.updates.check(true);
    } finally {
      setChecking(false);
    }
  }

  // Opens the WorkCrew website, where a subscriber downloads the app and manages
  // payment (and cancels). Billing lives on the website rather than an in-app
  // portal, so this is just a link out.
  async function openHelp() {
    setBillingBusy(true);
    setBillingError("");
    try {
      await window.workcrew.support.billing();
    } catch (caught) {
      setBillingError(caught instanceof Error ? caught.message : "Could not open the website.");
    } finally {
      setBillingBusy(false);
    }
  }

  return (
    <PanelShell title="Settings" subtitle="App information and updates." onClose={onClose}>
      <ul className="record-list settings-info">
        <li className="record-row"><span className="record-sub">App version</span><strong>{info.version}</strong></li>
        <li className="record-row"><span className="record-sub">Sign in</span><strong>{info.authMode === "supabase" ? "Cloud accounts" : "Secure local accounts"}</strong></li>
        <li className="record-row"><span className="record-sub">Billing</span><strong>{info.billingMode === "stripe" ? "Live billing" : "Test activation"}</strong></li>
      </ul>

      <div className="save-form update-section">
        <label className="field-label">Software updates</label>
        <p className="field-hint">WorkCrew keeps itself up to date. You can also check now. A ready update installs when you restart.</p>
        <div className="save-row">
          {update?.state === "ready" ? (
            <button className="primary" onClick={() => void window.workcrew.updates.install()}>Restart to update</button>
          ) : (
            <button className="secondary" onClick={() => void checkForUpdates()} disabled={checking}>
              {checking ? "Checking..." : "Check for updates"}
            </button>
          )}
        </div>
        {update && <p className="notice">{describeUpdate(update)}</p>}
      </div>

      <div className="save-form update-section">
        <label className="field-label">Support</label>
        <p className="field-hint">Questions or a problem? Reach the WorkCrew team at {SUPPORT_EMAIL}. To update your payment method or cancel your subscription, open the WorkCrew website, where billing is managed.</p>
        <div className="save-row">
          <button className="secondary" onClick={() => void window.workcrew.support.contact()}>Contact support</button>
          <button className="secondary" onClick={() => void openHelp()} disabled={billingBusy} title="Open the WorkCrew website">
            {billingBusy ? "Opening..." : "Help"}
          </button>
        </div>
        {billingError && <p className="notice">{billingError}</p>}
      </div>
    </PanelShell>
  );
}
