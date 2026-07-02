import { formatTokens } from "../lib/storage";
import type { UsageStatus } from "../lib/usage";

// A slim banner above the chat that appears as the token allowance runs low
// (amber) and once it is used up (red). It offers upgrading to a higher plan.
// Hidden entirely while there is comfortable headroom.
export function UsageBanner({
  status,
  onUpgrade,
  upgrading,
  canUpgrade
}: {
  status: UsageStatus;
  onUpgrade: () => void;
  upgrading: boolean;
  // False on the top tier (Ultra): there is nothing higher to move to, so the
  // banner just states the limit and the user waits for it to free up.
  canUpgrade: boolean;
}) {
  if (status.level === "ok") return null;
  const empty = status.level === "empty";
  // Name the window that is binding so the message is accurate (the day vs the
  // whole period).
  const period = status.window === "day" ? "for today" : "for this period";
  const emptyMessage =
    status.window === "day"
      ? "You have hit your usage limit for today. It frees up tomorrow."
      : "You have used all your tokens for this period.";
  const message = empty
    ? emptyMessage
    : `You are running low ${period} (${formatTokens(status.remaining)} tokens left).`;

  return (
    <div className={`usage-banner ${empty ? "usage-banner-empty" : "usage-banner-low"}`} role="status" aria-live="polite">
      <span className="usage-banner-dot" aria-hidden="true" />
      <span className="usage-banner-text">{message}</span>
      {canUpgrade && (
        <div className="usage-banner-actions">
          <button type="button" className="usage-banner-upgrade" onClick={onUpgrade} disabled={upgrading}>
            {upgrading ? "Upgrading..." : "Upgrade"}
          </button>
        </div>
      )}
    </div>
  );
}
