import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Dot, Minus, Plus } from '../lib/icons.jsx';
import { agentNote, chipLabel } from '../lib/counselCopy.js';
import { paletteFor } from '../lib/agentColor.js';

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

// The modes that are a room rather than a question.
//
// Observing and Human Like both assume people are talking to each other with
// agents around them, which is the only setting where inviting somebody makes
// sense. The other three are one person asking a counsel something, and a roster
// on one of those would offer to add a person to a conversation that has no
// shape for a second one.
const ROOM_MODES = new Set(['observer', 'human']);

export default function AgentPicker({
  agents = [],
  agentIds = [],
  allAgents = false,
  mode = 'parallel',
  turns = DEFAULT_TURNS,
  // The people in the room, and everybody who could be. Only two modes have a
  // room at all — see the people section below for why the list is not simply
  // always there.
  peers = [],
  members = [],
  observer = null,
  // Who, of the people in the room, may put a question to the agents in it:
  // `nobody`, `room`, or `chosen`. One rule with three settings rather than
  // three switches — see room.js in main, which is the authority on it.
  asking = 'nobody',
  // A session somebody else runs. Every control is read-only in one: the host
  // owns the mode, the counsel and the roster, and a guest changing them locally
  // would be a second source of truth for a conversation with one authority.
  guest = false,
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

  // The colours this counsel's answers will arrive in. Built from exactly who is
  // being asked — the same set ChatPane builds its palette from — so the dot
  // beside a name here and that agent's bubbles over there are the same colour.
  const palette = useMemo(
    () => paletteFor(allAgents ? agents.map((a) => a.id) : agentIds),
    [allAgents, agents, agentIds]
  );
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

  const row = (key, { checked, disabled, onPick, title, name, note, tone, colour }) => (
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
        {/* The colour this agent's answers will arrive in. Beside the name where
            the counsel is put together, so the association is made once, here,
            rather than worked out later from a transcript. Decorative: the name
            is right next to it, so nothing is ever carried by colour alone. */}
        {colour && <span className="agent-pick-dot" style={{ '--agent-color': colour }} aria-hidden="true" />}
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

  // The one switch that lets an agent cut across somebody mid-sentence.
  //
  // Under the mode it belongs to and only when that mode is chosen, like the
  // turn stepper — a control with no effect is a control somebody will try. It
  // is a checkbox rather than a third loudness setting because it is not a
  // matter of degree: either this room has agreed that an agent may interrupt
  // it, or it has not, and the default is that it has not.
  //
  // The note says what it costs rather than what it does. "Let observers
  // interrupt" reads as a feature; saying it will cut in is what somebody
  // actually needs to know before agreeing to it.
  const settings = observer || {};
  const observerRow = (
    <li role="none" className="agent-sub">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={settings.protective === true}
        className={`agent-pick agent-sub-pick ${settings.protective === true ? 'on' : ''}`}
        disabled={guest}
        onClick={() => onChange({ observer: { protective: !settings.protective } })}
        onKeyDown={(e) => keys(e, () => onChange({ observer: { protective: !settings.protective } }))}
      >
        <span className="agent-tick" aria-hidden="true">
          {settings.protective === true ? <Check size={13} /> : null}
        </span>
        <span className="agent-pick-text">
          <span className="agent-pick-name">Allow interruptions</span>
          <span className="agent-pick-note">they may cut in about something already agreed</span>
        </span>
      </button>
    </li>
  );

  // Who else is in the room.
  //
  // A person is not an agent and this list says so by being separate: agents are
  // ticked to be asked, and people are invited to be here. The states are shown
  // rather than flattened into a tick — somebody who was asked and has not
  // answered is a different thing from somebody who declined, and a session that
  // showed both as "not ticked" would have nothing to say about why nobody came.
  // What the row says under a name.
  //
  // For somebody not in the room it is what pressing it does rather than what is
  // currently true: "Invite" is an offer, and "not invited" is a fact nobody
  // needed stating about a person standing in a list of people you can invite.
  // Every other case is a state, because there the useful thing is what happened
  // rather than what you can do about it.
  const stateNote = (member) => {
    if (!member) return 'Invite';
    switch (member.state) {
      case 'joined':
        return 'in the room';
      case 'invited':
        return 'invited — waiting for an answer';
      case 'declined':
        return 'said no';
      case 'left':
        return 'left the room';
      case 'revoked':
        return 'removed';
      default:
        return 'Invite';
    }
  };

  // Who is on the roster, and it is deliberately two things joined.
  //
  // Everybody online, because those are the people an invitation could actually
  // reach — offering to invite somebody whose machine is off is offering
  // something that does nothing. Plus anybody already in the room, whether or
  // not they are online this second: they are in it, they stay in it while their
  // machine is off, and a roster that hid them would be telling you the room is
  // emptier than it is.
  const roster = [
    ...peers,
    ...members
      .filter((m) => m.state === 'joined' && !peers.some((p) => p.id === m.peerId))
      .map((m) => ({ id: m.peerId, name: m.name, online: false })),
  ];

  // Who may spend these agents.
  //
  // Radios rather than checkboxes because it really is one choice: the three
  // settings are one rule, and a room where "anyone" and "the people I tick"
  // could both be on would be a room with two answers to the same question.
  //
  // Above the roster rather than below it, because the last setting is about the
  // ticks on those rows: a control that makes ticks appear has to come before
  // the things it makes appear, or the ticks are a surprise.
  //
  // The notes say what it costs. "Anyone in the room" is a sentence about
  // permission; "they can put questions to your agents" is the thing somebody
  // actually needs to know before choosing it.
  const askRow = (value, name, note) => (
    <li role="none" key={value}>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={asking === value}
        className={`agent-pick agent-mode ${asking === value ? 'on' : ''}`}
        disabled={guest}
        onClick={() => onChange({ asking: value })}
        onKeyDown={(e) => keys(e, () => onChange({ asking: value }))}
        title={guest ? 'Only the person who started this session decides who may ask.' : ''}
      >
        <span className="agent-tick" aria-hidden="true">
          {asking === value ? <Dot size={13} /> : null}
        </span>
        <span className="agent-pick-text">
          <span className="agent-pick-name">{name}</span>
          <span className="agent-pick-note">{note}</span>
        </span>
      </button>
    </li>
  );

  const askingSection = (
    <>
      <li role="none" className="agent-menu-rule" />
      <li role="none" className="agent-menu-head" aria-hidden="true">
        Who may ask the agents
      </li>
      {askRow('nobody', 'Only me', 'anything the others say is chat, and stays chat')}
      {askRow('room', 'Anyone in the room', 'they can put questions to your agents')}
      {askRow('chosen', 'The people I tick', 'the rest are heard, and ask nobody')}
    </>
  );

  const peopleSection = (
    <>
      <li role="none" className="agent-menu-rule" />
      <li role="none" className="agent-menu-head" aria-hidden="true">
        People
      </li>
      {roster.length === 0 && <li className="agent-menu-empty">Nobody else is online.</li>}
      {roster.map((peer) => {
        const member = members.find((m) => m.peerId === peer.id) || null;
        const here = Boolean(member && member.state === 'joined');
        const who = peer.name || peer.hostname || 'this person';
        // The second thing a row can carry, and only under the one policy that
        // reads it: whether this person in particular may ask. Beside the row
        // rather than inside it — the row is already a button, and a button
        // inside a button is markup no browser agrees about.
        const askPill =
          asking === 'chosen' && here ? (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={member.ask === true}
              className={`agent-ask ${member.ask === true ? 'on' : ''}`}
              disabled={guest}
              onClick={() => onChange({ ask: peer.id, mayAsk: !member.ask })}
              onKeyDown={(e) => keys(e, () => onChange({ ask: peer.id, mayAsk: !member.ask }))}
              aria-label={`Let ${who} ask the agents`}
              title={
                guest
                  ? 'Only the person who started this session decides who may ask.'
                  : `Whether ${who} may put a question to the agents`
              }
            >
              {/* Ticked and not ticked differ by a mark as well as a colour: the
                  state is what this control is for, and colour alone is not a
                  state anybody can be told about. */}
              <span className="agent-ask-tick" aria-hidden="true">
                {member.ask === true ? <Check size={11} /> : null}
              </span>
              Ask
            </button>
          ) : null;
        return (
          <li key={peer.id} role="none" className={askPill ? 'agent-person' : undefined}>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={here}
              className={['agent-pick', here ? 'on' : '', peer.online === false ? 'off' : '']
                .filter(Boolean)
                .join(' ')}
              // Only a guest is stopped. Everybody on this list is either online
              // and invitable, or already in the room and removable — there is no
              // row here that does nothing when pressed.
              disabled={guest}
              onClick={() => onChange({ invite: peer.id, inviting: !here })}
              onKeyDown={(e) => keys(e, () => onChange({ invite: peer.id, inviting: !here }))}
              title={guest ? 'Only the person who started this session can invite people.' : ''}
            >
              <span className="agent-tick" aria-hidden="true">
                {here ? <Check size={13} /> : null}
              </span>
              <span className="agent-pick-text">
                <span className="agent-pick-name">{peer.name || peer.hostname}</span>
                <span className="agent-pick-note">
                  {here && peer.online === false ? 'in the room · offline' : stateNote(member)}
                </span>
              </span>
            </button>
            {askPill}
          </li>
        );
      })}
    </>
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
              // Only for agents this session actually asks. Colouring the ones
              // that are merely available would promise a colour to an agent
              // that has none yet, and change every other agent's the moment one
              // more was ticked.
              colour: chosen(a.id) ? palette.get(a.id) : null,
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
          {/* The two that came later, and they are a different kind of thing —
              the three above are ways of putting a question, and these are ways
              of being in a room. Below the rule rather than mixed in with them,
              so the menu reads as "how do they answer" and then "or something
              else entirely" rather than as five equivalent options. */}
          {modeRow('observer', 'Observer Agent', 'they watch, and speak when it matters')}
          {mode === 'observer' ? observerRow : null}
          {modeRow('human', 'Human Like', 'in turn, between themselves and watching, shuffled')}
          {/* Only the two modes that have a room. A session in the other three is
              one person asking some agents a question, and a roster on it would
              be an invitation to a conversation that does not have a shape for
              more than one person to be in. */}
          {ROOM_MODES.has(mode) ? askingSection : null}
          {ROOM_MODES.has(mode) ? peopleSection : null}
        </ul>
      )}
    </div>
  );
}
