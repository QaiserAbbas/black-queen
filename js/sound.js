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

  function ensure() {
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
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
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Filtered noise burst — used for shuffles / card slides.
  function noise(dur, vol, filterFreq, when) {
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
    filter.type = 'highpass';
    filter.frequency.value = filterFreq || 1200;
    const g = c.createGain();
    g.gain.value = vol || 0.25;
    src.connect(filter); filter.connect(g); g.connect(master);
    src.start(t0);
  }

  const Sound = {
    setEnabled(v) { enabled = !!v; if (!v) this.stopMusic(); },
    isEnabled() { return enabled; },
    unlock() { ensure(); },          // call on first user gesture

    click() { tone(660, 0.06, 'square', 0.12); },
    hover() { tone(880, 0.03, 'sine', 0.05); },

    deal() { noise(0.12, 0.18, 1600); tone(420, 0.05, 'sine', 0.08); },
    play() { noise(0.10, 0.20, 900); tone(300, 0.06, 'triangle', 0.10); },

    shuffle() {
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

    /* ---- ambient lounge loop --------------------------------------------- */
    startMusic() {
      if (!enabled || musicOn) return;
      const c = ensure(); if (!c) return;
      musicOn = true;
      // A slow, mellow ii–V–I-ish pad cycle.
      const chords = [
        [220, 277, 330], [196, 247, 294], [262, 330, 392], [233, 294, 349],
      ];
      let step = 0;
      const loop = () => {
        if (!musicOn || !enabled) return;
        const t = c.currentTime;
        const chord = chords[step % chords.length];
        chord.forEach((f) => {
          const osc = c.createOscillator();
          const g = c.createGain();
          osc.type = 'sine';
          osc.frequency.value = f;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.04, t + 0.6);
          g.gain.linearRampToValueAtTime(0.0001, t + 2.6);
          osc.connect(g); g.connect(master);
          osc.start(t); osc.stop(t + 2.8);
        });
        step++;
        musicTimer = setTimeout(loop, 2600);
      };
      loop();
    },
    stopMusic() {
      musicOn = false;
      if (musicTimer) clearTimeout(musicTimer);
      musicTimer = null;
    },
  };

  BQ.Sound = Sound;
})(window);
