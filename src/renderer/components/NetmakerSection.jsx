import React, { useEffect, useState } from 'react';

const api = window.lanchat;

// Netmaker, in Settings.
//
// Self-contained like UpdateSection: it owns its own async state rather than
// riding the batched config patch, because most of what it shows is observed
// rather than chosen — which networks this machine is on, and what its address
// is on each.
//
// The section is written to disappear when it has nothing to say. Settings is
// already one long scroll of a dozen headings, and a person with no mesh should
// meet one switch and one sentence, not an empty table of servers and codes.

function statusLine(state) {
  if (!state) return 'Looking…';
  const { enabled, status } = state;
  const count = (state.networks || []).length;
  if (count > 0) {
    return count === 1 ? 'On 1 Netmaker network.' : `On ${count} Netmaker networks.`;
  }
  if (!enabled) return 'Not looking for peers over Netmaker.';
  switch (status && status.reason) {
    case 'not-installed':
      return 'The netclient command-line tool was not found.';
    case 'permission':
      return "netclient's configuration is readable only by an administrator, so it cannot list peers.";
    case 'unauthorised':
      return 'The server refused the token.';
    case 'api-unreachable':
      return 'That server did not answer.';
    default:
      return 'No Netmaker network found on this machine.';
  }
}

// A network's address, or both of them when it has a v4 and a v6.
function addressLine(net) {
  const list = net.addresses && net.addresses.length ? net.addresses : [net.ourAddress];
  return list.filter(Boolean).join(' · ');
}

function NetworkRow({ net, onTrust }) {
  return (
    <div className="field">
      <label>
        {net.network || net.cidr || net.iface}{' '}
        {net.home ? <span className="tag good">home</span> : <span className="tag">shared</span>}
        {net.overlapping && <span className="tag warn">overlapping</span>}
      </label>
      <div className="hint">
        {net.server ? `${net.server} · ` : ''}
        {net.cidr || 'range unknown'} · on {net.iface}
      </div>
      <div className="hint">You are {addressLine(net) || 'not addressed here'}</div>
      {net.reachableRanges && net.reachableRanges.length > 0 && (
        <div className="hint">
          Also reachable:{' '}
          {net.reachableRanges.map((r) => (r.viaPeer ? `${r.cidr} via ${r.viaPeer}` : r.cidr)).join(', ')}
        </div>
      )}
      {net.overlapping && (
        <div className="hint" style={{ color: 'var(--danger)' }}>
          Another network here covers the same range, so an address cannot say which one it belongs to.
          Netmaker cannot bridge overlapping ranges either.
        </div>
      )}

      {/* Applied the moment it is clicked, never on Save: a setting that decides
          who can reach this machine must not sit in an unsaved draft. The wording
          says what is true now rather than what the switch would do — the same
          convention the "accept from the local network" toggle uses. */}
      <div className="switch">
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            {net.trusted
              ? 'Accepting connections that arrive on this network.'
              : 'Nobody on this network can open a connection to you.'}
          </div>
        </div>
        <button
          className={`toggle ${net.trusted ? 'on' : ''}`}
          onClick={() => onTrust(net.key, !net.trusted)}
          aria-pressed={net.trusted}
          aria-label={`Accept connections over ${net.network || net.cidr || net.iface}`}
        />
      </div>
    </div>
  );
}

// A server we can ask for a node list.
//
// This is the row that makes cross-tenant work, so it says so: netclient only
// ever knows the networks this machine has joined, and somebody on another
// Netmaker server is invisible to it until their server is named here.
function ServerRow({ server, onToken, onRemove }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [entering, setEntering] = useState(!server.hasToken);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await onToken(server.id, token);
      if (res && res.ok === false) return setError(res.error || 'That token could not be stored.');
      setToken('');
      setEntering(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label>{server.label || server.id}</label>
      <div className="hint">{server.apiUrl}</div>

      {server.hasToken && !entering ? (
        <div className="hint">
          A token is stored.{' '}
          <button className="btn ghost" onClick={() => setEntering(true)}>
            Replace
          </button>{' '}
          <button
            className="btn ghost"
            onClick={() => onToken(server.id, '')}
            title="Forget the token; the server stays listed"
          >
            Forget token
          </button>
        </div>
      ) : (
        <>
          <input
            type="password"
            value={token}
            placeholder="Read token for this server"
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
          <div className="hint">
            Only ever read from. It is sealed by your system keychain and never shown again.
          </div>
          <div>
            <button className="btn" onClick={save} disabled={busy || !token.trim()}>
              {busy ? 'Saving…' : 'Save token'}
            </button>{' '}
            {server.hasToken && (
              <button className="btn ghost" onClick={() => setEntering(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}

      {error && (
        <div className="hint" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <div>
        <button className="btn danger" onClick={() => onRemove(server.id)}>
          Remove server
        </button>
      </div>
    </div>
  );
}

// Why a server could not be listed. Each needs a different fix, so each gets its
// own sentence rather than one shrug for all of them.
function serverProblem(reason) {
  switch (reason) {
    case 'no-token':
      return 'No token — this server’s peers are not listed.';
    case 'unauthorised':
      return 'The server refused this token.';
    case 'api-unreachable':
      return 'This server did not answer.';
    default:
      return null;
  }
}

export default function NetmakerSection({ enabled, onToggle }) {
  const [state, setState] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => api.netmakerStatus().then((s) => alive && setState(s));
    load();
    const off = api.onEvent((evt) => {
      if (evt.type === 'netmaker-status' || evt.type === 'netmaker-networks') load();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  async function check() {
    setChecking(true);
    try {
      await api.probeNetmaker();
      setState(await api.netmakerStatus());
    } finally {
      setChecking(false);
    }
  }

  const networks = (state && state.networks) || [];
  const servers = (state && state.servers) || [];
  const problems = new Map(((state && state.status && state.status.servers) || []).map((s2) => [s2.id, s2]));

  async function saveServers(next, binaryPath) {
    await api.setNetmakerServers(next, binaryPath);
    setState(await api.netmakerStatus());
  }

  async function setToken(id, token) {
    const res = await api.setNetmakerToken(id, token);
    setState(await api.netmakerStatus());
    return res;
  }
  // Nothing to say: one switch and one sentence. Everything below appears only
  // once there is something true to put in it.
  const quiet = !enabled && networks.length === 0;

  return (
    <>
      <div className="switch">
        <div>
          <div style={{ fontWeight: 500 }}>Find peers over Netmaker</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            Reads the networks netclient has joined, or a server you add. Netmaker is a self-hosted WireGuard
            mesh — two people on different servers meet by both joining one shared network.
          </div>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
          aria-label="Find peers over Netmaker"
        />
      </div>

      {!quiet && (
        <div className="field">
          <label>
            Networks{' '}
            <button className="btn ghost" onClick={check} disabled={checking} style={{ float: 'right' }}>
              {checking ? 'Checking…' : 'Check'}
            </button>
          </label>
          <div className="hint" role="status">
            {statusLine(state)}
          </div>
          {networks.length === 0 ? (
            <div className="empty-hint">
              No Netmaker network on this machine. One appears here once netclient has joined one.
            </div>
          ) : (
            networks.map((net) => (
              <NetworkRow
                key={net.key}
                net={net}
                onTrust={async (key, on) => {
                  await api.setNetmakerTrusted(key, on);
                  setState(await api.netmakerStatus());
                }}
              />
            ))
          )}
        </div>
      )}

      {!quiet && (
        <div className="field">
          <label>Servers</label>
          <div className="hint">
            netclient only knows the networks this machine has joined. To see somebody on another Netmaker
            server — another account, another organisation — add that server here with a read token, and their
            networks appear alongside your own.
          </div>

          {servers.length === 0 ? (
            <div className="empty-hint">No servers added.</div>
          ) : (
            servers.map((srv) => (
              <div key={srv.id}>
                <ServerRow
                  server={srv}
                  onToken={setToken}
                  onRemove={(id) => {
                    // Removing a server discards a stored token, which is not
                    // recoverable — so it is asked about first.
                    const named = srv.label || srv.apiUrl || id;
                    if (!window.confirm(`Remove ${named}? Its stored token is discarded.`)) return;
                    saveServers(servers.filter((s2) => s2.id !== id).map(({ hasToken, ...rest }) => rest));
                  }}
                />
                {problems.has(srv.id) && (
                  <div className="hint" role="status" style={{ color: 'var(--danger)' }}>
                    {serverProblem(problems.get(srv.id).reason)}
                  </div>
                )}
              </div>
            ))
          )}

          <AddServer
            onAdd={(entry) => saveServers([...servers.map(({ hasToken, ...rest }) => rest), entry])}
          />
        </div>
      )}

      {!quiet && <PeerCode />}
    </>
  );
}

// Handing somebody your address and the key to expect.
//
// The sentence under the code is the important part. A long opaque string trains
// people to treat it as a password; this one is not, and saying so is cheaper
// than the support thread that follows from not saying it.
function PeerCode() {
  const [code, setCode] = useState(null);
  const [error, setError] = useState(null);
  const [paste, setPaste] = useState('');
  const [result, setResult] = useState(null);

  async function make() {
    setError(null);
    const res = await api.createPeerCode(null);
    if (!res || res.ok === false) return setError((res && res.error) || 'A code could not be made.');
    setCode(res.code);
  }

  async function redeem() {
    setResult(null);
    const res = await api.redeemPeerCode(paste.trim());
    if (!res || res.ok === false) {
      return setResult({ bad: true, text: (res && res.error) || 'That code could not be read.' });
    }
    setPaste('');
    setResult({
      bad: false,
      text: `Looking for ${res.peer.name || 'them'}. They will appear once they answer, and be marked verified if their key matches the code.`,
    });
  }

  return (
    <div className="field">
      <label>Your code</label>
      <div className="hint">
        Hand this to somebody on a network you share, and they can find you. It says where to reach you and
        which key to expect — <strong>it is not a password</strong>, it gives away nothing, and it lets nobody
        in on its own.
      </div>

      {code ? (
        <>
          <input readOnly value={code} onFocus={(e) => e.target.select()} />
          <div>
            <button className="btn" onClick={() => navigator.clipboard.writeText(code)}>
              Copy
            </button>
          </div>
        </>
      ) : (
        <button className="btn ghost" onClick={make}>
          Make a code
        </button>
      )}
      {error && (
        <div className="hint" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <label style={{ marginTop: 12 }}>Add someone from their code</label>
      <input
        value={paste}
        placeholder="lanchat1:…"
        onChange={(e) => setPaste(e.target.value)}
        spellCheck={false}
      />
      <div>
        <button className="btn" onClick={redeem} disabled={!paste.trim()}>
          Add
        </button>
      </div>
      {result && (
        <div className="hint" role="status" style={result.bad ? { color: 'var(--danger)' } : undefined}>
          {result.text}
        </div>
      )}
    </div>
  );
}

function AddServer({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [apiUrl, setUrl] = useState('');
  const [label, setLabel] = useState('');

  if (!open)
    return (
      <button className="btn ghost" onClick={() => setOpen(true)}>
        Add a server
      </button>
    );

  function add() {
    const url = apiUrl.trim();
    if (!url) return;
    // The id is the address, so the same server added twice replaces itself
    // rather than sitting in the list twice under two tokens.
    let id;
    try {
      id = new URL(url).host.toLowerCase();
    } catch {
      return;
    }
    onAdd({ id, apiUrl: url, label: label.trim() || null });
    setOpen(false);
    setUrl('');
    setLabel('');
  }

  return (
    <>
      <input
        value={apiUrl}
        placeholder="https://api.netmaker.example.com"
        onChange={(e) => setUrl(e.target.value)}
      />
      <input
        value={label}
        placeholder="A name for it (optional)"
        onChange={(e) => setLabel(e.target.value)}
      />
      <div>
        <button className="btn" onClick={add} disabled={!apiUrl.trim()}>
          Add
        </button>{' '}
        <button className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </>
  );
}
