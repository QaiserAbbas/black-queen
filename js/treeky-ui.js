/* =============================================================================
 * TREEKY — UI LAYER
 * -----------------------------------------------------------------------------
 * Subscribes to a TreekyEngine (or TreekyNetworkEngine — same event contract)
 * and renders the shedding table: a row of opponent badges (3–10 players), a
 * central draw + discard pile, my fanned hand, the suit picker, the pending-draw
 * badge, the "Last Card!" call, and the final results. Knows nothing about
 * rules — it just reacts to engine events and calls engine.playHuman / drawForTurn
 * / pass / declareLast, so the SAME code runs for local single-player and online.
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

  class TreekyUI {
    constructor() {
      this.engine = null;
      this.me = 0;
      this.spectator = false;
      this.pendingJackId = null;   // a Jack waiting on the suit picker
      this.lastTurn = null;        // last 'turn' payload (for re-render)
      this._bound = false;
    }

    show(screenId) {
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === screenId));
    }

    attach(engine) {
      this.engine = engine;
      this.me = (engine.me != null) ? engine.me : 0;
      this.spectator = !!engine.spectator;
      document.body.classList.toggle('spectating', this.spectator);
      this.pendingJackId = null;
      this.lastTurn = null;

      engine.on('gameStart', () => { this.closeOver(); this.fullRender(); });
      engine.on('resync', () => this.fullRender());
      engine.on('turn', (e) => this.onTurn(e));
      engine.on('cardPlayed', (e) => this.onCardPlayed(e));
      engine.on('suitChosen', (e) => this.onSuitChosen(e));
      engine.on('cardsDrawn', (e) => this.onCardsDrawn(e));
      engine.on('lastCardDeclared', (e) => this.onLastCardDeclared(e));
      engine.on('needReshuffle', () => this.showReshuffle());
      engine.on('reshuffled', () => { this.hideReshuffle(); this.renderPile(); this.toast('🔄 Deck reshuffled'); });
      engine.on('chooseSuit', (e) => { if (e.playerIndex === this.me) this.openSuitPicker(null); });
      engine.on('playerFinished', (e) => this.onPlayerFinished(e));
      engine.on('gameOver', (e) => this.onGameOver(e));

      this.bindControls();
      this.fullRender();
    }

    /* ---- one-time control wiring ----------------------------------------- */
    bindControls() {
      if (this._bound) return;
      this._bound = true;
      const draw = () => this.engine && this.engine.drawForTurn(this.me);
      $('#tkBtnDraw') && $('#tkBtnDraw').addEventListener('click', draw);
      $('#tkDraw') && $('#tkDraw').addEventListener('click', draw);
      $('#tkBtnPass') && $('#tkBtnPass').addEventListener('click', () => this.engine && this.engine.pass(this.me));
      $('#tkBtnLast') && $('#tkBtnLast').addEventListener('click', () => {
        if (this.engine && this.engine.declareLast(this.me)) this.flashLastBtn();
      });
      $('#tkReshuffleBtn') && $('#tkReshuffleBtn').addEventListener('click', () => this.engine && this.engine.reshuffle());
      document.querySelectorAll('#suitPickerOverlay [data-suit]').forEach((b) => {
        b.addEventListener('click', () => this.pickSuit(b.getAttribute('data-suit')));
      });
      // Cancel the Jack: close the picker WITHOUT playing, so a different card
      // can be chosen. Clicking the dim backdrop cancels too.
      $('#suitCancel') && $('#suitCancel').addEventListener('click', () => this.cancelSuit());
      const ov = $('#suitPickerOverlay');
      if (ov) ov.addEventListener('click', (e) => { if (e.target === ov) this.cancelSuit(); });
      // delegated clicks on my hand
      $('#tkHand') && $('#tkHand').addEventListener('click', (ev) => {
        const el = ev.target.closest('.card.face');
        if (el && el.dataset.id) this.tryPlay(el.dataset.id);
      });
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
      if (this.lastTurn) this.onTurn(this.lastTurn);
      else this.updateControls();
      // reflect a pending reshuffle (e.g. for a reconnecting / late-joining client)
      if (e.phase === 'awaitReshuffle') this.showReshuffle(); else this.hideReshuffle();
    }

    // Am I the table owner? (local single-player engine has no host concept → yes)
    amHost() { return (this.engine && this.engine.youAreHost !== undefined) ? !!this.engine.youAreHost : true; }

    showReshuffle() {
      const ov = $('#tkReshuffleOverlay'); if (!ov) return;
      const host = this.amHost() && this.me >= 0;     // spectators never reshuffle
      const btn = $('#tkReshuffleBtn'), wait = $('#tkReshuffleWait');
      if (btn) btn.style.display = host ? '' : 'none';
      if (wait) wait.style.display = host ? 'none' : '';
      ov.classList.add('show');
    }
    hideReshuffle() {
      const ov = $('#tkReshuffleOverlay'); if (ov) ov.classList.remove('show');
    }

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

    // Opponents seated around the FULL felt (Black-Queen style cross): me at the
    // bottom, the k opponents spread evenly across the top + both sides — so 3
    // opponents land at left / top / right, using the whole space.
    renderSeats() {
      const e = this.engine;
      const wrap = $('#tkSeats');
      if (!wrap) return;
      wrap.innerHTML = '';
      const others = this.otherIndexes();
      const k = others.length;
      const N = k + 1;                       // include me (the bottom slot, 90°)
      const cx = 50, cy = 46, rx = 42, ry = 38;
      others.forEach((idx, j) => {
        const p = e.players[idx];
        const deg = 90 + (j + 1) * (360 / N); // bottom-anchored, evenly spaced
        const rad = deg * Math.PI / 180;
        const x = Math.max(9, Math.min(91, cx + rx * Math.cos(rad)));
        const y = cy + ry * Math.sin(rad);
        const seat = document.createElement('div');
        seat.className = 'tk-seat'
          + (y > 64 ? ' lower' : '')           // only flip fan/badge for near-bottom seats
          + (idx === e.currentPlayerIndex && e.phase !== 'gameOver' ? ' active' : '')
          + (p.finished ? ' finished' : '');
        seat.dataset.seat = idx;
        seat.style.left = x + '%';
        seat.style.top = y + '%';
        seat.innerHTML = this.badgeHtml(p) + this.fanHtml((p.hand || []).length, p.finished);
        wrap.appendChild(seat);
      });
    }

    // My own seat badge, anchored at the bottom of the felt (in front of my hand).
    renderMyBadge() {
      const host = $('#tkMySeat');
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

    // Screen coords of a seat's badge (for attack/taunt FX positioning).
    seatAnchor(seatIndex) {
      const el = (seatIndex === this.me)
        ? document.querySelector('#tkMySeat .tk-badge')
        : document.querySelector('#tkSeats .tk-seat[data-seat="' + seatIndex + '"] .tk-badge');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }

    // Re-render everything (used after an appearance change).
    refreshCards() { this.fullRender(); }

    // Live standings: finishers first (in order), then the rest by fewest cards.
    renderStandings() {
      const e = this.engine;
      const body = $('#tkStandingsBody');
      if (!body || !e.players) return;
      const finished = (e.finishedOrder || []).map((i) => e.players[i]);
      const playing = e.players.filter((p) => !p.finished)
        .sort((a, b) => ((a.hand || []).length - (b.hand || []).length) || (a.index - b.index));
      body.innerHTML = finished.concat(playing).map((p) => {
        const cnt = (p.hand || []).filter(Boolean).length;
        const right = p.finished ? (ordinal(p.finishRank) + ' · finished') : (cnt + ' card' + (cnt === 1 ? '' : 's'));
        return '<div class="tk-rank-row' + (p.finished && p.finishRank === 1 ? ' winner' : '') + '">' +
          '<span class="tk-medal">' + (p.finished ? medal(p.finishRank) : '🎴') + '</span>' +
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
      const dock = $('#tkHand');
      if (!dock) return;
      dock.innerHTML = '';
      if (this.me < 0) { dock.style.display = 'none'; return; }   // spectator
      dock.style.display = '';
      const me = e.players[this.me];
      const hand = (me && me.hand) ? me.hand.filter(Boolean) : [];
      hand.forEach((card) => dock.appendChild(this.cardEl(card, true)));
      this.highlightLegal(this.lastTurn);
    }

    renderPile() {
      const e = this.engine;
      const disc = $('#tkDiscard');
      if (disc) {
        disc.innerHTML = '';
        const top = e.discardPile && e.discardPile[e.discardPile.length - 1];
        if (top) disc.appendChild(this.cardEl(top, true));
      }
      const suit = $('#tkSuit');
      if (suit) {
        suit.textContent = e.activeSuit ? SYM[e.activeSuit] : '';
        suit.className = 'tk-suit ' + (COLOR[e.activeSuit] || '');
      }
      const dc = $('#tkDrawCount');
      if (dc) dc.textContent = (e.drawPile ? e.drawPile.length : 0) + '';
      this.renderPending(e.pendingDraw || 0);
    }

    renderPending(n) {
      const el = $('#tkPending');
      if (!el) return;
      if (n > 0) { el.style.display = ''; el.textContent = '+' + n + ' to draw'; }
      else el.style.display = 'none';
    }

    /* ---- turn handling ---------------------------------------------------- */
    onTurn(ev) {
      this.lastTurn = ev;
      const e = this.engine;
      // seat glow (opponents + my own badge)
      document.querySelectorAll('#tkSeats .tk-seat').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.seat) === e.currentPlayerIndex && e.phase !== 'gameOver');
      });
      const my = $('#tkMySeat');
      if (my) my.classList.toggle('active', e.currentPlayerIndex === this.me && this.me >= 0 && e.phase !== 'gameOver');
      this.renderPending(ev.pendingDraw || 0);
      this.refreshPileMeta();
      this.highlightLegal(ev);
      this.updateControls();
    }

    refreshPileMeta() {
      const e = this.engine;
      const suit = $('#tkSuit');
      if (suit) { suit.textContent = e.activeSuit ? SYM[e.activeSuit] : ''; suit.className = 'tk-suit ' + (COLOR[e.activeSuit] || ''); }
      const dc = $('#tkDrawCount');
      if (dc) dc.textContent = (e.drawPile ? e.drawPile.length : 0) + '';
    }

    highlightLegal(ev) {
      const dock = $('#tkHand');
      if (!dock) return;
      const myTurn = ev && ev.playerIndex === this.me && this.me >= 0;
      const legal = new Set((myTurn && ev.legalCardIds) || []);
      dock.classList.toggle('my-turn', !!myTurn);
      Array.from(dock.querySelectorAll('.card.face')).forEach((el) => {
        const ok = myTurn && legal.has(el.dataset.id);
        el.classList.toggle('legal', ok);
        el.classList.toggle('disabled', myTurn && !ok);
      });
    }

    updateControls() {
      const e = this.engine, ev = this.lastTurn;
      const bar = $('#tkControls');
      const myTurn = ev && ev.playerIndex === this.me && this.me >= 0 && e.phase !== 'gameOver';
      const me = this.me >= 0 ? e.players[this.me] : null;

      const hasLegal = !!(ev && ev.legalCardIds && ev.legalCardIds.length);
      const showDraw = !!(myTurn && ev.canDraw);
      const showPass = !!(myTurn && ev.canPass);
      // Only offer the call when you can actually play your second-to-last card now.
      const showLast = !!(myTurn && me && me.hand && me.hand.filter(Boolean).length === 2 && hasLegal);

      setShown($('#tkBtnDraw'), showDraw);
      if (showDraw) $('#tkBtnDraw').textContent = ev.pendingDraw > 0 ? ('Draw ' + ev.pendingDraw) : 'Draw a card';
      setShown($('#tkBtnPass'), showPass);
      setShown($('#tkBtnLast'), showLast);
      $('#tkDraw') && $('#tkDraw').classList.toggle('drawable', showDraw);

      const status = $('#tkStatus');
      if (status) {
        if (this.me < 0) status.textContent = '👁 Spectating';
        else if (me && me.finished) status.textContent = '✓ You finished — ' + ordinal(me.finishRank) + ' place. Watching…';
        else if (myTurn) {
          if (ev.canPass) status.textContent = 'Throw a card or pass.';
          else if (ev.pendingDraw > 0) status.textContent = 'Under attack! Play a 3 or draw ' + ev.pendingDraw + '.';
          else if (hasLegal) status.textContent = 'Your turn — throw a card or draw.';
          else status.textContent = 'No playable card — draw.';
        } else status.textContent = waitingName(e);
      }
      if (bar) bar.style.display = (this.me < 0) ? 'none' : '';
    }

    /* ---- play / draw actions --------------------------------------------- */
    tryPlay(cardId) {
      const e = this.engine, ev = this.lastTurn;
      if (!ev || ev.playerIndex !== this.me || this.me < 0) return;
      if (!(ev.legalCardIds || []).includes(cardId)) { this.toast('You can’t play that now'); return; }
      const me = e.players[this.me];
      const card = (me.hand || []).find((c) => c && c.id === cardId);
      if (card && card.rank === e.rules.wildRank) { this.openSuitPicker(cardId); return; }
      e.playHuman(cardId);
    }

    openSuitPicker(cardId) {
      this.pendingJackId = cardId;            // may be null on the awaitSuit path
      $('#suitPickerOverlay') && $('#suitPickerOverlay').classList.add('show');
    }
    pickSuit(suit) {
      $('#suitPickerOverlay') && $('#suitPickerOverlay').classList.remove('show');
      const e = this.engine;
      if (this.pendingJackId) { const id = this.pendingJackId; this.pendingJackId = null; e.playHuman(id, suit); }
      else if (e.chooseSuit) { e.chooseSuit(this.me, suit); }
    }
    // Close the suit picker without committing the Jack — pick a different card.
    cancelSuit() {
      this.pendingJackId = null;
      const o = $('#suitPickerOverlay'); if (o) o.classList.remove('show');
    }

    /* ---- event reactions -------------------------------------------------- */
    onCardPlayed(ev) {
      this.renderSeats();
      this.renderMyBadge();
      this.renderPile();
      if (ev.playerIndex === this.me) this.renderMyHand();
      if (ev.isThree) {
        const n = this.engine.pendingDraw || 3;   // accumulated total (3, 6, 9, …)
        if (BQ.Sound) { if (BQ.Sound.whoosh) BQ.Sound.whoosh(); if (BQ.Sound.say) BQ.Sound.say('Pick ' + n + ' cards', { pitch: 1.2 }); }
        this.toast(nameOf(this.engine, ev.playerIndex) + ' played a 3 — pick ' + n + '!');
      } else if (ev.isJack) {
        this.toast(nameOf(this.engine, ev.playerIndex) + ' played a Jack 🃏');
      }
    }
    onSuitChosen(ev) {
      this.refreshPileMeta();
      this.renderPile();
      this.toast(nameOf(this.engine, ev.playerIndex) + ' chose ' + SYM[ev.suit]);
    }
    onCardsDrawn(ev) {
      this.renderSeats();
      this.renderMyBadge();
      this.refreshPileMeta();
      if (ev.playerIndex === this.me) this.renderMyHand();
      if (ev.count > 0) {
        const who = nameOf(this.engine, ev.playerIndex);
        if (ev.reason === 'missedLastCard') this.toast(who + ' forgot “Last Card!” — +' + ev.count);
        else if (ev.penalty) this.toast(who + ' drew ' + ev.count + ' cards');
      }
    }
    onLastCardDeclared(ev) {
      this.toast('🔔 ' + nameOf(this.engine, ev.playerIndex) + ': LAST CARD!');
      this.renderSeats();
    }
    onPlayerFinished(ev) {
      this.renderSeats();
      this.renderMyBadge();
      this.toast('🏁 ' + ev.name + ' finished — ' + ordinal(ev.rank) + '!');
      if (ev.playerIndex === this.me) { this.renderMyHand(); this.updateControls(); }
    }
    onGameOver(ev) {
      const body = $('#tkOverBody');
      if (body) {
        body.innerHTML = ev.ranking.map((r) =>
          '<div class="tk-rank-row' + (r.rank === ev.ranking.length ? ' loser' : (r.rank === 1 ? ' winner' : '')) + '">' +
            '<span class="tk-medal">' + medal(r.rank) + '</span>' +
            '<span class="tk-rank-name">' + escapeHtml(r.name) + '</span>' +
            '<span class="tk-rank-tag">' + (r.rank === ev.ranking.length ? 'last' : ordinal(r.rank)) + '</span>' +
          '</div>'
        ).join('');
      }
      $('#tkOverOverlay') && $('#tkOverOverlay').classList.add('show');
    }

    flashLastBtn() {
      const b = $('#tkBtnLast');
      if (b) { b.classList.add('called'); }
    }
    closeOver() {
      const o = $('#tkOverOverlay'); if (o) o.classList.remove('show');
      const s = $('#suitPickerOverlay'); if (s) s.classList.remove('show');
      this.hideReshuffle();
    }
    toast(msg) {
      const host = $('#fx') || document.body;
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      host.appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 1600);
    }
  }

  /* ---- small helpers ------------------------------------------------------ */
  function setShown(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function medal(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🃏'; }
  function nameOf(e, i) { return (e.players[i] && e.players[i].name) || 'Player'; }
  function waitingName(e) {
    const p = e.players[e.currentPlayerIndex];
    return p ? ('Waiting for ' + p.name + '…') : 'Waiting…';
  }

  BQ.TreekyUI = TreekyUI;
})(typeof window !== "undefined" ? window : globalThis);
