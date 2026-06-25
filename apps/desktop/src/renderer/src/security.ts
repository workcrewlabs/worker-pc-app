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

// The Permissions panel category an action belongs to, or null for actions with
// no toggle (reads, finish, shell). Used to decide whether "Always allow" covers
// this action.
export function permissionCategoryFor(action: AutomationAction): "browser-writes" | "windows-writes" | null {
  if (action.kind === "browser") return "browser-writes";
  if (action.kind === "windows") return "windows-writes";
  return null;
}

// Apps that are really a command line. Launching one and then typing into it is a
// way to run arbitrary commands WITHOUT going through the main process's native
// shell-approval dialog, so a launch of any of these is always confirmed, even
// under "Always allow".
const TERMINAL_APP = /(^|[\\/ ])(cmd|cmd\.exe|command prompt|powershell|powershell\.exe|pwsh|pwsh\.exe|windows ?terminal|wt|wt\.exe|conhost|conhost\.exe|bash|sh|git ?bash|wsl|wsl\.exe)([ "']|$)/i;

// Words that mark a click or key press as money-moving or destructive. A control
// whose visible text matches these always asks for confirmation, so prompt
// injection cannot silently pay, send, submit, delete, or confirm while "Always
// allow" is on.
const CONSEQUENTIAL_TEXT = /\b(pay|payment|buy|purchase|order|checkout|place\s+order|send|transfer|wire|withdraw|deposit|submit|confirm|delete)\b/i;

// Whether this action is consequential enough that it must ALWAYS be confirmed,
// regardless of "Always allow" or the per-category toggles. This is the safety
// floor that cannot be silenced.
export function isConsequentialAction(action: AutomationAction): boolean {
  if (action.kind === "windows") {
    if (action.command === "launch") return TERMINAL_APP.test(action.application ?? "");
    if (action.command === "click") return CONSEQUENTIAL_TEXT.test(action.control ?? "");
    return false;
  }
  if (action.kind === "browser") {
    if (action.command === "click" || action.command === "click-selector" || action.command === "press") {
      return CONSEQUENTIAL_TEXT.test(action.target ?? "");
    }
    return false;
  }
  return false;
}

// Whether the in-app approval prompt must be shown before running this action,
// given the user's settings. This is the single policy the runner uses, modelled
// on Claude Code: when "Always allow" is off, every write action asks (and the
// user approves to continue). "Always allow" silences the asking, but only for
// categories the user has left on in Permissions; a category turned off keeps
// asking even with "Always allow" on. Shell is excluded here because the main
// process shows its own native confirmation that cannot be bypassed.
export function requiresApproval(
  action: AutomationAction,
  opts: { alwaysAllow: boolean; permissions: Record<string, boolean> }
): boolean {
  if (action.kind === "shell") return false;
  if (!actionNeedsApproval(action)) return false; // reads and finish never prompt
  // Money-moving, destructive, and terminal-launch actions are never silenced,
  // even with "Always allow" on. This closes the path where Always allow lets
  // injected content open a terminal or click a Pay button with no prompt.
  if (isConsequentialAction(action)) return true;
  const category = permissionCategoryFor(action);
  const categoryAllowed = category ? opts.permissions[category] !== false : true;
  const covered = opts.alwaysAllow && categoryAllowed;
  return !covered;
}

export function redactResult(value: string): string {
  return value
    .replace(/(password|passcode|secret|token|cookie|authorization)\s*[:=]\s*\S+/gi, "$1: [REDACTED]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[PAYMENT NUMBER REDACTED]")
    .slice(0, 100_000);
}
