import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COMMAND_LIMITS, cancelRunningCommands, confinePath, looksLikeTruncatedWrite, runShellCommand } from "./shell-cli";

// confinePath is the safety boundary for write_file: a path is allowed only if
// it resolves to a location strictly inside the working folder. These cases pin
// the escape attempts (parent traversal, absolute paths, sneaky prefixes) so a
// future refactor cannot silently open a hole.

const base = resolve("C:/work/project");

describe("confinePath", () => {
  it("allows a simple file in the folder", () => {
    expect(confinePath(base, "notes.txt")).toBe(resolve(base, "notes.txt"));
  });

  it("allows a nested path in a subfolder", () => {
    expect(confinePath(base, "src/lib/util.js")).toBe(resolve(base, "src/lib/util.js"));
  });

  it("allows a path that internally traverses but stays inside", () => {
    expect(confinePath(base, "src/../notes.txt")).toBe(resolve(base, "notes.txt"));
  });

  it("rejects parent traversal that escapes the folder", () => {
    expect(confinePath(base, "../secret.txt")).toBeNull();
    expect(confinePath(base, "../../Windows/System32/evil.dll")).toBeNull();
    expect(confinePath(base, "src/../../outside.txt")).toBeNull();
  });

  it("rejects an absolute path pointing elsewhere", () => {
    expect(confinePath(base, "C:/Windows/System32/drivers/etc/hosts")).toBeNull();
    expect(confinePath(base, "/etc/passwd")).toBeNull();
  });

  it("rejects the base directory itself (a file must be strictly inside)", () => {
    expect(confinePath(base, ".")).toBeNull();
  });

  it("rejects a sibling folder that merely shares the name prefix", () => {
    // C:/work/project-evil starts with "C:/work/project" as a string but is NOT
    // inside it; the trailing separator check must catch this.
    const sibling = confinePath(resolve("C:/work/project"), "../project-evil/x.txt");
    expect(sibling).toBeNull();
  });
});

// Building an installer and uploading it take an hour between them. Under the old
// flat time limit that work was killed halfway through, which is why the limit is
// now silence: a command that is still printing is still working.

describe("how long a command is allowed to take", () => {
  // Real child processes, so these run against a real folder and real clocks. The
  // limits are passed in tiny to keep the suite fast; the behaviour under test is
  // the policy, not the numbers.
  let dir = "";

  async function withFolder<T>(body: (folder: string) => Promise<T>): Promise<T> {
    dir = await mkdtemp(join(tmpdir(), "workcrew-shell-"));
    try {
      return await body(dir);
    } finally {
      // A killed process holds its working directory open for a moment longer on
      // Windows, so removing a temp folder is best effort. The operating system
      // clears it later; failing the test over it would report a fault that is
      // not in the code under test.
      try { await rm(dir, { recursive: true, force: true }); } catch { /* released later */ }
    }
  }

  // A command that keeps printing while it works, and one that goes quiet. On
  // Windows, ping is the reliable way to wait without a console.
  const chatty = process.platform === "win32"
    ? 'for /l %i in (1,1,6) do @(echo working & ping -n 2 127.0.0.1 >nul)'
    : "for i in 1 2 3 4 5 6; do echo working; sleep 1; done";
  const silent = process.platform === "win32" ? "ping -n 12 127.0.0.1 >nul" : "sleep 12";

  it("lets a slow command finish while it is still producing output", async () => {
    const output = await withFolder((folder) =>
      // Idle limit far shorter than the command's total runtime: it survives only
      // because each line of output resets the clock. This is the case that used
      // to fail.
      runShellCommand(chatty, folder, { idleMs: 3_000, totalMs: 60_000 }));
    expect(output).toContain("working");
    expect(output).toContain("Exit code 0");
    expect(output).not.toContain("stopped");
  }, 40_000);

  it("stops a command that has gone silent, and says so", async () => {
    const output = await withFolder((folder) =>
      runShellCommand(silent, folder, { idleMs: 1_500, totalMs: 60_000 }));
    expect(output).toContain("stopped producing any output");
  }, 40_000);

  it("stops a command that never ends, however talkative it is", async () => {
    const output = await withFolder((folder) =>
      runShellCommand(chatty, folder, { idleMs: 30_000, totalMs: 2_000 }));
    expect(output).toContain("ran for");
    expect(output).toContain("stopped");
  }, 40_000);

  // Stop used to be checked only between steps, so pressing it while a long
  // command ran did nothing until that command finished on its own. A user who
  // interrupts expects the work to stop now, not in three minutes.
  it("stops a command in flight the moment the user asks", async () => {
    const started = Date.now();
    const output = await withFolder(async (folder) => {
      const running = runShellCommand(silent, folder, { idleMs: 60_000, totalMs: 60_000 });
      // Long enough for the child to be spawned and registered.
      await new Promise((settle) => setTimeout(settle, 500));
      expect(cancelRunningCommands()).toBe(1);
      return running;
    });
    expect(output).toContain("You stopped this command");
    // It gave up in about a second, not the twelve the command wanted.
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 40_000);

  it("has nothing to stop once a command has finished", async () => {
    await withFolder((folder) => runShellCommand("echo done", folder, { idleMs: 10_000, totalMs: 10_000 }));
    // A settled command deregisters itself, so Stop never kills a stranger.
    expect(cancelRunningCommands()).toBe(0);
  }, 40_000);

  it("gives an hours-long allowance by default, so a real build is never cut short", () => {
    expect(COMMAND_LIMITS.totalMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    expect(COMMAND_LIMITS.idleMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(COMMAND_LIMITS.idleMs).toBeLessThan(COMMAND_LIMITS.totalMs);
  });
});

// A model under pressure sends the piece it changed as the whole file. That
// exact shape arrived once: a 15 line handler as the entire content of the
// 1000 line main process file, which stopped the app compiling. The guard
// refuses it and tells the model to send the complete file instead.
describe("looksLikeTruncatedWrite", () => {
  it("refuses a fragment sent over a substantial file", () => {
    expect(looksLikeTruncatedWrite(40_000, 600)).toBe(true);
    expect(looksLikeTruncatedWrite(5_000, 900)).toBe(true);
  });

  it("allows a real edit, which lands near the original size", () => {
    expect(looksLikeTruncatedWrite(40_000, 41_500)).toBe(false);
    expect(looksLikeTruncatedWrite(40_000, 35_000)).toBe(false);
    expect(looksLikeTruncatedWrite(40_000, 9_000)).toBe(false);
  });

  it("leaves small files alone, where a big shrink is ordinary", () => {
    expect(looksLikeTruncatedWrite(900, 40)).toBe(false);
    expect(looksLikeTruncatedWrite(3_999, 100)).toBe(false);
  });
});
