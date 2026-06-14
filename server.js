const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── VAPID / WEB PUSH ──────────────────────────────────
const VAPID_PUBLIC_KEY = 'BB-CyQZN9sWis7oZDqkN1Pt9ZmDv5TdZVhQa-7e90ZPlohEi29xP9J07jnRDEBQviuYoi3E3E9nUKj0Nf1ZDgEk';
const VAPID_PRIVATE_KEY = 'UEh80qgw-h_Tu1-RsgbebXyqPGvsCIkxQNgp4OI3kII';
const VAPID_SUBJECT = 'mailto:admin@voxbridge.app';

function b64urlToBuffer(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function bufferToB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function buildVapidHeaders(audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const payload = { aud: audience, exp, sub: VAPID_SUBJECT };
  const encode = (obj) => bufferToB64url(Buffer.from(JSON.stringify(obj)));
  const unsignedToken = encode(header) + '.' + encode(payload);
  const jwk = {
    kty: 'EC', crv: 'P-256', d: VAPID_PRIVATE_KEY,
    x: bufferToB64url(b64urlToBuffer(VAPID_PUBLIC_KEY).slice(1, 33)),
    y: bufferToB64url(b64urlToBuffer(VAPID_PUBLIC_KEY).slice(33, 65))
  };
  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(unsignedToken), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return { Authorization: 'vapid t=' + unsignedToken + '.' + bufferToB64url(signature) + ', k=' + VAPID_PUBLIC_KEY };
}
function encryptPayload(payload, p256dh, auth) {
  const userPublicKey = b64urlToBuffer(p256dh);
  const userAuth = b64urlToBuffer(auth);
  const localKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const localPublicKey = localKeys.publicKey.export({ type: 'spki', format: 'der' }).slice(-65);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(localKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32));
  const sharedSecret = ecdh.computeSecret(userPublicKey);
  const salt = crypto.randomBytes(16);
  function hkdf(salt, ikm, info, length) {
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    return crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().slice(0, length);
  }
  const authInfo = Buffer.from('WebPush: info\0', 'utf8');
  const keyInfo = Buffer.concat([authInfo, userPublicKey, localPublicKey]);
  const ikm = hkdf(userAuth, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0])])), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([localPublicKey.length]), localPublicKey, ciphertext, authTag]);
}
function sendWebPush(subscription, payloadObj) {
  return new Promise((resolve) => {
    try {
      const endpoint = subscription.endpoint;
      const url = new URL(endpoint);
      const body = encryptPayload(JSON.stringify(payloadObj), subscription.keys.p256dh, subscription.keys.auth);
      const vapidHeaders = buildVapidHeaders(url.origin);
      const req = https.request({
        hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length, 'TTL': '86400', ...vapidHeaders }
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve({ statusCode: res.statusCode })); });
      req.on('error', (e) => resolve({ error: e.message }));
      req.write(body); req.end();
    } catch (e) { resolve({ error: e.message }); }
  });
}

// ── IN-MEMORY STORES ──────────────────────────────────
const users = {};
const userRegistry = {};
const offlineQueue = {};
const pushSubs = {};

// ── STATIC FILES -- serve BEFORE API routes ───────────
app.use(express.static(path.join(__dirname, 'public')));

// ── HEALTH ────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'VoxBridge running', onlineUsers: Object.keys(users).length });
});

// ── ICE CONFIG ────────────────────────────────────────
app.get('/ice-config', async (req, res) => {
  const METERED_KEY = process.env.METERED_API_KEY || '';
  let iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  if (METERED_KEY) {
    try {
      const r = await fetch('https://voxbridge.metered.live/api/v1/turn/credentials?apiKey=' + METERED_KEY);
      if (r.ok) {
        const meteredServers = await r.json();
        iceServers = iceServers.concat(meteredServers);
        return res.json({ iceServers, iceCandidatePoolSize: 10, bundlePolicy: 'max-bundle', iceTransportPolicy: 'all' });
      }
    } catch (e) {}
  }
  iceServers = iceServers.concat([
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:80?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:a.relay.metered.ca:80', 'turn:a.relay.metered.ca:80?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:a.relay.metered.ca:443', 'turn:a.relay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ]);
  res.json({ iceServers, iceCandidatePoolSize: 10, bundlePolicy: 'max-bundle', iceTransportPolicy: 'all' });
});

// ── VAPID KEY ─────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// ── PUSH SUBSCRIBE ────────────────────────────────────
app.post('/subscribe', (req, res) => {
  const { username, subscription } = req.body;
  if (!username || !subscription) return res.status(400).json({ error: 'Missing fields' });
  pushSubs[username.toLowerCase()] = subscription;
  res.json({ success: true });
});

// ── USER LOOKUP ───────────────────────────────────────
app.get('/user/:username', (req, res) => {
  const key = req.params.username.toLowerCase();
  const online = users[key];
  const registered = userRegistry[key];
  if (online) return res.json({ username: key, displayName: online.displayName, langCode: online.langCode, langName: online.langName, online: true });
  if (registered) return res.json({ username: key, displayName: registered.displayName, langCode: registered.langCode, langName: registered.langName, online: false });
  res.status(404).json({ error: 'Username not found' });
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
        model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
        messages: [{ role: 'user', content: `Detect language and translate to ${toLang}. Reply ONLY with JSON: {"detectedLang":"<lang>","translated":"<translation>"}\n\nText: ${text}` }]
      })
    });
    const data = await response.json();
    const content = data.content?.[0]?.text?.trim();
    if (!content) return res.status(500).json({ error: 'Empty response' });
    try {
      const result = JSON.parse(content.replace(/```json|```/g, '').trim());
      res.json({ detectedLang: result.detectedLang || 'Unknown', translated: result.translated || content });
    } catch (e) { res.json({ detectedLang: 'Unknown', translated: content }); }
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        model: 'claude-haiku-4-5-20251001', max_tokens: 4096,
        messages: [{ role: 'user', content: `Translate each numbered message to ${toLang}.\nReturn ONLY a JSON array of translated strings.\nExample: ["t1","t2"]\n\nMessages:\n${numbered}` }]
      })
    });
    const data = await response.json();
    const content = data.content?.[0]?.text?.trim();
    const translations = JSON.parse(content.replace(/```json|```/g, '').trim());
    res.json({ translations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CATCH-ALL -- serves index.html for any unmatched route ───────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── SOCKET.IO ─────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('register', ({ username, displayName, langCode, langName }) => {
    if (!username) return;
    const key = username.toLowerCase();
    users[key] = { socketId: socket.id, displayName, langCode, langName };
    userRegistry[key] = { displayName, langCode, langName };
    socket.username = key;
    socket.emit('registered', { success: true });
    socket.broadcast.emit('user-online', { username: key, displayName });
    // Deliver queued offline messages and missed calls
    if (offlineQueue[key] && offlineQueue[key].length > 0) {
      const queue = offlineQueue[key];
      delete offlineQueue[key];
      queue.forEach(item => socket.emit(item.type, item.payload));
    }
  });

  socket.on('keep-alive', ({ username }) => {
    if (!username) return;
    const key = username.toLowerCase();
    if (users[key]) users[key].socketId = socket.id;
    socket.emit('registered', { success: true });
  });

  socket.on('call-user', ({ toUsername, fromUsername, fromDisplayName, fromLang, theirLang, offer }) => {
    const key = toUsername.toLowerCase();
    const target = users[key];
    if (!target) {
      if (!offlineQueue[key]) offlineQueue[key] = [];
      offlineQueue[key].push({ type: 'missed-call', payload: { fromUsername, fromDisplayName, fromLang, timestamp: Date.now() } });
      if (pushSubs[key]) {
        sendWebPush(pushSubs[key], { title: '\ud83d\udcde Missed Call', body: (fromDisplayName || fromUsername) + ' tried to call you', tag: 'voxbridge-missed-' + fromUsername }).then(r => { if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key]; });
      }
      socket.emit('call-failed', { reason: '@' + toUsername + ' is not online right now -- they will see your missed call when they return' });
      return;
    }
    socket.callPartnerSocketId = target.socketId;
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });
    if (pushSubs[key]) {
      sendWebPush(pushSubs[key], { title: '\ud83d\udcde Incoming Call', body: (fromDisplayName || fromUsername) + ' is calling you', tag: 'voxbridge-call-' + fromUsername, requireInteraction: true }).then(r => { if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key]; });
    }
  });

  socket.on('answer-call', ({ to, answer }) => { socket.callPartnerSocketId = to; io.to(to).emit('call-answered', { answer }); });
  socket.on('reject-call', ({ to }) => { io.to(to).emit('call-rejected'); });
  socket.on('ice-candidate', ({ to, candidate }) => { io.to(to).emit('ice-candidate', { candidate }); });
  socket.on('hang-up', ({ to }) => { if (to) io.to(to).emit('call-ended'); });
  socket.on('translation-ready', ({ to, bubble }) => { if (to) io.to(to).emit('partner-translation', { bubble }); });
  socket.on('call-disconnect-notify', ({ to, reason }) => { if (to) io.to(to).emit('call-disconnect-notify', { reason }); });

  socket.on('chat-message', ({ toUsername, msgId, original, senderName, senderUsername, timestamp }, ack) => {
    const key = toUsername.toLowerCase();
    const target = users[key];
    if (typeof ack === 'function') ack({ ok: true, msgId });
    const pushPayload = { title: '\ud83d\udcac ' + (senderName || senderUsername), body: original.length > 80 ? original.slice(0, 80) + '\u2026' : original, tag: 'voxbridge-msg-' + senderUsername, data: { url: '/' } };
    if (target) {
      io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
      if (pushSubs[key]) sendWebPush(pushSubs[key], pushPayload).then(r => { if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key]; });
    } else {
      if (!offlineQueue[key]) offlineQueue[key] = [];
      if (offlineQueue[key].length >= 100) offlineQueue[key].shift();
      offlineQueue[key].push({ type: 'chat-message', payload: { msgId, original, senderName, senderUsername, timestamp } });
      socket.emit('message-queued', { msgId, toUsername: key });
      if (pushSubs[key]) sendWebPush(pushSubs[key], pushPayload).then(r => { if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key]; });
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
