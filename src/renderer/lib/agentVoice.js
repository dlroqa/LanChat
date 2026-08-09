// A voice per agent, so a discussion between four sounds like four people.
//
// The exact companion to agentColor.js, and deliberately so. That file gives
// each agent a colour "so a discussion between four reads as four voices"; this
// one makes the metaphor literal. Everything it established holds here without
// restatement: key on the agent's **id** and never its name, hash to a slot,
// step to the next free slot when two agents collide, and sort the ids so every
// window agrees on who got what.
//
// Rather than repeat that rule, this imports it. `ringFor` in agentColor.js is
// the single implementation; here it is handed a different ring.
//
// One consequence is worth naming because it is a feature and not a
// coincidence: VOICES is the same length as AGENT_HUES, and ringFor is a pure
// function of the ids and the ring's length. So an agent's voice slot and its
// colour slot are always the same slot — the agent in the third colour speaks in
// the third voice, in every session, including after a collision moves both.
// test/agentVoice.test.js asserts that rather than trusting it, because the day
// somebody adds a thirteenth hue is the day it silently stops being true.

import { ringFor, slotFor } from './agentColor.js';

// The ring.
//
// Twelve of Gemini's thirty prebuilt voices. Which twelve is not arbitrary: each
// is listed here with the characteristic Google documents for it, and adjacent
// slots are deliberately opposed — bright against gravelly, youthful against
// informative, soft against firm. That ordering does the same job as the
// five-step hue ordering in agentColor.js: it means the collision rule lands on
// an obviously different voice instead of a neighbouring shade of the same one.
//
// Two agents in a room must not merely have different voice *names*. They must
// be told apart with your eyes shut, which is the entire point, and two "Firm"
// voices next to each other would fail that while looking correct in a test that
// only checked for distinctness.
export const VOICES = Object.freeze([
  'Zephyr', // Bright
  'Algenib', // Gravelly
  'Leda', // Youthful
  'Charon', // Informative
  'Sadachbia', // Lively
  'Enceladus', // Breathy
  'Puck', // Upbeat
  'Gacrux', // Mature
  'Achernar', // Soft
  'Kore', // Firm
  'Vindemiatrix', // Gentle
  'Fenrir', // Excitable
]);

// The voice an agent has on its own, with no room to be distinct within — for
// Settings, where one agent is auditioned at a time. The counterpart of
// colorOf(), and it shares that function's trade-off: always the same voice for
// the same agent, but not guaranteed different from the agent next to it.
export function voiceOf(agentId) {
  return VOICES[slotFor(agentId, VOICES.length)];
}

// The voices of everybody in one discussion, all of them different.
export function voicesFor(agentIds) {
  return ringFor(agentIds, VOICES);
}

// Your own voice, for your own questions when the whole session is played back.
//
// Held deliberately **outside** VOICES rather than as a thirteenth entry in it.
// Two things depend on that. An agent can never be dealt this voice, so the
// narrator never sounds like a participant; and VOICES stays the same length as
// AGENT_HUES, which is what makes an agent's voice slot its colour slot (see the
// header, and the invariant test).
//
// Sulafat is documented "Warm", which is what a voice reading your side of a
// conversation should be against a ring picked for contrast.
export const USER_VOICE = 'Sulafat';

// The voice for one turn, whoever said it — and it always answers.
//
// This is the function the player actually calls, and it exists because of the
// bug it now makes impossible. `voicesFor` only knows the cast it was given, and
// a session set to "all agents" does not keep its cast in `agentIds` — so agents
// answering from outside that list resolved to `undefined`, main took an unnamed
// voice as a reason to fall back, and every one of those turns was spoken by the
// local voice however good the key was.
//
// So the roster decides *distinctness* and voiceOf() guarantees *everybody has
// one* — exactly the colorOf/paletteFor split agentColor.js describes. An agent
// nobody told us about still speaks, just not necessarily distinctly.
export function voiceForTurn({ agentId, mine }, voices) {
  if (mine) return USER_VOICE;
  return voices?.get(agentId) || voiceOf(agentId);
}

// ------------------------------------------------------------ the local voice
//
// What speaks when the online engine is switched off, which is the default. The
// browser's own voices are whatever the machine happens to have installed, so
// nothing here can name one: on this Linux host it is speech-dispatcher's set,
// on macOS it is the system voices, and the two have nothing in common.
//
// So the same slot rule is applied to whatever list the platform offers. That
// gives the one property that actually matters — four agents get four different
// local voices, stably — without pretending to know what they will sound like.

// Which of the platform's voices reads your own words.
//
// The one the system calls default, because that is the voice this machine has
// already decided is its ordinary speaking voice — the closest local equivalent
// of a narrator. Falls back to the first in the list, and to nothing at all on a
// machine with no voices.
export function localUserVoice(available, lang) {
  const list = inLanguage(available, lang);
  if (!list.length) return null;
  return (list.find((v) => v.default === true) || list[0]).name;
}

// ------------------------------------------------------------ the local voice
//
// What speaks when the online engine is switched off, which is the default. The
// browser's own voices are whatever the machine happens to have installed, so
// nothing here can name one: on this Linux host it is speech-dispatcher's set,
// on macOS it is the system voices, and the two have nothing in common.
//
// So the same slot rule is applied to whatever list the platform offers. That
// gives the one property that actually matters — four agents get four different
// local voices, stably — without pretending to know what they will sound like.

// Voices that are not the user's language are worse than a repeat: a French
// voice reading English is unintelligible, where two agents sharing an accent is
// merely less good. So the list is filtered to the window's language first, and
// only falls back to the whole list if that leaves nothing.
function inLanguage(available, lang) {
  const all = (available || []).filter((v) => v && v.name);
  if (!all.length) return [];
  const tag = String(lang || '')
    .toLowerCase()
    .split('-')[0];
  const matching = tag
    ? all.filter((v) =>
        String(v.lang || '')
          .toLowerCase()
          .startsWith(tag)
      )
    : [];
  return matching.length ? matching : all;
}

// `exclude` is the voice reading your own words, kept back so an agent does not
// sound like you. Given back if holding it out would leave nothing to deal —
// one voice shared is worse than an agent that cannot speak at all.
export function localVoicesFor(agentIds, available, lang, { exclude = null } = {}) {
  const list = inLanguage(available, lang);
  if (!list.length) return new Map();
  const kept = exclude ? list.filter((v) => v.name !== exclude) : list;
  const ring = (kept.length ? kept : list).map((v) => v.name);
  return ringFor(agentIds, ring);
}
