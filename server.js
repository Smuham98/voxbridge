const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const users = {};          // username -> { socketId, displayName, langCode, langName } (online only)
const userRegistry = {};   // username -> { displayName, langCode, langName } (all ever registered)
const pushSubs = {};       // username -> push subscription
const offlineQueue = {};   // username -> [ {type, payload, timestamp} ]

// ── SERVE FRONTEND ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
// Catch-all for mobile
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/socket.io') || req.path.startsWith('/api') ||
      req.path.match(/\.(js|css|png|ico|json)$/)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'VoxBridge running ✓', onlineUsers: Object.keys(users).length });
});

// -- ICE CONFIG for WebRTC
app.get('/ice-config', (req, res) => {
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'], username:'openrelayproject', credential:'openrelayproject' },
      { urls: ['turn:a.relay.metered.ca:80','turn:a.relay.metered.ca:443','turn:a.relay.metered.ca:443?transport=tcp'], username:'openrelayproject', credential:'openrelayproject' }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    iceTransportPolicy: 'all'
  });
});

// ── USER LOOKUP ───────────────────────────────────────
app.get('/user/:username', (req, res) => {
  const key = req.params.username.toLowerCase();
  const online = users[key];
  const registered = userRegistry[key];
  // Found online
  if (online) {
    return res.json({ username: key, displayName: online.displayName, langCode: online.langCode, langName: online.langName, online: true });
  }
  // Found in registry (offline)
  if (registered) {
    return res.json({ username: key, displayName: registered.displayName, langCode: registered.langCode, langName: registered.langName, online: false });
  }
  // Not found at all
  res.status(404).json({ error: 'Username not found. They may need to create their VoxBridge account first.' });
});

// ── PUSH SUBSCRIBE ────────────────────────────────────
app.post('/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.status(400).json({ error: 'Missing fields' });
  pushSubs[username.toLowerCase()] = subscription;
  res.json({ success: true });
});

// VAPID not configured — return empty so client falls back gracefully
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: null });
});

// ── TRANSLATE ─────────────────────────────────────────
app.post('/translate', async (req, res) => {
  const { text, toLang } = req.body;
  if (!text || !toLang) return res.status(400).json({ error: 'Missing text or toLang' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Detect language and translate to ${toLang}. Reply ONLY with JSON: {"detectedLang":"<lang>","translated":"<translation>"}\n\nText: ${text}` }]
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      let msg = 'API error ' + response.status;
      try { const j = JSON.parse(raw); if (j.error?.message) msg = j.error.message; } catch(e) {}
      return res.status(response.status).json({ error: msg });
    }
    const data = JSON.parse(raw);
    const content = data.content?.[0]?.text?.trim();
    if (!content) return res.status(500).json({ error: 'Empty response' });
    try {
      const result = JSON.parse(content.replace(/```json|```/g, '').trim());
      res.json({ detectedLang: result.detectedLang || 'Unknown', translated: result.translated || content });
    } catch(e) { res.json({ detectedLang: 'Unknown', translated: content }); }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── RETRANSLATE ───────────────────────────────────────
app.post('/retranslate', async (req, res) => {
  const { messages, toLang } = req.body;
  if (!messages || !toLang) return res.status(400).json({ error: 'Missing fields' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const numbered = messages.map((m, i) => `${i + 1}. ${m.original}`).join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: `Translate each numbered message to ${toLang}.\nReturn ONLY a JSON array of translated strings.\nExample: ["t1","t2"]\n\nMessages:\n${numbered}` }]
      })
    });
    const raw = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: 'API error' });
    const data = JSON.parse(raw);
    const content = data.content?.[0]?.text?.trim();
    const translations = JSON.parse(content.replace(/```json|```/g, '').trim());
    res.json({ translations });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── SOCKET.IO ─────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    // Persist to registry so offline lookup works
    userRegistry[key] = { displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    socket.broadcast.emit('user-online', { username: key, displayName });

    // Deliver any queued offline messages
    if (offlineQueue[key] && offlineQueue[key].length > 0) {
      const queue = offlineQueue[key];
      delete offlineQueue[key];
      queue.forEach(item => {
        socket.emit(item.type, item.payload);
      });
      console.log(`Delivered ${queue.length} queued messages to ${key}`);
    }
  });

  // ── CALLING ──────────────────────────────────────────
  socket.on('call-user', ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const key = toUsername.toLowerCase();
    const target = users[key];
    if (!target) {
      // Callee offline — queue a missed call notification for when they return
      if (!offlineQueue[key]) offlineQueue[key] = [];
      offlineQueue[key].push({
        type: 'missed-call',
        payload: {
          fromUsername,
          fromDisplayName,
          fromLang,
          timestamp: Date.now()
        },
        queuedAt: Date.now()
      });
      console.log(`Queued missed call for offline user: ${key}`);
      socket.emit('call-failed', { reason: '@' + toUsername + ' is not online — they will see your missed call when they return' });
      return;
    }
    socket.callPartnerSocketId = target.socketId;
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });
  });

  socket.on('answer-call', ({ to, answer }) => {
    socket.callPartnerSocketId = to;
    io.to(to).emit('call-answered', { answer });
  });

  socket.on('reject-call', ({ to }) => { io.to(to).emit('call-rejected'); });
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { candidate }); });
  socket.on('hang-up', ({ to }) => { if (to) io.to(to).emit('call-ended'); });
  socket.on('translation-ready', ({ to, bubble }) => { if (to) io.to(to).emit('partner-translation', { bubble }); });
  socket.on('call-disconnect-notify', ({ to, reason }) => { if (to) io.to(to).emit('call-disconnect-notify', { reason }); });
  socket.on('keep-alive', ({ username }) => {
    if (!username) return;
    const key = username.toLowerCase();
    // Update socket ID in case it changed, keep user visible
    if (users[key]) {
      users[key].socketId = socket.id;
    }
    // Silently re-emit registered so client stays online
    socket.emit('registered', { success: true });
  });

  // ── MESSAGING ─────────────────────────────────────────
  socket.on('chat-message', ({ toUsername, msgId, original, senderName, senderUsername, timestamp }) => {
    const key = toUsername.toLowerCase();
    const target = users[key];

    if (target) {
      // User is online — deliver immediately
      io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
    } else {
      // User is offline — queue the message for when they come back online
      if (!offlineQueue[key]) offlineQueue[key] = [];
      // Keep max 100 queued messages per user
      if (offlineQueue[key].length >= 100) offlineQueue[key].shift();
      offlineQueue[key].push({
        type: 'chat-message',
        payload: { msgId, original, senderName, senderUsername, timestamp },
        queuedAt: Date.now()
      });
      console.log(`Queued message for offline user: ${key}`);
      // Confirm to sender that message was queued
      socket.emit('message-queued', { msgId, toUsername: key });
    }
  });

  socket.on('typing', ({ toUsername, isTyping }) => {
    const target = users[toUsername.toLowerCase()];
    if (target) io.to(target.socketId).emit('typing', { fromUsername: socket.username, isTyping });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.username];
      socket.broadcast.emit('user-offline', { username: socket.username });
    }
  });
});

server.listen(PORT, () => console.log('VoxBridge running on port ' + PORT));
