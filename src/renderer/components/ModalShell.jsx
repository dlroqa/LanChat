import React, { useEffect } from 'react';
import { X } from '../lib/icons.jsx';

// Shared modal chrome: backdrop, title, close affordance and Escape handling.
//
// Every modal previously relied on a Cancel button or a backdrop click to
// dismiss, neither of which is an obvious escape route — a dialog should always
// offer a visible way out.
// A falsy `onClose` marks the dialog as non-dismissable (first-run setup, where
// there is nothing sensible to fall back to). In that case the close button,
// Escape key and backdrop click are all withheld together, so the dialog never
// looks dismissable while refusing to dismiss.
export default function ModalShell({ title, desc, onClose, children, className = '' }) {
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose || undefined}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          {onClose && (
            <button className="icon-btn modal-close" onClick={onClose} title="Close" aria-label="Close">
              <X size={18} />
            </button>
          )}
        </div>
        {desc && <p className="desc">{desc}</p>}
        {children}
      </div>
    </div>
  );
}
