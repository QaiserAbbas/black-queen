/* =============================================================================
 * Black Queen — LOCAL-NETWORK PLAY  (WebRTC data channels, zero-dependency)
 * -----------------------------------------------------------------------------
 * When every human at a started table is on the same local network, the game
 * moves off the cloud and onto that network:
 *
 *  • Each player opens a data channel to the host's device, with NO STUN/TURN
 *    servers — the only ICE candidates are the devices' own local addresses,
 *    so a channel that opens IS the proof the two reach each other directly on
 *    the LAN. (Signaling rides the cloud room's socket: `lanRtc`.)
 *  • Once the host reaches everyone, the cloud room hands it the game and the
 *    host's browser runs the table: the very same room class the cloud runs
 *    (party/main.js, loaded through the import map in index.html, with
 *    js/lan-shim.js standing in for partyserver), subclassed below so storage,
 *    lobby, history and backups go back to the cloud room instead.
 *  • Moves then travel device-to-device; the cloud only mirrors the table
 *    (`lanSync`, so it can take the game back from exactly here) and writes
 *    its history (`lanRecord`). An internet outage no longer stops the game —
 *    open channels don't need it (rebuilding one does: signaling is online).
 *
 * The table goes back to the cloud (`lanReturn` / the cloud's reclaim) when
 * someone off the network needs it (a joiner, a spectator, a player whose
 * channel can't be rebuilt), when the host leaves or backgrounds the tab, or
 * when the host's device disappears. See party/main.js "Local-network play".
 *
 * Trust: the host's device holds the whole game while it runs the table (it
 * deals, so it could peek at hands). Tokens and account ids never leave the
 * cloud. Untick "Play over the local network" (Appearance) to opt out — the
 * table then stays on the cloud.
 *
 *  UI contract:  attach({ getNet, deliver, onState }); NetClient calls
 *  fromCloud(msg, client) for every cloud message and route(msg) for every
 *  send; main.js calls leave() / reset() / prefChanged().
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  const LINK_TIMEOUT_MS = 8000;        // a channel not open by then: not reachable on this network
  const PING_EVERY_MS = 5000;          // channel heartbeat (also measures round-trip time)
  const PLAYER_STALE_MS = 20000;       // visible tab, nothing from the host this long → channel dead
  const HOST_STALE_MS = 75000;         // host side: lenient — a player's background tab pings ~1/min
  const DISCONNECTED_GRACE_MS = 8000;  // ICE "disconnected" this long → give the channel up
  const PROBE_RETRY_MS = 60000;        // a probe never connected (not on this network): wait before retrying
  const LOST_EVERY_MS = 10000;         // re-report "can't reach the host" at most this often
  const SYNC_DEBOUNCE_MS = 800;        // mirror the table to the cloud once per burst of changes
  const PERSIST_KEY = 'bq_lan';        // host: the running table, so a reload continues it

  // What a seated player sends the table. Everything else (seating, voice,
  // heartbeats, lan* control) always goes to the cloud room.
  const TABLE_TYPES = new Set(['prefs', 'attack', 'emote', 'chat', 'play', 'draw', 'pass',
    'declareLast', 'chooseSuit', 'reshuffle', 'reshuffleDeal', 'reshuffleStart', 'challenge',
    'passChallenge', 'resolveVacancy', 'ready', 'next', 'again', 'leave']);
  // Cloud messages about the game itself — the local table speaks for it now.
  const TABLE_NEWS = new Set(['game', 'peers', 'ready', 'paused', 'seatVacated', 'emote', 'chat', 'attack']);

  const SCRIPT_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ||
    (root.location && root.location.href) || '';
  const MAIN_URL = SCRIPT_SRC ? new URL('../party/main.js', SCRIPT_SRC).href : '';

  function canLink() { return typeof root.RTCPeerConnection === 'function'; }
  function canHost() {
    return canLink() && !!MAIN_URL && !!(root.HTMLScriptElement && root.HTMLScriptElement.supports &&
      root.HTMLScriptElement.supports('importmap'));
  }
  function enabled() { return !(BQ.Prefs && BQ.Prefs.get().lan === false); }
  function visible() { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; }

  let idSeq = 0;
  function randId() { return Math.random().toString(36).slice(2, 10) + (++idSeq).toString(36); }

  function readPersist() {
    try { return JSON.parse(localStorage.getItem(PERSIST_KEY) || 'null'); } catch (_) { return null; }
  }
  function clearPersist() {
    try { localStorage.removeItem(PERSIST_KEY); } catch (_) {}
  }

  /* ---- one host ↔ player data channel ------------------------------------- */
  class Link {
    constructor(seat, id, signal, staleMs) {
      this.seat = seat;            // the OTHER end's seat
      this.id = id;                // per attempt, so stale signaling can't cross attempts
      this.signal = signal;        // (data) → relayed to the other end by the cloud room
      this.staleMs = staleMs;
      this.pc = new RTCPeerConnection({ iceServers: [] });
      this.dc = null;
      this.open = false;
      this.everOpen = false;       // (open turns false again on close)
      this.dead = false;
      this.rtt = null;
      this.lastSeen = Date.now();
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onrtt = null;
      this._q = Promise.resolve();
      this.pc.onicecandidate = (e) => { if (e.candidate && !this.dead) this.signal({ id: this.id, ice: e.candidate }); };
      this.pc.onconnectionstatechange = () => this._state();
      this.pc.oniceconnectionstatechange = () => this._state();
      this._openTimer = setTimeout(() => { if (!this.open) this.close('timeout'); }, LINK_TIMEOUT_MS);
    }

    // Player side: create the channel and offer it.
    offer() {
      this._wire(this.pc.createDataChannel('bq', { ordered: true }));
      this._op(() => this.pc.createOffer()
        .then((o) => this.pc.setLocalDescription(o))
        .then(() => this.signal({ id: this.id, sdp: this.pc.localDescription })));
    }

    // Host side: answer a player's offer.
    answer(sdp) {
      this.pc.ondatachannel = (e) => { if (!this.dc) this._wire(e.channel); };
      this._op(() => this.pc.setRemoteDescription(sdp)
        .then(() => this.pc.createAnswer())
        .then((a) => this.pc.setLocalDescription(a))
        .then(() => this.signal({ id: this.id, sdp: this.pc.localDescription })));
    }

    // The other end's answer / ICE candidates, applied in arrival order.
    remote(data) {
      if (this.dead) return;
      if (data.sdp) this._op(() => this.pc.setRemoteDescription(data.sdp));
      else if (data.ice) this._op(() => this.pc.addIceCandidate(data.ice));
    }

    _op(fn) { this._q = this._q.then(fn).catch(() => {}); }   // a failure just ends in the open timeout

    _wire(dc) {
      this.dc = dc;
      dc.onopen = () => {
        if (this.dead) return;
        this.open = true;
        this.everOpen = true;
        this.lastSeen = Date.now();
        clearTimeout(this._openTimer);
        this._hb = setInterval(() => this._beat(), PING_EVERY_MS);
        if (this.onopen) this.onopen(this);
      };
      dc.onmessage = (ev) => {
        this.lastSeen = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (!m || typeof m !== 'object') return;
        if (m._ === 'ping') { this.send({ _: 'pong', ts: m.ts }); return; }
        if (m._ === 'pong') {
          if (typeof m.ts === 'number') { this.rtt = Math.max(0, Date.now() - m.ts); if (this.onrtt) this.onrtt(this); }
          return;
        }
        if (this.onmessage) this.onmessage(m, this);
      };
      dc.onclose = () => this.close('closed');
      dc.onerror = () => {};     // a close follows
    }

    _beat() {
      if (!this.open) return;
      // Hidden tabs run timers ~1/min — only judge silence while visible.
      if (visible() && Date.now() - this.lastSeen > this.staleMs) { this.close('stale'); return; }
      this.send({ _: 'ping', ts: Date.now() });
    }

    _state() {
      const st = this.pc.connectionState || this.pc.iceConnectionState;
      if (st === 'failed' || st === 'closed') { this.close(st); return; }
      clearTimeout(this._discTimer);
      if (st === 'disconnected') {
        // Often a Wi-Fi blip that heals by itself; give it a moment.
        this._discTimer = setTimeout(() => {
          const now = this.pc.connectionState || this.pc.iceConnectionState;
          if (now !== 'connected' && now !== 'completed') this.close('disconnected');
        }, DISCONNECTED_GRACE_MS);
      }
    }

    send(obj) { return this.sendRaw(JSON.stringify(obj)); }
    sendRaw(str) {
      if (!this.open || this.dead) return false;
      try { this.dc.send(str); return true; } catch (_) { this.close('send'); return false; }
    }

    close(why) {
      if (this.dead) return;
      this.dead = true;
      this.open = false;
      clearTimeout(this._openTimer); clearTimeout(this._discTimer); clearInterval(this._hb);
      try { if (this.dc) this.dc.close(); } catch (_) {}
      try { this.pc.close(); } catch (_) {}
      if (this.onclose) this.onclose(this, why || 'closed');
    }
  }

  /* ---- the cloud's room class, running as the local table ----------------- */
  // Everything a Durable Object does with storage, the lobby, the history
  // database and player backups is the cloud room's job: here it either goes
  // there (hooks.changed → lanSync, hooks.record → lanRecord) or nowhere.
  function makeRoomClass(Main) {
    return class LanRoom extends Main {
      constructor(code, hooks) {
        super({
          name: code,
          conns: new Map(),
          storage: {
            get: () => Promise.resolve(undefined),
            put: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            setAlarm: () => Promise.resolve(),
            deleteAlarm: () => Promise.resolve(),
          },
          blockConcurrencyWhile: (fn) => fn(),
        }, {});
        this.hooks = hooks;
        this.stopped = false;
      }

      save() { if (this.created && !this.stopped) this.hooks.changed(); }
      scheduleBackup() {}
      async sendBackup() {}
      async reportLobby() {}
      armHold() {}
      recordGameStart() { this.hooks.record({ kind: 'start' }); }
      recordRound(roundNo, scores, totals, breakdown) {
        this.hooks.record({ kind: 'round', roundNo, scores, totals, breakdown });
      }
      recordGameOver(winnerSeat, ranking, scores) {
        this.hooks.record({ kind: 'over', winnerSeat, ranking, scores, bots: this.seats.map((_, i) => this.seatIsBot(i)) });
      }
      // Voice and local-play status are the cloud room's to announce.
      broadcastVoice() {}
      broadcastLan() {}
      sendLan() {}

      send(conn, obj) {
        if (this.stopped || !obj) return;
        // Cloud-only replies mean nothing here (a seat this table can't match
        // is refused in attach, not reported as a game that ended).
        if (obj.t === 'resumeFail' || obj.t === 'backup') return;
        // A local seat token means nothing to the cloud: it must never replace
        // the player's saved session.
        if (obj.t === 'joined') obj = Object.assign({}, obj, { token: undefined, local: true });
        super.send(conn, obj);
      }

      handleMessage(conn, msg) {
        if (this.stopped || !msg || !TABLE_TYPES.has(msg.t)) return;
        return super.handleMessage(conn, msg);
      }

      // Seat a connection the host vouches for: its seat was stamped by the
      // cloud's signaling relay. Re-seating reuses the reconnect path.
      attach(conn, seat) {
        const s = this.seats[seat];
        if (this.stopped || !s || !s.token) return false;
        this.ctx.conns.set(conn.id, conn);
        this.onConnect(conn, null);
        super.handleMessage(conn, { t: 'resume', token: s.token });
        return true;
      }

      detach(conn) {
        if (!this.ctx.conns.delete(conn.id) || this.stopped) return;
        this.onClose(conn);
      }

      // The table went back to the cloud (or was superseded): fall silent.
      stop() {
        this.stopped = true;
        this.clearAllTimers();
        this.clearBluffWindow();
        this.engine = null;
      }
    };
  }

  /* ---- controller ---------------------------------------------------------- */
  const Lan = {
    getNet: () => null,      // the current BQ.NetClient (the cloud socket)
    deliver: null,           // (msg) → a message from the local table, as if from the server
    onState: null,           // ({ local, serving, host, relinking, rtt }) → UI

    // What the cloud room told us.
    code: null, mySeat: -1, hostSeat: -1, started: false,
    presence: null,          // last cloud 'peers' seats (host: who must be reachable)
    mode: null,              // { epoch, hostSeat } while the table is local

    // Player side.
    link: null, joinedEpoch: null, relinkTimer: null, fails: 0, lostAt: 0,
    probeBlockedUntil: 0, denied: false,

    // Host side.
    links: {},               // seat → Link
    room: null, selfConn: null, state: null, seq: 0, sentSeq: -1, records: [],
    saveQueued: false, syncTimer: null, goWaitUntil: 0, goTimer: null, roomBroken: false, _roomP: null,

    attach(opts) {
      Object.assign(this, opts || {});
      if (typeof document !== 'undefined') {
        // The table must live on a device that is actually running: a hidden
        // tab is throttled, and a locked phone stops altogether.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') { if (this.room) this.giveBack('hidden'); }
          else this.maybeGo();
        });
        root.addEventListener('pagehide', () => { if (this.room) this.giveBack('hidden'); });
      }
    },

    amHost() { return this.mySeat >= 0 && this.mySeat === this.hostSeat; },
    isLocal() { return !!this.mode; },
    // Moves currently go to the local table (not the cloud).
    serving() {
      if (!this.mode) return false;
      if (this.room) return !!this.selfConn;
      return !!(this.link && this.link.open && this.joinedEpoch === this.mode.epoch);
    },

    sendCloud(obj) {
      const net = this.getNet();
      if (!net || !net.connected) return false;
      net.sendCloud(obj);
      return true;
    },

    /* ---- NetClient hooks --------------------------------------------------- */
    // Every cloud message passes here first. true = consumed (not emitted).
    fromCloud(m, client) {
      if (!m || client !== this.getNet()) return false;
      switch (m.t) {
        case 'joined':
          if (this.code && m.code !== this.code) this.reset();
          this.code = m.code;
          if (typeof m.seat === 'number') this.mySeat = m.seat;
          // Back on the cloud socket while running the table: catch the mirror up.
          if (this.room) { this.sentSeq = -1; this.flush(); }
          return false;
        case 'spectating':
          this.reset();
          this.code = m.code;
          return false;
        case 'takenOver': case 'kicked': case 'resumeFail':
          this.reset();
          return false;
        case 'lan': this.onLan(m); return true;
        case 'lanStart': this.onLanStart(m); return true;
        case 'lanRecall': if (this.mode && m.epoch === this.mode.epoch) this.giveBack('recall'); return true;
        case 'lanRtc': this.onRtc(m.from | 0, m.data || {}); return true;
        case 'lanNo': this.onNo(m.reason); return true;
        case 'peers':
          if (this.mode) return true;
          this.presence = Array.isArray(m.seats) ? m.seats : [];
          this.maybeGo();
          return false;
      }
      return !!this.mode && TABLE_NEWS.has(m.t);
    },

    // Every send passes here first. true = it went to the local table.
    route(obj) {
      if (!obj || !TABLE_TYPES.has(obj.t) || !this.serving()) return false;
      if (this.room) {
        const room = this.room, conn = this.selfConn;
        const msg = JSON.parse(JSON.stringify(obj));
        queueMicrotask(() => { if (this.room === room) room.handleMessage(conn, msg); });
        return true;
      }
      return this.link.send(obj);
    },

    toTable(msg) {
      if (typeof this.deliver === 'function') this.deliver(msg);
      if (msg.t === 'joined') this.emitState();
    },

    /* ---- cloud → mode ------------------------------------------------------ */
    onLan(m) {
      const hostSeat = (typeof m.hostSeat === 'number') ? m.hostSeat : -1;
      if (hostSeat !== this.hostSeat) { this.denied = false; this.probeBlockedUntil = 0; }
      this.hostSeat = hostSeat;
      this.started = !!m.started;
      if (m.on) {
        if (!this.mode || this.mode.epoch !== m.epoch) {
          if (this.room) this.stopRoom();           // an older local table was superseded
          this.mode = { epoch: m.epoch, hostSeat };
          this.joinedEpoch = null;
          this.fails = 0;
          if (!this.amHost()) this.joinTable();
        }
      } else if (this.mode) {
        this.leaveMode();
      }
      if (this.amHost()) {
        if (this.link) { const l = this.link; this.link = null; l.close('now-host'); }
        this.maybeGo();
      } else {
        this.closeHostLinks();
        this.ensureLink();
      }
      this.emitState();
    },

    leaveMode() {
      this.mode = null;
      this.joinedEpoch = null;
      if (this.room) this.stopRoom();
      clearPersist();
      if (this.relinkTimer) { clearTimeout(this.relinkTimer); this.relinkTimer = null; }
      this.fails = 0;
    },

    /* ---- player side ------------------------------------------------------- */
    ensureLink() {
      if (this.amHost() || this.mySeat < 0 || this.hostSeat < 0 || !this.started) return;
      if (!enabled() || !canLink()) {
        // Can't (or won't) play locally — a local table must come back.
        if (this.mode) this.reportLost();
        return;
      }
      if (this.link) {
        if (this.link.seat === this.hostSeat) return;     // up, or coming up
        const l = this.link; this.link = null; l.close('host-changed');
      }
      if (this.relinkTimer) return;
      if (!this.mode && (this.denied || Date.now() < this.probeBlockedUntil)) return;
      const net = this.getNet();
      if (!net || !net.connected) return;                 // signaling needs the cloud
      const link = this.link = new Link(this.hostSeat, randId(),
        (data) => this.sendCloud({ t: 'lanRtc', to: link.seat, data }), PLAYER_STALE_MS);
      link.onopen = () => { this.fails = 0; this.joinTable(); this.emitState(); };
      link.onmessage = (msg) => {
        if (this.link === link && this.mode && this.joinedEpoch === this.mode.epoch) this.toTable(msg);
      };
      link.onrtt = () => this.emitState();
      link.onclose = (l, why) => this.linkLost(l, why);
      link.offer();
    },

    // Ask the host to seat us at the local table (epoch-tagged, so a late
    // channel can't join a table that already moved on).
    joinTable() {
      if (!this.mode || !this.link || !this.link.open) return;
      this.link.send({ _: 'join', epoch: this.mode.epoch });
      this.joinedEpoch = this.mode.epoch;
    },

    linkLost(l, why) {
      if (this.link !== l) return;
      this.link = null;
      this.joinedEpoch = null;
      if (!this.mode) {
        // Only probing. A channel that never opened means the host isn't on
        // this network (or isn't hosting) — don't keep knocking.
        if (why === 'denied') this.denied = true;
        else if (!l.everOpen) this.probeBlockedUntil = Date.now() + PROBE_RETRY_MS;
        else this.relinkTimer = setTimeout(() => { this.relinkTimer = null; this.ensureLink(); }, 2000);
        this.emitState();
        return;
      }
      // The table is local and we lost our way to it: rebuild the channel, and
      // tell the cloud when the host can't be reached (it takes the table back
      // if the host is still around, or once the host is gone for good).
      this.fails += 1;
      if (why === 'gone' || why === 'denied' || this.fails >= 2) this.reportLost();
      const delay = Math.min(800 * Math.pow(1.6, this.fails - 1), 6000);
      this.relinkTimer = setTimeout(() => { this.relinkTimer = null; this.ensureLink(); }, delay);
      this.emitState();
    },

    reportLost() {
      if (!this.mode || Date.now() - this.lostAt < LOST_EVERY_MS) return;
      if (this.sendCloud({ t: 'lanLost', epoch: this.mode.epoch })) this.lostAt = Date.now();
    },

    /* ---- signaling (both sides) -------------------------------------------- */
    onRtc(from, data) {
      if (this.amHost()) {
        if (data.sdp && data.sdp.type === 'offer') { this.acceptLink(from, data); return; }
        const l = this.links[from];
        if (l && l.id === data.id) l.remote(data);
        return;
      }
      const l = this.link;
      if (!l || from !== l.seat || data.id !== l.id) return;
      if (data.deny) { l.close('denied'); return; }
      if (data.gone) { l.close('gone'); return; }
      l.remote(data);
    },

    /* ---- host side ---------------------------------------------------------- */
    acceptLink(seat, data) {
      if (!this.started || !enabled() || !canHost() || this.roomBroken || seat === this.mySeat) {
        this.sendCloud({ t: 'lanRtc', to: seat, data: { id: data.id, deny: true } });
        return;
      }
      const old = this.links[seat];
      if (old) old.close('replaced');
      const link = new Link(seat, data.id,
        (d) => this.sendCloud({ t: 'lanRtc', to: seat, data: d }), HOST_STALE_MS);
      this.links[seat] = link;
      link.onopen = () => { this.emitState(); this.maybeGo(); };
      link.onmessage = (msg) => this.fromPlayer(link, msg);
      link.onclose = (l) => {
        if (this.links[l.seat] === l) delete this.links[l.seat];
        if (l.conn && this.room) this.room.detach(l.conn);
        l.conn = null;
        this.emitState();
      };
      link.answer(data.sdp);
      this.loadRoom().catch(() => {});      // warm the room class while the channel comes up
    },

    closeHostLinks() {
      if (this.room) this.stopRoom();
      Object.keys(this.links).forEach((s) => { const l = this.links[s]; delete this.links[s]; l.close('not-host'); });
    },

    fromPlayer(link, msg) {
      if (msg._ === 'join') { link.wantEpoch = msg.epoch; this.attachLink(link); return; }
      if (msg._) return;
      if (link.conn && this.room) this.room.handleMessage(link.conn, msg);
    },

    attachLink(link) {
      if (!this.room || !this.mode || link.conn || !link.open || link.wantEpoch !== this.mode.epoch) return;
      const conn = {
        id: 'lan-' + link.seat + '-' + randId(),
        send: (str) => { link.sendRaw(str); },
        close: () => link.close('table'),
      };
      link.conn = conn;
      if (!this.room.attach(conn, link.seat)) { link.conn = null; link.close('no-seat'); }
    },

    loadRoom() {
      if (!this._roomP) {
        this._roomP = import(MAIN_URL).then((mod) => makeRoomClass(mod.Main)).catch((e) => {
          this._roomP = null;
          this.roomBroken = true;
          console.warn('local table unavailable', e);
          throw e;
        });
      }
      return this._roomP;
    },

    // Host: when every player connected to the cloud room has an open channel
    // to this device, ask the cloud to move the game here.
    maybeGo() {
      clearTimeout(this.goTimer); this.goTimer = null;
      if (!this.amHost() || this.mode || !this.started || !this.presence) return;
      if (!enabled() || !canHost() || this.roomBroken || !visible()) return;
      const net = this.getNet();
      if (!net || !net.connected) return;
      const wait = this.goWaitUntil - Date.now();
      if (wait > 0) { this.goTimer = setTimeout(() => this.maybeGo(), wait + 50); return; }
      const others = this.presence.filter((p) => p.connected && p.seat !== this.mySeat).map((p) => p.seat);
      const linked = Object.keys(this.links).map(Number).filter((s) => this.links[s].open);
      if (others.some((s) => linked.indexOf(s) < 0)) return;
      this.goWaitUntil = Date.now() + 4000;      // one request in flight
      this.loadRoom().then(() => {
        if (!this.mode && this.amHost()) this.sendCloud({ t: 'lanGo', seats: linked });
      }).catch(() => {});
    },

    // The cloud said "not yet" (someone is watching, a channel isn't up…).
    onNo(reason) {
      this.goWaitUntil = Date.now() + (reason === 'not-linked' ? 3000 : 20000);
      this.maybeGo();
    },

    onLanStart(m) {
      if (!this.amHost()) return;
      if (this.room && this.mode && this.mode.epoch === m.epoch) { this.sentSeq = -1; this.flush(); return; }
      if (this.room) this.stopRoom();
      this.mode = { epoch: m.epoch, hostSeat: this.mySeat };
      this.loadRoom().then((Room) => {
        if (!this.mode || this.mode.epoch !== m.epoch || this.room) return;   // moved on meanwhile
        // Our own copy wins when it is newer (we reloaded mid-game; the cloud
        // only has what we mirrored before).
        const saved = readPersist();
        let state = m.state, seq = Number(m.seq) || 0, records = [];
        if (saved && saved.code === this.code && saved.epoch === m.epoch && saved.state && saved.seq >= seq) {
          state = saved.state; seq = saved.seq; records = Array.isArray(saved.records) ? saved.records : [];
        }
        this.startRoom(Room, state, seq, records);
      }).catch(() => this.giveBack('broken'));
    },

    startRoom(Room, state, seq, records) {
      const room = new Room(this.code, { changed: () => this.changed(), record: (rec) => this.record(rec) });
      try {
        room.hydrate(state);
      } catch (e) {
        console.error('local table could not start', e);
        room.stop();
        this.giveBack('broken');
        return;
      }
      // Seats re-attaching at once isn't news for every player.
      room.quietUntil = Date.now() + 5000;
      this.room = room;
      this.seq = seq;
      this.sentSeq = seq;
      this.records = records.slice();
      // The host's own seat: a loopback "connection" (async, like a socket).
      const self = this.selfConn = {
        id: 'lan-self-' + randId(),
        send: (str) => {
          let msg; try { msg = JSON.parse(str); } catch (_) { return; }
          queueMicrotask(() => { if (this.room === room) this.toTable(msg); });
        },
        close() {},
      };
      if (!room.attach(self, this.mySeat)) {
        this.stopRoom();
        this.giveBack('broken');
        return;
      }
      Object.keys(this.links).forEach((s) => this.attachLink(this.links[s]));
      this.state = room.serializeRoom();
      this.flush();
      this.emitState();
    },

    // The table changed: save this device's copy at once (a reload resumes
    // from it — one save per burst of synchronous changes), and mirror it to
    // the cloud once per burst of moves.
    changed() {
      if (this.saveQueued) return;
      this.saveQueued = true;
      queueMicrotask(() => {
        this.saveQueued = false;
        if (!this.room) return;
        this.seq += 1;
        this.state = this.room.serializeRoom();
        this.persist();
        if (!this.syncTimer) {
          this.syncTimer = setTimeout(() => { this.syncTimer = null; this.flush(); }, SYNC_DEBOUNCE_MS);
        }
      });
    },

    record(rec) {
      this.records.push(rec);
      this.flush();
    },

    // Save the table on this device, and bring the cloud's mirror up to date
    // (when its socket is up — while the internet is out, the newest state and
    // the history rows simply wait).
    flush() {
      if (!this.room || !this.mode) return;
      const net = this.getNet();
      if (!net || !net.connected) { this.persist(); return; }
      while (this.records.length) net.sendCloud({ t: 'lanRecord', epoch: this.mode.epoch, rec: this.records.shift() });
      if (this.state && this.sentSeq !== this.seq) {
        net.sendCloud({ t: 'lanSync', epoch: this.mode.epoch, seq: this.seq, state: this.state });
        this.sentSeq = this.seq;
      }
      this.persist();
    },

    persist() {
      if (!this.room || !this.mode) return;
      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify({
          code: this.code, epoch: this.mode.epoch, seq: this.seq, state: this.state, records: this.records,
        }));
      } catch (_) {}
    },

    // Host: hand the table back to the cloud (asked to, leaving, tab hidden).
    // Without a cloud socket there's nobody to hand it to — keep playing.
    giveBack(why) {
      if (!this.mode || !this.amHost()) return false;
      const net = this.getNet();
      if (!net || !net.connected) return false;
      const epoch = this.mode.epoch;
      const state = this.room ? this.room.serializeRoom() : null;
      if (this.room) {
        while (this.records.length) net.sendCloud({ t: 'lanRecord', epoch, rec: this.records.shift() });
        this.stopRoom();
      }
      this.seq += 1;
      net.sendCloud({ t: 'lanReturn', epoch, seq: this.seq, state, why });
      if (why === 'broken') this.roomBroken = true;      // don't keep trying to host
      this.mode = null;
      clearPersist();
      this.goWaitUntil = Date.now() + 5000;
      this.emitState();
      return true;
    },

    stopRoom() {
      const room = this.room;
      if (!room) return;
      this.room = null;
      this.selfConn = null;
      clearTimeout(this.syncTimer); this.syncTimer = null;
      room.stop();
      Object.keys(this.links).forEach((s) => { this.links[s].conn = null; this.links[s].wantEpoch = null; });
      this.state = null;
      this.records = [];
    },

    /* ---- main.js ------------------------------------------------------------ */
    // Leaving the game. A host hands the table back first (so the leave then
    // reaches the cloud like from any table). Returns true for a player whose
    // moves go to the local table: their leave must reach both.
    leave() {
      const viaTable = this.serving() && !this.room;
      if (this.room) this.giveBack('leave');
      if (viaTable) setTimeout(() => this.reset(), 300);   // let the leave go out first
      else this.reset();
      return viaTable;
    },

    // The "Play over the local network" preference changed.
    prefChanged() {
      if (enabled()) {
        if (this.amHost()) this.maybeGo(); else this.ensureLink();
        return;
      }
      if (this.room) this.giveBack('pref');
      else if (this.mode) this.reportLost();
      if (this.link) { const l = this.link; this.link = null; l.close('pref'); }
      Object.keys(this.links).forEach((s) => { const l = this.links[s]; delete this.links[s]; l.close('pref'); });
      this.emitState();
    },

    reset() {
      if (this.room) this.stopRoom();
      if (this.link) { const l = this.link; this.link = null; l.close('reset'); }
      Object.keys(this.links).forEach((s) => { const l = this.links[s]; delete this.links[s]; l.close('reset'); });
      clearTimeout(this.relinkTimer); this.relinkTimer = null;
      clearTimeout(this.goTimer); this.goTimer = null;
      this.mode = null; this.joinedEpoch = null; this.presence = null;
      this.code = null; this.mySeat = -1; this.hostSeat = -1; this.started = false;
      this.fails = 0; this.lostAt = 0; this.denied = false; this.probeBlockedUntil = 0; this.goWaitUntil = 0;
      clearPersist();
      this.emitState({ ended: true });
    },

    // extra.ended: we left this table altogether (left / kicked / taken over).
    emitState(extra) {
      if (typeof this.onState !== 'function') return;
      const serving = this.serving();
      this.onState(Object.assign({
        local: !!this.mode,
        serving,
        host: !!this.room,
        relinking: !!this.mode && !serving,
        rtt: this.room ? null : (this.link ? this.link.rtt : null),
      }, extra));
    },
  };

  Lan.makeRoomClass = makeRoomClass;     // (also used by the Node test harness)
  BQ.Lan = Lan;
})(typeof window !== 'undefined' ? window : globalThis);
