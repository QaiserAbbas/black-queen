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
  root.BQ.shuffle = shuffle;
  root.BQ.deal = deal;
  root.BQ.sortHand = sortHand;
  root.BQ.rankValue = rankValue;
})(typeof window !== "undefined" ? window : globalThis);
