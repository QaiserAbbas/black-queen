/* =============================================================================
 * Black Queen — GAME ENGINE
 * -----------------------------------------------------------------------------
 * A headless, event-driven trick-taking engine. It holds ALL game state and
 * enforces ALL rules (reading every value from BQ rules config). It knows
 * nothing about the DOM — it just emits events that the UI subscribes to.
 *
 * Emitted events (engine.on('eventName', handler)):
 *   'roundStart'   {round, dealerIndex, leaderIndex, hands}
 *   'turn'         {playerIndex, legalCardIds}        // whose move + legal plays
 *   'cardPlayed'   {playerIndex, card, trick}
 *   'trickWon'     {winnerIndex, trick, points}
 *   'roundEnd'     {roundScores, totals, breakdown}
 *   'gameOver'     {totals, winnerIndex, ranking}
 *   'heartsBroken' {}
 *   'state'        {phase}                            // generic phase change
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  class Player {
    constructor(index, name, isHuman) {
      this.index = index;
      this.name = name;
      this.isHuman = !!isHuman;
      this.hand = [];
      this.totalScore = 0;
      this.roundHistory = [];      // score earned each round
      this.tricksWon = 0;          // tricks taken THIS round
      this.consecutiveZeros = 0;   // for RULE 5
      this.queenTakes = 0;         // running count of times stuck with the Black Queen
    }
  }

  class GameEngine {
    constructor(rules) {
      this.rules = rules || BQ.cloneRules();
      this.listeners = {};
      this.players = [];
      this.round = 0;
      this.phase = 'idle';
      this.dealerIndex = 0;
      this.currentTrick = [];       // [{playerIndex, card}]
      this.trickLog = [];           // completed hands in the current round
      this.trickLeaderIndex = 0;
      this.currentPlayerIndex = 0;
      this.heartsBroken = false;
      this.leadSuit = null;
      this._resolveHumanPlay = null; // promise hook for human input
      this._lastRoundEnd = null;     // last round-summary payload (for refresh-resume)
      this._lastGameOver = null;     // last game-over payload (for refresh-resume)
      this.reshuffleRemaining = 0;   // trailing-player re-deals left THIS round
      this.reshuffleSeat = -1;       // seat currently offered a re-deal (-1 = none)
      this.reshuffleGate = null;     // optional veto(seat)->bool (server: skip bots)
    }

    /* ---- tiny event bus --------------------------------------------------- */
    on(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
      return this;
    }
    emit(evt, payload) {
      (this.listeners[evt] || []).forEach((fn) => fn(payload));
    }

    /* ---- setup ------------------------------------------------------------ */
    init(humanName) {
      const rules = this.rules;
      this.players = [];
      this.players.push(new Player(0, humanName || 'You', true));

      const pool = BQ.cloneOf(rules.botNames);
      for (let i = 1; i < rules.playerCount; i++) {
        const name = pool.splice(Math.floor(Math.random() * pool.length), 1)[0] || ('Bot ' + i);
        this.players.push(new Player(i, name, false));
      }
      this.round = 0;
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('ready');
    }

    // Server-side setup: explicit seat names. Every seat is "human-controlled"
    // so the engine never auto-plays — the SERVER drives both real players (waits
    // for their move) and bot/disconnected seats (plays for them). This keeps one
    // uniform control path for networked play.
    initWithPlayers(names) {
      this.players = names.map((n, i) => new Player(i, n, true));
      this.round = 0;
      this.dealerIndex = Math.floor(Math.random() * this.players.length);
      this._setPhase('ready');
    }

    _setPhase(phase) {
      this.phase = phase;
      this.emit('state', { phase });
    }

    /* ---- play direction (RULE 7) ----------------------------------------- */
    // +1 = to the left (clockwise); -1 = to the right (counter-clockwise).
    _step() { return this.rules.playDirection === 'left' ? 1 : -1; }
    // the next seat in the direction of play
    _next(i) {
      const n = this.players.length;
      return (((i + this._step()) % n) + n) % n;
    }

    /* ---- dealer selection (RULE 7) --------------------------------------- */
    _chooseDealer() {
      if (this.round === 1) return this.dealerIndex; // keep initial random dealer

      if (this.rules.dealerIsHighestScore) {
        // Highest total score deals; ties broken by lowest index.
        let best = 0;
        for (let i = 1; i < this.players.length; i++) {
          if (this.players[i].totalScore > this.players[best].totalScore) best = i;
        }
        return best;
      }
      // Fallback: dealer passes in the direction of play.
      return this._next(this.dealerIndex);
    }

    /* ---- round lifecycle -------------------------------------------------- */
    startRound() {
      this.round += 1;
      this.dealerIndex = this._chooseDealer();
      // RULE 7: the player NEXT in the play direction (the dealer's right, by
      // default) takes the first turn.
      this.trickLeaderIndex = this._next(this.dealerIndex);
      this.currentPlayerIndex = this.trickLeaderIndex;
      this.heartsBroken = false;
      this.currentTrick = [];
      this.leadSuit = null;
      this.trickLog = [];   // hand-by-hand record for THIS round (the scorecard)
      this._lastRoundEnd = null;  // a new round started — the old summary is stale

      // Build + shuffle + deal.
      this._dealHands();

      // The trailing player (most points) may force a re-deal before play —
      // up to reshuffleMax times. Decide eligibility BEFORE emitting roundStart
      // so the snapshot already carries the correct phase.
      this.reshuffleRemaining = this.rules.reshuffleEnabled ? (this.rules.reshuffleMax || 2) : 0;
      const seat = this._reshuffleEligibleSeat();
      this.reshuffleSeat = seat;
      this._setPhase(seat >= 0 ? 'awaitReshuffle' : 'playing');

      this.emit('roundStart', {
        round: this.round,
        dealerIndex: this.dealerIndex,
        leaderIndex: this.trickLeaderIndex,
        hands: this.players.map((p) => p.hand),
      });

      if (seat >= 0) this.emit('reshuffleOffer', { playerIndex: seat, remaining: this.reshuffleRemaining });
      else this._beginTurn();
    }

    // Shuffle a fresh 52-card deck and deal it to every seat (resets trick count).
    _dealHands() {
      const deck = BQ.shuffle(BQ.buildDeck());
      const hands = BQ.deal(deck, this.players.length);
      this.players.forEach((p, i) => {
        p.hand = hands[i];
        p.tricksWon = 0;
      });
    }

    // Which seat may force a re-deal right now? The player with the MOST points
    // (worst standing — LOW wins); ties broken by lowest seat index. Returns -1
    // when reshuffles are off/used up, on round 1, when everyone is tied (no sole
    // trailer), or when the server vetoes the seat (a bot / disconnected player).
    _reshuffleEligibleSeat() {
      const r = this.rules;
      if (!r.reshuffleEnabled || this.reshuffleRemaining <= 0) return -1;
      if (this.round < 2) return -1;                 // round 1: everyone at 0
      let top = 0;
      for (let i = 1; i < this.players.length; i++) {
        if (this.players[i].totalScore > this.players[top].totalScore) top = i;
      }
      const topScore = this.players[top].totalScore;
      if (this.players.every((p) => p.totalScore === topScore)) return -1; // all tied
      if (this.reshuffleGate && !this.reshuffleGate(top)) return -1;
      return top;
    }

    // The trailing player requests another deal. Re-deals the SAME round (round
    // number, dealer and leader unchanged), spends one reshuffle, then re-offers
    // (or begins play once none remain).
    reshuffleDeal() {
      if (this.phase !== 'awaitReshuffle' || this.reshuffleRemaining <= 0) return false;
      this.reshuffleRemaining -= 1;
      this._dealHands();
      this.heartsBroken = false;
      this.currentTrick = [];
      this.leadSuit = null;
      this.trickLog = [];

      const seat = this._reshuffleEligibleSeat();    // scores unchanged -> same seat, or -1 once spent
      this.reshuffleSeat = seat;
      this._setPhase(seat >= 0 ? 'awaitReshuffle' : 'playing');

      this.emit('roundStart', {
        round: this.round,
        dealerIndex: this.dealerIndex,
        leaderIndex: this.trickLeaderIndex,
        hands: this.players.map((p) => p.hand),
        reshuffled: true,
      });

      if (seat >= 0) this.emit('reshuffleOffer', { playerIndex: seat, remaining: this.reshuffleRemaining });
      else this._beginTurn();
      return true;
    }

    // The trailing player accepts the deal (or declines to reshuffle) — start play.
    beginPlay() {
      if (this.phase !== 'awaitReshuffle') return false;
      this.reshuffleSeat = -1;
      this._setPhase('playing');
      this._beginTurn();
      return true;
    }

    /* ---- legal-move computation ------------------------------------------ */
    legalCards(playerIndex) {
      const p = this.players[playerIndex];
      const hand = p.hand;
      const isLeading = this.currentTrick.length === 0;

      if (isLeading) {
        // Leading: hearts can't be led until broken (unless only hearts remain).
        if (this.rules.heartsMustBeBroken && !this.heartsBroken) {
          const nonHearts = hand.filter((c) => c.suit !== 'hearts');
          if (nonHearts.length > 0) return nonHearts;
        }
        return hand.slice();
      }

      // Following: must follow the lead suit if able.
      const follow = hand.filter((c) => c.suit === this.leadSuit);
      if (follow.length > 0) {
        // MUST-THROW QUEEN (following): if the led suit IS the Queen's suit and
        // a HIGHER card of that suit is ALREADY on the table, the Queen can no
        // longer win this trick — there's a guaranteed "way to throw" it onto
        // the higher card's holder. So you're forced to play it now instead of
        // hiding it behind a lower spade. Same exemption escape hatch as the
        // void case below: if its points are GUARANTEED wasted (every possible
        // winner is score-exempt), throwing becomes optional.
        if (this.rules.mustThrowQueen) {
          const q = this.rules.queenCard;
          const queen = follow.find((c) => c.rank === q.rank && c.suit === q.suit);
          if (queen && this._higherCardOnTable(queen) &&
              !this._queenGuaranteedWasted(playerIndex)) {
            return [queen];
          }
        }
        return follow;
      }

      // Void in the lead suit -> discarding. RULE: if you hold the Black Queen
      // you MUST throw it now — UNLESS its points are GUARANTEED wasted (every
      // possible winner of this trick is score-exempt). If even one non-exempt
      // player could still take it, you're forced; if it's certain to be wasted,
      // throwing it is your choice.
      if (this.rules.mustThrowQueen) {
        const q = this.rules.queenCard;
        const queen = hand.find((c) => c.rank === q.rank && c.suit === q.suit);
        if (queen && !this._queenGuaranteedWasted(playerIndex)) return [queen];
      }
      return hand.slice(); // otherwise, any card goes
    }

    // Is a card of the SAME suit and a HIGHER value already on the table in the
    // current trick? Used to detect that the Black Queen can be safely dumped
    // onto a higher spade — it can no longer win the trick itself.
    _higherCardOnTable(card) {
      return this.currentTrick.some(
        (t) => t.card.suit === card.suit && t.card.value > card.value
      );
    }

    // Would the Black Queen's 12 points definitely be wasted if discarded into
    // the CURRENT trick right now? True only when every player who could still
    // win this trick is score-exempt (so no non-exempt player can take it).
    _queenGuaranteedWasted(holderIndex) {
      const r = this.rules;
      if (!r.queenExemptEnabled) return false;          // nobody is exempt
      const isExempt = (i) => this.players[i].totalScore >= r.queenExemptScore;

      // current leader = highest card of the lead suit played so far
      let winnerIdx = -1, best = -1;
      for (const t of this.currentTrick) {
        if (t.card.suit === this.leadSuit && t.card.value > best) {
          best = t.card.value; winnerIdx = t.playerIndex;
        }
      }
      if (winnerIdx < 0) return false;                  // be safe: treat as not wasted

      // players who have not played yet (excluding the holder, who is discarding
      // and is void so cannot win). Their hands are unknown, so any non-exempt
      // one COULD win -> not guaranteed wasted.
      const played = new Set(this.currentTrick.map((t) => t.playerIndex));
      played.add(holderIndex);
      for (let i = 0; i < this.players.length; i++) {
        if (!played.has(i) && !isExempt(i)) return false;
      }
      return isExempt(winnerIdx);
    }

    _beginTurn() {
      const idx = this.currentPlayerIndex;
      const player = this.players[idx];

      // Set the phase BEFORE emitting 'turn' so listeners (and the UI's
      // playable-card highlighting) see the correct phase synchronously.
      this._setPhase(player.isHuman ? 'awaitHuman' : 'playing');

      const legal = this.legalCards(idx).map((c) => c.id);
      this.emit('turn', { playerIndex: idx, legalCardIds: legal });

      if (player.isHuman) {
        // UI will call engine.playHuman(cardId).
        return;
      }
      const delay = Math.max(0, this.rules.botThinkMs);
      setTimeout(() => {
        const card = BQ.AI.chooseCard(this, idx);
        this._commitPlay(idx, card);
      }, delay);
    }

    // Called by the UI when the human selects a card.
    playHuman(cardId) {
      if (this.phase !== 'awaitHuman') return false;
      const idx = this.currentPlayerIndex;
      const legal = this.legalCards(idx);
      const card = legal.find((c) => c.id === cardId);
      if (!card) return false; // illegal — ignore
      this._commitPlay(idx, card);
      return true;
    }

    _commitPlay(playerIndex, card) {
      const player = this.players[playerIndex];
      // remove from hand
      const pos = player.hand.findIndex((c) => c.id === card.id);
      if (pos >= 0) player.hand.splice(pos, 1);

      if (this.currentTrick.length === 0) this.leadSuit = card.suit;
      this.currentTrick.push({ playerIndex, card });

      // breaking hearts
      if (!this.heartsBroken) {
        const q = this.rules.queenCard;
        if (card.suit === 'hearts' ||
            (this.rules.queenBreaksHearts && card.rank === q.rank && card.suit === q.suit)) {
          this.heartsBroken = true;
          this.emit('heartsBroken', {});
        }
      }

      this.emit('cardPlayed', {
        playerIndex,
        card,
        trick: this.currentTrick.slice(),
      });

      if (this.currentTrick.length === this.players.length) {
        this._resolveTrick();
      } else {
        this.currentPlayerIndex = this._next(this.currentPlayerIndex);
        this._beginTurn();
      }
    }

    _resolveTrick() {
      // Winner = highest card of the lead suit.
      let winning = this.currentTrick[0];
      for (const play of this.currentTrick) {
        if (play.card.suit === this.leadSuit && play.card.value > winning.card.value) {
          winning = play;
        }
      }
      const winnerIndex = winning.playerIndex;
      const pen = this._trickPenalty(this.currentTrick, winnerIndex);
      const points = pen.pts;
      this.players[winnerIndex].tricksWon += 1;
      // stash the penalty cards onto the winner for round scoring
      this.players[winnerIndex]._penalty = (this.players[winnerIndex]._penalty || 0) + points;

      const finishedTrick = this.currentTrick.slice();
      this.currentTrick = [];
      this.leadSuit = null;

      // Did this hand contain the Black Queen? (the winner gets "stuck" with it,
      // unless they were immune by score — then the points were disregarded.)
      const q = this.rules.queenCard;
      const tookQueen = finishedTrick.some((p) => p.card.rank === q.rank && p.card.suit === q.suit);
      const queenDisregarded = pen.queenDisregarded;
      const hearts = finishedTrick.filter((p) => p.card.suit === 'hearts').length;

      // Per-player points conceded in THIS hand (only the winner takes points).
      const concede = this.players.map((_, i) => (i === winnerIndex ? points : 0));

      // Record this hand in the round's scorecard.
      const handNo = this.trickLog.length + 1;
      this.trickLog.push({
        handNo,
        winnerIndex,
        winnerName: this.players[winnerIndex].name,
        points,
        concede,                 // [pts conceded by player0, player1, ...]
        tookQueen,               // was the Black Queen captured this hand?
        queenDisregarded,        // captured but disregarded (winner immune by score)
        queenTaker: tookQueen ? winnerIndex : -1,
        hearts,
        cards: finishedTrick.map((p) => ({
          playerIndex: p.playerIndex,
          name: this.players[p.playerIndex].name,
          label: p.card.label,
          id: p.card.id,
        })),
      });

      // Only count it as "stuck with the Queen" if the points actually applied.
      if (tookQueen && !queenDisregarded) this.players[winnerIndex].queenTakes += 1;
      this.players[winnerIndex]._hearts = (this.players[winnerIndex]._hearts || 0) + hearts;

      this.emit('trickWon', { winnerIndex, trick: finishedTrick, points, handNo, tookQueen, queenDisregarded });

      // Round over when hands are empty.
      if (this.players[0].hand.length === 0) {
        this._endRound();
        return;
      }
      // GAME-END RULE: the moment any player's running total (banked score +
      // points taken so far this round) reaches the target, stop right here —
      // the round is cut short and scored as it stands.
      if (this._targetReachedMidRound()) {
        this._endRound(true);
        return;
      }
      this.currentPlayerIndex = winnerIndex;
      this.trickLeaderIndex = winnerIndex;
      this._beginTurn();
    }

    // Has anyone's live total crossed the target mid-round?
    _targetReachedMidRound() {
      const r = this.rules;
      const live = this.players.map((p) => p.totalScore + (p._penalty || 0));
      if (!live.some((s) => s >= r.endScore)) return false;
      // Don't cut a possible moon-shot short: if the crossing player holds
      // EVERY penalty point taken so far, they may still shoot the moon and
      // finish the round on the award instead. Play on — this is re-checked
      // after every trick, and the moment another player takes a point the
      // moon is dead and the game ends.
      if (r.shootTheMoonEnabled) {
        const raw = this.players.map((p) => p._penalty || 0);
        const total = raw.reduce((a, b) => a + b, 0);
        const crosser = live.findIndex((s) => s >= r.endScore);
        if (raw[crosser] === total) return false;
      }
      return true;
    }

    // Penalty for a trick, charged to its winner. RULE: a winner whose total
    // score is >= queenExemptScore has the Queen's points disregarded (they
    // still take the hearts). Returns { pts, queenDisregarded }.
    _trickPenalty(trick, winnerIndex) {
      const r = this.rules;
      const winner = this.players[winnerIndex];
      const exempt = r.queenExemptEnabled && winner && winner.totalScore >= r.queenExemptScore;
      let pts = 0;
      let queenDisregarded = false;
      for (const { card } of trick) {
        if (card.suit === 'hearts') pts += r.heartPoints;
        if (card.rank === r.queenCard.rank && card.suit === r.queenCard.suit) {
          if (exempt) queenDisregarded = true;     // immune: 12 points disregarded
          else pts += r.queenPoints;
        }
      }
      return { pts, queenDisregarded };
    }

    /* ---- round scoring (RULES 4, 5, shoot-the-moon) ----------------------- */
    // cutShort: the round was stopped mid-play because a player crossed the
    // target score. Penalties that judge a COMPLETED round (no-trick, the
    // consecutive-zero streak) don't apply to a partial one.
    _endRound(cutShort) {
      const r = this.rules;
      const breakdown = [];
      const roundScores = [];

      // raw penalties captured this round
      const raw = this.players.map((p) => p._penalty || 0);

      // who got stuck with the Black Queen this round (-1 if nobody, e.g. mid-deal)
      const queenHand = (this.trickLog || []).find((h) => h.tookQueen);
      const queenTakerThisRound = queenHand ? queenHand.winnerIndex : -1;
      const queenWasDisregarded = queenHand ? !!queenHand.queenDisregarded : false;

      // Shoot the moon: one player captured every penalty point.
      let mooner = -1;
      if (r.shootTheMoonEnabled) {
        const total = raw.reduce((a, b) => a + b, 0);
        mooner = raw.findIndex((v) => v === total && total === r.expectedRoundTotal);
      }

      this.players.forEach((p, i) => {
        let score = raw[i];
        const notes = [];
        const tookQueen = (i === queenTakerThisRound);

        if (tookQueen) {
          notes.push(queenWasDisregarded
            ? 'Took ♛ — disregarded, score ≥ ' + r.queenExemptScore + ' (+0)'
            : 'Stuck with the Black Queen ♛ (+' + r.queenPoints + ')');
        }

        if (mooner === i) {
          score = r.shootTheMoonAward;
          notes.push('Shot the moon!');
        }

        if (cutShort && p.totalScore + score >= r.endScore) {
          notes.push('Reached ' + r.endScore + ' — game ends');
        }

        // RULES 4 & 5 combined (NEW): a player can receive at most ONE -12
        // "zero penalty" per round, and receiving any -12 resets their
        // consecutive-zero streak.
        let zeroPenaltyApplied = false;

        // RULE 4: won no trick at all this round.
        if (!cutShort && r.noTrickRuleEnabled && p.tricksWon === 0) {
          score += r.noTrickPenalty;
          notes.push('No tricks taken (' + r.noTrickPenalty + ')');
          zeroPenaltyApplied = true;
        }

        // RULE 5: consecutive zero-point rounds.
        if (!cutShort && r.consecutiveZeroRuleEnabled) {
          if (raw[i] === 0) {
            if (zeroPenaltyApplied) {
              // already penalised this round (no-trick) — don't stack a 2nd -12,
              // and reset the streak.
              p.consecutiveZeros = 0;
            } else {
              p.consecutiveZeros += 1;
              if (p.consecutiveZeros >= r.consecutiveZeroLimit) {
                score += r.consecutiveZeroPenalty;
                notes.push(r.consecutiveZeroLimit + ' zero rounds in a row (' + r.consecutiveZeroPenalty + ')');
                p.consecutiveZeros = 0; // reset the streak after applying
              }
            }
          } else {
            p.consecutiveZeros = 0;
          }
        }

        p.totalScore += score;
        p.roundHistory.push(score);
        roundScores.push(score);
        breakdown.push({ playerIndex: i, raw: raw[i], score, notes, tookQueen, queenDisregarded: tookQueen && queenWasDisregarded, hearts: p._hearts || 0 });
        p._penalty = 0;
        p._hearts = 0;
      });

      // Every trick taken this round, for the end-of-round reveal: each entry is
      // a group of 4 cards (one per player) tagged with who WON it, so the UI can
      // group the tricks under each player. Built from the trick log (so it's
      // identical on the server for networked play). Safe to reveal: round-end
      // only fires after a fully-played round or a game-ending round.
      const tricks = (this.trickLog || []).map((h) => ({
        winnerIndex: h.winnerIndex,
        points: h.points,
        tookQueen: !!h.tookQueen,
        hearts: h.hearts || 0,
        cards: (h.cards || []).map((c) => {
          const u = c.id.indexOf('_');
          return { playerIndex: c.playerIndex, rank: c.id.slice(0, u), suit: c.id.slice(u + 1) };
        }),
      }));

      this._lastRoundEnd = {
        round: this.round,
        roundScores,
        totals: this.players.map((p) => p.totalScore),
        breakdown,
        tricks,
        cutShort: !!cutShort,
        // Whether this round ends the game. Scores are already applied above, so
        // _isGameOver() is accurate here. Carried in the payload because the
        // engine emits 'roundEnd' BEFORE phase flips to 'gameOver' — listeners
        // can't read the phase yet, so they must read this flag.
        gameOver: this._isGameOver(),
      };
      this._setPhase('roundEnd');
      this.emit('roundEnd', this._lastRoundEnd);

      if (this._isGameOver()) {
        this._endGame();
      }
    }

    _isGameOver() {
      const r = this.rules;
      // ABSOLUTE RULE: the moment ANY player reaches the target score (100 by
      // default), the game ends after the current hand — regardless of end mode.
      if (this.players.some((p) => p.totalScore >= r.endScore)) return true;
      // Otherwise, in fixed-rounds mode, stop once the round limit is reached.
      if (r.endMode === 'fixedRounds') return this.round >= r.roundLimit;
      return false;
    }

    _endGame() {
      const ranking = this.players
        .map((p) => ({ index: p.index, name: p.name, score: p.totalScore }))
        .sort((a, b) =>
          this.rules.lowestScoreWins ? a.score - b.score : b.score - a.score
        );
      this._lastGameOver = {
        totals: this.players.map((p) => p.totalScore),
        ranking,
        winnerIndex: ranking[0].index,
      };
      this._setPhase('gameOver');
      this.emit('gameOver', this._lastGameOver);
    }

    /* ---- helpers for UI --------------------------------------------------- */
    get human() { return this.players[0]; }
    snapshotScores() {
      return this.players.map((p) => ({
        index: p.index, name: p.name, total: p.totalScore,
        history: p.roundHistory.slice(),
      }));
    }

    /* ---- single-player persistence (survives a page refresh) -------------
     * snapshot() → a JSON-safe blob of the FULL game state.
     * GameEngine.fromSnapshot() rebuilds an engine from that blob.
     * resume() repaints the table and continues play from where we left off.
     */
    snapshot() {
      const card = (c) => (c ? { rank: c.rank, suit: c.suit } : null);
      return {
        v: 1,
        rules: this.rules,
        round: this.round,
        phase: this.phase,
        dealerIndex: this.dealerIndex,
        trickLeaderIndex: this.trickLeaderIndex,
        currentPlayerIndex: this.currentPlayerIndex,
        heartsBroken: this.heartsBroken,
        leadSuit: this.leadSuit,
        currentTrick: this.currentTrick.map((t) => ({ playerIndex: t.playerIndex, card: card(t.card) })),
        trickLog: this.trickLog,
        lastRoundEnd: this._lastRoundEnd || null,
        lastGameOver: this._lastGameOver || null,
        players: this.players.map((p) => ({
          index: p.index, name: p.name, isHuman: p.isHuman,
          hand: p.hand.map(card),
          totalScore: p.totalScore,
          roundHistory: p.roundHistory.slice(),
          tricksWon: p.tricksWon,
          consecutiveZeros: p.consecutiveZeros,
          queenTakes: p.queenTakes,
          _penalty: p._penalty || 0,
          _hearts: p._hearts || 0,
        })),
      };
    }

    static fromSnapshot(data) {
      const e = new GameEngine(data.rules);
      e.round = data.round;
      e.phase = data.phase;
      e.dealerIndex = data.dealerIndex;
      e.trickLeaderIndex = data.trickLeaderIndex;
      e.currentPlayerIndex = data.currentPlayerIndex;
      e.heartsBroken = !!data.heartsBroken;
      e.leadSuit = data.leadSuit || null;
      e.trickLog = data.trickLog || [];
      e._lastRoundEnd = data.lastRoundEnd || null;
      e._lastGameOver = data.lastGameOver || null;
      e.currentTrick = (data.currentTrick || []).map((t) => ({
        playerIndex: t.playerIndex, card: new BQ.Card(t.card.rank, t.card.suit),
      }));
      e.players = (data.players || []).map((pd) => {
        const p = new BQ.Player(pd.index, pd.name, pd.isHuman);
        p.hand = (pd.hand || []).map((c) => new BQ.Card(c.rank, c.suit));
        p.totalScore = pd.totalScore || 0;
        p.roundHistory = pd.roundHistory || [];
        p.tricksWon = pd.tricksWon || 0;
        p.consecutiveZeros = pd.consecutiveZeros || 0;
        p.queenTakes = pd.queenTakes || 0;
        p._penalty = pd._penalty || 0;
        p._hearts = pd._hearts || 0;
        return p;
      });
      return e;
    }

    // Repaint the table from restored state, then continue from where we left
    // off (re-arm a bot's pending turn, or re-show a round / game-over summary).
    resume() {
      this.emit('resync', {});
      if (this.phase === 'awaitHuman') {
        const legal = this.legalCards(this.currentPlayerIndex).map((c) => c.id);
        this.emit('turn', { playerIndex: this.currentPlayerIndex, legalCardIds: legal });
      } else if (this.phase === 'playing') {
        this._beginTurn();                 // a bot was mid-think — restart its turn
      } else if (this.phase === 'roundEnd') {
        if (this._lastRoundEnd) this.emit('roundEnd', this._lastRoundEnd);
      } else if (this.phase === 'gameOver') {
        if (this._lastRoundEnd) this.emit('roundEnd', this._lastRoundEnd);
        if (this._lastGameOver) this.emit('gameOver', this._lastGameOver);
      }
    }
  }

  BQ.GameEngine = GameEngine;
  BQ.Player = Player;
})(typeof window !== "undefined" ? window : globalThis);
