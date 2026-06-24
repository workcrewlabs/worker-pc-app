import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

// Runs one shell command inside WorkCrew's workspace folder. This is the engine
// behind coding and media tasks (clone a repo, run ffmpeg, edit files). It is
// ALWAYS gated by explicit user approval in the renderer before it reaches here;
// the workspace keeps work in one place rather than loose on the user's system.

const MAX_OUTPUT_CHARS = 60_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function workspaceDir(): string {
  return join(app.getPath("userData"), "workspace");
}

function clamp(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]` : text;
}

export async function runShellCommand(command: string): Promise<string> {
  const cwd = workspaceDir();
  await mkdir(cwd, { recursive: true });
  return new Promise<string>((resolve) => {
    // Run through the platform shell so pipes, &&, and built-ins work. The command
    // text is the model's, shown to and approved by the user before this runs.
    const child = process.platform === "win32"
      ? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd, windowsHide: true })
      : spawn("/bin/sh", ["-c", command], { cwd });

    let out = "";
    let settled = false;
    const settle = (text: string): void => { if (!settled) { settled = true; resolve(text); } };
    const append = (chunk: Buffer): void => { if (out.length < MAX_OUTPUT_CHARS) out += chunk.toString("utf8"); };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      settle(`${clamp(out).trim()}\n[The command ran too long and was stopped.]`);
    }, COMMAND_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      settle(`Could not run the command: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const body = clamp(out).trim();
      settle(`${body || "(no output)"}\n[Exit code ${code ?? 0}]`);
    });
  });
}
