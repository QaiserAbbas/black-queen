/* =============================================================================
 * Black Queen — ACCOUNT CLIENT  (auth, friends, history)
 * -----------------------------------------------------------------------------
 * Talks to the /api/* endpoints (cookie sessions) and drives the auth, profile,
 * and friends screens. Login is REQUIRED: BQ.Account.boot() checks the session
 * and either hands control to the app (onReady) or shows the login screen.
 * ===========================================================================*/

(function (root) {
  'use strict';
  const BQ = root.BQ;
  const $ = (s) => document.querySelector(s);

  async function api(path, opts) {
    const res = await fetch('/api' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts));
    let body = null; try { body = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, body: body || {} };
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ordinal(n) {
    const t = n % 100, u = n % 10;
    const suffix = (t >= 11 && t <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][u] || 'th');
    return n + suffix;
  }

  const GAME_META = {
    blackqueen: { icon: '♛', name: 'Black Queen' },
    treeky: { icon: '🎴', name: 'Treeky' },
    bluff: { icon: '🃏', name: 'Bluff' },
  };

  // Compact "2h ago" / "3d ago" relative time; falls back to a date for old games.
  function relTime(ts) {
    const t = new Date(ts).getTime();
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  const Account = {
    user: null,
    ui: null,
    onReady: null,        // (user) => void — app takes over (show menu, set name)

    init(opts) {
      this.ui = opts.ui;
      this.onReady = opts.onReady || function () {};
      this._wireAuth();
      this._wireMenu();
      this._wireProfile();
      this._wireFriends();
    },

    current() { return this.user; },

    // Decide the opening screen: logged in → app; otherwise → auth.
    async boot() {
      try {
        const r = await api('/me');
        if (r.ok && r.body.user) { this.user = r.body.user; this._enter(); return; }
      } catch (_) { /* offline / unreachable */ }
      this.ui.show('auth');
    },

    _enter() {
      const g = $('#accountGreet');
      if (g) g.textContent = 'Hi, ' + (this.user.displayName || this.user.username);
      this.onReady(this.user);          // main.js: set myName, attemptResume, show menu
    },

    /* ---- auth screen ----------------------------------------------------- */
    _setMode(mode) {
      this._mode = mode;
      const reg = mode === 'register';
      $('#authTabLogin').classList.toggle('active', !reg);
      $('#authTabRegister').classList.toggle('active', reg);
      $('#authUsernameField').style.display = reg ? '' : 'none';
      $('#btnAuthSubmit').textContent = reg ? 'Create Account' : 'Log In';
      $('#authSubtitle').textContent = reg ? 'Create an account to play' : 'Sign in to play';
      $('#authPassword').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
      $('#authError').textContent = '';
    },

    _wireAuth() {
      this._mode = 'login';
      $('#authTabLogin').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this._setMode('login'); });
      $('#authTabRegister').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this._setMode('register'); });
      $('#btnAuthSubmit').addEventListener('click', () => this._submitAuth());
      ['authEmail', 'authUsername', 'authPassword'].forEach((id) => {
        const el = document.getElementById(id);
        el && el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitAuth(); });
      });
    },

    async _submitAuth() {
      const reg = this._mode === 'register';
      const email = ($('#authEmail').value || '').trim();
      const username = ($('#authUsername').value || '').trim();
      const password = $('#authPassword').value || '';
      const err = $('#authError');
      err.textContent = '';
      $('#btnAuthSubmit').disabled = true;
      try {
        const r = await api(reg ? '/register' : '/login', {
          method: 'POST',
          body: JSON.stringify(reg ? { email, username, password } : { email, password }),
        });
        if (!r.ok) { err.textContent = r.body.error || 'Something went wrong.'; BQ.Sound && BQ.Sound.error(); return; }
        this.user = r.body.user;
        $('#authPassword').value = '';
        BQ.Sound && BQ.Sound.click();
        this._enter();
      } catch (_) {
        err.textContent = 'Could not reach the server. Check your connection.';
      } finally {
        $('#btnAuthSubmit').disabled = false;
      }
    },

    /* ---- menu account bar ------------------------------------------------ */
    _wireMenu() {
      $('#btnLogout').addEventListener('click', async () => {
        BQ.Sound && BQ.Sound.click();
        await api('/logout', { method: 'POST' });
        this.user = null;
        this._setMode('login');
        $('#authEmail').value = ''; $('#authPassword').value = '';
        this.ui.show('auth');
      });
      $('#btnProfile').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this.openProfile(); });
      $('#btnFriends').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this.openFriends(); });
    },

    /* ---- profile / history ---------------------------------------------- */
    _wireProfile() {
      $('#btnProfileBack').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this.ui.show('menu'); });
      $('#historyList').addEventListener('click', (e) => {
        const row = e.target.closest('[data-game]');
        if (row) {
          BQ.Sound && BQ.Sound.click();
          $('#historyList').querySelectorAll('.hist-card.open').forEach((c) => c.classList.remove('open'));
          row.classList.add('open');
          this._showGameDetail(row.dataset.game);
        }
      });
      $('#historyDetail').addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) {
          BQ.Sound && BQ.Sound.click();
          $('#historyDetail').innerHTML = '';
          $('#historyList').querySelectorAll('.hist-card.open').forEach((c) => c.classList.remove('open'));
        }
      });
    },

    async openProfile() {
      this.ui.show('profile');
      const list = $('#historyList');
      $('#historyDetail').innerHTML = '';
      list.innerHTML = '<p class="muted">Loading…</p>';
      const r = await api('/history');
      if (!r.ok) { list.innerHTML = '<p class="muted">Could not load history.</p>'; return; }
      const games = r.body.games || [];
      $('#profileSubtitle').textContent = games.length
        ? games.length + ' game' + (games.length === 1 ? '' : 's') + ' played — tap one to review'
        : 'Recent games';
      if (!games.length) {
        list.innerHTML = '<div class="hist-empty"><div class="hist-empty-mark">♛</div>' +
          '<p>No finished games yet.</p><p class="muted">Play one to see it here.</p></div>';
        return;
      }

      // Quick wins/games tally for the strip above the grid.
      const wins = games.filter((g) => g.won).length;
      const stats = '<div class="hist-stats">' +
        '<div class="hist-stat"><b>' + games.length + '</b><span>played</span></div>' +
        '<div class="hist-stat"><b>' + wins + '</b><span>won</span></div>' +
        '<div class="hist-stat"><b>' + (games.length ? Math.round((wins / games.length) * 100) : 0) + '%</b><span>win rate</span></div>' +
        '</div>';

      const cards = '<div class="hist-grid">' + games.map((g) => {
        const meta = GAME_META[g.gameType] || GAME_META.blackqueen;
        const icon = meta.icon;
        const type = meta.name;
        const result = g.won ? 'Victory'
          : (g.yourRank ? ordinal(g.yourRank) + ' place' : 'Finished');
        const cls = g.won ? ' won' : (g.yourRank === 2 ? ' silver' : (g.yourRank === 3 ? ' bronze' : ''));
        const badge = g.won ? '<span class="hc-badge win">WON</span>'
          : (g.yourRank ? '<span class="hc-badge rank">#' + g.yourRank + '</span>' : '');
        const score = (g.yourScore == null) ? '' :
          '<span class="hc-chip">' + g.yourScore + ' pts</span>';
        const code = g.code ? '<span class="hc-chip ghost">#' + esc(g.code) + '</span>' : '';
        return '<button class="hist-card' + cls + '" data-game="' + esc(g.id) + '">' +
          '<div class="hc-top"><span class="hc-game"><span class="hc-icon">' + icon + '</span>' + type + '</span>' + badge + '</div>' +
          '<div class="hc-result">' + result + '</div>' +
          '<div class="hc-meta">' + score + code +
            '<span class="hc-when">' + esc(relTime(g.endedAt)) + '</span></div>' +
          '</button>';
      }).join('') + '</div>';

      list.innerHTML = stats + cards;
    },

    async _showGameDetail(id) {
      const box = $('#historyDetail');
      box.innerHTML = '<p class="muted">Loading…</p>';
      const r = await api('/history/' + encodeURIComponent(id));
      if (!r.ok) { box.innerHTML = '<p class="muted">Could not load that game.</p>'; return; }
      const { game, players, rounds } = r.body;

      // Loser = worst rank (the player to learn from). Mine = the viewing user.
      const ranked = players.filter((p) => p.rank);
      const loserSeat = ranked.length ? ranked.reduce((a, b) => (b.rank > a.rank ? b : a)).seat : null;
      const meP = players.find((p) => p.userId && this.user && p.userId === this.user.id);
      const mySeat = meP ? meP.seat : null;

      const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
      const playersHtml = players.slice().sort((a, b) => (a.rank || 9) - (b.rank || 9)).map((p) => {
        const tag = p.seat === game.winnerSeat ? ' winner' : (p.seat === loserSeat ? ' loser' : '');
        const mine = (mySeat != null && p.seat === mySeat) ? ' me' : '';
        const rankMark = p.rank ? (medal[p.rank] || ('#' + p.rank)) : '·';
        return '<div class="detail-player' + tag + mine + '">' +
          '<span class="dp-rank">' + rankMark + '</span>' +
          '<span class="dp-name">' + esc(p.name) + (p.isBot ? ' 🤖' : '') +
          (mine ? ' <span class="me-tag">you</span>' : '') +
          (p.seat === loserSeat ? ' <span class="loser-tag">last</span>' : '') + '</span>' +
          '<span class="dp-score">' + (p.finalScore == null ? '' : p.finalScore + ' pts') + '</span></div>';
      }).join('');

      let roundsHtml = '';
      if (rounds && rounds.length) {
        roundsHtml = '<div class="rounds-scroll"><table class="rounds-table"><thead><tr><th>Round</th>' +
          players.map((p) => '<th>' + esc(p.name) + '</th>').join('') + '</tr></thead><tbody>' +
          rounds.map((rd) => '<tr><td>' + rd.roundNo + '</td>' +
            players.map((p) => '<td>' + ((rd.scores && rd.scores[p.seat] != null) ? rd.scores[p.seat] : '-') + '</td>').join('') +
            '</tr>').join('') + '</tbody></table></div>';
      }
      const gm = GAME_META[game.gameType] || GAME_META.blackqueen;
      const type = gm.icon + ' ' + gm.name;
      box.innerHTML = '<div class="detail-head">' +
          '<h3 class="detail-title">' + type + '</h3>' +
          '<span class="detail-date">' + esc(new Date(game.endedAt).toLocaleString()) + '</span>' +
          '<button class="detail-close" data-close>✕</button>' +
        '</div>' +
        '<div class="detail-sub">Final standings</div>' +
        '<div class="detail-players">' + playersHtml + '</div>' +
        (roundsHtml ? '<div class="detail-sub">Round by round</div>' + roundsHtml : '') +
        this._coachingHtml(game, players, rounds, mySeat, loserSeat);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    // "Learn from this game" — coach the viewing player (or the loser) on what
    // cost them points and how to play it better next time.
    _coachingHtml(game, players, rounds, mySeat, loserSeat) {
      const seat = (mySeat != null) ? mySeat : loserSeat;
      if (seat == null) return '';
      const nameOf = (s) => { const p = players.find((x) => x.seat === s); return p ? p.name : ('Seat ' + s); };
      const youLost = seat === loserSeat;
      const youWon = seat === game.winnerSeat;
      const who = (mySeat != null) ? 'You' : nameOf(seat);
      const lead = youLost ? who + ' finished last. Here is what cost the game, and how to bounce back:'
        : youWon ? who + ' won. A few spots where points still leaked:'
        : 'Where ' + who.toLowerCase() + ' took points, and how to tighten up:';
      const tips = [];

      if (game.gameType === 'treeky') {
        tips.push('Shed your most dangerous cards early (penalty cards and high ranks). Sitting on them is how you get stuck holding the bag.');
        tips.push('Keep one defensive card, a 2 or a wild, for when the draw turns against you.');
        tips.push('Declare "last card" the instant you are down to one card, or you take a penalty.');
      } else if (game.gameType === 'bluff') {
        tips.push('Bluff small. A lie of one card costs you only that card if it is caught — dumping four fake cards hands the whole pile back when someone doubts you.');
        tips.push('Track the count. If you are holding three Kings and someone claims two more, that is impossible — call it. Doubt the claims your own hand makes unlikely.');
        tips.push('Always doubt a winning play. When a player claims the cards that empty their hand, challenge it — being right ends their game, and being wrong only costs you the pile.');
        tips.push('Play honestly while the pile is small; save your bluffs for when the pile is huge and nobody wants to risk picking it up.');
      } else {
        // Black Queen: read each round's breakdown for this seat.
        const mine = (rounds || []).map((rd) => ({
          n: rd.roundNo,
          b: rd.breakdown && rd.breakdown.find((x) => x.playerIndex === seat),
          score: rd.scores && rd.scores[seat],
        }));
        const queenRounds = mine.filter((m) => m.b && m.b.tookQueen).map((m) => m.n);
        const heartRounds = mine.filter((m) => m.b && m.b.hearts >= 4).map((m) => m.n);
        const hasBreakdown = mine.some((m) => m.b);

        if (queenRounds.length) {
          tips.push('Round ' + queenRounds.join(', ') + ': you got stuck with the Queen of Spades, the single biggest swing in the game. Holding it, dump it the moment you cannot follow suit, onto a trick you are not winning. Without it, lead spades early to flush it out before your hand fills with hearts. Never sit on the Ace or King of spades with no small spade to duck under the Queen.');
        }
        if (heartRounds.length) {
          tips.push('Round ' + heartRounds.join(', ') + ': you collected a pile of hearts. Duck under the high card so you do not win point cards, go void in a suit early so you can throw hearts away, and stop winning tricks once hearts start to fall.');
        }
        if (!queenRounds.length && !heartRounds.length) {
          const worst = mine.filter((m) => m.score != null).sort((a, b) => b.score - a.score)[0];
          if (worst && worst.score > 0) {
            tips.push('Round ' + worst.n + ' cost you the most (' + worst.score + ' pts)' +
              (hasBreakdown ? '.' : ' (likely the Queen if that number is large).') +
              ' Keep leading low and ducking under high cards to bleed fewer points.');
          }
        }
        tips.push('Lead low. Winning the lead with a high card hands you the trick and any points in it. Lead from your shortest suit so you go void sooner and gain escape routes.');
        if (!hasBreakdown && rounds && rounds.length) {
          tips.push('Tip detail (which hearts, who caught the Queen) is saved for games from now on, so future reviews get sharper.');
        }
      }

      return '<div class="coaching"><h3 class="coach-title">Learn from this game</h3>' +
        '<p class="coach-lead">' + esc(lead) + '</p>' +
        '<ul class="coach-list">' + tips.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></div>';
    },

    /* ---- friends --------------------------------------------------------- */
    _wireFriends() {
      $('#btnFriendsBack').addEventListener('click', () => { BQ.Sound && BQ.Sound.click(); this.ui.show('menu'); });
      $('#btnFriendAdd').addEventListener('click', () => this._addFriend());
      $('#friendAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') this._addFriend(); });
      // event-delegated accept / reject / remove
      const handler = async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        BQ.Sound && BQ.Sound.click();
        const id = parseInt(btn.dataset.id, 10);
        const act = btn.dataset.act;
        if (act === 'accept') await api('/friends/respond', { method: 'POST', body: JSON.stringify({ userId: id, accept: true }) });
        else if (act === 'reject') await api('/friends/respond', { method: 'POST', body: JSON.stringify({ userId: id, accept: false }) });
        else if (act === 'remove') await api('/friends', { method: 'DELETE', body: JSON.stringify({ userId: id }) });
        this.openFriends();
      };
      $('#friendRequests').addEventListener('click', handler);
      $('#friendList').addEventListener('click', handler);
    },

    async _addFriend() {
      const input = $('#friendAdd');
      const username = (input.value || '').trim();
      const msg = $('#friendMsg');
      if (!username) return;
      const r = await api('/friends/request', { method: 'POST', body: JSON.stringify({ username }) });
      msg.textContent = r.ok ? ('Request sent to ' + username + '.') : (r.body.error || 'Could not send request.');
      if (r.ok) input.value = '';
      this.openFriends();
    },

    async openFriends() {
      this.ui.show('friends');
      const reqBox = $('#friendRequests'), listBox = $('#friendList');
      reqBox.innerHTML = ''; listBox.innerHTML = '<p class="muted">Loading…</p>';
      const r = await api('/friends');
      if (!r.ok) { listBox.innerHTML = '<p class="muted">Could not load friends.</p>'; return; }
      const { friends, incoming, outgoing } = r.body;

      const nm = (u) => esc(u.displayName || u.username) + ' <span class="muted">@' + esc(u.username) + '</span>';
      reqBox.innerHTML = (incoming && incoming.length)
        ? '<h3 class="friend-h">Friend requests</h3>' + incoming.map((u) =>
            '<div class="friend-row"><span>' + nm(u) + '</span><span class="friend-actions">' +
            '<button class="btn sm" data-act="accept" data-id="' + u.id + '">Accept</button>' +
            '<button class="btn ghost sm" data-act="reject" data-id="' + u.id + '">Reject</button></span></div>').join('')
        : '';

      let html = '<h3 class="friend-h">Your friends</h3>';
      if (friends && friends.length) {
        html += friends.map((u) =>
          '<div class="friend-row"><span>' + nm(u) + '</span>' +
          '<button class="btn ghost sm" data-act="remove" data-id="' + u.id + '">Remove</button></div>').join('');
      } else {
        html += '<p class="muted">No friends yet. Add someone by username above.</p>';
      }
      if (outgoing && outgoing.length) {
        html += '<h3 class="friend-h">Pending (sent)</h3>' + outgoing.map((u) =>
          '<div class="friend-row"><span>' + nm(u) + '</span><span class="muted">pending…</span></div>').join('');
      }
      listBox.innerHTML = html;
    },
  };

  BQ.Account = Account;
})(window);
