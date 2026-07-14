import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRef, ModelTier } from "@workcrew/contracts";
import {
  DEFAULT_CHAT_EFFORT,
  kindForFilename,
  localId,
  type ChatDeltaEnvelope,
  type ChatEffort,
  type ChatTurn,
  type LocalFile
} from "../lib/chat";

// Parameters for sending one chat turn.
export type SendOptions = {
  text: string;
  model: ModelTier;
  conversationId?: string;
  effort?: ChatEffort;
  thinking?: boolean;
  // Files already uploaded and ready to attach to this turn.
  attachments?: AttachmentRef[];
  // Files attached by their real location. They are read locally and registered
  // at send time, under the turn's thinking state, so attaching is instant and
  // the user never waits on an upload spinner.
  files?: LocalFile[];
  // App-provided context for this turn (for example the working folder's path
  // and current listing). The model sees it; the transcript never shows it.
  context?: string;
};

export type UseChatStream = {
  turns: ChatTurn[];
  streaming: boolean;
  conversationId: string | undefined;
  usedTokens: number | undefined;
  send: (options: SendOptions) => Promise<void>;
  stop: () => void;
  reset: (turns?: ChatTurn[], conversationId?: string) => void;
  // Show a user message in the transcript without sending it to the chat
  // backend. Used when the message is handed to the folder work engine instead,
  // so the conversation still reads user ask then quiet work then answer.
  appendUserTurn: (text: string) => void;
};

// Drives a streamed chat conversation. It appends a user turn and an empty
// assistant turn, then folds incoming text and thinking deltas into the
// assistant turn until a done frame resolves the turn (capturing the
// conversationId and usage) or an error frame surfaces a failure.
export function useChatStream(): UseChatStream {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [usedTokens, setUsedTokens] = useState<number | undefined>(undefined);

  // The request id of the in-flight stream, and the local id of the assistant
  // turn currently receiving deltas. Held in refs so the delta subscription
  // (registered once) always sees the latest values.
  const activeRequestId = useRef<string | null>(null);
  const activeTurnId = useRef<string | null>(null);

  // Subscribe to streamed frames once. Every frame is matched against the
  // active request id; frames for any other request are ignored.
  useEffect(() => {
    const unsubscribe = window.workcrew.chat.onDelta(({ requestId, frame }: ChatDeltaEnvelope) => {
      if (requestId !== activeRequestId.current) return;
      const turnId = activeTurnId.current;
      if (!turnId) return;

      if (frame.type === "text") {
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, text: turn.text + frame.text } : turn))
        );
        return;
      }
      if (frame.type === "thinking") {
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, thinking: (turn.thinking ?? "") + frame.text } : turn))
        );
        return;
      }
      if (frame.type === "done") {
        setConversationId(frame.conversationId);
        setUsedTokens(frame.usage.usedMicrodollars);
        setTurns((current) => current.map((turn) => (turn.id === turnId ? { ...turn, streaming: false } : turn)));
        setStreaming(false);
        activeRequestId.current = null;
        activeTurnId.current = null;
        return;
      }
      if (frame.type === "error") {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId ? { ...turn, streaming: false, error: frame.message } : turn
          )
        );
        setStreaming(false);
        activeRequestId.current = null;
        activeTurnId.current = null;
      }
      // Citation frames carry source metadata that the chat surface does not yet
      // render; they are intentionally ignored here.
    });
    return unsubscribe;
  }, []);

  const send = useCallback(
    async (options: SendOptions) => {
      const text = options.text.trim();
      const attachments = options.attachments ?? [];
      const files = options.files ?? [];
      // Allow a turn with attachments but no text (an image or document on its
      // own), and block re-entry while a stream is in flight.
      if ((!text && attachments.length === 0 && files.length === 0) || streaming) return;

      const assistantId = localId();
      const chips = [
        ...attachments.map((a) => ({ filename: a.filename, kind: a.kind })),
        ...files.map((f) => ({ filename: f.name, kind: kindForFilename(f.name) }))
      ];
      const userTurn: ChatTurn = {
        id: localId(),
        role: "user",
        text,
        attachments: chips.length > 0 ? chips : undefined
      };
      const assistantTurn: ChatTurn = { id: assistantId, role: "assistant", text: "", streaming: true };

      setTurns((current) => [...current, userTurn, assistantTurn]);
      setStreaming(true);
      activeTurnId.current = assistantId;

      try {
        // Local-path files are read and registered now, while the turn already
        // shows as thinking, so the composer never blocks on an upload. Documents
        // reduce to their text locally; only images send bytes.
        let allRefs = attachments;
        if (files.length > 0) {
          const uploaded = await window.workcrew.attachments.upload(files);
          allRefs = [...attachments, ...uploaded.filter(Boolean)];
        }
        const { requestId } = await window.workcrew.chat.send({
          text,
          model: options.model,
          conversationId: options.conversationId ?? conversationId,
          effort: options.effort ?? DEFAULT_CHAT_EFFORT,
          thinking: options.thinking ?? false,
          attachments: allRefs,
          ...(options.context ? { context: options.context } : {})
        });
        activeRequestId.current = requestId;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The message could not be sent";
        setTurns((current) =>
          current.map((turn) => (turn.id === assistantId ? { ...turn, streaming: false, error: message } : turn))
        );
        setStreaming(false);
        activeTurnId.current = null;
      }
    },
    [streaming, conversationId]
  );

  const stop = useCallback(() => {
    const requestId = activeRequestId.current;
    if (requestId) void window.workcrew.chat.stop(requestId);
    const turnId = activeTurnId.current;
    if (turnId) {
      setTurns((current) => current.map((turn) => (turn.id === turnId ? { ...turn, streaming: false } : turn)));
    }
    setStreaming(false);
    activeRequestId.current = null;
    activeTurnId.current = null;
  }, []);

  const appendUserTurn = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setTurns((current) => [...current, { id: localId(), role: "user", text: trimmed }]);
  }, []);

  // Replace the transcript, for starting a new chat or loading a saved one.
  const reset = useCallback((nextTurns: ChatTurn[] = [], nextConversationId?: string) => {
    const requestId = activeRequestId.current;
    if (requestId) void window.workcrew.chat.stop(requestId);
    activeRequestId.current = null;
    activeTurnId.current = null;
    setTurns(nextTurns);
    setConversationId(nextConversationId);
    setStreaming(false);
  }, []);

  return { turns, streaming, conversationId, usedTokens, send, stop, reset, appendUserTurn };
}
