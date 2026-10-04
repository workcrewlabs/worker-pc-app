import { beforeAll, describe, expect, it } from "vitest";
import { client, initializeDatabase } from "./db.js";
import {
  botCostMicrodollars,
  botForToken,
  botUsageSummary,
  createBot,
  initializeBotUsage,
  monthStartMs,
  recordBotUsage,
  setBotActive
} from "./bot-usage.js";

// What each WhatsApp chatbot costs its owner. These bots are not WorkCrew
// accounts and the providers bill every one of them on a single key, so the
// only way to tell one customer's spend from another is the bots reporting it
// themselves. That makes two things load bearing: the price must be worked out
// here rather than taken from the report, and a retrying workflow must not be
// counted twice.

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await initializeDatabase(client);
  await initializeBotUsage(client);
});

describe("what a chatbot costs to run", () => {
  it("prices tokens from the shared table, not from anything the bot claims", async () => {
    // GLM Flash is 0.15 in and 0.5 out per million, held as microdollars per
    // token. A bot sends counts only; there is no field for it to assert a cost.
    expect(botCostMicrodollars("glm-flash", 1_000_000, 0)).toBe(150_000);
    expect(botCostMicrodollars("glm-flash", 0, 1_000_000)).toBe(500_000);
    expect(botCostMicrodollars("glm", 1_000, 1_000)).toBe(Math.round(1_000 * 1.4 + 1_000 * 4.4));
  });

  it("adds a bot, resolves it by its reporting code, and never stores that code", async () => {
    const { bot, token } = await createBot("Cedar Tax bot", "Cedar Tax Consulting");
    expect(await botForToken(token)).toMatchObject({ id: bot.id, name: "Cedar Tax bot" });
    expect(await botForToken("not-the-code")).toBeNull();
    expect(await botForToken("")).toBeNull();
    // Only the hash is kept, so the code cannot be read back out of the row.
    const stored = await client.execute({ sql: "SELECT token_sha256 FROM bots WHERE id = ?", args: [bot.id] });
    expect(String(stored.rows[0]?.token_sha256)).not.toContain(token);
  });

  it("stops accepting reports once a bot is turned off, keeping its history", async () => {
    const { bot, token } = await createBot("Retired bot", "Someone");
    await recordBotUsage({ botId: bot.id, model: "glm", inputTokens: 100, outputTokens: 100 });
    expect(await setBotActive(bot.id, false)).toBe(true);
    // Turning a bot off is not deleting it: the token stops working, and what
    // it already spent is still on the books.
    expect(await botForToken(token)).toBeNull();
    const rows = await botUsageSummary();
    const mine = rows.find((row) => row.id === bot.id);
    expect(mine?.active).toBe(false);
    expect(mine?.totalMicrodollars).toBeGreaterThan(0);
  });

  it("counts a repeated report once, so a retrying workflow cannot inflate a bill", async () => {
    const { bot } = await createBot("Retry bot", "Someone");
    const once = { botId: bot.id, model: "glm" as const, inputTokens: 1_000, outputTokens: 1_000, dedupeId: `msg-${bot.id}` };
    await recordBotUsage(once);
    await recordBotUsage(once);
    await recordBotUsage(once);
    const mine = (await botUsageSummary()).find((row) => row.id === bot.id);
    expect(mine?.monthMessages).toBe(1);
    expect(mine?.monthMicrodollars).toBe(botCostMicrodollars("glm", 1_000, 1_000));
  });

  it("still records reports that carry no dedupe id", async () => {
    // Several nulls must coexist under the unique index, or a workflow that
    // sends no id would only ever record its first call.
    const { bot } = await createBot("No id bot", "Someone");
    await recordBotUsage({ botId: bot.id, model: "glm-flash", inputTokens: 10, outputTokens: 10 });
    await recordBotUsage({ botId: bot.id, model: "glm-flash", inputTokens: 10, outputTokens: 10 });
    const mine = (await botUsageSummary()).find((row) => row.id === bot.id);
    expect(mine?.monthMessages).toBe(2);
  });

  it("counts this calendar month only, while all time keeps the rest", async () => {
    const { bot } = await createBot("Monthly bot", "Someone");
    const now = Date.now();
    // Well inside the previous month, whichever month it is today.
    const lastMonth = monthStartMs(now) - 5 * DAY_MS;
    await recordBotUsage({ botId: bot.id, model: "glm", inputTokens: 1_000, outputTokens: 0 }, lastMonth);
    await recordBotUsage({ botId: bot.id, model: "glm", inputTokens: 2_000, outputTokens: 0 }, now);
    const mine = (await botUsageSummary(now)).find((row) => row.id === bot.id);
    expect(mine?.monthInputTokens).toBe(2_000);
    expect(mine?.totalMicrodollars).toBe(botCostMicrodollars("glm", 3_000, 0));
  });

  it("keeps each bot's spend separate, which is the whole point", async () => {
    const mine = await createBot("My own bot", "");
    const theirs = await createBot("A customer bot", "Abed");
    await recordBotUsage({ botId: mine.bot.id, model: "glm", inputTokens: 5_000, outputTokens: 0 });
    await recordBotUsage({ botId: theirs.bot.id, model: "glm", inputTokens: 1_000, outputTokens: 0 });
    const rows = await botUsageSummary();
    const a = rows.find((row) => row.id === mine.bot.id);
    const b = rows.find((row) => row.id === theirs.bot.id);
    expect(a?.monthMicrodollars).toBe(botCostMicrodollars("glm", 5_000, 0));
    expect(b?.monthMicrodollars).toBe(botCostMicrodollars("glm", 1_000, 0));
    expect(b?.customer).toBe("Abed");
  });

  it("shows a newly added bot with zeros rather than hiding it", async () => {
    const { bot } = await createBot("Brand new bot", "Nobody yet");
    const mine = (await botUsageSummary()).find((row) => row.id === bot.id);
    expect(mine).toBeTruthy();
    expect(mine?.monthMicrodollars).toBe(0);
    expect(mine?.lastSeenMs).toBeNull();
  });
});
