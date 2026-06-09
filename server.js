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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/ping', (req, res) => {
  res.json({ status: 'VoxBridge running', onlineUsers: Object.keys(users).length, apiKeySet: !!ANTHROPIC_API_KEY });
});

app.get('/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found or offline' });
  res.json({ username: req.params.username.toLowerCase(), displayName: u.displayName, langCode: u.langCode, langName: u.langName, online: true });
});

// Auto-detect language AND translate in one call
app.post('/translate', async (req, res) => {
  const { text, toLang } = req.body;
  if (!text || !toLang) return res.status(400).json({ error: 'Missing text or toLang' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured on server' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `You are a professional translator and language detector.

First, detect what language the following text is written in.
Then, translate it to ${toLang}.

If the text is already in ${toLang}, still return it (you can clean it up if needed).

Respond in this exact JSON format with no extra text:
{"detectedLang": "<language name in English>", "translated": "<translated text>"}

Text to process:
${text}`
        }]
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
    if (!content) return res.status(500).json({ error: 'Empty response from API' });

    // Parse the JSON response from Claude
    let result;
    try {
      // Strip any markdown code fences if present
      const clean = content.replace(/```json|```/g, '').trim();
      result = JSON.parse(clean);
    } catch(e) {
      // If JSON parse fails, just return the text as-is
      return res.json({ detectedLang: 'Unknown', translated: content });
    }

    res.json({ detectedLang: result.detectedLang || 'Unknown', translated: result.translated || content });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Signaling
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

  socket.on('translation-ready', ({ to, bubble }) => {
    if (to) io.to(to).emit('partner-translation', { bubble });
  });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.username];
      socket.broadcast.emit('user-offline', { username: socket.username });
    }
  });
});

server.listen(PORT, () => console.log('VoxBridge running on port ' + PORT));
