// Shown when a free (or capped) user runs out of tokens mid-conversation:
// the Claude-style "Upgrade to keep chatting" wall. `daily` distinguishes the
// paid-plan daily pacing message from the free plan's monthly allowance.
export function UpgradeWallModal({
  plan,
  daily,
  onClose,
  onUpgrade
}: {
  plan: string | null;
  daily: boolean;
  onClose: () => void;
  onUpgrade: () => void;
}) {
  const free = plan === "free";
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="upgrade-wall-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="modal-badge">{free ? "Free plan" : "Limit reached"}</span>
        <h2 id="upgrade-wall-title">Upgrade to keep going</h2>
        <p className="modal-text">
          {free
            ? "You have used all your free trial tokens. The free trial is one time and does not reset, so upgrade to a paid plan to keep going."
            : daily
              ? "You have hit today's usage limit. It frees up tomorrow, or upgrade for higher limits."
              : "You have used this period's tokens. Upgrade for higher limits, or they refresh next period."}
        </p>
        <p className="modal-text">
          Paid plans unlock more usage, stronger engines for tough work, and everything WorkCrew can do on your
          computer: working in your folders, building Excel files on disk, and automating your apps and browser.
        </p>
        <div className="modal-buttons">
          <button className="secondary" onClick={onClose}>Not now</button>
          <button className="primary" onClick={onUpgrade}>See plans</button>
        </div>
      </section>
    </div>
  );
}
