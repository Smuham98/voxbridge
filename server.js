const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io'
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

const users = {};
const pushSubs = {};

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({
  status: 'VoxBridge running ✓',
  onlineUsers: Object.keys(users).length
}));

app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ── API ROUTES ────────────────────────────────────────
app.get('/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found or offline' });
  res.json({ username: req.params.username.toLowerCase(), displayName: u.displayName, langCode: u.langCode, langName: u.langName, online: true });
});

app.post('/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.status(400).json({ error: 'Missing fields' });
  pushSubs[username.toLowerCase()] = subscription;
  res.json({ success: true });
});

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
        messages: [{ role: 'user', content: `Detect language and translate to ${toLang}. Reply ONLY with JSON, no markdown: {"detectedLang":"<lang>","translated":"<translation>"}\n\nText: ${text}` }]
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
      const result = JSON.parse(content.replace(/```json|```/g,'').trim());
      res.json({ detectedLang: result.detectedLang||'Unknown', translated: result.translated||content });
    } catch(e) {
      res.json({ detectedLang: 'Unknown', translated: content });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/retranslate', async (req, res) => {
  const { messages, toLang } = req.body;
  if (!messages || !toLang) return res.status(400).json({ error: 'Missing fields' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const numbered = messages.map((m,i) => `${i+1}. ${m.original}`).join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: `Translate each numbered message to ${toLang}.\nReturn ONLY a JSON array of translated strings in order.\nExample: ["t1","t2"]\n\nMessages:\n${numbered}` }]
      })
    });
    const raw = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: 'API error' });
    const data = JSON.parse(raw);
    const content = data.content?.[0]?.text?.trim();
    const translations = JSON.parse(content.replace(/```json|```/g,'').trim());
    res.json({ translations });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── STATIC FILES ──────────────────────────────────────
// Serve static files AFTER API routes so /ping etc still work
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all — must come LAST, after socket.io and all API routes
// Only intercepts non-API, non-socket routes
app.use((req, res, next) => {
  // Don't intercept socket.io or API routes
  if (req.path.startsWith('/socket.io') ||
      req.path.startsWith('/ping') ||
      req.path.startsWith('/user') ||
      req.path.startsWith('/translate') ||
      req.path.startsWith('/retranslate') ||
      req.path.startsWith('/subscribe') ||
      req.path.startsWith('/vapid')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── SIGNALING + MESSAGING ─────────────────────────────
io.on('connection', (socket) => {

  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    socket.broadcast.emit('user-online', { username: key, displayName });
    console.log('Registered:', key, '| Online:', Object.keys(users).length);
  });

  socket.on('call-user', async ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const target = users[toUsername.toLowerCase()];
    if (!target) { socket.emit('call-failed', { reason: '@' + toUsername + ' is not online right now' }); return; }
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
  socket.on('keep-alive', () => {});

  socket.on('chat-message', ({ toUsername, msgId, original, senderName, senderUsername, timestamp }) => {
    const target = users[toUsername.toLowerCase()];
    if (target) io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
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
