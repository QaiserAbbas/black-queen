/* =============================================================================
 * Black Queen — SOUND ENGINE
 * All sound effects & ambient music are SYNTHESIZED with the Web Audio API.
 * No audio files needed — the game works fully offline by just opening it.
 * Toggle with rules.soundEnabled or BQ.Sound.setEnabled(false).
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  let ctx = null;
  let enabled = true;
  let master = null;
  let musicOn = false;
  let musicTimer = null;

  /* ---- mixer: per-channel gain buses ----------------------------------------
   * master → destination; every channel bus → master. Volumes are 0..1 sliders
   * (Settings → Sound Volumes), kept in `volumes` so they survive until the
   * AudioContext exists and persist via BQ.Prefs. */
  const MASTER_BASE = 0.6;                  // overall gain at master volume 1.0
  const CHANNELS = ['music', 'cards', 'punch', 'fx', 'ui'];
  const volumes = { master: 1, music: 1, cards: 1, punch: 1, fx: 1, ui: 1 };
  const busNodes = {};
  let activeBus = null;                     // set per-call by the bus router

  function ensure() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_BASE * volumes.master;
      master.connect(ctx.destination);
      CHANNELS.forEach((name) => {
        const busGain = ctx.createGain();
        busGain.gain.value = volumes[name];
        busGain.connect(master);
        busNodes[name] = busGain;
      });
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Where a sound plugs in: its channel bus, or master when unrouted.
  function out() { return activeBus || master; }

  /* ---- real audio samples (sounds/) ----------------------------------------
   * Loaded lazily on the first user gesture. If a file is missing or we're
   * running from file:// (fetch unavailable), every caller falls back to the
   * synthesized version — the game never goes silent. */
  const SAMPLE_URLS = {
    shuffle: 'sounds/freesound_community-shuffle-cards-46455.mp3',
    place: 'sounds/oxidvideos-placing-playing-card-522514.mp3',
    punch: 'sounds/freesound_community-hard-punch-90179.mp3',
    roar: 'sounds/dragon-studio-cartoon-lion-roar-487672.mp3',
    pop: 'sounds/dragon-studio-bubble-gum-popping-467465.mp3',
    laugh: 'sounds/poorartistt-joyful-female-laughing-sound-no-copyright-sfx-547158.mp3',
    // Optional overrides — drop a matching file into sounds/ and it replaces
    // the synthesized version automatically (missing files are fine).
    click: 'sounds/click.mp3',
    deal: 'sounds/deal.mp3',
    trickWin: 'sounds/trick-win.mp3',
    roundEnd: 'sounds/round-end.mp3',
    win: 'sounds/eaglaxle-gaming-victory-464016.mp3',
    lose: 'sounds/ribhavagrawal-you-loseheavy-echoed-voice-230555.mp3',
    error: 'sounds/error.mp3',
    dragon: 'sounds/dragon-studio-dragon-growl-7-364612.mp3',
    bomb: 'sounds/bomb.mp3',
    ghost: 'sounds/dragon-studio-i-see-you-creepy-ghost-whisper-401711.mp3',
    skull: 'sounds/skull.mp3',
  };
  const sampleBufs = {};
  let samplesRequested = false;

  function loadSamples() {
    if (samplesRequested || typeof fetch !== 'function') return;
    samplesRequested = true;
    const c = ensure();
    if (!c) return;
    const fetchOne = (key) => {
      fetch(SAMPLE_URLS[key])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('http ' + r.status))))
        .then((ab) => c.decodeAudioData(ab))
        .then((buf) => { sampleBufs[key] = buf; })
        .catch(() => { /* keep synth fallback */ });
    };
    // Ask the server which files exist, fetch only those (no 404 noise for
    // optional overrides). On other hosts fall back to the core three.
    fetch('sounds/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no manifest'))))
      .then((files) => {
        const have = new Set(files);
        Object.keys(SAMPLE_URLS).forEach((key) => {
          if (have.has(SAMPLE_URLS[key].split('/').pop())) fetchOne(key);
        });
      })
      .catch(() => { ['shuffle', 'place', 'punch'].forEach(fetchOne); });
  }

  // Play a loaded sample. Returns false when unavailable → caller synthesizes.
  function sample(name, vol, rate) {
    if (!enabled) return true;            // muted counts as handled
    const c = ensure();
    const buf = c && sampleBufs[name];
    if (!buf) return false;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate || 1;
    const g = c.createGain();
    g.gain.value = vol == null ? 1 : vol;
    src.connect(g); g.connect(out());
    src.start();
    return true;
  }

  // Generic tone with an ADSR-ish envelope.
  function tone(freq, dur, type, vol, when) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = (when || c.currentTime);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.3, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(out());
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Filtered noise burst — shuffles, card slides, whooshes, thunder.
  function noise(dur, vol, filterFreq, when, filterType) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = (when || c.currentTime);
    const frames = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = filterType || 'highpass';
    filter.frequency.value = filterFreq || 1200;
    const g = c.createGain();
    g.gain.value = vol || 0.25;
    src.connect(filter); filter.connect(g); g.connect(out());
    src.start(t0);
  }

  // A tone whose pitch glides — pops, whooshes, drops.
  function glide(f0, f1, dur, type, vol, when) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = (when || c.currentTime);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol || 0.25, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(out());
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  // Bell-like strike: a tone plus a detuned partial with a long decay.
  function bell(freq, dur, vol, when) {
    if (!enabled) return;
    const c = ensure();
    if (!c) return;
    const t0 = (when || c.currentTime);
    [1, 2.76, 5.4].forEach((mult, i) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const v = (vol || 0.2) / (i + 1.5);
      g.gain.setValueAtTime(v, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / (i * 0.6 + 1));
      osc.connect(g); g.connect(out());
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    });
  }

  const Sound = {
    setEnabled(v) { enabled = !!v; if (!v) this.stopMusic(); },
    isEnabled() { return enabled; },
    unlock() { ensure(); loadSamples(); },   // call on first user gesture

    /* ---- per-channel volume mixer (Settings → Sound Volumes) -------------- */
    setVolume(channel, v) {
      v = Math.max(0, Math.min(1, Number(v)));
      if (isNaN(v)) return;
      volumes[channel] = v;
      if (channel === 'master') { if (master) master.gain.value = MASTER_BASE * v; }
      else if (busNodes[channel]) busNodes[channel].gain.value = v;
    },
    getVolume(channel) { return volumes[channel] != null ? volumes[channel] : 1; },
    applyVolumes(map) {
      if (!map) return;
      Object.keys(map).forEach((k) => this.setVolume(k, map[k]));
    },

    // Soft felt-table "tick" instead of a raw square buzz.
    click() {
      if (sample('click', 0.6)) return;
      noise(0.025, 0.08, 2400, undefined, 'bandpass');
      glide(900, 640, 0.06, 'sine', 0.12);
    },
    hover() { glide(1100, 900, 0.04, 'sine', 0.05); },

    deal() {
      if (sample('deal', 0.8)) return;
      noise(0.1, 0.16, 1800, undefined, 'bandpass');
      glide(500, 380, 0.06, 'sine', 0.07);
    },
    play() {
      if (sample('place', 0.9)) return;
      noise(0.10, 0.20, 900); tone(300, 0.06, 'triangle', 0.10);
    },

    // Ctrl-click slam: the real punch recording, with a synthesized sub-boom
    // underneath for weight, and a sparkle tail for the magic.
    punch() {
      const had = sample('punch', 1);
      const c = ensure(); if (!c) return;
      if (!had) {                                  // full synth fallback
        noise(0.22, 0.5, 200, c.currentTime, 'lowpass');
        glide(150, 40, 0.3, 'sine', 0.4);
      }
      glide(110, 35, 0.35, 'sine', 0.22);          // sub-boom
      this.sparkle();
    },

    shuffle() {
      if (sample('shuffle', 0.8)) return;
      const c = ensure(); if (!c) return;
      for (let i = 0; i < 8; i++) noise(0.07, 0.12, 1400, c.currentTime + i * 0.05);
    },

    // Rising chime with a soft octave shimmer + bell tail.
    trickWin() {
      if (sample('trickWin', 0.8)) return;
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [[523, 0], [659, 0.07], [784, 0.14]].forEach(([f, d]) => {
        tone(f, 0.13, 'sine', 0.16, t + d);
        tone(f * 2, 0.1, 'sine', 0.05, t + d);
      });
      bell(1568, 0.8, 0.1, t + 0.2);
    },

    // Rounder "uh-oh": triangle slides with a felt thump (no buzzy saws).
    penalty() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      glide(220, 150, 0.25, 'triangle', 0.2, t);
      glide(165, 110, 0.3, 'triangle', 0.16, t + 0.1);
      noise(0.15, 0.12, 300, t, 'lowpass');
    },

    roundEnd() {
      if (sample('roundEnd', 0.8)) return;
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [523, 587, 659, 784].forEach((f, i) => tone(f, 0.16, 'triangle', 0.14, t + i * 0.09));
      bell(1047, 1.2, 0.12, t + 0.36);
    },

    win() {
      if (sample('win', 0.85)) return;
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [523, 659, 784, 1047, 1319].forEach((f, i) => {
        tone(f, 0.32, 'sine', 0.18, t + i * 0.11);
        tone(f * 1.005, 0.32, 'triangle', 0.06, t + i * 0.11);   // gentle detune = warmth
      });
      bell(2093, 1.5, 0.1, t + 0.55);
      noise(0.4, 0.05, 6000, t + 0.4);
    },

    lose() {
      if (sample('lose', 0.85)) return;
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [392, 349, 311, 262].forEach((f, i) => {
        tone(f, 0.28, 'triangle', 0.15, t + i * 0.13);
        tone(f / 2, 0.3, 'sine', 0.08, t + i * 0.13);            // sad sub layer
      });
    },

    error() {
      if (sample('error', 0.7)) return;
      glide(300, 170, 0.16, 'triangle', 0.18);
      noise(0.06, 0.08, 500, undefined, 'lowpass');
    },

    /* ---- FX-engine companions --------------------------------------------- */

    // Air sweep for banners flying in.
    whoosh() {
      const c = ensure(); if (!c) return;
      noise(0.35, 0.3, 800, c.currentTime, 'bandpass');
      glide(300, 1800, 0.3, 'sine', 0.06);
    },

    // Little pop for floating emoji reactions.
    pop() {
      if (sample('pop', 0.7)) return;
      glide(320, 900, 0.09, 'sine', 0.16);
    },

    // Rising sparkle for clean wins / nice moments.
    sparkle() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.14, 'sine', 0.12, t + i * 0.06));
      noise(0.25, 0.05, 4000, t + 0.1);
    },

    // Someone ate hearts: soft thump + sad little descending third.
    heartHit() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      noise(0.18, 0.3, 220, t, 'lowpass');           // thump
      tone(392, 0.16, 'triangle', 0.18, t + 0.05);
      tone(311, 0.26, 'triangle', 0.18, t + 0.18);
    },

    // Low rolling rumble — under the Queen cinematic.
    thunder() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      noise(1.1, 0.5, 240, t, 'lowpass');
      noise(0.8, 0.35, 180, t + 0.35, 'lowpass');
      glide(70, 32, 1.2, 'sine', 0.3, t);            // sub drop
    },

    // The full Black Queen sting: thunder + dissonant stab + tolling bell,
    // topped with a mocking laugh (sounds/…laughing….mp3) if available.
    queenDoom() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      this.thunder();
      tone(466, 0.5, 'sawtooth', 0.14, t + 0.25);    // tritone-ish stab
      tone(622, 0.5, 'sawtooth', 0.12, t + 0.25);
      tone(330, 0.6, 'sawtooth', 0.12, t + 0.28);
      bell(880, 1.6, 0.22, t + 0.55);                // the toll
      bell(440, 2.0, 0.18, t + 1.05);
      setTimeout(() => {
        activeBus = busNodes.fx || null;             // re-route: timeout escapes the bus wrapper
        try { sample('laugh', 0.8); } finally { activeBus = null; }
      }, 500);
    },

    // Lion roar — victory growl. Real roar.mp3 if present, synth otherwise.
    roar() {
      if (sample('roar', 0.9)) return;
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      glide(160, 45, 0.8, 'sawtooth', 0.28, t);
      glide(110, 38, 0.9, 'sawtooth', 0.18, t + 0.08);
      noise(0.7, 0.35, 300, t, 'lowpass');
    },

    // Attack-taunt sounds (lion roar, dragon fire, bomb, ghost, doom).
    // Each tries a real recording first (sounds/<kind>.mp3), then synthesizes.
    attack(kind) {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      if (kind === 'lion') {
        this.roar();
      } else if (kind === 'skull') {                  // doom toll + mocking laugh
        if (!sample('skull', 0.9)) {
          noise(1.0, 0.3, 200, t, 'lowpass');
          bell(440, 1.6, 0.2, t + 0.15);
          bell(220, 2.0, 0.18, t + 0.7);
        }
        setTimeout(() => {
          activeBus = busNodes.fx || null;            // re-route: timeout escapes the bus wrapper
          try { sample('laugh', 0.8); } finally { activeBus = null; }
        }, 350);
      } else if (sample(kind, 0.9)) {
        return;
      } else if (kind === 'dragon') {                 // wingbeat + fire crackle
        this.whoosh();
        for (let i = 0; i < 6; i++) noise(0.1, 0.16, 2400, t + 0.25 + i * 0.16, 'bandpass');
        glide(90, 50, 1.2, 'sawtooth', 0.12, t + 0.2);
      } else if (kind === 'bomb') {                   // whistle down… BOOM
        glide(1400, 300, 0.85, 'sine', 0.12, t);
        noise(0.9, 0.55, 220, t + 0.9, 'lowpass');
        glide(120, 30, 0.8, 'sine', 0.35, t + 0.9);
      } else if (kind === 'ghost') {                  // wailing slide, eerie shimmer
        glide(700, 160, 1.6, 'sine', 0.1, t);
        glide(710, 175, 1.6, 'sine', 0.08, t + 0.12);
        noise(1.2, 0.05, 5000, t + 0.2);
      }
    },

    // Trophy fanfare on top of win() for game over.
    fanfare() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.38], [784, 0.56], [1047, 0.66], [1319, 0.8]]
        .forEach(([f, dt]) => {
          tone(f, 0.3, 'triangle', 0.18, t + dt);
          tone(f * 1.005, 0.3, 'sawtooth', 0.07, t + dt);   // slight detune = brass-y
        });
      noise(0.5, 0.08, 5000, t + 0.8);
      bell(1568, 1.4, 0.16, t + 0.85);
    },

    /* =========================================================================
     * MUSIC — a library of synthesized ambient tracks. Each track schedules ONE
     * bar and returns its length in ms; the loop re-reads the current track
     * every bar, so switching styles takes effect seamlessly mid-play.
     * =======================================================================*/
    startMusic() {
      if (!enabled || musicOn || musicTrack === 'off') return;
      const c = ensure(); if (!c) return;
      musicOn = true;
      let step = 0;
      const loop = () => {
        if (!musicOn || !enabled) return;
        const tr = MUSIC[musicTrack];
        if (!tr) { musicOn = false; return; }
        activeBus = busNodes.music || null;   // every note this bar → music bus
        let ms;
        try { ms = tr.bar(c, c.currentTime, step++); }
        finally { activeBus = null; }
        musicTimer = setTimeout(loop, ms);
      };
      loop();
    },
    stopMusic() {
      musicOn = false;
      if (musicTimer) clearTimeout(musicTimer);
      musicTimer = null;
    },
    // Change style. Live switch if already playing; 'off' stops.
    setMusicTrack(id) {
      musicTrack = (MUSIC[id] || id === 'off') ? id : 'lounge';
      if (musicTrack === 'off') this.stopMusic();
    },
    getMusicTrack() { return musicTrack; },
  };

  /* ---- track library ------------------------------------------------------ */
  // Soft pad chord — shared helper for the slower tracks.
  function pad(c, freqs, t, dur, vol) {
    freqs.forEach((f) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.25);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(out());
      osc.start(t); osc.stop(t + dur + 0.1);
    });
  }

  // Plucked string / harpsichord-ish note: bright attack, fast decay.
  function pluck(c, f, t, vol) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g); g.connect(out());
    osc.start(t); osc.stop(t + 0.25);
  }

  const MUSIC = {
    // The original mellow ii–V–I pad cycle.
    lounge: {
      label: 'Lounge Pads',
      bar(c, t, step) {
        const chords = [[220, 277, 330], [196, 247, 294], [262, 330, 392], [233, 294, 349]];
        pad(c, chords[step % chords.length], t, 2.6, 0.04);
        return 2600;
      },
    },

    // Brushed swing: quiet pads + walking bass + offbeat hat ticks.
    jazz: {
      label: 'Jazz Club',
      bar(c, t, step) {
        const beat = 0.55;
        const chords = [[220, 277, 330], [196, 247, 294], [262, 330, 392], [233, 294, 349]];
        const roots = [110, 98, 131, 117];
        pad(c, chords[step % 4], t, beat * 4, 0.022);
        const r = roots[step % 4];
        [r, r * 5 / 4, r * 3 / 2, r * 9 / 8].forEach((f, i) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'triangle';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.07, t + i * beat);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * beat + 0.4);
          osc.connect(g); g.connect(out());
          osc.start(t + i * beat); osc.stop(t + i * beat + 0.45);
        });
        noise(0.03, 0.035, 7000, t + beat);        // brushed hats on 2 & 4
        noise(0.03, 0.035, 7000, t + beat * 3);
        return beat * 4 * 1000;
      },
    },

    // Dark and suspenseful — fits the Black Queen. Low beating drone,
    // a slow minor arpeggio and a heartbeat thump.
    tension: {
      label: 'Queen’s Court (dark)',
      bar(c, t) {
        [55, 55.7].forEach((f) => {                 // detuned = slow unease beat
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'sawtooth';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.018, t + 0.8);
          g.gain.linearRampToValueAtTime(0.0001, t + 3.2);
          osc.connect(g); g.connect(out());
          osc.start(t); osc.stop(t + 3.3);
        });
        [220, 261.6, 329.6, 261.6].forEach((f, i) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'sine';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.045, t + 0.4 + i * 0.7);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4 + i * 0.7 + 0.55);
          osc.connect(g); g.connect(out());
          osc.start(t + 0.4 + i * 0.7); osc.stop(t + 0.4 + i * 0.7 + 0.6);
        });
        noise(0.1, 0.1, 140, t, 'lowpass');         // heartbeat: lub…
        noise(0.08, 0.07, 140, t + 0.32, 'lowpass'); // …dub
        return 3200;
      },
    },

    // Upbeat chiptune — square lead over a bouncing triangle bass.
    arcade: {
      label: 'Arcade (chiptune)',
      bar(c, t, step) {
        const n = 0.21;
        const phrases = [
          [659, 784, 880, 988, 880, 784, 659, 587],
          [523, 659, 784, 880, 784, 659, 587, 523],
        ];
        const bass = step % 2 ? 131 : 110;
        phrases[step % 2].forEach((f, i) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'square';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0.028, t + i * n);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * n + n * 0.9);
          osc.connect(g); g.connect(out());
          osc.start(t + i * n); osc.stop(t + i * n + n);
        });
        [0, 4].forEach((i) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'triangle';
          osc.frequency.value = bass;
          g.gain.setValueAtTime(0.06, t + i * n);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * n + 0.35);
          osc.connect(g); g.connect(out());
          osc.start(t + i * n); osc.stop(t + i * n + 0.4);
        });
        return 8 * n * 1000;
      },
    },

    // Baroque card-salon: harpsichord-style broken chords.
    minuet: {
      label: 'Harpsichord Salon',
      bar(c, t, step) {
        const n = 0.27;
        const chords = [
          [293.7, 349.2, 440, 587.3, 440, 349.2],   // Dm
          [261.6, 329.6, 392, 523.3, 392, 329.6],   // C
          [233.1, 293.7, 349.2, 466.2, 349.2, 293.7], // Bb
          [220, 277.2, 329.6, 440, 329.6, 277.2],   // A
        ];
        chords[step % 4].forEach((f, i) => pluck(c, f, t + i * n, 0.04));
        return 6 * n * 1000;
      },
    },
  };

  let musicTrack = 'lounge';

  Sound.MUSIC_TRACKS = Object.keys(MUSIC).map((id) => ({ id, label: MUSIC[id].label }))
    .concat([{ id: 'off', label: 'No Music' }]);

  /* ---- route every public sound through its mixer channel ----------------- */
  const BUS_OF = {
    click: 'ui', hover: 'ui', error: 'ui', pop: 'ui',
    deal: 'cards', play: 'cards', shuffle: 'cards',
    punch: 'punch',
    trickWin: 'fx', penalty: 'fx', roundEnd: 'fx', win: 'fx', lose: 'fx',
    whoosh: 'fx', sparkle: 'fx', heartHit: 'fx', thunder: 'fx', queenDoom: 'fx', fanfare: 'fx',
    attack: 'fx', roar: 'fx',
  };
  Object.keys(BUS_OF).forEach((name) => {
    const orig = Sound[name];
    Sound[name] = function () {
      ensure();
      const prev = activeBus;                       // restore → nested calls keep their own bus
      activeBus = busNodes[BUS_OF[name]] || null;
      try { return orig.apply(Sound, arguments); }
      finally { activeBus = prev; }
    };
  });

  Sound.CHANNELS = [
    { id: 'master', label: 'Master volume' },
    { id: 'music', label: 'Music' },
    { id: 'cards', label: 'Cards (shuffle & play)' },
    { id: 'punch', label: 'Hard punch' },
    { id: 'fx', label: 'Effects (Queen, hearts, wins)' },
    { id: 'ui', label: 'Interface clicks' },
  ];

  BQ.Sound = Sound;
})(window);
