import React, { useEffect, useState } from 'react';

// Agents settings: connect an agent over one of four transports, toggle it on or
// off, choose which peers may address it, and remove it completely.
//
// Nothing here is permanent — an agent can be added and removed at will, and the
// toggle is a full kill switch that stops the transport while keeping the
// configuration so it can be turned back on without re-entering a key.

const KINDS = [
  { id: 'http', label: 'HTTP API', hint: 'Recommended. The only transport that can ask you to approve a tool call.' },
  { id: 'command', label: 'Local command', hint: 'Runs a CLI on this machine. No approval prompts — the command must be non-interactive.' },
  { id: 'acp', label: 'ACP', hint: 'Agent Client Protocol over stdio. Keeps conversation context and supports approvals.' },
  { id: 'ssh', label: 'SSH command', hint: 'Runs the agent on another host. The host must already be in your known_hosts.' },
];

const BLANK = {
  name: '',
  kind: 'http',
  config: { baseUrl: 'http://127.0.0.1:8642', model: '', command: 'hermes', args: '', cwd: '', host: '', user: '', identityFile: '', port: '', remoteCommand: 'hermes' },
  secretMode: 'sealed',
  secretValue: '',
  secretEnv: '',
};

export default function AgentSection({ peers = [] }) {
  const [agents, setAgents] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [editingPeers, setEditingPeers] = useState(null);

  useEffect(() => {
    window.lanchat.listAgents().then(setAgents);
  }, []);

  function setCfg(patch) {
    setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  }

  // Only the fields the chosen transport actually uses are sent, so an agent
  // record never carries stale settings from a transport it is not using.
  function buildPayload(d) {
    const c = d.config;
    const args = c.args ? c.args.split(/\s+/).filter(Boolean) : undefined;
    const config =
      d.kind === 'http'
        ? { baseUrl: c.baseUrl, model: c.model || undefined }
        : d.kind === 'command'
          ? { command: c.command, args, cwd: c.cwd || undefined }
          : d.kind === 'acp'
            ? { command: c.command, args, cwd: c.cwd || undefined }
            : { host: c.host, user: c.user, identityFile: c.identityFile || undefined, port: c.port || undefined, remoteCommand: c.remoteCommand, args };
    const secret =
      d.kind !== 'http'
        ? { mode: 'none' }
        : d.secretMode === 'env'
          ? { mode: 'env', name: d.secretEnv }
          : d.secretValue
            ? { mode: 'sealed', value: d.secretValue }
            : { mode: 'none' };
    return { name: d.name, kind: d.kind, config, secret };
  }

  async function add() {
    setBusy(true);
    setResult(null);
    const res = await window.lanchat.addAgent(buildPayload(draft));
    setBusy(false);
    if (!res.ok) {
      setResult({ ok: false, text: res.error });
      return;
    }
    setAgents(await window.lanchat.listAgents());
    setDraft(null);
  }

  async function toggle(agent) {
    setAgents((list) => list.map((a) => (a.id === agent.id ? { ...a, enabled: !a.enabled, status: 'pending' } : a)));
    await window.lanchat.setAgentEnabled(agent.id, !agent.enabled);
    setAgents(await window.lanchat.listAgents());
  }

  async function remove(agent) {
    const ok = window.confirm(
      `Remove “${agent.name}”?\n\nThis disconnects the agent, deletes its stored key and its chat history, and cannot be undone.`
    );
    if (!ok) return;
    await window.lanchat.removeAgent(agent.id);
    setAgents(await window.lanchat.listAgents());
  }

  async function test(agent) {
    setResult({ id: agent.id, text: 'Testing…' });
    const res = await window.lanchat.testAgent(agent.id);
    setResult({ id: agent.id, ok: res.ok, text: res.detail });
  }

  async function savePeers(agent, allowed) {
    await window.lanchat.setAgentPeers(agent.id, allowed);
    setAgents(await window.lanchat.listAgents());
    setEditingPeers(null);
  }

  return (
    <div className="agents">
      {agents.length === 0 && !draft && (
        <div className="hint" style={{ marginBottom: 10 }}>
          No agents connected. An agent appears in your roster like any other contact — you can remove
          it at any time.
        </div>
      )}

      {agents.map((agent) => (
        <div key={agent.id} className={`agent-row ${agent.enabled ? '' : 'off'}`}>
          <div className="agent-main">
            <span className={`presence ${agent.enabled ? 'online' : ''}`} />
            <div>
              <div className="agent-name">
                {agent.name} <span className="tag">{agent.kind}</span>
                {!agent.enabled && <span className="tag">off</span>}
              </div>
              <div className="hint">
                {agent.allowedPeers.length
                  ? `${agent.allowedPeers.length} peer${agent.allowedPeers.length === 1 ? '' : 's'} may message it`
                  : 'Only you can message it'}
              </div>
            </div>
          </div>
          <div className="agent-actions">
            <button
              className={`toggle ${agent.enabled ? 'on' : ''}`}
              onClick={() => toggle(agent)}
              aria-pressed={agent.enabled}
              aria-label={`${agent.enabled ? 'Disable' : 'Enable'} ${agent.name}`}
            />
            <button className="btn" onClick={() => test(agent)}>
              Test
            </button>
            <button className="btn" onClick={() => setEditingPeers(agent)}>
              Peers…
            </button>
            <button className="btn danger" onClick={() => remove(agent)}>
              Remove
            </button>
          </div>
          {result && result.id === agent.id && (
            <div className={`agent-result ${result.ok === false ? 'bad' : 'good'}`}>{result.text}</div>
          )}
        </div>
      ))}

      {editingPeers && (
        <PeerPicker
          agent={editingPeers}
          peers={peers}
          onCancel={() => setEditingPeers(null)}
          onSave={(allowed) => savePeers(editingPeers, allowed)}
        />
      )}

      {!draft && (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setDraft({ ...BLANK })}>
          Connect an agent
        </button>
      )}

      {draft && (
        <div className="agent-form">
          <div className="field">
            <label htmlFor="agent-name">Name</label>
            <input
              id="agent-name"
              value={draft.name}
              placeholder="Hermes"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <div className="hint">Shown in your roster. Peers address it as @{draft.name || 'name'}.</div>
          </div>

          <div className="field">
            <label htmlFor="agent-kind">Connect via</label>
            <select
              id="agent-kind"
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <div className="hint">{KINDS.find((k) => k.id === draft.kind).hint}</div>
          </div>

          {draft.kind === 'http' && (
            <>
              <Field label="Base URL" value={draft.config.baseUrl} onChange={(v) => setCfg({ baseUrl: v })} />
              <Field label="Model (optional)" value={draft.config.model} onChange={(v) => setCfg({ model: v })} />
              <div className="field">
                <label htmlFor="agent-secret-mode">API key</label>
                <select
                  id="agent-secret-mode"
                  value={draft.secretMode}
                  onChange={(e) => setDraft((d) => ({ ...d, secretMode: e.target.value }))}
                >
                  <option value="sealed">Store it encrypted on this device</option>
                  <option value="env">Read it from an environment variable</option>
                </select>
                {draft.secretMode === 'sealed' ? (
                  <>
                    <input
                      type="password"
                      value={draft.secretValue}
                      autoComplete="off"
                      placeholder="Paste the key"
                      onChange={(e) => setDraft((d) => ({ ...d, secretValue: e.target.value }))}
                    />
                    <div className="hint">
                      Encrypted with your operating system's keychain. It is never shown again and never
                      leaves this device.
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      value={draft.secretEnv}
                      placeholder="HERMES_API_KEY"
                      onChange={(e) => setDraft((d) => ({ ...d, secretEnv: e.target.value }))}
                    />
                    <div className="hint">Only the variable name is stored; the key itself is never written to disk.</div>
                  </>
                )}
              </div>
            </>
          )}

          {(draft.kind === 'command' || draft.kind === 'acp') && (
            <>
              <Field label="Command" value={draft.config.command} onChange={(v) => setCfg({ command: v })} />
              <Field
                label="Arguments"
                value={draft.config.args}
                placeholder={draft.kind === 'acp' ? 'acp' : '-z {prompt}'}
                hint="{prompt} marks where the message goes. Arguments are passed separately — never through a shell."
                onChange={(v) => setCfg({ args: v })}
              />
              <Field label="Working directory (optional)" value={draft.config.cwd} onChange={(v) => setCfg({ cwd: v })} />
            </>
          )}

          {draft.kind === 'ssh' && (
            <>
              <Field label="Host" value={draft.config.host} placeholder="agent-box" onChange={(v) => setCfg({ host: v })} />
              <Field label="User" value={draft.config.user} onChange={(v) => setCfg({ user: v })} />
              <Field label="Port (optional)" value={draft.config.port} onChange={(v) => setCfg({ port: v })} />
              <Field
                label="Identity file (optional)"
                value={draft.config.identityFile}
                placeholder="~/.ssh/id_ed25519"
                onChange={(v) => setCfg({ identityFile: v })}
              />
              <Field label="Remote command" value={draft.config.remoteCommand} onChange={(v) => setCfg({ remoteCommand: v })} />
              <Field
                label="Arguments"
                value={draft.config.args}
                placeholder="-z {prompt}"
                hint="Strict host-key checking is enforced and passwords are never prompted, so the host must already be in known_hosts with key auth working."
                onChange={(v) => setCfg({ args: v })}
              />
            </>
          )}

          {result && result.ok === false && !result.id && <div className="agent-result bad">{result.text}</div>}

          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={!draft.name || busy} onClick={add}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button className="btn ghost" onClick={() => { setDraft(null); setResult(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// Who, besides you, may address this agent. Empty means local-only, which is the
// default: an agent runs commands on this machine, so reach is opt-in per peer.
function PeerPicker({ agent, peers, onSave, onCancel }) {
  const [allowed, setAllowed] = useState(agent.allowedPeers || []);
  const humans = peers.filter((p) => p.kind !== 'agent');

  return (
    <div className="agent-form">
      <div className="field">
        <label>Who may message {agent.name}?</label>
        <div className="hint">
          Anyone you tick can ask this agent to do things by writing <b>@{agent.name}</b> to you. Only you
          can approve a tool call it wants to run — that is never delegated to a peer.
        </div>
      </div>
      {humans.length === 0 && <div className="hint">No peers known yet.</div>}
      {humans.map((p) => (
        <label key={p.id} className="row" style={{ gap: 8, padding: '4px 0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allowed.includes(p.id)}
            onChange={(e) =>
              setAllowed((list) => (e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id)))
            }
          />
          <span>{p.name || p.hostname || p.id}</span>
        </label>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" onClick={() => onSave(allowed)}>
          Save
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
