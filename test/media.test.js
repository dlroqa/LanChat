'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveMedia, MAX_MEDIA } = require('../src/main/media.js');

// The pictures a message is talking about.
//
// What is pinned here is mostly what does *not* resolve. A resolved path is one
// the preview endpoint will serve, so the list of things that get through has to
// be exactly the list of things somebody meant to show: a photo, a clip, a
// sound. Everything else a marker could name — a key, a password file, a
// directory, something that is not there at all — has to come back as the plain
// text it always was.

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, name, bytes = 8) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

test('a bare MEDIA line names a picture, and says so in the shape a file bubble reads', (t) => {
  const png = write(tmpdir(t), 'graph.png', 40);
  const { text, media } = resolveMedia(`Here is the graph.\n\nMEDIA:${png}\n`, { strip: true });

  assert.deepEqual(media, [{ name: 'graph.png', path: png, size: 40, mime: 'image/png' }]);
  assert.equal(text, 'Here is the graph.');
});

test('a markdown link to the same file is the same picture, named twice', (t) => {
  const png = write(tmpdir(t), 'graph.png');
  const text = `MEDIA:${png}\n\n[Download the full-size PNG graph](sandbox:${png})`;
  const out = resolveMedia(text, { strip: true });

  assert.equal(out.media.length, 1, 'one picture');
  assert.equal(out.media[0].path, png);
  // The link keeps its label and its target: the window has somewhere to put
  // both, and stripping it would delete words somebody wrote.
  assert.equal(out.text, '[Download the full-size PNG graph](sandbox:' + png + ')');
});

test('file:// targets are decoded, including the escapes a space arrives wearing', (t) => {
  const png = write(tmpdir(t), 'my graph.png');
  // Built the way the platform builds one, rather than by gluing a prefix onto a
  // path: on Windows a file URL is `file:///D:/…`, with the drive behind a third
  // slash and the separators turned round, and a hand-made `file://D:\…` is not
  // a URL at all. This is the spelling an agent on that machine would emit.
  const url = pathToFileURL(png).href;
  assert.ok(url.includes('%20'), 'the space really is escaped, or this proves nothing');

  const { media } = resolveMedia(`[see](${url})`);
  assert.equal(media.length, 1);
  assert.equal(media[0].path, png);
  assert.equal(media[0].name, 'my graph.png');
});

test('nothing that is not a photo, a clip or a sound resolves', (t) => {
  const dir = tmpdir(t);
  const refused = [
    write(dir, 'notes.txt'),
    write(dir, 'report.pdf'),
    write(dir, 'id_rsa'),
    write(dir, 'archive.zip'),
  ];
  fs.mkdirSync(path.join(dir, 'pictures'));

  for (const p of [...refused, path.join(dir, 'pictures'), path.join(dir, 'gone.png')]) {
    const { text, media } = resolveMedia(`MEDIA:${p}`, { strip: true });
    assert.deepEqual(media, [], p);
    // Refused means untouched: the marker is still the text it always was.
    assert.equal(text, `MEDIA:${p}`, p);
  }
});

test('a relative path is never a path', () => {
  for (const target of ['pictures/graph.png', './graph.png', '../graph.png', '~/graph.png']) {
    assert.deepEqual(resolveMedia(`MEDIA:${target}`).media, [], target);
    assert.deepEqual(resolveMedia(`[x](${target})`).media, [], target);
  }
});

test('a link to somewhere else is left for the link scanner', (t) => {
  const png = write(tmpdir(t), 'graph.png');
  for (const target of [
    `https://example.com/graph.png`,
    `javascript:alert(1)`,
    `data:image/png;base64,AAAA`,
  ]) {
    assert.deepEqual(resolveMedia(`[x](${target})`).media, [], target);
  }
  // …and the one that is ours still resolves, so the test above is not passing
  // because the scanner stopped working.
  assert.equal(resolveMedia(`[x](sandbox:${png})`).media.length, 1);
});

test('MEDIA in the middle of a sentence is a sentence', (t) => {
  const png = write(tmpdir(t), 'graph.png');
  const text = `I put the MEDIA:${png} marker in, as you asked.`;
  assert.deepEqual(resolveMedia(text, { strip: true }), { text, media: [] });
});

test('the same file named many ways is one picture, and the cap holds', (t) => {
  const dir = tmpdir(t);
  const png = write(dir, 'graph.png');
  const many = Array.from({ length: MAX_MEDIA + 4 }, (_, i) => write(dir, `shot${i}.png`));

  assert.equal(resolveMedia(`MEDIA:${png}\n[a](sandbox:${png})\n[b](file://${png})`).media.length, 1);
  assert.equal(resolveMedia(many.map((p) => `MEDIA:${p}`).join('\n')).media.length, MAX_MEDIA);
});

test('without strip, what was said is returned exactly as it was said', (t) => {
  const png = write(tmpdir(t), 'graph.png');
  const text = `look at this\n\nMEDIA:${png}\n\nand this  \n`;
  const out = resolveMedia(text, { strip: false });

  assert.equal(out.text, text, 'byte for byte');
  assert.equal(out.media.length, 1, 'and the picture is still found');
});

test('stripping a line does not leave the gap it was sitting in', (t) => {
  const dir = tmpdir(t);
  const a = write(dir, 'a.png');
  const b = write(dir, 'b.png');
  const { text } = resolveMedia(`one\n\nMEDIA:${a}\n\nMEDIA:${b}\n\ntwo\n`, { strip: true });

  assert.equal(text, 'one\n\ntwo');
});

test('a message with nothing in it is not a message with something in it', () => {
  for (const empty of ['', null, undefined]) {
    assert.deepEqual(resolveMedia(empty), { text: '', media: [] });
  }
});

// ---------------------------------------------------------- drawn in a browser
//
// Everything above is about what resolveMedia decides. None of it can answer the
// question the report actually asked — is the picture *there* — so that one is
// put to a real browser, with the real component and the real stylesheet. The
// same bubble is drawn twice: once with the list main attaches, once without it,
// which is the state every one of these messages used to be in.

const { runMediaHarness } = require('../scripts/media-harness.js');

let drawn = null;
const draw = () => (drawn = drawn || runMediaHarness());

test('drawn in a browser: the picture an agent named is on the screen', async () => {
  const result = await draw();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }
  const { live, control } = result;

  assert.ok(live.picture, 'the bubble draws a picture');
  assert.equal(
    live.picture.decoded,
    true,
    'and the browser really decoded it, rather than drawing a broken glyph'
  );
  assert.ok(live.picture.w > 0 && live.picture.h > 0, 'and it takes up room on the screen');
  assert.equal(
    live.picture.alt,
    'recent_worldwide_earthquakes_graph.png',
    'named, for anybody who cannot see it'
  );

  // The control is the bug, still reproducible on demand: the same words with
  // nothing attached draw no picture at all.
  assert.equal(control.picture, null);
});

test('drawn in a browser: the markdown link reads as words and points at the file', async () => {
  const result = await draw();
  if (result.skipped) return;
  const { live, control, opened, shot } = result;

  assert.ok(live.chip, 'the label is a link');
  assert.equal(live.chip.label, 'Download the full-size PNG graph', 'showing what somebody wrote');
  assert.equal(live.chip.title, shot, 'and saying where it goes');
  assert.ok(!live.text.includes(']('), 'the punctuation around it is not part of the message on screen');
  assert.ok(!live.text.includes('sandbox:'), 'and neither is the target');

  // Clicking it hands back the path from the message, which is the only place a
  // path can come from — see mediaPath() in lib/linkify.js.
  assert.ok(opened.includes(shot), 'clicking the label opens the file it named');

  // Without the list, the same text is what it always was: markdown, rendered
  // literally, with nothing to click.
  assert.equal(control.chip, null);
  assert.ok(control.text.includes(`[Download the full-size PNG graph](sandbox:${shot})`));
});

test('drawn in a browser: everything beside the picture says what it is', async () => {
  const result = await draw();
  if (result.skipped) return;
  const { live, revealed, shot } = result;

  // Icon-only buttons, so the only name they have is the one written on them.
  assert.deepEqual(
    live.buttons.map((b) => b.name),
    ['Open recent_worldwide_earthquakes_graph.png', 'Show recent_worldwide_earthquakes_graph.png in folder']
  );
  assert.ok(
    live.buttons.every((b) => b.tag === 'BUTTON' && b.focusable),
    'and both are real buttons a keyboard can reach'
  );
  assert.ok(revealed.includes(shot), 'the download button reveals the file it is beside');

  // A picture must not squeeze the words above it into a column. Measured rather
  // than looked at: this is exactly the sort of thing a screenshot flatters.
  assert.ok(live.bubble.w > 300, `the bubble is only ${live.bubble.w}px wide`);
});

test('drawn in a browser: a link to a picture is drawn as a clickable picture', async () => {
  const result = await draw();
  if (result.skipped) return;
  const { remoteBefore, remoteAfter, remoteDrawn, asked, saveRequests, linkRequests, remote } = result;

  assert.equal(remoteDrawn, true, 'the picture arrived once the bubble was scrolled to');
  assert.deepEqual(asked, [remote], 'main is asked for the bytes, once');
  assert.ok(remoteBefore.picture, 'and what comes back is drawn');
  assert.equal(remoteBefore.picture.decoded, true);
  assert.equal(remoteBefore.picture.alt, 'quakes.png', 'named after the thing it is');
  assert.deepEqual(
    remoteBefore.pictureButton,
    { name: 'Open quakes.png', tag: 'BUTTON', focusable: true },
    'and the picture itself is a keyboard-reachable control'
  );
  assert.deepEqual(linkRequests, [remote], 'clicking the picture opens its original HTTPS URL');
  assert.equal(remoteBefore.note, 'from the web', 'and honest about where it came from');

  // Drawing it must not cost anything the bubble already did.
  assert.equal(remoteBefore.link, remote, 'the link is still a link');
  assert.equal(remoteBefore.card, false, 'and no card repeats it underneath');

  // The button has two states and both have to say which one they are in.
  assert.equal(remoteBefore.button, 'Save quakes.png to downloads');
  assert.deepEqual(saveRequests, [remote], 'pressing it asks main to keep the picture');
  assert.equal(remoteAfter.button, 'Show quakes.png in folder', 'and then it points at where it went');
  assert.ok(remoteAfter.note.includes('saved'));
});
