'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const {
  AgentRegistry,
  isAgentId,
  delegateIdFor,
  isDelegateId,
  parseDelegateId,
  KINDS,
} = require('./registry');
const { createVirtualSocket } = require('./virtualSocket');
const { createHttpTransport } = require('./transports/http');
const { discoverProfiles, hermesLaunchArgs } = require('./profiles');
const { createCommandTransport } = require('./transports/command');
const { createAcpTransport } = require('./transports/acp');
const { createSshTransport } = require('./transports/ssh');
const { heldLine, rotatedLine, busyLine } = require('./turnCopy');
const { resolveMedia } = require('../media');

// AgentHub owns the lifecycle of connected agents.
//
// An agent is registered with PeerHub behind a virtual socket, so from the rest
// of the app's point of view it is simply another peer: it appears in the roster,
// gets a presence dot, has persisted history, and receives chat through the
// ordinary hub.send() path. Nothing in peers.js, store.js or the chat UI needed
// to change to accommodate it.
//
// Three states, deliberately distinct:
//   removed          no record at all
//   added, disabled  configured and visible in the roster, but dormant and
//                    hard-gated: no transport running, all routing refused
//   added, enabled   transport running, socket open, reachable
//
// Reach: an agent is local-first. Remote peers can only address it if they are on
// that agent's allowlist AND they address it explicitly. Approvals are never
// delegated to the LAN — only the local user can authorise a tool call.

// Marks a 'peer-message' as having been produced locally by an agent rather than
// received from the network. A Symbol is used deliberately: inbound frames are
// built by JSON.parse, which can never produce one, so a remote host cannot forge
// this marker to impersonate a local agent no matter what it puts on the wire.
const LOCAL_ORIGIN = Symbol('lanchat.agent.localOrigin');

const TRANSPORTS = {
  http: createHttpTransport,
  command: createCommandTransport,
  acp: createAcpTransport,
  ssh: createSshTransport,
};

// Per-peer throttle. The agent runs one job at a time, and a busy refusal is
// itself a reply — so without this a single peer can both monopolise the agent
// and amplify each of its own messages into an outbound frame. Applies only to
// remote origins; the machine's owner is never throttled.
const PEER_MIN_INTERVAL_MS = 3000;
const PEER_MAX_BUSY_REFUSALS = 3;
const PEER_THROTTLE_TTL_MS = 60000;

// Fair-share turn taking for a shared agent. One peer holds the turn and gets a
// fixed number of queries; when they run out and somebody is waiting, the turn
// passes and they rejoin the back of the queue.
//
// This distributes whatever capacity the agent has — it does not create more of
// it. An upstream provider's own rate limit still surfaces as a failed run.
//
// A holder who stops mid-turn must not block everyone, so an idle turn is
// released once someone else is waiting. With nobody waiting there is nothing to
// be fair about, so a lone peer is simply granted a fresh turn.
//
// A turn is passed on, never taken away: whoever had it rejoins the back of the
// queue whether or not they used it, so nobody loses a place they waited for.
// What that costs is chatter — two peers who are both away would otherwise be
// told about a turn neither wants, once a minute, forever — so a peer who lets a
// whole turn lapse stops being *told* about the next one. They keep the place;
// asking anything makes them audible again.
//
// Standing in line should not mean watching it. The first question asked out of
// turn is kept and read the moment the turn arrives, and it does not spend a
// query — the waiting is what it cost. Only one is kept per peer: a second
// question while the first is still held is the same question asked twice into a
// queue that has not moved, and it is refused.
const TURN_QUOTA = 5;
const TURN_IDLE_MS = 60000;
// Losing a turn should never be a surprise, so the holder is told before it
// happens and given time to act on the warning.
const TURN_WARN_MS = 40000;
const TURN_SWEEP_MS = 5000;

// `transports` is injectable so tests can drive the lifecycle with a stub that
// never touches the network; production always uses the real table above.
function createAgentHub({ userDataDir, hub, bus, store, safeStorage, transports = TRANSPORTS }) {
  const registry = new AgentRegistry(userDataDir, { safeStorage });
  const live = new Map(); // agentId -> { transport, socket, busy, pendingApproval }
  const throttle = new Map(); // `${agentId}|${peerId}|${scope}` -> { last, refusals, expires }

  // May this peer reach this agent at all? Network-wide is a widening of the
  // allowlist, never a replacement: switching it off restores whatever the
  // allowlist already said, because the allowlist is never cleared.
  function peerMayReach(record, peerId) {
    if (!record || record.enabled === false || !peerId) return false;
    if (record.networkWide === true) return true;
    return (record.allowedPeers || []).includes(peerId);
  }

  // The three gates every route in from the LAN shares, in the order they matter:
  // the toggle is a hard gate, reach is a grant, and an agent that is not running
  // cannot answer whatever the other two say.
  //
  // Written once because each route used to apply them by hand, and a route that
  // checked two of the three would not read as a bug — it would read as one of
  // these lines being missing, which is exactly how it would get missed.
  function reachable(record, peerId) {
    if (!record || record.enabled === false) return false;
    if (!peerMayReach(record, peerId)) return false;
    return live.has(record.id);
  }

  // ---- fair-share turns ----

  // agentId -> { holder, used, queue: [peerId], last, warned, quiet, held }
  //
  // `quiet` holds peers who were handed a turn and let it lapse without asking
  // anything. It decides only whether to *speak* to them, never whether they get
  // a turn — their place in the queue is untouched.
  //
  // `held` is peerId -> { text, ts }: the one question each waiting peer asked
  // before their turn came, kept to be read when it does. A Map keyed by peer is
  // what makes "only the first one" true by construction rather than by counting.
  const turns = new Map();

  function turnState(agentId) {
    if (!turns.has(agentId)) {
      turns.set(agentId, {
        holder: null,
        used: 0,
        queue: [],
        last: 0,
        warned: false,
        quiet: new Set(),
        held: new Map(),
      });
    }
    return turns.get(agentId);
  }

  function passTurn(state) {
    state.holder = state.queue.shift() || null;
    state.used = 0;
    state.last = Date.now();
    state.warned = false;
  }

  // Decides whether `peerId` may spend a query now. Never called for the local
  // user — the machine's owner does not queue for their own agent.
  //
  // `yielded` names the peer whose idle turn this claim took over, if any. It is
  // reported rather than acted on here so this stays a state transition and all
  // the outbound copy keeps living in `accept`.
  function claimTurn(agentId, peerId) {
    const state = turnState(agentId);
    const now = Date.now();

    // A holder who has gone quiet yields, so one peer asking a single question
    // and wandering off cannot freeze the queue. Whoever asks next takes over:
    // passTurn promotes the head of the queue, or clears the holder so the
    // caller claims it below.
    //
    // The outgoing holder rejoins the back, exactly as the sweep requeues one.
    // Without it they are neither the holder nor in the queue, so publishStanding
    // — which only addresses participants — has nobody to correct, and their card
    // sits there claiming a turn that has moved on. This is the path taken when
    // nobody was waiting to trigger the sweep in the first place.
    let yielded = null;
    if (state.holder && state.holder !== peerId && now - state.last > TURN_IDLE_MS) {
      yielded = state.holder;
      // Handed a turn they never spent anything on: they keep their place, they
      // just stop being told about the next one. Same rule as the sweep.
      if (state.used === 0) state.quiet.add(yielded);
      passTurn(state);
      if (!state.queue.includes(yielded)) state.queue.push(yielded);
    }

    if (!state.holder) {
      state.holder = peerId;
      state.used = 0;
    }

    if (state.holder === peerId) {
      if (state.used >= TURN_QUOTA) {
        if (state.queue.length) {
          // Out of turn with others waiting: hand over and rejoin the back.
          passTurn(state);
          if (!state.queue.includes(peerId)) state.queue.push(peerId);
          return { ok: false, rotated: true, yielded };
        }
        state.used = 0; // nobody waiting, so nothing to be fair about
      }
      state.used += 1;
      state.last = now;
      state.warned = false; // they are active again, so the countdown resets
      state.quiet.delete(peerId); // and worth talking to again
      return { ok: true, rotated: false, yielded };
    }

    if (!state.queue.includes(peerId)) state.queue.push(peerId);
    return { ok: false, rotated: false, yielded };
  }

  // Where a peer stands, in the shape the roster renders.
  function standingFor(agentId, peerId) {
    const state = turnState(agentId);
    // Seconds until an idle turn is handed on, or 0 when it is not going
    // anywhere. Sent as a duration rather than a deadline so the two machines
    // count down together without their clocks having to agree.
    const idle = Date.now() - state.last;
    const handoverIn =
      state.holder && state.queue.length > 0 && idle > TURN_WARN_MS
        ? Math.max(1, Math.round((TURN_IDLE_MS - idle) / 1000))
        : 0;

    // Whether a question of theirs is waiting to be read. Carried on the standing
    // rather than announced separately so the asking machine learns it through
    // the frame it already handles, and can refuse a second attempt itself.
    const held = state.held.has(peerId);

    if (state.holder === peerId) {
      return {
        state: 'active',
        position: 0,
        remaining: Math.max(0, TURN_QUOTA - state.used),
        quota: TURN_QUOTA,
        ahead: 0,
        expiring: handoverIn > 0,
        expiresInSec: handoverIn,
        held,
      };
    }
    // Same shape either way, so every consumer can read the fields without
    // guarding on which branch produced them.
    const at = state.queue.indexOf(peerId);
    return {
      state: at === -1 ? 'idle' : 'waiting',
      position: at === -1 ? 0 : at + 1,
      remaining: TURN_QUOTA,
      quota: TURN_QUOTA,
      // How much stands between them and the agent. An exact countdown only
      // exists once the holder goes idle, but this moves in real time as the
      // holder spends queries, so waiting is never an unmeasured silence.
      ahead: at === -1 ? 0 : Math.max(0, TURN_QUOTA - state.used) + at * TURN_QUOTA,
      // Only whoever is actually next inherits the turn, so only they get the
      // same countdown — and it is the same number the holder sees, so the two
      // sides agree on when the handover happens.
      expiring: at === 0 && handoverIn > 0,
      expiresInSec: at === 0 ? handoverIn : 0,
      held,
    };
  }

  // Everyone with a stake in this agent's queue right now.
  function participants(agentId) {
    const state = turnState(agentId);
    return [...(state.holder ? [state.holder] : []), ...state.queue];
  }

  // Hands the turn to the next peer waiting and tells them so. `requeue` puts the
  // outgoing holder at the back rather than dropping them from the queue.
  function handOver(record, { requeue }) {
    const state = turnState(record.id);
    const previous = state.holder;
    passTurn(state);
    if (requeue && previous && !state.queue.includes(previous)) state.queue.push(previous);
    publishStanding(record);
    // Their standing has already gone out either way — the roster card, the
    // position and the countdown are all still accurate for a silenced peer. Only
    // the chat line is withheld, because they have shown they are not reading it.
    if (state.holder && !state.quiet.has(state.holder)) {
      reply(record.id, `Your turn — you have ${TURN_QUOTA} queries.`, state.holder);
    }
    flushHeld(record);
  }

  // Reads the question the new holder asked while they were still in line.
  //
  // It costs them nothing: the waiting is what it cost, and charging for it would
  // mean the person who queued with a question ready is worse off than the person
  // who queued with nothing. `used` is deliberately untouched, so their turn still
  // reads 5/5 afterwards.
  //
  // Held rather than consumed when the agent is mid-run: a turn can pass while the
  // previous holder's last query is still going, and dropping the question there
  // would lose it for the one case it was kept for. The idle sweep comes back
  // every few seconds and tries again.
  function flushHeld(record) {
    if (!record) return;
    const state = turnState(record.id);
    const holder = state.holder;
    if (!holder) return;
    const pending = state.held.get(holder);
    if (!pending) return;
    const entry = live.get(record.id);
    if (!entry || entry.busy) return;

    state.held.delete(holder);
    // Their turn starts being used now rather than at the handover, so the idle
    // countdown does not run against them while the agent answers.
    state.last = Date.now();
    // They did ask for this, so they are worth talking to again.
    state.quiet.delete(holder);
    // The card says a question is held; it no longer is.
    publishStanding(record);
    deliver(record.id, pending.text, holder);
  }

  // Called when a run finishes: if the holder has spent their turn and somebody
  // is waiting, pass it on now rather than making the next peer discover it by
  // asking again.
  function releaseIfSpent(agentId) {
    const state = turnState(agentId);
    const record = registry.get(agentId);
    if (!record || !state.holder || state.used < TURN_QUOTA || !state.queue.length) return;
    handOver(record, { requeue: true });
  }

  // A holder who stops using the agent should not keep the queue waiting just
  // because they have queries left. Sweeping for this rather than only checking
  // when the next peer happens to ask is what lets the person next in line be
  // *told* their turn has come, instead of having to keep trying.
  function releaseIdleTurns() {
    const now = Date.now();
    for (const [agentId, state] of turns) {
      // A peer who has gone offline should not hold a place in the queue, and
      // certainly not the turn — otherwise everyone else waits out the idle
      // timeout for somebody who has closed the app.
      const record = registry.get(agentId);
      if (!record) continue;

      const before = state.queue.length;
      state.queue = state.queue.filter((id) => hub.isConnected(id));
      // Nothing left to stay quiet about once they are gone, and the set must not
      // grow without bound over a long session.
      for (const id of state.quiet) if (!hub.isConnected(id)) state.quiet.delete(id);
      // A question is held against a place in line, and the filter above has just
      // taken that place away. Keeping it would mean answering, out of nowhere,
      // something asked in a session that has since ended.
      for (const id of state.held.keys()) if (!hub.isConnected(id)) state.held.delete(id);
      // The turn may have arrived while the agent was still answering somebody
      // else, in which case the held question is still sitting there.
      flushHeld(record);
      if (state.holder && !hub.isConnected(state.holder)) {
        // Gone for good as far as this turn is concerned, so not requeued.
        handOver(record, { requeue: false });
        continue;
      }
      if (state.queue.length !== before) publishStanding(record);

      // With nobody waiting there is no one to be fair to, so an idle holder is
      // left alone rather than warned about a handover that will not happen.
      if (!state.holder || !state.queue.length) continue;
      const idle = now - state.last;

      if (idle > TURN_IDLE_MS) {
        // Everybody keeps their place — losing a turn you were handed while away
        // must never cost you the one you queued for. A peer who sat out a whole
        // turn simply stops being told about the next one, so two idle peers
        // circulate it in silence rather than messaging each other every minute.
        if (state.used === 0 && state.holder) state.quiet.add(state.holder);
        handOver(record, { requeue: true });
        continue;
      }

      if (idle > TURN_WARN_MS) {
        // One *message* per turn, so a long pause does not become a stream of
        // nags — but the standing is re-sent on every sweep while the clock is
        // running. That keeps the holder losing the turn and the peer gaining it
        // ticking to the same deadline, and lets either recover if a frame was
        // dropped or their app started mid-countdown.
        if (!state.warned) {
          state.warned = true;
          // Warning somebody who already let a turn go by is telling them a
          // second time what they did not act on the first. The countdown below
          // still goes out, so it is visible if they do come back.
          if (!state.quiet.has(state.holder)) {
            const seconds = Math.max(1, Math.round((TURN_IDLE_MS - idle) / 1000));
            const waiting = state.queue.length;
            reply(
              agentId,
              `You have been idle — your turn passes to the next person in about ${seconds}s ` +
                `(${waiting} waiting). Ask something to keep it.`,
              state.holder
            );
          }
        }
        publishStanding(record);
      }
    }
  }

  // Unref'd so a background sweep never keeps the process alive on its own.
  const idleSweep = setInterval(releaseIdleTurns, TURN_SWEEP_MS);
  if (idleSweep.unref) idleSweep.unref();

  // Standing is pushed, not polled: a waiting peer needs to be told the moment
  // their turn arrives, and presence never crosses the wire.
  function publishStanding(record) {
    for (const peerId of participants(record.id)) {
      const standing = standingFor(record.id, peerId);
      hub.send(peerId, { type: 'agent-queue', agentId: record.id, ...standing });
      const threadId = delegateIdFor(record.id, peerId);
      if (hub.identities.has(threadId)) {
        hub.setIdentity(threadId, {
          queueState: standing.state,
          queuePosition: standing.position,
          queueRemaining: standing.remaining,
          queueQuota: standing.quota,
          queueAhead: standing.ahead || 0,
          queueExpiring: standing.expiring === true,
          queueExpiresInSec: standing.expiresInSec || 0,
          queueHeld: standing.held === true,
        });
      }
    }
  }

  // Returns 'ok' | 'silent' — 'silent' means drop without replying, which is
  // what stops a looping peer turning each of its messages into a frame back.
  // `scope` keeps summons from being throttled against questions. Saying hello
  // costs one frame and invites a question right after it, so sharing a key meant
  // the invitation swallowed the reply to it — silently, which is the worst way to
  // lose a message. Each scope keeps its own one-per-PEER_MIN_INTERVAL_MS ceiling,
  // and that ceiling is the flood gate; splitting the key does not widen it.
  function checkThrottle(agentId, peerId, busy, scope = 'ask') {
    const key = `${agentId}|${peerId}|${scope}`;
    const now = Date.now();
    for (const [k, v] of throttle) if (v.expires <= now) throttle.delete(k);
    const entry = throttle.get(key) || { last: 0, refusals: 0, expires: 0 };
    entry.expires = now + PEER_THROTTLE_TTL_MS;
    throttle.set(key, entry);
    if (now - entry.last < PEER_MIN_INTERVAL_MS) return 'silent';
    if (busy) {
      entry.refusals += 1;
      return entry.refusals > PEER_MAX_BUSY_REFUSALS ? 'silent' : 'ok';
    }
    entry.refusals = 0;
    entry.last = now;
    return 'ok';
  }

  function identityFor(record) {
    return {
      id: record.id,
      name: record.name,
      kind: 'agent',
      agentKind: record.kind,
      hostname: record.kind === 'ssh' ? record.config.host : 'local',
      avatar: { color: '#7c3aed', image: null },
    };
  }

  // The roster card for one peer's conversation with a local agent. Created
  // lazily on first use, so a delegate thread only exists once somebody has
  // actually asked something. It is a transcript, not a chat the owner types
  // into, so no socket is registered and it renders as an inactive contact.
  function ensureDelegateIdentity(record, peerId) {
    const id = delegateIdFor(record.id, peerId);
    if (hub.identities.has(id)) return id;
    const peer = hub.presenceList().find((p) => p.id === peerId);
    hub.setIdentity(id, {
      id,
      name: record.name,
      kind: 'agent',
      agentKind: record.kind,
      delegate: true,
      viaId: peerId,
      viaName: (peer && (peer.name || peer.hostname)) || 'a peer',
      hostname: 'local',
      avatar: { color: '#7c3aed', image: null },
    });
    return id;
  }

  function emitStatus(agentId, status, detail) {
    bus.emit('agent-status', { agentId, status, detail: detail || null });
  }

  function buildTransport(record) {
    const factory = transports[record.kind];
    if (!factory) throw new Error(`Unknown agent transport: ${record.kind}`);
    const config = record.config || {};
    return factory({
      id: record.id,
      name: record.name,
      // A Hermes profile is chosen with a launch flag, so it has to become argv
      // before the transport sees it. Translating here keeps the ACP transport
      // a generic ACP client: it knows a protocol, not a vendor.
      config: record.kind === 'acp' ? { ...config, args: hermesLaunchArgs(config) } : config,
      timeoutMs: config.timeoutMs,
      getSecret: () => registry.secretFor(record.id),
    });
  }

  // Tells a remote asker what the agent is doing right now. Local-only work
  // needs no relay — the renderer already sees the bus events directly.
  function relayActivity(agentId, origin, busy, detail) {
    if (!origin) return;
    hub.send(origin, { type: 'agent-activity', agentId, busy, detail: detail || null });
  }

  // ---- inbound: a message addressed to the agent ----

  // `origin` is null for the local user, or the peer id when relayed from the LAN.
  //
  // `thread` is where the answer is to be filed when that is not the thread the
  // addressing already implies — a session, which is a local workspace that asks
  // this agent and keeps its own conversation. Worked out once here and carried
  // to every place that reports back, rather than derived again at each of them.
  //
  // `ref` is the id of the message this run is answering. It exists for one
  // purpose: when a run fails, the question that failed has to be identifiable,
  // so it can stop counting as work done. Carried explicitly rather than
  // reconstructed as "the last thing asked" — that would be true today, because
  // only one question is ever outstanding, and silently wrong the moment that
  // stops being true.
  async function deliver(agentId, text, origin = null, { thread = null, ref = null } = {}) {
    const entry = live.get(agentId);
    const record = registry.get(agentId);
    if (!record || !entry) return;

    const threadId = thread || (origin ? delegateIdFor(agentId, origin) : agentId);

    if (entry.busy) {
      reply(agentId, 'I am still working on the previous message — one at a time, please.', origin, {
        threadId,
      });
      return;
    }
    entry.busy = true;
    // Live feedback — thinking and streamed words — is addressed to the thread a
    // reader is actually looking at. A session gets its own; everything else
    // keeps going out under the agent's id, exactly as it always has, so a
    // delegate thread's indicator does not move house on the strength of this.
    const liveId = thread || agentId;
    bus.emit('agent-typing', { agentId, threadId: liveId, isTyping: true });
    // A peer asking from another machine has no view of the agent at all, so
    // working state is relayed to them. Without it their end can only show
    // "online" and a silence, with no way to tell thinking from stuck.
    relayActivity(agentId, origin, true, null);

    let streamed = '';
    await entry.transport.send(
      { text },
      {
        onDelta: (delta) => {
          streamed += delta;
          bus.emit('agent-delta', { agentId, threadId: liveId, delta });
        },
        onStatus: (status) => {
          emitStatus(agentId, status ? 'working' : 'ready', status);
          relayActivity(agentId, origin, true, status || null);
        },
        onApproval: (req) => {
          // Surfaced to the local user only. A remote peer may have asked the
          // question, but only the machine's owner can authorise the answer.
          entry.pendingApproval = req;
          bus.emit('agent-approval', { agentId, ...req });
        },
        onDone: ({ text: output }) => {
          entry.busy = false;
          entry.pendingApproval = null;
          bus.emit('agent-typing', { agentId, threadId: liveId, isTyping: false });
          relayActivity(agentId, origin, false, null);
          // A run can finish with genuinely nothing in it: a CLI exiting 0 with an
          // empty stdout, or an ACP session stopping for a normal reason having
          // said nothing (see transports/spawn.js and describeStop in
          // transports/acp.js). Both are real outcomes rather than faults.
          //
          // This used to be written down as the words "(no output)", which read as
          // an error report and left one in the transcript forever. There is
          // nothing to keep here — the question is already in the thread, and the
          // answer to "what came back?" is "nothing". So it is signalled instead:
          // shown once, in the space where the answer would have been, and then
          // gone. Nothing stored, no unread, no notification sound.
          const text = output || streamed;
          if (text) reply(agentId, text, origin, { keep: true, threadId });
          else signalEmptyRun(agentId, origin, threadId);
          // Hand over as soon as the last query of a turn finishes, so whoever
          // is next is told immediately rather than on their next attempt.
          if (origin) releaseIfSpent(agentId);
        },
        onError: (err) => {
          entry.busy = false;
          entry.pendingApproval = null;
          bus.emit('agent-typing', { agentId, threadId: liveId, isTyping: false });
          relayActivity(agentId, origin, false, null);
          emitStatus(agentId, 'error', describeError(err));
          // Shown, then taken away — like a notice, and for the same reason.
          //
          // This used to be kept, on the grounds that a question with no reply
          // beside it hides what happened. That was right about the moment and
          // wrong about the week after: a timeout is worth reading once, and
          // then it is a permanent line of noise in the context of every
          // question asked below it. So it is reported and swept, and what it
          // leaves behind is on the question instead — `failedRef` names the
          // message this run was answering, which is how a failed ask stops
          // counting as one.
          //
          // Only `err.message` is relayed onward — `err.detail` names things
          // that exist on this machine and stays here. See transports/resolve.js.
          reply(agentId, `⚠️ ${err.message}`, origin, { error: true, ref, detail: err.detail, threadId });
        },
      }
    );
  }

  // Agent output re-enters the app through the same bus event as peer traffic, so
  // it is stored and rendered by the existing ipc.js router with no special case.
  //
  // An agent thread keeps two things: what was asked, and what came back from
  // the run — the output, or the error explaining why there was none. Everything
  // else this function sends is the machinery around that: whose turn it is,
  // where you are in the queue, that the agent is still busy. Those are true for
  // the moment they arrive and worthless a minute later, so they are shown and
  // then dropped rather than written down.
  //
  // Which is why `keep` is opt-in and no notice has to be marked as one: a notice
  // added here in future is transient because that is the default, not because
  // somebody remembered to say so. Only the two calls carrying a result ask to be
  // kept, and they say so at the point where that is obvious.
  // The full text for the owner of this machine: the peer-safe message plus
  // whatever local detail came with it. Never sent anywhere.
  function describeError(err) {
    return err && err.detail ? `${err.message} ${err.detail}` : err && err.message;
  }

  // `error` marks the one kind of transient message that is not just scheduling
  // chatter: a run that failed. It is not kept, exactly like a notice — but the
  // window treats it differently (a countdown, and then it goes), and it carries
  // `failedRef` so the question it failed can stop counting. `keep` and `error`
  // are opposite ends of the same axis, so an error is never also kept.
  function reply(
    agentId,
    text,
    origin,
    { keep = false, error = false, ref = null, detail = null, threadId: into = null } = {}
  ) {
    // A peer's conversation with the agent belongs in its own thread, not in the
    // human chat with that peer — otherwise asking an agent something graffitis
    // two real conversations. The owner still sees everything, just filed under
    // "Agent · via <peer>" instead of smeared through their chat with them.
    //
    // `into` is deliver()'s answer to the same question, worked out once at the
    // top of the run; the expression below is what it falls back to for a caller
    // that has no run behind it.
    const threadId = into || (origin ? delegateIdFor(agentId, origin) : agentId);
    // The pictures this reply is talking about.
    //
    // This is the one place an agent's output becomes a message, so it is the
    // one place that has to ask. A bare `MEDIA:` line is how an agent announces
    // what it made — machinery rather than words — so it comes out of the text
    // and the picture takes its place; a markdown link keeps its label, which is
    // something somebody wrote.
    //
    // Asked of `text` rather than of the local copy below, so the stripping
    // happens once and both copies are built from a message that has already
    // had its markers taken out. A peer reading a `MEDIA:` line naming a folder
    // on this machine learns the shape of a filesystem they cannot reach and
    // gains nothing they could use.
    //
    // Allowing each path is what lets the window fetch it back over the local
    // preview endpoint, and it is the narrowest thing that can be allowed: main
    // has already checked that each path is absolute, that it is a file that
    // exists, and that it is a photo, a clip or a sound (see media.js).
    const { text: said, media } = resolveMedia(text, { strip: true });
    for (const item of media) bus.emit('allow-preview', item.path);
    // `detail` is local-only, so it is folded into the copy kept here and left
    // out of the frame below. The two must never be built from one string.
    const localText = detail ? `${said} ${detail}` : said;
    const message = {
      from: threadId,
      type: 'chat',
      id: crypto.randomUUID(),
      text: localText,
      ts: Date.now(),
    };
    // The paths stay here. They name files on this machine, so there is nothing
    // for the peer's copy below to do with them but 404.
    if (media.length) message.media = media;
    // Who said it. Carried on the local frame only — the wire frame below already
    // names the agent, and a thread that is an agent needs no label because the
    // thread *is* the answer to "who".
    //
    // It matters where a thread is not an agent: a session can ask several at
    // once, and three answers arriving in one conversation with nothing to tell
    // them apart is three anonymous opinions. Set here rather than at the point
    // of storage so an error and an answer are attributed by the same line of
    // code — a failure that does not say whose it was is the case where the
    // label is needed most.
    message.agentId = agentId;
    message.agentName = nameOf(agentId);
    if (!keep) message.notice = true;
    if (error) {
      message.error = true;
      // Only when there is one. A run started by a peer's `@name` has no local
      // message to point at, and a `failedRef` of null would be a claim that
      // something identifiable failed.
      if (ref) message.failedRef = ref;
    }
    message[LOCAL_ORIGIN] = true;
    bus.emit('peer-message', message);
    // If a remote peer asked, relay the answer back to that peer alone — never
    // to everyone, and never to a peer that did not ask. `agent-reply` rather
    // than `chat` so their copy lands in its own thread too.
    if (origin) {
      // `failedRef` is deliberately not relayed: it names a message in a store on
      // this machine and would mean nothing on theirs. The flag travels, the id
      // does not — the asking machine matches the error against the question it
      // has outstanding (see `pendingRef` in remote.js).
      hub.send(origin, {
        type: 'agent-reply',
        agentId,
        name: nameOf(agentId),
        text: said,
        ts: Date.now(),
        ...(!keep && { notice: true }),
        ...(error && { error: true }),
      });
    }
  }

  // The other way a finished run reports back: it had nothing to say.
  //
  // Not a message, on purpose. Everything reply() sends is words somebody reads,
  // and there are no words for this — writing some would be inventing an event
  // ("that run finished without anything to show") out of the absence of one. So
  // it goes out as a signal the window answers with a light in the space where
  // the reply would have been, and nothing is written to disk either side.
  //
  // Both halves are addressed the same way reply() addresses its two: the local
  // thread by id, and the asking peer alone — never everyone, never a peer who
  // did not ask.
  function signalEmptyRun(agentId, origin, into = null) {
    // Named for the same reason reply() is: a session that asked three agents has
    // to know which of them came back with nothing, both to stop waiting on it
    // and to say so.
    bus.emit('agent-empty', {
      threadId: into || (origin ? delegateIdFor(agentId, origin) : agentId),
      agentId,
      agentName: nameOf(agentId),
    });
    if (origin) hub.send(origin, { type: 'agent-empty', agentId });
  }

  function nameOf(agentId) {
    return registry.get(agentId)?.name || 'agent';
  }

  // ---- start / stop / toggle ----

  async function startAgent(record) {
    if (live.has(record.id)) await stopAgent(record.id);
    const transport = buildTransport(record);
    const socket = createVirtualSocket((frame) => {
      // Frames arrive here exactly as PeerHub.send() serialised them.
      if (frame.type === 'chat' && frame.text) deliver(record.id, frame.text, null);
    });
    live.set(record.id, { transport, socket, busy: false, pendingApproval: null });
    hub.setIdentity(record.id, identityFor(record));
    emitStatus(record.id, 'connecting');
    try {
      const info = await transport.start();
      hub.register(record.id, socket); // roster dot goes green
      emitStatus(record.id, 'ready', info?.detail);
      return { ok: true, detail: info?.detail };
    } catch (err) {
      live.delete(record.id);
      // Local surfaces — the agent row and the status line — get the whole
      // story. Both stay on this machine.
      emitStatus(record.id, 'error', describeError(err));
      return { ok: false, detail: describeError(err) };
    }
  }

  async function stopAgent(agentId) {
    const entry = live.get(agentId);
    if (!entry) return;
    live.delete(agentId);
    try {
      await entry.transport.stop();
    } catch (err) {
      console.error('[agents] stop failed:', err.message);
    }
    entry.socket.close();
    hub.unregister(agentId, entry.socket); // roster dot goes grey
    emitStatus(agentId, 'off');
  }

  async function setEnabled(agentId, enabled) {
    const record = registry.update(agentId, { enabled });
    if (!record) return null;
    if (enabled) await startAgent(record);
    else {
      await stopAgent(agentId);
      // Keep the identity so a disabled agent stays visible in the roster as
      // offline, rather than silently vanishing.
      hub.setIdentity(agentId, identityFor(record));
    }
    // Disabling is a hard gate, so it must also retract the agent from every
    // peer that could see it — not just refuse them at the door.
    announce(record);
    return registry.publicList().find((a) => a.id === agentId);
  }

  // Who may reach the agent, and how discoverable it is. Both are re-advertised
  // immediately: entitlement is checked per message anyway, but the roster card
  // on the far side only moves when we tell it to.
  async function setSharing(agentId, patch) {
    const record = registry.update(agentId, {
      ...(patch.networkWide !== undefined ? { networkWide: patch.networkWide } : {}),
      ...(patch.directChat !== undefined ? { directChat: patch.directChat } : {}),
    });
    if (!record) return null;
    announce(record);
    hub.emitPresence();
    return registry.publicList().find((a) => a.id === agentId);
  }

  // ---- advertising an agent to the peers entitled to reach it ----

  // Presence never crosses the wire, so a peer only learns an agent exists — or
  // has stopped existing for them — from an explicit frame. Both directions
  // matter: without the advert a peer cannot file `@name` traffic into its own
  // thread, and without the withdrawal a revoked agent lingers in their roster.
  function advertFor(record) {
    return {
      type: 'agent-advert',
      agentId: record.id,
      name: record.name,
      agentKind: record.kind,
      directChat: record.directChat === true,
    };
  }

  // What each peer was last told about: peerId -> Set<agentId>. It is what makes
  // a withdrawal something we can be sure of rather than something we fire and
  // forget — an agent stays on this list until the peer has actually been told
  // to let go of it, so the next handshake finishes the job if the frame never
  // landed. It also keeps the retraction quiet: a peer is only ever told about
  // agents it was given, never about the ones it was not.
  const advertised = new Map();

  // What one peer should be holding for one agent right now: the card, or
  // nothing at all. Every announcement goes through here, so switching a grant
  // off travels by exactly the same path — and at the same speed — as switching
  // it on.
  function sendShare(peerId, record) {
    const held = advertised.get(peerId) || new Set();
    if (record.enabled !== false && peerMayReach(record, peerId)) {
      if (!hub.send(peerId, advertFor(record))) return;
      held.add(record.id);
      advertised.set(peerId, held);
      return;
    }
    // Nothing to take back — say nothing, rather than telling a peer about an
    // agent it was never offered.
    if (!held.has(record.id)) return;
    if (!hub.send(peerId, { type: 'agent-withdraw', agentId: record.id })) return;
    held.delete(record.id);
    if (held.size === 0) advertised.delete(peerId);
  }

  function announce(record) {
    if (!record) return;
    for (const peer of hub.presenceList()) {
      if (!peer.online || peer.kind === 'agent') continue;
      sendShare(peer.id, record);
    }
  }

  // Everything this peer should know about our agents, in one pass. Used on
  // handshake, where the withdrawals matter as much as the adverts: a peer that
  // was away — or that missed the frame — when a grant was taken back would
  // otherwise come back still holding a contact we revoked.
  function announceAllTo(peerId) {
    for (const record of registry.list()) sendShare(peerId, record);
  }

  // Unconditional retraction — used when the agent is disabled or removed, where
  // "who is still entitled" is no longer a meaningful question.
  function withdraw(record) {
    if (!record) return;
    hub.broadcast({ type: 'agent-withdraw', agentId: record.id });
    // The record is going away, so there is nothing left to re-send later; drop
    // it from the bookkeeping rather than leaving an id no peer can be told about.
    for (const [peerId, held] of advertised) {
      held.delete(record.id);
      if (held.size === 0) advertised.delete(peerId);
    }
  }

  function announceAll() {
    for (const record of registry.list()) announce(record);
  }

  // A peer that was offline when sharing changed never got the frame, so the
  // whole picture is re-sent whenever one completes a handshake.
  bus.on('peer-hello', ({ peerId }) => {
    if (!peerId) return;
    announceAllTo(peerId);
  });

  // ---- public API ----

  // The probe result is returned alongside the record rather than swallowed: a
  // saved agent and a reachable one are different things, and the caller needs
  // to be able to say so instead of reporting success for a connector that
  // never came up.
  async function add(draft) {
    const record = registry.add(draft);
    let probe = { ok: true, detail: null };
    if (record.enabled) probe = await startAgent(record);
    else hub.setIdentity(record.id, identityFor(record));
    announce(record);
    return { agent: registry.publicList().find((a) => a.id === record.id), probe };
  }

  // Edit an existing agent. Restarting a live transport is required, not
  // cosmetic: transports capture their config at construction, so a changed
  // base URL or command would otherwise be ignored until the next launch.
  async function update(agentId, patch) {
    const record = registry.update(agentId, patch);
    if (!record) return null;
    let probe = { ok: true, detail: null };
    if (record.enabled) probe = await startAgent(record);
    else {
      await stopAgent(agentId);
      // Refresh the card even while dormant — peers address the agent by name,
      // so a rename has to reach the roster either way.
      hub.setIdentity(agentId, identityFor(record));
    }
    // A rename changes how peers address it, so the advert has to be refreshed.
    announce(record);
    return { agent: registry.publicList().find((a) => a.id === agentId), probe };
  }

  // Removal must leave nothing behind — this is the "nothing permanent" contract.
  async function remove(agentId) {
    const record = registry.get(agentId);
    if (!record) return false;
    await stopAgent(agentId);
    // Retract it from every peer before the record is gone, or it lingers in
    // their rosters with nothing behind it.
    withdraw(record);
    hub.identities.delete(agentId);
    hub.addresses.delete(agentId);
    try {
      fs.rmSync(store.fileFor(agentId), { force: true });
    } catch (err) {
      console.error('[agents] history cleanup failed:', err.message);
    }
    // Each peer who used this agent has a delegate thread of their own. Missing
    // these would leave transcripts behind after a "removes everything" action.
    for (const id of [...hub.identities.keys()]) {
      const parts = parseDelegateId(id);
      if (!parts || parts.agentId !== agentId) continue;
      hub.identities.delete(id);
      try {
        fs.rmSync(store.fileFor(id), { force: true });
      } catch (err) {
        console.error('[agents] delegate history cleanup failed:', err.message);
      }
    }
    for (const key of [...throttle.keys()]) {
      if (key.startsWith(`${agentId}|`)) throttle.delete(key);
    }
    turns.delete(agentId);
    registry.remove(agentId); // drops the sealed secret with the record
    hub.emitPresence();
    return true;
  }

  // Hermes profiles offered for this agent. Read from the Hermes install on
  // this machine, so only meaningful when the agent's server is here too; the
  // API has no way to list or confirm them. See profiles.js.
  function profilesFor(agentId, draft) {
    const record = registry.get(agentId);
    const kind = record ? record.kind : draft && draft.kind;
    const config = (record ? record.config : draft && draft.config) || {};
    // ACP picks its profile by command rather than by URL, so both are offered
    // and discoverProfiles decides which one applies.
    return discoverProfiles({ kind, baseUrl: config.baseUrl, command: config.command });
  }

  async function test(agentId) {
    const record = registry.get(agentId);
    if (!record) return { ok: false, detail: 'No such agent.' };
    try {
      const transport = buildTransport(record);
      const info = await transport.start();
      await transport.stop();
      return { ok: true, detail: info?.detail || 'Reachable.' };
    } catch (err) {
      // Test is a local action by definition — the owner pressed the button —
      // so it reports the detail the relayed message deliberately omits.
      return { ok: false, detail: describeError(err) };
    }
  }

  async function answerApproval(agentId, runId, choice) {
    const entry = live.get(agentId);
    if (!entry || !entry.transport.answerApproval) return false;
    entry.pendingApproval = null;
    return entry.transport.answerApproval(runId, choice);
  }

  async function stopRun(agentId) {
    const entry = live.get(agentId);
    if (!entry) return false;
    await entry.transport.stop();
    entry.busy = false;
    bus.emit('agent-typing', { agentId, isTyping: false });
    // The transport was torn down to interrupt the run; bring it back up so the
    // agent stays usable without the user having to toggle it off and on.
    const record = registry.get(agentId);
    if (record && record.enabled) await startAgent(record);
    return true;
  }

  // Routes a message that arrived from a remote peer. Returns true if it was
  // consumed by an agent. Every condition here is a deliberate gate.
  function routeFromPeer(peerId, text) {
    if (!peerId || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('@')) return false; // must be explicitly addressed
    for (const record of registry.list()) {
      const prefix = `@${record.name.toLowerCase()}`;
      if (!trimmed.toLowerCase().startsWith(prefix)) continue;
      if (!reachable(record, peerId)) return false; // toggle, reach, running
      const rest = trimmed.slice(prefix.length).trim();
      // A bare `@name` is a summon rather than a question: it asks the agent to be
      // here, not to do anything. Handing it to accept() spent one of the asker's
      // queries and ran the transport on a prompt of nothing, and a run of nothing
      // is where the words "(no output)" came from.
      //
      // Peers on a build that has a summon frame send one; this branch is what
      // catches the same intent from a peer whose build sends it as ordinary chat,
      // so an older asker stops producing an empty run too.
      return rest ? accept(record, peerId, rest) : greet(record, peerId);
    }
    return false;
  }

  // A peer addressing an agent by id rather than by @name — the direct-chat
  // path. Every gate the @name path applies is re-applied here; the only
  // difference is how the agent was addressed.
  function routeDirect(peerId, agentId, text) {
    const record = registry.get(agentId);
    if (!record || typeof text !== 'string' || !text.trim()) return false;
    if (!reachable(record, peerId)) return false;
    return accept(record, peerId, text.trim());
  }

  // A peer's bare `@name`, sent as a summon rather than as chat. Nothing is asked
  // of the agent except that it be here.
  //
  // It still travels to this machine, because whether the agent says anything at
  // all is this machine's to decide — the same three gates as a question. A
  // greeting the asker's own machine wrote would be claiming an agent spoke when
  // it may be switched off, unreachable, or not shared with them.
  function routeSummon(peerId, agentId) {
    const record = registry.get(agentId);
    if (!reachable(record, peerId)) return false;
    return greet(record, peerId);
  }

  // Common tail: the request is stored in its own thread rather than in the
  // human chat, then handed to the transport — if it is this peer's turn.
  function accept(record, peerId, text) {
    const threadId = ensureDelegateIdentity(record, peerId);
    const state = turnState(record.id);
    const ts = Date.now();
    const note = () => bus.emit('agent-request', { threadId, agentId: record.id, peerId, text, ts });

    // A second question asked while one of theirs is already waiting to be read
    // is refused below — and it is not written down either. This thread is what
    // the agent's next answer is read against, so the same question arriving
    // three times makes that answer worse, not more likely. Keeping the
    // conversation to the questions that were actually asked is the point of the
    // mechanism rather than a side effect of it.
    const duplicate = state.held.has(peerId);
    if (!duplicate) note();

    // Anti-flood runs before anything is spent. Checking it later would let a
    // looping peer burn their own quota on messages that never reach the agent,
    // and turn each one into an outbound status frame — the exact amplification
    // the throttle exists to prevent. A message it swallows is still recorded
    // above, so a peer hammering the door is visible rather than invisible.
    const entry = live.get(record.id);
    if (checkThrottle(record.id, peerId, Boolean(entry && entry.busy)) === 'silent') return true;

    const claim = claimTurn(record.id, peerId);
    if (!claim.ok) {
      // Kept rather than dropped: they framed the question, and making them
      // notice their turn and type it again is the watching that standing in a
      // queue is supposed to spare them. One is kept — a second while the first
      // is still waiting is the same question asked twice, and it is refused.
      //
      // The asking machine normally refuses that second one itself, off its own
      // standing; this branch is what catches it when that standing is a beat
      // stale, or when the peer is running a build that does not know to.
      const standing = standingFor(record.id, peerId);
      if (duplicate) {
        reply(record.id, busyLine(nameOf(record.id), standing.position), peerId);
      } else {
        state.held.set(peerId, { text, ts });
        reply(
          record.id,
          claim.rotated
            ? rotatedLine(TURN_QUOTA, standing.position)
            : heldLine(nameOf(record.id), standing.position),
          peerId
        );
      }
    } else if (state.held.delete(peerId)) {
      // They hold the turn and are asking now, so anything kept from before is
      // superseded by what they just said. Only reachable when a handover landed
      // while the agent was mid-run and they typed before the sweep read it —
      // and this message was skipped above as a duplicate, so it needs writing
      // down after all now that it is the one being answered.
      note();
    }

    // Published once for either outcome: the queue can move on a refusal just as
    // it does on a claim, and everyone standing in it needs the same correction.
    publishStanding(record);

    // Somebody's idle turn was taken over by this claim. The warning that
    // normally precedes losing a turn only goes out while another peer is
    // already waiting, so a holder who went quiet on their own gets none — the
    // first they would know of it is a card that changed underneath them.
    if (claim.yielded && !turnState(record.id).quiet.has(claim.yielded)) {
      const theirs = standingFor(record.id, claim.yielded);
      reply(
        record.id,
        `Your turn went idle and someone else asked, so it has passed to them. ` +
          `You are #${theirs.position} in line; ask again when your turn comes round.`,
        claim.yielded
      );
    }

    if (claim.ok) deliver(record.id, text, peerId);
    // A refused claim can still have moved the turn — the rotate and yield paths
    // inside claimTurn promote a new holder without going through handOver — and
    // whoever it landed on may have been waiting with a question.
    else flushHeld(record);
    return true;
  }

  // The other tail: a summon is a trigger, not a message.
  //
  // Nothing is spent. No turn is claimed — TURN_QUOTA exists to share out whatever
  // capacity the agent has, and being asked to be present uses none of it, so
  // charging a query for it would make the introduction cost the first question.
  // For the same reason a summon never displaces a turn-holder and never joins
  // the held queue: there is nothing here to be answered later.
  //
  // And no transport runs. That is the whole point — a prompt of nothing produced
  // a run of nothing, and the run of nothing is what used to be reported.
  //
  // Nothing is written down either, on either machine. `@name` is how you open an
  // agent, not something anybody said, and both halves of it used to be recorded:
  // a synthesised `@name` bubble and a greeting to sit under it. Two lines of
  // transcript per summon, in a thread whose whole purpose is to hold the
  // questions and the answers. What is left is the one thing a summon is for —
  // the delegate thread exists, so the agent is there to be opened.
  function greet(record, peerId) {
    // Anti-flood still applies. It costs nothing to answer now, but a peer must
    // not be able to make us do it per keystroke: ensureDelegateIdentity below
    // touches the roster, and a roster republished thirty times a second is a
    // denial of service whether or not any words come with it.
    //
    // `busy` is false on purpose — nothing is being refused here, so this must
    // not spend the busy-refusal budget, and the agent working for somebody else
    // has no bearing on whether it can be summoned.
    if (checkThrottle(record.id, peerId, false, 'summon') === 'silent') return true;

    ensureDelegateIdentity(record, peerId);
    // True even when the throttle swallowed it above: this message was addressed to
    // an agent and is finished with either way. Returning false would tell
    // ipc.js's chat branch that nobody consumed it, and the bare `@name` would land
    // in the human chat with us — the one place agent traffic must never go.
    return true;
  }

  async function startAll() {
    for (const record of registry.list()) {
      if (record.enabled === false) {
        hub.setIdentity(record.id, identityFor(record)); // visible, offline
        continue;
      }
      await startAgent(record);
    }
    // Peers connected before us learn about shared agents here; those that
    // connect later get theirs from the peer-hello hook.
    announceAll();
  }

  // Everything this peer had been granted, taken back.
  //
  // Called when a pinned key changes and the user accepts the new one. The peer
  // id survives a key change — it is a UUID in a file, not something derived
  // from the key — so without this, clicking through the warning would hand the
  // new key every agent the old one could reach. "Warn loudly" is not sufficient
  // on its own precisely because the grant list outlives the warning.
  function revokePeer(peerId) {
    if (!peerId) return [];
    const revoked = [];
    for (const agent of registry.list()) {
      const allowed = agent.allowedPeers || [];
      if (!allowed.includes(peerId)) continue;
      registry.update(agent.id, { allowedPeers: allowed.filter((p) => p !== peerId) });
      revoked.push(agent.id);
    }
    // Anything that peer had shared with us goes too: it was advertised by a key
    // we no longer recognise.
    if (revoked.length) announceAll();
    return revoked;
  }

  async function stopAll() {
    clearInterval(idleSweep);
    // Peers should not be left holding a card for an agent that just went away
    // with the app; they will get a fresh advert on the next handshake.
    for (const record of registry.list()) withdraw(record);
    await Promise.all([...live.keys()].map((id) => stopAgent(id)));
  }

  return {
    list: () => registry.publicList(),
    add,
    update,
    remove,
    test,
    profilesFor,
    setEnabled,
    setSharing,
    setAllowedPeers: (agentId, peers) => {
      const record = registry.update(agentId, { allowedPeers: peers });
      // Visibility now follows permission, so a change here has to reach both
      // the local roster and the peers who just gained or lost the agent.
      if (record) announce(record);
      hub.emitPresence();
      return registry.publicList().find((a) => a.id === agentId);
    },
    answerApproval,
    stopRun,
    // Asking from this machine, on behalf of a thread that is not the agent's
    // own — a session. False when the agent is not running, so the caller can
    // say so rather than leaving a question in a transcript that nothing will
    // answer. Everything a peer can reach still goes through the routers below,
    // which is where the sharing gates live; this path is local-only by
    // construction and reaches no further than `deliver`.
    ask: (agentId, text, { thread = null, ref = null } = {}) => {
      if (!live.has(agentId)) return false;
      deliver(agentId, text, null, { thread, ref });
      return true;
    },
    // Whether there is anything there to ask. Asked separately from ask() so a
    // caller can write the question down before putting it, rather than after:
    // a transport that answers immediately would otherwise have its reply filed
    // above the question it was answering.
    isRunning: (agentId) => live.has(agentId),
    // Whether a run is already under way. Asked by a caller that is about to put
    // a question to several agents at once and needs to know which of them can
    // take one — because an agent asked while it is busy does not queue, it
    // answers "one at a time, please" (see deliver()), and that sentence is a
    // notice rather than a run: nothing follows it, so anything waiting on the
    // answer would wait forever. Skipping it here is what turns that into "this
    // one was busy" said once, in a session that got on with asking the rest.
    isBusy: (agentId) => Boolean(live.get(agentId)?.busy),
    routeFromPeer,
    routeDirect,
    routeSummon,
    announce,
    announceAll,
    startAll,
    revokePeer,
    stopAll,
    isAgent: isAgentId,
    isDelegate: isDelegateId,
    parseDelegate: parseDelegateId,
    standingFor,
    releaseIdleTurns,
    TURN_QUOTA,
    TURN_IDLE_MS,
    KINDS,
  };
}

module.exports = { createAgentHub, LOCAL_ORIGIN };
