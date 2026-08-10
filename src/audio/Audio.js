// Fully procedural audio — no asset files. Noise-shaped impacts for footsteps
// and block interaction, a layered ambient bed, and a slow generative pad.
//
// Buses
// -----
// Everything lands on one of four buses and every bus goes through the same
// master trim, a muffle filter and a compressor:
//
//   sfx  ─┬─────────────────────────┐
//         └─ send → reverb ─────────┤
//   amb  ────────────────────────── ├→ master → muffle → comp → destination
//   ui   ────────────────────────── │
//   music ───┬───────────────────── ┘
//            └─ long reverb ────────┘
//
// The muffle is a lowpass that sits wide open at 20kHz and closes to a few
// hundred Hz underwater — that one node is what makes going under read as being
// under, far more than any level change does.
//
// Voice budget
// ------------
// Every voice-producing call takes a token from `_take()` before it builds
// anything, and returns it on a timer sized to the voice's own length. Costs
// are weighted by how many nodes a category actually builds, so a herd of mobs
// and a landslide of block breaks compete for one budget instead of each having
// their own unbounded one. Over budget, the call returns without building a
// graph; it is never queued, because a late footstep is worse than none.
//
// Positional model
// ----------------
// World-originating sounds (block break/place/dig, mob calls, mob impacts) take
// an optional world position and are routed through a PannerNode. Player-centric
// sounds (own footsteps, hurt, pickup, UI, thunder) stay on the dry bus so they
// never drift with head movement. The listener is driven from the camera every
// frame by `setListener()` — this is a sphere world, so "up" is the player's
// local up, not world +Y.

import { Ambience } from './Ambience.js';

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
  //
  // Retuned against a 400Hz-weighted RMS render of every sound in the game,
  // because peak dBFS had been ranking a 62Hz groan level with a 4kHz cluck and
  // the ear is thirty-odd dB less sensitive down there. What that measurement
  // found was the clucks: the parrot at -24.7 and the chick at -25.5 were the
  // two loudest things on the planet, TWELVE dB above an overhead thunderclap
  // (-36.5) and thirty above the player's own footstep (-55.7). One parrot
  // standing beside you was a thousand times the power of your own boots.
  // The targets below put a nearby animal at about -34, which is where the cow,
  // the deer and the fox already sat.
  //
  // The groans are deliberately NOT raised to match. The cow, the koala and the
  // husk read quiet on a weighted meter because they are almost all sub-100Hz
  // energy, but they are simultaneously the highest PEAKS in the game (husk
  // -4.5 dBFS) and there is no headroom left to give them. That gap is the
  // instrument, not a mistake: a husk is meant to be felt before it is heard.
  cow: { kind: 'groan', base: 96, dur: 1.10, gain: 0.38 },
  deer: { kind: 'bleat', base: 210, dur: 0.52, gain: 0.36 },
  bunny: { kind: 'squeak', base: 940, dur: 0.11, gain: 0.45 },
  chick: { kind: 'cluck', base: 620, dur: 0.26, gain: 0.13 },
  parrot: { kind: 'cluck', base: 780, dur: 0.30, gain: 0.11 },
  fox: { kind: 'squeak', base: 430, dur: 0.28, gain: 0.32 },
  koala: { kind: 'groan', base: 132, dur: 0.80, gain: 0.30 },
  penguin: { kind: 'cluck', base: 340, dur: 0.38, gain: 0.26 },
  // Deliberately the lowest and longest thing on the planet — you should hear a
  // husk before the dark gives you any chance of seeing it.
  husk: { kind: 'groan', base: 62, dur: 1.70, gain: 0.42 },
  // The merchant is the only tuned, man-made sound out there — a pair of bells
  // on a pack. Nothing else on the planet rings, so one note through the trees
  // is unambiguous even before you can see what made it.
  // `far` puts it on the landmark distance law and out of the shared idle
  // throttle — a beacon that a passing sheep can mute is not a beacon.
  // 0.34 measured as the single loudest sound in the game (-22.3 weighted, 14dB
  // over thunder). It still wants to be the loudest VOICE — it is the one thing
  // out there worth walking towards — so it lands at about -30, above the herd
  // and under the sky.
  merchant: { kind: 'chime', base: 523, dur: 1.30, gain: 0.135, far: true },
};

// idle / hurt / death are the same instrument played differently.
const VOX_MODE = {
  idle: { pitch: 1.0, dur: 1.0, gain: 1.0, drop: 0.86, thump: 0 },
  hurt: { pitch: 1.34, dur: 0.62, gain: 1.35, drop: 1.18, thump: 0 },
  death: { pitch: 0.92, dur: 1.75, gain: 1.15, drop: 0.42, thump: 0.9 },
};

// Concurrent-voice budget, in weighted units. The weights are roughly the node
// count each category builds, so the ceiling means something: at the cap the
// graph holds on the order of 500 transient nodes, which measures as noise
// beside the voxel meshes this game already keeps resident.
const VOICE_BUDGET = 64;
const VOICE_COST = {
  step: 2, block: 3, mob: 7, hit: 3, player: 3, ui: 1, amb: 3, weather: 10,
};
// Per-category ceilings on top of the global one, so no single source can eat
// the whole budget. A cave-in must not be able to silence your own footsteps.
const VOICE_CAP = {
  step: 8, block: 24, mob: 28, hit: 12, player: 9, ui: 6, amb: 12, weather: 20,
};

export class Audio {
  constructor() {
    this.ctx = null;
    // Written only by `setVolumes`: a master volume of zero is off, not quiet.
    this.enabled = true;
    this.masterVolume = 0.7;
    this.musicVolume = 0.35;
    this.started = false;
    // debug/verification counters — cheap, and the only way to confirm the
    // graph is doing anything at all in a headless browser
    this.stats = {
      panners: 0, mobCalls: 0, thunder: 0, throttled: 0,
      voicesTaken: 0, voicesDropped: 0, peakVoices: 0,
    };
    this._lastIdleVox = -99;
    // panners following a live position object (a mob's own vector), re-read
    // every frame so a call from a running animal moves with it
    this._tracked = [];
    this._used = 0;
    this._cat = {};
    this._muffle = 0;
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;

    // The underwater filter. Wide open is a no-op the browser optimises away;
    // it only costs anything while it is actually closed.
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.6;

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    this.master.connect(this.muffle).connect(comp).connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    // UI sits on its own bus so menu clicks keep a steady level whatever the
    // world is doing, and so it can duck out from under the muffle later.
    this.uiBus = this.ctx.createGain(); this.uiBus.gain.value = 0.9;
    this.uiBus.connect(this.master);

    // Ambience is separate from sfx: it must not be pushed around by the
    // reverb send, and its level has to be trimmable on its own.
    this.ambBus = this.ctx.createGain(); this.ambBus.gain.value = 1;
    this.ambBus.connect(this.master);

    // small convolution space so impacts don't sound dry
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(1.5, 2.6);
    this.reverbGain = this.ctx.createGain(); this.reverbGain.gain.value = 0.16;
    this.sfxBus.connect(this.reverbGain).connect(this.reverb).connect(this.master);

    this.noiseBuf = this._noise(2.5);
    this._startAmbience();
    this._startMusic();
  }

  // --- voice budget ----------------------------------------------------------

  /**
   * Reserve budget for one voice of `cat` lasting `life` seconds. False means
   * the caller must build nothing at all — checking this after wiring up half a
   * graph would defeat the point.
   */
  _take(cat, life = 0.5) {
    const cost = VOICE_COST[cat] || 3;
    const cap = VOICE_CAP[cat] || 12;
    const used = this._cat[cat] || 0;
    if (this._used + cost > VOICE_BUDGET || used + cost > cap) {
      this.stats.voicesDropped++;
      return false;
    }
    this._used += cost;
    this._cat[cat] = used + cost;
    this.stats.voicesTaken++;
    if (this._used > this.stats.peakVoices) this.stats.peakVoices = this._used;
    setTimeout(() => {
      this._used = Math.max(0, this._used - cost);
      this._cat[cat] = Math.max(0, (this._cat[cat] || 0) - cost);
    }, Math.max(60, life * 1000 + 120));
    return true;
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

  _burst(mat, { gain = 0.5, pitch = 1, dur = 1, pos = null, cat = 'block' } = {}) {
    if (!this._live()) return false;
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.stone;
    const life = cfg.decay * dur;
    if (!this._take(cat, life * 1.6 + 0.1)) return false;
    const t = this.ctx.currentTime;
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
    return true;
  }

  // Player-centric by default; `pos` (a THREE.Vector3 or [x,y,z]) makes any of
  // these world-anchored.

  /**
   * A footstep. Two layers, not one: the impact of the boot, plus a quieter
   * scuff a few milliseconds behind it as the foot rolls. A single burst is
   * what made every surface sound like the same tap at different pitches.
   * Sand, snow and grass get a long soft scuff; stone and wood get a short one.
   */
  step(mat, pos) {
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.stone;
    if (mat === 'water') return this._waterStep(pos);
    const pitch = 0.85 + Math.random() * 0.25;
    if (!this._burst(mat, { gain: 0.20, pitch, dur: 0.9, pos, cat: 'step' })) return;
    const soft = mat === 'sand' || mat === 'snow' || mat === 'grass' || mat === 'soil';
    const t = this.ctx.currentTime + 0.012 + Math.random() * 0.02;
    const d = (soft ? 0.11 : 0.05) * (0.8 + Math.random() * 0.5);
    const out = this._dest(pos, d + 0.2);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(cfg.hi * 0.7 * pitch, t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, cfg.lo * 0.8), t + d);
    bp.Q.value = 0.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.075 * (soft ? 1.25 : 0.8), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  dig(mat, pos) { this._burst(mat, { gain: 0.18, pitch: 1.1, dur: 0.55, pos }); }
  break_(mat, pos) { this._burst(mat, { gain: 0.5, pitch: 0.9, dur: 1.7, pos }); }
  place(mat, pos) { this._burst(mat, { gain: 0.42, pitch: 1.15, dur: 1.1, pos }); }

  /** Walking through shallow water: a wet slosh with no hard transient at all. */
  _waterStep(pos) {
    if (!this._live() || !this._take('step', 0.45)) return;
    const t = this.ctx.currentTime;
    const d = 0.18 + Math.random() * 0.12;
    const out = this._dest(pos, d + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.5;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(400 + Math.random() * 300, t);
    bp.frequency.exponentialRampToValueAtTime(2200 + Math.random() * 1400, t + d * 0.6);
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.20, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /**
   * Water displaced. A broadband slap, a body of noise falling away behind it,
   * and a short run of rising bubble resonances — the rise is what makes it
   * water rather than a burst of static. Scale 1 is a body entering; the
   * fishing float and a bucket pass smaller numbers.
   */
  splash(pos, scale = 1) {
    if (!this._live() || !this._take('player', 1.0)) return;
    const t = this.ctx.currentTime;
    const d = (0.5 + Math.random() * 0.35) * scale;
    const out = this._dest(pos, d * 1.6 + 0.4);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.4;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600 + Math.random() * 1800, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + d);
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.34 * scale, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    const n = 2 + ((Math.random() * 4 * scale) | 0);
    for (let i = 0; i < n; i++) {
      const tn = t + 0.02 + i * (0.02 + Math.random() * 0.06);
      const bd = 0.04 + Math.random() * 0.06;
      const f = 300 + Math.random() * 800;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * (2 + Math.random() * 1.6), tn + bd);
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(0.0001, tn);
      bg.gain.linearRampToValueAtTime(0.10 * scale, tn + 0.004);
      bg.gain.exponentialRampToValueAtTime(0.0004, tn + bd);
      o.connect(bg).connect(out);
      o.start(tn); o.stop(tn + bd + 0.03);
    }
  }

  /** One swimming stroke. Deliberately soft; it repeats every second or so. */
  swim(pos) {
    if (!this._live() || !this._take('step', 0.5)) return;
    const t = this.ctx.currentTime;
    const d = 0.3 + Math.random() * 0.2;
    const out = this._dest(pos, d + 0.3);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 + Math.random() * 500, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + d);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + d * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(lp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /** Breaking the surface: the splash plus a gasp. */
  surface() {
    this.splash(null, 0.7);
    if (!this._live() || !this._take('player', 0.5)) return;
    const t = this.ctx.currentTime + 0.05;
    const d = 0.34;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.1;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + d * 0.5);
    bp.Q.value = 1.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.09);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /**
   * Taking a hit. The original was one sawtooth drop, which read as an arcade
   * buzzer; the sharp intake of breath over the top is what makes it a body.
   */
  hurt() {
    if (!this._live() || !this._take('player', 0.5)) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220 * (0.9 + Math.random() * 0.2), t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.28);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.26, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.connect(f).connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.36);
    this._noiseHit(this.sfxBus, t, { gain: 0.13, lo: 900, hi: 300, q: 1.4, dur: 0.2, at: 0.02 });
  }

  /** Player death: the hurt, then everything falling away underneath it. */
  death() {
    this.hurt();
    if (!this._live() || !this._take('player', 2.2)) return;
    const t = this.ctx.currentTime + 0.12;
    const d = 1.8;
    for (const [mul, amt] of [[1, 1], [0.5, 0.7], [1.5, 0.28]]) {
      const o = this.ctx.createOscillator();
      o.type = mul === 1.5 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(196 * mul, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(24, 44 * mul), t + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16 * amt, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0004, t + d);
      o.connect(g).connect(this.sfxBus);
      o.start(t); o.stop(t + d + 0.1);
    }
  }

  pickup() {
    if (!this._live() || !this._take('ui', 0.3)) return;
    const t = this.ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.14, t + i * 0.06 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.06 + 0.16);
      o.connect(g).connect(this.uiBus);
      o.start(t + i * 0.06); o.stop(t + i * 0.06 + 0.2);
    });
  }

  /**
   * The generic interface blip. Still one square, because dozens of call sites
   * pass nothing but a frequency and expect a click — but now with a fast pitch
   * drop and a lowpass on it, which is the difference between a click and the
   * flat beep this used to be. Everything menu-shaped runs through here.
   */
  ui(freq = 520) {
    if (!this._live() || !this._take('ui', 0.15)) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(freq * 1.06, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.03);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, freq * 5.5); lp.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    // 0.05 measured at -51.5 weighted, the quietest thing in the game bar the
    // bow creak, on the voice that answers every menu action there is.
    g.gain.linearRampToValueAtTime(0.075, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.09);
    o.connect(lp).connect(g).connect(this.uiBus);
    o.start(t); o.stop(t + 0.1);
  }

  /** Refused. A flat, dull two-tone fall; unmistakably not a confirmation. */
  deny() {
    if (!this._live() || !this._take('ui', 0.3)) return;
    const t = this.ctx.currentTime;
    [[230, 0], [172, 0.075]].forEach(([f, dt]) => {
      const o = this.ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + dt);
      g.gain.linearRampToValueAtTime(0.055, t + dt + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, t + dt + 0.10);
      o.connect(lp).connect(g).connect(this.uiBus);
      o.start(t + dt); o.stop(t + dt + 0.12);
    });
  }

  /** Something went wrong and the player needs to know without reading. */
  saveFail() {
    if (!this._live() || !this._take('ui', 0.7)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const tn = t + i * 0.13;
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150, tn);
      o.frequency.exponentialRampToValueAtTime(96, tn + 0.11);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 800;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, tn);
      g.gain.linearRampToValueAtTime(0.09, tn + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + 0.12);
      o.connect(lp).connect(g).connect(this.uiBus);
      o.start(tn); o.stop(tn + 0.14);
    }
  }

  /** Progress. A rising arpeggio with a bell on top; the only fanfare here. */
  levelUp() {
    if (!this._live() || !this._take('ui', 1.4)) return;
    const t = this.ctx.currentTime;
    const root = 440;
    [0, 4, 7, 12].forEach((semi, i) => {
      const f = root * Math.pow(2, semi / 12);
      const tn = t + i * 0.085;
      for (const [mul, amt, type] of [[1, 1, 'sine'], [2, 0.3, 'triangle']]) {
        const o = this.ctx.createOscillator();
        o.type = type; o.frequency.value = f * mul;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, tn);
        g.gain.linearRampToValueAtTime(0.085 * amt, tn + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0004, tn + (i === 3 ? 0.9 : 0.28));
        o.connect(g).connect(this.uiBus);
        if (this.reverbGain) g.connect(this.reverbGain);
        o.start(tn); o.stop(tn + (i === 3 ? 1.0 : 0.32));
      }
    });
  }

  /** Chewing, then a swallow. Four irregular wet grains, no two the same. */
  eat() {
    if (!this._live() || !this._take('player', 0.9)) return;
    const t = this.ctx.currentTime;
    const bites = 3 + ((Math.random() * 2) | 0);
    for (let i = 0; i < bites; i++) {
      const tn = t + i * (0.13 + Math.random() * 0.08);
      const d = 0.07 + Math.random() * 0.05;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900 + Math.random() * 1400, tn);
      bp.frequency.exponentialRampToValueAtTime(300, tn + d);
      bp.Q.value = 1.1;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.13, tn + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      src.connect(bp).connect(g).connect(this.sfxBus);
      src.start(tn, Math.random() * 2); src.stop(tn + d + 0.03);
    }
    // the gulp: a short rising resonance, the same trick as a bubble
    const gt = t + bites * 0.15 + 0.05;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, gt);
    o.frequency.exponentialRampToValueAtTime(430, gt + 0.12);
    const gg = this.ctx.createGain();
    gg.gain.setValueAtTime(0.0001, gt);
    gg.gain.linearRampToValueAtTime(0.10, gt + 0.02);
    gg.gain.exponentialRampToValueAtTime(0.0004, gt + 0.14);
    o.connect(gg).connect(this.sfxBus);
    o.start(gt); o.stop(gt + 0.16);
  }

  /** Bench work: a couple of knocks and a scrape. Not a chime, not a coin. */
  craft() {
    if (!this._live() || !this._take('player', 0.7)) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const tn = t + i * (0.10 + Math.random() * 0.05);
      const d = 0.12;
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      const f = 190 * (i ? 0.8 : 1) * (0.9 + Math.random() * 0.2);
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * 0.55, tn + d);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.18, tn + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      o.connect(g).connect(this.sfxBus);
      o.start(tn); o.stop(tn + d + 0.03);
      this._noiseHit(this.sfxBus, tn, { gain: 0.13, lo: 500, hi: 2600, q: 1.0, dur: 0.09 });
    }
    this._noiseHit(this.sfxBus, t + 0.24, { gain: 0.08, lo: 900, hi: 4200, q: 0.7, dur: 0.22, at: 0.05 });
  }

  /**
   * A kiln finishing a smelt. The one sound in the game that had to be new
   * rather than rewired: a kiln ran for twenty seconds and produced its ingot
   * in complete silence, so there was no way to know it was done without
   * standing over the screen.
   *
   * Two layers, and the order matters. First the breath of heat escaping as the
   * lid of the reaction gives — noise through a band that OPENS rather than
   * closes, which is what separates a release from an impact. Then, a beat
   * later, a dull struck tick: the thing itself, dropping into the tray.
   * Positional, because a kiln is a place you walk away from.
   */
  smelt(pos = null) {
    if (!this._live() || !this._take('block', 0.9)) return;
    const t = this.ctx.currentTime;
    const d = 0.55;
    const out = this._dest(pos, 1.2);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.55 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(1900 + Math.random() * 600, t + d);
    bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);

    // the ingot landing: low, short, barely tuned — a kiln is fired clay, and
    // anything that rang here sounded like a bell instead of a workshop
    const tn = t + 0.30;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = 260 * (0.92 + Math.random() * 0.16);
    o.frequency.setValueAtTime(f, tn);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, tn + 0.22);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, tn);
    og.gain.linearRampToValueAtTime(0.17, tn + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0004, tn + 0.24);
    o.connect(og).connect(out);
    o.start(tn); o.stop(tn + 0.26);
    this._noiseHit(out, tn, { gain: 0.11, lo: 600, hi: 3200, q: 1.0, dur: 0.07 });
  }

  /**
   * Drawing a bow. `power` is 0..1; the creak climbs with it, so holding at
   * full draw sounds like holding at full draw. Called repeatedly while held —
   * the step budget throttles it if the caller is generous with the rate.
   */
  bowDraw(power = 0.5) {
    if (!this._live() || !this._take('step', 0.35)) return;
    const t = this.ctx.currentTime;
    const d = 0.22;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.35 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(420 + power * 700, t);
    bp.frequency.linearRampToValueAtTime(620 + power * 1200, t + d);
    bp.Q.value = 5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    // -58 weighted at full draw: three dB under a footstep, for a sound whose
    // whole job is to report how hard the shot will be.
    g.gain.linearRampToValueAtTime(0.13 + power * 0.09, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.05);
  }

  /** Loosing it: string thwip plus the shaft leaving, both scaled by draw. */
  bowRelease(power = 1) {
    if (!this._live() || !this._take('player', 0.6)) return;
    const t = this.ctx.currentTime;
    const p = 0.35 + power * 0.65;

    // string: a fast damped low twang
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = 150 + power * 130;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.45, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24 * p, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.13);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.15);

    // shaft: bright noise sweeping down and away
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3800 + power * 2600, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.28);
    bp.Q.value = 1.3;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.16 * p, t + 0.006);
    ng.gain.exponentialRampToValueAtTime(0.0004, t + 0.28);
    src.connect(bp).connect(ng).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + 0.32);
  }

  /**
   * A swing that hit nothing. Cheap, and the reason a miss feels different from
   * standing still — the whole point of a whoosh is that it is not a hit.
   */
  swing() {
    if (!this._live() || !this._take('step', 0.3)) return;
    const t = this.ctx.currentTime;
    const d = 0.19;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.3;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(360, t);
    bp.frequency.exponentialRampToValueAtTime(1500 + Math.random() * 700, t + d * 0.45);
    bp.frequency.exponentialRampToValueAtTime(300, t + d);
    bp.Q.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.10, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.03);
  }

  /**
   * An arrow arriving. A hard tick tuned by what it hit, plus a shaft ring on
   * anything that is not flesh. `dig('stone')` stood in for this everywhere,
   * which meant an arrow into a tree sounded like a pickaxe.
   */
  impact(mat = 'wood', pos = null) {
    if (!this._live() || !this._take('hit', 0.5)) return;
    const cfg = MATERIAL_TUNING[mat] || MATERIAL_TUNING.wood;
    const t = this.ctx.currentTime;
    const out = this._dest(pos, 0.6, false);
    this._noiseHit(out, t, { gain: 0.30, lo: cfg.lo, hi: cfg.hi * 1.4, q: 1.0, dur: 0.07 });
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f = Math.max(90, (cfg.body || 240) * 1.4);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.18);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + 0.2);
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
    // A death is the last thing an animal ever does; it outbids a herd of idles
    // for the last slot in the budget rather than being dropped by them.
    if (kind !== 'death' && !this._take('mob', dur * 2 + 0.4)) return false;
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
    if (!this._live() || !this._take('hit', 0.5)) return;
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
    if (!this._live() || !this._take('weather', 7)) return;
    const t = this.ctx.currentTime;
    const near = Math.random();                 // 0 distant roll → 1 overhead crack
    const boom = 2.6 + Math.random() * 3.4;     // total decay in seconds
    // Clamped: the caller passes up to 1.2, and an overhead strike at that
    // strength used to schedule a gain of 1.26 on the bus. The compressor
    // caught it, but catching it is not the same as it not happening — a
    // limiter working that hard on the loudest event in the game is what makes
    // a storm sound small instead of frightening.
    const amp = Math.min(0.95, (0.5 + near * 0.42) * strength);
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
    this.ambience = new Ambience(
      this.ctx, this.ambBus, this.reverbGain, this.noiseBuf,
      (cat) => this._take(cat, 3),
    );
  }

  /**
   * Called every frame. Only `wind`, `water`, `cave` and `underwater` are
   * required; the rest colour the bed by where and when you are, and a caller
   * that does not know them still gets a working ambience. See the hook list in
   * the module notes for what each extra field wants.
   */
  setAmbience(s) {
    if (!this.ctx) return;
    if (this.ambience) this.ambience.set(s);
    const t = this.ctx.currentTime;
    const under = s.underwater || 0;

    // The muffle. 20kHz is transparent, 420Hz is submerged, and the ramp across
    // is what sells the moment your head goes under rather than the level drop.
    if (Math.abs(under - this._muffle) > 0.01) {
      this._muffle = under;
      const cut = 20000 * Math.pow(420 / 20000, under);
      this.muffle.frequency.setTargetAtTime(cut, t, 0.12);
      // Underwater the reverb send opens up: a hard surface a body-length away
      // in every direction, which is exactly what being in a lake is.
      if (this.reverbGain) {
        this.reverbGain.gain.setTargetAtTime(0.16 + under * 0.30, t, 0.2);
      }
      if (this.musicBus) {
        this.musicBus.gain.setTargetAtTime(this.musicVolume * (1 - under * 0.6), t, 0.6);
      }
      this.master.gain.setTargetAtTime(this.masterVolume * (1 - under * 0.45), t, 0.3);
    }
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

  /**
   * Master and music levels, 0..1, straight from the settings sliders. Both are
   * scaled by the current underwater duck rather than overwriting it — setting
   * the raw value here while submerged used to snap the mix back to dry until
   * the next time the player's head crossed the surface.
   *
   * Master at zero also switches the engine off rather than merely turning it
   * down. `_live()` has always gated every voice on `enabled`, but nothing ever
   * wrote that flag, so a player who dragged the slider to the left silently
   * kept paying for the whole graph: at a muted master the game still built a
   * PannerNode, three filters and an envelope per footstep, per block break and
   * per animal call, several times a second, all of it multiplied by a gain of
   * zero on the way out. This is the one control the player has that means
   * "off", so it is the one that says so.
   */
  setVolumes(master, music) {
    this.masterVolume = master;
    this.musicVolume = music;
    this.enabled = master > 0;
    const u = this._muffle || 0;
    if (this.master) this.master.gain.value = master * (1 - u * 0.45);
    if (this.musicBus) this.musicBus.gain.value = music * (1 - u * 0.6);
  }
}
