const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

// In-memory stores
const users = {};
const pushSubs = {};

// ── STATIC ────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({
  status: 'VoxBridge running ✓',
  onlineUsers: Object.keys(users).length,
  pushEnabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}));

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
  if (!username || !subscription) return res.status(400).json({ error: 'Missing fields' });
  pushSubs[username.toLowerCase()] = subscription;
  res.json({ success: true });
});

// ── SEND PUSH (manual VAPID using built-in crypto) ────
async function sendPush(username, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const sub = pushSubs[username.toLowerCase()];
  if (!sub) return;
  try {
    // Use dynamic import for web-push-like functionality via node built-ins
    // Build minimal VAPID JWT manually
    const endpoint = sub.endpoint;
    const origin = new URL(endpoint).origin;

    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({
      aud: origin,
      exp: now + 12 * 3600,
      sub: 'mailto:admin@voxbridge.app'
    })).toString('base64url');

    const signingInput = `${header}.${claims}`;
    const privateKeyBuffer = Buffer.from(VAPID_PRIVATE_KEY, 'base64url');

    // Create EC private key
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
        privateKeyBuffer,
        Buffer.from('a00a06082a8648ce3d030107', 'hex')
      ]),
      format: 'der',
      type: 'pkcs8'
    });

    const signature = crypto.sign(null, Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const jwt = `${signingInput}.${signature.toString('base64url')}`;

    const body = JSON.stringify(payload);

    const urlObj = new URL(endpoint);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'TTL': '86400'
      }
    };

    await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        if (res.statusCode === 410 || res.statusCode === 404) {
          delete pushSubs[username.toLowerCase()];
        }
        resolve();
      });
      req.on('error', resolve);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.log('Push error:', err.message);
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
        messages: [{ role: 'user', content: `Detect language and translate to ${toLang}. Reply ONLY with JSON, no markdown: {"detectedLang":"<lang>","translated":"<translation>"}

Text: ${text}` }]
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

  socket.on('call-user', async ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const target = users[toUsername.toLowerCase()];
    if (!target) { socket.emit('call-failed', { reason: '@' + toUsername + ' is not online right now' }); return; }
    socket.callPartnerSocketId = target.socketId;
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });
    await sendPush(toUsername, { type:'call', title:'📞 Incoming Call', body: fromDisplayName + ' is calling you on VoxBridge', tag:'voxbridge-call', requireInteraction:true, data:{ url:'/' } });
  });

  socket.on('answer-call', ({ to, answer }) => { socket.callPartnerSocketId = to; io.to(to).emit('call-answered', { answer }); });
  socket.on('reject-call', ({ to }) => { io.to(to).emit('call-rejected'); });
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { candidate }); });
  socket.on('hang-up', ({ to }) => { if (to) io.to(to).emit('call-ended'); });
  socket.on('translation-ready', ({ to, bubble }) => { if (to) io.to(to).emit('partner-translation', { bubble }); });

  socket.on('chat-message', async ({ toUsername, msgId, original, senderName, senderUsername, timestamp }) => {
    const target = users[toUsername.toLowerCase()];
    if (target) io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
    const preview = original.length > 60 ? original.slice(0,60)+'…' : original;
    await sendPush(toUsername, { type:'message', title:'💬 ' + senderName, body: preview, tag:'voxbridge-msg-'+senderUsername, renotify:true, data:{ url:'/' } });
  });

  socket.on('typing', ({ toUsername, isTyping }) => {
    const target = users[toUsername.toLowerCase()];
    if (target) io.to(target.socketId).emit('typing', { fromUsername: socket.username, isTyping });
  });

  // Disconnect notification relay
  socket.on('call-disconnect-notify', ({ to, reason }) => {
    if (to) io.to(to).emit('call-disconnect-notify', { reason });
  });

  // Keep-alive ping (prevents idle disconnect during calls)
  socket.on('keep-alive', () => { /* no-op — just keeping connection open */ });

  socket.on('disconnect', () => {
    if (socket.username) {
      delete users[socket.username];
      socket.broadcast.emit('user-offline', { username: socket.username });
      // If this user was in a call, their partner's connection state will
      // detect the ICE failure and handle cleanup on their end
    }
  });
});

server.listen(PORT, () => console.log('VoxBridge running on port ' + PORT));
