import { useState } from "react";

// A one-time announcement shown the first time the app opens after the usage
// upgrade. It is purely informational and changes nothing. Dismissing it (the X,
// the Got it button, or clicking the backdrop) records a flag so it never shows
// again on this device. Bump the key suffix to run a future one-time announcement.
const SEEN_KEY = "workcrew.announce.usageBoost.v1";

function alreadySeen(): boolean {
  // Treat unavailable storage as "seen" so a storage error can never make the
  // announcement reappear on every launch.
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function UsageBoostBanner() {
  const [open, setOpen] = useState(() => !alreadySeen());
  if (!open) return null;

  function dismiss() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Storage unavailable: still close for this session.
    }
    setOpen(false);
  }

  return (
    <div className="announce-overlay" role="dialog" aria-modal="true" aria-labelledby="announce-title" onClick={dismiss}>
      <div className="announce-card" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="announce-close" aria-label="Dismiss" onClick={dismiss}>&#215;</button>
        <span className="announce-eyebrow">What's new</span>
        <h2 id="announce-title" className="announce-title">You now get about <span className="announce-accent">3x more</span> usage</h2>
        <p className="announce-body">WorkCrew just got much more efficient, so your plan goes a lot further. The same plan now gets you roughly three times more chats and automations, at no extra cost. It's already on, nothing to change.</p>
        <div className="announce-actions">
          <button type="button" className="primary announce-cta" onClick={dismiss}>Got it</button>
        </div>
      </div>
    </div>
  );
}
