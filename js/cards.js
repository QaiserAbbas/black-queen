/* =============================================================================
 * Black Queen — CARDS & DECK
 * Pure data + helpers. No DOM, no rules. Safe to unit-test in isolation.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
  const SUIT_SYMBOL = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
  const SUIT_COLOR = { spades: 'black', clubs: 'black', hearts: 'red', diamonds: 'red' };

  // 2..10, J, Q, K, A  — index also doubles as comparable strength (Ace high).
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  function rankValue(rank) {
    return RANKS.indexOf(rank); // 0..12, Ace = 12 (highest)
  }

  class Card {
    constructor(rank, suit) {
      this.rank = rank;
      this.suit = suit;
      this.id = rank + '_' + suit;        // stable unique id
      this.symbol = SUIT_SYMBOL[suit];
      this.color = SUIT_COLOR[suit];
      this.value = rankValue(rank);
    }
    is(rank, suit) { return this.rank === rank && this.suit === suit; }
    get label() { return this.rank + this.symbol; }
  }

  function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push(new Card(rank, suit));
      }
    }
    return deck;
  }

  // TREEKY: combine `count` full decks into one pile (default 2 => every card
  // appears twice). Each physical copy needs a UNIQUE id so the engine can tell
  // the two "3♠" apart in a hand; we suffix the copy number onto the base id.
  function buildTreekyDeck(count) {
    const decks = Math.max(1, count || 2);
    const cards = [];
    for (let d = 0; d < decks; d++) {
      for (const suit of SUITS) {
        for (const rank of RANKS) {
          const c = new Card(rank, suit);
          c.id = rank + '_' + suit + '#' + d;   // e.g. "3_spades#0", "3_spades#1"
          cards.push(c);
        }
      }
    }
    return cards;
  }

  // Rebuild a Card from a snapshot, preserving its (possibly suffixed) id so
  // Treeky's two-deck identities survive a round-trip over the wire.
  function cardFrom(data) {
    const c = new Card(data.rank, data.suit);
    if (data.id) c.id = data.id;
    return c;
  }

  // Fisher–Yates shuffle (in place), returns the same array for chaining.
  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // Deal evenly into `n` hands (round-robin). Returns array of card arrays.
  function deal(deck, n) {
    const hands = Array.from({ length: n }, () => []);
    deck.forEach((card, i) => hands[i % n].push(card));
    hands.forEach(sortHand);
    return hands;
  }

  // Sort a hand for tidy display: by suit, then by rank.
  function sortHand(hand) {
    const suitOrder = { spades: 0, hearts: 1, clubs: 2, diamonds: 3 };
    hand.sort((a, b) =>
      suitOrder[a.suit] - suitOrder[b.suit] || a.value - b.value
    );
    return hand;
  }

  root.BQ = root.BQ || {};
  root.BQ.SUITS = SUITS;
  root.BQ.RANKS = RANKS;
  root.BQ.SUIT_SYMBOL = SUIT_SYMBOL;
  root.BQ.Card = Card;
  root.BQ.buildDeck = buildDeck;
  root.BQ.buildTreekyDeck = buildTreekyDeck;
  root.BQ.cardFrom = cardFrom;
  root.BQ.shuffle = shuffle;
  root.BQ.deal = deal;
  root.BQ.sortHand = sortHand;
  root.BQ.rankValue = rankValue;
})(typeof window !== "undefined" ? window : globalThis);
