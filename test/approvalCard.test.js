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
