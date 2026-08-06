'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The colour an agent speaks in.
//
// Two separate things are pinned here, and the second is the one that would
// otherwise rot.
//
// The first is behaviour: everybody in one conversation gets a different colour,
// the answer does not depend on the order they were passed in, and an agent's
// colour does not move about between windows.
//
// The second is the reason those particular hex values are in the file. They
// were chosen by measuring, against this window's own --surface and --fg and the
// exact percentages styles.css mixes them at. A hue swapped for a prettier one,
// or a fill nudged from 26% to 34% because it looked better on somebody's
// monitor, is precisely the change that drops a speaker's name below readable
// without anybody noticing. So the ratios are recomputed here from the
// stylesheet itself rather than written down as numbers that were true once.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const { AGENT_HUES, colorOf, paletteFor } = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'agentColor.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { AGENT_HUES, colorOf, paletteFor };`
)();

const CSS = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');

// ---- the colours themselves, measured ----

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, pa) => hex(a).map((v, i) => v * pa + hex(b)[i] * (1 - pa));
const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// Read out of the stylesheet, so this test is measuring what actually ships.
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(CSS);
  assert.ok(m, `--${name} should be defined in styles.css`);
  return m[1];
};
// And the two mix percentages, likewise — the numbers the comment in
// agentColor.js quotes are only true if these are the numbers in the CSS.
const mixPct = (selectorish) => {
  const m = new RegExp(
    `${selectorish}[\\s\\S]{0,200}?color-mix\\(in srgb, var\\(--agent-color\\) (\\d+)%`,
    'i'
  ).exec(CSS);
  assert.ok(m, `expected an --agent-color mix under ${selectorish}`);
  return Number(m[1]) / 100;
};

test('every hue carries body text at the size and weight a bubble uses', () => {
  const surface = token('surface');
  const fg = token('fg');
  const fill = mixPct('\\.bubble-row\\.agent \\.bubble');

  for (const hue of AGENT_HUES) {
    const r = ratio(hex(fg), mix(hue, surface, fill));
    assert.ok(r >= 4.5, `${hue}: body text is ${r.toFixed(2)}:1 on its fill, and needs 4.5:1`);
  }
});

test("every hue carries the speaker's name on its own fill", () => {
  // The hard one, and the reason the name is mixed toward --fg rather than left
  // at full strength: the name sits on a fill made of the same hue, so the two
  // start out close and have to be pushed apart.
  const surface = token('surface');
  const fg = token('fg');
  const fill = mixPct('\\.bubble-row\\.agent \\.bubble');
  const name = mixPct('\\.bubble-row\\.agent \\.bubble-speaker');

  for (const hue of AGENT_HUES) {
    const r = ratio(mix(hue, fg, name), mix(hue, surface, fill));
    assert.ok(r >= 4.5, `${hue}: its name is ${r.toFixed(2)}:1 on its own fill, and needs 4.5:1`);
  }
});

test('the ring is twelve distinct colours', () => {
  assert.equal(AGENT_HUES.length, 12);
  assert.equal(new Set(AGENT_HUES).size, 12, 'no colour appears twice');
  assert.ok(
    AGENT_HUES.every((h) => /^#[0-9a-f]{6}$/.test(h)),
    'six-digit hex throughout, which is what the mixing above assumes'
  );
});

// ---- who gets which ----

test('everybody in one conversation gets a different colour', () => {
  const ids = ['agent:a', 'agent:b', 'agent:c', 'agent:d'];
  const palette = paletteFor(ids);
  assert.equal(palette.size, 4);
  assert.equal(new Set(palette.values()).size, 4, 'four agents, four colours');
});

test('a room of twelve is still twelve different colours', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `agent:${i}`);
  const palette = paletteFor(ids);
  assert.equal(new Set(palette.values()).size, 12, 'the ring is used up exactly, with no repeat');
});

test('the order they were passed in does not change who gets what', () => {
  // Otherwise the same four agents would be coloured one way in the sidebar and
  // another in the transcript, and re-coloured whenever one answered first.
  const ids = ['agent:zeta', 'agent:alpha', 'agent:mu', 'agent:beta'];
  const first = paletteFor(ids);
  const second = paletteFor([...ids].reverse());
  for (const id of ids) assert.equal(first.get(id), second.get(id), `${id} keeps its colour`);
});

test('the same agent in the same room is the same colour every time', () => {
  const ids = ['agent:a', 'agent:b'];
  assert.deepEqual([...paletteFor(ids)], [...paletteFor(ids)], 'nothing here is random');
});

test('an agent asked about on its own always gets its hashed colour', () => {
  assert.equal(colorOf('agent:a'), colorOf('agent:a'));
  assert.ok(AGENT_HUES.includes(colorOf('agent:a')));
  assert.ok(AGENT_HUES.includes(colorOf('remote-agent:ada:1')), 'a peer’s agent is an id like any other');
});

test('a collision moves one agent and leaves the other where it was', () => {
  // Whichever of the two sorts first keeps its hashed colour. That is what keeps
  // the disruption from a collision as small as it can be: one of the pair
  // moves, it is always the same one, and everybody else is untouched.
  const pool = Array.from({ length: 60 }, (_, i) => `agent:${i}`);
  const pair = (() => {
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        if (colorOf(pool[i]) === colorOf(pool[j])) return [pool[i], pool[j]].sort();
      }
    }
    return null;
  })();
  assert.ok(pair, 'two ids that hash to the same slot, which is the case being tested');

  const palette = paletteFor(pair);
  assert.equal(palette.get(pair[0]), colorOf(pair[0]), 'the one that sorts first keeps its colour');
  assert.notEqual(palette.get(pair[1]), colorOf(pair[1]), 'and the other steps off it');
  assert.notEqual(palette.get(pair[0]), palette.get(pair[1]), 'which is the entire point');
});

test('an agent alone in a room is never moved off its own colour', () => {
  for (const id of ['agent:a', 'agent:zeta', 'remote-agent:ada:1']) {
    assert.equal(paletteFor([id]).get(id), colorOf(id));
  }
});

test('more agents than there are hues wraps rather than breaking', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `agent:${i}`);
  const palette = paletteFor(ids);
  assert.equal(palette.size, 20, 'everybody still gets a colour');
  assert.ok(
    [...palette.values()].every((c) => AGENT_HUES.includes(c)),
    'and it is always one from the ring'
  );
});

test('nothing, or nonsense, is an empty palette rather than a crash', () => {
  assert.equal(paletteFor().size, 0);
  assert.equal(paletteFor([]).size, 0);
  assert.equal(paletteFor([null, undefined, '']).size, 0, 'blanks are not agents');
  assert.equal(paletteFor(['agent:a', 'agent:a']).size, 1, 'and the same agent twice is one agent');
});

// ---- and the same claim again, in a browser ----

test('mounted in a browser: four agents, four opaque colours, all of them readable', async () => {
  // Everything above is arithmetic on the values in two files. This is the
  // window: that `color-mix` resolves the way the arithmetic says, that a
  // variable set on a row reaches the fill, the edge and the name, that nothing
  // further down the stylesheet wins over any of it, and that the pixels
  // chromium actually painted are the colours the styles computed.
  const { runAgentColourHarness, report } = require('../scripts/agent-colour-harness.js');
  const result = await runAgentColourHarness();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  assert.equal(result.count, 4, 'four answers, four coloured rows');
  assert.equal(result.outRows, 0, 'and the question somebody typed is not one of them');

  const declared = new Set(result.rows.map((r) => r.declared));
  assert.equal(declared.size, 4, 'four different colours in the one conversation');

  for (const r of result.rows) {
    assert.ok(r.bodyOnFill >= 4.5, `${r.who}: body text is ${r.bodyOnFill}:1 on its fill`);
    assert.ok(r.nameOnFill >= 4.5, `${r.who}: its name is ${r.nameOnFill}:1 on its own fill`);
    assert.equal(r.alpha, 'opaque', `${r.who}: the fill lets the conversation behind it show through`);
    assert.equal(r.edge.toLowerCase(), r.declared.toLowerCase(), `${r.who}: the edge is not its colour`);
  }

  assert.ok(result.painted, 'a screenshot was taken and read back');
  result.rows.forEach((r, i) => {
    const px = result.painted[i];
    assert.ok(px, `${r.who}: its bubble was not in the screenshot, so nothing was measured`);
    const want = [1, 3, 5].map((k) => parseInt(r.fill.slice(k, k + 2), 16));
    const off = Math.max(...px.map((v, k) => Math.abs(v - want[k])));
    assert.ok(off <= 3, `${r.who}: the colour most of its bubble is painted in is ${off} off the fill`);
  });

  // The same numbers a person would read, for when this fails on somebody's
  // machine and the assertion alone is not enough to say why.
  assert.ok(report(result), 'the harness agrees');
});
