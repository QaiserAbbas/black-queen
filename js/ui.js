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

  // RULE 4 warning: once this many hands (tricks) have been played in a round
  // and a player still hasn't won one, flag them — they're on track for the
  // "no tricks taken" penalty, so other players can see the danger coming.
  const NO_TRICK_WARN_AFTER = 6;

  // Map a card to its vector image filename in /cards (Byron Knoll deck).
  const RANK_FILE = { A: 'ace', J: 'jack', Q: 'queen', K: 'king' };
  function cardFile(card) {
    return (RANK_FILE[card.rank] || card.rank) + '_of_' + card.suit + '.svg';
  }

  // Card images that failed to load (missing on the server, poisoned cache,
  // offline before they were cached) — those cards render the text template
  // instead, so a face is never a blank white rectangle.
  const FACE_FAILED = new Set();

  function applyTextFace(el, card, tpl) {
    el.style.backgroundImage = '';
    el.classList.add('tpl', 'tpl-' + (tpl || 'simple'));
    el.innerHTML =
      '<span class="ci tl">' + card.rank + '<i>' + card.symbol + '</i></span>' +
      '<span class="cs">' + card.symbol + '</span>' +
      '<span class="ci br">' + card.rank + '<i>' + card.symbol + '</i></span>';
  }

  function applyClassicFace(el, card) {
    const file = 'cards/' + cardFile(card);
    if (FACE_FAILED.has(file)) return applyTextFace(el, card);
    el.style.backgroundImage = "url('" + file + "')";
    // Probe the image (served from the browser's cache when it's fine) and
    // swap this card to the text template the moment a load fails.
    const probe = new Image();
    probe.onerror = () => {
      FACE_FAILED.add(file);
      applyTextFace(el, card);
    };
    probe.src = file;
  }

  class UI {
    constructor() {
      this.engine = null;
      this.seatOf = {};      // playerIndex -> seat name
      this.indexOfSeat = {}; // seat name -> playerIndex
      this.legalSet = new Set();
      this.activeIndex = -1;
      this.stagedId = null;   // pre-selected card (plays automatically on my turn)
      this.peers = [];        // live presence info from the server
      this.voiceState = {};   // playerIndex -> { talking, signal, peerMuted, self, muted }
      this._bindStaticControls();
      this._buildMenuFan();
      // Tapping a member's voice chip toggles mute (own mic for self, that
      // member's incoming audio for others). Delegated so it survives the
      // badge re-renders that recreate the chip.
      const game = $('#game');
      if (game) game.addEventListener('click', (ev) => {
        const chip = ev.target.closest && ev.target.closest('.voice-chip');
        if (!chip || !BQ.Voice) return;
        ev.stopPropagation();
        if (chip.dataset.self === '1') BQ.Voice.toggleMute();
        else BQ.Voice.togglePeerMute(parseInt(chip.dataset.seat, 10));
      });
      // Smash shortcut keys: HOLD a style's key (1–5 by default, rebindable in
      // the emote panel) while clicking a card to slam it with that style.
      // Tracked here so the card click handler can read the held style.
      this._heldSmash = null;
      window.addEventListener('keydown', (ev) => {
        if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const keys = (BQ.Prefs && BQ.Prefs.get().smashKeys) || {};
        const k = ev.key.toLowerCase();
        for (const style in keys) {
          if (keys[style] === k) { this._heldSmash = style; return; }
        }
      });
      window.addEventListener('keyup', (ev) => {
        if (!this._heldSmash) return;
        const keys = (BQ.Prefs && BQ.Prefs.get().smashKeys) || {};
        if (keys[this._heldSmash] === ev.key.toLowerCase()) this._heldSmash = null;
      });
      // released outside the page (tab switch, screenshot tools…)
      window.addEventListener('blur', () => { this._heldSmash = null; });

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
      // A spectator has me = -1: no seat is "mine", so every hand renders
      // face-down through the opponent path and nothing is ever playable.
      this.me = (engine.me != null) ? engine.me : 0;
      this.spectator = !!engine.spectator;
      document.body.classList.toggle('spectating', this.spectator);

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
      engine.on('reshuffleOffer', (e) => this.onReshuffleOffer(e));
      engine.on('resync', () => this.resync());

      this.renderBadges();
    }

    /* ---- full repaint from current state (used when a player reconnects) -- */
    resync() {
      const e = this.engine;
      $('#roundChip').textContent = 'Round ' + (e.round || 1);
      this.closeOverlay('roundOverlay');
      this.closeOverlay('gameOverOverlay');
      this.closeOverlay('reshuffleOverlay');   // re-opens below if an offer is still pending
      this.renderBadges();
      // opponents' face-down stacks (others' hands are length-only placeholders)
      e.players.forEach((p, i) => {
        if (i === this.me) return;
        this.renderFacedown(this.seatOf[i], p.hand.length);
      });
      // my hand — no deal animation on a reconnect (spectators have no hand)
      if (e.players[this.me]) this.renderHumanHand(e.players[this.me].hand, false);
      // the in-progress trick already on the felt
      this._clearTrick();
      (e.currentTrick || []).forEach((play) => {
        const seat = this.seatOf[play.playerIndex];
        const slot = document.createElement('div');
        slot.className = 'slot ' + seat;
        slot.appendChild(this.cardEl(play.card, true));
        $('#trick').appendChild(slot);
      });
    }

    /* ---- "Reconnecting…" banner (transparent re-attach in progress) ------- */
    setReconnecting(on) {
      let el = document.getElementById('reconnectBanner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'reconnectBanner';
        el.className = 'reconnect-banner';
        el.innerHTML = '<span class="spin"></span><span>Reconnecting…</span>';
        document.body.appendChild(el);
      }
      el.classList.toggle('show', !!on);
      if (on) this.setNetStatus('reconnecting');
    }

    /* ---- connection status pill (toolbar): online + latency / offline ----- */
    setNetStatus(state, rtt) {
      const el = document.getElementById('netPill');
      if (!el) return;
      el.classList.remove('online', 'offline', 'reconnecting');
      el.classList.add(state);
      if (state === 'online') el.textContent = '🟢 ' + (rtt != null ? rtt + ' ms' : 'online');
      else if (state === 'reconnecting') el.textContent = '🟠 reconnecting…';
      else el.textContent = '🔴 offline';
    }

    /* ---- live presence: "3/4 online" chip + hover detail ------------------ */
    renderPeers(seats) {
      this.peers = seats || [];
      const el = document.getElementById('peersChip');
      if (!el) return;
      const humans = this.peers.filter((s) => !s.isBot || s.away);
      const online = humans.filter((s) => s.connected).length;
      const anyAway = this.peers.some((s) => s.away);
      el.textContent = '👥 ' + online + '/' + (humans.length || 1);
      el.classList.toggle('warn', anyAway);
      el.title = this.peers.map((s) =>
        s.name + (s.isBot ? ' — bot' : s.connected ? ' — online' : s.away ? ' — connection lost (bot covering)' : ' — offline')
        + (s.attacksMuted ? ' · 🛡️ taunts muted' : '')
      ).join('\n');
      // refresh the 🛡️ tags on the table badges
      if (this.engine && this.engine.players && this.engine.players.length) this.renderBadges();
    }

    /* ---- card DOM --------------------------------------------------------- */
    cardEl(card, faceUp) {
      const el = document.createElement('div');
      if (!faceUp) { el.className = 'card back'; return el; }
      el.className = 'card face ' + card.color;
      el.dataset.id = card.id;
      const q = this.engine.rules.queenCard;
      if (card.rank === q.rank && card.suit === q.suit) el.classList.add('is-queen');
      const face = (BQ.Prefs && BQ.Prefs.get().cardFace) || 'classic';
      if (face === 'classic') {
        // The face is the real vector card image from /cards — with the text
        // template as an automatic fallback if the image can't load.
        applyClassicFace(el, card);
      } else {
        // Text-based template (simple / high-contrast) — indices + center pip.
        applyTextFace(el, card, face);
      }
      return el;
    }

    /* ---- re-render my hand after an appearance change --------------------- */
    refreshCards() {
      const e = this.engine;
      if (!e || !e.players || !e.players.length) return;
      const me = e.players[this.me];
      if (me && me.hand) this.renderHumanHand(me.hand.filter(Boolean), false);
      this.layoutHumanHand();
    }

    /* ---- badges (avatars + score) ---------------------------------------- */
    renderBadges() {
      const e = this.engine;
      // VIRTUAL PARTNERS: scoring stays solo, but bots play as pairs across the
      // table (matching js/ai.js: partner = the seat n/2 around). Shown from the
      // human's view — your team gold, the opposing pair blue — only when the
      // partnership playbook is on AND the table is even (else no pairs exist).
      const n = e.players.length;
      const tacP = BQ.TACTICS && BQ.TACTICS.partners;
      const teamsActive = (!tacP || tacP.enabled !== false) && n % 2 === 0;
      const myPartner = teamsActive ? (this.me + n / 2) % n : -1;
      const TEAM_FRIEND = '#e9c46a', TEAM_FOE = '#5db7de';
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
        // Partnership pip + team-coloured avatar ring (see teamsActive above).
        let teamPip = '';
        if (teamsActive) {
          const mate = e.players[(idx + n / 2) % n];
          const mateName = mate ? mate.name : '';
          let color, tip;
          if (this.me < 0) {
            // Spectator: no "my" team — colour each pair distinctly so a watcher
            // can still see who's partnered with whom.
            const palette = ['#e9c46a', '#5db7de', '#e3779e', '#8fd17a'];
            color = palette[(idx % (n / 2)) % palette.length];
            tip = 'Paired with ' + mateName;
          } else {
            const isMyTeam = (idx === this.me) || (idx === myPartner);
            color = isMyTeam ? TEAM_FRIEND : TEAM_FOE;
            tip = isMe ? 'Your team — partnered with ' + mateName
                : isMyTeam ? 'Your partner' + (mateName ? ' (paired with ' + mateName + ')' : '')
                : 'Opponent pair — partnered with ' + mateName;
          }
          teamPip = ' <span class="team-pip" title="' + tip + '"></span>';
          b.style.setProperty('--team', color);
        }
        b.classList.toggle('has-team', teamsActive);
        // A dropped player's seat shows OFFLINE (a bot covers it until they return).
        const tag = p.offline ? '<span class="off-tag">⚠️ OFFLINE</span>'
                  : isBot ? '<span class="bot-tag">🤖 BOT</span>'
                  : (isMe ? '<span class="you-tag">YOU</span>' : '');
        // 🛡️ = this player muted attack taunts (taunting them is wasted)
        const peer = this.peers && this.peers[idx];
        const shield = (peer && peer.attacksMuted && !isBot)
          ? ' <span class="shield-tag" title="Attack taunts muted">🛡️</span>' : '';
        // RULE 5 warning: this player is on a zero-point streak that's one round
        // short of the limit, so another 0-point round costs them the penalty.
        // Show a pulsing "⚠ 0 0" tag (one 0 per streak round) so every player
        // knows that if this player ends the round on 0 again, it's -12.
        const zStreak = p.consecutiveZeros || 0;
        const zLimit = e.rules.consecutiveZeroLimit || 0;
        // Once they've picked up any points this round (conceded > 0) the streak
        // will reset at round-end, so they're no longer at risk — hide the tag.
        const atZeroRisk = !!e.rules.consecutiveZeroRuleEnabled && zLimit > 1 && zStreak >= zLimit - 1 && conceded === 0;
        // RULE 4 warning: this player has won no hand (trick) yet, and enough
        // hands have already been played this round that they're at risk of the
        // "no tricks taken" penalty. Show a pulsing "No Hands" tag.
        const tricksPlayed = (e.trickLog && e.trickLog.length) || 0;
        const atNoTrickRisk = !!e.rules.noTrickRuleEnabled &&
          tricksPlayed >= NO_TRICK_WARN_AFTER && (p.tricksWon || 0) === 0;
        const zeroTag = atZeroRisk
          ? ' <span class="zero-streak-tag" title="' + zStreak +
            ' zero-point rounds in a row — another 0 this round means ' +
            e.rules.consecutiveZeroPenalty + ' points!">⚠ ' +
            new Array(zStreak).fill('0').join(' ') + '</span>'
          : '';
        const noTrickTag = atNoTrickRisk
          ? ' <span class="no-trick-tag" title="No hands won in ' + tricksPlayed +
            ' hands — risks ' + e.rules.noTrickPenalty +
            ' points for taking no tricks this round!">⚠ No Hands</span>'
          : '';
        b.innerHTML =
          '<div class="avatar">' + p.name.charAt(0).toUpperCase() + '</div>' +
          '<div class="meta"><span class="pname">' + p.name + ' ' + tag + teamPip + shield +
          (stuck ? ' <span class="queen-tag">♛</span>' : '') + zeroTag + noTrickTag + '</span>' +
          '<span class="pscore">' +
            '<span class="st" title="Total score"><b>' + p.totalScore + '</b> pts</span>' +
            '<span class="st" title="Hands won this round"><b>' + p.tricksWon + '</b> won</span>' +
            '<span class="st" title="Points conceded this round"><b>' + conceded + '</b> rnd</span>' +
          '</span></div>';
        b.classList.toggle('dealer', idx === e.dealerIndex);
        b.classList.toggle('stuck', stuck);
        b.classList.toggle('zero-risk', atZeroRisk);
        b.classList.toggle('no-trick-risk', atNoTrickRisk);
        b.classList.toggle('is-bot', isBot);
        b.classList.toggle('is-me', isMe);
        b.classList.toggle('offline', !!p.offline);
        // re-apply any live voice indicator (innerHTML above wiped the chip)
        this._renderVoiceChip(b, idx);
      });
    }

    /* ---- voice chat per-member indicators -------------------------------- */
    // Pushed from BQ.Voice: talking glow, connection-signal bars, mute state.
    setVoiceMember(info) {
      if (!info) return;
      if (info.gone) delete this.voiceState[info.seat];
      else this.voiceState[info.seat] = info;
      const seatName = this.seatOf ? this.seatOf[info.seat] : null;
      const badge = seatName ? $('.badge[data-seat="' + seatName + '"]') : null;
      if (badge) this._renderVoiceChip(badge, info.seat);
    }

    // Wipe every voice indicator (call ended / left the room).
    clearVoice() {
      this.voiceState = {};
      $$('.voice-chip').forEach((c) => c.remove());
      $$('.badge.voice-talking').forEach((b) => b.classList.remove('voice-talking'));
    }

    _renderVoiceChip(badge, idx) {
      const info = this.voiceState[idx];
      let chip = badge.querySelector('.voice-chip');
      if (!info) { if (chip) chip.remove(); badge.classList.remove('voice-talking'); return; }
      if (!chip) { chip = document.createElement('span'); chip.className = 'voice-chip'; badge.appendChild(chip); }
      chip.dataset.seat = String(info.seat);
      chip.dataset.self = info.self ? '1' : '0';
      badge.classList.toggle('voice-talking', !!info.talking);

      let html;
      if (info.self) {
        chip.title = info.muted ? 'Your mic is muted — tap to unmute' : 'Your mic is live — tap to mute';
        html = '<span class="vmic' + (info.muted ? ' off' : '') + '">' + (info.muted ? '🔇' : '🎙️') + '</span>';
      } else if (info.signal === 'lost') {
        chip.title = 'Connection lost';
        html = '<span class="vsig lost" title="Connection lost">⚠</span>';
      } else {
        const bars = (typeof info.signal === 'number') ? info.signal : 0;
        chip.title = (info.peerMuted ? 'Muted by you · ' : '') +
          (bars === 0 ? 'Connecting…' : 'Signal ' + bars + '/3') + ' — tap to ' + (info.peerMuted ? 'unmute' : 'mute');
        html = '<span class="vsig b' + bars + '"><i></i><i></i><i></i></span>';
        if (info.peerMuted) html += '<span class="vmute">🔇</span>';
      }
      chip.innerHTML = html;
    }

    /* ---- round start: deal animation ------------------------------------- */
    onRoundStart(e) {
      $('#roundChip').textContent = 'Round ' + e.round;
      this.stagedId = null;                // a new deal voids any pre-selected card
      this.closeOverlay('roundOverlay');   // close last round's summary (multiplayer auto-advance)
      this.closeOverlay('reshuffleOverlay'); // a fresh deal: a pending offer re-opens after
      this.renderBadges();
      this._clearTrick();
      this.renderHumanHand([]);     // clear first
      // render opponent face-down stacks (dealt out from the center deck)
      this.engine.players.forEach((p, i) => {
        if (i === this.me) return;
        this.renderFacedown(this.seatOf[i], p.hand.length, true);
      });
      BQ.Sound.shuffle();

      // staggered reveal of my own hand (spectators have no hand of their own —
      // the south seat was already drawn face-down by the loop above)
      const human = this.engine.players[this.me];
      if (human) this.renderHumanHand(human.hand, true);
      BQ.Sound.deal();
    }

    renderFacedown(seat, count, animate) {
      const wrap = $('[data-hand="' + seat + '"]');
      if (!wrap) return;
      wrap.innerHTML = '';
      for (let i = 0; i < count; i++) wrap.appendChild(this.cardEl(null, false));
      if (animate) this._dealAnimate(wrap, 26);
    }

    /* ---- deal: every card flies + spins out from the center deck ---------- */
    _dealAnimate(wrap, stagger) {
      const cx = innerWidth / 2;
      const cy = innerHeight / 2;
      $$('.card', wrap).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const dx = cx - (r.left + r.width / 2);
        const dy = cy - (r.top + r.height / 2);
        el.animate([
          { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(' + ((i % 2 ? -1 : 1) * 160) + 'deg) scale(0.35)', opacity: 0.2 },
          { opacity: 1, offset: 0.4 },
          { transform: 'none', opacity: 1 },
        ], { duration: 460, delay: i * stagger, easing: 'cubic-bezier(.22,.9,.32,1)', fill: 'backwards' });
      });
    }

    renderHumanHand(hand, animate) {
      const wrap = $('#humanHand');
      wrap.innerHTML = '';
      BQ.sortHand(hand);
      hand.forEach((card) => {
        const el = this.cardEl(card, true);
        // Hold Ctrl/⌘ (or long-press on touch) while playing = HARD PUNCH slam.
        let longPress = false;
        let pressTimer = 0;
        el.addEventListener('pointerdown', () => {
          longPress = false;
          clearTimeout(pressTimer);
          pressTimer = setTimeout(() => { longPress = true; }, 450);
        });
        el.addEventListener('pointerup', () => clearTimeout(pressTimer));
        el.addEventListener('pointercancel', () => clearTimeout(pressTimer));
        el.addEventListener('click', (ev) => {
          const slam = !!(ev.ctrlKey || ev.metaKey || longPress);
          longPress = false;
          // a held shortcut key picks its style directly; ⌘/Ctrl/long-press
          // falls back to the selected style from the emote-panel picker
          const style = this._heldSmash ||
            (slam ? ((BQ.Prefs && BQ.Prefs.get().smash) || 'punch') : null);
          this.onHumanCardClick(card.id, el, style);
        });
        wrap.appendChild(el);
      });
      this.layoutHumanHand();
      this.applyPlayable();
      this.applyStaged();
      if (animate) this._dealAnimate(wrap, 42);
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
      // Use the intended card width from CSS (not measured — avoids deal-anim scale),
      // times the player's personal card-scale preference.
      const docStyle = getComputedStyle(document.documentElement);
      const scale = parseFloat(docStyle.getPropertyValue('--card-scale')) || 1;
      const cardW = (parseFloat(docStyle.getPropertyValue('--card-w')) || 90) * scale;
      // The hand centers on screen and may overflow its column into the empty
      // side cells, so it can span almost the full viewport — but never wider
      // than its own box: in scroll mode the strip is capped (max-width 96vw,
      // border-box) and carries its own padding, so spreading across a plain
      // 94vw overshot the box on narrow screens and left a few px of pointless
      // overflow-scroll (last card clipped, stray scrollbar).
      const wrapStyle = getComputedStyle(wrap);
      const pad = (parseFloat(wrapStyle.paddingLeft) || 0) + (parseFloat(wrapStyle.paddingRight) || 0);
      const cap = parseFloat(wrapStyle.maxWidth);          // NaN when 'none'
      let span = window.innerWidth * 0.94;
      if (!isNaN(cap)) span = Math.min(span, cap);
      span -= pad;
      let step = n > 1 ? (span - cardW) / (n - 1) : 0;     // gap between card lefts
      step = Math.min(step, cardW * 0.63);                 // cap overlap → keep an elegant fan on wide screens
      // Scroll mode: when cards would squeeze into slivers, overflow sideways
      // and scroll with half a card visible instead (body.hand-scroll CSS).
      // Only when genuinely cramped (under 40% of a card visible) — for a
      // near-fit, fitting beats a sliver of scrollbar.
      if (BQ.Prefs && BQ.Prefs.get().handScroll && step < cardW * 0.4) step = cardW * 0.52;
      cards.forEach((el, i) => {
        el.style.marginLeft = i === 0 ? '0px' : (step - cardW) + 'px';
      });
    }

    /* ---- trailing player's pre-deal reshuffle offer ----------------------- */
    onReshuffleOffer(e) {
      this.closeOverlay('roundOverlay');   // came straight off the round summary
      const mine = e.seat === this.me;
      const who = (this.engine.players[e.seat] || {}).name || 'A player';
      const actions = $('#reshuffleActions');
      const wait = $('#reshuffleWait');
      const msg = $('#reshuffleMsg');
      const dealBtn = $('#btnReshuffleDeal');
      if (mine) {
        if (actions) actions.style.display = '';
        if (wait) wait.style.display = 'none';
        if (msg) msg.textContent = "You have the most points — reshuffle the deck before the deal, or deal now.";
        const left = $('#reshuffleLeft');
        if (left) left.textContent = e.remaining;
        if (dealBtn) dealBtn.disabled = e.remaining <= 0;
      } else {
        if (actions) actions.style.display = 'none';
        if (wait) {
          wait.style.display = '';
          const nm = $('#reshuffleWaitName');
          if (nm) nm.textContent = who;
        }
        if (msg) msg.textContent = who + ' has the most points and may reshuffle the deck before the deal.';
      }
      this.openOverlay('reshuffleOverlay');
    }

    /* ---- turn handling ---------------------------------------------------- */
    onTurn(e) {
      this.closeOverlay('reshuffleOverlay'); // play has begun — any offer is settled
      this.activeIndex = e.playerIndex;
      this.legalSet = new Set(e.legalCardIds);
      // highlight active badge
      $$('.badge').forEach((b) => {
        const idx = this.indexOfSeat[b.dataset.seat];
        b.classList.toggle('active', idx === e.playerIndex);
      });
      this.applyPlayable();

      // My turn + a staged card: play it automatically (if it's legal).
      if (e.playerIndex === this.me && this.stagedId != null) {
        const id = this.stagedId;
        this.stagedId = null;
        this.applyStaged();
        if (this.legalSet.has(id)) {
          setTimeout(() => {
            if (this.activeIndex === this.me && this.engine.phase === 'awaitHuman' && this.legalSet.has(id)) {
              this.engine.playHuman(id);
            }
          }, 280);
        } else {
          this.toast('Pre-selected card not allowed now — pick another');
        }
      }
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

    /* ---- screen position of a player's badge (anchor for attack stamps) --- */
    seatAnchor(seatIndex) {
      const seatName = this.seatOf ? this.seatOf[seatIndex] : null;
      const el = seatName ? $('.seat.' + seatName + ' .badge') : null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    /* ---- emote / quick-message bubble at a player's seat ------------------ */
    showEmote(seatIndex, text, name, isEmoji) {
      const seatName = this.seatOf ? this.seatOf[seatIndex] : null;
      const seatEl = seatName ? $('.seat.' + seatName) : null;
      if (!seatEl || !$('#game').classList.contains('active')) {
        // Not at the table (e.g. lobby) — fall back to a toast.
        this.toast((name ? name + ': ' : '') + text);
        return;
      }
      let b = seatEl.querySelector('.emote-bubble');
      if (!b) {
        b = document.createElement('div');
        b.className = 'emote-bubble';
        seatEl.appendChild(b);
      }
      b.classList.toggle('big', !!isEmoji);
      b.textContent = text;   // textContent: player-typed text can never inject HTML
      void b.offsetWidth;     // restart the pop animation
      b.classList.add('show');
      clearTimeout(b._t);
      b._t = setTimeout(() => b.classList.remove('show'), isEmoji ? 2400 : 3600);
      // live-stream style: emoji reactions also float up across the screen
      if (isEmoji) { BQ.FX.floatEmoji(text, 6); BQ.Sound.pop(); }
    }

    /* ---- pre-select: stage a card before your turn, auto-play when it comes */
    applyStaged() {
      $$('#humanHand .card').forEach((el) =>
        el.classList.toggle('staged', this.stagedId != null && el.dataset.id === this.stagedId));
    }

    onHumanCardClick(cardId, el, smash) {
      if (this.activeIndex !== this.me || this.engine.phase !== 'awaitHuman') {
        // Not my turn: with "pre-select" on, stage the card (tap again to clear).
        if (BQ.Prefs && BQ.Prefs.get().preSelect) {
          this.stagedId = (this.stagedId === cardId) ? null : cardId;
          this.applyStaged();
          if (this.stagedId) this.toast('Pre-selected — plays when your turn comes');
        }
        return;
      }
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
      // _smashPending: consumed by onCardPlayed (engine emits synchronously in
      // single player; in multiplayer the server echoes the style in the hint).
      this._smashPending = smash || null;
      this.engine.playHuman(cardId, smash);
    }

    /* ---- card played: fly into trick ------------------------------------- */
    onCardPlayed(e) {
      // New trick? clear the previous one from the felt.
      if (e.trick.length === 1) this._clearTrick();

      const seat = this.seatOf[e.playerIndex];

      // capture WHERE the card leaves from before removing it from the hand
      let srcRect = null;
      let flip = false;                              // opponents' cards flip over mid-flight
      if (e.playerIndex === this.me) {
        const el = $('#humanHand .card[data-id="' + e.card.id + '"]');
        if (el) { srcRect = el.getBoundingClientRect(); el.remove(); }
      } else {
        const wrap = $('[data-hand="' + seat + '"]');
        if (wrap && wrap.lastChild) { srcRect = wrap.lastChild.getBoundingClientRect(); wrap.lastChild.remove(); }
        flip = true;
      }

      // the destination card in the trick (hidden until the flight lands)
      const slot = document.createElement('div');
      slot.className = 'slot ' + seat;
      const card = this.cardEl(e.card, true);
      slot.appendChild(card);
      $('#trick').appendChild(slot);

      // CARD SMASH: server hint for any player, local flag for single player.
      // e.smash carries the style ('punch'/'fire'/…); e.punch is the legacy flag.
      const smash = e.smash ||
        (e.playerIndex === this.me && this._smashPending) ||
        (e.punch ? 'punch' : null);
      if (e.playerIndex === this.me) this._smashPending = null;
      const punched = !!smash;

      const land = () => {
        if (smash) {
          card.classList.add('punched', 'smash-' + smash);
          BQ.Sound.smash(smash);
          BQ.FX.smash(smash, card);
        } else {
          BQ.Sound.play();
        }
      };

      const destRect = card.getBoundingClientRect();
      if (srcRect && destRect.width) {
        card.style.visibility = 'hidden';
        this._flyCard(e.card, srcRect, destRect, flip, punched, () => {
          card.style.visibility = '';
          land();
        });
      } else {
        card.style.animation = 'playPop 0.3s ease';
        land();
      }
      this.renderBadges();
    }

    /* ---- animate a card flying from a hand to its trick slot ---------------
       Opponents' cards travel as a 3D flip (back → face revealed mid-air);
       your own card arcs up and settles. Punched cards fly hard and fast.   */
    _flyCard(cardData, src, dst, flip, punched, onDone) {
      const fly = document.createElement('div');
      fly.className = 'fly-card';
      fly.style.left = dst.left + 'px';
      fly.style.top = dst.top + 'px';
      fly.style.width = dst.width + 'px';
      fly.style.height = dst.height + 'px';

      const inner = document.createElement('div');
      inner.className = 'fly-inner';
      const front = this.cardEl(cardData, true);
      front.classList.add('fly-face', 'fly-front');
      const back = this.cardEl(null, false);
      back.classList.add('fly-face', 'fly-back');
      inner.appendChild(front);
      inner.appendChild(back);
      fly.appendChild(inner);
      document.body.appendChild(fly);

      const dx = (src.left + src.width / 2) - (dst.left + dst.width / 2);
      const dy = (src.top + src.height / 2) - (dst.top + dst.height / 2);
      const sScale = dst.width ? (src.width / dst.width) : 1;
      const dur = punched ? 240 : 420;
      const lift = punched ? 14 : 52;                  // arc height

      const move = fly.animate([
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sScale + ')' },
        { transform: 'translate(' + (dx * 0.42) + 'px,' + (dy * 0.42 - lift) + 'px) scale(' + ((1 + sScale) / 2) * 1.05 + ')', offset: 0.55 },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: dur, easing: punched ? 'cubic-bezier(.5,0,.8,.4)' : 'cubic-bezier(.25,.7,.3,1)' });

      if (flip) {
        inner.animate(
          [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }],
          { duration: dur * 0.92, easing: 'ease-out' }
        );
      } else {
        inner.animate(
          [{ transform: 'rotate(-8deg)' }, { transform: 'rotate(3deg)', offset: 0.6 }, { transform: 'rotate(0)' }],
          { duration: dur, easing: 'ease-out' }
        );
      }

      let finished = false;
      const settle = () => {
        if (finished) return;
        finished = true;
        fly.remove();
        onDone();
      };
      move.onfinish = settle;
      setTimeout(settle, dur + 120);                   // safety net (tab throttling)
    }

    onTrickWon(e) {
      const seat = this.seatOf[e.winnerIndex];
      const name = this.engine.players[e.winnerIndex].name;
      const who = (e.winnerIndex === this.me) ? 'You' : name;
      const badge = $('.badge[data-seat="' + seat + '"]');
      if (e.tookQueen && e.queenDisregarded) {
        // Rule: winner is immune by score — Queen points disregarded.
        BQ.Sound.trickWin();
        const extra = e.points > 0 ? ' (still +' + e.points + ' ♥)' : '';
        this.handResult('Hand ' + e.handNo, who + ' caught ♛ — disregarded' + extra, '♛', false);
        BQ.FX.banner(who + ' caught the Queen', 'Immune — points disregarded', '♛', 'queen');
      } else if (e.tookQueen) {
        this.handResult('Hand ' + e.handNo, who + ' stuck with ♛ (+' + this.engine.rules.queenPoints + ')', '♛', true);
        this.queenSting(name, e.winnerIndex === this.me);
      } else if (e.points > 0) {
        BQ.Sound.heartHit();
        this.handResult('Hand ' + e.handNo, who + ' concede' + (who === 'You' ? '' : 's') + ' ' + e.points + ' pts', e.points, false);
        BQ.FX.heartHit(badge, e.points);   // beating heart burst at the eater's seat
      } else {
        BQ.Sound.trickWin();
        this.handResult('Hand ' + e.handNo, who + ' win' + (who === 'You' ? '' : 's') + ' the hand', '✦', false);
        // YOUR clean win → lion roar + a little pride
        if (e.winnerIndex === this.me) {
          BQ.Sound.roar();
          BQ.FX.floatEmoji('🦁', 3);
        }
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
      BQ.FX.emojiRain('💔', 14);
      BQ.FX.banner('Hearts Broken!', 'Hearts can now be led', '💔', 'heart');
      BQ.Sound.whoosh();
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
      // The engine fires 'roundEnd' just before phase flips to 'gameOver', so
      // trust the payload flag; fall back to phase for resume/reconnect replays.
      // Reveal the tricks each player WON this round, grouped per player.
      this.renderWonTricks(e.tricks);

      const over = !!e.gameOver || this.engine.phase === 'gameOver';
      $('#roundTitle').textContent = over
        ? 'Round ' + e.round + ' Complete — Game Over'
        : 'Round ' + e.round + ' Complete';

      // Always show this round's scorecard — INCLUDING the final hand that ends
      // the game (a player reached the target score). On that final hand the
      // button reveals the results podium instead of starting another round
      // (see showGameOver + main.js); we never skip silently past the scorecard.
      const nextBtn = $('#btnNextRound');
      if (nextBtn) {
        nextBtn.dataset.final = over ? '1' : '';
        if (over) {
          nextBtn.disabled = false;
          nextBtn.textContent = 'See Final Results 🏆';
          const wait = $('#roundWait'); if (wait) wait.style.display = 'none';
        } else {
          nextBtn.textContent = 'Next Round'; // multiplayer relabels to "I'm Ready"
        }
      }
      this.openOverlay('roundOverlay');
    }

    /* ---- end-of-round won-tricks reveal ---------------------------------- *
     * For each player, show the tricks they WON — each trick a group of 4 cards
     * (one per player), revealed one card at a time. tricks[] =
     * [{winnerIndex, points, tookQueen, hearts, cards:[{playerIndex,rank,suit}]}]. */
    renderWonTricks(tricks) {
      const box = document.getElementById('handsReveal');
      if (!box) return;
      box.innerHTML = '';
      if (!Array.isArray(tricks)) { box.style.display = 'none'; return; }
      box.style.display = '';

      const me = this.me;
      const players = this.engine.players || [];
      const q = this.engine.rules.queenCard;
      const CARD_MS = 55;    // between cards in a trick
      const TRICK_MS = 200;  // between tricks
      const SEAT_MS = 300;   // before the next player's section
      let delay = 0;

      for (let i = 0; i < players.length; i++) {
        const mine = tricks.filter((t) => t.winnerIndex === i);
        const name = (players[i] && players[i].name) || ('Seat ' + (i + 1));
        const pts = mine.reduce((s, t) => s + (t.points || 0), 0);

        const section = document.createElement('div');
        section.className = 'won-player' + (i === me ? ' you' : '');

        const head = document.createElement('div');
        head.className = 'won-head';
        head.style.animationDelay = delay + 'ms';
        const tag = mine.length === 1 ? 'trick' : 'tricks';
        head.innerHTML =
          '<span class="won-name">' + name + (i === me ? ' (you)' : '') + '</span>' +
          '<span class="won-sum">' + mine.length + ' ' + tag +
          (pts > 0 ? ' · <b class="pen">+' + pts + '</b>' : ' · 0') + '</span>';
        section.appendChild(head);

        const list = document.createElement('div');
        list.className = 'won-tricks';

        if (!mine.length) {
          const empty = document.createElement('span');
          empty.className = 'reveal-empty';
          empty.textContent = '— no tricks —';
          empty.style.animationDelay = delay + 'ms';
          list.appendChild(empty);
          delay += SEAT_MS;
        } else {
          mine.forEach((t) => {
            const group = document.createElement('div');
            group.className = 'won-trick';
            (t.cards || []).forEach((c) => {
              const card = new BQ.Card(c.rank, c.suit);
              const el = this.cardEl(card, true);
              el.classList.add('reveal-card');
              if (c.playerIndex === t.winnerIndex) el.classList.add('took'); // the winning card
              el.style.animationDelay = delay + 'ms';
              group.appendChild(el);
              delay += CARD_MS;
            });
            if (t.points > 0) {
              const badge = document.createElement('span');
              badge.className = 'won-trick-pts';
              badge.textContent = '+' + t.points;
              badge.style.animationDelay = delay + 'ms';
              group.appendChild(badge);
            }
            list.appendChild(group);
            delay += TRICK_MS;
          });
          delay += SEAT_MS - TRICK_MS;
        }
        section.appendChild(list);
        box.appendChild(section);
      }
    }

    /* ---- game over -------------------------------------------------------- */
    // The engine ends the game the instant a player reaches the target score.
    // We BUILD the results here but reveal them only AFTER the player has seen
    // the final hand's scorecard — the round overlay's button calls
    // showGameOver(). If no scorecard is up (e.g. reconnecting straight into a
    // finished game, where no roundEnd precedes this), reveal immediately.
    onGameOver(e) {
      this._gameOver = e;
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

      // Nothing to tap through? Show the results now.
      if (!$('#roundOverlay').classList.contains('show')) this.showGameOver();
    }

    // Reveal the results podium: closes the final scorecard and plays the
    // win/lose effects. Called from the scorecard's "See Final Results" button,
    // or directly by onGameOver when no scorecard is on screen.
    showGameOver() {
      const e = this._gameOver;
      if (!e) return;
      this.closeOverlay('roundOverlay');
      this.openOverlay('gameOverOverlay');
      const won = e.winnerIndex === this.me;
      const winnerName = (e.ranking && e.ranking[0]) ? e.ranking[0].name : '';
      if (won) {
        BQ.Sound.win();
        BQ.Sound.fanfare();
        this.confetti();
        BQ.FX.confetti3D(100);
        BQ.FX.banner('🏆 You win!', 'Champion of the table', '👑', 'win');
        BQ.FX.floatEmoji('🎉', 8);
      } else {
        BQ.Sound.lose();
        BQ.FX.banner(winnerName + ' wins', 'Better luck next game', '🏆', 'gold');
      }
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

    /* ---- Black Queen "sting": full-screen cinematic when a player gets stuck
       with the Queen — lightning, shockwaves, a spinning 3D Q♠, queen rain and
       a thunder-and-bells sting. Personalised if it's you. ------------------*/
    queenSting(name, isYou) {
      const tauntsYou = [
        'The Queen chose YOU 💀', 'Ouch! You grabbed the Black Queen 😩',
        'You got crowned… 👑', "Stuck with the Queen — that's gotta hurt 🤡",
        'The Queen says hi 👋💀',
      ];
      const tauntsThem = [
        name + ' got CROWNED! 👑', 'The Black Queen picked ' + name + ' 💀',
        'Ouch — ' + name + " can't escape the Queen 😈", 'Bad luck, ' + name + '! 🃏',
        'Everybody point at ' + name + ' 👉😂',
      ];
      const pool = isYou ? tauntsYou : tauntsThem;
      const taunt = pool[Math.floor(Math.random() * pool.length)];
      const pts = (this.engine.rules && this.engine.rules.queenPoints) || 12;

      BQ.Sound.queenDoom();
      BQ.FX.queenCinematic(name, taunt, pts, isYou);
      BQ.FX.floatEmoji('💀', 5);
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
