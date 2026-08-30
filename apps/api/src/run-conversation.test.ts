import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { conversationForRun } from "./run-conversation.js";
import { createPasswordCredential } from "./auth-local.js";
import { client, createConversation, createUser, getConversation, initializeDatabase, listConversations } from "./db.js";

// Every run made its own chat. Right the first time, wrong every time after:
// folder work sends EVERY turn through a run, so a chat where somebody asked
// four things in a row appeared in Recents four times under nearly the same
// title. The owner sent a screenshot of three copies of one spreadsheet task.

async function makeUser(): Promise<string> {
  const userId = randomUUID();
  const { passwordHash, passwordSalt } = await createPasswordCredential("a-long-enough-password");
  await createUser({
    id: userId,
    email: `runs-${userId}@example.com`,
    passwordHash,
    passwordSalt,
    emailVerified: true
  });
  return userId;
}

describe("which chat a run is recorded in", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  it("opens a chat when the run does not name one", () => {
    return (async () => {
      const userId = await makeUser();
      const id = await conversationForRun({ userId, task: "open youtube", model: "auto" });
      const conversation = await getConversation(id, userId);
      expect(conversation?.title).toBe("open youtube");
    })();
  });

  it("files a follow-up in the chat it continues, instead of opening another", async () => {
    const userId = await makeUser();
    const first = await conversationForRun({ userId, task: "edit this excel file", model: "auto" });
    const second = await conversationForRun({ userId, task: "now add the names", model: "auto", requestedId: first });
    const third = await conversationForRun({ userId, task: "ok", model: "auto", requestedId: first });

    expect(second).toBe(first);
    expect(third).toBe(first);
    // The whole point: one row in Recents, not three.
    expect(await listConversations(userId)).toHaveLength(1);
  });

  it("ignores a chat belonging to someone else and opens a fresh one", async () => {
    // The id arrives from the client, so it is not evidence of anything. Being
    // signed in is not enough; this has to be THEIR chat.
    const owner = await makeUser();
    const stranger = await makeUser();
    const theirs = await createConversation({ id: randomUUID(), userId: owner, title: "private", model: "auto" });

    const id = await conversationForRun({ userId: stranger, task: "read it out", model: "auto", requestedId: theirs.id });

    expect(id).not.toBe(theirs.id);
    // Nothing of the owner's was touched, and the stranger got their own chat.
    expect(await getConversation(id, stranger)).not.toBeNull();
    expect(await getConversation(theirs.id, stranger)).toBeNull();
    expect((await getConversation(theirs.id, owner))?.title).toBe("private");
  });

  it("opens a fresh chat for an id that does not exist at all", async () => {
    // Behaves exactly like the stranger's id above, so a client cannot tell a
    // chat that exists from one that does not.
    const userId = await makeUser();
    const id = await conversationForRun({ userId, task: "start over", model: "auto", requestedId: randomUUID() });
    expect(await getConversation(id, userId)).not.toBeNull();
  });
});
