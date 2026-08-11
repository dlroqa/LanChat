'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Turns with nothing in them, and — much more importantly — turns that only look
// like one.
//
// An agent is told to end on "nothing further." when it is done and to answer
// the observer with the single word NOTHING when it has nothing to add. Both are
// stored exactly as said, and a room fills up with bubbles that carry neither
// information nor a way of getting rid of them. This is the rule that decides
// which of those may go, and the half of it that matters is the half that says
// no: a real answer ending on the closing line keeps every word, including the
// line.
//
// Runs in the renderer (ESM for the browser), so the `export` keywords come off
// the same way test/sidebarSections.test.js loads the panel's arithmetic.
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const { isEmptyBody, isEmptyTurn, findEmptyTurns } = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'emptyTurn.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { isEmptyBody, isEmptyTurn, findEmptyTurns };`
)();

const SESSION = { isSession: true };

// An agent's answer in a room, as the host's copy has it. `agentId` is what says
// an agent said it — see ipc.js, which stamps it on the way in.
const said = (text, extra = {}) => ({
  id: 'm1',
  direction: 'in',
  kind: 'text',
  text,
  agentId: 'agent:mac',
  speaker: 'Mac',
  ...extra,
});

test('a bubble that says only that it has nothing to say', () => {
  assert.equal(isEmptyBody('NOTHING'), true);
  assert.equal(isEmptyBody('nothing further.'), true);

  // The shapes a model actually produces around a word it was told to say on
  // its own: quotes, a full stop, a leading dash, whitespace either side.
  assert.equal(isEmptyBody('"NOTHING."'), true);
  assert.equal(isEmptyBody("'nothing'"), true);
  assert.equal(isEmptyBody('NOTHING!'), true);
  assert.equal(isEmptyBody('  nothing further.  '), true);
  assert.equal(isEmptyBody('— nothing further.'), true);
  assert.equal(isEmptyBody('- Nothing Further'), true);
  assert.equal(isEmptyBody('\n\nnothing further.\n\n'), true, 'blank lines around it are not content');
});

test('a bubble with anything else in it is kept, whole', () => {
  // The one from the screenshot this was built from. It reasons, it concludes,
  // and then it closes — and the closing line is part of how a person reading
  // the conversation back would expect it to end. Deleting this would take the
  // answer with it.
  const zima = [
    "The answer's been given and independently verified — no rain for Brentwood through Thursday.",
    'Two agents confirming the same zero is where this one closes.',
    '',
    'nothing further.',
  ].join('\n');
  assert.equal(isEmptyBody(zima), false, 'context is saved');
  assert.equal(isEmptyTurn(said(zima), SESSION), false);

  // The same shape, shorter, and the same answer: one line of content is still
  // content.
  assert.equal(isEmptyBody('No rain.\nnothing further.'), false);
  assert.equal(isEmptyBody('nothing further.\nActually, one more thing:'), false);

  // The words inside a sentence are just words.
  assert.equal(isEmptyBody('There is NOTHING in the forecast.'), false);
  assert.equal(isEmptyBody('I have nothing further to add about the roof.'), false);
  assert.equal(isEmptyBody('nothing further?'), false, 'a question is not the closing line');

  // And nothing at all is not a turn with nothing in it — it is a turn that
  // never arrived, which is somebody else's problem.
  assert.equal(isEmptyBody(''), false);
  assert.equal(isEmptyBody(null), false);
  assert.equal(isEmptyBody(undefined), false);
});

test('only an agent turn in a room, and only one that was written down', () => {
  assert.equal(isEmptyTurn(said('nothing further.'), SESSION), true);
  assert.equal(isEmptyTurn(said('NOTHING'), SESSION), true);

  // A guest's copy of the same answer. The wire attribution is `speakerId`,
  // deliberately never `agentId` — so both have to count, or this would erase
  // on the host and not on the guest.
  const guestCopy = {
    id: 'm1',
    direction: 'in',
    kind: 'text',
    text: 'NOTHING',
    speakerId: 'x',
    speaker: 'Mac',
  };
  assert.equal(isEmptyTurn(guestCopy, SESSION), true);

  // A person in the room who happens to say it keeps their words. They are
  // theirs, and a member's relayed sentence carries no agent attribution.
  const person = { id: 'm2', direction: 'in', kind: 'text', text: 'nothing further.', speaker: 'Elijah' };
  assert.equal(isEmptyTurn(person, SESSION), false, "a person's own words are never deleted");

  // Nor is anything you typed yourself.
  assert.equal(isEmptyTurn(said('NOTHING', { direction: 'out' }), SESSION), false);

  // Not outside a room: the closing line and the observer's word are both things
  // said in one, and an agent's own thread has neither.
  assert.equal(isEmptyTurn(said('NOTHING'), { isSession: false }), false);
  assert.equal(isEmptyTurn(said('NOTHING')), false, 'and nothing is assumed about where it was said');

  // Notices and errors are never stored and have their own clocks; an imported
  // transcript is the reader's own file and is not this rule's to edit.
  assert.equal(isEmptyTurn(said('NOTHING', { notice: true }), SESSION), false);
  assert.equal(isEmptyTurn(said('NOTHING', { error: true }), SESSION), false);
  assert.equal(isEmptyTurn(said('nothing further.', { imported: true }), SESSION), false);
  assert.equal(isEmptyTurn(said('NOTHING', { kind: 'file' }), SESSION), false);
  assert.equal(isEmptyTurn(null, SESSION), false);
});

test('a history is swept by exactly the same rule', () => {
  const hist = [
    said('So: no rain.', { id: 'a' }),
    said('nothing further.', { id: 'b' }),
    said('One more thing, then.\n\nnothing further.', { id: 'c' }),
    said('NOTHING', { id: 'd' }),
    { id: 'e', direction: 'out', kind: 'text', text: 'thanks' },
  ];
  assert.deepEqual(
    findEmptyTurns(hist, SESSION).map((m) => m.id),
    ['b', 'd']
  );
  assert.deepEqual(findEmptyTurns([], SESSION), []);
  assert.deepEqual(findEmptyTurns(null, SESSION), []);
});

test('the renderer and main still agree about what an agent was told to say', () => {
  // Two files decide this between them: main writes the instruction into the
  // prompt, the renderer decides what may be erased. They cannot import each
  // other — one is CommonJS in the main process, the other ESM in the browser —
  // so the copy is checked against the original here rather than trusted.
  //
  // \r\n is normalised because this reads source as text: on the Windows runner
  // the same file arrives with different line endings, and that is the only
  // place a test like this fails.
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const dialogue = read('src/main/sessions/dialogue.js');
  const observer = read('src/main/sessions/observerPrompt.js');

  const closing = dialogue.match(/const CLOSING_LINE = '([^']+)'/);
  assert.ok(closing, 'dialogue.js should still name the line it asks agents to end on');
  assert.equal(
    isEmptyBody(closing[1]),
    true,
    `the renderer should recognise the line main asks for: ${closing[1]}`
  );

  const nothing = observer.match(/const NOTHING = '([^']+)'/);
  assert.ok(nothing, 'observerPrompt.js should still name the word it asks for');
  assert.equal(isEmptyBody(nothing[1]), true, `the renderer should recognise ${nothing[1]}`);

  // And the prompts really do ask for them, so this is a rule about what agents
  // are told rather than about two constants nobody uses.
  assert.match(dialogue, /end your reply with a line reading: \$\{CLOSING_LINE\}/);
  assert.match(observer, /reply with exactly: \$\{NOTHING\}/);
});

test('the countdown on the bubble and the timer that removes it are one number', () => {
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8').replace(/\r\n/g, '\n');
  const bubble = fs
    .readFileSync(path.join(SRC, 'components', 'MessageBubble.jsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  const ms = app.match(/const EMPTY_TURN_TTL_MS = (\d+);/);
  const s = bubble.match(/const EMPTY_TURN_TTL_S = (\d+);/);
  assert.ok(ms && s, 'both halves should still name the interval');
  assert.equal(Number(ms[1]), 4000, 'four seconds, as asked for');
  assert.equal(Number(s[1]) * 1000, Number(ms[1]), 'the sentence should not promise a clock nobody keeps');

  // The removal is the timer's, never the animation's: reduced motion turns the
  // dissolve off outright, and an animationend that never fires would leave the
  // bubble on screen for ever.
  assert.match(app, /prefersReducedMotion\(\) \? 0 : DISSOLVE_MS/);

  // Off the disk as well as off the screen — the whole point is a clean export.
  assert.match(app, /api\.purgeMessages\(thread, ids\)/);
});
