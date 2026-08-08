import React, { useEffect, useState } from 'react';
import { argumentHint, argumentPlaceholder, profileCopy, stickyNote } from '../lib/agentCopy';
import { agentTag } from '../lib/agentBadge';
import { isHermesCommand } from '../lib/agentCommand';

// Agents settings: connect an agent over one of four transports, toggle it on or
// off, choose which peers may address it, and remove it completely.
//
// Nothing here is permanent — an agent can be added and removed at will, and the
// toggle is a full kill switch that stops the transport while keeping the
// configuration so it can be turned back on without re-entering a key.

const KINDS = [
  {
    id: 'http',
    label: 'HTTP API',
    hint: 'Recommended. The only transport that can ask you to approve a tool call.',
  },
  {
    id: 'command',
    label: 'Local command',
    hint: 'Runs a CLI on this machine. No approval prompts — the command must be non-interactive.',
  },
  {
    id: 'acp',
    label: 'ACP',
    hint: 'Agent Client Protocol over stdio. Keeps conversation context and supports approvals.',
  },
  {
    id: 'ssh',
    label: 'SSH command',
    hint: 'Runs the agent on another host. The host must already be in your known_hosts.',
  },
  {
    id: 'a2a',
    label: 'A2A',
    hint: 'Agent2Agent over JSON-RPC. Reads the agent’s own card for its name and skills.',
  },
];

// Transports reached over a network, which therefore have something to
// authenticate with. The others start a program on a machine that already
// trusts you, so a key field on their form would be a box with nowhere to go.
const KEYED = new Set(['http', 'a2a']);

const BLANK = {
  id: null, // set once the record exists — the form doubles as the edit form
  created: false, // this form session created the record, so Discard may undo it
  hasSecret: false,
  name: '',
  kind: 'http',
  config: {
    baseUrl: 'http://127.0.0.1:8642',
    model: '',
    profile: '',
    command: 'hermes',
    args: '',
    cwd: '',
    host: '',
    user: '',
    identityFile: '',
    port: '',
    remoteCommand: 'hermes',
  },
  secretMode: 'sealed',
  secretValue: '',
  secretEnv: '',
};

// Inverse of buildPayload: turns a stored agent back into form state. The key
// is deliberately absent — publicList never returns it — so the field starts
// empty and an untouched field means "keep what is stored".
function draftFrom(agent) {
  const c = agent.config || {};
  return {
    ...BLANK,
    id: agent.id,
    hasSecret: agent.hasSecret,
    name: agent.name,
    kind: agent.kind,
    config: {
      ...BLANK.config,
      ...c,
      args: Array.isArray(c.args) ? c.args.join(' ') : c.args || '',
    },
    secretMode: agent.secretMode === 'env' ? 'env' : 'sealed',
    secretEnv: agent.secretEnv || '',
  };
}

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
        ? { baseUrl: c.baseUrl, model: c.model || undefined, profile: c.profile || undefined }
        : d.kind === 'a2a'
          ? { baseUrl: c.baseUrl }
          : d.kind === 'command'
            ? { command: c.command, args, cwd: c.cwd || undefined }
            : d.kind === 'acp'
              ? // `profile` is listed here for the same reason it is listed under
                // http: a field the form collects but the payload omits is a
                // field that silently does nothing. Leaving it out is exactly
                // what made the ACP picker dead on arrival — it saved, and the
                // agent still launched under whatever Hermes was already set to.
                // `|| undefined` rather than `''` so that clearing it works too:
                // update merges same-kind configs, and only an explicit
                // undefined overwrites a stored name on the way to JSON.
                { command: c.command, args, cwd: c.cwd || undefined, profile: c.profile || undefined }
              : {
                  host: c.host,
                  user: c.user,
                  identityFile: c.identityFile || undefined,
                  port: c.port || undefined,
                  remoteCommand: c.remoteCommand,
                  args,
                };
    const secret = !KEYED.has(d.kind)
      ? { mode: 'none' }
      : d.secretMode === 'env'
        ? { mode: 'env', name: d.secretEnv }
        : d.secretValue
          ? { mode: 'sealed', value: d.secretValue }
          : { mode: 'none' };
    const payload = { name: d.name, kind: d.kind, config, secret };
    // Editing an agent that already has a sealed key, without typing a new one,
    // must not wipe it. Omitting `secret` entirely is what tells the registry to
    // leave the stored key alone.
    if (d.id && KEYED.has(d.kind) && d.secretMode === 'sealed' && !d.secretValue && d.hasSecret) {
      delete payload.secret;
    }
    return payload;
  }

  async function save() {
    setBusy(true);
    setResult(null);
    const payload = buildPayload(draft);
    const res = draft.id
      ? await window.lanchat.updateAgent(draft.id, payload)
      : await window.lanchat.addAgent(payload);
    setBusy(false);
    if (!res.ok) {
      setResult({ ok: false, text: res.error });
      return;
    }
    setAgents(await window.lanchat.listAgents());
    // Saved is not the same as reachable. If it did not answer, stay open as an
    // edit form for the record that now exists, so the address can be corrected
    // in place without re-entering the key.
    if (res.probe && res.probe.ok === false) {
      setDraft((d) => ({
        ...d,
        id: res.agent.id,
        created: d.created || !d.id,
        hasSecret: res.agent.hasSecret,
        secretValue: '',
      }));
      setResult({ ok: false, text: res.probe.detail });
      return;
    }
    setDraft(null);
  }

  // Only offered for a record this form session just created, so it can be
  // undone cleanly. Editing an agent that already existed never deletes it.
  async function discard() {
    if (draft.id) await window.lanchat.removeAgent(draft.id);
    setAgents(await window.lanchat.listAgents());
    setDraft(null);
    setResult(null);
  }

  async function toggle(agent) {
    setAgents((list) =>
      list.map((a) => (a.id === agent.id ? { ...a, enabled: !a.enabled, status: 'pending' } : a))
    );
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

  async function savePeers(agent, allowed, sharing, approvals) {
    // Reach and the allowlist are stored separately on purpose: switching
    // network-wide off must leave the ticked list intact and governing again.
    await window.lanchat.setAgentPeers(agent.id, allowed);
    await window.lanchat.setAgentSharing(agent.id, sharing);
    // Last, and after reach: handing approvals to a peer who cannot reach the
    // agent is meaningless, and main prunes holders against the allowlist as it
    // saves — so this has to see the list that has already been written.
    if (approvals) await window.lanchat.setAgentApprovals(agent.id, approvals);
    setAgents(await window.lanchat.listAgents());
    setEditingPeers(null);
  }

  return (
    <div className="agents">
      {agents.length === 0 && !draft && (
        <div className="hint" style={{ marginBottom: 10 }}>
          No agents connected. An agent appears in your roster like any other contact — you can remove it at
          any time.
        </div>
      )}

      {agents.map((agent) => (
        <div key={agent.id} className={`agent-row ${agent.enabled ? '' : 'off'}`}>
          <div className="agent-main">
            <span className={`presence ${agent.enabled ? 'online' : ''}`} />
            <div>
              <div className="agent-name">
                {agent.name} <AgentTag agent={agent} />
                {!agent.enabled && <span className="tag">off</span>}
                {/* The widest grant in the app must never be a silent state. */}
                {agent.networkWide && (
                  <span className="tag warn" title="Anyone on your network can message this agent">
                    network
                  </span>
                )}
              </div>
              <div className="hint">
                {agent.networkWide
                  ? 'Anyone on the network may message it'
                  : agent.allowedPeers.length
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
            <button
              className="btn"
              onClick={() => {
                setResult(null);
                setDraft(draftFrom(agent));
              }}
            >
              Edit
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
          onSave={(allowed, sharing, approvals) => savePeers(editingPeers, allowed, sharing, approvals)}
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
              <ProfileField draft={draft} setCfg={setCfg} />
              <Field
                label="Model (optional)"
                value={draft.config.model}
                onChange={(v) => setCfg({ model: v })}
              />
              <SecretField draft={draft} setDraft={setDraft} envExample="HERMES_API_KEY" />
            </>
          )}

          {draft.kind === 'a2a' && (
            <>
              <Field
                label="Base URL"
                value={draft.config.baseUrl}
                placeholder="https://agent.example.com"
                hint="Where the agent’s card lives. Its name, skills and service endpoint are read from /.well-known/agent-card.json when the agent starts."
                onChange={(v) => setCfg({ baseUrl: v })}
              />
              <SecretField draft={draft} setDraft={setDraft} label="Bearer token" envExample="A2A_TOKEN" />
            </>
          )}

          {(draft.kind === 'command' || draft.kind === 'acp') && (
            <>
              <Field label="Command" value={draft.config.command} onChange={(v) => setCfg({ command: v })} />
              <Field
                label="Arguments"
                value={draft.config.args}
                placeholder={argumentPlaceholder(draft.kind)}
                hint={argumentHint(draft.kind)}
                onChange={(v) => setCfg({ args: v })}
              />
              <Field
                label="Working directory (optional)"
                value={draft.config.cwd}
                onChange={(v) => setCfg({ cwd: v })}
              />
              {/* Only Hermes understands --profile; the picker offers nothing
                  for any other ACP agent rather than suggesting a flag that
                  would stop it starting. */}
              {draft.kind === 'acp' && <ProfileField draft={draft} setCfg={setCfg} />}
            </>
          )}

          {draft.kind === 'ssh' && (
            <>
              <Field
                label="Host"
                value={draft.config.host}
                placeholder="agent-box"
                onChange={(v) => setCfg({ host: v })}
              />
              <Field label="User" value={draft.config.user} onChange={(v) => setCfg({ user: v })} />
              <Field
                label="Port (optional)"
                value={draft.config.port}
                onChange={(v) => setCfg({ port: v })}
              />
              <Field
                label="Identity file (optional)"
                value={draft.config.identityFile}
                placeholder="~/.ssh/id_ed25519"
                onChange={(v) => setCfg({ identityFile: v })}
              />
              <Field
                label="Remote command"
                value={draft.config.remoteCommand}
                onChange={(v) => setCfg({ remoteCommand: v })}
              />
              <Field
                label="Arguments"
                value={draft.config.args}
                placeholder="-z {prompt}"
                hint="Strict host-key checking is enforced and passwords are never prompted, so the host must already be in known_hosts with key auth working."
                onChange={(v) => setCfg({ args: v })}
              />
            </>
          )}

          {result && result.ok === false && !result.id && (
            <div className="agent-result bad">{result.text}</div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={!draft.name || busy} onClick={save}>
              {busy ? 'Connecting…' : draft.id ? 'Save changes' : 'Connect'}
            </button>
            {draft.created ? (
              <button className="btn ghost" onClick={discard}>
                Discard
              </button>
            ) : (
              <button
                className="btn ghost"
                onClick={() => {
                  setDraft(null);
                  setResult(null);
                }}
              >
                {draft.id ? 'Close' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Which Hermes profile to run under. Both transports that can choose one share
// this field, but not its copy: over HTTP an unknown name is quietly served as
// the server's default, while over ACP it is a launch flag that stops the agent
// starting. The names come from the Hermes install on this machine either way —
// authoritative for a local child process, a best guess for a server.
function ProfileField({ draft, setCfg }) {
  const [profiles, setProfiles] = useState(null); // null = not looked yet
  const [active, setActive] = useState(null); // Hermes' own current profile
  const [busy, setBusy] = useState(false);
  const copy = profileCopy(draft.kind);
  // Whether this field can do anything at all, which over ACP depends on the
  // command as it stands in the form right now — not on what was saved.
  const applies = draft.kind !== 'acp' || isHermesCommand(draft.config.command);
  const sticky = draft.kind === 'acp' && !draft.config.profile ? stickyNote(active) : null;

  async function look() {
    setBusy(true);
    const res = await window.lanchat.listAgentProfiles(draft.id, {
      kind: draft.kind,
      config: draft.config,
      secret: draft.secretValue || undefined,
    });
    setBusy(false);
    setProfiles(res?.profiles || []);
    setActive(res?.active || null);
  }

  return (
    <div className="field">
      <label htmlFor="agent-profile">Hermes profile (optional)</label>
      {profiles && profiles.length > 0 ? (
        <select
          id="agent-profile"
          value={draft.config.profile || ''}
          onChange={(e) => setCfg({ profile: e.target.value })}
        >
          <option value="">{copy.defaultOption}</option>
          {profiles.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <input
          id="agent-profile"
          value={draft.config.profile || ''}
          placeholder={copy.placeholder}
          onChange={(e) => setCfg({ profile: e.target.value })}
        />
      )}
      <div className="row" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
        <button type="button" className="btn" onClick={look} disabled={busy}>
          {busy ? 'Looking…' : 'Find profiles'}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          {!applies
            ? copy.notHermes
            : profiles === null
              ? copy.unasked
              : profiles.length
                ? copy.found
                : copy.none}
        </span>
      </div>
      {applies && sticky && (
        <div className="hint" style={{ marginTop: 6 }}>
          {sticky}
        </div>
      )}
    </div>
  );
}

// Transport, and the profile it runs under when there is one. See agentBadge.js
// for why the two share a badge and why only one half is uppercased.
function AgentTag({ agent }) {
  const tag = agentTag(agent);
  return (
    <span className="tag" title={tag.title}>
      {tag.kind}
      {tag.profile && (
        <>
          {' · '}
          <span className="tag-ident">{tag.profile}</span>
        </>
      )}
    </span>
  );
}

// The credential a network transport authenticates with.
//
// One component rather than a block per transport: HTTP and A2A both reach a
// service over a socket and both have to prove who they are, and the rules about
// how a key is kept — sealed with the operating system's keychain, or read from
// an environment variable and never written down — are a property of this app
// rather than of either protocol. Two copies would be two places for those rules
// to drift apart.
//
// Only the label and the example variable name differ, which is exactly the
// amount a caller should be able to change.
function SecretField({ draft, setDraft, label = 'API key', envExample }) {
  return (
    <div className="field">
      <label htmlFor="agent-secret-mode">{label}</label>
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
            placeholder={draft.hasSecret ? 'Leave blank to keep the stored key' : 'Paste the key'}
            onChange={(e) => setDraft((d) => ({ ...d, secretValue: e.target.value }))}
          />
          <div className="hint">
            {draft.hasSecret
              ? 'A key is already stored for this agent. Leave this blank to keep it, or paste a new one to replace it.'
              : "Encrypted with your operating system's keychain. It is never shown again and never leaves this device."}
          </div>
        </>
      ) : (
        <>
          <input
            value={draft.secretEnv}
            placeholder={envExample}
            onChange={(e) => setDraft((d) => ({ ...d, secretEnv: e.target.value }))}
          />
          <div className="hint">
            Only the variable name is stored; the key itself is never written to disk.
          </div>
        </>
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
  const [networkWide, setNetworkWide] = useState(agent.networkWide === true);
  const [directChat, setDirectChat] = useState(agent.directChat === true);
  const settings = agent.approvals || {};
  const [delegated, setDelegated] = useState(settings.delegated === true);
  const [unattended, setUnattended] = useState(settings.unattended === true);
  const [handover, setHandover] = useState(Math.round((settings.handoverMs ?? 20000) / 1000));
  // Typed once and sent once. Never read back — main only ever says whether
  // there is one, exactly as it does for an agent's key.
  const [passcode, setPasscode] = useState('');
  const humans = peers.filter((p) => p.kind !== 'agent');

  // Widening reach to everyone is the broadest grant in the app, so it is the
  // one thing here that asks before it takes effect. Narrowing never asks.
  function toggleNetworkWide() {
    if (networkWide) {
      setNetworkWide(false);
      return;
    }
    const ok = window.confirm(
      `Let anyone on your network message “${agent.name}”?\n\n` +
        'Every LanChat user who can reach this machine will be able to ask it to do things, ' +
        'not just the people you have ticked. Your ticked list is kept and takes over again ' +
        'the moment you switch this back off.\n\n' +
        'You still approve every tool call it wants to run, unless you have switched approvals ' +
        'over to a passcode holder below.'
    );
    if (ok) setNetworkWide(true);
  }

  // The other grant that asks before it takes effect, and it asks harder,
  // because it widens twice over: it skips the wait that would have let you
  // answer first, and it opens up runs *you* started as well as theirs.
  function toggleUnattended() {
    if (unattended) {
      setUnattended(false);
      return;
    }
    const ok = window.confirm(
      `Let approval holders answer for “${agent.name}” while you are away?\n\n` +
        'Prompts go to them immediately instead of waiting for you — and prompts from runs you ' +
        'started yourself, not just theirs, are offered to them too.\n\n' +
        'They can choose “Always allow”, which widens what this agent may do on this machine. ' +
        'Everything they decide is written into the agent’s thread here.'
    );
    if (ok) setUnattended(true);
  }

  return (
    <div className="agent-form">
      <div className="field">
        <label>Who may message {agent.name}?</label>
        <div className="hint">
          Anyone with access can ask this agent to do things. Approving a tool call it wants to run is yours
          alone, unless you hand it on below. Their conversation with it stays in its own thread, so your chat
          with them stays clean.
        </div>
      </div>

      <label className="agent-share-row" onClick={(e) => e.preventDefault()}>
        <button
          type="button"
          className={`toggle ${networkWide ? 'on' : ''}`}
          onClick={toggleNetworkWide}
          aria-pressed={networkWide}
          aria-label="Share with everyone on the network"
        />
        <div>
          <div className="agent-share-title">Anyone on the network</div>
          <div className="hint">
            {networkWide
              ? 'Shared with every peer on your network. The list below is ignored until you switch this off.'
              : 'Off — only the people you tick below can reach it.'}
          </div>
        </div>
      </label>

      <label className="agent-share-row" onClick={(e) => e.preventDefault()}>
        <button
          type="button"
          className={`toggle ${directChat ? 'on' : ''}`}
          onClick={() => setDirectChat((v) => !v)}
          aria-pressed={directChat}
          aria-label="Show in their contact list"
        />
        <div>
          <div className="agent-share-title">Show in their contact list</div>
          <div className="hint">
            {directChat
              ? 'It appears as a contact for anyone who can reach it.'
              : `Off — it appears for them only after they first write @${agent.name}.`}
          </div>
        </div>
      </label>

      <div className={`agent-peer-list ${networkWide ? 'muted' : ''}`}>
        {humans.length === 0 && <div className="hint">No peers known yet.</div>}
        {humans.map((p) => (
          <label key={p.id} className="row" style={{ gap: 8, padding: '4px 0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allowed.includes(p.id)}
              disabled={networkWide}
              onChange={(e) =>
                setAllowed((list) => (e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id)))
              }
            />
            <span>{p.name || p.hostname || p.id}</span>
          </label>
        ))}
      </div>

      {/* Handing approvals on. Its own block, below reach, because it only means
          anything for peers who already have reach — and because it is the one
          setting here that lets somebody else decide what runs on this machine. */}
      <div className="field" style={{ marginTop: 16 }}>
        <label>Approvals</label>
        <div className="hint">
          When this agent asks to run something, you are asked first — always. This is how you also let a peer
          answer, so a shared agent does not stall on an empty chair.
        </div>
      </div>

      <label className="agent-share-row" onClick={(e) => e.preventDefault()}>
        <button
          type="button"
          className={`toggle ${delegated ? 'on' : ''}`}
          onClick={() => {
            setDelegated((v) => !v);
            if (delegated) setUnattended(false);
          }}
          aria-pressed={delegated}
          aria-label="Let a peer answer approval prompts"
        />
        <div>
          <div className="agent-share-title">Let a ticked peer answer with a passcode</div>
          <div className="hint">
            {delegated
              ? 'A peer who is ticked above and knows the passcode can answer prompts for questions they asked.'
              : 'Off — approval prompts are yours alone, as they have always been.'}
          </div>
        </div>
      </label>

      {delegated && (
        <>
          <div className="field">
            <label htmlFor="agent-approval-passcode">Approval passcode</label>
            <input
              id="agent-approval-passcode"
              className="input"
              type="password"
              autoComplete="new-password"
              value={passcode}
              placeholder={agent.hasApprovalPasscode ? 'Set — type to replace' : 'Not set'}
              onChange={(e) => setPasscode(e.target.value)}
            />
            <div className="hint">
              Give this to the peers you want to hand approvals to, out of band. It is checked on this machine
              and never sent anywhere; changing it takes back whatever the old one granted.
            </div>
          </div>

          <label className="agent-share-row" onClick={(e) => e.preventDefault()}>
            <button
              type="button"
              className={`toggle ${unattended ? 'on' : ''}`}
              onClick={toggleUnattended}
              aria-pressed={unattended}
              aria-label="Answer immediately, including for your own runs"
            />
            <div>
              <div className="agent-share-title">Answer immediately, including for runs you started</div>
              <div className="hint">
                {unattended
                  ? 'Prompts go to holders at once, and prompts from your own sessions go to them too. For a machine nobody is sitting at.'
                  : `Off — you get ${handover}s to answer first, and your own runs are never offered to anyone.`}
              </div>
            </div>
          </label>

          {!unattended && (
            <div className="field">
              <label htmlFor="agent-handover">Give me this long to answer first</label>
              <input
                id="agent-handover"
                className="input"
                type="number"
                min="0"
                max="600"
                value={handover}
                onChange={(e) => setHandover(Math.max(0, Number(e.target.value) || 0))}
              />
              <div className="hint">
                Seconds. The prompt stays on your screen either way — whoever answers first wins.
              </div>
            </div>
          )}
        </>
      )}

      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button
          className="btn primary"
          onClick={() =>
            onSave(
              allowed,
              { networkWide, directChat },
              {
                delegated,
                unattended,
                handoverMs: handover * 1000,
                // Only when one was typed. An untouched field must not wipe a
                // passcode that is already set — the same rule the agent's key
                // follows in sealSecret().
                ...(passcode ? { passcode } : {}),
              }
            )
          }
        >
          Save
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
