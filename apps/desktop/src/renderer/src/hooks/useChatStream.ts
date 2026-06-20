import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelTier } from "@workcrew/contracts";
import {
  DEFAULT_CHAT_EFFORT,
  localId,
  type ChatDeltaEnvelope,
  type ChatEffort,
  type ChatTurn
} from "../lib/chat";

// Parameters for sending one chat turn.
export type SendOptions = {
  text: string;
  model: ModelTier;
  conversationId?: string;
  effort?: ChatEffort;
  thinking?: boolean;
};

export type UseChatStream = {
  turns: ChatTurn[];
  streaming: boolean;
  conversationId: string | undefined;
  usedTokens: number | undefined;
  send: (options: SendOptions) => Promise<void>;
  stop: () => void;
  reset: (turns?: ChatTurn[], conversationId?: string) => void;
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
      if (!text || streaming) return;

      const assistantId = localId();
      const userTurn: ChatTurn = { id: localId(), role: "user", text };
      const assistantTurn: ChatTurn = { id: assistantId, role: "assistant", text: "", streaming: true };

      setTurns((current) => [...current, userTurn, assistantTurn]);
      setStreaming(true);
      activeTurnId.current = assistantId;

      try {
        const { requestId } = await window.workcrew.chat.send({
          text,
          model: options.model,
          conversationId: options.conversationId ?? conversationId,
          effort: options.effort ?? DEFAULT_CHAT_EFFORT,
          thinking: options.thinking ?? false
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

  return { turns, streaming, conversationId, usedTokens, send, stop, reset };
}
