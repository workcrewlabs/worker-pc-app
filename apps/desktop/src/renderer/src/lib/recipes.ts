// Record-and-replay recipes for automation runs.
//
// The biggest token cost is paying the model to re-derive the same workflow on
// every run. A recipe captures the concrete, deterministic steps of a workflow
// the first time it succeeds, so a later run of the same task can replay those
// steps directly with NO model call. The model is only invoked when replay
// cannot proceed (a control is missing, the screen differs), at which point the
// normal model loop runs and re-saves a corrected recipe.
//
// Safety, by design:
//   - Steps reference desktop controls by NAME/auto_id (stable), never by the
//     numeric ids shown in a snapshot (which are reassigned every inspect) and
//     never by screen coordinates. Numeric references seen during recording are
//     resolved back to their name before being stored; a run that cannot be
//     fully resolved is simply not recorded.
//   - Replay still routes every money-affecting write through the same approval
//     gate as a normal run (see security.ts / actionNeedsApproval).
//   - Browser actions that target ephemeral aria refs (e12) are not replayable,
//     so any run containing one is not recorded. Desktop (pywinauto) workflows,
//     the accounting use case, are the target.
//
// The pure helpers here are unit tested; persistence uses localStorage, mirroring
// lib/storage.ts (same key prefix and version).

import type { AutomationAction } from "@workcrew/contracts";
import { actionNeedsApproval } from "../security";

const PREFIX = "workcrew";
const VERSION = "v1";

function storageKey(name: string): string {
  return `${PREFIX}:${VERSION}:${name}`;
}

function read<T>(name: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(storageKey(name));
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write<T>(name: string, value: T): void {
  try {
    window.localStorage.setItem(storageKey(name), JSON.stringify(value));
  } catch {
    // Storage full or disabled; replay simply stays unavailable.
  }
}

export type RecipeStep = {
  /** The action to replay, with a stable (name/auto_id/url) selector. */
  action: AutomationAction;
  /** Precomputed so replay can gate writes without re-deriving it. */
  needsApproval: boolean;
};

export type Recipe = {
  /** Normalized task text; the lookup key. */
  taskKey: string;
  /** Original task text, for display. */
  task: string;
  steps: RecipeStep[];
  /** The finish summary from the recorded run, shown when replay completes. */
  summary: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** How many times this recipe has replayed to completion. */
  runCount: number;
};

/**
 * Normalize a task into a stable lookup key: lowercased, trimmed, internal
 * whitespace collapsed. Two requests that differ only in spacing or case map to
 * the same recipe; anything else is treated as a different workflow.
 */
export function normalizeTaskKey(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Parse a Windows inspect snapshot (lines like `12 Button "Save & Close"`) into
 * a map of numeric id to control name, so a recorded numeric reference can be
 * rewritten to the stable name.
 */
export function parseWindowsSnapshot(text: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!text) return map;
  for (const raw of text.split("\n")) {
    const match = /^(\d+)\s+\S+\s+"(.*)"$/.exec(raw.trim());
    const id = match?.[1];
    const name = match?.[2];
    if (id !== undefined && name !== undefined) map.set(id, name);
  }
  return map;
}

const WINDOWS_CONTROL_COMMANDS = new Set(["click", "set-text", "type-keys", "get-text"]);
const WINDOWS_NO_CONTROL_COMMANDS = new Set(["launch", "list-windows", "connect", "inspect"]);
const BROWSER_REPLAYABLE_COMMANDS = new Set(["open", "goto", "reload", "go-back", "go-forward", "snapshot"]);

/**
 * Return a replay-stable version of an action, or null if it cannot be replayed
 * deterministically. `snapshot` is the inspect output that was current when the
 * action was chosen, used to resolve a numeric control reference to its name.
 */
export function stabilizeAction(action: AutomationAction, snapshot: string | null): AutomationAction | null {
  if (action.kind === "finish") return action;

  if (action.kind === "windows") {
    if (WINDOWS_NO_CONTROL_COMMANDS.has(action.command)) return action;
    if (WINDOWS_CONTROL_COMMANDS.has(action.command)) {
      const control = action.control ?? "";
      if (!control) return null;
      if (/^\d+$/.test(control)) {
        const name = parseWindowsSnapshot(snapshot).get(control);
        if (!name) return null; // a bare number with no snapshot to resolve it is not replayable
        return { ...action, control: name };
      }
      return action; // already a stable name/auto_id
    }
    return null;
  }

  if (action.kind === "browser") {
    // URL-driven and navigation/read actions are stable; ref-targeted writes
    // (click/fill/type/select/check/uncheck/hover/press) are not.
    return BROWSER_REPLAYABLE_COMMANDS.has(action.command) ? action : null;
  }

  return null;
}

/**
 * Build a recipe from the actions executed during a successful run, each paired
 * with the snapshot that was current when it was chosen. Returns null if any
 * step cannot be made replay-stable, so a partially-deterministic run is never
 * recorded (replay must be all-or-nothing safe). The trailing finish is dropped;
 * replay completes after the last concrete step.
 */
export function buildRecipe(
  task: string,
  recorded: { action: AutomationAction; snapshot: string | null }[],
  summary: string
): Recipe | null {
  if (recorded.length === 0) return null;
  const steps: RecipeStep[] = [];
  for (const { action, snapshot } of recorded) {
    const stable = stabilizeAction(action, snapshot);
    if (!stable) return null;
    if (stable.kind === "finish") continue;
    steps.push({ action: stable, needsApproval: actionNeedsApproval(stable) });
  }
  if (steps.length === 0) return null;
  const now = Date.now();
  return {
    taskKey: normalizeTaskKey(task),
    task: task.trim(),
    steps,
    summary,
    createdAtMs: now,
    updatedAtMs: now,
    runCount: 0
  };
}

// Persistence ---------------------------------------------------------------

const RECIPES_KEY = "recipes";
const RECIPES_LIMIT = 100;
const REPLAY_ENABLED_KEY = "replayEnabled";

export function loadRecipes(): Recipe[] {
  return read<Recipe[]>(RECIPES_KEY, []);
}

export function getRecipe(taskKey: string): Recipe | null {
  return loadRecipes().find((recipe) => recipe.taskKey === taskKey) ?? null;
}

/** Insert or replace the recipe for a task key, newest first. */
export function saveRecipe(recipe: Recipe): Recipe[] {
  const others = loadRecipes().filter((item) => item.taskKey !== recipe.taskKey);
  const next = [recipe, ...others].slice(0, RECIPES_LIMIT);
  write(RECIPES_KEY, next);
  return next;
}

export function removeRecipe(taskKey: string): Recipe[] {
  const next = loadRecipes().filter((item) => item.taskKey !== taskKey);
  write(RECIPES_KEY, next);
  return next;
}

/** Whether replay is enabled. Defaults to on; the owner can disable it. */
export function isReplayEnabled(): boolean {
  return read<boolean>(REPLAY_ENABLED_KEY, true);
}

export function setReplayEnabled(enabled: boolean): void {
  write(REPLAY_ENABLED_KEY, enabled);
}
