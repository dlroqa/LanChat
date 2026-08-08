'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load, mount, find, until } = require('../scripts/lib/reactDrive.js');

// The agent form's profile field, driven as the component it is.
//
// Everything about launching Hermes under a chosen profile was proven — the
// flag is built in profiles.js, injected in buildTransport, and there are tests
// for all of it — and none of it ever reached a user. buildPayload rebuilds
// `config` field-by-field before saving, and the ACP branch simply never listed
// `profile`. The picker filled in a value the save threw away, so the agent
// launched under whatever Hermes was already set to, and the only way anyone
// found out was by asking the agent which profile it was running.
//
// Nothing in the suite could see it. Every profile test starts at or below
// hermesLaunchArgs, which is handed a config that a real save would never have
// produced. The seam it broke at is one branch of an object literal — invisible
// to markup assertions and above the layer the main-side tests begin at.
//
// So this drives the real AgentSection: opens the form the way the button does,
// sets the fields the way their handlers do, and asserts on what reached the
// bridge. It is the test that would have failed.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const AgentSection = load(path.join(SRC, 'components', 'AgentSection.jsx')).default;

// A bridge that stores the way the registry stores: `add` keeps the config it
// was given, `update` merges it over the existing one for the same transport.
// The merge is the reason clearing a profile needs an explicit undefined rather
// than an omitted key, so a fake that replaced instead of merging would let a
// broken clear pass.
function bridge() {
  const calls = [];
  let stored = null;
  const api = {
    listAgents: async () => (stored ? [stored] : []),
    listAgentProfiles: async (id, draft) => {
      calls.push(['profiles', id, draft]);
      return { ok: true, profiles: ['default', 'iris', 'lanchat'], active: 'iris' };
    },
    addAgent: async (payload) => {
      calls.push(['add', payload]);
      stored = {
        id: 'agent:1',
        name: payload.name,
        kind: payload.kind,
        config: { ...payload.config },
        enabled: true,
        allowedPeers: [],
        networkWide: false,
        directChat: false,
        approvals: { delegated: false, unattended: false, handoverMs: 20000 },
        hasSecret: false,
        secretMode: 'none',
        secretEnv: null,
        createdAt: 1,
      };
      return { ok: true, agent: stored, probe: { ok: true } };
    },
    updateAgent: async (id, patch) => {
      calls.push(['update', id, patch]);
      const switching = patch.kind !== undefined && patch.kind !== stored.kind;
      const merged = switching ? { ...patch.config } : { ...stored.config, ...patch.config };
      // What writing to disk does to a key whose value is undefined.
      stored = { ...stored, kind: patch.kind, config: JSON.parse(JSON.stringify(merged)) };
      return { ok: true, agent: stored, probe: { ok: true } };
    },
    removeAgent: async () => ({ ok: true }),
  };
  return { api, calls, agent: () => stored };
}

const button = (text) => (n) =>
  n.props && n.type === 'button' && String(n.props.children || '').includes(text);
const byId = (id) => (n) => n.props && n.props.id === id;
const fieldNamed = (label) => (n) => n.props && n.props.label === label && n.props.onChange;
// ProfileField is a child component, and the harness does not render children —
// which is exactly right here: the element carries the same `setCfg` the real
// field calls from its onChange, so driving it drives the real seam.
const profileField = (n) => n.props && typeof n.props.setCfg === 'function';

async function openForm(view) {
  assert.ok(await until(() => find(view.tree, button('Connect an agent'))), 'the add button is there');
  find(view.tree, button('Connect an agent')).props.onClick();
  await view.settle();
}

async function set(view, matcher, apply) {
  assert.ok(await until(() => find(view.tree, matcher)), 'the field is on the form');
  apply(find(view.tree, matcher));
  await view.settle();
}

async function fillAcp(view, { name, command, profile }) {
  await set(view, byId('agent-name'), (n) => n.props.onChange({ target: { value: name } }));
  await set(view, byId('agent-kind'), (n) => n.props.onChange({ target: { value: 'acp' } }));
  await set(view, fieldNamed('Command'), (n) => n.props.onChange(command));
  await set(view, profileField, (n) => n.props.setCfg({ profile }));
}

test('the profile chosen for an ACP agent is what reaches the bridge', async (t) => {
  const { api, calls } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const view = mount(AgentSection, { peers: [] });
  t.after(() => view.unmount());
  await view.settle();

  await openForm(view);
  await fillAcp(view, { name: 'Hermes', command: 'hermes', profile: 'lanchat' });

  find(view.tree, button('Connect')).props.onClick();
  assert.ok(await until(() => calls.some((c) => c[0] === 'add')), 'the save reaches the bridge');

  const [, payload] = calls.find((c) => c[0] === 'add');
  assert.equal(payload.kind, 'acp');
  assert.equal(
    payload.config.profile,
    'lanchat',
    'the chosen profile is in the payload — this is the assertion the bug failed'
  );
  // The rest of the ACP config is untouched by the fix.
  assert.equal(payload.config.command, 'hermes');
});

test('clearing an ACP profile actually clears it', async (t) => {
  const { api, calls, agent } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const view = mount(AgentSection, { peers: [] });
  t.after(() => view.unmount());
  await view.settle();

  await openForm(view);
  await fillAcp(view, { name: 'Hermes', command: 'hermes', profile: 'lanchat' });
  find(view.tree, button('Connect')).props.onClick();
  assert.ok(await until(() => agent() && agent().config.profile === 'lanchat'), 'it is stored');

  // Reopen as the edit form, the way the row's Edit button does.
  assert.ok(await until(() => find(view.tree, button('Edit'))), 'the row appears');
  find(view.tree, button('Edit')).props.onClick();
  await view.settle();

  const reopened = find(view.tree, profileField);
  assert.equal(reopened.props.draft.config.profile, 'lanchat', 'the form reads back what was saved');

  reopened.props.setCfg({ profile: '' });
  await view.settle();
  find(view.tree, button('Save changes')).props.onClick();
  assert.ok(await until(() => calls.some((c) => c[0] === 'update')), 'the edit reaches the bridge');

  const [, , patch] = calls.find((c) => c[0] === 'update');
  assert.ok('profile' in patch.config, 'the key is present…');
  assert.equal(patch.config.profile, undefined, '…and undefined, which is what overwrites a merge');
  assert.equal(agent().config.profile, undefined, 'so the stored record no longer carries one');
});

test('an HTTP agent still saves its profile the way it always did', async (t) => {
  const { api, calls } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const view = mount(AgentSection, { peers: [] });
  t.after(() => view.unmount());
  await view.settle();

  await openForm(view);
  await set(view, byId('agent-name'), (n) => n.props.onChange({ target: { value: 'Server' } }));
  await set(view, profileField, (n) => n.props.setCfg({ profile: 'iris' }));

  find(view.tree, button('Connect')).props.onClick();
  assert.ok(await until(() => calls.some((c) => c[0] === 'add')), 'the save reaches the bridge');

  const [, payload] = calls.find((c) => c[0] === 'add');
  assert.equal(payload.kind, 'http', 'the form opens on HTTP');
  assert.equal(payload.config.profile, 'iris');
  assert.equal(payload.config.command, undefined, 'and carries nothing from another transport');
});

test('the profile field says so when the command is not Hermes', async (t) => {
  const { api } = bridge();
  global.window = { lanchat: api, confirm: () => true };
  t.after(() => delete global.window);

  const { profileCopy, stickyNote } = load(path.join(SRC, 'lib', 'agentCopy.js'));
  const view = mount(AgentSection, { peers: [] });
  t.after(() => view.unmount());
  await view.settle();

  await openForm(view);
  await fillAcp(view, { name: 'Wrapped', command: 'tessie', profile: 'lanchat' });

  // The field is handed the draft as it stands, so it can tell that the flag
  // this value becomes will not be sent to this command.
  const field = find(view.tree, profileField);
  assert.equal(field.props.draft.config.command, 'tessie');
  assert.match(profileCopy('acp').notHermes, /not sent to this command/);

  // And the value is still saved rather than quietly dropped — the command may
  // yet be changed back.
  find(view.tree, button('Connect')).props.onClick();
  await view.settle();

  // Blank follows Hermes' own current profile, which is a name, not "default".
  assert.equal(stickyNote('iris'), 'Blank runs “iris” — Hermes’ current profile on this machine.');
  assert.equal(stickyNote('default'), 'Blank runs Hermes’ default profile.');
  assert.equal(stickyNote(''), null);
});
