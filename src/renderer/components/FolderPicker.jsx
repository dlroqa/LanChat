import React, { useEffect, useRef, useState } from 'react';
import { Folder, Check } from '../lib/icons.jsx';

// Filing the session you are looking at.
//
// The sidebar can do this by dragging, and dragging is the better gesture when
// you can see both ends of it. This is for the other case, which is commoner
// than it sounds: you have been talking to a session for twenty minutes, you now
// know what it was about, and the folder it belongs in is a decision you want to
// act on here rather than by going and finding the row.
//
// It closes on a pick, unlike the agent picker beside it in the header. That one
// stays open on purpose because choosing a counsel is several decisions; this is
// one, and a menu that lingered after it would be waiting for nothing.
//
// "New folder…" is first because the moment you realise you need a folder is
// usually this one, and the alternative is a trip to the sidebar and back.

export default function FolderPicker({ folders = [], current = null, onPlace, onNewFolder }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  // Clicking anywhere else puts it away. Pointerdown rather than click, so the
  // menu is gone before whatever was clicked acts on it.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (!box.current || !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const pick = (folderId) => {
    onPlace(folderId);
    setOpen(false);
  };

  const create = () => {
    setOpen(false);
    onNewFolder();
  };

  return (
    <div className="folder-picker" ref={box}>
      <button
        type="button"
        className={`icon-btn ${current ? 'on' : ''}`}
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
        title={current ? `In ${current.name} — move to another folder` : 'Move to folder'}
        aria-label={current ? `In folder ${current.name}. Move to folder` : 'Move to folder'}
      >
        <Folder size={19} />
      </button>

      {open && (
        <ul className="folder-menu" role="listbox" aria-label="Move this session to a folder">
          <li role="none">
            <button type="button" className="folder-item" onClick={create}>
              New folder…
            </button>
          </li>
          {folders.length > 0 && <li role="none" className="folder-menu-rule" />}
          {folders.map((f) => (
            <li role="none" key={f.id}>
              <button
                type="button"
                role="option"
                aria-selected={current?.id === f.id}
                className={`folder-item ${current?.id === f.id ? 'active' : ''}`}
                onClick={() => pick(f.id)}
              >
                <span className="folder-item-tick">{current?.id === f.id && <Check size={14} />}</span>
                <span className="folder-item-text">{f.name}</span>
              </button>
            </li>
          ))}
          {/* Only when it is in one. An offer to take a session out of nowhere
              is a row that does nothing, and a menu of those teaches people not
              to read it. */}
          {current && (
            <>
              <li role="none" className="folder-menu-rule" />
              <li role="none">
                <button type="button" className="folder-item" onClick={() => pick(null)}>
                  Remove from folder
                </button>
              </li>
            </>
          )}
          {!folders.length && (
            <li role="none" className="folder-menu-empty">
              No folders yet — the one above makes the first.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
