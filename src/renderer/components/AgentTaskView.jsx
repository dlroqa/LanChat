import React, { useEffect, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import { Plus, Trash, Play, Stop, X, Dot } from '../lib/icons.jsx';
import { useAutosave } from '../lib/useAutosave.js';

// Agent tasks: one instruction, put to one agent, whenever you want it put.
//
// The list, and the task you have opened — the same two faces the notes view
// has, for the same reason: there is no room in this column for both at once.
//
// The answer is shown here and appears nowhere else. A task is not a
// conversation, so there is no thread for it to be appended to; what an opened
// task shows is the last run, read on demand, plus whatever is being written
// right now if the run is still going.
//
// Nothing about a run is decided here. Whether an agent can be asked, and what
// to say when it cannot, are main's — the refusal comes back with the sentence
// already in it, so this view never has to work out why something did not
// happen.

// What each status looks like in a row, and what it is called. `working` gets
// the accent because it is the one that is going to change on its own.
const MARKS = {
  idle: { className: 'task-dot', label: 'Not run yet' },
  working: { className: 'task-dot working', label: 'Running' },
  done: { className: 'task-dot done', label: 'Answered' },
  failed: { className: 'task-dot failed', label: 'Failed' },
};

function markFor(task) {
  return MARKS[task.status] || MARKS.idle;
}

// What a row says under its title: who it asks, and how the last run went.
function subtitleFor(task, agentName) {
  const who = agentName || 'No agent';
  if (task.status === 'working') return `${who} · running`;
  if (task.lastResult === 'answer') return `${who} · answered`;
  if (task.lastResult === 'empty') return `${who} · answered with nothing`;
  if (task.status === 'failed') return `${who} · ${task.lastDetail || 'failed'}`;
  return who;
}

export default function AgentTaskView({
  tasks = [],
  agents = [],
  streams = {},
  onCreate,
  onUpdate,
  onRun,
  onStop,
  onDelete,
  onRuns,
}) {
  const [openId, setOpenId] = useState(null);
  // What is in the two text fields. Held here rather than read straight off the
  // record for the reason the notes editor holds a draft: the save is debounced,
  // and a field whose value came back from disk a beat behind the keyboard
  // would drop letters. `null` means nothing has been typed since it opened, so
  // the record is what to show.
  const [draft, setDraft] = useState(null);
  // The last run of the open task, fetched when it is opened. Not carried on
  // the list: an answer is unbounded text, and a list channel that carried
  // every one of them would be sending every answer to draw a column of titles.
  const [runs, setRuns] = useState([]);
  // A refusal to show. Cleared the moment anything else happens, because it is
  // about one press of one button and nothing else.
  const [refusal, setRefusal] = useState(null);

  const record = tasks.find((t) => t.id === openId) || null;
  const open = record && { ...record, ...(draft || {}) };
  const nameFor = (id) => (agents.find((a) => a.id === id) || {}).name || null;

  // An instruction is typed a character at a time and lives in a file that is
  // rewritten whole and republished to this window. Saving on every keystroke
  // would mean doing all of that thirty times a sentence — and the re-render it
  // caused would land under the cursor. So the same discipline the notes
  // editor uses, from the same place.
  const { queue, flush } = useAutosave((id, patch) => onUpdate(id, patch));

  const edit = (patch) => {
    if (!record) return;
    setDraft((d) => {
      const next = { title: open.title, instruction: open.instruction, ...d, ...patch };
      queue(record.id, next);
      return next;
    });
  };

  const leave = () => {
    flush();
    setDraft(null);
    setOpenId(null);
  };

  // When the open record last moved. Re-reading the answers is keyed on this,
  // which is how a run that finishes while the task is open puts its result on
  // the screen: main publishes the record, the timestamp changes, and the run
  // it wrote is fetched. Pulled out of the dependency array rather than
  // computed in it so it is a value the linter can check.
  const openUpdatedAt = record ? record.updatedAt : null;
  useEffect(() => {
    if (!openId) {
      setRuns([]);
      return undefined;
    }
    let live = true;
    onRuns(openId).then((list) => live && setRuns(list || []));
    return () => {
      live = false;
    };
  }, [openId, onRuns, openUpdatedAt]);

  const start = async (id) => {
    setRefusal(null);
    // What is in the field is what gets asked. Running with a debounced edit
    // still in flight would put the previous version of the instruction to the
    // agent, which is the one bug this view could have that nobody would spot —
    // so the write is awaited rather than merely started.
    await flush();
    const result = await onRun(id);
    // `ok` false is not a failure of the app: it is main saying this could not
    // be run, and saying why in words meant to be shown.
    if (result && result.ok === false) setRefusal({ id, detail: result.detail });
  };

  const create = async () => {
    flush();
    const task = await onCreate();
    if (task) {
      setDraft(null);
      setOpenId(task.id);
    }
  };

  const remove = (id) => {
    // Flushed first, then deleted: a write landing after the delete would be a
    // write to a record that has stopped existing.
    flush();
    if (id === openId) {
      setDraft(null);
      setOpenId(null);
    }
    onDelete(id);
  };

  if (open) {
    const running = open.status === 'working';
    // What the agent is writing at this moment, keyed by the task's own id —
    // which is the thread it was asked under. Nothing plumbs this specially;
    // it is what asking under the task's id already produces.
    const live = Object.values(streams[open.id] || {}).join('');
    const last = runs[0];

    return (
      <div className="task-editor">
        <div className="task-editor-head">
          <button
            type="button"
            className="icon-btn"
            onClick={leave}
            title="Back to tasks"
            aria-label="Back to tasks"
          >
            <X size={17} />
          </button>
          <input
            className="task-title"
            value={open.title}
            onChange={(e) => edit({ title: e.target.value })}
            onBlur={flush}
            placeholder="New task"
            aria-label="Task name"
          />
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => remove(open.id)}
            title="Delete this task"
            aria-label="Delete this task"
          >
            <Trash size={17} />
          </button>
        </div>

        <div className="task-editor-body">
          <label className="task-field">
            <span>Agent</span>
            <select
              value={open.agentId || ''}
              // A discrete choice, so it is written at once rather than
              // debounced — but after whatever is waiting in the text fields,
              // or the two writes would land in the wrong order.
              onChange={(e) => {
                flush();
                onUpdate(open.id, { agentId: e.target.value || null });
              }}
            >
              <option value="">Nobody yet</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.remote && a.viaName ? ` (via ${a.viaName})` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="task-field">
            <span>What it should do</span>
            <textarea
              className="task-instruction"
              value={open.instruction}
              onChange={(e) => edit({ instruction: e.target.value })}
              onBlur={flush}
              placeholder="Check whether the nightly build passed and summarise the failures."
            />
          </label>

          {refusal && refusal.id === open.id ? <p className="task-refusal">{refusal.detail}</p> : null}

          <div className="task-actions">
            {running ? (
              <button type="button" className="btn" onClick={() => onStop(open.id)}>
                <Stop size={15} />
                <span>Stop</span>
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => start(open.id)}>
                <Play size={15} />
                <span>Run</span>
              </button>
            )}
            <span className="task-run-count">
              {open.runCount ? `${open.runCount} run${open.runCount === 1 ? '' : 's'}` : 'Never run'}
            </span>
          </div>

          {/* What came back. The live text while it is being written, then the
              run itself — one replacing the other rather than both at once,
              which would show the same answer twice. */}
          {running && live ? (
            <div className="task-answer live">
              <div className="task-answer-head">Writing…</div>
              <pre>{live}</pre>
            </div>
          ) : last ? (
            <div className={`task-answer${last.ok ? '' : ' bad'}`}>
              <div className="task-answer-head">
                {last.ok ? 'Answer' : last.kind === 'empty' ? 'Answered with nothing' : 'Failed'}
                {last.by && last.by !== 'manual' ? ' · on a schedule' : ''}
              </div>
              {last.text ? <pre>{last.text}</pre> : <p className="task-answer-none">{last.detail || '—'}</p>}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="task-list">
      <div className="task-list-head">
        <span className="task-count">
          {tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}` : 'No tasks'}
        </span>
        <button type="button" className="icon-btn" onClick={create} title="New task" aria-label="New task">
          <Plus size={17} />
        </button>
      </div>

      {tasks.length === 0 ? (
        <EmptyState title="No tasks yet">Give an agent a standing job and run it from here.</EmptyState>
      ) : (
        <div className="task-rows">
          {tasks.map((task) => {
            const mark = markFor(task);
            return (
              <div className="task-row" key={task.id}>
                <button type="button" className="task-row-face" onClick={() => setOpenId(task.id)}>
                  <span className={mark.className} aria-hidden="true">
                    <Dot size={10} />
                  </span>
                  <span className="task-row-meta">
                    <span className="task-row-title">{task.title}</span>
                    <span className="task-row-sub">{subtitleFor(task, nameFor(task.agentId))}</span>
                  </span>
                  {/* The status is a coloured dot, which says nothing to a
                      reader — so it is also a word, out of the way of the eye. */}
                  <span className="sr-only">{mark.label}</span>
                </button>
                <div className="task-row-actions">
                  {task.status === 'working' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onStop(task.id)}
                      title="Stop"
                      aria-label={`Stop ${task.title}`}
                    >
                      <Stop size={15} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => start(task.id)}
                      title="Run now"
                      aria-label={`Run ${task.title} now`}
                    >
                      <Play size={15} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {refusal && !tasks.some((t) => t.id === refusal.id && t.status === 'working') ? (
        <p className="task-refusal">{refusal.detail}</p>
      ) : null}
    </div>
  );
}
