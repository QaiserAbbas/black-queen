/* =============================================================================
 * TREEKY — GAME ENGINE
 * -----------------------------------------------------------------------------
 * A headless, event-driven SHEDDING engine (Crazy-Eights / "Switch" family).
 * It holds ALL game state and enforces ALL rules (reading values from the Treeky
 * rules config). It knows nothing about the DOM — it just emits events that a UI
 * (or the authoritative server) subscribes to. Same on/emit contract as the
 * Black Queen engine, but a completely different rule set.
 *
 * Emitted events (engine.on('eventName', handler)):
 *   'gameStart'        {players, dealerIndex, firstPlayerIndex, topCard, hands}
 *   'turn'             {playerIndex, legalCardIds, pendingDraw, activeSuit, topCard,
 *                       canDraw, canPass}
 *   'cardPlayed'       {playerIndex, card, topCard, activeSuit, isThree, isJack, handCount}
 *   'suitChosen'       {playerIndex, suit}
 *   'chooseSuit'       {playerIndex}          // a human played a wild; pick a suit
 *   'cardsDrawn'       {playerIndex, count, penalty, reason}
 *   'lastCardDeclared' {playerIndex}
 *   'playerFinished'   {playerIndex, rank, name}
 *   'gameOver'         {ranking, loserIndex}
 *   'state'            {phase}                // generic phase change
 *   'resync'           {}                     // repaint from current state
 *
 * Phases: 'idle' | 'playing' | 'awaitHuman' | 'awaitSuit' | 'gameOver'
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  class TreekyPlayer {
    constructor(index, name, isHuman) {
      this.index = index;
      this.name = name;
      this.isHuman = !!isHuman;
      this.hand = [];
      this.finished = false;     // emptied their hand
      this.finishRank = 0;       // 1 = first to finish, etc. (0 while playing)
      this.declaredLast = false; // tapped "Last Card!" this turn
      this.missedDeclare = false;// played to 1 card without declaring -> penalty next turn
      this.servedDeclare = false;// already paid the miss penalty this descent (no double-penalty)
    }
  }

  class TreekyEngine {
    constructor(rules) {
      this.rules = rules || (BQ.cloneTreekyRules ? BQ.cloneTreekyRules() : {});
      this.listeners = {};
      this.players = [];
      this.drawPile = [];
      this.discardPile = [];      // top of pile = last element
      this.activeSuit = null;     // the suit currently in force (may differ from top after a Jack)
      this.currentPlayerIndex = 0;
      this.dealerIndex = 0;
      this.pendingDraw = 0;       // accumulated draw penalty from stacked 3s
      this.phase = 'idle';
      this.finishedOrder = [];    // player indices, in the order they emptied their hands
      this._drewThisTurn = false; // the current player has drawn this turn (may still play/pass)
      this._drawnCardId = null;   // id of the single card drawn under rule 5
      this._drawMode = null;      // 'one' (rule 5: only the drawn card) | 'penalty' (any legal card)
      this._noDrawThisTurn = false; // missed-last-card turn: penalty card given, no further draw
      this._stuckPasses = 0;      // consecutive forced passes with an empty deck (deadlock guard)
      this._reshuffleResume = null; // thunk to run once the owner reshuffles the deck
      this._botTimer = null;
      this._lastGameOver = null;
    }

    /* ---- tiny event bus --------------------------------------------------- */
    on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); return this; }
    emit(evt, payload) { (this.listeners[evt] || []).forEach((fn) => fn(payload)); }

    /* ---- setup ------------------------------------------------------------ */
    // Single-player: human at seat 0, the rest are bots driven by THIS engine.
    init(humanName) {
      const r = this.rules;
      this.players = [];
      this.players.push(new TreekyPlayer(0, humanName || 'You', true));
      const pool = BQ.cloneOf(r.botNames);
      for (let i = 1; i < r.playerCount; i++) {
        const name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] || ('Bot ' + i);
        this.players.push(new TreekyPlayer(i, name, false));
      }
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('idle');
    }

    // Server-side: every seat is "human-controlled" so the engine never auto-plays
    // — the SERVER drives both real players and bots through the public methods.
    initWithPlayers(names) {
      this.players = names.map((n, i) => new TreekyPlayer(i, n, true));
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('idle');
    }

    _setPhase(phase) { this.phase = phase; this.emit('state', { phase }); }

    /* ---- turn order (direction-aware; finished players are skipped) -------- */
    // +1 = to the left (clockwise); -1 = to the right (counter-clockwise, default).
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
      const r = this.rules;
      const deck = BQ.shuffle(BQ.buildTreekyDeck(r.decks));

      // Don't deal more than the deck can supply: leave 1 for the start card plus
      // a small reserve for the draw pile. (Matters with 1 deck + many players.)
      const np = this.players.length;
      const reserve = np + 1;
      const maxHand = Math.max(2, Math.floor((deck.length - reserve) / np));
      const handSize = Math.min(r.handSize, maxHand);

      // RULE 1: deal `handSize` cards to each player.
      this.players.forEach((p) => {
        p.hand = [];
        p.finished = false; p.finishRank = 0;
        p.declaredLast = false; p.missedDeclare = false; p.servedDeclare = false;
        for (let k = 0; k < handSize; k++) { const c = deck.pop(); if (c) p.hand.push(c); }
        BQ.sortHand(p.hand);
      });

      // RULE 3: flip one card to start the pile; if it's a 3 or a Jack, flip again.
      let start = deck.pop();
      while (start && this._isSpecialStart(start)) { deck.unshift(start); start = deck.pop(); }
      this.discardPile = [start];
      this.activeSuit = start.suit;
      this.drawPile = deck;

      this.finishedOrder = [];
      this.pendingDraw = 0;
      this._drewThisTurn = false; this._drawnCardId = null; this._drawMode = null;
      this._noDrawThisTurn = false; this._stuckPasses = 0; this._reshuffleResume = null;

      // RULE 4: the player AFTER the dealer takes the first turn.
      this.currentPlayerIndex = this._next(this.dealerIndex);

      this._setPhase('playing');
      this.emit('gameStart', {
        players: this.players.map((p) => ({ index: p.index, name: p.name, isHuman: p.isHuman })),
        dealerIndex: this.dealerIndex,
        firstPlayerIndex: this.currentPlayerIndex,
        topCard: this._topInfo(),
        activeSuit: this.activeSuit,
        hands: this.players.map((p) => p.hand),
      });
      this._beginTurn();
    }

    _isSpecialStart(card) {
      return card.rank === this.rules.drawRank || card.rank === this.rules.wildRank;
    }
    topCard() { return this.discardPile[this.discardPile.length - 1]; }
    _topInfo() { const c = this.topCard(); return c ? { rank: c.rank, suit: c.suit, id: c.id } : null; }

    /* ---- legal-move computation (RULES 2, 5, 6, 7, 8) --------------------- */
    _isPlayable(card) {
      const r = this.rules;
      if (this.pendingDraw > 0) return card.rank === r.drawRank;   // only 3s while under attack
      if (card.rank === r.wildRank) return true;                   // a Jack is always playable
      const top = this.topCard();
      return card.suit === this.activeSuit || (top && card.rank === top.rank);
    }

    legalCards(idx) {
      const p = this.players[idx];
      if (!p || p.finished) return [];
      // A card is legal if it matches the pile (suit or rank) or is a Jack; under
      // a 3-attack only 3s are legal. The same set applies before AND after a draw
      // (after drawing you may throw any legal card or pass).
      return p.hand.filter((c) => this._isPlayable(c));
    }

    /* ---- turn lifecycle --------------------------------------------------- */
    _beginTurn() {
      const idx = this.currentPlayerIndex;
      const p = this.players[idx];
      if (!p || p.finished) { this.currentPlayerIndex = this._next(idx); return this._beginTurn(); }

      this._drewThisTurn = false; this._drawnCardId = null; this._drawMode = null;
      this._noDrawThisTurn = false;
      p.declaredLast = false;

      // RULE 9 penalty: forgot to call "Last Card!" last time. The player is
      // AUTOMATICALLY given the penalty card(s) now, then may NOT draw again this
      // turn — if they have no legal card to throw, the turn passes to the next
      // player. servedDeclare guards against re-penalizing the same descent.
      if (p.missedDeclare) {
        p.missedDeclare = false;
        p.servedDeclare = true;
        const n = this.rules.lastCardPenalty || 1;
        let drew = 0;
        for (let k = 0; k < n; k++) { const c = this._drawOne(); if (c) { p.hand.push(c); drew++; } }
        BQ.sortHand(p.hand);
        if (drew) this.emit('cardsDrawn', { playerIndex: idx, count: drew, penalty: false, reason: 'missedLastCard' });
        this._noDrawThisTurn = true;
        // No legal card after the penalty card (and not under a 3-attack) -> skip.
        if (this.pendingDraw === 0 && this.legalCards(idx).length === 0) {
          return this._advance();
        }
      }

      this._setPhase(p.isHuman ? 'awaitHuman' : 'playing');
      this._emitTurn(idx);

      if (p.isHuman) return;          // a human/server seat acts via public methods
      this._scheduleBot(idx);         // single-player bot
    }

    _emitTurn(idx) {
      const legal = this.legalCards(idx);
      this.emit('turn', {
        playerIndex: idx,
        legalCardIds: legal.map((c) => c.id),
        pendingDraw: this.pendingDraw,
        activeSuit: this.activeSuit,
        topCard: this._topInfo(),
        // You may always draw (even with a card to throw) — except after you've
        // already drawn this turn, or on a missed-last-card penalty turn.
        canDraw: !this._drewThisTurn && !this._noDrawThisTurn,
        // Pass appears ONLY after a draw, and only if you now have a card to throw.
        canPass: this._drewThisTurn && legal.length > 0,
      });
    }

    _scheduleBot(idx) {
      clearTimeout(this._botTimer);
      this._botTimer = setTimeout(() => this._botStep(idx), Math.max(120, this.rules.botThinkMs));
    }

    _botStep(idx) {
      if (this.phase !== 'playing' || this.currentPlayerIndex !== idx) return;
      const p = this.players[idx];
      if (!p || p.finished || p.isHuman) return;
      const move = BQ.TreekyAI.chooseMove(this, idx);
      if (!move || move.type === 'draw') {
        const res = this._doDraw(idx);
        if (res.continues) { this._scheduleBot(idx); }   // drew a playable card — decide again
        return;
      }
      if (move.type === 'pass') { this._doPass(idx); return; }
      // play
      if (p.hand.length === 2) p.declaredLast = true;    // bots never miss the call
      const card = p.hand.find((c) => c.id === move.cardId);
      if (!card) { const res = this._doDraw(idx); if (res.continues) this._scheduleBot(idx); return; }
      this._doPlay(idx, card, move.suit);
    }

    /* ---- public actions (used by the human UI and by the server) ---------- */
    playHuman(cardId, chosenSuit) {
      if (this.phase !== 'awaitHuman') return false;
      const idx = this.currentPlayerIndex;
      const card = this.legalCards(idx).find((c) => c.id === cardId);
      if (!card) return false;
      this._doPlay(idx, card, chosenSuit);
      return true;
    }

    // Draw because you have no legal card, OR take the accumulated 3-penalty.
    drawForTurn(idx) {
      if (this.phase !== 'awaitHuman' || idx !== this.currentPlayerIndex) return false;
      if (this._drewThisTurn && this.pendingDraw === 0) return false; // already drew this turn
      if (this._noDrawThisTurn && this.pendingDraw === 0) return false; // missed-last-card turn: no extra draw
      this._doDraw(idx);
      return true;
    }

    // Pass the play to the next player. Allowed ONLY after you've drawn this turn
    // (a normal draw or a 3-penalty pickup) AND you still have a card you could
    // throw. There is no pass before drawing — you throw or draw.
    pass(idx) {
      if (this.phase !== 'awaitHuman' || idx !== this.currentPlayerIndex) return false;
      if (!this._drewThisTurn || this.pendingDraw > 0) return false;
      if (this.legalCards(idx).length === 0) return false;
      this._doPass(idx);
      return true;
    }

    // Call "Last Card!" — valid as you're about to play your second-to-last card.
    declareLast(idx) {
      const p = this.players[idx];
      if (!p || p.hand.length !== 2) return false;
      p.declaredLast = true;
      this.emit('lastCardDeclared', { playerIndex: idx });
      return true;
    }

    // Resume a wild after the engine paused at 'awaitSuit' (programmatic path).
    chooseSuit(idx, suit) {
      if (this.phase !== 'awaitSuit' || idx !== this.currentPlayerIndex) return false;
      this.activeSuit = suit;
      this.emit('suitChosen', { playerIndex: idx, suit });
      this._advance();
      return true;
    }

    /* ---- internal mechanics ----------------------------------------------- */
    // No auto-reshuffle: when the deck runs dry the TABLE OWNER reshuffles via
    // reshuffle() (prompted by a popup). _drawOne just returns null when empty.
    _drawOne() { return this.drawPile.pop() || null; }

    // Keep the LAST card thrown on the ground; shuffle every other discarded
    // card back into the draw pile. Triggered by the owner.
    _reshuffleNow() {
      if (this.discardPile.length <= 1) return;
      const top = this.discardPile.pop();
      const rest = this.discardPile;
      this.discardPile = [top];
      // merge the spent pile INTO any cards still in the deck (don't discard them)
      this.drawPile = BQ.shuffle(this.drawPile.concat(rest));
    }

    // The owner reshuffles the spent pile back into the deck, then play resumes
    // exactly where it paused (the player who needed cards finishes their draw).
    reshuffle() {
      if (this.phase !== 'awaitReshuffle') return false;
      this._reshuffleNow();
      this.emit('reshuffled', { drawCount: this.drawPile.length });
      const resume = this._reshuffleResume; this._reshuffleResume = null;
      const cur = this.players[this.currentPlayerIndex];
      this._setPhase(cur && cur.isHuman ? 'awaitHuman' : 'playing');
      if (resume) resume();
      return true;
    }

    // Re-run the paused draw once the deck has been refilled.
    _resumeDraw(idx) {
      const res = this._doDraw(idx);
      if (res && res.continues) {
        const cur = this.players[this.currentPlayerIndex];
        if (cur && !cur.isHuman) this._scheduleBot(this.currentPlayerIndex);
      }
    }

    _doDraw(idx) {
      const p = this.players[idx];
      p.servedDeclare = false;   // drawing moves you away from finishing — fresh declare obligation

      // Deck finished (can't cover this draw)? Pause and ask the table owner to
      // reshuffle the spent pile back in. Play resumes here afterwards.
      const need = this.pendingDraw > 0 ? this.pendingDraw : 1;
      if (this.drawPile.length < need && this.discardPile.length > 1) {
        this._setPhase('awaitReshuffle');
        this._reshuffleResume = () => this._resumeDraw(idx);
        this.emit('needReshuffle', { playerIndex: idx });
        return { continues: false };
      }

      // RULE 8: under attack from stacked 3s — take the whole pile.
      if (this.pendingDraw > 0) {
        const count = this.pendingDraw;
        for (let k = 0; k < count; k++) { const c = this._drawOne(); if (c) p.hand.push(c); }
        BQ.sortHand(p.hand);
        this.pendingDraw = 0;
        this.emit('cardsDrawn', { playerIndex: idx, count, penalty: true, reason: 'three' });
        return this._afterDraw(idx);
      }

      // A normal draw of one card (you may draw even if you had a playable card).
      const c = this._drawOne();
      p.declaredLast = false;
      if (c) {
        p.hand.push(c); BQ.sortHand(p.hand);
        this._stuckPasses = 0;
        this.emit('cardsDrawn', { playerIndex: idx, count: 1, penalty: false, reason: 'draw' });
        return this._afterDraw(idx);
      }

      // Deck is empty and can't be reshuffled (only the top discard remains). This
      // is a forced pass. If EVERY active player passes in a row, nobody can ever
      // progress — end the game and rank the rest by fewest cards left.
      this._stuckPasses += 1;
      if (this._stuckPasses >= this.activeCount()) { this._endGame(); return { continues: false }; }
      this._advance();
      return { continues: false };
    }

    // After drawing (a normal card OR a 3-penalty), the player may throw ANY legal
    // card or pass. If they have nothing to throw, the turn passes to the next player.
    _afterDraw(idx) {
      this._drewThisTurn = true;
      if (this.legalCards(idx).length > 0) { this._emitTurn(idx); return { continues: true }; }
      this._drewThisTurn = false;
      this._advance();
      return { continues: false };
    }

    _doPass(idx) {
      this._drewThisTurn = false; this._drawnCardId = null; this._drawMode = null;
      this._advance();
    }

    _doPlay(idx, card, chosenSuit) {
      const r = this.rules;
      const p = this.players[idx];

      // remove from hand, place on the pile
      const pos = p.hand.findIndex((c) => c.id === card.id);
      if (pos >= 0) p.hand.splice(pos, 1);
      this.discardPile.push(card);
      this._drewThisTurn = false; this._drawnCardId = null; this._drawMode = null;
      this._stuckPasses = 0;   // a card was played — the table is moving again

      const isThree = card.rank === r.drawRank;
      const isJack = card.rank === r.wildRank;

      if (isThree) { this.pendingDraw += r.drawPenalty; this.activeSuit = card.suit; }
      else if (!isJack) { this.activeSuit = card.suit; }   // RULE 6: same-number play can change suit
      // (a Jack's active suit is set below, once chosen)

      // RULE 9: leaving yourself exactly one card requires the "Last Card!" call.
      if (p.hand.length === 1 && !p.declaredLast && !p.servedDeclare) p.missedDeclare = true;
      if (p.hand.length !== 1) p.declaredLast = false;

      this.emit('cardPlayed', {
        playerIndex: idx,
        card: { rank: card.rank, suit: card.suit, id: card.id },
        topCard: this._topInfo(),
        activeSuit: this.activeSuit,
        isThree, isJack,
        handCount: p.hand.length,
      });

      // RULE 10: emptied hand — rank the player and let the game continue.
      if (p.hand.length === 0) {
        p.finished = true;
        this.finishedOrder.push(idx);
        p.finishRank = this.finishedOrder.length;
        this.emit('playerFinished', { playerIndex: idx, rank: p.finishRank, name: p.name });
        if (this.activeCount() <= 1) {
          // resolve a finishing Jack's suit is moot — only one player remains.
          return this._endGame();
        }
      }

      // RULE 7: a Jack lets the player choose the next suit.
      if (isJack) {
        if (chosenSuit) {
          this.activeSuit = chosenSuit;
          this.emit('suitChosen', { playerIndex: idx, suit: chosenSuit });
          return this._advance();
        }
        // human played a wild without a suit — pause and ask.
        this._setPhase('awaitSuit');
        this.emit('chooseSuit', { playerIndex: idx });
        return;
      }
      this._advance();
    }

    _advance() {
      if (this.phase === 'gameOver') return;
      this.currentPlayerIndex = this._next(this.currentPlayerIndex);
      this._beginTurn();
    }

    _endGame() {
      clearTimeout(this._botTimer);
      // Append any players still holding cards (normally one; more if the deck
      // deadlocked) ranked by fewest cards left, ties by seat. The last one is
      // the loser.
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

    /* ---- single-player persistence (survives a refresh) ------------------- */
    snapshot() {
      const card = (c) => (c ? { rank: c.rank, suit: c.suit, id: c.id } : null);
      return {
        v: 1, game: 'treeky', rules: this.rules,
        phase: this.phase, dealerIndex: this.dealerIndex,
        currentPlayerIndex: this.currentPlayerIndex, activeSuit: this.activeSuit,
        pendingDraw: this.pendingDraw, finishedOrder: this.finishedOrder.slice(),
        drawPile: this.drawPile.map(card), discardPile: this.discardPile.map(card),
        lastGameOver: this._lastGameOver || null,
        players: this.players.map((p) => ({
          index: p.index, name: p.name, isHuman: p.isHuman,
          hand: p.hand.map(card), finished: p.finished, finishRank: p.finishRank,
          missedDeclare: p.missedDeclare, servedDeclare: p.servedDeclare,
        })),
      };
    }
    static fromSnapshot(data) {
      const e = new TreekyEngine(data.rules);
      e.phase = data.phase; e.dealerIndex = data.dealerIndex;
      e.currentPlayerIndex = data.currentPlayerIndex; e.activeSuit = data.activeSuit;
      e.pendingDraw = data.pendingDraw || 0; e.finishedOrder = data.finishedOrder || [];
      e._lastGameOver = data.lastGameOver || null;
      e.drawPile = (data.drawPile || []).map((c) => BQ.cardFrom(c));
      e.discardPile = (data.discardPile || []).map((c) => BQ.cardFrom(c));
      e.players = (data.players || []).map((pd) => {
        const p = new TreekyPlayer(pd.index, pd.name, pd.isHuman);
        p.hand = (pd.hand || []).map((c) => BQ.cardFrom(c));
        p.finished = !!pd.finished; p.finishRank = pd.finishRank || 0;
        p.missedDeclare = !!pd.missedDeclare; p.servedDeclare = !!pd.servedDeclare;
        return p;
      });
      return e;
    }
    resume() {
      this.emit('resync', {});
      if (this.phase === 'awaitHuman') this._emitTurn(this.currentPlayerIndex);
      else if (this.phase === 'playing') this._beginTurn();
      else if (this.phase === 'gameOver' && this._lastGameOver) this.emit('gameOver', this._lastGameOver);
    }
  }

  BQ.TreekyEngine = TreekyEngine;
  BQ.TreekyPlayer = TreekyPlayer;
})(typeof window !== "undefined" ? window : globalThis);
