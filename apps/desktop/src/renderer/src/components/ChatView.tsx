import { useEffect, useRef, useState } from "react";
import type { ModelTier } from "@workcrew/contracts";
import type { ChatTurn } from "../lib/chat";
import { MessageList } from "./MessageList";

// User-facing effort model names. The underlying tiers stay as values; provider
// and model brand names are never shown to the user.
const MODEL_LABELS: Record<ModelTier, string> = {
  auto: "Auto",
  haiku: "Quick answer",
  sonnet: "Medium effort",
  opus: "High effort"
};

// Quick-start suggestions for the empty state. Clicking one sends it as a chat
// message immediately.
const SUGGESTIONS = [
  "Help me write a clear, friendly email",
  "Explain a tricky topic in plain language",
  "Plan out a project step by step",
  "Summarize a document I will paste in"
];

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Sparkle() {
  return (
    <svg className="greeting-spark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2c.4 3.6 2.4 5.6 6 6-3.6.4-5.6 2.4-6 6-.4-3.6-2.4-5.6-6-6 3.6-.4 5.6-2.4 6-6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ChatView({
  turns,
  streaming,
  model,
  onModelChange,
  onSend,
  onStop
}: {
  turns: ChatTurn[];
  streaming: boolean;
  model: ModelTier;
  onModelChange: (model: ModelTier) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hasConversation = turns.length > 0;

  // Focus the composer when the view first mounts and whenever a streamed turn
  // finishes, so the user can keep typing without reaching for the mouse.
  useEffect(() => {
    if (!streaming) composerRef.current?.focus();
  }, [streaming]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setDraft("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    }
  }

  const composer = (
    <div className={`composer ${streaming ? "composer-running" : ""}`}>
      <textarea
        ref={composerRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask WorkCrew anything..."
        rows={hasConversation ? 1 : 3}
      />
      <div className="composer-tools">
        <button className="tool-button" type="button" title="Add files or photos" aria-label="Add files or photos" disabled>
          +
        </button>
        <select
          value={model}
          onChange={(event) => onModelChange(event.target.value as ModelTier)}
          aria-label="Answer effort"
        >
          {(["auto", "haiku", "sonnet", "opus"] as ModelTier[]).map((tier) => (
            <option key={tier} value={tier}>
              {MODEL_LABELS[tier]}
            </option>
          ))}
        </select>
        {streaming ? (
          <button className="stop-button" type="button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="run-button" type="button" onClick={() => submit(draft)} disabled={draft.trim().length === 0}>
            Send
          </button>
        )}
      </div>
    </div>
  );

  if (!hasConversation) {
    return (
      <div className="chat-empty">
        <h1 className="greeting">
          <Sparkle /> {timeGreeting()}
        </h1>
        {composer}
        <div className="suggestion-chips">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => submit(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-active">
      <div className="chat-scroll">
        <MessageList turns={turns} streaming={streaming} />
      </div>
      <div className="composer-dock">{composer}</div>
    </div>
  );
}
