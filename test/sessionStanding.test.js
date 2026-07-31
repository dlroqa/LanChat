'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The session panel's status row and its Status box both read one derivation, so
// a disagreement between them can only come from here — the same bargain the
// agent panel makes with turnStanding.js. The Commit box reads the other export,
// and what it counts is a promise: the questions asked *in this session*, which
// is not the same as the messages in it.
//
// The module is ESM for the renderer; evaluate it here without pulling in a
// bundler by dropping the `export` keywords and returning the bindings.
const LIB = path.join(__dirname, '..', 'src', 'renderer', 'lib', 'sessionStanding.js');
const SRC = fs.readFileSync(LIB, 'utf8');
const { sessionStanding, sessionStandingLabel, commitCount } = new Function(
  `${SRC.replace(/^export\s+/gm, '')}
   return { sessionStanding, sessionStandingLabel, commitCount };`
)();

// A session as the renderer synthesises it: a title, and the agent it asks
// resolved to a name (App.jsx does the resolving, so a dangling id arrives here
// as no name at all).
const bound = (extra) => ({ id: 'session:1', kind: 'session', name: 'Notes', agentName: 'Tessie', ...extra });

test('idle with an agent is Listening', () => {
  const s = sessionStanding(bound(), false, 'Thinking');
  assert.deepEqual(s, { key: 'listening', label: 'Listening', word: 'Listening', tone: 'ready' });
});

test('working is Forking in the box and the live phrase in the row', () => {
  const s = sessionStanding(bound(), true, 'Piecing it together');
  assert.equal(s.key, 'forking');
  assert.equal(s.word, 'Forking');
  assert.equal(s.tone, 'busy');
  // The row says what the chat indicator is saying at this instant; the box says
  // what the work is, which does not change every 2.6 seconds.
  assert.equal(s.label, 'Piecing it together');
});

test('working without a phrase to hand still has a word to type', () => {
  const s = sessionStanding(bound(), true, '');
  assert.equal(s.label, 'Forking');
});

test('no agent is Add agent, and says so even while a stale flag says busy', () => {
  const s = sessionStanding(bound({ agentName: null }), true, 'Thinking');
  assert.deepEqual(s, { key: 'unbound', label: 'Add agent', word: 'Add agent', tone: 'off' });
});

test('an agent that is no longer here reads the same as never having chosen one', () => {
  // App.jsx resolves the record's agentId against the agents it can reach, so a
  // session pointed at something gone arrives with an id and no name.
  const s = sessionStanding(bound({ agentId: 'agent:gone', agentName: null }), false, '');
  assert.equal(s.key, 'unbound');
});

test('no peer, no standing', () => {
  assert.equal(sessionStanding(null, false, ''), null);
});

test('every standing spells itself out for the tooltip and the screen reader', () => {
  assert.match(sessionStandingLabel(bound(), false), /Listening — Tessie is free/);
  assert.match(sessionStandingLabel(bound(), true), /Forking — Tessie is working/);
  assert.match(sessionStandingLabel(bound({ agentName: null }), false), /choose one in the header/);
  assert.equal(sessionStandingLabel(null, false), '');
});

// ---- Commit ----

test('a commit is a question asked here, and nothing else is', () => {
  const thread = [
    // Loaded from a saved transcript: that conversation was had somewhere else.
    { direction: 'out', kind: 'text', text: 'from the transcript', imported: true },
    { direction: 'in', kind: 'text', text: 'also from the transcript', imported: true },
    // Two questions actually asked in this session.
    { direction: 'out', kind: 'text', text: 'what about this bit?' },
    { direction: 'in', kind: 'text', text: 'the answer' },
    { direction: 'out', kind: 'text', text: 'and this one?' },
    // Refused: shown, then taken away again. Counting it would tick the box up
    // and back down for something that was never asked.
    { direction: 'out', kind: 'text', text: 'too soon', rejected: true },
    // The line the app writes to explain the refusal.
    { direction: 'in', kind: 'text', text: 'one at a time, please', notice: true },
    // A file sent to a peer is not a question.
    { direction: 'out', kind: 'file', name: 'notes.pdf' },
  ];
  assert.equal(commitCount(thread), 2);
});

test('an empty or unloaded thread is nought rather than nothing', () => {
  assert.equal(commitCount([]), 0);
  assert.equal(commitCount(undefined), 0);
  assert.equal(commitCount(null), 0);
});

test('a message with no kind at all still counts as one that was said', () => {
  assert.equal(commitCount([{ direction: 'out', text: 'asked' }]), 1);
});

// ---- The one coupling neither side can see ----
//
// The tinted stat box is a class name agreed between ConnectionPanel.jsx and
// styles.css and written down nowhere else. A tone the component can produce and
// the stylesheet has no rule for is an untinted box that looks like every other
// one — no error, no warning, nothing to notice until somebody looks at the
// panel. The names used to be the agent's alone (`stat-turn`); a session
// borrowing the same machinery is exactly the change that could leave half of a
// rename behind, so both halves are pinned here.
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const PANEL = fs.readFileSync(path.join(RENDERER, 'components', 'ConnectionPanel.jsx'), 'utf8');
const CSS = fs.readFileSync(path.join(RENDERER, 'styles.css'), 'utf8');

test('every tone a stat box can wear has a tint to wear', () => {
  const turn = ['waiting', 'brace', 'ready', 'handover', 'offline'];
  const session = ['listening', 'forking', 'unbound', 'commit'];
  for (const tone of [...turn, ...session]) {
    assert.match(CSS, new RegExp(`\\.stat-tint-${tone}\\s*[,{]`), `styles.css has no tint for ${tone}`);
  }
});

test('the box and its tint layer are the ones the stylesheet draws', () => {
  assert.match(PANEL, /stat stat-tint stat-tint-\$\{tone\}/);
  assert.match(PANEL, /className="stat-tint-wash"/);
  assert.match(CSS, /\.stat-tint-wash\s*\{/);
  // Half a rename is the failure this is here to catch.
  assert.doesNotMatch(PANEL, /stat-turn/);
  assert.doesNotMatch(CSS, /stat-turn/);
});
