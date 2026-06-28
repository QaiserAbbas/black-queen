/* =============================================================================
 * BLUFF — BOT AI
 * -----------------------------------------------------------------------------
 * A light, public-information strategy. Two decisions:
 *   choosePlay(engine, idx)      -> { rank, cardIds }   // what to place + claim
 *   decideChallenge(engine, idx) -> true | false        // call "Bluff!" or let it go
 *
 * A bot can see its OWN hand and every player's hand SIZE (public), plus the
 * current claim, but never the face-down pile or other players' cards. It plays
 * mostly honestly (dumping its longest rank) with the occasional small bluff,
 * and doubts a claim when its own hand makes the claim implausible — or when the
 * claimer is one play away from winning.
 * ===========================================================================*/

(function (root) {
  'use strict';
  const BQ = root.BQ;

  function groupByRank(hand) {
    const g = {};
    hand.forEach((c) => { (g[c.rank] = g[c.rank] || []).push(c); });
    return g;
  }

  // Place + claim. Honest by default (dump the rank we hold most of); now and
  // then offload a lone "junk" card under a plausible claim to thin the hand.
  function choosePlay(engine, idx) {
    const p = engine.players[idx];
    const max = engine.maxClaimFor(idx);
    if (!p.hand.length) return null;

    const g = groupByRank(p.hand);
    let bestRank = null, bestArr = [];
    for (const rank in g) {
      if (g[rank].length > bestArr.length) { bestArr = g[rank]; bestRank = rank; }
    }
    if (!bestRank) { bestRank = p.hand[0].rank; bestArr = [p.hand[0]]; }

    // Occasional bluff: claim our strongest rank but actually slip out a single
    // hard-to-group card (a singleton of another rank). Cheap if caught (1 card).
    const singles = Object.keys(g).filter((k) => g[k].length === 1 && k !== bestRank);
    if (singles.length && Math.random() < 0.22) {
      const junkRank = singles[Math.floor(Math.random() * singles.length)];
      return { rank: bestRank, cardIds: [g[junkRank][0].id] };
    }

    const n = Math.min(bestArr.length, max);
    return { rank: bestRank, cardIds: bestArr.slice(0, n).map((c) => c.id) };
  }

  // Doubt the current claim?
  function decideChallenge(engine, idx) {
    const claim = engine.claim;
    if (!claim) return false;
    const decks = engine.rules.decks || 1;
    const total = 4 * decks;                 // copies of any rank in the game
    const me = engine.players[idx];
    const myCount = me.hand.filter((c) => c.rank === claim.rank).length;

    // If I already hold enough of that rank that the claim can't be true, call it.
    if (myCount + claim.count > total) return true;

    const claimer = engine.players[claim.by];
    let prob = 0.04 + 0.10 * (claim.count - 1); // bigger claims are more suspect
    prob += myCount * 0.12;                      // I hold some → fewer remain for them
    if (claimer && claimer.hand.length === 0) prob += 0.55; // a truthful claim wins — call it
    else if (claimer && claimer.hand.length <= 2) prob += 0.15;

    prob = Math.max(0, Math.min(0.95, prob));
    return Math.random() < prob;
  }

  BQ.BluffAI = { choosePlay, decideChallenge, groupByRank };
})(typeof window !== "undefined" ? window : globalThis);
