'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Sessions: a titled local workspace that holds a conversation, can be loaded
// from a saved transcript, and asks an agent about any part of it.
//
// Three things are worth proving and none of them are provable by reading the
// code: that a transcript survives the round trip out to text and back; that an
// answer to a question a session asked is filed in that session rather than in
// the agent's own thread; and that a session id — which is now a thread the app
// stores messages under — cannot be claimed by anything off the wire.
//
// ipc.js is under test as much as the session code is, so electron is stubbed
// rather than avoided, the same way agentshare.test.js does it.
const handlers = new Map();
let openTo = null; // the file the stubbed open dialog pretends the user chose

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: {
      showOpenDialog: async () => (openTo ? { canceled: false, filePaths: [openTo] } : { canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { buildIdentity, buildPublicCard } = require('../src/main/identity.js');
const { createServer } = require('../src/main/server.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub, LOCAL_ORIGIN } = require('../src/main/agents/index.js');
const { createRemoteAgents } = require('../src/main/agents/remote.js');
const { createIpc } = require('../src/main/ipc.js');
const { SessionRegistry } = require('../src/main/sessions/registry.js');
const { parseTranscript } = require('../src/main/sessions/transcript.js');
const { composeContext } = require('../src/main/sessions/prompt.js');

// The Commit box's arithmetic, as the window does it. Asserted here against a
// real session on disk, because the number is made of two things that live in
// different places — the messages, and the correction on the record — and the
// bug worth catching is them disagreeing. ESM for the renderer, so it is
// evaluated rather than imported.
const { commitCount } = new Function(
  `${fs
    .readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'sessionStanding.js'), 'utf8')
    .replace(/^export\s+/gm, '')}
   return { commitCount };`
)();

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

function echoTransports(log) {
  return {
    http: ({ id, name }) => ({
      id,
      name,
      kind: 'stub',
      start: async () => ({ detail: 'ready' }),
      send: async ({ text }, h) => {
        log.push(text);
        // A run that fails rather than answering — an ACP prompt that timed out,
        // in the shape the real transport reports it. `fail:now` fails whoever is
        // asked; `fail:<Name>` fails only that one, which is what lets a counsel
        // be tested with some of it answering and some of it not.
        if (text.includes('fail:now') || text.includes(`fail:${name}`)) {
          h.onError?.(new Error("ACP call 'session/prompt' timed out."));
          return;
        }
        // A run that starts and does not finish, for proving what a session does
        // while it is still waiting. Never answered, never failed — the state a
        // real agent is in while it thinks.
        if (text.includes('hold:now')) return;
        h.onDone?.({ text: `echo:${text}` });
      },
      stop: async () => {},
    }),
  };
}

// One machine's worth of wiring. With a port, it can also be talked to: the
// shared-agent test below runs two of these over a real socket, because the
// thing being proved there is exactly the part that crosses one.
function makeNode(name, port = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-session-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port || 0 });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const getPublicCard = () => buildPublicCard(config, deviceKey);
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const server = port
    ? createServer({
        config,
        getIdentity,
        getPublicCard,
        deviceKey,
        pins,
        hub,
        bus,
        downloadsDir: path.join(dir, 'dl'),
      })
    : null;
  const store = new MessageStore(dir);
  const log = [];
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: echoTransports(log),
  });

  const events = [];
  handlers.clear();
  createIpc({
    config,
    getIdentity,
    hub,
    bus,
    store,
    fileSender: { send: async () => ({}) },
    discovery: { peers: () => [], refresh: () => {} },
    updater: null,
    linkStats: null,
    pip: null,
    agentHub,
    outbox: { enqueue: () => {}, pendingCount: () => 0, counts: () => ({}) },
    userDataDir: dir,
    downloadsDir: path.join(dir, 'dl'),
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (_c, payload) => events.push(payload) },
    }),
    revealWindow: () => {},
    applyLoginItem: () => {},
    onUnread: () => {},
  });
  const own = new Map(handlers);
  const call = (channel, arg) => own.get(channel)(null, arg);

  return { dir, bus, hub, server, store, agentHub, log, events, call, port, getIdentity };
}

// Ports are asked for rather than hardcoded: `node --test` runs files at the
// same time and a just-closed listener lingers in TIME_WAIT, so a fixed number
// collides with EADDRINUSE and looks like a product failure it is not.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitFor(fn, timeout = 5000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let v;
      try {
        v = fn();
      } catch {
        v = false;
      }
      if (v) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 20);
  });
}

// --------------------------------------------------------- reading a transcript

// Exactly what `lanchat:exportHistory` writes, down to the blank line after the
// header. If the exporter ever changes shape, this fixture is what notices.
const EXPORT = [
  'Chat history with Hermes',
  'Exported 30/07/2026, 09:41:02 from LanChat',
  '',
  '--- Wed Jul 29 2026 ---',
  '[09:34] Macmini: why did the turn move?',
  '[09:35] Hermes: Because the holder went quiet.',
  'The queue hands on after a minute of silence,',
  'and the next asker is told straight away.',
  '[09:36] Hermes (via peer): what did you decide?',
  '--- Thu Jul 30 2026 ---',
  '[10:02] Macmini: thanks',
  '',
].join('\n');

test('an exported conversation comes back with its speakers, its days and its clock', () => {
  const { mode, peer, messages } = parseTranscript(EXPORT);
  assert.equal(mode, 'lanchat');
  assert.equal(peer, 'Hermes');
  assert.equal(messages.length, 4);

  assert.deepEqual(
    messages.map((m) => `${m.direction}:${m.speaker}`),
    ['out:Macmini', 'in:Hermes', 'in:Hermes (via peer)', 'out:Macmini'],
    'the header names the far end, so anything under that name came in'
  );

  // The whole reason continuation lines are handled: an agent's answer is
  // exported with its newlines in it, and a parser that read only the prefixed
  // line would keep the first sentence and throw the answer away.
  assert.equal(
    messages[1].text,
    'Because the holder went quiet.\nThe queue hands on after a minute of silence,\nand the next asker is told straight away.'
  );

  const first = new Date(messages[0].ts);
  assert.equal(first.getFullYear(), 2026);
  assert.equal(first.getMonth(), 6); // July
  assert.equal(first.getDate(), 29);
  assert.equal(first.getHours(), 9);
  assert.equal(first.getMinutes(), 34);
  // The second day separator has to move the clock, or every message would be
  // filed on the first day of the transcript.
  assert.equal(new Date(messages[3].ts).getDate(), 30);
});

test('a twelve-hour clock is read as the time it means', () => {
  const { messages } = parseTranscript(
    [
      'Chat history with Server',
      'Exported x from LanChat',
      '',
      '--- Wed Jul 29 2026 ---',
      '[01:05 PM] Server: hi',
    ].join('\n')
  );
  assert.equal(new Date(messages[0].ts).getHours(), 13);
});

test('any other text file loads as blocks rather than being refused', () => {
  const at = Date.parse('2026-07-01T12:00:00Z');
  const { mode, messages } = parseTranscript('first note\nwith two lines\n\n\nsecond note\n', { at });
  assert.equal(mode, 'text');
  assert.deepEqual(
    messages.map((m) => m.text),
    ['first note\nwith two lines', 'second note']
  );
  assert.ok(messages[0].ts < messages[1].ts, 'blocks read in the order they were written');
  assert.equal(messages[1].ts, at, 'and end at the time the file was last written');
});

test('a file with nothing in it produces nothing rather than an empty bubble', () => {
  assert.deepEqual(parseTranscript('   \n\n  ').messages, []);
});

// ------------------------------------------------------------------ the record

test('a session is remembered, renamed and deleted on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-sessreg-'));
  const registry = new SessionRegistry(dir);

  const made = registry.create({});
  assert.equal(made.title, 'New Session', 'a session has a name before anybody gives it one');
  assert.equal(made.agentId, null);
  assert.ok(made.id.startsWith('session:'));

  registry.update(made.id, { title: '  turn\n fairness  ', agentId: 'agent:1' });
  const back = new SessionRegistry(dir).get(made.id);
  assert.equal(back.title, 'turn fairness', 'a title is one line, trimmed');
  assert.equal(back.agentId, 'agent:1');

  registry.update(made.id, { title: '   ' });
  assert.equal(registry.get(made.id).title, 'New Session', 'edited down to nothing, it takes its name back');

  registry.unbindAgent('agent:1');
  assert.equal(registry.get(made.id).agentId, null, 'an agent that no longer exists is not still asked');

  assert.equal(registry.remove(made.id), true);
  assert.deepEqual(new SessionRegistry(dir).list(), []);
});

test('the quoted excerpt travels in the prompt and the question comes last', () => {
  const prompt = composeContext({ text: 'the turn moved', speaker: 'Hermes', ts: null }, 'why?');
  assert.match(
    prompt,
    /^\[Context from an earlier conversation — Hermes\]\n<<<\nthe turn moved\n>>>\n\nwhy\?$/
  );
  assert.equal(composeContext(null, 'why?'), 'why?', 'a question with nothing quoted is left alone');
});

// ------------------------------------------------------- asking from a session

test('a question asked in a session is answered in that session', async () => {
  const A = makeNode('local');
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const session = A.call('lanchat:createSession', { title: 'turn fairness', agentId: agent.id });

  const quoted = {
    text: 'the turn moved after a minute',
    speaker: 'Hermes',
    ts: Date.parse('2026-07-29T09:35:00Z'),
  };
  const sent = A.call('lanchat:sendChat', { peerId: session.id, text: 'why did it move?', context: quoted });
  assert.equal(sent.rejected, undefined);

  await waitFor(() => A.store.read(session.id).length === 2, 5000, 'the answer to land in the session');

  // What was asked, and what was stored, are deliberately not the same thing.
  assert.equal(A.log[0], composeContext(quoted, 'why did it move?'));
  const kept = A.store.read(session.id);
  assert.deepEqual(
    kept.map((m) => `${m.direction}:${m.text}`),
    ['out:why did it move?', `in:echo:${A.log[0]}`],
    'the transcript keeps the question that was typed, not the prompt that was sent'
  );
  assert.equal(
    kept[0].context.text,
    'the turn moved after a minute',
    'and what it was asking about, separately'
  );

  assert.deepEqual(A.store.read(agent.id), [], "the agent's own thread is untouched");

  // The live feedback has to be addressed to the session too, or the window
  // would show another thread thinking while this one sat silent.
  const typing = A.events.filter((e) => e.type === 'typing');
  assert.ok(typing.length >= 2, 'the session is told when the run starts and when it ends');
  assert.ok(
    typing.every((e) => e.payload.peerId === session.id),
    'and nothing is addressed to the agent instead'
  );
});

test('a question that failed is marked as such, and the error explaining it is not kept', async () => {
  const A = makeNode('failed');
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const session = A.call('lanchat:createSession', { title: 'PTT PWA Lan', agentId: agent.id });

  // One question that works, so the difference between the two is what is being
  // proved rather than the whole thread being empty.
  A.call('lanchat:sendChat', { peerId: session.id, text: 'what is the time' });
  await waitFor(() => A.store.read(session.id).length === 2, 5000, 'the first answer');

  const asked = A.call('lanchat:sendChat', { peerId: session.id, text: 'fail:now' });
  const error = await waitFor(
    () => A.events.find((e) => e.type === 'chat' && /timed out/.test(e.payload?.text || ''))?.payload,
    5000,
    'the failure to reach the window'
  );

  // Shown once, with enough on it for the window to count it down and to know
  // which question it was the outcome of.
  assert.ok(error.error, 'the error says it is one');
  assert.equal(error.failedRef, asked.id, 'and names the question that failed');
  assert.match(error.text, /ACP call 'session\/prompt' timed out\./);

  // And then nothing of it survives. The question does — it is what was asked,
  // and it is still there to be re-sent — but it no longer claims to have been
  // answered.
  const kept = A.store.read(session.id);
  assert.deepEqual(
    kept.map((m) => `${m.direction}:${m.text}`),
    ['out:what is the time', `in:echo:${A.log[0]}`, 'out:fail:now'],
    'the error is never written to the session'
  );
  assert.equal(kept.find((m) => m.id === asked.id).failed, true, 'the question it failed is marked');
  assert.equal(kept[0].failed, undefined, 'and the one that was answered is left alone');
});

test('sweeping old errors takes their commits with them, and says the context is gone', async () => {
  const A = makeNode('sweep');
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const session = A.call('lanchat:createSession', { title: 'PTT PWA Lan', agentId: agent.id });

  // Three questions asked, as an older version would have left them: two of them
  // followed by an error it kept, and neither error naming the question it came
  // from — that link did not exist yet, which is the whole problem.
  for (const text of ['one', 'two', 'three']) {
    A.call('lanchat:sendChat', { peerId: session.id, text });
  }
  await waitFor(() => A.store.read(session.id).length === 6, 5000, 'the three answers');
  const legacy = [
    { id: 'old-1', peerId: session.id, direction: 'in', kind: 'text', text: '⚠️ transport is down', ts: 9 },
    { id: 'old-2', peerId: session.id, direction: 'in', kind: 'text', text: '⚠️ transport is down', ts: 10 },
  ];
  for (const m of legacy) A.store.append(session.id, m);

  // Before: the box counts every question, including the two nothing answered.
  const before = A.store.read(session.id);
  assert.equal(commitCount(before), 3);

  const res = A.call('lanchat:sweepSessionErrors', { id: session.id, ids: ['old-1', 'old-2'] });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 2);

  // After: the noise is gone from disk, the questions are not, and the count has
  // come down by exactly the number of errors removed — without anything having
  // guessed which question each belonged to.
  const after = A.store.read(session.id);
  assert.equal(after.filter((m) => (m.text || '').startsWith('⚠️')).length, 0, 'the errors are gone');
  assert.equal(after.filter((m) => m.direction === 'out').length, 3, 'the questions are not');

  const record = A.call('lanchat:listSessions').find((s) => s.id === session.id);
  assert.equal(record.unlinkedFailures, 2);
  assert.equal(commitCount(after) - record.unlinkedFailures, 1, 'three asked, two unanswered, one commit');

  // And the session says it has lost context it cannot put back.
  assert.equal(record.needsContext, true);

  // Sweeping the same ids again must not take the total down twice.
  const again = A.call('lanchat:sweepSessionErrors', { id: session.id, ids: ['old-1', 'old-2'] });
  assert.equal(again.removed, 0);
  assert.equal(
    A.call('lanchat:listSessions').find((s) => s.id === session.id).unlinkedFailures,
    2,
    'the correction is applied once, not once per attempt'
  );

  // Asking something new re-establishes the context, so the warning goes — while
  // the correction, which is about work that was never done, stays.
  A.call('lanchat:sendChat', { peerId: session.id, text: 'four' });
  const fresh = A.call('lanchat:listSessions').find((s) => s.id === session.id);
  assert.equal(fresh.needsContext, false, 'a new question clears the warning');
  assert.equal(fresh.unlinkedFailures, 2, 'but not the correction');
});

test('a session with no agent refuses without swallowing the question', () => {
  const A = makeNode('unbound');
  const session = A.call('lanchat:createSession', {});
  const res = A.call('lanchat:sendChat', { peerId: session.id, text: 'anyone there?' });
  assert.equal(res.rejected, true);
  assert.equal(res.text, 'anyone there?', 'the words come back for the composer');
  assert.equal(res.notice.peerId, session.id);
  assert.equal(res.notice.notice, true, 'the reason is shown once, not written into the transcript');
  assert.deepEqual(A.store.read(session.id), [], 'and nothing is left behind');
});

test('a saved conversation loads into a session, and names it', async () => {
  const A = makeNode('import');
  const session = A.call('lanchat:createSession', {});
  openTo = path.join(A.dir, 'LanChat Hermes 2026-07-29.txt');
  fs.writeFileSync(openTo, EXPORT, 'utf8');

  const res = await A.call('lanchat:importSessionText', { id: session.id });
  openTo = null;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'lanchat');
  assert.equal(res.count, 4);
  assert.equal(
    res.title,
    'LanChat Hermes 2026-07-29',
    'an unnamed session takes the name of what was put in it'
  );

  const loaded = A.store.read(session.id);
  assert.equal(loaded.length, 4);
  assert.ok(
    loaded.every((m) => m.imported === true && m.source === 'LanChat Hermes 2026-07-29.txt'),
    'every imported message says it was imported, and from where'
  );
});

test('a session thread cannot be claimed from the wire', async () => {
  const A = makeNode('guard');
  const session = A.call('lanchat:createSession', {});

  // A frame arriving off a socket, addressed to a local workspace. The `from` a
  // peer is given is its own id, so this is a peer that named itself after one.
  A.bus.emit('peer-message', { from: session.id, type: 'chat', text: 'trust me', ts: Date.now() });
  assert.deepEqual(A.store.read(session.id), [], 'nothing off the wire is written into a session');
  assert.equal(
    A.events.some((e) => e.type === 'chat'),
    false,
    'and nothing is shown either'
  );

  // The same frame, marked as having been produced here. The marker is a Symbol,
  // so JSON.parse cannot forge it.
  A.bus.emit('peer-message', {
    from: session.id,
    type: 'chat',
    text: 'from the agent',
    ts: Date.now(),
    [LOCAL_ORIGIN]: true,
  });
  assert.deepEqual(
    A.store.read(session.id).map((m) => m.text),
    ['from the agent']
  );
});

// ------------------------------------------------- asking a peer's shared agent

// The remote path has no run of its own to follow: the question goes to the
// owner's machine and the answer comes back as a separate frame, with nothing in
// it to say which question it answers. What makes the correlation sound is that
// there is only ever one question outstanding — see send() in agents/remote.js.
function remoteFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-remote-'));
  const store = new MessageStore(dir);
  const sent = [];
  const hub = {
    identities: new Map(),
    presenceList: () => [{ id: 'peer-a', name: 'Server', hostname: 'server' }],
    setIdentity: () => {},
    register: () => {},
    unregister: () => {},
    emitPresence: () => {},
    send: (peerId, frame) => (sent.push({ peerId, frame }), true),
  };
  const remote = createRemoteAgents({ hub, store });
  const entry = remote.adopt('peer-a', { agentId: 'agent:x', name: 'Hermes', directChat: true });
  return { store, remote, entry, sent };
}

test("an answer from a peer's agent lands in the session that asked for it", () => {
  const { store, remote, entry } = remoteFixture();
  const session = 'session:abc';

  remote.send('peer-a', entry, 'why did it move?', { prompt: 'why did it move?', thread: session });
  assert.deepEqual(
    store.read(session).map((m) => m.text),
    ['why did it move?'],
    'the local copy is filed in the session, not in the agent thread'
  );
  assert.deepEqual(store.read(entry.id), []);

  // Queue chatter is about the question that is waiting, so it goes to the same
  // place — but it is not an answer, so it does not end the correlation.
  const notice = remote.receive('peer-a', {
    agentId: 'agent:x',
    text: 'you are second in line',
    notice: true,
  });
  assert.equal(notice.peerId, session);
  assert.equal(entry.pending[0].thread, session, 'still waiting on the real answer');

  const answer = remote.receive('peer-a', { agentId: 'agent:x', text: 'because the holder went quiet' });
  assert.equal(answer.peerId, session);
  assert.deepEqual(
    store.read(session).map((m) => `${m.direction}:${m.text}`),
    ['out:why did it move?', 'in:because the holder went quiet']
  );
  assert.equal(entry.pending.length, 0, 'and the correlation ends with the answer');
  assert.equal(answer.speaker, 'Hermes', 'an answer filed in a session says who gave it');

  // With nothing outstanding, the agent's own thread gets its own traffic back.
  remote.send('peer-a', entry, 'hello there', { prompt: 'hello there' });
  const reply = remote.receive('peer-a', { agentId: 'agent:x', text: 'hello yourself' });
  assert.equal(reply.peerId, entry.id);
  assert.equal(reply.speaker, undefined, "and in the agent's own thread it does not need to");
  assert.deepEqual(
    store.read(entry.id).map((m) => m.text),
    ['hello there', 'hello yourself']
  );
});

// The same thing again, but for real: two nodes, a socket between them, and the
// agent on the far side of it. The unit test above pins the routing rule; this
// one proves the rule survives the wire, which is where a session asking
// somebody else's agent actually lives.
async function connect(from, to) {
  from.hub.connect(to.getIdentity().id, `127.0.0.1:${to.port}`);
  await waitFor(() => from.hub.isConnected(to.getIdentity().id), 5000, 'the socket to open');
  await waitFor(() => to.hub.isConnected(from.getIdentity().id), 5000, 'the reverse registration');
}

test('a session can ask an agent a peer shared, over a real socket', async (t) => {
  const A = makeNode('owner', await freePort());
  const B = makeNode('asker', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(B, A);

  const remoteId = await waitFor(
    () => [...B.hub.identities.keys()].find((k) => k.startsWith(`remote-agent:${idA}:${agent.id}`)),
    5000,
    "B to be told about A's agent"
  );

  const session = B.call('lanchat:createSession', { title: 'why the turn moved', agentId: remoteId });
  const quoted = { text: 'the turn moved after a minute', speaker: 'Hermes', ts: Date.now() };
  B.call('lanchat:sendChat', { peerId: session.id, text: 'why did it move?', context: quoted });

  await waitFor(() => A.log.length === 1, 5000, 'the question to reach the agent');
  assert.equal(A.log[0], composeContext(quoted, 'why did it move?'), 'the excerpt travelled with the question');

  await waitFor(
    () => B.store.read(session.id).some((m) => m.direction === 'in'),
    5000,
    'the answer to come back into the session'
  );
  assert.deepEqual(
    B.store.read(session.id).map((m) => m.direction),
    ['out', 'in'],
    'both halves of the exchange are in the session'
  );
  assert.deepEqual(B.store.read(remoteId), [], "and none of it is in the agent's own thread");
  assert.deepEqual(B.store.read(idA), [], "nor in B's chat with A");

  // The owner still sees what was asked of their agent, filed where it always
  // was: a session is the asker's way of organising their side, and changes
  // nothing about the transparency on the other.
  assert.deepEqual(
    A.store.read(`${agent.id}#${idB}`).map((m) => m.direction),
    ['in', 'in']
  );
});

test('a run that came back empty is signalled in the session that asked', () => {
  const { remote, entry } = remoteFixture();
  remote.send('peer-a', entry, 'anything?', { prompt: 'anything?', thread: 'session:abc' });
  const run = remote.emptyRun('peer-a', 'agent:x');
  assert.equal(run.into, 'session:abc');
  assert.equal(run.agentName, 'Hermes', 'and it says which agent had nothing to say');
  assert.equal(entry.pending.length, 0, 'an empty answer is still an answer');
  assert.equal(remote.emptyRun('peer-a', 'agent:x').into, entry.id);
});

// ------------------------------------------------------------------ a counsel
//
// A session can put one question to several agents at once. Four things are
// worth proving and none of them are readable off the code: that one typed
// sentence stays one question in the transcript however many agents it goes to;
// that each answer says who gave it; that an agent nobody can reach is skipped
// and named rather than stopping the rest; and that a question two agents
// answered is not marked as one that failed because a third did.

// A machine with `n` agents switched on, and a session pointed at all of them.
async function counselNode(name, names, { mode } = {}) {
  const A = makeNode(name);
  const agents = [];
  for (const agentName of names) {
    const { agent } = await A.agentHub.add({ name: agentName, kind: 'http', config: {} });
    agents.push(agent);
  }
  const session = A.call('lanchat:createSession', {});
  A.call('lanchat:setSessionCounsel', {
    id: session.id,
    agentIds: agents.map((a) => a.id),
    ...(mode && { mode }),
  });
  return { A, agents, session };
}

test('one question put to three agents is one question and three answers', async () => {
  const { A, agents, session } = await counselNode('counsel', ['Hermes', 'Tessie', 'Fable']);

  A.call('lanchat:sendChat', { peerId: session.id, text: 'what should we call it?' });
  await waitFor(() => A.store.read(session.id).length === 4, 5000, 'all three answers to land');

  const thread = A.store.read(session.id);
  assert.deepEqual(
    thread.map((m) => m.direction),
    ['out', 'in', 'in', 'in'],
    'one question, three answers — the sentence was typed once'
  );
  assert.equal(commitCount(thread), 1, 'and it counts as one piece of work, not three');
  assert.deepEqual(
    thread.slice(1).map((m) => m.speaker).sort(),
    ['Fable', 'Hermes', 'Tessie'],
    'every answer says which agent gave it'
  );
  assert.deepEqual(
    A.log.sort(),
    ['what should we call it?', 'what should we call it?', 'what should we call it?'],
    'and all three were asked the same thing at the same time'
  );
  assert.equal(agents.length, 3);
});

test('asked in turn, each agent is shown what the last one said', async () => {
  const { A, session } = await counselNode('relay', ['Hermes', 'Tessie'], { mode: 'relay' });

  A.call('lanchat:sendChat', { peerId: session.id, text: 'what should we call it?' });
  await waitFor(() => A.store.read(session.id).length === 3, 5000, 'both answers to land');

  assert.equal(A.log.length, 2, 'two agents, asked once each');
  assert.equal(A.log[0], 'what should we call it?', 'the first is asked the question as typed');
  assert.match(A.log[1], /^\[Answers already given to this question by other agents\]\n<<<\nHermes:\n/);
  assert.match(A.log[1], /echo:what should we call it\?/, "and it can read the first agent's answer");
  assert.match(A.log[1], />>>\n\nwhat should we call it\?$/, 'with the question itself last');
});

test('an agent nobody can reach is skipped and named, and the rest are still asked', async () => {
  const { A, agents, session } = await counselNode('partial', ['Hermes', 'Tessie']);
  await A.agentHub.setEnabled(agents[1].id, false);

  const sent = A.call('lanchat:sendChat', { peerId: session.id, text: 'still there?' });
  assert.equal(sent.rejected, undefined, 'one agent being off does not stop the others');
  assert.match(sent.notice.text, /Tessie was not asked — switched off\./);
  assert.equal(sent.notice.notice, true, 'said once, never written into the transcript');

  await waitFor(() => A.store.read(session.id).length === 2, 5000, "Hermes' answer to land");
  assert.deepEqual(
    A.store.read(session.id).map((m) => m.speaker || null),
    [null, 'Hermes'],
    'and only the agent that was asked answered'
  );
});

test('a question two agents answered is not marked as one that failed', async () => {
  const { A, session } = await counselNode('mixed', ['Hermes', 'Tessie']);

  // Tessie errors rather than answering; Hermes answers normally. The echo
  // transport fails only the agent named in the question.
  A.call('lanchat:sendChat', { peerId: session.id, text: 'fail:Tessie but not the other one' });
  await waitFor(
    () => A.store.read(session.id).some((m) => m.direction === 'in'),
    5000,
    'the answer that did come back'
  );
  await new Promise((r) => setTimeout(r, 50));

  const thread = A.store.read(session.id);
  assert.equal(thread[0].failed, undefined, 'one agent failing does not unmake the answer another gave');
  assert.equal(commitCount(thread), 1, 'so the question still counts as work the session got done');
});

test('a question the whole counsel failed is marked, once, at the end of the round', async () => {
  const { A, session } = await counselNode('allfail', ['Hermes', 'Tessie']);

  A.call('lanchat:sendChat', { peerId: session.id, text: 'fail:now' });
  await waitFor(() => A.store.read(session.id)[0].failed === true, 5000, 'the question to be marked');

  const thread = A.store.read(session.id);
  assert.equal(thread.length, 1, 'the errors themselves are shown and dropped, never kept');
  assert.equal(commitCount(thread), 0, 'and nothing was got out of the agents to count');

  const closed = A.events.filter((e) => e.type === 'session-round' && !e.payload.open).pop();
  assert.equal(closed.payload.failedRef, thread[0].id, 'the window is told which question it was');
  assert.deepEqual(closed.payload.failed.length, 2, 'and that both of them failed');
});

test('a second question waits until the counsel has finished with the first', async () => {
  const { A, session } = await counselNode('busy', ['Hermes', 'Tessie']);

  // Both agents start and neither finishes, so the round stays open.
  const first = A.call('lanchat:sendChat', { peerId: session.id, text: 'hold:now' });
  assert.equal(first.rejected, undefined, 'the first question goes');

  const second = A.call('lanchat:sendChat', { peerId: session.id, text: 'and another thing' });
  assert.equal(second.rejected, true, 'the second is refused rather than interleaved with it');
  assert.equal(second.text, 'and another thing', 'and the words come back for the composer');
  assert.match(second.notice.text, /still answering/);
  assert.deepEqual(
    A.store.read(session.id).map((m) => m.text),
    ['hold:now'],
    'so the transcript holds one question, not two'
  );
});

test('an idle session is not held shut by a round that already finished', async () => {
  const { A, session } = await counselNode('idle', ['Hermes', 'Tessie']);

  A.call('lanchat:sendChat', { peerId: session.id, text: 'first' });
  await waitFor(() => A.store.read(session.id).length === 3, 5000, 'both answers to the first');

  const second = A.call('lanchat:sendChat', { peerId: session.id, text: 'second' });
  assert.equal(second.rejected, undefined, 'a closed round blocks nothing');
});

test('a session set to ask everybody asks whoever is there at the time', async () => {
  const A = makeNode('standing');
  const { agent: hermes } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const session = A.call('lanchat:createSession', {});
  A.call('lanchat:setSessionCounsel', { id: session.id, allAgents: true });

  assert.equal(A.call('lanchat:listSessions')[0].allAgents, true);
  assert.equal(
    A.call('lanchat:listSessions')[0].agentId,
    hermes.id,
    'the one-agent mirror an older build reads is filled in from whoever is here'
  );

  // An agent added after the choice was made is in the counsel, without anything
  // having been written down when it arrived.
  await A.agentHub.add({ name: 'Tessie', kind: 'http', config: {} });
  A.call('lanchat:sendChat', { peerId: session.id, text: 'who is about?' });
  await waitFor(() => A.store.read(session.id).length === 3, 5000, 'both agents to answer');
  assert.deepEqual(
    A.store
      .read(session.id)
      .slice(1)
      .map((m) => m.speaker)
      .sort(),
    ['Hermes', 'Tessie']
  );
});

test('an old record is read as a counsel of one, and a downgrade still finds an agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-oldsess-'));
  const file = path.join(dir, 'sessions.json');
  const before = [
    { id: 'session:old', title: 'why the turn moved', agentId: 'agent:1', createdAt: 1, updatedAt: 2 },
  ];
  fs.writeFileSync(file, JSON.stringify(before, null, 2), 'utf8');

  const registry = new SessionRegistry(dir);
  assert.deepEqual(registry.get('session:old').agentIds, ['agent:1'], 'the one agent it asked is its counsel');
  assert.equal(registry.get('session:old').allAgents, false);
  assert.equal(registry.get('session:old').mode, 'parallel');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(before, null, 2), 'and the file is not rewritten');

  registry.update('session:old', { agentIds: ['agent:2', 'agent:3'] });
  const back = new SessionRegistry(dir).get('session:old');
  assert.deepEqual(back.agentIds, ['agent:2', 'agent:3']);
  assert.equal(back.agentId, 'agent:2', 'an older build reading this file still finds an agent to ask');
});

test('an agent that has gone leaves the counsel, and the rest carry on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-unbind-'));
  const registry = new SessionRegistry(dir);
  const many = registry.create({ agentIds: ['agent:1', 'agent:2', 'agent:3'] });
  const one = registry.create({ agentId: 'agent:2' });
  const standing = registry.create({ allAgents: true });
  const standingBefore = JSON.stringify(registry.get(standing.id));

  assert.equal(registry.unbindAgent('agent:2'), true);
  assert.deepEqual(registry.get(many.id).agentIds, ['agent:1', 'agent:3'], 'one leaves, the others stay');
  assert.equal(registry.get(many.id).agentId, 'agent:1', 'and the mirror follows the head of the list');
  assert.deepEqual(registry.get(one.id).agentIds, [], 'a counsel of one is left with nobody, as it always was');
  assert.equal(registry.get(one.id).agentId, null);
  assert.equal(
    JSON.stringify(registry.get(standing.id)),
    standingBefore,
    'and a session that asks whoever is here is untouched — there is no list to take a name out of'
  );
});

// The counsel, but for real: two machines, a socket between them, and one of the
// agents on the far side of it. The tests above pin the fan-out against local
// agents; this one proves the same round works when half of it is somebody
// else's — which is where a session asking several agents actually lives.
test('a counsel can span this machine and a peer, over a real socket', async (t) => {
  const A = makeNode('owner', await freePort());
  const B = makeNode('asker', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const { agent: theirs } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(theirs.id, { networkWide: true, directChat: true });
  const { agent: ours } = await B.agentHub.add({ name: 'Tessie', kind: 'http', config: {} });
  await connect(B, A);

  const remoteId = await waitFor(
    () => [...B.hub.identities.keys()].find((k) => k.startsWith(`remote-agent:${idA}:${theirs.id}`)),
    5000,
    "B to be told about A's agent"
  );

  const session = B.call('lanchat:createSession', { title: 'what to call it' });
  B.call('lanchat:setSessionCounsel', { id: session.id, agentIds: [ours.id, remoteId] });
  B.call('lanchat:sendChat', { peerId: session.id, text: 'what should we call it?' });

  await waitFor(
    () => B.store.read(session.id).filter((m) => m.direction === 'in').length === 2,
    5000,
    'both halves of the counsel to answer'
  );

  const thread = B.store.read(session.id);
  assert.deepEqual(
    thread.map((m) => m.direction),
    ['out', 'in', 'in'],
    'one question typed once, and an answer from each of them'
  );
  assert.deepEqual(
    thread
      .slice(1)
      .map((m) => m.speaker)
      .sort(),
    ['Hermes', 'Tessie'],
    'and each answer names the agent it came from, wherever that agent lives'
  );
  assert.equal(commitCount(thread), 1, 'one question is one commit however many machines answered it');
  assert.deepEqual(B.store.read(remoteId), [], "none of it lands in the shared agent's own thread");
  assert.deepEqual(B.store.read(idA), [], "nor in B's chat with A");

  // The owner sees what was asked of their agent and what it said back, filed
  // where it always was — a delegate thread keeps both halves as incoming, which
  // is the shape the single-agent test above pins. A counsel changes nothing
  // about the transparency on the owner's side.
  assert.deepEqual(
    A.store.read(`${theirs.id}#${B.getIdentity().id}`).map((m) => m.direction),
    ['in', 'in'],
    'and the transparency on the owner’s side is unchanged'
  );
});

// Two questions out to one shared agent at the same time.
//
// This is what the single `pendingThread` slot could not do, and what a counsel
// makes ordinary: the same shared agent can be in a session's round and in its
// own thread at once. The answers come back in the order the questions went, so
// the queue is what decides where each one is filed — see `pending` in
// agents/remote.js.
test('two questions to one shared agent are answered in the order they were asked', () => {
  const { store, remote, entry } = remoteFixture();
  const session = 'session:abc';

  // The session writes its own question down, so the round asks with record:false.
  remote.send('peer-a', entry, 'what should we call it?', {
    prompt: 'what should we call it?',
    thread: session,
    record: false,
  });
  // And the agent's own thread asks it something else while that is still out.
  remote.send('peer-a', entry, 'unrelated', { prompt: 'unrelated' });

  assert.equal(entry.pending.length, 2, 'both questions are outstanding at once');
  assert.deepEqual(store.read(session), [], 'the round wrote nothing — the session already had');
  assert.deepEqual(
    store.read(entry.id).map((m) => m.text),
    ['unrelated'],
    "while the agent's own thread kept its question the ordinary way"
  );

  const first = remote.receive('peer-a', { agentId: 'agent:x', text: 'Counsel mode.' });
  assert.equal(first.peerId, session, 'the first answer belongs to the first question');
  assert.equal(first.speaker, 'Hermes');

  const second = remote.receive('peer-a', { agentId: 'agent:x', text: 'about the other thing' });
  assert.equal(second.peerId, entry.id, 'and the second to the second');
  assert.equal(entry.pending.length, 0, 'with nothing left outstanding');
});

// ------------------------------------------------ the pictures an answer carries

// A 1x1 PNG, so what is named is a file a browser would really decode.
const PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

test('a picture an agent named reaches the session that asked, ready to be drawn', async () => {
  const A = makeNode('picture');
  const png = path.join(A.dir, 'graph.png');
  fs.writeFileSync(png, PIXEL_PNG);

  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  const session = A.call('lanchat:createSession', { title: 'quakes', agentId: agent.id });

  // The echo transport answers with `echo:` + the question, so a question with
  // the marker on a line of its own comes back with it on a line of its own —
  // which is exactly the shape a real agent's answer arrives in.
  A.call('lanchat:sendChat', { peerId: session.id, text: `draw it\nMEDIA:${png}` });
  await waitFor(() => A.store.read(session.id).length === 2, 5000, 'the answer to land');

  const answer = A.store.read(session.id)[1];
  assert.deepEqual(
    answer.media,
    [{ name: 'graph.png', path: png, size: PIXEL_PNG.length, mime: 'image/png' }],
    'the session branch carries the pictures through, field by field like the rest'
  );
  assert.equal(answer.text, 'echo:draw it', 'and the marker that named it is gone from the words');
});

test('a picture cannot be claimed from the wire', async () => {
  const A = makeNode('claim');
  const png = path.join(A.dir, 'private.png');
  fs.writeFileSync(png, PIXEL_PNG);
  const media = [{ name: 'private.png', path: png, size: PIXEL_PNG.length, mime: 'image/png' }];

  // A path on a message is a path the window fetches back and draws. Honouring
  // one a peer sent would be letting somebody else choose which files on this
  // machine appear on this screen, so the field is refused exactly the way
  // `notice` and `error` are — behind the Symbol, which JSON.parse cannot make.
  A.bus.emit('peer-message', { from: 'peer-1', type: 'chat', text: 'look at this', media, ts: Date.now() });
  const [fromPeer] = A.store.read('peer-1');
  assert.equal(fromPeer.text, 'look at this', 'what they said is still stored');
  assert.equal(fromPeer.media, undefined, 'what they claimed about our disk is not');

  A.bus.emit('peer-message', {
    from: 'peer-1',
    type: 'chat',
    text: 'from an agent here',
    media,
    ts: Date.now(),
    [LOCAL_ORIGIN]: true,
  });
  assert.deepEqual(A.store.read('peer-1')[1].media, media, 'and a local agent is still believed');
});

test('a picture the person at the keyboard names is theirs alone, and their words are untouched', async () => {
  const A = makeNode('typed');
  const png = path.join(A.dir, 'holiday.png');
  fs.writeFileSync(png, PIXEL_PNG);

  const sent = [];
  A.hub.send = (peerId, frame) => (sent.push({ peerId, frame }), true);

  const typed = `look at this\n\nMEDIA:${png}\n\nisn't it good`;
  A.call('lanchat:sendChat', { peerId: 'peer-1', text: typed });

  const stored = A.store.read('peer-1')[0];
  assert.equal(stored.text, typed, 'nothing is taken out of a message somebody wrote');
  assert.equal(sent[0].frame.text, typed, 'and what was sent is what was kept');
  assert.deepEqual(stored.media, [
    { name: 'holiday.png', path: png, size: PIXEL_PNG.length, mime: 'image/png' },
  ]);
});

test('a picture an agent made never crosses the wire, over a real socket', async (t) => {
  // The one part of this that a single-process test cannot answer. An agent that
  // draws something names a file on the machine it is running on; a peer asking
  // that agent from across the network has no such file and no way to read it,
  // so what must arrive on their side is the words and nothing else. Proved here
  // over two nodes and a real socket rather than reasoned about, because
  // "the path is not in the frame" is a claim about what is actually sent.
  const A = makeNode('owner-media', await freePort());
  const B = makeNode('asker-media', await freePort());
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const png = path.join(A.dir, 'graph.png');
  fs.writeFileSync(png, PIXEL_PNG);

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;
  const { agent } = await A.agentHub.add({ name: 'Hermes', kind: 'http', config: {} });
  await A.agentHub.setSharing(agent.id, { networkWide: true, directChat: true });
  await connect(B, A);

  const remoteId = await waitFor(
    () => [...B.hub.identities.keys()].find((k) => k.startsWith(`remote-agent:${idA}:${agent.id}`)),
    5000,
    "B to be told about A's agent"
  );

  // The echo transport answers with `echo:` and the question, so asking with the
  // marker on a line of its own is how the agent comes to name a file.
  const session = B.call('lanchat:createSession', { title: 'quakes', agentId: remoteId });
  B.call('lanchat:sendChat', { peerId: session.id, text: `draw it\nMEDIA:${png}` });

  await waitFor(
    () => B.store.read(session.id).some((m) => m.direction === 'in'),
    5000,
    'the answer to come back into the session'
  );

  // A's side: the owner of the machine the file is on sees the picture.
  const mine = A.store.read(`${agent.id}#${idB}`).find((m) => m.direction === 'in' && m.media);
  assert.ok(mine, 'the owner gets the picture their own agent made');
  assert.equal(mine.media[0].path, png);

  // B's side: the words, and not one byte about A's filesystem. Asserted on the
  // message that arrived rather than on the whole thread — B's own question is
  // in there too, and it says whatever B typed, which here happens to be a path.
  const theirs = B.store.read(session.id).find((m) => m.direction === 'in');
  assert.equal(theirs.media, undefined, 'no path arrives on the asking machine');
  assert.equal(theirs.text, 'echo:draw it', 'and the marker naming it did not travel either');
  assert.ok(!JSON.stringify(theirs).includes(png), 'nothing of the path is anywhere in what arrived');

  // And the question B typed is the other half of the same rule: the same string
  // naming a file that exists on A and not on B resolves to nothing here. A path
  // is only ever a picture on the machine the file is actually on.
  const asked = B.store.read(session.id).find((m) => m.direction === 'out');
  assert.ok(asked.text.includes(png), 'B still said what B said');
  assert.equal(asked.media, undefined, 'but a path that is not on this machine is just text');
});
