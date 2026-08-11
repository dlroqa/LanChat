'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load, mount, find, findAll, byClass } = require('../scripts/lib/reactDrive.js');

// The menu where a session is decided, driven for real.
//
// What is worth asserting here is the newest thing in it: who, of the people in
// a room, may put a question to the agents. It is one rule with three settings
// and a per-person tick under the third, and every failure mode is an interface
// one — a tick that appears before the setting that reads it, a control that
// does nothing when pressed, a permission a guest can grant themselves, or a
// state said in colour and nowhere else.

// The menu listens for a press anywhere else so it can put itself away. There
// is no browser here, so the two calls it makes are given somewhere to land —
// stubbed rather than avoided, because what is being driven has to be the
// component the app mounts.
global.document = { addEventListener() {}, removeEventListener() {} };

const AgentPicker = load(
  path.join(__dirname, '..', 'src', 'renderer', 'components', 'AgentPicker.jsx')
).default;

const AGENTS = [{ id: 'agent:1', name: 'Hermes', ready: true }];
const PEERS = [
  { id: 'p-zima', name: 'Zima', online: true },
  { id: 'p-serv', name: 'Server', online: true },
];
const MEMBERS = [
  { peerId: 'p-zima', name: 'Zima', state: 'joined', ask: false },
  { peerId: 'p-serv', name: 'Server', state: 'invited', ask: false },
];

// Opened, because everything below is inside the menu and the menu starts shut.
// Awaited: a setter re-renders on a microtask, so the menu exists a tick after
// the chip is pressed rather than on the line that pressed it.
async function openPicker(props = {}) {
  const patches = [];
  const view = mount(AgentPicker, {
    agents: AGENTS,
    agentIds: ['agent:1'],
    mode: 'observer',
    peers: PEERS,
    members: MEMBERS,
    onChange: (patch) => patches.push(patch),
    ...props,
  });
  find(view.tree, (n) => n.props && n.props['aria-label'] === 'The agents this session asks').props.onClick();
  await view.settle();
  return { view, patches };
}

const rows = (view) =>
  findAll(view.tree, (n) => n.props && String(n.props.className || '').includes('agent-pick')).map(
    (n) => n.props
  );

const named = (view, name) =>
  rows(view).find((r) => {
    const text = find(r.children, (n) => n.props && n.props.className === 'agent-pick-name');
    return text && text.props.children === name;
  });

test('the three settings are one choice, and the room’s is the one marked', async () => {
  const { view } = await openPicker({ asking: 'room' });
  const three = ['Only me', 'Anyone in the room', 'The people I tick'].map((n) => named(view, n));
  assert.ok(
    three.every(Boolean),
    'all three settings are offered — a rule with a setting missing is a rule nobody can leave'
  );
  // Radios, not checkboxes: they are one rule, and a room where two of them
  // could be on at once would have two answers to the same question.
  assert.ok(
    three.every((r) => r.role === 'menuitemradio'),
    'and offered as the single choice they are'
  );
  assert.deepEqual(
    three.map((r) => r['aria-checked']),
    [false, true, false],
    'with the room’s own setting marked for anybody reading rather than looking'
  );
});

test('choosing a setting says so once, in the shape main takes', async () => {
  const { view, patches } = await openPicker({ asking: 'nobody' });
  named(view, 'Anyone in the room').onClick();
  assert.deepEqual(patches, [{ asking: 'room' }], 'one patch, naming the rule and nothing else');
});

test('the per-person tick appears only under the setting that reads it', async () => {
  // A tick that is always there would be a control with no effect for two of the
  // three settings, which is the kind of thing somebody presses once and never
  // trusts again.
  for (const asking of ['nobody', 'room']) {
    const { view } = await openPicker({ asking });
    assert.equal(findAll(view.tree, byClass('agent-ask')).length, 0, `no ticks under ${asking}`);
  }
  const { view } = await openPicker({ asking: 'chosen' });
  const ticks = findAll(view.tree, byClass('agent-ask'));
  // One, for the one person actually in the room. Somebody who was invited and
  // never answered is not in it, and a tick beside their name would offer a
  // permission to a person who is not there to use it.
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].props['aria-label'], 'Let Zima ask the agents');
  assert.equal(ticks[0].props['aria-checked'], false);
});

test('a tick says what it is in words as well as in colour', async () => {
  const { view } = await openPicker({
    asking: 'chosen',
    members: [{ peerId: 'p-zima', name: 'Zima', state: 'joined', ask: true }],
  });
  const tick = find(view.tree, byClass('agent-ask'));
  assert.equal(tick.props['aria-checked'], true);
  assert.match(String(tick.props.className), /\bon\b/, 'and it looks different, as well as reading so');
  // The word is in the control whatever state it is in, so what the tint means
  // is never the only thing that says it.
  assert.ok(
    findAll(tick, (n) => typeof n === 'string' || (n.props && n.props.children === 'Ask')).length > 0 ||
      String(tick.props.children).includes('Ask')
  );
});

test('ticking one person names that person and nothing else', async () => {
  const { view, patches } = await openPicker({ asking: 'chosen' });
  find(view.tree, byClass('agent-ask')).props.onClick();
  assert.deepEqual(patches, [{ ask: 'p-zima', mayAsk: true }]);
});

test('a guest is shown the rule and cannot touch it', async () => {
  // A room somebody else runs: the policy is theirs, and a copy that could set
  // it here would be a second authority over whose agents get spent.
  const { view } = await openPicker({ asking: 'chosen', guest: true });
  const three = ['Only me', 'Anyone in the room', 'The people I tick'].map((n) => named(view, n));
  assert.ok(
    three.every((r) => r.disabled === true),
    'every setting is read-only for a guest'
  );
  assert.equal(
    three.find((r) => r['aria-checked']) !== undefined,
    true,
    'and the host’s choice is still shown rather than hidden'
  );
  const tick = find(view.tree, byClass('agent-ask'));
  assert.equal(tick.props.disabled, true);
  assert.match(tick.props.title, /Only the person who started this session/);
});

test('none of it appears in a session that is not a room', async () => {
  // The three modes that are one person asking a counsel have no room to have a
  // policy about, and a setting about people there would be a setting about
  // nobody.
  const { view } = await openPicker({ mode: 'parallel', asking: 'room' });
  assert.equal(named(view, 'Anyone in the room'), undefined);
  assert.equal(findAll(view.tree, byClass('agent-ask')).length, 0);
});
