import type { AutomationAction } from "@workcrew/contracts";

// Plain, friendly labels for each automation step. Provider and tool names are
// never shown; the user sees what is happening in everyday words.
export function actionLabel(action: AutomationAction): string {
  if (action.kind === "finish") return "Finishing up";
  if (action.kind === "shell") return "Run a command";
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

// A short detail string for an action, used as a subtitle in the activity list.
export function actionDetail(action: AutomationAction): string | undefined {
  if (action.kind === "shell") return action.command;
  if (action.kind === "browser") return action.url ?? action.value ?? action.target;
  if (action.kind === "windows") return action.application ?? action.windowTitle ?? action.control ?? action.value;
  return undefined;
}
