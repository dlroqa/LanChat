'use strict';

const crypto = require('node:crypto');
const {
  SessionRegistry,
  isSessionId,
  DEFAULT_TITLE,
  OBSERVER_MODE,
  HUMAN_MODE,
  cleanTitle,
} = require('./registry.js');
const {
  isHost,
  isGuest,
  memberOf,
  mayPost,
  maySetup,
  mayDirect,
  invite,
  setState,
  accept,
  decline,
  leave,
  revoke,
  audience,
  shared,
} = require('./room.js');
const { FolderRegistry } = require('./folders.js');
const { parseTranscript } = require('./transcript.js');
const { composeContext, contextRecord } = require('./prompt.js');
const { resolveCounsel, missedNotice, unreachableNotice, soloNotice, relayPrompt } = require('./counsel.js');
const {
  dialoguePrompt,
  converged,
  nextSpeaker,
  remaining,
  endedNotice,
  leftNotice,
  finalLeftNotice,
} = require('./dialogue.js');
const { userMessage, agentMessage, turnsOf, taskState } = require('./a2a.js');
const {
  IN_TURN,
  BETWEEN,
  OBSERVE,
  CYCLED,
  rollArrangement,
  planCycle,
  nextInSegment,
  cycleCost,
  segmentNotice,
  cycleNotice,
} = require('./humanlike.js');
const {
  mentions,
  cleanObserver,
  cleanCandidate,
  levelFor,
  dedupe,
  categoryOf,
  shelfLabel,
  CANDIDATE_TYPES,
  SHELF,
  PROTECTIVE,
  expired,
} = require('./observer.js');
const {
  watchPrompt,
  extractionPrompt,
  candidatePrompt,
  admittedPrompt,
  parseExtraction,
  parseCandidate,
  worthRepairing,
  repairPrompt,
} = require('./observerPrompt.js');
const { seamOpen, seamStarved, turnSpent, protectiveAllowedNow } = require('./seam.js');
const { newFrame, mergeFrame, concrete } = require('./plan.js');
const { PEER_MIN_INTERVAL_MS } = require('../agents/index.js');

// Sessions: a titled workspace with a conversation in it.
//
// A session is a thread id and nothing more. It is not a peer and it is never
// registered with PeerHub — agents get a virtual socket because they need
// presence and a wire identity, and a session has neither. Putting one on the
// presence path would be a local-only construct pretending to be a contact, and
// every guard that keeps agent ids off the wire would have to grow a second
// exception.
//
// What it gets instead is the ordinary thread machinery: MessageStore files it
// under its own id, so history, export and delete all work on a session with no
// new code, and the agents it asks answer into it the same way an agent answers
// any other thread.

// How long a round can sit with nothing happening in it before the session gives
// up waiting and lets the next question through. Nothing runs on a timer — this
// is checked when somebody tries to ask again, which is the only moment it
// matters. A transport that hangs must not be able to lock a workspace shut.
const ROUND_IDLE_MS = 10 * 60 * 1000;

function createSessions({
  userDataDir,
  store,
  agentHub,
  remoteAgents,
  registry,
  folderRegistry,
  hub = null,
  bus = null,
}) {
  const sessions = registry || new SessionRegistry(userDataDir);
  // Where sessions are filed. Its own registry and its own file, so that no
  // folder operation ever writes sessions.json — see src/main/sessions/folders.js
  // for why that is the whole design rather than an implementation detail.
  const folders = folderRegistry || new FolderRegistry(userDataDir);

  // The question each session currently has out with its agents.
  //
  // In memory and nowhere else. A round is a live thing — who is still thinking,
  // what has come back so far, who is next in a relay — and none of it means
  // anything after a restart: the answers that did arrive are in the transcript
  // where they belong, and the ones that had not arrived never will. Writing it
  // down would only create the possibility of the app reopening convinced it is
  // waiting for something.
  const rounds = new Map();

  function list() {
    return sessions.list();
  }

  // A session this machine can still do something with.
  //
  // One in the Trash is not one of those, and this is the single place that is
  // decided. Everything that acts on a session reads it first — send(),
  // importText(), the import handler in ipc.js — so a deleted session refuses
  // the same way a session that never existed does, with no second rule to keep
  // in step. The registry's own get() is the door for anything that has to see
  // a trashed record, which is the trash pair below and nothing else.
  function get(id) {
    const record = sessions.get(id);
    return record && !record.deletedAt ? record : null;
  }

  function create(draft = {}) {
    return sessions.create(draft);
  }

  function rename(id, title) {
    return sessions.update(id, { title });
  }

  // ------------------------------------------------------------------ folders

  function listFolders() {
    return folders.list();
  }

  function createFolder(draft = {}) {
    return folders.create(draft);
  }

  function renameFolder(id, name) {
    return folders.rename(id, name);
  }

  function deleteFolder(id) {
    return folders.remove(id);
  }

  function moveFolder(id, toIndex) {
    return folders.move(id, toIndex);
  }

  // Filing a session. Guarded through get() above, which is the "not while it is
  // deleted" door — a session in the Trash is not a workspace this machine has,
  // and it must not be filed into a folder where its row would not draw anyway.
  // Taking one *out* of a folder is always allowed: that is what a purge does.
  function placeSession(id, { folderId = null, index = null } = {}) {
    if (folderId && !get(id)) return false;
    return folders.place(id, { folderId, index });
  }

  function setAgent(id, agentId) {
    return sessions.update(id, { agentId: agentId || null });
  }

  // Who this session asks, as one decision: a list, or everybody, and whether
  // they are asked together or in turn.
  //
  // For a session set to ask everybody there is no list to take a head from, so
  // the mirror `agentId` an older build would read is resolved here, from whoever
  // is around at the moment the choice is made. It is a best effort by
  // definition — the whole point of the setting is that the membership is not
  // fixed — and a best effort is the right amount for a field that only matters
  // to a version of the app this person may never run again.
  function setCounsel(id, { agentIds, allAgents, mode, turns, observer } = {}) {
    const patch = {};
    if (agentIds !== undefined) patch.agentIds = agentIds;
    if (allAgents !== undefined) patch.allAgents = allAgents;
    if (mode !== undefined) patch.mode = mode;
    if (turns !== undefined) patch.turns = turns;
    // How loud this session's observers may be, and whether they may interrupt.
    // Merged rather than replaced in the registry — see update() there — so the
    // picker changing the level cannot silently switch interrupting back off.
    if (observer !== undefined) patch.observer = observer;
    if (allAgents === true) patch.agentId = askable().find((a) => a.ready)?.id || null;
    return sessions.update(id, patch);
  }

  // Everyone this machine could put a question to, and whether they can take one
  // right now.
  //
  // The single place liveness is decided. Every caller downstream — who gets
  // asked, who is named in the notice, whether the composer is refused at all —
  // reads this one list, so there is no second opinion to drift out of step with
  // it. `reason` is why somebody cannot be asked, and it is carried rather than
  // re-derived because by the time the sentence is written the state may have
  // changed underneath it.
  //
  // The ids are the ids the record stores and the roster shows: `agent:…` for
  // ours, and the `remote-agent:owner:agent` form for one a peer shared. No
  // mapping, no second namespace.
  function askable() {
    const out = [];
    if (agentHub) {
      for (const a of agentHub.list()) {
        // An agent that is switched off is on this list, and not ready. Leaving
        // it off entirely would make it indistinguishable from one that has been
        // removed, and the session would tell somebody their agent was "no longer
        // here" when it is here and turned off — which is the one case with
        // something to do about it.
        const running = a.enabled !== false && agentHub.isRunning(a.id);
        // Busy is not the same as unavailable, but it is the same for this
        // question: an agent asked mid-run answers "one at a time, please" and
        // starts nothing, so a round waiting on that sentence would wait for an
        // answer that is never coming. Skipped and named instead.
        const busy = running && agentHub.isBusy(a.id);
        out.push({
          id: a.id,
          name: a.name,
          remote: false,
          ready: running && !busy,
          reason: !running ? 'off' : busy ? 'busy' : null,
        });
      }
    }
    if (remoteAgents) {
      for (const [ownerPeerId, list] of Object.entries(remoteAgents.sharedBy())) {
        // Whose agent it is, for a picker that has to say so. An owner who has
        // gone offline takes their agents off this list entirely — dropOwner sees
        // to that — so a name is available for everyone still on it.
        const owner = hub && hub.identities.get(ownerPeerId);
        const viaName = (owner && (owner.name || owner.hostname)) || 'a peer';
        for (const entry of list) {
          const resolved = remoteAgents.resolveThread(entry.id);
          // A question of ours already waiting to be read by its owner. Asking
          // again would not be answered any sooner — see the refusal in
          // remote.js — so this end skips them for the same reason it skips one
          // of ours that is busy.
          const held = Boolean(
            resolved && resolved.entry.held && resolved.entry.standing?.state === 'waiting'
          );
          out.push({
            id: entry.id,
            name: entry.name,
            remote: true,
            viaName,
            ready: !held,
            reason: held ? 'held' : null,
          });
        }
      }
    }
    return out;
  }

  // What the window is told about a round in progress: who was asked, who is
  // still thinking, what has come back, and who is yet to be asked.
  //
  // Published from here rather than assembled in the renderer out of four kinds
  // of event. The round is main's — it decides who is asked and when — and a
  // window that reconstructed it would be a second implementation of the same
  // bookkeeping, wrong in exactly the moments that matter: three agents thinking
  // at once, one of them failing, the last one going quiet.
  function view(round) {
    return {
      id: round.id,
      sessionId: round.sessionId,
      mode: round.mode,
      open: round.open,
      messageId: round.messageId,
      asked: round.asked.map((t) => ({ agentId: t.agentId, name: t.name })),
      running: [...round.running],
      answered: round.answers.map((a) => a.agentId),
      failed: [...round.failed],
      empty: [...round.empty],
      missed: round.missed.map((m) => ({ agentId: m.agentId, name: m.name, reason: m.reason })),
      next: round.queue.map((t) => ({ agentId: t.agentId, name: t.name })),
      // Where a discussion has got to, and why it stopped.
      //
      // Published rather than counted in the window for the same reason the rest
      // of this is: the turn is advanced here, by the thing that decides whether
      // there is another one, and a window keeping its own tally would be a
      // second implementation that disagrees on exactly the turn that ended it.
      // Only on a dialogue — the other two modes have no turn to be on, and a
      // field that is always null is a field somebody will one day try to read.
      // Which part of a cycle is running, and which of the six shuffles it is.
      //
      // Published rather than counted in the window, for the same reason the
      // discussion's turn is: the segment is advanced here, by the thing that
      // decides whether there is another one, and a window keeping its own tally
      // would disagree on exactly the turn that ended it.
      ...(round.segments.length && {
        turn: round.turn,
        cap: round.cap,
        ended: round.ended,
        speaking: round.speaking,
        left: [...round.left],
        notices: round.notices.slice(),
        paused: round.paused,
        arrangement: round.arrangement,
        segment: {
          kind: (segmentOf(round) || {}).kind || null,
          index: round.segmentAt,
          of: round.segments.length,
        },
      }),
      ...(round.mode === 'dialogue' && {
        turn: round.turn,
        cap: round.cap,
        ended: round.ended,
        speaking: round.speaking,
        // Who has stopped taking turns while the rest carry on, and the sentence
        // said about each as it happened. A discussion of four that finishes with
        // two talking is not the same event as one that ran to its budget with
        // everybody in it, and the roster alone cannot tell them apart.
        left: [...round.left],
        notices: round.notices.slice(),
        paused: round.paused,
        // Where the discussion stands, in the one vocabulary the round, the
        // window and an A2A agent all share — see a2a.js. `ended` above is
        // LanChat's reason and stays; this is the same fact in the words
        // anything speaking the protocol already understands.
        state: taskState(round),
      }),
    };
  }

  function publish(round) {
    if (bus) bus.emit('session-round', view(round));
  }

  // A round that nothing has happened in for a long time is over, whatever the
  // transport thinks. Checked lazily, when the next question is asked, because
  // that is the only moment anybody is inconvenienced by it — a timer would burn
  // a wakeup every minute to notice something nobody is waiting on.
  // A paused discussion is never stale. It is idle because somebody stopped it
  // to think, which is the one kind of waiting this rule is not about: the point
  // of the timeout is a transport that hung, and holding the floor deliberately
  // is not that. Without this, walking away mid-discussion for ten minutes would
  // quietly forfeit the rest of the budget.
  function stale(round) {
    return round.open && !round.paused && Date.now() - round.lastAt > ROUND_IDLE_MS;
  }

  // The end of a round. `ended` is why, and only a dialogue has one: the other
  // two modes end when everybody who was asked has reported, which is not a
  // reason so much as the absence of anything left to wait for.
  function closeRound(round, ended = null) {
    if (!round.open) return;
    round.open = false;
    if (ended) round.ended = ended;
    round.speaking = null;
    // Nobody is waiting to speak into a round that is over, and a discussion put
    // back into the Trash and restored must not find a turn still queued.
    round.nextUp = null;
    round.paused = false;
    // A turn that was waiting its slot with a peer's agent is not taken. The
    // question was never sent, so cancelling it costs nobody an answer — and
    // leaving it armed would have a stopped discussion speak once more, into a
    // round that had already reported itself finished.
    if (round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }
    round.running.clear();
    rounds.delete(round.sessionId);
    // A question that nobody answered is a question that failed, and the mark
    // goes on it so it stops counting as work this session got done.
    //
    // Decided here, at the end, rather than by whichever agent errored first:
    // one member of a counsel failing says nothing about whether the question was
    // answered, and marking it there would take a real answer off the total every
    // time two agents out of three came back.
    if (round.answers.length === 0 && round.messageId) {
      store.update(round.sessionId, round.messageId, { failed: true });
      round.failedRef = round.messageId;
    }
    if (bus)
      bus.emit('session-round', {
        ...view(round),
        failedRef: round.failedRef || null,
        // Why the discussion stopped, in words, built here with every other
        // sentence a session produces. Never stored: it is true about this round
        // and noise above the next question, exactly like the missed notice.
        ...(round.mode === 'dialogue' && {
          endedNotice: endedNotice(round.ended, { turn: round.turn, cap: round.cap }),
        }),
        // A cycle that ran its three parts has its own sentence: it did not run
        // out of budget and the agents did not run out of things to say, which
        // are the only two endings dialogue.js knows how to describe. It simply
        // had three parts and finished them. An ending of any other kind — the
        // room emptying, somebody pressing Stop — keeps the words that ending
        // already has.
        ...(round.segments.length && {
          endedNotice:
            round.ended === CYCLED
              ? cycleNotice(round.arrangement, { spoke: round.answers.length })
              : endedNotice(round.ended, { turn: round.turn, cap: round.cap }),
        }),
      });
  }

  // Sweeping the errors an older version wrote into this session.
  //
  // Two things go together and must not come apart: the messages leave the
  // transcript, and the same number is taken off what the session claims to have
  // asked. An error that was written down is one question that was not answered,
  // so removing the noise without removing the commit would leave the box
  // counting work the session never got.
  //
  // The ids are decided in the window, which is also where the person is asked
  // whether they want this at all. Only what was really removed is counted:
  // pressing the button twice must not take the total down twice.
  function sweepErrors(sessionId, ids) {
    const record = get(sessionId);
    if (!record) return { removed: 0 };
    const removed = store.remove(sessionId, ids);
    if (!removed) return { removed: 0 };
    // `needsContext` rides along because it is the same fact seen from the other
    // side: these errors named no question, so the questions behind them cannot
    // be put back, and a fork from here is asking about a conversation with holes
    // in it.
    sessions.update(sessionId, { unlinkedFailures: removed, needsContext: true });
    return { removed, record: sessions.get(sessionId) };
  }

  // ---- the Trash ----
  //
  // Deleting a session is two steps, not one. The first takes it out of the
  // window and leaves everything on disk; the second is the one that cannot be
  // undone. What makes the first reversible is that it does not go near the
  // store: the transcript stays filed under the session's own id, untouched,
  // and restoring is therefore putting a record back rather than rebuilding a
  // conversation out of something. There is nothing to rebuild it from.

  function listTrash() {
    return sessions.trashed();
  }

  // Into the Trash.
  //
  // Any question this session has out is closed on the way, because the answers
  // have nowhere to arrive: the round is in memory, the window has stopped
  // showing the session, and an open round left behind would keep a workspace
  // nobody can see marked as busy until it went stale.
  function trash(id) {
    const record = sessions.get(id);
    if (!record || record.deletedAt) return false;
    const open = rounds.get(id);
    if (open) closeRound(open);
    return Boolean(sessions.trash(id));
  }

  function restore(id) {
    return sessions.restore(id);
  }

  // The end of the road. Takes the conversation with the record: the two are
  // halves of one thing, and leaving the history file behind would keep a
  // deleted workspace on disk under a name nothing points at any more.
  //
  // Only reachable from the Trash, so nothing can lose a transcript in one
  // click.
  function purge(id) {
    const record = sessions.get(id);
    if (!record || !record.deletedAt) return false;
    store.clear(id);
    // The one place a folder has to be swept. Everywhere else a session simply
    // stops being drawn — trashing it takes it out of the live list and its id
    // waits in the folder for a restore — but a purge means it is never coming
    // back, and an id waiting for it would wait for ever.
    folders.forget(id);
    return sessions.remove(id);
  }

  // The two bulk doors, each returning how many it actually moved — pressing
  // either on an empty Trash is not an error, it is nought.
  function restoreAll() {
    let count = 0;
    for (const record of sessions.trashed()) {
      if (sessions.restore(record.id)) count += 1;
    }
    return count;
  }

  function purgeAll() {
    let count = 0;
    for (const record of sessions.trashed()) {
      if (purge(record.id)) count += 1;
    }
    return count;
  }

  // An agent that no longer exists cannot be asked anything. The sessions that
  // asked it stay — they hold a real conversation — but they stop claiming they
  // can carry on, and the header offers a new agent instead.
  function unbindAgent(agentId) {
    return sessions.unbindAgent(agentId);
  }

  // ---- asking ----

  // The shape a refused send takes, which is the same shape the remote-agent
  // path already returns: the words come back so the composer can be refilled,
  // the documents come back as paths so the chips can be put back, and the
  // reason is shown once and then dropped rather than written into the
  // transcript. Being told why you cannot ask yet should not cost somebody the
  // sentence they wrote.
  function refuse(sessionId, text, docs, reason) {
    return {
      rejected: true,
      text,
      docs: docs.map((d) => ({ path: d.path, name: d.name, bytes: d.bytes })),
      notice: {
        id: crypto.randomUUID(),
        peerId: sessionId,
        direction: 'in',
        kind: 'text',
        text: reason,
        ts: Date.now(),
        notice: true,
      },
    };
  }

  // Asks this session's counsel — one agent or several, ours or ones peers
  // shared.
  //
  // `prompt` is what the agents are asked and `text` is what the person typed;
  // they differ when documents are attached or a fork quoted something, and the
  // split is the point — a transcript should hold the question, not the pages
  // that went with it.
  //
  // One question is written down however many agents it goes to. The person
  // typed one sentence, and a transcript that repeated it once per agent would be
  // claiming they asked three times; it would also have the session count three
  // commits for one piece of work, and put the same documents on three bubbles.
  function send(sessionId, text, { prompt, docs = [], context = null } = {}) {
    // get() rather than the registry's, so a session in the Trash refuses a
    // question exactly the way one that was never here does — see the note on
    // get() for why that rule lives in one place.
    const record = get(sessionId);
    if (!record) return refuse(sessionId, text, docs, 'That session no longer exists.');

    // One round at a time. Two questions in flight at once would interleave two
    // sets of answers in one conversation with nothing to say which belonged to
    // which — and in relay mode it would mean an agent being shown a discussion
    // of a different question. A round nothing has happened in for a long time is
    // treated as over rather than allowed to wedge the workspace shut.
    const open = rounds.get(sessionId);
    if (open && !stale(open)) {
      // A discussion is the one round somebody can speak into rather than only
      // wait out. It carries on for turns at a time without anybody typing, and
      // the whole reason for watching one is to be able to say "not that" while
      // it still matters — so words typed into a live discussion join it instead
      // of being handed back with a refusal. Every other mode is one lap and is
      // over by the time a second question could sensibly be asked.
      if (open.mode === 'dialogue') return interject(open, text, docs, context);
      return refuse(sessionId, text, docs, 'The agents are still answering the last question asked here.');
    }
    if (open) closeRound(open);

    // ---- a room, rather than a workspace ----
    //
    // A guest does not run rounds and has no counsel of its own: the agents in a
    // shared session belong to the host and are asked by the host, because one
    // machine doing all the asking is what keeps one order and stops two ends
    // starting two rounds for one question.
    //
    // Answered here, above the counsel entirely. Resolving one first would find
    // nobody to ask — correctly, since a guest points at no agents — and refuse
    // the sentence, turning every word typed in a shared room into an error
    // about agents the person never expected to have.
    if (isGuest(record)) {
      // Not joined yet. An invitation is not a key from this side either: until
      // it is answered there is no room to speak into, and the words are handed
      // back rather than written somewhere nobody will read them.
      if (record.accepted !== true) {
        return refuse(sessionId, text, docs, 'Join this session first — it belongs to somebody else.');
      }
      const quotedForRoom = contextRecord(context);
      const mine = {
        id: crypto.randomUUID(),
        peerId: sessionId,
        direction: 'out',
        kind: 'text',
        text,
        ts: Date.now(),
        ...(quotedForRoom && { context: quotedForRoom }),
      };
      store.append(sessionId, mine);
      sessions.touch(sessionId);
      tell(record.hostPeerId, { type: 'session-chat', sessionId, text, id: mine.id, ts: mine.ts });
      return { ...mine, delivered: true };
    }

    const { targets, missed } = resolveCounsel(record, { askable: askable() });
    // Nobody at all. The question is handed back rather than written into a
    // transcript nothing will ever answer, and the sentence says which of them
    // could not be reached and why — the difference between something to fix and
    // something to wait for.
    if (targets.length === 0) return refuse(sessionId, text, docs, unreachableNotice(record, missed));

    // A discussion between one agent is not a discussion. Refused rather than
    // quietly run as a single question, because the two produce different
    // conversations and somebody who asked for the first should not silently get
    // the second — see soloNotice for the sentence and why it names who is here.
    //
    // Checked after the counsel is resolved and not before: whether there are
    // two agents to talk is a fact about this moment, not about the record.
    const dialogue = record.mode === 'dialogue';
    if (dialogue && targets.length < 2) return refuse(sessionId, text, docs, soloNotice(targets, missed));

    // A cycle needs a room, for the same reason a discussion does: two of its
    // three parts are agents reading each other, and one agent has nobody to
    // read. Refused with the same sentence rather than quietly running a
    // smaller thing, because somebody who chose this mode asked for a
    // conversation and would otherwise silently get a single answer.
    const human = record.mode === HUMAN_MODE;
    if (human && targets.length < 2) return refuse(sessionId, text, docs, soloNotice(targets, missed));

    // ---- observing ----
    //
    // The one mode where saying something does not, by itself, ask anybody
    // anything. The words are written down and the agents read them; whether any
    // of them speaks is decided afterwards, by what they have to say, and the
    // ordinary outcome is that none of them does.
    //
    // Naming an agent is the exception and it is absolute: being asked directly
    // is its own justification, so a mention skips every threshold the quiet
    // path applies. It does not skip the ones that are not about thresholds —
    // an agent that is switched off is still switched off, and resolveCounsel
    // above has already left it out.
    const observing = record.mode === OBSERVER_MODE;
    const named = observing
      ? mentions(
          text,
          targets.map((t) => ({ ...t, id: t.agentId }))
        )
      : [];

    const quoted = contextRecord(context);
    const composed = composeContext(quoted, prompt == null ? text : prompt);

    // Asking something new is the end of the missing-context warning. It was
    // there to say the session had lost questions that could not be put back;
    // once there is a fresh question in it, there is context again and the
    // warning has nothing left to warn about.
    //
    // Cleared when the question is accepted rather than when it is answered: it
    // is the asking that re-establishes what this session is about, and a run
    // that fails does not put the hole back.
    if (record.needsContext) sessions.update(sessionId, { needsContext: false });

    const message = {
      id: crypto.randomUUID(),
      peerId: sessionId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
      ...(quoted && { context: quoted }),
    };
    // Written down before anybody is asked, and in that order: a transport that
    // answers immediately would otherwise have its reply filed above the question
    // it was answering.
    store.append(sessionId, message);
    sessions.touch(sessionId);

    // The host's own words, passed on to the room. Everything an agent says is
    // relayed where it is written down; this is the one thing said here that
    // nothing else would carry.
    if (shared(record)) {
      tellRoom(record, {
        type: 'session-chat',
        sessionId,
        text,
        speaker: identityName(),
        id: message.id,
        ts: message.ts,
      });
    }

    // Said, and nobody asked anything.
    //
    // The whole of observer mode in one branch, and it returns before a round
    // exists because there is nothing to wait for: no agent has been given a
    // question, so there is no set of answers to collect and no reason to hold
    // the workspace shut. Somebody thinking out loud in an observed session can
    // type six times in a row and none of it is refused.
    //
    // What happens instead is watch(): the agents read what was said, the plan
    // frame is brought up to date, and a card may appear on the shelf a moment
    // later. None of that is awaited — a session must never be slower to accept
    // a sentence because an observer is thinking about the last one.
    // The whole of the quiet half, and it is quiet in the strongest sense: the
    // words are written down, no agent is disturbed, and nothing is said.
    //
    // What is deliberately not here is a background run per message. Asking every
    // agent to consider every sentence would double the cost of a conversation to
    // produce silence almost every time — and doing it through `ask` would print
    // each agent's reasoning into the transcript it was meant to be watching,
    // because every reply that path produces is routed to a thread and stored.
    // Speaking unasked waits for a way to consult an agent silently; staying
    // quiet does not, and staying quiet is the behaviour that makes an observed
    // session worth having.
    if (observing) {
      // When the person last spoke, and how much they said — the debounce is
      // longer after one line than after a paragraph, because somebody who has
      // just sent one line is usually still typing the next.
      const state = watchStateFor(sessionId);
      state.lastHumanAt = Date.now();
      state.lastHumanText = text;
      state.humanTurns = (state.humanTurns || 0) + 1;
      // Ideas raised about a conversation the room has since moved past. Swept
      // here, when the person speaks, because that is the event that moves it —
      // a card is stale relative to what has been said, not to the clock alone.
      const fresh = state.shelf.filter(
        (c) =>
          !expired(
            { targetPlanVersion: c.planVersion, createdAt: c.createdAt },
            { planVersion: state.frame.version, humanTurnsSince: state.humanTurns - c.atTurn }
          )
      );
      if (fresh.length !== state.shelf.length) {
        state.shelf = fresh;
        publishWatch(sessionId, state);
      }
    }
    if (observing && named.length === 0) {
      // Started and not awaited. The sentence is already accepted and written
      // down; whether an observer eventually has something to say about it is a
      // separate question with its own timing, and nothing about typing should
      // wait on it. A pass that throws is caught inside watch().
      Promise.resolve(watch(sessionId)).catch(() => {});
      return { ...message, delivered: true };
    }

    // Who this round actually asks. Everybody in the counsel, except in an
    // observed session where somebody named names — there, only the agents that
    // were named, because "what does @Zima think?" is a question for Zima and
    // answering it with three opinions is not being helpful.
    const asking = observing && named.length ? named : targets;

    const round = {
      id: crypto.randomUUID(),
      sessionId,
      // What kind of round this is.
      //
      // An observed session that was asked something directly runs an ordinary
      // parallel round: the mode describes how the answers are gathered, and
      // several named agents answering one question is exactly that. The mode
      // the *session* is in is on the record; this is what this question is
      // doing.
      mode: human ? HUMAN_MODE : dialogue ? 'dialogue' : record.mode === 'relay' ? 'relay' : 'parallel',
      // The one message every run in this round is answering. All of them carry
      // it as `ref`, which is why an error has to name the agent as well: the
      // question alone no longer identifies which run failed.
      messageId: message.id,
      text,
      composed,
      docs,
      quoted,
      asked: asking,
      queue: [],
      running: new Set(),
      answers: [],
      empty: new Set(),
      failed: new Set(),
      missed,
      failedRef: null,
      open: true,
      startedAt: Date.now(),
      lastAt: Date.now(),
      // ---- a dialogue's own bookkeeping ----
      //
      // The order they speak in, which is the order the session's list is in.
      // Held separately from `asked` because `asked` is who took part and this
      // is the rota — they are the same list today and would come apart the
      // moment anything ever joined a discussion in progress.
      order: dialogue ? asking.slice() : [],
      // Which turn is being taken, counting from one, and the ceiling it is
      // counting towards. The cap is copied off the record here rather than read
      // from it later: a discussion runs for the budget it was started with, and
      // changing the setting mid-round must not extend the round it is in.
      turn: dialogue ? 1 : 0,
      cap: dialogue ? record.turns : 0,
      speaking: null,
      ended: null,
      // Agents that have stopped taking turns: signed off, went quiet, or could
      // not answer. They stay in `order` — the rota is a record of how the
      // discussion was arranged, and their words are still in the transcript —
      // and are skipped on the way round. See noteOutcome for why one agent
      // leaving is not the end of a discussion between four.
      left: new Set(),
      // What was said about each of them as they went, in order.
      notices: [],
      // Whether the person has the floor. A paused discussion is still open and
      // still has its budget; what it does not have is a turn in flight — see
      // pauseRound.
      paused: false,
      // Who speaks when it starts again. Worked out when the previous speaker
      // reports and held here until the turn is actually taken, so a pause never
      // loses whose go it was.
      nextUp: null,
      // ---- a Human Like cycle's own bookkeeping ----
      //
      // Empty for every other mode, and that emptiness is what the segment layer
      // is switched on by: `round.segments.length` is the single condition, so
      // the four modes that came before this one take exactly the paths they
      // always did. Nothing below is read unless a cycle planned it.
      //
      // The parts this question will run, in the order rolled for it, each with
      // its own queue of who speaks. Decided once, here, rather than worked out
      // as the round goes — a queue settled in advance is a queue that can be
      // counted, which is what makes "one turn each" a property rather than a
      // promise.
      segments: [],
      segmentAt: 0,
      // Which of the six shuffles this is, kept so the window can say so and so
      // the next question in this session can avoid it.
      arrangement: null,
      // The discussion itself, as A2A messages — see a2a.js.
      //
      // This is the record every turn is rendered from, and it is one list
      // rather than two: the question that started it, every agent's reply, and
      // (once there is a way to make one) anything the person says into the
      // middle of it, all in the order they happened. Keeping the person in the
      // same list as the agents is the whole reason for the shape — an
      // interjection is then a turn like any other rather than a special case
      // threaded through the loop.
      //
      // Filled in below, because the messages carry the round's own id and it
      // does not exist until this object does.
      history: [],
      // A turn waiting its slot with a peer's agent — see bookRemote below.
      timer: null,
    };
    // The opening question, and the only entry that is not quoted back to
    // anybody: it is rendered last in every prompt, on its own, because the
    // question is the thing to act on and belongs nearest the reply. Everything
    // after it is the discussion — see questionFor.
    round.history.push(userMessage({ text: composed, contextId: sessionId, taskId: round.id, turn: 0 }));
    rounds.set(sessionId, round);

    // A cycle: three parts in a rolled order, one turn each per part.
    //
    // Above the three branches that were here before it, and it is the only one
    // that has to decide anything before it can start — the others already know
    // who they are asking. Below this, nothing is changed.
    if (round.mode === HUMAN_MODE) {
      // Rolled here, once, and remembered on the record so the next question in
      // this session can avoid it. Written down before anything is dispatched: a
      // transport that answers inside the call can run the whole cycle and close
      // the round before this line would otherwise be reached, and the next
      // question would then be free to repeat the shape this one just used.
      const cycle = planCycle(rollArrangement(record.lastArrangement), asking);
      round.arrangement = cycle.arrangement;
      round.segments = cycle.segments;
      round.cap = cycleCost(asking.length);
      sessions.update(sessionId, { lastArrangement: cycle.arrangement });
      startSegment(round);
      if (round.open) publish(round);
    } else if (round.mode === 'dialogue') {
      // One agent at a time, always, so the busy gate in agents/index.js is never
      // the thing that ends a discussion — by the time somebody's turn comes
      // round again their last run is long over.
      round.speaking = round.order[0].agentId;
      // Dispatched before the window is told, for the reason given in
      // noteOutcome: dispatch() is what puts the agent into `running`, and a view
      // published ahead of it says nobody is thinking. Guarded, because a
      // transport that answers inside the call can run the whole discussion and
      // close the round before this line is reached.
      dispatch(round, round.order[0]);
      if (round.open) publish(round);
    } else if (round.mode === 'relay') {
      round.queue = asking.slice();
      publish(round);
      dispatchNext(round);
    } else {
      // Everybody is marked as thinking before anybody is asked. A transport
      // that answers inside the call would otherwise close the round on the
      // first answer, while the rest of the counsel had not been asked yet.
      for (const t of asking) round.running.add(t.agentId);
      publish(round);
      for (const t of asking) dispatch(round, t);
    }

    // Who was left out, said once. Never stored — it is true about this question
    // and noise above the next one — and shaped exactly like the notice a refusal
    // carries, so the window has one thing to render either way.
    const skipped = missedNotice(missed);
    return {
      ...message,
      delivered: true,
      ...(skipped && {
        notice: {
          id: crypto.randomUUID(),
          peerId: sessionId,
          direction: 'in',
          kind: 'text',
          text: skipped,
          ts: Date.now(),
          notice: true,
        },
      }),
    };
  }

  // Puts the round's question to one agent.
  //
  // In relay mode the question grows as it goes: each agent is shown what the
  // ones before it said, built here rather than at the start, because at the
  // start those answers did not exist.
  // In a dialogue it grows differently: only the last thing said is quoted, and
  // the agent is told whose turn it is and how many are left. A relay quotes
  // everything once; a dialogue would carry the whole discussion again on every
  // turn, and the agents already hold their own side of it.
  function questionFor(round, target) {
    // In a cycle it is the part that decides, not the round. A cycle is the
    // three older modes taken in turns, so each part asks for exactly what that
    // mode has always asked for — the builders below are the same ones, handed
    // different numbers.
    const segment = segmentOf(round);
    if (segment) {
      if (segment.kind === IN_TURN) return relayPrompt(round.composed, round.answers);
      if (segment.kind === BETWEEN) {
        return dialoguePrompt({
          question: round.composed,
          speaker: target,
          roster: remaining(round.order.length ? round.order : round.asked, round.left),
          history: turnsOf(round.history.slice(1)),
          // Where this speaker stands inside its own part, not inside the whole
          // cycle. A discussion segment is one lap, so the agent taking the last
          // turn of it is told this is the last turn — which is what makes it
          // say the thing it would want said last instead of leaving a thread
          // hanging for a lap that is never coming.
          turn: segment.spoken.length,
          cap: segment.size,
        });
      }
      // The observing part. It is asked to watch rather than to answer, and
      // saying nothing is the ordinary outcome — see the charter in
      // observerPrompt.js for why the instruction is written as prohibitions.
      return observerQuestion(round, target);
    }
    if (round.mode === 'relay') return relayPrompt(round.composed, round.answers);
    if (round.mode === 'dialogue') {
      return dialoguePrompt({
        question: round.composed,
        speaker: target,
        // Who is still in the room, in the order they speak. The ones who have
        // left are not on it — an agent told to expect Beacon after Tessie, when
        // Beacon signed off two turns ago, has been told something untrue.
        roster: remaining(round.order, round.left),
        // And everything said so far, by everybody. Not the last answer: that is
        // what made a discussion of three into three agents each replying to
        // whoever went immediately before them.
        //
        // From the first turn onwards, because history[0] is the question and
        // the question is rendered on its own, at the end. Quoting it here as
        // well would show every agent the question twice.
        history: turnsOf(round.history.slice(1)),
        turn: round.turn,
        cap: round.cap,
      });
    }
    return round.composed;
  }

  // When this machine may next put a question to a particular shared agent.
  //
  // The owner's anti-flood swallows a second question from the same peer inside
  // PEER_MIN_INTERVAL_MS — silently and on purpose, because answering a flood is
  // how you amplify one (see checkThrottle in agents/index.js). Nothing comes
  // back, so a round waiting on that question waits for an answer that was never
  // going to arrive.
  //
  // Every mode but one asks a given agent once per round, so this never bit
  // before. A discussion asks the same two agents over and over, as fast as they
  // answer, and two agents that answer quickly will trip it every time. Being
  // throttled by a neighbour is not something to work around — it is something
  // not to deserve, so this end paces itself instead.
  //
  // The slot is reserved rather than merely read, so two turns booked in the same
  // millisecond come out one interval apart rather than both taking the same one.
  // Headroom on top of the interval, and it is load-bearing rather than
  // superstition.
  //
  // The two ends measure different moments. This one books from when it decided
  // to send; the owner measures from when it *accepted* the last question, which
  // is later by a frame in flight and whatever it was doing when it arrived. Two
  // turns booked exactly PEER_MIN_INTERVAL_MS apart therefore arrive a hair under
  // it whenever the first question took longer to accept than the second — and
  // the owner's rule is a strict `<`, so the question is swallowed in silence and
  // the discussion waits for an answer that was never going to come.
  //
  // A quarter-second is far more than the difference in practice and far less
  // than anybody can perceive in a discussion that already paces itself in
  // seconds. Being early is the only failure mode with no way back, so this end
  // is deliberately late.
  const PEER_PACE_MARGIN_MS = 250;

  const lastAsked = new Map();
  function bookRemote(threadId, pace) {
    const now = Date.now();
    const at = pace
      ? Math.max(now, (lastAsked.get(threadId) || 0) + PEER_MIN_INTERVAL_MS + PEER_PACE_MARGIN_MS)
      : now;
    lastAsked.set(threadId, at);
    return at - now;
  }

  function sendRemote(round, target, remote, question) {
    const sent = remoteAgents.send(remote.ownerPeerId, remote.entry, round.text, {
      prompt: question,
      docs: round.docs,
      thread: round.sessionId,
      context: round.quoted,
      // The question is already in the transcript; this is the same question
      // reaching one more agent, not a second question.
      record: false,
    });
    if (sent.rejected) noteOutcome({ threadId: round.sessionId, agentId: target.agentId, kind: 'error' });
    return !sent.rejected;
  }

  function dispatch(round, target) {
    round.running.add(target.agentId);
    // An agent a peer shared with us. The question travels to its owner, and the
    // answer is routed back to this session rather than to the agent's own
    // thread — see `pending` in agents/remote.js for how, and why that is safe.
    const remote = remoteAgents && remoteAgents.resolveThread(target.agentId);
    if (remote) {
      const wait = bookRemote(target.agentId, round.mode === 'dialogue');
      if (wait > 0) {
        // The one timer in this file, and it is not a deadline — it is this
        // machine waiting its turn with somebody else's agent. The round is
        // already showing that agent as thinking, which is true: its question is
        // written and on its way.
        round.timer = setTimeout(() => {
          round.timer = null;
          // Stopped, trashed, or already over while we waited.
          //
          // Composed here rather than three seconds ago, which is the whole
          // reason this is inside the timer: a person can say something into a
          // discussion while it waits its turn with a peer's agent, and a
          // question written before they spoke would be the one turn in the room
          // that had not heard them.
          if (round.open) sendRemote(round, target, remote, questionFor(round, target));
        }, wait);
        if (round.timer.unref) round.timer.unref();
        return true;
      }
      return sendRemote(round, target, remote, questionFor(round, target));
    }
    const question = questionFor(round, target);
    // `ref` is what makes a failure attributable: if this run errors, the error
    // comes back naming this message, and this message stops counting as a
    // question that was answered — once the whole round is in, and not before.
    const ok = agentHub
      ? agentHub.ask(target.agentId, question, {
          thread: round.sessionId,
          ref: round.messageId,
          // The same turn in A2A's shape, for the one transport that speaks it.
          // Every other transport is handed `question` and never looks at this —
          // see the note on ask() in agents/index.js.
          a2a: {
            a2aMessage: userMessage({
              text: question,
              contextId: round.sessionId,
              taskId: round.id,
              turn: round.turn,
            }),
            taskId: round.id,
            contextId: round.sessionId,
          },
        })
      : false;
    // Refused at the door. Everything that could be checked in advance already
    // was, so this is a race — an agent switched off between resolving the
    // counsel and asking it — and it closes the slot the same way an error does,
    // because it is one: nothing is coming back from this agent.
    if (!ok) noteOutcome({ threadId: round.sessionId, agentId: target.agentId, kind: 'error' });
    return ok;
  }

  // What the agent taking the watching turn of a cycle is shown.
  //
  // Its reply goes straight into the transcript, so it is asked in plain
  // language rather than for a candidate block — see watchPrompt for why those
  // are two different things and must stay so.
  function observerQuestion(round, target) {
    return watchPrompt({
      question: round.composed,
      speaker: target,
      roster: remaining(round.asked, round.left),
      history: turnsOf(round.history.slice(1)),
      // No plan frame yet. Building one means asking an agent a question whose
      // answer does not land in the transcript, and `agentHub.ask` has no such
      // door — every reply it produces is routed to a thread and stored (see
      // ipc.js). Rather than print an extraction into the conversation it was
      // meant to be watching, the turn is taken on the conversation itself,
      // which is what watchPrompt is written to work from.
      frame: null,
    });
  }

  // ---- sharing a session ----
  //
  // A session began as a private workspace and can become a room. The rules for
  // who may do what live in room.js, as functions of a record and a proved peer
  // id; this is the part that moves frames and writes things down.
  //
  // **The session id rides as a field, never as a sender.** The guard in ipc.js
  // drops any frame whose `from` is a local thread id, because that would be a
  // peer impersonating one of our threads. Naming a room is not impersonating a
  // thread, so nothing here needs that rule relaxed and it is left exactly as it
  // was. Membership is always looked up in our own record — a peer claiming to
  // be in a room is not a peer who is in one.

  // What this machine is called, for the name on our own words when they reach
  // somebody else's copy of the room. Read at the moment of sending rather than
  // held, because a person can rename themselves mid-conversation.
  function identityName() {
    const me = hub && hub.getIdentity && hub.getIdentity();
    return (me && (me.name || me.hostname)) || 'Someone';
  }

  function tell(peerId, frame) {
    return hub ? hub.send(peerId, frame) : false;
  }

  // Everybody in the room, minus whoever caused the thing being told.
  function tellRoom(record, frame, except = null) {
    for (const peerId of audience(record, except)) tell(peerId, frame);
  }

  // Asking somebody in.
  //
  // Host only, and `maySetup` is what says so — a guest's copy of a session is a
  // view of the host's, and a guest handing out invitations to somebody else's
  // room would be a second authority over who is in it.
  function invitePeer(sessionId, peerId) {
    const record = get(sessionId);
    if (!record || !maySetup(record, null) || !peerId) return false;
    const identity = hub && hub.identities.get(peerId);
    const name = (identity && (identity.name || identity.hostname)) || null;
    const members = invite(record, peerId, name);
    sessions.update(sessionId, { members });
    tell(peerId, {
      type: 'session-invite',
      sessionId,
      title: record.title,
      mode: record.mode,
    });
    return true;
  }

  // Taking somebody back out. They are told, so their copy stops accepting
  // anything from us rather than sitting there looking live.
  function removePeer(sessionId, peerId) {
    const record = get(sessionId);
    if (!record || !maySetup(record, null)) return false;
    const members = revoke(record, peerId);
    sessions.update(sessionId, { members });
    tell(peerId, { type: 'session-leave', sessionId });
    return true;
  }

  // An invitation arriving.
  //
  // A record is written for it immediately, marked with whose room it is and
  // with us in it as `invited` — not joined. That distinction is the whole of the
  // consent model: an invitation is not a key, and nothing may be sent or
  // received for this session until somebody here says yes.
  function onInvite(fromPeerId, { sessionId, title } = {}) {
    if (!fromPeerId || !isSessionId(sessionId)) return null;
    // Already known: a duplicate invite frame, or one re-sent after a reconnect.
    if (sessions.get(sessionId)) return null;
    const record = sessions.createShared({
      id: sessionId,
      title: cleanTitle(title),
      hostPeerId: fromPeerId,
      members: [{ peerId: fromPeerId, state: 'joined' }],
    });
    if (bus) bus.emit('session-invited', { sessionId, from: fromPeerId, title: record.title });
    return record;
  }

  // Answering one.
  function answerInvite(sessionId, accepted) {
    const record = sessions.get(sessionId);
    if (!record || !isGuest(record)) return false;
    tell(record.hostPeerId, {
      type: 'session-invite-reply',
      sessionId,
      accepted: accepted === true,
    });
    if (!accepted) {
      // Declining removes the record. Keeping a workspace nobody agreed to join
      // would leave a room in the sidebar that does nothing.
      sessions.remove(sessionId);
      return true;
    }
    sessions.update(sessionId, {
      accepted: true,
      members: setState(record, record.hostPeerId, 'joined'),
    });
    if (bus) bus.emit('session-room', { sessionId });
    return true;
  }

  // The other end answering.
  function onInviteReply(fromPeerId, { sessionId, accepted } = {}) {
    const record = get(sessionId);
    if (!record || !maySetup(record, null)) return;
    if (!memberOf(record, fromPeerId)) return;
    const members = accepted ? accept(record, fromPeerId) : decline(record, fromPeerId);
    sessions.update(sessionId, { members });
    if (!accepted) return;
    // What they have missed. Sent once, on joining, because a room somebody
    // walks into halfway through is unreadable without it.
    tell(fromPeerId, {
      type: 'session-sync',
      sessionId,
      title: record.title,
      messages: store.read(sessionId).slice(-SYNC_MESSAGES),
    });
  }

  // How much of a conversation a newcomer is given. Enough to follow what is
  // being decided, bounded so that joining a long-running room is not a transfer
  // of the whole history.
  const SYNC_MESSAGES = 200;

  function onSync(fromPeerId, { sessionId, messages } = {}) {
    const record = sessions.get(sessionId);
    if (!mayDirect(record, fromPeerId)) return;
    // Replaced rather than merged: this is the host's transcript, and the host
    // is the authority on what was said and in what order.
    store.clear(sessionId);
    for (const m of Array.isArray(messages) ? messages : []) {
      if (!m || typeof m.text !== 'string') continue;
      store.append(sessionId, {
        id: m.id || crypto.randomUUID(),
        peerId: sessionId,
        // Everything that arrives from the room reads as incoming, including our
        // own earlier words — we were not here when they were said.
        direction: 'in',
        kind: 'text',
        text: m.text,
        ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
        ...(m.speaker && { speaker: m.speaker }),
      });
    }
    if (bus) bus.emit('session-synced', { sessionId });
  }

  // Being told somebody has gone, or that we have.
  //
  // Two frames in one, told apart by who sent it and which side we are. From the
  // host to us, it means we have been taken out: the record stays — it holds a
  // real conversation and deleting somebody's transcript because a peer said so
  // would be letting them delete our data — but it stops being live, and the
  // host is no longer a member we accept anything from. From a guest to the
  // host, it is that guest leaving.
  function onRoomLeave(fromPeerId, { sessionId } = {}) {
    const record = get(sessionId);
    if (!record) return;
    if (isGuest(record)) {
      if (fromPeerId !== record.hostPeerId) return;
      sessions.update(sessionId, { members: setState(record, fromPeerId, 'left') });
    } else {
      if (!memberOf(record, fromPeerId)) return;
      sessions.update(sessionId, { members: leave(record, fromPeerId) });
    }
    if (bus) bus.emit('session-room', { sessionId });
  }

  // Something said in a room.
  //
  // On the host this is a member's words: authorised against our own record,
  // written down, and passed on to everybody else. On a guest it is the host
  // relaying the room, and only the host — see mayPost in room.js for why a
  // guest never takes words from another guest directly.
  function onRoomChat(fromPeerId, { sessionId, text, speaker, id, ts } = {}) {
    const record = get(sessionId);
    if (!record || typeof text !== 'string' || !text.trim()) return;
    if (!mayPost(record, fromPeerId)) return;

    const identity = hub && hub.identities.get(fromPeerId);
    const said = {
      id: id || crypto.randomUUID(),
      peerId: sessionId,
      direction: 'in',
      kind: 'text',
      text,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      // Who said it. On the host that is the peer who sent it; on a guest the
      // host has already stamped it, and their word for who spoke is the one
      // that counts.
      speaker: speaker || (identity && (identity.name || identity.hostname)) || 'Someone',
    };
    if (bus) bus.emit('session-said', { sessionId, message: said });
    sessions.touch(sessionId);

    // The host is the only one that relays. A guest re-broadcasting would put
    // the same sentence round the room twice.
    if (isHost(record)) {
      tellRoom(
        record,
        { type: 'session-chat', sessionId, text, speaker: said.speaker, id: said.id, ts: said.ts },
        fromPeerId
      );
      // An observed room watches everybody in it, not only whoever is at this
      // keyboard — which is the whole reason a session can have people in it.
      if (record.mode === OBSERVER_MODE) {
        const state = watchStateFor(sessionId);
        state.lastHumanAt = Date.now();
        state.lastHumanText = text;
        state.humanTurns = (state.humanTurns || 0) + 1;
        Promise.resolve(watch(sessionId)).catch(() => {});
      }
    }
  }

  // ---- watching ----
  //
  // What an observed session does with a sentence nobody asked anybody about.
  //
  // Two passes, both through agentHub.consult, which is the door that runs a
  // transport without its words reaching a thread. One agent reads the room and
  // says what the plan is; if there turns out to be a plan, the others are asked
  // whether they have anything worth saying about it. The ordinary outcome of
  // the second pass is that nobody does.
  //
  // Nothing here is awaited by send(). A session must never be slower to accept
  // a sentence because an observer is still thinking about the last one, and a
  // person typing six times in a row must not queue six passes — see `thinking`
  // below, which is what makes the pass at-most-one-at-a-time per session.

  // The plan each observed session is keeping, and what is on its shelf.
  //
  // In memory, like `rounds` above and for the same reason: a candidate is a
  // live thing that has to be re-grounded against a conversation before it can
  // be acted on, and one restored from disk would be a proposal about a room
  // nobody is in any more.
  const watching = new Map();

  function watchStateFor(sessionId) {
    if (!watching.has(sessionId)) {
      watching.set(sessionId, {
        frame: newFrame(sessionId),
        shelf: [],
        thinking: false,
        // What a seam is measured against: who is mid-sentence, when the last
        // person spoke and how long what they said was, and when an observer
        // last took a turn unasked.
        typing: {},
        lastHumanAt: 0,
        lastHumanText: '',
        lastSpokeAt: 0,
        floor: null,
        timer: null,
        humanTurns: 0,
        // When this session last cut across somebody. A list rather than a
        // timestamp, because the rule is both "not too soon after the last one"
        // and "not too many in an hour", and the second needs the history.
        interruptions: [],
      });
    }
    return watching.get(sessionId);
  }

  // The last few things said, as the observers are shown them.
  //
  // Read from the transcript rather than kept alongside it, so a pass sees what
  // is actually in the conversation — including anything an agent answered when
  // it was named directly, which the observers were not party to.
  const WATCH_TURNS = 12;

  function roomHistory(sessionId) {
    return store
      .read(sessionId)
      .slice(-WATCH_TURNS)
      .filter((m) => m.kind === 'text' && m.text && !m.notice && !m.error)
      .map((m) => ({
        id: m.id,
        name: m.speaker || (m.direction === 'out' ? 'The person watching' : 'Someone'),
        text: m.text,
      }));
  }

  // One reading of the room, and possibly one card on the shelf.
  async function watch(sessionId) {
    const state = watchStateFor(sessionId);
    // At most one pass per session at a time. Somebody thinking out loud writes
    // several sentences in a row, and starting a pass for each would put every
    // agent in the room to work on a conversation that is still being written.
    if (state.thinking) return null;
    const record = get(sessionId);
    if (!record || record.mode !== OBSERVER_MODE) return null;

    // Local agents only. A peer's agent is paced by their anti-flood and its
    // fair-share quota is meant for questions somebody actually asked — spending
    // it on a background pass that usually produces silence would be a poor way
    // to treat a neighbour. Shared agents in an observed session answer when
    // they are named, and at no other time.
    const { targets } = resolveCounsel(record, { askable: askable() });
    const local = targets.filter((t) => !t.remote);
    if (local.length === 0) return null;

    state.thinking = true;
    try {
      const history = roomHistory(sessionId);
      if (history.length === 0) return null;

      // ---- is there a plan here? ----
      const reader = local[0];
      const read = await agentHub.consult(reader.agentId, extractionPrompt({ history, frame: state.frame }));
      const extracted = parseExtraction(read);
      if (extracted) {
        state.frame = mergeFrame(state.frame, extracted, {
          messageIds: history.map((h) => h.id),
        });
      }
      // No plan, nothing to say about one. This is the common path and it costs
      // exactly one run — the expensive second pass never happens.
      if (!concrete(state.frame)) return null;

      // ---- has anybody anything worth saying? ----
      const raised = [];
      for (const target of local) {
        const ask = candidatePrompt({
          history,
          frame: state.frame,
          speaker: target,
          types: CANDIDATE_TYPES,
        });
        const said = await agentHub.consult(target.agentId, ask);
        let parsed = parseCandidate(said);
        // One more try, and only for an answer that was visibly trying.
        //
        // A reply with a block that failed to yield a claim is a model that
        // understood the shape and fumbled it, and that is worth asking again.
        // A reply with no block at all is a transport that is not going to
        // produce one, and asking twice buys a second nothing. Never a third
        // attempt: a repair loop that can run twice can run forever on a model
        // having a bad day, and the failure is a session quietly spending money
        // to be told nothing.
        if (!parsed && worthRepairing(said)) {
          parsed = parseCandidate(await agentHub.consult(target.agentId, repairPrompt(said, ask)));
        }
        if (!parsed) continue;
        const candidate = cleanCandidate(parsed, {
          observerId: target.agentId,
          planId: state.frame.planId,
          planVersion: state.frame.version,
        });
        // Grounding is checked against what is really in the room. A claim citing
        // a message that does not exist is a claim about nothing, whatever it
        // says about itself.
        if (!candidate) continue;
        const real = new Set(history.map((h) => String(h.id)));
        candidate.evidence = candidate.evidence.filter((id) => real.has(id));
        raised.push(candidate);
      }

      // Two observers noticing the same thing is one card, with both names on it.
      const merged = dedupe(raised);
      const settings = cleanObserver(record.observer);
      const cards = [];
      for (const candidate of merged) {
        const level = levelFor(candidate, { observer: settings, plan: state.frame });
        if (!level) continue;
        cards.push({
          id: crypto.randomUUID(),
          level,
          category: categoryOf(candidate),
          label: shelfLabel(
            candidate,
            candidate.observerIds.map((id) => (local.find((t) => t.agentId === id) || {}).name)
          ),
          claim: candidate.claim,
          evidence: candidate.evidence,
          observerIds: candidate.observerIds,
          planVersion: state.frame.version,
          atTurn: state.humanTurns || 0,
          createdAt: Date.now(),
        });
      }
      if (cards.length === 0) return null;

      // At most one thing may ask for the floor at a time, and only if nothing
      // already is. The rest go to the shelf — a losing candidate is still
      // useful, it simply does not get to interrupt on its own account.
      // ---- interrupting ----
      //
      // The one thing here that does not wait for a gap, because the whole claim
      // of it is that waiting would cost something that cannot be got back: a
      // hard constraint about to be broken, or a step about to be taken that
      // cannot be undone.
      //
      // Everything that makes it rare has already happened by this point.
      // levelFor granted the rung only for a declared hard-constraint conflict,
      // only against a constraint the person actually stated, and only in a room
      // that switched interruptions on. What is left here is the rationing —
      // which is deliberately outside levelFor, because "is this important
      // enough" and "have we done this too often lately" are different
      // questions and a candidate must not be able to answer the second one.
      const urgent = cards.find((c) => c.level === PROTECTIVE);
      if (urgent && protectiveAllowedNow(state.interruptions)) {
        state.interruptions = [...(state.interruptions || []), Date.now()];
        // Straight through the floor machinery, minus the waiting. It is still
        // one turn, still generated after the decision to speak rather than
        // before, and still re-grounded against everything said since.
        state.floor = {
          card: urgent,
          candidate: merged.find((m) => m.claim === urgent.claim) || null,
          observerId: urgent.observerIds[0],
          observerName: (local.find((t) => t.agentId === urgent.observerIds[0]) || {}).name || 'An observer',
          requestedAt: Date.now(),
          seen: new Set(history.map((h) => h.id)),
          // An interruption is the one thing here that does not ask. Being
          // granted on arrival is exactly what the room agreed to when it
          // switched interruptions on.
          granted: true,
        };
        state.shelf = [...state.shelf, ...cards.filter((c) => c !== urgent)];
        publishWatch(sessionId, state);
        await admit(sessionId);
        return cards;
      }
      // Rationed out. It does not evaporate — an interruption refused for being
      // too soon after the last one is still the most important thing anybody
      // has said, so it takes the floor the ordinary way and waits its turn.
      const asking = state.floor ? null : cards.find((c) => c.level !== SHELF);
      state.shelf = [...state.shelf, ...cards.filter((c) => c !== asking)];
      if (asking) {
        const raised = merged.find((m) => m.claim === asking.claim) || null;
        state.floor = {
          card: asking,
          candidate: raised,
          observerId: asking.observerIds[0],
          observerName: (local.find((t) => t.agentId === asking.observerIds[0]) || {}).name || 'An observer',
          requestedAt: Date.now(),
          // What the room had already said when this was raised, so the
          // re-grounding pass can tell the observer what it has missed.
          seen: new Set(history.map((h) => h.id)),
          // Not granted. This is the whole difference between asking and
          // speaking, and it is a field rather than an inference so that no path
          // can arrive at admit() without somebody having said yes.
          granted: false,
        };
      }
      publishWatch(sessionId, state);
      return cards;
    } catch (err) {
      // A pass that fell over costs nothing and says nothing. Human chat and
      // every other mode are untouched by it, which is the property that matters
      // most about this whole path.
      console.error('[sessions] an observer pass failed:', err.message);
      return null;
    } finally {
      state.thinking = false;
    }
  }

  // ---- the soft floor ----
  //
  // An idea good enough that waiting for somebody to look at the shelf would
  // cost something, but not so urgent it may cut across a sentence. It asks.
  //
  // Three things have to be true before it speaks, and they are checked in this
  // order because they get more expensive:
  //
  //  1. There is a seam — nobody typing, nothing just said, no agent answering,
  //     and no observer having spoken since the last person did.
  //  2. The claim still stands against everything said since it was raised.
  //  3. The words exist. They are generated *now*, after admission, and never
  //     before: a paragraph written ten turns ago and held in a queue is a
  //     paragraph about a conversation that has moved on.
  //
  // If no seam arrives before its patience runs out, it stops waiting and
  // becomes an ordinary card. Nothing is lost — the idea was worth having and
  // still is; what ended was its claim on the next gap.

  const FLOOR_TICK_MS = 1500;

  function floorState(state) {
    if (!state.floor) state.floor = null;
    return state.floor;
  }

  // Whether an observer may take an unsolicited turn at this instant.
  function seamNow(sessionId, state) {
    const round = rounds.get(sessionId);
    // One unsolicited turn, then wait for a person.
    //
    // Deliberately separate from the cooldown inside seamOpen, because the two
    // rules are about different things and neither implies the other. The
    // cooldown is a clock: it stops a second contribution arriving hard on the
    // heels of the first. This is a conversation rule: however long it has been,
    // an observer that has spoken does not speak again until somebody has
    // answered it. Without this, a room left alone for two minutes would come
    // back to two observer turns in a row talking to each other.
    if (turnSpent({ spokeAt: state.lastSpokeAt, lastHumanAt: state.lastHumanAt })) return false;
    return seamOpen({
      typing: state.typing,
      lastHumanAt: state.lastHumanAt,
      lastHumanText: state.lastHumanText,
      // An agent mid-answer is an agent being listened to. Reading the live
      // round rather than a flag of our own, so there is one answer to "is
      // something already speaking" rather than two that can disagree.
      streaming: Boolean(round && round.open),
      lastSpokeAt: state.lastSpokeAt,
    });
  }

  // Waiting for a gap, and taking it.
  function waitForSeam(sessionId) {
    const state = watchStateFor(sessionId);
    if (state.timer) return;
    state.timer = setInterval(() => {
      const floor = floorState(state);
      if (!floor) {
        clearInterval(state.timer);
        state.timer = null;
        return;
      }
      // Patience ran out. The request stops waiting and joins the shelf, which
      // is a demotion rather than a deletion — see the comment above.
      if (seamStarved(floor.requestedAt)) {
        state.floor = null;
        state.shelf = [...state.shelf, { ...floor.card, starved: true }];
        clearInterval(state.timer);
        state.timer = null;
        publishWatch(sessionId, state);
        return;
      }
      // Asked, and not yet answered. The request stands until the person says
      // yes, says no, or the conversation moves past it — a seam is when it may
      // *speak*, never permission to.
      if (!floor.granted) return;
      if (!seamNow(sessionId, state)) return;
      clearInterval(state.timer);
      state.timer = null;
      Promise.resolve(admit(sessionId)).catch((err) => {
        console.error('[sessions] an admitted turn failed:', err.message);
      });
    }, FLOOR_TICK_MS);
    if (state.timer.unref) state.timer.unref();
  }

  // The floor was granted. Say it — if it is still worth saying.
  async function admit(sessionId) {
    const state = watchStateFor(sessionId);
    const floor = floorState(state);
    if (!floor) return null;
    const record = get(sessionId);
    if (!record || record.mode !== OBSERVER_MODE) {
      state.floor = null;
      return null;
    }
    state.floor = null;

    const history = roomHistory(sessionId);
    // Everything said since the request went in. Handed to the prompt so the
    // observer can withdraw in one sentence if the room has already covered it —
    // an observer that says something already answered is the fastest way to
    // teach somebody never to grant the floor again.
    const since = history
      .filter((h) => !floor.seen.has(h.id))
      .map((h) => `${h.name}: ${h.text}`)
      .join('\n');

    const said = await agentHub.consult(
      floor.observerId,
      admittedPrompt({ candidate: floor.candidate, frame: state.frame, history, since })
    );
    const text = String(said == null ? '' : said).trim();
    // Nothing usable. The floor was granted and handed back, which costs one run
    // and says nothing — the correct outcome for an observer that thought better
    // of it.
    if (!text) {
      publishWatch(sessionId, state);
      return null;
    }

    // One unsolicited turn, and the clock that enforces the next one starting
    // from here.
    state.lastSpokeAt = Date.now();
    const message = {
      id: crypto.randomUUID(),
      peerId: sessionId,
      direction: 'in',
      kind: 'text',
      text,
      ts: Date.now(),
      speaker: floor.observerName,
      agentId: floor.observerId,
    };
    if (bus) bus.emit('session-said', { sessionId, message });
    sessions.touch(sessionId);
    publishWatch(sessionId, state);
    return message;
  }

  function publishWatch(sessionId, state) {
    if (!bus) return;
    bus.emit('session-observer', {
      sessionId,
      shelf: state.shelf.map((c) => ({ ...c })),
      // What is asking to be heard, if anything. The claim travels with it: a
      // request that hid what it wanted to say would be a notification with
      // extra friction, and there would be nothing to decide on.
      floor: state.floor
        ? {
            id: state.floor.card.id,
            who: state.floor.observerName,
            claim: state.floor.card.claim,
            category: state.floor.card.category,
            granted: state.floor.granted === true,
          }
        : null,
      plan: {
        version: state.frame.version,
        goal: state.frame.goal,
        concrete: concrete(state.frame),
      },
    });
  }

  // Taking a card off the shelf, or putting it out of sight.
  //
  // Hiding and dismissing are the same act here, which they would not be in a
  // room with several people in it: there is one person, and their opinion of a
  // card is the room's.
  function shelfAction(sessionId, cardId, action) {
    const state = watching.get(sessionId);
    if (!state) return false;
    const card = state.shelf.find((c) => c.id === cardId);
    if (!card) return false;
    if (action === 'hide' || action === 'dismiss') {
      state.shelf = state.shelf.filter((c) => c.id !== cardId);
      publishWatch(sessionId, state);
      return true;
    }
    return false;
  }

  // Answering a request for the floor.
  //
  // Three answers, and they are the three things a person actually wants to say
  // to "may I say something": yes, not now, and no.
  //
  //  hear    — yes. It still waits for a seam before speaking, because granting
  //            the floor is permission rather than an instruction to talk over
  //            whatever is happening this second.
  //  shelf   — not now. It becomes an ordinary card, which is where it would
  //            have gone if it had scored a little lower.
  //  dismiss — no. Gone.
  //
  // Nothing here generates a word. The speech is written after admission and
  // after re-grounding, in admit(), and this only decides whether that happens.
  function floorAction(sessionId, action) {
    const state = watching.get(sessionId);
    if (!state || !state.floor) return false;
    if (action === 'hear') {
      // Idempotent: pressing it twice must not start two clocks, and the second
      // press of an already-granted request is not an error.
      if (state.floor.granted) return true;
      state.floor.granted = true;
      publishWatch(sessionId, state);
      waitForSeam(sessionId);
      return true;
    }
    if (action === 'shelf') {
      state.shelf = [...state.shelf, state.floor.card];
      state.floor = null;
      publishWatch(sessionId, state);
      return true;
    }
    if (action === 'dismiss') {
      state.floor = null;
      publishWatch(sessionId, state);
      return true;
    }
    return false;
  }

  function floorFor(sessionId) {
    const state = watching.get(sessionId);
    if (!state || !state.floor) return null;
    return {
      id: state.floor.card.id,
      who: state.floor.observerName,
      claim: state.floor.card.claim,
      category: state.floor.card.category,
      granted: state.floor.granted === true,
    };
  }

  function shelfFor(sessionId) {
    const state = watching.get(sessionId);
    return state ? state.shelf.map((c) => ({ ...c })) : [];
  }

  // ---- a Human Like cycle ----
  //
  // Three parts, in a rolled order, each giving every agent exactly one turn.
  // The whole of it sits above the per-mode machinery rather than inside it: a
  // segment picks its next speaker and dispatches, and when it runs out the next
  // segment starts. What each speaker is *shown* is still decided by
  // questionFor, using the same relay and dialogue builders the older modes use,
  // so a cycle is genuinely those modes rather than an imitation of them.

  function segmentOf(round) {
    return round.segments.length ? round.segments[round.segmentAt] || null : null;
  }

  // Hand the floor to the next agent in the current part, or move on.
  //
  // The one place a cycle spends a turn, so no path can wear the budget down by
  // forgetting to count — the same reason takeTurn exists for a discussion.
  function startSegment(round) {
    const segment = segmentOf(round);
    if (!segment) {
      closeRound(round, CYCLED);
      return null;
    }
    const next = nextInSegment(segment, round.left);
    if (!next) return advanceSegment(round);
    segment.spoken.push(next.agentId);
    round.turn += 1;
    round.speaking = next.agentId;
    // Dispatched before the window is told, for the reason takeTurn gives: it is
    // dispatch that puts an agent into `running`, so publishing first would send
    // a view with nobody thinking in it. It may also close the round from under
    // us when an agent is refused at the door, which is why every publish after
    // a dispatch in this file is guarded.
    dispatch(round, next);
    return round.open ? view(round) : null;
  }

  // This part is finished; start the next, or finish the cycle.
  function advanceSegment(round) {
    round.segmentAt += 1;
    if (round.segmentAt >= round.segments.length) {
      closeRound(round, CYCLED);
      return null;
    }
    const segment = segmentOf(round);
    // Said once, as it happens, and never stored — the same rule every other
    // notice a session produces follows. It names the part and the shuffle,
    // because the order was rolled and somebody watching two questions run
    // differently should be able to see that is what happened.
    const notice = segmentNotice(segment, {
      index: round.segmentAt,
      of: round.segments.length,
      arrangement: round.arrangement,
    });
    if (notice) round.notices.push(notice);
    return startSegment(round);
  }

  // The next agent in a relay, or the end of the round.
  function dispatchNext(round) {
    const next = round.queue.shift();
    if (!next) {
      if (round.running.size === 0) closeRound(round);
      return;
    }
    dispatch(round, next);
    if (round.open) publish(round);
  }

  // Hands the floor to whoever is next in a discussion.
  //
  // The one place a turn is actually spent, so the budget cannot be worn down by
  // a path that forgot to count. Reached from noteOutcome when the previous
  // speaker reports, and from resumeRound when the person gives the floor back.
  function takeTurn(round) {
    const next = round.nextUp;
    if (!next) return null;
    round.nextUp = null;
    round.turn += 1;
    round.speaking = next.agentId;
    // Dispatched before the window is told, and in that order: dispatch() is what
    // puts the next agent into `running`, so publishing first would send a view
    // with nobody thinking in it — for the whole discussion, since every turn
    // passes through here. It may also close the round from underneath us if that
    // agent is refused at the door, which is why the publish below is guarded
    // rather than unconditional.
    dispatch(round, next);
    if (!round.open) return null;
    publish(round);
    return view(round);
  }

  // One agent's run is over: it answered, it failed, or it finished with nothing
  // in it.
  //
  // The one funnel every ending comes through, whichever of the four routes it
  // arrived by (see ipc.js). A round has to know when it is finished, and
  // "finished" is not a thing any single reply can tell you when three of them
  // are outstanding.
  function noteOutcome({ threadId, agentId, kind, text = '' } = {}) {
    const round = rounds.get(threadId);
    if (!round || !round.open) return null;
    // Somebody this round is not waiting on. A notice, a stray answer arriving
    // after the round closed and reopened, an agent that already reported: none
    // of them end anything.
    if (!round.running.has(agentId)) return null;
    const who = round.asked.find((t) => t.agentId === agentId);
    round.running.delete(agentId);
    round.lastAt = Date.now();
    if (kind === 'answer') {
      round.answers.push({ agentId, name: (who && who.name) || 'an agent', text, ts: Date.now() });
      // And into the discussion proper. Only what was actually said: a run that
      // failed or came back empty is an outcome, recorded above, but it is not a
      // turn anybody can reply to and quoting an absence to the next speaker
      // would be inventing one.
      round.history.push(
        agentMessage({
          text,
          contextId: round.sessionId,
          taskId: round.id,
          agentId,
          agentName: (who && who.name) || null,
          turn: round.turn,
        })
      );
    } else if (kind === 'empty') round.empty.add(agentId);
    else round.failed.add(agentId);

    // A discussion decides here whether there is another turn in it, and who
    // takes it.
    //
    // One invariant, and everything below is it: **a discussion runs while at
    // least two agents are still in it and the budget is unspent.**
    //
    // It used to be that any one agent signing off, going quiet or failing ended
    // the round outright. For two that is the same rule — drop one of two and
    // nobody is left to talk to — but for four it threw away a conversation
    // three agents were still having. So an agent that stops now leaves, the
    // rest carry on, and the round ends when the room does.
    // A cycle decides here whether this part has anybody left in it.
    //
    // Above the dialogue branch and entered only when a cycle planned segments,
    // so the four modes that came before take exactly the paths they always did.
    // The rule is simpler than a discussion's because the hard part was settled
    // in advance: a part has a queue, the queue is every agent once, and when it
    // empties the part is over. Nothing here can extend a part or hand an agent
    // a second turn in one.
    if (round.segments.length) {
      round.speaking = null;
      // An agent that could not answer, said nothing, or signed off leaves the
      // room for the rest of the cycle — including the parts that have not run
      // yet. Asking it again in the next part would spend a peer's fair share on
      // a question already known to be unanswerable, and would put "could not
      // answer" in the transcript three times for one failure.
      //
      // Declining the watching turn is the exception, and it is the whole point
      // of that part. An observer asked "say something, or say nothing" and
      // answering nothing has done exactly what was asked — treating that as an
      // agent going quiet would drop it out of the parts still to come and,
      // where it was the last one left, end the cycle for having behaved
      // correctly.
      const watching = segmentOf(round) && segmentOf(round).kind === OBSERVE;
      const declined = watching && kind === 'empty';
      const departed =
        declined || kind === 'answer'
          ? converged(text)
            ? 'converged'
            : null
          : kind === 'empty'
            ? 'silence'
            : 'error';
      if (departed) {
        round.left.add(agentId);
        const still = remaining(round.asked, round.left);
        const notice = still.length
          ? leftNotice((who && who.name) || null, departed, still.length)
          : finalLeftNotice((who && who.name) || null, departed);
        if (notice) round.notices.push(notice);
        // Nobody left at all. The cycle stops rather than running two more
        // empty parts.
        if (still.length === 0) {
          closeRound(round, 'dwindled');
          return null;
        }
      }
      const next = startSegment(round);
      if (!round.open) return null;
      publish(round);
      return next || view(round);
    }

    if (round.mode === 'dialogue') {
      round.speaking = null;
      // What this agent just did, if it means it is finished. Nothing came back
      // (silence, or a failure — including an agent refused at the door, which is
      // how a peer's fair-share quota running out leaves a cross-machine
      // discussion rather than stalling it), or it said it was done and is taken
      // at its word: the whole reason the closing line is asked for is so an
      // agent with nothing to add stops spending turns on saying so.
      const departed =
        kind !== 'answer' ? (kind === 'empty' ? 'silence' : 'error') : converged(text) ? 'converged' : null;

      if (departed) {
        round.left.add(agentId);
        const still = remaining(round.order, round.left);
        if (still.length < 2) {
          // Nobody left to have a discussion with. Which sentence to end on: if
          // this is the only agent that ever left, it is that agent's doing and
          // is named as such — which is exactly what a discussion of two has
          // always said. If others went before it, the discussion emptied out
          // rather than being ended by anybody, and says so.
          const emptied = round.left.size > 1;
          // Either way, what this last one did is still worth recording. The
          // ending says the room emptied; only this says why the one that
          // emptied it went.
          if (emptied) {
            const last = finalLeftNotice((who && who.name) || null, departed);
            if (last) round.notices.push(last);
          }
          closeRound(round, emptied ? 'dwindled' : departed);
          return null;
        }
        // The rest have the floor. Said once, now, while it is true — never
        // stored, like every other notice a session produces.
        const notice = leftNotice((who && who.name) || null, departed, still.length);
        if (notice) round.notices.push(notice);
      }

      // The budget. The one ending that is not a judgement about the discussion,
      // and the only one that cannot be talked out of.
      if (round.turn >= round.cap) {
        closeRound(round, 'spent');
        return null;
      }
      const next = nextSpeaker(round.order, agentId, round.left);
      // Unreachable by the check above — an agent that did not depart is still on
      // the rota, so there is always somebody to hand the floor to. Guarded
      // anyway, because the alternative to a wrong answer here is a crash in
      // dispatch(), and a discussion that quietly ends is the better of the two.
      if (!next) {
        closeRound(round, 'dwindled');
        return null;
      }
      // Whose turn it is. Recorded before it is taken, because it may not be
      // taken yet: a paused discussion has worked out who speaks next and is
      // waiting for the person to finish saying whatever made them pause it.
      round.nextUp = next;
      if (round.paused) {
        publish(round);
        return view(round);
      }
      return takeTurn(round);
    }

    if (round.queue.length) {
      publish(round);
      dispatchNext(round);
      return round.open ? view(round) : null;
    }
    if (round.running.size === 0) {
      closeRound(round);
      return null;
    }
    publish(round);
    return view(round);
  }

  // Calling off whatever this session has out.
  //
  // The button behind a discussion that is going nowhere, and the reason a cap
  // is not the only thing standing between two agents and an afternoon of each
  // other's company: a budget is a number chosen in advance, and this is the
  // person watching it happen deciding they have seen enough.
  //
  // A local agent has a door for interrupting a run. One a peer shared does not —
  // the question is on somebody else's machine and only they can call it off — so
  // that run is abandoned rather than stopped, and the answer that eventually
  // arrives is dropped by the guard at the top of noteOutcome, which stopped
  // waiting for it the moment this closed the round.
  function stopRound(sessionId) {
    const round = rounds.get(sessionId);
    if (!round || !round.open) return false;
    for (const agentId of round.running) {
      const remote = remoteAgents && remoteAgents.resolveThread(agentId);
      if (remote || !agentHub) continue;
      // Not awaited: the round is over either way, and a transport that is slow
      // to come back down must not hold up the window being told so.
      Promise.resolve(agentHub.stopRun(agentId)).catch((err) => {
        console.error('[sessions] could not stop a run:', err.message);
      });
    }
    closeRound(round, 'stopped');
    return true;
  }

  // ---- speaking into a discussion, and picking it back up ----
  //
  // Stop is final: the round closes and whatever budget was left is gone. That
  // is the right answer to "this is going nowhere" and the wrong one to "wait —
  // not that", which is the far commoner thing to want while watching four
  // agents talk. These three are that second thing.
  //
  // Only a dialogue has any of it. Every other mode is one lap and is finished
  // by the time somebody could sensibly interrupt it; a discussion runs for a
  // dozen turns without anybody typing, which is precisely why it needs a way in.

  // Hold the floor. The agent mid-answer is left to finish — its reply is worth
  // having and cutting it off would lose it — and the turn after that one is
  // worked out and not taken.
  function pauseRound(sessionId) {
    const round = rounds.get(sessionId);
    if (!round || !round.open || round.mode !== 'dialogue' || round.paused) return false;
    round.paused = true;
    round.lastAt = Date.now();
    publish(round);
    return true;
  }

  // And give it back. The budget is untouched — pausing is not a turn, and a
  // discussion resumed is the same discussion rather than a shorter one.
  function resumeRound(sessionId) {
    const round = rounds.get(sessionId);
    if (!round || !round.open || !round.paused) return false;
    round.paused = false;
    round.lastAt = Date.now();
    // Nobody is waiting to speak if the pause landed while an agent was still
    // answering: that agent reports in the ordinary way and the discussion picks
    // itself up from there.
    if (round.nextUp) takeTurn(round);
    else publish(round);
    return true;
  }

  // Something the person said into the middle of a discussion.
  //
  // Written into the transcript as an ordinary message of theirs, because that
  // is what it is, and added to the discussion record as a turn with the `user`
  // role — which is the whole reason the record is A2A-shaped. The next speaker
  // is shown it the same way it is shown everything else, so nothing here has to
  // reach into the prompt builder and no path exists for the person's words to
  // be shown to one agent and not another.
  //
  // It does not spend a turn. The budget counts what the agents say; a person
  // saying "not that" has not used one of their replies up.
  function interject(round, text, docs, context) {
    const quoted = contextRecord(context);
    const message = {
      id: crypto.randomUUID(),
      peerId: round.sessionId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
      ...(quoted && { context: quoted }),
    };
    store.append(round.sessionId, message);
    sessions.touch(round.sessionId);

    // Documents handed over mid-discussion join the ones the round was started
    // with, so every turn from here on carries them. An attachment shown to the
    // next agent and not the one after would be a discussion where two agents
    // read different papers.
    if (docs.length) round.docs = [...round.docs, ...docs];

    round.history.push(
      userMessage({
        text: composeContext(quoted, text),
        contextId: round.sessionId,
        taskId: round.id,
        turn: round.turn,
      })
    );
    round.lastAt = Date.now();

    // Speaking into a paused discussion is how you start it again. Anything else
    // would leave somebody who had paused it, said their piece, and expected it
    // to carry on staring at a discussion that never moved.
    if (round.paused) resumeRound(round.sessionId);
    else publish(round);

    return { ...message, delivered: true };
  }

  // The round a session currently has out, for anything that needs to know
  // whether it is waiting — and for a window that opened after the round started.
  function roundFor(sessionId) {
    const round = rounds.get(sessionId);
    return round && round.open ? view(round) : null;
  }

  // ---- import ----

  // Loads a transcript into a session. The text arrives already read from disk:
  // dialogs and files belong to ipc.js, and keeping them out of here is what
  // lets the whole of the parsing be tested without a window.
  function importText(sessionId, raw, { source = null, at = Date.now() } = {}) {
    const record = get(sessionId);
    if (!record) return { ok: false, error: 'That session no longer exists.' };

    const parsed = parseTranscript(raw, { at });
    if (!parsed.messages.length) return { ok: false, error: 'There is no readable text in that file.' };

    for (const m of parsed.messages) {
      store.append(sessionId, {
        id: crypto.randomUUID(),
        peerId: sessionId,
        direction: m.direction,
        kind: 'text',
        text: m.text,
        ts: m.ts,
        // What marks these apart from the conversation the session goes on to
        // have: they were not said here, and the bubble says so rather than
        // letting an import pass itself off as something the agent replied.
        imported: true,
        ...(m.speaker && { speaker: m.speaker }),
        ...(source && { source }),
      });
    }
    // A session named by nobody takes the name of the first thing put in it, so
    // the sidebar reads as a list of subjects rather than a list of "New
    // Session".
    if (record.title === DEFAULT_TITLE && source) sessions.update(sessionId, { title: titleFrom(source) });
    else sessions.touch(sessionId);

    return {
      ok: true,
      mode: parsed.mode,
      count: parsed.messages.length,
      source,
      title: sessions.get(sessionId).title,
    };
  }

  // `LanChat Server 2026-07-30.txt` reads better as `LanChat Server 2026-07-30`.
  function titleFrom(source) {
    return String(source).replace(/\.[^.]+$/, '');
  }

  return {
    list,
    get,
    create,
    rename,
    listFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    placeSession,
    setAgent,
    setCounsel,
    listTrash,
    trash,
    restore,
    purge,
    restoreAll,
    purgeAll,
    unbindAgent,
    sweepErrors,
    send,
    noteOutcome,
    stopRound,
    pauseRound,
    resumeRound,
    roundFor,
    shelfFor,
    shelfAction,
    floorFor,
    floorAction,
    invitePeer,
    removePeer,
    onInvite,
    answerInvite,
    onInviteReply,
    onSync,
    onRoomChat,
    onRoomLeave,
    askable,
    importText,
    isSessionId,
  };
}

module.exports = { createSessions, isSessionId, ROUND_IDLE_MS };
