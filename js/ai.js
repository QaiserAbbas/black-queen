/* =============================================================================
 * Black Queen — BOT AI  (hard / "play the best")
 * -----------------------------------------------------------------------------
 * A strong, FAIR heuristic player. It never peeks at hidden hands — it makes
 * every decision from PUBLIC information only:
 *   • every card played so far this round (engine.trickLog + currentTrick),
 *   • which players have shown void in which suits (failed to follow),
 *   • running scores (for the Queen-immunity rule),
 *   • its own hand.
 * From that it counts the unseen cards and plays to:
 *   1. never get stuck with the Black Queen (12 pts) — and dump it on others,
 *   2. shed the queen-magnets (A♠/K♠) before they capture the Queen,
 *   3. lose dangerous tricks (duck under), win only the safe/empty ones,
 *   4. lead low & safe, voiding side suits so it can sluff penalties later,
 *   5. when safe from the Queen with only LOW spades, flush spades out first,
 *   6. when stuck holding A♠/K♠, run low clubs/diamonds to go void, then
 *      sluff the magnets onto an opponent's trick later.
 * Every rule value is read from the live rules config (nothing hard-coded).
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;
  const SUITS = BQ.SUITS;

  /* ---- small helpers ---------------------------------------------------- */
  const isQueen = (card, rules) =>
    card.rank === rules.queenCard.rank && card.suit === rules.queenCard.suit;

  function cardPenalty(card, rules) {
    let p = 0;
    if (card.suit === 'hearts') p += rules.heartPoints;
    if (isQueen(card, rules)) p += rules.queenPoints;
    return p;
  }

  const highest = (cards) => cards.slice().sort((a, b) => b.value - a.value)[0];
  const lowest = (cards) => cards.slice().sort((a, b) => a.value - b.value)[0];

  // id is "<rank>_<suit>" (rank may be "10"); rank never contains '_'.
  function parseId(id) {
    const i = id.indexOf('_');
    return { suit: id.slice(i + 1), val: BQ.rankValue(id.slice(0, i)) };
  }

  /* ---- public-information model ----------------------------------------- *
   * Reconstructs everything a watching opponent could legally know.        */
  function buildInfo(engine, me) {
    const rules = engine.rules;
    const n = engine.players.length;
    const qSuit = rules.queenCard.suit;
    const qVal = BQ.rankValue(rules.queenCard.rank);

    const seen = { spades: new Set(), hearts: new Set(), diamonds: new Set(), clubs: new Set() };
    const voids = Array.from({ length: n }, () => ({ spades: false, hearts: false, diamonds: false, clubs: false }));
    let queenPlayed = false;

    // completed tricks: cards[0] is the leader, so its suit is that trick's lead.
    for (const h of (engine.trickLog || [])) {
      const cards = h.cards || [];
      if (!cards.length) continue;
      const lead = parseId(cards[0].id).suit;
      for (const c of cards) {
        const p = parseId(c.id);
        seen[p.suit] && seen[p.suit].add(p.val);
        if (p.suit === qSuit && p.val === qVal) queenPlayed = true;
        if (p.suit !== lead) voids[c.playerIndex][lead] = true;
      }
    }

    // the trick in progress
    const lead = engine.leadSuit;
    for (const t of engine.currentTrick) {
      seen[t.card.suit] && seen[t.card.suit].add(t.card.value);
      if (t.card.suit === qSuit && t.card.value === qVal) queenPlayed = true;
      if (lead && t.card.suit !== lead) voids[t.playerIndex][lead] = true;
    }

    // my own cards (so "unseen" = strictly what opponents might still hold)
    const mine = { spades: new Set(), hearts: new Set(), diamonds: new Set(), clubs: new Set() };
    for (const c of engine.players[me].hand) mine[c.suit].add(c.value);

    const unseen = {};
    for (const s of SUITS) {
      unseen[s] = [];
      for (let v = 0; v <= 12; v++) if (!seen[s].has(v) && !mine[s].has(v)) unseen[s].push(v);
    }

    const iAmExempt =
      rules.queenExemptEnabled && engine.players[me].totalScore >= rules.queenExemptScore;

    return { rules, n, qSuit, qVal, voids, queenPlayed, unseen, iAmExempt };
  }

  // Are there still unseen cards of `suit` ABOVE `value` out among opponents?
  const higherOut = (info, suit, value) => info.unseen[suit].filter((v) => v > value).length;

  // Penalty points already on the table, as they'd be charged to ME if I won.
  // (The Queen is harmless to me when I'm immune by score.)
  function pointsForMe(trick, info) {
    const r = info.rules;
    let pts = 0;
    for (const { card } of trick) {
      if (card.suit === 'hearts') pts += r.heartPoints;
      if (card.suit === info.qSuit && card.value === info.qVal && !info.iAmExempt) pts += r.queenPoints;
    }
    return pts;
  }

  // How dangerous a card is to KEEP — used when discarding while void.
  // Higher = shed it first.
  function discardDanger(c, info) {
    if (c.suit === info.qSuit && c.value === info.qVal) return 1e6; // the Queen — gone, always
    let d = c.value; // higher ranks are generally riskier to hold
    if (c.suit === info.qSuit && c.value > info.qVal && !info.queenPlayed && !info.iAmExempt) {
      d += 100; // A♠/K♠ while the Queen is loose — they capture it; shed first
    } else if (c.suit === 'hearts') {
      d += 40 + c.value; // point cards, and high hearts win heart tricks
    } else if (c.value >= 10) {
      d += 20; // Q/K/A of side suits win tricks → catch future penalties
    }
    return d;
  }

  /* ====================================================================== *
   *  ENTRY POINT
   * ====================================================================== */
  function chooseCard(engine, playerIndex) {
    const legal = engine.legalCards(playerIndex);
    if (legal.length === 1) return legal[0]; // forced (incl. must-throw Queen)

    const info = buildInfo(engine, playerIndex);
    const trick = engine.currentTrick;

    if (trick.length === 0) return leadChoice(engine, info, playerIndex, legal);
    return followChoice(engine, info, playerIndex, legal, trick);
  }

  /* ---- LEADING ---------------------------------------------------------- *
   * Lead low and safe: avoid cards that are sure to win the trick, never
   * lead the Queen, don't lead high spades that could catch the Queen, and
   * prefer voiding a short side suit so penalties can be sluffed later.    */
  function leadChoice(engine, info, me, legal) {
    const { qSuit, qVal, queenPlayed, iAmExempt } = info;
    const iHoldQueen = legal.some((c) => c.suit === qSuit && c.value === qVal);

    let cands = legal.filter((c) => !(c.suit === qSuit && c.value === qVal));
    if (!cands.length) cands = legal;

    const lenBySuit = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
    for (const c of engine.players[me].hand) lenBySuit[c.suit]++;

    // My spade picture (the Queen lives in qSuit; "big" = ranked above her).
    const mySpades = engine.players[me].hand.filter((c) => c.suit === qSuit);
    const haveBigSpade = mySpades.some((c) => c.value > qVal);
    const onlySmallSpades = mySpades.length > 0 && !haveBigSpade;
    const safeFromQueen = queenPlayed || iAmExempt;

    // Rule 5: safe from the Queen and holding only LOW spades → lead spades now
    //         to finish the suit (depletes it for later sluffing, and can draw
    //         the Queen off an opponent at no risk to me — my spades can't win).
    const flushSpades = safeFromQueen && onlySmallSpades;

    // Rule 6: stuck with A♠/K♠ I can't safely lead → run my low clubs/diamonds
    //         first to go void in a side suit, so I can sluff the magnets later.
    const stuckBigSpade = haveBigSpade && !queenPlayed && !iAmExempt;

    let best = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const willWin = higherOut(info, c.suit, c.value) === 0; // nothing higher is out → I win
      let score = c.value;                       // prefer leading low
      if (willWin) score += 60;                  // strongly avoid grabbing the lead

      if (c.suit === qSuit && !queenPlayed && !iAmExempt) {
        // leading high spades can capture the Queen onto myself
        score += (!iHoldQueen && c.value > qVal) ? 80 : 5;
      }
      if (c.suit === 'hearts') score += willWin ? 15 : 4; // point suit; low hearts are fine

      score += lenBySuit[c.suit] * 1.5;          // bias toward voiding a short suit

      if (flushSpades && c.suit === qSuit) score -= 50;   // finish low spades first
      if (stuckBigSpade && (c.suit === 'clubs' || c.suit === 'diamonds')) {
        score -= 30;                              // run side suits low → go void
      }

      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /* ---- FOLLOWING / DISCARDING ------------------------------------------ */
  function followChoice(engine, info, me, legal, trick) {
    const { qSuit, qVal, n } = info;
    const leadSuit = engine.leadSuit;
    const following = legal.every((c) => c.suit === leadSuit); // I hold the lead suit

    if (following) {
      let topVal = -1;
      for (const t of trick) if (t.card.suit === leadSuit && t.card.value > topVal) topVal = t.card.value;

      const playedSet = new Set(trick.map((t) => t.playerIndex));
      let yet = 0;
      for (let s = 0; s < n; s++) if (s !== me && !playedSet.has(s)) yet++;
      const isLast = yet === 0;
      const pts = pointsForMe(trick, info);

      const underTop = legal.filter((c) => c.value < topVal);

      // Free trick: I'm last and nothing harmful is on the table → win it and
      // dump my highest card (sheds A♠/K♠ and other liabilities safely).
      if (isLast && pts === 0) return highest(legal);

      // Duck: playing under the current top guarantees I don't win this trick.
      // Shed the highest card that still stays safely under the top.
      if (underTop.length) return highest(underTop);

      // Can't duck — I might win. Minimise the overshoot and NEVER hand myself
      // the Black Queen voluntarily; keep it to sluff onto an opponent later.
      const noQueen = legal.filter((c) => !(c.suit === qSuit && c.value === qVal));
      return lowest(noQueen.length ? noQueen : legal);
    }

    // VOID in the lead suit → this discard can never win, so it's free:
    // throw the single most dangerous card I'm holding.
    let best = legal[0];
    let bestD = -Infinity;
    for (const c of legal) {
      const d = discardDanger(c, info);
      if (d > bestD) { bestD = d; best = c; }
    }
    return best;
  }

  BQ.AI = { chooseCard, cardPenalty };
})(typeof window !== "undefined" ? window : globalThis);
