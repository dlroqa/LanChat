import React, { useState, useMemo, useEffect } from 'react';
import Avatar from './Avatar.jsx';
import QueueBadge from './QueueBadge.jsx';
import SidebarSection from './SidebarSection.jsx';
import SearchScope from './SearchScope.jsx';
import SessionFolder from './SessionFolder.jsx';
import { Settings, Plus, Refresh, Users, GroupCall, Code, Sessions, Trash } from '../lib/icons.jsx';
import { formatShortDate, platformLabel } from '../lib/util.js';
import { sessionCounsel, sessionSubLine } from '../lib/counselCopy.js';
import {
  SCOPE_ALL,
  SHARED,
  NETMAKER,
  liveGuestRooms,
  moveSection,
  normalizeOrder,
  ownSessions,
  searchPlaceholder,
  searchSection,
  sectionForThread,
  sectionSignal,
  sectionTitle,
} from '../lib/sidebarSections.js';
import { folderOf, folderSessions, looseSessions, dropIndex, isNoopPlace } from '../lib/sessionFolders.js';

// A drag carrying a category, told apart from a drag carrying files. The window
// puts a "drop to send" sheet over the conversation for anything dragged into
// it, and re-ordering the panel is not that — so the type is checked rather than
// assumed, on the way in here and again in App.jsx on the way out.
const DND_TYPE = 'application/x-lanchat-section';

// And the two the Sessions list carries. Separate types rather than one with a
// payload, because `getData()` returns '' during `dragover` in Chromium — the
// list of *types* is the only thing readable while the pointer is moving, so
// every "may I take this?" decision has to be expressible as a type check. A
// folder may not go inside a folder; a session may.
const DND_SESSION = 'application/x-lanchat-session';
const DND_FOLDER = 'application/x-lanchat-folder';

const carries = (e, type) => Array.from(e.dataTransfer?.types || []).includes(type);
const carriesSection = (e) => carries(e, DND_TYPE);

// Why a peer could not connect, in words rather than a code.
//
// Every one of these was refused identically — an attacker who simply omits the
// proof looks exactly like a build that cannot produce one, and both are turned
// away. This only chooses the sentence, and it is chosen here, in the window,
// where the far end cannot read it. That is what makes it safe to be helpful:
// the friendlier line below is the one an attacker gets, and it costs nothing.
function refusalLabel(reason) {
  switch (reason) {
    case 'older-lanchat':
      return 'Needs a newer LanChat';
    case 'key-changed':
      return 'Could not be verified';
    case 'bad-signature':
    case 'bad-hello':
    case 'id-in-use':
      return 'Could not be verified';
    case 'timed-out':
      return 'Did not respond';
    default:
      return 'Offline';
  }
}

export default function Sidebar({
  self,
  peers,
  // Everyone a session can be pointed at, as main sees it. Not the same set as
  // the agents on the roster below — an agent shared without direct chat can be
  // asked and is deliberately not a contact — so a session's row names its
  // counsel from this rather than by filtering the roster. Named for what it is
  // rather than `agents`, which this component already uses for the roster's own
  // agent rows.
  askableAgents = [],
  tailnet,
  tailnetStatus,
  // The Netmaker meshes this machine is on, and the nodes seen over them.
  // A category that comes and goes with them, like the shared rooms above.
  netmaker = { networks: [], peers: [], status: {} },
  selectedId,
  unread,
  // Agents summoned and not yet opened. A summon writes no message, so there is
  // no unread count to carry it — the row says so itself, until it is clicked.
  summoned = {},
  queued = {},
  authFailures = {},
  showAddresses,
  sessions = [],
  // Where sessions are filed: `[{ id, name, sessionIds }]`, in the order they
  // are drawn. Membership lives on the folder rather than on the session, so a
  // session's own record never changes when it is filed — see lib/sessionFolders.
  folders = [],
  onNewFolder = () => {},
  onRenameFolder = () => {},
  onDeleteFolder = () => {},
  onMoveFolder = () => {},
  onPlaceSession = () => {},
  // The order the categories are stacked in and which of them are pinned open,
  // both saved settings. They arrive as whatever was in the config file, so
  // neither is trusted further than normalizeOrder makes it safe.
  sectionOrder = [],
  lockedSections = [],
  onSectionPrefs = () => {},
  // The search box, owned by App because the middle panel shows what it finds.
  // `{ q, scope }`: what was typed, and which category it is aimed at.
  search = { q: '', scope: SCOPE_ALL },
  onSearch = () => {},
  onSelect,
  onOpenProfile,
  onOpenDev,
  onOpenSettings,
  onNewSession,
  // The Trash, and whether it is the thing currently filling the window. A
  // toggle rather than a door: pressing it again puts the conversation back,
  // which is what the other three buttons on that row cannot offer because they
  // open dialogs.
  onOpenTrash,
  trashOpen = false,
  trashCount = 0,
  onAddPeer,
  onRefresh,
  onNewGroupCall,
}) {
  const q = search.q || '';
  const scope = search.scope || SCOPE_ALL;

  const sorted = useMemo(
    () =>
      [...peers].sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (a.name || '').localeCompare(b.name || '');
      }),
    [peers]
  );

  // Agents live in their own section at the top rather than among the people —
  // they are a different kind of correspondent, and anything that arrives as an
  // agent lands here without the list needing to know about it in advance.
  //
  // These are the whole lists, before the search box has had them. A heading is
  // the only thing a shut category shows, so what it counts has to be everything
  // inside it — a search for "eli" must not quietly take the flashing off People
  // because the person with the unread message is not called Eli.
  const allAgents = useMemo(() => sorted.filter((p) => p.kind === 'agent'), [sorted]);
  const allPeople = useMemo(() => sorted.filter((p) => p.kind !== 'agent'), [sorted]);

  // Tailnet devices that are online but not running LanChat (informational).
  const noApp = useMemo(() => (tailnet || []).filter((t) => t.online && !t.hasApp), [tailnet]);
  // Mesh nodes that are not already contacts. Somebody running LanChat is in
  // People, reached and authenticated; what is left here is the rest of the
  // mesh, which is informational in exactly the way the tailnet list is.
  const meshNodes = useMemo(() => {
    const known = new Set((peers || []).map((p) => p.address && String(p.address).split(':')[0]));
    return (netmaker.peers || []).filter((n) => n.address && !known.has(n.address));
  }, [netmaker.peers, peers]);

  const onlineTailnet = useMemo(() => (tailnet || []).filter((t) => t.online).length, [tailnet]);

  // ---- the four categories -------------------------------------------------
  //
  // Which one is open is worked out on every render rather than stored. There is
  // no state that could disagree with the panel: a category is open because it
  // is pinned, or pointed at, or holds the conversation you are in, or has
  // something the search found — and it flashes because it is shut and has
  // something waiting. Nothing has to be remembered to switch the flash off,
  // which is why it stops exactly when the message is read and not a moment
  // before.
  const [hovered, setHovered] = useState(null);
  // Whether the reader has said, about the pinned category, out loud. `null` is
  // "follow the pointer, like everything else"; true and false are a click, and
  // a click has to win — otherwise clicking a heading you are still pointing at
  // to shut it would do nothing at all. It goes back to null when the pointer
  // leaves, so the next hover behaves the way the other four do.
  const [sharedOpen, setSharedOpen] = useState(null);
  const [netmakerOpen, setNetmakerOpen] = useState(null);
  const [drag, setDrag] = useState({ id: null, overId: null, before: false });
  // A session or a folder being carried inside the Sessions list.
  //
  // **Its own state, never `drag` above.** `isExpanded` begins `!drag.id`, so
  // reusing it would shut all four categories the instant a row was picked up —
  // including the one holding every drop target the drag was aimed at.
  //
  //   kind:   'session' | 'folder' | null
  //   over:   { type: 'folder' | 'row' | 'loose', id }  — what is under the pointer
  //   before: which half of it, for the two that insert
  const [sdrag, setSdrag] = useState({ kind: null, id: null, over: null, before: false });
  // Folders are open unless shut, so a folder just made is open and a fresh
  // window shows what is in them. Held here rather than on the record: it is
  // view state, and the registry file is user data.
  const [shutFolders, setShutFolders] = useState(() => new Set());
  // Which folder is being renamed, if any. Lifted out of the row so that a
  // folder created by the "+" can open straight into its own name.
  const [renaming, setRenaming] = useState(null);

  const order = useMemo(() => normalizeOrder(sectionOrder), [sectionOrder]);
  const locked = useMemo(
    () => (Array.isArray(lockedSections) ? lockedSections : []).filter((id) => order.includes(id)),
    [lockedSections, order]
  );

  const searching = q.trim().length > 0;
  const scoped = scope !== SCOPE_ALL;
  const activeSection = useMemo(
    () => sectionForThread(selectedId, { sessions, peers }),
    [selectedId, sessions, peers]
  );

  // The two halves of the session list. A room somebody else runs, while it is
  // live, is drawn under its own heading above everything — not filed among the
  // sessions you started, where the only thing marking it was a pulse. When it
  // ends it comes back here, which is why `own` is what the Sessions category is
  // given rather than `sessions`.
  const rooms = useMemo(() => liveGuestRooms(sessions), [sessions]);
  const own = useMemo(() => ownSessions(sessions), [sessions]);

  // Nothing to have an opinion about once the last room has gone. Left set, a
  // click from a fortnight ago would decide how the next invitation arrives.
  useEffect(() => {
    if (!rooms.length) setSharedOpen(null);
  }, [rooms.length]);

  // What each category has to show, and what it matched on.
  //
  // A category the search is not aimed at is not searched: pointing the box at
  // Sessions and then opening People should show the people, all of them. The
  // query is about the category it was aimed at, and nothing else.
  //
  // Tailnet devices are in here now. They used to be the one list the box could
  // not touch — it filtered the three above them and left the machines below
  // untouched, which read as a search that had stopped working halfway down.
  //
  // The pinned category is searched by whatever the Sessions scope is asking,
  // because that is what it holds and there is no chip for it: it is not in the
  // scope menu, since a scope saved in the config that pointed at a category
  // which had since ended would be a filter nobody could clear.
  const hits = useMemo(() => {
    const qFor = (id) => (!scoped || scope === id ? q : '');
    return {
      shared: searchSection('shared', rooms, qFor('sessions'), platformLabel),
      sessions: searchSection('sessions', own, qFor('sessions'), platformLabel),
      agents: searchSection('agents', allAgents, qFor('agents'), platformLabel),
      people: searchSection('people', allPeople, qFor('people'), platformLabel),
      tailnet: searchSection('tailnet', noApp, qFor('tailnet'), platformLabel),
      // No scope chip of its own, for the same reason the pinned category has
      // none: a scope saved in the config pointing at a category that had since
      // gone would be a filter nobody could clear.
      netmaker: searchSection('netmaker', meshNodes, qFor('people'), platformLabel),
    };
  }, [rooms, own, allAgents, allPeople, noApp, meshNodes, q, scope, scoped]);

  const shownCount = {
    shared: hits.shared.length,
    sessions: hits.sessions.length,
    agents: hits.agents.length,
    people: hits.people.length,
    tailnet: hits.tailnet.length,
    netmaker: hits.netmaker.length,
  };

  // An invitation nobody has answered is something waiting, exactly as an unread
  // message is — and it was the one kind of waiting the sidebar could not say.
  // A room you were asked into arrived silently: the row appeared, the heading
  // stayed dark, and the only thing that ever mentioned it was a strip above the
  // composer of a session you had no reason to open. So it is fed into the same
  // signal the unread count is, and the row flashes the way a summoned agent
  // does — the two mean the same thing to a reader.
  //
  // Only rooms that are still live can be waiting for an answer: a room whose
  // host ended it is a transcript now, and a heading flashing about a Join
  // button that would reach nobody would be the panel asking for something it
  // cannot deliver.
  const invitations = useMemo(() => {
    const out = {};
    for (const s of rooms) if (s.accepted === false) out[s.id] = true;
    return out;
  }, [rooms]);

  const signals = {
    shared: sectionSignal(rooms, unread, invitations),
    sessions: sectionSignal(own, unread, summoned),
    agents: sectionSignal(allAgents, unread, summoned),
    people: sectionSignal(allPeople, unread, summoned),
    tailnet: { count: 0, alert: false },
    // A list of machines has nothing waiting in it, the same as the tailnet one.
    netmaker: { count: 0, alert: false },
  };

  // Everything shuts while a category is being carried: four headings are a
  // short list to drop into, and a list that grew and shrank under the pointer
  // as it passed each category would be a moving target.
  //
  // Aiming the box at a category takes over from the locks and from the
  // conversation you have open, so exactly one category is showing and it is the
  // one being searched. They come back the moment the scope is cleared — nothing
  // was unlocked, it was only overruled. Pointing at any heading still opens it:
  // the scope narrows what the box is asking, not what you may look at.
  //
  // Sessions is held open for the whole of a drag inside it, and while a folder
  // is being named. Both are cases where the category shutting would take the
  // thing being worked on with it: the hover timer is 220ms, which is easily
  // reached by a pointer on its way to a drop target or a hand on its way to the
  // keyboard, and there is nothing to drop onto in a category that has shut.
  //
  // The pinned category answers a different question, because it is opened by a
  // different act. It cannot be locked and it cannot be scoped, so what is left
  // is: a search that found something in it, then what the reader said, then the
  // pointer and the conversation they have open. A click wins over the pointer
  // deliberately — see `sharedOpen`.
  const isExpanded = (id) => {
    if (drag.id) return false;
    if (id === NETMAKER.id) {
      return netmakerOpen === null ? false : netmakerOpen;
    }
    if (id === SHARED.id) {
      if (searching && shownCount.shared > 0) return true;
      if (sharedOpen !== null) return sharedOpen;
      return hovered === id || id === activeSection;
    }
    return (
      (id === 'sessions' && (Boolean(sdrag.kind) || Boolean(renaming))) ||
      hovered === id ||
      (scoped
        ? id === scope
        : locked.includes(id) || id === activeSection || (searching && shownCount[id] > 0))
    );
  };

  // The categories the search is not about, said quietly. A flashing one is
  // never quietened: something arrived for you, and a filter you applied to the
  // panel does not get to decide you should not hear about it.
  //
  // Aiming the box at Sessions does not quieten the rooms above them: the same
  // words are being asked of both lists, so telling the reader one of the two
  // answers is beside the point would be a lie about what was searched.
  const isQuiet = (id) =>
    scoped && id !== scope && !(id === SHARED.id && scope === 'sessions') && !signals[id].alert;

  const onHover = (id, open) => {
    // A pointer leaving takes the click with it. What is left is a category
    // behaving like the other four again, which is what somebody who has walked
    // away from it expects to come back to.
    if (id === SHARED.id && !open) setSharedOpen(null);
    if (id === NETMAKER.id && !open) setNetmakerOpen(null);
    setHovered((h) => (open ? id : h === id ? null : h));
  };

  const toggleShared = () => setSharedOpen(!isExpanded(SHARED.id));
  const toggleNetmaker = () => setNetmakerOpen(!isExpanded(NETMAKER.id));

  const toggleLock = (id) =>
    onSectionPrefs({ sidebarLocked: locked.includes(id) ? locked.filter((x) => x !== id) : [...locked, id] });

  const move = (id, delta) =>
    onSectionPrefs({ sidebarOrder: moveSection(order, id, order.indexOf(id) + delta) });

  const dragStart = (id) => (e) => {
    e.dataTransfer.setData(DND_TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
    setHovered(null);
    setDrag({ id, overId: null, before: false });
  };

  const dragOver = (id) => (e) => {
    if (!carriesSection(e)) return; // a file: leave it to the window's own handler
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    setDrag((d) => (d.overId === id && d.before === before ? d : { ...d, overId: id, before }));
  };

  const drop = (id) => (e) => {
    if (!carriesSection(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = e.dataTransfer.getData(DND_TYPE) || drag.id;
    if (moving && moving !== id) {
      const rest = order.filter((x) => x !== moving);
      const at = rest.indexOf(id) + (drag.before ? 0 : 1);
      onSectionPrefs({ sidebarOrder: moveSection(order, moving, at) });
    }
    setDrag({ id: null, overId: null, before: false });
  };

  const dragEnd = () => setDrag({ id: null, overId: null, before: false });

  // ---------------------------------------------- carrying sessions and folders
  //
  // Every handler below follows one rule about the event, and it is the rule the
  // category drag above already follows: on the branch that **accepts** a drag,
  // call `preventDefault()` and `stopPropagation()`; on the branch that refuses
  // it, touch the event not at all. Accepting stops the drag reaching App, which
  // puts a "drop to send" sheet over the conversation for anything dropped into
  // the window. Refusing without touching it is what leaves a genuine file drop
  // free to reach that sheet — `preventDefault()` there would swallow it.

  const foldersById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const clearSdrag = () => setSdrag({ kind: null, id: null, over: null, before: false });

  const startCarry = (kind, type) => (id) => (e) => {
    e.dataTransfer.setData(type, id);
    e.dataTransfer.effectAllowed = 'move';
    setHovered(null);
    setSdrag({ kind, id, over: null, before: false });
  };
  const sessionDragStart = startCarry('session', DND_SESSION);
  const folderDragStart = startCarry('folder', DND_FOLDER);

  // Somewhere under the pointer, remembered only when it changes — a setState per
  // dragover event would re-render the panel a hundred times a second.
  const markOver = (over, before) =>
    setSdrag((d) =>
      d.over && d.over.type === over.type && d.over.id === over.id && d.before === before
        ? d
        : { ...d, over, before }
    );

  const halves = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };

  const take = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };

  // A folder head answers to both drags and tells them apart by type alone: a
  // session dropped on it goes *into* it, a folder dropped on it goes before or
  // after it. A drag carries exactly one of the two, so there is nothing to
  // disambiguate at the point of the drop.
  const folderOver = (id) => (e) => {
    if (carries(e, DND_SESSION)) {
      take(e);
      markOver({ type: 'folder', id }, false);
      return;
    }
    if (carries(e, DND_FOLDER)) {
      take(e);
      markOver({ type: 'folder', id }, halves(e));
    }
  };

  const folderDrop = (id) => (e) => {
    if (carries(e, DND_SESSION)) {
      take(e);
      const moving = e.dataTransfer.getData(DND_SESSION) || sdrag.id;
      // Onto the head means into the folder, at the end. There is no row under
      // the pointer to measure against, and the end is where a thing you have
      // just filed belongs.
      if (moving && !isNoopPlace(folders, moving, id, null)) onPlaceSession(moving, id, null);
      clearSdrag();
      return;
    }
    if (carries(e, DND_FOLDER)) {
      take(e);
      const moving = e.dataTransfer.getData(DND_FOLDER) || sdrag.id;
      if (moving && moving !== id) {
        const rest = folders.filter((f) => f.id !== moving);
        const at = rest.findIndex((f) => f.id === id) + (sdrag.before ? 0 : 1);
        onMoveFolder(moving, at);
      }
      clearSdrag();
    }
  };

  // A row inside a folder: insert before or after it, in that folder.
  const rowOver = (folderId, sessionId) => (e) => {
    if (!carries(e, DND_SESSION)) return;
    take(e);
    markOver({ type: 'row', id: sessionId, folderId }, halves(e));
  };

  const rowDrop = (folderId, sessionId) => (e) => {
    if (!carries(e, DND_SESSION)) return;
    take(e);
    const moving = e.dataTransfer.getData(DND_SESSION) || sdrag.id;
    const folder = foldersById.get(folderId);
    if (moving && folder) {
      const at = dropIndex(folder.sessionIds, moving, sessionId, sdrag.before);
      if (!isNoopPlace(folders, moving, folderId, at)) onPlaceSession(moving, folderId, at);
    }
    clearSdrag();
  };

  // Out of every folder. The loose list orders itself by when each session was
  // last used, so this shows a region rather than an insertion point — drawing a
  // caret would promise a position that is not the user's to set.
  const looseOver = (e) => {
    if (!carries(e, DND_SESSION)) return;
    take(e);
    markOver({ type: 'loose', id: null }, false);
  };

  const looseDrop = (e) => {
    if (!carries(e, DND_SESSION)) return;
    take(e);
    const moving = e.dataTransfer.getData(DND_SESSION) || sdrag.id;
    if (moving && !isNoopPlace(folders, moving, null, null)) onPlaceSession(moving, null, null);
    clearSdrag();
  };

  const toggleFolder = (id) =>
    setShutFolders((shut) => {
      const next = new Set(shut);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Shut while a folder is being carried, mirroring the rule the categories
  // already follow: a list of drop targets that grew and shrank under the
  // pointer as it passed each one would be a moving target.
  const folderOpen = (id) => !shutFolders.has(id) && sdrag.kind !== 'folder';

  const addFolder = async () => {
    const record = await onNewFolder();
    // Straight into its own name. A folder called "New Folder" is worth exactly
    // as much as a session called "New Session", and this is the one moment
    // somebody is certain to know what it is for.
    if (record?.id) setRenaming(record.id);
  };

  const moveFolderBy = (id, delta) => {
    const at = folders.findIndex((f) => f.id === id);
    if (at >= 0) onMoveFolder(id, at + delta);
  };

  // What a session is for, in the line under its name: the agents it asks, or
  // that it has not been given any yet. The names come from the roster rather
  // than from the record, so a renamed agent is renamed here too — and an agent
  // that has gone drops out of the line rather than being counted in it.
  // `folderId` is the folder this row is being drawn inside, or null for a loose
  // one. It decides two things and nothing else: whether the row is a drop
  // target for another session, and where a drop lands.
  //
  // `fixed` is for the rows that are not in the Sessions list at all — a live
  // room somebody else runs, drawn under its own heading. Filing one is not
  // refused so much as meaningless: it is not in the list a folder draws from,
  // so a drop would file something that then failed to appear where it was put.
  const sessionRow = (s, folderId = null, { fixed = false } = {}) => {
    // A room another machine runs asks their agents, so the line under it names
    // theirs: resolving it against this machine's roster answers "no agent yet"
    // about a session with three of them in it.
    const names = s.hostPeerId
      ? (s.roomCounsel || []).map((a) => a.name)
      : sessionCounsel(s, askableAgents).map((a) => a.name);
    // The day the session was started, beside its name. Sessions are ordered by
    // when they were last used, so the list itself says nothing about age — and
    // every session begins life called "New Session", which makes the date the
    // only thing telling two untitled ones apart until somebody names them.
    const created = formatShortDate(s.createdAt);
    const over = sdrag.over;
    const edge =
      over && over.type === 'row' && over.id === s.id && sdrag.id !== s.id
        ? sdrag.before
          ? 'drop-before'
          : 'drop-after'
        : '';
    return (
      <div
        key={s.id}
        // Named in the DOM the way a category and a folder are, so the browser
        // harness can point at one row rather than counting its way to it.
        data-row={s.id}
        className={`peer session ${s.id === selectedId ? 'active' : ''} ${
          invitations[s.id] ? 'invited' : ''
        } ${edge}`}
        onClick={() => onSelect(s.id)}
        draggable={!fixed}
        onDragStart={fixed ? undefined : sessionDragStart(s.id)}
        onDragEnd={fixed ? undefined : clearSdrag}
        // Only a row inside a folder is a place to insert. A loose row has no
        // order to insert into — the loose list sorts itself — so the region
        // around it takes the drop instead.
        onDragOver={folderId ? rowOver(folderId, s.id) : undefined}
        onDrop={folderId ? rowDrop(folderId, s.id) : undefined}
      >
        <span className="session-mark" aria-hidden="true">
          <Sessions size={17} />
        </span>
        <div className="meta">
          <div className="name">
            <span className="name-text">{s.title}</span>
            {created && (
              <span className="session-date" title={`Created ${new Date(s.createdAt).toLocaleString()}`}>
                {created}
              </span>
            )}
          </div>
          <div className="sub">
            {invitations[s.id]
              ? 'Invitation · waiting for you'
              : sessionSubLine({ allAgents: s.allAgents, names })}
          </div>
        </div>
        {unread[s.id] > 0 && <span className="unread-dot">{unread[s.id]}</span>}
      </div>
    );
  };

  const peerRow = (p) => (
    <div
      key={p.id}
      className={`peer ${p.id === selectedId ? 'active' : ''} ${p.online ? '' : 'offline'} ${
        summoned[p.id] ? 'summoned' : ''
      }`}
      onClick={() => onSelect(p.id)}
    >
      <Avatar name={p.name} id={p.id} avatar={p.avatar} online={p.online} />
      <div className="meta">
        <div className="name">
          <span className="name-text">{p.name || p.hostname || 'Unknown'}</span>
          {p.shared && (
            <span className="tag" title="Shared with you from another tailnet">
              shared
            </span>
          )}
          {p.kind === 'agent' && (
            <span className="tag" title={`Agent connected over ${p.agentKind}`}>
              agent
            </span>
          )}
          {/* Where this thread stands in the queue for a shared agent, so
              waiting your turn is visible rather than looking like the
              agent is ignoring you. */}
          <QueueBadge peer={p} />
        </div>
        <div className="sub">
          {p.kind === 'agent'
            ? // Summoned and not opened yet. Said here rather than as a second
              // tag beside the name: at this width two tags squeeze the name
              // down to "Tes…", and the name is the thing being looked for. The
              // subtitle already carries what the row is doing, and it has the
              // room.
              //
              // In words as well as in the pulse, because the pulse is the one
              // part of this a reader with motion turned off will never see.
              summoned[p.id]
              ? `Summoned · via ${p.viaName}`
              : // A shared agent says whose it is, so it is never mistaken for
                // one of your own: `delegate` is a peer's conversation with
                // your agent, `remote` is an agent a peer shared with you.
                p.delegate || p.remote
                ? `Agent · via ${p.viaName}`
                : p.online
                  ? `Agent · ${p.agentKind}`
                  : 'Agent · off'
            : p.online
              ? platformLabel(p.platform) || 'Online'
              : authFailures[p.id]
                ? refusalLabel(authFailures[p.id])
                : 'Offline'}
          {showAddresses && p.address ? ` · ${p.address.split(':')[0]}` : ''}
        </div>
      </div>
      {unread[p.id] > 0 && <span className="unread-dot">{unread[p.id]}</span>}
      {!unread[p.id] && queued[p.id] > 0 && (
        <span className="queued-dot" title={`${queued[p.id]} message(s) waiting to send`}>
          {queued[p.id]}
        </span>
      )}
    </div>
  );

  // The three things done to the roster rather than to one person. They live in
  // the People heading, which is where they have always been — a heading that
  // can now be shut, so they fade in with the grip and the lock on hover rather
  // than sitting on top of a title that is meant to read as a title.
  // The one thing done to the Sessions list rather than to one session. It sits
  // in the heading, left of the lock, in the slot the People heading's three
  // already use — so it fades in with the grip and the lock on hover rather than
  // sitting on top of a title meant to read as a title.
  const sessionsActions = (
    <button className="icon-btn sb-action" onClick={addFolder} title="New folder">
      <Plus size={16} />
    </button>
  );

  const peopleActions = (
    <>
      <button className="icon-btn sb-action" onClick={onNewGroupCall} title="Start a group call">
        <GroupCall size={16} />
      </button>
      <button className="icon-btn sb-action" onClick={onRefresh} title="Refresh">
        <Refresh size={15} />
      </button>
      <button className="icon-btn sb-action" onClick={onAddPeer} title="Add peer by IP">
        <Plus size={16} />
      </button>
    </>
  );

  // What is under each heading. Every category renders whether or not it has
  // anything in it: four headings that are always the same four, in whatever
  // order they have been put in, is the thing being dragged and locked — one
  // that came and went with its contents would move the others under the
  // pointer, and could not be given a place to sit at all.
  // The Sessions list: folders first, then whatever is in none of them.
  //
  // The two halves are ordered by different things on purpose. Inside a folder
  // the order is the one you dragged them into; outside, it is still the most
  // recently used first, which is what the list has always done and what makes
  // the session you were just in the one at the top. Filing something is how you
  // opt out of that, per folder.
  //
  // **A search flattens all of it.** A search is a question about sessions, not
  // about where they were filed, and a folder with no matches would be a shut
  // box the searcher has to open to disprove. It also removes a whole class of
  // bug: a drop index measured against a *filtered* list writes the wrong
  // position into the record.
  const sessionsBody = (rows) => {
    if (searching) {
      return rows.length ? (
        rows.map((h) => sessionRow(h.item))
      ) : (
        <div className="empty-hint">No sessions yet. The button above starts one.</div>
      );
    }

    const loose = looseSessions(
      rows.map((h) => h.item),
      folders
    );
    if (!folders.length && !loose.length) {
      return <div className="empty-hint">No sessions yet. The button above starts one.</div>;
    }

    const carrying = sdrag.kind === 'session';
    const over = sdrag.over;

    return (
      <>
        {folders.map((f) => {
          const inside = folderSessions(f, sessionsById);
          return (
            <SessionFolder
              key={f.id}
              id={f.id}
              name={f.name}
              count={inside.length}
              open={folderOpen(f.id)}
              editing={renaming === f.id}
              onToggle={() => toggleFolder(f.id)}
              onEditing={(on) => setRenaming(on ? f.id : null)}
              onRename={(name) => onRenameFolder(f.id, name)}
              onDelete={() => onDeleteFolder(f.id)}
              onMove={(delta) => moveFolderBy(f.id, delta)}
              dropInto={carrying && over?.type === 'folder' && over.id === f.id}
              dropEdge={
                sdrag.kind === 'folder' && over?.type === 'folder' && over.id === f.id && sdrag.id !== f.id
                  ? sdrag.before
                    ? 'before'
                    : 'after'
                  : null
              }
              onDragStart={folderDragStart(f.id)}
              onDragEnd={clearSdrag}
              onDragOver={folderOver(f.id)}
              onDrop={folderDrop(f.id)}
            >
              {inside.length ? (
                inside.map((s) => sessionRow(s, f.id))
              ) : (
                <div className="empty-hint folder-empty">Drag a session here.</div>
              )}
            </SessionFolder>
          );
        })}
        {/* Everything in no folder. A region rather than a list of drop targets:
            its order is not the user's to set, so there is no insertion point to
            draw and dropping anywhere in it means the same thing. */}
        <div
          className={`loose-sessions ${carrying && over?.type === 'loose' ? 'drop-out' : ''}`}
          onDragOver={looseOver}
          onDrop={looseDrop}
        >
          {loose.map((s) => sessionRow(s))}
          {/* Only while something is being carried, and only when it came out of
              a folder — an empty region has no height to aim at, and a strip
              inviting a drop that would change nothing is noise. */}
          {carrying && folderOf(folders, sdrag.id) && <div className="loose-drop">Not in a folder</div>}
        </div>
      </>
    );
  };

  const sectionBody = (id) => {
    const rows = hits[id];
    // A category that is being searched and found nothing says so about the
    // search, not about itself: "no sessions yet" would be a lie told to
    // somebody who has plenty and simply mistyped one.
    if (searching && (!scoped || scope === id) && rows.length === 0) {
      return <div className="empty-hint">Nothing here matches “{q.trim()}”.</div>;
    }
    switch (id) {
      // No folders and no dragging in here: there is nothing to arrange. It is
      // the rooms that are open right now, drawn by the same row as any other
      // session — which already knows how to say whose agents a room asks and
      // that an invitation is waiting.
      case NETMAKER.id: {
        const rows = hits.netmaker;
        if (!netmaker.networks || !netmaker.networks.length) {
          return <div className="empty-hint">This machine is not on a Netmaker network.</div>;
        }
        if (!rows.length) {
          return (
            <div className="empty-hint">
              Nobody else is visible on your Netmaker networks yet. A node appears here once netclient or a
              server you added lists it.
            </div>
          );
        }
        return rows.map(({ item: n }) => (
          <div
            key={`${n.key}:${n.address}`}
            className="peer offline"
            title="On a Netmaker network but not running LanChat"
          >
            <Avatar name={n.name || n.address} id={n.address} />
            <div className="meta">
              <div className="name">
                <span className="name-text">{n.name || n.address}</span>
                {n.foreign && <span className="tag">not your network</span>}
              </div>
              <div className="sub">{n.network ? `${n.network} · ` : ''}app not running</div>
            </div>
          </div>
        ));
      }
      case SHARED.id:
        return rows.map((h) => sessionRow(h.item, null, { fixed: true }));
      case 'sessions':
        return sessionsBody(rows);
      case 'agents':
        return rows.length ? (
          rows.map((h) => peerRow(h.item))
        ) : (
          <div className="empty-hint">
            No agents yet. One appears here when you connect an agent on this machine, or when a peer shares
            theirs with you.
          </div>
        );
      case 'people':
        return rows.length ? (
          rows.map((h) => peerRow(h.item))
        ) : (
          <div className="empty-hint">
            No LanChat users found yet. People on your Tailscale network or LAN who run LanChat show up here
            automatically. You can also add one by IP with the + button.
          </div>
        );
      case 'tailnet':
      default:
        // An empty tailnet list is ambiguous on its own — say which of "no CLI",
        // "signed out" or "nothing there" it actually is. The two used to be
        // separate blocks with a heading each, which printed the heading twice
        // whenever Tailscale was down *and* something had been seen earlier.
        if (tailnetStatus && tailnetStatus.ok === false) {
          return (
            <div className="empty-hint">
              {tailnetStatus.reason === 'not-installed'
                ? 'The Tailscale command-line tool was not found, so tailnet peers cannot be listed. Peers on your local network still appear above.'
                : 'Tailscale is not responding — check that it is running and signed in.'}
            </div>
          );
        }
        if (!rows.length) {
          return (
            <div className="empty-hint">
              {onlineTailnet
                ? 'Everything online on your tailnet is running LanChat.'
                : 'No other devices on your tailnet are online.'}
            </div>
          );
        }
        return rows.map(({ item: t }) => (
          <div key={t.ip} className="peer offline" title="Online on Tailscale but not running LanChat">
            <Avatar name={t.hostname} id={t.ip} />
            <div className="meta">
              <div className="name">
                <span className="name-text">{t.hostname}</span>
              </div>
              <div className="sub">{platformLabel(t.os)} · app not running</div>
            </div>
          </div>
        ));
    }
  };

  return (
    <div className="sidebar">
      <div className="me">
        <Avatar name={self?.name} id={self?.id} avatar={self?.avatar} online />
        <div className="meta">
          <div className="name">{self?.name || 'You'}</div>
          <div className="sub">
            {self?.hostname} · {platformLabel(self?.platform)}
          </div>
        </div>
      </div>

      {/* The things you do to this machine rather than to a conversation, on
          their own line under the name. They used to share the row with it,
          which left three targets crowded against the edge and no room for a
          fourth. */}
      <div className="me-actions">
        <button className="icon-btn" onClick={onOpenProfile} title="Edit profile" aria-label="Edit profile">
          <Users size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenDev} title="Developer" aria-label="Developer">
          <Code size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={18} />
        </button>
        <button className="icon-btn" onClick={onNewSession} title="New session" aria-label="New session">
          <Sessions size={18} />
        </button>
        {/* Beside New session on purpose: one button makes a workspace and the
            one next to it is where a workspace goes when it is deleted, so the
            two ends of a session's life sit together. The count is the whole of
            what it has to say — a Trash with something in it is a Trash worth
            opening — and it is left off entirely when empty rather than shown
            as a nought. */}
        <button
          className={`icon-btn ${trashOpen ? 'on' : ''}`}
          onClick={onOpenTrash}
          title={trashCount ? `Trash (${trashCount})` : 'Trash'}
          aria-label={trashCount ? `Trash, ${trashCount} deleted` : 'Trash'}
          aria-pressed={trashOpen}
        >
          <Trash size={18} />
          {trashCount > 0 && <span className="trash-count">{trashCount}</span>}
        </button>
      </div>

      {/* One box for everything under it. The chip on the left says which of the
          four categories it is asking — or none of them, which means all four —
          and the placeholder says the same thing in words, because a chip
          showing a magnifier and a chevron is not a sentence. */}
      <div className="sidebar-search">
        <div className="search-box">
          <SearchScope scope={scope} order={order} onChange={(id) => onSearch({ scope: id })} />
          <input
            value={q}
            onChange={(e) => onSearch({ q: e.target.value })}
            onKeyDown={(e) => {
              // Escape undoes the search one step at a time: the words first,
              // then what they were aimed at. Clearing both at once would take
              // away a scope somebody set deliberately because they mistyped.
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              if (q) onSearch({ q: '' });
              else if (scoped) onSearch({ scope: SCOPE_ALL });
            }}
            placeholder={searchPlaceholder(scope)}
            aria-label={searchPlaceholder(scope)}
          />
        </div>
      </div>

      <div className="peer-list">
        {/* Above everything, and only while there is one. A room somebody else
            runs is the one thing in this panel that arrived rather than being
            put here, so it is not filed among the four a person has arranged —
            it appears on top, says so, and goes when the room does.

            Held back while a category is being carried: the four headings are a
            short list to drop into, and one more appearing under the pointer
            would move every target in it. It arrives the moment the drag ends. */}
        {(netmaker.networks || []).length > 0 && !drag.id && (
          // Same two elements as below, for the same reason: a category arriving
          // has to make room for itself and a height cannot be animated to auto.
          <div className="sb-pop">
            <div className="sb-pop-inner">
              <SidebarSection
                key={NETMAKER.id}
                id={NETMAKER.id}
                title={sectionTitle(NETMAKER.id)}
                pinned
                expanded={isExpanded(NETMAKER.id)}
                quiet={isQuiet(NETMAKER.id)}
                flashing={false}
                count={signals.netmaker.count}
                alert={signals.netmaker.alert}
                onHover={onHover}
                onToggle={toggleNetmaker}
              >
                {sectionBody(NETMAKER.id)}
              </SidebarSection>
            </div>
          </div>
        )}
        {rooms.length > 0 && !drag.id && (
          // Two elements around it for the same reason .sb-body has two: a
          // category arriving has to make room for itself, and a height cannot
          // be animated to `auto`. The outer is the track being opened from
          // nothing, the inner is what is clipped while it opens.
          <div className="sb-pop">
            <div className="sb-pop-inner">
              <SidebarSection
                key={SHARED.id}
                id={SHARED.id}
                title={sectionTitle(SHARED.id)}
                pinned
                expanded={isExpanded(SHARED.id)}
                quiet={isQuiet(SHARED.id)}
                flashing={!isExpanded(SHARED.id) && signals.shared.alert}
                count={signals.shared.count}
                alert={signals.shared.alert}
                onHover={onHover}
                onToggle={toggleShared}
              >
                {sectionBody(SHARED.id)}
              </SidebarSection>
            </div>
          </div>
        )}
        {order.map((id) => (
          <SidebarSection
            key={id}
            id={id}
            title={sectionTitle(id)}
            expanded={isExpanded(id)}
            locked={locked.includes(id)}
            quiet={isQuiet(id)}
            flashing={!isExpanded(id) && signals[id].alert}
            count={signals[id].count}
            alert={signals[id].alert}
            dragging={Boolean(drag.id)}
            dropEdge={
              drag.id && drag.overId === id && drag.id !== id ? (drag.before ? 'before' : 'after') : null
            }
            actions={id === 'people' ? peopleActions : id === 'sessions' ? sessionsActions : null}
            onHover={onHover}
            onToggleLock={toggleLock}
            onMove={move}
            onDragStart={dragStart(id)}
            onDragOver={dragOver(id)}
            onDrop={drop(id)}
            onDragEnd={dragEnd}
          >
            {sectionBody(id)}
          </SidebarSection>
        ))}
      </div>
    </div>
  );
}
