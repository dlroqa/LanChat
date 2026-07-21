'use strict';

const { spawn } = require('node:child_process');

// Shared child-process runner for the `command` and `ssh` transports.
//
// Everything here goes through spawn() with an argv *array* and no shell. That
// is the single most important property of this file: the prompt is user text
// that may contain quotes, backticks, semicolons or newlines, and it must never
// be interpolated into a shell string where those become syntax.

const MAX_OUTPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 180000;

// Substitutes the prompt into an argv template. `{prompt}` marks the slot; if
// the template has no placeholder the prompt is appended as the final argument.
// Each element is replaced whole, so the prompt always stays one argv entry.
function buildArgs(template, prompt) {
  const args = (template || []).map((a) => String(a));
  if (!args.some((a) => a.includes('{prompt}'))) return [...args, prompt];
  return args.map((a) => (a === '{prompt}' ? prompt : a.split('{prompt}').join(prompt)));
}

// `onChild` receives the spawned process so the caller can terminate an
// in-flight run from stop(); `onDelta` receives stdout chunks for live typing.
function runProcess({ file, args, cwd, env, timeoutMs, onDelta, onChild }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: cwd || undefined,
        env: env || process.env,
        shell: false, // never — see the note above
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    onChild?.(child);

    let out = '';
    let errOut = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`The agent did not respond within ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s.`));
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      onDelta?.(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errOut += chunk;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`Command not found: ${file}`) : err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = out.trim();
      if (code !== 0 && !text) {
        reject(new Error(errOut.trim().slice(-2000) || `The agent exited with code ${code}.`));
        return;
      }
      resolve({ text: text.slice(-MAX_OUTPUT_CHARS), code });
    });

    // Exposed so stop() can terminate an in-flight run.
    resolve.child = child;
    if (typeof onDelta === 'function' && onDelta.registerChild) onDelta.registerChild(child);
  });
}

module.exports = { runProcess, buildArgs, MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS };
