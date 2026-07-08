import { useEffect, useRef, useState } from "react";
import { SUPPORT_EMAIL } from "@workcrew/contracts";
import { getTheme, setTheme, type Theme } from "../lib/theme";
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
  const [optOut, setOptOut] = useState(false);
  const [analyticsNotice, setAnalyticsNotice] = useState("");
  // Once the user changes the toggle, ignore a late-arriving initial read so it
  // cannot overwrite the newer choice with the stale stored value.
  const optOutTouchedRef = useRef(false);
  // Appearance: dark (default) or light, stored per device and applied instantly.
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  function chooseTheme(next: Theme) {
    setThemeState(next);
    setTheme(next);
  }
  // Token-spend mode: "economy" (default) does much more per plan; "privacy" keeps
  // everything on the most private engine and spends more. Exactly one is active.
  const [modelMode, setModelMode] = useState<"economy" | "privacy">("economy");
  const [modelNotice, setModelNotice] = useState("");
  const modelModeTouchedRef = useRef(false);

  useEffect(() => window.workcrew.updates.onStatus((status) => setUpdate(status)), []);
  useEffect(() => {
    void window.workcrew.settings.getAnalyticsOptOut()
      .then((value) => { if (!optOutTouchedRef.current) setOptOut(value); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    void window.workcrew.settings.getModelMode()
      .then((value) => { if (!modelModeTouchedRef.current) setModelMode(value); })
      .catch(() => {});
  }, []);

  // Choose a mode. The two toggles are mutually exclusive: turning one on turns the
  // other off, so exactly one is always active. Optimistic with rollback on failure.
  async function chooseMode(mode: "economy" | "privacy") {
    modelModeTouchedRef.current = true;
    if (mode === modelMode) return;
    const previous = modelMode;
    setModelMode(mode);
    setModelNotice("");
    try {
      await window.workcrew.settings.setModelMode(mode);
    } catch {
      setModelMode(previous);
      setModelNotice("Could not save that setting. Please try again.");
    }
  }

  async function toggleAnalytics(share: boolean) {
    optOutTouchedRef.current = true;
    const previous = optOut;
    setOptOut(!share);
    setAnalyticsNotice("");
    try {
      await window.workcrew.settings.setAnalyticsOptOut(!share);
    } catch {
      // Persistence failed: roll the switch back so it never shows a state the
      // main process did not actually save, and tell the user.
      setOptOut(previous);
      setAnalyticsNotice("Could not save that setting. Please try again.");
    }
  }

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
        <label className="field-label">Appearance</label>
        <p className="field-hint">Choose how WorkCrew looks on this computer.</p>
        <div
          className="theme-picker"
          role="radiogroup"
          aria-label="Appearance"
          onKeyDown={(event) => {
            // Arrow keys move between options, matching the radiogroup convention.
            if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              chooseTheme(theme === "dark" ? "light" : "dark");
            }
          }}
        >
          <button
            type="button"
            className={`theme-option ${theme === "dark" ? "theme-option-active" : ""}`}
            role="radio"
            aria-checked={theme === "dark"}
            tabIndex={theme === "dark" ? 0 : -1}
            onClick={() => chooseTheme("dark")}
          >
            <span className="theme-swatch theme-swatch-dark" aria-hidden="true" />
            Dark
          </button>
          <button
            type="button"
            className={`theme-option ${theme === "light" ? "theme-option-active" : ""}`}
            role="radio"
            aria-checked={theme === "light"}
            tabIndex={theme === "light" ? 0 : -1}
            onClick={() => chooseTheme("light")}
          >
            <span className="theme-swatch theme-swatch-light" aria-hidden="true" />
            Light
          </button>
        </div>
      </div>

      <div className="save-form update-section">
        <label className="field-label">AI mode</label>
        <p className="field-hint">Choose how WorkCrew uses your tokens. WorkCrew never stores your chats or uses them to train AI models.</p>
        <label className="always-toggle">
          <span className={`switch ${modelMode === "economy" ? "switch-on" : ""}`}>
            <input
              type="checkbox"
              checked={modelMode === "economy"}
              onChange={(event) => void chooseMode(event.target.checked ? "economy" : "privacy")}
              aria-label="Economy mode"
            />
            <span className="switch-knob" aria-hidden="true" />
          </span>
          <span className="always-toggle-label">Economy mode: do much more on the same plan</span>
        </label>
        <label className="always-toggle">
          <span className={`switch ${modelMode === "privacy" ? "switch-on" : ""}`}>
            <input
              type="checkbox"
              checked={modelMode === "privacy"}
              onChange={(event) => void chooseMode(event.target.checked ? "privacy" : "economy")}
              aria-label="Privacy mode"
            />
            <span className="switch-knob" aria-hidden="true" />
          </span>
          <span className="always-toggle-label">Privacy mode: keep everything on WorkCrew's most private AI. This uses a lot more tokens, so chats and tasks go through your limit faster.</span>
        </label>
        {modelNotice && <p className="notice" role="alert">{modelNotice}</p>}
      </div>

      <div className="save-form update-section">
        <label className="field-label">Analytics</label>
        <p className="field-hint">WorkCrew records anonymous usage events (for example app opened, or a download clicked) to improve the app, and you can turn this off. It never records your messages, files, screenshots, passwords, or any private data, and your chats are never used to train AI models.</p>
        <label className="always-toggle">
          <span className={`switch ${!optOut ? "switch-on" : ""}`}>
            <input
              type="checkbox"
              checked={!optOut}
              onChange={(event) => void toggleAnalytics(event.target.checked)}
              aria-label="Share anonymous usage analytics"
            />
            <span className="switch-knob" aria-hidden="true" />
          </span>
          <span className="always-toggle-label">Share anonymous usage analytics</span>
        </label>
        {analyticsNotice && <p className="notice" role="alert">{analyticsNotice}</p>}
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
