import React, { useEffect, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import { Plus, Trash, X, Clock } from '../lib/icons.jsx';

// Scheduled tasks: a task, and when it should run on its own.
//
// Three ways to say when, and they are three ways rather than one because they
// are three different intentions. A one-off is a reminder. A preset is a habit.
// A cron expression is for the person who already knows what they want and
// would be slowed down by being asked in pieces.
//
// Whichever is used, the panel shows the next few times it would actually
// happen, and that preview is the whole of the validation. Main runs the same
// walker the scheduler will, so what is shown here is what will happen — which
// is worth more than any amount of checking the syntax, because a cron
// expression that parses and means the wrong thing is the failure that
// actually occurs.
//
// A schedule with no task is not offered at all: there is nothing for it to
// run, and a clock with nothing on the other end of it is not a feature.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A local datetime for `datetime-local`, which wants no timezone and no
// seconds. Built by hand rather than through toISOString, which would convert
// to UTC and show somebody a time they did not pick.
function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function whenText(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay
    ? `Today at ${time}`
    : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

// How a schedule's last firing reads in a row. Every one of these is a sentence
// main wrote, because main is the one awake when they happen.
function lastText(schedule) {
  if (!schedule.lastFireAt) return null;
  if (schedule.lastResult === 'ran') return `Last ran ${whenText(schedule.lastFireAt)}`;
  return schedule.lastDetail || 'Did not run';
}

const DEFAULT_SPEC = { kind: 'every', preset: 'daily', hour: 9, minute: 0, weekday: 1 };

export default function ScheduledTaskView({
  schedules = [],
  tasks = [],
  onCreate,
  onUpdate,
  onToggle,
  onDelete,
  onPreview,
}) {
  // `null` is the list; a schedule id is that one being edited; 'new' is one
  // being written that does not exist yet.
  const [editing, setEditing] = useState(null);
  const [spec, setSpec] = useState(DEFAULT_SPEC);
  const [taskId, setTaskId] = useState('');
  const [preview, setPreview] = useState(null);

  const open = schedules.find((s) => s.id === editing) || null;
  const titleFor = (id) => (tasks.find((t) => t.id === id) || {}).title || 'a task that is gone';

  // What this spec would actually do, asked of main on every change. The one
  // piece of validation there is, and the only one worth having.
  useEffect(() => {
    if (!editing) {
      setPreview(null);
      return undefined;
    }
    let live = true;
    onPreview(spec).then((result) => live && setPreview(result));
    return () => {
      live = false;
    };
  }, [editing, spec, onPreview]);

  const startNew = () => {
    setSpec(DEFAULT_SPEC);
    setTaskId(tasks[0] ? tasks[0].id : '');
    setEditing('new');
  };

  const edit = (schedule) => {
    setSpec(schedule.spec || DEFAULT_SPEC);
    setTaskId(schedule.taskId);
    setEditing(schedule.id);
  };

  const close = () => {
    setEditing(null);
    setPreview(null);
  };

  const save = async () => {
    // The button is disabled without these, but `disabled` is presentation and
    // this is the rule: a schedule that cannot be read would be saved and then
    // silently never fire, which is the one failure here that nobody notices.
    if (!taskId || !(preview && preview.ok)) return;
    const result =
      editing === 'new' ? await onCreate(taskId, spec) : await onUpdate(editing, { taskId, spec });
    // A refusal stays on the form rather than closing it: the spec somebody
    // typed is still in front of them to fix.
    if (result && result.ok === false) {
      setPreview({ ok: false, error: result.error });
      return;
    }
    close();
  };

  if (editing) {
    const kind = spec.kind || 'every';
    const set = (patch) => setSpec((s) => ({ ...s, ...patch }));

    return (
      <div className="sched-editor">
        <div className="sched-editor-head">
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            title="Back"
            aria-label="Back to schedules"
          >
            <X size={17} />
          </button>
          <span className="sched-editor-title">{editing === 'new' ? 'New schedule' : 'Schedule'}</span>
          {open ? (
            <button
              type="button"
              className="icon-btn danger"
              onClick={() => {
                onDelete(open.id);
                close();
              }}
              title="Delete this schedule"
              aria-label="Delete this schedule"
            >
              <Trash size={17} />
            </button>
          ) : null}
        </div>

        <div className="sched-editor-body">
          <label className="task-field">
            <span>Task</span>
            <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">Pick a task</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>

          <div className="task-field">
            <span>When</span>
            <div className="sched-kinds" role="radiogroup" aria-label="How often">
              {[
                ['once', 'Once'],
                ['every', 'Repeats'],
                ['cron', 'Cron'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={kind === id}
                  className={`sched-kind${kind === id ? ' on' : ''}`}
                  onClick={() =>
                    setSpec(
                      id === 'once'
                        ? { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
                        : id === 'cron'
                          ? { kind: 'cron', expr: '0 9 * * 1-5' }
                          : DEFAULT_SPEC
                    )
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {kind === 'once' ? (
            <label className="task-field">
              <span>At</span>
              <input
                type="datetime-local"
                value={toLocalInput(spec.at || Date.now())}
                onChange={(e) => {
                  const at = new Date(e.target.value).getTime();
                  if (Number.isFinite(at)) set({ at });
                }}
              />
            </label>
          ) : null}

          {kind === 'every' ? (
            <>
              <label className="task-field">
                <span>How often</span>
                <select value={spec.preset || 'daily'} onChange={(e) => set({ preset: e.target.value })}>
                  <option value="hourly">Every hour</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                </select>
              </label>
              {spec.preset === 'weekly' ? (
                <label className="task-field">
                  <span>On</span>
                  <select
                    value={spec.weekday ?? 1}
                    onChange={(e) => set({ weekday: Number(e.target.value) })}
                  >
                    {WEEKDAYS.map((name, i) => (
                      <option key={name} value={i}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="task-field">
                <span>{spec.preset === 'hourly' ? 'At minute' : 'At'}</span>
                <input
                  type="time"
                  value={`${String(spec.preset === 'hourly' ? 0 : (spec.hour ?? 9)).padStart(2, '0')}:${String(spec.minute ?? 0).padStart(2, '0')}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(':').map(Number);
                    if (Number.isFinite(h) && Number.isFinite(m)) set({ hour: h, minute: m });
                  }}
                />
              </label>
            </>
          ) : null}

          {kind === 'cron' ? (
            <label className="task-field">
              <span>Expression</span>
              <input
                className="sched-cron"
                value={spec.expr || ''}
                onChange={(e) => set({ expr: e.target.value })}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
          ) : null}

          {/* The next few times it would actually happen. Main runs the same
              walker the scheduler will, so this is not a guess about the spec —
              it is the spec, answered. */}
          <div className={`sched-preview${preview && preview.ok === false ? ' bad' : ''}`}>
            {preview && preview.ok ? (
              <>
                <div className="sched-preview-head">{preview.describes}</div>
                <ul>
                  {preview.next.map((ms) => (
                    <li key={ms}>{whenText(ms)}</li>
                  ))}
                </ul>
              </>
            ) : preview ? (
              <div className="sched-preview-head">{preview.error}</div>
            ) : (
              <div className="sched-preview-head">…</div>
            )}
          </div>

          <div className="task-actions">
            <button
              type="button"
              className="btn primary"
              onClick={save}
              disabled={!taskId || !(preview && preview.ok)}
            >
              <span>{editing === 'new' ? 'Schedule it' : 'Save'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sched-list">
      <div className="task-list-head">
        <span className="task-count">
          {schedules.length ? `${schedules.length} scheduled` : 'Nothing scheduled'}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={startNew}
          // Nothing to schedule is a reason to say so, not to offer a form that
          // cannot be filled in.
          disabled={tasks.length === 0}
          title={tasks.length === 0 ? 'Write a task first' : 'New schedule'}
          aria-label={tasks.length === 0 ? 'Write a task first' : 'New schedule'}
        >
          <Plus size={17} />
        </button>
      </div>

      {schedules.length === 0 ? (
        <EmptyState title="Nothing scheduled">
          {tasks.length === 0
            ? 'Write an agent task first, then set when it should run on its own.'
            : 'Set an agent task to run on its own — once, on a repeat, or on a cron expression.'}
        </EmptyState>
      ) : (
        <div className="task-rows">
          {schedules.map((schedule) => {
            const last = lastText(schedule);
            return (
              <div className="task-row" key={schedule.id}>
                <button type="button" className="task-row-face" onClick={() => edit(schedule)}>
                  <span className={`task-dot${schedule.enabled ? ' done' : ''}`} aria-hidden="true">
                    <Clock size={12} />
                  </span>
                  <span className="task-row-meta">
                    <span className="task-row-title">{titleFor(schedule.taskId)}</span>
                    <span className="task-row-sub">
                      {schedule.enabled ? whenText(schedule.nextRunAt) || 'No next time' : 'Off'}
                      {schedule.missed ? ` · ${schedule.missed} missed` : ''}
                    </span>
                    {last ? <span className="task-row-sub">{last}</span> : null}
                  </span>
                </button>
                <div className="task-row-actions">
                  <button
                    type="button"
                    className={`icon-btn${schedule.enabled ? ' on' : ''}`}
                    onClick={() => onToggle(schedule.id, !schedule.enabled)}
                    aria-pressed={schedule.enabled}
                    title={schedule.enabled ? 'Switch off' : 'Switch on'}
                    aria-label={`${schedule.enabled ? 'Switch off' : 'Switch on'} the schedule for ${titleFor(schedule.taskId)}`}
                  >
                    <Clock size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => onDelete(schedule.id)}
                    title="Delete this schedule"
                    aria-label={`Delete the schedule for ${titleFor(schedule.taskId)}`}
                  >
                    <Trash size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
