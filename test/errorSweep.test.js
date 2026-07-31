'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MessageStore } = require('../src/main/store.js');
const { SessionRegistry } = require('../src/main/sessions/registry.js');

// Errors an older version wrote into a session, and getting rid of them without
// getting rid of anything else.
//
// This is the only path in the app that deletes history a piece at a time, so
// what it will and will not match is the whole of its safety. The rule lives in
// the renderer; evaluate the one pure function here rather than pulling in a
// bundler.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'components', 'ErrorSweepModal.jsx'),
  'utf8'
);
const BODY = SRC.slice(SRC.indexOf('export function findKeptErrors')).replace(/^export\s+/gm, '');
const { findKeptErrors } = new Function(`${BODY}\n   return { findKeptErrors };`)();

const inbound = (id, text, extra = {}) => ({
  id,
  peerId: 'session:1',
  direction: 'in',
  kind: 'text',
  text,
  ts: 1,
  ...extra,
});

test('a kept error is matched by the prefix it was written with', () => {
  const found = findKeptErrors([inbound('e1', "⚠️ ACP call 'session/prompt' timed out.")]);
  assert.deepEqual(
    found.map((m) => m.id),
    ['e1']
  );
});

test('a message quoting an error is not one', () => {
  // Somebody pasting an error back to ask about it is exactly the message a
  // sweep must never touch, which is why the match is anchored rather than a
  // search for the glyph anywhere in the text.
  const thread = [
    inbound('a', "What does ⚠️ ACP call 'session/prompt' timed out. mean?"),
    { id: 'b', direction: 'out', kind: 'text', text: "⚠️ ACP call 'session/prompt' timed out.", ts: 1 },
    inbound('c', 'The answer is that the agent stopped responding.'),
  ];
  assert.deepEqual(findKeptErrors(thread), []);
});

test('an error still counting itself down is left alone', () => {
  // It is on screen, it is on its way out, and main never wrote it to disk —
  // offering to delete it would be offering to delete something that is not
  // there.
  const thread = [
    inbound('live', '⚠️ transport is down', { notice: true, error: true }),
    inbound('old', '⚠️ transport is down'),
  ];
  assert.deepEqual(
    findKeptErrors(thread).map((m) => m.id),
    ['old']
  );
});

test('files and empty threads match nothing', () => {
  assert.deepEqual(findKeptErrors([inbound('f', '⚠️ x', { kind: 'file' })]), []);
  assert.deepEqual(findKeptErrors([]), []);
  assert.deepEqual(findKeptErrors(null), []);
  assert.deepEqual(findKeptErrors([null, undefined, {}]), []);
});

// ---- taking them off disk ----

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-sweep-'));
  return { dir, store: new MessageStore(dir) };
}

test('remove takes exactly the named messages and nothing beside them', () => {
  const { store } = tmpStore();
  const thread = 'session:1';
  for (const m of [
    { id: 'q1', direction: 'out', kind: 'text', text: 'what is the time', ts: 1 },
    inbound('e1', '⚠️ transport is down'),
    { id: 'q2', direction: 'out', kind: 'text', text: 'and the date?', ts: 3 },
    inbound('a2', 'the 31st'),
  ]) {
    store.append(thread, m);
  }

  assert.equal(store.remove(thread, ['e1']), 1);
  assert.deepEqual(
    store.read(thread).map((m) => m.id),
    ['q1', 'q2', 'a2'],
    'the questions and the real answer stay'
  );
});

test('remove counts only what was really there', () => {
  // The number comes straight off the commit total, so counting an id that was
  // not in the file would take away work that was actually done.
  const { store } = tmpStore();
  store.append('session:1', inbound('e1', '⚠️ gone'));

  assert.equal(store.remove('session:1', ['e1', 'never-existed']), 1);
  assert.equal(store.remove('session:1', ['e1']), 0, 'and sweeping twice takes nothing the second time');
  assert.equal(store.remove('session:1', []), 0);
});

test('remove leaves other threads alone', () => {
  const { store } = tmpStore();
  store.append('session:1', inbound('e1', '⚠️ one'));
  store.append('session:2', inbound('e1', '⚠️ two'));

  store.remove('session:1', ['e1']);
  assert.deepEqual(store.read('session:1'), []);
  assert.equal(store.read('session:2').length, 1, 'the same id in another thread is a different message');
});

// ---- the arithmetic ----

test('the correction accumulates and never goes negative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-sweepreg-'));
  const sessions = new SessionRegistry(dir);
  const s = sessions.create({ title: 'PTT PWA Lan' });

  assert.equal(sessions.get(s.id).unlinkedFailures, undefined, 'nothing to correct to begin with');

  sessions.update(s.id, { unlinkedFailures: 2, needsContext: true });
  assert.equal(sessions.get(s.id).unlinkedFailures, 2);
  assert.equal(sessions.get(s.id).needsContext, true);

  // A session swept a second time must not forget the first correction.
  sessions.update(s.id, { unlinkedFailures: 1 });
  assert.equal(sessions.get(s.id).unlinkedFailures, 3);

  // Asking something new is what clears the warning — and only the warning. The
  // questions those errors belonged to are still gone.
  sessions.update(s.id, { needsContext: false });
  assert.equal(sessions.get(s.id).needsContext, false);
  assert.equal(sessions.get(s.id).unlinkedFailures, 3, 'the correction survives it');

  // A correction can never invent work.
  sessions.update(s.id, { unlinkedFailures: -99 });
  assert.equal(sessions.get(s.id).unlinkedFailures, 0);

  // And it survives a restart, or the number would go back up on the next launch.
  assert.equal(new SessionRegistry(dir).get(s.id).unlinkedFailures, 0);
});
