import { useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import type { ChatTurn } from "../lib/chat";
import { Dictation } from "../lib/dictation";
import { MessageList } from "./MessageList";

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

// User-facing effort model names. The underlying tiers stay as values; provider
// and model brand names are never shown to the user.
const MODEL_LABELS: Record<ModelTier, string> = {
  auto: "Auto",
  haiku: "Quick answer",
  sonnet: "Medium effort",
  opus: "High effort"
};

// Quick-start automation examples for the empty state. Clicking one opens the
// Automation panel with the task already filled in, ready to run, so the first
// thing a new user sees is what WorkCrew can actually do on their PC.
const AUTOMATION_PROMPTS = [
  "Open my browser and sign in to a site for me",
  "Open my email and summarize the unread messages",
  "Open Excel and tidy up a spreadsheet",
  "Find a file on my computer and open it"
];

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function ChatView({
  turns,
  streaming,
  model,
  onModelChange,
  onSend,
  onStop,
  onAutomate
}: {
  turns: ChatTurn[];
  streaming: boolean;
  model: ModelTier;
  onModelChange: (model: ModelTier) => void;
  onSend: (text: string, attachments: AttachmentRef[]) => void;
  onStop: () => void;
  onAutomate: (task: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  const dictationRef = useRef<Dictation | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hasConversation = turns.length > 0;

  // Show the one-time model setup progress on first voice use.
  useEffect(() => window.workcrew.dictation.onStatus((status) => {
    if (status.state === "downloading") setVoiceNote(`Setting up voice ${status.progress ?? 0}%`);
    else if (status.state === "preparing") setVoiceNote("Setting up voice");
    else if (status.state === "ready") setVoiceNote("");
  }), []);

  // Toggle voice input: first tap records, second tap stops and transcribes the
  // clip on-device, appending the recognized text to whatever is already typed.
  async function toggleMic() {
    if (transcribing) return;
    if (dictating) {
      setDictating(false);
      setTranscribing(true);
      setVoiceNote("Transcribing");
      try {
        const text = (await dictationRef.current?.stopAndTranscribe()) ?? "";
        if (text) setDraft((current) => (current.trim() ? `${current.trim()} ${text}` : text));
        setVoiceNote("");
      } catch {
        setVoiceNote("Voice input failed. Please try again.");
      } finally {
        setTranscribing(false);
        dictationRef.current = null;
      }
      return;
    }
    try {
      const dictation = new Dictation();
      await dictation.start();
      dictationRef.current = dictation;
      setDictating(true);
      setVoiceNote("Listening. Tap the mic again to stop.");
    } catch {
      setVoiceNote("Could not access the microphone. Allow mic access and try again.");
    }
  }

  // Focus the composer when the view first mounts and whenever a streamed turn
  // finishes, so the user can keep typing without reaching for the mouse.
  useEffect(() => {
    if (!streaming) composerRef.current?.focus();
  }, [streaming]);

  // Open the native file picker, upload the chosen files, and add a chip for
  // each one that stored successfully. Errors surface as a small inline notice.
  async function addFiles() {
    if (uploading || streaming) return;
    setAttachError("");
    let picked: { path: string; name: string; size: number }[];
    try {
      picked = await window.workcrew.files.pick();
    } catch {
      return;
    }
    if (picked.length === 0) return;
    setUploading(true);
    try {
      const refs = await window.workcrew.attachments.upload(picked);
      setAttachments((current) => [...current, ...refs].slice(0, 20));
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : "The file could not be added.");
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((current) => current.filter((item) => item.attachmentId !== attachmentId));
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || streaming || uploading) return;
    onSend(trimmed, attachments);
    setDraft("");
    setAttachments([]);
    setAttachError("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    }
  }

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !uploading;

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
      {(attachments.length > 0 || attachError) && (
        <div className="attachment-row">
          {attachments.map((item) => (
            <span className="attachment-chip" key={item.attachmentId}>
              <span className="attachment-name" title={item.filename}>{item.filename}</span>
              <button type="button" aria-label={`Remove ${item.filename}`} onClick={() => removeAttachment(item.attachmentId)}>
                ×
              </button>
            </span>
          ))}
          {attachError && <span className="attach-error">{attachError}</span>}
        </div>
      )}
      {voiceNote && <div className="voice-note">{voiceNote}</div>}
      <div className="composer-tools">
        <button
          className="tool-button"
          type="button"
          title="Add files or photos"
          aria-label="Add files or photos"
          onClick={() => void addFiles()}
          disabled={uploading || streaming}
        >
          {uploading ? "…" : "+"}
        </button>
        <button
          className={`tool-button mic-button ${dictating ? "mic-recording" : ""}`}
          type="button"
          title={dictating ? "Stop and add the text" : "Speak your message"}
          aria-label={dictating ? "Stop and transcribe" : "Speak your message"}
          onClick={() => void toggleMic()}
          disabled={transcribing || streaming}
        >
          {transcribing ? "…" : <MicIcon />}
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
          <button className="run-button" type="button" onClick={() => submit(draft)} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );

  if (!hasConversation) {
    return (
      <div className="chat-empty">
        <h1 className="greeting">{timeGreeting()}</h1>
        {composer}
        <p className="suggestion-label">Try an automation</p>
        <div className="suggestion-chips">
          {AUTOMATION_PROMPTS.map((prompt) => (
            <button key={prompt} type="button" onClick={() => onAutomate(prompt)}>
              {prompt}
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
