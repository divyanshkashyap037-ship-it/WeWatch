import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Mic, MicOff, Video, VideoOff, Link2, Play, Pause, RefreshCw, Send, FolderUp, Settings, Crown, Lock } from 'lucide-react';
import EmojiReaction, { EMOJI_MAP } from '../components/EmojiReaction.jsx';
import { parseYouTubeId, cn } from '../lib/utils.js';

const DEMOS = [
  { label: 'Demo 1', id: 'dQw4w9WgXcQ' },
  { label: 'Big Buck Bunny', id: 'aqz-KE-bpKQ' },
  { label: 'Demo 3', id: 'eRsGyueVLvQ' }
];

function FaceVideo({ stream, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) { ref.current.srcObject = stream || null; ref.current.play().catch(() => {}); }
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={!!muted} className="h-full w-full object-cover" />;
}

const charFor = (name) => EMOJI_MAP[name] || name;

// stable per-user color (Insta-style name tint + avatar)
function colorFor(name) {
  let h = 0;
  const s = (name || '?').toString();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 75%, 65%)`;
}

function fmtTime(at) {
  try {
    return new Date(at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function Room() {
  const { roomId } = useParams();
  const [qs] = useSearchParams();
  const [myName] = useState(() => {
    const n = qs.get('name') || localStorage.getItem('wewatchy_name') || 'Guest';
    localStorage.setItem('wewatchy_name', n.slice(0, 30));
    return n.slice(0, 30);
  });

  const [roomName, setRoomName] = useState('Movie Night');
  const [users, setUsers] = useState([]);
  const [msgs, setMsgs] = useState([]);
  const [video, setVideo] = useState({ type: 'none', url: '', youtubeId: '', time: 0, playing: false });
  const [acting, setActing] = useState('Nothing playing yet');
  const [toast, setToast] = useState('');
  const [url, setUrl] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [faces, setFaces] = useState([]);
  const [floats, setFloats] = useState([]);
  const [myId, setMyId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [hostName, setHostName] = useState('');
  const [controlMode, setControlMode] = useState('all');
  const [showSettings, setShowSettings] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');

  const socketRef = useRef(null);
  const mp4Ref = useRef(null);
  const ytContainerRef = useRef(null);
  const ytPlayer = useRef(null);
  const ytReady = useRef(false);
  const pendingYtId = useRef(null);
  const pendingSync = useRef(null);
  const isRemote = useRef(false);
  const lastYtTime = useRef(0);
  const localStream = useRef(null);
  const peers = useRef(new Map());
  const peerNames = useRef(new Map());
  const iceServers = useRef([{ urls: 'stun:stun.l.google.com:19302' }]);
  const videoRef = useRef(video);
  videoRef.current = video;
  const chatBoxRef = useRef(null);
  const toastT = useRef(null);

  const showToast = useCallback((m) => {
    setToast(m);
    clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const pushSys = useCallback((text) => setMsgs((p) => [...p.slice(-99), { kind: 'sys', text }]), []);
  const pushMsg = useCallback((sender, text, socketId, at) => {
    setMsgs((p) => [...p.slice(-99), { kind: 'msg', sender, text, socketId, at: at || Date.now() }]);
  }, []);
  const floatChar = useCallback((char) => {
    const id = Date.now() + Math.random();
    setFloats((p) => [...p.slice(-19), { id, char, left: 10 + Math.random() * 80 }]);
    setTimeout(() => setFloats((p) => p.filter((f) => f.id !== id)), 2300);
  }, []);

  useEffect(() => { chatBoxRef.current?.scrollTo({ top: 99999 }); }, [msgs]);

  // ---------- YT API ready (race-fixed) ----------
  const createYT = useCallback((videoId) => {
    if (!window.YT || !window.YT.Player || !ytContainerRef.current) { pendingYtId.current = videoId; return; }
    ytReady.current = true;
    if (ytPlayer.current && typeof ytPlayer.current.loadVideoById === 'function') {
      try { ytPlayer.current.loadVideoById(videoId); return; } catch { pendingYtId.current = videoId; }
    }
    try {
      ytContainerRef.current.innerHTML = '<div id="yt-player-target" style="width:100%;height:100%;"></div>';
      ytPlayer.current = new window.YT.Player('yt-player-target', {
        width: '100%', height: '100%', videoId,
        host: 'https://www.youtube.com',
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, enablejsapi: 1, origin: window.location.origin },
        events: {
          onStateChange: (e) => {
            if (isRemote.current) return;
            let t = 0;
            try { t = ytPlayer.current.getCurrentTime(); } catch {}
            if (e.data === window.YT.PlayerState.PLAYING) socketRef.current?.emit('video-play', { roomId, time: t });
            else if (e.data === window.YT.PlayerState.PAUSED) socketRef.current?.emit('video-pause', { roomId, time: t });
          },
          onReady: (e) => {
            if (pendingSync.current) { const p = pendingSync.current; pendingSync.current = null; applySync(p.v, p.action, p.by); return; }
            try { if (videoRef.current.playing) e.target.playVideo(); } catch {}
          },
          onError: (e) => showToast('YouTube error ' + e.data)
        }
      });
    } catch { pendingYtId.current = videoId; }
    // eslint-disable-next-line
  }, [roomId]);

  const applySync = useCallback((v, action, by) => {
    if (v.type === 'youtube' && (!ytReady.current || !window.YT?.Player)) {
      pendingSync.current = { v, action, by };
      setVideo(v);
      createYT(v.youtubeId);
      return;
    }
    if (v.type === 'youtube' && !ytPlayer.current) {
      pendingSync.current = { v, action, by };
      setVideo(v);
      createYT(v.youtubeId);
      setTimeout(() => {
        if (pendingSync.current) { const p = pendingSync.current; pendingSync.current = null; applySync(p.v, p.action, p.by); }
      }, 1500);
      return;
    }
    isRemote.current = true;
    setVideo(v);
    const target = (Number(v.time) || 0) + (v.playing ? (Date.now() - (v.updatedAt || Date.now())) / 1000 : 0);
    try {
      if (v.type === 'youtube') {
        let cur = 0;
        try { cur = ytPlayer.current.getCurrentTime(); } catch {}
        if (Math.abs(cur - target) > 1.2) { try { ytPlayer.current.seekTo(target, true); } catch {} }
        if (v.playing) { try { ytPlayer.current.playVideo(); } catch {} }
        else { try { ytPlayer.current.pauseVideo(); } catch {} }
        lastYtTime.current = target;
      } else if (v.type === 'mp4') {
        const el = mp4Ref.current;
        if (el) {
          if (Math.abs(el.currentTime - target) > 1.2) { try { el.currentTime = target; } catch {} }
          if (v.playing) el.play().catch(() => {});
          else el.pause();
        }
      }
    } catch {}
    if (action === 'change') { setActing(`${by || 'Someone'} changed the video`); showToast(`${by || 'Someone'} loaded a video`); }
    else if (action === 'play') setActing(`${by || 'Someone'} played`);
    else if (action === 'pause') setActing(`${by || 'Someone'} paused`);
    setTimeout(() => { isRemote.current = false; }, 700);
    // eslint-disable-next-line
  }, [createYT, showToast]);

  // ---------- socket + webrtc ----------
  useEffect(() => {
    window.onYouTubeIframeAPIReady = () => {
      ytReady.current = true;
      if (pendingYtId.current) { const id = pendingYtId.current; pendingYtId.current = null; createYT(id); }
      else if (pendingSync.current) { const p = pendingSync.current; pendingSync.current = null; applySync(p.v, p.action, p.by); }
    };
    const poll = setInterval(() => {
      if (!ytReady.current && window.YT?.Player) {
        ytReady.current = true;
        if (pendingYtId.current) { const id = pendingYtId.current; pendingYtId.current = null; createYT(id); }
      }
    }, 500);

    const s = io();
    socketRef.current = s;

    // ICE config (TURN when deployed) before any peer connection is made
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => { if (cfg?.iceServers?.length) iceServers.current = cfg.iceServers; })
      .catch(() => {});

    const upsertFace = (id, name, stream, muted) =>
      setFaces((prev) => {
        const i = prev.findIndex((f) => f.id === id);
        const f = { id, name, stream, muted };
        if (i >= 0) { const n = [...prev]; n[i] = f; return n; }
        return [...prev, f];
      });
    const removeFace = (id) => setFaces((prev) => prev.filter((f) => f.id !== id));

    const initMedia = async () => {
      if (localStream.current) return;
      try {
        localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch { pushSys('Camera/mic blocked — you can still watch + chat'); return; }
      upsertFace('local', myName + ' (you)', localStream.current, true);
    };

    const makePeer = (remoteId, initiator) => {
      if (peers.current.has(remoteId)) return peers.current.get(remoteId);
      const pc = new RTCPeerConnection({ iceServers: iceServers.current });
      peers.current.set(remoteId, pc);
      if (localStream.current) localStream.current.getTracks().forEach((t) => { try { pc.addTrack(t, localStream.current); } catch {} });
      pc.ontrack = (e) => upsertFace(remoteId, peerNames.current.get(remoteId) || 'Friend', e.streams[0], false);
      pc.onicecandidate = (e) => { if (e.candidate) s.emit('webrtc-ice', { to: remoteId, candidate: e.candidate }); };
      (async () => {
        if (initiator) {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            s.emit('webrtc-offer', { to: remoteId, sdp: pc.localDescription });
          } catch {}
        }
      })();
      return pc;
    };

    s.on('connect', () => { setMyId(s.id); s.emit('join-room', { roomId, name: myName }); });
    s.on('room-state', (st) => {
      setRoomName(st.name || 'Room');
      setUsers(st.users || []);
      setControlMode(st.controlMode || 'all');
      if (st.hostId) setHostName((st.users || []).find((u) => u.socketId === st.hostId)?.name || '');
      if (st.video?.type !== 'none') applySync(st.video, 'state', st.video.by);
    });
    s.on('host-status', (h) => { setIsHost(!!h.isHost); setControlMode(h.controlMode || 'all'); });
    s.on('host-changed', (h) => {
      setHostName(h.hostName || '');
      setIsHost(h.hostId === s.id);
      if (h.hostId === s.id) showToast('You are now the host 👑');
    });
    s.on('control-mode', (m) => {
      setControlMode(m.mode);
      showToast(m.mode === 'host' ? 'Host locked video controls 🔒' : 'Everyone can control the video 🔓');
    });
    s.on('room-renamed', (m) => setRoomName(m.name));
    s.on('not-allowed', (m) => showToast(m.what || 'Not allowed'));
    s.on('users-list', setUsers);
    s.on('system-msg', (m) => pushSys(m.text));
    s.on('chat-receive', (m) => pushMsg(m.sender, m.text, m.socketId, m.at));
    s.on('reaction-receive', (m) => floatChar(charFor(m.char || m.emoji || m.name)));
    s.on('video-sync', ({ video: v, action }) => applySync(v, action, v.by));
    s.on('all-users', async (list) => {
      list.forEach((u) => peerNames.current.set(u.socketId, u.name));
      await initMedia();
      list.forEach((u) => makePeer(u.socketId, true));
    });
    s.on('user-joined', async ({ socketId, name }) => {
      peerNames.current.set(socketId, name);
      pushSys(name + ' joined');
      if (!localStream.current) await initMedia();
      if (localStream.current) makePeer(socketId, false);
    });
    s.on('user-left', ({ socketId, name }) => {
      try { peers.current.get(socketId)?.close(); } catch {}
      peers.current.delete(socketId);
      removeFace(socketId);
      if (name) pushSys(name + ' left');
    });
    s.on('webrtc-offer', async ({ from, fromName, sdp }) => {
      peerNames.current.set(from, fromName || 'Friend');
      if (!localStream.current) await initMedia();
      const pc = makePeer(from, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        s.emit('webrtc-answer', { to: from, sdp: pc.localDescription });
      } catch {}
    });
    s.on('webrtc-answer', async ({ from, sdp }) => {
      try { await peers.current.get(from)?.setRemoteDescription(new RTCSessionDescription(sdp)); } catch {}
    });
    s.on('webrtc-ice', async ({ from, candidate }) => {
      try { await peers.current.get(from)?.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    });

    // YT seek detection + drift re-sync
    const seekPoll = setInterval(() => {
      const p = ytPlayer.current;
      if (!p?.getCurrentTime || videoRef.current.type !== 'youtube' || isRemote.current) return;
      try {
        const t = p.getCurrentTime();
        if (p.getPlayerState?.() === window.YT?.PlayerState.PLAYING && Math.abs(t - lastYtTime.current) > 2.5 && lastYtTime.current > 0)
          s.emit('video-seek', { roomId, time: t });
        lastYtTime.current = t;
      } catch {}
    }, 1000);
    const drift = setInterval(() => {
      if (!isRemote.current && videoRef.current.type !== 'none') s.emit('video-request-state', { roomId });
    }, 8000);

    // mp4 native events
    const el = mp4Ref.current;
    const onPlay = () => { if (!isRemote.current && videoRef.current.type === 'mp4') s.emit('video-play', { roomId, time: el.currentTime }); };
    const onPause = () => { if (!isRemote.current && videoRef.current.type === 'mp4') s.emit('video-pause', { roomId, time: el.currentTime }); };
    const onSeek = () => { if (!isRemote.current && videoRef.current.type === 'mp4') s.emit('video-seek', { roomId, time: el.currentTime }); };
    el?.addEventListener('play', onPlay);
    el?.addEventListener('pause', onPause);
    el?.addEventListener('seeked', onSeek);

    return () => {
      clearInterval(poll); clearInterval(seekPoll); clearInterval(drift);
      el?.removeEventListener('play', onPlay);
      el?.removeEventListener('pause', onPause);
      el?.removeEventListener('seeked', onSeek);
      peers.current.forEach((pc) => { try { pc.close(); } catch {} });
      localStream.current?.getTracks().forEach((t) => t.stop());
      s.disconnect();
    };
    // eslint-disable-next-line
  }, [roomId]);

  // keep mp4 src in sync with state
  useEffect(() => {
    const el = mp4Ref.current;
    if (!el) return;
    if (video.type === 'mp4' && video.url && el.getAttribute('src') !== video.url) el.src = video.url;
    if (video.type !== 'mp4' && el.getAttribute('src')) { try { el.pause(); } catch {} el.removeAttribute('src'); el.load(); }
    if (video.type === 'youtube' && video.youtubeId) {
      if (!ytPlayer.current) createYT(video.youtubeId);
      else if (ytPlayer.current.loadVideoById) { try { ytPlayer.current.loadVideoById(video.youtubeId); } catch {} }
    }
  }, [video.type, video.url, video.youtubeId, createYT]);

  const [draft, setDraft] = useState('');
  const sendChat = () => {
    const t = draft.trim();
    if (!t) return;
    socketRef.current?.emit('chat-send', { roomId, text: t });
    setDraft('');
  };

  const locked = controlMode === 'host' && !isHost;

  const loadUrl = () => {
    if (locked) return showToast('Video controls are locked by the host 🔒');
    const v = url.trim();
    if (!v) return showToast('Paste a YouTube or video link first');
    const yid = parseYouTubeId(v);
    if (yid) { showToast('Loading YouTube: ' + yid); socketRef.current?.emit('video-change', { roomId, video: { type: 'youtube', url: v, youtubeId: yid } }); }
    else socketRef.current?.emit('video-change', { roomId, video: { type: 'mp4', url: v } });
  };

  const changeVideo = (vid) => {
    if (locked) return showToast('Video controls are locked by the host 🔒');
    socketRef.current?.emit('video-change', { roomId, video: { type: 'youtube', url: 'https://youtu.be/' + vid, youtubeId: vid } });
  };

  const uploadFile = async (f) => {
    if (!f) return;
    if (locked) return showToast('Video controls are locked by the host 🔒');
    showToast('Uploading ' + f.name + '…');
    const fd = new FormData();
    fd.append('videofile', f);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.url) { socketRef.current?.emit('video-change', { roomId, video: { type: 'mp4', url: data.url } }); showToast('File shared ✔'); }
      else showToast('Upload failed');
    } catch { showToast('Upload failed'); }
  };

  const saveControlMode = (mode) => {
    socketRef.current?.emit('set-control-mode', { roomId, mode });
  };
  const saveRoomName = () => {
    const n = renameDraft.trim();
    if (!n) return;
    socketRef.current?.emit('rename-room', { roomId, name: n });
    setRenameDraft('');
  };
  const copyInvite = () => {
    const link = window.location.href;
    navigator.clipboard?.writeText(link).then(() => showToast('Invite link copied 🎉')).catch(() => prompt('Copy this link:', link));
  };

  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    try { localStream.current?.getAudioTracks().forEach((t) => (t.enabled = next)); } catch {}
  };
  const toggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    try { localStream.current?.getVideoTracks().forEach((t) => (t.enabled = next)); } catch {}
  };

  return (
    <main className="mx-auto max-w-6xl px-4 pb-24">
      {toast && (
        <div className="fixed left-1/2 top-20 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-[#1c1c1e] px-4 py-2 text-sm">{toast}</div>
      )}
      <div className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur">
        <div>
          <div className="flex items-center gap-1.5 font-bold">
            🍿 {roomName}
            {isHost && <span className="flex items-center gap-0.5 rounded-full bg-[#FFB020]/15 px-2 py-0.5 text-xs font-semibold text-[#FFB020]"><Crown className="size-3" /> Host</span>}
            {locked && <span className="flex items-center gap-0.5 rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/60"><Lock className="size-3" /> Host controls</span>}
          </div>
          <div className="text-xs text-white/50">{users.length || 1} online · {acting}{hostName && !isHost ? ` · host: ${hostName}` : ''}</div>
        </div>
        <div className="flex gap-2">
          {isHost && (
            <button onClick={() => { setRenameDraft(roomName); setShowSettings(true); }} title="Host settings"
              className="rounded-xl border border-white/10 bg-white/10 p-2 hover:bg-white/15">
              <Settings className="size-4" />
            </button>
          )}
          <button onClick={copyInvite} className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm hover:bg-white/15">
            <Link2 className="size-4" /> Invite
          </button>
          <Link to="/" className="rounded-xl px-3 py-2 text-sm text-white/60 hover:text-white">Leave</Link>
        </div>
      </div>

      {showSettings && isHost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setShowSettings(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#1c1c1e] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="font-bold">👑 Host settings</div>
              <button onClick={() => setShowSettings(false)} className="text-white/50 hover:text-white">✕</button>
            </div>
            <div className="mt-4 text-xs text-white/50">ROOM NAME</div>
            <div className="mt-1 flex gap-2">
              <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} maxLength={60}
                className="flex-1 rounded-xl border border-white/10 bg-black/50 px-3 py-2 outline-none" />
              <button onClick={saveRoomName} className="rounded-xl bg-[#FF4D00] px-4 text-sm font-semibold">Save</button>
            </div>
            <div className="mt-4 text-xs text-white/50">WHO CAN CONTROL THE VIDEO</div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button onClick={() => saveControlMode('all')}
                className={cn('rounded-xl border px-3 py-2.5 text-sm font-semibold', controlMode !== 'host' ? 'border-[#FF4D00] bg-[#FF4D00]/15 text-white' : 'border-white/10 bg-white/5 text-white/60')}>
                Everyone
              </button>
              <button onClick={() => saveControlMode('host')}
                className={cn('rounded-xl border px-3 py-2.5 text-sm font-semibold', controlMode === 'host' ? 'border-[#FF4D00] bg-[#FF4D00]/15 text-white' : 'border-white/10 bg-white/5 text-white/60')}>
                Host only 🔒
              </button>
            </div>
            <div className="mt-3 text-xs text-white/40">Locked controls are enforced for every device in the room.</div>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
        <section>
          <div className="flex gap-2 rounded-2xl border border-white/10 bg-white/5 p-2">
            <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadUrl()}
              placeholder={locked ? 'Locked — host controls the video 🔒' : 'YouTube or mp4 link…'}
              disabled={locked}
              className="flex-1 bg-transparent px-2 outline-none placeholder:text-white/25 disabled:opacity-50" />
            <button onClick={loadUrl} disabled={locked}
              className="rounded-xl bg-[#FF4D00] px-4 py-2 text-sm font-semibold disabled:opacity-40">Load</button>
            <label className="flex cursor-pointer items-center gap-1 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm">
              <FolderUp className="size-4" /> File<input type="file" accept="video/*,.mkv,.avi,.mov" hidden onChange={(e) => uploadFile(e.target.files[0])} />
            </label>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-white/50">
            <span>Try:</span>
            {DEMOS.map((d) => (
              <button key={d.id} onClick={() => changeVideo(d.id)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 hover:bg-white/10">{d.label}</button>
            ))}
          </div>

          <div className="relative mt-3 aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black">
            <div className={cn('absolute inset-0', video.type === 'youtube' ? 'block' : 'hidden')}>
              <div ref={ytContainerRef} className="h-full w-full" />
            </div>
            <video ref={mp4Ref} controls playsInline preload="auto" className={cn('absolute inset-0 h-full w-full', video.type === 'mp4' ? 'block' : 'hidden')} />
            {video.type === 'none' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/40">
                <div className="text-5xl">🍿</div>
                <div className="font-semibold text-white">Nothing playing yet</div>
                <div className="text-sm">Paste a link above and hit Load.</div>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              {floats.map((f) => (
                <span key={f.id} className="absolute bottom-2 animate-bounce text-3xl" style={{ left: f.left + '%' }}>{f.char}</span>
              ))}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => { try { ytPlayer.current?.playVideo?.(); } catch {} mp4Ref.current?.play().catch(() => {}); }} className="rounded-xl border border-white/10 bg-white/10 p-2"><Play className="size-4" /></button>
            <button onClick={() => { try { ytPlayer.current?.pauseVideo?.(); } catch {} mp4Ref.current?.pause(); }} className="rounded-xl border border-white/10 bg-white/10 p-2"><Pause className="size-4" /></button>
            <button onClick={() => socketRef.current?.emit('video-request-state', { roomId })} className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm"><RefreshCw className="size-4" /> Sync</button>
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="text-sm font-bold">🎥 Faces <span className="font-normal text-white/40">{faces.length} in room</span></div>
            <div className={cn('mt-2 grid gap-2', faces.length <= 1 ? 'grid-cols-1' : 'grid-cols-2')}>
              {faces.map((f) => (
                <div key={f.id} className="relative aspect-[4/3] overflow-hidden rounded-xl bg-black">
                  <FaceVideo stream={f.stream} muted={f.muted} />
                  <div className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-2 py-0.5 text-xs">{f.name}</div>
                </div>
              ))}
              {faces.length === 0 && <div className="rounded-xl bg-black/40 p-4 text-sm text-white/40">Joining camera…</div>}
            </div>
            <div className="mt-2 flex gap-2">
              <button onClick={toggleMic} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/10 py-2 text-sm">
                {micOn ? <Mic className="size-4" /> : <MicOff className="size-4" />} {micOn ? 'Mute' : 'Unmute'}
              </button>
              <button onClick={toggleCam} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-white/10 bg-white/10 py-2 text-sm">
                {camOn ? <Video className="size-4" /> : <VideoOff className="size-4" />} {camOn ? 'Cam off' : 'Cam on'}
              </button>
            </div>
          </div>

          <div className="flex min-h-[300px] flex-1 flex-col rounded-2xl border border-white/10 bg-white/5 p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold">💬 Chat</div>
              <EmojiReaction size="sm" onReact={(name) => { socketRef.current?.emit('reaction-send', { roomId, emoji: name }); floatChar(charFor(name)); }} />
            </div>
            <div ref={chatBoxRef} className="mt-2 max-h-[340px] flex-1 space-y-1 overflow-y-auto rounded-xl bg-black/40 p-3">
              {msgs.length === 0 && <div className="py-6 text-center text-sm text-white/30">Say hi to your friends 👋</div>}
              {msgs.map((m, i) => {
                if (m.kind === 'sys') return <div key={i} className="py-1 text-center text-xs text-white/40">{m.text}</div>;
                const mine = m.socketId && myId && m.socketId === myId;
                const c = colorFor(m.sender);
                if (mine) {
                  return (
                    <div key={i} className="flex flex-col items-end">
                      <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-[#0095F6] px-3.5 py-2 text-[15px] text-white">{m.text}</div>
                      <div className="mt-0.5 text-[11px] text-white/35">{fmtTime(m.at)}</div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="flex items-end gap-1.5">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-black"
                      style={{ background: `linear-gradient(135deg, ${c}, #fff)` }}>
                      {(m.sender || '?').trim().charAt(0).toUpperCase()}
                    </div>
                    <div className="max-w-[80%]">
                      <div className="mb-0.5 ml-1 text-xs font-semibold" style={{ color: c }}>{m.sender}</div>
                      <div className="rounded-[20px] rounded-bl-md bg-[#262626] px-3.5 py-2 text-[15px] text-white">{m.text}</div>
                      <div className="ml-1 mt-0.5 text-[11px] text-white/35">{fmtTime(m.at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                placeholder="Message" maxLength={500} className="flex-1 rounded-xl border border-white/10 bg-black/50 px-3 py-2 outline-none placeholder:text-white/25" />
              <button onClick={sendChat} className="rounded-xl bg-[#FF4D00] p-2.5"><Send className="size-4" /></button>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
