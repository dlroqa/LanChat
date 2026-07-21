import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatPane from './components/ChatPane.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import IncomingCall from './components/IncomingCall.jsx';
import ProfileModal from './components/ProfileModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AddPeerModal from './components/AddPeerModal.jsx';
import { CallManager } from './lib/rtc.js';
import { Ringer, playNotification } from './lib/sounds.js';
import ConnectionPanel from './components/ConnectionPanel.jsx';

const api = window.lanchat;

export default function App() {
  const [self, setSelf] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [config, setConfig] = useState({ iceServers: [], enableTailscale: true, enableLan: true });
  const [peers, setPeers] = useState([]);
  const [tailnet, setTailnet] = useState([]);
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

  const configRef = useRef(config);
  const selectedRef = useRef(selectedId);
  const knownPeers = useRef({});
  const typingTimers = useRef({});
  const callRef = useRef(null);
  const ringerRef = useRef(null);
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
          payload.forEach((p) => (knownPeers.current[p.id] = p));
          break;
        case 'tailnet-peers':
          setTailnet(payload);
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
        case 'peer-hello':
          if (payload.identity) knownPeers.current[payload.peerId] = payload.identity;
          break;
        case 'chat':
          appendMessage(payload.peerId, payload);
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
          callRef.current.handleSignal(payload.peerId, payload.signal);
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
    if (!msg.delivered) toast('Message queued — peer appears offline', 'info');
  }

  async function attach() {
    if (!selectedId) return;
    await api.pickAndSendFile(selectedId);
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
        selectedId={selectedId}
        unread={unread}
        showAddresses={config.showAddresses}
        onSelect={setSelectedId}
        onOpenProfile={() => setModal('profile')}
        onOpenSettings={() => setModal('settings')}
        onAddPeer={() => setModal('addpeer')}
        onRefresh={() => (api.refresh(), toast('Refreshing…'))}
      />

      <div style={{ position: 'relative', minWidth: 0, display: 'flex' }}>
        <ChatPane
          peer={selectedPeer}
          messages={messages[selectedId] || []}
          typing={typing[selectedId]}
          progress={progress}
          previewUrl={previewUrl}
          showAddresses={config.showAddresses}
          onSend={sendText}
          onAttach={attach}
          onTyping={onTyping}
          onOpenFile={(p) => p && api.openFile(p)}
          onRevealFile={(p) => p && api.revealFile(p)}
          onVoiceCall={() => startCall(false)}
          onVideoCall={() => startCall(true)}
        />
        {dragOver && <div className="drop-overlay">Drop to send</div>}
      </div>

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
          <ConnectionPanel peer={selectedPeer} stats={linkStats[selectedId]} />
        )}
      </aside>

      {modal === 'profile' && (
        <ProfileModal self={self} firstRun={firstRun} onSave={saveProfile} onClose={() => setModal(null)} />
      )}
      {modal === 'settings' && (
        <SettingsModal
          config={config}
          self={self}
          soundUrl={soundUrl}
          onSave={saveSettings}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'addpeer' && (
        <AddPeerModal defaultPort={self?.servicePort} onAdd={addPeer} onClose={() => setModal(null)} />
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

// Merge persisted history with any live messages already received, dedup by id.
function mergeHistory(hist, live) {
  const map = new Map();
  for (const m of hist || []) map.set(m.id, m);
  for (const m of live || []) map.set(m.id, { ...map.get(m.id), ...m });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
