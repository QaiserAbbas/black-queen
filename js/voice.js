/* =============================================================================
 * Black Queen — VOICE CHAT  (WebRTC audio mesh, zero-dependency)
 * -----------------------------------------------------------------------------
 *  • Peer-to-peer audio between the (≤4) human players in a room.
 *  • The existing WebSocket server is used ONLY as a signaling relay — it
 *    forwards offer/answer/ICE blobs; the actual audio never touches it.
 *  • Glare-free by construction: for any pair the LOWER seat number always
 *    creates the offer, the higher seat waits and answers.
 *  • Public STUN only. Players behind symmetric NATs may fail to connect
 *    without a TURN relay (not bundled — would need paid hosting).
 *
 *  Per-member feedback (emitted via onMember):
 *    - talking  : active-speaker detection via a WebAudio analyser (RMS).
 *    - signal   : connection quality from RTCPeerConnection.getStats()
 *                 (RTT + packet loss) → 0..3 bars, plus 'lost' / connecting.
 *    - peerMuted: this member's incoming audio is muted on MY side.
 *
 *  UI contract:  set onState / onError / onMember; call attach(); then
 *  toggle() / toggleMute() / togglePeerMute(seat). Wire net 'voice' →
 *  onRoster, 'rtc' → onSignal.
 * ===========================================================================*/

(function (root) {
  'use strict';

  const BQ = root.BQ;

  const ICE = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const TALK_RMS = 0.045;     // RMS above this = speaking
  const TALK_HOLD = 320;      // ms to keep "talking" lit after the level drops
  const MON_EVERY = 160;      // ms between monitor ticks
  const SIG_EVERY = 12;       // every Nth tick (~2s) re-poll connection stats

  const Voice = {
    net: null,
    seatOf: function () { return -1; },
    onState: null,            // (st) => void
    onError: null,            // (msg) => void
    onMember: null,           // (info) => void  per-seat talking/signal/mute

    enabled: false,
    muted: false,
    localStream: null,
    peers: {},                // seat -> { pc, audioEl, analyser, _talk, signal, peerMuted, _lost, _recv }
    roster: [],

    audioCtx: null,
    _localAnalyser: null,
    _localTalk: null,
    _monTimer: null,
    _tick: 0,

    attach: function (net, seatOf) {
      this.net = net;
      if (seatOf) this.seatOf = seatOf;
    },

    supported: function () {
      return !!(navigator.mediaDevices &&
                navigator.mediaDevices.getUserMedia &&
                root.RTCPeerConnection);
    },

    /* ---- join / leave / mute --------------------------------------------- */
    join: function () {
      if (this.enabled) return;
      if (!this.supported()) {
        return this._fail('Voice needs a secure (https) connection.');
      }
      const self = this;
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(function (stream) {
          self.localStream = stream;
          self.enabled = true;
          self.muted = false;
          self._applyMute();
          self._ensureAudioCtx();
          self._localTalk = {};
          self._localAnalyser = self._makeAnalyser(stream);
          self._startMonitor();
          if (self.net) self.net.send({ t: 'voice', on: true });
          self._emit();
          self._emitMember(self.seatOf());
        })
        .catch(function () {
          self._fail('Microphone blocked. Allow mic access to use voice.');
        });
    },

    leave: function () {
      const had = this.enabled || this.localStream || Object.keys(this.peers).length;
      this.enabled = false;
      if (this.net) this.net.send({ t: 'voice', on: false });
      const self = this;
      Object.keys(this.peers).forEach(function (s) { self._closePeer(+s); });
      this._stopMonitor();
      this._localAnalyser = null;
      this._localTalk = null;
      if (this.audioCtx) { try { this.audioCtx.close(); } catch (_) {} this.audioCtx = null; }
      if (this.localStream) {
        this.localStream.getTracks().forEach(function (t) { t.stop(); });
        this.localStream = null;
      }
      this.roster = [];
      this.muted = false;
      if (had) this._emit();
    },

    toggle: function () { this.enabled ? this.leave() : this.join(); },

    toggleMute: function () {
      if (!this.enabled) return;
      this.muted = !this.muted;
      this._applyMute();
      this._emit();
      this._emitMember(this.seatOf());
    },

    // Mute ONE other member's incoming audio (local only — they keep talking).
    togglePeerMute: function (seat) {
      const e = this.peers[seat];
      if (!e) return;
      e.peerMuted = !e.peerMuted;
      if (e.audioEl) e.audioEl.muted = e.peerMuted;
      this._emitMember(seat);
    },

    _applyMute: function () {
      if (!this.localStream) return;
      const on = !this.muted;
      this.localStream.getAudioTracks().forEach(function (t) { t.enabled = on; });
    },

    /* ---- signaling-driven mesh reconciliation ---------------------------- */
    onRoster: function (seats) {
      this.roster = Array.isArray(seats) ? seats : [];
      const self = this;

      if (!this.enabled) {
        Object.keys(this.peers).forEach(function (s) { self._closePeer(+s); });
        this._emit();
        return;
      }

      const me = this.seatOf();
      const others = this.roster.filter(function (s) { return s !== me; });

      Object.keys(this.peers).forEach(function (s) {
        if (others.indexOf(+s) < 0) self._closePeer(+s);
      });

      others.forEach(function (s) {
        if (self.peers[s]) return;
        if (me < s) {
          const pc = self._makePeer(s);
          self._negotiate(s, pc);
        }
      });

      this._emit();
    },

    onSignal: function (from, data) {
      if (!this.enabled || !data) return;
      if (!this.peers[from]) this._makePeer(from);
      const pc = this.peers[from].pc;
      const self = this;

      if (data.sdp) {
        pc.setRemoteDescription(data.sdp).then(function () {
          if (data.sdp.type !== 'offer') return;
          return pc.createAnswer().then(function (ans) {
            return pc.setLocalDescription(ans);
          }).then(function () {
            self._send(from, { sdp: pc.localDescription });
          });
        }).catch(function () {});
      } else if (data.ice) {
        pc.addIceCandidate(data.ice).catch(function () {});
      }
    },

    /* ---- peer plumbing --------------------------------------------------- */
    _makePeer: function (seat) {
      const self = this;
      const pc = new RTCPeerConnection(ICE);
      const entry = { pc: pc, audioEl: null, analyser: null, _talk: {}, signal: 0, peerMuted: false };
      this.peers[seat] = entry;

      this.localStream.getTracks().forEach(function (t) {
        pc.addTrack(t, self.localStream);
      });

      pc.onicecandidate = function (e) {
        if (e.candidate) self._send(seat, { ice: e.candidate });
      };

      pc.ontrack = function (e) {
        let el = entry.audioEl;
        if (!el) {
          el = entry.audioEl = document.createElement('audio');
          el.autoplay = true;
          el.dataset.voiceSeat = String(seat);
          el.style.display = 'none';
          document.body.appendChild(el);
        }
        el.muted = entry.peerMuted;
        el.srcObject = e.streams[0];
        const p = el.play && el.play();
        if (p && p.catch) p.catch(function () {});
        entry.analyser = self._makeAnalyser(e.streams[0]);
      };

      pc.onconnectionstatechange = function () {
        self._pollSignal(seat);
        if (pc.connectionState === 'failed') {
          try { pc.restartIce(); } catch (_) {}
        }
      };

      return pc;
    },

    _negotiate: function (seat, pc) {
      const self = this;
      pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer);
      }).then(function () {
        self._send(seat, { sdp: pc.localDescription });
      }).catch(function () {});
    },

    _closePeer: function (seat) {
      const e = this.peers[seat];
      if (!e) return;
      try { e.pc.close(); } catch (_) {}
      if (e.audioEl) {
        try { e.audioEl.srcObject = null; e.audioEl.remove(); } catch (_) {}
      }
      delete this.peers[seat];
      if (typeof this.onMember === 'function') this.onMember({ seat: seat, gone: true });
    },

    _send: function (to, data) {
      if (this.net) this.net.send({ t: 'rtc', to: to, data: data });
    },

    /* ---- active-speaker + connection-quality monitor --------------------- */
    _ensureAudioCtx: function () {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      if (!this.audioCtx) { try { this.audioCtx = new AC(); } catch (_) { this.audioCtx = null; } }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(function () {});
      }
    },

    // Tap a stream's level WITHOUT routing it to the speakers (the <audio>
    // element already plays remote audio; we'd never want to hear ourselves).
    _makeAnalyser: function (stream) {
      if (!this.audioCtx || !stream || !stream.getAudioTracks().length) return null;
      try {
        const src = this.audioCtx.createMediaStreamSource(stream);
        const an = this.audioCtx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        return an;
      } catch (_) { return null; }
    },

    _startMonitor: function () {
      if (this._monTimer) return;
      this._tick = 0;
      const self = this;
      this._monTimer = setInterval(function () { self._monitor(); }, MON_EVERY);
    },

    _stopMonitor: function () {
      if (this._monTimer) { clearInterval(this._monTimer); this._monTimer = null; }
    },

    _monitor: function () {
      this._tick++;
      const self = this;

      // Local speaking state (suppressed while muted).
      const me = this.seatOf();
      if (me >= 0 && this._localTalk) {
        const t = !this.muted && this._isTalking(this._localAnalyser, this._localTalk);
        if (this._localTalk.on !== t) { this._localTalk.on = t; this._emitMember(me); }
      }

      // Remote speaking state.
      Object.keys(this.peers).forEach(function (s) {
        const e = self.peers[s];
        if (!e.analyser) return;
        const t = self._isTalking(e.analyser, e._talk);
        if (e._talk.on !== t) { e._talk.on = t; self._emitMember(+s); }
      });

      // Connection quality, less often (stats are comparatively expensive).
      if (this._tick % SIG_EVERY === 0) {
        Object.keys(this.peers).forEach(function (s) { self._pollSignal(+s); });
      }
    },

    _isTalking: function (analyser, talk) {
      if (!analyser) return false;
      const buf = talk.buf || (talk.buf = new Uint8Array(analyser.fftSize));
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      if (rms > TALK_RMS) talk.holdUntil = now + TALK_HOLD;
      return now < (talk.holdUntil || 0);
    },

    _pollSignal: function (seat) {
      const e = this.peers[seat];
      if (!e || !e.pc) return;
      const self = this;
      const apply = function (sig) {
        if (e.signal !== sig) { e.signal = sig; self._emitMember(seat); }
      };
      const cs = e.pc.connectionState;
      if (cs === 'failed' || cs === 'disconnected' || cs === 'closed') return apply('lost');
      if (cs !== 'connected') return apply(0);   // new / connecting / checking
      e.pc.getStats().then(function (stats) {
        apply(self._quality(stats, e));
      }).catch(function () {});
    },

    // RTT + recent packet loss → 1 (poor) .. 3 (good). 0 = not flowing yet.
    _quality: function (stats, e) {
      let rtt = null, lost = 0, recv = 0;
      stats.forEach(function (s) {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' &&
            (s.nominated || s.selected) && s.currentRoundTripTime != null) {
          rtt = s.currentRoundTripTime;
        }
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
          lost = s.packetsLost || 0;
          recv = s.packetsReceived || 0;
        }
      });
      const dLost = lost - (e._lost || 0);
      const dRecv = recv - (e._recv || 0);
      e._lost = lost; e._recv = recv;
      const denom = dLost + dRecv;
      const loss = denom > 0 ? dLost / denom : 0;
      if (recv === 0 && rtt == null) return 0;
      let bars = 3;
      if (rtt != null) {
        if (rtt > 0.3 || loss > 0.08) bars = 1;
        else if (rtt > 0.15 || loss > 0.02) bars = 2;
      }
      if (loss > 0.2) bars = 1;
      return bars;
    },

    /* ---- emit ------------------------------------------------------------ */
    _emit: function () {
      if (typeof this.onState === 'function') {
        this.onState({
          inCall: this.enabled,
          muted: this.muted,
          peers: Object.keys(this.peers).map(Number),
        });
      }
    },

    _emitMember: function (seat) {
      if (typeof this.onMember !== 'function' || !this.enabled) return;
      const me = this.seatOf();
      let info;
      if (seat === me) {
        info = { seat: seat, self: true, signal: 'self',
                 talking: !!(this._localTalk && this._localTalk.on), muted: this.muted };
      } else {
        const e = this.peers[seat];
        if (!e) return;
        info = { seat: seat, self: false,
                 signal: (e.signal != null ? e.signal : 0),
                 talking: !!(e._talk && e._talk.on),
                 peerMuted: !!e.peerMuted };
      }
      this.onMember(info);
    },

    _fail: function (msg) {
      this.enabled = false;
      if (typeof this.onError === 'function') this.onError(msg);
      this._emit();
    },
  };

  BQ.Voice = Voice;
})(typeof window !== 'undefined' ? window : globalThis);
