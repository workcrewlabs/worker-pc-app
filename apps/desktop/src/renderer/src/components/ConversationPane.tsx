import { useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import type { ChatTurn, LocalFile } from "../lib/chat";
import { setConversationFolder, type PermissionState, type WorkingFolder } from "../lib/storage";
import { useChatStream } from "../hooks/useChatStream";
import { useAutomationRunner } from "../hooks/useAutomationRunner";
import { ChatView } from "./ChatView";
import { ApprovalModal } from "./ApprovalModal";
import { looksLikeAutomation, isQuestionLike, looksLikeFileRequest } from "../lib/routing";

// The status one pane reports up to the workspace so the sidebar can show a
// progress bar (running), a pause glyph (a backgrounded computer task), or a
// purple dot (finished in the background).
export type AutomationPhase = "idle" | "running" | "paused" | "complete" | "failed" | "stopped";
export type PaneStatus = {
  streaming: boolean;
  automation: AutomationPhase;
  busy: boolean;
  unread: boolean;
  conversationId?: string;
  hasConversation: boolean;
};

type Props = {
  paneKey: string;
  // Whether this pane is the one on screen. Only the active pane runs its
  // computer task; a chat stream keeps running in the background either way.
  active: boolean;
  model: ModelTier;
  onModelChange: (model: ModelTier) => void;
  alwaysAllow: boolean;
  onAlwaysAllowChange: (value: boolean) => void;
  permissions: PermissionState;
  // Seeds for a pane opened from a saved conversation, or a scheduled routine that
  // should start running as soon as the pane mounts.
  initialTurns?: ChatTurn[];
  initialConversationId?: string;
  initialAutomation?: { task: string; label: string };
  // The folder this saved conversation was working in, restored on reopen so it
  // keeps routing to the command engine and shows its pill.
  initialWorkingFolder?: WorkingFolder | null;
  composerSeed?: { text: string; nonce: number };
  onStatus: (key: string, status: PaneStatus) => void;
  onRefreshEntitlement: () => void;
  onSaveRoutine: (task: string) => void;
  onRecord: () => void;
};

export function ConversationPane({
  paneKey,
  active,
  model,
  onModelChange,
  alwaysAllow,
  onAlwaysAllowChange,
  permissions,
  initialTurns,
  initialConversationId,
  initialAutomation,
  initialWorkingFolder,
  composerSeed,
  onStatus,
  onRefreshEntitlement,
  onSaveRoutine,
  onRecord
}: Props) {
  const chat = useChatStream();
  const runner = useAutomationRunner();
  // Once a task has run in this pane, follow-ups that are not plain questions
  // re-run the task with the correction added, so the user can refine and re-run.
  const [automationTask, setAutomationTask] = useState("");
  const [automationMode, setAutomationMode] = useState(false);
  const [unread, setUnread] = useState(false);
  // The folder the user added to work in (absolute path + display name), kept for
  // the whole conversation so follow-ups keep operating in it.
  const [workingFolder, setWorkingFolder] = useState<{ path: string; name: string } | null>(null);
  const seeded = useRef(false);
  // Reserved synchronously the instant a folder run begins, so a second send during
  // the async preamble (the folder-tree read) cannot slip past the lagging
  // runner.running state and be silently dropped.
  const startingRef = useRef(false);

  async function pickFolder(): Promise<void> {
    try {
      const picked = await window.workcrew.files.pickFolder();
      if (picked) setWorkingFolder(picked);
    } catch {
      // Cancelled or unavailable: leave the current folder as is.
    }
  }

  // The context prepended to a task that runs inside a folder: the folder's path
  // and a shallow listing, so the model knows what it is working with and that it
  // should read, edit, and create files there. Questions are answered from the
  // folder too. The listing is clamped so the preamble plus the task can never
  // exceed the backend's task-length limit (which would reject the whole run).
  async function folderPreamble(folder: { path: string; name: string }, task: string): Promise<string> {
    let tree = "";
    try { tree = await window.workcrew.files.folderTree(folder.path); } catch { tree = ""; }
    const head =
      `You are working inside the user's own folder at:\n${folder.path}\n` +
      `This folder is the working directory; every run_command already runs inside it (do not cd to it). ` +
      `run_command executes in Windows cmd.exe, so use Windows commands: "type file" to read a file, "dir" to ` +
      `list, "findstr" to search. For anything richer (editing files, JSON/Excel, multi-line writes) call ` +
      `powershell -NoProfile -Command "..." (Get-Content, Set-Content), or node/python/git. Do NOT use unix ` +
      `commands like cat, ls, or grep; they fail in cmd.exe. Use run_command to read, edit, and create files and ` +
      `run build/test/git directly in the folder, editing existing files in place. ` +
      `Work with commands ONLY. You cannot see the screen or view files by opening them: opening a file, the ` +
      `folder, or a file:/// URL shows it to the user and returns nothing to you. NEVER open the folder or any ` +
      `file in Explorer, a browser, a photo viewer, or any app just to look at it; read contents with "type", ` +
      `"findstr", or a python/node one-liner, and describe images from their names and metadata since you cannot ` +
      `view them. Only open something on screen if the user explicitly asked for it to be opened. Never repeat ` +
      `an action that just failed. If the user asks a question about the folder or its files, run the fewest ` +
      `read-only commands needed (or none, if the listing below already answers it), then immediately call ` +
      `finish with the complete answer.`;
    // Keep the whole message (head + listing + "\n\nThe user's request:\n" + task)
    // comfortably under the 20k task cap; give the listing whatever room is left.
    const budget = 19_000 - head.length - task.length - 60;
    if (tree && budget > 200) {
      const clamped = tree.length > budget ? `${tree.slice(0, budget)}\n...(more files not shown)` : tree;
      return `${head}\n\nIt currently contains:\n${clamped}\n\nThe user's request:\n`;
    }
    return `${head}\n\nThe user's request:\n`;
  }

  // Run an automation inline in this pane (from a typed task or an example chip).
  // When a working folder is set, the task is prefixed with the folder context and
  // the folder path is passed through so shell commands run inside it.
  function runAutomation(task: string, label = "Task"): void {
    const trimmed = task.trim();
    const folder = workingFolder;
    // Folder mode routes every turn (including short replies like "ok") through the
    // engine, so only require a non-empty message there; otherwise require a real
    // task. The synchronous guards block a double-run.
    if (trimmed.length === 0 || (!folder && trimmed.length < 3) || runner.isBusy() || startingRef.current) return;
    startingRef.current = true;
    setAutomationTask(trimmed);
    setAutomationMode(true);
    if (folder) {
      void folderPreamble(folder, trimmed)
        .then((preamble) => runner.run(preamble + trimmed, model, label, folder.path))
        .finally(() => { startingRef.current = false; });
    } else {
      void runner.run(trimmed, model, label);
      startingRef.current = false;
    }
  }

  // Seed the transcript (opened conversation) or auto-start a scheduled routine,
  // exactly once when the pane mounts.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if ((initialTurns && initialTurns.length > 0) || initialConversationId) {
      chat.reset(initialTurns ?? [], initialConversationId);
    }
    if (initialWorkingFolder) setWorkingFolder(initialWorkingFolder);
    if (initialAutomation && initialAutomation.task.trim().length >= 3) {
      runAutomation(initialAutomation.task, initialAutomation.label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist this conversation's working folder so reopening it restores the folder
  // (and keeps routing to the command engine), once the conversation has an id.
  useEffect(() => {
    if (chat.conversationId) setConversationFolder(chat.conversationId, workingFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.conversationId, workingFolder]);

  // Keep this pane's runner in sync with the global settings.
  useEffect(() => { runner.setAutoApprove(alwaysAllow); /* eslint-disable-next-line */ }, [alwaysAllow]);
  useEffect(() => { runner.setPermissions(permissions); /* eslint-disable-next-line */ }, [permissions]);

  // A computer task cannot run in the background (it needs the real mouse and
  // screen), so pause it when this pane is not on screen and resume when it is.
  useEffect(() => {
    if (active) runner.resume();
    else runner.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Refresh the entitlement (rolling daily figure) when a chat turn or a run
  // finishes here, since it consumed budget.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !chat.streaming) onRefreshEntitlement();
    wasStreaming.current = chat.streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.streaming]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !runner.running) onRefreshEntitlement();
    wasRunning.current = runner.running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.running]);

  // `running` stays true while a computer task is paused (it is mid-task), so busy
  // covers streaming and both running and paused automations.
  const busy = chat.streaming || runner.running;

  // Mark the pane unread when a run finishes while it is in the background; clear
  // it as soon as the pane is opened.
  const prevBusy = useRef(false);
  useEffect(() => {
    if (prevBusy.current && !busy && !active) setUnread(true);
    prevBusy.current = busy;
  }, [busy, active]);
  useEffect(() => {
    if (active && unread) setUnread(false);
  }, [active, unread]);

  // Report status up whenever anything the sidebar cares about changes.
  const automationPhase: AutomationPhase = runner.paused
    ? "paused"
    : runner.running
    ? "running"
    : runner.status === "complete"
    ? "complete"
    : runner.status === "failed"
    ? "failed"
    : runner.status === "stopped"
    ? "stopped"
    : "idle";
  const hasConversation =
    chat.turns.length > 0 || runner.running || runner.steps.length > 0 || Boolean(runner.summary) || Boolean(runner.error);
  useEffect(() => {
    onStatus(paneKey, {
      streaming: chat.streaming,
      automation: automationPhase,
      busy,
      unread,
      conversationId: chat.conversationId,
      hasConversation
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.streaming, chat.conversationId, chat.turns.length, automationPhase, busy, unread, hasConversation]);

  function rerunAutomation(): void {
    if (automationTask.trim().length >= 3) runAutomation(automationTask, "Task");
  }

  function saveCurrentAsRoutine(): void {
    const lastUser = [...chat.turns].reverse().find((turn) => turn.role === "user");
    const task = (automationTask || lastUser?.text || "").trim();
    if (task.length >= 3) onSaveRoutine(task);
  }

  // Context injected into a chat turn when a working folder is set: the folder's
  // path and current listing. A plain question ("what do you see in this folder")
  // is then answered directly in chat, instantly, with no run panel and nothing
  // opening on screen, exactly like cowork. The model sees this context; the
  // transcript never shows or stores it.
  async function folderChatContext(folder: { path: string; name: string }): Promise<string> {
    let tree = "";
    try { tree = await window.workcrew.files.folderTree(folder.path); } catch { tree = ""; }
    const head =
      `App context (added by WorkCrew, not typed by the user): the user attached their own local folder to ` +
      `this conversation.\nFolder path: ${folder.path}\nIts current contents (names, types, sizes; not file ` +
      `contents):\n`;
    const tail = `\nAnswer questions about this folder and its files directly from this listing.`;
    const budget = 23_000 - head.length - tail.length;
    const clamped = tree.length > budget ? `${tree.slice(0, budget)}\n...(more files not shown)` : tree;
    return `${head}${clamped || "(the folder listing could not be read)"}${tail}`;
  }

  // Route a typed message. With a working folder set, this conversation is a
  // hands-on session in that folder (like cowork): a plain question is answered
  // directly in chat with the folder's listing injected as context (no run, no
  // panel, nothing opens on screen), and everything else goes to the engine that
  // works inside the folder. Otherwise: a file hand-off and questions stay in
  // chat; imperative "do this on my machine" phrasing runs as an automation; a
  // follow-up while iterating on a task re-runs it with the correction.
  function send(text: string, attachments: AttachmentRef[], files: LocalFile[] = []): void {
    const paths = files.map((f) => f.path);
    const fileList = paths.length > 0
      ? `\n\nThe user attached these files; work with them at their real locations on the computer: ${paths.map((p) => `"${p}"`).join(", ")}`
      : "";
    if (workingFolder && !runner.running) {
      if (isQuestionLike(text)) {
        const folder = workingFolder;
        runner.clear();
        setAutomationTask("");
        setAutomationMode(false);
        void folderChatContext(folder).then((context) => chat.send({ text, model, attachments, files, context }));
        return;
      }
      // The task shows as a normal user message in the transcript (the work
      // itself renders quietly underneath), like cowork.
      chat.appendUserTurn(text);
      runAutomation(`${text}${fileList}`, "Task");
      return;
    }
    const fileRequest = looksLikeFileRequest(text);
    if (!runner.running && !fileRequest) {
      if (paths.length > 0 && looksLikeAutomation(text)) {
        runAutomation(`${text}${fileList}`, "Task");
        return;
      }
      if (attachments.length === 0 && files.length === 0) {
        if (automationMode && !isQuestionLike(text)) {
          const combined = `${automationTask}\n\nThe last attempt was not right. Correction from the user: ${text}\nPlease do the whole task again with this fix.`;
          runAutomation(combined, "Task");
          return;
        }
        if (!automationMode && looksLikeAutomation(text)) {
          runAutomation(text, "Task");
          return;
        }
      }
    }
    if (!runner.running) {
      runner.clear();
      setAutomationTask("");
      setAutomationMode(false);
    }
    // Chat path: local files are registered at send time inside the stream hook,
    // under the thinking state, so attaching never blocks on an upload.
    void chat.send({ text, model, attachments, files });
  }

  return (
    <>
      <ChatView
        turns={chat.turns}
        streaming={chat.streaming}
        model={model}
        onModelChange={onModelChange}
        onSend={send}
        onStop={chat.stop}
        onAutomate={(task) => runAutomation(task, "Task")}
        onRecord={active ? onRecord : undefined}
        runner={runner}
        automationTask={automationTask}
        alwaysAllow={alwaysAllow}
        onAlwaysAllowChange={onAlwaysAllowChange}
        onSaveRoutine={saveCurrentAsRoutine}
        onRerun={rerunAutomation}
        composerSeed={active ? composerSeed : undefined}
        workingFolder={workingFolder}
        onPickFolder={() => void pickFolder()}
        onClearFolder={() => setWorkingFolder(null)}
        onAddFolder={(folder) => setWorkingFolder(folder)}
      />
      {active && runner.pending && (
        <ApprovalModal
          action={runner.pending.action}
          label={runner.pending.label}
          onDecide={runner.decide}
          onAllowAlways={() => {
            onAlwaysAllowChange(true);
            runner.setAutoApprove(true);
            runner.decide(true);
          }}
        />
      )}
    </>
  );
}
