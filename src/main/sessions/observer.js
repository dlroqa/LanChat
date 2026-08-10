'use strict';

// Agents that watch rather than answer.
//
// Every other mode a session has is a question going out: parallel asks
// everybody at once, relay asks them one after another, a dialogue sets them
// talking. All three start the moment somebody presses Enter, which is exactly
// what you want when you have a question and exactly wrong when you are
// thinking out loud and would like not to be interrupted.
//
// An observer is the other thing. It reads what is said, keeps a picture of the
// plan taking shape, and stays quiet — because agreement, praise, restatement
// and adjacent trivia are the overwhelming majority of what a language model
// has to say about a conversation it was not asked about, and none of it is
// worth the interruption. It speaks when it is spoken to, and otherwise only
// when staying quiet would leave a concrete plan materially worse.
//
// Nothing in this file talks to an agent, reads a clock or touches disk. Who is
// mentioned, whether a candidate is worth raising, which of the three levels it
// deserves, whether two observers have said the same thing, and whether a
// candidate has gone stale are all decisions about data that was handed in —
// same rule as counsel.js and dialogue.js, and for the same reason. The one
// thing that must never decide any of it is a language model: a model that
// could grant itself permission to interrupt is not an observer, it is a
// participant with extra steps.

const { nameList } = require('./dialogue.js');

// How loud a session's observers are allowed to be.
//
// `quiet` is shelf-only: nothing may ask for the floor, and the agents speak
// when directly asked and at no other time. `balanced` is the default and adds
// the soft floor — a request to say something, which the person grants or does
// not. There is deliberately no third setting that lowers the bar further;
// "more interruptions" is not a thing anybody wants enough to put a switch on.
const LEVELS = ['quiet', 'balanced'];
const DEFAULT_LEVEL = 'balanced';

// The three ways an observer can reach somebody, least disruptive first.
//
// The order is the policy: an idea goes to the shelf unless there is a positive
// reason it cannot wait, and it interrupts only if waiting would cost something
// that cannot be got back. Nothing may skip a rung by being confident about
// itself — see levelFor, where the rungs are climbed by facts about the plan
// rather than by the candidate's own opinion of its importance.
const SHELF = 'shelf';
const SOFT_FLOOR = 'soft_floor';
const PROTECTIVE = 'protective';

// What an observer can be raising. A candidate that is not one of these is not a
// candidate — there is no `comment`, no `agreement` and no `observation`,
// because those are the categories every unwanted interruption arrives under.
const CANDIDATE_TYPES = [
  'alternative',
  'risk',
  'contradiction',
  'missing_dependency',
  'hard_constraint_conflict',
  'synthesis',
  'validation_test',
  'clarifying_question',
];

// The kinds that are allowed to interrupt, and only with the room's permission.
//
// A protective interruption is for a plan that is about to walk into something
// it declared it must not do, or into something that cannot be undone. An
// `alternative` is never that, however good it is, and neither is a
// `synthesis` — both of them keep perfectly well until somebody looks at the
// shelf.
const PROTECTIVE_TYPES = ['hard_constraint_conflict', 'contradiction'];

// Thresholds.
//
// Numbers rather than a judgement, and high rather than reasonable. The failure
// this whole design is arranged around is not "the observer missed something" —
// it is "the observer became noise and got switched off", and a threshold that
// lets four candidates an hour through is that failure on a slow fuse. Being
// wrong by staying quiet costs one idea; being wrong by speaking costs the
// feature.
const MIN_CONFIDENCE = 0.6;
const MIN_NOVELTY = 0.5;
const FLOOR_IMPACT = 0.6;
const FLOOR_SILENCE_RISK = 0.6;
const PROTECTIVE_CONFIDENCE = 0.8;
const PROTECTIVE_SILENCE_RISK = 0.8;

// What a re-raised candidate loses for having been raised before.
//
// An observer that may put the same idea back every turn is an observer that
// says the same thing for ever, and the person who shelved it the first time has
// already answered. So a second outing has to clear a higher bar than the first,
// and a third higher still. Multiplied rather than subtracted so it decays
// rather than falling off a cliff.
const RERAISE_PENALTY = 0.6;

// How long a candidate stays worth raising, and how many things the person can
// say before it stops being about the conversation they are now having.
const CANDIDATE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_HUMAN_TURNS = 2;

// A number between nought and one, or nothing.
//
// Every score on a candidate arrives from a language model, which means it
// arrives as whatever the model felt like writing: `0.8`, `"high"`, `85`,
// `-1`, or nothing at all. Anything unreadable is nought rather than a default,
// because a missing score is not a good score, and a candidate whose scores
// cannot be read should fail the thresholds rather than sail past them on
// helpful assumptions.
function score(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  // A model that answered on a 0–100 scale meant 0.85 and wrote 85. Rescaled
  // rather than clamped to 1, which would turn every such answer into a
  // certainty and let the whole scale through the top threshold.
  if (n > 1) return n <= 100 ? n / 100 : 1;
  return n;
}

// The settings a session keeps about its observers, cleaned.
//
// Written this way so a record from a build that never heard of observers, a
// record hand-edited into nonsense, and a record from a future build with more
// fields in it all come out as something this code can act on. Nothing here
// throws and nothing here defaults to "louder": an unreadable level is
// `balanced`, and an unreadable protective flag is off.
function cleanObserver(observer) {
  const raw = observer && typeof observer === 'object' ? observer : {};
  return {
    level: LEVELS.includes(raw.level) ? raw.level : DEFAULT_LEVEL,
    // Off unless somebody switched it on, and that is the whole of the rule.
    // There is no configuration, no roll-out and no heuristic that turns this on
    // for anybody — an agent that can cut across you mid-sentence is something
    // you agree to, once, in your own words.
    protective: raw.protective === true,
  };
}

// Whether this session may interrupt at all.
//
// One flag, not two. An earlier draft of this carried a separate `killed` field
// meant as an emergency stop outranking the setting — which sounds prudent and
// is, here, unreachable state: nothing but the person's own switch ever writes
// `protective`, so there is no path by which a stop could be overridden and
// nothing for a second flag to defend against. A field that can only ever hold
// its default is not a safety measure, it is a thing to misread later.
//
// Turning the switch off is the stop, it takes effect on the next candidate, and
// it is checked before anything else in levelFor.
function protectiveAllowed(observer) {
  return cleanObserver(observer).protective === true;
}

// Who the person named.
//
// `@Name` anywhere in what they typed, not only at the start — the wire path in
// agents/index.js requires the prefix because a peer's chat message has to be
// unambiguously addressed to an agent rather than to the person, and a session
// has no such ambiguity: there is nobody else in it to be talking to. So "what
// does @Hermes think of that?" invokes Hermes, which is how somebody actually
// writes it.
//
// Each `@` is read once and claimed by the longest name that fits it, which is
// the only way to get `@Mac Pro` right in a room that also has a `Mac`. Matching
// per-agent instead — even longest-first — hands the same `@` to both of them,
// because the space after `@Mac` is a perfectly good word boundary. So the text
// is walked rather than the roster.
//
// Case-insensitive, because nobody capitalises a mention the way the settings
// panel does. The boundary check is what stops `@Mac` matching `@Mackenzie`: a
// name may only be followed by something that is not a word character, which
// lets `@Hermes,` and `@Hermes.` through and keeps the wrong agent out.
function mentions(text, roster) {
  const said = String(text == null ? '' : text);
  if (!said.includes('@')) return [];
  const lower = said.toLowerCase();
  const by = [...(roster || [])].filter((a) => a && a.name);
  by.sort((a, b) => b.name.length - a.name.length);

  const found = [];
  for (let at = lower.indexOf('@'); at !== -1; at = lower.indexOf('@', at + 1)) {
    for (const agent of by) {
      const needle = `@${agent.name.toLowerCase()}`;
      if (!lower.startsWith(needle, at)) continue;
      const after = lower[at + needle.length];
      if (after !== undefined && /[\w@]/.test(after)) continue;
      if (!found.some((f) => f.id === agent.id)) found.push(agent);
      // This `@` is spoken for. Moving past the whole name stops a shorter
      // agent claiming the same one, and stops the scan finding an `@` inside
      // the name it just consumed.
      at += needle.length - 1;
      break;
    }
  }
  return found;
}

// A candidate this code is willing to reason about.
//
// The model wrote it, so none of it is trusted: the type has to be one of ours,
// there has to be an actual claim, and every score is read through score()
// above. What comes back is a candidate with known fields and known ranges, or
// null — and null means silence, which is the right answer to a proposal that
// could not be understood.
function cleanCandidate(raw, { observerId = null, planId = null, planVersion = 0 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = CANDIDATE_TYPES.includes(raw.type) ? raw.type : null;
  const claim = String(raw.claim == null ? '' : raw.claim).trim();
  if (!type || !claim) return null;
  return {
    observerId: raw.observerId || observerId,
    targetPlanId: raw.targetPlanId || planId,
    targetPlanVersion: Number.isFinite(Number(raw.targetPlanVersion))
      ? Number(raw.targetPlanVersion)
      : planVersion,
    type,
    claim,
    // Which messages this is grounded in. Numbers and strings both, because a
    // message id here is a uuid and a test's is whatever the test used; what
    // matters is that there is a link back, so a claim can be checked against
    // the thing it claims to be about.
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((id) => id != null).map(String) : [],
    novelty: score(raw.novelty),
    impact: score(raw.impact),
    urgency: score(raw.urgency),
    confidence: score(raw.confidence),
    interruptionCost: score(raw.interruptionCost),
    silenceRisk: score(raw.silenceRisk),
    // How many times this idea has been put forward before. Set by the caller
    // from the shelf, never by the model — a candidate that could declare itself
    // new would never be anything else.
    raised: Number.isFinite(Number(raw.raised)) ? Math.max(0, Math.floor(Number(raw.raised))) : 0,
  };
}

// Whether a candidate is worth anybody's attention at all.
//
// The floor under every level, applied before the levels are considered. A
// candidate that is not grounded, not novel or not believed does not go to the
// shelf either — the shelf is a place for ideas somebody might want, not a
// dumping ground that makes the silence look busy.
function eligible(candidate) {
  if (!candidate) return false;
  // The penalty for having been here before, applied to the two scores that are
  // claims about how much this is worth hearing. An idea does not become more
  // valuable by being repeated.
  const decay = RERAISE_PENALTY ** candidate.raised;
  if (candidate.confidence < MIN_CONFIDENCE) return false;
  if (candidate.novelty * decay < MIN_NOVELTY) return false;
  // Grounding. A claim about a conversation that cannot point at any part of it
  // is a claim about nothing, and this is the single cheapest guard against a
  // model that has started inventing the thread it is watching.
  if (candidate.evidence.length === 0) return false;
  return true;
}

// Which of the three rungs a candidate has earned.
//
// This is the counterfactual silence test, written as code because it is the
// one decision in the feature that must never be a matter of opinion:
//
//   If the person carries on for several turns without this, are they likely to
//   make a materially worse decision, break a hard constraint, or waste
//   substantial effort?
//
//   No                              -> the shelf, or nothing.
//   Yes, but reversible             -> ask for the floor.
//   Yes, urgent and irreversible    -> interrupt, if the room allows it at all.
//
// Note what cannot influence the answer: how confident the observer is, how
// interesting the idea is, and how long it has been waiting. Confidence gates
// eligibility and nothing else, because a model's certainty is a fact about the
// model rather than about the plan.
function levelFor(candidate, { observer = null, plan = null } = {}) {
  if (!eligible(candidate)) return null;
  const settings = cleanObserver(observer);

  const decay = RERAISE_PENALTY ** candidate.raised;
  const urgentAndCostly =
    candidate.silenceRisk >= PROTECTIVE_SILENCE_RISK &&
    candidate.confidence >= PROTECTIVE_CONFIDENCE &&
    candidate.urgency >= PROTECTIVE_SILENCE_RISK &&
    PROTECTIVE_TYPES.includes(candidate.type);

  if (urgentAndCostly) {
    // The room has to have agreed to this, and the plan has to have a hard
    // constraint for the candidate to be conflicting with. Without the second
    // check "hard_constraint_conflict" is a label a model can write on anything
    // to reach the loudest rung available — so the constraint is looked up in
    // the plan frame, which is built from what the person actually said.
    if (protectiveAllowed(settings) && plan && hasHardConstraint(plan)) return PROTECTIVE;
    // Allowed to interrupt in principle, not in this room. It does not
    // evaporate — it becomes the most urgent thing on the shelf's doorstep,
    // which is a floor request.
    return SOFT_FLOOR;
  }

  if (settings.level === 'quiet') return SHELF;

  const worthAsking =
    candidate.impact * decay >= FLOOR_IMPACT &&
    candidate.silenceRisk >= FLOOR_SILENCE_RISK &&
    // The one place interruption cost is read. A candidate that knows it is
    // expensive to deliver has to be worth more than one that is cheap, and this
    // is where "worth" and "cost" are actually compared rather than merely both
    // being recorded.
    candidate.silenceRisk > candidate.interruptionCost;

  return worthAsking ? SOFT_FLOOR : SHELF;
}

// Whether the plan has anything a candidate could be in hard conflict with.
function hasHardConstraint(plan) {
  return Boolean(plan && (plan.constraints || []).some((c) => c && c.hard === true));
}

// Two observers noticing the same thing.
//
// A discussion of two agents watching one conversation will find the same
// missing dependency at the same moment reasonably often, and two cards saying
// it in different words is the failure everybody predicts and nobody guards
// against. Sameness is judged on what the candidate is *about* — its type and
// the substance of its claim — rather than on its wording, because two models
// never phrase anything identically and a string comparison would therefore
// never merge anything.
//
// The survivor is the better-evidenced of the two, and the other's observer is
// kept as an attribution: "Mac and Zima both raised this" is more useful than
// either name alone, and losing the second name would quietly overstate how
// much independent support the idea has.
function dedupe(candidates) {
  const out = [];
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const twin = out.find((kept) => sameIdea(kept, candidate));
    if (!twin) {
      out.push({ ...candidate, observerIds: [candidate.observerId].filter(Boolean) });
      continue;
    }
    if (!twin.observerIds.includes(candidate.observerId) && candidate.observerId) {
      twin.observerIds.push(candidate.observerId);
    }
    // The stronger claim wins the card. Evidence first, because a claim pointing
    // at three messages is better grounded than one pointing at one; impact
    // breaks the tie.
    const better =
      candidate.evidence.length > twin.evidence.length ||
      (candidate.evidence.length === twin.evidence.length && candidate.impact > twin.impact);
    if (better) {
      const observerIds = twin.observerIds;
      Object.assign(twin, candidate, { observerIds });
    }
    // Two observers agreeing is evidence, and the merged card carries the union
    // of what each pointed at rather than only the winner's.
    twin.evidence = [...new Set([...twin.evidence, ...candidate.evidence])];
  }
  return out;
}

// Whether two candidates are the same idea.
//
// Same type, and claims that share most of their meaningful words. Meaningful
// is doing real work: without the stopword cut, "the" and "a" and "to" carry
// two unrelated sentences over any sensible threshold, and the deduplicator
// starts merging a dependency risk with an alternative because both mentioned
// "the server".
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'if',
  'in',
  'is',
  'it',
  'its',
  'may',
  'might',
  'not',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'to',
  'was',
  'we',
  'were',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function terms(claim) {
  return new Set(
    String(claim || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

const SAME_IDEA = 0.5;

function sameIdea(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const left = terms(a.claim);
  const right = terms(b.claim);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  // Against the smaller of the two, so a short precise claim and a long one
  // saying the same thing plus detail still count as the same idea.
  return shared / Math.min(left.size, right.size) >= SAME_IDEA;
}

// Whether a candidate has stopped being about the conversation now happening.
//
// Any one of these ends it, and they are all cheap facts rather than judgements:
// the plan moved under it, the person has said enough since that it is answering
// a different moment, or it has simply been sitting there too long. A candidate
// that expires is not deleted — see the shelf — but it may not be promoted
// without being built again against what is true now.
function expired(candidate, { planVersion = null, humanTurnsSince = 0, now = Date.now() } = {}) {
  if (!candidate) return true;
  if (planVersion != null && candidate.targetPlanVersion !== planVersion) return true;
  if (humanTurnsSince >= CANDIDATE_HUMAN_TURNS) return true;
  if (candidate.createdAt && now - candidate.createdAt >= CANDIDATE_TTL_MS) return true;
  return false;
}

// ---- what the interface says ----
//
// Here rather than in the renderer, for the reason counsel.js gives about its
// own sentences: a card, a floor request and a warning are three surfaces
// describing one candidate, and three components each writing their own version
// is how they start disagreeing.

const CATEGORY = {
  alternative: 'Alternative available',
  risk: 'Possible risk',
  contradiction: 'Contradiction',
  missing_dependency: 'Missing prerequisite',
  hard_constraint_conflict: 'Conflicts with a constraint',
  synthesis: 'Synthesis available',
  validation_test: 'Test worth running',
  clarifying_question: 'Unanswered question',
};

function categoryOf(candidate) {
  return (candidate && CATEGORY[candidate.type]) || 'Idea';
}

// The card on the shelf: what it is, and who noticed it. Never the claim on its
// own — "a local coordinator avoids conflicting turns" out of context reads as
// an instruction rather than as something on offer.
function shelfLabel(candidate, names) {
  const who = nameList((names || []).filter(Boolean));
  const what = categoryOf(candidate);
  return who ? `${what} — ${who}` : what;
}

module.exports = {
  LEVELS,
  DEFAULT_LEVEL,
  SHELF,
  SOFT_FLOOR,
  PROTECTIVE,
  CANDIDATE_TYPES,
  PROTECTIVE_TYPES,
  MIN_CONFIDENCE,
  MIN_NOVELTY,
  FLOOR_IMPACT,
  FLOOR_SILENCE_RISK,
  PROTECTIVE_CONFIDENCE,
  PROTECTIVE_SILENCE_RISK,
  RERAISE_PENALTY,
  CANDIDATE_TTL_MS,
  CANDIDATE_HUMAN_TURNS,
  score,
  cleanObserver,
  protectiveAllowed,
  mentions,
  cleanCandidate,
  eligible,
  levelFor,
  hasHardConstraint,
  dedupe,
  sameIdea,
  expired,
  categoryOf,
  shelfLabel,
};
