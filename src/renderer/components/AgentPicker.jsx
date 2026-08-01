import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Dot } from '../lib/icons.jsx';
import { agentNote, chipLabel } from '../lib/counselCopy.js';

// Who a session asks.
//
// This was a `<select>` for as long as a session asked exactly one agent, which
// is what a `<select>` is for. It cannot be one any more: a counsel is several
// agents at once, and the native multiple-select — a scrolling box where choices
// are made by ctrl-clicking — is a control almost nobody knows how to work and
// which looks nothing like the rest of this window.
//
// So it is a menu of checkboxes, built on the same bones as the sidebar's search
// scope: the same chip, the same pointerdown-away, the same Escape. What it does
// differently is stay open. A multi-select that shut itself after every tick
// would make assembling a counsel of three into three trips through the same
// menu, and the whole point of the thing is comparing agents against each other.
//
// `role="menuitemcheckbox"` rather than a listbox of options, because a listbox
// announces itself as a single choice and this is not one. The mode rows below
// are `menuitemradio` for the same reason in reverse: those two really are one
// choice.
export default function AgentPicker({
  agents = [],
  agentIds = [],
  allAgents = false,
  mode = 'parallel',
  onChange,
}) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  // Clicking anywhere else puts it away. Pointerdown rather than click so the
  // menu is gone before whatever was clicked acts on it.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!box.current || !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Agents this session was pointed at that are not here any more — switched
  // off is not the same thing and stays in the list above; this is removed, or
  // belonging to a peer who stopped sharing. Shown, ticked and dimmed, rather
  // than silently dropped: a session that says it asks three agents and only
  // ever gets two answers should be able to see why, and un-tick the third.
  const missing = agentIds.filter((id) => !agents.some((a) => a.id === id));

  const chosen = (id) => allAgents || agentIds.includes(id);
  const names = agents.filter((a) => chosen(a.id)).map((a) => a.name);
  const label = chipLabel({ allAgents, names: allAgents ? agents.map((a) => a.name) : names });

  // Ticking one agent while the session is set to ask everybody is how a
  // standing instruction becomes a list. There is no list to take a name out of
  // until that moment, so it is written down here — everybody who is here now,
  // less the one just un-ticked — and from then on the session asks that set
  // rather than whoever turns up.
  const toggle = (id) => {
    if (allAgents) {
      onChange({ allAgents: false, agentIds: agents.filter((a) => a.id !== id).map((a) => a.id) });
      return;
    }
    const next = agentIds.includes(id) ? agentIds.filter((x) => x !== id) : [...agentIds, id];
    onChange({ allAgents: false, agentIds: next });
  };

  // Space and Enter tick without closing; the browser gives Enter to a button
  // for free, and Space is added so the two behave alike on a row that is a
  // checkbox in everything but tag name.
  const keys = (e, act) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      act();
    }
  };

  const row = (key, { checked, disabled, onPick, title, name, note, tone }) => (
    <li key={key} role="none">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        className={['agent-pick', checked ? 'on' : '', tone || ''].filter(Boolean).join(' ')}
        disabled={disabled}
        onClick={onPick}
        onKeyDown={(e) => keys(e, onPick)}
        title={title}
      >
        <span className="agent-tick" aria-hidden="true">
          {checked ? <Check size={13} /> : null}
        </span>
        <span className="agent-pick-text">
          <span className="agent-pick-name">{name}</span>
          {note && <span className="agent-pick-note">{note}</span>}
        </span>
      </button>
    </li>
  );

  const modeRow = (value, name, note) => (
    <li role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={mode === value}
        className={`agent-pick agent-mode ${mode === value ? 'on' : ''}`}
        onClick={() => onChange({ mode: value })}
        onKeyDown={(e) => keys(e, () => onChange({ mode: value }))}
      >
        <span className="agent-tick" aria-hidden="true">
          {mode === value ? <Dot size={13} /> : null}
        </span>
        <span className="agent-pick-text">
          <span className="agent-pick-name">{name}</span>
          <span className="agent-pick-note">{note}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div className="agent-picker" ref={box}>
      <button
        type="button"
        className={`agent-chip ${allAgents || agentIds.length ? 'set' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'ArrowDown' && !open) setOpen(true);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="The agents this session asks"
      >
        <span className="agent-chip-text">{label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <ul
          className="agent-menu"
          role="menu"
          aria-label="The agents this session asks"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {row('__all__', {
            checked: allAgents,
            onPick: () => onChange({ allAgents: true, agentIds: [] }),
            name: 'All agents',
            note: 'anyone added or shared later joins automatically',
          })}
          <li role="none" className="agent-menu-rule" />

          {agents.length === 0 && <li className="agent-menu-empty">No agents yet — add one in Settings.</li>}
          {agents.map((a) =>
            row(a.id, {
              checked: chosen(a.id),
              onPick: () => toggle(a.id),
              name: a.name,
              // An agent that cannot take a question right now can still be
              // ticked: a counsel is a standing choice about who to ask, and it
              // should survive somebody turning their machine off overnight. The
              // question skips them and says so — see missedNotice in main.
              note: agentNote(a),
              tone: a.ready === false ? 'off' : '',
              title:
                a.ready === false ? 'It stays in the counsel and is skipped until it can answer again.' : '',
            })
          )}
          {missing.map((id) =>
            row(id, {
              checked: true,
              onPick: () => toggle(id),
              name: 'an agent that is no longer here',
              note: 'removed, or no longer shared',
              tone: 'gone',
            })
          )}

          <li role="none" className="agent-menu-rule" />
          {modeRow('parallel', 'All at once', 'each answers on its own')}
          {modeRow('relay', 'In turn', 'each sees the answers already given')}
        </ul>
      )}
    </div>
  );
}
