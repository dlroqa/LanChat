'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load } = require('../scripts/lib/reactDrive.js');

// The one line on an approval card that says whose decision it is.
//
// It is worth pinning because it is the only thing distinguishing four
// materially different situations that otherwise draw the same card — and the
// one that matters most is the one where clicking Allow runs a command on a
// machine the reader is not sitting at. A card that read the same in that case
// as in the local one would be inviting somebody to approve something for
// somebody else's computer without knowing they were doing it.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const AgentApproval = load(path.join(SRC, 'components', 'AgentApproval.jsx')).default;

const readable = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();

const draw = (request) =>
  renderToStaticMarkup(
    React.createElement(AgentApproval, { request, agentName: 'Tessie', onAnswer: () => {} })
  );

const base = { runId: 'r1', command: 'rm -rf /', choices: ['once', 'always', 'deny'] };

test('with nobody delegated, the card says what it always said', () => {
  const text = readable(draw(base));
  assert.match(text, /Tessie wants to run something on this device/);
  assert.match(text, /Only you can answer this\. Peers cannot approve it\./);
});

test('a pending handover names who else may answer, and when', () => {
  const text = readable(draw({ ...base, delegates: [{ id: 'p1', name: 'Ada' }], handoverMs: 20000 }));
  assert.match(text, /You can answer this\. If you do not, Ada may answer it in 20s\./);
  assert.doesNotMatch(text, /Peers cannot approve it/);
});

test('with the handover already open, it is a race and says so', () => {
  const text = readable(
    draw({
      ...base,
      delegates: [
        { id: 'p1', name: 'Ada' },
        { id: 'p2', name: 'Grace' },
      ],
      handoverMs: 0,
    })
  );
  assert.match(text, /You can answer this, and so can Ada, Grace — whoever gets there first\./);
});

test('answering for somebody else says whose machine it runs on, twice', () => {
  const html = draw({ ...base, remote: true, viaOwner: 'Ada' });
  const text = readable(html);
  // Once in the heading, because "this device" would be a lie...
  assert.match(text, /Tessie wants to run something on Ada's device/);
  // ...and once in the hint, because the consequence is the whole point.
  assert.match(text, /Whatever you choose runs on their device, not yours\./);
  // And the card carries its own modifier, so it cannot be mistaken at a glance
  // for the local one.
  assert.match(html, /class="agent-approval agent-approval-remote"/);
});

test('a deny is always offered, however the choices arrived', () => {
  // The existing guarantee, re-asserted here because a delegate is now one of
  // the people relying on it: there must never be a prompt that cannot be
  // refused, whether the transport sent strings or objects.
  const strings = readable(draw({ ...base, choices: ['once'] }));
  assert.match(strings, /Deny/);
  const objects = readable(draw({ ...base, choices: [{ id: 'go', label: 'Proceed' }] }));
  assert.match(objects, /Proceed/);
  assert.match(objects, /Deny/);
});

// ---- the seams either side of the card ----
//
// The defect that shipped in 0.8.3 was a callback's argument list, invisible to
// every assertion on markup. These are the other two places in this feature
// where a value is handed across a prop boundary, so they are driven rather
// than read: a button pressed here has to arrive at the bridge as the same
// thing, and nothing about the rendered output would say if it did not.

const { mount, find, findAll } = require('../scripts/lib/reactDrive.js');
const ConnectionPanel = load(path.join(SRC, 'components', 'ConnectionPanel.jsx')).default;

// The harness renders one component, not its children — so a panel that returns
// `<AgentPanel …/>` hands back an element, and searching it finds nothing
// inside. Mounting that element is what carries the props across the boundary,
// which is precisely the hand-off being tested: a prop dropped on the way down
// is invisible until something on the far side is asked to use it.
function into(element, extra = {}) {
  assert.equal(typeof element.type, 'function', 'a component element to descend into');
  return mount(element.type, { ...element.props, ...extra });
}

// JSX children arrive as an array — `Answer approvals for {name}…` is three
// entries — so stringifying the array puts commas between them and a plain
// regex on it never matches what a person reads. Flattened first.
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props && node.props.children);
  return String(node);
}

const buttonSaying = (re) => (n) => n.type === 'button' && re.test(textOf(n));

test('pressing a choice hands that choice on, and nothing else', () => {
  const chosen = [];
  const view = mount(AgentApproval, {
    request: { ...base, choices: ['once', 'always', 'deny'] },
    agentName: 'Tessie',
    onAnswer: (...args) => chosen.push(args),
  });
  const buttons = findAll(view.tree, (n) => n.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.props.children),
    ['Allow once', 'Always allow', 'Deny']
  );
  buttons[1].props.onClick();
  assert.deepEqual(chosen, [['always']], 'the id travels, alone');
  view.unmount();
});

test('the passcode a delegate types reaches the bridge under its thread id', async (t) => {
  const asked = [];
  const peer = {
    id: 'remote-agent:owner-1:agent:9',
    kind: 'agent',
    name: 'Tessie',
    remote: true,
    viaName: 'Ada',
    online: true,
    avatar: { color: '#7c3aed', image: null },
  };

  // Three boundaries, each one a place the settings bug could have happened
  // again: panel -> agent panel -> claim form.
  const panel = mount(ConnectionPanel, { peer, onClaimApprovals: (...a) => asked.push(a) });
  t.after(() => panel.unmount());
  const agentPanel = into(panel.tree);
  t.after(() => agentPanel.unmount());

  const claimEl = find(agentPanel.tree, (n) => n.props && typeof n.props.onClaim === 'function');
  assert.ok(claimEl, 'a remote agent is offered the chance to take approvals');
  const claim = into(claimEl);
  t.after(() => claim.unmount());

  find(claim.tree, buttonSaying(/Answer approvals for Ada/)).props.onClick();
  await claim.settle();

  const field = find(claim.tree, (n) => n.props && n.props.id === 'approval-passcode');
  assert.ok(field, 'the passcode field appears');
  assert.equal(field.props.type, 'password', 'and is not typed in the clear');
  field.props.onChange({ target: { value: 'let me in' } });
  await claim.settle();

  find(claim.tree, buttonSaying(/^Ask$/)).props.onClick();
  await claim.settle();

  assert.deepEqual(asked, [[peer.id, 'let me in']], 'the thread and the passcode, in that order');
  // And nothing is left lying in the component afterwards.
  assert.equal(
    find(claim.tree, (n) => n.props && n.props.id === 'approval-passcode'),
    null,
    'the form closes rather than keeping what was typed'
  );
});

test('a granted claim says so instead of asking again', () => {
  const peer = {
    id: 'remote-agent:o:a',
    kind: 'agent',
    name: 'Tessie',
    remote: true,
    viaName: 'Ada',
    online: true,
    avatar: {},
  };
  const panel = mount(ConnectionPanel, { peer, approvalClaim: { ok: true }, onClaimApprovals: () => {} });
  const agentPanel = into(panel.tree);
  const claim = into(find(agentPanel.tree, (n) => n.props && typeof n.props.onClaim === 'function'));
  assert.equal(find(claim.tree, buttonSaying(/Answer approvals/)), null, 'nothing left to ask for');
  assert.match(
    renderToStaticMarkup(React.createElement(() => claim.tree)),
    /You can answer this agent&#x27;s approval prompts for Ada/
  );
  claim.unmount();
  agentPanel.unmount();
  panel.unmount();
});

test('a local agent is never offered somebody else’s approval rights', () => {
  const panel = mount(ConnectionPanel, {
    peer: { id: 'agent:1', kind: 'agent', name: 'Tessie', online: true, avatar: {} },
    onClaimApprovals: () => assert.fail('nothing to claim on your own machine'),
  });
  const agentPanel = into(panel.tree);
  // Asserted inside the panel, not against an unrendered element: the claim form
  // is simply not among the children an agent of your own produces.
  assert.equal(
    find(agentPanel.tree, (n) => n.props && typeof n.props.onClaim === 'function'),
    null
  );
  agentPanel.unmount();
  panel.unmount();
});
