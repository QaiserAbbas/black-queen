/* =============================================================================
 * BLUFF — GAME ENGINE  (a.k.a. Cheat / BS / I Doubt It)
 * -----------------------------------------------------------------------------
 * Headless, event-driven engine. It holds ALL state and enforces ALL rules
 * (reading from the Bluff rules config). It knows nothing about the DOM — it
 * just emits events that a UI (or the authoritative server) subscribes to.
 * Same on/emit + "init vs initWithPlayers" contract as the other engines, so
 * the SAME code path serves local single-player and online play.
 *
 * The deck is dealt out completely. On your turn you place 1–maxPerPlay cards
 * FACE DOWN onto the pile and CLAIM a rank (free choice). Any OTHER active
 * player may then call "Bluff!". On a challenge the just-played cards are
 * revealed: if any card's rank ≠ the claim, the claimer takes the whole pile;
 * otherwise the challenger takes it. The loser of the challenge leads next (with
 * a fresh, empty pile). If nobody challenges, the pile stays and the next player
 * adds to it. First to empty their hand finishes 1st; the last one is the loser.
 *
 * Emitted events (engine.on('eventName', handler)):
 *   'gameStart'         {players, dealerIndex, firstPlayerIndex, hands}
 *   'turn'              {playerIndex}                     // someone must play
 *   'cardPlayed'        {playerIndex, rank, count, pileCount, handCount}
 *   'challengeWindow'   {by, rank, count}                // doubt is now open
 *   'challengePassed'   {playerIndex}                    // a player let it go
 *   'challengeResolved' {challenger, by, rank, wasBluff, revealed, loser, pileCount}
 *   'playerFinished'    {playerIndex, rank, name}
 *   'gameOver'          {ranking, loserIndex}
 *   'state'             {phase}
 *   'resync'            {}
 *
 * Phases: 'idle' | 'playing' | 'awaitHuman' | 'awaitChallenge' | 'gameOver'
 *   (the active player's turn is 'awaitHuman' for human seats so the server's
 *    reconnect / bot-fill machinery — which keys on 'awaitHuman' — just works.)
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  class BluffPlayer {
    constructor(index, name, isHuman) {
      this.index = index;
      this.name = name;
      this.isHuman = !!isHuman;
      this.hand = [];
      this.finished = false;   // emptied their hand
      this.finishRank = 0;     // 1 = first to finish, etc. (0 while playing)
    }
  }

  class BluffEngine {
    constructor(rules) {
      this.rules = rules || (BQ.cloneBluffRules ? BQ.cloneBluffRules() : {});
      this.listeners = {};
      this.players = [];
      this.pile = [];                 // face-down cards on the table (bottom→top)
      this.currentPlayerIndex = 0;
      this.dealerIndex = 0;
      this.phase = 'idle';
      this.claim = null;              // {by, rank, count, cards:[Card]} awaiting doubt
      this.challengeDecided = new Set(); // players who passed on the current claim
      this.finishedOrder = [];        // player indices, in finish order
      this._pendingFinish = false;    // the claimer emptied their hand with this play
      this._lastResolved = null;      // last challengeResolved payload (for resync)
      this._lastGameOver = null;
      this._botTimer = null;          // single-player: the current bot's turn timer
      this._botChallengeTimers = [];  // single-player: pending bot doubt timers
    }

    /* ---- tiny event bus --------------------------------------------------- */
    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) { (this.listeners[evt] || []).forEach((fn) => fn(payload)); }

    /* ---- setup ------------------------------------------------------------ */
    // Single-player: human at seat 0, the rest are bots driven by THIS engine.
    init(humanName) {
      const r = this.rules;
      this.players = [];
      this.players.push(new BluffPlayer(0, humanName || 'You', true));
      const pool = BQ.cloneOf(r.botNames);
      for (let i = 1; i < r.playerCount; i++) {
        const name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] || ('Bot ' + i);
        this.players.push(new BluffPlayer(i, name, false));
      }
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('idle');
    }

    // Server-side: every seat is "human-controlled" so the engine never auto-acts
    // — the SERVER drives both real players and bots through the public methods.
    initWithPlayers(names) {
      this.players = names.map((n, i) => new BluffPlayer(i, n, true));
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('idle');
    }

    _setPhase(phase) { this.phase = phase; this.emit('state', { phase }); }

    /* ---- turn order (direction-aware; finished players are skipped) -------- */
    _step() { return this.rules.playDirection === 'left' ? 1 : -1; }
    _next(i) {
      const n = this.players.length, step = this._step();
      let j = i;
      for (let k = 0; k < n; k++) {
        j = (((j + step) % n) + n) % n;
        if (!this.players[j].finished) return j;
      }
      return i;
    }
    activeCount() { return this.players.filter((p) => !p.finished).length; }

    /* ---- start / deal ----------------------------------------------------- */
    start() {
      const deck = BQ.shuffle(BQ.buildTreekyDeck(this.rules.decks || 1));
      this.players.forEach((p) => {
        p.hand = [];
        p.finished = false; p.finishRank = 0;
      });
      // Deal the WHOLE deck out round-robin (hands may be uneven by one card).
      let i = 0;
      while (deck.length) {
        const c = deck.pop();
        this.players[i % this.players.length].hand.push(c);
        i++;
      }
      this.players.forEach((p) => BQ.sortHand(p.hand));

      this.pile = [];
      this.claim = null;
      this.challengeDecided = new Set();
      this.finishedOrder = [];
      this._pendingFinish = false;
      this._lastResolved = null;
      this._lastGameOver = null;

      // The player AFTER the dealer takes the first turn.
      this.currentPlayerIndex = this._next(this.dealerIndex);

      this._setPhase('playing');
      this.emit('gameStart', {
        players: this.players.map((p) => ({ index: p.index, name: p.name, isHuman: p.isHuman })),
        dealerIndex: this.dealerIndex,
        firstPlayerIndex: this.currentPlayerIndex,
        hands: this.players.map((p) => p.hand),
      });
      this._beginTurn();
    }

    /* ---- affordances (read by both the UI and the snapshot) --------------- */
    pileCount() { return this.pile.length; }
    maxClaimFor(idx) {
      const p = this.players[idx];
      return Math.min(this.rules.maxPerPlay || 4, p ? p.hand.length : 0);
    }
    canPlay(idx) { return this.phase === 'awaitHuman' && this.currentPlayerIndex === idx; }
    canChallenge(idx) {
      const p = this.players[idx];
      return this.phase === 'awaitChallenge' && !!this.claim &&
        idx !== this.claim.by && !!p && !p.finished && !this.challengeDecided.has(idx);
    }

    /* ---- turn lifecycle --------------------------------------------------- */
    _beginTurn() {
      const idx = this.currentPlayerIndex;
      const p = this.players[idx];
      if (!p || p.finished) { this.currentPlayerIndex = this._next(idx); return this._beginTurn(); }

      this._setPhase(p.isHuman ? 'awaitHuman' : 'playing');
      this.emit('turn', { playerIndex: idx });

      if (p.isHuman) return;     // a human / server seat acts via public methods
      this._scheduleBotTurn(idx);
    }

    _scheduleBotTurn(idx) {
      clearTimeout(this._botTimer);
      this._botTimer = setTimeout(() => this._botTurnStep(idx), Math.max(150, this.rules.botThinkMs));
    }

    _botTurnStep(idx) {
      if (this.phase !== 'playing' || this.currentPlayerIndex !== idx) return;
      const p = this.players[idx];
      if (!p || p.finished || p.isHuman) return;
      const move = BQ.BluffAI.choosePlay(this, idx);
      if (!move || !move.cardIds || !move.cardIds.length) return; // should not happen
      this._doPlay(idx, move.rank, move.cardIds);
    }

    /* ---- public actions (human UI + server) ------------------------------- */
    // Place cards face down and claim a rank. `cardIds` is 1..maxPerPlay ids
    // from the player's hand; `rank` is any rank in BQ.RANKS.
    playClaim(idx, rank, cardIds) {
      if (this.phase !== 'awaitHuman' || idx !== this.currentPlayerIndex) return false;
      if (!this._validClaim(idx, rank, cardIds)) return false;
      this._doPlay(idx, rank, cardIds);
      return true;
    }

    _validClaim(idx, rank, cardIds) {
      const p = this.players[idx];
      if (!p || p.finished) return false;
      if (BQ.RANKS.indexOf(rank) < 0) return false;
      if (!Array.isArray(cardIds) || cardIds.length < 1) return false;
      if (cardIds.length > (this.rules.maxPerPlay || 4)) return false;
      // every id must be a distinct card currently in the hand
      const seen = new Set();
      for (const id of cardIds) {
        if (seen.has(id)) return false;
        seen.add(id);
        if (!p.hand.some((c) => c.id === id)) return false;
      }
      return true;
    }

    _doPlay(idx, rank, cardIds) {
      const p = this.players[idx];
      const ids = new Set(cardIds);
      const taken = p.hand.filter((c) => ids.has(c.id));
      p.hand = p.hand.filter((c) => !ids.has(c.id));
      taken.forEach((c) => this.pile.push(c));

      this.claim = { by: idx, rank, count: taken.length, cards: taken };
      this.challengeDecided = new Set();
      this._pendingFinish = (p.hand.length === 0);

      this.emit('cardPlayed', {
        playerIndex: idx, rank, count: taken.length,
        pileCount: this.pile.length, handCount: p.hand.length,
      });

      this._openChallenge();
    }

    _openChallenge() {
      this._setPhase('awaitChallenge');
      this.emit('challengeWindow', { by: this.claim.by, rank: this.claim.rank, count: this.claim.count });

      // Single-player only (the engine drives the bots — detected by the presence
      // of any non-human seat): schedule each eligible BOT to decide, and give the
      // human a grace window to call "Bluff!" before auto-letting-it-go so the
      // table flows without a click on every play. On the server every seat is
      // "human", so this schedules nothing and the server drives the window.
      this._clearBotChallengeTimers();
      const driven = this.players.some((p) => !p.isHuman);
      if (!driven) return;
      const eligible = this._eligibleChallengers();
      eligible.forEach((i, n) => {
        if (this.players[i].isHuman) {
          const t = setTimeout(() => { if (this.canChallenge(i)) this.passChallenge(i); },
            Math.max(2000, this.rules.challengeWindowMs || 9000));
          this._botChallengeTimers.push(t);
          return;
        }
        const t = setTimeout(() => this._botChallengeStep(i), Math.max(150, this.rules.botThinkMs) + n * 220);
        this._botChallengeTimers.push(t);
      });
    }

    _eligibleChallengers() {
      if (!this.claim) return [];
      return this.players
        .filter((p) => !p.finished && p.index !== this.claim.by && !this.challengeDecided.has(p.index))
        .map((p) => p.index);
    }

    _botChallengeStep(idx) {
      if (!this.canChallenge(idx)) return;
      const doubt = BQ.BluffAI.decideChallenge(this, idx);
      if (doubt) this.challenge(idx); else this.passChallenge(idx);
    }

    // A player calls "Bluff!" on the current claim.
    challenge(idx) {
      if (!this.canChallenge(idx)) return false;
      this._clearBotChallengeTimers();
      this._resolveChallenge(idx);
      return true;
    }

    // A player declines to challenge ("let it go").
    passChallenge(idx) {
      if (!this.canChallenge(idx)) return false;
      this.challengeDecided.add(idx);
      this.emit('challengePassed', { playerIndex: idx });
      if (this._eligibleChallengers().length === 0) this._resolveNoChallenge();
      return true;
    }

    _resolveNoChallenge() {
      this._clearBotChallengeTimers();
      const by = this.claim ? this.claim.by : this.currentPlayerIndex;
      // The claim stands; the pile stays for the next player to build on.
      if (this._pendingFinish) this._finishPlayer(by);
      this._pendingFinish = false;
      if (this.activeCount() <= 1) return this._endGame();
      this.currentPlayerIndex = this._next(by);
      this._beginTurn();
    }

    _resolveChallenge(challengerIdx) {
      const claim = this.claim;
      const revealed = claim.cards.map((c) => ({ rank: c.rank, suit: c.suit, id: c.id }));
      const wasBluff = claim.cards.some((c) => c.rank !== claim.rank);
      const loser = wasBluff ? claim.by : challengerIdx;

      // The loser scoops up the WHOLE pile.
      const lp = this.players[loser];
      this.pile.forEach((c) => lp.hand.push(c));
      BQ.sortHand(lp.hand);
      this.pile = [];

      const payload = {
        challenger: challengerIdx, by: claim.by, rank: claim.rank,
        wasBluff, revealed, loser, pileCount: 0,
      };
      this._lastResolved = payload;
      this.emit('challengeResolved', payload);

      // A truthful final play means the claimer really did empty their hand.
      if (!wasBluff && this._pendingFinish) this._finishPlayer(claim.by);
      this._pendingFinish = false;
      this.claim = null;
      this.challengeDecided = new Set();

      if (this.activeCount() <= 1) return this._endGame();
      // The loser of the doubt leads the next (fresh) pile; if somehow inactive,
      // fall back to the player after the claimer.
      this.currentPlayerIndex = (this.players[loser] && !this.players[loser].finished)
        ? loser : this._next(claim.by);
      this._beginTurn();
    }

    _finishPlayer(idx) {
      const p = this.players[idx];
      if (!p || p.finished) return;
      p.finished = true;
      this.finishedOrder.push(idx);
      p.finishRank = this.finishedOrder.length;
      this.emit('playerFinished', { playerIndex: idx, rank: p.finishRank, name: p.name });
    }

    _endGame() {
      clearTimeout(this._botTimer);
      this._clearBotChallengeTimers();
      // Append any players still holding cards (normally one) — ranked by fewest
      // cards left, ties by seat. The last one is the loser.
      const remaining = this.players.filter((p) => !p.finished)
        .sort((a, b) => (a.hand.length - b.hand.length) || (a.index - b.index));
      remaining.forEach((p) => this.finishedOrder.push(p.index));
      const order = this.finishedOrder.slice();
      const loserIndex = order.length ? order[order.length - 1] : -1;
      order.forEach((i, rank) => { this.players[i].finishRank = rank + 1; });
      const ranking = order.map((i, rank) => ({
        index: i, name: this.players[i].name, rank: rank + 1, cardsLeft: this.players[i].hand.length,
      }));
      this._lastGameOver = { ranking, loserIndex };
      this._setPhase('gameOver');
      this.emit('gameOver', this._lastGameOver);
    }

    _clearBotChallengeTimers() {
      this._botChallengeTimers.forEach((t) => clearTimeout(t));
      this._botChallengeTimers = [];
    }

    /* ---- persistence (server restore / refresh) — mirrors TreekyEngine ----- */
    snapshot() {
      const card = (c) => (c ? { rank: c.rank, suit: c.suit, id: c.id } : null);
      return {
        v: 1, game: 'bluff', rules: this.rules,
        phase: this.phase, dealerIndex: this.dealerIndex,
        currentPlayerIndex: this.currentPlayerIndex,
        pile: this.pile.map(card),
        claim: this.claim ? {
          by: this.claim.by, rank: this.claim.rank, count: this.claim.count,
          cards: this.claim.cards.map(card),
        } : null,
        challengeDecided: [...this.challengeDecided],
        finishedOrder: this.finishedOrder.slice(),
        pendingFinish: !!this._pendingFinish,
        lastResolved: this._lastResolved || null,
        lastGameOver: this._lastGameOver || null,
        players: this.players.map((p) => ({
          index: p.index, name: p.name, isHuman: p.isHuman,
          hand: p.hand.map(card), finished: p.finished, finishRank: p.finishRank,
        })),
      };
    }

    static fromSnapshot(data) {
      const e = new BluffEngine(data.rules);
      e.phase = data.phase;
      e.dealerIndex = data.dealerIndex;
      e.currentPlayerIndex = data.currentPlayerIndex;
      e.pile = (data.pile || []).map((c) => BQ.cardFrom(c));
      e.claim = data.claim ? {
        by: data.claim.by, rank: data.claim.rank, count: data.claim.count,
        cards: (data.claim.cards || []).map((c) => BQ.cardFrom(c)),
      } : null;
      e.challengeDecided = new Set(data.challengeDecided || []);
      e.finishedOrder = data.finishedOrder || [];
      e._pendingFinish = !!data.pendingFinish;
      e._lastResolved = data.lastResolved || null;
      e._lastGameOver = data.lastGameOver || null;
      e.players = (data.players || []).map((pd) => {
        const p = new BluffPlayer(pd.index, pd.name, pd.isHuman);
        p.hand = (pd.hand || []).map((c) => BQ.cardFrom(c));
        p.finished = !!pd.finished; p.finishRank = pd.finishRank || 0;
        return p;
      });
      return e;
    }
  }

  BQ.BluffEngine = BluffEngine;
  BQ.BluffPlayer = BluffPlayer;
})(typeof window !== "undefined" ? window : globalThis);
