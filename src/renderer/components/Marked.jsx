import React from 'react';
import { sliceRuns } from '../lib/findInThread.js';

// Marking what a search found, wherever it was found.
//
// A bubble is several surfaces — the message, a quoted excerpt, the names of the
// documents handed over, the name of a file — and the find bar counts hits
// across all of them in the order they are read on screen. So the marking has to
// work the same way on every one of them, which is why it lives here rather than
// beside any single surface that happens to need it.

// The runs of a string, cut at whatever the search found in it. `hit` is
// undefined on every surface the current query does not touch, which is the
// usual case and costs nothing.
export function markRuns(runs, hit) {
  if (!hit || hit.ranges.length === 0) return runs.map((run) => ({ ...run, hit: null }));
  return sliceRuns(runs, hit.ranges, hit.base);
}

// One occurrence, marked where it stands. `data-hit` is its ordinal in the
// thread: it is how the pane finds this one on screen when the arrows walk to
// it, and it is unique because the numbering is handed out once, in order.
export function Hit({ run, current }) {
  return (
    <mark className={`find-hit${run.hit === current ? ' current' : ''}`} data-hit={run.hit}>
      {run.text}
    </mark>
  );
}

// A plain string with the search marked in it — a quoted excerpt, the name of a
// document, the name of a file.
export function Marked({ text, hit, current }) {
  const pieces = markRuns([{ type: 'text', text }], hit);
  return (
    <>
      {pieces.map((run, i) =>
        run.hit == null ? (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        ) : (
          <Hit key={i} run={run} current={current} />
        )
      )}
    </>
  );
}
