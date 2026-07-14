import type { AutomationAction } from "@workcrew/contracts";

export function actionNeedsApproval(action: AutomationAction): boolean {
  if (action.kind === "finish") return false;
  // Running a shell command on the user's computer always requires approval.
  if (action.kind === "shell") return true;
  if (action.kind === "browser") {
    return new Set(["click", "fill", "type", "press", "select", "check", "uncheck", "click-selector", "fill-selector"]).has(action.command);
  }
  // Every Windows write command must prompt. "type-text" (type literal text into
  // the focused control) and "press-key" (send Enter/Tab/arrows) are writes too:
  // they can fill fields or submit a form, so they were missing here and slipped
  // past the approval gate entirely. The rest are reads (list-windows, connect,
  // inspect, get-text, screenshot) and never prompt.
  return new Set(["launch", "click", "set-text", "type-keys", "type-text", "press-key"]).has(action.command);
}

// The Permissions panel category an action belongs to, or null for actions with
// no toggle (reads, finish, shell). Used to decide whether "Always allow" covers
// this action.
export function permissionCategoryFor(action: AutomationAction): "browser-writes" | "windows-writes" | null {
  if (action.kind === "browser") return "browser-writes";
  if (action.kind === "windows") return "windows-writes";
  return null;
}

// Friendly app names that the main process (windows-agent.ts APP_TARGETS) resolves
// to a real terminal, plus the resolved executables themselves. Launching a
// terminal and then typing into it runs arbitrary commands WITHOUT the main
// process's native shell-approval dialog, so any terminal launch is always
// confirmed, even under "Always allow". Kept in sync with APP_TARGETS; the
// substring regex below is a backstop for names with flags (e.g. "powershell -nop").
const TERMINAL_TARGETS = new Set(["wt", "cmd", "powershell", "pwsh", "conhost", "bash", "sh", "wsl"]);
const TERMINAL_ALIASES: Record<string, string> = {
  "terminal": "wt",
  "windows terminal": "wt",
  "command prompt": "cmd",
  "git bash": "bash",
  "powershell ise": "powershell"
};
const TERMINAL_APP = /\b(cmd|command prompt|powershell|pwsh|windows ?terminal|wt|conhost|bash|git ?bash|wsl|terminal)\b/i;

export function launchesTerminal(application: string): boolean {
  const key = application.trim().toLowerCase().replace(/\.exe$/i, "");
  const resolved = TERMINAL_ALIASES[key] ?? key;
  if (TERMINAL_TARGETS.has(resolved)) return true;
  return TERMINAL_APP.test(application);
}

// Words that mark a click as money-moving or destructive. A control whose visible
// LABEL matches these always asks for confirmation, so prompt injection cannot
// silently pay, send, submit, delete, or confirm while "Always allow" is on. Note
// the click action itself carries only an opaque ref (e12 / a number), so the
// caller must resolve the ref to its real label and pass it in; matching the raw
// ref would never fire. "order" alone is excluded so "Order history" is not caught;
// "place order" still is.
const CONSEQUENTIAL_TEXT = /\b(pay|payment|buy|purchase|checkout|place\s+order|send|transfer|wire|withdraw|deposit|submit|confirm|delete)\b/i;

// Whether this action is consequential enough that it must ALWAYS be confirmed,
// regardless of "Always allow" or the per-category toggles. This is the safety
// floor that cannot be silenced. `label` is the resolved human-readable target of
// a click (from the snapshot the model used); when omitted, the raw action field
// is used as a best effort (correct for recorded recipes whose controls are real
// names, but a bare ref will simply not match, which is fail-open for clicks, so
// callers that have a snapshot should always resolve and pass the label).
export function isConsequentialAction(action: AutomationAction, label?: string): boolean {
  if (action.kind === "windows") {
    if (action.command === "launch") return launchesTerminal(action.application ?? "");
    if (action.command === "click") return CONSEQUENTIAL_TEXT.test(label ?? action.control ?? "");
    return false;
  }
  if (action.kind === "browser") {
    if (action.command === "click" || action.command === "click-selector") {
      return CONSEQUENTIAL_TEXT.test(label ?? action.target ?? "");
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
// asking even with "Always allow" on. A shell command (used to work inside a
// folder the user added) is governed the same way: it asks each time when "Always
// allow" is off, and runs freely when it is on. The main process keeps a separate
// native floor for obviously destructive commands that cannot be bypassed.
export function requiresApproval(
  action: AutomationAction,
  opts: { alwaysAllow: boolean; permissions: Record<string, boolean>; label?: string }
): boolean {
  if (!actionNeedsApproval(action)) return false; // reads and finish never prompt
  // Money-moving, destructive, and terminal-launch actions are never silenced,
  // even with "Always allow" on. This closes the path where Always allow lets
  // injected content open a terminal or click a Pay button with no prompt. The
  // caller resolves a click's opaque ref to its real label and passes it as
  // opts.label so the text match works on the real button name.
  if (isConsequentialAction(action, opts.label)) return true;
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
