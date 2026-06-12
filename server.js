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

// ── WEB PUSH (VAPID) -- self-contained implementation, no external deps ──────
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

// Build a VAPID JWT for the 'Authorization' header
function buildVapidHeaders(audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h
  const payload = { aud: audience, exp, sub: VAPID_SUBJECT };
  const encode = (obj) => bufferToB64url(Buffer.from(JSON.stringify(obj)));
  const unsignedToken = encode(header) + '.' + encode(payload);

  // Reconstruct private key as JWK for signing
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: VAPID_PRIVATE_KEY,
    x: bufferToB64url(b64urlToBuffer(VAPID_PUBLIC_KEY).slice(1, 33)),
    y: bufferToB64url(b64urlToBuffer(VAPID_PUBLIC_KEY).slice(33, 65))
  };
  const keyObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });

  const signature = crypto.sign('sha256', Buffer.from(unsignedToken), {
    key: keyObj,
    dsaEncoding: 'ieee-p1363' // raw r||s format required by JWT ES256
  });

  const jwt = unsignedToken + '.' + bufferToB64url(signature);
  return {
    Authorization: 'vapid t=' + jwt + ', k=' + VAPID_PUBLIC_KEY,
  };
}

// Encrypt payload using RFC8291 (aes128gcm)
function encryptPayload(payload, p256dh, auth) {
  const userPublicKey = b64urlToBuffer(p256dh);
  const userAuth = b64urlToBuffer(auth);

  const localKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const localPublicKey = localKeys.publicKey.export({ type: 'spki', format: 'der' }).slice(-65);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(localKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32));
  const sharedSecret = ecdh.computeSecret(userPublicKey);

  const salt = crypto.randomBytes(16);

  // HKDF for key derivation (RFC8291)
  function hkdf(salt, ikm, info, length) {
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    const infoBuf = Buffer.concat([info, Buffer.from([1])]);
    return crypto.createHmac('sha256', prk).update(infoBuf).digest().slice(0, length);
  }

  const authInfo = Buffer.from('WebPush: info\0', 'utf8');
  const keyInfo = Buffer.concat([authInfo, userPublicKey, localPublicKey]);
  const ikm = hkdf(userAuth, sharedSecret, keyInfo, 32);

  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0', 'utf8');
  const cek = hkdf(salt, ikm, cekInfo, 16);
  const nonce = hkdf(salt, ikm, nonceInfo, 12);

  const payloadBuf = Buffer.from(payload, 'utf8');
  const padding = Buffer.from([0]); // no padding
  const plaintext = Buffer.concat([payloadBuf, padding]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedBody = Buffer.concat([ciphertext, authTag]);

  // Build aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(localPublicKey)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  const idLen = Buffer.from([localPublicKey.length]);
  const header = Buffer.concat([salt, rs, idLen, localPublicKey]);

  return Buffer.concat([header, encryptedBody]);
}

// Send a web push notification to a subscription
function sendWebPush(subscription, payloadObj) {
  return new Promise((resolve) => {
    try {
      const endpoint = subscription.endpoint;
      const url = new URL(endpoint);
      const payloadStr = JSON.stringify(payloadObj);
      const body = encryptPayload(payloadStr, subscription.keys.p256dh, subscription.keys.auth);
      const vapidHeaders = buildVapidHeaders(url.origin);

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          'TTL': '86400',
          ...vapidHeaders
        }
      };

      const req = https.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ error: e.message });
    }
  });
}

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
  res.json({ key: VAPID_PUBLIC_KEY });
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

      // Send push notification for the missed call
      if (pushSubs[key]) {
        sendWebPush(pushSubs[key], {
          title: '\ud83d\udcde Missed Call',
          body: (fromDisplayName || fromUsername) + ' tried to call you',
          tag: 'voxbridge-missed-' + fromUsername,
          type: 'call',
          data: { url: '/' }
        }).then((r) => {
          if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key];
        });
      }
      socket.emit('call-failed', { reason: '@' + toUsername + ' is not online — they will see your missed call when they return' });
      return;
    }
    socket.callPartnerSocketId = target.socketId;
    io.to(target.socketId).emit('incoming-call', { from: socket.id, fromUsername, fromDisplayName, fromLang, theirLang, offer });
    // Also push -- helps if recipient's app is backgrounded and socket is stale
    if (pushSubs[key]) {
      sendWebPush(pushSubs[key], {
        title: '\ud83d\udcde Incoming Call',
        body: (fromDisplayName || fromUsername) + ' is calling you',
        tag: 'voxbridge-call-' + fromUsername,
        type: 'call',
        requireInteraction: true,
        data: { url: '/' }
      }).then((r) => {
        if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key];
      });
    }
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
      // User is online — deliver immediately via socket
      io.to(target.socketId).emit('chat-message', { msgId, original, senderName, senderUsername, timestamp });
      // Also push -- covers backgrounded apps where socket lags
      if (pushSubs[key]) {
        const preview = original.length > 80 ? original.slice(0, 80) + '\u2026' : original;
        sendWebPush(pushSubs[key], {
          title: '\ud83d\udcac ' + (senderName || senderUsername),
          body: preview,
          tag: 'voxbridge-msg-' + senderUsername,
          type: 'message',
          data: { url: '/' }
        }).then((r) => {
          if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key];
        });
      }
    } else {
      // User is offline — queue the message for when they come back online
      if (!offlineQueue[key]) offlineQueue[key] = [];
      if (offlineQueue[key].length >= 100) offlineQueue[key].shift();
      offlineQueue[key].push({
        type: 'chat-message',
        payload: { msgId, original, senderName, senderUsername, timestamp },
        queuedAt: Date.now()
      });
      console.log(`Queued message for offline user: ${key}`);
      socket.emit('message-queued', { msgId, toUsername: key });

      // Send a real push notification so it shows even if app/browser is closed
      if (pushSubs[key]) {
        const preview = original.length > 80 ? original.slice(0, 80) + '\u2026' : original;
        sendWebPush(pushSubs[key], {
          title: '\ud83d\udcac ' + (senderName || senderUsername),
          body: preview,
          tag: 'voxbridge-msg-' + senderUsername,
          type: 'message',
          data: { url: '/' }
        }).then((r) => {
          if (r.error || (r.statusCode && r.statusCode >= 400)) {
            console.log('Push failed for', key, r);
            // Clean up dead subscriptions
            if (r.statusCode === 404 || r.statusCode === 410) delete pushSubs[key];
          }
        });
      }
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
