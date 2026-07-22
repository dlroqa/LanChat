'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// groupCall.js is renderer ESM. Extract just the pure, DOM-free helpers.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'groupCall.js'), 'utf8');
const { shouldOffer, reconcileRoster } = new Function(
  `${SRC.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '')}
   return { shouldOffer, reconcileRoster };`
)();

// The glare rule must be a total order: for any distinct pair, exactly one side
// offers. If both offered (or neither did), the mesh connection would never form.
test('shouldOffer is asymmetric for a pair', () => {
  assert.equal(shouldOffer('aaa', 'bbb'), true);
  assert.equal(shouldOffer('bbb', 'aaa'), false);
  assert.notEqual(shouldOffer('aaa', 'bbb'), shouldOffer('bbb', 'aaa'));
});

test('every unordered pair yields exactly one offerer', () => {
  const ids = ['id-1', 'id-9', 'id-abc', 'id-abd', 'zeta', '000'];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = shouldOffer(ids[i], ids[j]);
      const b = shouldOffer(ids[j], ids[i]);
      assert.equal(a && b, false, `${ids[i]}/${ids[j]}: both offered`);
      assert.equal(a || b, true, `${ids[i]}/${ids[j]}: neither offered`);
    }
  }
});

test('reconcileRoster finds who joined and who left, excluding self', () => {
  const current = ['b', 'c'];
  const next = [{ id: 'me' }, { id: 'b' }, { id: 'd' }];
  const { added, removed } = reconcileRoster(current, next, 'me');
  assert.deepEqual(added.sort(), ['d']);
  assert.deepEqual(removed.sort(), ['c']);
});

test('reconcileRoster never treats self as a participant', () => {
  const { added } = reconcileRoster([], [{ id: 'me' }, { id: 'x' }], 'me');
  assert.ok(!added.includes('me'));
  assert.deepEqual(added, ['x']);
});

test('reconcileRoster is stable when nothing changed', () => {
  const { added, removed } = reconcileRoster(['x', 'y'], [{ id: 'x' }, { id: 'y' }, { id: 'me' }], 'me');
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});
