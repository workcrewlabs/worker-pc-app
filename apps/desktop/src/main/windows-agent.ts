import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { windowsActionSchema } from "@workcrew/contracts";

export class WindowsAgent {
  private process: ChildProcess | null = null;
  private endpoint: string | null = null;
  private token: string | null = null;

  private async start(): Promise<void> {
    if (this.endpoint && this.token) return;
    const executable = process.env.WORKCREW_WINDOWS_AGENT;
    if (!executable) throw new Error("The WorkCrew Windows helper is not installed on this test machine");
    const token = randomBytes(32).toString("hex");
    const child = spawn(executable, ["--host", "127.0.0.1", "--port", "0", "--token", token], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const ready = await new Promise<{ port: number }>((resolvePromise, reject) => {
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
    this.process = child;
    this.endpoint = `http://127.0.0.1:${ready.port}`;
    this.token = token;
  }

  async execute(rawAction: unknown): Promise<string> {
    const action = windowsActionSchema.parse(rawAction);
    await this.start();
    const response = await fetch(`${this.endpoint}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await response.json() as { ok?: boolean; output?: string; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Windows helper action failed");
    return payload.output ?? "Action completed.";
  }

  async stop(): Promise<void> {
    this.process?.kill();
    this.process = null;
    this.endpoint = null;
    this.token = null;
  }
}
