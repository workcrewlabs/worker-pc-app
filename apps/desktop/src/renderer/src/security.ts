import type { AutomationAction } from "@workcrew/contracts";

export function actionNeedsApproval(action: AutomationAction): boolean {
  if (action.kind === "finish") return false;
  // Running a shell command on the user's computer always requires approval.
  if (action.kind === "shell") return true;
  if (action.kind === "browser") {
    return new Set(["click", "fill", "type", "press", "select", "check", "uncheck", "click-selector", "fill-selector"]).has(action.command);
  }
  return new Set(["launch", "click", "set-text", "type-keys"]).has(action.command);
}

export function redactResult(value: string): string {
  return value
    .replace(/(password|passcode|secret|token|cookie|authorization)\s*[:=]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[PAYMENT NUMBER REDACTED]")
    .slice(0, 100_000);
}
