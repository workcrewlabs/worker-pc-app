import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { app } from "electron";
import { browserActionSchema, type BrowserAction } from "@workcrew/contracts";

const require = createRequire(import.meta.url);
const MAX_OUTPUT_BYTES = 250_000;

function safeRef(value: string | undefined): string {
  if (!value || !/^e\d{1,6}$/.test(value)) throw new Error("A current accessibility reference is required");
  return value;
}

function safeUrl(value: string | undefined): string {
  if (!value) throw new Error("A URL is required");
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed");
  return url.toString();
}

function commandArgs(action: BrowserAction): string[] {
  switch (action.command) {
    case "open": return ["open", safeUrl(action.url), "--headed"];
    case "goto": return ["goto", safeUrl(action.url)];
    case "snapshot": return ["snapshot", "--depth=6"];
    case "click": return ["click", safeRef(action.target)];
    case "fill": return ["fill", safeRef(action.target), action.value ?? ""];
    case "type": return ["type", action.value ?? ""];
    case "press": return ["press", action.key ?? "Enter"];
    case "select": return ["select", safeRef(action.target), action.value ?? ""];
    case "check": return ["check", safeRef(action.target)];
    case "uncheck": return ["uncheck", safeRef(action.target)];
    case "hover": return ["hover", safeRef(action.target)];
    case "screenshot": return ["screenshot"];
    case "go-back":
    case "go-forward":
    case "reload":
    case "tab-list": return [action.command];
    case "tab-new": return action.url ? ["tab-new", safeUrl(action.url)] : ["tab-new"];
    case "tab-select":
    case "tab-close": return [action.command, String(action.index ?? 0)];
  }
  throw new Error("Unsupported Playwright CLI command");
}

async function cliEntry(): Promise<string> {
  const packagePath = require.resolve("@playwright/cli/package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { bin: Record<string, string> | string };
  const relative = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin["playwright-cli"];
  if (!relative) throw new Error("Playwright CLI entry point was not found");
  return resolve(dirname(packagePath), relative);
}

export class BrowserCli {
  private readonly sessionName = `workcrew-${process.pid}`;
  private activeChild: ReturnType<typeof spawn> | null = null;

  async execute(rawAction: unknown): Promise<string> {
    const action = browserActionSchema.parse(rawAction);
    const workspace = resolve(app.getPath("userData"), "browser-automation");
    await mkdir(workspace, { recursive: true });
    const entry = await cliEntry();
    const args = [entry, `-s=${this.sessionName}`, ...commandArgs(action)];

    return new Promise<string>((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: workspace,
        windowsHide: true,
        shell: false,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PLAYWRIGHT_CLI_SESSION: this.sessionName },
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.activeChild = child;
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), 45_000);
      const collect = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) child.kill();
        return next.slice(0, MAX_OUTPUT_BYTES);
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        this.activeChild = null;
        if (code === 0) resolvePromise(stdout.trim() || "Command completed.");
        else reject(new Error((stderr || stdout || `Playwright CLI exited with code ${code}`).trim()));
      });
    });
  }

  async stop(): Promise<void> {
    this.activeChild?.kill();
    try {
      const entry = await cliEntry();
      const child = spawn(process.execPath, [entry, `-s=${this.sessionName}`, "close"], {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore"
      });
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    } catch {
      // The active browser may not have started yet.
    }
  }
}
