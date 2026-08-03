'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Agent tasks: one instruction, asked whenever it is wanted.
//
// Two claims here are the feature, and both are about what does *not* happen.
//
// The first: an answer to a task goes onto the task and nowhere else. No
// transcript file is written, and no `chat` event reaches the window. Running a
// task must not be able to graffiti a conversation, and the only way to show
// that is to run one against a real agent and then look for the file and the
// event that would prove it had.
//
// The second: `task:` is a local namespace, so a frame off the wire claiming one
// is a peer trying to write a fabricated answer onto one of our records. That is
// tested in taskGuard.test.js, which forges the frame.
//
// Everything is driven through the IPC channels rather than the service,
// because the wiring is half of what is new.

const handlers = new Map();

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: {
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { buildIdentity } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { createIpc } = require('../src/main/ipc.js');
const { TaskRegistry } = require('../src/main/tasks/registry.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

// Agents that behave in the four ways a run can end.
function transports() {
  return {
    http: ({ id, name, config }) => ({
      id,
      name,
      kind: 'stub',
      start: async () => ({ detail: 'ready' }),
      send: async ({ text }, h) => {
        if (config.mode === 'empty') return h.onDone?.({ text: '' });
        if (config.mode === 'error') return h.onError?.(new Error('the connector fell over'));
        if (config.mode === 'silent') return undefined; // never answers
        h.onDelta?.('thinking…');
        return h.onDone?.({ text: `echo:${text}` });
      },
      stop: async () => {},
    }),
  };
}

function makeNode(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-tasks-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: 0 });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const store = new MessageStore(dir);
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: transports(),
  });

  const events = [];
  handlers.clear();
  createIpc({
    config,
    getIdentity,
    hub,
    bus,
    store,
    fileSender: { send: async () => ({}) },
    discovery: { peers: () => [], refresh: () => {} },
    updater: null,
    linkStats: null,
    pip: null,
    agentHub,
    outbox: { enqueue: () => {}, pendingCount: () => 0, counts: () => ({}) },
    userDataDir: dir,
    downloadsDir: path.join(dir, 'dl'),
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (_c, payload) => events.push(payload) },
    }),
    revealWindow: () => {},
    applyLoginItem: () => {},
    onUnread: () => {},
  });
  const own = new Map(handlers);
  const call = (channel, arg) => own.get(channel)(null, arg);
  return { dir, store, agentHub, call, events, hub, bus };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const pushed = (node, type) => node.events.filter((e) => e.type === type).map((e) => e.payload);
const runFile = (node, id) => path.join(node.dir, 'task-runs', `${id.replace(/[^\w.\-]+/g, '_')}.json`);

async function withAgent(node, mode = 'echo') {
  const { agent } = await node.agentHub.add({ name: `${mode}-agent`, kind: 'http', config: { mode } });
  return agent;
}

test('a task run answers onto the task, and into no conversation at all', async (t) => {
  const n = makeNode('answer');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', {
    agentId: agent.id,
    instruction: 'Check the disk and say how full it is.',
  });
  assert.match(task.id, /^task:/);
  // Unnamed tasks take their name from what they ask, so a list of them is not
  // a list of "New task".
  assert.equal(task.title, 'Check the disk and say how full it is.');

  const before = n.events.length;
  const result = await n.call('lanchat:runTask', { id: task.id });
  assert.equal(result.ok, true);
  // This stub answers inside the send call, which is the ordering hazard the
  // run is booked before the ask to survive: the reply lands while `run` is
  // still on the stack, and it is matched because there was already a run for
  // it to be matched to. A record booked afterwards would have found nothing
  // waiting and dropped the answer on the floor.
  assert.equal(result.task.status, 'done', 'the answer that arrived mid-ask was matched');
  await settle();

  // ---- the first of the two claims ----
  //
  // No transcript was written under the task's id. If a task's answer went
  // through the ordinary chat path, this file is what it would have created.
  assert.ok(!fs.existsSync(n.store.fileFor(task.id)), 'a task run wrote no conversation');
  assert.deepEqual(n.store.read(task.id), [], 'and there is no history to read back');
  // And no chat event reached the window, so nothing drew a bubble for it.
  const chats = n.events.slice(before).filter((e) => e.type === 'chat');
  assert.deepEqual(chats, [], 'no chat event was emitted');

  // What did happen: the record moved, and the answer is in the run file.
  const [record] = await n.call('lanchat:listTasks');
  assert.equal(record.status, 'done');
  assert.equal(record.lastResult, 'answer');
  assert.equal(record.runCount, 1);
  assert.ok(record.lastChars > 0);

  const [run] = await n.call('lanchat:taskRuns', { id: task.id });
  assert.equal(run.ok, true);
  assert.equal(run.kind, 'answer');
  assert.equal(run.text, 'echo:Check the disk and say how full it is.');
  assert.equal(run.agentId, agent.id);
  assert.equal(run.by, 'manual');
  assert.ok(run.endedAt >= run.startedAt);

  // The answers are in their own file, not in the list — the same split the
  // note bodies have, and for the same reason.
  const list = fs.readFileSync(path.join(n.dir, 'tasks.json'), 'utf8');
  assert.ok(!list.includes('echo:'), 'no answer text in tasks.json');
  assert.ok(fs.existsSync(runFile(n, task.id)));
});

test('the answer being written is streamed under the task, without becoming one', async (t) => {
  const n = makeNode('stream');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Say something' });
  await n.call('lanchat:runTask', { id: task.id });
  await settle();

  // The deltas already flow, keyed by thread — which for a task is its own id.
  // Nothing new plumbs this; it is what asking under the task's id buys.
  const deltas = n.events.filter((e) => e.type === 'agent-delta' && e.payload.threadId === task.id);
  assert.ok(deltas.length > 0, 'the window can watch it being written');
  // And a delta is not a message: still nothing on disk.
  assert.ok(!fs.existsSync(n.store.fileFor(task.id)));
});

test('an empty run and a failed run both end it, and say which they were', async (t) => {
  const n = makeNode('endings');
  t.after(() => n.agentHub.stopAll?.());

  const quiet = await withAgent(n, 'empty');
  const broken = await withAgent(n, 'error');

  const a = await n.call('lanchat:createTask', { agentId: quiet.id, instruction: 'Say nothing' });
  await n.call('lanchat:runTask', { id: a.id });
  await settle();
  const afterEmpty = await n.call('lanchat:listTasks');
  const emptied = afterEmpty.find((r) => r.id === a.id);
  assert.equal(emptied.status, 'failed', 'nothing came back, so nothing was answered');
  assert.equal(emptied.lastResult, 'empty');
  assert.equal((await n.call('lanchat:taskRuns', { id: a.id }))[0].kind, 'empty');

  const b = await n.call('lanchat:createTask', { agentId: broken.id, instruction: 'Fall over' });
  await n.call('lanchat:runTask', { id: b.id });
  await settle();
  const failed = (await n.call('lanchat:listTasks')).find((r) => r.id === b.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastResult, 'error');
  const [run] = await n.call('lanchat:taskRuns', { id: b.id });
  assert.equal(run.ok, false);
  assert.ok(run.text.length > 0 || run.detail, 'and it says what went wrong');

  // Neither of them wrote a conversation either.
  for (const id of [a.id, b.id]) assert.ok(!fs.existsSync(n.store.fileFor(id)));
});

test('a run that cannot start says why, in a sentence', async (t) => {
  const n = makeNode('refusals');
  t.after(() => n.agentHub.stopAll?.());

  const bare = await n.call('lanchat:createTask', {});
  assert.deepEqual(await n.call('lanchat:runTask', { id: 'task:nope' }), {
    ok: false,
    reason: 'gone',
    detail: 'That task is no longer here.',
  });

  let refusal = await n.call('lanchat:runTask', { id: bare.id });
  assert.equal(refusal.reason, 'no-instruction');
  assert.ok(refusal.detail.length > 0);

  await n.call('lanchat:updateTask', { id: bare.id, patch: { instruction: 'Do the thing' } });
  refusal = await n.call('lanchat:runTask', { id: bare.id });
  assert.equal(refusal.reason, 'no-agent', 'an instruction with nobody to put it to');

  // An agent that is switched off is not the same as one that has been removed,
  // and the sentence is different because the thing to do about it is.
  const agent = await withAgent(n);
  await n.call('lanchat:updateTask', { id: bare.id, patch: { agentId: agent.id } });
  await n.call('lanchat:setAgentEnabled', { id: agent.id, enabled: false });
  refusal = await n.call('lanchat:runTask', { id: bare.id });
  assert.equal(refusal.reason, 'agent-off');
  assert.match(refusal.detail, /switched off/);

  await n.call('lanchat:updateTask', { id: bare.id, patch: { agentId: 'agent:vanished' } });
  refusal = await n.call('lanchat:runTask', { id: bare.id });
  assert.equal(refusal.reason, 'agent-gone');

  // A refusal is not a run: nothing was recorded, and the record did not move.
  assert.deepEqual(await n.call('lanchat:taskRuns', { id: bare.id }), []);
  assert.equal((await n.call('lanchat:listTasks')).find((r) => r.id === bare.id).runCount, 0);
});

test('a task will not be run twice at once', async (t) => {
  const n = makeNode('once');
  t.after(() => n.agentHub.stopAll?.());

  // An agent that takes the question and never answers, which is the only way
  // to hold a run open long enough to ask again.
  const agent = await withAgent(n, 'silent');
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Wait forever' });

  const first = await n.call('lanchat:runTask', { id: task.id });
  assert.equal(first.ok, true);
  // Nothing has come back, so this is what a run in flight looks like.
  assert.equal(first.task.status, 'working');
  assert.equal(first.task.lastRunAt > 0, true);

  const second = await n.call('lanchat:runTask', { id: task.id });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-running');

  // Stopping it ends the run and records what happened, rather than leaving a
  // record that says "working" for the rest of the session.
  assert.deepEqual(await n.call('lanchat:stopTask', { id: task.id }), { ok: true });
  const record = (await n.call('lanchat:listTasks')).find((r) => r.id === task.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.lastDetail, 'Stopped.');
  assert.equal((await n.call('lanchat:taskRuns', { id: task.id }))[0].detail, 'Stopped.');
  assert.deepEqual(await n.call('lanchat:stopTask', { id: task.id }), { ok: false }, 'and it stays stopped');
});

test('removing an agent leaves the task, pointing at nobody', async (t) => {
  const n = makeNode('unbind');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Ask the agent' });

  await n.call('lanchat:removeAgent', { id: agent.id });
  const record = (await n.call('lanchat:listTasks')).find((r) => r.id === task.id);
  // The instruction is the work. The agent is a choice that can be made again.
  assert.equal(record.agentId, null);
  assert.equal(record.instruction, 'Ask the agent');
  assert.equal((await n.call('lanchat:runTask', { id: task.id })).reason, 'no-agent');
  // And the window was told, so the picker stops showing a name that is gone.
  assert.ok(pushed(n, 'tasks').length > 0);
});

test('a patch from the window cannot claim a task succeeded', async (t) => {
  const n = makeNode('patch');
  t.after(() => n.agentHub.stopAll?.());

  const task = await n.call('lanchat:createTask', { instruction: 'Something' });
  const patched = await n.call('lanchat:updateTask', {
    id: task.id,
    patch: {
      title: 'Renamed',
      instruction: 'Something else',
      // None of these are the window's to decide. A blind spread would take
      // them all, and a task could then report a run that never happened.
      status: 'done',
      runCount: 99,
      lastResult: 'answer',
      id: 'task:forged',
      createdAt: 0,
    },
  });
  assert.equal(patched.title, 'Renamed');
  assert.equal(patched.instruction, 'Something else');
  assert.equal(patched.status, 'idle');
  assert.equal(patched.runCount, 0);
  assert.equal(patched.lastResult, null);
  assert.equal(patched.id, task.id);
  assert.equal(patched.createdAt, task.createdAt);
});

test('deleting a task takes its answers with it, and it all survives a restart', async (t) => {
  const n = makeNode('restart');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const kept = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Kept' });
  const dropped = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Dropped' });
  await n.call('lanchat:runTask', { id: kept.id });
  await n.call('lanchat:runTask', { id: dropped.id });
  await settle();

  assert.ok(fs.existsSync(runFile(n, dropped.id)));
  assert.deepEqual(await n.call('lanchat:deleteTask', { id: dropped.id }), { ok: true });
  assert.ok(!fs.existsSync(runFile(n, dropped.id)), 'the answers went with the record');

  // A second registry on the same directory is what the next launch is.
  const after = new TaskRegistry(n.dir);
  assert.deepEqual(
    after.list().map((r) => r.instruction),
    ['Kept']
  );
  assert.equal(after.get(kept.id).lastResult, 'answer');

  // The file is JSON a person can edit and an older build can write. Anything
  // that is not a task is dropped rather than rendered, and a file that will
  // not parse is a fresh start rather than a crash on launch.
  const file = path.join(n.dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'task:real' }, { id: 'note:no' }, null, 'nonsense']), 'utf8');
  const guarded = new TaskRegistry(file.replace(/\/tasks\.json$/, ''));
  assert.deepEqual(
    guarded.list().map((r) => r.id),
    ['task:real']
  );
  assert.equal(guarded.get('task:real').status, 'idle', 'and a record with no status gets a usable one');
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepEqual(new TaskRegistry(n.dir).list(), []);
});

// ---- schedules, through the same door ---------------------------------------
//
// The store and the tick are pinned in scheduler.test.js with an injected
// clock. What is asked here is the wiring around them: that a spec is checked
// before it is saved rather than after it never fires, that the preview and the
// scheduler answer with the same walker, and that a schedule cannot outlive the
// task it runs.

test('a schedule is checked before it is saved, and knows when it is next due', async (t) => {
  const n = makeNode('schedules');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Nightly' });

  // The preview is the validation. It runs the same walker the scheduler will,
  // so what it shows is what will happen.
  const good = await n.call('lanchat:previewSchedule', { spec: { kind: 'cron', expr: '0 9 * * 1-5' } });
  assert.equal(good.ok, true);
  assert.equal(good.next.length, 3);
  assert.equal(good.describes, '0 9 * * 1-5');
  assert.ok(good.next[0] > Date.now());

  const bad = await n.call('lanchat:previewSchedule', { spec: { kind: 'cron', expr: 'every so often' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0, 'and it says so in a sentence');
  const never = await n.call('lanchat:previewSchedule', { spec: { kind: 'cron', expr: '0 0 31 2 *' } });
  assert.equal(never.ok, false, 'a spec that will never come round is refused too');

  // A spec that cannot be read is refused rather than saved and silently never
  // fired, which is the failure nobody would notice.
  const refused = await n.call('lanchat:createSchedule', {
    taskId: task.id,
    spec: { kind: 'cron', expr: 'x' },
  });
  assert.equal(refused.ok, false);
  assert.deepEqual(await n.call('lanchat:listSchedules'), []);

  const orphan = await n.call('lanchat:createSchedule', {
    taskId: 'task:nope',
    spec: { kind: 'cron', expr: '0 9 * * *' },
  });
  assert.equal(orphan.ok, false, 'and a schedule with no task is not a schedule');

  const sched = await n.call('lanchat:createSchedule', {
    taskId: task.id,
    spec: { kind: 'cron', expr: '0 9 * * 1-5' },
  });
  assert.match(sched.id, /^sched:/);
  assert.equal(sched.enabled, true);
  // The number the tick compares against, computed here and written down.
  assert.equal(sched.nextRunAt, good.next[0], 'the preview and the record agree');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(n.dir, 'schedules.json'), 'utf8'))[0].nextRunAt,
    sched.nextRunAt
  );
});

test('switching a schedule off and on recomputes when it is next due', async (t) => {
  const n = makeNode('toggle');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Nightly' });
  const sched = await n.call('lanchat:createSchedule', {
    taskId: task.id,
    spec: { kind: 'cron', expr: '* * * * *' },
  });

  const off = await n.call('lanchat:setScheduleEnabled', { id: sched.id, enabled: false });
  assert.equal(off.enabled, false);

  // Coming back on asks the clock again. A schedule that was off for a week
  // must not return already overdue and fire the instant it is switched on.
  const on = await n.call('lanchat:setScheduleEnabled', { id: sched.id, enabled: true });
  assert.equal(on.enabled, true);
  assert.ok(on.nextRunAt > Date.now(), 'due next in the future, not in the past');
});

test('a schedule cannot outlive the task it runs', async (t) => {
  const n = makeNode('cascade');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Nightly' });
  await n.call('lanchat:createSchedule', { taskId: task.id, spec: { kind: 'cron', expr: '0 9 * * *' } });
  await n.call('lanchat:createSchedule', { taskId: task.id, spec: { kind: 'cron', expr: '0 18 * * *' } });
  assert.equal((await n.call('lanchat:listSchedules')).length, 2);

  await n.call('lanchat:deleteTask', { id: task.id });
  // A clock with nothing on the other end of it would come round forever,
  // refuse every time, and there would be no task left to reach it through.
  assert.deepEqual(await n.call('lanchat:listSchedules'), []);
  assert.equal(pushed(n, 'schedules').at(-1).length, 0, 'and the window was told');
});

test('a schedule survives a restart knowing what it was waiting for', async (t) => {
  const n = makeNode('sched-restart');
  t.after(() => n.agentHub.stopAll?.());

  const agent = await withAgent(n);
  const task = await n.call('lanchat:createTask', { agentId: agent.id, instruction: 'Nightly' });
  const sched = await n.call('lanchat:createSchedule', {
    taskId: task.id,
    spec: { kind: 'every', preset: 'daily', hour: 7, minute: 30 },
  });

  const { ScheduleRegistry } = require('../src/main/tasks/schedules.js');
  const [after] = new ScheduleRegistry(n.dir).list();
  assert.equal(after.id, sched.id);
  assert.equal(after.nextRunAt, sched.nextRunAt, 'the moment it was waiting for is on disk');
  assert.deepEqual(after.spec, { kind: 'every', preset: 'daily', hour: 7, minute: 30 });
  assert.equal(new Date(after.nextRunAt).getHours(), 7);
  assert.equal(new Date(after.nextRunAt).getMinutes(), 30);
});
