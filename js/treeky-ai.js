/* =============================================================================
 * TREEKY — BOT AI
 * -----------------------------------------------------------------------------
 * A light, public-information strategy for a shedding game. Returns a single
 * ACTION for the seat whose turn it is:
 *   { type: 'play', cardId, suit? }   // suit only when playing a wild (Jack)
 *   { type: 'draw' }                  // no legal card, or take the 3-penalty
 *   { type: 'pass' }                  // keep a freshly-drawn (playable) card
 *
 * The engine guarantees legality; the AI only ranks among legal options. It can
 * see opponents' HAND SIZES (public) but never their actual cards.
 * ===========================================================================*/

(function (root) {
  'use strict';
  const BQ = root.BQ;

  // The suit the player holds the most of (used when a Jack picks the next suit).
  function bestSuit(player, exceptCard) {
    const count = {};
    player.hand.forEach((c) => {
      if (exceptCard && c.id === exceptCard.id) return;
      count[c.suit] = (count[c.suit] || 0) + 1;
    });
    let suit = (exceptCard && exceptCard.suit) || BQ.SUITS[0];
    let best = -1;
    for (const s of BQ.SUITS) {
      if ((count[s] || 0) > best) { best = count[s] || 0; suit = s; }
    }
    return suit;
  }

  function chooseMove(engine, idx) {
    const r = engine.rules;
    const p = engine.players[idx];
    const legal = engine.legalCards(idx);

    // Nothing legal: draw a card (the engine auto-passes the turn if the drawn
    // card doesn't help). A bot never voluntarily passes — it sheds when it can.
    if (legal.length === 0) return { type: 'draw' };

    // Under attack from stacked 3s — pass it on (legal here is all our 3s).
    if (engine.pendingDraw > 0) return { type: 'play', cardId: legal[0].id };

    // Just drew and now has a legal card: play it, preferring a non-wild.
    if (engine._drewThisTurn) {
      const c = legal.find((x) => x.rank !== r.wildRank) || legal[0];
      return { type: 'play', cardId: c.id, suit: c.rank === r.wildRank ? bestSuit(p, c) : undefined };
    }

    // Fresh turn — rank the legal cards.
    const suitCount = {};
    p.hand.forEach((c) => { suitCount[c.suit] = (suitCount[c.suit] || 0) + 1; });
    const nextIdx = engine._next(idx);
    const nextSmall = engine.players[nextIdx] && engine.players[nextIdx].hand.length <= 2;

    // Hold Jacks in reserve unless they're the only thing we can play.
    const nonWild = legal.filter((c) => c.rank !== r.wildRank);
    const pool = nonWild.length ? nonWild : legal;

    let best = pool[0], bestScore = -Infinity;
    for (const c of pool) {
      let s = suitCount[c.suit] || 0;                 // shed from our longest suits
      if (c.rank === r.drawRank) s += nextSmall ? 5 : 1; // attack when the next player is low
      if (c.rank === r.wildRank) s -= 8;              // keep wilds back
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return {
      type: 'play',
      cardId: best.id,
      suit: best.rank === r.wildRank ? bestSuit(p, best) : undefined,
    };
  }

  BQ.TreekyAI = { chooseMove, bestSuit };
})(typeof window !== "undefined" ? window : globalThis);
