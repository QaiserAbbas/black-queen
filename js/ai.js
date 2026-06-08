/* =============================================================================
 * Black Queen — BOT AI
 * A heuristic player. Goal: avoid taking penalty cards (Queen + hearts), shed
 * dangerous high cards safely, and dump penalties on opponents when void.
 * Self-contained: reads the live engine state to make each decision.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  function isQueen(card, rules) {
    return card.rank === rules.queenCard.rank && card.suit === rules.queenCard.suit;
  }

  // Penalty weight of an individual card (used to evaluate "danger").
  function cardPenalty(card, rules) {
    let p = 0;
    if (card.suit === 'hearts') p += rules.heartPoints;
    if (isQueen(card, rules)) p += rules.queenPoints;
    return p;
  }

  function chooseCard(engine, playerIndex) {
    const rules = engine.rules;
    const legal = engine.legalCards(playerIndex);
    if (legal.length === 1) return legal[0];

    const trick = engine.currentTrick;
    const leading = trick.length === 0;

    if (leading) return leadChoice(legal, rules);
    return followChoice(engine, legal, trick, rules);
  }

  /* When leading: play a low, safe card. Prefer suits we have lots of low
   * cards in; never lead the Queen voluntarily; avoid leading high. */
  function leadChoice(legal, rules) {
    const safe = legal.filter((c) => !isQueen(c, rules));
    const pool = safe.length ? safe : legal;
    // lowest value first
    return pool.slice().sort((a, b) => a.value - b.value)[0];
  }

  /* When following. */
  function followChoice(engine, legal, trick, rules) {
    const leadSuit = engine.leadSuit;
    const following = legal[0].suit === leadSuit && legal.every((c) => c.suit === leadSuit);

    // Highest card currently winning the trick in lead suit.
    let topValue = -1;
    for (const play of trick) {
      if (play.card.suit === leadSuit && play.card.value > topValue) topValue = play.card.value;
    }
    const penaltyInTrick = trick.reduce((s, p) => s + cardPenalty(p.card, rules), 0);
    const isLastToPlay = trick.length === engine.players.length - 1;

    if (following) {
      // We must follow suit.
      const underTop = legal.filter((c) => c.value < topValue);
      if (penaltyInTrick > 0 || !isLastToPlay) {
        // Trick is dangerous (or unknown) — duck under the top card if we can.
        if (underTop.length) return underTop.sort((a, b) => b.value - a.value)[0]; // highest safe duck
        // Can't duck: throw our lowest of suit (minimize, may still win).
        return legal.slice().sort((a, b) => a.value - b.value)[0];
      }
      // Trick is clean and we're last: safe to win cheaply — dump highest.
      return legal.slice().sort((a, b) => b.value - a.value)[0];
    }

    // We're VOID in the lead suit: discard the most dangerous card.
    // 1) ditch the Queen if we hold it. 2) ditch highest heart. 3) ditch highest card.
    const queen = legal.find((c) => isQueen(c, rules));
    if (queen) return queen;
    const hearts = legal.filter((c) => c.suit === 'hearts');
    if (hearts.length) return hearts.sort((a, b) => b.value - a.value)[0];
    return legal.slice().sort((a, b) => b.value - a.value)[0];
  }

  BQ.AI = { chooseCard, cardPenalty };
})(typeof window !== "undefined" ? window : globalThis);
