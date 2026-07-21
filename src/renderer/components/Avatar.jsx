import React from 'react';
import { colorFor, initials } from '../lib/util.js';

// Avatar: colored initials disc with optional presence dot.
export default function Avatar({ name, id, avatar, size = '', online = null }) {
  const bg = avatar?.color || colorFor(id || name);
  const photo = avatar?.image || null;
  return (
    <span className={`avatar ${size}`} style={{ background: photo ? 'transparent' : bg }} aria-hidden="true">
      {photo ? <img src={photo} alt="" className="avatar-img" /> : initials(name)}
      {online !== null && <span className={`presence ${online ? 'online' : ''}`} />}
    </span>
  );
}
