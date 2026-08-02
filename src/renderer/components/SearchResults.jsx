import React, { useEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { X, Sessions as SessionsIcon } from '../lib/icons.jsx';
import { formatShortDate, platformLabel } from '../lib/util.js';
import { matchRanges, sliceRuns } from '../lib/findInThread.js';
import { SCOPE_ALL, searchSection, sectionTitle, normalizeOrder } from '../lib/sidebarSections.js';
import { sessionCounsel, sessionSubLine } from '../lib/counselCopy.js';

// What a search found, in the room where there is space to read it.
//
// The sidebar shows the same matches, but a 260px column shows them the way it
// shows everything else — a name and a line under it, clipped. Here a result can
// say what it is and why it is here, which matters most for the hits nobody can
// see coming: a search for "100.64" lands on an address the row was never
// displaying, and without a word about it the result looks like a bug.
//
// This lies *over* the conversation rather than replacing it. ChatPane keeps its
// own scroll position and the composer keeps whatever was being typed in it, so
// closing this puts the reader back exactly where they were — a search should
// never cost somebody a half-written message.

// Which words a matched field is reported with. `name` is left unsaid: it is
// what the row already shows in bold, and "matched name: Elijah" under the word
// Elijah is noise.
const FIELD_WORDS = {
  hostname: 'hostname',
  platform: 'system',
  address: 'address',
  connector: 'connector',
};

// The matched span, marked. Reuses the find bar's scanner so the roster and a
// conversation agree about what "matching" means, down to the offsets.
function Marked({ text, q }) {
  const runs = useMemo(() => {
    const s = String(text ?? '');
    return sliceRuns([{ text: s }], matchRanges(s, q));
  }, [text, q]);
  return (
    <>
      {runs.map((run, i) =>
        // `hit` is the occurrence's ordinal, and the first one is nought — so
        // this asks whether there is a hit rather than whether it is truthy.
        run.hit !== null && run.hit !== undefined ? (
          <mark key={i} className="result-hit">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        )
      )}
    </>
  );
}

export default function SearchResults({
  search,
  sessions = [],
  peers = [],
  // Everyone a session can be pointed at, for the line under its title. Read
  // through counselCopy rather than worked out here: a session's counsel is said
  // in one place so that no two surfaces can end up naming a different set.
  askableAgents = [],
  tailnet = [],
  unread = {},
  order,
  onSelect,
  onClose,
}) {
  const q = (search.q || '').trim();
  const scope = search.scope || SCOPE_ALL;
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  const groups = useMemo(() => {
    const agents = peers.filter((p) => p.kind === 'agent');
    const people = peers.filter((p) => p.kind !== 'agent');
    const noApp = (tailnet || []).filter((t) => t.online && !t.hasApp);
    const source = { sessions, agents, people, tailnet: noApp };

    return normalizeOrder(order)
      .filter((id) => scope === SCOPE_ALL || scope === id)
      .map((id) => ({ id, title: sectionTitle(id), rows: searchSection(id, source[id], q, platformLabel) }))
      .filter((g) => g.rows.length > 0);
  }, [sessions, peers, tailnet, order, q, scope]);

  // One flat walk over everything found, so the arrow keys cross a category
  // boundary without anybody having to think about categories.
  const flat = useMemo(
    () => groups.flatMap((g) => g.rows.map((row) => ({ ...row, section: g.id }))),
    [groups]
  );
  const total = flat.length;

  // A new query is a new list: staying on row 7 of a list that now has two would
  // leave the highlight nowhere.
  useEffect(() => setActive(0), [q, scope]);

  // Only sessions, agents and people are conversations. A tailnet device is a
  // machine that is not running LanChat — there is nothing to open, and a row
  // that looked openable and did nothing would be worse than one that plainly is
  // not.
  const openable = (row) => row.section !== 'tailnet';

  const open = (row) => {
    if (!openable(row)) return;
    onSelect(row.item.id);
    onClose();
  };

  useEffect(() => {
    const keys = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!total) return;
        e.preventDefault();
        setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % total : (i - 1 + total) % total));
      } else if (e.key === 'Enter' && total) {
        const row = flat[Math.min(active, total - 1)];
        if (row && openable(row)) {
          e.preventDefault();
          open(row);
        }
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  // Keep the highlighted row on screen when the keys walk past the fold.
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('.result.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let index = -1;

  return (
    <div className="search-results" role="region" aria-label="Search results">
      {/* The light, once, left to right, behind everything. It is gone by the
          time anybody has finished reading the heading, and it never returns:
          decorative motion in this app does not repeat — only signals do. */}
      <div className="search-shine" aria-hidden="true" />

      <div className="results-head">
        <div className="results-count">
          {total === 0 ? 'No matches' : `${total} ${total === 1 ? 'match' : 'matches'}`} for “{q}”
          {scope !== SCOPE_ALL && <span className="results-scope">in {sectionTitle(scope)}</span>}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close search" aria-label="Close search">
          <X size={18} />
        </button>
      </div>

      <div className="results-list" ref={listRef}>
        {total === 0 && (
          <div className="results-empty">
            Nothing matches “{q}”{scope !== SCOPE_ALL ? ` in ${sectionTitle(scope)}` : ''}. Names, hostnames,
            systems, addresses and agent connectors are all searched.
          </div>
        )}

        {groups.map((g) => (
          <section key={g.id} className="result-group">
            <div className="result-group-head">
              <span className="result-group-title">{g.title}</span>
              <span className="result-group-count">{g.rows.length}</span>
            </div>

            {g.rows.map(({ item, field, text }) => {
              index += 1;
              const at = index;
              const isSession = g.id === 'sessions';
              const isDevice = g.id === 'tailnet';
              const name = isSession ? item.title : item.name || item.hostname || 'Unknown';
              const sub = isSession
                ? sessionSubLine({
                    allAgents: item.allAgents,
                    names: sessionCounsel(item, askableAgents).map((a) => a.name),
                  })
                : isDevice
                  ? `${platformLabel(item.os)} · app not running`
                  : item.kind === 'agent'
                    ? `Agent · ${item.agentKind || 'off'}`
                    : platformLabel(item.platform) || (item.online ? 'Online' : 'Offline');

              return (
                <div
                  key={isDevice ? item.ip : item.id}
                  className={`result ${at === active ? 'active' : ''} ${isDevice ? 'inert' : ''}`}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => open({ item, section: g.id })}
                >
                  {isSession ? (
                    <span className="session-mark" aria-hidden="true">
                      <SessionsIcon size={18} />
                    </span>
                  ) : (
                    <Avatar
                      name={isDevice ? item.hostname : item.name}
                      id={isDevice ? item.ip : item.id}
                      avatar={item.avatar}
                      online={isDevice ? false : item.online}
                    />
                  )}

                  <div className="result-meta">
                    <div className="result-name">
                      {/* The name is one flex item, whatever it is made of.
                          .result-name spaces its children by 8px, and a matched
                          name is not one node but a run per marked span — so
                          without this wrapper a search for "Ses" drew "New Ses
                          sion", the gap opening inside the word at exactly the
                          place the search had found. */}
                      <span className="result-name-text">
                        {field === 'name' ? <Marked text={name} q={q} /> : name}
                      </span>
                      {/* The same date the sidebar row carries, drawn by the
                          same rule. A search for a session is most often a
                          search among several called "New Session", which is
                          precisely when a result showing only the title
                          identifies nothing. */}
                      {isSession && formatShortDate(item.createdAt) && (
                        <span
                          className="session-date"
                          title={`Created ${new Date(item.createdAt).toLocaleString()}`}
                        >
                          {formatShortDate(item.createdAt)}
                        </span>
                      )}
                      {unread[item.id] > 0 && <span className="unread-dot">{unread[item.id]}</span>}
                    </div>
                    <div className="result-sub">{sub}</div>
                    {/* Why this row is here, when the reason is not the name.
                        Without it a hit on an address or a connector kind reads
                        as the search having gone wrong. */}
                    {field && field !== 'name' && (
                      <div className="result-why">
                        {FIELD_WORDS[field] || field} <Marked text={text} q={q} />
                      </div>
                    )}
                  </div>

                  {isDevice && <span className="result-note">not on LanChat</span>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
