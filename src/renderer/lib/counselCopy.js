// What a session's counsel is called, in the four places that have to say it.
//
// A session used to ask one agent, and one agent has one name: the header, the
// sidebar row, the composer's placeholder and the status word could each write
// it out and there was nothing to get wrong. A counsel of three has to be said
// rather than named, and the moment four surfaces each say it their own way they
// start disagreeing — the header saying "3 agents" over a sidebar row that still
// names one of them is how somebody ends up believing they are asking a different
// set of agents than they are.
//
// So it is said once, here, and read from there. Pure and DOM-free, in the house
// style of turnStanding.js and sessionStanding.js, which means every sentence in
// the interface can be asserted in a test rather than read off a screenshot.

// Beyond this, names stop being a list somebody reads and become a wall to
// count. Three is enough to recognise a counsel you assembled; past it the
// number is the useful part.
const MAX_NAMED = 3;

// "Hermes", "Hermes and Tessie", "Hermes, Tessie and Fable", and then
// "Hermes, Tessie and 2 others".
export function counselNames(names, max = MAX_NAMED) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const rest = list.length - max;
  return `${list.slice(0, max).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

// Who a session asks, resolved from the roster rather than from the record.
//
// The record keeps ids; a roster row is what has a name, and an id whose agent
// has gone resolves to nothing — which is the same state as never having chosen
// it, since either way there is nobody there to ask. A session set to ask
// whoever is available resolves to whoever is available, that being the whole of
// what the setting means.
//
// It lives beside the sentences for the same reason they do: the sidebar row and
// the search results both have to name a counsel, and two surfaces each working
// it out from `agentIds` is how one of them goes stale the day that field grows
// a third shape.
export function sessionCounsel(session, agents) {
  const roster = agents || [];
  if (!session) return [];
  if (session.allAgents) return roster;
  const ids = session.agentIds || (session.agentId ? [session.agentId] : []);
  return ids.map((id) => roster.find((a) => a.id === id)).filter(Boolean);
}

// The header chip: what this session asks, short enough to sit on one line beside
// the title.
//
// A session asking whoever is available says so rather than naming today's three,
// because the set is not the point of that setting — the standing instruction is,
// and a chip reading "Hermes, Tessie and Fable" would go stale the moment somebody
// shared a fourth.
export function chipLabel({ allAgents, names } = {}) {
  if (allAgents) return 'All agents';
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return 'choose agents…';
  if (list.length === 1) return list[0];
  return `${list.length} agents`;
}

// The sidebar row's second line. Longer than the chip because there is room, and
// because a list of sessions is read to find one — "Session · Hermes" is what you
// scan for, and "Session · 2 agents" is not.
export function sessionSubLine({ allAgents, names, available } = {}) {
  if (allAgents) {
    const n = typeof available === 'number' ? available : (names || []).length;
    return n ? `Session · all agents (${n})` : 'Session · all agents (none here yet)';
  }
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return 'Session · no agent yet';
  if (list.length > MAX_NAMED) return `Session · ${list.length} agents`;
  return `Session · ${counselNames(list)}`;
}

// What the composer invites you to do. In relay mode it says the order, because
// the order is the whole difference between the two modes and choosing it in a
// menu that is shut by the time you type is otherwise invisible.
export function askPlaceholder({ allAgents, names, mode } = {}) {
  const keys = '  (Enter to send, Shift+Enter for newline)';
  const list = (names || []).filter(Boolean);
  if (allAgents) return `Ask all agents…${keys}`;
  if (list.length === 0) return 'Choose agents above to ask something';
  if (list.length === 1) return `Ask ${list[0]}…${keys}`;
  // Two of them are named in full either way — "all 2 agents" is a sentence
  // written by a counter rather than by a person, and there is room for both
  // names at that size.
  if (mode === 'dialogue') {
    return list.length === 2
      ? `Give ${list[0]} and ${list[1]} something to discuss…${keys}`
      : `Give ${list.length} agents something to discuss…${keys}`;
  }
  if (mode === 'relay') {
    return list.length === 2
      ? `Ask ${list[0]}, then ${list[1]}…${keys}`
      : `Ask ${list[0]}, then the rest in turn…${keys}`;
  }
  return list.length === 2
    ? `Ask ${list[0]} and ${list[1]}…${keys}`
    : `Ask all ${list.length} agents…${keys}`;
}

// Who is thinking, while they are.
//
// The verb is the one the chat indicator is already rotating — both read the same
// clock, so they never disagree — and it stays singular for any number of agents.
// Rotating a different whimsical verb per agent would produce a sentence nobody
// can read; one verb and several names is a sentence.
//
// In relay mode the ones still to come are named too. A counsel asked one after
// another looks identical to a stalled one otherwise: something is happening and
// only main knows there is more of it coming.
export function thinkingLine(round, phrase, fallbackName = 'The agent') {
  const verb = phrase || 'thinking';
  if (!round || !round.open) return `${fallbackName} is ${verb}`;
  const nameOf = (id) => round.asked.find((a) => a.agentId === id)?.name || 'an agent';
  const running = (round.running || []).map(nameOf);
  // A discussion says which turn it is on as well as who is speaking. Two agents
  // replying to each other look exactly like one agent being slow otherwise —
  // the count is the only thing on screen that says this is going somewhere and
  // roughly how much of it is left.
  if (round.mode === 'dialogue' && running.length) {
    return `${running[0]} is ${verb} · turn ${round.turn} of ${round.cap}`;
  }
  if (running.length === 0) return `${fallbackName} is ${verb}`;
  const head = running.length === 1 ? `${running[0]} is ${verb}` : `${counselNames(running)} are ${verb}`;
  const next = (round.next || []).map((a) => a.name);
  if (next.length === 0) return head;
  return `${head} · ${counselNames(next)} to follow`;
}

// The line under an agent's name in the picker.
//
// An agent that cannot take a question right now is still worth ticking — a
// counsel is a standing choice about who to ask, and it should survive somebody
// switching a machine off overnight — so this says what will happen rather than
// taking the row away. The reasons are main's, carried on the roster it publishes
// (see askable() in sessions/index.js); only the wording is decided here, because
// only here is it read by somebody choosing rather than by somebody waiting.
export function agentNote(agent) {
  if (!agent) return null;
  if (agent.ready === false) {
    switch (agent.reason) {
      case 'busy':
        return 'busy with something else — will be skipped';
      case 'held':
        return 'still reading an earlier question — will be skipped';
      default:
        return 'switched off — will be skipped';
    }
  }
  return agent.remote ? `shared by ${agent.viaName || 'a peer'}` : null;
}

// What came back, once it all has. Not a message — nothing is written down — but
// the thing a reader wants after three agents have answered is to know that all
// three did, and a round that ends with two answers and a silence should say so.
export function roundSummary(round) {
  if (!round || round.open) return '';
  // A discussion has its own ending, worked out by the thing that ended it and
  // sent down with the round. Counting answers here instead would say "4
  // answered" about a conversation, which is true and tells nobody why it
  // stopped — the one thing somebody watching it wants to know.
  if (round.mode === 'dialogue' && round.endedNotice) return round.endedNotice;
  const answered = (round.answered || []).length;
  const quiet = (round.empty || []).length;
  const failed = (round.failed || []).length;
  if (answered === 0 && quiet === 0 && failed === 0) return '';
  const parts = [];
  if (answered) parts.push(`${answered} answered`);
  if (quiet) parts.push(`${quiet} had nothing to say`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}
