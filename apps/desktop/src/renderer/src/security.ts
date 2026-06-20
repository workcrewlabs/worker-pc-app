import type { AutomationAction } from "@workcrew/contracts";

export function actionNeedsApproval(action: AutomationAction): boolean {
  if (action.kind === "finish") return false;
  if (action.kind === "browser") {
    return new Set(["click", "fill", "type", "press", "select", "check", "uncheck"]).has(action.command);
  }
  return new Set(["click", "set-text", "type-keys"]).has(action.command);
}

export function redactResult(value: string): string {
  return value
    .replace(/(password|passcode|secret|token|cookie|authorization)\s*[:=]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[PAYMENT NUMBER REDACTED]")
    .slice(0, 100_000);
}
