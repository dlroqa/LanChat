import React, { useEffect, useRef } from 'react';
import { Lock, Unlock, Grip } from '../lib/icons.jsx';

// One category in the left panel: a heading, and the list it puts away.
//
// The heading is the permanent thing here — the list under it is shown on
// hover, on a lock, or because the conversation you are in is inside it. That
// makes the heading the only part of a category most people see most of the
// time, so everything it has to say has to fit in it: what it is, how many
// unread messages are behind it, and whether it is pinned open.
//
// Hover is deliberately delayed at both ends. Opening a category pushes the ones
// below it down the panel, so a category that opened the instant a pointer
// crossed it would move the heading somebody was reaching for out from under
// them. `OPEN_MS` is long enough to tell aiming from passing through; `CLOSE_MS`
// is long enough to cross the gap between a heading and its own rows without the
// list shutting on the way.
const OPEN_MS = 120;
const CLOSE_MS = 220;

export default function SidebarSection({
  id,
  title,
  expanded,
  locked,
  flashing,
  count = 0,
  alert = false,
  actions = null,
  dropEdge = null, // 'before' | 'after' | null
  dragging = false, // a category is being dragged somewhere in the panel
  onHover,
  onToggleLock,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}) {
  const openTimer = useRef(null);
  const closeTimer = useRef(null);

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };

  // Nothing may be left running once this is gone: the timer's whole job is to
  // call back into a parent that would no longer have a category to open.
  useEffect(() => clearTimers, []);

  // A drag is a different intent from a hover, and the two together would have
  // categories opening under a category being carried past them.
  useEffect(() => {
    if (dragging) clearTimers();
  }, [dragging]);

  const enter = () => {
    if (dragging) return;
    clearTimers();
    openTimer.current = setTimeout(() => onHover(id, true), OPEN_MS);
  };

  const leave = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => onHover(id, false), CLOSE_MS);
  };

  // Keyboard parity with hover: tabbing to the grip or the lock opens the
  // category, the same way pointing at it does. Focus moving between two
  // controls inside the same heading is not a departure, so it does not close —
  // checked against where focus actually went rather than by waiting to see if
  // it comes back.
  const focus = () => {
    clearTimers();
    onHover(id, true);
  };
  const blur = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    clearTimers();
    onHover(id, false);
  };

  // Drag-and-drop is never the only way to do this. Arrow keys on the grip move
  // the category one place at a time, and because the section is keyed by id the
  // browser moves the focused button along with it — so the keys can be held
  // down and the focus follows the category the way a pointer would.
  const gripKeys = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onMove(id, e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  const cls = [
    'sb-section',
    expanded ? 'open' : '',
    locked ? 'locked' : '',
    flashing ? 'flash' : '',
    dropEdge ? `drop-${dropEdge}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      className={cls}
      data-section={id}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={focus}
      onBlur={blur}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="sb-head" draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <button
          type="button"
          className="sb-grip"
          onKeyDown={gripKeys}
          title={`Reorder ${title} — drag, or use the arrow keys`}
          aria-label={`Reorder ${title}. Use the up and down arrow keys to move it.`}
        >
          <Grip size={14} />
        </button>

        <span className="sb-title">{title}</span>

        {/* What the heading has to say while it is shut. The pill is the same
            one the rows use, because it is the same fact — and it is the reason
            the flash is safe to be motion: a reader who never sees the flash
            still has the number. */}
        {!expanded && count > 0 && (
          <span className="unread-dot" title={`${count} unread`}>
            {count}
          </span>
        )}
        {!expanded && count === 0 && alert && <span className="sb-dot" title="Waiting to be opened" />}

        <span className="sb-actions">{actions}</span>

        <button
          type="button"
          className="sb-lock"
          aria-pressed={Boolean(locked)}
          onClick={() => onToggleLock(id)}
          title={locked ? `${title} stays open — click to unlock` : `Keep ${title} open`}
          aria-label={locked ? `Unlock ${title}` : `Keep ${title} open`}
        >
          {locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      </div>

      {/* Two elements, not one: the outer is the grid track being animated from
          nothing to its content's height, the inner is what gets clipped while
          that happens. A height cannot be transitioned to `auto`, and measuring
          one in JavaScript would go stale the moment a peer came online. */}
      <div className="sb-body">
        <div className="sb-body-inner">{children}</div>
      </div>
    </section>
  );
}
