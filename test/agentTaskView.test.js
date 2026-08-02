'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load, mount, find, findAll, byClass, wait } = require('../scripts/lib/reactDrive.js');

// The agent task view.
//
// Two things here are worth pinning and are not visible in the markup.
//
// The first is the same discipline the notes editor has, and for a sharper
// reason: an instruction lives in a file that is rewritten whole and pushed
// back to this window, so a save per keystroke would re-render the column under
// the cursor thirty times a sentence. It is debounced — and therefore has to be
// flushed on every way out.
//
// The second is what that debounce threatens. Pressing Run with an edit still
// waiting would put the *previous* instruction to the agent: the right task
// name, the right agent, and the wrong question, with nothing on screen to say
// so. The flush before the run is what stops that, and it is asserted here
// because nobody would ever notice it failing.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const AgentTaskView = load(path.join(SRC, 'components', 'AgentTaskView.jsx')).default;

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const AGENTS = [
  { id: 'agent:tessie', name: 'Tessie', ready: true },
  { id: 'remote-agent:ada:1', name: 'Bracket', remote: true, viaName: 'Ada', ready: true },
];

const TASKS = [
  {
    id: 'task:a',
    title: 'Nightly build',
    agentId: 'agent:tessie',
    instruction: 'Check the nightly build.',
    status: 'done',
    lastResult: 'answer',
    runCount: 3,
    updatedAt: 1_760_000_000_000,
  },
  {
    id: 'task:b',
    title: 'Disk check',
    agentId: null,
    instruction: 'Check the disk.',
    status: 'working',
    lastResult: null,
    runCount: 1,
    updatedAt: 1_759_000_000_000,
  },
];

const props = (over = {}) => ({
  tasks: TASKS,
  agents: AGENTS,
  streams: {},
  onCreate: async () => null,
  onUpdate: () => {},
  onRun: async () => ({ ok: true }),
  onStop: () => {},
  onDelete: () => {},
  onRuns: async () => [],
  ...over,
});

const draw = (over = {}) => readable(renderToStaticMarkup(React.createElement(AgentTaskView, props(over))));

test('a row says what the task is, who it asks, and how it went', () => {
  const html = draw();
  assert.ok(html.includes('2 tasks'));
  assert.ok(html.includes('Nightly build'));
  assert.ok(html.includes('Tessie · answered'));
  // A task with nobody to put it to says so rather than showing a blank.
  assert.ok(html.includes('No agent · running'));
});

test('the status is a colour and a word, not a colour alone', () => {
  const html = draw();
  // A coloured dot says nothing to a reader, so every row carries the state in
  // words as well, out of the way of the eye.
  assert.ok(html.includes('task-dot done'));
  assert.ok(html.includes('task-dot working'));
  assert.ok(html.includes('>Answered<'));
  assert.ok(html.includes('>Running<'));
  assert.ok(html.includes('class="sr-only"'));
});

test('a running task offers stop, and a stopped one offers run', () => {
  const html = draw();
  assert.ok(html.includes('aria-label="Run Nightly build now"'));
  assert.ok(html.includes('aria-label="Stop Disk check"'));
  assert.ok(!html.includes('aria-label="Run Disk check now"'), 'not while it is already running');
});

test('with nothing in it, it says what it is for', () => {
  const html = draw({ tasks: [] });
  assert.ok(html.includes('No tasks yet'));
  assert.ok(html.includes('No tasks'), 'and the count agrees');
});

// ---- driven -----------------------------------------------------------------

const view = (over = {}) => mount(AgentTaskView, props(over));

async function open(v, which = 'Nightly build') {
  const row = findAll(v.tree, byClass('task-row-face')).find((n) =>
    JSON.stringify(n.props.children).includes(which)
  );
  row.props.onClick();
  await v.settle();
  return v;
}

test('driven: the instruction is written once the typing stops, not once per letter', async () => {
  const writes = [];
  const v = view({ onUpdate: (id, patch) => writes.push({ id, ...patch }) });
  await open(v);

  const field = find(v.tree, byClass('task-instruction'));
  assert.equal(field.props.value, 'Check the nightly build.');

  for (const text of ['Check the n', 'Check the ni', 'Check the nig', 'Check the nigh']) {
    find(v.tree, byClass('task-instruction')).props.onChange({ target: { value: text } });
    await v.settle();
    await wait(40);
  }
  assert.deepEqual(writes, [], 'nothing yet — this is one sentence being typed');
  // And the field shows what was typed rather than what is on disk, which is
  // the whole reason it holds a draft.
  assert.equal(find(v.tree, byClass('task-instruction')).props.value, 'Check the nigh');

  await wait(700);
  assert.equal(writes.length, 1, 'one write for the lot of it');
  assert.equal(writes[0].instruction, 'Check the nigh', 'carrying the last letter typed');
  assert.equal(writes[0].id, 'task:a');
  v.unmount();
});

test('driven: Run puts the instruction as it is now, not as it was', async () => {
  const writes = [];
  const ran = [];
  const v = view({
    onUpdate: (id, patch) => {
      writes.push({ id, ...patch });
    },
    onRun: async (id) => {
      ran.push({ id, at: writes.length });
      return { ok: true };
    },
  });
  await open(v);

  find(v.tree, byClass('task-instruction')).props.onChange({
    target: { value: 'Check the nightly build and name the failures.' },
  });
  await v.settle();
  // Straight to Run, with the debounced write still waiting.
  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();

  assert.equal(writes.length, 1, 'the edit was flushed');
  assert.equal(writes[0].instruction, 'Check the nightly build and name the failures.');
  assert.equal(ran.length, 1);
  // The ordering is the assertion: the write had already happened when the run
  // was asked for, so the agent is put the question that is on the screen.
  assert.equal(ran[0].at, 1, 'and it was flushed before the run, not after');
  v.unmount();
});

test('driven: every way out of the editor writes what is in it first', async () => {
  // Closing.
  {
    const writes = [];
    const v = view({ onUpdate: (id, patch) => writes.push({ id, ...patch }) });
    await open(v);
    find(v.tree, byClass('task-instruction')).props.onChange({ target: { value: 'half typed' } });
    await v.settle();
    find(v.tree, byClass('icon-btn')).props.onClick();
    await v.settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].instruction, 'half typed');
    await wait(700);
    assert.equal(writes.length, 1, 'the debounced write did not fire on top');
    assert.ok(find(v.tree, byClass('task-list')), 'and the list is back');
    v.unmount();
  }

  // Deleting.
  {
    const writes = [];
    const deleted = [];
    const v = view({
      onUpdate: (id, patch) => writes.push({ id, ...patch }),
      onDelete: (id) => deleted.push({ id, at: writes.length }),
    });
    await open(v);
    find(v.tree, byClass('task-instruction')).props.onChange({ target: { value: 'last words' } });
    await v.settle();
    find(v.tree, byClass('danger')).props.onClick();
    await v.settle();
    assert.equal(writes.length, 1, 'flushed');
    assert.equal(deleted[0].at, 1, 'and flushed before the delete, not after it');
    assert.ok(find(v.tree, byClass('task-list')));
    v.unmount();
  }

  // Being unmounted, which is what a call arriving does to this panel.
  {
    const writes = [];
    const v = view({ onUpdate: (id, patch) => writes.push({ id, ...patch }) });
    await open(v);
    find(v.tree, byClass('task-instruction')).props.onChange({ target: { value: 'mid sentence' } });
    await v.settle();
    v.unmount();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].instruction, 'mid sentence');
  }
});

test('driven: picking an agent lands after whatever was being typed', async () => {
  const writes = [];
  const v = view({ onUpdate: (id, patch) => writes.push({ id, ...patch }) });
  await open(v);

  find(v.tree, byClass('task-instruction')).props.onChange({ target: { value: 'a new brief' } });
  await v.settle();
  find(v.tree, (n) => n.type === 'select').props.onChange({ target: { value: 'remote-agent:ada:1' } });
  await v.settle();

  // Two writes, in the order they were made. The other way round, the record
  // would end up with the agent picked and the brief that preceded it.
  assert.equal(writes.length, 2);
  assert.equal(writes[0].instruction, 'a new brief');
  assert.equal(writes[1].agentId, 'remote-agent:ada:1');
  v.unmount();
});

test('driven: a refusal is shown in the words main sent', async () => {
  const v = view({
    onRun: async () => ({ ok: false, reason: 'agent-off', detail: 'The agent is switched off.' }),
  });
  await open(v);
  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();

  const shown = find(v.tree, byClass('task-refusal'));
  assert.ok(shown, 'the refusal is on screen');
  // Not rewritten here: main writes this sentence so that a schedule firing at
  // three in the morning records exactly the same words.
  assert.equal(shown.props.children, 'The agent is switched off.');
  v.unmount();
});

test('driven: the answer arrives on its own when the run finishes', async () => {
  let runs = [];
  const v = view({ onRuns: async () => runs });
  await open(v);
  assert.ok(!find(v.tree, byClass('task-answer')), 'nothing to show yet');

  // What a finished run looks like from here: main pushes the record with a new
  // updatedAt, and the answer is re-read because of it.
  runs = [{ id: 'r1', ok: true, kind: 'answer', text: 'Build 412 passed.', by: 'manual' }];
  v.setProps({
    tasks: TASKS.map((t) => (t.id === 'task:a' ? { ...t, updatedAt: t.updatedAt + 1 } : t)),
  });
  await v.settle();
  await wait(10);

  const answer = find(v.tree, byClass('task-answer'));
  assert.ok(answer, 'and now there is');
  assert.ok(JSON.stringify(answer.props.children).includes('Build 412 passed.'));
  v.unmount();
});

test('driven: what is being written shows while it is being written', async () => {
  const working = TASKS.map((t) => (t.id === 'task:a' ? { ...t, status: 'working' } : t));
  const v = view({
    tasks: working,
    // Keyed by thread — and a task's thread is its own id. Nothing plumbs this
    // specially; it is what asking under the task's id already produces.
    streams: { 'task:a': { 'agent:tessie': 'checking the log…' } },
  });
  await open(v);

  const live = find(v.tree, byClass('live'));
  assert.ok(live, 'the answer being written is on screen');
  assert.ok(JSON.stringify(live.props.children).includes('checking the log…'));
  // And the button offers to stop it rather than to start it again.
  assert.ok(!find(v.tree, byClass('primary')), 'no Run while it is running');
  v.unmount();
});
