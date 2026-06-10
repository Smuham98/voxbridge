const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

// Configure VAPID if keys are set
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:voxbridge@voxbridge.app',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('Web Push configured ✓');
} else {
  console.log('Web Push not configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Render');
}

// In-memory stores
const users = {};           // username -> { socketId, displayName, langCode, langName }
const pushSubs = {};        // username -> push subscription object

// ── STATIC ────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Service worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({
  status: 'VoxBridge running',
  onlineUsers: Object.keys(users).length,
  pushEnabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}));

// VAPID public key — frontend needs this to subscribe
app.get('/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ── USER LOOKUP ───────────────────────────────────────
app.get('/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found or offline' });
  res.json({ username: req.params.username.toLowerCase(), displayName: u.displayName, langCode: u.langCode, langName: u.langName, online: true });
});

// ── PUSH SUBSCRIPTION ─────────────────────────────────
app.post('/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.status(400).json({ error: 'Missing username or subscription' });
  pushSubs[username.toLowerCase()] = subscription;
  console.log('Push subscription saved for:', username);
  res.json({ success: true });
});

app.post('/unsubscribe', (req, res) => {
  const { username } = req.body;
  if (username) delete pushSubs[username.toLowerCase()];
  res.json({ success: true });
});

// ── SEND PUSH NOTIFICATION ────────────────────────────
async function sendPush(username, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const sub = pushSubs[username.toLowerCase()];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Subscription expired or invalid — remove it
      delete pushSubs[username.toLowerCase()];
    }
    console.log('Push error for', username, ':', err.message);
  }
}

// ── TRANSLATION ───────────────────────────────────────
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
        messages: [{ role: 'user', content: `You are a professional translator.\nDetect the language of the text below, then translate it to ${toLang}.\nIf it is already in ${toLang}, return it as-is.\nRespond ONLY with this JSON (no markdown):\n{"detectedLang":"<language name>","translated":"<translated text>"}\n\nText:\n${text}` }]
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

// Batch retranslate
app.post('/retranslate', async (req, res) => {
  const { messages, toLang } = req.body;
  if (!messages || !toLang) return res.status(400).json({ error: 'Missing messages or toLang' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const numbered = messages.map((m,i) => `${i+1}. ${m.original}`).join('\n');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{ role: 'user', content: `Translate each numbered message to ${toLang}.\nReturn ONLY a JSON array of translated strings in order.\nExample: ["translation1","translation2"]\n\nMessages:\n${numbered}` }]
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

// ── SIGNALING + MESSAGING ─────────────────────────────
io.on('connection', (socket) => {

  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    socket.broadcast.emit('user-online', { username: key, displayName });
  });

  // ── CALLING ──────────────────────────────────────────
  socket.on('call-user', async ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const target = users[toUsername.toLowerCase()];
    if (!target) {
      socket.emit('call-failed', { reason: '@' + toUsername + ' is not online right now' });
      return;
    }
    socket.callPartnerSocketId = target.socketId;
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });

    // Send push notification to callee (in case their screen is off)
    await sendPush(toUsername, {
      type: 'call',
      title: '📞 Incoming Call',
      body: fromDisplayName + ' is calling you on VoxBridge',
      icon: '/icon-192.png',
      tag: 'voxbridge-call',
      renotify: true,
      requireInteraction: true,   // stays on screen until dismissed
      data: { url: '/' }
    });
  });

  socket.on('answer-call', ({ to, answer }) => {
    socket.callPartnerSocketId = to;
    io.to(to).emit('call-answered', { answer });
  });

  socket.on('reject-call', ({ to }) => { io.to(to).emit('call-rejected'); });
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { candidate }); });
  socket.on('hang-up', ({ to }) => { if (to) io.to(to).emit('call-ended'); });
  socket.on('translation-ready', ({ to, bubble }) => { if (to) io.to(to).emit('partner-translation', { bubble }); });

  // ── MESSAGING ─────────────────────────────────────────
  socket.on('chat-message', async ({ toUsername, msgId, original, senderName, senderUsername, timestamp }) => {
    const target = users[toUsername.toLowerCase()];

    // Deliver via socket if online
    if (target) {
      io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
    }

    // Always send push notification (catches background/closed browser)
    const preview = original.length > 60 ? original.slice(0, 60) + '…' : original;
    await sendPush(toUsername, {
      type: 'message',
      title: '💬 ' + senderName,
      body: preview,
      icon: '/icon-192.png',
      tag: 'voxbridge-msg-' + senderUsername,
      renotify: true,
      data: { url: '/', from: senderUsername }
    });
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
