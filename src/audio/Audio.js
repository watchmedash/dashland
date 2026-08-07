// Fully procedural audio — no asset files. Noise-shaped impacts for footsteps
// and block interaction, a layered wind bed, and a slow generative pad.
//
// Positional model
// ----------------
// World-originating sounds (block break/place/dig, mob calls, mob impacts) take
// an optional world position and are routed through a PannerNode. Player-centric
// sounds (own footsteps, hurt, pickup, UI, thunder) stay on the dry bus so they
// never drift with head movement. The listener is driven from the camera every
// frame by `setListener()` — this is a sphere world, so "up" is the player's
// local up, not world +Y.

const MATERIAL_TUNING = {
  stone: { lo: 480, hi: 2400, decay: 0.10, tone: 0.20, noise: 1.0, body: 150 },
  soil: { lo: 200, hi: 1100, decay: 0.13, tone: 0.10, noise: 1.0, body: 95 },
  grass: { lo: 900, hi: 5200, decay: 0.09, tone: 0.05, noise: 1.0, body: 0 },
  sand: { lo: 1400, hi: 7000, decay: 0.11, tone: 0.02, noise: 1.0, body: 0 },
  snow: { lo: 600, hi: 3600, decay: 0.13, tone: 0.04, noise: 1.0, body: 0 },
  wood: { lo: 300, hi: 1900, decay: 0.11, tone: 0.42, noise: 0.7, body: 220 },
  glass: { lo: 1800, hi: 9000, decay: 0.16, tone: 0.55, noise: 0.5, body: 1400 },
  metal: { lo: 900, hi: 6000, decay: 0.28, tone: 0.62, noise: 0.4, body: 620 },
  water: { lo: 300, hi: 2600, decay: 0.22, tone: 0.10, noise: 1.0, body: 0 },
};

// Distance law shared by every positional source. Inverse rolloff, so a sound
// at `REF_DISTANCE` plays at full level and falls away as roughly ref/dist
// beyond it: 4/(4 + 1.1*(d-4)) → 1.00 at 4m, 0.28 at 15m, 0.09 at 40m.
const REF_DISTANCE = 4;
const MAX_DISTANCE = 120;
const ROLLOFF = 1.1;

// A second law for sounds meant to be navigated towards rather than merely
// heard. Under the curve above a source is at 9% by 40m and 3% by 120m, which
// is fine for a sheep and useless for a landmark: the merchant's bell was
// inaudible everywhere except where you had already found him. This one holds
// 18m at full and decays gently — 0.38 at 60m, 0.22 at 110m.
const FAR_REF_DISTANCE = 18;
const FAR_ROLLOFF = 0.7;

// Per-species vocal identity. `base` is the fundamental in Hz; the four are
// deliberately an octave-plus apart so they never blur together in a herd.
const MOB_VOICE = {
  // Gains are matched by ear/by meter, not by number: the bleat and cluck lose a
  // lot through their formant filters, the groan almost nothing. Pitches are
  // spread well apart so a mixed group never blurs into one texture.
  cow: { kind: 'groan', base: 96, dur: 1.10, gain: 0.38 },
  deer: { kind: 'bleat', base: 210, dur: 0.52, gain: 0.36 },
  bunny: { kind: 'squeak', base: 940, dur: 0.11, gain: 0.30 },
  chick: { kind: 'cluck', base: 620, dur: 0.26, gain: 0.34 },
  parrot: { kind: 'cluck', base: 780, dur: 0.30, gain: 0.32 },
  fox: { kind: 'squeak', base: 430, dur: 0.28, gain: 0.32 },
  koala: { kind: 'groan', base: 132, dur: 0.80, gain: 0.30 },
  penguin: { kind: 'cluck', base: 340, dur: 0.38, gain: 0.34 },
  // Deliberately the lowest and longest thing on the planet — you should hear a
  // husk before the dark gives you any chance of seeing it.
  husk: { kind: 'groan', base: 62, dur: 1.70, gain: 0.42 },
  // The merchant is the only tuned, man-made sound out there — a pair of bells
  // on a pack. Nothing else on the planet rings, so one note through the trees
  // is unambiguous even before you can see what made it.
  // `far` puts it on the landmark distance law and out of the shared idle
  // throttle — a beacon that a passing sheep can mute is not a beacon.
  merchant: { kind: 'chime', base: 523, dur: 1.30, gain: 0.34, far: true },
};

// idle / hurt / death are the same instrument played differently.
const VOX_MODE = {
  idle: { pitch: 1.0, dur: 1.0, gain: 1.0, drop: 0.86, thump: 0 },
  hurt: { pitch: 1.34, dur: 0.62, gain: 1.35, drop: 1.18, thump: 0 },
  death: { pitch: 0.92, dur: 1.75, gain: 1.15, drop: 0.42, thump: 0.9 },
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.masterVolume = 0.7;
    this.musicVolume = 0.35;
    this.started = false;
    // debug/verification counters — cheap, and the only way to confirm the
    // graph is doing anything at all in a headless browser
    this.stats = { panners: 0, mobCalls: 0, thunder: 0, throttled: 0 };
    this._lastIdleVox = -99;
    // panners following a live position object (a mob's own vector), re-read
    // every frame so a call from a running animal moves with it
    this._tracked = [];
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(comp).connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    // small convolution space so impacts don't sound dry
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.5, 2.6);
    this.reverbGain = this.ctx.createGain(); this.reverbGain.gain.value = 0.16;
    this.sfxBus.connect(this.reverbGain).connect(this.reverb).connect(this.master);

    this.noiseBuf = this._noise(2.5);
    this._startAmbience();
    this._startMusic();
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  // --- positional plumbing ---------------------------------------------------

  /** True once a context exists, is running, and output is wanted. */
  _live() {
    return !!(this.ctx && this.enabled && this.ctx.state !== 'closed'
      && this.ctx.state !== 'suspended');
  }

  /**
   * Drive the AudioListener from the camera. `up` must be the player's local up
   * on the sphere — using world +Y would swing the stereo image as you walk
   * around the planet. Modern per-AudioParam setters with a fallback to the
   * deprecated setPosition/setOrientation for older Safari/Firefox.
   */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (!L) return;
    try {
      const t = this.ctx.currentTime;
      if (L.positionX) {
        // a short ramp instead of a hard set kills zipper noise on fast turns
        const k = 0.02;
        L.positionX.linearRampToValueAtTime(px, t + k);
        L.positionY.linearRampToValueAtTime(py, t + k);
        L.positionZ.linearRampToValueAtTime(pz, t + k);
        L.forwardX.linearRampToValueAtTime(fx, t + k);
        L.forwardY.linearRampToValueAtTime(fy, t + k);
        L.forwardZ.linearRampToValueAtTime(fz, t + k);
        L.upX.linearRampToValueAtTime(ux, t + k);
        L.upY.linearRampToValueAtTime(uy, t + k);
        L.upZ.linearRampToValueAtTime(uz, t + k);
      } else {
        L.setPosition(px, py, pz);
        L.setOrientation(fx, fy, fz, ux, uy, uz);
      }
      this._followSources();
    } catch (e) { /* never let audio break the frame loop */ }
  }

  /** Re-point panners whose source object is still moving; drop dead ones. */
  _followSources() {
    if (!this._tracked.length) return;
    const t = this.ctx.currentTime;
    for (let i = this._tracked.length - 1; i >= 0; i--) {
      const e = this._tracked[i];
      if (t > e.until) { this._tracked.splice(i, 1); continue; }
      const p = e.node, s = e.pos;
      if (p.positionX) {
        p.positionX.value = s.x;
        p.positionY.value = s.y;
        p.positionZ.value = s.z;
      } else p.setPosition(s.x, s.y, s.z);
    }
  }

  /**
   * Destination for one voice. With a world position it is a fresh PannerNode
   * feeding the sfx bus (so master/music volume and the reverb send still apply);
   * without one it is the dry bus.
   */
  _dest(pos, life = 1, track = false, far = false) {
    if (!pos || !this.ctx) return this.sfxBus;
    let p;
    try {
      p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = far ? FAR_REF_DISTANCE : REF_DISTANCE;
      p.maxDistance = MAX_DISTANCE;
      p.rolloffFactor = far ? FAR_ROLLOFF : ROLLOFF;
      p.coneInnerAngle = 360;
      p.coneOuterAngle = 360;
      p.coneOuterGain = 1;
      const x = pos.x ?? pos[0] ?? 0, y = pos.y ?? pos[1] ?? 0, z = pos.z ?? pos[2] ?? 0;
      if (p.positionX) {
        p.positionX.value = x;
        p.positionY.value = y;
        p.positionZ.value = z;
      } else {
        p.setPosition(x, y, z);
      }
    } catch (e) {
      return this.sfxBus;
    }
    p.connect(this.sfxBus);
    this.stats.panners++;
    // Only follow objects the caller promises are stable and live — block
    // sounds are handed a shared scratch vector that is recycled next frame.
    if (track && pos && pos.x !== undefined && this._tracked.length < 24) {
      this._tracked.push({ node: p, pos, until: this.ctx.currentTime + life });
    }
    this._reap(p, life);
    return p;
  }

  /** Drop a transient node out of the graph once its voice has finished. */
  _reap(node, life) {
    setTimeout(() => { try { node.disconnect(); } catch (e) { /* already gone */ } },
      Math.max(50, life * 1000 + 400));
  }

  /** Rough attenuation a positional source will get — used for culling/tests. */
  distanceGain(d) {
    const dist = Math.max(REF_DISTANCE, Math.min(MAX_DISTANCE, d));
    return REF_DISTANCE / (REF_DISTANCE + ROLLOFF * (dist - REF_DISTANCE));
  }

  _noise(seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      // gently pinkened noise reads warmer than pure white
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
    return buf;
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
      }
    }
    return buf;
  }

  _burst(mat, { gain = 0.5, pitch = 1, dur = 1, pos = null } = {}) {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.stone;
    const life = cfg.decay * dur;
    const out = this._dest(pos, life * 1.6 + 0.1);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (cfg.lo + Math.random() * (cfg.hi - cfg.lo)) * pitch;
    bp.Q.value = 0.9 + Math.random() * 1.2;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = cfg.lo * 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * cfg.noise, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + life);
    src.connect(bp).connect(hp).connect(g).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + life + 0.05);

    if (cfg.body > 0) {
      const o = this.ctx.createOscillator();
      o.type = mat === 'metal' || mat === 'glass' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(cfg.body * pitch * (0.9 + Math.random() * 0.2), t);
      o.frequency.exponentialRampToValueAtTime(cfg.body * pitch * 0.55, t + life);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(gain * cfg.tone, t + 0.006);
      og.gain.exponentialRampToValueAtTime(0.0006, t + life * 1.5);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + life * 1.6);
    }
  }

  // Player-centric by default; `pos` (a THREE.Vector3 or [x,y,z]) makes any of
  // these world-anchored.
  step(mat, pos) { this._burst(mat, { gain: 0.22, pitch: 0.85 + Math.random() * 0.25, dur: 0.9, pos }); }
  dig(mat, pos) { this._burst(mat, { gain: 0.18, pitch: 1.1, dur: 0.55, pos }); }
  break_(mat, pos) { this._burst(mat, { gain: 0.5, pitch: 0.9, dur: 1.7, pos }); }
  place(mat, pos) { this._burst(mat, { gain: 0.42, pitch: 1.15, dur: 1.1, pos }); }
  splash(pos) { this._burst('water', { gain: 0.45, pitch: 1, dur: 1.6, pos }); }

  hurt() {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(f).connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.36);
  }

  pickup() {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.06 + 0.16);
      o.connect(g).connect(this.sfxBus);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.2);
    });
  }

  ui(freq = 520) {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square'; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.09);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.1);
  }

  // --- creatures -------------------------------------------------------------

  /** One-shot noise voice, used for breath, chitter and flesh impacts. */
  _noiseHit(out, t, { gain, lo, hi, q = 1, dur, at = 0.004 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(hi, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, lo), t + dur);
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + at);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  /**
   * Species vocalisation. `kind` is 'idle' | 'hurt' | 'death'; `pos` anchors it
   * in the world. Idle calls are rate-limited globally so a herd cannot stack
   * into a wall of noise even if every animal asks at once.
   */
  mob(type, kind = 'idle', pos = null) {
    if (!this._live()) return false;
    const v = MOB_VOICE[type];
    const mode = VOX_MODE[kind] || VOX_MODE.idle;
    if (!v) return false;
    const t = this.ctx.currentTime;
    if (kind === 'idle' && !v.far) {
      // hard floor between any two idle calls from any animal
      if (t - this._lastIdleVox < 0.45) { this.stats.throttled++; return false; }
      this._lastIdleVox = t;
    }

    const jitter = 0.9 + Math.random() * 0.22;
    const pitch = mode.pitch * jitter;
    const dur = v.dur * mode.dur * (0.88 + Math.random() * 0.28);
    const gain = v.gain * mode.gain;
    const out = this._dest(pos, dur * 2 + 0.4, true, !!v.far);
    const f0 = v.base * pitch;

    if (v.kind === 'bleat') {
      // ruminant: sawtooth larynx, heavy vibrato, a nasal formant pair
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * 1.10, t);
      o.frequency.linearRampToValueAtTime(f0, t + dur * 0.22);
      o.frequency.exponentialRampToValueAtTime(Math.max(35, f0 * mode.drop), t + dur);
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(9 + Math.random() * 5, t);
      lfo.frequency.linearRampToValueAtTime(24 + Math.random() * 10, t + dur);
      const lg = this.ctx.createGain(); lg.gain.value = f0 * 0.11;
      lfo.connect(lg).connect(o.frequency);
      const f1 = this.ctx.createBiquadFilter();
      f1.type = 'bandpass'; f1.frequency.value = 640 * jitter; f1.Q.value = 2.4;
      const f2 = this.ctx.createBiquadFilter();
      f2.type = 'lowpass'; f2.frequency.value = 2600; f2.Q.value = 0.7;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.05);
      g.gain.linearRampToValueAtTime(gain * 0.75, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
      o.connect(f1).connect(f2).connect(g).connect(out);
      o.start(t); o.stop(t + dur + 0.05);
      lfo.start(t); lfo.stop(t + dur + 0.05);
      this._noiseHit(out, t, { gain: gain * 0.16, lo: 400, hi: 1600, q: 0.8, dur: dur * 0.5, at: 0.03 });
    } else if (v.kind === 'squeak') {
      // small mammal: fast up-down glissando, plus a dry chitter
      const grains = kind === 'idle' ? 1 + ((Math.random() * 3) | 0) : 1;
      for (let n = 0; n < grains; n++) {
        const tn = t + n * (0.055 + Math.random() * 0.05);
        const o = this.ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(f0 * 0.62, tn);
        o.frequency.exponentialRampToValueAtTime(f0 * 1.7, tn + dur * 0.3);
        o.frequency.exponentialRampToValueAtTime(f0 * mode.drop, tn + dur);
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 420;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (n === 0 ? 1 : 0.7), tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + dur);
        o.connect(hp).connect(g).connect(out);
        o.start(tn); o.stop(tn + dur + 0.03);
        this._noiseHit(out, tn, { gain: gain * 0.3, lo: 1800, hi: 5200, q: 1.6, dur: dur * 0.6 });
      }
    } else if (v.kind === 'chime') {
      // Handbells: two or three struck partials per note, a fifth apart, each
      // one a fast attack onto a long exponential tail. Sine partials only —
      // every richer waveform tried here read as a game menu rather than metal.
      const notes = kind === 'idle' ? [1, 1.5, 2] : [1, 1.5];
      for (let n = 0; n < notes.length; n++) {
        const tn = t + n * (0.16 + Math.random() * 0.05);
        const f = f0 * notes[n];
        for (const [mul, amt] of [[1, 1], [2.76, 0.30], [5.4, 0.12]]) {
          const o = this.ctx.createOscillator();
          o.type = 'sine';
          o.frequency.setValueAtTime(f * mul, tn);
          // A struck bell falls slightly flat as it decays; without this the
          // tail sits dead still and sounds synthesised.
          o.frequency.linearRampToValueAtTime(f * mul * 0.995, tn + dur);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, tn);
          g.gain.linearRampToValueAtTime(gain * amt, tn + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0004, tn + dur * (mul > 3 ? 0.35 : 1));
          o.connect(g).connect(out);
          o.start(tn); o.stop(tn + dur + 0.05);
        }
        // the clapper itself, so each note has an edge to it
        this._noiseHit(out, tn, { gain: gain * 0.16, lo: 2200, hi: 8000, q: 1.1, dur: 0.06 });
      }
    } else if (v.kind === 'cluck') {
      // bird: a run of clipped glottal grains, the last one longer and higher
      const grains = kind === 'idle' ? 2 + ((Math.random() * 3) | 0) : 2;
      for (let n = 0; n < grains; n++) {
        const last = n === grains - 1;
        const tn = t + n * (0.085 + Math.random() * 0.06);
        const gd = last ? dur * 0.55 : 0.05 + Math.random() * 0.03;
        const o = this.ctx.createOscillator();
        o.type = 'square';
        const top = f0 * (last ? 1.55 : 1.0) * (0.94 + Math.random() * 0.14);
        o.frequency.setValueAtTime(top, tn);
        o.frequency.exponentialRampToValueAtTime(Math.max(80, top * (last ? 0.42 : 0.55) * mode.drop), tn + gd);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1100 * jitter; bp.Q.value = 1.4;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3200;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tn);
        g.gain.linearRampToValueAtTime(gain * (last ? 1.1 : 0.8), tn + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + gd);
        o.connect(bp).connect(lp).connect(g).connect(out);
        o.start(tn); o.stop(tn + gd + 0.03);
        this._noiseHit(out, tn, { gain: gain * 0.22, lo: 700, hi: 2800, q: 1.2, dur: gd * 0.7 });
      }
    } else {
      // browser: long low hum, two detuned partials, slow vibrato, very dark
      for (const [mul, amt, type] of [[1, 1, 'triangle'], [2.01, 0.34, 'sine'], [0.5, 0.5, 'sine']]) {
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f0 * mul * 1.04, t);
        o.frequency.linearRampToValueAtTime(f0 * mul, t + dur * 0.3);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * mul * mode.drop), t + dur);
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 4 + Math.random() * 2.5;
        const lg = this.ctx.createGain(); lg.gain.value = f0 * mul * 0.03;
        lfo.connect(lg).connect(o.frequency);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.9;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain * amt, t + dur * 0.22);
        g.gain.linearRampToValueAtTime(gain * amt * 0.8, t + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
        o.connect(lp).connect(g).connect(out);
        o.start(t); o.stop(t + dur + 0.08);
        lfo.start(t); lfo.stop(t + dur + 0.08);
      }
      this._noiseHit(out, t, { gain: gain * 0.10, lo: 180, hi: 700, q: 0.7, dur: dur * 0.8, at: 0.12 });
    }

    if (mode.thump > 0) this.mobHit(pos, mode.thump);
    this.stats.mobCalls++;
    return true;
  }

  /**
   * Soft flesh impact — a damp low thump under a short muffled slap. Nothing
   * like the crisp grass footstep this replaced.
   */
  mobHit(pos = null, amt = 1) {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    const dur = 0.17 + Math.random() * 0.06;
    const out = this._dest(pos, dur * 2 + 0.3, true);

    // body: a fast dropping sine, the "whump"
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f0 = 132 * (0.85 + Math.random() * 0.3);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * amt, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.05);

    // slap: brief damp noise, low-passed so it reads as soft, not gravelly
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + dur);
    lp.Q.value = 0.6;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.26 * amt, t + 0.004);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + dur * 0.75);
    src.connect(lp).connect(ng).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  // --- weather ---------------------------------------------------------------

  /**
   * Real thunder: a sharp crack transient over a long, irregular, heavily
   * low-passed rumble. Every roll is randomised — count and spacing of the
   * after-rumbles, cutoff sweep, crack brightness — so repeats never match.
   * Non-positional: it is the whole sky.
   */
  thunder(strength = 1) {
    if (!this._live()) return;
    const t = this.ctx.currentTime;
    const near = Math.random();                 // 0 distant roll → 1 overhead crack
    const boom = 2.6 + Math.random() * 3.4;     // total decay in seconds
    const amp = (0.55 + near * 0.5) * strength;
    const out = this.sfxBus;
    this.stats.thunder++;

    // --- rumble bed: noise through a slowly closing low-pass -----------------
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.18 + Math.random() * 0.16;   // stretched = deeper
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(120 + near * 380, t);
    lp.frequency.exponentialRampToValueAtTime(45 + Math.random() * 40, t + boom);
    lp.Q.value = 0.8;
    const lp2 = this.ctx.createBiquadFilter();
    lp2.type = 'lowpass'; lp2.frequency.value = 900; lp2.Q.value = 0.5;
    const body = this.ctx.createGain();
    body.gain.setValueAtTime(0.0001, t);
    body.gain.linearRampToValueAtTime(amp * 0.8, t + 0.03 + (1 - near) * 0.5);

    // irregular swells inside the decay — this is what stops it sounding like
    // one smooth fade every single time
    let lvl = amp * 0.8;
    let tt = t + 0.2;
    const swells = 2 + ((Math.random() * 4) | 0);
    for (let i = 0; i < swells; i++) {
      const step = (boom / swells) * (0.5 + Math.random());
      const dip = lvl * (0.25 + Math.random() * 0.4);
      body.gain.linearRampToValueAtTime(Math.max(0.001, dip), tt + step * 0.55);
      lvl = dip * (1.15 + Math.random() * 0.9);
      body.gain.linearRampToValueAtTime(Math.max(0.001, Math.min(amp, lvl)), tt + step);
      tt += step;
    }
    body.gain.exponentialRampToValueAtTime(0.0004, t + boom);
    src.connect(lp).connect(lp2).connect(body).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + boom + 0.2);

    // --- sub: the pressure you feel rather than hear -------------------------
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(48 + Math.random() * 22, t);
    sub.frequency.exponentialRampToValueAtTime(20 + Math.random() * 8, t + boom * 0.7);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.linearRampToValueAtTime(amp * 0.5, t + 0.05);
    sg.gain.exponentialRampToValueAtTime(0.0004, t + boom * 0.8);
    sub.connect(sg).connect(out);
    sub.start(t); sub.stop(t + boom * 0.85);

    // --- crack: bright transient, only when the strike is close --------------
    const crackT = t + (1 - near) * (0.05 + Math.random() * 0.35);
    const cd = 0.10 + Math.random() * 0.16;
    const cs = this.ctx.createBufferSource();
    cs.buffer = this.noiseBuf;
    cs.playbackRate.value = 1.1 + Math.random() * 0.7;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900 + near * 2200, crackT);
    hp.frequency.exponentialRampToValueAtTime(220, crackT + cd);
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.0001, crackT);
    cg.gain.linearRampToValueAtTime(amp * (0.25 + near * 0.75), crackT + 0.002);
    cg.gain.exponentialRampToValueAtTime(0.0006, crackT + cd);
    cs.connect(hp).connect(cg).connect(out);
    cs.start(crackT, Math.random() * 2);
    cs.stop(crackT + cd + 0.05);

    // a couple of stray slaps just after the crack — the tearing edge
    const slaps = near > 0.4 ? 1 + ((Math.random() * 3) | 0) : 0;
    for (let i = 0; i < slaps; i++) {
      const st = crackT + 0.04 + Math.random() * 0.5;
      const sd = 0.05 + Math.random() * 0.1;
      const s2 = this.ctx.createBufferSource();
      s2.buffer = this.noiseBuf;
      s2.playbackRate.value = 0.7 + Math.random() * 0.8;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 260 + Math.random() * 900; bp.Q.value = 0.9;
      const g2 = this.ctx.createGain();
      g2.gain.setValueAtTime(0.0001, st);
      g2.gain.linearRampToValueAtTime(amp * (0.12 + Math.random() * 0.2), st + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.0004, st + sd);
      s2.connect(bp).connect(g2).connect(out);
      s2.start(st, Math.random() * 2);
      s2.stop(st + sd + 0.05);
    }
  }

  _startAmbience() {
    const mk = (type, freq, q, gain) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = this.ctx.createGain(); g.gain.value = gain;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { src, f, g };
    };
    this.wind = mk('bandpass', 520, 0.7, 0.0);
    this.windHi = mk('highpass', 2400, 0.5, 0.0);
    this.waterAmb = mk('bandpass', 900, 0.6, 0.0);
    this.caveAmb = mk('lowpass', 180, 1.0, 0.0);

    // slow gusts
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lg = this.ctx.createGain(); lg.gain.value = 260;
    lfo.connect(lg).connect(this.wind.f.frequency);
    lfo.start();
  }

  setAmbience({ wind = 0, water = 0, cave = 0, underwater = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.4;
    // Trimmed a touch from the original bed: with mob calls and thunder now in
    // the mix, the wind was eating the headroom a distant bleat needs.
    this.wind.g.gain.setTargetAtTime(wind * 0.046, t, k);
    this.windHi.g.gain.setTargetAtTime(wind * 0.013, t, k);
    this.waterAmb.g.gain.setTargetAtTime(water * 0.044, t, k);
    this.caveAmb.g.gain.setTargetAtTime(cave * 0.08, t, k);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicVolume * (underwater ? 0.4 : 1), t, 0.6);
    this.master.gain.setTargetAtTime(this.masterVolume * (underwater ? 0.55 : 1), t, 0.3);
  }

  _startMusic() {
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.musicVolume;
    const rev = this.ctx.createConvolver();
    rev.buffer = this._impulse(4.5, 3.4);
    const wet = this.ctx.createGain(); wet.gain.value = 0.55;
    this.musicBus.connect(this.master);
    this.musicBus.connect(wet).connect(rev).connect(this.master);

    // A lydian-ish palette: warm, wide, never resolves too hard.
    const scale = [0, 2, 4, 7, 9, 11, 14, 16];
    const roots = [55, 61.74, 65.41, 49];
    let chordIndex = 0;

    const voice = (freq, dur, gain, type = 'sine', detune = 0) => {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 1400; f.Q.value = 0.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(f).connect(g).connect(this.musicBus);
      o.start(t); o.stop(t + dur + 0.1);
    };

    const tick = () => {
      if (!this.ctx) return;
      const root = roots[chordIndex % roots.length];
      chordIndex++;
      const dur = 11 + Math.random() * 5;
      [0, 2, 4].forEach((si, i) => {
        const semi = scale[si];
        const f = root * Math.pow(2, semi / 12) * (i === 0 ? 2 : 4);
        voice(f, dur, 0.05, 'sine', (Math.random() - 0.5) * 8);
        voice(f * 1.005, dur, 0.03, 'triangle', (Math.random() - 0.5) * 10);
      });
      // occasional bell motif
      if (Math.random() < 0.65) {
        const n = scale[(Math.random() * scale.length) | 0];
        setTimeout(() => voice(root * Math.pow(2, n / 12) * 8, 3.2, 0.035, 'sine'), 2000 + Math.random() * 4000);
      }
      this._musicTimer = setTimeout(tick, dur * 900);
    };
    this._musicTimer = setTimeout(tick, 1500);
  }

  setVolumes(master, music) {
    this.masterVolume = master;
    this.musicVolume = music;
    if (this.master) this.master.gain.value = master;
    if (this.musicBus) this.musicBus.gain.value = music;
  }
}
