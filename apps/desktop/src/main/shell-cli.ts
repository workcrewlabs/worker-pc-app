import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { app } from "electron";

// Runs one shell command inside a working folder. This is the engine behind
// coding and media tasks (clone a repo, run ffmpeg, edit files). By default it
// uses WorkCrew's own hidden workspace; when the user has added a folder to work
// in, the command runs inside THAT folder instead. It is gated by an approval
// (see shell:run) so a command runs only with the user's permission.

const MAX_OUTPUT_CHARS = 60_000;

/**
 * How long a command may take.
 *
 * The thing to measure is silence, not duration. Packaging an installer or
 * uploading one to a release honestly takes an hour, and a flat ten-minute limit
 * killed that work halfway through with nothing to show for it. A command that is
 * still printing is still working; one that has said nothing for a quarter of an
 * hour has hung, whatever its total runtime. The total is only a backstop against
 * something that chatters forever.
 */
export type CommandLimits = { idleMs: number; totalMs: number };
export const COMMAND_LIMITS: CommandLimits = { idleMs: 15 * 60 * 1000, totalMs: 3 * 60 * 60 * 1000 };

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total} minute${total === 1 ? "" : "s"}`;
  const hours = Math.round((ms / 3_600_000) * 10) / 10;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function workspaceDir(): string {
  return join(app.getPath("userData"), "workspace");
}

// Resolve the folder a command should run in: the user's chosen folder when it is
// a real directory, otherwise WorkCrew's hidden workspace. Never trusts the caller
// blindly; a path that is not an existing directory falls back to the workspace.
export async function resolveWorkingDir(folder?: string | null): Promise<string> {
  if (folder && folder.trim()) {
    try {
      if ((await stat(folder)).isDirectory()) return folder;
    } catch {
      // Not a real directory: fall through to the workspace.
    }
  }
  return workspaceDir();
}

// Resolve a requested (relative or absolute) path against a base directory and
// return the absolute path ONLY if it stays strictly inside base. Returns null
// when the path escapes the folder (via .. or an absolute path elsewhere) or
// resolves to the base directory itself. This is the confinement that stops
// write_file from ever touching a file outside the folder the user granted.
// Pure path math so it is unit-tested directly.
export function confinePath(base: string, requested: string): string | null {
  const root = resolve(base);
  const target = resolve(root, requested);
  return target.startsWith(root + sep) ? target : null;
}

function clamp(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : text;
}

/**
 * Whether a write looks like a fragment about to destroy a file.
 *
 * write_file replaces the whole file, and a model under pressure will sometimes
 * send just the piece it changed: a 15 line handler arrived as the entire
 * content of a 1000 line main process file, and the app stopped compiling.
 * A real rewrite almost never shrinks a substantial file to under a fifth of
 * its size, so that shape is refused and the model is told to send the whole
 * file. Small files are exempt: rewriting a 20 line config down to 5 is normal.
 */
export function looksLikeTruncatedWrite(previousBytes: number, nextBytes: number): boolean {
  return previousBytes >= 4_000 && nextBytes < previousBytes / 5;
}

// Kill the whole process tree. child.kill() only terminates the shell itself, so
// any tool it launched (git, ffmpeg, npm) would be orphaned and keep running.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch { /* already gone */ }
}

/**
 * Every command running right now, so Stop can actually stop them.
 *
 * A folder run spends nearly all its time inside a command (a test suite, an
 * install, a search). Stopping only checked between steps, so pressing Stop
 * during a three minute command did nothing at all until that command chose to
 * finish, which reads exactly like being ignored.
 */
const liveCommands = new Set<() => void>();

/** Stop every command in flight. Returns how many were stopped. */
export function cancelRunningCommands(): number {
  const running = [...liveCommands];
  liveCommands.clear();
  for (const cancel of running) cancel();
  return running.length;
}

export async function runShellCommand(
  command: string,
  folder?: string | null,
  limits: CommandLimits = COMMAND_LIMITS
): Promise<string> {
  const cwd = await resolveWorkingDir(folder);
  try {
    await mkdir(cwd, { recursive: true });
  } catch (error) {
    return `Could not run the command: ${error instanceof Error ? error.message : String(error)}`;
  }
  return new Promise<string>((resolve) => {
    // windowsVerbatimArguments keeps the command identical to what the user
    // approved (Node would otherwise re-escape quotes and corrupt it). On POSIX
    // the child is detached into its own group so the whole tree can be killed.
    // GIT_TERMINAL_PROMPT=0 makes git fail fast with a readable error instead of
    // hanging invisibly on a credential prompt (there is no terminal to answer
    // it), so a push without stored credentials reports instead of timing out.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const child = process.platform === "win32"
      ? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true });

    let out = "";
    let settled = false;
    // Reset by every chunk of output, so the idle clock measures silence rather
    // than how long the work has taken.
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    const stopTimers = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
    };
    const settle = (text: string): void => {
      if (settled) return;
      settled = true;
      stopTimers();
      liveCommands.delete(cancel);
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve(text);
    };
    const giveUp = (note: string): void => {
      killTree(child.pid);
      settle(`${clamp(out).trim()}\n[${note}]`);
    };
    // Pressing Stop kills the command and everything it started, and reports
    // what it had produced so far rather than pretending it finished.
    const cancel = (): void => giveUp("You stopped this command.");
    liveCommands.add(cancel);
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => giveUp(`The command stopped producing any output for ${minutes(limits.idleMs)}, so it and anything it started were stopped.`),
        limits.idleMs
      );
    };
    const append = (chunk: Buffer): void => {
      resetIdle();
      if (out.length >= MAX_OUTPUT_CHARS) return;
      const text = chunk.toString("utf8");
      const remaining = MAX_OUTPUT_CHARS - out.length;
      out += text.length > remaining ? text.slice(0, remaining) : text;
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    totalTimer = setTimeout(
      () => giveUp(`The command ran for ${minutes(limits.totalMs)}, so it and anything it started were stopped.`),
      limits.totalMs
    );
    resetIdle();

    child.on("error", (error) => {
      settle(`Could not run the command: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on("close", (code) => {
      settle(`${clamp(out).trim() || "(no output)"}\n[Exit code ${code ?? 0}]`);
    });
  });
}
