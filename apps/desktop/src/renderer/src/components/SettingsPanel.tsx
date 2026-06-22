import { useEffect, useState } from "react";
import { PanelShell } from "./PanelShell";

// Settings holds the one thing a user may need to change: the backend address.
// Everything sensitive (keys, billing, provider details) lives on the backend,
// so there is nothing secret to enter here. App version and modes are shown for
// support and troubleshooting.

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
  const [backendUrl, setBackendUrl] = useState("");
  const [initial, setInitial] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => window.workcrew.updates.onStatus((status) => setUpdate(status)), []);

  async function checkForUpdates() {
    setChecking(true);
    setUpdate({ state: "checking" });
    try {
      await window.workcrew.updates.check();
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void window.workcrew.settings.getBackendUrl().then((url) => {
      if (cancelled) return;
      setBackendUrl(url);
      setInitial(url);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const saved = await window.workcrew.settings.setBackendUrl(backendUrl);
      setBackendUrl(saved);
      setInitial(saved);
      setNotice("Saved. New requests use this address right away.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That address could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const changed = backendUrl.trim() !== initial && backendUrl.trim().length > 0;

  return (
    <PanelShell title="Settings" subtitle="Connection and app information." onClose={onClose}>
      <div className="save-form">
        <label className="field-label" htmlFor="backend-url">Backend address</label>
        <input
          id="backend-url"
          value={backendUrl}
          onChange={(event) => setBackendUrl(event.target.value)}
          placeholder="https://your-backend.onrender.com"
          spellCheck={false}
          autoComplete="off"
        />
        <p className="field-hint">
          Where WorkCrew sends your requests. Leave this as the default unless support gives you a new address.
        </p>
        <div className="save-row">
          <button className="primary" onClick={() => void save()} disabled={!changed || busy}>
            {busy ? "Saving..." : "Save address"}
          </button>
          {initial && backendUrl.trim() !== initial && (
            <button className="link-button" onClick={() => setBackendUrl(initial)} disabled={busy}>
              Reset
            </button>
          )}
        </div>
        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error-banner inline">{error}</p>}
      </div>

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
    </PanelShell>
  );
}
