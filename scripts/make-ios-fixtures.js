'use strict';

// Golden fixtures for the iOS port.
//
// The Swift rewrite has to reproduce a pile of small, exact behaviours: a
// transcript byte layout, a cron walker, the rule that decides whether a turn is
// empty. Writing Swift tests from the JavaScript by reading it is a
// re-derivation, and a re-derivation makes the same mistakes twice — it agrees
// with what the reader thought the code said. So the vectors are *extracted* by
// running the shipping modules and recording what they actually answer. The
// Swift suite then asserts against that, which makes it a conformance suite
// against the desktop rather than a second opinion about it.
//
// This is a script and not a one-off dump because the desktop keeps moving.
// Re-run it whenever a ported module changes; a diff in `ios/.../Fixtures` is
// then the review question "did we mean to change the wire?", asked at the
// moment it can still be answered.
//
// Read-only with respect to `src/`. Nothing here imports Electron, opens a
// socket, or touches the user's config.

// The clock has to be pinned before anything reads it. cron.js works in local
// time (a daily 09:00 means nine in the morning where you are, not UTC), so the
// fixture is meaningless without saying which local. New York is chosen because
// its DST transitions are the two edges worth testing and because it is not the
// zone this file was written in — a fixture that only passes in the author's
// timezone is the bug this line exists to prevent.
process.env.TZ = 'America/New_York';
const TZ = process.env.TZ;

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const RENDERER = path.join(SRC, 'renderer');
const OUT = path.join(ROOT, 'ios', 'LanChatiOS', 'Packages', 'LanChatKit', 'Tests', 'Fixtures');

// --------------------------------------------------------------- loading

// The renderer is ESM for the browser and this is a CommonJS script, so the
// `export` markers come off and the source is evaluated as a function body —
// the same trick test/sidebarSections.test.js and test/agentVoice.test.js use.
// Several modules are loaded together where one imports another; the `import`
// lines come off with the exports and the dependency is simply prepended.
function loadRenderer(files, names) {
  const body = files
    .map((f) => fs.readFileSync(path.join(RENDERER, 'lib', `${f}.js`), 'utf8'))
    .join('\n')
    .replace(/^import[^;]+;$/gm, '')
    .replace(/^export\s+/gm, '');
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

const written = [];

function writeFixture(name, note, cases) {
  const body = {
    // No timestamp and no git revision: a fixture that changes every time it is
    // generated cannot be reviewed by diff, which is the only way anybody is
    // ever going to notice that the wire moved.
    _: {
      generator: 'scripts/make-ios-fixtures.js',
      note,
      tz: TZ,
    },
    ...cases,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(body, null, 2)}\n`);
  written.push(name);
}

// Deterministic stand-ins for things that are random in the running app. Fixed
// byte patterns rather than recorded randomness, so a reader can see at a glance
// that nonce S is all 0x11 and nonce C is all 0x22 and check the hex by eye.
const fill = (byte) => Buffer.alloc(32, byte);

// ------------------------------------------------------- auth transcripts

function authTranscripts() {
  const proto = require(path.join(SRC, 'main', 'authProto.js'));

  const nonceS = proto.b64u(fill(0x11));
  const nonceC = proto.b64u(fill(0x22));
  const kxS = proto.b64u(fill(0x33));
  const kxC = proto.b64u(fill(0x44));

  // Ed25519 signing is deterministic (RFC 8032), so a fixed seed gives a fixed
  // signature and the whole vector is reproducible in Swift.
  const seedS = proto.b64u(fill(0x51));
  const seedC = proto.b64u(fill(0x43));
  const keyS = proto.signingPublicFrom(seedS);
  const keyC = proto.signingPublicFrom(seedC);

  const idS = 'ca24b2fe-0000-4000-8000-000000000001';
  const idC = 'ca24b2fe-0000-4000-8000-000000000002';

  const shared = { proto: String(proto.PROTO), nonceS, nonceC, keyS, keyC, kxS, kxC, idS, idC };

  const roles = [
    { role: 'server', byte: proto.ROLE_SERVER, seed: seedS, key: keyS },
    { role: 'client', byte: proto.ROLE_CLIENT, seed: seedC, key: keyC },
  ].map(({ role, byte, seed, key }) => {
    const buf = proto.transcript({ ...shared, role: byte });
    const sig = proto.sign(seed, buf);
    return {
      role,
      roleByte: byte,
      transcriptHex: buf.toString('hex'),
      transcriptBytes: buf.length,
      // Standard base64, WITH padding — unlike every key and nonce above, which
      // are base64url without it. This asymmetry is the single most likely
      // thing to be got wrong in a rewrite, so both encodings appear in one
      // fixture where they can be compared.
      signatureBase64: sig,
      signerPublicKeyB64u: key,
      verifies: proto.verify(key, buf, sig),
      // The same signature against the other party's key must fail, which is
      // what makes the role byte load-bearing rather than decorative.
      verifiesUnderOtherKey: proto.verify(key === keyS ? keyC : keyS, buf, sig),
    };
  });

  return {
    constants: {
      PROTO: proto.PROTO,
      DOMAIN: proto.DOMAIN,
      ROLE_SERVER: proto.ROLE_SERVER,
      ROLE_CLIENT: proto.ROLE_CLIENT,
      KEY_BYTES: proto.KEY_BYTES,
      NONCE_BYTES: proto.NONCE_BYTES,
      SIG_BYTES: proto.SIG_BYTES,
    },
    inputs: shared,
    seeds: { server: seedS, client: seedC },
    transcripts: roles,
    fingerprints: [keyS, keyC].map((key) => ({ key, fingerprint: proto.fingerprint(key) })),
    // fromB64u is the gate every field on the wire passes through, and it is
    // strict on purpose: padding is rejected, the alphabet is url-safe only,
    // and the decoded length has to be exactly what was asked for.
    fromB64u: [
      { input: proto.b64u(fill(0x11)), want: 32, ok: true },
      { input: `${proto.b64u(fill(0x11))}=`, want: 32, ok: false, why: 'padding rejected' },
      { input: Buffer.alloc(32, 0x11).toString('base64'), want: 32, ok: false, why: 'standard alphabet' },
      { input: proto.b64u(Buffer.alloc(31, 0x11)), want: 32, ok: false, why: 'short' },
      { input: proto.b64u(Buffer.alloc(33, 0x11)), want: 32, ok: false, why: 'long' },
      { input: '', want: 32, ok: false, why: 'empty' },
      { input: 'a'.repeat(513), want: 32, ok: false, why: 'over the 512-char ceiling' },
    ].map((c) => ({ ...c, decoded: Boolean(proto.fromB64u(c.input, c.want)) })),
  };
}

// -------------------------------------------------------- handshake reject

function handshakeReject() {
  const proto = require(path.join(SRC, 'main', 'authProto.js'));
  const hs = require(path.join(SRC, 'main', 'handshake.js'));

  const key = proto.signingPublicFrom(proto.b64u(fill(0x51)));
  const nonce = proto.b64u(fill(0x11));
  const kx = proto.b64u(fill(0x33));
  const id = 'ca24b2fe-0000-4000-8000-000000000001';

  const good = () => ({
    type: 'hello',
    proto: proto.PROTO,
    from: id,
    identity: { id, publicKey: key, name: 'Ada', servicePort: 47100 },
    auth: { nonce, key, kx },
  });

  const mutate = (why, fn, needSig = false) => {
    const msg = good();
    fn(msg);
    return { why, needSig, accepted: hs.parseHello(msg, { needSig }) !== null, message: msg };
  };

  return {
    wire: {
      // The only reason that ever goes out. Everything else stays local, so a
      // stranger cannot tell a version mismatch from a changed key.
      WIRE_REASON: hs.WIRE_REASON,
      WIRE_CLOSE_CODE: hs.WIRE_CLOSE_CODE,
    },
    localReasons: {
      OLDER_LANCHAT: hs.OLDER_LANCHAT,
      BAD_HELLO: hs.BAD_HELLO,
      BAD_SIGNATURE: hs.BAD_SIGNATURE,
      KEY_CHANGED: hs.KEY_CHANGED,
      ID_IN_USE: hs.ID_IN_USE,
      TIMED_OUT: hs.TIMED_OUT,
    },
    refusalForWire: [hs.BAD_HELLO, hs.KEY_CHANGED, hs.TIMED_OUT].map((reason) => ({
      reason,
      wire: hs.refusalForWire(reason),
    })),
    looksLikeOldBuild: [
      { msg: { type: 'hello', from: 'x' }, old: hs.looksLikeOldBuild({ type: 'hello', from: 'x' }) },
      { msg: good(), old: hs.looksLikeOldBuild(good()) },
    ],
    parseHello: [
      mutate('a well-formed hello', () => {}),
      mutate(
        'a well-formed hello, signature required and present',
        (m) => {
          m.auth.sig = 'AA==';
        },
        true
      ),
      mutate('signature required and absent', () => {}, true),
      mutate('proto 1', (m) => {
        m.proto = 1;
      }),
      mutate('proto as a string', (m) => {
        m.proto = '2';
      }),
      mutate('no from', (m) => {
        m.from = '';
      }),
      mutate('from over 256 chars', (m) => {
        m.from = 'a'.repeat(257);
        m.identity.id = m.from;
      }),
      mutate('nonce is 31 bytes', (m) => {
        m.auth.nonce = proto.b64u(Buffer.alloc(31, 0x11));
      }),
      mutate('key is padded base64', (m) => {
        m.auth.key = Buffer.alloc(32, 0x11).toString('base64');
        m.identity.publicKey = m.auth.key;
      }),
      mutate('no kx', (m) => {
        delete m.auth.kx;
      }),
      mutate('identity.id disagrees with from', (m) => {
        m.identity.id = 'somebody-else';
      }),
      mutate('identity.publicKey disagrees with auth.key', (m) => {
        m.identity.publicKey = proto.b64u(fill(0x99));
      }),
      mutate('no identity at all', (m) => {
        delete m.identity;
      }),
      mutate('no auth at all', (m) => {
        delete m.auth;
      }),
    ],
  };
}

// -------------------------------------------------------------- cron walker

function cronNextDue() {
  const cron = require(path.join(SRC, 'main', 'tasks', 'cron.js'));

  const iso = (ms) => new Date(ms).toISOString();
  const local = (ms) => new Date(ms).toString();

  const from = Date.parse('2026-03-06T12:00:00Z');

  const walk = (why, spec, fromMs = from, count = 4) => {
    const runs = cron.nextRuns(spec, fromMs, count);
    return {
      why,
      spec,
      from: iso(fromMs),
      describes: cron.describeSchedule(spec),
      runs: runs === null ? null : runs.map((ms) => ({ ms, iso: iso(ms), local: local(ms) })),
    };
  };

  return {
    parseCron: [
      '0 9 * * 1-5',
      '*/15 * * * *',
      '0 0 1 1 *',
      '30 6 * * 0',
      '0 9 31 2 *',
      'not a cron',
      '* * * *',
      '60 * * * *',
    ].map((expr) => ({ expr, parsed: cron.parseCron(expr) !== null })),

    presets: ['hourly', 'daily', 'weekly'].map((preset) => ({
      preset,
      expr: cron.presetExpr(preset, { hour: 9, minute: 30, weekday: 1 }),
    })),

    schedules: [
      walk('a weekday cron across the US DST start', { kind: 'cron', expr: '0 9 * * 1-5' }),
      walk('every quarter hour', { kind: 'cron', expr: '*/15 * * * *' }),
      walk('a daily preset', { kind: 'every', preset: 'daily', hour: 9, minute: 0 }),
      walk('an hourly preset', { kind: 'every', preset: 'hourly', hour: 0, minute: 15 }),
      walk('a weekly preset on Mondays', {
        kind: 'every',
        preset: 'weekly',
        hour: 9,
        minute: 0,
        weekday: 1,
      }),
      walk('a one-off still to come', { kind: 'once', at: from + 3600_000 }),
      walk('a one-off already past — never comes round', { kind: 'once', at: from - 3600_000 }),
      walk('a cron that can never match', { kind: 'cron', expr: '0 9 30 2 *' }),

      // The two edges. On 8 March 2026 New York skips 02:00–03:00; on
      // 1 November 2026 it runs 01:00–02:00 twice. A daily 02:30 has no
      // instant to land on in spring, and a daily 01:30 has two in autumn —
      // the walker steps strictly after the minute it starts in, which is what
      // stops the repeated hour firing twice.
      walk(
        'DST spring forward — a daily 02:30 the day the hour disappears',
        { kind: 'every', preset: 'daily', hour: 2, minute: 30 },
        Date.parse('2026-03-07T12:00:00Z'),
        3
      ),
      walk(
        'DST fall back — a daily 01:30 the day the hour repeats',
        { kind: 'every', preset: 'daily', hour: 1, minute: 30 },
        Date.parse('2026-10-31T12:00:00Z'),
        3
      ),
      walk(
        'DST fall back — an hourly schedule through the doubled hour',
        { kind: 'cron', expr: '30 * * * *' },
        Date.parse('2026-11-01T04:00:00Z'),
        5
      ),
    ],
  };
}

// -------------------------------------------------------------- empty turns

function emptyTurns() {
  const { isEmptyBody, isEmptyTurn, findEmptyTurns } = loadRenderer(
    ['emptyTurn'],
    ['isEmptyBody', 'isEmptyTurn', 'findEmptyTurns']
  );

  const bodies = [
    'NOTHING',
    'nothing further.',
    'Nothing Further',
    '"NOTHING."',
    "'nothing'",
    'NOTHING!',
    '  nothing further.  ',
    '— nothing further.',
    '- nothing further',
    '\n\nNOTHING\n\n',
    // The half that matters is the half that says no.
    'I agree with Mac, and I have nothing further.',
    'Here is the answer.\n\nnothing further.',
    'nothing further. But one more thing:',
    'NOTHING is going to work here.',
    'nothing',
    '',
    '   ',
  ];

  const turn = (extra) => ({
    id: 'm1',
    direction: 'in',
    kind: 'text',
    text: 'NOTHING',
    agentId: 'agent:mac',
    speaker: 'Mac',
    ...extra,
  });

  const turns = [
    { why: 'an agent saying nothing, in a session', msg: turn({}), isSession: true },
    { why: 'the same turn outside a session', msg: turn({}), isSession: false },
    { why: 'our own words', msg: turn({ direction: 'out' }), isSession: true },
    // agentId is stamped on the host's copy of an agent's answer and speakerId
    // on a guest's; a person in the room has neither, which is what lets
    // somebody type "nothing further." and keep their words.
    {
      why: 'a person in a room — neither agentId nor speakerId',
      msg: turn({ agentId: undefined, speakerId: undefined }),
      isSession: true,
    },
    {
      why: "a guest's copy of an agent's answer, marked by speakerId",
      msg: turn({ agentId: undefined, speakerId: 'agent:mac' }),
      isSession: true,
    },
    { why: 'a notice', msg: turn({ notice: true }), isSession: true },
    { why: 'an error', msg: turn({ error: true }), isSession: true },
    { why: 'imported history is never erased', msg: turn({ imported: true }), isSession: true },
    { why: 'a file', msg: turn({ kind: 'file' }), isSession: true },
  ];

  const thread = [
    turn({ id: 'a', text: 'A real answer.' }),
    turn({ id: 'b', text: 'NOTHING' }),
    turn({ id: 'c', text: 'nothing further.' }),
    turn({ id: 'd', text: 'An answer that ends on it.\nnothing further.' }),
    turn({ id: 'e', text: 'NOTHING', direction: 'out' }),
  ];

  return {
    isEmptyBody: bodies.map((text) => ({ text, empty: isEmptyBody(text) })),
    isEmptyTurn: turns.map((t) => ({ ...t, empty: isEmptyTurn(t.msg, { isSession: t.isSession }) })),
    findEmptyTurns: {
      thread: thread.map((m) => ({ id: m.id, text: m.text, direction: m.direction })),
      inSession: findEmptyTurns(thread, { isSession: true }).map((m) => m.id),
      outsideSession: findEmptyTurns(thread, { isSession: false }).map((m) => m.id),
    },
  };
}

// ------------------------------------------------------------- kokoro text

function kokoroText() {
  const k = require(path.join(SRC, 'main', 'tts', 'kokoroText.js'));

  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} goes here.`).join(' ');

  return {
    constants: {
      MAX_TOKENS: k.MAX_TOKENS,
      MAX_BODY_TOKENS: k.MAX_BODY_TOKENS,
      STYLE_ROWS: k.STYLE_ROWS,
      BOUNDARY: k.BOUNDARY,
      PUNCTUATION: k.PUNCTUATION,
    },
    normalize: [
      'It was 1985.',
      'That will be $4.50, please.',
      'Dr. Chandra will see you at 9:30.',
      'Pi is about 3.14 and e is 2.718.',
      'The meeting is at 14:05 on 2019-03-01.',
      'Mr. and Mrs. Smith vs. the St. Louis Co.',
      '1,234,567 items at $0.99 each.',
      'Chapter 12, section 3.4, page 100.',
    ].map((raw) => ({ raw, normalized: k.normalize(raw) })),

    saidAsNumber: ['1985', '2026', '9:30', '14:05', '3.14', '0', '7', '100', '1234'].map((raw) => ({
      raw,
      said: k.saidAsNumber(raw),
    })),
    saidAsMoney: ['$4.50', '$1', '$0.99', '$1,000', '$12.00'].map((raw) => ({
      raw,
      said: k.saidAsMoney(raw),
    })),
    saidAsDecimal: ['3.14', '0.5', '2.718', '10.0'].map((raw) => ({
      raw,
      said: k.saidAsDecimal(raw),
    })),
    isAbbreviation: ['Dr', 'Mr', 'Mrs', 'St', 'vs', 'Co', 'Inc', 'Hello', 'a'].map((word) => ({
      word,
      abbreviation: k.isAbbreviation(word),
    })),

    languageOf: ['af_bella', 'am_fenrir', 'bf_emma', 'bm_george', 'af_heart', 'zz_unknown'].map((voice) => ({
      voice,
      language: k.languageOf(voice),
    })),

    // The repairs look arbitrary and are not: each exists because the model
    // mispronounces something without it, so they are pinned verbatim.
    repairPhonemes: [
      { phonemes: 'həlˈəʊ wˈɜːld', language: 'a' },
      { phonemes: 'həlˈəʊ wˈɜːld', language: 'b' },
      { phonemes: 'ˈkɜːnəl', language: 'a' },
      { phonemes: 'ðə kwˈɪk bɹˈaʊn fˈɒks', language: 'b' },
    ].map(({ phonemes, language }) => ({
      phonemes,
      language,
      repaired: k.repairPhonemes(phonemes, language),
    })),

    segment: ['Hello, world! How are you?', 'One. Two! Three?', 'No punctuation here'].map((text) => ({
      text,
      segments: k.segment(text),
    })),

    // Clamped to STYLE_ROWS - 1, not to MAX_BODY_TOKENS. The two are easy to
    // confuse and the difference is silent — it sounds like the voice hurrying
    // the end of a long sentence rather than like a bug.
    styleOffset: [0, 1, 100, 508, 509, 510, 511, 1000].map((tokenCount) => ({
      tokenCount,
      offset: k.styleOffset(tokenCount),
    })),

    splitSentences: [
      'One sentence.',
      'One. Two. Three.',
      'Dr. Chandra went to St. Louis. Then he left.',
      'A question? An exclamation! A statement.',
    ].map((text) => ({ text, sentences: k.splitSentences(text) })),

    splitLong: [
      { text: long, budget: 80 },
      { text: 'A short one.', budget: 80 },
    ].map(({ text, budget }) => ({ text, budget, chunks: k.splitLong(text, budget) })),

    splitFor: { measure: 'string length', cases: null },
    _splitForAsync: { text: long, max: 120 },
  };
}

// splitFor takes the caller's "how many tokens would this be", which is async
// because phonemising is — so this half of the Kokoro fixture is too. The real
// measure needs the model; the stub below has the same shape, so what gets
// pinned is the greedy packing, which is the part Swift has to reproduce,
// rather than the tokeniser, which it does not.
async function kokoroSplitFor(body) {
  const k = require(path.join(SRC, 'main', 'tts', 'kokoroText.js'));
  const measure = async (s) => s.length;
  const { text, max } = body._splitForAsync;
  const cases = [];
  for (const m of [60, 120, 4000]) {
    cases.push({ max: m, chunks: await k.splitFor(text, measure, m) });
  }
  delete body._splitForAsync;
  body.splitFor = { measure: 'string length (stub — the real one phonemises)', text, max, cases };
  return body;
}

// ------------------------------------------------------------ call signals

function signalShapes() {
  const { serializeCandidate, serializeDescription, isCloneable } = loadRenderer(
    ['signal'],
    ['serializeCandidate', 'serializeDescription', 'isCloneable']
  );

  const candidate = {
    candidate: 'candidate:1 1 udp 2130706431 100.83.12.4 47100 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'abcd',
    // Anything else on a real RTCIceCandidate must not survive: the shape on
    // the wire is exactly four fields.
    protocol: 'udp',
    address: '100.83.12.4',
  };

  return {
    serializeCandidate: [
      { why: 'a host candidate on the tailnet', input: candidate, out: serializeCandidate(candidate) },
      {
        why: 'missing optional fields',
        input: { candidate: 'x' },
        out: serializeCandidate({ candidate: 'x' }),
      },
      { why: 'null', input: null, out: serializeCandidate(null) },
    ],
    serializeDescription: [
      {
        input: { type: 'offer', sdp: 'v=0\r\n', extra: 1 },
        out: serializeDescription({ type: 'offer', sdp: 'v=0\r\n', extra: 1 }),
      },
      {
        input: { type: 'answer', sdp: 'v=0\r\n' },
        out: serializeDescription({ type: 'answer', sdp: 'v=0\r\n' }),
      },
      { input: null, out: serializeDescription(null) },
    ],
    isCloneable: [
      { input: { a: 1 }, ok: isCloneable({ a: 1 }) },
      { input: 'a string', ok: isCloneable('a string') },
      { input: [1, 2, 3], ok: isCloneable([1, 2, 3]) },
    ],
  };
}

function glare() {
  const { shouldOffer, reconcileRoster } = loadRenderer(
    ['signal', 'groupCall'],
    ['shouldOffer', 'reconcileRoster']
  );

  const ids = ['a', 'b', 'z', 'A', 'Z', '0', '100.83.12.4', 'ca24b2fe-0000', 'ca24b2fe-0001'];
  const pairs = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [x, y] = [ids[i], ids[j]];
      pairs.push({
        a: x,
        b: y,
        aOffers: shouldOffer(x, y),
        bOffers: shouldOffer(y, x),
        // Exactly one of a pair offers, always. Both offering means no call.
        exactlyOne: shouldOffer(x, y) !== shouldOffer(y, x),
      });
    }
  }

  const roster = (why, current, next, selfId) => ({
    why,
    current,
    next,
    selfId,
    ...reconcileRoster(current, next, selfId),
  });

  return {
    shouldOffer: pairs,
    selfPair: { a: 'a', b: 'a', aOffers: shouldOffer('a', 'a') },
    reconcileRoster: [
      roster('somebody joins', ['a', 'b'], ['a', 'b', 'c'], 'me'),
      roster('somebody leaves', ['a', 'b', 'c'], ['a', 'c'], 'me'),
      roster('self is never counted', ['a'], ['a', 'me'], 'me'),
      roster('no change', ['a', 'b'], ['a', 'b'], 'me'),
    ],
  };
}

// ------------------------------------------------------------ dial backoff

function dialBackoff() {
  // The constants live inside a closure in discovery.js and are not exported,
  // so they are read out of the source. That is only safe if the formula is
  // still the one this fixture describes — hence the guard. If discovery.js
  // changes shape, generation fails loudly instead of quietly emitting a
  // schedule nobody implements any more.
  const src = fs.readFileSync(path.join(SRC, 'main', 'discovery.js'), 'utf8');
  const base = /const BACKOFF_BASE_MS = (\d+);/.exec(src);
  const max = /const BACKOFF_MAX_MS = ([\d *]+);/.exec(src);
  const formula = src.includes('Math.min(BACKOFF_BASE_MS * 2 ** (entry.failures - 1), BACKOFF_MAX_MS)');
  if (!base || !max || !formula) {
    throw new Error(
      'discovery.js no longer matches the backoff shape this fixture describes — ' +
        'read src/main/discovery.js and update scripts/make-ios-fixtures.js'
    );
  }

  const BASE = Number(base[1]);
  const MAX = max[1].split('*').reduce((a, b) => a * Number(b.trim()), 1);

  return {
    constants: { BACKOFF_BASE_MS: BASE, BACKOFF_MAX_MS: MAX },
    note: 'keyed on "ip:port"; cleared outright by a successful peer-hello',
    schedule: Array.from({ length: 12 }, (_, i) => {
      const failures = i + 1;
      return { failures, waitMs: Math.min(BASE * 2 ** (failures - 1), MAX) };
    }),
  };
}

// -------------------------------------------------------- renderer logic

function linkify() {
  const {
    linkify: run,
    hasLink,
    firstLink,
    isImageUrl,
    safeHref,
  } = loadRenderer(['linkify'], ['linkify', 'hasLink', 'firstLink', 'isImageUrl', 'safeHref']);

  const texts = [
    'no links here',
    'see https://example.com for details',
    'a markdown [write-up](https://example.com/post) inline',
    'a picture https://example.com/chart.png in a message',
    'two https://a.example.com and https://b.example.com links',
    'trailing punctuation https://example.com.',
    'in parens (https://example.com)',
    'javascript:alert(1) is not a link',
    'ftp://example.com/file is not one either',
  ];

  return {
    linkify: texts.map((text) => ({ text, runs: run(text) })),
    hasLink: texts.map((text) => ({ text, has: hasLink(text) })),
    firstLink: texts.map((text) => ({ text, first: firstLink(text) })),
    isImageUrl: [
      'https://example.com/a.png',
      'https://example.com/a.jpg',
      'https://example.com/a.JPEG',
      'https://example.com/a.gif?x=1',
      'https://example.com/a.svg',
      'https://example.com/a.html',
      'https://example.com/a',
    ].map((href) => ({ href, image: isImageUrl(href) })),
    safeHref: [
      'https://example.com',
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'ftp://example.com',
    ].map((raw) => ({ raw, safe: safeHref(raw) })),
    // A file run only ever comes from main-vouched media, never parsed out of
    // text — a path a peer types stays exactly what they typed.
    withMedia: {
      text: 'the chart is at /home/ada/chart.png',
      media: [{ path: '/home/ada/chart.png', name: 'chart.png' }],
      runs: run('the chart is at /home/ada/chart.png', [{ path: '/home/ada/chart.png', name: 'chart.png' }]),
    },
  };
}

function findInThread() {
  const { matchRanges, searchableFields, countHits, fieldHits, threadHits, sliceRuns } = loadRenderer(
    ['findInThread'],
    ['matchRanges', 'searchableFields', 'countHits', 'fieldHits', 'threadHits', 'sliceRuns']
  );

  const messages = [
    { id: 'a', kind: 'text', text: 'the relay carries the discussion' },
    { id: 'b', kind: 'text', text: 'RELAY again, and relay once more' },
    { id: 'c', kind: 'file', file: { name: 'relay-notes.md' } },
    { id: 'd', kind: 'text', text: 'nothing to see', docs: [{ name: 'relay.pdf' }] },
    { id: 'e', kind: 'text', text: 'quoted', context: { text: 'the relay again', speaker: 'Mac' } },
  ];

  return {
    matchRanges: [
      { text: 'relay relay relay', query: 'relay' },
      { text: 'RELAY relay', query: 'relay' },
      { text: 'no match', query: 'relay' },
      { text: 'aaa', query: 'aa' },
      { text: 'anything', query: '' },
    ].map(({ text, query }) => ({ text, query, ranges: matchRanges(text, query) })),

    searchableFields: messages.map((msg) => ({ id: msg.id, fields: searchableFields(msg) })),
    countHits: messages.map((msg) => ({ id: msg.id, hits: countHits(msg, 'relay') })),
    fieldHits: messages.map((msg) => ({ id: msg.id, hits: fieldHits(msg, 'relay', 0) })),
    threadHits: {
      query: 'relay',
      messages: messages.map((m) => m.id),
      ...threadHits(messages, 'relay'),
    },
    sliceRuns: [
      {
        runs: [{ kind: 'text', text: 'the relay carries' }],
        ranges: matchRanges('the relay carries', 'relay'),
        base: 0,
      },
    ].map(({ runs, ranges, base }) => ({ runs, ranges, base, out: sliceRuns(runs, ranges, base) })),
  };
}

function sessionFolders() {
  const { folderOf, filedIds, folderSessions, looseSessions, dropIndex, moveFolder, isNoopPlace } =
    loadRenderer(
      ['sessionFolders'],
      ['folderOf', 'filedIds', 'folderSessions', 'looseSessions', 'dropIndex', 'moveFolder', 'isNoopPlace']
    );

  const folders = [
    // `session:gone` is in the folder but not in the session list — a trashed
    // session, which is not gone but somewhere else. Its id stays in place so
    // restoring puts it back in exactly this slot.
    { id: 'folder:1', name: 'Design', sessionIds: ['session:a', 'session:gone', 'session:b'] },
    { id: 'folder:2', name: 'Ops', sessionIds: ['session:c'] },
  ];
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((s) => ({
    id: `session:${s}`,
    title: s.toUpperCase(),
  }));
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return {
    folders,
    sessions: sessions.map((s) => s.id),
    folderOf: sessions.map((s) => ({ id: s.id, folder: (folderOf(folders, s.id) || {}).id || null })),
    filedIds: filedIds(folders),
    folderSessions: folders.map((f) => ({
      folder: f.id,
      sessions: folderSessions(f, byId).map((s) => s.id),
    })),
    // A trashed session vanishes from the list while its id stays in place in
    // the folder, which is what lets restoring put it back in its exact slot.
    looseSessions: looseSessions(sessions, folders).map((s) => s.id),
    dropIndex: [
      { ids: ['a', 'b', 'c'], moving: 'a', over: 'c', before: false },
      { ids: ['a', 'b', 'c'], moving: 'a', over: 'c', before: true },
      { ids: ['a', 'b', 'c'], moving: 'c', over: 'a', before: true },
      { ids: ['a', 'b', 'c'], moving: 'b', over: 'b', before: true },
    ].map((c) => ({ ...c, index: dropIndex(c.ids, c.moving, c.over, c.before) })),
    moveFolder: [0, 1, 2, -1].map((toIndex) => ({
      toIndex,
      order: moveFolder(folders, 'folder:2', toIndex).map((f) => f.id),
    })),
    isNoopPlace: [
      { sessionId: 'session:a', folderId: 'folder:1', index: 0 },
      { sessionId: 'session:a', folderId: 'folder:1', index: 1 },
      { sessionId: 'session:a', folderId: 'folder:2', index: 0 },
      { sessionId: 'session:d', folderId: null, index: 0 },
    ].map((c) => ({ ...c, noop: isNoopPlace(folders, c.sessionId, c.folderId, c.index) })),
  };
}

function agentRings() {
  const {
    AGENT_HUES,
    VOICES,
    USER_VOICE,
    colorOf,
    paletteFor,
    ringFor,
    slotFor,
    voiceOf,
    voicesFor,
    voiceForTurn,
    ringVoices,
  } = loadRenderer(
    ['agentColor', 'agentVoice'],
    [
      'AGENT_HUES',
      'VOICES',
      'USER_VOICE',
      'colorOf',
      'paletteFor',
      'ringFor',
      'slotFor',
      'voiceOf',
      'voicesFor',
      'voiceForTurn',
      'ringVoices',
    ]
  );

  const ids = [
    'agent:ca24b2fe-0000-4000-8000-000000000001',
    'agent:ca24b2fe-0000-4000-8000-000000000002',
    'agent:ca24b2fe-0000-4000-8000-000000000003',
    'agent:ca24b2fe-0000-4000-8000-000000000004',
    'remote-agent:peer1:agent:zima',
    'agent:zima',
  ];

  return {
    AGENT_HUES,
    VOICES,
    USER_VOICE,
    // The invariant that makes the two rings one idea: an agent's voice slot is
    // its colour slot, which holds only while the rings are the same length.
    ringLengthsAgree: AGENT_HUES.length === VOICES.length,
    slotFor: ids.map((id) => ({ id, slot: slotFor(id, AGENT_HUES.length) })),
    colorOf: ids.map((id) => ({ id, color: colorOf(id) })),
    voiceOf: ids.map((id) => ({ id, voice: voiceOf(id) })),
    slotsMatch: ids.map((id) => ({
      id,
      colourSlot: AGENT_HUES.indexOf(colorOf(id)),
      voiceSlot: VOICES.indexOf(voiceOf(id)),
    })),
    // Order-independent: the ring is dealt from sorted ids, so the same cast
    // gets the same colours however it was assembled.
    paletteFor: [ids.slice(0, 4), [...ids.slice(0, 4)].reverse()].map((cast) => ({
      cast,
      palette: paletteFor(cast),
    })),
    ringFor: [{ cast: ids.slice(0, 4), ring: AGENT_HUES }].map(({ cast, ring }) => ({
      cast,
      out: ringFor(cast, ring),
    })),
    voicesFor: [ids.slice(0, 4), [...ids.slice(0, 4)].reverse()].map((cast) => ({
      cast,
      voices: voicesFor(cast),
    })),
    // The user's voice is held out of the cast, so you never sound like a
    // participant.
    ringVoices: [ids.slice(0, 3)].map((cast) => ({ cast, dealt: ringVoices(cast, VOICES) })),
    voiceForTurn: [
      { turn: { agentId: ids[0], mine: false } },
      { turn: { agentId: null, mine: true } },
      { turn: { agentId: 'agent:never-seen', mine: false } },
    ].map(({ turn }) => ({
      turn,
      voice: voiceForTurn(turn, voicesFor(ids.slice(0, 4)), VOICES, USER_VOICE),
    })),
  };
}

// ------------------------------------------------------------------- main

async function main() {
  writeFixture(
    'auth-transcripts.json',
    'the signed transcript, byte for byte, plus the base64url/base64 split',
    authTranscripts()
  );
  writeFixture(
    'handshake-reject.json',
    'every malformed hello and what parseHello does with it',
    handshakeReject()
  );
  writeFixture('cron-nextdue.json', `next-due tables in ${TZ}, including both DST edges`, cronNextDue());
  writeFixture('empty-turn.json', 'which turns may be erased — and, mostly, which may not', emptyTurns());
  writeFixture(
    'kokoro-text.json',
    'everything between what an agent said and what the model is fed, short of the phonemiser',
    await kokoroSplitFor(kokoroText())
  );
  writeFixture('signal-shapes.json', 'the SDP and ICE candidate shapes on the wire', signalShapes());
  writeFixture('glare.json', 'who offers in a group call, over every unordered pair', glare());
  writeFixture('dial-backoff.json', 'the doubling schedule, read out of discovery.js', dialBackoff());
  writeFixture('linkify.json', 'typed runs, safe hrefs, and image links', linkify());
  writeFixture('find-in-thread.json', 'hit ordinals across every searchable field', findInThread());
  writeFixture(
    'session-folders.json',
    'folder membership, drop indices and no-op placement',
    sessionFolders()
  );
  writeFixture('agent-rings.json', 'the colour and voice rings, and the slot invariant', agentRings());

  process.stdout.write(`${written.length} fixtures written to ${path.relative(ROOT, OUT)}\n`);
  for (const name of written) process.stdout.write(`  ${name}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
