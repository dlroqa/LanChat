'use strict';

// Turning a turn of English into the numbers Kokoro's graph wants.
//
// Kokoro is not a text model. It takes phonemes — one token per IPA character —
// so everything between "what an agent said" and "what the model is fed" happens
// here: expand what is written but not said (2019, $4.50, Dr.), hand the words to
// a grapheme-to-phoneme engine, repair what that engine gets wrong for this
// particular model, and look each resulting character up in a 115-entry table.
//
// Three of those four steps are pure string work with no I/O and no model, which
// is why they live in their own file: test/kokoroText.test.js drives every rule
// below without a single byte of weights on disk. Only the G2P call itself needs
// the `phonemizer` package, and that stays in the worker.
//
// The normalisation rules and the phoneme repairs are ported from kokoro-js
// (Apache-2.0, https://github.com/hexgrad/kokoro), which is the reference
// implementation for this model. They look arbitrary and they are not: each one
// exists because the model mispronounces something without it. They are kept
// close to the original deliberately — this is the one part of the pipeline where
// improvising means sounding wrong in a way that is hard to trace back.
//
// The sentence splitter is *not* ported. kokoro-js has a streaming one built for
// a different job; what this needs is narrower and is written to the real
// constraint, which is a token count rather than a character count. See splitFor.

// The model's positional limit. The style vector is indexed by token count into
// a 510-row pack, so 510 is not a soft budget — a longer sequence has no style
// row to read and the run is meaningless. Two slots go to the boundary tokens.
const MAX_TOKENS = 510;
const MAX_BODY_TOKENS = MAX_TOKENS - 2;

// Rows in a voice pack: 510 × 256 float32, which is the 522,240 bytes each
// `voices/*.bin` weighs. The last valid row index is one less, and that — not
// MAX_BODY_TOKENS — is what the style lookup clamps to. The two are easy to
// confuse and the difference is silent: clamping low reads a row meant for a
// shorter utterance, which sounds like the voice hurrying the end of a long
// sentence rather than like a bug.
const STYLE_ROWS = 510;

// The token both ends of every sequence carry. `$` is entry 0 of the vocabulary
// and is the model's boundary marker, not padding — dropping it detunes the
// prosody of the first and last word.
const BOUNDARY = '$';

// ------------------------------------------------------------ what is written
//
// Said aloud, "1985" is not "one thousand nine hundred and eighty five" and
// "$4.50" is not "dollar four point five zero". A G2P engine reads digits
// literally, so anything that is spoken differently from how it is spelled has to
// be rewritten into words *before* it gets there.

// A year, a clock time, or a decimal — told apart by shape, because the same
// four digits mean different things in each.
function saidAsNumber(raw) {
  // A decimal is handled later by saidAsDecimal; leaving it alone here keeps the
  // two rules from both firing on "3.14".
  if (raw.includes('.')) return raw;

  if (raw.includes(':')) {
    const [hour, minute] = raw.split(':').map(Number);
    if (minute === 0) return `${hour} o'clock`;
    return minute < 10 ? `${hour} oh ${minute}` : `${hour} ${minute}`;
  }

  const value = Number.parseInt(raw.slice(0, 4), 10);
  // Below 1100 a four-digit number is read as a number ("1024 bytes"), and a
  // round century keeps its own reading ("2000"), so both are left alone.
  if (value < 1100 || value % 1000 < 10) return raw;

  const century = raw.slice(0, 2);
  const rest = Number.parseInt(raw.slice(2, 4), 10);
  const plural = raw.endsWith('s') ? 's' : '';

  if (value % 1000 >= 100 && value % 1000 <= 999) {
    if (rest === 0) return `${century} hundred${plural}`;
    if (rest < 10) return `${century} oh ${rest}${plural}`;
  }
  return `${century} ${rest}${plural}`;
}

// Money is said with the unit in the middle, not at the front: "$4.50" is "four
// dollars and fifty cents".
function saidAsMoney(raw) {
  const unit = raw[0] === '$' ? 'dollar' : 'pound';
  const amount = raw.slice(1);

  // "$4 million" — the magnitude word is already words, so only the unit needs
  // saying, and it is always plural.
  if (Number.isNaN(Number(amount))) return `${amount} ${unit}s`;

  if (!amount.includes('.')) return `${amount} ${unit}${amount === '1' ? '' : 's'}`;

  const [whole, fraction] = amount.split('.');
  // "4.5" is forty-five cents, not five: the fraction is padded to two places
  // before it is read as a count of the minor unit.
  const minor = Number.parseInt(fraction.padEnd(2, '0'), 10);
  const minorName = raw[0] === '$' ? (minor === 1 ? 'cent' : 'cents') : minor === 1 ? 'penny' : 'pence';
  return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${minor} ${minorName}`;
}

// A decimal is read digit by digit after the point — "3.14" is "three point one
// four", never "three point fourteen".
function saidAsDecimal(raw) {
  const [whole, fraction] = raw.split('.');
  return `${whole} point ${fraction.split('').join(' ')}`;
}

// Everything written that is not said the way it is spelled.
//
// Order matters throughout and the rules are not independent: quotes are folded
// before brackets are turned into guillemets, numbers are expanded before the
// thousands separator is stripped, and money is read before bare decimals so
// "$4.50" never reaches saidAsDecimal. Reordering this list changes what the
// model says.
function normalize(raw) {
  return (
    String(raw == null ? '' : raw)
      // Typographic quotes and brackets, folded to one representation each so the
      // punctuation table below has a fixed set to match.
      .replace(/[‘’]/g, "'")
      .replace(/«/g, '“')
      .replace(/»/g, '”')
      .replace(/[“”]/g, '"')
      .replace(/\(/g, '«')
      .replace(/\)/g, '»')
      // Full-width CJK punctuation, which arrives in pasted text and which the
      // G2P engine reads as nothing at all.
      .replace(/、/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/，/g, ', ')
      .replace(/：/g, ': ')
      .replace(/；/g, '; ')
      .replace(/？/g, '? ')
      // Tabs and exotic spaces become ordinary ones; runs collapse. Newlines are
      // kept, because they are the strongest sentence boundary there is.
      .replace(/[^\S \n]/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/(?<=\n) +(?=\n)/g, '')
      // Titles. The lookahead for a capital is what stops "Dr." at the end of a
      // sentence being read as a title rather than an abbreviation.
      .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
      // "etc." keeps its stop only when a new sentence really follows it.
      //
      // The one deliberate departure from the reference implementation, which
      // writes this rule `/gi`. Under a case-insensitive flag `[A-Z]` also
      // matches a lowercase letter, so the lookahead the rule is built around
      // can never distinguish the two cases — it strips the stop at the end of a
      // sentence and keeps it in the middle of one, which is precisely backwards
      // and makes the voice pause mid-clause. The flag is dropped rather than the
      // rule. It changes a pause, never a phoneme.
      .replace(/\betc\.(?! [A-Z])/g, 'etc')
      // The model says "yeah" as a flat "yeh" without this.
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      // Years, clock times and decimals — told apart inside saidAsNumber.
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, saidAsNumber)
      // "1,024" — the separator is silent, and leaving it in makes two numbers.
      .replace(/(?<=\d),(?=\d)/g, '')
      .replace(
        /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
        saidAsMoney
      )
      .replace(/\d*\.\d+/g, saidAsDecimal)
      // A range: "3-5" is "three to five", not "three minus five".
      .replace(/(?<=\d)-(?=\d)/g, ' to ')
      // "10S" is a size, not a word ending.
      .replace(/(?<=\d)S/g, ' S')
      // Initialisms pluralise with a spoken S: "PDFs" is "P D F s", and the
      // apostrophe form is what makes the G2P engine treat it as separate.
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, 's')
      // "U.S. state" — the stops make the G2P engine end a sentence mid-phrase,
      // so within an initialism they become hyphens.
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (run) => run.replace(/\./g, '-'))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
      .trim()
  );
}

// ------------------------------------------------------------- what is spoken

// The characters the G2P engine must never see.
//
// Punctuation carries the prosody — a comma is a pause and a question mark is a
// rise — so it has to survive into the phoneme string rather than be phonemised.
// The text is cut into alternating word and punctuation runs, and only the word
// runs are sent to the engine.
const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_RUN = new RegExp(
  `(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`,
  'g'
);

// Cutting text into runs, marking which are punctuation. Every character of the
// input appears in exactly one run, so joining the results back together after
// phonemising the word runs reproduces the sentence.
function segment(text) {
  const runs = [];
  let at = 0;
  for (const found of text.matchAll(PUNCTUATION_RUN)) {
    if (at < found.index) runs.push({ punctuation: false, text: text.slice(at, found.index) });
    if (found[0].length) runs.push({ punctuation: true, text: found[0] });
    at = found.index + found[0].length;
  }
  if (at < text.length) runs.push({ punctuation: false, text: text.slice(at) });
  return runs;
}

// Which English the voice speaks. Kokoro's voice ids are prefixed by accent —
// `bf_emma` and `bm_george` are British, everything starting `a` is American —
// and the G2P engine needs telling, because the two differ in more than accent:
// "schedule" and "herb" get different phonemes, not different pronunciations of
// the same ones.
function languageOf(voice) {
  return String(voice || '')[0] === 'b' ? 'en' : 'en-us';
}

// Repairs to the phoneme string, applied after G2P and before tokenising.
//
// Every one of these is a place where the phonemiser is right about English and
// wrong about what this model was trained on. They are ported verbatim from the
// reference implementation; the alphabet Kokoro learned is narrower than IPA, and
// a character outside it tokenises to nothing and is silently dropped.
function repairPhonemes(phonemes, language) {
  let out = phonemes
    // The model's own name, which it otherwise says as "kuh-KOR-oh".
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    // Four characters the phonemiser emits that are not in the model's alphabet,
    // each folded to the nearest one that is.
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    // "two hundred" runs into one word without a break here.
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    // A trailing " z" before punctuation is the plural of the previous word, not
    // a word of its own.
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');

  // American English only: "ninety" keeps a hard t everywhere else.
  if (language === 'en-us') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');

  return out.trim();
}

// ------------------------------------------------------------- what is fed in

// Phonemes to token ids, against the vocabulary shipped with the weights.
//
// The vocabulary is read from the downloaded tokenizer.json rather than written
// down here, so a future revision of the model cannot silently disagree with a
// hardcoded copy. Characters outside it are dropped rather than replaced: they
// are the ones repairPhonemes did not catch, and a wrong token is a wrong sound
// where a missing one is a slightly shorter word.
function toIds(phonemes, vocab) {
  const ids = [vocab[BOUNDARY]];
  for (const ch of String(phonemes)) {
    const id = vocab[ch];
    if (Number.isInteger(id)) ids.push(id);
  }
  ids.push(vocab[BOUNDARY]);
  return ids;
}

// The style vector's row for a sequence of this length.
//
// A voice pack is 510 rows of 256 floats and the row is chosen by token count —
// the model was trained with a different style vector per length, which is what
// keeps a one-word answer from being read with the pacing of a paragraph. The
// clamp matters: an over-long sequence would index past the end of the pack and
// read another voice's memory.
function styleOffset(tokenCount) {
  return 256 * Math.min(Math.max(tokenCount - 2, 0), STYLE_ROWS - 1);
}

// ------------------------------------------------------------------ splitting

// Abbreviations whose full stop does not end a sentence.
const ABBREVIATIONS = new Set(
  (
    'mr mrs ms dr prof sr jr sgt col gen rep sen gov lt maj capt st mt etc co inc ltd dept ' +
    'vs p pg jan feb mar apr jun jul aug sep sept oct nov dec sun mon tu tue tues wed th ' +
    'thu thur thurs fri sat e.g i.e no vol fig approx est min max'
  ).split(' ')
);

function isAbbreviation(word) {
  return ABBREVIATIONS.has(
    word
      .replace(/['’]s$/i, '')
      .replace(/\.+$/, '')
      .toLowerCase()
  );
}

// Sentence ends, for text that has already been normalised.
//
// Deliberately not the reference implementation's streaming splitter: this one
// answers a different question. Nothing here streams — a turn arrives whole — and
// the thing that must not be exceeded is a token count, not a character count, so
// the split has to be cheap enough to run before phonemising and forgiving enough
// that the caller can regroup afterwards. Sentences are therefore cut generously
// and rejoined by token budget in splitFor.
//
// A stop is a sentence end unless it is an abbreviation, an initial, a decimal
// that survived normalisation, or inside a URL.
function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
      continue;
    }
    if (!'.!?…'.includes(ch)) continue;

    // A digit either side is a decimal or a version number.
    if (ch === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;

    // The word this stop belongs to, read backwards to the previous space.
    let from = i;
    while (from > start && /\S/.test(text[from - 1])) from--;
    const word = text.slice(from, i + 1);
    if (ch === '.' && (isAbbreviation(word) || /^([A-Za-z]\.)+$/.test(word))) continue;
    if (/https?:\/\//.test(word) || word.includes('@')) continue;

    // Trailing quotes and brackets belong to the sentence that is ending.
    let end = i;
    while (end + 1 < text.length && '.!?…"\'’”»)]}'.includes(text[end + 1])) end++;

    // Something must follow, or this is the final stop and the loop ends anyway.
    const piece = text.slice(start, end + 1).trim();
    if (piece) out.push(piece);
    start = end + 1;
    i = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// One more level down, for a "sentence" with no sentence end in it — a pasted log
// line, or a paragraph written without punctuation. Cut at commas first because
// they are still a natural breath, and at words only when there is nothing else.
function splitLong(text, budget) {
  const pieces = [];
  let current = '';
  for (const part of text.split(/(?<=,)\s+/)) {
    if (current && current.length + part.length > budget) {
      pieces.push(current.trim());
      current = '';
    }
    current += (current ? ' ' : '') + part;
  }
  if (current.trim()) pieces.push(current.trim());

  const out = [];
  for (const piece of pieces) {
    if (piece.length <= budget) {
      out.push(piece);
      continue;
    }
    let buffer = '';
    for (const word of piece.split(/\s+/)) {
      if (buffer && buffer.length + word.length + 1 > budget) {
        out.push(buffer);
        buffer = '';
      }
      buffer += (buffer ? ' ' : '') + word;
    }
    if (buffer) out.push(buffer);
  }
  return out;
}

// The chunks a turn is synthesised in, each guaranteed to tokenise inside the
// model's limit.
//
// `measure` is the caller's "how many tokens would this be", which is async
// because phonemising is. Sentences are packed greedily: joining short sentences
// into one run is not an optimisation, it is what stops a four-word answer being
// read with a pause after every clause.
async function splitFor(text, measure, max = MAX_TOKENS) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = '';

  const fits = async (piece) => {
    const count = await measure(piece);
    return { count, ok: count <= max };
  };

  for (const sentence of sentences) {
    const joined = current ? `${current} ${sentence}` : sentence;
    if ((await fits(joined)).ok) {
      current = joined;
      continue;
    }

    if (current) chunks.push(current);
    current = '';

    const alone = await fits(sentence);
    if (alone.ok) {
      current = sentence;
      continue;
    }

    // One sentence that will not fit on its own. Fall back to a character budget
    // scaled by how far over it went, then re-measure each piece.
    const budget = Math.max(40, Math.floor(sentence.length * (max / Math.max(alone.count, 1)) * 0.9));
    for (const piece of splitLong(sentence, budget)) {
      const measured = await fits(piece);
      if (measured.ok) {
        chunks.push(piece);
        continue;
      }
      // Still too long after word splitting: cut it hard rather than refuse.
      for (const slice of piece.match(new RegExp(`.{1,${budget}}`, 'gs')) || []) chunks.push(slice);
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  MAX_TOKENS,
  MAX_BODY_TOKENS,
  STYLE_ROWS,
  BOUNDARY,
  PUNCTUATION,
  normalize,
  segment,
  languageOf,
  repairPhonemes,
  toIds,
  styleOffset,
  splitSentences,
  splitLong,
  splitFor,
  saidAsNumber,
  saidAsMoney,
  saidAsDecimal,
  isAbbreviation,
};
