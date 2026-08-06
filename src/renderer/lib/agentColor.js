// A colour per agent, so a discussion between four reads as four voices.
//
// A session can put one question to several agents, and a discussion keeps them
// talking for a dozen turns. The name above each answer says who wrote it, but a
// name is a word among words — scanning back through twelve replies to find what
// Beacon said means reading twelve labels. A colour is found without reading.
//
// Keyed on the agent's **id**, never its name. Ids are unique and stable for the
// life of an agent; names are neither, and two agents both called "Claude" — one
// local, one a peer's — are exactly the case where telling them apart matters
// most.

// The ring.
//
// Twelve hues evenly spaced round the wheel at one saturation and one lightness,
// so no colour reads as louder than another, and ordered in steps of five so
// that neighbouring slots are 150° apart rather than 30°. That ordering is what
// makes the collision rule below land on an obviously different colour instead
// of the adjacent shade.
//
// The values are not a matter of taste. Every one was measured against this
// window's own tokens, and two things have to hold for all twelve:
//
//   * the bubble fill — color-mix(in srgb, hue 26%, --surface) — carrying body
//     text at --fg: worst in the ring is 6.93:1, against the 4.5:1 needed;
//   * the speaker's name — color-mix(in srgb, hue 68%, --fg) — on that fill:
//     worst in the ring is 4.88:1.
//
// Both are recomputed in test/agentColor.test.js rather than trusted, because a
// hue swapped for a prettier one is exactly the change that quietly drops a name
// below readable. The two percentages live in styles.css and are repeated in
// that test; move one and the other fails.
export const AGENT_HUES = Object.freeze([
  '#dd8888',
  '#88ddb3',
  '#dd88dd',
  '#b3dd88',
  '#8888dd',
  '#ddb388',
  '#88dddd',
  '#dd88b3',
  '#88dd88',
  '#b388dd',
  '#dddd88',
  '#88b3dd',
]);

// Which slot an id belongs to when nothing is in the way. The same hash
// colorFor() in util.js uses, deliberately: an agent's avatar and its bubbles
// should not disagree about which end of the spectrum it lives at.
function slotFor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % AGENT_HUES.length;
}

// The colour an agent has on its own, with no room to be distinct within. For
// lists and settings, where agents are read one at a time and the only thing
// that matters is that the colour is always the same one.
export function colorOf(agentId) {
  return AGENT_HUES[slotFor(agentId)];
}

// The colours of everybody in one conversation, all of them different.
//
// Hashing alone is not enough: twelve slots and four agents collide about two
// times in five, and two agents sharing a colour in the one place a colour is
// meant to tell them apart is the whole feature failing. So a collision steps to
// the next free slot.
//
// Which of the two moves is decided by sorting the ids, not by the order the
// caller happened to pass them — otherwise the same four agents would be
// coloured one way in the sidebar and another in the transcript, or re-coloured
// the moment one of them answered first. Sorted ids give every window the same
// answer for the same room.
//
// The cost is real and worth naming: an agent that collides is not on its hashed
// colour, so its colour can differ between two sessions with different
// membership. Distinctness inside the conversation wins that trade, because
// that is what the colour is for — colorOf() above is there for the places where
// a stable colour matters more than a distinct one.
//
// More agents than there are hues wraps rather than failing: the thirteenth
// shares with the first, which is worse than distinct and far better than
// undefined.
export function paletteFor(agentIds) {
  const ids = [...new Set((agentIds || []).filter(Boolean))].sort();
  const taken = new Set();
  const out = new Map();
  for (const id of ids) {
    const start = slotFor(id);
    let slot = start;
    for (let step = 0; step < AGENT_HUES.length; step += 1) {
      slot = (start + step) % AGENT_HUES.length;
      if (!taken.has(slot)) break;
    }
    taken.add(slot);
    out.set(id, AGENT_HUES[slot]);
  }
  return out;
}
