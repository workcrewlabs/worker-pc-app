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

// Working folders ----------------------------------------------------------
// The folder each conversation is working in, kept so reopening a saved
// conversation restores its folder (and keeps routing to the command engine).

export type WorkingFolder = { path: string; name: string };

const FOLDERS_KEY = "conversationFolders";

export function getConversationFolder(conversationId: string): WorkingFolder | null {
  const map = read<Record<string, WorkingFolder>>(FOLDERS_KEY, {});
  return map[conversationId] ?? null;
}

export function setConversationFolder(conversationId: string, folder: WorkingFolder | null): void {
  const map = read<Record<string, WorkingFolder>>(FOLDERS_KEY, {});
  if (folder) map[conversationId] = folder;
  else delete map[conversationId];
  write(FOLDERS_KEY, map);
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

// Routines (scheduled automations that run while WorkCrew is open) -----------

export type RoutineCadence = "manual" | "hourly" | "daily" | "weekdays" | "weekly";

export type Routine = {
  id: string;
  name: string;
  task: string;
  cadence: RoutineCadence;
  // Time of day for daily/weekdays/weekly, in local time.
  hour: number;
  minute: number;
  // Day of week (0 Sunday .. 6 Saturday) for weekly.
  weekday: number;
  enabled: boolean;
  lastRunAtMs: number | null;
  createdAtMs: number;
};

const ROUTINES_KEY = "routines";
const HOUR_MS = 60 * 60 * 1000;

export function loadRoutines(): Routine[] {
  return read<Routine[]>(ROUTINES_KEY, []);
}

export function addRoutine(input: Omit<Routine, "id" | "createdAtMs" | "lastRunAtMs">): Routine[] {
  const routine: Routine = { ...input, id: id(), lastRunAtMs: null, createdAtMs: Date.now() };
  const next = [routine, ...loadRoutines()];
  write(ROUTINES_KEY, next);
  return next;
}

export function updateRoutine(routineId: string, patch: Partial<Routine>): Routine[] {
  const next = loadRoutines().map((routine) => (routine.id === routineId ? { ...routine, ...patch } : routine));
  write(ROUTINES_KEY, next);
  return next;
}

export function removeRoutine(routineId: string): Routine[] {
  const next = loadRoutines().filter((routine) => routine.id !== routineId);
  write(ROUTINES_KEY, next);
  return next;
}

export function markRoutineRan(routineId: string, atMs: number): Routine[] {
  return updateRoutine(routineId, { lastRunAtMs: atMs });
}

/**
 * Whether a routine is due to run at nowMs. Pure and deterministic given its
 * inputs. Manual and disabled routines never run automatically. Hourly runs at
 * most once per hour. Time-of-day cadences run once on or after their scheduled
 * time, gated to weekdays or a chosen weekday, and not again until the next
 * eligible day.
 */
export function isRoutineDue(routine: Routine, nowMs: number): boolean {
  if (!routine.enabled || routine.cadence === "manual") return false;

  if (routine.cadence === "hourly") {
    return routine.lastRunAtMs === null || nowMs - routine.lastRunAtMs >= HOUR_MS;
  }

  const now = new Date(nowMs);
  const day = now.getDay();
  if (routine.cadence === "weekdays" && (day === 0 || day === 6)) return false;
  if (routine.cadence === "weekly" && day !== routine.weekday) return false;

  const scheduled = new Date(nowMs);
  scheduled.setHours(routine.hour, routine.minute, 0, 0);
  const scheduledMs = scheduled.getTime();
  if (nowMs < scheduledMs) return false;
  // Already ran on or after today's scheduled time.
  if (routine.lastRunAtMs !== null && routine.lastRunAtMs >= scheduledMs) return false;
  return true;
}

/** The first due routine at nowMs, or null. Routines are checked newest first. */
export function nextDueRoutine(routines: Routine[], nowMs: number): Routine | null {
  return routines.find((routine) => isRoutineDue(routine, nowMs)) ?? null;
}

// Friendly one-line schedule description for the routine list.
export function describeCadence(routine: Routine): string {
  const time = `${String(routine.hour).padStart(2, "0")}:${String(routine.minute).padStart(2, "0")}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (routine.cadence) {
    case "manual":
      return "Only when you run it";
    case "hourly":
      return "Every hour";
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `Every ${days[routine.weekday] ?? "week"} at ${time}`;
  }
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
    description: "Clicking, typing, and form entry inside the automated browser. Asked each time unless Always allow is on. Turn off to always be asked.",
    locked: false,
    defaultOn: true
  },
  {
    id: "windows-writes",
    title: "Windows actions",
    description: "Setting text and sending keystrokes to desktop apps. Asked each time unless Always allow is on. Turn off to always be asked.",
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
