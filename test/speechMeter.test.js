'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { load } = require('../scripts/lib/reactDrive.js');

// The equalizer under the read-aloud transport.
//
// While a turn is being synthesised the transport shows a loading bar, because
// there is a wait and nothing to hear; the moment sound arrives this takes the
// row instead. Two claims are being made by that, and both are worth pinning
// here rather than only being visible in a running window:
//
//   1. It is a *measurement*. Every height comes from the audio actually leaving
//      the speakers, so the mapping from bins to bars, and from bar to height,
//      has to be right on a machine running at 44.1kHz as well as one at 48.
//   2. The two faces never share the row. A bar that stayed lit under a meter
//      would be claiming a turn was still being made while it was being spoken.
//
// ESM for the renderer, so the imports are dropped and the `export` keywords
// stripped and the module evaluated — exactly as statusMotion.test.js does.
// Nothing runs at module scope, so no canvas and no window ever have to exist.
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const SRC = fs.readFileSync(path.join(RENDERER, 'lib', 'speechMeter.js'), 'utf8');
const {
  MIN_PITCH,
  LO_HZ,
  HI_HZ,
  FLOOR,
  RELEASE,
  LANE_SPLIT,
  BAR_FILL,
  TOKENS,
  usableBins,
  barCount,
  binRanges,
  barValue,
  decay,
  barColors,
  barDips,
  readTokens,
  syntheticLevels,
  stillLevels,
  paint,
} = new Function(
  `${SRC.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '')}
   return { MIN_PITCH, LO_HZ, HI_HZ, FLOOR, RELEASE, LANE_SPLIT, BAR_FILL, TOKENS, usableBins,
            barCount, binRanges, barValue, decay, barColors, barDips, readTokens,
            syntheticLevels, stillLevels, paint };`
)();

const FFT = 2048;
const BINS = FFT / 2;

// ------------------------------------------------------------- bins to bars

test('the band drawn is the band a voice lives in', () => {
  for (const rate of [44100, 48000]) {
    const { lo, hi } = usableBins(rate, FFT, BINS);
    const perBin = rate / FFT;
    assert.ok(lo * perBin <= LO_HZ + perBin, `${rate}: the low edge lands on ${LO_HZ}Hz`);
    assert.ok(hi * perBin >= HI_HZ - perBin, `${rate}: the high edge lands on ${HI_HZ}Hz`);
    assert.ok(hi < BINS, `${rate}: and never past the last bin there is`);
  }
});

// The rate is asked for rather than assumed, and this is why: 44.1k and 48k put
// the same frequency in different bins, so a mapping written for one draws the
// wrong part of the spectrum on a machine running the other.
test('the same frequency is a different bin at a different rate', () => {
  const a = usableBins(44100, FFT, BINS);
  const b = usableBins(48000, FFT, BINS);
  assert.notDeepEqual(a, b, 'the two rates must not resolve to the same bins');
});

test('every bar has bins, and no bin is drawn twice', () => {
  for (const rate of [44100, 48000]) {
    const bars = 82;
    const { lo, hi } = usableBins(rate, FFT, BINS);
    const ranges = binRanges(bars, rate, FFT, BINS);
    assert.equal(ranges[0], lo, 'the first bar starts at the low edge');
    assert.equal(ranges[bars * 2 - 1], hi, 'the last one ends at the high edge');
    for (let i = 0; i < bars; i += 1) {
      const a = ranges[i * 2];
      const b = ranges[i * 2 + 1];
      assert.ok(b > a, `${rate}: bar ${i} has at least one bin to read`);
      // A gap would be a frequency nothing draws; an overlap would be one drawn
      // twice, which reads as a wider peak than the voice actually has.
      if (i + 1 < bars) assert.equal(b, ranges[(i + 1) * 2], `${rate}: bar ${i} meets bar ${i + 1}`);
    }
  }
});

// The reason the mapping is logarithmic: a voice keeps nearly all of its energy
// under about a kilohertz, and spacing the bars evenly by frequency put the
// whole reading in the leftmost inch of the row with the rest sitting dead.
test('the low end gets the room a voice actually uses', () => {
  const bars = 72;
  const ranges = binRanges(bars, 48000, FFT, BINS);
  const width = (i) => ranges[i * 2 + 1] - ranges[i * 2];
  assert.equal(width(0), 1, 'the lowest bars are one bin each');
  assert.ok(width(bars - 1) > width(0) * 3, 'and the highest cover many');
  // Half the row should be below a kilohertz, which is where a voice lives.
  const perBin = 48000 / FFT;
  let atKilo = 0;
  while (atKilo < bars && ranges[atKilo * 2] * perBin < 1000) atKilo += 1;
  assert.ok(atKilo > bars * 0.3, `only ${atKilo} of ${bars} bars under 1kHz`);
});

// barCount never asks for more bars than the band has bins, but a bucket that
// ran backwards would read as silence for ever and be nearly impossible to spot,
// so it is made impossible rather than relied upon.
test('a bucket never runs backwards, however many bars are asked for', () => {
  for (const bars of [8, 72, 300, 1000]) {
    const ranges = binRanges(bars, 48000, FFT, BINS);
    for (let i = 0; i < bars; i += 1) {
      assert.ok(ranges[i * 2 + 1] > ranges[i * 2], `${bars} bars: bar ${i} reads at least one bin`);
    }
  }
});

test('bars never get thinner than a bar, or fewer than a spectrum', () => {
  for (const width of [0, 40, 120, 248, 900]) {
    const bars = barCount(width, BINS, 48000, FFT);
    assert.ok(bars >= 8, `${width}px: still recognisably a spectrum`);
    if (width >= 8 * MIN_PITCH) {
      assert.ok(width / bars >= MIN_PITCH, `${width}px: ${bars} bars leaves each one room`);
    }
  }
  const { lo, hi } = usableBins(48000, FFT, BINS);
  assert.ok(barCount(4000, BINS, 48000, FFT) <= hi - lo, 'and never more bars than there are bins');
});

// ------------------------------------------------------------ bars to heights

test('a bar reads the loudest thing in its bucket, not the average of it', () => {
  const freq = new Uint8Array(BINS);
  freq[10] = 255;
  // One narrow peak against silence — a formant. Averaging would draw it as
  // almost nothing, which is exactly how a voice stops looking like a voice.
  assert.equal(barValue(freq, 8, 16), 1);
});

test('the noise floor is not the voice', () => {
  const freq = new Uint8Array(BINS);
  freq.fill(Math.floor(255 * FLOOR));
  assert.equal(barValue(freq, 0, 8), 0, 'a quiet room sits on the axis');
});

test('louder is always taller', () => {
  const freq = new Uint8Array(BINS);
  let last = -1;
  for (const level of [60, 100, 140, 180, 220, 255]) {
    freq[0] = level;
    const v = barValue(freq, 0, 1);
    assert.ok(v > last, `${level} must stand higher than ${last}`);
    assert.ok(v <= 1);
    last = v;
  }
});

test('a bar goes up at once and comes down over about ten frames', () => {
  assert.equal(decay(0.1, 0.9), 0.9, 'the attack is instant — a meter must not lag the voice');
  let v = 1;
  for (let i = 0; i < 10; i += 1) v = decay(v, 0);
  assert.ok(v < 0.15, `ten frames should be most of the way down, got ${v}`);
  assert.ok(v > 0, 'but not a bar that snaps off, which is what strobes');
  assert.ok(RELEASE > 0 && RELEASE < 1);
});

// --------------------------------------------------------------- the colours

test('the ramp runs the long way round the wheel, from the stylesheet', () => {
  const colors = barColors(12, { hueFrom: 0, hueTo: 285, sat: 82, light: 60 });
  assert.equal(colors.length, 12);
  const hues = colors.map((c) => parseFloat(c.slice(4)));
  assert.equal(hues[0], 0, 'red at one end');
  assert.equal(hues[hues.length - 1], 285, 'violet at the other');
  for (let i = 1; i < hues.length; i += 1) assert.ok(hues[i] > hues[i - 1], 'and it only runs up');
  // The tokens are the stylesheet's to change, which is the whole reason they
  // are tokens: a theme that wanted a quieter meter must not have to edit the JS.
  const quiet = barColors(4, { hueFrom: 200, hueTo: 220, sat: 30, light: 50 });
  assert.ok(quiet.every((c) => c.includes('30%') && c.includes('50%')));
});

test('a bar reaches the same distance below the axis every frame', () => {
  const a = barDips(40);
  const b = barDips(40);
  assert.deepEqual([...a], [...b], 'rolled per frame, the row would flicker');
  for (const d of a) assert.ok(d >= 0.18 && d <= 0.6, `${d} is a dip, not a second graph`);
  assert.ok(new Set([...a]).size > 10, 'and they are not all the same, or it is a pattern');
});

test('the colours fall back rather than drawing hsl(NaN)', () => {
  // A canvas painted before the stylesheet has landed. Every value still has to
  // be something a context can be given.
  const empty = readTokens({ getPropertyValue: () => '' });
  assert.deepEqual(empty, TOKENS);
  const none = readTokens(null);
  assert.deepEqual(none, TOKENS);
  for (const [key, value] of Object.entries(empty)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is a number`);
    else assert.ok(value.length > 0, `${key} is a colour`);
  }
});

test('the stylesheet is what is read, when it has answered', () => {
  const styles = {
    getPropertyValue: (name) =>
      ({
        '--meter-hue-from': ' 10 ',
        '--meter-hue-to': '200',
        '--meter-sat': '40%',
        '--meter-light': '55%',
        '--meter-wave': ' hsl(1 2% 3%) ',
        '--meter-axis': 'rgba(1, 2, 3, 0.4)',
      })[name] || '',
  };
  assert.deepEqual(readTokens(styles), {
    hueFrom: 10,
    hueTo: 200,
    sat: 40,
    light: 55,
    wave: 'hsl(1 2% 3%)',
    axis: 'rgba(1, 2, 3, 0.4)',
  });
});

// ------------------------------------------------------------- the blind face

test('the blind face lifts on a word and settles between them', () => {
  const bars = 40;
  const level = new Float32Array(bars);
  const onWord = syntheticLevels(level, bars, 1000, 0);
  const between = syntheticLevels(new Float32Array(bars), bars, 1000, 600);
  assert.ok(onWord > between, 'the boundary the platform really fires is what moves it');
});

test('the blind face puts its energy where a voice has energy', () => {
  const bars = 60;
  const level = new Float32Array(bars);
  // Settled, so the shape rather than one frame of wobble is what is measured.
  for (let i = 0; i < 40; i += 1) syntheticLevels(level, bars, 1000 + i * 16, 0);
  let peak = 0;
  for (let i = 1; i < bars; i += 1) if (level[i] > level[peak]) peak = i;
  assert.ok(peak < bars * 0.5, 'a hump in the low mid, not a claim about the top of the band');
});

test('the still frame is the same frame whenever it is asked for', () => {
  const a = new Float32Array(30);
  const b = new Float32Array(30);
  stillLevels(a, 30);
  stillLevels(b, 30);
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.max(...a) > 0.2, 'and it is visible — the state survives the motion going');
});

// ------------------------------------------------------------------ the frame

// A context that records rather than draws, so what was painted can be asserted
// without a canvas.
function recorder() {
  const calls = [];
  return {
    calls,
    fillStyle: null,
    globalAlpha: 1,
    clearRect: (...a) => calls.push({ op: 'clear', a }),
    fillRect(...a) {
      calls.push({ op: 'fill', a, fill: this.fillStyle, alpha: this.globalAlpha });
    },
  };
}

function frame(overrides = {}) {
  const bars = 24;
  const level = new Float32Array(bars).fill(0.5);
  return {
    level,
    colors: barColors(bars, TOKENS),
    dips: barDips(bars),
    tokens: TOKENS,
    time: null,
    ...overrides,
  };
}

test('a frame clears once and draws both lanes', () => {
  const ctx = recorder();
  const opts = frame();
  paint(ctx, 240, 60, 2, opts);
  const clears = ctx.calls.filter((c) => c.op === 'clear');
  assert.equal(clears.length, 1, 'one clear, or the last frame shows through');
  assert.deepEqual(clears[0].a, [0, 0, 240, 60]);

  const axes = ctx.calls.filter((c) => c.op === 'fill' && c.fill === TOKENS.axis);
  assert.equal(axes.length, 2, 'a centre line for the spectrum and one for the waveform');
  const [spectrum, wave] = axes.map((c) => c.a[1]);
  assert.ok(spectrum < wave, 'the spectrum sits above the waveform');
  // The split is the reason the spectrum reads first: it is the larger lane.
  assert.ok(spectrum < 60 * LANE_SPLIT && wave > 60 * LANE_SPLIT);

  const spikes = ctx.calls.filter((c) => c.op === 'fill' && opts.colors.includes(c.fill));
  assert.equal(spikes.length, opts.level.length, 'exactly one spike per bar');

  // No rules, no frame, no ticks. Nothing else in the app draws a grid, and a
  // backdrop behind a control is the last place to start one — so a frame is
  // exactly the spikes, the two centre lines, and the waveform's own columns.
  const waveCols = ctx.calls.filter((c) => c.op === 'fill' && c.fill === TOKENS.wave);
  assert.equal(spikes.length + axes.length + waveCols.length, ctx.calls.length - clears.length);
});

test('the bars are evenly spaced, with an even gap beside each', () => {
  const ctx = recorder();
  const opts = frame();
  paint(ctx, 240, 60, 2, opts);
  const spikes = ctx.calls.filter((c) => c.op === 'fill' && opts.colors.includes(c.fill));
  const widths = new Set(spikes.map((s) => s.a[2]));
  assert.equal(widths.size, 1, 'a bar landing on a half pixel is drawn across two of them');
  const gaps = new Set();
  for (let i = 1; i < spikes.length; i += 1) gaps.add(spikes[i].a[0] - spikes[i - 1].a[0]);
  assert.ok(gaps.size <= 2, 'and the pitch never wanders by more than a rounding');
  assert.ok([...widths][0] >= 1 && [...widths][0] <= Math.ceil((240 / spikes.length) * BAR_FILL) + 1);
});

test('a louder bar is a taller bar, in the picture as well as the number', () => {
  const ctx = recorder();
  const opts = frame();
  opts.level[0] = 0.1;
  opts.level[1] = 1;
  paint(ctx, 240, 60, 2, opts);
  const spikes = ctx.calls.filter((c) => c.op === 'fill' && opts.colors.includes(c.fill));
  assert.ok(spikes[1].a[3] > spikes[0].a[3], 'the loud bar is drawn taller');
  assert.ok(spikes[1].alpha > spikes[0].alpha, 'and brighter');
});

test('a silent bar still holds the axis', () => {
  const ctx = recorder();
  const opts = frame({ level: new Float32Array(24) });
  paint(ctx, 240, 60, 2, opts);
  const spikes = ctx.calls.filter((c) => c.op === 'fill' && opts.colors.includes(c.fill));
  assert.equal(spikes.length, 24);
  for (const s of spikes) assert.ok(s.a[3] >= 2, 'a row of gaps would read as a broken meter');
});

test('every colour the canvas draws with came from the stylesheet', () => {
  const ctx = recorder();
  const opts = frame({ time: new Uint8Array(2048).fill(128) });
  paint(ctx, 240, 60, 2, opts);
  const allowed = new Set([...opts.colors, TOKENS.wave, TOKENS.axis]);
  for (const call of ctx.calls) {
    if (call.op !== 'fill') continue;
    assert.ok(allowed.has(call.fill), `${call.fill} is not one of the tokens`);
  }
  // And the module itself holds no colour of its own beyond the fallbacks, which
  // are the tokens' own defaults rather than a second palette.
  assert.doesNotMatch(SRC, /#[0-9a-fA-F]{3,8}\b/, 'no hex in the drawing code');
});

test('the waveform lane is read from the audio when there is audio to read', () => {
  const quiet = new Uint8Array(2048).fill(128);
  const loud = new Uint8Array(2048);
  for (let i = 0; i < loud.length; i += 1) loud[i] = i % 2 ? 255 : 0;

  const heights = (time) => {
    const ctx = recorder();
    const opts = frame({ time });
    paint(ctx, 240, 60, 2, opts);
    return ctx.calls
      .filter((c) => c.op === 'fill' && c.fill === TOKENS.wave)
      .reduce((sum, c) => sum + c.a[3], 0);
  };
  assert.ok(heights(loud) > heights(quiet), 'a loud passage draws a taller band than a quiet one');
});

test('the still frame does not move, whenever it is drawn', () => {
  const draw = (t) => {
    const ctx = recorder();
    const opts = frame();
    stillLevels(opts.level, opts.level.length);
    paint(ctx, 240, 60, 2, { ...opts, t, still: true });
    return JSON.stringify(ctx.calls);
  };
  assert.equal(draw(0), draw(9999), 'reduced motion means one frame, not a slow one');
});

// --------------------------------------------------- the row, and what is in it

const CSS = fs
  .readFileSync(path.join(RENDERER, 'styles.css'), 'utf8')
  // The Windows runner checks out CRLF, and a regex written for one newline does
  // not match the other.
  .replace(/\r\n/g, '\n');

const ruleFor = (selector) => {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at > 0, `${selector} is in the stylesheet`);
  return CSS.slice(at, CSS.indexOf('\n}', at));
};

test('the bar and the meter share one slot that never changes height', () => {
  const face = ruleFor('.transport-face');
  assert.match(face, /position:\s*relative/);
  assert.match(face, /height:\s*30px/, 'a fixed height, so nothing below it moves as they swap');
  assert.match(face, /margin-top:\s*8px/, 'the gap the bar used to carry, now the slot s');
});

test('the synthesising bar keeps the place it has always had', () => {
  const load = ruleFor('.transport-load');
  assert.match(load, /position:\s*absolute/);
  assert.match(load, /top:\s*0/, 'pinned to the top of the slot, on the pixel it was on before');
  assert.doesNotMatch(load, /margin-top/, 'the margin moved to the slot, or the bar would shift down');
  assert.match(load, /height:\s*3px/, 'and it is the same bar');
  assert.match(load, /transition:\s*opacity 0\.15s ease 0\.25s/, 'including the cache-hit delay');
});

test('the meter sits behind the buttons, and stops short of the card', () => {
  const meter = ruleFor('.transport-meter');
  assert.match(meter, /position:\s*absolute/);
  // Measured back up out of the slot it lives in, so the spikes rise behind the
  // transport's buttons. The card's inner edge is 54px above the slot — 8px of
  // padding, the 38px button row and the slot's own 8px of margin — and the
  // graph is kept clear of it.
  const top = /top:\s*(-?\d+)px/.exec(meter);
  assert.ok(top, 'the meter is placed in px, not left to the flow');
  const above = -Number(top[1]);
  assert.ok(above > 38, `it reaches up past the buttons (${above}px)`);
  assert.ok(above < 54, `but never to the card's own edge (${above}px of 54)`);
  // A canvas is a replaced element: given top and bottom but no height it takes
  // its own intrinsic 150px and drops the bottom, which drew the meter straight
  // through everything under the transport.
  assert.match(meter, /height:\s*\d+px/, 'its height is stated rather than inferred');
  assert.match(meter, /z-index:\s*0/, 'and it is behind what it sits behind');
  // Rounded corners are why the card has to be the thing that clips it.
  assert.match(ruleFor('.conn-transport'), /overflow:\s*hidden/);
  assert.match(ruleFor('.transport-row'), /z-index:\s*1/, 'the buttons stay in front');
  assert.match(meter, /opacity:\s*0/, 'dark until there is something to hear');
  // In on a delay, out on none: the bar is visibly finished before the meter
  // arrives, rather than the two dissolving through each other.
  assert.match(meter, /transition:\s*opacity 0\.18s ease 0\.12s/);
  for (const token of [
    '--meter-hue-from',
    '--meter-hue-to',
    '--meter-sat',
    '--meter-light',
    '--meter-wave',
    '--meter-axis',
  ]) {
    assert.ok(meter.includes(token), `${token} is declared in the stylesheet, not in the JS`);
  }
});

test('reduced motion stops the meter without hiding it', () => {
  const at = CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  /* The cursor and the sparks');
  assert.ok(at > 0, 'the transport s reduced-motion block is still where this test thinks it is');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', CSS.indexOf('.transport-load.filling', at)));
  const meter = block.slice(block.indexOf('.transport-meter'));
  assert.match(meter, /transition:\s*none/, 'the fade goes, or the one frame arrives by animation');
  assert.doesNotMatch(meter, /display:\s*none|opacity:\s*0[^.]/, 'the state has to survive');
});

// ------------------------------------------------------- the transport itself

const ConnectionPanel = load(path.join(RENDERER, 'components', 'ConnectionPanel.jsx')).default;

const session = {
  id: 'session:1',
  kind: 'session',
  name: 'New Session',
  counselIds: ['agent:1', 'agent:2'],
  counselNames: ['Mac', 'Zima'],
};

const draw = (speech) =>
  renderToStaticMarkup(
    React.createElement(ConnectionPanel, {
      peer: session,
      stats: null,
      agentStatus: null,
      awaiting: false,
      typing: false,
      streaming: false,
      commits: 0,
      speech: {
        playing: false,
        paused: false,
        pending: false,
        prefetch: null,
        position: 0,
        count: 0,
        engine: null,
        meter: null,
        onToggle: () => {},
        onNext: () => {},
        onPrev: () => {},
        ...speech,
      },
    })
  );

test('a session with turns to read has a transport that works', () => {
  // The regression, at the far end of the wiring: the transport went dead when a
  // discussion ended because the list was emptied under it, and an empty list
  // disables every button here.
  const html = draw({ count: 12, position: 3 });
  assert.ok(html.includes('12 turns'), 'it says what there is to read');
  assert.ok(!/transport-play[^>]*disabled/.test(html), 'and play is not disabled');
});

test('the meter is decoration, and the progress bar still speaks', () => {
  const html = draw({ count: 4, playing: true });
  assert.ok(html.includes('class="transport-meter on "'), 'the meter is lit while a voice is heard');
  assert.ok(/<canvas[^>]*aria-hidden="true"/.test(html), 'and says nothing — it is a picture');
  assert.ok(html.includes('role="progressbar"'), 'the bar is still the announced one');
  assert.ok(html.includes('aria-valuetext="Ready"'));
});

test('the bar has the row while a turn is being made, and the meter has it after', () => {
  const making = draw({ count: 4, playing: true, pending: true });
  assert.ok(making.includes('transport-load on'), 'the bar is lit');
  assert.ok(!/class="transport-meter on/.test(making), 'and the meter is not — they never share');

  const saying = draw({ count: 4, playing: true, pending: false });
  assert.ok(!/transport-load on/.test(saying), 'once the sound arrives the bar is done');
  assert.ok(/class="transport-meter on/.test(saying), 'and the meter takes the row');
});

test('a session being pre-synthesised belongs to the bar too', () => {
  const html = draw({ count: 4, playing: true, prefetch: { done: 1, total: 4 } });
  assert.ok(html.includes('transport-load on filling'));
  assert.ok(!/class="transport-meter on/.test(html), 'nothing has been said yet to meter');
});

test('the platform voice is metered visibly blind', () => {
  const html = draw({ count: 4, playing: true, engine: 'local' });
  assert.ok(html.includes('transport-meter on blind'), 'drawn back, because it is a shape not data');
  assert.ok(html.includes('This computer'), 'and the row says which voice that is');
});
