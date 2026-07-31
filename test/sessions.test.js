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
        // in the shape the real transport reports it.
        if (text.includes('fail:now')) {
          h.onError?.(new Error("ACP call 'session/prompt' timed out."));
          return;
        }
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
  assert.equal(entry.pendingThread, session, 'still waiting on the real answer');

  const answer = remote.receive('peer-a', { agentId: 'agent:x', text: 'because the holder went quiet' });
  assert.equal(answer.peerId, session);
  assert.deepEqual(
    store.read(session).map((m) => `${m.direction}:${m.text}`),
    ['out:why did it move?', 'in:because the holder went quiet']
  );
  assert.equal(entry.pendingThread, null, 'and the correlation ends with the answer');

  // With nothing outstanding, the agent's own thread gets its own traffic back.
  remote.send('peer-a', entry, 'hello there', { prompt: 'hello there' });
  const reply = remote.receive('peer-a', { agentId: 'agent:x', text: 'hello yourself' });
  assert.equal(reply.peerId, entry.id);
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
  assert.equal(remote.emptyRun('peer-a', 'agent:x'), 'session:abc');
  assert.equal(entry.pendingThread, null, 'an empty answer is still an answer');
  assert.equal(remote.emptyRun('peer-a', 'agent:x'), entry.id);
});
