import { randomUUID } from "node:crypto";
import type { ModelTier } from "@workcrew/contracts";
import { runTitle } from "./anthropic.js";
import { createConversation, getConversation } from "./db.js";

/**
 * Which chat a run should be recorded in.
 *
 * Every run used to make a new conversation. That is right the first time, and
 * wrong every time after: folder work sends EVERY turn through a run, including
 * a one word reply, so a chat where somebody asked four things in a row appeared
 * in Recents four times under near enough the same title.
 *
 * So a run that names the chat it belongs to is filed there instead. The id is
 * checked against the VERIFIED user before it is used: getConversation is scoped
 * by user_id, so an id belonging to another account simply finds nothing and a
 * new chat is made, exactly as if none had been sent. A client cannot use this
 * field to write into somebody else's chat, and cannot learn whether an id
 * exists, because both cases behave identically.
 */
export async function conversationForRun(input: {
  userId: string;
  task: string;
  model: ModelTier;
  /** The chat the client says this run continues. Untrusted. */
  requestedId?: string;
}): Promise<string> {
  if (input.requestedId) {
    const existing = await getConversation(input.requestedId, input.userId);
    if (existing) return existing.id;
  }
  const created = await createConversation({
    id: randomUUID(),
    userId: input.userId,
    title: runTitle(input.task),
    model: input.model
  });
  return created.id;
}
