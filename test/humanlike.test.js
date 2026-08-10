'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  IN_TURN,
  BETWEEN,
  OBSERVE,
  ARRANGEMENTS,
  arrangement,
  rollArrangement,
  planCycle,
  nextInSegment,
  cycleCost,
  segmentNotice,
  cycleNotice,
} = require('../src/main/sessions/humanlike.js');

// The shuffle, held to the two rules that keep it from becoming noise.
//
// Everything here is a property rather than an example: "one turn each" is a
// count, and "never the same twice running" is a claim about every possible
// roll. Both are the sort of thing a comment can assert and only a test can
// know, which is why the roll takes its randomness as an argument.

const THREE = [
  { agentId: 'a', name: 'Mac' },
  { agentId: 'b', name: 'Zima' },
  { agentId: 'c', name: 'Tessie' },
];

// ------------------------------------------------------------- the six orders

test('the six arrangements are the six that were asked for', () => {
  // Checked against the specification line by line, because this table is the
  // feature. A permutation generator would be shorter and would not let anybody
  // verify that number 4 is the number 4 somebody wrote down.
  assert.deepEqual(
    ARRANGEMENTS.map((a) => [a.n, ...a.order]),
    [
      [1, IN_TURN, BETWEEN, OBSERVE],
      [2, BETWEEN, IN_TURN, OBSERVE],
      [3, OBSERVE, BETWEEN, IN_TURN],
      [4, IN_TURN, OBSERVE, BETWEEN],
      [5, BETWEEN, OBSERVE, IN_TURN],
      [6, OBSERVE, IN_TURN, BETWEEN],
    ]
  );
});

test('every arrangement runs all three parts exactly once', () => {
  for (const a of ARRANGEMENTS) {
    assert.deepEqual([...a.order].sort(), [BETWEEN, OBSERVE, IN_TURN].sort(), `order ${a.n}`);
  }
});

// ----------------------------------------------------------------- the rolling

test('a roll never repeats the arrangement the last question ran', () => {
  // The property the whole mode rests on. Two hundred rolls against each of the
  // six possible predecessors — if this were a retry loop or an off-by-one in
  // the exclusion, this is what would catch it.
  for (const last of [1, 2, 3, 4, 5, 6]) {
    for (let i = 0; i < 200; i += 1) {
      const got = rollArrangement(last, Math.random);
      assert.notEqual(got.n, last, `rolled ${got.n} again after ${last}`);
    }
  }
});

test('a roll can still reach every other arrangement', () => {
  // The other half of the property. Excluding the last one must not quietly
  // narrow the pool to one favourite — a mode that alternated between two
  // shapes would pass the test above and still be predictable.
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(rollArrangement(3, Math.random).n);
  assert.deepEqual([...seen].sort(), [1, 2, 4, 5, 6]);
});

test('the first question in a session may roll anything', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(rollArrangement(null, Math.random).n);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6]);
});

test('the ends of the random range are both reachable and neither is off the end', () => {
  // A source returning exactly 0 and exactly 1 are the two values that index off
  // an array if nobody guards them. Returning undefined here would end a round
  // before it started.
  assert.equal(rollArrangement(null, () => 0).n, 1);
  assert.equal(rollArrangement(null, () => 1).n, 6);
  assert.equal(rollArrangement(null, () => 0.999999).n, 6);
});

test('a broken source of randomness still yields a real arrangement', () => {
  // Never a crash and never nothing: an unusable roll falls to the first
  // arrangement, which is a working conversation rather than a dead round.
  assert.equal(rollArrangement(null, () => NaN).n, 1);
  assert.equal(rollArrangement(null, () => undefined).n, 1);
});

test('an unknown last arrangement does not empty the pool', () => {
  // A record hand-edited to 99, or written by a future build with more shapes in
  // it. The pool must not come back empty and strand the round.
  const got = rollArrangement(99, Math.random);
  assert.ok(ARRANGEMENTS.some((a) => a.n === got.n));
});

// --------------------------------------------------- one turn per agent, always

test('every agent gets exactly one turn in every segment', () => {
  // The rule the user asked for in so many words, and the reason this mode is
  // not just "dialogue with extra steps".
  for (const a of ARRANGEMENTS) {
    const cycle = planCycle(a, THREE);
    assert.equal(cycle.segments.length, 3);
    for (const segment of cycle.segments) {
      assert.deepEqual(
        segment.queue.map((t) => t.agentId),
        ['a', 'b', 'c'],
        `order ${a.n}, segment ${segment.kind}`
      );
    }
  }
});

test('draining one segment leaves the others full', () => {
  // Three arrays that were secretly one array is a bug that only appears with
  // three agents and looks exactly like a transport fault.
  const cycle = planCycle(arrangement(1), THREE);
  const gone = new Set();
  while (nextInSegment(cycle.segments[0], gone)) {
    /* drained */
  }
  assert.equal(cycle.segments[0].queue.length, 0);
  assert.equal(cycle.segments[1].queue.length, 3);
  assert.equal(cycle.segments[2].queue.length, 3);
});

test('a segment hands out each agent once and then says it is done', () => {
  const cycle = planCycle(arrangement(1), THREE);
  const segment = cycle.segments[0];
  const gone = new Set();
  const spoke = [];
  for (let guard = 0; guard < 10; guard += 1) {
    const next = nextInSegment(segment, gone);
    if (!next) break;
    spoke.push(next.agentId);
  }
  assert.deepEqual(spoke, ['a', 'b', 'c']);
  // And nothing after that — no looping back to the top, which is the whole
  // difference between this and a dialogue.
  assert.equal(nextInSegment(segment, gone), null);
});

test('an agent that left the room is skipped rather than asked again', () => {
  // It could not answer the first segment; asking it again would spend a peer's
  // fair share on a question already known to be unanswerable.
  const cycle = planCycle(arrangement(1), THREE);
  const gone = new Set(['b']);
  const spoke = [];
  for (let guard = 0; guard < 10; guard += 1) {
    const next = nextInSegment(cycle.segments[0], gone);
    if (!next) break;
    spoke.push(next.agentId);
  }
  assert.deepEqual(spoke, ['a', 'c']);
});

test('a cycle with nobody in it ends rather than hanging', () => {
  const cycle = planCycle(arrangement(1), []);
  assert.equal(nextInSegment(cycle.segments[0], new Set()), null);
  assert.equal(cycleCost(0), 1);
});

test('the cost of a cycle is one each way round plus at most one observer', () => {
  assert.equal(cycleCost(2), 5);
  assert.equal(cycleCost(3), 7);
  assert.equal(cycleCost(5), 11);
});

test('a cycle can be planned from a bare number as well as an arrangement', () => {
  // The record stores a number; the roll returns an object. Both have to work,
  // or restoring the last arrangement from disk becomes a special case.
  assert.equal(planCycle(2, THREE).arrangement, 2);
  assert.equal(planCycle(arrangement(2), THREE).arrangement, 2);
  // And nonsense still produces a runnable cycle rather than nothing.
  assert.equal(planCycle(null, THREE).segments.length, 3);
});

// ------------------------------------------------------------------- the words

test('the running part is named, with the order it belongs to', () => {
  const cycle = planCycle(arrangement(4), THREE);
  const line = segmentNotice(cycle.segments[1], { index: 1, of: 3, arrangement: 4 });
  // The arrangement number is the only visible sign the order was rolled rather
  // than fixed, so somebody watching two different questions can see why.
  assert.equal(line, 'Part 2 of 3: whoever has been watching · order 4');
});

test('the ending says the whole cycle ran', () => {
  assert.match(cycleNotice(4, { spoke: 6 }), /Everyone had their turn \(order 4\)\. 6 replies\./);
  assert.match(cycleNotice(2, { spoke: 1 }), /1 reply\./);
  // A cycle where nobody managed to say anything still has to read as finished.
  assert.match(cycleNotice(2, { spoke: 0 }), /finished/);
});
