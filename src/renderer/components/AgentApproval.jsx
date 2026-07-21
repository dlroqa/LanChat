import React from 'react';

// An agent is asking permission to run something on this machine.
//
// This is rendered as a distinct card rather than a chat bubble, and deliberately
// so: the text of a message is attacker-influenced (a remote peer may have
// prompted the agent), and a prompt that looked like ordinary agent output could
// be spoofed by an agent simply writing something that resembled one. The card's
// framing, and the fact that only real approval events produce it, is what makes
// the difference visible.
//
// Only the local user ever sees this. A peer may have asked the question, but
// authorisation is never delegated across the network.

export default function AgentApproval({ request, agentName, onAnswer }) {
  if (!request) return null;
  const choices = normaliseChoices(request.choices);

  return (
    <div className="agent-approval" role="alertdialog" aria-label={`${agentName} is requesting permission`}>
      <div className="agent-approval-head">
        <span className="agent-approval-icon" aria-hidden="true">
          !
        </span>
        <div>
          <b>{agentName}</b> wants to run something on this device.
          <div className="hint">Only you can answer this. Peers cannot approve it.</div>
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

// The HTTP transport reports choices as plain strings, ACP as {id, label}
// objects. Normalise both, and always guarantee a deny option exists so there is
// never a prompt the user cannot refuse.
function normaliseChoices(raw) {
  const list = (raw || []).map((c) =>
    typeof c === 'string'
      ? { id: c, label: LABELS[c] || c, deny: c === 'deny' || c === 'cancelled' }
      : { id: c.id, label: c.label || LABELS[c.id] || c.id, deny: c.kind === 'reject_once' || c.id === 'deny' }
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
