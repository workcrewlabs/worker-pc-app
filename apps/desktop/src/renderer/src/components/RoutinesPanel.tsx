import { useState } from "react";
import type { ModelTier } from "@workcrew/contracts";
import type { AutomationRunner } from "../hooks/useAutomationRunner";
import {
  addRoutine,
  describeCadence,
  removeRoutine,
  updateRoutine,
  type Routine,
  type RoutineCadence
} from "../lib/storage";
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
  runner,
  model,
  routines,
  onChange,
  onClose,
  initialTask = ""
}: {
  runner: AutomationRunner;
  model: ModelTier;
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

  const timed = cadence === "daily" || cadence === "weekdays" || cadence === "weekly";
  const canSave = name.trim().length > 0 && task.trim().length >= 3;

  function save() {
    if (!canSave) return;
    onChange(addRoutine({ name: name.trim(), task: task.trim(), cadence, hour, minute, weekday, enabled: true }));
    setName("");
    setTask("");
  }

  function runNow(routine: Routine) {
    if (runner.running) return;
    void runner.run(routine.task, model, routine.name);
  }

  return (
    <PanelShell title="Routines" subtitle="Save a task and have WorkCrew run it on a schedule." onClose={onClose}>
      <div className="save-form">
        <label className="field-label" htmlFor="routine-name">New routine</label>
        <input id="routine-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, for example Morning email summary" />
        <textarea
          className="automation-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="What should it do? For example: open my email and summarize the unread messages"
          rows={2}
        />
        <div className="routine-schedule">
          <select value={cadence} onChange={(event) => setCadence(event.target.value as RoutineCadence)} aria-label="How often">
            {CADENCES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {cadence === "weekly" && (
            <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} aria-label="Day of week">
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={index}>{day}</option>
              ))}
            </select>
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
          <button className="primary" onClick={save} disabled={!canSave}>Save routine</button>
        </div>
        <p className="field-hint">Routines run while WorkCrew is open, and ask before any change just like a normal task.</p>
      </div>

      {(runner.running || runner.summary) && (
        <div className={`automation-summary ${runner.status}`} role="status">
          <strong>{runner.label || "Routine"}: {runner.running ? "Running..." : runner.status === "complete" ? "Done" : "Stopped"}</strong>
          {runner.summary && <p>{runner.summary}</p>}
        </div>
      )}

      {routines.length === 0 ? (
        <div className="empty-state">
          <strong>No routines yet</strong>
          <p>Save a task above to run it on a schedule.</p>
        </div>
      ) : (
        <ul className="record-list">
          {routines.map((routine) => (
            <li key={routine.id} className="record-row">
              <div className="record-main">
                <p className="record-task"><strong>{routine.name}</strong></p>
                <p className="record-sub">{routine.task}</p>
                <div className="record-meta"><span>{describeCadence(routine)}{routine.enabled ? "" : " (paused)"}</span></div>
              </div>
              <div className="record-actions">
                <button className="primary small" onClick={() => runNow(routine)} disabled={runner.running}>Run now</button>
                <button
                  className="link-button"
                  onClick={() => onChange(updateRoutine(routine.id, { enabled: !routine.enabled }))}
                >
                  {routine.enabled ? "Pause" : "Resume"}
                </button>
                <button className="link-button" onClick={() => onChange(removeRoutine(routine.id))} aria-label={`Remove ${routine.name}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}
