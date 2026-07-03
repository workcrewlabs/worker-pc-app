import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  client,
  createConversation,
  initializeDatabase,
  listConversations,
  renameConversation,
  setConversationPinned
} from "./db.js";

describe("conversation rename and pin", () => {
  beforeAll(async () => {
    await initializeDatabase(client);
  });

  async function makeUser(): Promise<string> {
    const userId = randomUUID();
    await client.execute({
      sql: "INSERT INTO users(id, email, email_verified, password_hash, password_salt, created_at_ms) VALUES (?, ?, 0, 'h', 's', ?)",
      args: [userId, `${userId}@example.com`, Date.now()]
    });
    return userId;
  }

  it("renames a conversation the owner owns, and rejects a non-owner", async () => {
    const userId = await makeUser();
    const other = await makeUser();
    const conversation = await createConversation({ id: randomUUID(), userId, title: "old title", model: "haiku" });

    expect(await renameConversation(conversation.id, userId, "new title")).toBe(true);
    const owned = await listConversations(userId);
    expect(owned.find((c) => c.id === conversation.id)?.title).toBe("new title");

    // Another user cannot rename it (scoped by user_id), and nothing changes.
    expect(await renameConversation(conversation.id, other, "hacked")).toBe(false);
    const stillOwned = await listConversations(userId);
    expect(stillOwned.find((c) => c.id === conversation.id)?.title).toBe("new title");
  });

  it("lists pinned conversations first, most recently pinned on top", async () => {
    const userId = await makeUser();
    const a = await createConversation({ id: randomUUID(), userId, title: "A", model: "haiku" });
    const b = await createConversation({ id: randomUUID(), userId, title: "B", model: "haiku" });
    const c = await createConversation({ id: randomUUID(), userId, title: "C", model: "haiku" });

    // Pin A, then (a moment later) C, so C sorts above A. B stays unpinned.
    expect(await setConversationPinned(a.id, userId, true)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(await setConversationPinned(c.id, userId, true)).toBe(true);

    const list = await listConversations(userId);
    // Pinned block first (C above A), then the unpinned B.
    expect(list.map((x) => x.title)).toEqual(["C", "A", "B"]);
    expect(list[0].pinnedAtMs).not.toBeNull();
    expect(list.find((x) => x.title === "B")?.pinnedAtMs).toBeNull();

    // Unpinning drops it back out of the pinned block.
    expect(await setConversationPinned(c.id, userId, false)).toBe(true);
    const after = await listConversations(userId);
    expect(after[0].title).toBe("A"); // the only remaining pinned one
    expect(after.find((x) => x.title === "C")?.pinnedAtMs).toBeNull();
    void b;
  });
});
