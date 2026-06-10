/* =============================================================================
 * Black Queen — FX ENGINE
 * -----------------------------------------------------------------------------
 * TikTok-live-style celebration effects, all DOM + CSS 3D (zero dependencies):
 *   • floatEmoji()     — reactions that float up the screen like a live stream
 *   • emojiRain()      — emojis falling across the whole table
 *   • banner()         — "gift banner" sweeping in at the top with shimmer
 *   • heartHit()       — beating 3D heart + burst when someone eats hearts
 *   • queenCinematic() — full-screen takeover when the Black Queen lands:
 *                        lightning, shockwaves, a spinning 3D card, queen rain
 *   • confetti3D()     — tumbling 3D confetti for the winner
 * Everything cleans itself up; capped so the DOM can't flood.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ = root.BQ || {};
  const MAX_PARTICLES = 160;
  let liveParticles = 0;

  function fxOn() {
    return !BQ.Prefs || BQ.Prefs.get().fx !== false;
  }

  // One fixed, pointer-transparent layer above everything.
  function layer() {
    let el = document.getElementById('fx3d');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fx3d';
      document.body.appendChild(el);
    }
    return el;
  }

  function spawn(parent, className, ttlMs) {
    if (liveParticles >= MAX_PARTICLES) return null;
    liveParticles++;
    const el = document.createElement('div');
    el.className = className;
    parent.appendChild(el);
    setTimeout(() => { el.remove(); liveParticles--; }, ttlMs);
    return el;
  }

  const FX = {

    /* ---- live-stream style floating reaction ------------------------------ */
    floatEmoji(emoji, count) {
      if (!fxOn()) return;
      const host = layer();
      const n = Math.min(count || 5, 10);
      for (let i = 0; i < n; i++) {
        const el = spawn(host, 'fx-float', 4600);
        if (!el) return;
        el.textContent = emoji;
        el.style.left = (68 + Math.random() * 26) + 'vw';
        el.style.bottom = '-50px';
        el.style.fontSize = (26 + Math.random() * 26) + 'px';
        el.style.setProperty('--sway', (Math.random() * 80 - 40) + 'px');
        el.style.animationDuration = (2.8 + Math.random() * 1.6) + 's';
        el.style.animationDelay = (i * 0.14) + 's';
      }
    },

    /* ---- emoji rain across the whole table -------------------------------- */
    emojiRain(emoji, count) {
      if (!fxOn()) return;
      const host = layer();
      const n = Math.min(count || 14, 24);
      for (let i = 0; i < n; i++) {
        const el = spawn(host, 'fx-rain', 4200);
        if (!el) return;
        el.textContent = emoji;
        el.style.left = Math.random() * 100 + 'vw';
        el.style.fontSize = (18 + Math.random() * 26) + 'px';
        el.style.animationDuration = (1.8 + Math.random() * 1.8) + 's';
        el.style.animationDelay = (Math.random() * 0.7) + 's';
      }
    },

    /* ---- top "gift banner" -------------------------------------------------
       theme: 'gold' | 'queen' | 'heart' | 'win'                              */
    banner(title, sub, icon, theme) {
      if (!fxOn()) return;
      const host = layer();
      const el = document.createElement('div');
      el.className = 'fx-banner ' + (theme || 'gold');
      el.innerHTML =
        '<span class="fxb-icon"></span>' +
        '<span class="fxb-text"><b></b><small></small></span>';
      el.querySelector('.fxb-icon').textContent = icon || '✦';
      el.querySelector('b').textContent = title || '';
      el.querySelector('small').textContent = sub || '';
      host.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => el.classList.add('out'), 2400);
      setTimeout(() => el.remove(), 3100);
    },

    /* ---- somebody ate hearts: beating heart + burst at their seat --------- */
    heartHit(anchorEl, points) {
      if (!fxOn()) return;
      const host = layer();
      const r = anchorEl ? anchorEl.getBoundingClientRect()
                         : { left: innerWidth / 2 - 40, top: innerHeight / 2 - 40, width: 80, height: 80 };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const big = spawn(host, 'fx-bigheart', 1500);
      if (big) {
        big.textContent = '❤️';
        big.style.left = cx + 'px';
        big.style.top = cy + 'px';
        const pts = document.createElement('span');
        pts.className = 'fx-bigheart-pts';
        pts.textContent = '+' + points + ' ♥';
        big.appendChild(pts);
      }
      // radial burst of mini hearts
      const n = Math.min(6 + points * 2, 16);
      for (let i = 0; i < n; i++) {
        const m = spawn(host, 'fx-mini', 1400);
        if (!m) break;
        m.textContent = Math.random() < 0.3 ? '💔' : '❤️';
        m.style.left = cx + 'px';
        m.style.top = cy + 'px';
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
        const d = 60 + Math.random() * 90;
        m.style.setProperty('--tx', Math.cos(a) * d + 'px');
        m.style.setProperty('--ty', Math.sin(a) * d - 40 + 'px');
        m.style.fontSize = (14 + Math.random() * 14) + 'px';
      }
    },

    /* ---- THE BIG ONE: Black Queen cinematic --------------------------------
       Full-screen takeover: vignette, lightning, shockwave rings, a real 3D
       card (queen face / card back) spinning in, queen rain, screen shake.  */
    queenCinematic(name, taunt, pts, isYou) {
      if (!fxOn()) {
        return;
      }
      const host = layer();
      const o = document.createElement('div');
      o.className = 'fxq' + (isYou ? ' you' : '');
      o.innerHTML =
        '<div class="fxq-flash"></div>' +
        '<div class="fxq-rings"><span></span><span></span><span></span></div>' +
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
      host.appendChild(o);

      requestAnimationFrame(() => o.classList.add('show'));

      // queen rain behind the card
      for (let i = 0; i < 16; i++) {
        const q = spawn(host, 'fx-rain fxq-rain', 3800);
        if (!q) break;
        q.textContent = '♛';
        q.style.left = Math.random() * 100 + 'vw';
        q.style.fontSize = (16 + Math.random() * 30) + 'px';
        q.style.animationDuration = (1.6 + Math.random() * 1.8) + 's';
        q.style.animationDelay = (0.3 + Math.random() * 0.6) + 's';
      }

      // screen shake on the table underneath
      const shakeEl = document.getElementById('game') || document.getElementById('app');
      if (shakeEl) {
        setTimeout(() => {
          shakeEl.classList.add('shake');
          setTimeout(() => shakeEl.classList.remove('shake'), 600);
        }, 350);
      }

      setTimeout(() => o.classList.add('out'), 2900);
      setTimeout(() => o.remove(), 3500);
    },

    /* ---- HARD PUNCH slam: shockwave + sparks + flash at the played card ---- */
    punchSlam(targetEl) {
      if (!fxOn()) return;
      const host = layer();
      const r = targetEl ? targetEl.getBoundingClientRect()
                         : { left: innerWidth / 2 - 40, top: innerHeight / 2 - 50, width: 80, height: 100 };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // white impact flash
      const flash = spawn(host, 'fx-impact-flash', 350);
      if (flash) { flash.style.left = cx + 'px'; flash.style.top = cy + 'px'; }

      // expanding shockwave rings
      [0, 140].forEach((delay, i) => {
        setTimeout(() => {
          const ring = spawn(host, 'fx-shock' + (i ? ' red' : ''), 750);
          if (ring) { ring.style.left = cx + 'px'; ring.style.top = cy + 'px'; }
        }, delay);
      });

      // magic sparks bursting outward
      const sparks = ['✨', '💥', '⭐', '🔥', '✨', '✨'];
      for (let i = 0; i < 12; i++) {
        const s = spawn(host, 'fx-spark', 1000);
        if (!s) break;
        s.textContent = sparks[i % sparks.length];
        s.style.left = cx + 'px';
        s.style.top = cy + 'px';
        const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
        const d = 80 + Math.random() * 110;
        s.style.setProperty('--tx', Math.cos(a) * d + 'px');
        s.style.setProperty('--ty', Math.sin(a) * d + 'px');
        s.style.fontSize = (15 + Math.random() * 16) + 'px';
      }

      // thump the table
      const shakeEl = document.getElementById('game') || document.getElementById('app');
      if (shakeEl) {
        shakeEl.classList.add('shake');
        setTimeout(() => shakeEl.classList.remove('shake'), 550);
      }
    },

    /* ---- 3D tumbling confetti ---------------------------------------------- */
    confetti3D(count) {
      if (!fxOn()) return;
      const host = layer();
      const colors = ['#e9c46a', '#c0392b', '#2ecc71', '#3498db', '#fff', '#ffd877', '#9b59b6'];
      const n = Math.min(count || 80, 120);
      for (let i = 0; i < n; i++) {
        const el = spawn(host, 'fx-conf', 5200);
        if (!el) break;
        el.style.left = Math.random() * 100 + 'vw';
        el.style.background = colors[i % colors.length];
        el.style.width = (7 + Math.random() * 7) + 'px';
        el.style.height = (10 + Math.random() * 9) + 'px';
        el.style.animationDuration = (2.4 + Math.random() * 2.4) + 's';
        el.style.animationDelay = (Math.random() * 0.8) + 's';
        el.style.setProperty('--rx', Math.floor(Math.random() * 720 + 360) + 'deg');
        el.style.setProperty('--rz', Math.floor(Math.random() * 720 + 180) + 'deg');
      }
    },
  };

  BQ.FX = FX;
})(typeof window !== 'undefined' ? window : globalThis);
