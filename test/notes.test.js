'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Notes: this machine's own writing, kept in two halves.
//
// The claim worth proving here cannot be read off the code, because it is about
// what happens on disk while somebody types. A note body is prose with no bound
// on it; the list beside it is metadata that has to be readable without opening
// anything. If both lived in one array, recording a single letter would mean
// rewriting every note anyone had ever written. So: the bodies are in their own
// files, the prose is never in notes.json, and a body-only save leaves that file
// alone until something visible moves or the editor says it has finished.
//
// The other claim is the Trash. Deleting a note keeps the record and keeps the
// body file; only a purge takes either away. A test that stopped at the record
// would pass against a build that unlinked the writing on the way in.
//
// Driven through the IPC channels rather than the store, because the wiring is
// half of what is new — a handler that forgets to publish, or one that publishes
// on every keystroke and undoes the coalescing, is exactly the mistake that
// would ship.

const handlers = new Map();

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
      showOpenDialog: async () => ({ canceled: true }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  },
};

const { Config } = require('../src/main/config.js');
const { buildIdentity } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { MessageStore } = require('../src/main/store.js');
const { createAgentHub } = require('../src/main/agents/index.js');
const { createIpc } = require('../src/main/ipc.js');
const { NoteStore } = require('../src/main/notes.js');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
};

function makeNode(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-notes-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: 0 });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const store = new MessageStore(dir);
  const agentHub = createAgentHub({
    userDataDir: dir,
    hub,
    bus,
    store,
    safeStorage: fakeSafeStorage,
    transports: {},
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
  return { dir, call, events, hub, agentHub };
}

const metaFile = (node) => path.join(node.dir, 'notes.json');
const rawMeta = (node) => fs.readFileSync(metaFile(node), 'utf8');
const bodyFile = (node, id) => path.join(node.dir, 'notes', `${id.replace(/[^\w.\-]+/g, '_')}.md`);
const pushed = (node, type) => node.events.filter((e) => e.type === type).map((e) => e.payload);

test('a note is written in two halves, and the prose is not in the list', async (t) => {
  const n = makeNode('split');
  t.after(() => n.hub.stop?.());

  const note = await n.call('lanchat:createNote', {});
  assert.match(note.id, /^note:/);

  const prose = 'The kitchen tap drips.\nAsk Ada whether the washer is metric.';
  await n.call('lanchat:saveNote', { id: note.id, title: 'Tap', body: prose, final: true });

  // The body is a file of its own, holding exactly what was typed.
  assert.equal(fs.readFileSync(bodyFile(n, note.id), 'utf8'), prose);
  // And none of it is in the list. This is the whole reason for the split: the
  // list is rewritten wholesale, and prose in it would be rewritten with it.
  const meta = rawMeta(n);
  assert.ok(!meta.includes('washer'), 'the second line is not in notes.json');
  assert.ok(!meta.includes('metric'), 'nor any of the rest of it');

  // What the list does carry is enough to draw a row: a title, and the first
  // line with anything on it.
  const [row] = await n.call('lanchat:listNotes');
  assert.equal(row.title, 'Tap');
  assert.equal(row.preview, 'The kitchen tap drips.');
  assert.ok(!('body' in row), 'a row is metadata, and nothing else');

  // Reading one, on the other hand, opens the body.
  assert.equal((await n.call('lanchat:readNote', { id: note.id })).body, prose);
});

test('the preview is the first line with something on it', async (t) => {
  const n = makeNode('preview');
  t.after(() => n.hub.stop?.());

  const note = await n.call('lanchat:createNote', {});
  // Opening with blank lines is ordinary. A preview taken from the first N
  // characters would show nothing at all for a note like this.
  await n.call('lanchat:saveNote', { id: note.id, body: '\n\n   \n  Buy milk  \nand bread', final: true });
  assert.equal((await n.call('lanchat:listNotes'))[0].preview, 'Buy milk');

  await n.call('lanchat:saveNote', { id: note.id, body: '', final: true });
  assert.equal((await n.call('lanchat:listNotes'))[0].preview, '', 'and an empty note previews as nothing');
});

test('typing does not rewrite the list, and looking away does', async (t) => {
  const n = makeNode('coalesce');
  t.after(() => n.hub.stop?.());

  const note = await n.call('lanchat:createNote', { title: 'Draft' });
  // One save to settle the record and the preview, so what follows is the
  // steady state of somebody typing into a note that already exists.
  await n.call('lanchat:saveNote', { id: note.id, body: 'Line one is written.', final: true });

  const before = rawMeta(n);
  const pushesBefore = pushed(n, 'notes').length;

  // Now keystrokes. Each one adds to the same first line, so the preview moves
  // and the file is expected to keep up.
  for (let i = 0; i < 5; i += 1) {
    await n.call('lanchat:saveNote', { id: note.id, body: `Line one is written.${'!'.repeat(i + 1)}` });
  }
  assert.notEqual(rawMeta(n), before, 'a moving preview is a visible change, and is recorded');

  // And now keystrokes that change nothing anybody can see: a second line being
  // typed, well under the coalescing window.
  const settled = rawMeta(n);
  const pushesSettled = pushed(n, 'notes').length;
  assert.ok(pushesSettled > pushesBefore, 'the visible ones were published');

  for (let i = 0; i < 20; i += 1) {
    await n.call('lanchat:saveNote', { id: note.id, body: `Line one is written.!!!!!\nsecond line ${i}` });
    // Every one of them reaches the body file. It is one file, and it is the
    // thing being typed.
    assert.ok(fs.readFileSync(bodyFile(n, note.id), 'utf8').endsWith(`second line ${i}`));
  }
  assert.equal(rawMeta(n), settled, 'twenty keystrokes, and the list was left alone');
  assert.equal(pushed(n, 'notes').length, pushesSettled, 'and the window was not re-rendered for them');

  // Looking away is the flush. Whatever the clock says, the record on disk now
  // agrees with the body beside it.
  const saved = await n.call('lanchat:saveNote', { id: note.id, final: true });
  assert.notEqual(rawMeta(n), settled, 'the record caught up');
  assert.ok(saved.updatedAt >= JSON.parse(settled)[0].updatedAt);
  assert.equal(pushed(n, 'notes').length, pushesSettled + 1, 'and the window heard about it once');
});

test('a title that is edited down to nothing still names the note', async (t) => {
  const n = makeNode('title');
  t.after(() => n.hub.stop?.());

  const note = await n.call('lanchat:createNote', {});
  assert.equal(note.title, 'Untitled note');

  const named = await n.call('lanchat:saveNote', { id: note.id, title: '  Two   words\nspilling over  ' });
  assert.equal(named.title, 'Two words spilling over', 'one line, trimmed');

  const blanked = await n.call('lanchat:saveNote', { id: note.id, title: '   ' });
  assert.equal(blanked.title, 'Untitled note', 'a row with no words in it is unclickable');

  const long = await n.call('lanchat:saveNote', { id: note.id, title: 'x'.repeat(200) });
  assert.equal(long.title.length, 80);
});

test('deleting keeps the writing; only purging takes it away', async (t) => {
  const n = makeNode('trash');
  t.after(() => n.hub.stop?.());

  const note = await n.call('lanchat:createNote', { title: 'Keepsake' });
  const prose = 'An afternoon of it.';
  await n.call('lanchat:saveNote', { id: note.id, body: prose, final: true });

  assert.deepEqual(await n.call('lanchat:deleteNote', { id: note.id }), { ok: true });
  assert.equal((await n.call('lanchat:listNotes')).length, 0, 'out of the list');
  const [trashed] = await n.call('lanchat:listNoteTrash');
  assert.equal(trashed.id, note.id, 'and into the Trash');
  // The one thing this must never do on the way in.
  assert.ok(fs.existsSync(bodyFile(n, note.id)), 'the writing is still there');
  assert.equal((await n.call('lanchat:readNote', { id: note.id })).body, prose, 'and still readable');

  // Both lists go out together, or the window shows a note in two places.
  const last = n.events[n.events.length - 2];
  assert.equal(last.type, 'notes');
  assert.equal(n.events[n.events.length - 1].type, 'noteTrash');

  assert.deepEqual(await n.call('lanchat:restoreNote', { id: note.id }), { ok: true });
  assert.equal((await n.call('lanchat:listNotes')).length, 1, 'back where it was');
  assert.equal((await n.call('lanchat:readNote', { id: note.id })).body, prose, 'with what was in it');

  // A note that is not in the Trash cannot be purged: there is no path from the
  // list straight to the irreversible one.
  assert.deepEqual(await n.call('lanchat:purgeNote', { id: note.id }), { ok: false });
  assert.ok(fs.existsSync(bodyFile(n, note.id)));

  await n.call('lanchat:deleteNote', { id: note.id });
  assert.deepEqual(await n.call('lanchat:purgeNote', { id: note.id }), { ok: true });
  assert.equal((await n.call('lanchat:listNoteTrash')).length, 0);
  // The body goes with the record. One left behind is bytes nothing points at.
  assert.ok(!fs.existsSync(bodyFile(n, note.id)), 'and the file with it');
});

test('the Trash empties and refills in one go, both ways', async (t) => {
  const n = makeNode('bulk');
  t.after(() => n.hub.stop?.());

  const ids = [];
  for (const title of ['one', 'two', 'three']) {
    const note = await n.call('lanchat:createNote', { title });
    await n.call('lanchat:saveNote', { id: note.id, body: title, final: true });
    await n.call('lanchat:deleteNote', { id: note.id });
    ids.push(note.id);
  }

  assert.deepEqual(await n.call('lanchat:restoreAllNotes'), { ok: true, count: 3 });
  assert.equal((await n.call('lanchat:listNotes')).length, 3);
  assert.equal((await n.call('lanchat:listNoteTrash')).length, 0);

  // Nothing to do is not a failure, and it does not republish either.
  const quiet = n.events.length;
  assert.deepEqual(await n.call('lanchat:restoreAllNotes'), { ok: true, count: 0 });
  assert.equal(n.events.length, quiet, 'an empty Trash is not news');

  for (const id of ids) await n.call('lanchat:deleteNote', { id });
  assert.deepEqual(await n.call('lanchat:purgeAllNotes'), { ok: true, count: 3 });
  assert.equal((await n.call('lanchat:listNoteTrash')).length, 0);
  for (const id of ids) assert.ok(!fs.existsSync(bodyFile(n, id)), `${id} took its body with it`);
});

test('all of it survives a restart, and junk in the file does not', async (t) => {
  const n = makeNode('restart');
  t.after(() => n.hub.stop?.());

  const kept = await n.call('lanchat:createNote', { title: 'Kept' });
  await n.call('lanchat:saveNote', { id: kept.id, body: 'still here', final: true });
  const binned = await n.call('lanchat:createNote', { title: 'Binned' });
  await n.call('lanchat:saveNote', { id: binned.id, body: 'in the trash', final: true });
  await n.call('lanchat:deleteNote', { id: binned.id });

  // A second store on the same directory is what the next launch is.
  const after = new NoteStore(n.dir);
  assert.deepEqual(
    after.list().map((r) => r.title),
    ['Kept']
  );
  assert.deepEqual(
    after.trashed().map((r) => r.title),
    ['Binned']
  );
  assert.equal(after.read(kept.id).body, 'still here');
  assert.equal(
    after.read(binned.id).body,
    'in the trash',
    'the Trash keeps its writing across a restart too'
  );

  // The file is JSON on disk that a person can edit and an older build can
  // write. Anything that is not a note is dropped rather than rendered.
  fs.writeFileSync(
    metaFile(n),
    JSON.stringify([{ id: 'note:real', title: 'Real' }, { id: 'session:no' }, null, 'nonsense', {}]),
    'utf8'
  );
  const guarded = new NoteStore(n.dir);
  assert.deepEqual(
    guarded.list().map((r) => r.id),
    ['note:real']
  );

  // And a file that will not parse at all is a fresh start rather than a crash
  // on launch.
  fs.writeFileSync(metaFile(n), 'not json', 'utf8');
  assert.deepEqual(new NoteStore(n.dir).list(), []);
});

test('a note with no body file yet reads as empty rather than as missing', async (t) => {
  const n = makeNode('nobody');
  t.after(() => n.hub.stop?.());

  // What a note is between being created and being typed into.
  const note = await n.call('lanchat:createNote', {});
  assert.ok(!fs.existsSync(bodyFile(n, note.id)), 'nothing written yet');
  assert.equal((await n.call('lanchat:readNote', { id: note.id })).body, '');

  // And a note that never existed is nothing at all, rather than an empty one.
  assert.equal(await n.call('lanchat:readNote', { id: 'note:nope' }), null);
  assert.equal(await n.call('lanchat:saveNote', { id: 'note:nope', body: 'x' }), null);
  assert.deepEqual(await n.call('lanchat:deleteNote', { id: 'note:nope' }), { ok: false });
});
