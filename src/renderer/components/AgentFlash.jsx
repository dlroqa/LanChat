import React, { useEffect, useState } from 'react';

// The light that fills an agent thread when it connects, and when a run comes
// back with nothing in it.
//
// It exists because those two moments used to be reported in words. Connecting
// was reported by silence, and an empty run by the string "(no output)" — which
// reads as an error at exactly the moment somebody is trying to find out whether
// the channel works. Neither is an error and neither is really a sentence, so
// they are shown instead: light in the space where the answer would have been,
// and then gone.
//
// Three properties are deliberate, and each is the fix for a way this could have
// gone wrong:
//
//   * It is a sibling of the scrolling message list, never a child of it. Inside
//     a scroller, `inset: 0` resolves against the content box — the light would
//     stretch to the full scroll height and slide out of view as you read.
//   * It never takes pointer events and never blocks input. Chatting continues
//     underneath it: that is the whole point of a light that says "you are
//     connected" rather than a modal that says it.
//   * It announces itself. The visuals are aria-hidden, so on their own this
//     would be a state conveyed by motion and colour alone.
export default function AgentFlash({ mode = 'connected', ms, name, onDone }) {
  // Whether the window is actually in front. An animation ticking behind a
  // minimised window is battery spent on nothing, and one that *started* while
  // hidden would be half over when the user came back — worse than not playing,
  // because they would see it end without having seen it happen.
  const [visible, setVisible] = useState(() => !isHidden());

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(!isHidden());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    // A run of this can be interrupted at any moment — by another summon
    // remounting it, by the thread changing, by the window closing. The timer is
    // owned here and cleared on the way out, so nothing survives to fire against
    // a component that is gone.
    const timer = setTimeout(() => onDone?.(), ms);
    return () => clearTimeout(timer);
  }, [visible, ms, onDone]);

  if (!visible) return null;

  return (
    <div className={`agent-flash ${mode}`} style={{ '--flash-ms': `${ms}ms` }}>
      {/* Decoration, and named as such: everything below is one light, and a
          screen reader has nothing to gain from being walked through its
          layers. The sentence it stands for is in the live region underneath. */}
      <div className="agent-flash-art" aria-hidden="true">
        <span className="agent-flash-glass" />
        <span className="agent-flash-prism" />
        <span className="agent-flash-frames">
          {FRAMES.map((f, i) => (
            <i key={i} style={frameStyle(f)} />
          ))}
        </span>
        <span className="agent-flash-mirror">
          {FRAMES.map((f, i) => (
            <i key={i} style={frameStyle(f)} />
          ))}
        </span>
        <span className="agent-flash-sheen" />
      </div>
      {/* Polite: it never interrupts what is already being read out, and it says
          the same thing to somebody who cannot see the light as the light says to
          somebody who can. */}
      <div className="sr-only" role="status" aria-live="polite">
        {mode === 'empty' ? 'The run finished with no output.' : `Connected to ${name || 'the agent'}.`}
      </div>
    </div>
  );
}

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// The receding frames from the reference: each one further back, turned a little
// further, lit a little differently, and starting a beat after the one in front.
//
// `dx` is what makes this a corridor rather than a set of concentric rectangles.
// Sharing one centre reads as a target; drifting the far frames off to one side
// gives the run a vanishing point, which is the whole illusion.
//
// Written out rather than generated: the depths are not a formula, they are a
// picture, and a picture is easier to adjust when you can see all of it at once.
const FRAMES = [
  { z: -80, dx: 0, rot: -13, hue: 'a', scale: 1.02, delay: 0 },
  { z: -220, dx: -3, rot: 9, hue: 'b', scale: 0.88, delay: 90 },
  { z: -360, dx: -6, rot: -6, hue: 'c', scale: 0.76, delay: 180 },
  { z: -520, dx: -9, rot: 14, hue: 'a', scale: 0.62, delay: 270 },
  { z: -680, dx: -11, rot: -18, hue: 'b', scale: 0.5, delay: 360 },
  { z: -840, dx: -13, rot: 5, hue: 'c', scale: 0.4, delay: 450 },
  { z: -1000, dx: -14, rot: -9, hue: 'a', scale: 0.3, delay: 540 },
];

// The hues come from the existing --streak-* palette rather than a new set of
// tokens: it was already matched to a long-exposure reference and already holds
// exactly the magenta / violet / amber the connection light wants. Two palettes
// this close together would drift.
const EDGES = { a: 'var(--streak-violet)', b: 'var(--streak-magenta)', c: 'var(--streak-amber)' };

function frameStyle(f) {
  return {
    '--z': `${f.z}px`,
    '--dx': `${f.dx}%`,
    '--rot': `${f.rot}deg`,
    '--sc': f.scale,
    '--edge': EDGES[f.hue],
    animationDelay: `${f.delay}ms`,
  };
}
