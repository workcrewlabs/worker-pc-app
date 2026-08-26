import type { ChatTurn } from "../lib/chat";
import { Markdown } from "../lib/markdown";
import { RunCard, TurnActivityBlock } from "./AutomationActivity";

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

function AssistantTurn({
  turn,
  onRerun,
  onSaveRoutine
}: {
  turn: ChatTurn;
  onRerun?: (task: string) => void;
  onSaveRoutine?: (task: string) => void;
}) {
  // A finished computer task keeps its card, exactly as it looked while running,
  // so Run again and Save as a routine are still there and the next task does
  // not erase it. Both act on this card's own task, not on whatever the runner
  // happens to be holding, which by then is usually a later run.
  if (turn.run) {
    const past = turn.run;
    const task = past.task.trim();
    return (
      <div className="turn turn-assistant">
        <RunCard
          task={past.task}
          status={past.status}
          steps={past.steps}
          summary={past.summary}
          error={past.error}
          onRerun={onRerun ? () => onRerun(past.task) : undefined}
          onSaveRoutine={onSaveRoutine && task.length >= 3 ? () => onSaveRoutine(past.task) : undefined}
        />
      </div>
    );
  }
  return (
    <div className="turn turn-assistant">
      {turn.thinking && turn.thinking.trim().length > 0 && <ThinkingBlock text={turn.thinking} />}
      {/* The work comes before the words, as it happened. */}
      {turn.activity && turn.activity.length > 0 && <TurnActivityBlock steps={turn.activity} />}
      {(turn.text.length > 0 || turn.streaming) && (
        <div className="assistant-body">
          <Markdown text={turn.text} />
          {turn.streaming && <span className="stream-cursor" aria-hidden="true" />}
        </div>
      )}
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

export function MessageList({
  turns,
  onRerun,
  onSaveRoutine
}: {
  turns: ChatTurn[];
  streaming?: boolean;
  onRerun?: (task: string) => void;
  onSaveRoutine?: (task: string) => void;
}) {
  // Scrolling is managed by the parent (ChatView), which only sticks to the
  // bottom when the user is already there, so they can freely scroll up.
  return (
    <div className="message-list" aria-live="polite">
      {turns.map((turn) =>
        turn.role === "user" ? (
          <UserTurn key={turn.id} turn={turn} />
        ) : (
          <AssistantTurn key={turn.id} turn={turn} onRerun={onRerun} onSaveRoutine={onSaveRoutine} />
        )
      )}
    </div>
  );
}
