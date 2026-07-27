'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The agent panel's status row types its word in under a travelling block
// cursor, then keeps sweeping for as long as the agent is working. Both the
// cursor position and the burst colour come out of one module, so the rhythm is
// testable here rather than only being visible in a running window.
//
// ESM for the renderer, and it imports React for its hooks. Drop the import and
// the `export` keywords and evaluate it — the hooks are only *defined* here, not
// called, so React never has to exist.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'statusMotion.js'), 'utf8');
const { sweepFrame, typedTick, nextHue, BURST_HUES, HOLD_TICKS, burstOnEdge, readyBurstDelay, rayReach } =
  new Function(
    `${SRC.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '')}
   return { sweepFrame, typedTick, nextHue, BURST_HUES, HOLD_TICKS, burstOnEdge, readyBurstDelay, rayReach };`
  )();

test('the first pass types the word in, hiding what has not been reached', () => {
  const len = 8; // "Thinking"
  assert.deepStrictEqual(sweepFrame(0, len), { head: 0, typed: false });
  assert.deepStrictEqual(sweepFrame(3, len), { head: 3, typed: false });
  // The cursor never sits past the last character.
  assert.deepStrictEqual(sweepFrame(len - 1, len), { head: len - 1, typed: false });
});

test('the cursor travels left to right, one character per tick', () => {
  const heads = [];
  for (let t = 0; t < 6; t += 1) heads.push(sweepFrame(t, 10).head);
  assert.deepStrictEqual(heads, [0, 1, 2, 3, 4, 5]);
});

test('the row rests with the whole word and no cursor once it is typed', () => {
  const len = 5;
  for (let t = len; t < len + HOLD_TICKS; t += 1) {
    assert.strictEqual(sweepFrame(t, len).head, null, `tick ${t} should have no cursor`);
  }
});

test('later passes sweep the finished word rather than retyping it', () => {
  const len = 5;
  const second = sweepFrame(len + HOLD_TICKS + 2, len);
  assert.strictEqual(second.head, 2);
  // `typed` is what keeps the rest of the word on screen while the cursor runs
  // back across it — the difference between scanning and starting over.
  assert.strictEqual(second.typed, true);
});

test('a settled label can stop the moment the word is whole', () => {
  assert.strictEqual(sweepFrame(typedTick(6), 6).head, null);
});

test('an empty label asks for no cursor at all', () => {
  assert.deepStrictEqual(sweepFrame(0, 0), { head: null, typed: true });
});

test('every burst picks a hue different from the one already burning', () => {
  for (const current of BURST_HUES) {
    // Both ends of the random range, so neither rounds back onto `current`.
    assert.notStrictEqual(nextHue(current, () => 0), current);
    assert.notStrictEqual(nextHue(current, () => 0.999999), current);
  }
});

test('burst hues are spread far enough apart to read as different colours', () => {
  const sorted = [...BURST_HUES].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i] - sorted[i - 1] >= 20, `hues ${sorted[i - 1]} and ${sorted[i]} are too close`);
  }
});

test('only finishing work earns a firework', () => {
  assert.strictEqual(burstOnEdge('busy', 'ready'), true);
});

test('arriving at Ready any other way does not', () => {
  // Sitting idle, coming back online, clearing an error, and the very first
  // render of an agent that was never busy — all of them are Ready, and none of
  // them is a finish.
  assert.strictEqual(burstOnEdge('ready', 'ready'), false);
  assert.strictEqual(burstOnEdge('off', 'ready'), false);
  assert.strictEqual(burstOnEdge('error', 'ready'), false);
  assert.strictEqual(burstOnEdge(undefined, 'ready'), false);
  // Nor does leaving busy for anywhere else.
  assert.strictEqual(burstOnEdge('busy', 'off'), false);
  assert.strictEqual(burstOnEdge('busy', 'error'), false);
});

test('the burst waits for the word to finish typing itself in', () => {
  const len = 'Ready'.length;
  assert.ok(
    readyBurstDelay(len) > typedTick(len) * 48,
    'the firework must not fire while the cursor is still travelling'
  );
});

test('rays reach the ellipse, not a circle', () => {
  const rx = 300;
  const ry = 38;
  // Sideways they run the long axis, up and down the short one.
  assert.strictEqual(Math.round(rayReach(0, rx, ry)), rx);
  assert.strictEqual(Math.round(rayReach(180, rx, ry)), rx);
  assert.strictEqual(Math.round(rayReach(90, rx, ry)), ry);
  assert.strictEqual(Math.round(rayReach(270, rx, ry)), ry);
});

test('every other angle lands between the two axes', () => {
  const rx = 300;
  const ry = 38;
  for (let a = 0; a < 360; a += 7) {
    const d = rayReach(a, rx, ry);
    assert.ok(d >= ry - 0.001 && d <= rx + 0.001, `${a}deg reached ${d}`);
  }
});
