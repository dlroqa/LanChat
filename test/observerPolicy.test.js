'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  SHELF,
  SOFT_FLOOR,
  PROTECTIVE,
  RERAISE_PENALTY,
  CANDIDATE_TTL_MS,
  score,
  cleanObserver,
  protectiveAllowed,
  mentions,
  cleanCandidate,
  eligible,
  levelFor,
  dedupe,
  sameIdea,
  expired,
  categoryOf,
  shelfLabel,
} = require('../src/main/sessions/observer.js');

// Whether an observer is allowed to speak, decided without one running.
//
// This is the file that has to be right. Everything an observer does that a
// person did not ask for goes through levelFor, and the failure that kills the
// whole feature is not a missed idea — it is an agent that learned to interrupt.
// So the thresholds, the counterfactual silence test and the opt-in for
// interrupting are all pure functions, and this is where they are held to it.

// A candidate that clears every bar, to be spoilt one field at a time. Written
// out in full rather than built by a helper so that each test below can be read
// on its own and say exactly which field it is about.
const GOOD = {
  observerId: 'agent:mac',
  type: 'missing_dependency',
  claim: 'The coordinator needs a lock before two agents can share the port.',
  evidence: ['m1', 'm2'],
  novelty: 0.9,
  impact: 0.8,
  urgency: 0.4,
  confidence: 0.85,
  interruptionCost: 0.3,
  silenceRisk: 0.75,
};

const candidate = (patch = {}) => cleanCandidate({ ...GOOD, ...patch });

const PLAN = { constraints: [{ id: 'c1', text: 'Must work on a LAN', hard: true }] };

// ------------------------------------------------------------------- the scores

// Everything on a candidate was written by a language model, which means every
// field arrives as whatever it felt like writing. None of it may be trusted into
// a comparison unread.

test('a score that cannot be read is nought, not a default', () => {
  // The direction matters more than the value. A missing score defaulting to
  // something reasonable would let a candidate whose scores were unreadable sail
  // through thresholds it never actually met.
  assert.equal(score(undefined), 0);
  assert.equal(score(null), 0);
  assert.equal(score('high'), 0);
  assert.equal(score(NaN), 0);
  assert.equal(score(-3), 0);
});

test('a model that answered out of a hundred meant a fraction', () => {
  // Clamping 85 to 1 would turn "fairly confident" into "certain" and hand it
  // the top rung. Rescaling keeps the shape of what it said.
  assert.equal(score(85), 0.85);
  assert.equal(score(100), 1);
  assert.equal(score(0.85), 0.85);
  // Past any scale anybody uses, there is nothing to recover.
  assert.equal(score(4000), 1);
});

test('a candidate that is not one of ours is not a candidate', () => {
  assert.equal(cleanCandidate({ ...GOOD, type: 'agreement' }), null);
  assert.equal(cleanCandidate({ ...GOOD, type: 'praise' }), null);
  assert.equal(cleanCandidate({ ...GOOD, claim: '   ' }), null);
  assert.equal(cleanCandidate(null), null);
  assert.equal(cleanCandidate('alternative'), null);
});

// ------------------------------------------------------------------ eligibility

test('a claim pointing at nothing is not raised at all', () => {
  // The cheapest guard there is against a model that has started inventing the
  // conversation it is watching: if it cannot point at a message, it has no
  // business speaking about one.
  assert.equal(eligible(candidate({ evidence: [] })), false);
  assert.equal(levelFor(candidate({ evidence: [] })), null);
});

test('an unconfident or unoriginal candidate does not even reach the shelf', () => {
  assert.equal(eligible(candidate({ confidence: 0.4 })), false);
  assert.equal(eligible(candidate({ novelty: 0.2 })), false);
  // The shelf is a place for ideas somebody might want, not a dumping ground
  // that makes the silence look busy.
  assert.equal(levelFor(candidate({ confidence: 0.4 })), null);
});

// ------------------------------------------- the counterfactual silence test

test('a useful idea that can wait goes to the shelf', () => {
  // Low silence risk is the whole of it: nothing is lost by the person reading
  // this in their own time.
  const level = levelFor(candidate({ silenceRisk: 0.2, impact: 0.9 }), { plan: PLAN });
  assert.equal(level, SHELF);
});

test('a high-impact idea that silence would cost asks for the floor', () => {
  const level = levelFor(candidate({ impact: 0.8, silenceRisk: 0.75 }), { plan: PLAN });
  assert.equal(level, SOFT_FLOOR);
});

test('an idea that costs more to deliver than silence costs stays on the shelf', () => {
  // The one place interruption cost is actually compared against anything rather
  // than merely recorded.
  const level = levelFor(candidate({ silenceRisk: 0.65, interruptionCost: 0.9 }), { plan: PLAN });
  assert.equal(level, SHELF);
});

test('confidence buys eligibility and never a louder rung', () => {
  // A model's certainty is a fact about the model, not about the plan. A
  // supremely confident low-stakes idea is still a low-stakes idea.
  const sure = levelFor(candidate({ confidence: 1, silenceRisk: 0.1, impact: 0.2 }), { plan: PLAN });
  assert.equal(sure, SHELF);
});

// ------------------------------------------------------- protective interruption

// The loudest thing an observer can do, and the one with the most ways to be
// wrong. Four separate things all have to be true, and each of these tests
// removes exactly one of them.

const URGENT = {
  type: 'hard_constraint_conflict',
  claim: 'Broadcasting on the public interface breaks the LAN-only constraint.',
  urgency: 0.9,
  silenceRisk: 0.9,
  confidence: 0.9,
};

test('a room that never agreed to interruptions is never interrupted', () => {
  // Not merely quieter — the rung is unreachable. It falls back to asking, which
  // is the loudest thing a room that has not opted in can be shown.
  //
  // This switch is also the stop, and there is only one of it. An earlier draft
  // carried a second `killed` flag meant to outrank it; nothing could ever set
  // that flag, and a field which can only hold its default is not a safety
  // measure — it is something to misread later.
  const level = levelFor(candidate(URGENT), { observer: { protective: false }, plan: PLAN });
  assert.equal(level, SOFT_FLOOR);
});

test('a room that agreed can be interrupted about a hard constraint', () => {
  const level = levelFor(candidate(URGENT), { observer: { protective: true }, plan: PLAN });
  assert.equal(level, PROTECTIVE);
});

test('a plan with no hard constraint has nothing to be in hard conflict with', () => {
  // Otherwise `hard_constraint_conflict` is a label a model can write on
  // anything to reach the loudest rung available. The constraint has to exist in
  // the frame, which is built from what the person actually said.
  const soft = { constraints: [{ id: 'c1', text: 'Prefer small diffs', hard: false }] };
  const level = levelFor(candidate(URGENT), { observer: { protective: true }, plan: soft });
  assert.equal(level, SOFT_FLOOR);
});

test('an alternative may never interrupt, however urgent it says it is', () => {
  // A better idea is never a reason to cut across somebody mid-sentence. It
  // keeps perfectly well until they look at the shelf.
  const level = levelFor(candidate({ ...URGENT, type: 'alternative' }), {
    observer: { protective: true },
    plan: PLAN,
  });
  assert.notEqual(level, PROTECTIVE);
});

test('a quiet session shelves everything it is allowed to shelve', () => {
  const level = levelFor(candidate({ impact: 0.9, silenceRisk: 0.9 }), {
    observer: { level: 'quiet' },
    plan: PLAN,
  });
  assert.equal(level, SHELF);
});

test('even a quiet session may still interrupt about a hard constraint', () => {
  // Quiet is about ideas, not about safety. Somebody who asked for quiet and
  // switched interruptions on meant both things.
  const level = levelFor(candidate(URGENT), {
    observer: { level: 'quiet', protective: true },
    plan: PLAN,
  });
  assert.equal(level, PROTECTIVE);
});

// -------------------------------------------------------------- the settings

test('observer settings default to balanced and silent', () => {
  const fresh = cleanObserver(undefined);
  assert.equal(fresh.level, 'balanced');
  // The two that matter. Anything that made either of these default to true
  // would ship an agent that can interrupt to somebody who never agreed to one.
  assert.equal(fresh.protective, false);
  assert.equal(protectiveAllowed(undefined), false);
});

test('nonsense settings fall to the quiet reading, never the loud one', () => {
  const junk = cleanObserver({ level: 'EXTREME', protective: 'yes' });
  assert.equal(junk.level, 'balanced');
  // Truthy but not `true`: a string from a hand-edited file must not switch
  // interrupting on.
  assert.equal(junk.protective, false);
});

// -------------------------------------------------------------- being asked

test('an observer is invoked by name anywhere in the sentence', () => {
  const roster = [
    { id: 'a', name: 'Mac' },
    { id: 'b', name: 'Zima' },
  ];
  // The wire path in agents/index.js needs the prefix because a peer's message
  // might be addressed to the person; a session has nobody else in it.
  assert.deepEqual(
    mentions('what does @Zima think of that?', roster).map((a) => a.id),
    ['b']
  );
  assert.deepEqual(mentions('no mention here', roster), []);
});

test('a longer name is not swallowed by a shorter one inside it', () => {
  const roster = [
    { id: 'a', name: 'Mac' },
    { id: 'b', name: 'Mac Pro' },
  ];
  assert.deepEqual(
    mentions('@Mac Pro, thoughts?', roster).map((a) => a.id),
    ['b']
  );
});

test('a mention stops at a word boundary', () => {
  const roster = [{ id: 'a', name: 'Mac' }];
  // `@Mackenzie` is somebody else, and answering it would be an agent barging
  // into a sentence that was not about it.
  assert.deepEqual(mentions('@Mackenzie said so', roster), []);
  // Punctuation is how people actually write a mention.
  assert.equal(mentions('@Mac, thoughts?', roster).length, 1);
  assert.equal(mentions('ask @Mac.', roster).length, 1);
});

test('an agent named twice is invoked once', () => {
  const roster = [{ id: 'a', name: 'Mac' }];
  assert.equal(mentions('@Mac and also @Mac', roster).length, 1);
});

// ------------------------------------------------------- two observers, one idea

test('two observers noticing the same thing produce one card', () => {
  // The failure everybody predicts and nobody guards against: two models watching
  // one conversation find the same gap at the same moment and say it in different
  // words, so a string comparison never merges them.
  const mac = cleanCandidate({
    ...GOOD,
    observerId: 'agent:mac',
    claim: 'The coordinator needs a lock before the port can be shared.',
  });
  const zima = cleanCandidate({
    ...GOOD,
    observerId: 'agent:zima',
    claim: 'Sharing that port without a coordinator lock will collide.',
    evidence: ['m1', 'm2', 'm7'],
  });
  const merged = dedupe([mac, zima]);
  assert.equal(merged.length, 1);
  // Neither name is lost: two observers agreeing is itself evidence, and
  // dropping one would overstate how independent the support is.
  assert.deepEqual(merged[0].observerIds.sort(), ['agent:mac', 'agent:zima']);
  // The better-grounded claim wins the card and the evidence is pooled.
  assert.deepEqual(merged[0].evidence.sort(), ['m1', 'm2', 'm7']);
});

test('different kinds of idea about the same subject stay apart', () => {
  // Without the stopword cut, "the" and "to" carry two unrelated sentences over
  // any sensible threshold and a dependency risk gets merged into an alternative.
  const risk = cleanCandidate({ ...GOOD, type: 'risk', claim: 'The server may drop the port.' });
  const alt = cleanCandidate({
    ...GOOD,
    type: 'alternative',
    claim: 'The server could use a different port.',
  });
  assert.equal(sameIdea(risk, alt), false);
  assert.equal(dedupe([risk, alt]).length, 2);
});

test('two genuinely different ideas of the same kind stay apart', () => {
  const one = cleanCandidate({ ...GOOD, claim: 'Nothing acquires the coordinator lock first.' });
  const two = cleanCandidate({
    ...GOOD,
    claim: 'Certificate rotation has no scheduled owner.',
  });
  assert.equal(sameIdea(one, two), false);
});

// ------------------------------------------------------------------- going stale

test('a candidate about an older version of the plan is expired', () => {
  const c = { ...candidate(), targetPlanVersion: 3, createdAt: Date.now() };
  assert.equal(expired(c, { planVersion: 4 }), true);
  assert.equal(expired(c, { planVersion: 3 }), false);
});

test('a candidate expires once the person has moved on', () => {
  const c = { ...candidate(), createdAt: Date.now() };
  assert.equal(expired(c, { humanTurnsSince: 1 }), false);
  assert.equal(expired(c, { humanTurnsSince: 2 }), true);
});

test('a candidate expires on the clock', () => {
  const born = 1_000_000;
  const c = { ...candidate(), createdAt: born };
  assert.equal(expired(c, { now: born + CANDIDATE_TTL_MS - 1 }), false);
  assert.equal(expired(c, { now: born + CANDIDATE_TTL_MS }), true);
});

test('an idea raised before has to be better to get the same hearing', () => {
  // Decay rather than a cliff: a second outing clears a higher bar, a third
  // higher still, and eventually it stops being offered at all.
  const fresh = candidate({ novelty: 0.55 });
  assert.equal(eligible(fresh), true);
  const again = { ...fresh, raised: 1 };
  assert.equal(0.55 * RERAISE_PENALTY < 0.5, true);
  assert.equal(eligible(again), false);
});

// ------------------------------------------------------------------- the words

test('a card says what kind of thing it is and who noticed it', () => {
  const c = candidate();
  assert.equal(categoryOf(c), 'Missing prerequisite');
  assert.equal(shelfLabel(c, ['Mac']), 'Missing prerequisite — Mac');
  assert.equal(shelfLabel(c, ['Mac', 'Zima']), 'Missing prerequisite — Mac and Zima');
  // Nothing known about who: still a readable card rather than a dangling dash.
  assert.equal(shelfLabel(c, []), 'Missing prerequisite');
});
