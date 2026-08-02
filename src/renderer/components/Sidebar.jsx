import React, { useState, useMemo } from 'react';
import Avatar from './Avatar.jsx';
import QueueBadge from './QueueBadge.jsx';
import SidebarSection from './SidebarSection.jsx';
import SearchScope from './SearchScope.jsx';
import { Settings, Plus, Refresh, Users, GroupCall, Code, Sessions, Trash } from '../lib/icons.jsx';
import { formatShortDate, platformLabel } from '../lib/util.js';
import { sessionCounsel, sessionSubLine } from '../lib/counselCopy.js';
import {
  SCOPE_ALL,
  normalizeOrder,
  moveSection,
  searchPlaceholder,
  searchSection,
  sectionForThread,
  sectionSignal,
  sectionTitle,
} from '../lib/sidebarSections.js';

// A drag carrying a category, told apart from a drag carrying files. The window
// puts a "drop to send" sheet over the conversation for anything dragged into
// it, and re-ordering the panel is not that — so the type is checked rather than
// assumed, on the way in here and again in App.jsx on the way out.
const DND_TYPE = 'application/x-lanchat-section';
const carriesSection = (e) => Array.from(e.dataTransfer?.types || []).includes(DND_TYPE);

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
  selectedId,
  unread,
  // Agents summoned and not yet opened. A summon writes no message, so there is
  // no unread count to carry it — the row says so itself, until it is clicked.
  summoned = {},
  queued = {},
  authFailures = {},
  showAddresses,
  sessions = [],
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
  const [drag, setDrag] = useState({ id: null, overId: null, before: false });

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

  // What each category has to show, and what it matched on.
  //
  // A category the search is not aimed at is not searched: pointing the box at
  // Sessions and then opening People should show the people, all of them. The
  // query is about the category it was aimed at, and nothing else.
  //
  // Tailnet devices are in here now. They used to be the one list the box could
  // not touch — it filtered the three above them and left the machines below
  // untouched, which read as a search that had stopped working halfway down.
  const hits = useMemo(() => {
    const qFor = (id) => (!scoped || scope === id ? q : '');
    return {
      sessions: searchSection('sessions', sessions, qFor('sessions'), platformLabel),
      agents: searchSection('agents', allAgents, qFor('agents'), platformLabel),
      people: searchSection('people', allPeople, qFor('people'), platformLabel),
      tailnet: searchSection('tailnet', noApp, qFor('tailnet'), platformLabel),
    };
  }, [sessions, allAgents, allPeople, noApp, q, scope, scoped]);

  const shownCount = {
    sessions: hits.sessions.length,
    agents: hits.agents.length,
    people: hits.people.length,
    tailnet: hits.tailnet.length,
  };

  const signals = {
    sessions: sectionSignal(sessions, unread, summoned),
    agents: sectionSignal(allAgents, unread, summoned),
    people: sectionSignal(allPeople, unread, summoned),
    tailnet: { count: 0, alert: false },
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
  const isExpanded = (id) =>
    !drag.id &&
    (hovered === id ||
      (scoped
        ? id === scope
        : locked.includes(id) || id === activeSection || (searching && shownCount[id] > 0)));

  // The categories the search is not about, said quietly. A flashing one is
  // never quietened: something arrived for you, and a filter you applied to the
  // panel does not get to decide you should not hear about it.
  const isQuiet = (id) => scoped && id !== scope && !signals[id].alert;

  const onHover = (id, open) => setHovered((h) => (open ? id : h === id ? null : h));

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

  // What a session is for, in the line under its name: the agents it asks, or
  // that it has not been given any yet. The names come from the roster rather
  // than from the record, so a renamed agent is renamed here too — and an agent
  // that has gone drops out of the line rather than being counted in it.
  const sessionRow = (s) => {
    const names = sessionCounsel(s, askableAgents).map((a) => a.name);
    // The day the session was started, beside its name. Sessions are ordered by
    // when they were last used, so the list itself says nothing about age — and
    // every session begins life called "New Session", which makes the date the
    // only thing telling two untitled ones apart until somebody names them.
    const created = formatShortDate(s.createdAt);
    return (
      <div
        key={s.id}
        className={`peer session ${s.id === selectedId ? 'active' : ''}`}
        onClick={() => onSelect(s.id)}
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
          <div className="sub">{sessionSubLine({ allAgents: s.allAgents, names })}</div>
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
  const sectionBody = (id) => {
    const rows = hits[id];
    // A category that is being searched and found nothing says so about the
    // search, not about itself: "no sessions yet" would be a lie told to
    // somebody who has plenty and simply mistyped one.
    if (searching && (!scoped || scope === id) && rows.length === 0) {
      return <div className="empty-hint">Nothing here matches “{q.trim()}”.</div>;
    }
    switch (id) {
      case 'sessions':
        return rows.length ? (
          rows.map((h) => sessionRow(h.item))
        ) : (
          <div className="empty-hint">No sessions yet. The button above starts one.</div>
        );
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
            actions={id === 'people' ? peopleActions : null}
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
