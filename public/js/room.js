// WeWatchy room client — fixed YT + mp4 sync, mesh cams, chat
const parts = location.pathname.split('/r/');
const roomId = (parts[1] || '').split('?')[0].split('/')[0];
const qs = new URLSearchParams(location.search);
let myName = qs.get('name') || localStorage.getItem('wewatchy_name') || '';
if (!myName) { myName = prompt('Enter your name:') || 'Guest'; }
myName = myName.slice(0, 30);
localStorage.setItem('wewatchy_name', myName);

const socket = io();
const statusEl = document.getElementById('status');
const roomNameEl = document.getElementById('roomName');
const onlineEl = document.getElementById('onlineCount');
const chatEl = document.getElementById('chat');
const chatInput = document.getElementById('chatInput');
const mp4 = document.getElementById('mp4-player');
const emptyState = document.getElementById('emptyState');
const ytWrap = document.getElementById('yt-wrap');
const actingEl = document.getElementById('nowActing');
const emojiLayer = document.getElementById('emojiLayer');
const toastEl = document.getElementById('toast');

let currentVideo = { type: 'none', url: '', youtubeId: '', time: 0, playing: false };
let isRemote = false;
let ytPlayer = null, ytReady = false, pendingYtId = null, pendingSync = null;
let lastYtTime = 0;

function toast(msg) {
  if (!toastEl) { alert(msg); return; }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ---------- robust YouTube ID parsing (all formats) ----------
function parseYouTubeId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input; // bare ID
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split(/[?/]/)[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const pathMatch = u.pathname.match(/\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (pathMatch) return pathMatch[2];
    }
  } catch { /* not a full URL, fall through */ }
  const m = input.match(/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function addChat(sender, text) {
  const d = document.createElement('div');
  d.className = 'm';
  d.innerHTML = `<b></b> <span></span>`;
  d.querySelector('b').textContent = sender + ':';
  d.querySelector('span').textContent = ' ' + text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function addSys(text) {
  const d = document.createElement('div');
  d.className = 'sys'; d.textContent = text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
}
function floatEmoji(emoji) {
  const s = document.createElement('span');
  s.textContent = emoji;
  s.style.left = (10 + Math.random() * 80) + '%';
  emojiLayer.appendChild(s);
  setTimeout(() => s.remove(), 2300);
}
function setActing(t) { actingEl.textContent = t; }

// ---------- YouTube API — FIXED race ----------
// Bug was: iframe_api in <head> fires onYouTubeIframeAPIReady BEFORE room.js loads,
// so ytReady stayed false forever and YT never played.
function markYTReady() {
  if (ytReady) return;
  if (window.YT && window.YT.Player) {
    ytReady = true;
    if (pendingYtId) { const id = pendingYtId; pendingYtId = null; createYT(id); }
    else if (pendingSync) { const p = pendingSync; pendingSync = null; applySync(p.v, p.action, p.by); }
  }
}
window.onYouTubeIframeAPIReady = markYTReady;
setInterval(markYTReady, 500); // catches early-fire case
// ensure API script exists (if adblock removed it, inject)
if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}
setTimeout(markYTReady, 1000);

function createYT(videoId) {
  if (!window.YT || !window.YT.Player) { pendingYtId = videoId; return; }
  ytReady = true;
  if (ytPlayer && ytPlayer.loadVideoById) {
    try { ytPlayer.loadVideoById(videoId); } catch { pendingYtId = videoId; }
    return;
  }
  try {
    ytPlayer = new YT.Player('youtube-player', {
      width: '100%', height: '100%', videoId,
      playerVars: { autoplay: 1, rel: 0, playsinline: 1 },
      events: {
        onStateChange: onYTState,
        onReady: (e) => {
          if (pendingSync) { const p = pendingSync; pendingSync = null; applySync(p.v, p.action, p.by); return; }
          try { if (currentVideo.playing) e.target.playVideo(); } catch {}
        },
        onError: (e) => toast('YouTube error ' + e.data + ' — try another video')
      }
    });
  } catch { pendingYtId = videoId; }
}
function onYTState(e) {
  if (isRemote || !window.YT) return;
  let t = 0;
  try { t = ytPlayer.getCurrentTime(); } catch {}
  if (e.data === YT.PlayerState.PLAYING) socket.emit('video-play', { roomId, time: t });
  else if (e.data === YT.PlayerState.PAUSED) socket.emit('video-pause', { roomId, time: t });
  else if (e.data === YT.PlayerState.CUED && currentVideo.playing) { try { ytPlayer.playVideo(); } catch {} }
}
setInterval(() => {
  if (!ytPlayer || !ytPlayer.getCurrentTime || currentVideo.type !== 'youtube' || isRemote) return;
  try {
    const t = ytPlayer.getCurrentTime();
    if (ytPlayer.getPlayerState && window.YT && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
      if (Math.abs(t - lastYtTime) > 2.5 && lastYtTime > 0) socket.emit('video-seek', { roomId, time: t });
    }
    lastYtTime = t;
  } catch {}
}, 1000);

// ---------- mp4 events ----------
mp4.addEventListener('play', () => { if (!isRemote && currentVideo.type === 'mp4') socket.emit('video-play', { roomId, time: mp4.currentTime }); });
mp4.addEventListener('pause', () => { if (!isRemote && currentVideo.type === 'mp4') socket.emit('video-pause', { roomId, time: mp4.currentTime }); });
mp4.addEventListener('seeked', () => { if (!isRemote && currentVideo.type === 'mp4') socket.emit('video-seek', { roomId, time: mp4.currentTime }); });

// ---------- show / sync ----------
function showVideo(v) {
  currentVideo = v;
  if (v.type === 'youtube' && v.youtubeId) {
    emptyState.style.display = 'none';
    try { mp4.pause(); } catch {}
    mp4.style.display = 'none'; mp4.removeAttribute('src'); mp4.load();
    ytWrap.style.display = 'block';
    createYT(v.youtubeId);
  } else if (v.type === 'mp4' && v.url) {
    emptyState.style.display = 'none'; ytWrap.style.display = 'none';
    try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch {}
    if (mp4.getAttribute('src') !== v.url) mp4.src = v.url;
    mp4.style.display = 'block';
  } else {
    emptyState.style.display = 'flex'; mp4.style.display = 'none'; ytWrap.style.display = 'none';
  }
}
function serverTime(v) {
  const elapsed = (Date.now() - (v.updatedAt || Date.now())) / 1000;
  return (Number(v.time) || 0) + (v.playing ? elapsed : 0);
}
async function applySync(v, action, by) {
  // if YT not ready yet, queue and retry after player ready
  if (v.type === 'youtube' && (!ytReady || !window.YT || !window.YT.Player)) {
    pendingSync = { v, action, by };
    showVideo(v);
    return;
  }
  if (v.type === 'youtube' && !ytPlayer) {
    pendingSync = { v, action, by };
    showVideo(v);
    // retry in 1.5s in case onReady didn't fire
    setTimeout(() => { if (pendingSync) { const p = pendingSync; pendingSync = null; applySync(p.v, p.action, p.by); } }, 1500);
    return;
  }
  isRemote = true;
  showVideo(v);
  const target = serverTime(v);
  try {
    if (v.type === 'youtube' && ytPlayer && ytPlayer.seekTo) {
      let cur = 0;
      try { cur = ytPlayer.getCurrentTime(); } catch {}
      if (Math.abs(cur - target) > 1.2) { try { ytPlayer.seekTo(target, true); } catch {} }
      if (v.playing) { try { ytPlayer.playVideo(); } catch {} }
      else { try { ytPlayer.pauseVideo(); } catch {} }
      lastYtTime = target;
    } else if (v.type === 'mp4') {
      try { if (Math.abs(mp4.currentTime - target) > 1.2) mp4.currentTime = target; } catch {}
      if (v.playing) await mp4.play().catch(() => {});
      else mp4.pause();
    }
  } catch {}
  if (action === 'change') { setActing(`${by || 'Someone'} changed the video 🍿`); toast(`${by || 'Someone'} loaded a video`); }
  else if (action === 'play') setActing(`${by || 'Someone'} played ▶`);
  else if (action === 'pause') setActing(`${by || 'Someone'} paused ⏸`);
  setTimeout(() => { isRemote = false; }, 700);
}
setInterval(() => {
  if (isRemote || currentVideo.type === 'none') return;
  socket.emit('video-request-state', { roomId });
}, 8000);

// ---------- socket ----------
socket.on('connect', () => {
  statusEl.textContent = '● Connected as ' + myName;
  statusEl.classList.add('ok');
  socket.emit('join-room', { roomId, name: myName });
});
socket.on('room-state', (s) => {
  roomNameEl.textContent = (s.name || 'Room');
  if (s.video && s.video.type !== 'none') applySync(s.video, 'state', s.video.by);
  updateOnline(s.users || []);
});
socket.on('users-list', updateOnline);
function updateOnline(users) {
  onlineEl.textContent = `${users.length || 1} online`;
  document.getElementById('faceCount').textContent = `${users.length || 1}`;
}
socket.on('system-msg', (m) => addSys(m.text));
socket.on('chat-receive', (m) => addChat(m.sender, m.text));
socket.on('reaction-receive', (m) => { floatEmoji(m.emoji); });
socket.on('video-sync', ({ video, action }) => applySync(video, action, video.by));
socket.on('room-full', () => toast('Room is full (12 max)'));

document.getElementById('sendBtn').onclick = sendChat;
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const t = chatInput.value.trim();
  if (!t) return;
  socket.emit('chat-send', { roomId, text: t });
  chatInput.value = '';
}
document.querySelectorAll('.reacts button').forEach(b => {
  b.onclick = () => { socket.emit('reaction-send', { roomId, emoji: b.dataset.emoji }); floatEmoji(b.dataset.emoji); };
});

// ---------- load video / upload ----------
document.getElementById('loadBtn').onclick = () => {
  const url = document.getElementById('videoUrl').value.trim();
  if (!url) { toast('Paste a YouTube or mp4 link first'); return; }
  const yid = parseYouTubeId(url);
  if (yid) {
    toast('Loading YouTube: ' + yid);
    socket.emit('video-change', { roomId, video: { type: 'youtube', url, youtubeId: yid } });
  } else if (/^https?:\/\/.+\.(mp4|webm|mov|m3u8)(\?.*)?$/i.test(url) || url.startsWith('/uploads/')) {
    socket.emit('video-change', { roomId, video: { type: 'mp4', url } });
  } else if (/^https?:\/\//i.test(url)) {
    // unknown http link — try as mp4 anyway
    socket.emit('video-change', { roomId, video: { type: 'mp4', url } });
  } else {
    toast('Not a valid YouTube or video link');
  }
};
document.getElementById('videoUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('loadBtn').click(); });

// quick-pick demo videos (proves YT works even if user link is bad)
document.querySelectorAll('[data-demo]').forEach(b => {
  b.onclick = () => {
    const yid = b.getAttribute('data-demo');
    socket.emit('video-change', { roomId, video: { type: 'youtube', url: 'https://youtu.be/' + yid, youtubeId: yid } });
  };
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  statusEl.textContent = '● Uploading ' + f.name + '…';
  const fd = new FormData();
  fd.append('videofile', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.url) {
      socket.emit('video-change', { roomId, video: { type: 'mp4', url: data.url } });
      toast('File shared with room ✔');
      statusEl.textContent = '● Connected as ' + myName;
    } else toast('Upload failed');
  } catch { toast('Upload failed'); statusEl.textContent = '● Connected as ' + myName; }
});
document.getElementById('playBtn').onclick = () => {
  if (currentVideo.type === 'youtube' && ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
  else mp4.play().catch(() => toast('Press play on the video once (browser autoplay block)'));
};
document.getElementById('pauseBtn').onclick = () => {
  if (currentVideo.type === 'youtube' && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
  else mp4.pause();
};
document.getElementById('syncBtn').onclick = () => { socket.emit('video-request-state', { roomId }); toast('Re-syncing…'); };

// ---------- invite / leave ----------
function copyInvite() {
  const link = location.href;
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Invite link copied 🎉')).catch(() => prompt('Copy this link:', link));
  else prompt('Copy this link:', link);
}
document.getElementById('copyBtn').onclick = copyInvite;
document.getElementById('copyBtn2').onclick = copyInvite;
document.getElementById('leaveBtn').onclick = () => location.href = '/';

// ---------- WebRTC mesh ----------
const facesEl = document.getElementById('faces');
const peers = new Map();
const peerNames = new Map();
let localStream = null, micOn = true, camOn = true;

function addVideo(socketId, name, stream, muted) {
  let box = document.getElementById('face-' + socketId);
  if (!box) {
    box = document.createElement('div');
    box.className = 'face'; box.id = 'face-' + socketId;
    box.innerHTML = `<video autoplay playsinline></video><div class="tag"></div>`;
    facesEl.appendChild(box);
    updateFaceGrid();
  }
  const v = box.querySelector('video');
  v.srcObject = stream; v.muted = !!muted;
  v.play().catch(() => {});
  box.querySelector('.tag').textContent = name;
}
function removeVideo(socketId) { document.getElementById('face-' + socketId)?.remove(); try { peers.get(socketId)?.close(); } catch {} peers.delete(socketId); updateFaceGrid(); }
function updateFaceGrid() {
  const n = facesEl.children.length;
  facesEl.style.gridTemplateColumns = n <= 1 ? '1fr' : n <= 2 ? '1fr 1fr' : '1fr 1fr';
}

async function initMedia() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    addSys('Camera/mic blocked — you can still watch + chat');
    return;
  }
  addVideo('local', myName + ' (you)', localStream, true);
}

function makePeer(remoteId, initiator) {
  if (peers.has(remoteId)) return peers.get(remoteId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peers.set(remoteId, pc);
  if (localStream) localStream.getTracks().forEach(t => { try { pc.addTrack(t, localStream); } catch {} });
  pc.ontrack = (e) => addVideo(remoteId, peerNames.get(remoteId) || 'Friend', e.streams[0], false);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc-ice', { to: remoteId, candidate: e.candidate }); };
  (async () => {
    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { to: remoteId, sdp: pc.localDescription });
      } catch {}
    }
  })();
  return pc;
}

socket.on('all-users', async (users) => {
  users.forEach(u => peerNames.set(u.socketId, u.name));
  await initMedia();
  users.forEach(u => makePeer(u.socketId, true));
});
socket.on('user-joined', async ({ socketId, name }) => {
  peerNames.set(socketId, name);
  addSys(name + ' joined');
  if (!localStream) await initMedia();
  if (localStream) makePeer(socketId, false);
});
socket.on('user-left', ({ socketId, name }) => { removeVideo(socketId); if (name) addSys(name + ' left'); });
socket.on('webrtc-offer', async ({ from, fromName, sdp }) => {
  peerNames.set(from, fromName || peerNames.get(from) || 'Friend');
  if (!localStream) await initMedia();
  const pc = makePeer(from, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('webrtc-answer', { to: from, sdp: pc.localDescription });
  } catch {}
});
socket.on('webrtc-answer', async ({ from, sdp }) => {
  const pc = peers.get(from);
  if (pc) try { await pc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch {}
});
socket.on('webrtc-ice', async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (pc && candidate) try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});

function toggleMic() {
  micOn = !micOn;
  try { localStream?.getAudioTracks().forEach(t => t.enabled = micOn); } catch {}
  document.getElementById('micBtn').classList.toggle('off', !micOn);
  document.getElementById('micBtn').querySelector('span').textContent = micOn ? 'Mute' : 'Unmute';
  document.getElementById('micBtn2').textContent = micOn ? '🎤' : '🔇';
}
function toggleCam() {
  camOn = !camOn;
  try { localStream?.getVideoTracks().forEach(t => t.enabled = camOn); } catch {}
  document.getElementById('camBtn').classList.toggle('off', !camOn);
  document.getElementById('camBtn').querySelector('span').textContent = camOn ? 'Cam off' : 'Cam on';
  document.getElementById('camBtn2').textContent = camOn ? '📷' : '🚫';
}
document.getElementById('micBtn').onclick = toggleMic;
document.getElementById('micBtn2').onclick = toggleMic;
document.getElementById('camBtn').onclick = toggleCam;
document.getElementById('camBtn2').onclick = toggleCam;
