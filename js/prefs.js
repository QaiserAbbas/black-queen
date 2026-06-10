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
    cardScale: 1,        // 0.7 – 1.4 multiplier on your own hand
    table: 'classic',
    cardBack: 'crimson',
    cardFace: 'classic',
    preSelect: false,    // allow staging a card before your turn
    fx: true,            // big cinematic effects (queen takeover, banners, rains)
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
  }

  BQ.Prefs = {
    TABLES, BACKS, FACES, DEFAULTS,
    get() { return prefs; },
    set(patch) { Object.assign(prefs, patch); save(); apply(); },
    reset() { prefs = Object.assign({}, DEFAULTS); save(); apply(); },
    apply,
  };
})(typeof window !== 'undefined' ? window : globalThis);
