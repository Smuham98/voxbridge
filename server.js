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

const users = {};

// ── SERVE FRONTEND ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'VoxBridge running', onlineUsers: Object.keys(users).length });
});

// ── USER LOOKUP ───────────────────────────────────────
app.get('/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found or offline' });
  res.json({ username: req.params.username.toLowerCase(), displayName: u.displayName, langCode: u.langCode, langName: u.langName, online: true });
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
    } catch(e) {
      res.json({ detectedLang: 'Unknown', translated: content });
    }
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

// ── PUSH SUBSCRIBE ────────────────────────────────────
app.post('/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (username && subscription) {
    // Store subscription (in-memory for now)
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Missing fields' });
  }
});

app.get('/vapid-public-key', (req, res) => {
  res.status(503).json({ error: 'Push not configured' });
});

// ── SOCKET.IO SIGNALING ───────────────────────────────
io.on('connection', (socket) => {

  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    socket.broadcast.emit('user-online', { username: key, displayName });
  });

  socket.on('call-user', ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
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

// Wildcard — serves index.html for ANY path not matched above
// This fixes mobile browsers that add trailing slashes or modify the URL
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => console.log('VoxBridge running on port ' + PORT));
