'use strict';

const crypto = require('node:crypto');
const { SessionRegistry, isSessionId, DEFAULT_TITLE } = require('./registry.js');
const { parseTranscript } = require('./transcript.js');
const { composeContext, contextRecord } = require('./prompt.js');

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
// new code, and the agent it asks answers into it the same way an agent answers
// any other thread.

function createSessions({ userDataDir, store, agentHub, remoteAgents, registry }) {
  const sessions = registry || new SessionRegistry(userDataDir);

  function list() {
    return sessions.list();
  }

  function get(id) {
    return sessions.get(id);
  }

  function create(draft = {}) {
    return sessions.create(draft);
  }

  function rename(id, title) {
    return sessions.update(id, { title });
  }

  function setAgent(id, agentId) {
    return sessions.update(id, { agentId: agentId || null });
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
    const record = sessions.get(sessionId);
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

  // Removing a session takes its conversation with it. The record and the
  // transcript are two halves of one thing, and leaving the history file behind
  // would keep a deleted workspace on disk under a name nothing points at any
  // more.
  function remove(id) {
    if (!sessions.get(id)) return false;
    store.clear(id);
    return sessions.remove(id);
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

  // Asks this session's agent, whether it is one of ours or one a peer shared.
  //
  // `prompt` is what the agent is asked and `text` is what the person typed;
  // they differ when documents are attached or a fork quoted something, and the
  // split is the point — a transcript should hold the question, not the pages
  // that went with it.
  function send(sessionId, text, { prompt, docs = [], context = null } = {}) {
    const record = sessions.get(sessionId);
    if (!record) return refuse(sessionId, text, docs, 'That session no longer exists.');
    if (!record.agentId) {
      return refuse(sessionId, text, docs, 'Choose an agent for this session before asking it something.');
    }

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

    // An agent a peer shared with us. The question travels to its owner, and the
    // answer is routed back to this session rather than to the agent's own
    // thread — see `pendingThread` in agents/remote.js for how, and why that is
    // safe.
    const remote = remoteAgents && remoteAgents.resolveThread(record.agentId);
    if (remote) {
      const sent = remoteAgents.send(remote.ownerPeerId, remote.entry, text, {
        prompt: composed,
        docs,
        thread: sessionId,
        context: quoted,
      });
      if (!sent.rejected) sessions.touch(sessionId);
      return sent;
    }

    // One of ours.
    if (!agentHub || !agentHub.isAgent(record.agentId)) {
      return refuse(sessionId, text, docs, 'The agent this session asks is not available any more.');
    }
    // Checked before the bubble is written, so a switched-off agent refuses
    // without leaving a question in the transcript that nothing will ever
    // answer.
    if (!agentHub.isRunning(record.agentId))
      return refuse(sessionId, text, docs, 'That agent is switched off.');
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
    // Written down before it is asked, and in that order: a transport that
    // answers immediately would otherwise have its reply filed above the
    // question it was answering.
    store.append(sessionId, message);
    sessions.touch(sessionId);
    // `ref` is what makes a failure attributable: if this run errors, the error
    // comes back naming this message, and this message stops counting as a
    // question that was answered.
    agentHub.ask(record.agentId, composed, { thread: sessionId, ref: message.id });
    return { ...message, delivered: true };
  }

  // ---- import ----

  // Loads a transcript into a session. The text arrives already read from disk:
  // dialogs and files belong to ipc.js, and keeping them out of here is what
  // lets the whole of the parsing be tested without a window.
  function importText(sessionId, raw, { source = null, at = Date.now() } = {}) {
    const record = sessions.get(sessionId);
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
    setAgent,
    remove,
    unbindAgent,
    sweepErrors,
    send,
    importText,
    isSessionId,
  };
}

module.exports = { createSessions, isSessionId };
