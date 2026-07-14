import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

// Runs one shell command inside a working folder. This is the engine behind
// coding and media tasks (clone a repo, run ffmpeg, edit files). By default it
// uses WorkCrew's own hidden workspace; when the user has added a folder to work
// in, the command runs inside THAT folder instead. It is gated by an approval
// (see shell:run) so a command runs only with the user's permission.

const MAX_OUTPUT_CHARS = 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

function clamp(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : text;
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

export async function runShellCommand(command: string, folder?: string | null): Promise<string> {
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
    const child = process.platform === "win32"
      ? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true, windowsVerbatimArguments: true })
      : spawn("/bin/sh", ["-c", command], { cwd, detached: true });

    let out = "";
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (out.length >= MAX_OUTPUT_CHARS) return;
      const text = chunk.toString("utf8");
      const remaining = MAX_OUTPUT_CHARS - out.length;
      out += text.length > remaining ? text.slice(0, remaining) : text;
    };
    const settle = (text: string): void => {
      if (settled) return;
      settled = true;
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve(text);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      killTree(child.pid);
      settle(`${clamp(out).trim()}\n[The command ran too long, so it and anything it started were stopped.]`);
    }, COMMAND_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      settle(`Could not run the command: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle(`${clamp(out).trim() || "(no output)"}\n[Exit code ${code ?? 0}]`);
    });
  });
}
