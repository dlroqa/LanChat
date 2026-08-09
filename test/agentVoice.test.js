'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The voice an agent speaks in.
//
// Three things are pinned here.
//
// The first is the behaviour agentColor.test.js already pins for colours, which
// this feature inherits by sharing the rule rather than copying it: everybody in
// one discussion gets a different voice, the answer does not depend on the order
// they were passed in, and an agent's voice does not move about between windows.
//
// The second is the extraction itself. paletteFor() was rewritten to call the
// shared ringFor(), and a refactor of something that ships is only allowed if it
// is provably the same. So the old implementation is kept here, verbatim, and
// the two are compared over a large sample.
//
// The third is the invariant that makes the two rings one idea: an agent's voice
// slot and its colour slot are the same slot. That holds only while the rings are
// the same length, which is exactly the kind of fact that stops being true when
// somebody adds a thirteenth hue and nobody notices.

const SRC = path.join(__dirname, '..', 'src', 'renderer');

// agentVoice.js imports from agentColor.js, so the two are loaded together: the
// colour module's source is prepended and both sets of `export` markers are
// stripped, which is the same new-Function trick agentColor.test.js uses to read
// renderer ESM from a CommonJS test.
function load() {
  const color = fs.readFileSync(path.join(SRC, 'lib', 'agentColor.js'), 'utf8');
  const voice = fs.readFileSync(path.join(SRC, 'lib', 'agentVoice.js'), 'utf8');
  const body = `${color}\n${voice.replace(/^import[^;]+;$/gm, '')}`.replace(/^export\s+/gm, '');
  return new Function(
    `${body}
     return { AGENT_HUES, VOICES, colorOf, paletteFor, ringFor, slotFor, voiceOf, voicesFor, localVoicesFor };`
  )();
}

const { AGENT_HUES, VOICES, paletteFor, ringFor, slotFor, voiceOf, voicesFor, localVoicesFor } = load();

// A pool of stable, realistic ids.
const ids = (n, prefix = 'agent') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

// ------------------------------------------------------------------- the ring

test('the ring is twelve distinct voices', () => {
  assert.equal(VOICES.length, 12);
  assert.equal(new Set(VOICES).size, VOICES.length, 'a repeated voice is a wasted slot');
  for (const name of VOICES) assert.match(name, /^[A-Z][A-Za-z]+$/);
});

// The names are sent to Gemini verbatim, so a typo here is a 400 at the moment
// somebody is trying to listen to a discussion. Checked against the documented
// set rather than against themselves.
test('every voice is one Gemini actually has', () => {
  const PREBUILT = new Set([
    'Zephyr',
    'Puck',
    'Charon',
    'Kore',
    'Fenrir',
    'Leda',
    'Orus',
    'Aoede',
    'Callirrhoe',
    'Autonoe',
    'Enceladus',
    'Iapetus',
    'Umbriel',
    'Algieba',
    'Despina',
    'Erinome',
    'Algenib',
    'Rasalgethi',
    'Laomedeia',
    'Achernar',
    'Alnilam',
    'Schedar',
    'Gacrux',
    'Pulcherrima',
    'Achird',
    'Zubenelgenubi',
    'Vindemiatrix',
    'Sadachbia',
    'Sadaltager',
    'Sulafat',
  ]);
  for (const name of VOICES) assert.ok(PREBUILT.has(name), `${name} is not a Gemini voice`);
});

test('an agent keeps its voice', () => {
  for (const id of ids(50)) assert.equal(voiceOf(id), voiceOf(id));
  assert.ok(VOICES.includes(voiceOf('anything')));
  // Nonsense does not throw; it lands somewhere.
  for (const junk of [null, undefined, '', 0, 'x']) assert.ok(VOICES.includes(voiceOf(junk)));
});

test('everybody in one discussion sounds different', () => {
  for (let n = 1; n <= VOICES.length; n += 1) {
    const room = ids(n, 'room');
    const spoken = voicesFor(room);
    assert.equal(spoken.size, n);
    assert.equal(new Set(spoken.values()).size, n, `${n} agents must have ${n} voices`);
  }
});

test('the answer does not depend on the order they were passed in', () => {
  const room = ids(6, 'order');
  const forwards = voicesFor(room);
  const backwards = voicesFor([...room].reverse());
  const shuffled = voicesFor([room[3], room[0], room[5], room[1], room[4], room[2]]);
  for (const id of room) {
    assert.equal(backwards.get(id), forwards.get(id));
    assert.equal(shuffled.get(id), forwards.get(id));
  }
});

test('duplicates and empties are ignored rather than given a voice', () => {
  const spoken = voicesFor(['a', 'a', null, '', 'b', undefined, 'b']);
  assert.equal(spoken.size, 2);
  assert.ok(spoken.has('a') && spoken.has('b'));
});

test('more agents than voices wraps rather than failing', () => {
  const many = voicesFor(ids(30, 'crowd'));
  assert.equal(many.size, 30);
  for (const name of many.values()) assert.ok(VOICES.includes(name));
});

test('nothing, or nonsense, is an empty result rather than a crash', () => {
  assert.equal(voicesFor(undefined).size, 0);
  assert.equal(voicesFor(null).size, 0);
  assert.equal(voicesFor([]).size, 0);
  assert.equal(voicesFor([null, '', undefined]).size, 0);
});

// ------------------------------------------------- the colour/voice invariant

test('an agent speaks in the voice matching its colour', () => {
  // The property that makes the two rings one idea rather than two lists. It
  // holds because ringFor is a pure function of the ids and the ring's length,
  // and the two rings are the same length.
  assert.equal(VOICES.length, AGENT_HUES.length, 'the two rings must stay the same length');

  for (let n = 1; n <= 20; n += 1) {
    const room = ids(n, 'paired');
    const colours = paletteFor(room);
    const spoken = voicesFor(room);
    for (const id of room) {
      assert.equal(
        VOICES.indexOf(spoken.get(id)),
        AGENT_HUES.indexOf(colours.get(id)),
        `${id} must speak in the voice at its own colour's slot`
      );
    }
  }
});

// ------------------------------------------------------- the extraction itself

test('paletteFor still does exactly what it did before ringFor was extracted', () => {
  // The implementation as it stood before the refactor, kept verbatim.
  const slotForOld = (key) => {
    let h = 0;
    const s = String(key || '');
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % AGENT_HUES.length;
  };
  const paletteForOld = (agentIds) => {
    const list = [...new Set((agentIds || []).filter(Boolean))].sort();
    const taken = new Set();
    const out = new Map();
    for (const id of list) {
      const start = slotForOld(id);
      let slot = start;
      for (let step = 0; step < AGENT_HUES.length; step += 1) {
        slot = (start + step) % AGENT_HUES.length;
        if (!taken.has(slot)) break;
      }
      taken.add(slot);
      out.set(id, AGENT_HUES[slot]);
    }
    return out;
  };

  const pool = [...ids(60, 'equiv'), '', null, undefined, 0, 'a', 'Claude', 'claude'];
  // Deterministic rather than random, so a failure is reproducible.
  let seed = 1;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let trial = 0; trial < 4000; trial += 1) {
    const room = [];
    for (let i = 0; i < trial % 20; i += 1) room.push(pool[Math.floor(next() * pool.length)]);
    const now = paletteFor(room);
    const before = paletteForOld(room);
    assert.equal(now.size, before.size);
    for (const [id, hue] of before) assert.equal(now.get(id), hue);
  }

  // The edges, by hand.
  for (const room of [undefined, null, [], [null], [''], ids(30, 'wrap')]) {
    const now = paletteFor(room);
    const before = paletteForOld(room);
    assert.equal(now.size, before.size);
    for (const [id, hue] of before) assert.equal(now.get(id), hue);
  }
});

test('slotFor indexes whatever ring it is given', () => {
  // Defaulting to the hue ring is what keeps colorOf() unchanged.
  assert.equal(slotFor('anybody'), slotFor('anybody', AGENT_HUES.length));
  for (const size of [1, 2, 5, 12, 30]) {
    const slot = slotFor('anybody', size);
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < size);
  }
});

test('ringFor deals from any ring at all', () => {
  const ring = ['one', 'two', 'three'];
  const dealt = ringFor(['a', 'b', 'c'], ring);
  assert.equal(dealt.size, 3);
  assert.equal(new Set(dealt.values()).size, 3);
  for (const value of dealt.values()) assert.ok(ring.includes(value));
});

// ------------------------------------------------------------ the local voices

test('the platform voices are dealt out by the same rule', () => {
  const available = [
    { name: 'English One', lang: 'en-GB' },
    { name: 'English Two', lang: 'en-US' },
    { name: 'English Three', lang: 'en-US' },
    { name: 'French One', lang: 'fr-FR' },
  ];
  const room = ids(3, 'local');
  const dealt = localVoicesFor(room, available, 'en-GB');

  assert.equal(dealt.size, 3);
  assert.equal(new Set(dealt.values()).size, 3, 'three agents, three voices');
  // A French voice reading English is unintelligible; a shared accent is merely
  // less good. So the language filter comes first.
  for (const name of dealt.values()) assert.ok(name.startsWith('English'));
});

test('a language with no voices falls back to the whole list rather than to silence', () => {
  const available = [
    { name: 'French One', lang: 'fr-FR' },
    { name: 'French Two', lang: 'fr-CA' },
  ];
  const dealt = localVoicesFor(ids(2, 'nolang'), available, 'ja-JP');
  assert.equal(dealt.size, 2);
  assert.equal(new Set(dealt.values()).size, 2);
});

test('a machine with no voices at all is empty rather than broken', () => {
  assert.equal(localVoicesFor(ids(3), [], 'en-GB').size, 0);
  assert.equal(localVoicesFor(ids(3), null, 'en-GB').size, 0);
  assert.equal(localVoicesFor(ids(3), [{ lang: 'en' }], 'en').size, 0, 'a voice with no name is no voice');
});

test('local voices are stable for the same machine and cast', () => {
  const available = [
    { name: 'A', lang: 'en-GB' },
    { name: 'B', lang: 'en-GB' },
    { name: 'C', lang: 'en-GB' },
  ];
  const room = ids(3, 'stable');
  const first = localVoicesFor(room, available, 'en');
  const again = localVoicesFor([...room].reverse(), available, 'en');
  for (const id of room) assert.equal(again.get(id), first.get(id));
});

test('more agents than the machine has voices wraps rather than failing', () => {
  const available = [
    { name: 'A', lang: 'en' },
    { name: 'B', lang: 'en' },
  ];
  const dealt = localVoicesFor(ids(5, 'few'), available, 'en');
  assert.equal(dealt.size, 5);
  for (const name of dealt.values()) assert.ok(['A', 'B'].includes(name));
});
