import { useEffect, useRef, useState } from "react";
import { REFERRAL_BONUS_MICRODOLLARS, type ReferralInfo } from "@workcrew/contracts";
import { formatTokens } from "../lib/storage";

// Invite and earn: shows the user's referral link, the reward, a one-click copy,
// and how many people they have invited and how many have subscribed. The link
// and stats come from GET /v1/referral.
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    window.workcrew.api.referral()
      .then((data) => { if (active) setInfo(data); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load your invite link."); });
    return () => { active = false; };
  }, []);

  async function copyLink() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Could not copy automatically. Select the link and copy it.");
    }
  }

  const reward = formatTokens(REFERRAL_BONUS_MICRODOLLARS);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="account-head">
          <h2 id="invite-title">Invite &amp; earn</h2>
          <button ref={closeRef} className="panel-close" onClick={onClose} aria-label="Close invite">Close</button>
        </div>

        <p className="modal-text">Invite a friend and get {reward} tokens when they subscribe. Share your link or code:</p>

        {error && <p className="error-banner inline">{error}</p>}

        {info && (
          <>
            <div className="invite-link-row">
              <input
                className="invite-link"
                readOnly
                value={info.link}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Your referral link"
              />
              <button className="primary" onClick={() => void copyLink()}>{copied ? "Copied" : "Copy"}</button>
            </div>

            <div className="invite-stats">
              <div><strong>{info.invitedCount}</strong><span>Invited</span></div>
              <div><strong>{info.creditedCount}</strong><span>Subscribed</span></div>
              <div><strong>{formatTokens(info.bonusMicrodollars)}</strong><span>Tokens earned</span></div>
            </div>

            <p className="field-hint">Your friend enters your code <strong>{info.code}</strong> when they create their account. You are credited after their first payment.</p>
          </>
        )}
      </section>
    </div>
  );
}
