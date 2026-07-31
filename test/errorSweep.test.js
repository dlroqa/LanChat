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
const BODY = SRC.slice(SRC.indexOf('// Which messages in a loaded history are errors')).replace(
  /^export\s+/gm,
  ''
);
const { findKeptErrors, findSummonLeftovers } = new Function(
  `${BODY}\n   return { findKeptErrors, findSummonLeftovers };`
)();

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

// ---- what a summon used to leave behind ----

const outbound = (id, text, extra = {}) => ({
  id,
  peerId: 'remote-agent:server:a1',
  direction: 'out',
  kind: 'text',
  text,
  ts: 1,
  ...extra,
});

test('both halves of an old summon are matched', () => {
  const thread = [
    outbound('s1', '@Tessie'),
    inbound('g1', 'Hello — Tessie here. Ask me anything.'),
    inbound('g2', 'Hello — Hermes here. Ask me anything.'),
  ];
  assert.deepEqual(
    findSummonLeftovers(thread).map((m) => m.id),
    ['s1', 'g1', 'g2']
  );
});

test('a real question that opens with a mention is not a summon line', () => {
  // The distinction the whole matcher rests on: `@Tessie` alone is the bubble a
  // summon used to write, `@Tessie …` is something somebody asked.
  const thread = [
    outbound('q1', '@Tessie what is the time'),
    outbound('q2', '@Tessie '),
    outbound('q3', 'ask @Tessie about it'),
  ];
  assert.deepEqual(findSummonLeftovers(thread), []);
});

test('direction is respected in both directions', () => {
  const thread = [
    // A peer said this to us; it is theirs, not machinery of ours.
    inbound('i1', '@Tessie'),
    // And we never wrote the greeting — only the owner's machine did.
    outbound('o1', 'Hello — Tessie here. Ask me anything.'),
  ];
  assert.deepEqual(findSummonLeftovers(thread), []);
});

test('a message about a greeting is not a greeting', () => {
  const thread = [
    inbound('a', 'It said "Hello — Tessie here. Ask me anything." and nothing else.'),
    inbound('b', 'Hello — Tessie here. Ask me anything. What can I do?'),
  ];
  assert.deepEqual(findSummonLeftovers(thread), []);
});

test('anything already counting itself down is left alone', () => {
  // It is on screen with a timer running and was never on disk, so there is
  // nothing here to take off it.
  const thread = [inbound('live', 'Hello — Tessie here. Ask me anything.', { notice: true })];
  assert.deepEqual(findSummonLeftovers(thread), []);
});

test('leftovers and empty threads', () => {
  assert.deepEqual(findSummonLeftovers([]), []);
  assert.deepEqual(findSummonLeftovers(null), []);
  assert.deepEqual(findSummonLeftovers([null, undefined, {}]), []);
  assert.deepEqual(findSummonLeftovers([outbound('f', '@Tessie', { kind: 'file' })]), []);
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

test('an agent thread can be purged too, not just a session', () => {
  // The summon leftovers live in agent threads, which have no Commit box — so
  // they go through the plain purge rather than the session sweep.
  const { store } = tmpStore();
  const thread = 'remote-agent:server:a1';
  store.append(thread, outbound('s1', '@Tessie'));
  store.append(thread, inbound('g1', 'Hello — Tessie here. Ask me anything.'));
  store.append(thread, outbound('q1', '@Tessie what is the time'));
  store.append(thread, inbound('a1', 'Half past.'));

  assert.equal(store.remove(thread, ['s1', 'g1']), 2);
  assert.deepEqual(
    store.read(thread).map((m) => m.id),
    ['q1', 'a1'],
    'the question and its answer stay'
  );
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
