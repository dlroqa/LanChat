'use strict';

// What an observer is asked, and how the answer is read back.
//
// This is the seam between a language model and everything else in the feature,
// and it is the part most likely to go wrong — so it is written to fail in one
// direction only. Every unreadable answer, every half-answer, every answer that
// arrives wrapped in three paragraphs of preamble comes out of here as silence.
// Nothing is guessed, nothing is repaired by inference, and the caller never has
// to wonder whether it got a real candidate or a hopeful reconstruction of one.
//
// ---- why key-and-value rather than JSON ----
//
// LanChat's agents are not structured-output APIs. They are five transports —
// http, command, acp, ssh, a2a — and what comes back is whatever the thing on
// the other end printed. A `command` agent wrapping a model will happily prepend
// "Sure, here's my analysis:" and append a closing pleasantry, and some of them
// print progress lines. Against that, `JSON.parse` fails on the common case
// rather than the rare one, and a single trailing comma from a model that was
// otherwise perfectly clear costs the whole answer.
//
// A block of `key: value` lines survives all of it. Prose above and below is
// walked past. A malformed line is dropped without taking its neighbours with
// it. And the one thing that must not be lost — the claim — is a single line
// that either parsed or did not.
//
// ---- what a hostile answer cannot do ----
//
// The text being read here was written by an agent, and in a shared session by
// an agent on somebody else's machine. It is never executed and never trusted:
// the type has to be one of ours, the scores go through score() in observer.js,
// and the evidence is checked against message ids the caller actually holds. An
// answer claiming a message id that is not in the room is an answer pointing at
// nothing, and it is dropped in cleanCandidate.

const { fence, clip } = require('./dialogue.js');
const { renderFrame } = require('./plan.js');

// The fence an answer's structured part is wrapped in.
//
// A named fence rather than a bare one, because agents produce code blocks for
// all sorts of reasons and reading the last ``` in a reply that happened to
// contain a shell snippet would pick up the snippet. The name makes it ours.
const BLOCK = 'lanchat';
const BLOCK_OPEN = new RegExp('```' + BLOCK + '\\s*\\n', 'gi');

// The word an observer says when it has nothing worth saying.
//
// Required rather than optional, and this is deliberate: an observer that can
// answer "nothing" by producing no block at all is indistinguishable from one
// whose transport died mid-sentence. Asking for the word means silence is
// something the model chose and said, which is a fact worth having.
const NOTHING = 'NOTHING';

// How much of the conversation an observer is shown.
//
// Smaller than a dialogue's budget on purpose. An observer runs on every message
// in a planning conversation, so its prompt is the one that gets built most
// often and is the one whose size actually shows up on somebody's bill.
const MAX_WATCH_CHARS = 6000;

// ---- the prompts ----

// The standing instruction every observer prompt opens with.
//
// Written as prohibitions rather than encouragements because that is what
// actually works: a model told to "be helpful when appropriate" is helpful
// constantly. The list of what does not count is longer than the list of what
// does, and that ratio is the design.
const CHARTER = [
  '[You are observing a conversation. You are not a participant in it.]',
  '[Say nothing unless the contribution is grounded in what was actually said,' +
    ' genuinely new, and materially useful to a plan being made.]',
  '[These never qualify: agreement, praise, restating what somebody said,' +
    ' encouragement, adjacent facts, and questions already answered.]',
  '[Before proposing anything, apply this test: if these people carry on for' +
    ' several more turns without knowing this, are they likely to make a' +
    ' materially worse decision, break a stated constraint, or waste' +
    ' substantial effort? If not, say nothing.]',
];

// The discussion so far, as an observer sees it.
//
// Fenced for the reason dialogue.js gives about its own quoting: the delimiters
// are what tell the reading agent where other people's words stop and where
// LanChat's instructions start, and everything inside them was written by
// somebody who is not us.
function watched(history) {
  const turns = (history || []).filter((t) => t && t.text);
  if (turns.length === 0) return null;
  const blocks = turns.map((t) => `[${t.id}] ${t.name || 'Someone'}:\n${fence(clip(t.text))}`);
  let from = 0;
  let size = blocks.reduce((n, b) => n + b.length + 2, 0);
  while (from < blocks.length - 1 && size > MAX_WATCH_CHARS) {
    size -= blocks[from].length + 2;
    from += 1;
  }
  const out = from > 0 ? ['[Earlier turns elided]'] : [];
  return [...out, ...blocks.slice(from)].join('\n\n');
}

// Reading the room: is there a plan here, and what is in it?
//
// Extraction is asked for separately from proposing anything, and that split is
// load-bearing. A single prompt that said "work out the plan and suggest an
// improvement" gets a model that invents whatever plan makes its suggestion look
// good. Asked on its own, with the message ids it must cite, it has nothing to
// aim at.
function extractionPrompt({ history, frame } = {}) {
  const said = watched(history);
  const known = renderFrame(frame);
  return [
    '[Read the conversation below and describe the plan being made, if there is one.]',
    '[Every item must cite the message ids it came from, in square brackets.' +
      ' An item you cannot cite is one you must not write down.]',
    '[Do not invent, infer intent, or add anything sensible that nobody said.]',
    known ? `[What was already understood:]\n${known}` : null,
    '',
    said ? `<<<\n${said}\n>>>` : '',
    '',
    'Reply with only this block, and nothing else:',
    '```' + BLOCK,
    'goal: <one sentence, or leave blank>',
    'constraint: <something this must not break> [ids] <hard|soft>',
    'assumption: <something being taken as true> [ids]',
    'action: <a concrete thing somebody proposed doing> [ids]',
    'question: <something raised and not answered> [ids]',
    'decision: <something explicitly settled> [ids]',
    'next: <an agreed next step> [ids]',
    '```',
    '[Repeat any line as often as it applies. Omit lines that do not apply.]',
    `[If there is no plan being made here, reply with exactly: ${NOTHING}]`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// Having something to say, and deciding whether to say it.
function candidatePrompt({ question, history, frame, speaker, types } = {}) {
  const said = watched(history);
  const known = renderFrame(frame);
  const you = speaker && speaker.name ? `[You are ${speaker.name}.]` : null;
  return [
    ...CHARTER,
    you,
    known ? `[The plan as it stands:]\n${known}` : null,
    '',
    said ? `<<<\n${said}\n>>>` : '',
    question ? `\n[The last thing said was:]\n${fence(clip(question))}` : '',
    '',
    'Reply with only this block, and nothing else:',
    '```' + BLOCK,
    `type: <one of: ${(types || []).join(', ')}>`,
    'claim: <one sentence — the thing you would say>',
    'evidence: <message ids this is grounded in, comma separated>',
    'novelty: <0 to 1 — how far this is from what has been said>',
    'impact: <0 to 1 — how much the plan changes if you are right>',
    'urgency: <0 to 1 — how badly this needs saying now rather than later>',
    'confidence: <0 to 1 — how sure you are>',
    'interruption_cost: <0 to 1 — how disruptive saying this now would be>',
    'silence_risk: <0 to 1 — what it costs if nobody ever hears this>',
    '```',
    `[If you have nothing that passes the test above, reply with exactly: ${NOTHING}]`,
    '[Do not write the block and a claim of nothing. One or the other.]',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// Taking the watching turn in a Human Like cycle.
//
// Plain language rather than the block above, and that is a deliberate
// difference. A candidate block is machinery: it is read by code, scored, and
// only turned into speech if it clears the bar. This turn is the speech — it
// goes straight into the transcript where a person reads it — so asking for a
// block here would put `type:` and `silence_risk:` in the middle of somebody's
// conversation.
//
// The restraint is the same restraint. What changes is only that the decision
// to stay quiet is the agent's own and is expressed by saying nothing, which the
// cycle treats as a turn declined rather than as an agent leaving.
function watchPrompt({ question, history, frame, speaker, roster } = {}) {
  const said = watched(history);
  const known = renderFrame(frame);
  const here = (roster || []).map((t) => t.name).filter(Boolean);
  return [
    ...CHARTER,
    speaker && speaker.name ? `[You are ${speaker.name}.]` : null,
    here.length ? `[The others here: ${here.join(', ')}.]` : null,
    '[It is your turn to say something, or to say nothing.]',
    '[If you have something that passes the test above, say it in two sentences:' +
      ' the point, and one thing to do or check.]',
    `[If you do not, reply with exactly: ${NOTHING} — that is an ordinary answer` +
      ' here and costs you nothing.]',
    '[Do not summarise what was said. Do not agree with people. Do not praise anybody.]',
    known ? `[The plan as it stands:]\n${known}` : null,
    '',
    said ? `<<<\n${said}\n>>>` : '',
    question ? `\n${question}` : '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// Saying it, once permission has been given.
//
// A separate call from the candidate, and that is the rule the whole design
// turns on: nothing is written until somebody has agreed to hear it. Generating
// the speech up front and holding it would mean a queue of paragraphs waiting
// for a gap, every one of them about a conversation that has since moved.
function admittedPrompt({ candidate, frame, history, since } = {}) {
  const said = watched(history);
  const known = renderFrame(frame);
  return [
    '[You asked to say something and the room agreed. Say it now, briefly.]',
    '[State the point, why it matters, and one thing to do or test.' +
      ' Do not summarise the conversation and do not thank anybody.]',
    '[Three sentences at most.]',
    // The whole reason this is a second call. Between asking and being allowed,
    // people carried on talking, and an observer that ignores that says something
    // already answered — which is the fastest way to teach somebody to stop
    // granting the floor.
    since
      ? `[Since you asked to speak, this was said. If it already covers your point,' +
        ' say so in one sentence instead:]\n${fence(clip(since))}`
      : null,
    known ? `[The plan as it stands:]\n${known}` : null,
    '',
    said ? `<<<\n${said}\n>>>` : '',
    '',
    `[What you asked to say was: ${fence(clip(candidate && candidate.claim, 500))}]`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ---- reading the answer back ----

// The last `lanchat` block in a reply, or null.
//
// The last rather than the first: a model that shows its working sometimes
// writes a draft block and then a corrected one, and the corrected one is the
// answer. Nothing outside the block is read at all.
function blockOf(text) {
  const body = String(text == null ? '' : text);
  BLOCK_OPEN.lastIndex = 0;
  let start = -1;
  let match = BLOCK_OPEN.exec(body);
  while (match) {
    start = match.index + match[0].length;
    match = BLOCK_OPEN.exec(body);
  }
  if (start === -1) return null;
  const end = body.indexOf('```', start);
  return (end === -1 ? body.slice(start) : body.slice(start, end)).trim() || null;
}

// Whether the answer was an explicit "nothing to say".
//
// Checked outside the block as well as in it, because a model told to reply with
// one word usually does exactly that and does not wrap it in a fence.
function saidNothing(text) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return true;
  const block = blockOf(body);
  if (block) return new RegExp(`^${NOTHING}\\b`, 'i').test(block);
  // Bare, allowing for the full stop and the quotation marks a model adds.
  return new RegExp(`^["'\`]?${NOTHING}["'\`.!]*$`, 'i').test(body);
}

// The `key: value` lines of a block, as a map of key to list of values.
//
// A list rather than a single value because the extraction block repeats keys on
// purpose — several constraints, several assumptions. A malformed line is
// skipped and its neighbours are kept, which is the entire reason this is not
// JSON.
function fieldsOf(block) {
  const out = new Map();
  if (!block) return out;
  for (const raw of String(block).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line
      .slice(0, at)
      .trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, '');
    const value = line.slice(at + 1).trim();
    if (!key || !value) continue;
    // A model that echoed the prompt's own placeholder rather than filling it
    // in. Dropped rather than stored, because `<one sentence>` as a claim is
    // worse than no claim at all — it would pass the "is there a claim" check.
    if (/^<.*>$/.test(value)) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(value);
  }
  return out;
}

// The message ids cited in a value, as `[m1, m2]` or a bare list.
//
// `bare` is what stops a sentence being read as its own citation, and it is not
// a nicety. An `evidence:` line is nothing but ids, so a bare list is the whole
// value. An extraction line is prose *followed by* a citation, and reading it
// bare turns "Must be encrypted end to end" into six message ids — which sails
// straight through the one guard that stops a model writing down a constraint
// nobody ever stated. So the two callers ask for different things, explicitly.
function idsIn(value, { bare = true } = {}) {
  const said = String(value == null ? '' : value);
  const bracket = said.match(/\[([^\]]*)\]/);
  if (!bracket && !bare) return [];
  const body = bracket ? bracket[1] : said;
  return (
    body
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      // Strip the decoration a model puts round an id it is citing.
      .map((s) => s.replace(/^["'#]+|["'.,]+$/g, ''))
      .filter(Boolean)
  );
}

// The text of a value with its citation taken off the end.
function textOf(value) {
  return String(value == null ? '' : value)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(hard|soft)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// An extraction, read back into the shape plan.js merges.
//
// Returns null for "nothing here", which is different from an empty extraction:
// null means the observer looked and found no plan, and the caller leaves the
// frame alone rather than bumping its version for a reading that found nothing.
function parseExtraction(text) {
  if (saidNothing(text)) return null;
  const block = blockOf(text);
  if (!block) return null;
  const fields = fieldsOf(block);
  if (fields.size === 0) return null;

  // Every extraction line is prose plus a citation, so the citation has to be
  // bracketed. An uncited item comes back with no sources and is dropped by the
  // filter — which is the guard, not an accident of parsing.
  const listFrom = (key) =>
    (fields.get(key) || [])
      .map((value) => ({ text: textOf(value), sources: idsIn(value, { bare: false }) }))
      .filter((item) => item.text && item.sources.length);

  const goal = (fields.get('goal') || [])[0];
  const extraction = {
    goal: goal ? textOf(goal) : null,
    constraints: (fields.get('constraint') || [])
      .map((value) => ({
        text: textOf(value),
        sources: idsIn(value, { bare: false }),
        // Hardness is read from the word the prompt asked for, and anything that
        // is not the word `hard` is soft. A model that omits it has not declared
        // a hard constraint, and defaulting to hard would hand the protective
        // path a rule nobody stated.
        hard: /\bhard\b/i.test(value),
      }))
      .filter((item) => item.text && item.sources.length),
    assumptions: listFrom('assumption'),
    candidate_actions: listFrom('action'),
    open_questions: listFrom('question'),
    decisions: listFrom('decision'),
    next_steps: listFrom('next'),
  };
  // A block that parsed but yielded nothing usable is the same as no block.
  const anything = extraction.goal || Object.values(extraction).some((v) => Array.isArray(v) && v.length);
  return anything ? extraction : null;
}

// A candidate, read back.
//
// Deliberately not cleaned here — this hands back the raw shape and
// cleanCandidate in observer.js decides what is acceptable. One place decides
// what a valid candidate is, and it is the same place whether the candidate came
// off a model or out of a test.
function parseCandidate(text) {
  if (saidNothing(text)) return null;
  const block = blockOf(text);
  if (!block) return null;
  const fields = fieldsOf(block);
  const one = (key) => (fields.get(key) || [])[0];
  const claim = one('claim');
  if (!claim) return null;
  return {
    type: one('type')
      ? String(one('type'))
          .trim()
          .toLowerCase()
          .replace(/[^a-z_]/g, '')
      : null,
    claim: textOf(claim),
    evidence: idsIn(one('evidence')),
    novelty: one('novelty'),
    impact: one('impact'),
    urgency: one('urgency'),
    confidence: one('confidence'),
    interruptionCost: one('interruption_cost'),
    silenceRisk: one('silence_risk'),
  };
}

// The one retry, and only for an answer that looked like it was trying.
//
// A reply with no block at all is a transport that is not going to produce one —
// asking again costs a second run to get a second nothing. A reply *with* a
// block that failed to yield a claim is a model that understood the shape and
// fumbled it, and that is worth exactly one more attempt.
//
// Never two. A repair loop that can run twice can run for ever on a model
// having a bad day, and the failure mode is a session quietly spending money on
// an observer that says nothing.
function worthRepairing(text) {
  if (saidNothing(text)) return false;
  return Boolean(blockOf(text));
}

// The one retry, asked so that it can actually succeed.
//
// `ask` is the original question, repeated in full. That is not padding: the
// answer has to cite message ids, and the ids only exist in the conversation the
// first prompt carried. A repair that said merely "try again, properly" would
// hand the agent a schema with nothing to ground it in — so it would cite
// nothing, fail the evidence filter, and be dropped. A retry that cannot
// possibly produce a usable answer is worse than no retry, because it costs a
// run to learn what was already known.
//
// The correction goes first, where an instruction is read, and the original ask
// follows it unchanged.
function repairPrompt(previous, ask) {
  return [
    '[Your last reply could not be read.]',
    '[Reply with only the block, starting with ```' + BLOCK + ' and ending with ```.]',
    '[No text before it and none after it.]',
    `[Or, if you have nothing to say, reply with exactly: ${NOTHING}]`,
    previous ? `[What you sent was:]\n${fence(clip(previous, 800))}` : null,
    '',
    ask || '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

module.exports = {
  BLOCK,
  NOTHING,
  MAX_WATCH_CHARS,
  CHARTER,
  watched,
  extractionPrompt,
  candidatePrompt,
  watchPrompt,
  admittedPrompt,
  blockOf,
  saidNothing,
  fieldsOf,
  idsIn,
  textOf,
  parseExtraction,
  parseCandidate,
  worthRepairing,
  repairPrompt,
};
