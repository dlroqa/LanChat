'use strict';

const fs = require('node:fs');
const path = require('node:path');

// What came back, each time a task was run.
//
// One file per task, for the reason note bodies are one file per note: an
// answer is unbounded text, and answers kept in tasks.json would mean rewriting
// every task's record to record one reply. The list has to stay small enough to
// republish to the window on every change; the answers do not.
//
// A run is history rather than state. Nothing here is consulted to decide what
// to do next — that is the in-memory bookkeeping in index.js — so a file that
// cannot be read is an empty history and not a failure to run anything.

// How many runs of one task are kept. Enough to see whether something has been
// failing since Tuesday, few enough that a task fired every hour by a schedule
// cannot fill a disk. The oldest fall off the front.
const MAX_RUNS = 20;

class TaskRunStore {
  constructor(userDataDir) {
    this.dir = path.join(userDataDir, 'task-runs');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // The same sanitising MessageStore does, so an id that somehow arrived with a
  // path separator in it cannot name a file outside this directory.
  fileFor(taskId) {
    const safe = String(taskId).replace(/[^\w.\-]+/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  // Newest first: what happened last time is the question anybody has.
  read(taskId, limit = MAX_RUNS) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(taskId), 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(-Math.max(1, limit)).reverse();
    } catch {
      return [];
    }
  }

  append(taskId, run) {
    let list = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(taskId), 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // No history yet, which is what a task's first run has.
    }
    list.push(run);
    try {
      fs.writeFileSync(this.fileFor(taskId), JSON.stringify(list.slice(-MAX_RUNS)), 'utf8');
    } catch (err) {
      console.error('[tasks] run save failed:', err.message);
    }
    return run;
  }

  // Deleting a task takes its answers with it. One left behind is bytes on disk
  // that nothing points at and nothing will ever clean up.
  clear(taskId) {
    try {
      fs.rmSync(this.fileFor(taskId), { force: true });
    } catch (err) {
      console.error('[tasks] run clear failed:', err.message);
    }
  }
}

module.exports = { TaskRunStore, MAX_RUNS };
