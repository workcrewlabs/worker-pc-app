// Shared chat types and helpers for the renderer. The transcript is held in
// React state as a flat list of turns. Each assistant turn collects streamed
// text and an optional thinking summary as deltas arrive.

import type { AttachmentKind, ChatDeltaFrame, Message, ModelTier } from "@workcrew/contracts";

export type ChatRole = "user" | "assistant";

// A file shown as a chip on a user turn. Only the display fields are kept here;
// the full reference lives on the send payload.
export type TurnAttachment = { filename: string; kind: AttachmentKind };

export type ChatTurn = {
  // A local id, stable for the lifetime of the turn in the transcript.
  id: string;
  role: ChatRole;
  text: string;
  // Files attached to this (user) turn, shown as chips above the bubble.
  attachments?: TurnAttachment[];
  // Streamed thinking summary, shown above the answer while present.
  thinking?: string;
  // True while the assistant turn is actively receiving deltas.
  streaming?: boolean;
  // Set when this turn could not complete.
  error?: string;
};

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
