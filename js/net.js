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

  class NetClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.connected = false;
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

        ws.onopen = () => { settled = true; clearTimeout(timer); this.connected = true; resolve(); };
        ws.onerror = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          const err = new Error('error'); err.code = 'no-server'; reject(err);
        };
        ws.onclose = () => {
          this.connected = false;
          if (!settled) { settled = true; clearTimeout(timer); const err = new Error('closed'); err.code = 'no-server'; reject(err); }
          this.emit('close');
        };
        ws.onmessage = (ev) => {
          let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
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
    playHuman(cardId) { this.client.send({ t: 'play', cardId }); return true; }

    get human() { return this.players[this.me]; }

    // Rebuild local mirror state from a server snapshot (no events emitted).
    ingest(s) {
      this.me = s.you;
      this.phase = s.phase;
      this.round = s.round;
      this.dealerIndex = s.dealerIndex;
      this.currentPlayerIndex = s.currentPlayerIndex;
      this.heartsBroken = s.heartsBroken;
      this.rules = s.rules;
      this.trickLog = s.trickLog || [];

      this.players = s.players.map((p) => {
        const obj = {
          index: p.index, name: p.name, isHuman: !p.isBot, isBot: p.isBot,
          totalScore: p.totalScore, tricksWon: p.tricksWon,
          roundHistory: p.roundHistory || [], queenTakes: p.queenTakes,
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
        case 'turn':
          this.emit('turn', { playerIndex: s.currentPlayerIndex, legalCardIds: s.legalCardIds });
          break;
        case 'cardPlayed': {
          const last = this.currentTrick[this.currentTrick.length - 1];
          if (last) {
            this.emit('cardPlayed', {
              playerIndex: last.playerIndex, card: last.card,
              trick: this.currentTrick.slice(),
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
            handNo: hint.handNo, tookQueen: hint.tookQueen,
            trick: this.currentTrick.slice(),
          });
          break;
        case 'roundEnd':
          this.emit('roundEnd', {
            round: hint.round, roundScores: hint.roundScores,
            totals: hint.totals, breakdown: hint.breakdown,
          });
          break;
        case 'gameOver':
          this.emit('gameOver', {
            totals: hint.totals, winnerIndex: hint.winnerIndex, ranking: hint.ranking,
          });
          break;
        case 'sync':
        default:
          this.emit('state', { phase: s.phase });
          break;
      }
    }
  }

  BQ.NetClient = NetClient;
  BQ.NetworkEngine = NetworkEngine;
})(typeof window !== 'undefined' ? window : globalThis);
