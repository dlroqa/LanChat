// Where a session stands, as one value.
//
// The session panel needs this in three places at once — the word typed into the
// status row, the word in the Status box, and the tone that tints both — and
// deriving it three times is exactly how those three drift apart and start
// contradicting each other. Derive it once here instead, the same way
// turnStanding.js does for an agent's place in a queue.
//
// A session is not a peer and not an agent: it is a local workspace with a
// conversation in it and an agent it asks. So there is no presence to report and
// no queue to stand in — only whether the agent is working on something for this
// session, and whether there is an agent at all.
//
// Pure and DOM-free on purpose: the busy flag and the working phrase are worked
// out in the component and handed in, so this stays a plain function.

// Tones are the ones the panel already knows how to draw (agent-tone-* in
// styles.css), so a session borrows the agent's vocabulary rather than inventing
// a second one that has to be kept in step with it.
const STANDINGS = {
  unbound: { word: 'Add agent', tone: 'off' },
  forking: { word: 'Forking', tone: 'busy' },
  listening: { word: 'Listening', tone: 'ready' },
};

// How many agents this session can actually put a question to.
//
// `agentNames` is the resolved counsel — the ones that exist right now, not the
// ids the record holds — so an agent that has been removed or a peer who stopped
// sharing one is already out of it. `agentName` is the one-agent case kept for
// everything that was written before a session could ask more than one.
function counselSize(peer) {
  if (Array.isArray(peer.agentNames)) return peer.agentNames.length;
  return peer.agentName ? 1 : 0;
}

// Who this session asks, said the way a person would.
function counselWho(peer) {
  const list = Array.isArray(peer.agentNames) ? peer.agentNames : peer.agentName ? [peer.agentName] : [];
  if (list.length === 0) return 'nobody';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} agents`;
}

export function sessionStanding(peer, busy, phrase) {
  if (!peer) return null;

  // A session is normally bound to at least one agent — one is chosen for it the
  // moment it is created when there is only one to choose. Unbound means nobody
  // has picked yet, or everybody it was pointed at has gone, or it is set to ask
  // whoever is available and nobody is: all of them come down to the same thing,
  // that nothing here can answer. Saying "Listening" would be a lie, and it is the
  // one state with something to do about it, so it says that instead.
  if (!counselSize(peer)) return { key: 'unbound', label: STANDINGS.unbound.word, ...STANDINGS.unbound };

  // Working. The row shows the phrase the chat indicator is showing at this
  // instant — both read the same clock, so they never disagree — while the box
  // beside it names what the work *is*, which does not change every 2.6 seconds.
  if (busy) return { key: 'forking', label: phrase || STANDINGS.forking.word, ...STANDINGS.forking };

  // Idle, with an agent on the other end of it. Nothing is being asked and the
  // session is ready to be asked something.
  return { key: 'listening', label: STANDINGS.listening.word, ...STANDINGS.listening };
}

// The same standing spelled out, for the tooltip and for screen readers. Colour
// carries the state at a glance in the panel; it must not be the only thing that
// carries it.
export function sessionStandingLabel(peer, busy) {
  const standing = sessionStanding(peer, busy);
  if (!standing) return '';
  switch (standing.key) {
    case 'unbound':
      return 'No agent yet — choose one in the header above the conversation and this session can start asking';
    case 'forking': {
      const many = counselSize(peer) > 1;
      return `Forking — ${counselWho(peer)} ${many ? 'are' : 'is'} working on the last question asked here`;
    }
    default: {
      const many = counselSize(peer) > 1;
      const them = many ? 'them' : 'it';
      return `Listening — ${counselWho(peer)} ${many ? 'are' : 'is'} free, and this session is ready to ask ${them} something`;
    }
  }
}

// How many questions have been committed to this session: the ones you asked, and
// only those.
//
// A reply is not a commit, and neither is a line that arrived with an imported
// transcript — that conversation was had somewhere else, and counting it would
// make a freshly loaded session open on a number nobody in it had earned. A
// refused send is shown and then taken away (App.jsx), so counting it would tick
// the box up and back down again for something that was never asked.
//
// Nor is a question that failed. It was asked, and it is still in the thread to
// be read and re-sent, but nothing came back from it — an ACP timeout is not
// work the session got out of the agent, and counting it would have the box
// claim two answers where there was one. The mark comes from main, which knows
// which question a failed run was answering; it is on disk, so a session
// re-opened tomorrow opens on the same number it closed on.
export function commitCount(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m || m.direction !== 'out') continue;
    if (m.kind && m.kind !== 'text') continue;
    if (m.imported || m.rejected || m.notice || m.failed) continue;
    n += 1;
  }
  return n;
}
