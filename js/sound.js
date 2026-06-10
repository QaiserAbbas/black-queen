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
  };
  const sampleBufs = {};
  let samplesRequested = false;

  function loadSamples() {
    if (samplesRequested || typeof fetch !== 'function') return;
    samplesRequested = true;
    const c = ensure();
    if (!c) return;
    Object.keys(SAMPLE_URLS).forEach((key) => {
      fetch(SAMPLE_URLS[key])
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('http ' + r.status))))
        .then((ab) => c.decodeAudioData(ab))
        .then((buf) => { sampleBufs[key] = buf; })
        .catch(() => { /* keep synth fallback */ });
    });
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

    click() { tone(660, 0.06, 'square', 0.12); },
    hover() { tone(880, 0.03, 'sine', 0.05); },

    deal() { noise(0.12, 0.18, 1600); tone(420, 0.05, 'sine', 0.08); },
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

    trickWin() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      tone(523, 0.10, 'sine', 0.2, t);
      tone(659, 0.10, 'sine', 0.2, t + 0.08);
      tone(784, 0.16, 'sine', 0.22, t + 0.16);
    },

    penalty() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      tone(196, 0.20, 'sawtooth', 0.18, t);
      tone(165, 0.28, 'sawtooth', 0.18, t + 0.12);
    },

    roundEnd() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [523, 587, 659, 784].forEach((f, i) => tone(f, 0.18, 'triangle', 0.16, t + i * 0.09));
    },

    win() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        tone(f, 0.35, 'sine', 0.22, t + i * 0.12));
    },

    lose() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      [392, 349, 311, 262].forEach((f, i) =>
        tone(f, 0.30, 'sawtooth', 0.16, t + i * 0.14));
    },

    error() { tone(150, 0.18, 'square', 0.18); },

    /* ---- FX-engine companions --------------------------------------------- */

    // Air sweep for banners flying in.
    whoosh() {
      const c = ensure(); if (!c) return;
      noise(0.35, 0.3, 800, c.currentTime, 'bandpass');
      glide(300, 1800, 0.3, 'sine', 0.06);
    },

    // Little pop for floating emoji reactions.
    pop() { glide(320, 900, 0.09, 'sine', 0.16); },

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

    // The full Black Queen sting: thunder + dissonant stab + tolling bell.
    queenDoom() {
      const c = ensure(); if (!c) return;
      const t = c.currentTime;
      this.thunder();
      tone(466, 0.5, 'sawtooth', 0.14, t + 0.25);    // tritone-ish stab
      tone(622, 0.5, 'sawtooth', 0.12, t + 0.25);
      tone(330, 0.6, 'sawtooth', 0.12, t + 0.28);
      bell(880, 1.6, 0.22, t + 0.55);                // the toll
      bell(440, 2.0, 0.18, t + 1.05);
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
