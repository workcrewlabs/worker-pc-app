import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import { APP_NAME, windowsActionSchema } from "@workcrew/contracts";
import { defaultShortcutRoots, findAppShortcuts } from "./app-locator";

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

  // Open a desktop app by name or full path. Launching is done here rather
  // than the helper, so it works without any extra setup; the helper is only
  // needed to inspect and control the window afterwards.
  //
  // Three behaviors matter for third-party apps:
  //  1. An unknown name is resolved through the app's Start Menu or desktop
  //     shortcut and the shortcut is opened exactly like a double-click. The
  //     shortcut carries the app's own start folder, which many legacy business
  //     apps (VB6-era accounting tools and the like) require; started from
  //     anywhere else they crash with startup errors ("Run-time error 91").
  //  2. A full exe path is spawned with the exe's OWN folder as the working
  //     directory, for the same reason.
  //  3. A name that matches nothing is verified: if no matching process appears
  //     shortly after the launch, this returns an error instead of a phantom
  //     "Opened", so the model can ask the user instead of hunting with shell
  //     commands in a loop.
  private async launchApp(name: string): Promise<string> {
    const raw = name.trim().replace(/^["']|["']$/g, "");
    if (!raw) throw new Error("Tell me which app to open, for example Excel or Notepad.");

    // A full path: open a shortcut the way a double-click would, or run an
    // executable directly from its own directory. Existence checks go through
    // async access() so an unreachable network path can never freeze the UI.
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
      if (/\.lnk$/i.test(raw)) {
        if (!(await this.pathExists(raw))) {
          throw new Error(`No shortcut was found at ${raw}. Check the path and try again.`);
        }
        const target = this.readShortcutTarget(raw);
        if (target && !(await this.pathExists(target))) {
          throw new Error(`The shortcut at ${raw} points to a program that no longer exists. Ask the user where the app is installed now.`);
        }
        return this.openShortcut(raw, basename(raw).replace(/\.lnk$/i, ""), target);
      }
      const exePath = /\.exe$/i.test(raw) ? raw : `${raw}.exe`;
      if (!(await this.pathExists(exePath))) {
        throw new Error(`No program was found at ${exePath}. Check the path and try again.`);
      }
      const child = spawn(exePath, [], { cwd: dirname(exePath), windowsHide: false, detached: true, stdio: "ignore", shell: false });
      child.unref();
      return `Opened ${basename(exePath)}.`;
    }

    const target = resolveAppTarget(raw);
    if (!target) throw new Error("Tell me which app to open, for example Excel or Notepad.");
    const known = APP_TARGETS[raw.toLowerCase()] !== undefined;
    if (!known) {
      // Installed programs are launched by their Start Menu or desktop shortcut,
      // exactly as the user would. This is what makes names like "Adminsoft
      // Accounts" work: the shortcut knows the real exe and its start folder.
      for (const candidate of findAppShortcuts(raw, defaultShortcutRoots(this.desktopRoots()))) {
        const candidateTarget = this.readShortcutTarget(candidate.path);
        // A shortcut whose recorded program is gone would hang the launch on a
        // Windows "problem with shortcut" dialog, so skip it and try the next.
        if (candidateTarget && !(await this.pathExists(candidateTarget))) continue;
        return this.openShortcut(candidate.path, candidate.name, candidateTarget);
      }
    }
    // The launch runs through cmd's "start", which re-parses the command line, so
    // a name with shell metacharacters (& | > < ^ % " etc.) could inject commands.
    // App names are simple, so allow only a safe set and reject the rest, pointing
    // the model at the full-path form instead. Known targets are hardcoded above.
    if (!known && !/^[A-Za-z0-9 ._+()-]+$/.test(target)) {
      throw new Error(`I can only open "${raw}" if you give me the full path to its .exe file. Ask the user where it is installed, then open it with that path.`);
    }
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
          throw new Error(`I could not find an installed app called "${raw}": nothing with that name is in the Start Menu or on the desktop. Do not retry and do not search with shell commands. Ask the user for the app's exact name or the full path to its .exe file.`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("I could not find")) throw error;
        // tasklist itself failed: do not block the launch on the verification.
      }
    }
    return `Opened ${raw || target}.`;
  }

  // The real per-user desktop folder, which can be redirected (for example into
  // OneDrive), so ask Electron for it rather than assuming %USERPROFILE%\Desktop.
  private desktopRoots(): string[] {
    try {
      return [app.getPath("desktop")];
    } catch {
      return [];
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  // The program a .lnk points at, or null when it cannot be read (ClickOnce
  // .appref-ms entries and MSI "advertised" shortcuts have no readable target).
  private readShortcutTarget(shortcutPath: string): string | null {
    if (!/\.lnk$/i.test(shortcutPath)) return null;
    try {
      return shell.readShortcutLink(shortcutPath).target || null;
    } catch {
      return null;
    }
  }

  // Open a shortcut exactly the way a double-click does. ShellExecute reports
  // failure directly, so its success is a trustworthy "the app is starting".
  // The settle afterwards absorbs slow starters so the model's next look at the
  // windows does not race the app; the process check is informational only and
  // never fails a launch ShellExecute accepted (legacy apps can take longer).
  private async openShortcut(shortcutPath: string, label: string, target: string | null): Promise<string> {
    const failure = await shell.openPath(shortcutPath);
    if (failure) throw new Error(`Windows could not open ${label}: ${failure}`);
    const image = target && /\.exe$/i.test(target) ? basename(target) : null;
    for (const delayMs of [1_500, 2_500]) {
      await new Promise((settle) => setTimeout(settle, delayMs));
      if (!image || (await this.processRunning(image))) return `Opened ${label}.`;
    }
    return `Opened ${label}. It may still be starting; use list-windows once its window appears.`;
  }

  private async processRunning(image: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5_000 });
      return stdout.toLowerCase().includes(image.toLowerCase());
    } catch {
      return true; // tasklist trouble must never fail a launch Windows accepted
    }
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
