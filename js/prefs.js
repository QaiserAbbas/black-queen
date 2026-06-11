/* =============================================================================
 * Black Queen — PERSONAL APPEARANCE PREFERENCES
 * -----------------------------------------------------------------------------
 * Per-player, client-side only (localStorage) — every player can use their own
 * card scale, table felt, card back and card face template without affecting
 * anyone else at the table. Applied via data-attributes + CSS variables.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ = root.BQ || {};
  const KEY = 'bq_prefs';

  /* ---- Table felt themes -------------------------------------------------- */
  const TABLES = [
    { id: 'classic',  label: 'Emerald Felt' },
    { id: 'midnight', label: 'Midnight Blue' },
    { id: 'crimson',  label: 'Crimson Lounge' },
    { id: 'charcoal', label: 'Charcoal Slate' },
    { id: 'royal',    label: 'Royal Purple' },
    { id: 'sand',     label: 'Desert Sand' },
  ];

  /* ---- Card back designs --------------------------------------------------- */
  const BACKS = [
    { id: 'crimson', label: 'Crimson Weave' },
    { id: 'navy',    label: 'Navy Stripe' },
    { id: 'emerald', label: 'Emerald Lattice' },
    { id: 'gold',    label: 'Gold Crest' },
    { id: 'plum',    label: 'Plum Diamond' },
    { id: 'ocean',   label: 'Ocean Wave' },
    { id: 'slate',   label: 'Slate Grid' },
    { id: 'rose',    label: 'Rose Quartz' },
    { id: 'teal',    label: 'Teal Deco' },
    { id: 'noir',    label: 'Noir Queen' },
  ];

  /* ---- Card face templates ------------------------------------------------- */
  const FACES = [
    { id: 'classic',  label: 'Classic Deck (illustrated)' },
    { id: 'simple',   label: 'Simple (big & clean)' },
    { id: 'contrast', label: 'Night (high contrast)' },
  ];

  const DEFAULTS = {
    cardScale: 1,        // 0.7 – 2.0 multiplier on your own hand
    handScroll: true,    // big hands scroll horizontally instead of over-squeezing
    trickScale: 1,       // 0.7 – 1.6 multiplier on the played cards in the center
    table: 'classic',
    cardBack: 'crimson',
    cardFace: 'classic',
    preSelect: false,    // allow staging a card before your turn
    mobileMode: 'auto',  // 'auto' | 'on' | 'off' — thumb-friendly mobile UI
    fx: true,            // big cinematic effects (queen takeover, banners, rains)
    attacks: true,       // show/hear attack taunts (lion, bomb…) — mute per player
    smash: 'punch',      // card-smash style for ⌘/Ctrl-click (punch/fire/bolt/ice/bomb)
    smashVoice: true,    // voice shout ("Kaboom!") on smash
    // per-style shortcut: HOLD the key while clicking a card to slam with that
    // style (rebindable via the key chips in the emote-panel picker)
    smashKeys: { punch: '1', fire: '2', bolt: '3', ice: '4', bomb: '5' },
    music: 'lounge',     // ambient music style (see BQ.Sound.MUSIC_TRACKS)
    musicPrev: 'lounge', // last non-off style, restored by the 🎵 mute toggle
    // per-channel volumes, 0..1 (Settings → Sound Volumes)
    volumes: { master: 1, music: 1, cards: 1, punch: 1, fx: 1, ui: 1 },
  };

  let prefs = load();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      return Object.assign({}, DEFAULTS, saved);
    } catch (_) { return Object.assign({}, DEFAULTS); }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  // Push the current prefs into the DOM (CSS picks the rest up).
  function apply() {
    const body = document.body;
    if (!body) return;
    body.dataset.table = prefs.table;
    body.dataset.back = prefs.cardBack;
    body.dataset.face = prefs.cardFace;
    document.documentElement.style.setProperty('--card-scale', prefs.cardScale);
    document.documentElement.style.setProperty('--trick-scale', prefs.trickScale);
    body.classList.toggle('hand-scroll', !!prefs.handScroll);
  }

  BQ.Prefs = {
    TABLES, BACKS, FACES, DEFAULTS,
    get() { return prefs; },
    set(patch) { Object.assign(prefs, patch); save(); apply(); },
    reset() { prefs = Object.assign({}, DEFAULTS); save(); apply(); },
    apply,
  };
})(typeof window !== 'undefined' ? window : globalThis);
