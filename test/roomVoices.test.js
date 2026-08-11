'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load } = require('../scripts/lib/reactDrive.js');

// A room, on the screen of somebody who is not hosting it.
//
// The relay that carries an agent's answer to the rest of the room hands over a
// name and a `speakerId`, and deliberately not an `agentId`: an id off the wire
// must never land in the namespace this app treats as local. The cost of that
// choice is that a window drawing a guest's copy has to be told to read the
// other field — and a fix that stopped there would have shipped a room where
// half the people see a discussion in four colours and the rest see one wall of
// grey.
//
// So this is the other half of the same fix, asserted against the real
// component: the voices arrive, they are drawn, and they are drawn in the same
// colours the host sees them in.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const ChatPane = load(path.join(SRC, 'components', 'ChatPane.jsx')).default;
const Sidebar = load(path.join(SRC, 'components', 'Sidebar.jsx')).default;
const { paletteFor } = load(path.join(SRC, 'lib', 'agentColor.js'));
const { chipLabel } = load(path.join(SRC, 'lib', 'counselCopy.js'));

// The card App builds for a session another machine runs: no counsel of its own,
// because a guest asks nobody, and the host's cast carried alongside it.
const GUEST_ROOM = {
  id: 'session:1',
  name: 'where to put the lock',
  kind: 'session',
  agentIds: [],
  agentNames: ['Hermes', 'Tessie'],
  counselIds: [],
  mode: 'dialogue',
  turns: 4,
  hostPeerId: 'p-host',
  accepted: true,
};

const HERMES = 'agent:11111111-2222-3333-4444-555555555555';
const TESSIE = 'agent:66666666-7777-8888-9999-000000000000';

// What onRoomChat files on a guest — a speaker, a voice, and no agent id.
const relayed = (id, speaker, speakerId, text) => ({
  id,
  peerId: GUEST_ROOM.id,
  direction: 'in',
  kind: 'text',
  text,
  ts: 1754800000000 + Number(id.slice(1)) * 1000,
  speaker,
  speakerId,
});

const pane = (messages, peer = GUEST_ROOM, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(ChatPane, {
      peer,
      messages,
      agents: [],
      counselAgents: [],
      progress: {},
      ...extra,
    })
  );

test('a relayed agent answer is drawn as a voice, in the colour the host sees', () => {
  const html = pane([
    relayed('m1', 'host', null, 'where should the lock live?'),
    relayed('m2', 'Hermes', HERMES, 'in the coordinator'),
    relayed('m3', 'Tessie', TESSIE, 'or in whoever holds the port'),
  ]);

  assert.match(html, /Hermes/, 'the agent that answered is named');
  assert.match(html, /Tessie/, 'and so is the other one');

  // The colours the host's window deals for these two — the same ids give the
  // same answer everywhere, which is the whole reason the id travels at all.
  const palette = paletteFor([HERMES, TESSIE]);
  assert.match(
    html,
    new RegExp(`--agent-color:\\s*${palette.get(HERMES)}`, 'i'),
    'and each answer carries its own colour'
  );
  assert.match(
    html,
    new RegExp(`--agent-color:\\s*${palette.get(TESSIE)}`, 'i'),
    'a different one for the other'
  );
  assert.notEqual(palette.get(HERMES), palette.get(TESSIE), 'two voices, two colours');
});

// The empty window, which is what this pane renders before anything is chosen.
//
// It has an early return for a null `peer` — and an early return protects the
// JSX below it, not the consts above it, which are evaluated on every render.
// Two crashes on this seam were found by a browser harness rather than here,
// because every other test in this file hands the pane a card. This is the
// cheapest possible guard against the third.
test('the pane renders with no conversation open', () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatPane, { peer: null, messages: [], agents: [], progress: {} })
  );
  assert.ok(html.length > 0, 'it draws something rather than throwing');
  assert.doesNotMatch(html, /invite-card/, 'and nothing that belongs to a room');
});

test('a person in the room is not given an agent’s colour', () => {
  const html = pane([relayed('m1', 'Zima', null, 'put it in the coordinator')]);
  assert.match(html, /Zima/, 'they are named');
  assert.doesNotMatch(html, /--agent-color/, 'and drawn as a person, because that is what they are');
});

// ---- the same room, described the same way -------------------------------
//
// The header of a shared session is not decoration: it says what kind of
// conversation this is and who is in it. A guest resolving it against its own
// roster answered "choose agents…" about a discussion between three of them,
// which is the same room described two different ways on two screens.

test('a guest is shown the host’s cast, not its own empty one', () => {
  const html = pane([]);
  // The chip a host would see for the same two agents, from the same function
  // that writes it there — so this asserts the two headers agree rather than
  // asserting a string that only this test knows.
  assert.match(
    html,
    new RegExp(chipLabel({ allAgents: false, names: GUEST_ROOM.agentNames })),
    'the header reads what the host’s reads'
  );
  assert.doesNotMatch(html, /choose agents/, 'never as a session with nobody in it');
  // The picker is read-only for a guest — that rule predates this and must
  // survive being given something to draw.
  assert.match(html, /disabled/, 'and none of it is theirs to change');
});

test('a guest who has joined can type; one who has not, cannot', () => {
  // "Unavailable" is the composer's own word for a thread it cannot be used on.
  // A joined guest asks nobody and still has people to talk to, so what closes
  // the box in a room is the unanswered invitation and nothing else.
  assert.doesNotMatch(pane([]), /Unavailable/, 'a room you are in is a room you can talk in');
  assert.match(
    pane([], { ...GUEST_ROOM, accepted: false }),
    /Unavailable/,
    'one you have not answered is not'
  );
  // The placeholder says what typing will do. It must not name the host's agents
  // — a guest's words go to the room and no agent is asked — because a box that
  // promises an answer nobody is going to give is worse than a plain one.
  assert.match(pane([]), /Say something to the room/);
  assert.doesNotMatch(pane([]), /Give Hermes and Tessie something to discuss/);
});

test('a guest is not offered an attachment its words cannot carry', () => {
  // The guest branch of send() in main/sessions/index.js relays text and nothing
  // else: a document staged here would be cleared from the composer and dropped
  // on the way out. Pinned from both ends — test/sessions.test.js proves the main
  // side carries no attachment, and this proves the window does not offer one.
  assert.doesNotMatch(pane([]), /Attach a document/, 'no attach button in somebody else’s room');
  const own = { ...GUEST_ROOM, hostPeerId: null, agentIds: ['a1'], agentNames: ['Hermes'] };
  const mine = pane([], own, { agents: [{ id: 'a1', name: 'Hermes', ready: true }] });
  assert.match(mine, /Attach a document/, 'and it is still there in a session of our own');
});

// ---- an invitation ---------------------------------------------------------
//
// It used to be a strip above the composer of a session nobody had a reason to
// open, which is as close to invisible as this window gets. An invitation is the
// one thing here that expires if it is not noticed.

test('an invitation is drawn in the middle of the pane, and says who sent it', () => {
  const html = pane([], { ...GUEST_ROOM, accepted: false }, { roomPeers: [{ id: 'p-host', name: 'Ed' }] });
  assert.match(html, /invite-card/, 'it is a card in the conversation, not a strip under it');
  assert.match(html, /invite-veil/, 'over the transcript, because none of it is readable yet');
  assert.match(html, /Ed has invited you to this session/, 'and it says who asked');
  assert.match(html, /where to put the lock/, 'and to what');
  assert.match(html, /Join/);
  assert.match(html, /Decline/);
  assert.doesNotMatch(html, /invite-bar/, 'the strip above the composer is gone');
});

test('a session you are in draws no invitation at all', () => {
  assert.doesNotMatch(pane([]), /invite-card/);
});

const SELF = { id: 'me', name: 'MacMini', hostname: 'macmini', platform: 'darwin' };

const panel = (sessions) =>
  renderToStaticMarkup(
    React.createElement(Sidebar, {
      self: SELF,
      peers: [],
      tailnet: [],
      sessions,
      tailnetStatus: { ok: true, reason: null },
      selectedId: null,
      unread: {},
      summoned: {},
      queued: {},
      authFailures: {},
      showAddresses: false,
      askableAgents: [],
      // Shut, which is the state the flash exists for: a category nobody has
      // open is the only place a signal has to carry on its own.
      sectionOrder: ['sessions', 'agents', 'people', 'tailnet'],
      lockedSections: [],
      onSectionPrefs: () => {},
      search: { q: '', scope: 'all' },
      onSearch: () => {},
      onSelect: () => {},
      onOpenProfile: () => {},
      onOpenDev: () => {},
      onOpenSettings: () => {},
      onNewSession: () => {},
      onOpenTrash: () => {},
      onAddPeer: () => {},
      onRefresh: () => {},
      onNewGroupCall: () => {},
    })
  );

test('an invitation flashes in the sidebar the way anything else waiting does', () => {
  const waiting = {
    id: 'session:1',
    title: 'where to put the lock',
    hostPeerId: 'p-host',
    accepted: false,
    createdAt: 1754800000000,
  };
  const html = panel([waiting]);
  assert.match(html, /peer session[^"]*invited/, 'the row is lit');
  assert.match(html, /Invitation · waiting for you/, 'and says what it is waiting for');
  assert.match(html, /sb-section[^"]*flash/, 'and the shut heading above it is lit too');

  // Answered, and the sidebar goes quiet. Nothing has to be remembered to
  // switch it off — the record stops saying it is waiting.
  const joined = { ...waiting, accepted: true, roomCounsel: [{ id: 'a1', name: 'Hermes' }] };
  const after = panel([joined]);
  assert.doesNotMatch(after, /peer session[^"]*invited/, 'the flash stops when it is answered');
  assert.match(after, /Session · Hermes/, 'and the row names the host’s agents, not this machine’s');
});
