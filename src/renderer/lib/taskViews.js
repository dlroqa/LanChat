// The three views the Task Bar floor stands on, and the arithmetic for moving
// between them.
//
// The Task Bar is reached two ways — the icons at the foot of the floor, and the
// left and right arrow keys — and those two must never disagree about what comes
// after what. So the order, the names and the wrapping live here, once, and both
// the buttons and the key handler read them from the same place.
//
// Pure and dependency-free, like sidebarSections.js and findInThread.js — the
// suite loads this file directly with the `export` keywords stripped.

// Canonical order, and the only place a view's name is written down. The name is
// also the title the floor shows, so renaming one here renames it everywhere it
// appears: the heading, the button's label, and the tooltip.
export const TASK_VIEWS = [
  { id: 'notes', name: 'Notes' },
  { id: 'agent', name: 'Agent Task' },
  { id: 'schedule', name: 'Scheduled Task' },
];

export const TASK_VIEW_IDS = TASK_VIEWS.map((v) => v.id);

// Notes rather than the agent views: it is the one that is worth something with
// nothing else set up, and a first run should open on a floor that can be used
// rather than on one that asks you to go and configure an agent first.
export const DEFAULT_TASK_VIEW = 'notes';

export function taskViewName(id) {
  const found = TASK_VIEWS.find((v) => v.id === id);
  return found ? found.name : '';
}

// Anything at all can arrive here — a view id survives a render, a prop and a
// stale caller, and an unknown one would render a floor with no title and no
// selected button. A view that cannot be named is not a view, so it falls back.
export function normalizeTaskView(id) {
  return TASK_VIEW_IDS.includes(id) ? id : DEFAULT_TASK_VIEW;
}

// One step along, wrapping at both ends.
//
// Wrapping, rather than stopping, because there are three of them and they are
// shown as a row you cycle rather than as a range you scrub: a right arrow that
// did nothing on the last view would read as a key that had stopped working.
export function stepTaskView(id, delta) {
  const from = TASK_VIEW_IDS.indexOf(normalizeTaskView(id));
  const n = TASK_VIEW_IDS.length;
  const step = Math.trunc(delta) || 0;
  return TASK_VIEW_IDS[(((from + step) % n) + n) % n];
}
