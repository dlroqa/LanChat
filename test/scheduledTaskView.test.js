'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load, mount, find, findAll, byClass, until } = require('../scripts/lib/reactDrive.js');

// The scheduled task view.
//
// The thing worth pinning here is that the panel never lets somebody save a
// schedule that will not do what they think it does. A cron expression that
// parses and means the wrong thing is the failure that actually happens, so the
// preview — the next few real moments, answered by the same walker the
// scheduler will run — is both the validation and the explanation, and Save is
// unreachable until it is good.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const ScheduledTaskView = load(path.join(SRC, 'components', 'ScheduledTaskView.jsx')).default;

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const TASKS = [
  { id: 'task:a', title: 'Nightly build' },
  { id: 'task:b', title: 'Weekly digest' },
];

const SOON = Date.now() + 60 * 60 * 1000;

const SCHEDULES = [
  {
    id: 'sched:1',
    taskId: 'task:a',
    spec: { kind: 'cron', expr: '0 9 * * 1-5' },
    enabled: true,
    nextRunAt: SOON,
    lastFireAt: Date.now() - 60 * 60 * 1000,
    lastResult: 'ran',
    missed: 0,
  },
  {
    id: 'sched:2',
    taskId: 'task:b',
    spec: { kind: 'every', preset: 'weekly', hour: 18, minute: 30, weekday: 5 },
    enabled: false,
    nextRunAt: null,
    lastFireAt: Date.now() - 2 * 60 * 60 * 1000,
    lastResult: 'skipped',
    lastDetail: 'The agent was switched off.',
    missed: 3,
  },
];

const props = (over = {}) => ({
  schedules: SCHEDULES,
  tasks: TASKS,
  onCreate: async () => ({ id: 'sched:new' }),
  onUpdate: async () => ({ id: 'sched:1' }),
  onToggle: () => {},
  onDelete: () => {},
  onPreview: async () => ({ ok: true, next: [SOON], describes: 'Every day at 09:00' }),
  ...over,
});

const draw = (over = {}) =>
  readable(renderToStaticMarkup(React.createElement(ScheduledTaskView, props(over))));

test('a row says which task, when next, and how the last one went', () => {
  const html = draw();
  assert.ok(html.includes('2 scheduled'));
  assert.ok(html.includes('Nightly build'));
  assert.ok(html.includes('Weekly digest'));
  // A schedule that is off says so rather than showing a time it will not keep,
  // and one that has been skipping says how often, in main's own words.
  assert.ok(html.includes('Off · 3 missed'));
  assert.ok(html.includes('The agent was switched off.'));
});

test('with no tasks there is nothing to schedule, and it says which is missing', () => {
  const html = draw({ schedules: [], tasks: [] });
  assert.ok(html.includes('Nothing scheduled'));
  assert.ok(html.includes('Write an agent task first'));
  // The button is dead rather than gone: a control that vanishes teaches
  // nobody where it was.
  const addButton = (page, label) => page.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))[0];
  assert.ok(addButton(html, 'Write a task first').includes('disabled'));

  const withTasks = draw({ schedules: [] });
  assert.ok(withTasks.includes('once, on a repeat, or on a cron expression'));
  assert.ok(!addButton(withTasks, 'New schedule').includes('disabled'));
});

test('every control that is only an icon carries its name', () => {
  const html = draw();
  assert.ok(html.includes('aria-label="Switch off the schedule for Nightly build"'));
  assert.ok(html.includes('aria-label="Switch on the schedule for Weekly digest"'));
  assert.ok(html.includes('aria-label="Delete the schedule for Nightly build"'));
});

// ---- driven -----------------------------------------------------------------

const view = (over = {}) => mount(ScheduledTaskView, props(over));

async function openNew(v) {
  find(v.tree, byClass('icon-btn')).props.onClick();
  await v.settle();
  await until(() => Boolean(find(v.tree, byClass('sched-preview'))));
  return v;
}

test('driven: the three ways of saying when are one choice with three answers', async () => {
  const v = await openNew(view());
  const kinds = findAll(v.tree, byClass('sched-kind'));
  assert.equal(kinds.length, 3);
  assert.deepEqual(
    kinds.map((k) => k.props.children),
    ['Once', 'Repeats', 'Cron']
  );
  // Exactly one is chosen at a time, and it starts on the repeat, which is what
  // most schedules are.
  assert.equal(kinds.filter((k) => k.props['aria-checked']).length, 1);
  assert.equal(kinds[1].props['aria-checked'], true);

  kinds[2].props.onClick();
  await v.settle();
  const after = findAll(v.tree, byClass('sched-kind'));
  assert.equal(after[2].props['aria-checked'], true);
  assert.equal(after[1].props['aria-checked'], false);
  assert.ok(find(v.tree, byClass('sched-cron')), 'and the field for it appeared');
  v.unmount();
});

test('driven: the preview is asked on every change, and shows what would happen', async () => {
  const asked = [];
  const v = await openNew(
    view({
      onPreview: async (spec) => {
        asked.push(spec);
        return { ok: true, next: [SOON, SOON + 86_400_000], describes: 'Every day at 09:00' };
      },
    })
  );

  assert.equal(asked.length, 1, 'asked as soon as the form opened');
  const preview = find(v.tree, byClass('sched-preview'));
  assert.ok(JSON.stringify(preview.props.children).includes('Every day at 09:00'));

  find(v.tree, (n) => n.type === 'select' && n.props.value === 'daily').props.onChange({
    target: { value: 'weekly' },
  });
  await v.settle();
  await until(() => asked.length > 1);
  assert.equal(asked.length, 2, 'and again when the spec changed');
  assert.equal(asked[1].preset, 'weekly');
  v.unmount();
});

test('driven: a spec that will not do anything cannot be saved', async () => {
  const created = [];
  const v = await openNew(
    view({
      onPreview: async (spec) =>
        spec.kind === 'cron' && spec.expr === 'nonsense'
          ? { ok: false, error: 'That is not a schedule this can read.' }
          : { ok: true, next: [SOON], describes: 'ok' },
      onCreate: async (taskId, spec) => {
        created.push({ taskId, spec });
        return { id: 'sched:new' };
      },
    })
  );

  // Good to begin with.
  assert.equal(find(v.tree, byClass('primary')).props.disabled, false);

  findAll(v.tree, byClass('sched-kind'))[2].props.onClick();
  await v.settle();
  find(v.tree, byClass('sched-cron')).props.onChange({ target: { value: 'nonsense' } });
  await v.settle();
  await until(() => {
    const p = find(v.tree, byClass('sched-preview'));
    return p && JSON.stringify(p.props.children).includes('not a schedule');
  });

  // The refusal is on screen, in the words main wrote, and Save is out of
  // reach — a schedule that cannot be read would otherwise be saved and then
  // silently never fire, which is the failure nobody notices.
  const preview = find(v.tree, byClass('sched-preview'));
  assert.ok(JSON.stringify(preview.props.children).includes('not a schedule'));
  assert.equal(find(v.tree, byClass('primary')).props.disabled, true);

  // And the refusal is in the function as well as on the button, because
  // `disabled` is presentation and this is the rule.
  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();
  assert.deepEqual(created, [], 'nothing was saved');
  v.unmount();
});

test('driven: saving a good one hands main the spec and closes the form', async () => {
  const created = [];
  const v = await openNew(
    view({
      onCreate: async (taskId, spec) => {
        created.push({ taskId, spec });
        return { id: 'sched:new' };
      },
    })
  );

  findAll(v.tree, byClass('sched-kind'))[2].props.onClick();
  await v.settle();
  find(v.tree, byClass('sched-cron')).props.onChange({ target: { value: '0 9 * * 1-5' } });
  await v.settle();
  await until(() => find(v.tree, byClass('primary')).props.disabled === false);

  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();

  assert.deepEqual(created, [{ taskId: 'task:a', spec: { kind: 'cron', expr: '0 9 * * 1-5' } }]);
  assert.ok(find(v.tree, byClass('sched-list')), 'and the list is back');
  v.unmount();
});

test('driven: a refusal from main keeps the form open with the spec still in it', async () => {
  const v = await openNew(
    view({ onCreate: async () => ({ ok: false, error: 'That task is no longer here.' }) })
  );
  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();

  // Still on the form: what somebody typed is in front of them to fix, rather
  // than thrown away with a message about it.
  assert.ok(find(v.tree, byClass('sched-editor')), 'the form stayed open');
  const preview = find(v.tree, byClass('sched-preview'));
  assert.ok(JSON.stringify(preview.props.children).includes('no longer here'));
  v.unmount();
});

test('driven: opening an existing one edits it rather than making another', async () => {
  const updated = [];
  const v = view({ onUpdate: async (id, patch) => updated.push({ id, ...patch }) });

  findAll(v.tree, byClass('task-row-face'))[0].props.onClick();
  await v.settle();
  await until(() => Boolean(find(v.tree, byClass('sched-cron'))));

  // The cron it was saved with, in the field, on the tab that spells it.
  assert.equal(findAll(v.tree, byClass('sched-kind'))[2].props['aria-checked'], true);
  assert.equal(find(v.tree, byClass('sched-cron')).props.value, '0 9 * * 1-5');

  await find(v.tree, byClass('primary')).props.onClick();
  await v.settle();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'sched:1', 'the one that was opened');
  v.unmount();
});
