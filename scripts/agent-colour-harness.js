'use strict';

// The agent colours, as a browser actually paints them.
//
// test/agentColor.test.js computes what the contrast *should* be from the hex in
// agentColor.js and the percentages in styles.css. That is the right check for
// the palette, and it is not a check on the window: it assumes `color-mix(in
// srgb, …)` resolves the way the arithmetic says, that `--agent-color` set on a
// row actually reaches the fill, the edge and the name, and that nothing further
// down the stylesheet wins over any of it.
//
// This is that assumption tested rather than trusted. Four agents in one
// discussion, mounted for real, and the numbers read back off getComputedStyle
// and off the pixels of a screenshot — so a rule that never applies, a variable
// that never inherits, or a fill quietly overridden by a later selector shows up
// as a colour that is not the one the palette chose.
//
//   node scripts/agent-colour-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');
const { readPng } = require('./lib/png.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1180, height: 760, budget: 8000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatPane from ${JSON.stringify(path.join(SRC, 'components', 'ChatPane.jsx'))};
import { paletteFor } from ${JSON.stringify(path.join(SRC, 'lib', 'agentColor.js'))};
window.__lanchat = { React, createRoot, ChatPane, paletteFor };
`;
}

function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
  fs.writeFileSync(entryFile, entry());
  esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    outfile: outFile,
    format: 'iife',
    loader: { '.js': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: ROOT,
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
  });
  return fs.readFileSync(outFile, 'utf8');
}

function buildPage(dir) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const bundle = buildBundle(dir);

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar"></div>
  <div class="chat-wrap" id="mount"></div>
  <aside class="side-panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, ChatPane, paletteFor } = window.__lanchat;
const h = React.createElement;

// Four agents in one discussion — the case the whole change exists for.
const agents = [
  { id: 'agent:hermes', name: 'Hermes', remote: false, ready: true, reason: null },
  { id: 'agent:tessie', name: 'Tessie', remote: false, ready: true, reason: null },
  { id: 'agent:beacon', name: 'Beacon', remote: false, ready: true, reason: null },
  { id: 'remote-agent:p1:wren', name: 'Wren', remote: true, viaName: 'Server', ready: true, reason: null },
];
const ids = agents.map((a) => a.id);

const said = [
  ['agent:hermes', 'Hermes', 'Beacon is taken — there is a package on npm under that name already.'],
  ['agent:tessie', 'Tessie', 'Then Wren. It is short, it is free, and it says small and quick.'],
  ['agent:beacon', 'Beacon', 'Wren is a bird, not a protocol. Hermes, does that bother you?'],
  ['remote-agent:p1:wren', 'Wren', 'It does not bother me. Tessie is right that it is free.'],
];

const messages = [
  { id: 'm0', peerId: 'session:1', direction: 'out', kind: 'text', text: 'what should we call it?', ts: Date.now() - 90000 },
  ...said.map(([agentId, speaker, text], i) => ({
    id: 'm' + (i + 1), peerId: 'session:1', direction: 'in', kind: 'text',
    text, speaker, agentId, ts: Date.now() - 80000 + i * 1000,
  })),
];

const card = {
  id: 'session:1', kind: 'session', name: 'Brainstorm', online: true,
  agentIds: ids, allAgents: false, mode: 'dialogue', turns: 12,
  agentNames: agents.map((a) => a.name), agentId: ids[0], agentName: 'Hermes',
};

const root = createRoot(document.getElementById('mount'));
root.render(h(ChatPane, {
  peer: card, messages, progress: {}, agents, mentionables: [], docs: [],
  onSetCounsel: () => {}, onRenameSession: () => {}, onImportText: () => {},
  onSend: () => {}, onAttach: () => {}, onTyping: () => {}, onOpenFile: () => {},
  onRevealFile: () => {}, onClearHistory: () => {}, onExportHistory: () => {},
  onVoiceCall: () => {}, onVideoCall: () => {},
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// sRGB relative luminance and WCAG contrast, from the computed colours the
// browser reports rather than from anything this file worked out.
// A computed colour, as three 0-255 channels.
//
// Not one format but two: anything that went through color-mix() comes back as
// \`color(srgb 0.217 0.272 0.347)\` — the modern form, with 0-to-1 channels —
// while a plain hex or rgb() declaration still reports \`rgb(55, 69, 88)\`.
// Reading the first as if it were the second turns every mixed colour into
// black, which is a convincing enough failure to be worth naming here.
const rgb = (s) => {
  const nums = (s.match(/-?[\\d.]+/g) || []).map(Number);
  return s.trim().startsWith('color(') ? nums.slice(0, 3).map((v) => v * 255) : nums.slice(0, 3);
};
// Whether anything behind a bubble can show through it.
const seeThrough = (s) => /rgba?\\([^)]*,\\s*0?\\.\\d+\\s*\\)/.test(s) || /\\/\\s*0?\\.\\d+/.test(s);
const lin = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => {
  const x = Math.max(lum(a), lum(b)), y = Math.min(lum(a), lum(b));
  return (x + 0.05) / (y + 0.05);
};
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

(async () => {
  await wait(300);
  const out = { rows: [], errors: [] };
  const palette = paletteFor(ids);
  out.palette = [...palette].map(([id, c]) => [id, c]);

  const rows = [...document.querySelectorAll('.bubble-row.agent')];
  out.count = rows.length;

  for (const row of rows) {
    const bubble = row.querySelector('.bubble');
    const speaker = row.querySelector('.bubble-speaker');
    const cs = getComputedStyle(bubble);
    const fill = rgb(cs.backgroundColor);
    const body = rgb(cs.color);
    const name = speaker ? rgb(getComputedStyle(speaker).color) : null;
    const edge = rgb(cs.borderLeftColor);
    const box = bubble.getBoundingClientRect();
    out.rows.push({
      who: speaker ? speaker.textContent : null,
      declared: row.style.getPropertyValue('--agent-color').trim(),
      fill: hex(fill),
      edge: hex(edge),
      bodyOnFill: Number(ratio(body, fill).toFixed(2)),
      nameOnFill: name ? Number(ratio(name, fill).toFixed(2)) : null,
      alpha: seeThrough(cs.backgroundColor) ? cs.backgroundColor : 'opaque',
      // Where to sample the screenshot, well inside the bubble and clear of text.
      probe: [Math.round(box.left + box.width - 12), Math.round(box.top + 6)],
      borderWidth: cs.borderLeftWidth,
    });
  }

  // The question somebody typed must not be one of them.
  out.outRows = document.querySelectorAll('.bubble-row.out.agent').length;

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

async function runAgentColourHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };

  return withScratchDir(outDir, 'lanchat-agent-colour-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, buildPage(dir));
    // The DOM and the picture in one launch. Both are wanted from the same page
    // at the same size, which is the case lib/chromium.js says to ask for them
    // together: a launch costs about three seconds and everything else here is
    // milliseconds, and this suite already starts more browsers at once than the
    // machine has patience for.
    const shot = path.join(dir, 'agents.png');
    const result = render(chrome, dir, page, { ...RUN, png: shot });
    if (!result) return { skipped: 'the page produced no result' };

    // Read here rather than by the caller: without an output directory this
    // scratch dir is deleted on the way out, and a path handed back would point
    // at nothing by the time anybody looked.
    const png = fs.existsSync(shot) ? readPng(shot) : null;
    const painted = png
      ? result.rows.map((r) => {
          const [x, y] = r.probe;
          const i = (y * png.width + x) * 4;
          return [png.data[i], png.data[i + 1], png.data[i + 2]];
        })
      : null;

    return { ...result, painted, shot: keep ? shot : null, dir: keep ? dir : null };
  });
}

// What was measured, and whether it is good enough to ship.
function report(result) {
  const fails = [];
  console.log(`palette: ${result.palette.map(([, c]) => c).join(' ')}`);
  console.log(`coloured rows: ${result.count} (expected 4)`);
  if (result.count !== 4) fails.push(`expected 4 coloured rows, painted ${result.count}`);
  if (result.outRows !== 0) fails.push('the question somebody typed was coloured as an agent');

  const declared = new Set();
  for (const r of result.rows) {
    console.log(
      `  ${String(r.who).padEnd(8)} declared ${r.declared}  fill ${r.fill}  edge ${r.edge}  ` +
        `body ${r.bodyOnFill}:1  name ${r.nameOnFill}:1  ${r.alpha}  border ${r.borderWidth}`
    );
    declared.add(r.declared);
    if (r.bodyOnFill < 4.5) fails.push(`${r.who}: body text ${r.bodyOnFill}:1 on its fill, needs 4.5:1`);
    if (r.nameOnFill !== null && r.nameOnFill < 4.5)
      fails.push(`${r.who}: its name ${r.nameOnFill}:1 on its own fill, needs 4.5:1`);
    if (r.alpha !== 'opaque') fails.push(`${r.who}: fill is not opaque (${r.alpha})`);
    if (r.edge.toLowerCase() !== r.declared.toLowerCase())
      fails.push(`${r.who}: the edge is ${r.edge}, not the agent's ${r.declared}`);
  }
  if (declared.size !== result.rows.length)
    fails.push(`two agents share a colour: ${[...declared].join(' ')}`);

  // And the same thing again off the pixels, because a computed style is what
  // the engine says it will paint and a screenshot is what it painted.
  if (result.painted) {
    result.rows.forEach((r, n) => {
      const px = result.painted[n];
      const seen = `#${px.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const want = [1, 3, 5].map((k) => parseInt(r.fill.slice(k, k + 2), 16));
      // A couple of levels of slack for the screenshot's own rounding, and no
      // more: this is checking that the fill was painted, not approximated.
      const off = Math.max(...px.map((v, k) => Math.abs(v - want[k])));
      console.log(`  ${String(r.who).padEnd(8)} painted ${seen} vs computed ${r.fill} (±${off})`);
      if (off > 3) fails.push(`${r.who}: painted ${seen} where the style says ${r.fill}`);
    });
  } else {
    console.log('  (no screenshot to read back)');
  }

  console.log('');
  if (fails.length) {
    for (const f of fails) console.log(`FAIL  ${f}`);
    return false;
  }
  console.log('OK  four agents, four opaque colours, every one readable, all four painted as computed.');
  return true;
}

if (require.main === module) {
  runAgentColourHarness(process.argv[2])
    .then((result) => {
      if (result.skipped) {
        console.log(`skipped: ${result.skipped}`);
        return;
      }
      if (!report(result)) process.exitCode = 1;
      if (result.dir) console.log(`kept in ${result.dir}`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runAgentColourHarness, report };
