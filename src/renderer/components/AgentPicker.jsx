import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Dot, Minus, Plus } from '../lib/icons.jsx';
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
// What a discussion may cost, in turns. The same bounds main clamps to — see
// cleanTurns in sessions/dialogue.js — because a stepper that lets somebody
// press up past the ceiling and then silently disagrees with the record is worse
// than one that stops.
const MIN_TURNS = 2;
const MAX_TURNS = 12;
const DEFAULT_TURNS = 6;

export default function AgentPicker({
  agents = [],
  agentIds = [],
  allAgents = false,
  mode = 'parallel',
  turns = DEFAULT_TURNS,
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

  // How long two agents may go on for.
  //
  // A stepper rather than a free number box: the range is small, both ends are
  // hard limits, and the only thing anybody wants to do to it is nudge it. It
  // sits under the mode row it belongs to and only when that mode is chosen —
  // shown always, it would be a control with no effect for the two modes that
  // have no turns.
  //
  // A `group` of two `menuitem`s rather than the `spinbutton` this visually is.
  //
  // A spinbutton is the right control for a small bounded number, and it is the
  // wrong one *here*: the only valid children of a `menu` are menuitems, groups
  // and separators, so a spinbutton inside this list is a control a screen reader
  // may decline to announce at all. Correct semantics in the wrong container is
  // still a control nobody can find.
  //
  // So the two buttons are what they look like — things to press — the group
  // carries the name and the current value for anyone arriving at it, and the
  // count is a live region so pressing them says what happened. The arrow keys
  // are kept on the group because somebody who reads this as a number will try
  // them, and doing nothing would be the surprise.
  const step = (by) => onChange({ turns: Math.min(MAX_TURNS, Math.max(MIN_TURNS, turns + by)) });
  const turnStepper = (
    <li role="none" className="agent-turns">
      <span className="agent-pick-note" aria-hidden="true">
        Turns
      </span>
      <span
        role="group"
        aria-label={`Turns: ${turns}, between ${MIN_TURNS} and ${MAX_TURNS}`}
        className="agent-turns-box"
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            step(1);
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            step(-1);
          }
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="agent-turns-step"
          onClick={() => step(-1)}
          disabled={turns <= MIN_TURNS}
          aria-label="One turn fewer"
        >
          <Minus size={12} />
        </button>
        <span className="agent-turns-count" aria-live="polite">
          {turns}
        </span>
        <button
          type="button"
          role="menuitem"
          className="agent-turns-step"
          onClick={() => step(1)}
          disabled={turns >= MAX_TURNS}
          aria-label="One turn more"
        >
          <Plus size={12} />
        </button>
      </span>
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
          {/* Two agents replying to each other, which is the only mode that keeps
              going after the first lap — so it is the only one with a budget
              under it, and the stepper appears with the choice rather than
              sitting there greyed out beside the other two. */}
          {modeRow('dialogue', 'Between themselves', 'they reply to each other until they are done')}
          {mode === 'dialogue' ? turnStepper : null}
        </ul>
      )}
    </div>
  );
}
