import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from '../lib/icons.jsx';
import { SCOPE_ALL, scopeOptions } from '../lib/sidebarSections.js';

// What the search box is pointed at.
//
// The box searches all four categories by default. Aiming it at one is a chip at
// its left rather than a row of tabs above it: the sidebar is 260px at its
// narrowest and four tabs there would each be three letters wide, and it is the
// box's own setting — it belongs inside the box, the way a filter belongs to the
// thing it filters.
//
// The menu lists the categories in the order they have been dragged into, not
// the order they are written in. It sits directly under the panel it describes,
// and a menu that disagreed with the column beside it would be a menu about some
// other app.
export default function SearchScope({ scope = SCOPE_ALL, order, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const options = scopeOptions(order);
  const current = options.find((o) => o.id === scope) || options[0];

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

  const pick = (id) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="search-scope" ref={box}>
      <button
        type="button"
        className={`scope-chip ${scope === SCOPE_ALL ? '' : 'set'}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
          if (e.key === 'ArrowDown' && !open) setOpen(true);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          scope === SCOPE_ALL ? 'Searching everything — click to narrow it' : `Searching ${current.title}`
        }
        aria-label={scope === SCOPE_ALL ? 'Search scope: everything' : `Search scope: ${current.title}`}
      >
        {/* The magnifier is the chip rather than a second glyph beside it, and
            the category's name only appears once there is one — unscoped, this
            is the same quiet magnifier the box has always had, in a column too
            narrow to spend on the word "everything". */}
        <Search size={15} />
        {scope !== SCOPE_ALL && <span className="scope-name">{current.title}</span>}
        <ChevronDown size={13} />
      </button>

      {/* Clearing the scope is its own target rather than a menu trip: going
          back to searching everything is the commonest thing anybody does here. */}
      {scope !== SCOPE_ALL && (
        <button
          type="button"
          className="scope-clear"
          onClick={() => pick(SCOPE_ALL)}
          title="Search everything again"
          aria-label="Search everything again"
        >
          <X size={12} />
        </button>
      )}

      {open && (
        <ul className="scope-menu" role="listbox" aria-label="Search scope">
          {options.map((o) => (
            <li
              key={o.id}
              role="option"
              aria-selected={o.id === scope}
              className={`scope-item ${o.id === scope ? 'active' : ''}`}
              onClick={() => pick(o.id)}
            >
              {o.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
