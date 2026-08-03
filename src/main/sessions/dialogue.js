'use strict';

// Two agents talking to each other, with LanChat holding both ends.
//
// A counsel asked in parallel gives you several answers to one question, and a
// relay gives you one lap of them reading each other. A dialogue is the loop:
// each agent replies to what the last one said, turn after turn, until it runs
// out of turns or somebody has nothing left to add.
//
// Nothing here talks to an agent. Working out what to show whoever's turn it is,
// deciding whether a reply ended the discussion, and saying why it stopped are
// all pure functions of what they are handed — same rule as counsel.js, and for
// the same reason: a conversation between two language models is the last thing
// anybody wants to have to run in order to find out what it says.

// How many turns a dialogue may take before it is over, whatever the agents
// think. This is the ceiling on the setting, not the setting.
//
// A dialogue is the one thing in LanChat that can spend money without anybody
// typing: two agents will keep finding something to say for as long as they are
// asked to. The cap is a hard number rather than a judgement about whether the
// discussion is going anywhere, because a judgement is the thing neither end of
// this is in a position to make.
const MAX_TURNS = 12;
const MIN_TURNS = 2;
const DEFAULT_TURNS = 6;

// Enough of the last answer to reply to. Smaller than counsel.js's relay budget
// on purpose: a relay quotes everything said so far exactly once, and a dialogue
// would carry the whole discussion again on every turn. Only the last thing said
// is quoted here — for ACP and HTTP the agent is holding its own side of the
// conversation anyway, so re-sending it is duplication rather than context.
const MAX_QUOTE_CHARS = 4000;

// The line an agent ends on when it has nothing further to add.
//
// A whole sentence rather than a sentinel token, because it is never stripped:
// it is stored in the transcript exactly as the agent said it, and "nothing
// further." is something a person reading the conversation back would expect to
// find at the end of one. A marker like <<DONE>> would have to be edited out of
// the message after it was written down, and rewriting an answer to make the
// bookkeeping tidy is not a thing this codebase does.
const CLOSING_LINE = 'nothing further.';
const CLOSING_RE = /^\s*[—–-]?\s*nothing further[.!]?\s*$/i;

// Why a dialogue stopped. Phrased as the end of "The discussion ended …", the
// same way counsel.js phrases its reasons as the end of "X is …".
const ENDINGS = {
  spent: 'after using all its turns',
  converged: 'because there was nothing further to add',
  silence: 'because an agent finished without saying anything',
  error: 'because an agent could not answer',
  stopped: 'because you stopped it',
};

// A turn budget somebody can actually be given: a whole number, at least two —
// one each — and never above the ceiling. Anything unreadable falls to the
// default rather than to nought, because nought would be a dialogue that cannot
// happen at all.
// Nothing at all is checked before the number is read, because Number(null) is
// nought and nought is finite: without this, a caller saying "I am not setting
// this" would be given the smallest budget there is rather than the ordinary
// one. `undefined` would have fallen through on its own; null and an empty box
// would not.
function cleanTurns(turns) {
  if (turns === null || turns === undefined || turns === '') return DEFAULT_TURNS;
  const n = Math.floor(Number(turns));
  if (!Number.isFinite(n)) return DEFAULT_TURNS;
  return Math.min(MAX_TURNS, Math.max(MIN_TURNS, n));
}

// Quoted text that cannot climb out of its quotes.
//
// This is the one piece here with an attacker in mind. The body being fenced was
// written by an agent — in a cross-machine dialogue, by an agent running on
// somebody else's computer — and it goes into a prompt several times over
// without a person reading it in between. The delimiters are what tells the
// agent on the other side where the quotation stops and where LanChat's own
// instructions start, so an agent that could write a closing fence of its own
// could write instructions in LanChat's voice.
//
// A zero-width space between the characters: the fence stops being a fence and
// the words survive intact, which matters because a genuine answer may well
// discuss these delimiters — this file does. Written as an escape rather than
// the character itself, so it cannot be lost to a copy, a diff or an editor
// that trims invisibles.
const ZWSP = '\u200b';

function fence(text) {
  return String(text == null ? '' : text).replace(/<<<|>>>/g, (m) => m.split('').join(ZWSP));
}

// A body trimmed to what will fit, marked where it was cut.
function clip(text, max = MAX_QUOTE_CHARS) {
  const body = String(text == null ? '' : text);
  return body.length > max ? `${body.slice(0, max)}\n[Truncated]` : body;
}

// Whose turn it is next.
//
// Round-robin over the order the counsel was resolved in, which is the order the
// session's list is in — see cleanIds in registry.js for why that order is data.
// Two is what a dialogue normally is; three or more works and simply goes round.
// An agent that is not in the order at all puts the turn back to the top, which
// is the only sane answer to a question that should not have been asked.
function nextSpeaker(order, lastAgentId) {
  if (!Array.isArray(order) || order.length === 0) return null;
  const at = order.findIndex((t) => t.agentId === lastAgentId);
  if (at < 0) return order[0];
  return order[(at + 1) % order.length];
}

// What the agent whose turn it is sees.
//
// Same fence and same order as composeContext in prompt.js — quoted material
// first, the thing to act on last — so an agent meets one convention across
// forks, relays and dialogues rather than three.
//
// The framing lines are outside the fence and the quoted words are inside it,
// which is the whole point of fence() above: everything LanChat says is said
// where the other agent could not have written it.
//
// The names are in the block deliberately, for the reason relayPrompt gives:
// "somebody said this" invites a summary, and "Hermes said this" invites a reply
// to Hermes — which is the entire thing a dialogue is for.
function dialoguePrompt({ question, speaker, said, turn, cap } = {}) {
  // The opening turn. Nobody has spoken, so there is nothing to quote and no
  // discussion to describe yet — it is simply the question, plus the standing
  // instruction about how this one ends.
  const left = Math.max(0, (cap || 0) - (turn || 0) + 1);
  const rules = [
    `[Turn ${turn} of ${cap}.]`,
    `[Reply in your own voice. If you have nothing further to add, end your reply` +
      ` with a line reading: ${CLOSING_LINE}]`,
  ];
  if (!said || !said.text) {
    return [
      '[A discussion of this question between you and another agent]',
      ...rules,
      '',
      question || '',
    ].join('\n');
  }
  const who = said.name || 'The other agent';
  const you = speaker && speaker.name ? `You are ${speaker.name}. ` : '';
  return [
    '[A discussion of this question between you and another agent]',
    `[${you}${who} has just said this. Reply to ${who} — do not summarise them.]`,
    ...rules,
    left <= 1 ? '[This is the last turn. Say what you would want said last.]' : null,
    '<<<',
    `${who}:`,
    fence(clip(said.text)),
    '>>>',
    '',
    question || '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// Whether a reply said it was done.
//
// The last line with anything on it, so an agent that signs off after its answer
// is heard and an agent that merely mentions the phrase in passing is not.
function converged(text) {
  const lines = String(text == null ? '' : text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return CLOSING_RE.test(lines[lines.length - 1]);
}

// Why the discussion stopped, said once and not stored — a round fact, like
// every other notice a session produces.
function endedNotice(reason, { turn = 0, cap = 0 } = {}) {
  const why = ENDINGS[reason];
  if (!why) return null;
  const used = reason === 'spent' ? '' : ` It used ${turn} of ${cap} turns.`;
  return `The discussion ended ${why}.${used}`;
}

module.exports = {
  dialoguePrompt,
  converged,
  nextSpeaker,
  endedNotice,
  cleanTurns,
  fence,
  clip,
  CLOSING_LINE,
  ENDINGS,
  MAX_TURNS,
  MIN_TURNS,
  DEFAULT_TURNS,
  MAX_QUOTE_CHARS,
};
