import React from 'react';
import { TASK_VIEWS, normalizeTaskView, stepTaskView, taskViewName } from '../lib/taskViews.js';
import { Note, Bot, Clock } from '../lib/icons.jsx';

// The Task Bar floor: a name at the top, a body, and the three views along the
// bottom.
//
// The column already has a title one level up, and it names the floor you are
// standing on. This names what is on that floor, which is a different question
// with a different answer, so it is a second heading rather than a rewrite of
// the first — h2 for the floor, h3 for the view, and the outline stays honest.
//
// The buttons are at the foot rather than the head because the head is spoken
// for: the dictation card is pinned directly above this, and a row of controls
// wedged between the card and the title would read as belonging to the card.
// Down here they sit against the grip, which is the column's other set of
// controls, and the title has the top of the floor to itself.
//
// Nothing is held here. The view is App state (see the aside in SidePanelDeck),
// and the wrapping is a pure function in lib/taskViews.js, so this component is
// the arrangement and nothing else.

const ICONS = { notes: Note, agent: Bot, schedule: Clock };

export default function TaskBarFace({ view, onView, children }) {
  const active = normalizeTaskView(view);

  // Left and right inside the row itself, so the three can be worked from the
  // keyboard by someone who has tabbed to them and never learnt the global
  // shortcut — the same courtesy the sidebar grips extend to reordering. It is
  // also the standard tablist behaviour, which means it is already known.
  const keys = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // Stopped here as well as handled: the window-level handler is listening in
    // capture and would otherwise step the view a second time on its way down.
    e.stopPropagation();
    onView(stepTaskView(active, e.key === 'ArrowRight' ? 1 : -1));
  };

  return (
    <div className="task-view">
      {/* Keyed on the view for the reason the column's own title is keyed on the
          floor: the name is a new element each time, so it arrives rather than
          swapping in place under a body that has already changed. */}
      <h3 className="task-view-title" id="task-view-title" key={active}>
        {taskViewName(active)}
      </h3>

      <div className="task-view-body" role="tabpanel" aria-labelledby="task-view-title">
        {children}
      </div>

      <div className="task-view-menu" role="tablist" aria-label="Task Bar views">
        {TASK_VIEWS.map(({ id, name }) => {
          const Icon = ICONS[id];
          const on = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              // One stop for the whole row, not three — a roving tabIndex, so
              // tabbing through the panel does not mean pressing tab three times
              // to get past a control you have already answered.
              tabIndex={on ? 0 : -1}
              aria-selected={on}
              // These are icons with no words beside them, so the label is not a
              // convenience here: it is the only name the button has.
              aria-label={name}
              title={name}
              className={`icon-btn${on ? ' on' : ''}`}
              onClick={() => onView(id)}
              onKeyDown={keys}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
