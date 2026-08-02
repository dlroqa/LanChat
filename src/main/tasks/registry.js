'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The list of standing jobs: an agent, an instruction, and what happened last
// time it was run.
//
// A task is a session turned inside out. A session is a conversation you are
// having, so its record is small and its transcript is the substance; a task is
// one question asked over and over, so the question is the record and each
// answer is a run beside it. That is why the instruction lives here and the
// answers do not — see runs.js.
//
// Record keeping only. Whether an agent can be asked, what happens when it
// answers, and what a schedule does with any of it are all decided one layer up
// in index.js, the same split sessions makes.

const TASK_ID_PREFIX = 'task:';

const DEFAULT_TITLE = 'New task';

// One line in a narrow column, the same bound a session title has.
const MAX_TITLE = 80;

// An instruction is a paragraph, not a document. Long enough for a real brief,
// short enough that a record file stays a record file — anything that needs
// more than this is a conversation, and sessions are what those are for.
const MAX_INSTRUCTION = 8000;

// What a task is doing, as far as this machine knows.
//
//   idle    — never run, or run and long since finished being interesting
//   working — asked, and the answer has not come back
//   done    — the last run answered
//   failed  — the last run errored, or nobody would take it
const STATUSES = ['idle', 'working', 'done', 'failed'];

function newTaskId() {
  return `${TASK_ID_PREFIX}${crypto.randomUUID()}`;
}

// A task is a purely local construct: no presence, no key, no address, and
// nothing off the wire may ever claim to be one. The guard in ipc.js reads this
// rather than the prefix, for the reason the session guard does.
function isTaskId(id) {
  return typeof id === 'string' && id.startsWith(TASK_ID_PREFIX);
}

function cleanTitle(title) {
  const flat = String(title == null ? '' : title)
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? flat.slice(0, MAX_TITLE) : DEFAULT_TITLE;
}

// Newlines are kept — an instruction is prose and a list of steps is a normal
// shape for one. Only the ends are trimmed and the length is bounded.
function cleanInstruction(text) {
  return String(text == null ? '' : text)
    .trim()
    .slice(0, MAX_INSTRUCTION);
}

// The name a task gets when nobody gives it one: the first line of what it
// asks. A list of tasks all called "New task" is a list of nothing.
function titleFrom(instruction) {
  for (const line of String(instruction || '').split('\n')) {
    const flat = line.replace(/\s+/g, ' ').trim();
    if (flat) return flat.slice(0, MAX_TITLE);
  }
  return DEFAULT_TITLE;
}

// Fills in what a record written by an older build does not have. In memory
// only and deliberately not saved, the way the session registry does it: a task
// this build merely read leaves tasks.json byte for byte as it was.
function normalize(record) {
  if (!STATUSES.includes(record.status)) record.status = 'idle';
  if (typeof record.runCount !== 'number') record.runCount = 0;
  if (record.agentId === undefined) record.agentId = null;
  return record;
}

class TaskRegistry {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'tasks.json');
    this.records = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((r) => r && isTaskId(r.id)).map(normalize) : [];
    } catch {
      return [];
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (err) {
      console.error('[tasks] save failed:', err.message);
    }
  }

  // Newest first, by when the record last moved. A task that has just run is
  // the one most likely to be wanted.
  list() {
    return this.records.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  create({ title, agentId, instruction } = {}) {
    const now = Date.now();
    const asked = cleanInstruction(instruction);
    const record = {
      id: newTaskId(),
      title: title == null ? titleFrom(asked) : cleanTitle(title),
      agentId: typeof agentId === 'string' && agentId ? agentId : null,
      instruction: asked,
      status: 'idle',
      lastRunAt: null,
      lastEndedAt: null,
      lastResult: null,
      lastDetail: null,
      lastChars: 0,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.#save();
    return record;
  }

  // Field by field rather than a spread: a patch arrives from the renderer, and
  // a blind merge would let it write `status`, `runCount` or an id — none of
  // which are the window's to decide.
  update(id, patch = {}) {
    const record = this.get(id);
    if (!record) return null;
    if (patch.title !== undefined) record.title = cleanTitle(patch.title);
    if (patch.instruction !== undefined) {
      record.instruction = cleanInstruction(patch.instruction);
      // A task that was never named follows its instruction, so the row keeps
      // saying what the task is while it is being written.
      if (!patch.title && record.title === DEFAULT_TITLE) record.title = titleFrom(record.instruction);
    }
    if (patch.agentId !== undefined) {
      record.agentId = typeof patch.agentId === 'string' && patch.agentId ? patch.agentId : null;
    }
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  // What a run does to the record. Separate from update() on purpose: these are
  // fields main owns, and keeping them out of the patched set above is what
  // stops a window claiming its task succeeded.
  markRun(id, patch = {}) {
    const record = this.get(id);
    if (!record) return null;
    for (const key of ['status', 'lastRunAt', 'lastEndedAt', 'lastResult', 'lastDetail', 'lastChars']) {
      if (patch[key] !== undefined) record[key] = patch[key];
    }
    if (patch.countRun) record.runCount += 1;
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  remove(id) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    this.#save();
    return true;
  }

  // An agent that has been removed cannot go on being the one a task asks. The
  // task is kept — the instruction is the work, and the agent is a choice that
  // can be made again — but it is left pointing at nobody rather than at a
  // record that no longer exists.
  unbindAgent(agentId) {
    let changed = false;
    for (const record of this.records) {
      if (record.agentId !== agentId) continue;
      record.agentId = null;
      record.updatedAt = Date.now();
      changed = true;
    }
    if (changed) this.#save();
    return changed;
  }
}

module.exports = {
  TaskRegistry,
  isTaskId,
  newTaskId,
  titleFrom,
  DEFAULT_TITLE,
  MAX_TITLE,
  MAX_INSTRUCTION,
  STATUSES,
};
