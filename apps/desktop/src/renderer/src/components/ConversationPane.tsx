import { useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import type { ChatTurn } from "../lib/chat";
import type { PermissionState } from "../lib/storage";
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
  const seeded = useRef(false);

  // Run an automation inline in this pane (from a typed task or an example chip).
  function runAutomation(task: string, label = "Task"): void {
    const trimmed = task.trim();
    if (trimmed.length < 3 || runner.isBusy()) return;
    setAutomationTask(trimmed);
    setAutomationMode(true);
    void runner.run(trimmed, model, label);
  }

  // Seed the transcript (opened conversation) or auto-start a scheduled routine,
  // exactly once when the pane mounts.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if ((initialTurns && initialTurns.length > 0) || initialConversationId) {
      chat.reset(initialTurns ?? [], initialConversationId);
    }
    if (initialAutomation && initialAutomation.task.trim().length >= 3) {
      runAutomation(initialAutomation.task, initialAutomation.label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Route a typed message: a file hand-off and questions stay in chat; imperative
  // "do this on my machine" phrasing runs as an automation; a follow-up while
  // iterating on a task re-runs it with the correction. Mirrors the old shell.
  function send(text: string, attachments: AttachmentRef[], localPaths: string[] = []): void {
    const fileRequest = looksLikeFileRequest(text);
    if (!runner.running && !fileRequest) {
      if (localPaths.length > 0 && looksLikeAutomation(text)) {
        const list = localPaths.map((path) => `"${path}"`).join(", ");
        runAutomation(`${text}\n\nWork on these local files directly on the computer: ${list}`, "Task");
        return;
      }
      if (attachments.length === 0) {
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
    void chat.send({ text, model, attachments });
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
