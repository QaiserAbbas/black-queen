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
const BQ = globalThis.BQ;

// Cloud hosts (Render/Railway/Fly/Heroku) inject the port via process.env.PORT.
const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
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
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
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

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

// Returns { messages:[str], rest:Buffer, closed:bool } parsed from a buffer.
function decodeFrames(buf) {
  const messages = [];
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

    if (opcode === 0x8) { closed = true; break; }      // close
    else if (opcode === 0x9) { /* ping */ }            // (we ignore; clients rarely ping)
    else if (opcode === 0x1 || opcode === 0x0) messages.push(data.toString('utf8'));
  }
  return { messages, rest: buf.slice(offset), closed };
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
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
    send(obj) {
      try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (_) {}
    },
  };
  clients.set(client.id, client);

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    const { messages, rest, closed } = decodeFrames(client.buf);
    client.buf = rest;
    for (const m of messages) {
      let msg; try { msg = JSON.parse(m); } catch (_) { continue; }
      handleMessage(client, msg);
    }
    if (closed) socket.end();
  });
  socket.on('close', () => dropClient(client));
  socket.on('error', () => dropClient(client));
});

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
    players: room.seats.map((s, i) => ({ seat: i, name: s.name, isBot: s.isBot, you: false })),
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
}

/* ---- message router ---------------------------------------------------- */
function handleMessage(client, msg) {
  switch (msg.t) {
    case 'create': {
      const room = makeRoom(client);
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
      const openLobby = [...rooms.values()].filter((r) => !r.started && r.seats.length < r.rules.playerCount);
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
        client.send({ t: 'game', snapshot: snapshotFor(room, openSeat), hint: { name: 'resync' } });
        resumePlay(room);   // clears the vacancy + un-freezes everyone
        break;
      }

      if (room.seats.length >= room.rules.playerCount) return client.send({ t: 'error', msg: 'Room ' + room.code + ' is full.' });
      const seat = room.seats.length;
      const token = makeToken();
      room.seats.push({ clientId: client.id, name: client.name, isBot: false, token });
      client.roomCode = room.code; client.seat = seat;
      if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
      client.send({ t: 'joined', code: room.code, seat, token, host: false });
      broadcastLobby(room);
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
        client.send({ t: 'game', snapshot: snapshotFor(room, seatIdx), hint: { name: 'resync' } });
        // 2) re-show the round-summary / game-over overlay if we're parked there
        if (e.phase === 'roundEnd' && room.lastRoundEnd) {
          client.send({ t: 'game', snapshot: snapshotFor(room, seatIdx), hint: Object.assign({ name: 'roundEnd' }, room.lastRoundEnd) });
          broadcastReady(room);
        } else if (e.phase === 'gameOver' && room.lastGameOver) {
          client.send({ t: 'game', snapshot: snapshotFor(room, seatIdx), hint: Object.assign({ name: 'gameOver' }, room.lastGameOver) });
        }
        // tell everyone else's table the seat is a human again (drops the BOT tag)
        broadcast(room, { name: 'sync' });
        // If the table is frozen because ANOTHER seat is empty, the reconnecting
        // player needs to see the pause overlay too (and re-prompt the host).
        if (room.paused) {
          client.send({ t: 'paused', paused: true, name: room.vacancy && room.vacancy.name, code: room.code });
          if (isHost && room.vacancy) promptHostVacancy(room);
        }
      } else {
        broadcastLobby(room);
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
    case 'play': {
      const room = rooms.get(client.roomCode);
      if (!room || !room.engine) return;
      if (room.paused) return;   // play is frozen (a player left) — ignore moves
      const e = room.engine;
      if (e.phase === 'awaitHuman' && e.currentPlayerIndex === client.seat) {
        e.playHuman(msg.cardId);
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
}

function wireEngine(room) {
  const e = room.engine;

  e.on('roundStart', (ev) => { room.lastRoundEnd = null; broadcast(room, { name: 'roundStart', leaderIndex: ev.leaderIndex }); });
  e.on('heartsBroken', () => broadcast(room, { name: 'heartsBroken' }));
  e.on('cardPlayed', () => broadcast(room, { name: 'cardPlayed' }));
  e.on('trickWon', (ev) => broadcast(room, {
    name: 'trickWon', winnerIndex: ev.winnerIndex, points: ev.points, handNo: ev.handNo,
    tookQueen: ev.tookQueen, queenDisregarded: ev.queenDisregarded,
  }));
  e.on('roundEnd', (ev) => {
    room.lastRoundEnd = { round: ev.round, roundScores: ev.roundScores, totals: ev.totals, breakdown: ev.breakdown };
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
    },
    players: e.players.map((p, i) => ({
      index: i,
      name: p.name,
      isBot: seatIsBot(room, i),
      totalScore: p.totalScore,
      tricksWon: p.tricksWon,
      roundHistory: p.roundHistory,
      queenTakes: p.queenTakes,
      penalty: p._penalty || 0,
      handCount: p.hand.length,
      hand: i === seat ? p.hand.map((c) => ({ rank: c.rank, suit: c.suit })) : null,
    })),
    currentTrick: e.currentTrick.map((x) => ({ playerIndex: x.playerIndex, card: { rank: x.card.rank, suit: x.card.suit } })),
    trickLog: e.trickLog,
    legalCardIds: myTurn ? e.legalCards(seat).map((c) => c.id) : [],
  };
}

function broadcast(room, hint) {
  room.seats.forEach((s, seat) => {
    if (!s.clientId) return;
    const c = clients.get(s.clientId);
    if (!c) return;
    c.send({ t: 'game', snapshot: snapshotFor(room, seat), hint });
  });
}

/* ---- disconnect handling ------------------------------------------------ */
function dropClient(client, intentional) {
  if (!clients.has(client.id)) return;
  clients.delete(client.id);
  const room = rooms.get(client.roomCode);
  if (!room) return;

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
