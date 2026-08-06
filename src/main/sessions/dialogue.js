'use strict';

// Agents talking to each other, with LanChat holding every end.
//
// A counsel asked in parallel gives you several answers to one question, and a
// relay gives you one lap of them reading each other. A dialogue is the loop:
// each agent replies to what has been said, turn after turn, until it runs out
// of turns or there is nobody left with anything to add.
//
// Two is what a discussion normally is, and for a long time it was all this
// could be: every turn was shown the previous reply and nothing else, and the
// prompt said "you and another agent" in so many words. With three that quietly
// stopped being true — the third agent never saw the first, and on the next lap
// the first had never seen the second, so each of them was replying to a third
// of a conversation and reasonably concluded there was nothing left to say.
// Everything below is written for N: what a speaker is shown is the discussion,
// not the last line of it.
//
// Nothing here talks to an agent. Working out what to show whoever's turn it is,
// deciding whether a reply ended the discussion, and saying why it stopped are
// all pure functions of what they are handed — same rule as counsel.js, and for
// the same reason: a conversation between several language models is the last
// thing anybody wants to have to run in order to find out what it says.

// The role a person's turn carries, and what they are called when it is quoted.
// Both belong to a2a.js, which owns the record's vocabulary; this file owns what
// is said about it. No cycle: a2a.js reads nothing back from here.
const { ROLE_USER, WATCHER } = require('./a2a.js');

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

// Enough of any one turn to reply to. A single runaway answer must not be able
// to crowd out the question underneath it, or the turns either side of it.
const MAX_QUOTE_CHARS = 4000;

// And enough of the discussion as a whole.
//
// Every turn carries every turn before it. That is more than a discussion of two
// strictly needs — an ACP or HTTP agent is holding its own side of the
// conversation, so its own earlier words come back to it a second time — and it
// is the only thing that works for three or more, where an agent has genuinely
// never seen what was said while it was not speaking. It is also the only thing
// that works at all for `command`, `spawn` and `ssh`, which are handed a prompt
// and remember nothing between turns.
//
// So this is a deliberate trade of prompt size for a discussion that is actually
// between everybody in it. The budget is what keeps the trade bounded: past it,
// the oldest turns go first and say that they have, because the turns being
// replied to are the recent ones.
const MAX_DISCUSSION_CHARS = 12000;
const ELIDED_MARK = '[Earlier turns elided]';

// Where the turns this speaker has not been shown begin. At most once in a
// prompt, and never in the first one — an agent that has not spoken yet is not
// catching up on anything.
const NEW_MARK = '— new since your last turn —';

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
//
// The first four are what the *last* agent to leave did, which is why they read
// as one agent's doing: by the time any of them ends a discussion there is only
// one other agent left, and a conversation of one is not one. `dwindled` is the
// same fact said from the other side, for a discussion of several that emptied
// out a few at a time rather than all at once.
const ENDINGS = {
  spent: 'after using all its turns',
  converged: 'because there was nothing further to add',
  silence: 'because an agent finished without saying anything',
  error: 'because an agent could not answer',
  stopped: 'because you stopped it',
  dwindled: 'because everybody else had finished and one agent cannot discuss alone',
};

// Why one agent stopped, in a discussion the others are carrying on without it.
//
// Its own sentence rather than one of the endings above, because it is not an
// ending: three agents out of four still have the floor, and telling somebody
// "the discussion ended" when it plainly has not is worse than saying nothing.
// Said once, when it happens, and never stored — the same rule every other
// notice a session produces follows.
const DEPARTURES = {
  converged: 'had nothing further to add',
  silence: 'finished without saying anything',
  error: 'could not answer',
};

function leftNotice(name, reason, remaining) {
  const why = DEPARTURES[reason];
  if (!why) return null;
  const who = name || 'An agent';
  const rest =
    remaining === 1 ? 'One agent is left' : `The other ${remaining === 2 ? 'two' : remaining} carried on`;
  return `${who} ${why}. ${rest}.`;
}

// What the last one out did.
//
// The same fact as leftNotice without the part that would no longer be true:
// nobody carried on, because there was nobody left to. Said separately so that a
// discussion which emptied out still records *why* each agent went — "everybody
// else had finished" is the shape of the ending and not a reason, and losing the
// reason for the one that ended it would be the same information gap this whole
// seam was rebuilt to close.
function finalLeftNotice(name, reason) {
  const why = DEPARTURES[reason];
  if (!why) return null;
  return `${name || 'An agent'} ${why}.`;
}

// A list of names as somebody would say it: "Hermes", "Hermes and Tessie",
// "Hermes, Tessie and Beacon".
//
// Here rather than in counsel.js, which has the older copy of this, because
// counsel.js already reads from this file and the reverse would be a cycle. One
// joiner, so a roster line and a missed-agent notice cannot drift into
// disagreeing about where the commas go.
function nameList(names) {
  const said = (names || []).filter(Boolean);
  if (said.length === 0) return '';
  if (said.length === 1) return said[0];
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
}

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
//
// `gone` is everybody who has left: agents that signed off, went quiet or could
// not answer. They stay in the order — the rota is a fact about how the
// discussion was arranged and the transcript still has their words in it — and
// are simply skipped on the way past. Nobody left at all is null, which is the
// caller's cue that there is no discussion any more.
function nextSpeaker(order, lastAgentId, gone) {
  if (!Array.isArray(order) || order.length === 0) return null;
  const left = gone || new Set();
  const at = order.findIndex((t) => t.agentId === lastAgentId);
  // From the one after whoever just spoke, all the way round to them again. A
  // stranger — or nobody, on the opening turn — starts the sweep at the top.
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(at < 0 ? -1 + step : at + step) % order.length];
    if (!left.has(candidate.agentId)) return candidate;
  }
  return null;
}

// Everybody still in the discussion, in the order they speak.
function remaining(order, gone) {
  const left = gone || new Set();
  return (order || []).filter((t) => !left.has(t.agentId));
}

// The discussion so far, quoted, fenced, attributed and bounded.
//
// Every turn, not the last one — this is the piece that makes a discussion of
// four a discussion between four rather than four agents each talking to
// whoever happened to go before them.
//
// `history` is `[{ agentId, name, text }]` in the order it was said. `seenBy` is
// the agent about to read it: everything after that agent's own last turn is
// what it has not been shown, and the mark goes there. An agent that has not
// spoken yet has seen none of it, and gets no mark — there is nothing to catch
// up on when it is all new.
function quoteDiscussion(history, seenBy) {
  const turns = (history || []).filter((t) => t && t.text);
  if (turns.length === 0) return null;

  // Where this speaker last left the conversation. Everything after it is new.
  let lastMine = -1;
  for (let i = 0; i < turns.length; i += 1) {
    if (seenBy && turns[i].agentId === seenBy) lastMine = i;
  }

  // Each turn on its own, clipped, so one runaway answer is cut rather than
  // eating everybody else's words.
  const blocks = turns.map((t) => `${t.name || 'An agent'}:\n${fence(clip(t.text))}`);

  // Oldest first out of the door, until what is left fits. The +2 is the blank
  // line between blocks, which is part of what has to fit.
  let from = 0;
  let size = blocks.reduce((n, b) => n + b.length + 2, 0);
  while (from < blocks.length - 1 && size > MAX_DISCUSSION_CHARS) {
    size -= blocks[from].length + 2;
    from += 1;
  }

  const out = [];
  if (from > 0) out.push(ELIDED_MARK);
  for (let i = from; i < blocks.length; i += 1) {
    // The mark sits before the first turn this agent has not read, and only when
    // that turn is actually in what remains after eliding.
    if (lastMine >= 0 && i === lastMine + 1) out.push(NEW_MARK);
    out.push(blocks[i]);
  }
  return out.join('\n\n');
}

// What the agent whose turn it is sees.
//
// Same fence and same order as composeContext in prompt.js — quoted material
// first, the thing to act on last — so an agent meets one convention across
// forks, relays and dialogues rather than three.
//
// The framing lines are outside the fence and the quoted words are inside it,
// which is the whole point of fence() above: everything LanChat says is said
// where no agent could have written it.
//
// The names are in the block deliberately, for the reason relayPrompt gives:
// "somebody said this" invites a summary, and "Hermes said this" invites a reply
// to Hermes — which is the entire thing a dialogue is for. With more than two in
// the room the roster line does the same job one level up: an agent that is not
// told who else is here cannot address them by name, and a discussion where
// nobody is addressed is a queue of statements.
function dialoguePrompt({ question, speaker, roster, history, turn, cap } = {}) {
  const here = (roster || []).map((t) => t.name).filter(Boolean);
  const count = (roster || []).length;
  const left = Math.max(0, (cap || 0) - (turn || 0) + 1);

  // Who is in the room. Said as a number and a list rather than "another agent",
  // which was true only while a discussion could only ever be two.
  const room =
    count > 1
      ? `[A discussion of this question between ${count} agents: ${nameList(here)}.]`
      : '[A discussion of this question between you and the other agents.]';

  const you = speaker && speaker.name ? `You are ${speaker.name}.` : null;
  // The rota, so an agent knows it is not the only one who has not spoken yet
  // and that the floor comes back round to it.
  const order = count > 1 ? `Speaking order: ${here.join(' → ')}, then round again.` : null;

  // Whether the person watching has said anything into this discussion.
  //
  // Their words are quoted in the order they were said, like everybody else's,
  // because that order is the truth about the conversation: somebody who spoke
  // while an agent was still answering did not speak in reply to it, and moving
  // their turn below that answer to make it more prominent would say they did.
  //
  // So prominence is done here instead, outside the fence, in LanChat's own
  // voice — which is also the only place it can be said safely, since an agent
  // could otherwise write this line itself.
  const interrupted = (history || []).some((t) => t && t.role === ROLE_USER);

  const rules = [
    [you, order].filter(Boolean).length ? `[${[you, order].filter(Boolean).join(' ')}]` : null,
    `[Turn ${turn} of ${cap}.]`,
    interrupted
      ? '[The person watching has spoken into this discussion. Their turns are the ones marked' +
        ` "${WATCHER}" — take them as direction rather than as another opinion.]`
      : null,
    count > 2
      ? '[Reply in your own voice, to the discussion. Address anyone in it by name.' +
        ' Do not summarise what has been said.]'
      : '[Reply in your own voice, to what has been said. Do not summarise it.]',
    `[If you have nothing further to add, end your reply with a line reading: ${CLOSING_LINE}]`,
    left <= 1 ? '[This is the last turn. Say what you would want said last.]' : null,
  ].filter(Boolean);

  const said = quoteDiscussion(history, speaker && speaker.agentId);

  // The opening turn. Nobody has spoken, so there is nothing to quote and no
  // discussion to describe yet — it is simply the question, plus the standing
  // instruction about how this one ends.
  if (!said) return [room, ...rules, '', question || ''].join('\n');

  return [room, ...rules, '<<<', said, '>>>', '', question || ''].join('\n');
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
  quoteDiscussion,
  converged,
  nextSpeaker,
  remaining,
  endedNotice,
  leftNotice,
  finalLeftNotice,
  nameList,
  cleanTurns,
  fence,
  clip,
  CLOSING_LINE,
  ENDINGS,
  DEPARTURES,
  MAX_TURNS,
  MIN_TURNS,
  DEFAULT_TURNS,
  MAX_QUOTE_CHARS,
  MAX_DISCUSSION_CHARS,
  ELIDED_MARK,
  NEW_MARK,
};
