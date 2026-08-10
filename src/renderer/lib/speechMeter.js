// Drawing the voice: the equalizer under the read-aloud transport.
//
// While a turn is being synthesised the transport shows a loading bar, because
// there is a wait and nothing to hear. The moment sound arrives the bar has
// nothing left to say and this takes the row instead — spikes rising from a
// centre axis, coloured across the spectrum, over a band of the waveform itself.
// It is a measurement, not an animation: every height here comes from the audio
// actually leaving the speakers, through the analyser tapped into the player's
// graph (see agentSpeech.js `_build`), so it moves with the tone and the
// loudness of the voice rather than beside them.
//
// Everything in this file is arithmetic. No canvas, no DOM, no React — the same
// shape as statusMotion.js, and for the same reason: the part worth reading and
// the part worth testing should not need a browser to run. `paint` is the one
// exception in spirit, and it takes a context and numbers, which a test can hand
// it as a recording object.

// How narrow a bar may get before there are simply too many of them. Two pixels
// of bar and one of gap is the floor at which the picture is still a row of
// spikes rather than a smear.
export const MIN_PITCH = 3;

// The band a voice lives in. Below 120Hz is under the lowest fundamental of a
// speaking voice and holds nothing but rumble; above 7kHz is past the sibilance
// and into air that stays empty for the whole reading. Bars spent on either are
// bars that never move.
export const LO_HZ = 120;
export const HI_HZ = 7000;

// Under this, it is not the voice. The analyser's byte scale never quite reaches
// zero, and without a floor every bar sits permanently a little off the axis,
// which reads as a meter that is stuck rather than a room that is quiet.
export const FLOOR = 0.1;

// Lifts the quiet detail without lifting the floor with it. Speech spends most
// of its time well below full scale, and a linear scale draws that as almost
// nothing happening.
export const GAMMA = 0.7;

// How a bar comes down. Instantly up and slowly down is how a meter has always
// behaved, and it is what stops this strobing: the analyser's own smoothing
// settles the numbers, this settles the picture. 0.8 per frame reaches a tenth
// in about ten frames — a fall you can see, without a bar that hangs.
export const RELEASE = 0.8;

// The waveform lane is drawn from what is left after the gain, and a voice
// rarely peaks anywhere near full scale there. Without this the band would be a
// thin line down the middle of its own lane.
export const WAVE_GAIN = 1.6;

// How the height is split between the two lanes. The spectrum is the one being
// read, so it gets the larger share.
export const LANE_SPLIT = 0.62;

// How much of a bar's slot is the bar. The rest is the gap beside it, and the
// gap is what makes a row of spikes read as a graph rather than as a smear.
export const BAR_FILL = 0.55;

// How solid the ink gets. A loud bar is drawn at nearly full strength, because
// the colours in the reference are the point of it — the floor is what stops a
// row of quiet bars from disappearing into the card altogether.
export const INK_FLOOR = 0.36;
export const INK_RANGE = 0.55;
export const WAVE_INK = 0.8;
// The two centre lines are furniture, not data, and are drawn like it.
export const AXIS_INK = 0.3;

// The colours, when the stylesheet has not answered. Every one of these is
// declared on .transport-meter as a custom property and read from there — these
// are the fallback for a canvas painted before the styles have landed, which
// would otherwise draw `hsl(NaN …)`.
export const TOKENS = {
  hueFrom: 0,
  hueTo: 285,
  sat: 82,
  light: 60,
  wave: 'hsl(188 92% 58%)',
  axis: 'rgba(255, 255, 255, 0.35)',
};

// Which bins of the FFT are worth drawing, for a given device rate.
//
// Asked rather than assumed: the sample rate is 44.1k on some machines and 48k
// on others, and a mapping that assumed one puts the whole spectrum in the wrong
// place on the other.
export function usableBins(rate, fftSize, bins) {
  const perBin = rate / fftSize;
  const lo = Math.max(1, Math.round(LO_HZ / perBin));
  const hi = Math.max(lo + 1, Math.min(bins - 1, Math.round(HI_HZ / perBin)));
  return { lo, hi };
}

// How many bars fit. One per usable bin where the row is wide enough for that,
// never so many that a bar is thinner than MIN_PITCH, and never so few that the
// picture stops being a spectrum.
export function barCount(cssWidth, bins, rate, fftSize) {
  const width = Math.max(0, Number(cssWidth) || 0);
  let span = 0;
  if (bins > 2) {
    const { lo, hi } = usableBins(rate, fftSize, bins);
    span = hi - lo;
  }
  const room = Math.floor(width / MIN_PITCH);
  return Math.max(8, Math.min(room || 8, span || 96));
}

// Which bins each bar answers for, as a flat pair list so no object is allocated
// per bar and none per frame.
//
// Logarithmic across the band, which is the difference between a meter and a
// meter that works. A voice keeps almost all of its energy under about a
// kilohertz, and a linear map from 120Hz to 7kHz puts a kilohertz an eighth of
// the way along — so the whole reading happened in the leftmost inch of the row
// and the rest sat dead. Spacing the bars by ratio rather than by difference
// gives the octaves a voice actually uses roughly equal room, and the row fills.
//
// Two rules are kept whatever the arithmetic says: every bar has at least one
// bin, and the last one reaches the top of the band. A bar with no bins would
// sit dead on the axis for the whole reading, and a band that stopped short
// would quietly drop the sibilance off the end.
export function binRanges(bars, rate, fftSize, bins) {
  const { lo, hi } = usableBins(rate, fftSize, bins);
  const out = new Int32Array(bars * 2);
  const ratio = hi / lo;
  let at = lo;
  for (let i = 0; i < bars; i += 1) {
    const ideal = Math.floor(lo * Math.pow(ratio, (i + 1) / bars));
    // How many bars are still to come, and so how many bins have to be left for
    // them. This is what keeps the walk from eating the top of the band early —
    // and the floor under it is what stops a caller asking for more bars than
    // the band has bins from inverting a bucket. barCount will not ask for that,
    // but a bucket that ran backwards would read as silence for ever and be very
    // hard to see, so it is made impossible here rather than relied upon there.
    const left = bars - i - 1;
    const room = Math.max(at + 1, hi - left);
    const next = Math.min(Math.max(at + 1, ideal), room);
    out[i * 2] = at;
    out[i * 2 + 1] = next;
    at = next;
  }
  return out;
}

// How high one bar stands, from the bins behind it.
//
// The peak of the bucket rather than its mean. A voice is a handful of narrow
// formants against a lot of quiet, and averaging flattens exactly the thing that
// makes the picture look like speech instead of noise.
export function barValue(freq, lo, hi) {
  let peak = 0;
  for (let b = lo; b < hi; b += 1) {
    if (freq[b] > peak) peak = freq[b];
  }
  const v = (peak / 255 - FLOOR) / (1 - FLOOR);
  return v <= 0 ? 0 : Math.pow(v, GAMMA);
}

// Straight up, gently down. See RELEASE.
export function decay(prev, next) {
  return next > prev ? next : prev * RELEASE + next * (1 - RELEASE);
}

// The ramp across the row, built once per bar count.
//
// Red through orange, yellow, green and cyan to violet — the long way round the
// wheel, which is why it is written as two hue numbers that run up rather than
// as a pair of colours. Both ends come from the stylesheet.
export function barColors(bars, tokens = TOKENS) {
  const { hueFrom, hueTo, sat, light } = { ...TOKENS, ...tokens };
  const out = new Array(bars);
  const last = Math.max(1, bars - 1);
  for (let i = 0; i < bars; i += 1) {
    const h = hueFrom + ((hueTo - hueFrom) * i) / last;
    out[i] = `hsl(${h.toFixed(1)} ${sat}% ${light}%)`;
  }
  return out;
}

// How far below the axis each bar reaches.
//
// The spikes are not symmetrical — some drop further than others, and that
// irregularity is most of what makes the row read as a graph rather than a
// pattern. Fixed per bar rather than rolled per frame: random depths every frame
// would flicker, which is the one thing a meter must not do.
export function barDips(bars) {
  const out = new Float32Array(bars);
  for (let i = 0; i < bars; i += 1) {
    // Knuth's multiplicative hash, kept inside 32 bits. The same bar gets the
    // same reach every frame for as long as the row is that wide.
    const h = (((i * 2654435761) >>> 0) % 1000) / 1000;
    out[i] = 0.18 + 0.42 * h;
  }
  return out;
}

// The custom properties off one computed style, with the constants above
// standing in for anything the stylesheet has not answered yet.
export function readTokens(styles) {
  if (!styles || typeof styles.getPropertyValue !== 'function') return { ...TOKENS };
  const num = (name, fallback) => {
    const raw = parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(raw) ? raw : fallback;
  };
  const text = (name, fallback) => {
    const raw = String(styles.getPropertyValue(name) || '').trim();
    return raw || fallback;
  };
  return {
    hueFrom: num('--meter-hue-from', TOKENS.hueFrom),
    hueTo: num('--meter-hue-to', TOKENS.hueTo),
    sat: num('--meter-sat', TOKENS.sat),
    light: num('--meter-light', TOKENS.light),
    wave: text('--meter-wave', TOKENS.wave),
    axis: text('--meter-axis', TOKENS.axis),
  };
}

// The face drawn for a voice whose audio cannot be reached.
//
// The platform voice speaks through the window rather than through the app's
// audio graph, so there is no node to measure and nothing honest to plot. What
// is drawn instead is a shape — energy where a voice actually has it, a broad
// hump in the low mid falling away above, and never a claim about the top of the
// band where the platform may have nothing at all.
//
// The one real measurement on this path is the word: the platform fires a
// boundary as it reaches each one, so the envelope lifts when a word starts and
// settles between them. It moves with the speech, rather than beside it. The
// stylesheet drains most of the colour out of this face as well, so it is
// plainly not the same claim as the lit one.
export function syntheticLevels(level, bars, t, sinceWord) {
  const breath = 0.5 + 0.28 * Math.sin(t / 230) + 0.12 * Math.sin(t / 97);
  const burst = Math.exp(-Math.max(0, sinceWord) / 180);
  const amp = Math.min(1, 0.22 + 0.5 * breath + 0.4 * burst);
  for (let i = 0; i < bars; i += 1) {
    const at = i / Math.max(1, bars - 1);
    const shape = Math.exp(-((at - 0.18) * (at - 0.18)) / 0.08);
    const wobble = 0.55 + 0.45 * Math.sin(t / (140 + i * 7) + i * 0.6);
    level[i] = decay(level[i], amp * shape * wobble);
  }
  return amp;
}

// The still frame, for a window that has asked for less motion.
//
// The same bargain the loading bar makes one rule above it in the stylesheet:
// the movement goes and the state stays. A reader who cannot have the animation
// still gets a row that says a voice is speaking, in the same colours, drawn
// once and left alone.
export function stillLevels(level, bars) {
  for (let i = 0; i < bars; i += 1) {
    const at = i / Math.max(1, bars - 1);
    level[i] = 0.45 * Math.exp(-((at - 0.18) * (at - 0.18)) / 0.08);
  }
}

function clamp1(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

// One frame, in device pixels.
//
// Takes a context and numbers and nothing else — no element, no window, no
// measurement of its own — so a test can hand it a recording object and assert
// what was drawn. The canvas is transparent and the panel's own surface is the
// ground, which is how the meter stays on-theme without knowing the theme.
export function paint(ctx, W, H, dpr, opts) {
  const { level, colors, dips, tokens, time, t = 0, still = false, amp = 0.5 } = opts;
  const bars = level.length;
  const pad = Math.max(1, Math.round(dpr));

  ctx.clearRect(0, 0, W, H);

  // The lanes. The spectrum takes the larger share and keeps its axis in the
  // middle of it, so the spikes have somewhere to fall to as well as rise from.
  const sh = (H - 3 * pad) * LANE_SPLIT;
  const sy0 = pad;
  const sMid = sy0 + sh / 2;
  const wy0 = sy0 + sh + pad;
  const wh = H - 3 * pad - sh;
  const wMid = wy0 + wh / 2;

  const pitch = W / bars;
  const bw = Math.max(1, Math.round(pitch * BAR_FILL));

  // The two centre lines, one per lane. The spine of the graph, and the whole of
  // its furniture — no rules, no frame, no ticks. Nothing else in this app draws
  // a grid, and a backdrop behind a control is the last place to start.
  ctx.fillStyle = tokens.axis;
  ctx.globalAlpha = AXIS_INK;
  ctx.fillRect(0, Math.round(sMid), W, 1);
  ctx.fillRect(0, Math.round(wMid), W, 1);

  // The spikes. Positions are rounded so every gap is the same width — a bar
  // landing on a half pixel is drawn across two of them, which reads as a row of
  // varying thickness rather than a graph. The floor of one device pixel keeps
  // the axis a continuous line through the quiet bars instead of a row of gaps.
  const reach = sh / 2;
  for (let i = 0; i < bars; i += 1) {
    const v = level[i];
    const up = Math.max(1, Math.round(v * reach));
    const down = Math.max(1, Math.round(v * reach * dips[i]));
    ctx.fillStyle = colors[i];
    ctx.globalAlpha = INK_FLOOR + INK_RANGE * v;
    ctx.fillRect(Math.round(i * pitch), Math.round(sMid) - up, bw, up + down);
  }

  // The waveform underneath: one column per device pixel, each filled from the
  // centre line out to the loudest sample it covers in either direction.
  //
  // Anchored to the axis rather than drawn between the two extremes, which is
  // what makes it the dense band in the reference instead of a thin trace
  // wandering across the lane. The thickness of the band at any point is the
  // loudness of the voice there, which is the thing worth seeing.
  ctx.fillStyle = tokens.wave;
  ctx.globalAlpha = WAVE_INK;
  const half = wh / 2;
  for (let k = 0; k < W; k += 1) {
    let hi;
    let lo;
    if (time && time.length) {
      const a = Math.floor((k * time.length) / W);
      const b = Math.max(a + 1, Math.floor(((k + 1) * time.length) / W));
      hi = -1;
      lo = 1;
      for (let s = a; s < b && s < time.length; s += 1) {
        const v = (time[s] - 128) / 128;
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
    } else {
      // No signal to read: the blind face, and the still frame. A band of the
      // same envelope the spikes are drawn from, so the two lanes agree about
      // how loud the voice is even when neither of them can measure it.
      const swell = still ? 0.18 : amp * 0.55 * (0.6 + 0.4 * Math.sin(k * 0.05 + t / 120));
      hi = swell;
      lo = -swell;
    }
    // Never the wrong side of the axis: a column whose samples all sit above the
    // centre still fills down to it, so the band is continuous.
    const y0 = wMid - clamp1(Math.max(0, hi) * WAVE_GAIN) * half;
    const y1 = wMid - clamp1(Math.min(0, lo) * WAVE_GAIN) * half;
    ctx.fillRect(k, y0, 1, Math.max(1, y1 - y0));
  }

  ctx.globalAlpha = 1;
}
