'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// When a task runs on its own.
//
// A schedule is a task, a spec that says when, and the one number that makes
// the whole thing work: `nextRunAt`. It is computed from the spec and written
// to disk, so the tick is a numeric comparison rather than a re-parse, and so a
// schedule survives a restart knowing exactly what it was waiting for.
//
// Record keeping only. When to fire, what to do about an agent that is not
// there, and what to do with time that passed while the app was closed all live
// in scheduler.js.

const SCHEDULE_ID_PREFIX = 'sched:';

function newScheduleId() {
  return `${SCHEDULE_ID_PREFIX}${crypto.randomUUID()}`;
}

function isScheduleId(id) {
  return typeof id === 'string' && id.startsWith(SCHEDULE_ID_PREFIX);
}

// Fills in what a record from an older build does not have. In memory only and
// not saved, the way the session and task registries do it.
function normalize(record) {
  if (record.enabled === undefined) record.enabled = true;
  if (typeof record.missed !== 'number') record.missed = 0;
  if (record.nextRunAt === undefined) record.nextRunAt = null;
  return record;
}

class ScheduleRegistry {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'schedules.json');
    this.records = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((r) => r && isScheduleId(r.id)).map(normalize) : [];
    } catch {
      return [];
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2), 'utf8');
    } catch (err) {
      console.error('[schedules] save failed:', err.message);
    }
  }

  // Soonest first, with the ones that are never going to fire at the bottom: a
  // list of schedules is read to find out what happens next.
  list() {
    return this.records.slice().sort((a, b) => {
      const an = a.enabled && a.nextRunAt ? a.nextRunAt : Infinity;
      const bn = b.enabled && b.nextRunAt ? b.nextRunAt : Infinity;
      return an - bn || (a.createdAt || 0) - (b.createdAt || 0);
    });
  }

  get(id) {
    return this.records.find((r) => r.id === id) || null;
  }

  forTask(taskId) {
    return this.records.filter((r) => r.taskId === taskId);
  }

  create({ taskId, spec, nextRunAt }) {
    const now = Date.now();
    const record = {
      id: newScheduleId(),
      taskId,
      spec,
      enabled: true,
      nextRunAt: nextRunAt ?? null,
      lastFireAt: null,
      lastResult: null,
      lastDetail: null,
      // Occurrences that came and went while the app was not running. Counted
      // rather than replayed — see the argument in scheduler.js.
      missed: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.#save();
    return record;
  }

  // Field by field rather than a spread, for the reason the task registry
  // patches that way: this arrives from the renderer, and `lastResult` and
  // `missed` are not the window's to write.
  update(id, patch = {}) {
    const record = this.get(id);
    if (!record) return null;
    if (patch.spec !== undefined) record.spec = patch.spec;
    if (patch.taskId !== undefined) record.taskId = patch.taskId;
    if (patch.enabled !== undefined) record.enabled = Boolean(patch.enabled);
    if (patch.nextRunAt !== undefined) record.nextRunAt = patch.nextRunAt;
    record.updatedAt = Date.now();
    this.#save();
    return record;
  }

  // What firing does to the record. Kept apart from update() so that the two
  // sets of fields have two doors, and only one of them faces the window.
  markFire(id, patch = {}) {
    const record = this.get(id);
    if (!record) return null;
    for (const key of ['lastFireAt', 'lastResult', 'lastDetail', 'nextRunAt', 'enabled']) {
      if (patch[key] !== undefined) record[key] = patch[key];
    }
    if (patch.missed) record.missed += patch.missed;
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

  // A task that has been deleted takes its schedules with it. A schedule with
  // no task is a clock with nothing on the other end of it — it would fire
  // forever, refuse every time, and there would be no way to reach it to stop.
  removeForTask(taskId) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.taskId !== taskId);
    if (this.records.length === before) return 0;
    this.#save();
    return before - this.records.length;
  }
}

module.exports = { ScheduleRegistry, isScheduleId, newScheduleId };
