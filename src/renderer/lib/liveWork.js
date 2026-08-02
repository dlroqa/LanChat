// Everything an agent on this machine is doing right now, wherever it was
// started from.
//
// The Task Bar shows tasks you set up in it. But an agent is asked from four
// places in this window — a task, a session, its own conversation, and a peer
// putting a question to one you share — and a panel that listed only the first
// would say "nothing running" with three agents mid-sentence. So the view leads
// with all of it.
//
// Derived here rather than pushed from main, and the distinction matters,
// because this codebase has a standing rule against reassembling main's
// bookkeeping in the window. This is not that. Every input below is a decision
// main has already made and published:
//
//   tasks    — the record, on `tasks`
//   rounds   — who a session is still waiting on, computed in main and pushed
//              on `session-round`
//   typing   — the bracket deliver() puts around every run, on `typing`
//
// Nothing here counts, infers or remembers: the three are read and put in one
// order. A second implementation of the bookkeeping would drift; reading what
// main already decided cannot.
//
// `typing` rather than `agentStatus` on purpose. A status arrives only if the
// transport chooses to report one, while the typing bracket is emitted by
// deliver() at the start and the end of every run whatever asked for it — which
// makes it the most reliable "a run is under way" signal in the app.
//
// Pure and dependency-free, like taskViews.js — the suite loads it directly
// with the `export` keywords stripped.

// A peer's question to one of our agents gets a thread of its own, named
// `agent:<uuid>#<peerId>` (see delegateIdFor in main's agents/registry.js).
const DELEGATE = '#';

// The order things are listed in, and why: your own tasks first, because this
// is their panel; then the sessions you asked; then an agent answering you
// directly; and last a question somebody else put to an agent of yours — work
// happening on this machine that you did not start, and the thing you are
// least likely to be waiting on.
const ORDER = ['task', 'session', 'agent', 'peer'];

export function liveWork({
  tasks = [],
  sessions = [],
  rounds = {},
  typing = {},
  peers = [],
  agents = [],
} = {}) {
  const out = [];
  const seen = new Set();

  // First writer wins. The same run can show up twice — a task is also a thread
  // that is typing, a session likewise — and the earlier loop is the one with
  // the better name for it.
  const add = (item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };

  // Agents are in two lists for two reasons: `agents` is who can be asked,
  // including ones a peer shared, and `peers` is the roster, where a local
  // agent appears as a contact. Either will do for a name.
  const agentName = (id) => {
    const askable = agents.find((a) => a.id === id);
    if (askable) return askable.name || null;
    const contact = peers.find((p) => p.id === id && p.kind === 'agent');
    return contact ? contact.name || null : null;
  };
  const peerName = (id) => {
    const found = peers.find((p) => p.id === id);
    return found ? found.name || found.hostname || null : null;
  };

  // Tasks, straight off the record main pushed.
  for (const task of tasks) {
    if (task.status !== 'working') continue;
    add({
      kind: 'task',
      id: task.id,
      title: task.title,
      who: agentName(task.agentId) || 'an agent',
      // The one of these that has an honest clock on it: a task records when
      // its run began. Nothing else published here carries a start time, so
      // nothing else claims one.
      startedAt: task.lastRunAt || 0,
    });
  }

  // Sessions with a question still out. `running` is main's list of who has not
  // answered yet, and `asked` is who was put the question — both read rather
  // than recounted.
  for (const session of sessions) {
    const round = rounds[session.id];
    if (!round || !round.open) continue;
    const waiting = round.running || [];
    if (waiting.length === 0) continue;
    add({
      kind: 'session',
      id: session.id,
      title: session.title,
      // A session waiting on two of three agents names those two.
      who: waiting
        .map((id) => {
          const asked = (round.asked || []).find((a) => a.agentId === id);
          return (asked && asked.name) || agentName(id) || 'an agent';
        })
        .join(', '),
      startedAt: 0,
    });
  }

  // The rest of it: an agent mid-answer in a conversation of its own, or in the
  // thread a peer's question was filed under.
  for (const [threadId, isTyping] of Object.entries(typing)) {
    if (!isTyping || seen.has(threadId)) continue;
    // A person typing at us is not work. Only agent-shaped threads count here,
    // and everything else in this map is somebody at a keyboard.
    const own = agentName(threadId);
    if (own) {
      add({ kind: 'agent', id: threadId, title: own, who: own, startedAt: 0 });
      continue;
    }
    const at = threadId.indexOf(DELEGATE);
    if (at <= 0) continue;
    const delegated = agentName(threadId.slice(0, at));
    if (!delegated) continue;
    const asker = peerName(threadId.slice(at + 1));
    add({
      kind: 'peer',
      id: threadId,
      title: delegated,
      who: asker ? `asked by ${asker}` : 'asked by a peer',
      startedAt: 0,
    });
  }

  // By kind, then oldest first within a kind — the one that has been going
  // longest is the one worth looking at. Ties keep the order they arrived in,
  // which for tasks is the order main published them.
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.startedAt - b.startedAt);
}
