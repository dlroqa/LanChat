import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatPane from './components/ChatPane.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import IncomingCall from './components/IncomingCall.jsx';
import ProfileModal from './components/ProfileModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AddPeerModal from './components/AddPeerModal.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import { CallManager } from './lib/rtc.js';
import { Ringer, playNotification } from './lib/sounds.js';
import ConnectionPanel from './components/ConnectionPanel.jsx';
import PttBar from './components/PttBar.jsx';
import { PttManager, attachPttKey, defaultPttKey } from './lib/ptt.js';

const api = window.lanchat;

export default function App() {
  const [self, setSelf] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [config, setConfig] = useState({ iceServers: [], enableTailscale: true, enableLan: true });
  const [peers, setPeers] = useState([]);
  const [tailnet, setTailnet] = useState([]);
  const [tailnetStatus, setTailnetStatus] = useState({ ok: true, reason: null });
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState({}); // peerId -> [msg]
  const [typing, setTyping] = useState({});
  const [unread, setUnread] = useState({});
  const [progress, setProgress] = useState({});
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null); // 'profile' | 'settings' | 'addpeer'
  const [firstRun, setFirstRun] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [call, setCall] = useState({ status: 'idle' });
  const [linkStats, setLinkStats] = useState({}); // peerId -> stats
  const [callFullscreen, setCallFullscreen] = useState(false);
  const [ptt, setPtt] = useState({ transmitting: false, connecting: false, talkers: [], inboundStreams: [] });
  const [agentStatus, setAgentStatus] = useState({}); // agentId -> {status, detail, streaming}
  const [approvals, setApprovals] = useState({}); // agentId -> pending approval request
  const [update, setUpdate] = useState(null); // newer release found at startup
  const [queued, setQueued] = useState({}); // peerId -> messages waiting to send

  const configRef = useRef(config);
  const selectedRef = useRef(selectedId);
  const knownPeers = useRef({});
  const peersRef = useRef([]);
  const typingTimers = useRef({});
  const callRef = useRef(null);
  const ringerRef = useRef(null);
  const pttRef = useRef(null);
  const selectedPeerRef = useRef(null);
  const selfRef = useRef(null);
  const loadedPeers = useRef(new Set());

  configRef.current = config;
  selectedRef.current = selectedId;
  selfRef.current = self;

  // --- Call manager + ringer (created once) ---
  if (!callRef.current) {
    callRef.current = new CallManager({
      sendSignal: (peerId, signal) => api.sendSignal(peerId, signal),
      onState: (s) => setCall(s),
      getIceServers: () => configRef.current.iceServers || [],
      getSelfName: () => selfRef.current?.name || null,
      onError: (msg) => toast(msg, 'error'),
      getDevices: () => ({
        audioInputId: configRef.current.audioInputId || null,
        videoInputId: configRef.current.videoInputId || null,
      }),
    });
  }
  if (!ringerRef.current) ringerRef.current = new Ringer();
  if (!pttRef.current) {
    pttRef.current = new PttManager({
      sendSignal: (peerId, signal) => api.sendSignal(peerId, signal),
      onState: (s) => setPtt(s),
      getIceServers: () => configRef.current.iceServers || [],
      getDevices: () => ({ audioInputId: configRef.current.audioInputId || null }),
      onError: (msg) => toast(msg, 'error'),
    });
  }

  // Ring while a call is pending; stop the moment it connects or ends.
  useEffect(() => {
    const ringer = ringerRef.current;
    const opts = {
      ringtone: configRef.current.ringtone || 'classic',
      volume: configRef.current.ringtoneVolume ?? 0.8,
      customUrl: soundUrl(configRef.current.customRingtonePath),
    };
    if (call.status === 'incoming') ringer.start('incoming', opts);
    else if (call.status === 'outgoing') ringer.start('outgoing', opts);
    else ringer.stop();
  }, [call.status]);

  useEffect(() => {
    if (call.status === 'idle') setCallFullscreen(false);
  }, [call.status]);

  // Never leave a tone playing if the window closes mid-ring.
  useEffect(() => () => ringerRef.current?.stop(), []);

  // Hold-to-talk. Disabled during a normal call so the two cannot fight over
  // the microphone.
  useEffect(() => {
    const keyName = config.pttKey || defaultPttKey();
    return attachPttKey({
      keyName,
      customCode: config.pttCustomCode,
      isEnabled: () =>
        config.pttEnabled !== false &&
        call.status === 'idle' &&
        Boolean(selectedPeerRef.current && selectedPeerRef.current.online),
      onDown: () => pttRef.current.setTransmitting(true, selectedPeerRef.current),
      onUp: () => pttRef.current.setTransmitting(false),
    });
  }, [config.pttKey, config.pttCustomCode, config.pttEnabled, call.status]);

  useEffect(() => () => pttRef.current?.closeAll(), []);

  function toast(text, level = 'info') {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }

  function appendMessage(peerId, msg) {
    setMessages((prev) => {
      const list = prev[peerId] ? [...prev[peerId]] : [];
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...msg };
      else list.push(msg);
      return { ...prev, [peerId]: list };
    });
  }

  // --- Initial load ---
  useEffect(() => {
    (async () => {
      const state = await api.getState();
      setSelf(state.identity);
      setConfigured(state.configured);
      setConfig(state.config);
      setPeers(state.presence || []);
      if (!state.configured) {
        setFirstRun(true);
        setModal('profile');
      }
    })();
  }, []);

  // --- Event stream from main ---
  useEffect(() => {
    const off = api.onEvent((evt) => {
      const { type, payload } = evt;
      switch (type) {
        case 'presence':
          setPeers(payload);
          peersRef.current = payload;
          payload.forEach((p) => (knownPeers.current[p.id] = p));
          break;
        case 'tailnet-peers':
          setTailnet(payload);
          break;
        case 'outbox-counts':
          setQueued(payload);
          break;
        case 'tailnet-status':
          setTailnetStatus(payload);
          break;
        case 'link-stats':
          setLinkStats((m) => ({ ...m, [payload.peerId]: payload }));
          break;
        case 'identity':
          setSelf(payload);
          break;
        case 'select-peer':
          // Opened from the status-menu item.
          setSelectedId(payload);
          break;
        case 'start-call': {
          // Call shortcut from the status menu.
          const target =
            peersRef.current.find((p) => p.id === payload.peerId) || knownPeers.current[payload.peerId];
          if (!target || !target.online) {
            toast('That person is offline', 'error');
            break;
          }
          setSelectedId(payload.peerId);
          callRef.current
            .start(target, Boolean(payload.withVideo))
            .catch((err) => toast(`Cannot start call: ${err.message}`, 'error'));
          break;
        }
        case 'peer-hello':
          if (payload.identity) knownPeers.current[payload.peerId] = payload.identity;
          break;
        case 'chat':
          appendMessage(payload.peerId, payload);
          // The finished reply supersedes the streamed preview.
          if (payload.peerId.startsWith('agent:')) {
            setAgentStatus((s) => ({ ...s, [payload.peerId]: { ...s[payload.peerId], streaming: '' } }));
            setApprovals((a) => (a[payload.peerId] ? { ...a, [payload.peerId]: null } : a));
          }
          if (payload.direction === 'in') {
            const cfg = configRef.current;
            if (!cfg.muteNotifications) {
              playNotification(cfg.notificationSound || 'ping', {
                volume: cfg.notificationVolume ?? 0.7,
                customUrl: soundUrl(cfg.customNotificationPath),
              });
            }
            if (payload.peerId !== selectedRef.current) {
              setUnread((u) => ({ ...u, [payload.peerId]: (u[payload.peerId] || 0) + 1 }));
            }
          }
          break;
        case 'typing':
          setTyping((t) => ({ ...t, [payload.peerId]: payload.isTyping }));
          clearTimeout(typingTimers.current[payload.peerId]);
          if (payload.isTyping) {
            typingTimers.current[payload.peerId] = setTimeout(
              () => setTyping((t) => ({ ...t, [payload.peerId]: false })),
              4000
            );
          }
          break;
        case 'signal':
          // PTT rides its own channel so it never disturbs a normal call.
          if (payload.signal && payload.signal.channel === 'ptt') {
            if (configRef.current.pttAllowIncoming !== false) {
              pttRef.current.handleSignal(payload.peerId, payload.signal);
            }
          } else {
            callRef.current.handleSignal(payload.peerId, payload.signal);
          }
          break;
        case 'file-offer':
          // Placeholder bubble so incoming transfers show up with progress.
          appendMessage(payload.peerId, {
            id: payload.transferId,
            peerId: payload.peerId,
            direction: 'in',
            kind: 'file',
            file: { name: payload.name, size: payload.size, mime: payload.mime, path: null },
            ts: Date.now(),
            pending: true,
          });
          break;
        case 'file-progress': {
          const key = payload.transferId;
          const frac = payload.total ? payload.received / payload.total : 0;
          setProgress((p) => ({ ...p, [key]: frac }));
          break;
        }
        case 'agent-status':
          setAgentStatus((s) => ({ ...s, [payload.agentId]: payload }));
          if (payload.status === 'error') toast(`Agent: ${payload.detail}`, 'error');
          break;
        case 'agent-approval':
          // Never auto-answered — it sits until the local user decides.
          setApprovals((a) => ({ ...a, [payload.agentId]: payload }));
          setSelectedId(payload.agentId);
          break;
        case 'agent-delta':
          // Live typing; the authoritative reply arrives as a normal 'chat' event.
          setAgentStatus((s) => ({
            ...s,
            [payload.agentId]: { ...s[payload.agentId], streaming: (s[payload.agentId]?.streaming || '') + payload.delta },
          }));
          break;
        case 'update-available':
          // Suppressed for a release the user explicitly skipped, and while
          // first-run setup is still on screen.
          if (payload.latest !== configRef.current.skippedUpdateVersion) setUpdate(payload);
          break;
        case 'toast':
          toast(payload.text, payload.level);
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  // Mirror total unread onto the status-menu item and app badge.
  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
    api.setUnread(total);
  }, [unread]);

  // --- Load history when selecting a peer ---
  useEffect(() => {
    if (!selectedId) return;
    setUnread((u) => ({ ...u, [selectedId]: 0 }));
    if (loadedPeers.current.has(selectedId)) return;
    loadedPeers.current.add(selectedId);
    api.getHistory(selectedId).then((hist) => {
      setMessages((prev) => ({ ...prev, [selectedId]: mergeHistory(hist, prev[selectedId]) }));
    });
  }, [selectedId]);

  const selectedPeer = useMemo(() => {
    if (!selectedId) return null;
    const live = peers.find((p) => p.id === selectedId);
    const base = live || knownPeers.current[selectedId] || { id: selectedId, name: 'Unknown' };
    return { ...base, online: live ? live.online : false };
  }, [selectedId, peers]);

  const soundUrl = (path) =>
    path && selfRef.current
      ? `http://localhost:${selfRef.current.servicePort}/lanchat/preview?path=${encodeURIComponent(path)}`
      : null;

  selectedPeerRef.current = selectedPeer;

  const previewUrl = (path) =>
    path && self ? `http://localhost:${self.servicePort}/lanchat/preview?path=${encodeURIComponent(path)}` : null;

  // --- Actions ---
  async function saveProfile(profile) {
    const id = await api.setProfile(profile);
    setSelf(id);
    setConfigured(true);
    setFirstRun(false);
    setModal(null);
  }

  async function sendText(text) {
    if (!selectedId) return;
    const msg = await api.sendChat(selectedId, text);
    appendMessage(selectedId, msg);
    // Held locally and retried on reconnect. This machine has to still be
    // running for that to happen — there is no server to hold it for us.
    if (!msg.delivered) toast('Saved — it will send when they are back online', 'info');
  }

  async function attach() {
    if (!selectedId) return;
    await api.pickAndSendFile(selectedId);
  }

  // A recorded voice message travels as bytes; main writes it to disk and then
  // sends it through the ordinary file-transfer path.
  async function sendVoice(result, err) {
    if (err) {
      toast(`Cannot record: ${err.message}`, 'error');
      return;
    }
    if (!result || !selectedId) return;
    const buf = await result.blob.arrayBuffer();
    await api.sendVoice(selectedId, new Uint8Array(buf), result.ext);
  }

  function onTyping(active) {
    if (selectedId) api.sendTyping(selectedId, active);
  }

  async function addPeer(ip, port) {
    await api.addManualPeer(ip, port);
    toast(`Looking for LanChat at ${ip}:${port}…`);
  }

  async function saveSettings(patch) {
    const c = await api.setConfig(patch);
    setConfig(c);
    toast('Settings saved');
  }

  // Change mic/camera mid-call and remember it for future calls.
  async function switchDevice(key, deviceId) {
    setConfig((c) => ({ ...c, [key]: deviceId }));
    api.setConfig({ [key]: deviceId });
    if (!deviceId) return; // "System default" applies to the next call
    try {
      await callRef.current.switchDevice(key === 'videoInputId' ? 'video' : 'audio', deviceId);
    } catch (err) {
      toast(`Could not switch device: ${err.message}`, 'error');
    }
  }

  function startCall(withVideo) {
    if (!selectedPeer || !selectedPeer.online) return;
    callRef.current.start(selectedPeer, withVideo).catch((err) => toast(`Cannot start call: ${err.message}`, 'error'));
  }

  // --- Drag & drop files ---
  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (!selectedId) return;
    const paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean);
    if (paths.length) api.sendFilePaths(selectedId, paths);
  }

  const inCall = ['outgoing', 'connecting', 'in-call'].includes(call.status);
  const incoming = call.status === 'incoming';

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        if (selectedId) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <Sidebar
        self={self}
        peers={peers}
        tailnet={tailnet}
        tailnetStatus={tailnetStatus}
        selectedId={selectedId}
        unread={unread}
        queued={queued}
        showAddresses={config.showAddresses}
        onSelect={setSelectedId}
        onOpenProfile={() => setModal('profile')}
        onOpenSettings={() => setModal('settings')}
        onAddPeer={() => setModal('addpeer')}
        onRefresh={() => (api.refresh(), toast('Refreshing…'))}
      />

      <div className="chat-wrap">
        <ChatPane
          peer={selectedPeer}
          messages={messages[selectedId] || []}
          typing={typing[selectedId]}
          progress={progress}
          approval={approvals[selectedId]}
          agentStream={agentStatus[selectedId]?.streaming}
          onApprove={(choice) => {
            const req = approvals[selectedId];
            if (!req) return;
            setApprovals((a) => ({ ...a, [selectedId]: null }));
            api.answerAgentApproval(selectedId, req.runId, choice);
          }}
          previewUrl={previewUrl}
          showAddresses={config.showAddresses}
          onSend={sendText}
          onAttach={attach}
          onVoice={sendVoice}
          onTyping={onTyping}
          onOpenFile={(p) => p && api.openFile(p)}
          onRevealFile={(p) => p && api.revealFile(p)}
          onVoiceCall={() => startCall(false)}
          onVideoCall={() => startCall(true)}
        />
        {dragOver && <div className="drop-overlay">Drop to send</div>}
      </div>

      {/* Incoming push-to-talk audio. Hidden: playback only, no controls. */}
      {ptt.inboundStreams.map(({ peerId, stream }) => (
        <PttAudio key={peerId} stream={stream} />
      ))}

      <aside className="side-panel">
        {inCall ? (
          <CallOverlay
            call={call}
            devices={{ audioInputId: config.audioInputId, videoInputId: config.videoInputId }}
            fullscreen={false}
            onToggleFullscreen={() => setCallFullscreen(true)}
            onHangup={() => callRef.current.hangup()}
            onToggleMute={() => callRef.current.toggleMute()}
            onToggleCamera={() => callRef.current.toggleCamera()}
            onSwitchDevice={switchDevice}
            onAudioStats={() => callRef.current.getAudioStats()}
          />
        ) : (
          <>
            {config.pttEnabled !== false && (
              <PttBar
                peer={selectedPeer}
                state={ptt}
                keyName={config.pttKey || defaultPttKey()}
                onHoldStart={() => pttRef.current.setTransmitting(true, selectedPeerRef.current)}
                onHoldEnd={() => pttRef.current.setTransmitting(false)}
              />
            )}
            <ConnectionPanel peer={selectedPeer} stats={linkStats[selectedId]} />
          </>
        )}
      </aside>

      {modal === 'profile' && (
        <ProfileModal self={self} firstRun={firstRun} onSave={saveProfile} onClose={() => setModal(null)} />
      )}
      {modal === 'settings' && (
        <SettingsModal
          config={config}
          self={self}
          peers={peers}
          soundUrl={soundUrl}
          onSave={saveSettings}
          onClose={() => setModal(null)}
        />
      )}
      {update && !firstRun && (
        <UpdatePrompt
          info={update}
          onClose={() => setUpdate(null)}
          onSkip={async () => {
            const version = update.latest;
            setUpdate(null);
            setConfig(await api.setConfig({ skippedUpdateVersion: version }));
            toast(`You will not be reminded about ${version} again`);
          }}
        />
      )}
      {modal === 'addpeer' && (
        <AddPeerModal
          defaultPort={self?.servicePort}
          tailnet={tailnet}
          peers={peers}
          onAdd={addPeer}
          onClose={() => setModal(null)}
        />
      )}

      {incoming && (
        <IncomingCall
          call={call}
          onAccept={() => callRef.current.accept().catch((err) => toast(`Cannot answer: ${err.message}`, 'error'))}
          onDecline={() => callRef.current.decline()}
        />
      )}
      {inCall && callFullscreen && (
        <CallOverlay
          call={call}
          devices={{ audioInputId: config.audioInputId, videoInputId: config.videoInputId }}
          fullscreen
          onToggleFullscreen={() => setCallFullscreen(false)}
          onHangup={() => callRef.current.hangup()}
          onToggleMute={() => callRef.current.toggleMute()}
          onToggleCamera={() => callRef.current.toggleCamera()}
          onSwitchDevice={switchDevice}
          onAudioStats={() => callRef.current.getAudioStats()}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// Plays an incoming push-to-talk stream. Mounted per talking peer.
function PttAudio({ stream }) {
  const ref = React.useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

// Merge persisted history with any live messages already received, dedup by id.
function mergeHistory(hist, live) {
  const map = new Map();
  for (const m of hist || []) map.set(m.id, m);
  for (const m of live || []) map.set(m.id, { ...map.get(m.id), ...m });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
