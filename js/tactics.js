/* =============================================================================
 * Black Queen — BOT TACTICS  (the bot's "playbook")
 * -----------------------------------------------------------------------------
 * THIS is the file you edit to make the bots play smarter or change how they
 * think. config.js says HOW THE GAME SCORES; this file says HOW THE BOT PLAYS.
 *
 * The bot's brain (js/ai.js) reads every tactic from the object below. You do
 * NOT need to touch ai.js — just change the numbers and flags here.
 *
 * HOW TO EDIT
 * -----------------------------------------------------------------------------
 *   • enabled: true | false   → turn a whole tactic on or off.
 *   • weight: <number>         → how STRONGLY the bot follows that tactic.
 *                                Bigger number = stronger pull. 0 = ignored.
 *
 * MENTAL MODEL (important): when LEADING, the bot scores every candidate card
 * and plays the one with the LOWEST score. So a weight that is ADDED makes a
 * card less attractive (the bot avoids it), and a weight that is SUBTRACTED
 * makes a card more attractive (the bot prefers it). The comments below say
 * "avoid" or "prefer" so you don't have to remember the sign.
 *
 * When DISCARDING (the bot is void in the led suit and can't win), it throws
 * the card with the HIGHEST danger score, so there a bigger weight = "get rid
 * of this kind of card sooner".
 *
 * The defaults below reproduce the bot's current, tuned behavior exactly —
 * start from here and nudge a value at a time to see the effect.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const TACTICS = {
    /* ---- Master switch ---------------------------------------------------- */
    // Leave on. Individual tactics are toggled in their own `enabled` flags.
    enabled: true,

    /* ===================================================================== *
     *  LEADING — what to do when the bot starts a trick.
     *  Goal: lead low and safe; don't hand yourself the lead or the Queen.
     * ===================================================================== */
    leading: {
      // Prefer leading LOW cards. The card's rank is multiplied by this, so a
      // higher weight makes the bot even keener to lead its smallest cards.
      preferLowLead: { weight: 1 },

      // Avoid leading a card that is GUARANTEED to win the trick (nothing higher
      // is still out). Winning means you grab the lead — usually undesirable.
      avoidWinningLead: { enabled: true, weight: 60 },

      // Don't lead spades that could drag the Black Queen onto yourself.
      //   weight      → applied to a HIGH spade (above the Queen) while she's loose.
      //   minorWeight → small nudge for other spades when the Queen is still out.
      avoidQueenCapture: { enabled: true, weight: 80, minorWeight: 5 },

      // Be careful leading hearts (they are point cards).
      //   winWeight  → penalty when the heart would win the trick.
      //   safeWeight → tiny penalty when a low heart is safe to lead.
      cautiousHearts: { enabled: true, winWeight: 15, safeWeight: 4 },

      // Prefer leading from a SHORT suit so the bot goes void and can sluff
      // penalties later. weight is multiplied by how many cards it holds in the
      // suit (longer suit = higher score = avoided), nudging it toward shorties.
      voidShortSuit: { enabled: true, weight: 1.5 },

      // Once the bot is SAFE from the Queen and holds only LOW spades, flush
      // them out first (finish the suit so it's free to sluff later, and maybe
      // draw the Queen off an opponent at no risk). Subtracted = preferred.
      flushLowSpades: { enabled: true, weight: 50 },

      // When STUCK holding a big spade (A♠/K♠) the bot can't safely lead, run
      // low clubs/diamonds first to go void, so it can sluff the magnet later.
      escapeStuckSpades: { enabled: true, weight: 30 },
    },

    /* ===================================================================== *
     *  FOLLOWING — what to do when someone else led and the bot must respond.
     *  Goal: dodge points; never volunteer to take the Black Queen.
     * ===================================================================== */
    following: {
      // If the bot plays LAST and there are no points on the table, win the
      // trick on purpose and dump its most dangerous high card safely.
      grabFreeTricks: { enabled: true },

      // "Duck": when possible, play UNDER the current highest card so the bot
      // cannot win this (possibly point-laden) trick. Sheds the highest safe card.
      duckUnderTop: { enabled: true },

      // Never voluntarily capture the Black Queen — keep it back to sluff onto
      // an opponent later, unless the rules force the bot to throw it.
      neverTakeQueen: { enabled: true },
    },

    /* ===================================================================== *
     *  DISCARDING — bot is VOID in the led suit, so its card can't win.
     *  This is a free throwaway: get rid of the most dangerous card.
     *  Bigger weight = "shed this kind of card sooner".
     * ===================================================================== */
    discarding: {
      // Always dump the Black Queen the instant the bot is void (it's pure risk).
      dumpQueenFirst: { enabled: true },

      // Shed the Queen "magnets" — spades ABOVE the Queen (A♠/K♠) — while she's
      // still loose, before they can capture her.
      shedLooseSpadeMagnets: { enabled: true, weight: 100 },

      // Shed hearts (point cards). High hearts are worst, so the card's rank is
      // added on top of this base weight.
      shedHearts: { enabled: true, weight: 40 },

      // Shed high cards of side suits (they win future tricks and catch points).
      //   highCardThreshold → ranks at or above this count as "high" (default Q).
      //   weight            → how eager the bot is to get rid of them.
      shedHighSideSuit: { enabled: true, weight: 20, highCardThreshold: 'Q' },
    },

    /* ===================================================================== *
     *  PARTNERS — virtual pairs (scoring stays SOLO; this only changes how a
     *  bot plays, never any rule).
     *
     *  Seats are paired across the table: seat 1 & seat 3 are partners, and
     *  seat 2 & seat 4 are partners (so each bot's partner sits opposite). The
     *  bot only ever uses PUBLIC information — who has shown void in which suit,
     *  what has been played — never a peek at hidden hands. It implements the
     *  README "Pairs Strategy": set your partner up, dump the Queen on the
     *  opposing pair, and never pile points onto your own partner.
     * ===================================================================== */
    partners: {
      // Master switch for ALL partnership behavior. Turn off → bots play as
      // four independent solo players (the original behavior).
      enabled: true,

      // Don't undercut your own partner: if your partner is already winning a
      // harmless (point-free) trick, let them keep it instead of stealing it.
      letPartnerWin: { enabled: true },

      // Don't pile points onto your partner: when discarding while void, never
      // throw hearts or the Queen onto a trick your partner is winning — dump a
      // safe high card instead and save the penalties for an opponent's trick.
      // weight = how hard to avoid it (kept very high; this is a near-rule).
      protectPartner: { enabled: true, weight: 100000 },

      // Set up your partner's sluff (README tactics 1, 2, 6): lead a LOW card
      // into a suit your partner is VOID in, so an opponent is forced to win and
      // your partner can drop the Queen (or a heart) on them.
      leadPartnerVoid: { enabled: true, weight: 25 },

      // Starve the opponents: avoid leading a suit an OPPONENT is void in, which
      // would only hand them a free discard for their own penalty cards.
      avoidOpponentVoid: { enabled: true, weight: 15 },

      // Signal (README tactic 4): early in the round, holding no Queen and no
      // high spade, prefer leading a LOW spade to tell your partner you're safe
      // there (and to help draw the Queen toward an opponent).
      signalLowSpade: { enabled: true, weight: 8 },
    },
  };

  root.BQ = root.BQ || {};
  root.BQ.TACTICS = TACTICS;
})(typeof window !== "undefined" ? window : globalThis);
