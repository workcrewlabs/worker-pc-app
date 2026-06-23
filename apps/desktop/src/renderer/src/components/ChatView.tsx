import { useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import type { ChatTurn } from "../lib/chat";
import { Dictation } from "../lib/dictation";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { MessageList } from "./MessageList";

type PickedFile = { path: string; name: string; size: number };
// A file in the composer: it shows immediately with a spinner while it uploads,
// then becomes ready (or shows an error).
type Attachment = { id: string; filename: string; status: "uploading" | "ready" | "error"; ref?: AttachmentRef };

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

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
const MODEL_OPTIONS: DropdownOption<ModelTier>[] = [
  { value: "auto", label: "Auto" },
  { value: "haiku", label: "Quick answer" },
  { value: "sonnet", label: "Medium effort" },
  { value: "opus", label: "High effort", description: "Uses the most tokens" }
];

// Quick-start automation examples for the empty state. Clicking one opens the
// Automation panel with the task already filled in, ready to run.
const AUTOMATION_PROMPTS = [
  "Open my browser and sign in to a site for me",
  "Open my email and summarize the unread messages",
  "Open Excel and tidy up a spreadsheet",
  "Find a file on my computer and open it"
];

// Example questions for the empty state. Clicking one sends it as a chat message.
const QUESTION_PROMPTS = [
  "What is in the news today?",
  "Explain a tricky topic in simple words",
  "Help me write a clear, friendly email",
  "Summarize a document I will paste in"
];

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  const dictationRef = useRef<Dictation | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hasConversation = turns.length > 0;

  const uploading = attachments.some((item) => item.status === "uploading");
  const readyRefs = attachments.filter((item) => item.status === "ready" && item.ref).map((item) => item.ref as AttachmentRef);

  // Show the one-time model setup progress on first voice use.
  useEffect(() => window.workcrew.dictation.onStatus((status) => {
    if (status.state === "downloading") setVoiceNote(`Setting up voice ${status.progress ?? 0}%`);
    else if (status.state === "preparing") setVoiceNote("Setting up voice");
    else if (status.state === "ready") setVoiceNote("");
  }), []);

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

  useEffect(() => {
    if (!streaming) composerRef.current?.focus();
  }, [streaming]);

  // Add files: show each as a chip with a spinner straight away, then upload them
  // in the background and mark each ready (or failed) on its own. More files can
  // be added while others are still uploading.
  function addFiles(picked: PickedFile[]) {
    if (picked.length === 0) return;
    setAttachError("");
    setAttachments((current) => {
      const room = Math.max(0, 20 - current.length);
      const accepted = picked.slice(0, room);
      const chips: Attachment[] = accepted.map((file) => ({ id: localId(), filename: file.name, status: "uploading" }));
      accepted.forEach((file, index) => {
        const chip = chips[index];
        if (!chip) return;
        window.workcrew.attachments.upload([file])
          .then((refs) => {
            const ref = refs[0];
            setAttachments((list) => list.map((item) =>
              item.id === chip.id ? (ref ? { ...item, status: "ready", ref } : { ...item, status: "error" }) : item
            ));
            if (!ref) setAttachError("A file could not be added.");
          })
          .catch((error) => {
            setAttachments((list) => list.map((item) => (item.id === chip.id ? { ...item, status: "error" } : item)));
            setAttachError(error instanceof Error ? error.message : "A file could not be added.");
          });
      });
      return [...current, ...chips];
    });
  }

  async function pickFiles() {
    if (streaming) return;
    let picked: PickedFile[];
    try {
      picked = await window.workcrew.files.pick();
    } catch {
      return;
    }
    addFiles(picked);
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (streaming) return;
    const picked: PickedFile[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = window.workcrew.files.pathForFile(file);
        if (path) picked.push({ path, name: file.name, size: file.size });
      } catch {
        // A file without a resolvable path is skipped.
      }
    }
    addFiles(picked);
  }

  function onDragOver(event: React.DragEvent) {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
      if (!dragging) setDragging(true);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if ((!trimmed && readyRefs.length === 0) || streaming || uploading) return;
    onSend(trimmed, readyRefs);
    setDraft("");
    setAttachments([]);
    setAttachError("");
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(draft);
    }
  }

  const canSend = (draft.trim().length > 0 || readyRefs.length > 0) && !uploading;

  const composer = (
    <div
      className={`composer ${streaming ? "composer-running" : ""} ${dragging ? "composer-drag" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="attachment-row">
          {attachments.map((item) => (
            <span className={`attachment-chip chip-${item.status}`} key={item.id}>
              {item.status === "uploading" ? (
                <span className="chip-spinner" aria-label="Uploading" />
              ) : (
                <span className="chip-icon" aria-hidden="true">{item.status === "error" ? "!" : "●"}</span>
              )}
              <span className="attachment-name" title={item.filename}>{item.filename}</span>
              <button type="button" aria-label={`Remove ${item.filename}`} onClick={() => removeAttachment(item.id)}>×</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={composerRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask WorkCrew anything..."
        rows={hasConversation ? 1 : 3}
      />
      {attachError && <div className="attach-error-row">{attachError}</div>}
      {voiceNote && <div className="voice-note">{voiceNote}</div>}
      <div className="composer-tools">
        <button
          className="tool-button"
          type="button"
          title="Add files or photos"
          aria-label="Add files or photos"
          onClick={() => void pickFiles()}
          disabled={streaming}
        >
          <PlusIcon />
        </button>
        <button
          className={`tool-button mic-button ${dictating ? "mic-recording" : ""}`}
          type="button"
          title={dictating ? "Stop and add the text" : "Speak your message"}
          aria-label={dictating ? "Stop and transcribe" : "Speak your message"}
          onClick={() => void toggleMic()}
          disabled={transcribing || streaming}
        >
          {transcribing ? <span className="chip-spinner" aria-label="Transcribing" /> : <MicIcon />}
        </button>
        <Dropdown
          value={model}
          options={MODEL_OPTIONS}
          onChange={onModelChange}
          ariaLabel="Answer effort"
          header="Effort"
          direction="up"
          align="right"
        />
        {streaming ? (
          <button className="stop-button" type="button" onClick={onStop}>Stop</button>
        ) : (
          <button className="run-button" type="button" onClick={() => submit(draft)} disabled={!canSend}>Send</button>
        )}
      </div>
      {dragging && <div className="drop-hint">Drop files to attach</div>}
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
            <button key={prompt} type="button" onClick={() => onAutomate(prompt)}>{prompt}</button>
          ))}
        </div>
        <p className="suggestion-label">Ask me a question</p>
        <div className="suggestion-chips">
          {QUESTION_PROMPTS.map((prompt) => (
            <button key={prompt} type="button" onClick={() => submit(prompt)}>{prompt}</button>
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
