// Local persistence helpers for WorkCrew renderer features.
// Everything here lives in window.localStorage. No new IPC channels are
// introduced. Keys are versioned so a future schema change can migrate safely.

const PREFIX = "workcrew";
const VERSION = "v1";

function key(name: string): string {
  return `${PREFIX}:${VERSION}:${name}`;
}

function read<T>(name: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key(name));
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write<T>(name: string, value: T): void {
  try {
    window.localStorage.setItem(key(name), JSON.stringify(value));
  } catch {
    // Storage may be full or disabled. Features degrade quietly.
  }
}

function id(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// History ------------------------------------------------------------------

export type RunOutcome = "complete" | "stopped" | "failed";

export type HistoryEntry = {
  id: string;
  task: string;
  timestamp: number;
  outcome: RunOutcome;
  activityCount: number;
};

const HISTORY_KEY = "history";
const HISTORY_LIMIT = 200;

export function loadHistory(): HistoryEntry[] {
  return read<HistoryEntry[]>(HISTORY_KEY, []);
}

export function addHistory(entry: Omit<HistoryEntry, "id">): HistoryEntry[] {
  const next = [{ ...entry, id: id() }, ...loadHistory()].slice(0, HISTORY_LIMIT);
  write(HISTORY_KEY, next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  write<HistoryEntry[]>(HISTORY_KEY, []);
  return [];
}

// Workflows -----------------------------------------------------------------

export type Workflow = {
  id: string;
  name: string;
  task: string;
  createdAt: number;
};

const WORKFLOWS_KEY = "workflows";

export function loadWorkflows(): Workflow[] {
  return read<Workflow[]>(WORKFLOWS_KEY, []);
}

export function addWorkflow(name: string, task: string): Workflow[] {
  const entry: Workflow = { id: id(), name: name.trim(), task: task.trim(), createdAt: Date.now() };
  const next = [entry, ...loadWorkflows()];
  write(WORKFLOWS_KEY, next);
  return next;
}

export function removeWorkflow(workflowId: string): Workflow[] {
  const next = loadWorkflows().filter((item) => item.id !== workflowId);
  write(WORKFLOWS_KEY, next);
  return next;
}

// Scheduled (local only, no real engine) ------------------------------------

export type Cadence = "daily" | "weekly" | "weekdays";

export type Schedule = {
  id: string;
  name: string;
  task: string;
  cadence: Cadence;
  createdAt: number;
};

const SCHEDULES_KEY = "schedules";

export function loadSchedules(): Schedule[] {
  return read<Schedule[]>(SCHEDULES_KEY, []);
}

export function addSchedule(input: Omit<Schedule, "id" | "createdAt">): Schedule[] {
  const entry: Schedule = { ...input, id: id(), createdAt: Date.now() };
  const next = [entry, ...loadSchedules()];
  write(SCHEDULES_KEY, next);
  return next;
}

export function removeSchedule(scheduleId: string): Schedule[] {
  const next = loadSchedules().filter((item) => item.id !== scheduleId);
  write(SCHEDULES_KEY, next);
  return next;
}

// Permissions ----------------------------------------------------------------
// The security model (see SECURITY.md and security.ts) requires explicit
// approval for browser and Windows write actions, and keeps consequential
// actions blocked. We surface that here. Some categories are always locked on
// (they always require approval and cannot be turned off). Optional toggles
// only control whether a routine write category should ask each time. Turning
// a toggle off never auto approves a sensitive action, because the approval
// modal still fires for any action where actionNeedsApproval is true.

export type PermissionCategory = {
  id: string;
  title: string;
  description: string;
  locked: boolean;
  defaultOn: boolean;
};

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    id: "browser-writes",
    title: "Browser actions",
    description: "Clicking, typing, and form entry inside the automated browser. Approved per action.",
    locked: false,
    defaultOn: true
  },
  {
    id: "windows-writes",
    title: "Windows actions",
    description: "Setting text and sending keystrokes to desktop windows. Approved per action.",
    locked: false,
    defaultOn: true
  },
  {
    id: "downloads",
    title: "Downloads",
    description: "Saving files that a task produces or retrieves.",
    locked: false,
    defaultOn: true
  },
  {
    id: "messages",
    title: "Sending messages",
    description: "Sending emails or chat messages on your behalf. Always requires approval.",
    locked: true,
    defaultOn: true
  },
  {
    id: "purchases",
    title: "Purchases and payments",
    description: "Any checkout or financial activity. Always requires approval.",
    locked: true,
    defaultOn: true
  },
  {
    id: "deletions",
    title: "Deletions and security changes",
    description: "Removing data or changing permissions. Always requires approval.",
    locked: true,
    defaultOn: true
  }
];

const PERMISSIONS_KEY = "permissions";

export type PermissionState = Record<string, boolean>;

export function defaultPermissions(): PermissionState {
  const state: PermissionState = {};
  for (const category of PERMISSION_CATEGORIES) state[category.id] = category.defaultOn;
  return state;
}

export function loadPermissions(): PermissionState {
  const stored = read<PermissionState>(PERMISSIONS_KEY, {});
  const merged = defaultPermissions();
  for (const category of PERMISSION_CATEGORIES) {
    // Locked categories are always on regardless of stored value.
    if (category.locked) {
      merged[category.id] = true;
    } else {
      const value = stored[category.id];
      if (typeof value === "boolean") merged[category.id] = value;
    }
  }
  return merged;
}

export function savePermissions(state: PermissionState): PermissionState {
  const next = loadPermissions();
  for (const category of PERMISSION_CATEGORIES) {
    if (category.locked) continue;
    const value = state[category.id];
    if (typeof value === "boolean") next[category.id] = value;
  }
  write(PERMISSIONS_KEY, next);
  return next;
}

// Token display -------------------------------------------------------------

// The monthly allowance is tracked internally as a usage budget. For the user
// we present it as a plain monthly token balance, never as a money figure and
// never tied to any provider name.
export function tokensFromBudget(internalUnits: number): number {
  return Math.max(0, Math.round(internalUnits));
}

export function formatTokens(internalUnits: number): string {
  const tokens = tokensFromBudget(internalUnits);
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(2))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Time formatting ------------------------------------------------------------

export function formatAbsoluteTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}
