import React from 'react';

// An agent is asking permission to run something.
//
// This is rendered as a distinct card rather than a chat bubble, and deliberately
// so: the text of a message is attacker-influenced (a remote peer may have
// prompted the agent), and a prompt that looked like ordinary agent output could
// be spoofed by an agent simply writing something that resembled one. The card's
// framing, and the fact that only real approval events produce it, is what makes
// the difference visible.
//
// Whose question it is depends on which machine the agent runs on, and the card
// has to say so rather than assume. Four cases, and the hint line is the whole
// difference between them:
//
//   * ours, nobody else may answer — the original, and still the default;
//   * ours, and a named peer may answer it in a moment;
//   * ours, and a named peer may answer it right now (unattended sharing);
//   * somebody else's, and they have handed us the right to answer for them.
//
// The last one is the one worth being loud about. Clicking Allow there runs a
// command on a machine that is not this one, and a card that looked identical to
// the local case would be inviting somebody to approve something for a computer
// they are not sitting at.

export default function AgentApproval({ request, agentName, onAnswer }) {
  if (!request) return null;
  const choices = normaliseChoices(request.choices);
  const remote = request.remote === true;
  const delegates = Array.isArray(request.delegates) ? request.delegates : [];

  return (
    <div
      className={`agent-approval${remote ? ' agent-approval-remote' : ''}`}
      role="alertdialog"
      aria-label={`${agentName} is requesting permission`}
    >
      <div className="agent-approval-head">
        <span className="agent-approval-icon" aria-hidden="true">
          !
        </span>
        <div>
          <b>{agentName}</b>{' '}
          {remote
            ? `wants to run something on ${request.viaOwner ? `${request.viaOwner}'s` : 'their'} device.`
            : 'wants to run something on this device.'}
          <div className="hint">{hint({ remote, request, delegates })}</div>
        </div>
      </div>

      <pre className="agent-approval-command">{String(request.command || 'an unspecified command')}</pre>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {choices.map((choice) => (
          <button
            key={choice.id}
            className={`btn ${choice.deny ? 'danger' : choice.id === 'once' ? 'primary' : ''}`}
            onClick={() => onAnswer(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// The one line that says whose decision this is. Written from what the event
// actually carries rather than from a setting the window would have to be told
// separately, so it cannot claim a peer may answer when main has not offered it
// to one.
function hint({ remote, request, delegates }) {
  if (remote) {
    const owner = request.viaOwner || 'its owner';
    return `Answering on behalf of ${owner}. Whatever you choose runs on their device, not yours.`;
  }
  if (!delegates.length) return 'Only you can answer this. Peers cannot approve it.';
  const names = delegates.map((d) => d.name).join(', ');
  const seconds = Math.round((request.handoverMs || 0) / 1000);
  return seconds > 0
    ? `You can answer this. If you do not, ${names} may answer it in ${seconds}s.`
    : `You can answer this, and so can ${names} — whoever gets there first.`;
}

// The HTTP transport reports choices as plain strings, ACP as {id, label}
// objects. Normalise both, and always guarantee a deny option exists so there is
// never a prompt the user cannot refuse.
function normaliseChoices(raw) {
  const list = (raw || []).map((c) =>
    typeof c === 'string'
      ? { id: c, label: LABELS[c] || c, deny: c === 'deny' || c === 'cancelled' }
      : {
          id: c.id,
          label: c.label || LABELS[c.id] || c.id,
          deny: c.kind === 'reject_once' || c.id === 'deny',
        }
  );
  if (!list.some((c) => c.deny)) list.push({ id: 'deny', label: 'Deny', deny: true });
  return list;
}

const LABELS = {
  once: 'Allow once',
  session: 'Allow for this session',
  always: 'Always allow',
  deny: 'Deny',
};
