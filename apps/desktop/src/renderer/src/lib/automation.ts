import type { AutomationAction } from "@workcrew/contracts";

// Plain, friendly labels for each automation step. Provider and tool names are
// never shown; the user sees what is happening in everyday words.
export function actionLabel(action: AutomationAction): string {
  if (action.kind === "finish") return "Finishing up";
  if (action.kind === "shell") return "Run a command";
  if (action.kind === "write_file") return "Write a file";
  if (action.kind === "read_file") return "Read a file";
  if (action.kind === "edit_file") return "Edit a file";
  if (action.kind === "browser") {
    switch (action.command) {
      case "open":
      case "goto":
        return "Open a web page";
      case "snapshot":
        return "Read the page";
      case "click":
        return "Click an item";
      case "fill":
      case "type":
        return "Enter text";
      case "press":
        return "Press a key";
      case "select":
        return "Choose an option";
      case "check":
        return "Tick a box";
      case "uncheck":
        return "Untick a box";
      case "hover":
        return "Point at an item";
      case "screenshot":
        return "Take a screenshot";
      default:
        return "Browser step";
    }
  }
  switch (action.command) {
    case "launch":
      return "Open an app";
    case "list-windows":
      return "See open apps";
    case "connect":
      return "Connect to a desktop app";
    case "inspect":
      return "Read a desktop window";
    case "click":
      return "Click in a desktop app";
    case "set-text":
      return "Enter text in a desktop app";
    case "type-keys":
      return "Type in a desktop app";
    case "get-text":
      return "Read text from a desktop app";
    case "screenshot":
      return "Take a screenshot";
    default:
      return "Desktop step";
  }
}

/**
 * What an action is doing, said plainly, in both tenses.
 *
 * The activity list used to read "Ran a command" over and over, with the command
 * itself hidden in a tooltip nobody hovers. Watching that, you cannot tell
 * whether the work is going well, going in circles, or about to touch something
 * it should not. Every line now names the thing it acted on.
 */
export type ActivityLine = { doing: string; done: string };

/** Keep a line short enough to read at a glance, cut on a word where possible. */
function clampLine(value: string, limit = 64): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** The last two segments of a path: enough to recognise, short enough to read. */
function shortPath(value: string): string {
  const cleaned = value.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  return clampLine(parts.length <= 2 ? cleaned : parts.slice(-2).join("/"), 48);
}

/** Describe one shell command the way a person would say it out loud. */
function describeCommand(raw: string): ActivityLine {
  const command = raw.trim();
  const lower = command.toLowerCase();
  const after = (word: string): string => command.slice(word.length).trim();

  if (lower.startsWith("type ")) {
    const file = shortPath(after("type"));
    return { doing: `Reading ${file}`, done: `Read ${file}` };
  }
  if (lower === "dir" || lower.startsWith("dir ")) {
    return { doing: "Listing the folder", done: "Listed the folder" };
  }
  if (lower.startsWith("findstr ")) {
    return { doing: "Searching the files", done: "Searched the files" };
  }
  const short = clampLine(command);
  return { doing: `Running ${short}`, done: `Ran ${short}` };
}

/**
 * The activity line for an action. `done` picks the past tense, so the step that
 * is still in flight reads "Reading WORKCREW.md" and the finished one above it
 * reads "Read WORKCREW.md".
 */
export function activityLine(action: AutomationAction, done: boolean): string {
  const line = ((): ActivityLine => {
    if (action.kind === "shell") return describeCommand(action.command);
    if (action.kind === "write_file") {
      const file = shortPath(action.path);
      return { doing: `Writing ${file}`, done: `Wrote ${file}` };
    }
    if (action.kind === "read_file") {
      const file = shortPath(action.path);
      return { doing: `Reading ${file}`, done: `Read ${file}` };
    }
    if (action.kind === "edit_file") {
      const file = shortPath(action.path);
      return { doing: `Editing ${file}`, done: `Edited ${file}` };
    }
    if (action.kind === "finish") return { doing: "Finishing up", done: "Finished" };
    // Browser and desktop steps already have readable labels; the target they
    // act on is the part worth adding.
    const label = actionLabel(action);
    const target = actionDetail(action);
    const text = target ? `${label}: ${clampLine(target, 40)}` : label;
    return { doing: text, done: text };
  })();
  return done ? line.done : line.doing;
}

/**
 * One line for a whole stretch of finished work, the way a coding assistant
 * compresses it: "Ran 12 commands, read 5 files, wrote 3 files, 1 failed".
 * The per-step lines still exist behind a click; this is the collapsed view,
 * so a long run reads as a sentence instead of a scroll.
 */
export function summarizeActivity(steps: { label: string; status: string }[]): string {
  let commands = 0;
  let reads = 0;
  let writes = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.label === "Finished" || step.label === "Finishing up") continue;
    if (step.status === "error") failed += 1;
    if (step.label.startsWith("Read ")) reads += 1;
    else if (step.label.startsWith("Wrote ")) writes += 1;
    else commands += 1;
  }
  const parts: string[] = [];
  if (commands) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (reads) parts.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
  if (writes) parts.push(`wrote ${writes} file${writes === 1 ? "" : "s"}`);
  if (failed) parts.push(`${failed} failed`);
  if (parts.length === 0) return "";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A short detail string for an action, used as a subtitle in the activity list.
export function actionDetail(action: AutomationAction): string | undefined {
  if (action.kind === "shell") return action.command;
  if (action.kind === "write_file") return action.path;
  if (action.kind === "read_file" || action.kind === "edit_file") return action.path;
  if (action.kind === "browser") return action.url ?? action.value ?? action.target;
  if (action.kind === "windows") return action.application ?? action.windowTitle ?? action.control ?? action.value;
  return undefined;
}
