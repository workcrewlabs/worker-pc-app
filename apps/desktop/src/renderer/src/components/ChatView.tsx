import { useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import type { ChatTurn, LocalFile } from "../lib/chat";
import type { AutomationRunner } from "../hooks/useAutomationRunner";
import { Dictation } from "../lib/dictation";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { MessageList } from "./MessageList";
import { AutomationActivity, FolderActivity } from "./AutomationActivity";

type PickedFile = LocalFile;
// A file in the composer. A file with a real location on the computer (drag, file
// picker, or a pasted copied file) attaches INSTANTLY: only its path is recorded,
// and nothing is read or uploaded until the message is sent (a local task works on
// the original file and never uploads it). Only a pasted screenshot, which has no
// path, uploads its bytes when pasted and shows a brief spinner.
type Attachment = { id: string; filename: string; status: "uploading" | "ready" | "error"; ref?: AttachmentRef; path?: string; size?: number };

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3l6 17 2.5-6.5L20 11z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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

// A compact on/off toggle that sits under the composer. When on, automations run
// their actions without asking for approval each time. It reads as subordinate to
// the composer (muted) and brightens when on, so the user always sees its state.
// Shell commands still ask every time (the desktop enforces that separately), so
// this never fully removes the safety prompt.
function AlwaysAllowToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label
      className={`always-toggle ${checked ? "always-toggle-on" : ""}`}
      title="Run automation actions without asking each time"
    >
      <span className={`switch ${checked ? "switch-on" : ""}`} aria-hidden="true">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-label="Always allow actions without asking"
        />
        <span className="switch-knob" />
      </span>
      <span className="always-toggle-label">Always allow</span>
    </label>
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

// Turn an upload failure into one short, friendly line. Electron wraps anything
// thrown in the main process as "Error invoking remote method '...': Error: <msg>",
// which looks like a developer error, so we strip that wrapper. The backend's own
// messages (unsupported type, too large, empty) are already written for people, so
// they pass through; a network blip or anything unexpected becomes a plain line.
function friendlyFileError(error: unknown): string {
  let message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  message = message
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^[A-Za-z]*Error:\s*/, "")
    .trim();
  if (!message || /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|abort/i.test(message)) {
    return "That file could not be added. Please try again.";
  }
  return message;
}

export function ChatView({
  turns,
  streaming,
  model,
  onModelChange,
  onSend,
  onStop,
  onAutomate,
  onRecord,
  runner,
  automationTask,
  alwaysAllow,
  onAlwaysAllowChange,
  onSaveRoutine,
  onRerun,
  composerSeed,
  workingFolder,
  onPickFolder,
  onClearFolder,
  onAddFolder
}: {
  turns: ChatTurn[];
  streaming: boolean;
  model: ModelTier;
  onModelChange: (model: ModelTier) => void;
  onSend: (text: string, attachments: AttachmentRef[], files: LocalFile[]) => void;
  onStop: () => void;
  onAutomate: (task: string) => void;
  onRecord?: () => void;
  runner: AutomationRunner;
  automationTask: string;
  alwaysAllow: boolean;
  onAlwaysAllowChange: (value: boolean) => void;
  onSaveRoutine?: () => void;
  onRerun?: () => void;
  composerSeed?: { text: string; nonce: number };
  workingFolder?: { path: string; name: string } | null;
  onPickFolder?: () => void;
  onClearFolder?: () => void;
  // A folder dragged into the chat becomes the working folder.
  onAddFolder?: (folder: { path: string; name: string }) => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  // The "+" opens a small menu to add photos/files or a folder to work in.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const dictationRef = useRef<Dictation | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTurnsRef = useRef(0);
  // Show the conversation layout once there are chat turns OR an automation is
  // running/has run, so an automation started from the empty state unfolds in
  // place rather than leaving the user on the greeting screen.
  const runnerActive = runner.running || runner.steps.length > 0 || Boolean(runner.summary) || Boolean(runner.error);
  const hasConversation = turns.length > 0 || runnerActive;

  const uploading = attachments.some((item) => item.status === "uploading");
  // Pasted screenshots (no path) upload when pasted and carry a ref by send time.
  const readyRefs = attachments.filter((item) => item.status === "ready" && item.ref).map((item) => item.ref as AttachmentRef);
  // Path files attach instantly; they are sent by their real location and only
  // read at send time (or worked on in place by a local task, with no upload).
  const readyFiles: LocalFile[] = attachments
    .filter((item) => item.status === "ready" && item.path)
    .map((item) => ({ path: item.path as string, name: item.filename, size: item.size ?? 0 }));

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

  // Drop seeded text (for example a just-recorded task) into the composer so the
  // user can review, edit, and run it from the chat. Keyed on a nonce so the same
  // text can be re-seeded. The user then presses Send (or refines first).
  useEffect(() => {
    if (composerSeed && composerSeed.text) {
      setDraft(composerSeed.text);
      composerRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSeed?.nonce]);

  // Keep the latest content in view, but only when the user is already at (or
  // near) the bottom. If they have scrolled up to read older messages, leave
  // their position alone so they can actually scroll. A big jump in message count
  // (opening a conversation, or sending a new message) always scrolls to the end.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const jumped = turns.length === 0 || prevTurnsRef.current === 0 || turns.length - prevTurnsRef.current > 1;
    prevTurnsRef.current = turns.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (jumped || nearBottom) el.scrollTop = el.scrollHeight;
  }, [turns, streaming, runner.steps.length, runner.summary, runner.running]);

  // A bad file should not leave a stuck banner. Clear the attachment error on its
  // own after a few seconds (and whenever it changes), so it quietly goes away
  // instead of lingering into the next message or a new chat.
  useEffect(() => {
    if (!attachError) return;
    const timer = setTimeout(() => setAttachError(""), 4500);
    return () => clearTimeout(timer);
  }, [attachError]);

  // Close the add menu on any outside click or Escape.
  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (): void => setAddMenuOpen(false);
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setAddMenuOpen(false); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [addMenuOpen]);

  // Add files by their real location: the chip is ready INSTANTLY, like cowork.
  // Nothing is read or uploaded here; a local task works on the original file in
  // place, and a chat question reads it at send time under the thinking state.
  function addFiles(picked: PickedFile[]) {
    if (picked.length === 0) return;
    setAttachError("");
    setAttachments((current) => {
      const room = Math.max(0, 20 - current.length);
      const chips: Attachment[] = picked.slice(0, room).map((file) => ({
        id: localId(),
        filename: file.name,
        status: "ready",
        path: file.path,
        size: file.size
      }));
      return [...current, ...chips];
    });
  }

  // Add an image (or other) blob that has no file path, for example a screenshot
  // pasted from the clipboard. The bytes are read here and uploaded directly, so
  // it does not depend on reading the OS clipboard a second time.
  function addImageBlob(file: File) {
    const id = localId();
    setAttachError("");
    const filename = file.name || "Pasted image";
    setAttachments((current) => [...current, { id, filename, status: "uploading" }]);
    file.arrayBuffer()
      .then((bytes) => window.workcrew.attachments.uploadBytes(filename, file.type || "image/png", bytes))
      .then((ref) => {
        setAttachments((list) => list.map((item) =>
          item.id === id ? (ref ? { ...item, status: "ready", ref } : { ...item, status: "error" }) : item
        ));
        if (!ref) setAttachError("That image could not be pasted. Try copying it again.");
      })
      .catch((error) => {
        setAttachments((list) => list.map((item) => (item.id === id ? { ...item, status: "error" } : item)));
        setAttachError(friendlyFileError(error));
      });
  }

  // Handle paste (Ctrl+V or the right-click Paste menu). Files copied from the
  // file manager keep their path and are located locally; a pasted screenshot has
  // no path, so its bytes are read straight from the paste event. Plain text falls
  // through to the normal paste so typing and pasting text still work.
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (streaming || runner.running) return;
    const data = event.clipboardData;
    if (!data) return;
    const files = Array.from(data.files);
    if (files.length === 0) return;
    event.preventDefault();
    const picked: PickedFile[] = [];
    for (const file of files) {
      let path = "";
      try { path = window.workcrew.files.pathForFile(file); } catch { path = ""; }
      if (path) picked.push({ path, name: file.name, size: file.size });
      else addImageBlob(file);
    }
    // Route through the directory-aware handler so a pasted/copied folder becomes
    // the working folder instead of a failed file upload, exactly like a drop.
    if (picked.length) void handleDropped(picked);
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

  // Route each dropped path: a folder becomes the working folder, a file attaches
  // instantly. The kind check is a local stat, so the drop still feels immediate.
  async function handleDropped(picked: PickedFile[]) {
    const files: PickedFile[] = [];
    for (const item of picked) {
      let kind: "file" | "directory" | "missing" = "file";
      try { kind = await window.workcrew.files.pathKind(item.path); } catch { kind = "file"; }
      if (kind === "directory") onAddFolder?.({ path: item.path, name: item.name });
      else if (kind === "file") files.push(item);
    }
    addFiles(files);
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
    void handleDropped(picked);
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
    // Block while a chat is streaming, a pasted image is still uploading, or an
    // automation is running, so a message is never dropped against a busy engine.
    if ((!trimmed && readyRefs.length === 0 && readyFiles.length === 0) || streaming || uploading || runner.running) return;
    onSend(trimmed, readyRefs, readyFiles);
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

  const canSend = (draft.trim().length > 0 || readyRefs.length > 0 || readyFiles.length > 0) && !uploading && !runner.running;

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
        onPaste={onPaste}
        placeholder="Ask WorkCrew anything..."
        rows={hasConversation ? 1 : 3}
      />
      {attachError && <div className="attach-error-row">{attachError}</div>}
      {voiceNote && <div className="voice-note">{voiceNote}</div>}
      <div className="composer-tools">
        <div className="add-menu-wrap">
          <button
            className="tool-button"
            type="button"
            title="Add files or a folder"
            aria-label="Add files or a folder"
            aria-haspopup="menu"
            onClick={(event) => { event.stopPropagation(); setAddMenuOpen((open) => !open); }}
            disabled={streaming}
          >
            <PlusIcon />
          </button>
          {addMenuOpen && (
            <div className="add-menu" role="menu" onClick={(event) => event.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); void pickFiles(); }}>
                <span className="add-menu-icon"><PlusIcon /></span> Add photos or files
              </button>
              {onPickFolder && (
                <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onPickFolder(); }}>
                  <span className="add-menu-icon"><FolderIcon /></span> Add a folder to work in
                </button>
              )}
            </div>
          )}
        </div>
        {onRecord && (
          <button
            className="tool-button"
            type="button"
            title="Record clicks to make a fast automation"
            aria-label="Record clicks"
            onClick={onRecord}
            disabled={streaming}
          >
            <CursorIcon />
          </button>
        )}
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
        {streaming || (workingFolder && runner.running) ? (
          <button className="stop-button" type="button" onClick={streaming ? onStop : runner.stop}>Stop</button>
        ) : (
          <button className="run-button" type="button" onClick={() => submit(draft)} disabled={!canSend}>Send</button>
        )}
      </div>
      {dragging && <div className="drop-hint">Drop files or a folder</div>}
    </div>
  );

  // The working-folder pill sits BELOW the composer, detached from it, on the
  // page background (like Claude cowork), never inside the composer panel.
  const folderContext = workingFolder ? (() => {
    const folderName = workingFolder.name || workingFolder.path;
    const rawParent = workingFolder.path.length > folderName.length
      ? workingFolder.path.slice(0, workingFolder.path.length - folderName.length)
      : "";
    const folderParent = rawParent.length > 30 ? `…${rawParent.slice(rawParent.length - 30)}` : rawParent;
    return (
      <div className="composer-context">
        <div className="folder-pill" title={`Working in ${workingFolder.path}. Click to change.`}>
          <button type="button" className="folder-pill-main" onClick={onPickFolder} aria-label={`Working in ${workingFolder.path}. Change folder.`}>
            <span className="folder-pill-icon" aria-hidden="true"><FolderIcon /></span>
            <span className="folder-pill-loc">
              {folderParent && <span className="folder-pill-parent">{folderParent}</span>}
              <span className="folder-pill-name">{folderName}</span>
            </span>
            <svg className="folder-pill-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {onClearFolder && (
            <button type="button" className="folder-pill-remove" aria-label="Stop working in this folder" onClick={onClearFolder}>×</button>
          )}
        </div>
      </div>
    );
  })() : null;

  // The "Always allow" toggle sits just under the composer, on the left, like a
  // permissions switch. It is present in both the empty and active layouts.
  const aux = (
    <div className="composer-aux">
      <AlwaysAllowToggle checked={alwaysAllow} onChange={onAlwaysAllowChange} />
    </div>
  );

  if (!hasConversation) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-inner">
          <h1 className="greeting">{timeGreeting()}</h1>
          {composer}
          {folderContext}
          {aux}
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
      </div>
    );
  }

  return (
    <div className="chat-active">
      <div className="chat-scroll" ref={scrollRef}>
        <MessageList turns={turns} streaming={streaming} />
        {workingFolder ? (
          <FolderActivity runner={runner} />
        ) : (
          <AutomationActivity runner={runner} task={automationTask} onSaveRoutine={onSaveRoutine} onRerun={onRerun} />
        )}
      </div>
      <div className="composer-dock">{composer}{folderContext}{aux}</div>
    </div>
  );
}
