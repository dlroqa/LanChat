'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The link between a question that went unanswered and the one sent to replace
// it. Every rule here decides whether a bubble somebody can still read is
// deleted, so each one is worth stating on its own: an armed link that fires on
// the wrong event takes away a question nothing replaced.
//
// The module is ESM for the renderer; evaluate it here without pulling in a
// bundler by dropping the `export` keywords and returning the bindings — the
// same bargain sessionStanding.test.js makes.
const LIB = path.join(__dirname, '..', 'src', 'renderer', 'lib', 'resendLink.js');
const SRC = fs.readFileSync(LIB, 'utf8');
const { linkResend, markSent, clearLink, chatOutcome, roundOutcome, retire } = new Function(
  `${SRC.replace(/^export\s+/gm, '')}
   return { linkResend, markSent, clearLink, chatOutcome, roundOutcome, retire };`
)();

const THREAD = 'session:1';

// A question restored into the composer and then sent: the state every removal
// below starts from.
function armed(thread = THREAD, id = 'q1') {
  return markSent(linkResend({}, thread, id), thread, true);
}

test('a restored question is remembered against its thread', () => {
  const links = linkResend({}, THREAD, 'q1');
  assert.deepEqual(links[THREAD], { id: 'q1', sent: false });
});

test('restoring a second question replaces the first', () => {
  const links = linkResend(linkResend({}, THREAD, 'q1'), THREAD, 'q2');
  assert.deepEqual(links[THREAD], { id: 'q2', sent: false });
});

test('a restored question that was never sent survives an answer', () => {
  const links = linkResend({}, THREAD, 'q1');
  const out = retire(links, THREAD, 'answer');
  assert.equal(out.id, null);
  assert.deepEqual(out.links[THREAD], { id: 'q1', sent: false });
});

test('an answer retires the question the send replaced', () => {
  const out = retire(armed(), THREAD, 'answer');
  assert.equal(out.id, 'q1');
  assert.equal(out.links[THREAD], undefined);
});

test('a failure retires it too — the newer question carries the mark now', () => {
  const out = retire(armed(), THREAD, 'failure');
  assert.equal(out.id, 'q1');
  assert.equal(out.links[THREAD], undefined);
});

test('an empty run retires nothing, and still spends the link', () => {
  const out = retire(armed(), THREAD, 'empty');
  assert.equal(out.id, null, 'the old question is the only record left of two silences');
  assert.equal(out.links[THREAD], undefined, 'and it cannot be taken later by something unrelated');
});

test('nothing concluded leaves the link exactly where it was', () => {
  const links = armed();
  const out = retire(links, THREAD, null);
  assert.equal(out.id, null);
  assert.equal(out.links, links);
});

test('a refused send disarms the link without losing it', () => {
  const links = markSent(armed(), THREAD, false);
  assert.deepEqual(links[THREAD], { id: 'q1', sent: false });
  assert.equal(retire(links, THREAD, 'answer').id, null);
});

test('threads do not reach into each other', () => {
  const links = { ...armed('session:1', 'q1'), ...armed('agent:2', 'q2') };
  const out = retire(links, 'agent:2', 'answer');
  assert.equal(out.id, 'q2');
  assert.deepEqual(out.links['session:1'], { id: 'q1', sent: true });
});

test('a thread with no link is a no-op everywhere', () => {
  assert.deepEqual(retire({}, THREAD, 'answer'), { links: {}, id: null });
  assert.deepEqual(markSent({}, THREAD, true), {});
  assert.deepEqual(clearLink({}, THREAD), {});
  assert.deepEqual(linkResend({}, THREAD, null), {});
});

test('clearing a thread drops its link unfired', () => {
  assert.equal(clearLink(armed(), THREAD)[THREAD], undefined);
});

// --- what an event says about the run ---

test('an answer arriving is an answer', () => {
  assert.equal(chatOutcome({ direction: 'in', text: 'here you go' }), 'answer');
});

test('a failed run is a conclusion, not a silence', () => {
  assert.equal(chatOutcome({ direction: 'in', error: true, notice: true }), 'failure');
});

test('queue chatter concludes nothing', () => {
  assert.equal(chatOutcome({ direction: 'in', notice: true, text: 'you are #2 in line' }), null);
});

test('our own message back is not an answer to it', () => {
  assert.equal(chatOutcome({ direction: 'out', text: 'the question' }), null);
});

test('an open round has not finished anything', () => {
  assert.equal(roundOutcome({ open: true, answered: ['a1'], failed: [] }), null);
  assert.equal(roundOutcome({ answered: [] }), null, 'and neither has a payload that is not a round');
});

test('a closed round is read by what came back, not by who failed in it', () => {
  assert.equal(roundOutcome({ open: false, answered: ['a1'], failed: ['a2'] }), 'answer');
  assert.equal(roundOutcome({ open: false, answered: [], failedRef: 'q9' }), 'failure');
  assert.equal(roundOutcome({ open: false, answered: [], failedRef: null }), 'empty');
});

// --- the sequence the feature exists for ---

test('restore, send, answer: the failed question goes and the link with it', () => {
  let links = {};
  links = linkResend(links, THREAD, 'q1'); // the re-send button
  links = markSent(links, THREAD, true); // Send pressed
  const round = { open: false, sessionId: THREAD, answered: ['tessie'], failed: [], failedRef: null };
  const out = retire(links, THREAD, roundOutcome(round));
  assert.equal(out.id, 'q1');
  assert.deepEqual(out.links, {});
});

test('and a second failure retires the first, leaving one question marked', () => {
  let links = linkResend({}, THREAD, 'q1');
  links = markSent(links, THREAD, true);
  const round = { open: false, sessionId: THREAD, answered: [], failed: ['tessie'], failedRef: 'q2' };
  const out = retire(links, THREAD, roundOutcome(round));
  assert.equal(out.id, 'q1', 'the older duplicate goes; q2 is the one wearing the mark now');
});

// --- and what it looks like on the way out ---

// Everything above decides *whether* a question is retired. This decides what
// happens on screen when it is, and only a layout engine can answer it: the
// disintegration is a CSS rule, and a rule that matches nothing fails silently —
// the bubble simply blinks out and every assertion about the removal still
// passes. It was scoped to `.erasing.dissolving` until this feature, and
// `erasing` is worn by a failed run's *error*, never by the question it failed.
test('mounted in a browser: a retired question comes apart rather than blinking out', async () => {
  const { runRetireHarness } = require('../scripts/retire-harness.js');
  const result = await runRetireHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened — everything above still runs.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  const { marked, dissolving, plain } = result;

  // The bug this exists for: the row is animating, and for exactly as long as
  // App.jsx waits before taking the message away.
  assert.equal(dissolving.animation, 'bubble-disintegrate', 'a retired question blinked out');
  assert.equal(dissolving.duration, `${result.dissolveMs / 1000}s`);
  assert.equal(dissolving.fill, 'forwards', 'it must not snap back at the end and then vanish');
  // Without the caption's class: there is no countdown on this one, so the row
  // must not be taking the layout that exists to make room for one.
  assert.ok(!dissolving.classes.includes('erasing'), 'a retired question is not counting anything down');
  // Part-way through, frozen: coming apart, not gone. A value of 0 or 1 here
  // would mean the animation had not started or had already finished, and the
  // check above would be reading a rule nothing was applying yet.
  const mid = Number(dissolving.opacity);
  assert.ok(mid > 0 && mid < 1, `the bubble was not part-way out: opacity ${dissolving.opacity}`);

  // A question on its way out stops offering to be sent again.
  assert.equal(dissolving.button, null, 'a bubble that is leaving still offered to be re-sent');

  // While it is merely marked, all of that is the other way round: it holds
  // still, it says what happened, and the button is there and works.
  assert.equal(marked.animation, 'none', 'a question waiting to be re-sent was already leaving');
  assert.equal(marked.opacity, '1');
  assert.equal(marked.mark, '· not answered');
  assert.equal(marked.button?.name, 'Put this question back in the composer');
  assert.ok(marked.button.box.w >= 24 && marked.button.box.h >= 24, 'the button is too small to hit');
  assert.deepEqual(result.restored, ['q1'], 'pressing it did not hand back the question');

  // And an ordinary question is untouched by any of it.
  assert.equal(plain.animation, 'none');
  assert.equal(plain.mark, null);
  assert.equal(plain.button, null);
});

// The wiring, which is neither of the two above: the link is made by the button
// in App.jsx, armed by the send, and spent by the event that comes back. Nothing
// short of the real App can show that those three meet — so this is the real App,
// mounted in a browser with main stubbed out, doing what the person in the
// screenshot did.
test('mounted in a browser: re-send, answer, and the unanswered question goes', async () => {
  const { runResendHarness } = require('../scripts/resend-harness.js');
  const result = await runResendHarness();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }
  assert.deepEqual(result.errors, [], 'the window logged errors');
  assert.equal(result.threw, undefined, `the driver threw: ${result.threw}`);

  // Opened on a question main marked as unanswered, with the button beside it.
  assert.deepEqual(
    result.opened.map((m) => ({ failed: m.failed, resendable: m.resendable })),
    [{ failed: true, resendable: true }]
  );

  // Pressed: the words are in the composer and the thread has not changed. This
  // is a restore, not a re-send — the old bubble is still there to be read.
  assert.equal(result.restored, result.asked);
  assert.equal(result.afterRestore.length, 1);
  assert.equal(result.afterRestore[0].failed, true);

  // Sent again: two questions now, the older still wearing the mark.
  assert.equal(result.afterSend.length, 2, 'the re-send did not produce a second question');
  assert.deepEqual(
    result.afterSend.map((m) => m.failed),
    [true, false]
  );

  // The answer lands, and the older one is on its way out — coming apart, and no
  // longer offering to be sent a third time.
  assert.equal(result.going.length, 2, 'the old question went before it could be seen going');
  assert.equal(result.going[0].dissolving, true);
  assert.equal(result.going[0].animation, 'bubble-disintegrate');
  assert.equal(result.going[0].resendable, false);

  // And then it is gone — from the thread, and from main's copy of it.
  assert.deepEqual(
    result.settled.map((m) => m.failed),
    [false],
    'the unanswered question is still in the thread'
  );
  assert.deepEqual(result.calls.purge, [{ id: 'session:1', ids: ['session:1/q1'] }]);
  assert.deepEqual(result.leftOnDisk, ['session:1/n1'], 'history still holds the retired question');

  // A run that came back with nothing retires nothing: the mark and the button
  // are the only remaining word that this has now gone unanswered twice.
  assert.equal(result.afterEmpty.length, 2, 'an empty run took the question away');
  assert.equal(result.afterEmpty[0].failed, true);
  assert.equal(result.afterEmpty[0].resendable, true);

  // Nor does an answer to something else, when the restored words were never
  // sent — which is also the same link twice, and it may only be spent once.
  assert.equal(result.afterUnsent.length, 2, 'a question nobody re-sent was retired anyway');
  assert.equal(result.afterUnsent[0].failed, true);
  assert.deepEqual(result.tidesOnDisk, ['session:2/q1', 'session:2/n2']);
});
