/* =============================================================================
 * Black Queen — CLIENT NETWORKING
 * -----------------------------------------------------------------------------
 *  • NetClient    — thin WebSocket wrapper (connect / send / on-message).
 *  • NetworkEngine — mirrors the local GameEngine's interface (on/emit, players,
 *                    rules, phase, trickLog, playHuman) but is driven by server
 *                    snapshots. This lets the existing UI attach to it unchanged.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  // Heartbeat: keeps cloud proxies (ngrok / Render / Cloudflare) from killing
  // an "idle" socket, measures round-trip latency, and detects half-open
  // connections (network died but no close event ever arrived).
  // STALE_AFTER tolerates background-tab timer throttling (browsers slow
  // intervals to ~1/min when the tab is hidden) so we don't churn reconnects.
  const HEARTBEAT_EVERY_MS = 20 * 1000;
  const STALE_AFTER_MS = 130 * 1000;

  class NetClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.latencyMs = null;     // last measured round-trip, for the status pill
      this._lastSeen = 0;
      this._hbTimer = null;
    }

    _startHeartbeat() {
      this._lastSeen = Date.now();
      this._hbTimer = setInterval(() => {
        if (!this.connected) return;
        // No traffic at all for too long → the link is dead even though the
        // browser never told us. Force-close so the reconnect path kicks in.
        if (Date.now() - this._lastSeen > STALE_AFTER_MS) {
          try { this.ws.close(); } catch (_) {}
          return;
        }
        this.send({ t: 'ping', ts: Date.now() });
      }, HEARTBEAT_EVERY_MS);
      // Coming back from a locked phone / background tab: probe immediately so
      // a dead link is noticed (and replaced) right away, not a minute later.
      if (!this._visHandler) {
        this._visHandler = () => {
          if (document.visibilityState === 'visible' && this.connected) {
            this.send({ t: 'ping', ts: Date.now() });
          }
        };
        document.addEventListener('visibilitychange', this._visHandler);
      }
    }

    _stopHeartbeat() {
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
      if (this._visHandler) {
        document.removeEventListener('visibilitychange', this._visHandler);
        this._visHandler = null;
      }
    }
    connect() {
      return new Promise((resolve, reject) => {
        // Multiplayer requires the Node server. file:// (or any non-http origin)
        // can't open a WebSocket at all — fail clearly instead of hanging.
        if (location.protocol !== 'http:' && location.protocol !== 'https:') {
          const err = new Error('not-served'); err.code = 'not-served'; return reject(err);
        }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + location.host + '/ws';
        let settled = false;
        let ws;
        try { ws = this.ws = new WebSocket(url); }
        catch (e) { e.code = 'bad-url'; return reject(e); }

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch (_) {}
          const err = new Error('timeout'); err.code = 'timeout'; reject(err);
        }, 5000);

        ws.onopen = () => {
          settled = true; clearTimeout(timer); this.connected = true;
          this._startHeartbeat();
          resolve();
        };
        ws.onerror = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          const err = new Error('error'); err.code = 'no-server'; reject(err);
        };
        ws.onclose = () => {
          this.connected = false;
          this._stopHeartbeat();
          if (!settled) { settled = true; clearTimeout(timer); const err = new Error('closed'); err.code = 'no-server'; reject(err); }
          this.emit('close');
        };
        ws.onmessage = (ev) => {
          this._lastSeen = Date.now();
          let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
          if (msg.t === 'pong') {
            if (msg.ts) this.latencyMs = Date.now() - msg.ts;
          }
          this.emit(msg.t, msg);
        };
      });
    }
    on(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); return this; }
    emit(t, payload) { (this.handlers[t] || []).forEach((fn) => fn(payload)); }
    send(obj) { if (this.ws && this.connected) this.ws.send(JSON.stringify(obj)); }
  }

  /* ---- NetworkEngine: a read-only mirror the UI can render ---------------- */
  class NetworkEngine {
    constructor(client) {
      this.client = client;
      this.listeners = {};
      this.players = [];
      this.rules = {};
      this.me = 0;
      this.phase = 'idle';
      this.dealerIndex = 0;
      this.currentPlayerIndex = 0;
      this.heartsBroken = false;
      this.trickLog = [];
      this.currentTrick = [];
    }

    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) { (this.listeners[evt] || []).forEach((fn) => fn(payload)); }

    // Sending a move to the authoritative server (mirror of local playHuman).
    // smash = slam style ('punch'/'fire'/…); the server echoes it so every
    // table sees it. punch keeps older servers/clients working.
    playHuman(cardId, smash) { this.client.send({ t: 'play', cardId, punch: !!smash, smash: smash || undefined }); return true; }

    // Trailing-player re-deal controls (before a round begins).
    reshuffleDeal() { this.client.send({ t: 'reshuffleDeal' }); return true; }
    reshuffleStart() { this.client.send({ t: 'reshuffleStart' }); return true; }

    get human() { return this.players[this.me]; }

    // Rebuild local mirror state from a server snapshot (no events emitted).
    ingest(s) {
      this.me = s.you;
      this.spectator = !!s.spectator;   // watching only: me = -1, no hand, no moves
      this.phase = s.phase;
      this.round = s.round;
      this.dealerIndex = s.dealerIndex;
      this.currentPlayerIndex = s.currentPlayerIndex;
      this.heartsBroken = s.heartsBroken;
      this.rules = s.rules;
      this.trickLog = s.trickLog || [];
      this.reshuffle = s.reshuffle || null;   // {seat, remaining} while a re-deal is offered

      this.players = s.players.map((p) => {
        const obj = {
          index: p.index, name: p.name, isHuman: !p.isBot, isBot: p.isBot,
          offline: !!p.offline,
          totalScore: p.totalScore, tricksWon: p.tricksWon,
          roundHistory: p.roundHistory || [], queenTakes: p.queenTakes,
          consecutiveZeros: p.consecutiveZeros || 0,
          _penalty: p.penalty,
        };
        // Reconstruct real Card objects for my own hand; placeholders for others.
        obj.hand = p.hand
          ? p.hand.map((c) => new BQ.Card(c.rank, c.suit))
          : new Array(p.handCount).fill(null);
        return obj;
      });

      this.currentTrick = (s.currentTrick || []).map((x) => ({
        playerIndex: x.playerIndex, card: new BQ.Card(x.card.rank, x.card.suit),
      }));
      this._lastSnapshot = s;
    }

    // Apply a snapshot then fire the matching UI event for animation.
    handle(s, hint) {
      this.ingest(s);
      const name = hint && hint.name;
      switch (name) {
        case 'roundStart':
          this.emit('roundStart', {
            round: s.round, dealerIndex: s.dealerIndex, leaderIndex: hint.leaderIndex,
            hands: this.players.map((p) => p.hand),
          });
          this.emit('turn', { playerIndex: s.currentPlayerIndex, legalCardIds: s.legalCardIds });
          break;
        // Trailing player decides on a reshuffle BEFORE cards are dealt.
        case 'reshuffleOffer':
          this.emit('reshuffleOffer', { seat: hint.seat, remaining: hint.remaining, me: this.me });
          break;
        case 'turn':
          this.emit('turn', { playerIndex: s.currentPlayerIndex, legalCardIds: s.legalCardIds });
          break;
        case 'cardPlayed': {
          const last = this.currentTrick[this.currentTrick.length - 1];
          if (last) {
            this.emit('cardPlayed', {
              playerIndex: last.playerIndex, card: last.card,
              trick: this.currentTrick.slice(),
              punch: !!hint.punch,
              smash: hint.smash || (hint.punch ? 'punch' : null),
            });
          }
          break;
        }
        case 'heartsBroken':
          this.emit('heartsBroken', {});
          break;
        case 'trickWon':
          this.emit('trickWon', {
            winnerIndex: hint.winnerIndex, points: hint.points,
            handNo: hint.handNo, tookQueen: hint.tookQueen, queenDisregarded: hint.queenDisregarded,
            trick: this.currentTrick.slice(),
          });
          break;
        case 'roundEnd':
          this.emit('roundEnd', {
            round: hint.round, roundScores: hint.roundScores,
            totals: hint.totals, breakdown: hint.breakdown,
            tricks: hint.tricks,
            gameOver: !!hint.gameOver,
          });
          break;
        case 'gameOver':
          this.emit('gameOver', {
            totals: hint.totals, winnerIndex: hint.winnerIndex, ranking: hint.ranking,
          });
          break;
        case 'resync':
          // A reconnecting player: rebuild the whole table from the snapshot,
          // then restore the active-turn highlight + playable cards.
          this.emit('resync', { phase: s.phase });
          if (s.reshuffle) {
            this.emit('reshuffleOffer', { seat: s.reshuffle.seat, remaining: s.reshuffle.remaining, me: this.me });
          } else {
            this.emit('turn', { playerIndex: s.currentPlayerIndex, legalCardIds: s.legalCardIds });
          }
          break;
        case 'sync':
        default:
          this.emit('state', { phase: s.phase });
          break;
      }
    }
  }

  /* ---- TreekyNetworkEngine: read-only mirror for the Treeky UI ------------ */
  // Same on/emit + action-method contract as TreekyEngine, but driven by server
  // snapshots. The Treeky UI can't tell it apart from a local engine.
  class TreekyNetworkEngine {
    constructor(client) {
      this.client = client;
      this.listeners = {};
      this.players = [];
      this.rules = {};
      this.me = 0;
      this.spectator = false;
      this.phase = 'idle';
      this.currentPlayerIndex = 0;
      this.activeSuit = null;
      this.pendingDraw = 0;
      this.drawPile = [];
      this.discardPile = [];
      this.finishedOrder = [];
      this._lastTurn = null;
    }

    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) { (this.listeners[evt] || []).forEach((fn) => fn(payload)); }

    /* actions → server messages */
    playHuman(cardId, suit) { this.client.send({ t: 'play', cardId, suit: suit || undefined }); return true; }
    drawForTurn() { this.client.send({ t: 'draw' }); return true; }
    pass() { this.client.send({ t: 'pass' }); return true; }
    declareLast() { this.client.send({ t: 'declareLast' }); return true; }
    chooseSuit(idx, suit) { this.client.send({ t: 'chooseSuit', suit }); return true; }
    reshuffle() { this.client.send({ t: 'reshuffle' }); return true; }

    get human() { return this.players[this.me]; }

    ingest(s) {
      this.me = s.you;
      this.spectator = !!s.spectator;
      this.youAreHost = !!s.youAreHost;
      this.phase = s.phase;
      this.rules = s.rules || {};
      this.dealerIndex = s.dealerIndex || 0;
      this.currentPlayerIndex = s.currentPlayerIndex;
      this.activeSuit = s.activeSuit;
      this.pendingDraw = s.pendingDraw || 0;
      this.finishedOrder = s.finishedOrder || [];
      this.drawPile = new Array(s.drawCount || 0).fill(null);  // length only — for the count label
      this.discardPile = s.topCard ? [BQ.cardFrom(s.topCard)] : [];
      this._lastTurn = {
        playerIndex: s.currentPlayerIndex, legalCardIds: s.legalCardIds || [],
        pendingDraw: this.pendingDraw, activeSuit: this.activeSuit,
        topCard: s.topCard || null, canDraw: !!s.canDraw, canPass: !!s.canPass,
      };
      this.players = (s.players || []).map((p) => ({
        index: p.index, name: p.name, isHuman: !p.isBot, isBot: p.isBot, offline: !!p.offline,
        finished: !!p.finished, finishRank: p.finishRank || 0,
        hand: p.hand ? p.hand.map((c) => BQ.cardFrom(c)) : new Array(p.handCount || 0).fill(null),
      }));
      this._lastSnapshot = s;
    }

    handle(s, hint) {
      this.ingest(s);
      const name = hint && hint.name;
      const turnEv = () => this._lastTurn;
      switch (name) {
        case 'gameStart': this.emit('gameStart', {}); this.emit('turn', turnEv()); break;
        case 'turn': this.emit('turn', turnEv()); break;
        case 'cardPlayed':
          this.emit('cardPlayed', { playerIndex: hint.playerIndex, isThree: hint.isThree, isJack: hint.isJack });
          break;
        case 'suitChosen': this.emit('suitChosen', { playerIndex: hint.playerIndex, suit: hint.suit }); break;
        case 'cardsDrawn':
          this.emit('cardsDrawn', { playerIndex: hint.playerIndex, count: hint.count, penalty: hint.penalty, reason: hint.reason });
          break;
        case 'lastCardDeclared': this.emit('lastCardDeclared', { playerIndex: hint.playerIndex }); break;
        case 'needReshuffle': this.emit('needReshuffle', {}); break;
        case 'reshuffled': this.emit('reshuffled', {}); this.emit('turn', turnEv()); break;
        case 'playerFinished':
          this.emit('playerFinished', { playerIndex: hint.playerIndex, rank: hint.rank, name: hint.name });
          break;
        case 'gameOver': this.emit('gameOver', { ranking: hint.ranking, loserIndex: hint.loserIndex }); break;
        case 'resync': this.emit('resync', {}); this.emit('turn', turnEv()); break;
        default: this.emit('state', { phase: s.phase }); break;
      }
    }
  }

  BQ.NetClient = NetClient;
  BQ.NetworkEngine = NetworkEngine;
  BQ.TreekyNetworkEngine = TreekyNetworkEngine;
})(typeof window !== 'undefined' ? window : globalThis);
