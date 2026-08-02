import React, { useEffect, useRef } from 'react';
import TaskBarFace from './TaskBarFace.jsx';
import { stepTaskView } from '../lib/taskViews.js';

// The right column, named and standing on two floors.
//
// Until now the column started straight in on the dictation card, so nothing
// said what it was. It says it now — and the title is also the mode: the ground
// under the card slides between the Activity Panel, which is everything the
// column has always shown, and the Task Bar, which is empty for the moment.
//
// The card itself is not on that ground. Push-to-talk and dictation belong to
// the window rather than to whichever floor is showing, and a slider that took
// the microphone away as a side effect of being pulled would be worse than no
// slider at all. So it stays pinned above the deck, in every state, for every
// kind of conversation — and it keeps following the selection while the Task
// Bar is up, which is the only thing on this side that moves when someone picks
// a different thread on the left.
//
// The view is a prop rather than state here: a call replaces this whole panel,
// and the floor a person left the column on should still be under it when the
// call ends. App owns it for that reason (see the aside in App.jsx). The same
// goes for which of the Task Bar's three views is showing — one floor down, and
// a call takes it away just as completely.

// The modifier is what keeps the shortcut clear of the arrow keys the composer,
// the search results and the sidebar grips already use — none of those look at
// modifiers, so a plain arrow would be taken from whichever of them had focus.
// navigator.platform is missing outside a browser, hence the fallbacks: this is
// read while rendering, not only inside an effect.
const MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const MOD = MAC ? '⌘' : 'Ctrl';

// Movement below this is a slipped click, not a drag — starting to follow the
// pointer at the first pixel makes the bar feel like it wobbles when tapped.
const DRAG_START = 6;
// And below this the drag has not asked for the other floor, so it springs back.
const COMMIT = 24;

// Where a bare left or right arrow belongs to something else. Inside a text
// field an arrow is the caret, and taking it to move a panel would make the
// note being typed unwritable; a select and a range are the same bargain. This
// is checked for the sideways keys only — the modifier on the up and down pair
// is what keeps those clear, and they have always reached the deck from inside
// the composer.
const editing = (el) =>
  Boolean(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));

export default function SidePanelDeck({ up, onUp, view, onView, dictation, activity, tasks }) {
  const deckRef = useRef(null);
  const drag = useRef(null);
  // A drag ends in a click as well as a pointerup; without this the toggle would
  // fire on top of the drag and undo it.
  const dragged = useRef(false);

  useEffect(() => {
    const onKey = (e) => {
      // The panel is gone below 980px and behind a call. A shortcut that moved
      // something nobody can see would be a key press with no answer.
      if (!deckRef.current || !deckRef.current.offsetParent) return;
      // Sideways: the Task Bar's three views. Bare arrows, because that is what
      // was asked for, and they are affordable here in a way up and down were
      // not — every other arrow handler in this app takes up and down only, so
      // the only thing left or right can be taken from is a caret. Hence the two
      // gates below rather than a modifier.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Held modifiers are somebody else's shortcut, not a slower version of
        // this one: ⌘← is the start of the line and ⌥← is the previous word.
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (editing(e.target)) return;
        // There is one view on the other floor, and stepping through a set of
        // one is a key press with no answer for the same reason as above.
        if (!up) return;
        e.preventDefault();
        onView(stepTaskView(view, e.key === 'ArrowRight' ? 1 : -1));
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      onUp(e.key === 'ArrowUp');
    };
    // Capture, so it lands before the element-scoped arrow handlers rather than
    // after whichever of them happens to hold focus.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // The floor and the view are read by the handler, not just written by it, so
    // they belong in here: one window listener re-subscribed on a change nobody
    // can make faster than they can press a key.
  }, [onUp, onView, up, view]);

  const pull = (px) => {
    const el = deckRef.current;
    if (!el) return;
    if (px == null) el.style.removeProperty('--pull');
    else el.style.setProperty('--pull', `${px}px`);
  };

  const pointerDown = (e) => {
    if (e.button) return;
    // Cleared here rather than only in the click that follows: a drag that ends
    // in a cancel never produces one, and a stale flag would swallow the next
    // press instead.
    dragged.current = false;
    drag.current = { y: e.clientY, moved: false, room: deckRef.current?.clientHeight || 0 };
    // Capture keeps the moves coming when the pointer leaves the bar — which it
    // does immediately, since the whole gesture is upwards. A synthesised event
    // has no pointer to capture, so the drag must not depend on this succeeding.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the drag works without it */
    }
  };

  const pointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < DRAG_START) return;
      d.moved = true;
      deckRef.current?.classList.add('dragging');
    }
    // Each floor can only be pulled towards the other one. There is nothing past
    // either stop, and letting the deck travel there would show a strip of empty
    // panel that no state can explain.
    pull(up ? Math.min(Math.max(dy, 0), d.room) : Math.max(Math.min(dy, 0), -d.room));
  };

  const pointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      // Never moved, so there is nothing to put back: leave it to the click.
      deckRef.current?.classList.remove('dragging');
      return;
    }
    dragged.current = true;
    const dy = e.clientY - d.y;
    // The state first, then the finger's offset given back, both before the
    // browser paints again — so the deck carries on from where it was let go of
    // rather than snapping to its old floor for a frame and setting off from
    // there. Re-enabling the transition in the same breath is what turns the
    // remaining distance into the tail of the same movement.
    if (!up && dy < -COMMIT) onUp(true);
    else if (up && dy > COMMIT) onUp(false);
    deckRef.current?.classList.remove('dragging');
    pull(null);
  };

  const click = () => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onUp(!up);
  };

  // Arrow keys on the grip itself, so the bar can be worked from the keyboard
  // without knowing the global shortcut — the same courtesy the sidebar grips
  // extend to reordering. Enter and Space are the button's own and toggle.
  const keys = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onUp(e.key === 'ArrowUp');
    }
  };

  const other = up ? 'Activity Panel' : 'Task Bar';
  const arrow = up ? '↓' : '↑';

  return (
    <>
      {/* Keyed on the view so the name is a new element each time, which is what
          re-runs its arrival — a title that swapped in place while everything
          below it slid would be the one still thing in a moving column. */}
      <h2 className="panel-title" key={up ? 'tasks' : 'activity'}>
        {up ? 'Task Bar' : 'Activity Panel'}
      </h2>

      {dictation}

      <div className={`panel-deck${up ? ' up' : ''}`} ref={deckRef}>
        <div className="panel-deck-face panel-face-activity" aria-hidden={up ? 'true' : undefined}>
          {activity}
        </div>
        <div className="panel-deck-face panel-face-tasks" aria-hidden={up ? undefined : 'true'}>
          <TaskBarFace view={view} onView={onView}>
            {tasks}
          </TaskBarFace>
        </div>
      </div>

      <button
        type="button"
        className="panel-grip"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onClick={click}
        onKeyDown={keys}
        title={`Pull up for the Task Bar (${MOD}↑), down for the Activity Panel (${MOD}↓)`}
        aria-label={`${other} — ${MOD}${arrow}, or drag ${up ? 'down' : 'up'}`}
        aria-expanded={up}
      >
        {/* The shortcut, shown on hover and on focus — a hint only a mouse can
            reach is missing from exactly the person it would help most. It is
            aria-hidden because the label above already says the same words. */}
        <span className="panel-grip-keys" aria-hidden="true">
          <kbd>{MOD}</kbd>
          <kbd>{arrow}</kbd>
          {other}
        </span>
        <span className="panel-grip-bars" aria-hidden="true">
          <span />
          <span />
        </span>
      </button>
    </>
  );
}
