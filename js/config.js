/* =============================================================================
 * Black Queen — RULE CONFIGURATION
 * -----------------------------------------------------------------------------
 * EVERYTHING about how the game scores and plays lives in this one object.
 * Change a number here (or via the in-game Settings panel) and the whole engine
 * obeys it. Nothing in engine.js hard-codes a rule value — it always reads from
 * here. This is the file you edit when you want to tweak the game later.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const DEFAULT_RULES = {
    /* ---- Identity --------------------------------------------------------- */
    gameName: 'Black Queen',

    /* ---- Players ---------------------------------------------------------- */
    playerCount: 4,            // total seats at the table (1 human + bots)
    botNames: ['Aisha', 'Omar', 'Zara', 'Bilal', 'Hana', 'Yusuf'],

    /* ---- Deck & deal ------------------------------------------------------ */
    // 52-card deck, 4 players => 13 cards each. Penalty total = 12 (Queen) + 13
    // (hearts) = 25, which matches "Total for each round will be 25".
    useFullDeck: true,

    /* ---- Penalty card values (MAJOR RULES 1, 2, 3) ------------------------ */
    queenCard: { rank: 'Q', suit: 'spades' }, // the Black Queen
    queenPoints: 12,           // RULE 1: Queen = 12 points
    heartPoints: 1,            // RULE 2: each heart = 1 point
    expectedRoundTotal: 25,    // RULE 3: sanity check (12 + 13 hearts)

    /* ---- Special scoring rules -------------------------------------------- */
    // RULE 4: a player who wins NO trick the entire round.
    noTrickPenalty: -12,
    noTrickRuleEnabled: true,

    // RULE 5: N consecutive rounds scoring exactly 0 triggers a penalty.
    consecutiveZeroLimit: 3,
    consecutiveZeroPenalty: -12,
    consecutiveZeroRuleEnabled: true,

    // RULE 6: passing cards is disabled.
    passingEnabled: false,

    // QUEEN IMMUNITY: a player whose total score is >= this threshold cannot be
    // charged the Queen's points. If they capture the Black Queen, its points
    // are disregarded (they still take any hearts in that trick).
    queenExemptEnabled: true,
    queenExemptScore: 80,

    /* ---- Trick-play rules -------------------------------------------------- */
    // RULE 7: highest-scoring player deals; the player NEXT (in play direction)
    // takes the first turn, and play continues that way.
    dealerIsHighestScore: true,
    // Direction of play: 'right' = counter-clockwise (first turn to the dealer's
    // RIGHT); 'left' = clockwise (to the dealer's left).
    playDirection: 'right',

    heartsMustBeBroken: false, // off by default: hearts may be led at any time
    queenBreaksHearts: true,   // playing the Black Queen also "breaks" hearts

    /* ---- Trailing-player reshuffle (multiplayer only) --------------------- */
    // Before a round begins, the player with the MOST points (worst position,
    // since LOW wins) may force a fresh re-deal — up to `reshuffleMax` times per
    // round. Off by default so single-player is unaffected; the server turns it
    // on for online Black Queen tables. Skipped on round 1 (everyone tied at 0).
    reshuffleEnabled: false,
    reshuffleMax: 2,

    // MUST-THROW QUEEN: when you can't follow the led suit (you're void) and you
    // hold the Black Queen, you are forced to discard it — you can't hold it back.
    mustThrowQueen: true,

    /* ---- Shooting the moon (optional classic twist) ----------------------- */
    shootTheMoonEnabled: false,
    shootTheMoonAward: -25,    // taker subtracts, or set othersGain instead

    /* ---- Winning condition ------------------------------------------------ */
    // 'targetScore'  -> game ends when any player reaches endScore; LOW wins.
    // 'fixedRounds'  -> play exactly `roundLimit` rounds; LOW wins.
    endMode: 'targetScore',
    endScore: 100,
    roundLimit: 10,
    lowestScoreWins: true,

    /* ---- Presentation ----------------------------------------------------- */
    soundEnabled: true,
    animationSpeed: 1,         // 1 = normal, 0.5 = fast, 2 = slow
    botThinkMs: 650,           // delay before a bot plays (feels human)
  };

  /* =============================================================================
   * TREEKY — RULE CONFIGURATION
   * -----------------------------------------------------------------------------
   * Treeky is a shedding game (Crazy-Eights / "Switch" family). Played with TWO
   * full decks combined (every card appears twice). Goal: empty your hand. The
   * first to finish is ranked 1st and becomes a spectator while the rest play on;
   * the game ends when only one player is still holding cards. Everything the
   * Treeky engine needs is read from here.
   * ===========================================================================*/
  const TREEKY_RULES = {
    gameName: 'Treeky',

    /* ---- Players ---------------------------------------------------------- */
    playerCount: 4,            // single-player table size (1 human + 3 bots)
    minPlayers: 3,             // game is valid with 3+ players
    maxPlayers: 10,            // up to 10 seats online
    fillToMin: 4,             // multiplayer: bots fill empty seats up to this many
    botNames: ['Aisha', 'Omar', 'Zara', 'Bilal', 'Hana', 'Yusuf', 'Imran', 'Sana', 'Tariq'],

    /* ---- Deck & deal ------------------------------------------------------ */
    decks: 2,                  // 1 or 2 full 52-card decks (2 => 104 cards)
    handSize: 10,              // RULE 1: ten cards each
    // Direction of play: 'right' (default, counter-clockwise) or 'left'.
    playDirection: 'right',

    /* ---- Special cards (RULES 2, 6, 7) ------------------------------------ */
    wildRank: 'J',             // a Jack is always playable and chooses the next suit
    drawRank: '3',             // a 3 forces the next player to draw, and stacks
    drawPenalty: 3,            // RULE 8: each 3 adds 3 cards to the pending draw

    /* ---- Last-card rule (RULE 9) ------------------------------------------ */
    lastCardPenalty: 1,        // miss the "Last Card!" call => draw this many next turn

    /* ---- Presentation (shared with Black Queen) --------------------------- */
    soundEnabled: true,
    animationSpeed: 1,
    botThinkMs: 1250,          // a touch slower so moves are easy to follow
  };

  /* =============================================================================
   * BLUFF — RULE CONFIGURATION
   * -----------------------------------------------------------------------------
   * Bluff (a.k.a. Cheat / BS / I Doubt It). The whole deck is dealt out; on your
   * turn you place 1–maxPerPlay cards FACE DOWN and CLAIM a rank for them — any
   * rank you like (this build uses the free-choice variant). The claim may be a
   * lie. Any other player can call "Bluff!": the just-played cards are revealed —
   * if the claim was false the claimer takes the whole pile, otherwise the
   * challenger takes it. First to empty their hand wins. Everything the Bluff
   * engine needs is read from here.
   * ===========================================================================*/
  const BLUFF_RULES = {
    gameName: 'Bluff',

    /* ---- Players ---------------------------------------------------------- */
    playerCount: 4,            // single-player table size (1 human + 3 bots)
    minPlayers: 2,             // game is valid with 2+ players
    maxPlayers: 8,             // up to 8 seats online
    fillToMin: 4,              // multiplayer: bots fill empty seats up to this many
    botNames: ['Aisha', 'Omar', 'Zara', 'Bilal', 'Hana', 'Yusuf', 'Imran', 'Sana', 'Tariq'],

    /* ---- Deck & deal ------------------------------------------------------ */
    decks: 1,                  // 1 or 2 full 52-card decks (whole deck dealt out)
    maxPerPlay: 4,             // most cards you may place (and claim) in one turn
    // Direction of play: 'right' (default, counter-clockwise) or 'left'.
    playDirection: 'right',

    /* ---- Timing ----------------------------------------------------------- */
    // Online: how long a human challenge window stays open before undecided
    // players auto-let-it-go (so a slow/absent player can't stall the table).
    challengeWindowMs: 9000,

    /* ---- Presentation (shared with the other games) ----------------------- */
    soundEnabled: true,
    animationSpeed: 1,
    botThinkMs: 1100,
  };

  // Deep clone so callers can mutate freely without touching the defaults.
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  root.BQ = root.BQ || {};
  root.BQ.DEFAULT_RULES = DEFAULT_RULES;
  root.BQ.TREEKY_RULES = TREEKY_RULES;
  root.BQ.BLUFF_RULES = BLUFF_RULES;
  root.BQ.cloneRules = function () { return clone(DEFAULT_RULES); };
  root.BQ.cloneTreekyRules = function () { return clone(TREEKY_RULES); };
  root.BQ.cloneBluffRules = function () { return clone(BLUFF_RULES); };
  root.BQ.cloneOf = clone;
})(typeof window !== "undefined" ? window : globalThis);
