'use strict';

// Working out who a session is asking, and what to tell them.
//
// A session can put one question to several agents at once — a counsel. Three
// things have to be decided every time it does: which of the agents it is
// pointed at can actually be reached, what to say about the ones that cannot,
// and, when they are being asked one after another, what each of them is shown
// of what has already been said.
//
// All three are pure functions of what they are handed. Liveness is decided by
// the caller and passed in as a roster, so none of this needs an agent hub, a
// socket or a clock, and every sentence it produces can be read in a test
// instead of inferred from a screenshot.

const MAX_RELAY_CHARS = 8000;

// Why somebody could not be asked. These are the words the notice is built from,
// so they are phrased as the end of "X is …" rather than as error codes.
const REASONS = {
  off: 'switched off',
  busy: 'already working on something else',
  gone: 'no longer here',
  held: 'still reading an earlier question',
};

// Who this session is asking, out of everyone it could be.
//
// `askable` is the roster: `[{ id, name, ready, reason }]`, everyone this machine
// knows about, whether or not they can take a question this instant. It is built
// by the caller, because reachability is the one thing here that depends on live
// state — see askable() in index.js.
//
// A session asking whoever is available takes the whole roster; that is what
// makes the setting a standing one rather than a list that was true once. A
// session with a list takes the list, and keeps its order: in relay mode the
// order is the order they are asked in.
//
// An id in the list that the roster has never heard of is somebody who has gone —
// an agent removed, or a peer who stopped sharing one. It is reported as missed
// rather than dropped silently, because "Hermes is no longer here" is the answer
// to the question the person is actually asking when nothing comes back from
// Hermes.
function resolveCounsel(record, { askable = [] } = {}) {
  const by = new Map(askable.map((a) => [a.id, a]));
  const wanted = record.allAgents ? askable.map((a) => a.id) : record.agentIds || [];

  const targets = [];
  const missed = [];
  for (const id of wanted) {
    const agent = by.get(id);
    if (!agent) {
      missed.push({ agentId: id, name: null, reason: 'gone' });
      continue;
    }
    if (agent.ready) targets.push({ agentId: id, name: agent.name, remote: agent.remote === true });
    else missed.push({ agentId: id, name: agent.name, reason: agent.reason || 'off' });
  }
  return { targets, missed };
}

// The names of a counsel, as a person would say them.
function names(list) {
  const said = list.map((m) => m.name || 'an agent that is no longer here');
  if (said.length === 0) return '';
  if (said.length === 1) return said[0];
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
}

// What to say about the agents that were not asked.
//
// Shown once and then gone, like every other notice: it is true about this
// question and worthless above the next one. It names them because "one of your
// agents was unavailable" leaves somebody hunting through a menu to find out
// which, and the reason is the difference between something to fix and something
// to wait for.
function missedNotice(missed) {
  if (!missed || missed.length === 0) return null;
  if (missed.length === 1) {
    const one = missed[0];
    return `${one.name || 'One agent'} was not asked — ${REASONS[one.reason] || REASONS.off}.`;
  }
  const parts = missed.map((m) => `${m.name || 'an agent'} is ${REASONS[m.reason] || REASONS.off}`);
  return `${missed.length} agents were not asked: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

// Why nobody could be asked, for the refusal that comes back when a whole
// counsel is out of reach. The same facts as the notice above, said as the
// reason a question is being handed back rather than as an aside.
function unreachableNotice(record, missed) {
  if (!missed || missed.length === 0) {
    return record.allAgents
      ? 'There are no agents to ask yet. Add one, or wait for a peer to share theirs.'
      : 'Choose an agent for this session before asking it something.';
  }
  const parts = missed.map((m) => `${m.name || 'an agent'} is ${REASONS[m.reason] || REASONS.off}`);
  const list =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Nobody in this session's counsel can be asked right now: ${list}.`;
}

// What the next agent in a relay is shown.
//
// Same fence and same order as composeContext in prompt.js — an agent reading a
// LanChat prompt should meet one convention, not two — with the answers already
// given standing where a fork's quoted excerpt would, and the question last,
// because the question is what it must act on and should be the most recent
// thing it read.
//
// The names are in the block on purpose. "Somebody said this" invites a summary;
// "Tessie said this" invites a reply to Tessie, which is the entire point of
// asking a counsel one at a time.
function relayPrompt(question, answers) {
  if (!answers || answers.length === 0) return question;
  const said = answers.map((a) => {
    const body =
      a.text.length > MAX_RELAY_CHARS ? `${a.text.slice(0, MAX_RELAY_CHARS)}\n[Truncated]` : a.text;
    return `${a.name}:\n${body}`;
  });
  const block = [
    '[Answers already given to this question by other agents]',
    '<<<',
    said.join('\n\n'),
    '>>>',
  ].join('\n');
  return question ? `${block}\n\n${question}` : block;
}

module.exports = {
  resolveCounsel,
  missedNotice,
  unreachableNotice,
  relayPrompt,
  names,
  REASONS,
  MAX_RELAY_CHARS,
};
