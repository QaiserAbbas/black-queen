/* =============================================================================
 * Black Queen — LAN MULTIPLAYER SERVER  (zero dependencies)
 * -----------------------------------------------------------------------------
 * Run:  node server.js  [port]
 * Then everyone on your Wi-Fi/LAN opens the printed URL in a browser.
 *
 * This single file:
 *   1. Serves the static game files (index.html, css, js).
 *   2. Speaks WebSocket (hand-rolled, RFC6455) — no npm install needed.
 *   3. Runs the AUTHORITATIVE GameEngine per room. Clients are thin views.
 *   4. Fills empty seats with bots; a player who disconnects becomes a bot, so
 *      a game never stalls.
 * ===========================================================================*/

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ---- load the headless engine (universal modules attach to globalThis.BQ) - */
require('./js/config.js');
require('./js/cards.js');
require('./js/ai.js');
require('./js/engine.js');
require('./js/treeky-engine.js');
require('./js/treeky-ai.js');
const BQ = globalThis.BQ;

// Cloud hosts (Render/Railway/Fly/Heroku) inject the port via process.env.PORT.
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 4003;
// Card-smash styles a client may request (mirrors BQ.FX.SMASHES in js/fx.js).
const SMASH_KINDS = new Set(['punch', 'fire', 'bolt', 'ice', 'bomb']);
const ROOT = __dirname;

/* =============================================================================
 * Static file serving
 * ===========================================================================*/
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // What sound files actually exist — lets the client fetch only those
  // (no 404 noise for optional overrides; see sounds/README.md).
  if (urlPath === '/sounds/manifest.json') {
    return fs.readdir(path.join(ROOT, 'sounds'), (err, files) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(err ? [] : files.filter((f) => /\.(mp3|ogg|wav)$/i.test(f))));
    });
  }
  // prevent path traversal
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

/* =============================================================================
 * Minimal WebSocket layer (RFC 6455) — text frames only, which is all we need.
 * ===========================================================================*/
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let nextClientId = 1;

// opcode: 0x1 text (default), 0x9 ping, 0xA pong
function encodeFrame(str, opcode) {
  const payload = Buffer.from(str || '', 'utf8');
  const len = payload.length;
  const first = 0x80 | (opcode || 0x1);
  let header;
  if (len < 126) {
    header = Buffer.from([first, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = first; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// Returns { messages:[str], pings:[Buffer], rest:Buffer, closed:bool }.
function decodeFrames(buf) {
  const messages = [];
  const pings = [];
  let offset = 0;
  let closed = false;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // wait for more data
    let data = buf.slice(p, p + len);
    if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3]; data = out; }
    offset = p + len;

    if (opcode === 0x8) { closed = true; break; }       // close
    else if (opcode === 0x9) pings.push(data);          // ping → caller must reply pong (RFC 6455)
    else if (opcode === 0xA) { /* pong — receipt alone proves liveness */ }
    else if (opcode === 0x1 || opcode === 0x0) messages.push(data.toString('utf8'));
  }
  return { messages, pings, rest: buf.slice(offset), closed };
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  // Nagle's algorithm batches small packets (~40-200ms over WAN); every game
  // message is a small JSON frame, so flush them immediately.
  socket.setNoDelay(true);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const client = {
    id: nextClientId++,
    socket,
    buf: Buffer.alloc(0),
    roomCode: null,
    seat: -1,
    name: 'Player',
    lastSeen: Date.now(),   // any inbound traffic proves the link is alive
    lastChatAt: 0,          // emote/chat rate limiting
    send(obj) {
      try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (_) {}
    },
  };
  clients.set(client.id, client);

  socket.on('data', (chunk) => {
    client.lastSeen = Date.now();
    client.buf = Buffer.concat([client.buf, chunk]);
    const { messages, pings, rest, closed } = decodeFrames(client.buf);
    client.buf = rest;
    for (const ping of pings) {
      try { socket.write(encodeFrame(ping.toString('utf8'), 0xA)); } catch (_) {}
    }
    for (const m of messages) {
      let msg; try { msg = JSON.parse(m); } catch (_) { continue; }
      handleMessage(client, msg);
    }
    if (closed) socket.end();
  });
  socket.on('close', () => dropClient(client));
  socket.on('error', () => dropClient(client));
});

/* ---- keepalive: defeat idle proxy timeouts + detect half-open sockets -----
 * Cloud proxies (ngrok, Render, Cloudflare…) silently kill WebSockets idle for
 * ~30-60s, often WITHOUT a FIN reaching us — the seat then looks "human" while
 * nobody is there and the game waits forever. Ping every 25s so the link never
 * looks idle; if a client hasn't sent ANY traffic in 75s, declare it dead and
 * drop it (a bot takes over, so the table keeps moving).
 * --------------------------------------------------------------------------*/
const PING_INTERVAL_MS = 25 * 1000;
const DEAD_AFTER_MS = 75 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (now - client.lastSeen > DEAD_AFTER_MS) {
      try { client.socket.destroy(); } catch (_) {}   // fires 'close' → dropClient
      continue;
    }
    try { client.socket.write(encodeFrame('', 0x9)); } catch (_) {}
  }
}, PING_INTERVAL_MS).unref();

/* =============================================================================
 * Rooms & game coordination
 * ===========================================================================*/
const clients = new Map();   // id -> client
const rooms = new Map();     // code -> room

// How long we hold a seat (and an all-bot in-progress room) so a refreshed or
// briefly-disconnected player can reclaim their EXACT seat via their session
// token before we let it go.
const RECONNECT_GRACE_MS = 90 * 1000;

// How long a player's EXACT turn is held after an unintentional drop (refresh /
// Wi-Fi blip) before a bot fills in. A page reload + reconnect must finish
// inside this window so the refreshed player keeps the same turn instead of
// finding a bot already played for them.
const DISCONNECT_TURN_GRACE_MS = 15 * 1000;

// A per-player session token: survives reconnects, so a refreshed browser can
// re-attach to the same seat instead of spawning a brand-new one.
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

// Tear a room down only after the grace window with nobody connected — so a
// brief outage (Wi-Fi drop, tunnel hiccup) doesn't destroy an in-progress game.
function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const anyHuman = room.seats.some((s) => s.clientId && clients.get(s.clientId));
    if (!anyHuman) {
      if (room.botTimer) clearTimeout(room.botTimer);
      room.seats.forEach((s) => { if (s.graceTimer) clearTimeout(s.graceTimer); });
      rooms.delete(room.code);
    }
  }, RECONNECT_GRACE_MS);
}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function makeRoom(hostClient) {
  const code = makeCode();
  const room = {
    code,
    hostId: hostClient.id,
    hostToken: null,     // host's seat token — lets the host reclaim host on reconnect
    gameType: 'blackqueen',  // 'blackqueen' | 'treeky' — set from the create message
    rules: BQ.cloneRules(),
    seats: [],        // [{clientId|null, name, isBot, token, disconnected, graceTimer}]
    engine: null,
    started: false,
    botTimer: null,
    cleanupTimer: null,  // pending room teardown (cancelled if someone reconnects)
    lastRoundEnd: null,  // last round-summary payload, replayed to a reconnecting player
    lastGameOver: null,  // last game-over payload, replayed to a reconnecting player
    ready: new Set(), // seats that confirmed "ready" for the next round
    paused: false,    // true while play is frozen (a player left mid-game)
    vacancy: null,    // {seat, name} the host is being asked to resolve
    spectators: new Set(), // client ids watching the live stream (no seat, no cards)
  };
  rooms.set(code, room);
  return room;
}

// Seats occupied by a connected human (bots/disconnected don't need to confirm).
function humanSeats(room) {
  const out = [];
  room.seats.forEach((s, i) => { if (s.clientId && clients.get(s.clientId) && !s.isBot) out.push(i); });
  return out;
}

function broadcastReady(room) {
  const humans = humanSeats(room);
  const payload = { t: 'ready', ready: [...room.ready], humans, names: room.seats.map((s) => s.name) };
  room.seats.forEach((s) => { if (s.clientId) { const c = clients.get(s.clientId); if (c) c.send(payload); } });
}

// Advance to the next round only when every connected human has confirmed.
function checkReady(room) {
  if (!room.engine || room.engine.phase !== 'roundEnd') return;
  const humans = humanSeats(room);
  const allReady = humans.length > 0 && humans.every((seat) => room.ready.has(seat));
  if (allReady) {
    room.ready = new Set();
    room.engine.startRound();
  } else {
    broadcastReady(room);
  }
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    maxSeats: room.rules.playerCount,
    players: room.seats.map((s, i) => ({
      seat: i, name: s.name, isBot: s.isBot, you: false,
      connected: !!(s.clientId && clients.get(s.clientId)),
    })),
  };
}

function broadcastLobby(room) {
  room.seats.forEach((s) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (!c) return;
    const state = lobbyState(room);
    state.players = state.players.map((p) => ({ ...p, you: p.seat === c.seat }));
    state.youAreHost = (room.hostId === c.id);
    state.yourSeat = c.seat;
    c.send({ t: 'lobby', state });
  });
}

function seatIsBot(room, seat) {
  const s = room.seats[seat];
  return !s || s.isBot || !s.clientId || !clients.get(s.clientId);
}

// Send a raw (non-snapshot) payload to every connected player AND spectator in
// the room (presence, emotes, attacks, pause notices — all public info).
function sendAll(room, payload) {
  room.seats.forEach((s) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (c) c.send(payload);
  });
  if (room.spectators) {
    for (const id of room.spectators) { const c = clients.get(id); if (c) c.send(payload); }
  }
}

// Live presence: who is connected, who dropped (bot stand-in), who's a bot.
function presenceState(room) {
  return {
    t: 'peers',
    seats: room.seats.map((s, i) => ({
      seat: i,
      name: s.name,
      isBot: !!s.isBot && !s.disconnected,
      connected: !!(s.clientId && clients.get(s.clientId)),
      away: !!s.disconnected,           // human seat temporarily covered by a bot
      attacksMuted: !!s.attacksMuted,   // they won't see/hear taunts
    })),
  };
}

function broadcastPresence(room, note) {
  const payload = presenceState(room);
  if (note) payload.note = note;        // { kind:'lost'|'back'|'left', name }
  sendAll(room, payload);
  // Voice roster tracks live, connected seats — refresh it whenever presence
  // shifts so a dropped player's peers tear their audio link down.
  broadcastVoice(room);
}

// Seats currently opted into voice chat AND actually connected. Media is pure
// P2P (WebRTC); the server only relays signaling and publishes this roster so
// each client knows who to dial.
function voiceRoster(room) {
  const out = [];
  room.seats.forEach((s, i) => {
    if (s.voice && s.clientId && clients.get(s.clientId)) out.push(i);
  });
  return out;
}

function broadcastVoice(room) {
  sendAll(room, { t: 'voice', seats: voiceRoster(room) });
}

// A human who just dropped (refresh / Wi-Fi blip) keeps their EXACT turn for a
// short grace window so a reconnect resumes on the same turn instead of finding
// a bot already moved for them. Only once that window lapses (botFill) does a
// bot take over.
function seatAwaitingReconnect(room, seat) {
  const s = room.seats[seat];
  return !!(s && s.disconnected && !s.botFill);
}

// Start (or restart) the per-seat grace window after an unintentional drop.
function beginDisconnectGrace(room, seatIdx) {
  const seat = room.seats[seatIdx];
  if (!seat) return;
  if (seat.turnGraceTimer) clearTimeout(seat.turnGraceTimer);
  seat.botFill = false;
  seat.turnGraceTimer = setTimeout(() => {
    seat.turnGraceTimer = null;
    // Didn't return in time — let a bot keep the game moving. The seat + token
    // are still held (RECONNECT_GRACE_MS) so a later reconnect still resumes.
    if (seat.disconnected && !seat.clientId) {
      seat.botFill = true;
      if (!room.paused && room.engine && room.engine.phase === 'awaitHuman' &&
          room.engine.currentPlayerIndex === seatIdx) {
        scheduleBot(room, seatIdx);
      }
    }
  }, DISCONNECT_TURN_GRACE_MS);
}

// Tell every connected client whether play is currently frozen (and why).
function broadcastPaused(room, paused, name) {
  room.seats.forEach((s) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (c) c.send({ t: 'paused', paused: !!paused, name: name || null, code: room.code });
  });
}

// Ask the (current) host what to do with a seat a player just left: add a bot
// or wait for a new player to take it.
function promptHostVacancy(room) {
  if (!room.vacancy) return;
  const host = clients.get(room.hostId);
  if (host) host.send({ t: 'seatVacated', seat: room.vacancy.seat, name: room.vacancy.name, code: room.code });
}

// Convert a vacated seat into a permanent bot (host chose "Add a Bot").
function fillSeatWithBot(room, seatIdx) {
  const seat = room.seats[seatIdx];
  if (!seat) return;
  if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
  const used = new Set(room.seats.map((s) => s.name));
  const pool = BQ.cloneOf(room.rules.botNames).filter((n) => !used.has(n));
  const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ('Bot ' + (seatIdx + 1));
  seat.clientId = null;
  seat.isBot = true;
  seat.open = false;
  seat.disconnected = false;
  seat.botFill = true;
  seat.name = name;
  if (room.engine && room.engine.players[seatIdx]) room.engine.players[seatIdx].name = name;
}

// Un-freeze play after a vacancy is resolved (bot added, or a new player joined)
// and repaint every table from the current state.
function resumePlay(room) {
  room.paused = false;
  room.vacancy = null;
  broadcastPaused(room, false);
  const e = room.engine;
  if (e && e.phase === 'awaitHuman' && seatIsBot(room, e.currentPlayerIndex)) {
    scheduleBot(room, e.currentPlayerIndex);
  }
  broadcast(room, { name: 'resync' });
  broadcastPresence(room);   // seat changed (bot added / new player) — refresh badges
}

/* ---- message router ---------------------------------------------------- */
function handleMessage(client, msg) {
  switch (msg.t) {
    // App-level heartbeat: the client echoes its timestamp so it can measure
    // round-trip latency; the traffic itself keeps proxies from idling us out.
    case 'ping': {
      client.send({ t: 'pong', ts: msg.ts });
      break;
    }
    // Client-side preference flags others should know about (e.g. a player who
    // muted attack taunts gets a 🛡️ on their badge — taunting them is wasted).
    case 'prefs': {
      const room = rooms.get(client.roomCode);
      if (!room || client.seat < 0) break;
      const seat = room.seats[client.seat];
      if (!seat) break;
      seat.attacksMuted = !!msg.attacksMuted;
      broadcastPresence(room);
      break;
    }
    // Attack taunt (lion / dragon / bomb / ghost / skull) — a big intimidation
    // animation on every table. Budget: ONE per move; the credit comes back
    // when the sender plays their next card.
    case 'attack': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.started || client.seat < 0) break;
      const seat = room.seats[client.seat];
      if (!seat || seat.attackUsed) break;
      const kind = String(msg.kind || '');
      if (['lion', 'dragon', 'bomb', 'ghost', 'skull'].indexOf(kind) < 0) break;
      seat.attackUsed = true;
      sendAll(room, { t: 'attack', kind, seat: client.seat, name: client.name });
      break;
    }
    // Quick emoji reaction or a short preset/custom message, shown as a speech
    // bubble at the sender's seat on every table.
    case 'emote':
    case 'chat': {
      const room = rooms.get(client.roomCode);
      if (!room || client.seat < 0) break;
      const now = Date.now();
      if (now - client.lastChatAt < 1200) break;      // rate limit: ~1 per 1.2s
      client.lastChatAt = now;
      const text = String(msg.t === 'emote' ? (msg.emoji || '') : (msg.text || ''))
        .replace(/\s+/g, ' ').trim().slice(0, msg.t === 'emote' ? 8 : 60);
      if (!text) break;
      sendAll(room, { t: msg.t, seat: client.seat, name: client.name, text });
      break;
    }
    // Voice chat presence: this seat is opting in/out of the audio mesh. We
    // republish the roster so every client (re)dials the right peers.
    case 'voice': {
      const room = rooms.get(client.roomCode);
      if (!room || client.seat < 0) break;
      const seat = room.seats[client.seat];
      if (!seat) break;
      seat.voice = !!msg.on;
      broadcastVoice(room);
      break;
    }
    // WebRTC signaling relay: forward an opaque offer/answer/ICE blob to one
    // target seat in the same room. Media itself never touches the server.
    case 'rtc': {
      const room = rooms.get(client.roomCode);
      if (!room || client.seat < 0) break;
      const to = msg.to | 0;
      const seat = room.seats[to];
      if (!seat || !seat.clientId) break;
      const c = clients.get(seat.clientId);
      if (c) c.send({ t: 'rtc', from: client.seat, data: msg.data });
      break;
    }
    case 'create': {
      const room = makeRoom(client);
      // Pick the game: Treeky uses its own rule set + seat limits.
      if (msg.gameType === 'treeky') {
        room.gameType = 'treeky'; room.rules = BQ.cloneTreekyRules();
        const tr = msg.treekyRules || {};
        if ([7, 8, 10, 12].indexOf(tr.handSize) >= 0) room.rules.handSize = tr.handSize;
        if (typeof tr.botThinkMs === 'number') room.rules.botThinkMs = Math.max(300, Math.min(3000, tr.botThinkMs));
        if (tr.decks === 1 || tr.decks === 2) room.rules.decks = tr.decks;
        if (tr.playDirection === 'left' || tr.playDirection === 'right') room.rules.playDirection = tr.playDirection;
      }
      client.name = (msg.name || 'Host').slice(0, 14);
      const token = makeToken();
      room.hostToken = token;
      room.seats.push({ clientId: client.id, name: client.name, isBot: false, token });
      client.roomCode = room.code; client.seat = 0;
      client.send({ t: 'joined', code: room.code, seat: 0, token, host: true });
      broadcastLobby(room);
      break;
    }
    case 'join': {
      // Codes are uppercase letters/digits with no spaces (and never contain the
      // ambiguous 0/1/I/O glyphs), so just uppercase + strip whitespace.
      const code = (msg.code || '').toUpperCase().replace(/\s+/g, '');
      let room = code ? rooms.get(code) : null;

      // Joinable rooms: a lobby with a free seat, OR an in-progress game where a
      // player left and the host chose to wait for a new player (an "open" seat).
      const openLobby = [...rooms.values()].filter((r) => !r.started && r.seats.length < seatCap(r));
      const openMid = [...rooms.values()].filter((r) => r.started && r.seats.some((s) => s.open));
      const open = openLobby.concat(openMid);

      if (!room) {
        if (open.length === 1) {
          // Only one game open — join it regardless of what was typed. This is the
          // common LAN case and removes all code-typing friction.
          room = open[0];
        } else if (open.length === 0) {
          return client.send({ t: 'error', msg: 'No open rooms yet. Ask the host to press "Create Room" first.' });
        } else {
          return client.send({ t: 'error', msg: 'Room "' + (code || '—') + '" not found. Open rooms: ' + open.map((r) => r.code).join(', ') + '. Type one of these.' });
        }
      }

      client.name = (msg.name || 'Player').slice(0, 14);

      // Joining an in-progress game: take over an opened seat (its hand + score
      // carry over from the player who left). This also resolves the host's
      // vacancy prompt and un-freezes the table.
      if (room.started) {
        const openSeat = room.seats.findIndex((s) => s.open);
        if (openSeat < 0) return client.send({ t: 'error', msg: 'That game already started.' });
        const token = makeToken();
        const seat = room.seats[openSeat];
        if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
        seat.clientId = client.id;
        seat.name = client.name;
        seat.isBot = false;
        seat.open = false;
        seat.disconnected = false;
        seat.botFill = false;
        seat.token = token;
        if (room.engine && room.engine.players[openSeat]) room.engine.players[openSeat].name = client.name;
        client.roomCode = room.code; client.seat = openSeat;
        if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
        client.send({ t: 'joined', code: room.code, seat: openSeat, token, host: false });
        client.send({ t: 'game', snapshot: seatSnap(room, openSeat), hint: { name: 'resync' } });
        resumePlay(room);   // clears the vacancy + un-freezes everyone
        break;
      }

      if (room.seats.length >= seatCap(room)) return client.send({ t: 'error', msg: 'Room ' + room.code + ' is full.' });
      const seat = room.seats.length;
      const token = makeToken();
      room.seats.push({ clientId: client.id, name: client.name, isBot: false, token });
      client.roomCode = room.code; client.seat = seat;
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
      client.send({ t: 'joined', code: room.code, seat, token, host: false });
      broadcastLobby(room);
      break;
    }
    // Spectate / livestream: attach this connection as a watcher (no seat). It
    // receives the public table with every hand HIDDEN and can never play.
    case 'spectate': {
      const code = (msg.code || '').toUpperCase().replace(/\s+/g, '');
      let room = code ? rooms.get(code) : null;
      if (!room) {
        const live = [...rooms.values()].filter((r) => r.started && r.engine);
        if (live.length === 1) room = live[0];
        else if (live.length === 0) return client.send({ t: 'error', msg: 'No live game to watch yet. Ask the host to start one.' });
        else return client.send({ t: 'error', msg: 'Which game? Live now: ' + live.map((r) => r.code).join(', ') + '. Type one of these.' });
      }
      // Leaving any prior seat/room association: a spectator holds no seat.
      client.roomCode = room.code;
      client.seat = -1;
      client.name = (msg.name || 'Spectator').slice(0, 14);
      room.spectators.add(client.id);
      client.send({ t: 'spectating', code: room.code });
      if (room.started && room.engine) {
        const e = room.engine;
        const snap = () => (room.gameType === 'treeky' ? treekySpectatorSnapshot(room) : spectatorSnapshot(room));
        client.send({ t: 'game', snapshot: snap(), hint: { name: 'resync' } });
        if (room.gameType === 'treeky') {
          if (e.phase === 'gameOver' && room.lastGameOver) {
            client.send({ t: 'game', snapshot: snap(), hint: Object.assign({ name: 'gameOver' }, room.lastGameOver) });
          }
        } else if (e.phase === 'roundEnd' && room.lastRoundEnd) {
          client.send({ t: 'game', snapshot: snap(), hint: Object.assign({ name: 'roundEnd' }, room.lastRoundEnd) });
        } else if (e.phase === 'gameOver' && room.lastGameOver) {
          client.send({ t: 'game', snapshot: snap(), hint: Object.assign({ name: 'gameOver' }, room.lastGameOver) });
        }
        broadcastPresence(room);   // seed the "who's online" badges on the spectator's table
      }
      break;
    }
    // Reconnect: a refreshed / dropped player presents their session token and
    // we re-attach this NEW connection to their EXISTING seat — same room, same
    // hand, same score — instead of creating a new one.
    case 'resume': {
      const code = (msg.code || '').toUpperCase().replace(/\s+/g, '');
      const room = code ? rooms.get(code) : null;
      if (!room) return client.send({ t: 'resumeFail', reason: 'room-gone' });
      const seatIdx = room.seats.findIndex((s) => s.token && s.token === msg.token);
      if (seatIdx < 0) return client.send({ t: 'resumeFail', reason: 'seat-gone' });

      const seat = room.seats[seatIdx];
      if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
      if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
      if (seat.botPlayTimer) { clearTimeout(seat.botPlayTimer); seat.botPlayTimer = null; }
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }

      seat.clientId = client.id;
      seat.isBot = false;
      seat.disconnected = false;
      seat.botFill = false;
      client.roomCode = code;
      client.seat = seatIdx;
      client.name = seat.name;
      const isHost = !!(room.hostToken && room.hostToken === seat.token);
      if (isHost) room.hostId = client.id;

      client.send({ t: 'joined', code, seat: seatIdx, token: seat.token, host: isHost });

      if (room.started && room.engine) {
        const e = room.engine;
        // 1) a full snapshot so the table fully repaints from the current state
        client.send({ t: 'game', snapshot: seatSnap(room, seatIdx), hint: { name: 'resync' } });
        // 2) re-show the round-summary / game-over overlay if we're parked there
        if (room.gameType !== 'treeky' && e.phase === 'roundEnd' && room.lastRoundEnd) {
          client.send({ t: 'game', snapshot: seatSnap(room, seatIdx), hint: Object.assign({ name: 'roundEnd' }, room.lastRoundEnd) });
          broadcastReady(room);
        } else if (e.phase === 'gameOver' && room.lastGameOver) {
          client.send({ t: 'game', snapshot: seatSnap(room, seatIdx), hint: Object.assign({ name: 'gameOver' }, room.lastGameOver) });
        }
        // tell everyone else's table the seat is a human again (drops the BOT tag)
        broadcast(room, { name: 'sync' });
        broadcastPresence(room, { kind: 'back', name: seat.name });
        // If the table is frozen because ANOTHER seat is empty, the reconnecting
        // player needs to see the pause overlay too (and re-prompt the host).
        if (room.paused) {
          client.send({ t: 'paused', paused: true, name: room.vacancy && room.vacancy.name, code: room.code });
          if (isHost && room.vacancy) promptHostVacancy(room);
        }
      } else {
        broadcastLobby(room);
        broadcastPresence(room, { kind: 'back', name: seat.name });
      }
      break;
    }
    case 'rules': {
      const room = rooms.get(client.roomCode);
      if (room && room.hostId === client.id && !room.started && msg.rules) {
        Object.assign(room.rules, msg.rules);
        broadcastLobby(room);
      }
      break;
    }
    case 'start': {
      const room = rooms.get(client.roomCode);
      if (room && room.hostId === client.id && !room.started) {
        // The host may pass a full seat layout: msg.layout is an array of length
        // playerCount where each entry is either a current (human) seat index or
        // 'bot'. Seat 0 is the owner; play then proceeds around the table.
        if (Array.isArray(msg.layout)) applySeatLayout(room, msg.layout);
        startGame(room);
      }
      break;
    }
    // ---- Treeky actions (play carries an optional suit for a Jack) -------
    case 'draw': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.paused || room.gameType !== 'treeky') break;
      const e = room.engine;
      if (e.phase === 'awaitHuman' && e.currentPlayerIndex === client.seat) e.drawForTurn(client.seat);
      break;
    }
    case 'pass': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.paused || room.gameType !== 'treeky') break;
      const e = room.engine;
      if (e.phase === 'awaitHuman' && e.currentPlayerIndex === client.seat) e.pass(client.seat);
      break;
    }
    case 'declareLast': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.paused || room.gameType !== 'treeky') break;
      const e = room.engine;
      if (e.currentPlayerIndex === client.seat) e.declareLast(client.seat);
      break;
    }
    case 'chooseSuit': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.paused || room.gameType !== 'treeky') break;
      const e = room.engine;
      if (e.phase === 'awaitSuit' && e.currentPlayerIndex === client.seat) e.chooseSuit(client.seat, msg.suit);
      break;
    }
    // Table owner reshuffles the spent pile back into the deck (deck finished).
    case 'reshuffle': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.gameType !== 'treeky') break;
      if (client.id === room.hostId && room.engine.phase === 'awaitReshuffle') room.engine.reshuffle();
      break;
    }
    case 'play': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine) return;
      if (room.paused) return;   // play is frozen (a player left) — ignore moves
      const e = room.engine;
      if (room.gameType === 'treeky') {
        if (e.phase === 'awaitHuman' && e.currentPlayerIndex === client.seat) e.playHuman(msg.cardId, msg.suit);
        else if (e.phase === 'awaitSuit' && e.currentPlayerIndex === client.seat && msg.suit) e.chooseSuit(client.seat, msg.suit);
        return;
      }
      if (e.phase === 'awaitHuman' && e.currentPlayerIndex === client.seat) {
        // playHuman emits cardPlayed synchronously — the flag rides along into
        // that one broadcast (card-smash slam shown on every table).
        // smash = style id, whitelisted; legacy clients send punch:true only.
        room.punchNext = SMASH_KINDS.has(msg.smash) ? msg.smash
                       : (msg.punch ? 'punch' : null);
        e.playHuman(msg.cardId);
        room.punchNext = null;
        // playing a card refunds the attack-taunt credit (one per move)
        const s = room.seats[client.seat];
        if (s) s.attackUsed = false;
      }
      break;
    }
    // Host resolves a left-seat: 'bot' fills it and resumes; 'open' keeps the
    // game paused with the seat joinable until a new player takes it.
    case 'resolveVacancy': {
      const room = rooms.get(client.roomCode);
      if (!room || room.hostId !== client.id || !room.vacancy) break;
      if (msg.choice === 'bot') {
        fillSeatWithBot(room, room.vacancy.seat);
        resumePlay(room);
      } else {
        const seat = room.seats[room.vacancy.seat];
        if (seat) seat.open = true;
        broadcastPaused(room, true, room.vacancy.name);
      }
      break;
    }
    // A player confirms they're ready for the next round. The round only
    // advances once EVERY connected human has confirmed.
    case 'ready': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine || room.engine.phase !== 'roundEnd') break;
      room.ready.add(client.seat);
      checkReady(room);
      break;
    }
    // (kept for compatibility) host force-advance — also routed through ready.
    case 'next': {
      const room = rooms.get(client.roomCode);
      if (room && room.engine && room.engine.phase === 'roundEnd') {
        room.ready.add(client.seat);
        checkReady(room);
      }
      break;
    }
    case 'again': {
      const room = rooms.get(client.roomCode);
      if (room && room.hostId === client.id && room.engine && room.engine.phase === 'gameOver') {
        startGame(room);
      }
      break;
    }
    // Host removes a player from the LOBBY (pre-start). The seat is freed
    // immediately and its token cleared so the kicked player can't resume back
    // into it; the kicked client is told to return to the menu. Mid-game
    // departures go through the leave / vacancy (bot-fill) flow instead.
    case 'kick': {
      const room = rooms.get(client.roomCode);
      if (!room || room.hostId !== client.id || room.started) break;
      const target = msg.seat | 0;
      if (target === client.seat) break;          // the host can't kick themselves
      const seat = room.seats[target];
      if (!seat) break;

      if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
      if (room.hostToken && room.hostToken === seat.token) room.hostToken = null; // safety
      seat.token = null;                           // a resume with this token now fails

      // Detach the kicked client (if connected) so its eventual socket close
      // won't touch this room, and tell it to clean up + return to the menu.
      if (seat.clientId) {
        const c = clients.get(seat.clientId);
        if (c) {
          c.roomCode = null; c.seat = -1;
          c.send({ t: 'kicked', code: room.code });
        }
      }

      room.seats.splice(target, 1);
      // Re-index remaining seats so each connected client knows its new seat.
      room.seats.forEach((s, i) => { if (s.clientId) { const cc = clients.get(s.clientId); if (cc) cc.seat = i; } });
      broadcastLobby(room);
      break;
    }
    case 'leave': dropClient(client, true); break;
  }
}

// Apply a host-chosen seat layout for the whole table (humans AND bots). `layout`
// is an array of length playerCount; each entry is either a current (human) seat
// index or 'bot'. Index 0 becomes seat 1 (the owner / first to play), index 1 the
// next seat to the right, and so on. Every joined human must appear exactly once;
// the remaining seats become bots. Returns true only if the layout was valid and
// applied — otherwise the caller falls back to the default (bots fill the tail).
function applySeatLayout(room, layout) {
  if (room.started) return false;
  const N = room.rules.playerCount;
  if (!Array.isArray(layout) || layout.length !== N) return false;

  const humanIdxs = [];
  for (const v of layout) {
    if (v === 'bot' || v === null) continue;
    if (!Number.isInteger(v) || v < 0 || v >= room.seats.length) return false;
    humanIdxs.push(v);
  }
  // Every current human seat must be placed exactly once.
  if (humanIdxs.length !== room.seats.length) return false;
  if (new Set(humanIdxs).size !== humanIdxs.length) return false;

  // Name the new bot seats from the pool, avoiding any human's name.
  const used = new Set(room.seats.map((s) => s.name));
  const pool = BQ.cloneOf(room.rules.botNames).filter((n) => !used.has(n));
  let botN = 0;
  const newSeats = layout.map((v) => {
    if (v === 'bot' || v === null) {
      const name = pool.shift() || ('Bot ' + (++botN));
      return { clientId: null, name, isBot: true };
    }
    return room.seats[v];
  });

  room.seats = newSeats;
  // Re-point each connected client at its new seat index.
  room.seats.forEach((s, i) => { if (s.clientId) { const c = clients.get(s.clientId); if (c) c.seat = i; } });
  return true;
}

/* ---- start / run a game ------------------------------------------------- */
function startGame(room) {
  if (room.gameType === 'treeky') return startTreekyGame(room);
  // fill empty seats with bots up to playerCount
  const botPool = BQ.cloneOf(room.rules.botNames);
  while (room.seats.length < room.rules.playerCount) {
    const name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0] || ('Bot ' + room.seats.length);
    room.seats.push({ clientId: null, name, isBot: true });
  }
  room.started = true;
  room.lastRoundEnd = null;
  room.lastGameOver = null;

  const engine = new BQ.GameEngine(room.rules);
  engine.initWithPlayers(room.seats.map((s) => s.name));
  room.engine = engine;

  room.ready = new Set();
  wireEngine(room);
  engine.startRound();
  broadcastPresence(room);   // seed the "who's online" indicator on every table
}

function wireEngine(room) {
  const e = room.engine;

  e.on('roundStart', (ev) => {
    room.lastRoundEnd = null;
    room.seats.forEach((s) => { s.attackUsed = false; });   // fresh attack credit each round
    broadcast(room, { name: 'roundStart', leaderIndex: ev.leaderIndex });
  });
  e.on('heartsBroken', () => broadcast(room, { name: 'heartsBroken' }));
  e.on('cardPlayed', () => { broadcast(room, { name: 'cardPlayed', punch: !!room.punchNext, smash: room.punchNext || undefined }); room.punchNext = null; });
  e.on('trickWon', (ev) => broadcast(room, {
    name: 'trickWon', winnerIndex: ev.winnerIndex, points: ev.points, handNo: ev.handNo,
    tookQueen: ev.tookQueen, queenDisregarded: ev.queenDisregarded,
  }));
  e.on('roundEnd', (ev) => {
    room.lastRoundEnd = { round: ev.round, roundScores: ev.roundScores, totals: ev.totals, breakdown: ev.breakdown, tricks: ev.tricks, cutShort: !!ev.cutShort, gameOver: !!ev.gameOver };
    broadcast(room, Object.assign({ name: 'roundEnd' }, room.lastRoundEnd));
    // Begin collecting "ready" confirmations for the next round (unless the
    // game just ended — gameOver fires right after this).
    room.ready = new Set();
    if (e.phase !== 'gameOver') broadcastReady(room);
  });
  e.on('gameOver', (ev) => {
    room.lastGameOver = { totals: ev.totals, winnerIndex: ev.winnerIndex, ranking: ev.ranking };
    broadcast(room, Object.assign({ name: 'gameOver' }, room.lastGameOver));
  });

  // On every turn, if the seat is a bot (or a disconnected player), the SERVER
  // plays for it after a short think delay.
  e.on('turn', (ev) => {
    broadcast(room, { name: 'turn' });
    if (seatIsBot(room, ev.playerIndex)) scheduleBot(room, ev.playerIndex);
  });
}

function scheduleBot(room, seat) {
  if (room.gameType === 'treeky') return scheduleTreekyBot(room, seat);
  if (room.paused) return;                        // play is frozen (a player left)
  if (seatAwaitingReconnect(room, seat)) return;  // dropped human still inside their grace window
  const e = room.engine;
  const s = room.seats[seat];
  if (s && s.botPlayTimer) { clearTimeout(s.botPlayTimer); s.botPlayTimer = null; }
  const timer = setTimeout(() => {
    if (s) s.botPlayTimer = null;
    if (room.paused) return;
    if (!room.engine || room.engine !== e) return;
    if (e.phase === 'awaitHuman' && e.currentPlayerIndex === seat && seatIsBot(room, seat)) {
      const card = BQ.AI.chooseCard(e, seat);
      if (card) e.playHuman(card.id);
    }
  }, Math.max(120, room.rules.botThinkMs));
  if (s) s.botPlayTimer = timer;
}

/* =============================================================================
 * TREEKY — server-side game type
 * ===========================================================================*/

// Max seats a room can hold: Treeky scales to maxPlayers; Black Queen is fixed.
function seatCap(room) {
  return room.gameType === 'treeky' ? (room.rules.maxPlayers || 10) : room.rules.playerCount;
}
// A per-seat snapshot for whichever game the room is running.
function seatSnap(room, seat) {
  return room.gameType === 'treeky' ? treekySnapshotFor(room, seat) : snapshotFor(room, seat);
}

function startTreekyGame(room) {
  // Bots fill empty seats only up to the minimum table size (fillToMin, e.g. 4).
  // With enough humans (up to maxPlayers) no bots are added.
  const fillTo = Math.min(room.rules.fillToMin || 4, seatCap(room));
  const botPool = BQ.cloneOf(room.rules.botNames);
  const used = new Set(room.seats.map((s) => s.name));
  while (room.seats.length < fillTo) {
    let name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
    while (name && used.has(name)) name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
    name = name || ('Bot ' + (room.seats.length + 1));
    used.add(name);
    room.seats.push({ clientId: null, name, isBot: true });
  }
  room.started = true;
  room.lastGameOver = null;

  const engine = new BQ.TreekyEngine(room.rules);
  engine.initWithPlayers(room.seats.map((s) => s.name));
  room.engine = engine;

  room.ready = new Set();
  wireTreekyEngine(room);
  engine.start();
  broadcastPresence(room);
}

function wireTreekyEngine(room) {
  const e = room.engine;
  e.on('gameStart', () => broadcast(room, { name: 'gameStart' }));
  e.on('cardPlayed', (ev) => broadcast(room, { name: 'cardPlayed', playerIndex: ev.playerIndex, isThree: ev.isThree, isJack: ev.isJack }));
  e.on('suitChosen', (ev) => broadcast(room, { name: 'suitChosen', playerIndex: ev.playerIndex, suit: ev.suit }));
  e.on('cardsDrawn', (ev) => broadcast(room, { name: 'cardsDrawn', playerIndex: ev.playerIndex, count: ev.count, penalty: ev.penalty, reason: ev.reason }));
  e.on('lastCardDeclared', (ev) => broadcast(room, { name: 'lastCardDeclared', playerIndex: ev.playerIndex }));
  e.on('needReshuffle', () => broadcast(room, { name: 'needReshuffle' }));
  e.on('reshuffled', () => broadcast(room, { name: 'reshuffled' }));
  e.on('playerFinished', (ev) => broadcast(room, { name: 'playerFinished', playerIndex: ev.playerIndex, rank: ev.rank, name: ev.name }));
  e.on('gameOver', (ev) => {
    room.lastGameOver = { ranking: ev.ranking, loserIndex: ev.loserIndex };
    broadcast(room, Object.assign({ name: 'gameOver' }, room.lastGameOver));
  });
  e.on('turn', (ev) => {
    broadcast(room, { name: 'turn' });
    if (seatIsBot(room, ev.playerIndex)) scheduleBot(room, ev.playerIndex);
  });
}

function scheduleTreekyBot(room, seat) {
  if (room.paused) return;
  if (seatAwaitingReconnect(room, seat)) return;
  const e = room.engine;
  const s = room.seats[seat];
  if (s && s.botPlayTimer) { clearTimeout(s.botPlayTimer); s.botPlayTimer = null; }
  const timer = setTimeout(() => {
    if (s) s.botPlayTimer = null;
    if (room.paused || !room.engine || room.engine !== e) return;
    if (e.currentPlayerIndex !== seat || !seatIsBot(room, seat)) return;
    if (e.phase === 'awaitSuit') { e.chooseSuit(seat, BQ.TreekyAI.bestSuit(e.players[seat])); return; }
    if (e.phase !== 'awaitHuman') return;
    const move = BQ.TreekyAI.chooseMove(e, seat);
    if (!move || move.type === 'draw') { e.drawForTurn(seat); return; }
    if (move.type === 'pass') { e.pass(seat); return; }
    if (e.players[seat].hand.length === 2) e.players[seat].declaredLast = true;  // bots never miss
    e.playHuman(move.cardId, move.suit);
  }, Math.max(150, room.rules.botThinkMs));
  if (s) s.botPlayTimer = timer;
}

// A small rules subset the Treeky client needs (the UI checks wildRank).
function treekyRulesPayload(r) {
  return { gameName: r.gameName, wildRank: r.wildRank, drawRank: r.drawRank, drawPenalty: r.drawPenalty, handSize: r.handSize };
}

function treekySnapshotFor(room, seat) {
  const e = room.engine;
  const myTurn = e.phase === 'awaitHuman' && e.currentPlayerIndex === seat;
  const legal = myTurn ? e.legalCards(seat).map((c) => c.id) : [];
  const top = e.topCard();
  const phase = e.phase === 'awaitReshuffle' ? 'awaitReshuffle'
    : myTurn ? 'awaitHuman'
    : (e.phase === 'awaitSuit' && e.currentPlayerIndex === seat ? 'awaitSuit'
    : (e.phase === 'gameOver' ? 'gameOver' : 'playing'));
  return {
    gameType: 'treeky',
    you: seat,
    youAreHost: !!(room.seats[seat] && room.seats[seat].clientId === room.hostId),
    phase,
    dealerIndex: e.dealerIndex,
    currentPlayerIndex: e.currentPlayerIndex,
    activeSuit: e.activeSuit,
    pendingDraw: e.pendingDraw,
    drawCount: e.drawPile.length,
    topCard: top ? { rank: top.rank, suit: top.suit, id: top.id } : null,
    finishedOrder: e.finishedOrder.slice(),
    rules: treekyRulesPayload(e.rules),
    players: e.players.map((p, i) => ({
      index: i, name: p.name, isBot: seatIsBot(room, i),
      offline: !!(room.seats[i] && room.seats[i].disconnected),
      finished: p.finished, finishRank: p.finishRank,
      handCount: p.hand.length,
      hand: i === seat ? p.hand.map((c) => ({ rank: c.rank, suit: c.suit, id: c.id })) : null,
    })),
    legalCardIds: legal,
    canDraw: myTurn && !e._drewThisTurn && !e._noDrawThisTurn,   // may draw even with a card to throw
    canPass: myTurn && e._drewThisTurn && legal.length > 0,       // pass only after drawing, if you can throw
  };
}

// One payload for all spectators (and finished players watching): every hand
// hidden, the discard top + counts visible, never anyone's turn.
function treekySpectatorSnapshot(room) {
  const s = treekySnapshotFor(room, 0);
  s.you = -1; s.spectator = true; s.youAreHost = false;
  s.phase = (room.engine.phase === 'awaitReshuffle') ? 'awaitReshuffle' : 'playing';
  s.legalCardIds = []; s.canDraw = false; s.canPass = false;
  s.players = s.players.map((p) => Object.assign({}, p, { hand: null }));
  return s;
}

function treekyBroadcast(room, hint) {
  room.seats.forEach((s, seat) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (!c) return;
    c.send({ t: 'game', snapshot: treekySnapshotFor(room, seat), hint });
  });
  if (room.spectators && room.spectators.size && room.engine) {
    const snap = treekySpectatorSnapshot(room);
    for (const id of room.spectators) { const c = clients.get(id); if (c) c.send({ t: 'game', snapshot: snap, hint }); }
  }
}

/* ---- build a personalized snapshot for one seat ------------------------- */
function snapshotFor(room, seat) {
  const e = room.engine;
  const myTurn = e.phase === 'awaitHuman' && e.currentPlayerIndex === seat;
  return {
    you: seat,
    phase: myTurn ? 'awaitHuman' : 'playing',
    round: e.round,
    dealerIndex: e.dealerIndex,
    currentPlayerIndex: e.currentPlayerIndex,
    heartsBroken: e.heartsBroken,
    rules: {
      queenCard: e.rules.queenCard,
      queenPoints: e.rules.queenPoints,
      heartPoints: e.rules.heartPoints,
      expectedRoundTotal: e.rules.expectedRoundTotal,
      lowestScoreWins: e.rules.lowestScoreWins,
      queenExemptScore: e.rules.queenExemptScore,
      queenExemptEnabled: e.rules.queenExemptEnabled,
      consecutiveZeroRuleEnabled: e.rules.consecutiveZeroRuleEnabled,
      consecutiveZeroLimit: e.rules.consecutiveZeroLimit,
      consecutiveZeroPenalty: e.rules.consecutiveZeroPenalty,
      noTrickRuleEnabled: e.rules.noTrickRuleEnabled,
      noTrickPenalty: e.rules.noTrickPenalty,
    },
    players: e.players.map((p, i) => ({
      index: i,
      name: p.name,
      isBot: seatIsBot(room, i),
      offline: !!(room.seats[i] && room.seats[i].disconnected),
      totalScore: p.totalScore,
      tricksWon: p.tricksWon,
      roundHistory: p.roundHistory,
      queenTakes: p.queenTakes,
      consecutiveZeros: p.consecutiveZeros,
      penalty: p._penalty || 0,
      handCount: p.hand.length,
      hand: i === seat ? p.hand.map((c) => ({ rank: c.rank, suit: c.suit })) : null,
    })),
    currentTrick: e.currentTrick.map((x) => ({ playerIndex: x.playerIndex, card: { rank: x.card.rank, suit: x.card.suit } })),
    trickLog: e.trickLog,
    legalCardIds: myTurn ? e.legalCards(seat).map((c) => c.id) : [],
  };
}

// A spectator's snapshot: the public table with EVERY hand hidden (only counts),
// no playable cards, and never "your turn". One payload serves all spectators.
function spectatorSnapshot(room) {
  const s = snapshotFor(room, 0);     // seat 0 anchors the view (south)
  s.you = -1;
  s.spectator = true;
  s.phase = 'playing';                // a spectator never acts
  s.legalCardIds = [];
  s.players = s.players.map((p) => Object.assign({}, p, { hand: null }));
  return s;
}

function broadcast(room, hint) {
  if (room.gameType === 'treeky') return treekyBroadcast(room, hint);
  room.seats.forEach((s, seat) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (!c) return;
    c.send({ t: 'game', snapshot: snapshotFor(room, seat), hint });
  });
  if (room.spectators && room.spectators.size && room.engine) {
    const snap = spectatorSnapshot(room);
    for (const id of room.spectators) { const c = clients.get(id); if (c) c.send({ t: 'game', snapshot: snap, hint }); }
  }
}

/* ---- disconnect handling ------------------------------------------------ */
function dropClient(client, intentional) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  const room = rooms.get(client.roomCode);
  if (!room) return;

  // Spectators hold no seat — just drop them from the watch list and stop.
  if (room.spectators && room.spectators.has(client.id)) {
    room.spectators.delete(client.id);
    return;
  }

  const seat = room.seats[client.seat];
  if (seat && seat.clientId === client.id) {
    if (intentional) {
      // The player chose to leave: surrender the seat identity for good (clear
      // the token so it can't be reclaimed).
      const wasHost = room.hostToken && room.hostToken === seat.token;
      seat.token = null;
      if (wasHost) room.hostToken = null;
      if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
      if (seat.botPlayTimer) { clearTimeout(seat.botPlayTimer); seat.botPlayTimer = null; }
      if (room.started) {
        const active = room.engine && room.engine.phase === 'awaitHuman';
        if (active) {
          // Mid-play: FREEZE the table and ask the host what to do with the empty
          // seat — add a bot (resume) or wait for a new player to take it. The
          // seat is left open (not a bot) so play stays paused until resolved.
          seat.clientId = null; seat.isBot = false; seat.disconnected = false;
          seat.botFill = false; seat.open = true;
          room.paused = true;
          room.vacancy = { seat: client.seat, name: seat.name };
        } else {
          // Not mid-play (round summary / game over): just bot-fill so the
          // ready / play-again flow isn't blocked.
          seat.clientId = null; seat.isBot = true; seat.disconnected = false; seat.open = false;
          if (room.engine && room.engine.phase === 'roundEnd') { room.ready.delete(client.seat); checkReady(room); }
          broadcast(room, { name: 'sync' });
        }
        broadcastPresence(room, { kind: 'left', name: seat.name });
      } else {
        room.seats.splice(client.seat, 1);
        room.seats.forEach((s, i) => { if (s.clientId) { const c = clients.get(s.clientId); if (c) c.seat = i; } });
      }
    } else if (room.started) {
      // Unintentional drop (refresh / Wi-Fi blip): HOLD the seat + token and
      // freeze THIS seat's turn for a grace window so the player reclaims their
      // exact seat AND turn with a `resume`. A bot only takes over if they don't
      // return in time — so a refresh never auto-plays a card for them.
      seat.clientId = null; seat.isBot = true; seat.disconnected = true;
      beginDisconnectGrace(room, client.seat);
      if (room.engine && room.engine.phase === 'roundEnd') { room.ready.delete(client.seat); checkReady(room); }
      broadcast(room, { name: 'sync' });
      broadcastPresence(room, { kind: 'lost', name: seat.name });
    } else {
      // Unintentional drop in the lobby: hold the seat for a short grace window
      // so a refresh lands them back in the same spot, then free it.
      seat.clientId = null; seat.disconnected = true;
      if (seat.graceTimer) clearTimeout(seat.graceTimer);
      seat.graceTimer = setTimeout(() => {
        const idx = room.seats.indexOf(seat);
        if (idx >= 0 && seat.disconnected && !seat.clientId) {
          room.seats.splice(idx, 1);
          room.seats.forEach((s, i) => { if (s.clientId) { const c = clients.get(s.clientId); if (c) c.seat = i; } });
          if (room.seats.some((s) => s.clientId)) broadcastLobby(room);
        }
      }, RECONNECT_GRACE_MS);
      broadcastLobby(room);
    }
  }

  // Host left? Temporarily delegate to a live human; the original reclaims it
  // via their token if they reconnect.
  if (room.hostId === client.id) {
    const next = room.seats.find((s) => s.clientId && clients.get(s.clientId));
    if (next) room.hostId = next.clientId;
  }

  const anyHuman = room.seats.some((s) => s.clientId && clients.get(s.clientId));
  if (!anyHuman) {
    // Nobody left to play or to decide a vacancy — don't hold a pause open.
    if (room.paused) { room.paused = false; room.vacancy = null; }
    if (!room.started) { if (room.botTimer) clearTimeout(room.botTimer); rooms.delete(room.code); }
    else scheduleRoomCleanup(room);   // hold the in-progress game for a reconnect
  } else if (room.paused && room.vacancy) {
    // A player left mid-game: freeze everyone and ask the current host to add a
    // bot or wait for a new player to take the seat.
    broadcastPaused(room, true, room.vacancy.name);
    promptHostVacancy(room);
  } else if (!room.started) broadcastLobby(room);
  else broadcast(room, { name: 'sync' });
}

/* =============================================================================
 * Boot
 * ===========================================================================*/
server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push('http://' + ni.address + ':' + PORT);
    }
  }
  console.log('\n  ♛  Black Queen — LAN server running\n');
  console.log('  On this computer:   http://localhost:' + PORT);
  urls.forEach((u) => console.log('  On your network:    ' + u + '   <-- share this with players'));
  console.log('\n  Press Ctrl+C to stop.\n');
});
