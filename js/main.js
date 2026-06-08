/* =============================================================================
 * Black Queen — BOOTSTRAP / GLUE
 * Wires the menu, settings editor, and game lifecycle to the engine + UI.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;
  const $ = (s) => document.querySelector(s);

  // Persisted rules (localStorage) layered over defaults.
  function loadRules() {
    const base = BQ.cloneRules();
    try {
      const saved = JSON.parse(localStorage.getItem('bq_rules') || '{}');
      Object.assign(base, saved);
    } catch (_) {}
    return base;
  }
  function saveRules(rules) {
    try { localStorage.setItem('bq_rules', JSON.stringify(rules)); } catch (_) {}
  }

  let rules = loadRules();
  let engine = null;
  const ui = new BQ.UI();

  // ---- multiplayer state -----------------------------------------------
  let net = null;            // BQ.NetClient
  let netEngine = null;      // BQ.NetworkEngine
  let isMultiplayer = false;
  let isHost = false;
  let myName = 'You';

  /* ---- Settings editor schema (label, key, type, opts) ------------------- */
  const SETTINGS_SCHEMA = [
    { section: 'Scoring' },
    { key: 'queenPoints', label: 'Black Queen points', type: 'number' },
    { key: 'heartPoints', label: 'Each heart points', type: 'number' },
    { key: 'noTrickPenalty', label: 'No-trick score (Rule 4)', type: 'number' },
    { key: 'noTrickRuleEnabled', label: 'Enable no-trick rule', type: 'check' },
    { key: 'consecutiveZeroLimit', label: 'Consecutive 0-rounds limit (Rule 5)', type: 'number' },
    { key: 'consecutiveZeroPenalty', label: 'Penalty for that streak', type: 'number' },
    { key: 'consecutiveZeroRuleEnabled', label: 'Enable streak rule', type: 'check' },
    { key: 'queenExemptEnabled', label: 'Queen immunity at high score', type: 'check' },
    { key: 'queenExemptScore', label: 'Queen immunity score (≥)', type: 'number' },

    { section: 'Play' },
    { key: 'heartsMustBeBroken', label: 'Hearts must be broken before leading', type: 'check' },
    { key: 'queenBreaksHearts', label: 'Black Queen also breaks hearts', type: 'check' },
    { key: 'mustThrowQueen', label: 'Must throw Queen when void in lead suit', type: 'check' },
    { key: 'shootTheMoonEnabled', label: 'Allow shooting the moon', type: 'check' },
    { key: 'dealerIsHighestScore', label: 'Highest score deals (Rule 7)', type: 'check' },
    { key: 'playDirection', label: 'Play direction', type: 'select', opts: [['right', 'Right (counter-clockwise)'], ['left', 'Left (clockwise)']] },

    { section: 'Match' },
    { key: 'endMode', label: 'Game ends by', type: 'select', opts: [['targetScore', 'Target score'], ['fixedRounds', 'Fixed rounds']] },
    { key: 'endScore', label: 'Target score', type: 'number' },
    { key: 'roundLimit', label: 'Round limit', type: 'number' },
    { key: 'lowestScoreWins', label: 'Lowest score wins', type: 'check' },

    { section: 'Feel' },
    { key: 'botThinkMs', label: 'Bot think time (ms)', type: 'number' },
    { key: 'soundEnabled', label: 'Sound', type: 'check' },
  ];

  function buildSettingsForm() {
    const form = $('#settingsForm');
    form.innerHTML = '';
    SETTINGS_SCHEMA.forEach((f) => {
      if (f.section) {
        const h = document.createElement('h3');
        h.className = 'full';
        h.textContent = f.section;
        form.appendChild(h);
        return;
      }
      const row = document.createElement('div');
      row.className = 'set-row' + (f.type === 'check' ? ' check' : '');
      const id = 'set_' + f.key;
      let control;
      if (f.type === 'check') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.checked = !!rules[f.key];
        row.appendChild(control);
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
      } else if (f.type === 'select') {
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
        control = document.createElement('select');
        f.opts.forEach(([val, text]) => {
          const o = document.createElement('option');
          o.value = val; o.textContent = text;
          if (rules[f.key] === val) o.selected = true;
          control.appendChild(o);
        });
        row.appendChild(control);
      } else {
        const lab = document.createElement('label');
        lab.htmlFor = id; lab.textContent = f.label;
        row.appendChild(lab);
        control = document.createElement('input');
        control.type = 'number';
        control.value = rules[f.key];
        row.appendChild(control);
      }
      control.id = id;
      control.dataset.key = f.key;
      control.dataset.type = f.type;
      form.appendChild(row);
    });
  }

  function readSettingsForm() {
    $('#settingsForm').querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'check') rules[key] = el.checked;
      else if (type === 'number') rules[key] = Number(el.value);
      else rules[key] = el.value;
    });
    saveRules(rules);
    BQ.Sound.setEnabled(rules.soundEnabled);
    if (engine) engine.rules = rules; // applies next round
  }

  /* ---- How to play content --------------------------------------------- */
  function rulesHtml() {
    return (
      '<h2>♛ How to Play Black Queen</h2>' +
      '<p style="color:#cfe6d6;margin-bottom:0.8rem">A trick-taking game. Avoid winning tricks that contain penalty cards — the lowest total score wins.</p>' +
      '<h3>The Penalty Cards</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li><b>Black Queen (Q♠)</b> = <b>' + rules.queenPoints + '</b> points</li>' +
      '<li>Each <b style="color:#ff8a7a">Heart ♥</b> = <b>' + rules.heartPoints + '</b> point</li>' +
      '<li>Total points per round = <b>' + rules.expectedRoundTotal + '</b></li>' +
      '</ul>' +
      '<h3>Special Rules</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li>Win <b>no trick</b> all round → <b>' + rules.noTrickPenalty + '</b> to your score.</li>' +
      '<li><b>' + rules.consecutiveZeroLimit + '</b> zero-point rounds in a row → <b>' + rules.consecutiveZeroPenalty + '</b>.</li>' +
      '<li><b>No passing</b> of cards.</li>' +
      '<li>The <b>highest-scoring</b> player deals; the player to their <b>right</b> plays first, and play continues to the <b>right</b>.</li>' +
      '</ul>' +
      '<h3>Playing a Trick</h3>' +
      '<ul style="margin:0 0 0.8rem 1.2rem;line-height:1.7">' +
      '<li>Follow the led suit if you can.</li>' +
      '<li>Highest card of the led suit wins the trick and leads next.</li>' +
      '<li>Hearts can\'t be led until a heart (or the Queen) has been played.</li>' +
      '</ul>' +
      '<div class="close-row"><button class="btn small" data-close="rulesOverlay">Got it</button></div>'
    );
  }

  /* ---- Game lifecycle (single player) ----------------------------------- */
  function newGame(name) {
    isMultiplayer = false; isHost = true;
    engine = new BQ.GameEngine(rules);
    engine.init(name);
    ui.attach(engine);
    ui.show('game');
    BQ.Sound.unlock();
    if (rules.soundEnabled) BQ.Sound.startMusic();
    setupRoundControls();
    engine.startRound();
  }

  /* ---- Multiplayer ------------------------------------------------------- */
  // A clear, reusable explanation for when the server can't be reached.
  function serverHelp(err) {
    const code = err && err.code;
    if (code === 'not-served' || location.protocol === 'file:') {
      return 'Multiplayer needs the game server. You opened this file directly. ' +
        'In a terminal run  node server.js  then open the http://… address it prints (the same address on every device).';
    }
    return 'Could not reach the game server at ' + location.host + '. ' +
      'Make sure  node server.js  is running and you opened the address it printed (not a file or a different server).';
  }

  function setMpStatus(msg, kind) {
    const el = $('#mpStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mp-status' + (kind ? ' ' + kind : '');
  }

  function setControlsEnabled(on) {
    $('#btnCreate').disabled = !on;
    $('#btnJoin').disabled = !on;
  }

  // Open the multiplayer screen and immediately probe the server.
  function openMultiplayer() {
    $('#mpError').textContent = '';
    ui.show('mp');
    $('#mpName').focus();
    setControlsEnabled(false);
    setMpStatus('Connecting to server…', '');
    ensureConnected()
      .then(() => { setMpStatus('✓ Connected. Create a room or join with a code.', 'ok'); setControlsEnabled(true); })
      .catch((err) => { setMpStatus(serverHelp(err), 'bad'); setControlsEnabled(true); });
  }

  function ensureConnected() {
    if (net && net.connected) return Promise.resolve();
    net = new BQ.NetClient();
    wireNet();
    return net.connect();
  }

  function wireNet() {
    net.on('joined', (m) => { $('#mpError').textContent = ''; });
    net.on('error', (m) => { setMpStatus(m.msg || 'Error', 'bad'); $('#mpError').textContent = ''; BQ.Sound.error(); });
    net.on('lobby', (m) => {
      isHost = m.state.youAreHost;
      renderLobby(m.state);
      ui.show('lobby');
    });
    net.on('close', () => {
      if (isMultiplayer) ui.toast('Disconnected from server');
    });
    net.on('ready', (m) => renderReady(m));
    net.on('game', (m) => {
      if (!netEngine) {
        isMultiplayer = true;
        netEngine = new BQ.NetworkEngine(net);
        netEngine.ingest(m.snapshot);
        ui.attach(netEngine);
        // set up the round/game-over confirmation controls
        netEngine.on('roundEnd', setupRoundControls);
        netEngine.on('gameOver', setupGameOverControls);
        ui.show('game');
        BQ.Sound.unlock();
        if (rules.soundEnabled) BQ.Sound.startMusic();
      }
      netEngine.handle(m.snapshot, m.hint);
    });
  }

  function createRoom() {
    myName = ($('#mpName').value || '').trim() || 'Host';
    $('#mpError').textContent = '';
    setMpStatus('Creating room…', '');
    ensureConnected().then(() => {
      setMpStatus('✓ Connected.', 'ok');
      net.send({ t: 'create', name: myName });
    }).catch((err) => { setMpStatus(serverHelp(err), 'bad'); });
  }

  function joinRoom() {
    myName = ($('#mpName').value || '').trim() || 'Player';
    const code = ($('#mpCode').value || '').trim().toUpperCase();
    $('#mpError').textContent = '';
    setMpStatus(code ? 'Joining room ' + code + '…' : 'Looking for an open game…', '');
    ensureConnected().then(() => {
      net.send({ t: 'join', code, name: myName });
    }).catch((err) => { setMpStatus(serverHelp(err), 'bad'); });
  }

  function renderLobby(state) {
    $('#lobbyCode').textContent = state.code;
    const seats = state.players.map((p) =>
      '<div class="lobby-seat' + (p.you ? ' you' : '') + '">' +
      '<span class="avatar">' + p.name.charAt(0).toUpperCase() + '</span>' +
      '<span class="lname">' + p.name + (p.seat === 0 ? ' 👑' : '') + (p.you ? ' (you)' : '') + '</span></div>'
    ).join('');
    const empties = Math.max(0, state.maxSeats - state.players.length);
    const botNote = empties > 0
      ? '<div class="lobby-seat bot">' + empties + ' empty seat' + (empties > 1 ? 's' : '') + ' → filled with bots</div>'
      : '';
    $('#lobbyPlayers').innerHTML = seats + botNote;
    $('#lobbyHint').textContent = state.youAreHost
      ? 'Share code ' + state.code + ' with players on your network, then press Start.'
      : 'Waiting for the host to start…';
    $('#btnLobbyStart').style.display = state.youAreHost ? '' : 'none';
  }

  // Round-end controls. Single player: a plain "Next Round" button.
  // Multiplayer: EVERY player must press "I'm Ready"; the round advances only
  // when all connected humans have confirmed.
  function setupRoundControls() {
    const btn = $('#btnNextRound');
    const wait = $('#roundWait');
    if (!btn) return;
    btn.disabled = false;
    if (isMultiplayer) {
      btn.textContent = "I'm Ready ✓";
      wait.style.display = '';
      wait.textContent = 'All players must confirm to continue.';
    } else {
      btn.textContent = 'Next Round';
      wait.style.display = 'none';
    }
  }

  // Game-over: only the host can start a new game.
  function setupGameOverControls() {
    const host = !isMultiplayer || isHost;
    const b = $('#btnPlayAgain'), w = $('#gameOverWait');
    if (b) b.style.display = host ? '' : 'none';
    if (w) w.style.display = host ? 'none' : '';
  }

  // Update the "who's ready" status shown in the round-summary overlay.
  function renderReady(m) {
    const wait = $('#roundWait');
    if (!wait) return;
    const ticks = m.humans.map((seat) =>
      m.names[seat] + (m.ready.indexOf(seat) >= 0 ? ' ✓' : ' …')
    ).join('   ·   ');
    wait.style.display = '';
    wait.innerHTML = '<b>' + m.ready.length + ' / ' + m.humans.length + ' ready</b> &nbsp; ' + ticks;
  }

  function leaveMultiplayer() {
    if (net) { net.send({ t: 'leave' }); }
    netEngine = null; isMultiplayer = false;
    BQ.Sound.stopMusic();
    ui.show('menu');
  }

  function leaveMultiplayer() {
    if (net) { net.send({ t: 'leave' }); }
    netEngine = null; isMultiplayer = false;
    BQ.Sound.stopMusic();
    ui.show('menu');
  }

  /* ---- Event wiring ----------------------------------------------------- */
  function wire() {
    // Menu
    $('#btnPlay').addEventListener('click', () => { BQ.Sound.unlock(); BQ.Sound.click(); ui.show('setup'); $('#playerName').focus(); });
    $('#btnMulti').addEventListener('click', () => { BQ.Sound.unlock(); BQ.Sound.click(); openMultiplayer(); });
    $('#btnRules').addEventListener('click', () => { BQ.Sound.click(); $('#rulesModal').innerHTML = rulesHtml(); ui.openOverlay('rulesOverlay'); });
    $('#btnSettingsMenu').addEventListener('click', () => { BQ.Sound.click(); buildSettingsForm(); ui.openOverlay('settingsOverlay'); });

    // Multiplayer screens
    $('#btnCreate').addEventListener('click', () => { BQ.Sound.click(); createRoom(); });
    $('#btnJoin').addEventListener('click', () => { BQ.Sound.click(); joinRoom(); });
    $('#btnMpBack').addEventListener('click', () => { BQ.Sound.click(); ui.show('menu'); });
    $('#btnLobbyStart').addEventListener('click', () => { BQ.Sound.click(); if (net) net.send({ t: 'start' }); });
    $('#btnLobbyLeave').addEventListener('click', () => { BQ.Sound.click(); leaveMultiplayer(); });
    $('#mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

    // Setup
    $('#btnBackMenu').addEventListener('click', () => { BQ.Sound.click(); ui.show('menu'); });
    $('#btnStart').addEventListener('click', startFromSetup);
    $('#playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') startFromSetup(); });

    function startFromSetup() {
      const name = ($('#playerName').value || '').trim() || 'You';
      BQ.Sound.click();
      newGame(name);
    }

    // In-game toolbar
    $('#btnScores').addEventListener('click', () => { BQ.Sound.click(); ui.renderScoreboard(); ui.openOverlay('scoreOverlay'); });
    $('#btnSettings').addEventListener('click', () => { BQ.Sound.click(); buildSettingsForm(); ui.openOverlay('settingsOverlay'); });
    $('#btnSound').addEventListener('click', () => {
      rules.soundEnabled = !rules.soundEnabled;
      BQ.Sound.setEnabled(rules.soundEnabled);
      saveRules(rules);
      $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
      if (rules.soundEnabled) { BQ.Sound.startMusic(); BQ.Sound.click(); }
    });
    $('#btnQuit').addEventListener('click', () => {
      if (!confirm('Quit to main menu? Current game will be lost.')) return;
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic();
      ui.show('menu');
    });

    // Round overlay — single player advances immediately; multiplayer waits
    // for ALL players to confirm "ready".
    $('#btnNextRound').addEventListener('click', () => {
      BQ.Sound.click();
      if (isMultiplayer) {
        net.send({ t: 'ready' });
        const btn = $('#btnNextRound');
        btn.disabled = true;
        btn.textContent = 'Waiting for others…';
      } else {
        ui.closeOverlay('roundOverlay');
        engine.startRound();
      }
    });

    // Settings overlay
    $('#btnSaveRules').addEventListener('click', () => {
      readSettingsForm();
      BQ.Sound.click();
      ui.closeOverlay('settingsOverlay');
      if (net && net.connected && isHost) net.send({ t: 'rules', rules }); // host syncs room rules (pre-start)
      ui.toast('Rules saved — applied next round');
      $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
    });
    $('#btnResetRules').addEventListener('click', () => {
      rules = BQ.cloneRules();
      saveRules(rules);
      buildSettingsForm();
      BQ.Sound.click();
      if (engine) engine.rules = rules;
      ui.toast('Defaults restored');
    });

    // Game over
    $('#btnPlayAgain').addEventListener('click', () => {
      BQ.Sound.click();
      ui.closeOverlay('gameOverOverlay');
      if (isMultiplayer) net.send({ t: 'again' });
      else newGame(engine.players[0].name);
    });
    $('#btnGoMenu').addEventListener('click', () => {
      BQ.Sound.click();
      ui.closeOverlay('gameOverOverlay');
      if (isMultiplayer) { leaveMultiplayer(); return; }
      BQ.Sound.stopMusic();
      ui.show('menu');
    });

    // initial sound icon state
    $('#btnSound').textContent = rules.soundEnabled ? '🔊' : '🔇';
    BQ.Sound.setEnabled(rules.soundEnabled);
  }

  document.addEventListener('DOMContentLoaded', wire);
})(window);
