'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load } = require('../scripts/lib/reactDrive.js');

// Why a discussion stopped, on the screen.
//
// This is the seam that made the original bug unreadable rather than merely
// wrong. Main worked out the sentence and published it; `roundSummary` was
// written to render it and tested to prove it; and in between, the window threw
// away the only view that carried it — a closing round was deleted from state
// the instant it arrived, and no component ever imported the function. Three
// correct pieces and no path between them, so a discussion that ended sat there
// saying nothing at all.
//
// Asserted against the real component and the real copy, because the bug lived
// in the wiring and nothing smaller than the wiring would have caught it.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const ChatPane = load(path.join(SRC, 'components', 'ChatPane.jsx')).default;
const { paletteFor } = load(path.join(SRC, 'lib', 'agentColor.js'));

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x2014;/g, '—');

const SESSION = { id: 'session:1', name: 'Brainstorm', kind: 'session', agentIds: ['a', 'b', 'c'] };

const pane = (props) =>
  readable(
    renderToStaticMarkup(
      React.createElement(ChatPane, {
        peer: SESSION,
        messages: [],
        agents: [],
        counselAgents: [],
        progress: {},
        ...props,
      })
    )
  );

// A round view in the shape main publishes, so a field renamed there fails here.
const closed = (extra) => ({
  sessionId: SESSION.id,
  open: false,
  mode: 'dialogue',
  answered: [],
  empty: [],
  failed: [],
  notices: [],
  ...extra,
});

const live = (extra) => ({
  sessionId: SESSION.id,
  open: true,
  mode: 'dialogue',
  answered: [],
  empty: [],
  failed: [],
  running: [],
  asked: [],
  missed: [],
  next: [],
  notices: [],
  ...extra,
});

test('the reason a discussion ended is on the screen when it ends', () => {
  const html = pane({
    lastRound: closed({
      answered: ['a', 'b'],
      endedNotice: 'The discussion ended because there was nothing further to add. It used 4 of 12 turns.',
    }),
  });
  assert.match(html, /nothing further to add/, 'the sentence main wrote reaches the reader');
  assert.match(html, /4 of 12 turns/, 'including how much of the budget it spent');
  assert.match(html, /round-note/, 'as a note about the round, not as a message from anybody');
});

test('an agent that dropped out is named while the discussion carries on', () => {
  const html = pane({
    round: live({
      answered: ['a'],
      notices: ['Beacon had nothing further to add. The other 3 carried on.'],
    }),
  });
  assert.match(html, /Beacon had nothing further to add\. The other 3 carried on\./);
});

test('a live round shows its departures, not a finished one’s ending', () => {
  // Both are never set at once — main clears one as it sets the other — but a
  // window showing the last discussion's ending underneath a running one would
  // be describing the wrong conversation, so the precedence is pinned.
  const html = pane({
    round: live({ notices: ['Wren could not answer. The other two carried on.'] }),
    lastRound: closed({
      answered: ['a'],
      endedNotice: 'The discussion ended because you stopped it. It used 2 of 6 turns.',
    }),
  });
  assert.match(html, /Wren could not answer/);
  assert.ok(!html.includes('you stopped it'), 'the finished one is not shown over the live one');
});

test('a round with nothing to say about itself adds nothing to the conversation', () => {
  assert.ok(!pane({}).includes('round-note'), 'no round, no note');
  assert.ok(
    !pane({ lastRound: closed({ mode: 'parallel' }) }).includes('round-note'),
    'and a round nobody answered and nothing was said about stays quiet'
  );
});

// ---- one colour per agent, all the way to the markup ----

// The palette is proved on its own in agentColor.test.js. What is proved here is
// that it arrives: a colour that is correct and never set on an element is the
// same to a reader as no colour at all, which is exactly how the ending notice
// managed to be right and invisible for so long.

const ANSWERS = [
  { id: 'm1', direction: 'out', kind: 'text', text: 'what should we call it?', ts: 1 },
  {
    id: 'm2',
    direction: 'in',
    kind: 'text',
    text: 'Beacon is taken.',
    ts: 2,
    speaker: 'Hermes',
    agentId: 'a',
  },
  { id: 'm3', direction: 'in', kind: 'text', text: 'Then Wren.', ts: 3, speaker: 'Tessie', agentId: 'b' },
  {
    id: 'm4',
    direction: 'in',
    kind: 'text',
    text: 'Wren is a bird.',
    ts: 4,
    speaker: 'Beacon',
    agentId: 'c',
  },
];
const COUNSEL = [
  { id: 'a', name: 'Hermes', ready: true },
  { id: 'b', name: 'Tessie', ready: true },
  { id: 'c', name: 'Beacon', ready: true },
];

test('each agent’s answers carry that agent’s colour', () => {
  const html = pane({ messages: ANSWERS, agents: COUNSEL });
  const palette = paletteFor(['a', 'b', 'c']);

  for (const id of ['a', 'b', 'c']) {
    assert.ok(
      html.includes(`--agent-color:${palette.get(id)}`),
      `${id}'s colour should reach the bubble it wrote`
    );
  }
  assert.equal(new Set([...palette.values()]).size, 3, 'and the three are different colours');
  assert.equal((html.match(/bubble-row[^"]*agent/g) || []).length, 3, 'one coloured row per answer');
});

test('what the person wrote is not coloured as an agent', () => {
  // The colour says which agent spoke. A question somebody typed has no agent
  // behind it, and giving it one would put the reader into the counsel.
  const html = pane({ messages: ANSWERS, agents: COUNSEL });
  assert.ok(
    !/bubble-row[^"]*\bout\b[^"]*\bagent\b/.test(html),
    'the question somebody typed is never one of the coloured rows'
  );
  assert.equal(
    (html.match(/--agent-color/g) || []).length,
    3,
    'three answers, three colours, and nothing else tinted'
  );
});

test('an agent thread is not coloured at all', () => {
  // One voice, so there is nothing to tell apart, and a colour would be
  // decoration claiming to be information.
  const html = readable(
    renderToStaticMarkup(
      React.createElement(ChatPane, {
        peer: { id: 'agent:x', name: 'Hermes', kind: 'agent' },
        messages: ANSWERS,
        agents: COUNSEL,
        counselAgents: [],
        progress: {},
      })
    )
  );
  assert.ok(!html.includes('--agent-color'));
});

test('a counsel that was not unanimous still reports what came back', () => {
  // Not a dialogue, so there is no ending to give — but "three were asked and
  // two answered" is what a reader wants to know, and roundSummary has always
  // been able to say it. It simply had nowhere to say it.
  const html = pane({ lastRound: closed({ mode: 'parallel', answered: ['a', 'b'], empty: ['c'] }) });
  assert.match(html, /2 answered/);
  assert.match(html, /1 had nothing to say/);
});
