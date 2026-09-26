const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 1024);

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) app.use(express.static(clientDist));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---- uploads setup (local file watch) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 80);
    cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

// ---- in-memory rooms ----
// room = { id, name, createdAt, hostId, controlMode: 'all'|'host',
//          video: {type, url, youtubeId, time, playing, updatedAt, by}, users: Map(socketId -> {name}) }
const rooms = new Map();

// reaction names (React client) -> visible emoji (legacy clients just show m.emoji)
const REACTION_CHARS = {
  'smiling-face-with-hearts': '🥰',
  'star-struck': '🤩',
  'confused-face': '😕',
  'pleading-face': '🥺',
  'grinning-face-with-smiling-eyes': '😄'
};

function makeRoomId() {
  return crypto.randomBytes(3).toString('hex'); // 6 chars e.g. a3f9c1
}

function getRoomState(room) {
  return {
    id: room.id,
    name: room.name,
    video: room.video,
    hostId: room.hostId || null,
    controlMode: room.controlMode || 'all',
    users: [...room.users.entries()].map(([socketId, u]) => ({ socketId, name: u.name }))
  };
}

// ---- public deploy endpoints ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '0.2.0', uptimeSec: Math.floor(process.uptime()), rooms: rooms.size });
});

// ICE servers for WebRTC, driven by env so friends outside your WiFi can connect.
// TURN_URLS="turn:host:3478?transport=udp,turn:host:3478?transport=tcp" TURN_USERNAME=u TURN_CREDENTIAL=p
app.get('/api/config', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.json({ iceServers, turnConfigured: urls.length > 0, maxUploadMb: MAX_UPLOAD_MB });
});

// ---- REST API ----
app.post('/api/rooms', (req, res) => {
  const name = (req.body.name || 'Movie Night').toString().slice(0, 60);
  const id = makeRoomId();
  rooms.set(id, {
    id,
    name,
    createdAt: Date.now(),
    hostId: null, // first joiner becomes host
    controlMode: 'all',
    video: { type: 'none', url: '', youtubeId: '', time: 0, playing: false, updatedAt: Date.now(), by: 'host' },
    users: new Map()
  });
  res.json({ roomId: id, link: `/r/${id}` });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ exists: false });
  res.json({ exists: true, id: room.id, name: room.name, users: room.users.size });
});

app.post('/api/upload', upload.single('videofile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname });
});

// serve React SPA if built, else legacy static room page
app.get('/r/:roomId', (req, res) => {
  const spa = path.join(__dirname, 'client', 'dist', 'index.html');
  if (fs.existsSync(spa)) return res.sendFile(spa);
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});
app.get('/', (req, res, next) => {
  const spa = path.join(__dirname, 'client', 'dist', 'index.html');
  if (fs.existsSync(spa)) return res.sendFile(spa);
  next();
});

// ---- Socket.io: sync + chat + webrtc signaling ----
io.on('connection', (socket) => {
  // JOIN
  socket.on('join-room', ({ roomId, name }) => {
    roomId = (roomId || '').toString().trim();
    name = (name || 'Guest').toString().slice(0, 30);
    let room = rooms.get(roomId);
    // allow joining via link even if server restarted: auto-recreate
    if (!room) {
      room = {
        id: roomId, name: 'Movie Night', createdAt: Date.now(),
        hostId: null, controlMode: 'all',
        video: { type: 'none', url: '', youtubeId: '', time: 0, playing: false, updatedAt: Date.now(), by: 'system' },
        users: new Map()
      };
      rooms.set(roomId, room);
    }
    if (room.users.size >= 12) {
      socket.emit('room-full');
      return;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    room.users.set(socket.id, { name });
    // first joiner (or joiner when host slot is empty) becomes host
    let becameHost = false;
    if (!room.hostId || !room.users.has(room.hostId)) {
      room.hostId = socket.id;
      becameHost = true;
    }

    // send current state to joiner
    socket.emit('room-state', getRoomState(room));
    socket.emit('host-status', { isHost: room.hostId === socket.id, hostId: room.hostId, controlMode: room.controlMode || 'all' });
    // tell others
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name });
    io.to(roomId).emit('users-list', getRoomState(room).users);
    io.to(roomId).emit('system-msg', { text: `${name} joined`, at: Date.now() });
    if (becameHost) {
      io.to(roomId).emit('host-changed', { hostId: room.hostId, hostName: name });
      io.to(roomId).emit('system-msg', { text: `${name} is the host`, at: Date.now() });
    }

    // send existing users so new peer can initiate WebRTC offers
    const existing = [...room.users.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([socketId, u]) => ({ socketId, name: u.name }));
    socket.emit('all-users', existing);
  });

  // CHAT
  socket.on('chat-send', ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const msg = {
      sender: socket.data.name || 'Guest',
      socketId: socket.id,
      text: (text || '').toString().slice(0, 500),
      at: Date.now()
    };
    if (!msg.text.trim()) return;
    io.to(roomId).emit('chat-receive', msg);
  });

  socket.on('reaction-send', ({ roomId, emoji }) => {
    const raw = (emoji || '❤️').toString().slice(0, 40);
    io.to(roomId).emit('reaction-receive', {
      socketId: socket.id, sender: socket.data.name || 'Guest',
      name: raw,
      emoji: REACTION_CHARS[raw] || raw,
      char: REACTION_CHARS[raw] || raw
    });
  });

  // HOST SETTINGS
  function isHost(room, socketId) {
    return !!room && room.hostId === socketId;
  }

  socket.on('set-control-mode', ({ roomId, mode }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(room, socket.id)) {
      socket.emit('not-allowed', { what: 'Only the host can change control mode' });
      return;
    }
    room.controlMode = mode === 'host' ? 'host' : 'all';
    io.to(roomId).emit('control-mode', { mode: room.controlMode });
    io.to(roomId).emit('system-msg', {
      text: room.controlMode === 'host' ? 'Host locked video controls' : 'Everyone can control the video',
      at: Date.now()
    });
  });

  socket.on('rename-room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(room, socket.id)) {
      socket.emit('not-allowed', { what: 'Only the host can rename the room' });
      return;
    }
    room.name = (name || 'Movie Night').toString().slice(0, 60);
    io.to(roomId).emit('room-renamed', { name: room.name });
  });

  // VIDEO SYNC — server is source of truth
  function updateVideo(roomId, patch, by) {
    const room = rooms.get(roomId);
    if (!room) return null;
    room.video = { ...room.video, ...patch, updatedAt: Date.now(), by: by || socket.data.name || 'someone' };
    return room.video;
  }

  socket.on('video-change', ({ roomId, video }) => {
    if (!video) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.controlMode === 'host' && !isHost(room, socket.id)) {
      socket.emit('not-allowed', { what: 'Video controls are locked by the host' });
      return;
    }
    const v = updateVideo(roomId, {
      type: ['youtube', 'mp4'].includes(video.type) ? video.type : 'mp4',
      url: (video.url || '').toString().slice(0, 2000),
      youtubeId: (video.youtubeId || '').toString().slice(0, 30),
      time: 0, playing: true
    });
    if (v) io.to(roomId).emit('video-sync', { video: v, action: 'change' });
  });

  socket.on('video-play', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.controlMode === 'host' && !isHost(room, socket.id)) return; // silent: scrub fights
    const v = updateVideo(roomId, { time: Number(time) || 0, playing: true });
    if (v) socket.to(roomId).emit('video-sync', { video: v, action: 'play' });
  });

  socket.on('video-pause', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.controlMode === 'host' && !isHost(room, socket.id)) return;
    const v = updateVideo(roomId, { time: Number(time) || 0, playing: false });
    if (v) socket.to(roomId).emit('video-sync', { video: v, action: 'pause' });
  });

  socket.on('video-seek', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.controlMode === 'host' && !isHost(room, socket.id)) return;
    const v = updateVideo(roomId, { time: Number(time) || 0 });
    if (v) socket.to(roomId).emit('video-sync', { video: v, action: 'seek' });
  });

  socket.on('video-request-state', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) socket.emit('video-sync', { video: room.video, action: 'state' });
  });

  // WEBRTC signaling relay (mesh)
  socket.on('webrtc-offer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, fromName: socket.data.name, sdp });
  });
  socket.on('webrtc-answer', ({ to, sdp }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, sdp });
  });
  socket.on('webrtc-ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const { roomId, name } = socket.data;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const wasHost = room.hostId === socket.id;
      room.users.delete(socket.id);
      socket.to(roomId).emit('user-left', { socketId: socket.id, name });
      io.to(roomId).emit('users-list', getRoomState(room).users);
      if (wasHost && room.users.size > 0) {
        // pass host to the longest-joined remaining user
        const next = [...room.users.entries()][0];
        room.hostId = next[0];
        io.to(roomId).emit('host-changed', { hostId: room.hostId, hostName: next[1].name });
        io.to(roomId).emit('system-msg', { text: `${next[1].name} is now the host`, at: Date.now() });
        const nextSocket = io.sockets.sockets.get(room.hostId);
        if (nextSocket) nextSocket.emit('host-status', { isHost: true, hostId: room.hostId, controlMode: room.controlMode || 'all' });
      }
      if (room.users.size === 0) {
        // keep room + video state for 1h so link still works, then delete
        setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.users.size === 0 && Date.now() - r.video.updatedAt > 1000 * 60 * 60) rooms.delete(roomId);
        }, 1000 * 60 * 60);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`WeWatchy running on http://localhost:${PORT}`);
});
