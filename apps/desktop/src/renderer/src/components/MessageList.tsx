import { useEffect, useRef } from "react";
import type { ChatTurn } from "../lib/chat";

// Renders the conversation transcript. User turns sit in a tinted bubble on the
// right of the column; assistant turns render as plain serif body text with no
// avatar. A streaming cursor blinks at the end of the assistant turn that is
// still receiving deltas.

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking-block">
      <summary>Thinking</summary>
      <p>{text}</p>
    </details>
  );
}

function AssistantTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div className="turn turn-assistant">
      {turn.thinking && turn.thinking.trim().length > 0 && <ThinkingBlock text={turn.thinking} />}
      <div className="assistant-body">
        {turn.text}
        {turn.streaming && <span className="stream-cursor" aria-hidden="true" />}
      </div>
      {turn.error && <p className="turn-error">{turn.error}</p>}
    </div>
  );
}

function UserTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div className="turn turn-user">
      {turn.attachments && turn.attachments.length > 0 && (
        <div className="bubble-attachments">
          {turn.attachments.map((attachment, index) => (
            <span className="attachment-chip" key={`${attachment.filename}-${index}`}>
              <span className="attachment-name" title={attachment.filename}>{attachment.filename}</span>
            </span>
          ))}
        </div>
      )}
      {turn.text.length > 0 && <div className="user-bubble">{turn.text}</div>}
    </div>
  );
}

export function MessageList({ turns, streaming }: { turns: ChatTurn[]; streaming: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the latest content in view as deltas arrive and as new turns append.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns, streaming]);

  return (
    <div className="message-list" aria-live="polite">
      {turns.map((turn) =>
        turn.role === "user" ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AssistantTurn key={turn.id} turn={turn} />
        )
      )}
      <div ref={endRef} />
    </div>
  );
}
