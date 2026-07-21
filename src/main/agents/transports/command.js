'use strict';

const { runProcess, buildArgs, DEFAULT_TIMEOUT_MS } = require('./spawn');

// Local command transport: spawns the agent CLI once per message and treats
// stdout as the reply. Simplest option and needs no API key, but it is
// request/response only — there is no approval channel, so a CLI invoked this
// way must already be non-interactive (e.g. `hermes -z`, which auto-bypasses
// approval prompts because there is no TTY to answer them).
//
// That trade-off is why the HTTP transport is the recommended one: it is the
// only path where a dangerous tool call can be put in front of the user.

function createCommandTransport({ id, name, config, timeoutMs }) {
  const file = String(config.command || 'hermes');
  const template = Array.isArray(config.args) && config.args.length ? config.args : ['-z', '{prompt}'];
  const cwd = config.cwd || undefined;
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
  let child = null;

  async function start() {
    // Resolve the binary without running a turn: `--version` is cheap and
    // proves the command exists and is executable before we accept messages.
    const { text } = await runProcess({ file, args: ['--version'], cwd, timeoutMs: 15000 });
    return { detail: `${file} ${text.split('\n')[0] || 'ready'}`.trim() };
  }

  async function send({ text }, handlers = {}) {
    const { onDelta, onDone, onError } = handlers;
    try {
      const result = await runProcess({
        file,
        args: buildArgs(template, text),
        cwd,
        timeoutMs: budget,
        onDelta,
        onChild: (c) => {
          child = c;
        },
      });
      child = null;
      onDone?.({ text: result.text });
    } catch (err) {
      child = null;
      onError?.(err);
    }
  }

  async function stop() {
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {}
    child = null;
  }

  return { id, name, kind: 'command', start, send, stop };
}

module.exports = { createCommandTransport };
