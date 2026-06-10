/* =============================================================================
 * Black Queen — FX ENGINE (canvas particle system + CSS-3D set pieces)
 * -----------------------------------------------------------------------------
 * All particles — floating reactions, emoji rain, sparks, shockwaves, confetti,
 * attack actors — run on ONE full-screen <canvas> with a requestAnimationFrame
 * physics loop (velocity, gravity, drag, sway, spin, trails). That gives full
 * control over motion and costs far less than hundreds of DOM nodes.
 *
 * Two things deliberately stay in the DOM, where they genuinely work better:
 *   • the Black Queen 3D card (CSS perspective flip — true 3D)
 *   • the top "gift banner" (text layout + shimmer)
 *
 * Public API: floatEmoji, emojiRain, banner, heartHit, queenCinematic,
 *             punchSlam, confetti3D, attack, ATTACKS.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ = root.BQ || {};

  function fxOn() {
    return !BQ.Prefs || BQ.Prefs.get().fx !== false;
  }

  /* ===========================================================================
   * Canvas particle engine
   * =========================================================================*/
  const MAX_PARTICLES = 600;

  const CV = {
    el: null,
    g: null,
    parts: [],
    raf: 0,
    last: 0,

    ensure() {
      if (this.el) return this;
      const c = document.createElement('canvas');
      c.id = 'fxCanvas';
      document.body.appendChild(c);
      this.el = c;
      this.g = c.getContext('2d');
      const fit = () => {
        const d = Math.min(root.devicePixelRatio || 1, 2);
        c.width = Math.floor(innerWidth * d);
        c.height = Math.floor(innerHeight * d);
        this.g.setTransform(d, 0, 0, d, 0, 0);
      };
      fit();
      root.addEventListener('resize', fit);
      this._tick = this._tick.bind(this);
      return this;
    },

    add(p) {
      this.ensure();
      if (this.parts.length >= MAX_PARTICLES) return;
      p.life = 0;
      this.parts.push(p);
      if (!this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this._tick);
      }
    },

    _tick(now) {
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const g = this.g;
      g.clearRect(0, 0, innerWidth, innerHeight);

      const live = [];
      for (const p of this.parts) {
        p.life += dt;
        if (p.update) p.update(p, dt);
        if (p.life >= p.ttl) {
          if (p.onDone) { const fn = p.onDone; p.onDone = null; fn(); }
          continue;
        }
        // physics
        p.vy += (p.gravity || 0) * dt;
        if (p.drag) { p.vx *= (1 - p.drag * dt); p.vy *= (1 - p.drag * dt); }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.vr) p.rot = (p.rot || 0) + p.vr * dt;
        this._draw(g, p);
        live.push(p);
      }
      this.parts = live;
      if (this.parts.length) {
        this.raf = requestAnimationFrame(this._tick);
      } else {
        this.raf = 0;
        g.clearRect(0, 0, innerWidth, innerHeight);
      }
    },

    _draw(g, p) {
      const t = p.life / p.ttl;
      // default alpha: quick fade-in, ease-out fade
      let a = p.alpha != null ? p.alpha : Math.min(1, p.life * 8) * (1 - t * t);
      if (a <= 0) return;
      const sway = p.swayAmp ? Math.sin(p.life * (p.swayFreq || 3) + (p.swayPhase || 0)) * p.swayAmp : 0;
      const x = p.x + sway;
      const y = p.y;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, a));

      if (p.kind === 'glyph') {
        const size = p.size * (p.pulse ? 1 + Math.sin(p.life * p.pulse) * 0.18 : 1) * (p.grow ? (0.35 + 0.65 * Math.min(1, p.life * 4)) : 1);
        g.translate(x, y);
        if (p.rot) g.rotate(p.rot);
        if (p.flipX) g.scale(-1, 1);
        g.font = Math.round(size) + 'px serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (p.shadow) { g.shadowColor = p.shadow; g.shadowBlur = 18; }
        g.fillText(p.glyph, 0, 0);

      } else if (p.kind === 'text') {
        g.translate(x, y);
        g.font = '800 ' + Math.round(p.size) + 'px "Segoe UI", system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = p.color || '#fff';
        g.shadowColor = 'rgba(0,0,0,0.7)';
        g.shadowBlur = 8;
        g.fillText(p.text, 0, 0);

      } else if (p.kind === 'rect') {
        // confetti with fake 3D tumble: height squashes on cos(rotX)
        g.translate(x, y);
        g.rotate(p.rot || 0);
        const squash = Math.cos((p.rotX = (p.rotX || 0) + (p.vrX || 6) * 0.016));
        g.scale(1, Math.max(0.12, Math.abs(squash)));
        g.fillStyle = p.color;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);

      } else if (p.kind === 'ring') {
        const r = p.size * (0.1 + 0.9 * (1 - Math.pow(1 - t, 2)));
        g.strokeStyle = p.color;
        g.lineWidth = Math.max(1, p.width * (1 - t));
        g.shadowColor = p.color;
        g.shadowBlur = 16;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();

      } else if (p.kind === 'flash') {
        const r = p.size * (0.5 + t);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(255,255,255,' + (0.9 * (1 - t)) + ')');
        grad.addColorStop(0.45, 'rgba(255,216,119,' + (0.5 * (1 - t)) + ')');
        grad.addColorStop(1, 'rgba(255,216,119,0)');
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);

      } else if (p.kind === 'streak') {
        g.strokeStyle = p.color || 'rgba(255,216,119,0.9)';
        g.lineWidth = p.width || 2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - p.vx * 0.07, y - p.vy * 0.07);
        g.stroke();
      }
      g.restore();
    },
  };

  function shake() {
    const el = document.getElementById('game') || document.getElementById('app');
    if (!el) return;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 550);
  }

  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ===========================================================================
   * Public FX
   * =========================================================================*/
  const FX = {

    /* ---- live-stream style floating reaction (rises up the right side) ---- */
    floatEmoji(emoji, count) {
      if (!fxOn()) return;
      const n = Math.min(count || 5, 12);
      for (let i = 0; i < n; i++) {
        CV.add({
          kind: 'glyph', glyph: emoji,
          x: innerWidth * rnd(0.72, 0.94), y: innerHeight + 30,
          vx: 0, vy: -innerHeight * rnd(0.18, 0.3),
          swayAmp: rnd(14, 44), swayFreq: rnd(2, 4), swayPhase: rnd(0, 6),
          size: rnd(26, 50), grow: true,
          ttl: rnd(2.8, 4.4),
        });
      }
    },

    /* ---- emoji rain across the whole table --------------------------------- */
    emojiRain(emoji, count) {
      if (!fxOn()) return;
      const n = Math.min(count || 14, 28);
      for (let i = 0; i < n; i++) {
        CV.add({
          kind: 'glyph', glyph: emoji,
          x: Math.random() * innerWidth, y: -40 - Math.random() * innerHeight * 0.3,
          vx: rnd(-12, 12), vy: innerHeight * rnd(0.28, 0.5),
          vr: rnd(-3, 3),
          size: rnd(18, 42),
          ttl: rnd(2.2, 3.6),
        });
      }
    },

    /* ---- top "gift banner" (DOM: text layout + shimmer) -------------------- */
    banner(title, sub, icon, theme) {
      if (!fxOn()) return;
      const el = document.createElement('div');
      el.className = 'fx-banner ' + (theme || 'gold');
      el.innerHTML =
        '<span class="fxb-icon"></span>' +
        '<span class="fxb-text"><b></b><small></small></span>';
      el.querySelector('.fxb-icon').textContent = icon || '✦';
      el.querySelector('b').textContent = title || '';
      el.querySelector('small').textContent = sub || '';
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => el.classList.add('out'), 2400);
      setTimeout(() => el.remove(), 3100);
    },

    /* ---- somebody ate hearts: beating heart + burst at their seat ---------- */
    heartHit(anchorEl, points) {
      if (!fxOn()) return;
      const r = anchorEl ? anchorEl.getBoundingClientRect()
                         : { left: innerWidth / 2 - 40, top: innerHeight / 2 - 40, width: 80, height: 80 };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      CV.add({ kind: 'glyph', glyph: '❤️', x: cx, y: cy, vx: 0, vy: -26, size: 54, pulse: 9, shadow: 'rgba(192,57,43,0.8)', ttl: 1.3 });
      CV.add({ kind: 'text', text: '+' + points + ' ♥', x: cx, y: cy - 46, vx: 0, vy: -40, size: 19, color: '#ff8a7a', ttl: 1.3 });
      const n = Math.min(6 + points * 2, 16);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(0, 0.5);
        const sp = rnd(90, 220);
        CV.add({
          kind: 'glyph', glyph: Math.random() < 0.3 ? '💔' : '❤️',
          x: cx, y: cy,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
          gravity: 360, drag: 1.4, vr: rnd(-4, 4),
          size: rnd(13, 26), ttl: rnd(0.9, 1.4),
        });
      }
    },

    /* ---- HARD PUNCH slam: flash + shockwaves + sparks + streaks ------------ */
    punchSlam(targetEl) {
      if (!fxOn()) return;
      const r = targetEl ? targetEl.getBoundingClientRect()
                         : { left: innerWidth / 2 - 40, top: innerHeight / 2 - 50, width: 80, height: 100 };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      CV.add({ kind: 'flash', x: cx, y: cy, vx: 0, vy: 0, size: 130, ttl: 0.3 });
      CV.add({ kind: 'ring', x: cx, y: cy, vx: 0, vy: 0, size: 190, width: 7, color: '#ffd877', ttl: 0.65 });
      setTimeout(() => CV.add({ kind: 'ring', x: cx, y: cy, vx: 0, vy: 0, size: 240, width: 5, color: '#c0392b', ttl: 0.7 }), 120);

      const sparks = ['✨', '💥', '⭐', '🔥'];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2 + rnd(0, 0.4);
        const sp = rnd(220, 480);
        CV.add({
          kind: 'glyph', glyph: sparks[i % sparks.length],
          x: cx, y: cy,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          gravity: 500, drag: 2.4, vr: rnd(-6, 6),
          size: rnd(14, 28), shadow: 'rgba(255,216,119,0.8)',
          ttl: rnd(0.7, 1.1),
        });
        CV.add({
          kind: 'streak',
          x: cx, y: cy,
          vx: Math.cos(a) * sp * 1.5, vy: Math.sin(a) * sp * 1.5,
          drag: 3, width: rnd(1.5, 3),
          ttl: rnd(0.25, 0.4),
        });
      }
      shake();
    },

    /* ---- THE BIG ONE: Black Queen cinematic --------------------------------
       DOM centerpiece (true CSS-3D card spin + text), canvas queen rain.    */
    queenCinematic(name, taunt, pts, isYou) {
      if (!fxOn()) return;
      const o = document.createElement('div');
      o.className = 'fxq' + (isYou ? ' you' : '');
      o.innerHTML =
        '<div class="fxq-flash"></div>' +
        '<div class="fxq-card3d"><div class="fxq-spin">' +
          '<div class="fxq-face fxq-front"></div>' +
          '<div class="fxq-face fxq-back"><span>♛</span></div>' +
        '</div></div>' +
        '<div class="fxq-name"></div>' +
        '<div class="fxq-taunt"></div>' +
        '<div class="fxq-pts"></div>';
      o.querySelector('.fxq-name').textContent = name + (isYou ? ' (You)' : '');
      o.querySelector('.fxq-taunt').textContent = taunt || '';
      o.querySelector('.fxq-pts').textContent = '+' + (pts || 12);
      document.body.appendChild(o);
      requestAnimationFrame(() => o.classList.add('show'));

      // shockwaves + queen rain on canvas
      const cx = innerWidth / 2, cy = innerHeight * 0.44;
      [0, 350, 700].forEach((d, i) => setTimeout(() => {
        CV.add({ kind: 'ring', x: cx, y: cy, vx: 0, vy: 0, size: Math.min(innerWidth, innerHeight) * 0.7, width: 6, color: i === 1 ? '#c0392b' : '#ffd877', ttl: 1.4 });
      }, d));
      this.emojiRain('♛', 18);
      setTimeout(shake, 350);
      setTimeout(() => o.classList.add('out'), 2900);
      setTimeout(() => o.remove(), 3500);
    },

    /* ---- 3D tumbling confetti ----------------------------------------------- */
    confetti3D(count) {
      if (!fxOn()) return;
      const colors = ['#e9c46a', '#c0392b', '#2ecc71', '#3498db', '#fff', '#ffd877', '#9b59b6'];
      const n = Math.min(count || 80, 160);
      for (let i = 0; i < n; i++) {
        CV.add({
          kind: 'rect',
          x: Math.random() * innerWidth, y: -20 - Math.random() * 60,
          vx: rnd(-30, 30), vy: innerHeight * rnd(0.22, 0.42),
          vr: rnd(-4, 4), vrX: rnd(3, 10),
          w: rnd(7, 13), h: rnd(10, 18),
          color: colors[i % colors.length],
          ttl: rnd(2.6, 4.6),
        });
      }
    },

    /* =========================================================================
     * ATTACK TAUNTS — TikTok-gift style "pressure" animations, sent on demand
     * (one per move). A huge actor charges across the table with a particle
     * trail, plus a banner naming the sender.
     * =======================================================================*/
    ATTACKS: [
      { id: 'lion', label: 'Lion', emoji: '🦁', title: 'ROARRR!' },
      { id: 'dragon', label: 'Dragon', emoji: '🐉', title: 'Dragon fire!' },
      { id: 'bomb', label: 'Bomb', emoji: '💣', title: 'Incoming!' },
      { id: 'ghost', label: 'Ghost', emoji: '👻', title: 'Boo!' },
      { id: 'skull', label: 'Doom', emoji: '💀', title: 'Your end is near…' },
    ],

    // anchor: {x, y} of the ATTACKER's seat on this viewer's table — the stamp
    // pops up right where the sender sits, so everyone sees who is roaring.
    attack(kind, fromName, anchor) {
      if (!fxOn()) return;
      const def = this.ATTACKS.find((a) => a.id === kind);
      if (!def) return;
      const big = Math.min(innerWidth, innerHeight);
      this.banner((fromName ? fromName + ' — ' : '') + def.title, 'Keep your nerve…', def.emoji, 'queen');

      // COMPACT attack stamp: pops in at the attacker's seat (top-center as a
      // fallback), pulses in place and fades — no full-screen travel.
      // All garnish particles are slow + short-lived, contained near the stamp.
      const aSize = Math.min(big * 0.17, innerHeight * 0.18);
      const pad = aSize * 0.65;
      const ax = anchor ? Math.max(pad, Math.min(innerWidth - pad, anchor.x)) : innerWidth / 2;
      const ay = anchor ? Math.max(pad, Math.min(innerHeight - pad, anchor.y)) : innerHeight * 0.15;

      const stamp = (glyph, opts) => CV.add(Object.assign({
        kind: 'glyph', glyph,
        x: ax, y: ay, vx: 0, vy: 0,
        size: aSize, grow: true, pulse: 4,
        shadow: 'rgba(0,0,0,0.55)',
        ttl: 1.6,
      }, opts));

      const garnish = (glyph, n, spread) => {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rnd(0, 0.6);
          CV.add({
            kind: 'glyph', glyph,
            x: ax + Math.cos(a) * aSize * 0.4, y: ay + Math.sin(a) * aSize * 0.3,
            vx: Math.cos(a) * (spread || 60), vy: Math.sin(a) * (spread || 60) - 20,
            drag: 2.5, size: rnd(13, 24), ttl: rnd(0.6, 1),
          });
        }
      };

      CV.add({ kind: 'ring', x: ax, y: ay, vx: 0, vy: 0, size: aSize * 1.15, width: 5, color: kind === 'skull' ? '#c0392b' : '#ffd877', ttl: 0.7 });

      if (kind === 'lion') {
        stamp('🦁');
        garnish('💨', 5, 70);
        setTimeout(shake, 200);

      } else if (kind === 'dragon') {
        stamp('🐉');
        garnish('🔥', 7, 65);

      } else if (kind === 'bomb') {
        stamp('💣', {
          ttl: 0.55, vr: 4,
          onDone() {
            CV.add({ kind: 'flash', x: ax, y: ay, vx: 0, vy: 0, size: aSize * 1.2, ttl: 0.3 });
            stamp('💥', { ttl: 0.7, pulse: 10 });
            garnish('🔥', 6, 90);
            garnish('✨', 5, 80);
            shake();
          },
        });

      } else if (kind === 'ghost') {
        stamp('👻', {
          ttl: 2,
          update(p) { p.alpha = 0.45 + Math.sin(p.life * 5) * 0.4; },   // spooky flicker
        });
        garnish('✨', 5, 50);

      } else if (kind === 'skull') {
        stamp('💀', { ttl: 1.8, pulse: 6, shadow: 'rgba(192,57,43,0.9)' });
        garnish('💀', 4, 55);
        setTimeout(shake, 400);
      }
    },
  };

  BQ.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
