import React from 'react';
import Avatar from './Avatar.jsx';

// The agents a peer is sharing, offered while an `@` is being typed at them.
//
// What it lists is not a matter of taste: main routes `@name …` by prefix-
// matching the *start* of the message against the agents that peer has shared
// with this machine (matchMention in agents/remote.js). Offering anything else
// would complete to something that lands in the human's chat instead, so the
// list is exactly that set and the caller does the filtering.
//
// An empty list renders nothing at all rather than an empty box. With nobody to
// suggest there is nothing to say, and "no agents" under the composer would be
// an answer to a question the person did not ask.
export default function MentionMenu({ items, active, onPick, onHover, id }) {
  if (!items.length) return null;
  return (
    <ul className="mention-menu" id={id} role="listbox" aria-label="Agents you can ask">
      {items.map((item, i) => (
        <li
          key={item.id}
          id={`${id}-opt-${i}`}
          className={`mention-item ${i === active ? 'active' : ''}`}
          role="option"
          aria-selected={i === active}
          // Pointer down rather than click: the composer must not lose the caret
          // to the list on the way to choosing from it.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {/* `size` is a class name here, not a number — see Avatar.jsx. */}
          <Avatar name={item.name} id={item.id} avatar={item.avatar} size="sm" />
          <span className="mention-name">{item.name}</span>
          {/* Whose agent it is. Two peers can share an agent of the same name,
              and the only thing telling them apart is who it belongs to. */}
          {item.viaName && <span className="mention-via">via {item.viaName}</span>}
        </li>
      ))}
    </ul>
  );
}

// Which agent an `@` is reaching for, given what has been typed and where the
// caret is.
//
// Anchored at the start of the message, because that is the only place main will
// route one from: matchMention requires `trimmed.startsWith('@')`. A menu that
// opened mid-sentence would be offering a completion that quietly goes to the
// person instead of the agent — the one failure this feature exists to prevent.
//
// Exported so the behaviour can be tested without a DOM.
export function mentionQuery(text, caret) {
  if (typeof text !== 'string') return null;
  const before = text.slice(0, caret);
  const m = /^@(\S*)$/.exec(before);
  return m ? m[1] : null;
}

// The agents that query is reaching for, in the order they should be offered.
//
// Prefix first and in name order, so the list does not reshuffle under the
// fingers as more of a name is typed. Matching is case-insensitive because the
// routing is.
export function matchMentions(items, query) {
  if (query == null) return [];
  const q = query.toLowerCase();
  return items
    .filter((item) => item.name && item.name.toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}
