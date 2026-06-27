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
        if (row) this._showGameDetail(row.dataset.game);
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
      if (!games.length) { list.innerHTML = '<p class="muted">No finished games yet — play one!</p>'; return; }
      list.innerHTML = games.map((g) => {
        const when = new Date(g.endedAt).toLocaleString();
        const type = g.gameType === 'treeky' ? '🎴 Treeky' : '♛ Black Queen';
        const badge = g.won ? '<span class="hist-win">WON</span>'
          : (g.yourRank ? '<span class="hist-rank">#' + g.yourRank + '</span>' : '');
        return '<button class="hist-row" data-game="' + esc(g.id) + '">' +
          '<span class="hist-type">' + type + '</span>' +
          '<span class="hist-when">' + esc(when) + '</span>' + badge + '</button>';
      }).join('');
    },

    async _showGameDetail(id) {
      const box = $('#historyDetail');
      box.innerHTML = '<p class="muted">Loading…</p>';
      const r = await api('/history/' + encodeURIComponent(id));
      if (!r.ok) { box.innerHTML = '<p class="muted">Could not load that game.</p>'; return; }
      const { game, players, rounds } = r.body;
      const pName = (seat) => { const p = players.find((x) => x.seat === seat); return p ? p.name : ('Seat ' + seat); };
      const playersHtml = players.slice().sort((a, b) => (a.rank || 9) - (b.rank || 9)).map((p) =>
        '<div class="detail-player' + (p.seat === game.winnerSeat ? ' winner' : '') + '">' +
        '<span>' + (p.rank ? '#' + p.rank + ' ' : '') + esc(p.name) + (p.isBot ? ' 🤖' : '') + '</span>' +
        '<span>' + (p.finalScore == null ? '' : p.finalScore + ' pts') + '</span></div>').join('');
      let roundsHtml = '';
      if (rounds && rounds.length) {
        roundsHtml = '<table class="rounds-table"><thead><tr><th>Round</th>' +
          players.map((p) => '<th>' + esc(p.name) + '</th>').join('') + '</tr></thead><tbody>' +
          rounds.map((rd) => '<tr><td>' + rd.roundNo + '</td>' +
            players.map((p) => '<td>' + ((rd.scores && rd.scores[p.seat] != null) ? rd.scores[p.seat] : '–') + '</td>').join('') +
            '</tr>').join('') + '</tbody></table>';
      }
      const type = game.gameType === 'treeky' ? '🎴 Treeky' : '♛ Black Queen';
      box.innerHTML = '<h3 class="detail-title">' + type + ' · ' + esc(new Date(game.endedAt).toLocaleString()) + '</h3>' +
        '<div class="detail-players">' + playersHtml + '</div>' + roundsHtml;
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
        html += '<p class="muted">No friends yet — add someone by username above.</p>';
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
