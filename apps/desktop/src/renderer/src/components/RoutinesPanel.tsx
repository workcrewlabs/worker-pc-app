import { useState } from "react";
import {
  addRoutine,
  describeCadence,
  removeRoutine,
  updateRoutine,
  type Routine,
  type RoutineCadence
} from "../lib/storage";
import { track } from "../lib/analytics";
import { Dropdown } from "./Dropdown";
import { PanelShell } from "./PanelShell";

// Routines are saved tasks that run on a schedule while WorkCrew is open. The
// user can also run any routine immediately. Routines are stored locally; the
// scheduler that fires them lives in the workspace.

const CADENCES: { value: RoutineCadence; label: string }[] = [
  { value: "manual", label: "Only when I run it" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" }
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

// Turn a task sentence into a short, capitalized routine name as a default.
function deriveRoutineName(task: string): string {
  const cleaned = task.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  const short = cleaned.length > 44 ? `${cleaned.slice(0, 44)}...` : cleaned;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

// A typeable time field (hour or minute) with large up and down buttons that are
// easy to click. The arrows wrap around the ends (for example 23 up to 00).
function TimeStepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (value: number) => void; label: string }) {
  const wrap = (next: number): number => (next > max ? min : next < min ? max : next);
  const clampTyped = (next: number): number => Math.max(min, Math.min(max, Math.floor(next || 0)));
  return (
    <div className="time-stepper">
      <input
        type="number"
        className="time-input"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(clampTyped(Number(event.target.value)))}
        aria-label={label}
      />
      <div className="time-steps">
        <button type="button" className="time-step" aria-label={`Increase ${label}`} onClick={() => onChange(wrap(value + 1))}>▲</button>
        <button type="button" className="time-step" aria-label={`Decrease ${label}`} onClick={() => onChange(wrap(value - 1))}>▼</button>
      </div>
    </div>
  );
}

export function RoutinesPanel({
  onRun,
  busy,
  routines,
  onChange,
  onClose,
  initialTask = ""
}: {
  // Run a routine now. The workspace opens a fresh conversation for it and drives
  // it there, so a routine run behaves like any other computer task.
  onRun: (task: string, label: string) => void;
  // Whether a computer task is already running or paused (the machine is busy).
  busy: boolean;
  routines: Routine[];
  onChange: (next: Routine[]) => void;
  onClose: () => void;
  initialTask?: string;
}) {
  // Seeded from "Save as a routine" in the Automation panel, if any.
  const [name, setName] = useState(initialTask ? deriveRoutineName(initialTask) : "");
  const [task, setTask] = useState(initialTask);
  const [cadence, setCadence] = useState<RoutineCadence>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  // When set, the form is editing an existing routine rather than adding a new one.
  const [editingId, setEditingId] = useState<string | null>(null);

  const timed = cadence === "daily" || cadence === "weekdays" || cadence === "weekly";
  const canSave = name.trim().length > 0 && task.trim().length >= 3;

  function resetForm() {
    setEditingId(null);
    setName("");
    setTask("");
    setCadence("daily");
    setHour(9);
    setMinute(0);
    setWeekday(1);
  }

  function save() {
    if (!canSave) return;
    if (editingId) {
      onChange(updateRoutine(editingId, { name: name.trim(), task: task.trim(), cadence, hour, minute, weekday }));
    } else {
      onChange(addRoutine({ name: name.trim(), task: task.trim(), cadence, hour, minute, weekday, enabled: true }));
      // Schedule shape only; never the routine name or task text.
      track("routine_created", { cadence });
    }
    resetForm();
  }

  // Load a routine into the form so the user can change it and save it back.
  function startEdit(routine: Routine) {
    setEditingId(routine.id);
    setName(routine.name);
    setTask(routine.task);
    setCadence(routine.cadence);
    setHour(routine.hour);
    setMinute(routine.minute);
    setWeekday(routine.weekday);
  }

  function runNow(routine: Routine) {
    if (busy) return;
    onRun(routine.task, routine.name);
  }

  return (
    <PanelShell title="Routines" subtitle="Save a task and have WorkCrew run it on a schedule." onClose={onClose}>
      <div className="save-form">
        <label className="field-label" htmlFor="routine-name">{editingId ? "Edit routine" : "New routine"}</label>
        <input id="routine-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, for example Morning email summary" />
        <textarea
          className="automation-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="What should it do? For example: open my email and summarize the unread messages"
          rows={2}
        />
        <div className="routine-schedule">
          <Dropdown
            value={cadence}
            options={CADENCES}
            onChange={(value) => setCadence(value)}
            ariaLabel="How often"
          />
          {cadence === "weekly" && (
            <Dropdown
              value={String(weekday)}
              options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
              onChange={(value) => setWeekday(Number(value))}
              ariaLabel="Day of week"
            />
          )}
          {timed && (
            <>
              <TimeStepper value={hour} min={0} max={23} onChange={setHour} label="Hour" />
              <span className="colon">:</span>
              <TimeStepper value={minute} min={0} max={59} onChange={setMinute} label="Minute" />
            </>
          )}
        </div>
        <div className="save-row">
          <button className="primary" onClick={save} disabled={!canSave}>{editingId ? "Save changes" : "Save routine"}</button>
          {editingId && <button className="link-button" onClick={resetForm}>Cancel</button>}
        </div>
        <p className="field-hint">Routines run while WorkCrew is open, and ask before any change just like a normal task.</p>
      </div>

      {routines.length === 0 ? (
        <div className="empty-state">
          <strong>No routines yet</strong>
          <p>Save a task above to run it on a schedule.</p>
        </div>
      ) : (
        <ul className="routine-list">
          {routines.map((routine) => (
            <li key={routine.id} className={`routine-card ${routine.enabled ? "" : "is-paused"}`}>
              <div className="routine-info">
                <p className="routine-name">{routine.name}</p>
                <p className="routine-task">{routine.task}</p>
                <span className="routine-meta">{describeCadence(routine)}{routine.enabled ? "" : " · Paused"}</span>
              </div>
              <div className="routine-actions">
                <button className="primary small" onClick={() => runNow(routine)} disabled={busy}>Run now</button>
                <button className="icon-button" onClick={() => startEdit(routine)} aria-label={`Edit ${routine.name}`} title="Edit">
                  <PencilIcon />
                </button>
                <label className="toggle" title={routine.enabled ? "Pause" : "Resume"}>
                  <input
                    type="checkbox"
                    checked={routine.enabled}
                    onChange={() => onChange(updateRoutine(routine.id, { enabled: !routine.enabled }))}
                    aria-label={routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
                  />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
                <button className="icon-button danger" onClick={() => { track("routine_deleted"); onChange(removeRoutine(routine.id)); }} aria-label={`Remove ${routine.name}`} title="Remove">
                  <TrashIcon />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}
