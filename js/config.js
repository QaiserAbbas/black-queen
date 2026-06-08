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

  // Deep clone so callers can mutate freely without touching the defaults.
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  root.BQ = root.BQ || {};
  root.BQ.DEFAULT_RULES = DEFAULT_RULES;
  root.BQ.cloneRules = function () { return clone(DEFAULT_RULES); };
  root.BQ.cloneOf = clone;
})(typeof window !== "undefined" ? window : globalThis);
