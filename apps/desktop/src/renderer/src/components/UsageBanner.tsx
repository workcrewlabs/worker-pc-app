import { formatTokens } from "../lib/storage";
import type { UsageStatus } from "../lib/usage";

// A slim banner above the chat that appears as the token allowance runs low
// (amber) and once it is used up (red). It offers adding tokens and upgrading.
// Hidden entirely while there is comfortable headroom.
export function UsageBanner({
  status,
  onAddTokens,
  onUpgrade,
  upgrading
}: {
  status: UsageStatus;
  onAddTokens: () => void;
  onUpgrade: () => void;
  upgrading: boolean;
}) {
  if (status.level === "ok") return null;
  const empty = status.level === "empty";
  // Name the window that is binding so the message is accurate (a short rate cap
  // vs the day vs the whole period).
  const period = status.window === "5h" ? "for now" : status.window === "day" ? "for today" : "for this period";
  const emptyMessage =
    status.window === "5h"
      ? "You have hit your usage limit for now. It will free up within a few hours."
      : status.window === "day"
        ? "You have hit your usage limit for today. It frees up tomorrow."
        : "You have used all your tokens for this period.";
  const message = empty
    ? emptyMessage
    : `You are running low ${period} (${formatTokens(status.remaining)} tokens left).`;

  return (
    <div className={`usage-banner ${empty ? "usage-banner-empty" : "usage-banner-low"}`} role="status" aria-live="polite">
      <span className="usage-banner-dot" aria-hidden="true" />
      <span className="usage-banner-text">{message}</span>
      <div className="usage-banner-actions">
        <button type="button" className="usage-banner-add" onClick={onAddTokens}>Add tokens</button>
        <button type="button" className="usage-banner-upgrade" onClick={onUpgrade} disabled={upgrading}>
          {upgrading ? "Upgrading..." : "Upgrade"}
        </button>
      </div>
    </div>
  );
}
