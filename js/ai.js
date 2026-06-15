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
 *
 * PARTNERSHIP: scoring is solo, but the bots also PLAY as virtual pairs (seats
 * sitting across the table — 1&3, 2&4). Still using public info only, a bot
 * sets its partner up (leads into their void), never piles points onto its own
 * partner, and won't steal a trick the partner is already winning. Every weight
 * and toggle for all of this lives in js/tactics.js (BQ.TACTICS) — nothing in
 * here is hard-coded; rule VALUES still come from the live rules config.
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

  /* ---- tactics access --------------------------------------------------- *
   * Every strategic knob lives in js/tactics.js (BQ.TACTICS). The two helpers
   * below read it safely: if the file is missing or a value was deleted, the
   * built-in fallback keeps the bot playing exactly as before.              */
  const tactics = () => (BQ.TACTICS && BQ.TACTICS.enabled !== false ? BQ.TACTICS : {});

  // Is a named tactic switched on? Missing entry => treated as on.
  function on(tx, group, name) {
    const t = tx[group] && tx[group][name];
    return !t || t.enabled !== false;
  }
  // Read a tactic's numeric setting (weight / threshold), with a fallback.
  // A rank string (e.g. 'Q') is resolved to its card value for comparisons.
  function wt(tx, group, name, key, def) {
    const t = tx[group] && tx[group][name];
    const v = t && t[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return BQ.rankValue(v);
    return def;
  }

  /* ---- partnership ------------------------------------------------------ *
   * Scoring stays solo, but the bots PLAY as virtual pairs sitting across the
   * table: seats 1 & 3 partner, seats 2 & 4 partner (0-based 0&2, 1&3). The
   * partner is the seat n/2 places around, which is only defined for an even
   * table — with an odd count there are no pairs and the bot plays pure solo. */
  function partnerOf(me, n) {
    return n % 2 === 0 ? (me + n / 2) % n : -1;
  }
  // Is a partnership sub-tactic active? (the whole `partners` group can be off)
  function partnerOn(tx, name) {
    const g = tx.partners;
    if (!g || g.enabled === false) return false;
    const t = g[name];
    return !t || t.enabled !== false;
  }
  function partnerWt(tx, name, def) {
    const g = tx.partners, t = g && g[name];
    const v = t && t.weight;
    return typeof v === 'number' ? v : def;
  }
  // Which seat currently leads (wins) the in-progress trick? null if none yet.
  function currentWinner(trick, leadSuit) {
    let w = null, top = -1;
    for (const t of trick) {
      if (t.card.suit === leadSuit && t.card.value > top) { top = t.card.value; w = t.playerIndex; }
    }
    return w;
  }

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

    return {
      rules, n, qSuit, qVal, voids, queenPlayed, unseen, iAmExempt,
      tx: tactics(), me, partner: partnerOf(me, n),
      tricksDone: (engine.trickLog || []).length,
    };
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
    const tx = info.tx;
    if (c.suit === info.qSuit && c.value === info.qVal && on(tx, 'discarding', 'dumpQueenFirst'))
      return 1e6; // the Queen — gone, always
    let d = c.value; // higher ranks are generally riskier to hold
    if (c.suit === info.qSuit && c.value > info.qVal && !info.queenPlayed && !info.iAmExempt &&
        on(tx, 'discarding', 'shedLooseSpadeMagnets')) {
      d += wt(tx, 'discarding', 'shedLooseSpadeMagnets', 'weight', 100); // A♠/K♠ while the Queen is loose
    } else if (c.suit === 'hearts' && on(tx, 'discarding', 'shedHearts')) {
      d += wt(tx, 'discarding', 'shedHearts', 'weight', 40) + c.value; // point cards; high hearts worst
    } else if (c.value >= wt(tx, 'discarding', 'shedHighSideSuit', 'highCardThreshold', 10) &&
               on(tx, 'discarding', 'shedHighSideSuit')) {
      d += wt(tx, 'discarding', 'shedHighSideSuit', 'weight', 20); // Q/K/A of side suits catch penalties
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
    const { qSuit, qVal, queenPlayed, iAmExempt, tx, partner } = info;
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

    // Rule 5 (tactic: flushLowSpades): safe from the Queen and holding only LOW
    //         spades → lead spades now to finish the suit (depletes it for later
    //         sluffing, and can draw the Queen off an opponent at no risk).
    const flushSpades = safeFromQueen && onlySmallSpades && on(tx, 'leading', 'flushLowSpades');

    // Rule 6 (tactic: escapeStuckSpades): stuck with A♠/K♠ I can't safely lead →
    //         run low clubs/diamonds first to go void, then sluff the magnet later.
    const stuckBigSpade =
      haveBigSpade && !queenPlayed && !iAmExempt && on(tx, 'leading', 'escapeStuckSpades');

    let best = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const willWin = higherOut(info, c.suit, c.value) === 0; // nothing higher is out → I win
      let score = c.value * wt(tx, 'leading', 'preferLowLead', 'weight', 1); // prefer leading low
      if (willWin && on(tx, 'leading', 'avoidWinningLead')) {
        score += wt(tx, 'leading', 'avoidWinningLead', 'weight', 60);        // avoid grabbing the lead
      }

      if (c.suit === qSuit && !queenPlayed && !iAmExempt && on(tx, 'leading', 'avoidQueenCapture')) {
        // leading high spades can capture the Queen onto myself
        score += (!iHoldQueen && c.value > qVal)
          ? wt(tx, 'leading', 'avoidQueenCapture', 'weight', 80)
          : wt(tx, 'leading', 'avoidQueenCapture', 'minorWeight', 5);
      }
      if (c.suit === 'hearts' && on(tx, 'leading', 'cautiousHearts')) {
        score += willWin
          ? wt(tx, 'leading', 'cautiousHearts', 'winWeight', 15)
          : wt(tx, 'leading', 'cautiousHearts', 'safeWeight', 4);           // low hearts are fine
      }

      if (on(tx, 'leading', 'voidShortSuit')) {
        score += lenBySuit[c.suit] * wt(tx, 'leading', 'voidShortSuit', 'weight', 1.5); // void short suits
      }

      if (flushSpades && c.suit === qSuit) {
        score -= wt(tx, 'leading', 'flushLowSpades', 'weight', 50);          // finish low spades first
      }
      if (stuckBigSpade && (c.suit === 'clubs' || c.suit === 'diamonds')) {
        score -= wt(tx, 'leading', 'escapeStuckSpades', 'weight', 30);       // run side suits low → go void
      }

      // PARTNERSHIP — set my partner up and starve my opponents (public info
      // only: who has shown void in what). Scoring stays solo; this only
      // changes which card I choose, never any rule.
      if (partner >= 0) {
        // Lead LOW into a suit my partner is void in: an opponent is forced to
        // win it, and my partner can sluff a penalty (often the Queen) onto them.
        if (!willWin && info.voids[partner][c.suit] && partnerOn(tx, 'leadPartnerVoid')) {
          score -= partnerWt(tx, 'leadPartnerVoid', 25);
        }
        // Don't lead a suit an OPPONENT is void in — that just gifts them a free
        // discard for their own penalties.
        if (partnerOn(tx, 'avoidOpponentVoid')) {
          for (let s = 0; s < info.n; s++) {
            if (s !== me && s !== partner && info.voids[s][c.suit]) {
              score += partnerWt(tx, 'avoidOpponentVoid', 15);
              break;
            }
          }
        }
        // Signal: early on, holding no Queen and no high spade, lead a LOW spade
        // to tell my partner I'm safe there (and help draw the Queen onto an
        // opponent). I can't capture the Queen — my spades are all below her.
        if (c.suit === qSuit && !iHoldQueen && !haveBigSpade && !queenPlayed &&
            info.tricksDone < 2 && partnerOn(tx, 'signalLowSpade')) {
          score -= partnerWt(tx, 'signalLowSpade', 8);
        }
      }

      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /* ---- FOLLOWING / DISCARDING ------------------------------------------ */
  function followChoice(engine, info, me, legal, trick) {
    const { qSuit, qVal, n, tx, partner } = info;
    const leadSuit = engine.leadSuit;
    const following = legal.every((c) => c.suit === leadSuit); // I hold the lead suit

    // Is my virtual partner currently winning this trick? (public: highest card
    // of the lead suit so far). Drives "don't undercut your own partner".
    const winner = currentWinner(trick, leadSuit);
    const partnerWinning = partner >= 0 && winner === partner;

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
      if (isLast && pts === 0 && on(tx, 'following', 'grabFreeTricks')) {
        // ...unless my partner is already winning this pointless trick — then
        // let them keep it. Duck a high card under them if I can, else go low.
        if (partnerWinning && partnerOn(tx, 'letPartnerWin')) {
          return underTop.length ? highest(underTop) : lowest(legal);
        }
        return highest(legal);
      }

      // Duck: playing under the current top guarantees I don't win this trick.
      // Shed the highest card that still stays safely under the top.
      if (underTop.length && on(tx, 'following', 'duckUnderTop')) return highest(underTop);

      // Can't duck — I might win. Minimise the overshoot and NEVER hand myself
      // the Black Queen voluntarily; keep it to sluff onto an opponent later.
      const noQueen = on(tx, 'following', 'neverTakeQueen')
        ? legal.filter((c) => !(c.suit === qSuit && c.value === qVal))
        : legal;
      return lowest(noQueen.length ? noQueen : legal);
    }

    // VOID in the lead suit → this discard can never win, so it's free:
    // throw the single most dangerous card I'm holding.
    // PARTNERSHIP: if my partner is currently winning, don't pile penalty cards
    // (hearts / the Queen) onto their trick — shed a safe high card instead.
    const protect = partnerWinning && partnerOn(tx, 'protectPartner');
    const isPenalty = (c) => c.suit === 'hearts' || (c.suit === qSuit && c.value === qVal);
    let best = legal[0];
    let bestD = -Infinity;
    for (const c of legal) {
      let d = discardDanger(c, info);
      if (protect && isPenalty(c)) d -= partnerWt(tx, 'protectPartner', 100000); // keep points off partner
      if (d > bestD) { bestD = d; best = c; }
    }
    return best;
  }

  BQ.AI = { chooseCard, cardPenalty };
})(typeof window !== "undefined" ? window : globalThis);
