'use strict';

// Driving headless chromium, for the harnesses that check the renderer by
// laying it out rather than by reasoning about it.
//
// There are two of those now — the connection light and the window's frame —
// and everything they have in common is here: finding a browser, running a page
// in it, getting an answer back, and having somewhere to work. What is left in
// each harness is the part that is actually about the thing it measures.
//
// Note for this sandbox: snap chromium is confined. It cannot write into /tmp or
// into a dot-directory under $HOME, and it needs a writable cwd for its own
// profile, so the working directory has to be somewhere ordinary. That is the
// whole reason withScratchDir exists rather than mkdtemp being called inline.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BINARIES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

// Null rather than a throw: chromium is not always present, and a harness that
// cannot run should report that it skipped rather than fail a suite.
function chromiumPath() {
  for (const bin of BINARIES) {
    try {
      return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// --dump-dom returns the page as markup, so the only way back out of the browser
// is for the page to leave its findings somewhere in the DOM. Both harnesses put
// them in a <pre id="result">, which means they arrive HTML-escaped.
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function baseArgs({ width, height, budget = 2000, args = [] }) {
  return [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `--window-size=${width},${height}`,
    ...args,
    `--virtual-time-budget=${budget}`,
  ];
}

// One run of one page. `dump` reads the findings back out of <pre id="result">;
// `png` writes a screenshot beside it. Both together cost one browser launch —
// which is worth asking for whenever the same page at the same size is wanted in
// both forms, because a launch is around three seconds and everything else here
// is milliseconds.
function render(chrome, dir, pageFile, opts) {
  const { dump = true, png = null } = opts;
  const out = execFileSync(
    chrome,
    [
      ...baseArgs(opts),
      ...(png ? [`--screenshot=${png}`] : []),
      ...(dump ? ['--dump-dom'] : []),
      `file://${pageFile}`,
    ],
    // chromium announces each file it writes on stderr; callers print JSON.
    { encoding: 'utf8', cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }
  );
  if (!dump) return null;
  const m = out.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  return m ? JSON.parse(decodeEntities(m[1])) : null;
}

// Somewhere ordinary to work, cleaned up unless the caller wants to keep it.
//
// A run without an explicit destination is a test run, and it cleans up after
// itself — chromium leaves about 12MB of profile behind each time, which is not
// something a suite should be depositing in somebody's home directory. Pass a
// directory to keep the screenshots and look at them.
async function withScratchDir(outDir, prefix, fn) {
  const keep = Boolean(outDir);
  const dir = outDir || fs.mkdtempSync(path.join(os.homedir(), prefix));
  if (keep) fs.mkdirSync(dir, { recursive: true });
  try {
    return await fn(dir, keep);
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { chromiumPath, decodeEntities, render, withScratchDir };
