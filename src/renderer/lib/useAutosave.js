import { useCallback, useEffect, useRef } from 'react';

// Saving a field somebody is typing into, without saving once per letter.
//
// Two views in the Task Bar have the same problem: a text field whose contents
// belong on disk, being changed a character at a time. Writing on every
// keystroke means rewriting a file — and, since main republishes what it
// writes, re-rendering the column — thirty times a sentence. Writing only when
// somebody remembers to press a button means losing what they wrote when they
// do not.
//
// So: a save is held back until the typing stops, and every way out of the
// field flushes it first. The flushing is the part that makes the holding back
// safe, which is why both live here rather than being written twice.
//
// The thing that must be true, and that the debounce quietly threatens: the
// save that finally runs carries the last letter typed. A timer created inside
// a render closes over the state of that render, which is the state as it was
// one keystroke ago — so what is queued lives in a ref, and the callback reads
// it when it fires rather than remembering it when it was made.

// Long enough that a sentence is one save rather than thirty; short enough that
// a hand leaving the keyboard is followed by a save before it gets back.
const IDLE_MS = 500;

export function useAutosave(save, idleMs = IDLE_MS) {
  const pending = useRef(null); // { id, patch }
  const timer = useRef(null);
  // The caller's save, as it is now. Kept in a ref so a fresh closure on every
  // render does not cancel and rebuild the timer under the person typing.
  const saveRef = useRef(save);
  saveRef.current = save;

  const clear = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  // The one door out. Everything that ends an edit goes through here, so there
  // is a single place that has to be right: closing, switching to another
  // record, deleting, losing focus, and being unmounted.
  // Returns whatever the save returned, so a caller that has to know the write
  // landed before doing the next thing can await it — running a task, for
  // instance, must put the instruction as it is now rather than as it was one
  // keystroke ago.
  const flush = useCallback(() => {
    clear();
    const held = pending.current;
    pending.current = null;
    return held ? saveRef.current(held.id, held.patch, true) : undefined;
  }, []);

  const queue = useCallback(
    (id, patch) => {
      // A different record than the one waiting: the one waiting is written out
      // now rather than being overwritten by an edit to something else.
      if (pending.current && pending.current.id !== id) flush();
      pending.current = { id, patch: { ...(pending.current?.patch || {}), ...patch } };
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        const held = pending.current;
        pending.current = null;
        // Not final: this is a pause mid-sentence, not a finish.
        if (held) saveRef.current(held.id, held.patch, false);
      }, idleMs);
    },
    [flush, idleMs]
  );

  // A call arriving unmounts this whole panel. Whatever was in the field at
  // that moment goes to disk before it does.
  useEffect(() => flush, [flush]);

  return { queue, flush };
}
