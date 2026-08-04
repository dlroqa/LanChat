'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load, mount, find, until } = require('../scripts/lib/reactDrive.js');

// The sharing form, driven as the component it is.
//
// Everything about handing an approval on was proven in main and over real
// sockets, and none of it reached a user: the form's Save dropped the settings
// on the floor between the picker and the handler, so the toggle came back off
// every time. Nothing in the suite could see it, because the seam it broke at
// is a callback's argument list — invisible to markup assertions, and below
// the ipc layer every other test starts from.
//
// So this drives the real AgentSection: opens the picker the way the button
// does, hands its `onSave` exactly what the picker hands it, and asserts on
// what reached the bridge. It is the one test that would have failed.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const AgentSection = load(path.join(SRC, 'components', 'AgentSection.jsx')).default;

const AGENT = {
  id: 'agent:1',
  name: 'Mac',
  kind: 'acp',
  config: {},
  enabled: true,
  allowedPeers: ['peer-1'],
  networkWide: true,
  directChat: false,
  approvals: { delegated: false, unattended: false, handoverMs: 20000 },
  hasSecret: false,
  hasApprovalPasscode: false,
  secretMode: 'none',
  secretEnv: null,
  createdAt: 1,
};

// The bridge, recording what the form asks of it. `listAgents` answers with
// whatever the last save established, so reopening the picker reads back what
// was actually stored rather than what the form remembered.
function bridge() {
  const calls = [];
  let stored = { ...AGENT };
  const api = {
    listAgents: async () => [stored],
    setAgentPeers: async (id, allowedPeers) => {
      calls.push(['peers', id, allowedPeers]);
      stored = { ...stored, allowedPeers };
    },
    setAgentSharing: async (id, patch) => {
      calls.push(['sharing', id, patch]);
      stored = { ...stored, ...patch };
    },
    setAgentApprovals: async (id, patch) => {
      calls.push(['approvals', id, patch]);
      const { passcode, ...rest } = patch;
      stored = {
        ...stored,
        approvals: { ...stored.approvals, ...rest },
        hasApprovalPasscode: stored.hasApprovalPasscode || Boolean(passcode),
      };
      return { ok: true, agent: stored };
    },
  };
  return { api, calls, agent: () => stored };
}

const byLabelText = (text) => (n) =>
  n.props && n.type === 'button' && String(n.props.children || '').includes(text);

const pickerIn = (view) => find(view.tree, (n) => n.props && typeof n.props.onSave === 'function');

async function openPicker(view) {
  assert.ok(await until(() => find(view.tree, byLabelText('Peers…'))), 'the agent row appears');
  find(view.tree, byLabelText('Peers…')).props.onClick();
  await view.settle();
  assert.ok(await until(() => pickerIn(view)), 'the sharing form opens');
  return pickerIn(view);
}

test('what the sharing form is given for approvals is what reaches the bridge', async (t) => {
  const { api, calls } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const view = mount(AgentSection, { peers: [{ id: 'peer-1', name: 'Macmini', kind: 'peer' }] });
  t.after(() => view.unmount());
  await view.settle();

  const picker = await openPicker(view);

  // Exactly what PeerPicker's own Save button passes: three arguments, the
  // third being the approvals block. The defect was that the third never
  // arrived, so `setAgentApprovals` was never called at all.
  picker.props.onSave(
    ['peer-1'],
    { networkWide: true, directChat: false },
    { delegated: true, unattended: true, handoverMs: 20000, passcode: 'let me in' }
  );
  assert.ok(
    await until(() => calls.some((c) => c[0] === 'approvals')),
    'the approvals block reaches the bridge'
  );

  const saved = calls.find((c) => c[0] === 'approvals');
  assert.equal(saved[1], 'agent:1');
  assert.deepEqual(saved[2], {
    delegated: true,
    unattended: true,
    handoverMs: 20000,
    passcode: 'let me in',
  });

  // And the order matters: reach is written before approvals, because main
  // prunes holders against the allowlist as it saves.
  const order = calls.map((c) => c[0]);
  assert.deepEqual(order, ['peers', 'sharing', 'approvals']);
});

test('a saved approvals setting is what the form reads back', async (t) => {
  const { api, agent } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const view = mount(AgentSection, { peers: [{ id: 'peer-1', name: 'Macmini', kind: 'peer' }] });
  t.after(() => view.unmount());
  await view.settle();

  const picker = await openPicker(view);
  picker.props.onSave(
    ['peer-1'],
    { networkWide: true, directChat: false },
    { delegated: true, unattended: true, handoverMs: 20000, passcode: 'let me in' }
  );
  assert.ok(await until(() => agent().approvals.delegated === true), 'the store takes it');

  // The form closes on save and the list is re-read. Reopening it must show
  // what is stored — this is the symptom the report described: toggled on,
  // saved, and off again on the next look.
  assert.ok(await until(() => !pickerIn(view)), 'the form closes on save');
  const reopened = await openPicker(view);
  assert.equal(reopened.props.agent.approvals.delegated, true, 'the toggle stayed on');
  assert.equal(reopened.props.agent.approvals.unattended, true);
  assert.equal(reopened.props.agent.hasApprovalPasscode, true, 'and the passcode registered');
});
