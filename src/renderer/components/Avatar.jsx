import React from 'react';
import { colorFor, initials } from '../lib/util.js';

// Avatar: colored initials disc with optional presence dot.
export default function Avatar({ name, id, avatar, size = '', online = null }) {
  const bg = avatar?.color || colorFor(id || name);
  return (
    <span className={`avatar ${size}`} style={{ background: bg }} aria-hidden="true">
      {initials(name)}
      {online !== null && <span className={`presence ${online ? 'online' : ''}`} />}
    </span>
  );
}
