'use strict';

const fs = require('node:fs');
const path = require('node:path');
const React = require('react');

// Driving a real component, with real timers, without a browser.
//
// `react-dom/server` renders once and cannot be typed into, and there is no
// jsdom here. But some of what the Task Bar's editors promise is not in their
// markup at all: that a debounced save carries the last letter typed, that
// every way out of a field flushes what is in it, that running a task puts the
// instruction as it is now. Those are questions about a mounted component whose
// callbacks and effects actually run.
//
// So the component is driven as the function it is, with useState, useRef,
// useEffect, useCallback and useMemo backed by real storage and the tree
// rebuilt when a setter moves something. Small enough to read in one sitting,
// which is the point — a test harness nobody can check is a test nobody can
// trust.
//
// What it is not: React. There is no reconciliation, no batching beyond a
// microtask, and no children are rendered — `find` walks the element tree the
// component returned. That is enough for callbacks and effects, and anything
// needing more than that belongs in a browser harness instead.

// The real files, transformed the way vite would, so what is driven is what the
// app mounts rather than a fixture of it.
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const esbuild = require('esbuild');
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: 'jsx',
    format: 'cjs',
  });
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === 'react') return React;
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
    return require(id);
  });
  cache.set(file, mod.exports);
  return mod.exports;
}

function mount(Component, props) {
  const cells = [];
  let i = 0;
  let effects = [];
  const cleanups = [];
  let queued = false;
  let tree = null;
  let current = props;

  const hooks = {
    useState(initial) {
      const at = i++;
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        const value = typeof next === 'function' ? next(cells[at]) : next;
        if (Object.is(value, cells[at])) return;
        cells[at] = value;
        schedule();
      };
      return [cells[at], set];
    },
    useRef(initial) {
      const at = i++;
      if (!(at in cells)) cells[at] = { current: initial };
      return cells[at];
    },
    // Deliberately not memoised. What is being driven here is behaviour, and a
    // stale closure kept for identity's sake would be the bug rather than the
    // thing under test — the components themselves keep what has to survive a
    // render in refs, which is exactly what this would hide.
    useCallback(fn) {
      i += 1;
      return fn;
    },
    useMemo(fn) {
      i += 1;
      return fn();
    },
    useEffect(fn, deps) {
      const at = i++;
      const prev = cells[at];
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      cells[at] = { deps };
      if (changed) effects.push(fn);
    },
  };

  function pass() {
    i = 0;
    effects = [];
    const saved = { ...React };
    Object.assign(React, hooks);
    try {
      tree = Component(current);
    } finally {
      Object.assign(React, saved);
    }
    for (const run of effects) {
      const undo = run();
      if (typeof undo === 'function') cleanups.push(undo);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      pass();
    });
  }

  pass();

  return {
    get tree() {
      return tree;
    },
    // A new set of props, as a parent re-rendering would deliver — which is how
    // a pushed list from main reaches a view that is already open.
    setProps(next) {
      current = { ...current, ...next };
      pass();
    },
    settle: () => new Promise((r) => setTimeout(r, 0)),
    unmount() {
      for (const undo of cleanups.splice(0)) undo();
    },
  };
}

// The first element in the tree the predicate accepts.
function find(node, pick) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (pick(node)) return node;
  return find(node.props && node.props.children, pick);
}

// Every element the predicate accepts, in tree order.
function findAll(node, pick, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pick, out);
    return out;
  }
  if (pick(node)) out.push(node);
  return findAll(node.props && node.props.children, pick, out);
}

const byClass = (name) => (n) =>
  n.props &&
  String(n.props.className || '')
    .split(' ')
    .includes(name);

const byLabel = (label) => (n) => n.props && n.props['aria-label'] === label;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for something to become true, rather than for a length of time.
//
// The debounced saves these tests drive settle after half a second, and a fixed
// sleep a little longer than that is a race the suite loses on a busy machine —
// which is exactly where a test suite runs. So: poll, give up after a bound
// that is long enough to mean something is actually wrong, and let the caller's
// own assertion produce the message.
async function until(predicate, { timeout = 5000, every = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(every);
  }
  return predicate();
}

module.exports = { load, mount, find, findAll, byClass, byLabel, wait, until };
