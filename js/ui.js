/* =============================================================================
 * Black Queen — UI LAYER
 * Subscribes to engine events and renders the table, hands, tricks, modals,
 * scoreboards and effects. All animation/feel lives here; rules live in config.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  // Seat order, clockwise starting from the human.
  const SEAT_ORDER = ['south', 'west', 'north', 'east'];

  class UI {
    constructor() {
      this.engine = null;
      this.seatOf = {};      // playerIndex -> seat name
      this.indexOfSeat = {}; // seat name -> playerIndex
      this.legalSet = new Set();
      this.activeIndex = -1;
      this._bindStaticControls();
      this._buildMenuFan();
      // Re-fan the hand whenever the viewport changes (rotate / resize), so the
      // cards always spread to use the available width.
      let raf = 0;
      window.addEventListener('resize', () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => this.layoutHumanHand());
      });
    }

    /* ---- screen routing --------------------------------------------------- */
    show(screenId) {
      $$('.screen').forEach((s) => s.classList.toggle('active', s.id === screenId));
    }

    /* ---- attach to a fresh engine ---------------------------------------- */
    attach(engine) {
      this.engine = engine;
      // Which player is "me"? Local single-player => 0; networked => engine.me.
      this.me = (engine.me != null) ? engine.me : 0;

      // Rotate seats so that "me" always sits at the south (bottom) seat.
      const n = engine.players.length;
      this.seatOf = {}; this.indexOfSeat = {};
      engine.players.forEach((p, i) => {
        const seat = SEAT_ORDER[(((i - this.me) % n) + n) % n] || ('extra' + i);
        this.seatOf[i] = seat;
        this.indexOfSeat[seat] = i;
      });

      engine.on('roundStart', (e) => this.onRoundStart(e));
      engine.on('turn', (e) => this.onTurn(e));
      engine.on('cardPlayed', (e) => this.onCardPlayed(e));
      engine.on('trickWon', (e) => this.onTrickWon(e));
      engine.on('heartsBroken', () => this.flashHearts());
      engine.on('roundEnd', (e) => this.onRoundEnd(e));
      engine.on('gameOver', (e) => this.onGameOver(e));

      this.renderBadges();
    }

    /* ---- card DOM --------------------------------------------------------- */
    cardEl(card, faceUp) {
      const el = document.createElement('div');
      if (!faceUp) { el.className = 'card back'; return el; }
      el.className = 'card ' + card.color;
      el.dataset.id = card.id;
      const q = this.engine.rules.queenCard;
      if (card.rank === q.rank && card.suit === q.suit) el.classList.add('is-queen');
      el.innerHTML =
        '<div class="corner tl">' + card.rank + '<span>' + card.symbol + '</span></div>' +
        '<div class="pip">' + card.symbol + '</div>' +
        '<div class="corner br">' + card.rank + '<span>' + card.symbol + '</span></div>';
      return el;
    }

    /* ---- badges (avatars + score) ---------------------------------------- */
    renderBadges() {
      const e = this.engine;
      $$('.badge').forEach((b) => {
        const seat = b.dataset.seat;
        const idx = this.indexOfSeat[seat];
        if (idx === undefined) { b.style.display = 'none'; return; }
        b.style.display = '';
        const p = e.players[idx];
        // Does this player currently hold the Black Queen this round?
        // (A disregarded Queen — winner immune by score — doesn't count.)
        const stuck = (e.trickLog || []).some((h) => h.tookQueen && !h.queenDisregarded && h.winnerIndex === idx);
        const conceded = (p._penalty || 0);
        // Is this seat an AI/bot? (network: p.isBot; local: !isHuman)
        const isBot = (p.isBot != null) ? p.isBot : (p.isHuman === false);
        const isMe = (idx === this.me);
        const tag = isBot ? '<span class="bot-tag">🤖 BOT</span>'
                          : (isMe ? '<span class="you-tag">YOU</span>' : '');
        b.innerHTML =
          '<div class="avatar">' + p.name.charAt(0).toUpperCase() + '</div>' +
          '<div class="meta"><span class="pname">' + p.name + ' ' + tag +
          (stuck ? ' <span class="queen-tag">♛</span>' : '') + '</span>' +
          '<span class="pscore">' +
            '<span class="st" title="Total score"><b>' + p.totalScore + '</b> pts</span>' +
            '<span class="st" title="Hands won this round"><b>' + p.tricksWon + '</b> won</span>' +
            '<span class="st" title="Points conceded this round"><b>' + conceded + '</b> rnd</span>' +
          '</span></div>';
        b.classList.toggle('dealer', idx === e.dealerIndex);
        b.classList.toggle('stuck', stuck);
        b.classList.toggle('is-bot', isBot);
        b.classList.toggle('is-me', isMe);
      });
    }

    /* ---- round start: deal animation ------------------------------------- */
    onRoundStart(e) {
      $('#roundChip').textContent = 'Round ' + e.round;
      this.closeOverlay('roundOverlay');   // close last round's summary (multiplayer auto-advance)
      this.renderBadges();
      this._clearTrick();
      this.renderHumanHand([]);     // clear first
      // render opponent face-down stacks
      this.engine.players.forEach((p, i) => {
        if (i === this.me) return;
        this.renderFacedown(this.seatOf[i], p.hand.length);
      });
      BQ.Sound.shuffle();

      // staggered reveal of my own hand
      const human = this.engine.players[this.me];
      this.renderHumanHand(human.hand, true);
      BQ.Sound.deal();
    }

    renderFacedown(seat, count) {
      const wrap = $('[data-hand="' + seat + '"]');
      if (!wrap) return;
      wrap.innerHTML = '';
      for (let i = 0; i < count; i++) wrap.appendChild(this.cardEl(null, false));
    }

    renderHumanHand(hand, animate) {
      const wrap = $('#humanHand');
      wrap.innerHTML = '';
      BQ.sortHand(hand);
      hand.forEach((card, i) => {
        const el = this.cardEl(card, true);
        if (animate) {
          el.classList.add('dealing');
          el.style.setProperty('--dx', '0px');
          el.style.setProperty('--dy', '-220px');
          el.style.setProperty('--dr', (i - hand.length / 2) * 2 + 'deg');
          el.style.animationDelay = (i * 0.04) + 's';
          // tidy up: drop the animation class once it has played
          el.addEventListener('animationend', () => el.classList.remove('dealing'), { once: true });
        }
        el.addEventListener('click', () => this.onHumanCardClick(card.id, el));
        wrap.appendChild(el);
      });
      this.layoutHumanHand();
      this.applyPlayable();
    }

    /* Fan the hand to fill the available width: every card spread evenly so its
       top-left index stays visible and tappable, never overlapping more than
       necessary. Driven by card count + viewport, so it adapts to any screen. */
    layoutHumanHand() {
      const wrap = $('#humanHand');
      if (!wrap) return;
      const cards = $$('.card', wrap);
      const n = cards.length;
      if (!n) return;
      // Use the intended card width from CSS (not measured — avoids deal-anim scale).
      const cardW = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--card-w')) || 90;
      // The hand centers on screen and may overflow its column into the empty
      // side cells, so it can span almost the full viewport.
      const span = window.innerWidth * 0.94;
      let step = n > 1 ? (span - cardW) / (n - 1) : 0;     // gap between card lefts
      step = Math.min(step, cardW * 0.63);                 // cap overlap → keep an elegant fan on wide screens
      cards.forEach((el, i) => {
        el.style.marginLeft = i === 0 ? '0px' : (step - cardW) + 'px';
      });
    }

    /* ---- turn handling ---------------------------------------------------- */
    onTurn(e) {
      this.activeIndex = e.playerIndex;
      this.legalSet = new Set(e.legalCardIds);
      // highlight active badge
      $$('.badge').forEach((b) => {
        const idx = this.indexOfSeat[b.dataset.seat];
        b.classList.toggle('active', idx === e.playerIndex);
      });
      this.applyPlayable();
    }

    applyPlayable() {
      const wrap = $('#humanHand');
      const myTurn = this.activeIndex === this.me && this.engine.phase === 'awaitHuman';
      $$('.card', wrap).forEach((el) => {
        const playable = myTurn && this.legalSet.has(el.dataset.id);
        el.classList.toggle('playable', playable);
        el.classList.toggle('disabled', myTurn && !playable);
      });
    }

    onHumanCardClick(cardId, el) {
      if (this.activeIndex !== this.me || this.engine.phase !== 'awaitHuman') return;
      if (!this.legalSet.has(cardId)) {
        BQ.Sound.error();
        // If the only legal play is the Black Queen, say so explicitly.
        const q = this.engine.rules.queenCard;
        const queenId = q.rank + '_' + q.suit;
        if (this.legalSet.size === 1 && this.legalSet.has(queenId)) {
          this.toast('You must throw the Black Queen ♛');
        } else {
          this.toast('You must follow suit');
        }
        return;
      }
      this.engine.playHuman(cardId);
    }

    /* ---- card played: fly into trick ------------------------------------- */
    onCardPlayed(e) {
      // New trick? clear the previous one from the felt.
      if (e.trick.length === 1) this._clearTrick();

      const seat = this.seatOf[e.playerIndex];

      // remove a card from that player's visible hand
      if (e.playerIndex === this.me) {
        const el = $('#humanHand .card[data-id="' + e.card.id + '"]');
        if (el) el.remove();
      } else {
        const wrap = $('[data-hand="' + seat + '"]');
        if (wrap && wrap.lastChild) wrap.lastChild.remove();
      }

      // place into trick slot
      const slot = document.createElement('div');
      slot.className = 'slot ' + seat;
      const card = this.cardEl(e.card, true);
      card.style.animation = 'playPop 0.3s ease';
      slot.appendChild(card);
      $('#trick').appendChild(slot);

      BQ.Sound.play();
      this.renderBadges();
    }

    onTrickWon(e) {
      const seat = this.seatOf[e.winnerIndex];
      const name = this.engine.players[e.winnerIndex].name;
      const who = (e.winnerIndex === this.me) ? 'You' : name;
      if (e.tookQueen && e.queenDisregarded) {
        // Rule: winner is immune by score — Queen points disregarded.
        BQ.Sound.trickWin();
        const extra = e.points > 0 ? ' (still +' + e.points + ' ♥)' : '';
        this.handResult('Hand ' + e.handNo, who + ' caught ♛ — disregarded' + extra, '♛', false);
      } else if (e.tookQueen) {
        BQ.Sound.penalty();
        this.handResult('Hand ' + e.handNo, who + ' stuck with ♛ (+' + this.engine.rules.queenPoints + ')', '♛', true);
      } else if (e.points > 0) {
        BQ.Sound.penalty();
        this.handResult('Hand ' + e.handNo, who + ' concede' + (who === 'You' ? '' : 's') + ' ' + e.points + ' pts', e.points, false);
      } else {
        BQ.Sound.trickWin();
        this.handResult('Hand ' + e.handNo, who + ' win' + (who === 'You' ? '' : 's') + ' the hand', '✦', false);
      }
      // The completed hand STAYS on the table. We just mark the winning card so
      // it's clear who took it; it is cleared only when the next lead is played.
      $$('#trick .slot').forEach((s) => {
        s.classList.add('settled');
        if (s.classList.contains(seat)) s.classList.add('winner');
      });
      this.renderBadges();
    }

    _clearTrick() { $('#trick').innerHTML = ''; }

    flashHearts() {
      const f = $('#heartsFlash');
      f.classList.add('show');
      setTimeout(() => f.classList.remove('show'), 1400);
    }

    /* ---- round end -------------------------------------------------------- */
    onRoundEnd(e) {
      BQ.Sound.roundEnd();
      this.renderBadges();
      const tbody = e.breakdown.map((b) => {
        const p = this.engine.players[b.playerIndex];
        const note = b.notes.length ? b.notes.join('; ') : '—';
        const cls = b.score < 0 ? 'neg' : (b.score > 0 ? 'pos' : '');
        const stuckReal = b.tookQueen && !b.queenDisregarded;
        const queen = b.tookQueen
          ? (b.queenDisregarded ? ' <span class="queen-tag void">♛✕</span>' : ' <span class="queen-tag">♛</span>')
          : '';
        // breakdown of conceded cards: hearts + (queen?)
        const split = (b.raw > 0 || b.tookQueen)
          ? (b.hearts + '♥' + (stuckReal ? ' + ♛' + this.engine.rules.queenPoints : (b.tookQueen ? ' + ♛0 (void)' : '')))
          : '—';
        return '<tr class="' + (stuckReal ? 'stuck-row' : '') + '"><td class="name">' + p.name + queen + '</td>' +
          '<td>' + b.raw + '</td>' +
          '<td style="font-size:0.78rem;color:#cfe6d6">' + split + '</td>' +
          '<td class="' + cls + '">' + (b.score >= 0 ? '+' : '') + b.score + '</td>' +
          '<td>' + p.totalScore + '</td>' +
          '<td style="text-align:left;color:#bfe0c9;font-size:0.8rem">' + note + '</td></tr>';
      }).join('');
      $('#roundSummaryTable').innerHTML =
        '<thead><tr><th style="text-align:left">Player</th><th>Pts</th><th>From</th><th>Round</th><th>Total</th><th style="text-align:left">Notes</th></tr></thead>' +
        '<tbody>' + tbody + '</tbody>';
      $('#roundTitle').textContent = 'Round ' + e.round + ' Complete';

      // If the game is over, the engine already emitted gameOver; don't show next.
      if (this.engine.phase === 'gameOver') return;
      this.openOverlay('roundOverlay');
    }

    /* ---- game over -------------------------------------------------------- */
    onGameOver(e) {
      this.closeOverlay('roundOverlay');
      const won = e.winnerIndex === this.me;
      $('#gameOverTitle').textContent = won ? '🏆 You Win!' : '🎴 Game Over';

      const places = ['first', 'second', 'third', 'fourth'];
      const medals = ['🥇', '🥈', '🥉', '4️⃣'];
      $('#podium').innerHTML = e.ranking.map((r, i) =>
        '<div class="place ' + (places[i] || 'fourth') + '">' +
        '<div class="rank">' + (medals[i] || '') + '</div>' +
        '<div style="font-weight:700">' + r.name + '</div>' +
        '<div style="color:#cfe6d6">' + r.score + ' pts</div></div>'
      ).join('');

      $('#finalTable').innerHTML =
        '<thead><tr><th>#</th><th style="text-align:left">Player</th><th>Final Score</th></tr></thead><tbody>' +
        e.ranking.map((r, i) =>
          '<tr><td>' + (i + 1) + '</td><td class="name">' + r.name + '</td><td>' + r.score + '</td></tr>'
        ).join('') + '</tbody>';

      this.openOverlay('gameOverOverlay');
      if (won) { BQ.Sound.win(); this.confetti(); } else { BQ.Sound.lose(); }
    }

    /* ---- scoreboard modal ------------------------------------------------- */
    renderScoreboard() {
      const e = this.engine;
      const sorted = e.players.slice().sort((a, b) =>
        e.rules.lowestScoreWins ? a.totalScore - b.totalScore : b.totalScore - a.totalScore);
      $('#totalsTable').innerHTML =
        '<thead><tr><th>#</th><th style="text-align:left">Player</th><th>Total</th><th>♛ stuck</th></tr></thead><tbody>' +
        sorted.map((p, i) =>
          '<tr><td>' + (i + 1) + '</td><td class="name ' + (i === 0 ? 'leader' : '') + '">' +
          p.name + (i === 0 ? ' 👑' : '') + '</td><td>' + p.totalScore + '</td>' +
          '<td>' + (p.queenTakes > 0 ? '<span class="queen-tag">♛ ×' + p.queenTakes + '</span>' : '—') + '</td></tr>'
        ).join('') + '</tbody>';

      const rounds = e.players[0].roundHistory.length;
      let head = '<thead><tr><th style="text-align:left">Player</th>';
      for (let r = 1; r <= rounds; r++) head += '<th>R' + r + '</th>';
      head += '<th>Σ</th></tr></thead>';
      const body = e.players.map((p) =>
        '<tr><td class="name">' + p.name + '</td>' +
        p.roundHistory.map((s) =>
          '<td class="' + (s < 0 ? 'neg' : (s > 0 ? 'pos' : '')) + '">' + (s >= 0 ? '+' : '') + s + '</td>'
        ).join('') +
        '<td style="font-weight:700">' + p.totalScore + '</td></tr>'
      ).join('');
      $('#roundsTable').innerHTML = rounds
        ? head + '<tbody>' + body + '</tbody>'
        : '<tbody><tr><td style="color:#bfe0c9">No rounds played yet.</td></tr></tbody>';

      this.renderHandCard();
    }

    /* ---- hand-by-hand scorecard for the current round -------------------- */
    renderHandCard() {
      const e = this.engine;
      const players = e.players;
      const log = e.trickLog || [];

      // ---- Summary per player: hands won, points conceded, Queen status ----
      $('#handTotalsTable').innerHTML =
        '<thead><tr><th style="text-align:left">Player</th><th>Hands won</th><th>Conceded</th><th>Queen</th></tr></thead><tbody>' +
        players.map((p, i) => {
          const stuck = log.some((h) => h.tookQueen && !h.queenDisregarded && h.winnerIndex === i);
          const voided = log.some((h) => h.tookQueen && h.queenDisregarded && h.winnerIndex === i);
          const queenCell = stuck ? '<span class="queen-tag">♛ stuck</span>'
                          : voided ? '<span class="queen-tag void">♛ void (≥' + (e.rules.queenExemptScore != null ? e.rules.queenExemptScore : 80) + ')</span>'
                          : '—';
          return '<tr><td class="name">' + p.name + '</td>' +
            '<td>' + p.tricksWon + '</td>' +
            '<td class="' + ((p._penalty || 0) > 0 ? 'pos' : '') + '">' + (p._penalty || 0) + '</td>' +
            '<td>' + queenCell + '</td></tr>';
        }).join('') + '</tbody>';

      // ---- Matrix: every hand × points each player conceded -----------------
      const head =
        '<thead><tr><th>Hand</th>' +
        players.map((p) => '<th>' + p.name + '</th>').join('') +
        '<th style="text-align:left">Led / Note</th></tr></thead>';

      const bodyRows = log.length
        ? log.map((h) => {
            const cells = players.map((p, idx) => {
              const c = h.concede[idx];
              const isQ = h.queenTaker === idx;
              const qMark = isQ ? (h.queenDisregarded ? ' <span class="queen-tag void">♛✕</span>' : ' <span class="queen-tag">♛</span>') : '';
              const inner = (c > 0 ? '+' + c : '·') + qMark;
              return '<td class="' + (c > 0 ? 'pos' : '') + (isQ && !h.queenDisregarded ? ' queen-cell' : '') + '">' + inner + '</td>';
            }).join('');
            const lead = h.cards[0] ? (h.cards[0].name + ' led ' + h.cards[0].label) : '';
            const note = h.tookQueen
              ? (h.queenDisregarded ? (h.winnerName + ' caught ♛ — disregarded (≥' + (e.rules.queenExemptScore != null ? e.rules.queenExemptScore : 80) + ')') : (h.winnerName + ' stuck with ♛'))
              : (h.points > 0 ? (h.winnerName + ' took ' + h.points) : '');
            return '<tr><td>' + h.handNo + '</td>' + cells +
              '<td style="text-align:left;font-size:0.78rem;color:#cfe6d6">' + (note || lead) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="' + (players.length + 2) + '" style="color:#bfe0c9">No hands played yet this round.</td></tr>';

      // totals row (sum conceded this round)
      const totalsRow = log.length
        ? '<tr class="totals-row"><td>Σ</td>' +
            players.map((p, idx) => {
              const t = log.reduce((s, h) => s + h.concede[idx], 0);
              return '<td>' + t + '</td>';
            }).join('') +
            '<td style="text-align:left">of ' + e.rules.expectedRoundTotal + '</td></tr>'
        : '';

      $('#handLogTable').innerHTML = head + '<tbody>' + bodyRows + totalsRow + '</tbody>';
    }

    /* ---- overlays --------------------------------------------------------- */
    openOverlay(id) { $('#' + id).classList.add('show'); }
    closeOverlay(id) { $('#' + id).classList.remove('show'); }

    /* ---- toast + confetti ------------------------------------------------- */
    toast(msg) {
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      $('#fx').appendChild(t);
      requestAnimationFrame(() => t.classList.add('show'));
      setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 1600);
    }

    // Small popup in the top-right corner announcing the result of a hand.
    handResult(title, body, icon, isQueen) {
      const el = $('#handResult');
      if (!el) return;
      el.className = 'hand-result' + (isQueen ? ' queen' : '');
      el.innerHTML =
        '<div class="hr-icon">' + icon + '</div>' +
        '<div class="hr-text"><span class="hr-title">' + title + '</span>' +
        '<span class="hr-body">' + body + '</span></div>';
      // restart the show animation
      void el.offsetWidth;
      el.classList.add('show');
      clearTimeout(this._handResultTimer);
      this._handResultTimer = setTimeout(() => el.classList.remove('show'), 2600);
    }

    confetti() {
      const fx = $('#fx');
      const colors = ['#e9c46a', '#c0392b', '#2ecc71', '#3498db', '#fff', '#ffd877'];
      for (let i = 0; i < 140; i++) {
        const c = document.createElement('div');
        c.className = 'confetti';
        c.style.left = Math.random() * 100 + 'vw';
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = (2 + Math.random() * 2.5) + 's';
        c.style.animationDelay = (Math.random() * 0.6) + 's';
        c.style.transform = 'rotate(' + (Math.random() * 360) + 'deg)';
        fx.appendChild(c);
        setTimeout(() => c.remove(), 5000);
      }
    }

    /* ---- menu fan decoration --------------------------------------------- */
    _buildMenuFan() {
      const fan = $('#menuFan');
      if (!fan) return;
      const cards = [
        { r: 'A', s: '♠', red: false }, { r: 'K', s: '♥', red: true },
        { r: 'Q', s: '♠', red: false }, { r: 'J', s: '♦', red: true },
        { r: '10', s: '♣', red: false },
      ];
      const n = cards.length;
      cards.forEach((c, i) => {
        const el = document.createElement('div');
        el.className = 'mini' + (c.red ? ' red' : '');
        el.textContent = c.r + c.s;
        const angle = (i - (n - 1) / 2) * 12;
        el.style.transform = 'translateX(-50%) rotate(' + angle + 'deg) translateY(' + Math.abs(angle) * 0.6 + 'px)';
        fan.appendChild(el);
      });
    }

    /* ---- static control wiring (close buttons etc.) ---------------------- */
    _bindStaticControls() {
      document.addEventListener('click', (ev) => {
        const close = ev.target.getAttribute && ev.target.getAttribute('data-close');
        if (close) this.closeOverlay(close);
      });
    }
  }

  BQ.UI = UI;
})(window);
