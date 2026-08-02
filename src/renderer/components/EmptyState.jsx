import React from 'react';

// The panel's way of saying there is nothing here yet.
//
// The markup was written twice — once for the column with no conversation
// selected, once for the empty Task Bar floor — and is about to be wanted three
// more times, one per view. So it is one component, and the wording is the only
// thing that differs between its uses.
//
// The ring is optional because it is a big, permanently animating thing. One of
// them holding an empty column is a focal point; three of them stacked in the
// same narrow panel, one per view, is a distraction with no information in it.
// Views that show it beside a list of real rows pass `ring={false}`.
export default function EmptyState({ title, children, ring = true }) {
  return (
    <div className="panel-empty">
      {ring ? (
        <div className="pulse-ring" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <h4>{title}</h4>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
