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

// In-memory user registry: username -> { socketId, displayName, langCode, langName }
const users = {};

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/ping', (req, res) => {
  res.json({ status: 'VoxBridge running', onlineUsers: Object.keys(users).length, apiKeySet: !!ANTHROPIC_API_KEY });
});

// Look up a user by username — used to add contacts
app.get('/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found or offline' });
  res.json({ username: req.params.username.toLowerCase(), displayName: u.displayName, langCode: u.langCode, langName: u.langName, online: true });
});

// List all online users (for search)
app.get('/users', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const list = Object.entries(users)
    .filter(([uname, u]) => !q || uname.includes(q) || u.displayName.toLowerCase().includes(q))
    .map(([uname, u]) => ({ username: uname, displayName: u.displayName, langCode: u.langCode, langName: u.langName }));
  res.json(list);
});

// Translation
app.post('/translate', async (req, res) => {
  const { text, fromLang, toLang } = req.body;
  if (!text || !fromLang || !toLang) return res.status(400).json({ error: 'Missing fields' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured on server' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `Translate from ${fromLang} to ${toLang}. Return ONLY the translated text.\n\nText: ${text}` }]
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      let msg = 'API error ' + response.status;
      try { const j = JSON.parse(raw); if (j.error?.message) msg = j.error.message; } catch(e) {}
      return res.status(response.status).json({ error: msg });
    }
    const data = JSON.parse(raw);
    const translated = data.content?.[0]?.text?.trim();
    if (!translated) return res.status(500).json({ error: 'Empty response' });
    res.json({ translated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SIGNALING ────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Register user when they come online
  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    // Notify others this user came online
    socket.broadcast.emit('user-online', { username: key, displayName });
    console.log('Online:', key, '| Total:', Object.keys(users).length);
  });

  // Caller initiates call
  socket.on('call-user', ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const target = users[toUsername.toLowerCase()];
    if (!target) { socket.emit('call-failed', { reason: '@' + toUsername + ' is not online right now' }); return; }
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });
  });

  // Callee accepts
  socket.on('answer-call', ({ to, answer }) => { io.to(to).emit('call-answered', { answer }); });

  // Callee rejects
  socket.on('reject-call', ({ to }) => { io.to(to).emit('call-rejected'); });

  // ICE candidates
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { candidate }); });

  // Hang up
  socket.on('hang-up', ({ to }) => { if (to) io.to(to).emit('call-ended'); });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.username];
      socket.broadcast.emit('user-offline', { username: socket.username });
      console.log('Offline:', socket.username, '| Total:', Object.keys(users).length);
    }
  });
});

server.listen(PORT, () => console.log('VoxBridge running on port ' + PORT));
