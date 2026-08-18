// Shared chat types and helpers for the renderer. The transcript is held in
// React state as a flat list of turns. Each assistant turn collects streamed
// text and an optional thinking summary as deltas arrive.

import type { AttachmentKind, ChatDeltaFrame, Message, ModelTier } from "@workcrew/contracts";

export type ChatRole = "user" | "assistant";

// A file shown as a chip on a user turn. Only the display fields are kept here;
// the full reference lives on the send payload.
export type TurnAttachment = { filename: string; kind: AttachmentKind };

// A file attached by its real location on the computer (picked, dragged, or a
// pasted copied file). Attaching is instant: nothing is read or uploaded until
// the message is sent, and a local task never uploads it at all.
export type LocalFile = { path: string; name: string; size: number };

// Guess the display kind of a local file from its name, for the turn chip.
export function kindForFilename(name: string): AttachmentKind {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "text";
}

// One finished piece of work from a run (a command, a file read, a file
// written), kept on the turn it belongs to. Structurally the same as the
// runner's RunStep, deliberately declared here so the transcript owns its own
// shape and does not depend on the live runner.
export type TurnActivity = { id: string; label: string; status: string; detail?: string };

/**
 * A finished run, kept whole in the transcript.
 *
 * A computer task is not a message, it is a piece of work with a result and
 * buttons that act on it. Held only as live state it was erased the moment the
 * next run started, so the card the user wanted to press Run again on vanished
 * and nothing was left of what had been done before. Kept as a turn, each run
 * stays exactly where it happened and they stack up like messages do.
 */
export type TurnRun = {
  task: string;
  status: "complete" | "failed" | "stopped" | "idle" | "running";
  summary: string;
  error?: string;
  steps: TurnActivity[];
};

export type ChatTurn = {
  // A local id, stable for the lifetime of the turn in the transcript.
  id: string;
  role: ChatRole;
  text: string;
  // Files attached to this (user) turn, shown as chips above the bubble.
  attachments?: TurnAttachment[];
  // Streamed thinking summary, shown above the answer while present.
  thinking?: string;
  // The work this turn did, moved here when the run finished. Left in runner
  // state it was a live view pinned under the newest message, so it drifted
  // away from the request that caused it; on the turn it stays where it
  // happened, however many messages follow.
  activity?: TurnActivity[];
  // A whole finished run, rendered as its card rather than as text.
  run?: TurnRun;
  // True while the assistant turn is actively receiving deltas.
  streaming?: boolean;
  // Set when this turn could not complete.
  error?: string;
};

/**
 * The transcript entry a finished run leaves behind, or null when it left
 * nothing at all.
 *
 * A run is not just its words. The work it did belongs to the request that
 * caused it, so a run that answered nothing (interrupted, or one that only
 * edited files) still becomes a turn and still holds its place in the
 * conversation. Only a run with no answer, no work, and no failure is dropped.
 */
export function turnFromRun(text: string, activity?: TurnActivity[], error?: string): ChatTurn | null {
  const trimmed = text.trim();
  const work = activity && activity.length > 0 ? activity : undefined;
  if (!trimmed && !work && !error) return null;
  return {
    id: localId(),
    role: "assistant",
    text: trimmed,
    ...(work ? { activity: work } : {}),
    ...(error ? { error } : {})
  };
}

/**
 * The conversation so far, compacted for a run to read.
 *
 * A run used to be handed the task text and nothing else, so a follow-up that
 * leans on what came before ("give me them", "do it now", "the second one") had
 * no referent at all, and WorkCrew answered that it had no earlier context in
 * the middle of a conversation the user could see on screen. Chat never had this
 * problem: its history lives on the server under the conversation id, while a
 * run starts from nothing every time.
 *
 * Newest turns win the space. Each is clipped so one long answer cannot crowd
 * out the exchange around it, and the whole block is bounded because it shares
 * the run's request budget with the folder listing.
 */
export function conversationDigest(turns: ChatTurn[], budget = 3_500, perTurn = 700): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const text = turn?.text.trim();
    if (!turn || !text) continue;
    const clipped = text.length > perTurn ? `${text.slice(0, perTurn)}...` : text;
    const line = `${turn.role === "user" ? "User" : "WorkCrew"}: ${clipped}`;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The transcript entry a finished computer task leaves behind, or null when the
 * run did nothing worth keeping.
 *
 * A run with no steps and no words is one that never started (a duplicate send,
 * a task too short to run); recording it would litter the chat with empty cards.
 */
export function turnFromCompletedRun(run: TurnRun): ChatTurn | null {
  const worthKeeping = run.steps.length > 0 || run.summary.trim().length > 0 || Boolean(run.error);
  if (!worthKeeping) return null;
  return { id: localId(), role: "assistant", text: "", run };
}

// A short local id for transcript turns. Distinct from the server message id.
export function localId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Effort levels map to the model output effort. The chat surface uses a single
// default effort; the user only ever picks the effort model name (the tier).
export type ChatEffort = "low" | "medium" | "high" | "max";

// The default effort sent with every chat turn. The selector in the composer
// chooses the model tier; effort stays at the spec default for chat.
export const DEFAULT_CHAT_EFFORT: ChatEffort = "high";

// Reduce a stored content block array (from a reloaded conversation) into the
// plain text the renderer displays. Thinking and tool blocks are summarized so
// reload preserves a readable transcript without leaking internal block shapes.
export function textFromContent(content: unknown[]): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as { type?: string; text?: string; thinking?: string };
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
  }
  return { text, thinking };
}

// Pull attachment chips out of a stored content block array. The backend stores
// each attached file as an "attachment_ref" block carrying its metadata.
export function attachmentsFromContent(content: unknown[]): TurnAttachment[] {
  const out: TurnAttachment[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as { type?: string; attachment?: { filename?: string; kind?: AttachmentKind } };
    if (block.type === "attachment_ref" && block.attachment?.filename) {
      out.push({ filename: block.attachment.filename, kind: block.attachment.kind ?? "text" });
    }
  }
  return out;
}

// Build the renderer transcript from a reloaded conversation's messages.
export function turnsFromMessages(messages: Message[]): ChatTurn[] {
  return messages.map((message) => {
    const { text, thinking } = textFromContent(message.contentJson);
    const attachments = attachmentsFromContent(message.contentJson);
    return {
      id: message.id,
      role: message.role,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      thinking: thinking || undefined
    } satisfies ChatTurn;
  });
}

// A delta envelope as delivered by the preload chat.onDelta subscription.
export type ChatDeltaEnvelope = { requestId: string; frame: ChatDeltaFrame };

// The fixed default chat model tier. Spec default for chat is the medium effort
// tier; the user can switch in the composer.
export const DEFAULT_CHAT_MODEL: ModelTier = "sonnet";
