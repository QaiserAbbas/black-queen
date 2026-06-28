/* =============================================================================
 * Black Queen — ROOM SERVER  (Cloudflare Workers + partyserver, free plan)
 * -----------------------------------------------------------------------------
 * `Main` is a partyserver Server — one Durable Object instance PER room. The
 * room code is `this.name` (clients connect to /parties/main/<CODE>), which
 * replaces the old single-process `rooms`/`clients` Maps:
 *   • there is no cross-room state here — see party/lobby.js for that.
 *   • `this.getConnection(id)` is the live socket for a connection id.
 *   • per-connection app state (seat, name, chat throttle) lives in this.clients.
 *
 * Everything else — the AUTHORITATIVE engine per room, bots filling empty seats,
 * a dropped player held for a grace window then covered by a bot, reconnect via
 * session token, spectators, Treeky — is ported verbatim from the LAN server.
 *
 * Timers: partyserver keeps this object warm while ≥1 socket is open (no
 * hibernation), so the per-seat setTimeout bot/grace timers behave exactly like
 * the Node server. When the LAST socket closes we arm a Durable Object alarm to
 * expire the room after the reconnect grace (see onAlarm).
 * ===========================================================================*/

import { Server, getServerByName } from "partyserver";
import { BQ } from "./engine.js";
import { getUser } from "./api.js";

// Card-smash styles a client may request (mirrors BQ.FX.SMASHES in js/fx.js).
const SMASH_KINDS = new Set(["punch", "fire", "bolt", "ice", "bomb"]);

// Hold an all-disconnected in-progress room this long for a reconnect before the
// alarm expires it (mirrors the old RECONNECT_GRACE_MS room cleanup).
const RECONNECT_GRACE_MS = 90 * 1000;
// Hold a dropped player's EXACT turn this long before a bot fills in, so a page
// refresh resumes on the same turn instead of finding a bot already played.
const DISCONNECT_TURN_GRACE_MS = 15 * 1000;

export class Main extends Server {
  // Keep the object in memory (and its setTimeout bot/grace timers alive) while
  // connections are open — we hold the authoritative engine in memory, not in
  // storage, so hibernation would drop the game.
  static options = { hibernate: false };

  constructor(ctx, env) {
    super(ctx, env);

    this.created = false;
    this.hostConnId = null;       // connection id of the (current) host
    this.hostToken = null;        // host's seat token — lets the host reclaim host
    this.gameType = "blackqueen"; // 'blackqueen' | 'treeky' | 'bluff'
    this.rules = null;

    this.seats = [];              // [{connId|null, name, isBot, token, disconnected, open, botFill, ...timers}]
    this.engine = null;
    this.started = false;
    this.lastRoundEnd = null;     // replayed to a reconnecting player
    this.lastGameOver = null;
    this.ready = new Set();       // seats that confirmed "ready" for the next round
    this.paused = false;          // play frozen (a player left mid-game)
    this.vacancy = null;          // {seat, name} the host is being asked to resolve
    this.spectators = new Set();  // connection ids watching (no seat, no cards)
    this.punchNext = null;        // smash style riding along the next cardPlayed
    this.bluffWindowTimer = null;     // Bluff: closes a stalled human doubt window
    this.bluffChallengeTimers = [];   // Bluff: pending per-bot doubt decisions

    this.gameDbId = null;         // D1 games.id for the current game (history)

    // connId -> { seat, name, lastChatAt, userId }
    this.clients = new Map();
  }

  /* ---- transport helpers ------------------------------------------------- */
  send(conn, obj) { if (conn) { try { conn.send(JSON.stringify(obj)); } catch (_) {} } }
  connOf(connId) { return connId ? this.getConnection(connId) : null; }
  meta(conn) { return this.clients.get(conn.id); }

  makeToken() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // Tell the lobby registry whether this room is open / live (or gone).
  async reportLobby(removed) {
    try {
      const stub = await getServerByName(this.env.Lobby, "lobby");
      await stub.fetch("https://lobby/report", {
        method: "POST",
        body: JSON.stringify({
          code: this.name,
          removed: !!removed,
          started: this.started,
          joinable: this.isJoinable(),
          live: this.started && !!this.engine,
        }),
      });
    } catch (_) { /* lobby is best-effort */ }
  }

  isJoinable() {
    if (!this.created) return false;
    if (!this.started) return this.seats.length < this.seatCap();
    return this.seats.some((s) => s.open);
  }

  /* ---- game history (D1) — best-effort; never blocks gameplay ------------ */
  randomId() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  // Open a games row when a game starts. Fire-and-forget: rounds/game_players
  // are written seconds later, by which time this insert has long landed.
  recordGameStart() {
    if (!this.env.DB) { this.gameDbId = null; return; }
    this.gameDbId = this.randomId();
    this.env.DB.prepare(
      `INSERT INTO games (id, code, game_type, started_at) VALUES (?, ?, ?, ?)`
    ).bind(this.gameDbId, this.name, this.gameType, Date.now()).run().catch(() => {});
  }

  recordRound(roundNo, scores, totals, breakdown) {
    if (!this.gameDbId || !this.env.DB) return;
    this.env.DB.prepare(
      `INSERT OR REPLACE INTO rounds (game_id, round_no, scores, totals, breakdown, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      this.gameDbId, roundNo, JSON.stringify(scores || []), JSON.stringify(totals || []),
      JSON.stringify(breakdown || []), Date.now()
    ).run().catch(() => {});
  }

  // Finalize a finished game: stamp the winner + write one game_players row per
  // seat (humans carry user_id; bots/vacated seats are null).
  // ranking is an array of { index, ... } objects, best-first (both engines).
  recordGameOver(winnerSeat, ranking, scores) {
    if (!this.gameDbId || !this.env.DB) return;
    const rank = (seat) => {
      if (!Array.isArray(ranking)) return null;
      const i = ranking.findIndex((r) => r && r.index === seat);
      return i < 0 ? null : i + 1;
    };
    const stmts = [
      this.env.DB.prepare(`UPDATE games SET ended_at = ?, winner_seat = ? WHERE id = ?`)
        .bind(Date.now(), (winnerSeat == null ? null : winnerSeat), this.gameDbId),
    ];
    this.seats.forEach((s, seat) => {
      stmts.push(
        this.env.DB.prepare(
          `INSERT OR REPLACE INTO game_players (game_id, seat, user_id, name, is_bot, final_score, rank)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          this.gameDbId, seat, s.userId || null, s.name, this.seatIsBot(seat) ? 1 : 0,
          (scores && scores[seat] != null) ? scores[seat] : null, rank(seat)
        )
      );
    });
    this.env.DB.batch(stmts).catch(() => {});
  }

  /* =============================================================================
   * Connection lifecycle
   * ===========================================================================*/
  onConnect(conn, ctx) {
    // Register the connection SYNCHRONOUSLY so the first message (usually
    // `create`) always finds its meta. Seat assignment happens on
    // create/join/resume; until then this is an anonymous menu connection.
    const meta = { seat: -1, name: "Player", lastChatAt: 0, userId: null };
    this.clients.set(conn.id, meta);
    this.ctx.storage.deleteAlarm().catch(() => {});

    // Resolve the logged-in user from the session cookie in the background (so a
    // finished game records to their history). handleMessage awaits this before
    // it assigns a seat, so the userId is always known by create/join time.
    meta.userReady = (ctx && ctx.request && this.env.DB)
      ? getUser(ctx.request, this.env).then((u) => { if (u) meta.userId = u.id; }).catch(() => {})
      : Promise.resolve();
  }

  onMessage(conn, raw) {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    this.handleMessage(conn, msg);
  }

  async onClose(conn) { await this.dropClient(conn, false); }
  async onError(conn) { await this.dropClient(conn, false); }

  /* =============================================================================
   * Rooms & game coordination (ported from server.js)
   * ===========================================================================*/

  // Seats occupied by a connected human (bots/disconnected don't need to confirm).
  humanSeats() {
    const out = [];
    this.seats.forEach((s, i) => { if (s.connId && this.connOf(s.connId) && !s.isBot) out.push(i); });
    return out;
  }

  broadcastReady() {
    const humans = this.humanSeats();
    const payload = { t: "ready", ready: [...this.ready], humans, names: this.seats.map((s) => s.name) };
    this.seats.forEach((s) => { if (s.connId) { const c = this.connOf(s.connId); if (c) this.send(c, payload); } });
  }

  checkReady() {
    if (!this.engine || this.engine.phase !== "roundEnd") return;
    const humans = this.humanSeats();
    const allReady = humans.length > 0 && humans.every((seat) => this.ready.has(seat));
    if (allReady) {
      this.ready = new Set();
      this.engine.startRound();
    } else {
      this.broadcastReady();
    }
  }

  lobbyState() {
    return {
      code: this.name,
      hostId: this.hostConnId,
      started: this.started,
      maxSeats: this.rules.playerCount,
      players: this.seats.map((s, i) => ({
        seat: i, name: s.name, isBot: s.isBot, you: false,
        connected: !!(s.connId && this.connOf(s.connId)),
      })),
    };
  }

  broadcastLobby() {
    this.seats.forEach((s) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (!c) return;
      const m = this.meta(c);
      const state = this.lobbyState();
      state.players = state.players.map((p) => ({ ...p, you: p.seat === (m ? m.seat : -1) }));
      state.youAreHost = (this.hostConnId === c.id);
      state.yourSeat = m ? m.seat : -1;
      this.send(c, { t: "lobby", state });
    });
  }

  seatIsBot(seat) {
    const s = this.seats[seat];
    return !s || s.isBot || !s.connId || !this.connOf(s.connId);
  }

  // Send a public (non-snapshot) payload to every connected player AND spectator.
  sendAll(payload) {
    this.seats.forEach((s) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (c) this.send(c, payload);
    });
    for (const id of this.spectators) { const c = this.connOf(id); if (c) this.send(c, payload); }
  }

  presenceState() {
    return {
      t: "peers",
      seats: this.seats.map((s, i) => ({
        seat: i,
        name: s.name,
        isBot: !!s.isBot && !s.disconnected,
        connected: !!(s.connId && this.connOf(s.connId)),
        away: !!s.disconnected,
        attacksMuted: !!s.attacksMuted,
      })),
    };
  }

  broadcastPresence(note) {
    const payload = this.presenceState();
    if (note) payload.note = note;
    this.sendAll(payload);
    this.broadcastVoice();
  }

  voiceRoster() {
    const out = [];
    this.seats.forEach((s, i) => { if (s.voice && s.connId && this.connOf(s.connId)) out.push(i); });
    return out;
  }

  broadcastVoice() { this.sendAll({ t: "voice", seats: this.voiceRoster() }); }

  seatAwaitingReconnect(seat) {
    const s = this.seats[seat];
    return !!(s && s.disconnected && !s.botFill);
  }

  beginDisconnectGrace(seatIdx) {
    const seat = this.seats[seatIdx];
    if (!seat) return;
    if (seat.turnGraceTimer) clearTimeout(seat.turnGraceTimer);
    seat.botFill = false;
    seat.turnGraceTimer = setTimeout(() => {
      seat.turnGraceTimer = null;
      if (seat.disconnected && !seat.connId) {
        seat.botFill = true;
        if (!this.paused && this.engine && this.engine.phase === "awaitHuman" &&
            this.engine.currentPlayerIndex === seatIdx) {
          this.scheduleBot(seatIdx);
        }
      }
    }, DISCONNECT_TURN_GRACE_MS);
  }

  broadcastPaused(paused, name) {
    this.seats.forEach((s) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (c) this.send(c, { t: "paused", paused: !!paused, name: name || null, code: this.name });
    });
  }

  promptHostVacancy() {
    if (!this.vacancy) return;
    const host = this.connOf(this.hostConnId);
    if (host) this.send(host, { t: "seatVacated", seat: this.vacancy.seat, name: this.vacancy.name, code: this.name });
  }

  fillSeatWithBot(seatIdx) {
    const seat = this.seats[seatIdx];
    if (!seat) return;
    if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
    const used = new Set(this.seats.map((s) => s.name));
    const pool = BQ.cloneOf(this.rules.botNames).filter((n) => !used.has(n));
    const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : ("Bot " + (seatIdx + 1));
    seat.connId = null;
    seat.isBot = true;
    seat.open = false;
    seat.disconnected = false;
    seat.botFill = true;
    seat.userId = null;
    seat.name = name;
    if (this.engine && this.engine.players[seatIdx]) this.engine.players[seatIdx].name = name;
  }

  resumePlay() {
    this.paused = false;
    this.vacancy = null;
    this.broadcastPaused(false);
    const e = this.engine;
    if (e && e.phase === "awaitHuman" && this.seatIsBot(e.currentPlayerIndex)) {
      this.scheduleBot(e.currentPlayerIndex);
    }
    // Bluff: re-arm a doubt window that was frozen while the table was paused.
    if (e && this.gameType === "bluff" && e.phase === "awaitChallenge") {
      this.scheduleBluffWindow();
    }
    this.broadcast({ name: "resync" });
    this.broadcastPresence();
    this.reportLobby();
  }

  /* ---- message router ---------------------------------------------------- */
  async handleMessage(conn, msg) {
    const meta = this.clients.get(conn.id);
    if (!meta) return;
    // Make sure the session lookup has resolved so seat assignment carries the
    // right userId (resolves in ~1ms after connect; a no-op thereafter).
    if (meta.userReady) await meta.userReady;

    switch (msg.t) {
      case "ping": {
        this.send(conn, { t: "pong", ts: msg.ts });
        break;
      }
      case "prefs": {
        if (meta.seat < 0) break;
        const seat = this.seats[meta.seat];
        if (!seat) break;
        seat.attacksMuted = !!msg.attacksMuted;
        this.broadcastPresence();
        break;
      }
      case "attack": {
        if (!this.started || meta.seat < 0) break;
        const seat = this.seats[meta.seat];
        if (!seat || seat.attackUsed) break;
        const kind = String(msg.kind || "");
        if (["lion", "dragon", "bomb", "ghost", "skull"].indexOf(kind) < 0) break;
        seat.attackUsed = true;
        this.sendAll({ t: "attack", kind, seat: meta.seat, name: meta.name });
        break;
      }
      case "emote":
      case "chat": {
        if (meta.seat < 0) break;
        const now = Date.now();
        if (now - meta.lastChatAt < 1200) break;      // rate limit ~1 / 1.2s
        meta.lastChatAt = now;
        const text = String(msg.t === "emote" ? (msg.emoji || "") : (msg.text || ""))
          .replace(/\s+/g, " ").trim().slice(0, msg.t === "emote" ? 8 : 60);
        if (!text) break;
        this.sendAll({ t: msg.t, seat: meta.seat, name: meta.name, text });
        break;
      }
      case "voice": {
        if (meta.seat < 0) break;
        const seat = this.seats[meta.seat];
        if (!seat) break;
        seat.voice = !!msg.on;
        this.broadcastVoice();
        break;
      }
      case "rtc": {
        if (meta.seat < 0) break;
        const to = msg.to | 0;
        const seat = this.seats[to];
        if (!seat || !seat.connId) break;
        const c = this.connOf(seat.connId);
        if (c) this.send(c, { t: "rtc", from: meta.seat, data: msg.data });
        break;
      }
      case "create": {
        if (this.created) { this.send(conn, { t: "error", msg: "Room already exists." }); break; }
        this.created = true;
        this.gameType = "blackqueen";
        this.rules = BQ.cloneRules();
        if (msg.gameType === "treeky") {
          this.gameType = "treeky"; this.rules = BQ.cloneTreekyRules();
          const tr = msg.treekyRules || {};
          if ([7, 8, 10, 12].indexOf(tr.handSize) >= 0) this.rules.handSize = tr.handSize;
          if (typeof tr.botThinkMs === "number") this.rules.botThinkMs = Math.max(300, Math.min(3000, tr.botThinkMs));
          if (tr.decks === 1 || tr.decks === 2) this.rules.decks = tr.decks;
          if (tr.playDirection === "left" || tr.playDirection === "right") this.rules.playDirection = tr.playDirection;
        } else if (msg.gameType === "bluff") {
          this.gameType = "bluff"; this.rules = BQ.cloneBluffRules();
          const br = msg.bluffRules || {};
          if (br.decks === 1 || br.decks === 2) this.rules.decks = br.decks;
          if ([2, 3, 4, 5].indexOf(br.maxPerPlay) >= 0) this.rules.maxPerPlay = br.maxPerPlay;
          if (typeof br.botThinkMs === "number") this.rules.botThinkMs = Math.max(300, Math.min(3000, br.botThinkMs));
          if (br.playDirection === "left" || br.playDirection === "right") this.rules.playDirection = br.playDirection;
        }
        meta.name = (msg.name || "Host").slice(0, 14);
        const token = this.makeToken();
        this.hostToken = token;
        this.hostConnId = conn.id;
        this.seats.push({ connId: conn.id, name: meta.name, isBot: false, token, userId: meta.userId });
        meta.seat = 0;
        this.send(conn, { t: "joined", code: this.name, seat: 0, token, host: true });
        this.broadcastLobby();
        this.reportLobby();
        break;
      }
      case "join": {
        if (!this.created) return this.send(conn, { t: "error", msg: "Room " + this.name + " not found." });
        meta.name = (msg.name || "Player").slice(0, 14);

        // Joining an in-progress game: take over an opened seat.
        if (this.started) {
          const openSeat = this.seats.findIndex((s) => s.open);
          if (openSeat < 0) return this.send(conn, { t: "error", msg: "That game already started." });
          const token = this.makeToken();
          const seat = this.seats[openSeat];
          if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
          seat.connId = conn.id;
          seat.name = meta.name;
          seat.isBot = false;
          seat.open = false;
          seat.disconnected = false;
          seat.botFill = false;
          seat.token = token;
          seat.userId = meta.userId;
          if (this.engine && this.engine.players[openSeat]) this.engine.players[openSeat].name = meta.name;
          meta.seat = openSeat;
          this.send(conn, { t: "joined", code: this.name, seat: openSeat, token, host: false });
          this.send(conn, { t: "game", snapshot: this.seatSnap(openSeat), hint: { name: "resync" } });
          this.resumePlay();
          break;
        }

        if (this.seats.length >= this.seatCap()) return this.send(conn, { t: "error", msg: "Room " + this.name + " is full." });
        const seat = this.seats.length;
        const token = this.makeToken();
        this.seats.push({ connId: conn.id, name: meta.name, isBot: false, token, userId: meta.userId });
        meta.seat = seat;
        this.send(conn, { t: "joined", code: this.name, seat, token, host: false });
        this.broadcastLobby();
        this.reportLobby();
        break;
      }
      case "spectate": {
        if (!this.created) return this.send(conn, { t: "error", msg: "No game here to watch." });
        meta.seat = -1;
        meta.name = (msg.name || "Spectator").slice(0, 14);
        this.spectators.add(conn.id);
        this.send(conn, { t: "spectating", code: this.name });
        if (this.started && this.engine) {
          const e = this.engine;
          const snap = () => (this.gameType === "treeky" ? this.treekySpectatorSnapshot()
            : this.gameType === "bluff" ? this.bluffSpectatorSnapshot()
            : this.spectatorSnapshot());
          this.send(conn, { t: "game", snapshot: snap(), hint: { name: "resync" } });
          if (this.gameType !== "blackqueen") {
            if (e.phase === "gameOver" && this.lastGameOver) {
              this.send(conn, { t: "game", snapshot: snap(), hint: Object.assign({ name: "gameOver" }, this.lastGameOver) });
            }
          } else if (e.phase === "roundEnd" && this.lastRoundEnd) {
            this.send(conn, { t: "game", snapshot: snap(), hint: Object.assign({ name: "roundEnd" }, this.lastRoundEnd) });
          } else if (e.phase === "gameOver" && this.lastGameOver) {
            this.send(conn, { t: "game", snapshot: snap(), hint: Object.assign({ name: "gameOver" }, this.lastGameOver) });
          }
          this.broadcastPresence();
        }
        break;
      }
      case "resume": {
        if (!this.created) return this.send(conn, { t: "resumeFail", reason: "room-gone" });
        const seatIdx = this.seats.findIndex((s) => s.token && s.token === msg.token);
        if (seatIdx < 0) return this.send(conn, { t: "resumeFail", reason: "seat-gone" });

        const seat = this.seats[seatIdx];
        if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
        if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
        if (seat.botPlayTimer) { clearTimeout(seat.botPlayTimer); seat.botPlayTimer = null; }
        this.ctx.storage.deleteAlarm().catch(() => {});

        seat.connId = conn.id;
        seat.isBot = false;
        seat.disconnected = false;
        seat.botFill = false;
        seat.userId = meta.userId;
        meta.seat = seatIdx;
        meta.name = seat.name;
        const isHost = !!(this.hostToken && this.hostToken === seat.token);
        if (isHost) this.hostConnId = conn.id;

        this.send(conn, { t: "joined", code: this.name, seat: seatIdx, token: seat.token, host: isHost });

        if (this.started && this.engine) {
          const e = this.engine;
          this.send(conn, { t: "game", snapshot: this.seatSnap(seatIdx), hint: { name: "resync" } });
          if (this.gameType === "blackqueen" && e.phase === "roundEnd" && this.lastRoundEnd) {
            this.send(conn, { t: "game", snapshot: this.seatSnap(seatIdx), hint: Object.assign({ name: "roundEnd" }, this.lastRoundEnd) });
            this.broadcastReady();
          } else if (e.phase === "gameOver" && this.lastGameOver) {
            this.send(conn, { t: "game", snapshot: this.seatSnap(seatIdx), hint: Object.assign({ name: "gameOver" }, this.lastGameOver) });
          }
          this.broadcast({ name: "sync" });
          this.broadcastPresence({ kind: "back", name: seat.name });
          if (this.paused) {
            this.send(conn, { t: "paused", paused: true, name: this.vacancy && this.vacancy.name, code: this.name });
            if (isHost && this.vacancy) this.promptHostVacancy();
          }
        } else {
          this.broadcastLobby();
          this.broadcastPresence({ kind: "back", name: seat.name });
        }
        this.reportLobby();
        break;
      }
      case "rules": {
        if (this.hostConnId === conn.id && !this.started && msg.rules) {
          Object.assign(this.rules, msg.rules);
          this.broadcastLobby();
        }
        break;
      }
      case "start": {
        if (this.hostConnId === conn.id && !this.started) {
          if (Array.isArray(msg.layout)) this.applySeatLayout(msg.layout);
          this.startGame();
        }
        break;
      }
      // ---- Treeky actions -------------------------------------------------
      case "draw": {
        if (!this.engine || this.paused || this.gameType !== "treeky") break;
        const e = this.engine;
        if (e.phase === "awaitHuman" && e.currentPlayerIndex === meta.seat) e.drawForTurn(meta.seat);
        break;
      }
      case "pass": {
        if (!this.engine || this.paused || this.gameType !== "treeky") break;
        const e = this.engine;
        if (e.phase === "awaitHuman" && e.currentPlayerIndex === meta.seat) e.pass(meta.seat);
        break;
      }
      case "declareLast": {
        if (!this.engine || this.paused || this.gameType !== "treeky") break;
        const e = this.engine;
        if (e.currentPlayerIndex === meta.seat) e.declareLast(meta.seat);
        break;
      }
      case "chooseSuit": {
        if (!this.engine || this.paused || this.gameType !== "treeky") break;
        const e = this.engine;
        if (e.phase === "awaitSuit" && e.currentPlayerIndex === meta.seat) e.chooseSuit(meta.seat, msg.suit);
        break;
      }
      case "reshuffle": {
        if (!this.engine || this.gameType !== "treeky") break;
        if (conn.id === this.hostConnId && this.engine.phase === "awaitReshuffle") this.engine.reshuffle();
        break;
      }
      case "reshuffleDeal": {
        if (!this.engine || this.gameType === "treeky" || this.paused) break;
        const e = this.engine;
        if (e.phase === "awaitReshuffle" && e.reshuffleSeat === meta.seat) e.reshuffleAgain();
        break;
      }
      case "reshuffleStart": {
        if (!this.engine || this.gameType === "treeky" || this.paused) break;
        const e = this.engine;
        if (e.phase === "awaitReshuffle" && e.reshuffleSeat === meta.seat) e.beginPlay();
        break;
      }
      // ---- Bluff doubt window --------------------------------------------
      case "challenge": {
        if (!this.engine || this.paused || this.gameType !== "bluff") break;
        this.engine.challenge(meta.seat);
        break;
      }
      case "passChallenge": {
        if (!this.engine || this.paused || this.gameType !== "bluff") break;
        this.engine.passChallenge(meta.seat);
        break;
      }
      case "play": {
        if (!this.engine) return;
        if (this.paused) return;
        const e = this.engine;
        if (this.gameType === "treeky") {
          if (e.phase === "awaitHuman" && e.currentPlayerIndex === meta.seat) e.playHuman(msg.cardId, msg.suit);
          else if (e.phase === "awaitSuit" && e.currentPlayerIndex === meta.seat && msg.suit) e.chooseSuit(meta.seat, msg.suit);
          return;
        }
        if (this.gameType === "bluff") {
          if (e.phase === "awaitHuman" && e.currentPlayerIndex === meta.seat) e.playClaim(meta.seat, msg.rank, msg.cardIds);
          return;
        }
        if (e.phase === "awaitHuman" && e.currentPlayerIndex === meta.seat) {
          this.punchNext = SMASH_KINDS.has(msg.smash) ? msg.smash : (msg.punch ? "punch" : null);
          e.playHuman(msg.cardId);
          this.punchNext = null;
          const s = this.seats[meta.seat];
          if (s) s.attackUsed = false;
        }
        break;
      }
      case "resolveVacancy": {
        if (this.hostConnId !== conn.id || !this.vacancy) break;
        if (msg.choice === "bot") {
          this.fillSeatWithBot(this.vacancy.seat);
          this.resumePlay();
        } else {
          const seat = this.seats[this.vacancy.seat];
          if (seat) seat.open = true;
          this.broadcastPaused(true, this.vacancy.name);
          this.reportLobby();
        }
        break;
      }
      case "ready": {
        if (!this.engine || this.engine.phase !== "roundEnd") break;
        this.ready.add(meta.seat);
        this.checkReady();
        break;
      }
      case "next": {
        if (this.engine && this.engine.phase === "roundEnd") {
          this.ready.add(meta.seat);
          this.checkReady();
        }
        break;
      }
      case "again": {
        if (this.hostConnId === conn.id && this.engine && this.engine.phase === "gameOver") {
          this.startGame();
        }
        break;
      }
      case "kick": {
        if (this.hostConnId !== conn.id || this.started) break;
        const target = msg.seat | 0;
        if (target === meta.seat) break;
        const seat = this.seats[target];
        if (!seat) break;

        if (seat.graceTimer) { clearTimeout(seat.graceTimer); seat.graceTimer = null; }
        if (this.hostToken && this.hostToken === seat.token) this.hostToken = null;
        seat.token = null;

        if (seat.connId) {
          const c = this.connOf(seat.connId);
          if (c) {
            const cm = this.meta(c);
            if (cm) cm.seat = -1;
            this.send(c, { t: "kicked", code: this.name });
          }
        }

        this.seats.splice(target, 1);
        this.reindexSeats();
        this.broadcastLobby();
        this.reportLobby();
        break;
      }
      case "leave": this.dropClient(conn, true); break;
    }
  }

  // Re-point every connected client at its (possibly shifted) seat index.
  reindexSeats() {
    this.seats.forEach((s, i) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (c) { const m = this.meta(c); if (m) m.seat = i; }
    });
  }

  applySeatLayout(layout) {
    if (this.started) return false;
    const N = this.rules.playerCount;
    if (!Array.isArray(layout) || layout.length !== N) return false;

    const humanIdxs = [];
    for (const v of layout) {
      if (v === "bot" || v === null) continue;
      if (!Number.isInteger(v) || v < 0 || v >= this.seats.length) return false;
      humanIdxs.push(v);
    }
    if (humanIdxs.length !== this.seats.length) return false;
    if (new Set(humanIdxs).size !== humanIdxs.length) return false;

    const used = new Set(this.seats.map((s) => s.name));
    const pool = BQ.cloneOf(this.rules.botNames).filter((n) => !used.has(n));
    let botN = 0;
    const newSeats = layout.map((v) => {
      if (v === "bot" || v === null) {
        const name = pool.shift() || ("Bot " + (++botN));
        return { connId: null, name, isBot: true };
      }
      return this.seats[v];
    });

    this.seats = newSeats;
    this.reindexSeats();
    return true;
  }

  /* ---- start / run a game ------------------------------------------------- */
  startGame() {
    if (this.gameType === "treeky") return this.startTreekyGame();
    if (this.gameType === "bluff") return this.startBluffGame();
    const botPool = BQ.cloneOf(this.rules.botNames);
    while (this.seats.length < this.rules.playerCount) {
      const name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0] || ("Bot " + this.seats.length);
      this.seats.push({ connId: null, name, isBot: true });
    }
    this.started = true;
    this.lastRoundEnd = null;
    this.lastGameOver = null;
    this.rules.reshuffleEnabled = true;
    this.recordGameStart();

    const engine = new BQ.GameEngine(this.rules);
    engine.initWithPlayers(this.seats.map((s) => s.name));
    this.engine = engine;

    this.ready = new Set();
    this.wireEngine();
    engine.startRound();
    this.broadcastPresence();
    this.reportLobby();
  }

  wireEngine() {
    const e = this.engine;
    e.reshuffleGate = (seat) => !this.seatIsBot(seat);

    e.on("roundStart", (ev) => {
      this.lastRoundEnd = null;
      this.seats.forEach((s) => { s.attackUsed = false; });
      this.broadcast({ name: "roundStart", leaderIndex: ev.leaderIndex });
    });
    e.on("reshuffleOffer", (ev) => {
      if (this.seatIsBot(ev.playerIndex)) { this.engine.beginPlay(); return; }
      this.broadcast({ name: "reshuffleOffer", seat: ev.playerIndex, remaining: ev.remaining });
    });
    e.on("heartsBroken", () => this.broadcast({ name: "heartsBroken" }));
    e.on("cardPlayed", () => { this.broadcast({ name: "cardPlayed", punch: !!this.punchNext, smash: this.punchNext || undefined }); this.punchNext = null; });
    e.on("trickWon", (ev) => this.broadcast({
      name: "trickWon", winnerIndex: ev.winnerIndex, points: ev.points, handNo: ev.handNo,
      tookQueen: ev.tookQueen, queenDisregarded: ev.queenDisregarded,
    }));
    e.on("roundEnd", (ev) => {
      this.lastRoundEnd = { round: ev.round, roundScores: ev.roundScores, totals: ev.totals, breakdown: ev.breakdown, tricks: ev.tricks, cutShort: !!ev.cutShort, gameOver: !!ev.gameOver };
      this.broadcast(Object.assign({ name: "roundEnd" }, this.lastRoundEnd));
      this.recordRound(ev.round, ev.roundScores, ev.totals, ev.breakdown);
      this.ready = new Set();
      if (e.phase !== "gameOver") this.broadcastReady();
    });
    e.on("gameOver", (ev) => {
      this.lastGameOver = { totals: ev.totals, winnerIndex: ev.winnerIndex, ranking: ev.ranking };
      this.broadcast(Object.assign({ name: "gameOver" }, this.lastGameOver));
      this.recordGameOver(ev.winnerIndex, ev.ranking, ev.totals);
    });

    e.on("turn", (ev) => {
      this.broadcast({ name: "turn" });
      if (this.seatIsBot(ev.playerIndex)) this.scheduleBot(ev.playerIndex);
    });
  }

  scheduleBot(seat) {
    if (this.gameType === "treeky") return this.scheduleTreekyBot(seat);
    if (this.gameType === "bluff") return this.scheduleBluffBot(seat);
    if (this.paused) return;
    if (this.seatAwaitingReconnect(seat)) return;
    const e = this.engine;
    const s = this.seats[seat];
    if (s && s.botPlayTimer) { clearTimeout(s.botPlayTimer); s.botPlayTimer = null; }
    const timer = setTimeout(() => {
      if (s) s.botPlayTimer = null;
      if (this.paused) return;
      if (!this.engine || this.engine !== e) return;
      if (e.phase === "awaitHuman" && e.currentPlayerIndex === seat && this.seatIsBot(seat)) {
        const card = BQ.AI.chooseCard(e, seat);
        if (card) e.playHuman(card.id);
      }
    }, Math.max(120, this.rules.botThinkMs));
    if (s) s.botPlayTimer = timer;
  }

  /* =============================================================================
   * TREEKY
   * ===========================================================================*/
  seatCap() {
    if (this.gameType === "treeky") return this.rules.maxPlayers || 10;
    if (this.gameType === "bluff") return this.rules.maxPlayers || 8;
    return this.rules.playerCount;
  }
  seatSnap(seat) {
    if (this.gameType === "treeky") return this.treekySnapshotFor(seat);
    if (this.gameType === "bluff") return this.bluffSnapshotFor(seat);
    return this.snapshotFor(seat);
  }

  startTreekyGame() {
    const fillTo = Math.min(this.rules.fillToMin || 4, this.seatCap());
    const botPool = BQ.cloneOf(this.rules.botNames);
    const used = new Set(this.seats.map((s) => s.name));
    while (this.seats.length < fillTo) {
      let name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
      while (name && used.has(name)) name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
      name = name || ("Bot " + (this.seats.length + 1));
      used.add(name);
      this.seats.push({ connId: null, name, isBot: true });
    }
    this.started = true;
    this.lastGameOver = null;
    this.recordGameStart();

    const engine = new BQ.TreekyEngine(this.rules);
    engine.initWithPlayers(this.seats.map((s) => s.name));
    this.engine = engine;

    this.ready = new Set();
    this.wireTreekyEngine();
    engine.start();
    this.broadcastPresence();
    this.reportLobby();
  }

  wireTreekyEngine() {
    const e = this.engine;
    e.on("gameStart", () => this.broadcast({ name: "gameStart" }));
    e.on("cardPlayed", (ev) => this.broadcast({ name: "cardPlayed", playerIndex: ev.playerIndex, isThree: ev.isThree, isJack: ev.isJack }));
    e.on("suitChosen", (ev) => this.broadcast({ name: "suitChosen", playerIndex: ev.playerIndex, suit: ev.suit }));
    e.on("cardsDrawn", (ev) => this.broadcast({ name: "cardsDrawn", playerIndex: ev.playerIndex, count: ev.count, penalty: ev.penalty, reason: ev.reason }));
    e.on("lastCardDeclared", (ev) => this.broadcast({ name: "lastCardDeclared", playerIndex: ev.playerIndex }));
    e.on("needReshuffle", () => this.broadcast({ name: "needReshuffle" }));
    e.on("reshuffled", () => this.broadcast({ name: "reshuffled" }));
    // NB: matches server.js — the trailing `name: ev.name` is what reaches the
    // client (an object literal's last duplicate key wins), so the hint carries
    // the finishing player's name, not the literal "playerFinished".
    e.on("playerFinished", (ev) => this.broadcast({ playerIndex: ev.playerIndex, rank: ev.rank, name: ev.name }));
    e.on("gameOver", (ev) => {
      this.lastGameOver = { ranking: ev.ranking, loserIndex: ev.loserIndex };
      this.broadcast(Object.assign({ name: "gameOver" }, this.lastGameOver));
      // Treeky winner = first to finish (ranking[0].index); no per-round totals.
      const tWinner = Array.isArray(ev.ranking) && ev.ranking[0] ? ev.ranking[0].index : null;
      this.recordGameOver(tWinner, ev.ranking, null);
    });
    e.on("turn", (ev) => {
      this.broadcast({ name: "turn" });
      if (this.seatIsBot(ev.playerIndex)) this.scheduleBot(ev.playerIndex);
    });
  }

  scheduleTreekyBot(seat) {
    if (this.paused) return;
    if (this.seatAwaitingReconnect(seat)) return;
    const e = this.engine;
    const s = this.seats[seat];
    if (s && s.botPlayTimer) { clearTimeout(s.botPlayTimer); s.botPlayTimer = null; }
    const timer = setTimeout(() => {
      if (s) s.botPlayTimer = null;
      if (this.paused || !this.engine || this.engine !== e) return;
      if (e.currentPlayerIndex !== seat || !this.seatIsBot(seat)) return;
      if (e.phase === "awaitSuit") { e.chooseSuit(seat, BQ.TreekyAI.bestSuit(e.players[seat])); return; }
      if (e.phase !== "awaitHuman") return;
      const move = BQ.TreekyAI.chooseMove(e, seat);
      if (!move || move.type === "draw") { e.drawForTurn(seat); return; }
      if (move.type === "pass") { e.pass(seat); return; }
      if (e.players[seat].hand.length === 2) e.players[seat].declaredLast = true;
      e.playHuman(move.cardId, move.suit);
    }, Math.max(150, this.rules.botThinkMs));
    if (s) s.botPlayTimer = timer;
  }

  treekyRulesPayload(r) {
    return { gameName: r.gameName, wildRank: r.wildRank, drawRank: r.drawRank, drawPenalty: r.drawPenalty, handSize: r.handSize };
  }

  treekySnapshotFor(seat) {
    const e = this.engine;
    const myTurn = e.phase === "awaitHuman" && e.currentPlayerIndex === seat;
    const legal = myTurn ? e.legalCards(seat).map((c) => c.id) : [];
    const top = e.topCard();
    const phase = e.phase === "awaitReshuffle" ? "awaitReshuffle"
      : myTurn ? "awaitHuman"
      : (e.phase === "awaitSuit" && e.currentPlayerIndex === seat ? "awaitSuit"
      : (e.phase === "gameOver" ? "gameOver" : "playing"));
    return {
      gameType: "treeky",
      you: seat,
      youAreHost: !!(this.seats[seat] && this.seats[seat].connId === this.hostConnId),
      phase,
      dealerIndex: e.dealerIndex,
      currentPlayerIndex: e.currentPlayerIndex,
      activeSuit: e.activeSuit,
      pendingDraw: e.pendingDraw,
      drawCount: e.drawPile.length,
      topCard: top ? { rank: top.rank, suit: top.suit, id: top.id } : null,
      finishedOrder: e.finishedOrder.slice(),
      rules: this.treekyRulesPayload(e.rules),
      players: e.players.map((p, i) => ({
        index: i, name: p.name, isBot: this.seatIsBot(i),
        offline: !!(this.seats[i] && this.seats[i].disconnected),
        finished: p.finished, finishRank: p.finishRank,
        handCount: p.hand.length,
        hand: i === seat ? p.hand.map((c) => ({ rank: c.rank, suit: c.suit, id: c.id })) : null,
      })),
      legalCardIds: legal,
      canDraw: myTurn && !e._drewThisTurn && !e._noDrawThisTurn,
      canPass: myTurn && e._drewThisTurn && legal.length > 0,
    };
  }

  treekySpectatorSnapshot() {
    const s = this.treekySnapshotFor(0);
    s.you = -1; s.spectator = true; s.youAreHost = false;
    s.phase = (this.engine.phase === "awaitReshuffle") ? "awaitReshuffle" : "playing";
    s.legalCardIds = []; s.canDraw = false; s.canPass = false;
    s.players = s.players.map((p) => Object.assign({}, p, { hand: null }));
    return s;
  }

  treekyBroadcast(hint) {
    this.seats.forEach((s, seat) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (!c) return;
      this.send(c, { t: "game", snapshot: this.treekySnapshotFor(seat), hint });
    });
    if (this.spectators.size && this.engine) {
      const snap = this.treekySpectatorSnapshot();
      for (const id of this.spectators) { const c = this.connOf(id); if (c) this.send(c, { t: "game", snapshot: snap, hint }); }
    }
  }

  /* =============================================================================
   * BLUFF
   * ===========================================================================*/
  startBluffGame() {
    const fillTo = Math.min(this.rules.fillToMin || 4, this.seatCap());
    const botPool = BQ.cloneOf(this.rules.botNames);
    const used = new Set(this.seats.map((s) => s.name));
    while (this.seats.length < fillTo) {
      let name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
      while (name && used.has(name)) name = botPool.splice(Math.floor(Math.random() * botPool.length), 1)[0];
      name = name || ("Bot " + (this.seats.length + 1));
      used.add(name);
      this.seats.push({ connId: null, name, isBot: true });
    }
    this.started = true;
    this.lastGameOver = null;
    this.recordGameStart();

    const engine = new BQ.BluffEngine(this.rules);
    engine.initWithPlayers(this.seats.map((s) => s.name));
    this.engine = engine;

    this.ready = new Set();
    this.wireBluffEngine();
    engine.start();
    this.broadcastPresence();
    this.reportLobby();
  }

  wireBluffEngine() {
    const e = this.engine;
    e.on("gameStart", () => this.broadcast({ name: "gameStart" }));
    e.on("turn", (ev) => {
      this.clearBluffWindow();
      this.broadcast({ name: "turn" });
      if (this.seatIsBot(ev.playerIndex)) this.scheduleBot(ev.playerIndex);
    });
    e.on("cardPlayed", (ev) => this.broadcast({ name: "cardPlayed", playerIndex: ev.playerIndex, rank: ev.rank, count: ev.count }));
    e.on("challengeWindow", (ev) => {
      this.broadcast({ name: "challengeWindow", by: ev.by, rank: ev.rank, count: ev.count });
      this.scheduleBluffWindow();
    });
    e.on("challengePassed", (ev) => this.broadcast({ name: "challengePassed", playerIndex: ev.playerIndex }));
    e.on("challengeResolved", (ev) => {
      this.clearBluffWindow();
      this.broadcast({
        name: "challengeResolved", challenger: ev.challenger, by: ev.by, rank: ev.rank,
        wasBluff: ev.wasBluff, revealed: ev.revealed, loser: ev.loser,
      });
    });
    // dup-key trick (see Treeky): the trailing `name: ev.name` is what reaches the
    // client as the hint name — here the finishing player's name.
    e.on("playerFinished", (ev) => this.broadcast({ playerIndex: ev.playerIndex, rank: ev.rank, name: ev.name }));
    e.on("gameOver", (ev) => {
      this.clearBluffWindow();
      this.lastGameOver = { ranking: ev.ranking, loserIndex: ev.loserIndex };
      this.broadcast(Object.assign({ name: "gameOver" }, this.lastGameOver));
      const winner = Array.isArray(ev.ranking) && ev.ranking[0] ? ev.ranking[0].index : null;
      this.recordGameOver(winner, ev.ranking, null);
    });
  }

  scheduleBluffBot(seat) {
    if (this.paused) return;
    if (this.seatAwaitingReconnect(seat)) return;
    const e = this.engine;
    const s = this.seats[seat];
    if (s && s.botPlayTimer) { clearTimeout(s.botPlayTimer); s.botPlayTimer = null; }
    const timer = setTimeout(() => {
      if (s) s.botPlayTimer = null;
      if (this.paused || !this.engine || this.engine !== e) return;
      if (e.currentPlayerIndex !== seat || !this.seatIsBot(seat)) return;
      if (e.phase !== "awaitHuman") return;
      const move = BQ.BluffAI.choosePlay(e, seat);
      if (move && move.cardIds && move.cardIds.length) e.playClaim(seat, move.rank, move.cardIds);
    }, Math.max(150, this.rules.botThinkMs));
    if (s) s.botPlayTimer = timer;
  }

  // Open doubt window: let each eligible BOT (incl. offline/bot-filled seats)
  // decide, and arm a backstop that auto-passes anyone still undecided so a
  // slow or absent human can never freeze the table.
  scheduleBluffWindow() {
    this.clearBluffWindow();
    const e = this.engine;
    if (!e || e.phase !== "awaitChallenge") return;
    e.players.forEach((p, seat) => {
      if (!e.canChallenge(seat) || !this.seatIsBot(seat)) return;
      const t = setTimeout(() => {
        if (this.paused || !this.engine || this.engine !== e) return;
        if (!e.canChallenge(seat)) return;
        if (BQ.BluffAI.decideChallenge(e, seat)) e.challenge(seat);
        else e.passChallenge(seat);
      }, Math.max(150, this.rules.botThinkMs) + seat * 180);
      this.bluffChallengeTimers.push(t);
    });
    this.bluffWindowTimer = setTimeout(() => {
      this.bluffWindowTimer = null;
      if (this.paused || !this.engine || this.engine !== e || e.phase !== "awaitChallenge") return;
      e.players.forEach((p, seat) => { if (e.canChallenge(seat)) e.passChallenge(seat); });
    }, Math.max(3000, this.rules.challengeWindowMs || 9000));
  }

  clearBluffWindow() {
    if (this.bluffWindowTimer) { clearTimeout(this.bluffWindowTimer); this.bluffWindowTimer = null; }
    this.bluffChallengeTimers.forEach((t) => clearTimeout(t));
    this.bluffChallengeTimers = [];
  }

  bluffRulesPayload(r) {
    return { gameName: r.gameName, maxPerPlay: r.maxPerPlay, decks: r.decks };
  }

  bluffSnapshotFor(seat) {
    const e = this.engine;
    const myTurn = e.phase === "awaitHuman" && e.currentPlayerIndex === seat;
    const phase = e.phase === "gameOver" ? "gameOver"
      : myTurn ? "awaitHuman"
      : (e.phase === "awaitChallenge" ? "awaitChallenge" : "playing");
    return {
      gameType: "bluff",
      you: seat,
      youAreHost: !!(this.seats[seat] && this.seats[seat].connId === this.hostConnId),
      phase,
      dealerIndex: e.dealerIndex,
      currentPlayerIndex: e.currentPlayerIndex,
      pileCount: e.pile.length,
      claim: e.claim ? { by: e.claim.by, rank: e.claim.rank, count: e.claim.count } : null,
      finishedOrder: e.finishedOrder.slice(),
      rules: this.bluffRulesPayload(e.rules),
      players: e.players.map((p, i) => ({
        index: i, name: p.name, isBot: this.seatIsBot(i),
        offline: !!(this.seats[i] && this.seats[i].disconnected),
        finished: p.finished, finishRank: p.finishRank,
        handCount: p.hand.length,
        hand: i === seat ? p.hand.map((c) => ({ rank: c.rank, suit: c.suit, id: c.id })) : null,
      })),
      canPlay: myTurn,
      canChallenge: e.canChallenge(seat),
      maxClaim: e.maxClaimFor(seat),
    };
  }

  bluffSpectatorSnapshot() {
    const s = this.bluffSnapshotFor(0);
    s.you = -1; s.spectator = true; s.youAreHost = false;
    s.phase = this.engine.phase === "gameOver" ? "gameOver"
      : (this.engine.phase === "awaitChallenge" ? "awaitChallenge" : "playing");
    s.canPlay = false; s.canChallenge = false; s.maxClaim = 0;
    s.players = s.players.map((p) => Object.assign({}, p, { hand: null }));
    return s;
  }

  bluffBroadcast(hint) {
    this.seats.forEach((s, seat) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (!c) return;
      this.send(c, { t: "game", snapshot: this.bluffSnapshotFor(seat), hint });
    });
    if (this.spectators.size && this.engine) {
      const snap = this.bluffSpectatorSnapshot();
      for (const id of this.spectators) { const c = this.connOf(id); if (c) this.send(c, { t: "game", snapshot: snap, hint }); }
    }
  }

  /* ---- Black Queen per-seat snapshot ------------------------------------- */
  snapshotFor(seat) {
    const e = this.engine;
    const myTurn = e.phase === "awaitHuman" && e.currentPlayerIndex === seat;
    const reshuffling = e.phase === "awaitReshuffle";
    return {
      you: seat,
      phase: myTurn ? "awaitHuman" : "playing",
      reshuffle: reshuffling ? { seat: e.reshuffleSeat, remaining: e.reshuffleRemaining } : null,
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
        isBot: this.seatIsBot(i),
        offline: !!(this.seats[i] && this.seats[i].disconnected),
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

  spectatorSnapshot() {
    const s = this.snapshotFor(0);
    s.you = -1;
    s.spectator = true;
    s.phase = "playing";
    s.legalCardIds = [];
    s.players = s.players.map((p) => Object.assign({}, p, { hand: null }));
    return s;
  }

  broadcast(hint) {
    if (this.gameType === "treeky") return this.treekyBroadcast(hint);
    if (this.gameType === "bluff") return this.bluffBroadcast(hint);
    this.seats.forEach((s, seat) => {
      if (!s.connId) return;
      const c = this.connOf(s.connId);
      if (!c) return;
      this.send(c, { t: "game", snapshot: this.snapshotFor(seat), hint });
    });
    if (this.spectators.size && this.engine) {
      const snap = this.spectatorSnapshot();
      for (const id of this.spectators) { const c = this.connOf(id); if (c) this.send(c, { t: "game", snapshot: snap, hint }); }
    }
  }

  /* ---- disconnect handling ------------------------------------------------ */
  async dropClient(conn, intentional) {
    if (!this.clients.has(conn.id)) return;
    const meta = this.clients.get(conn.id);
    this.clients.delete(conn.id);

    // Spectators hold no seat — just drop them from the watch list.
    if (this.spectators.has(conn.id)) {
      this.spectators.delete(conn.id);
      return;
    }

    const seatIdx = meta ? meta.seat : -1;
    const seat = this.seats[seatIdx];
    if (seat && seat.connId === conn.id) {
      if (intentional) {
        const wasHost = this.hostToken && this.hostToken === seat.token;
        seat.token = null;
        if (wasHost) this.hostToken = null;
        if (seat.turnGraceTimer) { clearTimeout(seat.turnGraceTimer); seat.turnGraceTimer = null; }
        if (seat.botPlayTimer) { clearTimeout(seat.botPlayTimer); seat.botPlayTimer = null; }
        if (this.started) {
          const active = this.engine && this.engine.phase === "awaitHuman";
          if (active) {
            seat.connId = null; seat.isBot = false; seat.disconnected = false;
            seat.botFill = false; seat.open = true; seat.userId = null;
            this.paused = true;
            this.vacancy = { seat: seatIdx, name: seat.name };
          } else {
            seat.connId = null; seat.isBot = true; seat.disconnected = false; seat.open = false; seat.userId = null;
            if (this.engine && this.engine.phase === "roundEnd") { this.ready.delete(seatIdx); this.checkReady(); }
            this.broadcast({ name: "sync" });
          }
          this.broadcastPresence({ kind: "left", name: seat.name });
        } else {
          this.seats.splice(seatIdx, 1);
          this.reindexSeats();
        }
      } else if (this.started) {
        // Unintentional drop (refresh / Wi-Fi blip): hold the seat + token and
        // freeze THIS seat's turn for a grace window.
        seat.connId = null; seat.isBot = true; seat.disconnected = true;
        this.beginDisconnectGrace(seatIdx);
        if (this.engine && this.engine.phase === "roundEnd") { this.ready.delete(seatIdx); this.checkReady(); }
        this.broadcast({ name: "sync" });
        this.broadcastPresence({ kind: "lost", name: seat.name });
      } else {
        // Unintentional drop in the lobby: hold the seat briefly for a refresh.
        seat.connId = null; seat.disconnected = true;
        if (seat.graceTimer) clearTimeout(seat.graceTimer);
        seat.graceTimer = setTimeout(() => {
          const idx = this.seats.indexOf(seat);
          if (idx >= 0 && seat.disconnected && !seat.connId) {
            this.seats.splice(idx, 1);
            this.reindexSeats();
            if (this.seats.some((s) => s.connId)) this.broadcastLobby();
            this.reportLobby();
          }
        }, RECONNECT_GRACE_MS);
        this.broadcastLobby();
      }
    }

    // Trailing player who was deciding a re-deal just dropped — play on.
    if (this.engine && this.engine.phase === "awaitReshuffle" &&
        this.seatIsBot(this.engine.reshuffleSeat)) {
      this.engine.beginPlay();
    }

    // Host left? Delegate to a live human; the original reclaims it via token.
    if (this.hostConnId === conn.id) {
      const next = this.seats.find((s) => s.connId && this.connOf(s.connId));
      if (next) this.hostConnId = next.connId;
    }

    const anyHuman = this.seats.some((s) => s.connId && this.connOf(s.connId));
    if (!anyHuman) {
      if (this.paused) { this.paused = false; this.vacancy = null; }
      if (!this.started) {
        this.clearAllTimers();
        this.created = false; this.seats = []; this.engine = null;
        // Awaited: the object may evict right after this handler returns, so the
        // "room gone" report must land before then (otherwise the lobby keeps a
        // stale joinable entry pointing at a dead room until its TTL sweep).
        await this.reportLobby(true);
      } else {
        // Hold the in-progress game for a reconnect, then expire via alarm.
        this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS).catch(() => {});
      }
    } else if (this.paused && this.vacancy) {
      this.broadcastPaused(true, this.vacancy.name);
      this.promptHostVacancy();
      this.reportLobby();
    } else if (!this.started) { this.broadcastLobby(); this.reportLobby(); }
    else this.broadcast({ name: "sync" });
  }

  clearAllTimers() {
    this.seats.forEach((s) => {
      if (s.botPlayTimer) clearTimeout(s.botPlayTimer);
      if (s.turnGraceTimer) clearTimeout(s.turnGraceTimer);
      if (s.graceTimer) clearTimeout(s.graceTimer);
    });
  }

  // Fired RECONNECT_GRACE_MS after the last socket closed on an in-progress game.
  // Nobody came back — let the room go (its in-memory state is discarded when the
  // object evicts; we just clear timers and tell the lobby).
  async onAlarm() {
    const anyHuman = this.seats.some((s) => s.connId && this.connOf(s.connId));
    if (anyHuman) return;
    this.clearAllTimers();
    this.created = false; this.started = false; this.engine = null; this.seats = [];
    await this.reportLobby(true);
  }
}
