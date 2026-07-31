'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// What the `@` menu offers, and when it offers anything at all.
//
// The two exported helpers are the whole of the decision — the component only
// draws what they return — and they are the half of this feature that has to
// agree with main. `matchMention` in agents/remote.js routes a mention only when
// the message *starts* with `@`, so a menu that opened anywhere else would be
// completing to something that lands in the human's chat instead. That agreement
// is asserted here against the real source of both.
//
// The module is ESM for the renderer and imports React; evaluate just the two
// pure functions here rather than pulling in a bundler.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'components', 'MentionMenu.jsx'),
  'utf8'
);
const BODY = SRC.slice(SRC.indexOf('export function mentionQuery')).replace(/^export\s+/gm, '');
const { mentionQuery, matchMentions } = new Function(
  `${BODY}
   return { mentionQuery, matchMentions };`
)();

const agents = [
  { id: 'r1', name: 'Tessie', viaName: 'Server' },
  { id: 'r2', name: 'Tesla', viaName: 'Server' },
  { id: 'r3', name: 'Hermes', viaName: 'Server' },
];

test('an @ at the start of the message opens the menu', () => {
  assert.equal(mentionQuery('@', 1), '');
  assert.equal(mentionQuery('@tes', 4), 'tes');
});

test('an @ anywhere else does not, because nothing would route it', () => {
  // main requires the message to start with `@`. Offering a completion here
  // would send the whole line to the person instead of to the agent.
  assert.equal(mentionQuery('ask @tes', 8), null);
  assert.equal(mentionQuery('hello @', 7), null);
  assert.equal(mentionQuery(' @tes', 5), null);
});

test('the menu closes once the mention is finished', () => {
  // A space ends the name: from here on it is a question being typed, not a
  // name being chosen.
  assert.equal(mentionQuery('@Tessie what is the time', 24), null);
  assert.equal(mentionQuery('@Tessie ', 8), null);
});

test('the caret decides, not the end of the text', () => {
  // Clicking back into the mention re-opens it; sitting past it does not.
  assert.equal(mentionQuery('@Tessie hello', 4), 'Tes');
  assert.equal(mentionQuery('@Tessie hello', 13), null);
});

test('nothing typed at all is not a mention', () => {
  assert.equal(mentionQuery('', 0), null);
  assert.equal(mentionQuery('hello', 5), null);
  assert.equal(mentionQuery(null, 0), null);
});

test('matching is by prefix, case-insensitive, and in name order', () => {
  assert.deepEqual(
    matchMentions(agents, 'te').map((a) => a.name),
    ['Tesla', 'Tessie']
  );
  assert.deepEqual(
    matchMentions(agents, 'TESS').map((a) => a.name),
    ['Tessie']
  );
  // Prefix, not substring: `@rmes` is not a way of reaching Hermes, because it
  // is not a way of reaching it in main either.
  assert.deepEqual(matchMentions(agents, 'rmes'), []);
});

test('a bare @ offers everything there is', () => {
  assert.equal(matchMentions(agents, '').length, 3);
});

test('with nobody to suggest there is nothing to open', () => {
  // The load-bearing case for the summon gate: no agents online means no menu,
  // so no completion, so no summon can be started from one.
  assert.deepEqual(matchMentions([], ''), []);
  assert.deepEqual(matchMentions(agents, null), []);
});

// ---- The agreement with main ----
//
// The rule the menu is built around lives in another file, in another process,
// and is written down nowhere else. If it is ever relaxed there, this is what
// says the menu has to be relaxed with it.
test('main still routes a mention only from the start of the message', () => {
  const remote = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agents', 'remote.js'), 'utf8');
  assert.match(
    remote,
    /if \(!trimmed\.startsWith\('@'\)\) return null;/,
    'matchMention no longer anchors at the start — the composer menu must change with it'
  );
});
