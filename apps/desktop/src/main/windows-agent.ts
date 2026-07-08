import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { APP_NAME, windowsActionSchema } from "@workcrew/contracts";

const execFileAsync = promisify(execFile);

// Where the packaged Windows helper executable lives. In an installed build it
// is bundled under the app resources; in development it is the PyInstaller output
// under python/windows-agent/dist. An explicit WORKCREW_WINDOWS_AGENT env var
// overrides both.
function defaultAgentPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "windows-agent", "workcrew-windows-agent.exe");
  return join(app.getAppPath(), "..", "..", "python", "windows-agent", "dist", "workcrew-windows-agent.exe");
}

// Friendly app names mapped to the command Windows uses to start them. Anything
// not listed is passed through as-is, so registered apps (Spotify, Chrome, etc.)
// still launch by name.
const APP_TARGETS: Record<string, string> = {
  excel: "excel",
  "microsoft excel": "excel",
  word: "winword",
  "microsoft word": "winword",
  powerpoint: "powerpnt",
  "microsoft powerpoint": "powerpnt",
  outlook: "outlook",
  onenote: "onenote",
  notepad: "notepad",
  wordpad: "write",
  calculator: "calc",
  calc: "calc",
  paint: "mspaint",
  "file explorer": "explorer",
  explorer: "explorer",
  files: "explorer",
  "command prompt": "cmd",
  terminal: "wt"
};

function resolveAppTarget(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return APP_TARGETS[key] ?? key.replace(/\.exe$/i, "");
}

export class WindowsAgent {
  private process: ChildProcess | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;
  private healthChecked = false;

  // Open a desktop app by name or full exe path. Launching is done here rather
  // than the helper, so it works without any extra setup; the helper is only
  // needed to inspect and control the window afterwards.
  //
  // Two behaviors matter for third-party apps:
  //  1. A full exe path is spawned with the exe's OWN folder as the working
  //     directory. Many legacy business apps (VB6-era accounting tools and the
  //     like) load their config and libraries relative to their install folder
  //     and crash with startup errors (e.g. "Run-time error 91") when started
  //     from anywhere else.
  //  2. An unknown name is verified: if no matching process appears shortly
  //     after the launch, this returns an error instead of a phantom "Opened",
  //     so the model can ask for the full path instead of hunting with shell
  //     commands in a loop.
  private async launchApp(name: string): Promise<string> {
    const raw = name.trim().replace(/^["']|["']$/g, "");
    if (!raw) throw new Error("Tell me which app to open, for example Excel or Notepad.");

    // A full path to an executable: run it directly from its own directory.
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      const exePath = /\.exe$/i.test(raw) ? raw : `${raw}.exe`;
      if (!existsSync(exePath)) {
        throw new Error(`No program was found at ${exePath}. Check the path and try again.`);
      }
      const child = spawn(exePath, [], { cwd: dirname(exePath), windowsHide: false, detached: true, stdio: "ignore", shell: false });
      child.unref();
      return `Opened ${basename(exePath)}.`;
    }

    const target = resolveAppTarget(raw);
    if (!target) throw new Error("Tell me which app to open, for example Excel or Notepad.");
    const known = APP_TARGETS[raw.toLowerCase()] !== undefined;
    const child = spawn("cmd", ["/c", "start", "", target], { windowsHide: true, detached: true, stdio: "ignore", shell: false });
    child.unref();
    // Known Windows/Office targets are trusted to start. For anything else,
    // confirm a matching process actually appeared; "start" reports no failure
    // itself, and a false "Opened" sends the model on a shell-command hunt.
    if (!known) {
      await new Promise((settle) => setTimeout(settle, 1_500));
      const image = `${target.replace(/\.exe$/i, "")}.exe`;
      try {
        const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5_000 });
        if (!stdout.toLowerCase().includes(image.toLowerCase())) {
          throw new Error(`I could not find an installed app called "${raw}". If you know where it is installed, tell me the full path to its .exe file and I will open it directly.`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("I could not find")) throw error;
        // tasklist itself failed: do not block the launch on the verification.
      }
    }
    return `Opened ${raw || target}.`;
  }

  private reset(): void {
    this.process = null;
    this.endpoint = null;
    this.token = null;
    this.healthChecked = false;
  }

  private async start(): Promise<void> {
    if (this.endpoint && this.token) return;
    const executable = process.env.WORKCREW_WINDOWS_AGENT ?? defaultAgentPath();
    if (!existsSync(executable)) {
      throw new Error("The WorkCrew Windows helper is not installed. Reinstall the app to enable Windows app automation.");
    }
    const token = randomBytes(32).toString("hex");
    const child = spawn(executable, ["--host", "127.0.0.1", "--port", "0", "--token", token], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    // If the helper crashes at any point after launch, clear our internal state
    // so a later execute() call relaunches a fresh process cleanly rather than
    // talking to a dead endpoint.
    child.once("exit", () => {
      if (this.process === child) this.reset();
    });
    let ready: { port: number };
    try {
      ready = await new Promise<{ port: number }>((resolvePromise, reject) => {
        const timeout = setTimeout(() => reject(new Error("Windows helper startup timed out")), 10_000);
        let line = "";
        child.stdout.on("data", (chunk: Buffer) => {
          line += chunk.toString("utf8");
          const newline = line.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timeout);
          try { resolvePromise(JSON.parse(line.slice(0, newline)) as { port: number }); }
          catch { reject(new Error("Windows helper returned an invalid startup message")); }
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Windows helper stopped during startup with code ${code}`)));
      });
    } catch (error) {
      // Startup failed: make sure no half started child lingers and state is clean.
      child.kill();
      this.reset();
      throw error instanceof Error ? error : new Error("Windows helper failed to start");
    }
    this.process = child;
    this.endpoint = `http://127.0.0.1:${ready.port}`;
    this.token = token;
    this.healthChecked = false;
  }

  private async probeHealth(): Promise<void> {
    if (this.healthChecked) return;
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(5_000)
      });
      const payload = await response.json() as { ok?: boolean };
      if (!response.ok || !payload.ok) throw new Error("Windows helper failed its readiness check");
    } catch {
      // A failed probe means the helper is not usable. Reset so the next call
      // can relaunch, and surface a concise, non sensitive error.
      await this.stop();
      throw new Error("Windows helper is not ready");
    }
    this.healthChecked = true;
  }

  async execute(rawAction: unknown): Promise<string> {
    const action = windowsActionSchema.parse(rawAction);
    // Launching an app does not need the helper, so handle it directly. Every
    // other command drives an existing window through the helper (pywinauto).
    if (action.command === "launch") {
      return this.launchApp(action.application ?? "");
    }
    await this.start();
    await this.probeHealth();
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/action`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      // A transport failure usually means the helper died mid request. Reset so
      // a later call relaunches, and return a concise error with no internals.
      await this.stop();
      throw new Error("Windows helper action failed");
    }
    const payload = await response.json() as { ok?: boolean; output?: string; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Windows helper action failed");
    return payload.output ?? "Action completed.";
  }

  // Begin recording the user's clicks in desktop apps. The helper polls the mouse
  // in its own process between this call and recordStop, so this returns at once.
  async recordStart(): Promise<void> {
    // Pass WorkCrew's own window title so the helper ignores clicks and typing
    // that happen in WorkCrew itself (starting/stopping, its panels and buttons),
    // recording only the user's work in the target app.
    await this.execute({ kind: "windows", command: "record-start", windowTitle: APP_NAME });
  }

  // Stop recording and return the captured steps as raw action objects (the
  // helper returns them as a JSON array). The caller validates them against the
  // action schema before saving.
  async recordStop(): Promise<unknown[]> {
    const output = await this.execute({ kind: "windows", command: "record-stop" });
    try {
      const parsed = JSON.parse(output) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async stop(): Promise<void> {
    this.process?.kill();
    this.reset();
  }
}
