/* =============================================================================
 * BLUFF — UI LAYER
 * -----------------------------------------------------------------------------
 * Subscribes to a BluffEngine (or BluffNetworkEngine — same event contract) and
 * renders the table: opponent badges around the felt, the face-down pile + the
 * current claim banner, my fanned hand (selectable), a rank picker, the Play
 * action, and the "Bluff!" / "Let it go" challenge controls. It knows nothing
 * about rules — it reacts to engine events and calls engine.playClaim / challenge
 * / passChallenge, so the SAME code runs for local single-player and online.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const SYM = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
  const COLOR = { spades: 'black', clubs: 'black', hearts: 'red', diamonds: 'red' };
  const RANK_FILE = { A: 'ace', J: 'jack', Q: 'queen', K: 'king' };
  const FACE_FAILED = new Set();

  function cardFile(card) { return (RANK_FILE[card.rank] || card.rank) + '_of_' + card.suit + '.svg'; }
  function applyTextFace(el, card) {
    el.style.backgroundImage = '';
    el.classList.add('tpl', 'tpl-simple');
    const sym = SYM[card.suit];
    el.innerHTML =
      '<span class="ci tl">' + card.rank + '<i>' + sym + '</i></span>' +
      '<span class="cs">' + sym + '</span>' +
      '<span class="ci br">' + card.rank + '<i>' + sym + '</i></span>';
  }
  function applyFace(el, card) {
    const face = (BQ.Prefs && BQ.Prefs.get().cardFace) || 'classic';
    if (face !== 'classic') return applyTextFace(el, card);
    const file = 'cards/' + cardFile(card);
    if (FACE_FAILED.has(file)) return applyTextFace(el, card);
    el.style.backgroundImage = "url('" + file + "')";
    const probe = new Image();
    probe.onerror = () => { FACE_FAILED.add(file); applyTextFace(el, card); };
    probe.src = file;
  }

  // "3 × 7" — claim count and rank, with a rank word for readability.
  function claimText(claim) {
    if (!claim) return '';
    return claim.count + ' × ' + rankWord(claim.rank);
  }
  function rankWord(rank) {
    const map = { A: 'Aces', K: 'Kings', Q: 'Queens', J: 'Jacks' };
    return map[rank] || (rank + 's');
  }

  class BluffUI {
    constructor() {
      this.engine = null;
      this.me = 0;
      this.spectator = false;
      this.selected = new Set();   // card ids selected to play this turn
      this.claimRank = null;       // the rank I'm claiming this turn
      this._armed = false;         // selection initialised for the current turn
      this._bound = false;
      this._revealTimer = null;
    }

    show(screenId) {
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === screenId));
    }

    attach(engine) {
      this.engine = engine;
      this.me = (engine.me != null) ? engine.me : 0;
      this.spectator = !!engine.spectator;
      document.body.classList.toggle('spectating', this.spectator);
      this.selected = new Set();
      this.claimRank = null;
      this._armed = false;

      engine.on('gameStart', () => { this.closeOver(); this.fullRender(); });
      engine.on('resync', () => this.fullRender());
      engine.on('turn', () => this.onTurn());
      engine.on('cardPlayed', (e) => this.onCardPlayed(e));
      engine.on('challengeWindow', (e) => this.onChallengeWindow(e));
      engine.on('challengePassed', (e) => this.onChallengePassed(e));
      engine.on('challengeResolved', (e) => this.onChallengeResolved(e));
      engine.on('playerFinished', (e) => this.onPlayerFinished(e));
      engine.on('gameOver', (e) => this.onGameOver(e));

      this.bindControls();
      this.buildRankRow();
      this.fullRender();
    }

    /* ---- one-time control wiring ----------------------------------------- */
    bindControls() {
      if (this._bound) return;
      this._bound = true;
      $('#blBtnPlay') && $('#blBtnPlay').addEventListener('click', () => this.commitPlay());
      $('#blBtnDoubt') && $('#blBtnDoubt').addEventListener('click', () => this.engine && this.engine.challenge(this.me));
      $('#blBtnLetGo') && $('#blBtnLetGo').addEventListener('click', () => this.engine && this.engine.passChallenge(this.me));
      $('#blHand') && $('#blHand').addEventListener('click', (ev) => {
        const el = ev.target.closest('.card.face');
        if (el && el.dataset.id) this.toggleCard(el.dataset.id);
      });
      $('#blRankRow') && $('#blRankRow').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-rank]');
        if (b) this.pickRank(b.getAttribute('data-rank'));
      });
    }

    buildRankRow() {
      const row = $('#blRankRow');
      if (!row || row.childElementCount) return;
      row.innerHTML = BQ.RANKS.map((r) => '<button class="bl-rank" data-rank="' + r + '">' + r + '</button>').join('');
    }

    /* ---- card DOM --------------------------------------------------------- */
    cardEl(card, faceUp) {
      const el = document.createElement('div');
      if (!faceUp || !card) { el.className = 'card back'; return el; }
      el.className = 'card face ' + (COLOR[card.suit] || 'black');
      el.dataset.id = card.id;
      applyFace(el, card);
      return el;
    }

    /* ---- full repaint ----------------------------------------------------- */
    fullRender() {
      const e = this.engine;
      if (!e || !e.players || !e.players.length) return;
      this.renderSeats();
      this.renderMyBadge();
      this.renderMyHand();
      this.renderPile();
      this.updateControls();
    }

    amHost() { return (this.engine && this.engine.youAreHost !== undefined) ? !!this.engine.youAreHost : true; }

    // Opponents (everyone but me), in play order starting just after me.
    otherIndexes() {
      const e = this.engine, n = e.players.length, out = [];
      const start = (this.me >= 0) ? this.me : -1;
      for (let k = 1; k <= n; k++) {
        const i = (((start + k) % n) + n) % n;
        if (i === this.me) continue;
        out.push(i);
      }
      return out;
    }

    renderSeats() {
      const e = this.engine;
      const wrap = $('#blSeats');
      if (!wrap) return;
      wrap.innerHTML = '';
      const others = this.otherIndexes();
      const N = others.length + 1;            // include me (the bottom slot, 90°)
      const cx = 50, cy = 46, rx = 42, ry = 38;
      others.forEach((idx, j) => {
        const p = e.players[idx];
        const deg = 90 + (j + 1) * (360 / N);
        const rad = deg * Math.PI / 180;
        const x = Math.max(9, Math.min(91, cx + rx * Math.cos(rad)));
        const y = cy + ry * Math.sin(rad);
        const seat = document.createElement('div');
        seat.className = 'tk-seat'
          + (y > 64 ? ' lower' : '')
          + (idx === e.currentPlayerIndex && e.phase !== 'gameOver' ? ' active' : '')
          + (e.claim && idx === e.claim.by ? ' claimer' : '')
          + (p.finished ? ' finished' : '');
        seat.dataset.seat = idx;
        seat.style.left = x + '%';
        seat.style.top = y + '%';
        seat.innerHTML = this.badgeHtml(p) + this.fanHtml((p.hand || []).length, p.finished);
        wrap.appendChild(seat);
      });
    }

    renderMyBadge() {
      const host = $('#blMySeat');
      if (!host) return;
      const e = this.engine;
      const me = (this.me >= 0) ? e.players[this.me] : null;
      if (!me) { host.innerHTML = ''; host.classList.remove('active'); return; }
      host.classList.toggle('active', e.currentPlayerIndex === this.me && e.phase !== 'gameOver');
      host.innerHTML = this.badgeHtml(me, true);
    }

    badgeHtml(p, isMe) {
      const e = this.engine;
      const isBot = (p.isBot != null) ? p.isBot : (p.isHuman === false);
      const isDealer = e && e.dealerIndex === p.index;
      const count = (p.hand || []).filter(Boolean).length;
      const cls = 'tk-badge' + (isMe ? ' is-me' : '') + (isBot ? ' is-bot' : '') + (isDealer ? ' dealer' : '');
      const tag = p.offline ? '<span class="bot-tag">⚠️ OFF</span>'
        : isBot ? '<span class="bot-tag">🤖 BOT</span>'
        : (isMe ? '<span class="you-tag">YOU</span>' : '');
      const dot = '<span class="tk-dot' + (isBot ? ' bot' : '') + '"></span>';
      let stats, statCls = 'tk-bstats';
      if (p.finished) { stats = '<b>' + ordinal(p.finishRank) + '</b> · done'; statCls += ' fin'; }
      else { stats = '<b>' + count + '</b> card' + (count === 1 ? '' : 's'); if (count === 1) statCls += ' one'; }
      return '<div class="' + cls + '">' +
        '<div class="tk-ava">' + escapeHtml((p.name || '?').slice(0, 1).toUpperCase()) + '</div>' +
        '<div class="tk-bmeta">' +
          '<span class="tk-bname"><span class="nm">' + escapeHtml(p.name || '') + '</span>' + tag + dot + '</span>' +
          '<span class="' + statCls + '">' + stats + '</span>' +
        '</div></div>';
    }

    seatAnchor(seatIndex) {
      const el = (seatIndex === this.me)
        ? document.querySelector('#blMySeat .tk-badge')
        : document.querySelector('#blSeats .tk-seat[data-seat="' + seatIndex + '"] .tk-badge');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }

    refreshCards() { this.fullRender(); }

    // Live standings: finishers first (in order), then the rest by fewest cards.
    renderStandings() {
      const e = this.engine;
      const body = $('#blStandingsBody');
      if (!body || !e.players) return;
      const finished = (e.finishedOrder || []).map((i) => e.players[i]);
      const playing = e.players.filter((p) => !p.finished)
        .sort((a, b) => ((a.hand || []).length - (b.hand || []).length) || (a.index - b.index));
      body.innerHTML = finished.concat(playing).map((p) => {
        const cnt = (p.hand || []).filter(Boolean).length;
        const right = p.finished ? (ordinal(p.finishRank) + ' · finished') : (cnt + ' card' + (cnt === 1 ? '' : 's'));
        return '<div class="tk-rank-row' + (p.finished && p.finishRank === 1 ? ' winner' : '') + '">' +
          '<span class="tk-medal">' + (p.finished ? medal(p.finishRank) : '🃏') + '</span>' +
          '<span class="tk-rank-name">' + escapeHtml(p.name) + (p.index === this.me ? ' (you)' : '') + '</span>' +
          '<span class="tk-rank-tag">' + right + '</span></div>';
      }).join('');
    }

    fanHtml(count, finished) {
      if (finished || count <= 0) return '<div class="tk-fan"></div>';
      const show = Math.min(count, 12);
      let s = '<div class="tk-fan">';
      for (let i = 0; i < show; i++) s += '<div class="card back"></div>';
      return s + '</div>';
    }

    renderMyHand() {
      const e = this.engine;
      const dock = $('#blHand');
      if (!dock) return;
      dock.innerHTML = '';
      if (this.me < 0) { dock.style.display = 'none'; return; }   // spectator
      dock.style.display = '';
      const me = e.players[this.me];
      const hand = (me && me.hand) ? me.hand.filter(Boolean) : [];
      const myTurn = e.canPlay(this.me);
      dock.classList.toggle('my-turn', !!myTurn);
      hand.forEach((card) => {
        const el = this.cardEl(card, true);
        if (this.selected.has(card.id)) el.classList.add('sel');
        if (!myTurn) el.classList.add('disabled');
        dock.appendChild(el);
      });
    }

    // The face-down pile (count only) + the current claim banner.
    renderPile() {
      const e = this.engine;
      const pile = $('#blPile');
      if (pile) {
        const n = e.pileCount ? e.pileCount() : 0;
        pile.classList.toggle('empty', n === 0);
        const cnt = $('#blPileCount');
        if (cnt) cnt.textContent = n + '';
      }
      const banner = $('#blClaim');
      if (banner) {
        if (e.claim) {
          banner.style.display = '';
          banner.innerHTML = '<span class="bl-claim-who">' + escapeHtml(nameOf(e, e.claim.by)) + '</span> claims ' +
            '<span class="bl-claim-what">' + claimText(e.claim) + '</span>';
        } else {
          banner.style.display = 'none';
          banner.innerHTML = '';
        }
      }
    }

    /* ---- the rank picker + selection ------------------------------------- */
    pickRank(rank) {
      if (!this.engine.canPlay(this.me)) return;
      this.claimRank = rank;
      this.syncRankRow();
      this.syncPlayBtn();
    }
    syncRankRow() {
      document.querySelectorAll('#blRankRow .bl-rank').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-rank') === this.claimRank));
    }
    toggleCard(id) {
      const e = this.engine;
      if (!e.canPlay(this.me)) return;
      if (this.selected.has(id)) this.selected.delete(id);
      else {
        if (this.selected.size >= e.maxClaimFor(this.me)) { this.toast('Up to ' + e.maxClaimFor(this.me) + ' cards'); return; }
        this.selected.add(id);
      }
      this.renderMyHand();
      this.syncPlayBtn();
    }
    syncPlayBtn() {
      const btn = $('#blBtnPlay');
      if (!btn) return;
      const ok = this.selected.size > 0 && this.claimRank;
      btn.disabled = !ok;
      btn.textContent = ok
        ? ('Play ' + this.selected.size + ' as ' + rankWord(this.claimRank))
        : (this.selected.size ? 'Pick a rank to claim' : 'Select card(s) to play');
    }
    commitPlay() {
      const e = this.engine;
      if (!e.canPlay(this.me) || !this.selected.size || !this.claimRank) return;
      const ids = Array.from(this.selected);
      const rank = this.claimRank;
      this.selected = new Set();
      e.playClaim(this.me, rank, ids);
    }

    // Default the claim to the rank we hold the most of (easy honest play).
    defaultRank() {
      const me = this.engine.players[this.me];
      if (!me || !me.hand) return BQ.RANKS[0];
      const g = {};
      me.hand.filter(Boolean).forEach((c) => { g[c.rank] = (g[c.rank] || 0) + 1; });
      let best = BQ.RANKS[0], n = -1;
      for (const r in g) if (g[r] > n) { n = g[r]; best = r; }
      return best;
    }

    /* ---- bottom controls -------------------------------------------------- */
    updateControls() {
      const e = this.engine;
      const status = $('#blStatus');
      const me = this.me >= 0 ? e.players[this.me] : null;
      const myTurn = e.canPlay(this.me);
      const canDoubt = e.canChallenge(this.me);

      // Fresh turn → arm a clean selection + a sensible default claim.
      if (myTurn) {
        if (!this._armed) { this.selected = new Set(); this.claimRank = this.defaultRank(); this._armed = true; }
      } else { this._armed = false; }

      setShown($('#blRankRow'), myTurn);
      setShown($('#blBtnPlay'), myTurn);
      setShown($('#blDoubtRow'), canDoubt);
      if (myTurn) { this.syncRankRow(); this.syncPlayBtn(); }

      if (status) {
        if (this.me < 0) status.textContent = '👁 Spectating';
        else if (me && me.finished) status.textContent = '✓ You finished — ' + ordinal(me.finishRank) + ' place. Watching…';
        else if (myTurn) status.textContent = 'Your turn — place cards face down and claim a rank.';
        else if (canDoubt) status.textContent = 'Call “Bluff!” or let it go.';
        else if (e.phase === 'awaitChallenge') status.textContent = 'Doubt window — ' + waitingName(e, true) + '…';
        else status.textContent = waitingName(e);
      }
    }

    /* ---- event reactions -------------------------------------------------- */
    onTurn() { this.fullRender(); }

    onCardPlayed(ev) {
      this.renderSeats();
      this.renderMyBadge();
      this.renderPile();
      if (ev.playerIndex === this.me) this.renderMyHand();
      if (ev.playerIndex !== this.me) {
        this.toast(nameOf(this.engine, ev.playerIndex) + ' played ' + ev.count + ' · claims ' + rankWord(ev.rank));
      }
      if (BQ.Sound && BQ.Sound.whoosh) BQ.Sound.whoosh();
    }

    onChallengeWindow() {
      this.renderPile();
      this.updateControls();
    }

    onChallengePassed(ev) {
      if (ev.playerIndex !== this.me) this.toast(nameOf(this.engine, ev.playerIndex) + ' let it go');
      this.updateControls();
    }

    onChallengeResolved(ev) {
      const e = this.engine;
      const who = nameOf(e, ev.challenger);
      const claimer = nameOf(e, ev.by);
      if (ev.wasBluff) {
        this.toast('🔍 ' + who + ' caught ' + claimer + ' bluffing! ' + claimer + ' picks up the pile');
      } else {
        this.toast('✅ Truthful — those were ' + rankWord(ev.rank) + '. ' + who + ' picks up the pile');
      }
      if (BQ.Sound) { if (ev.wasBluff && BQ.Sound.error) BQ.Sound.error(); else if (BQ.Sound.pop) BQ.Sound.pop(); }
      this.showReveal(ev.revealed, ev.wasBluff, ev.rank);
      this.renderSeats();
      this.renderMyBadge();
      this.renderMyHand();
      this.renderPile();
    }

    // Flip the challenged cards face up for a moment so everyone sees the truth.
    showReveal(cards, wasBluff, rank) {
      const box = $('#blReveal');
      if (!box) return;
      clearTimeout(this._revealTimer);
      box.innerHTML = '';
      box.className = 'bl-reveal ' + (wasBluff ? 'lie' : 'truth');
      (cards || []).forEach((c) => box.appendChild(this.cardEl(BQ.cardFrom(c), true)));
      const tag = document.createElement('div');
      tag.className = 'bl-reveal-tag';
      tag.textContent = wasBluff ? 'BLUFF — not ' + rankWord(rank) : 'TRUE — ' + rankWord(rank);
      box.appendChild(tag);
      box.classList.add('show');
      this._revealTimer = setTimeout(() => { box.classList.remove('show'); box.innerHTML = ''; }, 2400);
    }

    onPlayerFinished(ev) {
      this.renderSeats();
      this.renderMyBadge();
      this.toast('🏁 ' + ev.name + ' went out — ' + ordinal(ev.rank) + '!');
      if (ev.playerIndex === this.me) { this.renderMyHand(); this.updateControls(); }
    }

    onGameOver(ev) {
      const body = $('#blOverBody');
      if (body) {
        body.innerHTML = ev.ranking.map((r) =>
          '<div class="tk-rank-row' + (r.rank === ev.ranking.length ? ' loser' : (r.rank === 1 ? ' winner' : '')) + '">' +
            '<span class="tk-medal">' + medal(r.rank) + '</span>' +
            '<span class="tk-rank-name">' + escapeHtml(r.name) + '</span>' +
            '<span class="tk-rank-tag">' + (r.rank === ev.ranking.length ? 'last' : ordinal(r.rank)) + '</span>' +
          '</div>'
        ).join('');
      }
      $('#blOverOverlay') && $('#blOverOverlay').classList.add('show');
    }

    closeOver() {
      const o = $('#blOverOverlay'); if (o) o.classList.remove('show');
      const rv = $('#blReveal'); if (rv) { rv.classList.remove('show'); rv.innerHTML = ''; }
    }

    toast(msg) {
      const host = $('#fx') || document.body;
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 1800);
    }
  }

  /* ---- small helpers ------------------------------------------------------ */
  function setShown(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function medal(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🃏'; }
  function nameOf(e, i) { return (e.players[i] && e.players[i].name) || 'Player'; }
  function waitingName(e, claimer) {
    const idx = (claimer && e.claim) ? null : e.currentPlayerIndex;
    if (claimer && e.claim) return 'players are deciding';
    const p = e.players[idx];
    return p ? ('Waiting for ' + p.name) : 'Waiting';
  }

  BQ.BluffUI = BluffUI;
})(typeof window !== "undefined" ? window : globalThis);
