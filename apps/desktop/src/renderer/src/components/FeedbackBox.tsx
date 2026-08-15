import { useState } from "react";

// A small feedback box on the home page. The user types a short note and sends
// it, which opens their Gmail compose window pre-filled with the message and
// addressed to the WorkCrew support inbox. Nothing is sent until the user
// reviews and sends that draft themselves, so the renderer never posts the text
// anywhere directly.
const MAX_LENGTH = 2000;

export function FeedbackBox() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<null | "sent" | "error">(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await window.workcrew.support.contact({ subject: "WorkCrew feedback", body });
      setText("");
      setNotice("sent");
    } catch {
      setNotice("error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feedback-box">
      <label className="feedback-label" htmlFor="feedback-input">Share feedback</label>
      <form className="feedback-form" onSubmit={submit}>
        <textarea
          id="feedback-input"
          className="feedback-input"
          value={text}
          onChange={(event) => { setText(event.target.value); setNotice(null); }}
          placeholder="Tell us what is working or what could be better"
          maxLength={MAX_LENGTH}
          rows={2}
          disabled={busy}
        />
        <button type="submit" className="feedback-send" disabled={busy || !text.trim()}>
          {busy ? "Opening..." : "Send"}
        </button>
      </form>
      {notice === "sent" && (
        <p className="feedback-note feedback-note-ok" role="status">
          Your email draft is ready to review and send. Thank you.
        </p>
      )}
      {notice === "error" && (
        <p className="feedback-note feedback-note-err" role="alert">
          Could not open your email. Please try again.
        </p>
      )}
    </div>
  );
}
