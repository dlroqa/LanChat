'use strict';

const { runProcess, buildArgs, DEFAULT_TIMEOUT_MS } = require('./spawn');

// SSH transport: runs the agent command on another host. Useful when the agent
// lives on a different machine from LanChat.
//
// Security posture, all enforced below rather than left to the user's ssh config:
//   StrictHostKeyChecking=yes  the host key must already be in known_hosts, so a
//                              swapped or spoofed host fails closed instead of
//                              prompting (there is no TTY here to prompt on).
//   BatchMode=yes              never prompt for a password; key auth or nothing.
//   PasswordAuthentication=no  belt and braces against an interactive fallback.
//   no shell string            the remote argv is passed as separate arguments,
//                              so prompt text cannot break out into remote shell
//                              syntax. This is the main injection risk here and
//                              it is why buildArgs() keeps the prompt in one slot.

function createSshTransport({ id, name, config, timeoutMs }) {
  const host = String(config.host || '').trim();
  const user = String(config.user || '').trim();
  const identity = config.identityFile ? String(config.identityFile) : null;
  const port = config.port ? String(config.port) : null;
  const remoteCommand = String(config.remoteCommand || 'hermes');
  const template = Array.isArray(config.args) && config.args.length ? config.args : ['-z', '{prompt}'];
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
  let child = null;

  if (!host) throw new Error('An SSH host is required.');

  function sshArgs(remoteFile, remoteArgv) {
    const args = [
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'BatchMode=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'ConnectTimeout=10',
    ];
    if (identity) args.push('-i', identity);
    if (port) args.push('-p', port);
    args.push(user ? `${user}@${host}` : host, '--', remoteFile, ...remoteArgv);
    return args;
  }

  async function start() {
    // `true` is a no-op on the remote host: this validates connectivity, host-key
    // trust and key auth without starting an agent turn.
    await runProcess({ file: 'ssh', args: sshArgs('true', []), timeoutMs: 20000 });
    return { detail: `SSH to ${user ? `${user}@` : ''}${host} succeeded` };
  }

  async function send({ text }, handlers = {}) {
    const { onDelta, onDone, onError } = handlers;
    try {
      const result = await runProcess({
        file: 'ssh',
        args: sshArgs(remoteCommand, buildArgs(template, text)),
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

  return { id, name, kind: 'ssh', start, send, stop };
}

module.exports = { createSshTransport };
