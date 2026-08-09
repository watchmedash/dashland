// Ambient beds and sparse generative detail. Everything is synthesised from a
// single shared pink-noise buffer plus oscillators; there are no asset files.
//
// Two mechanisms
// --------------
// 1. Beds: looping noise sources created once at start, each through a fixed
//    filter into a gain that is the only thing ever automated. Node count is
//    constant for the lifetime of the game and gains ride to zero when a layer
//    is not wanted, so an unused bed costs one silent multiply.
// 2. Detail: sparse one-shots (a bird, a drip, a bubble run) scheduled from one
//    timer chain, gated on the same state the beds read. These are what stop a
//    quiet planet reading as a broken audio device.
//
// Everything answers to `set()`, which is called every frame. It is written to
// be cheap on the frames where nothing has changed: a gain is only re-armed
// when its target has moved more than a hair, so standing still schedules no
// automation events at all.

// Indices match BIOME_NAMES in the HUD.
// bird/cricket/cicada are population densities, windF/windQ colour the wind for
// the terrain (open ground hisses low and wide, trees whistle higher and
// narrower), surf is how much ocean is within earshot by default, and `air` is
// a per-biome trim so a snowfield genuinely reads emptier than a meadow.
const BIOME_AIR = [
  { bird: 0.15, cricket: 0.00, cicada: 0.00, windF: 340, windQ: 0.55, surf: 1.00, air: 1.00 }, // Ocean
  { bird: 0.35, cricket: 0.12, cicada: 0.00, windF: 380, windQ: 0.60, surf: 0.85, air: 1.00 }, // Shore
  { bird: 0.70, cricket: 0.80, cicada: 0.15, windF: 520, windQ: 0.70, surf: 0.00, air: 1.00 }, // Plains
  { bird: 1.00, cricket: 0.70, cicada: 0.25, windF: 640, windQ: 1.15, surf: 0.00, air: 0.85 }, // Woodland
  { bird: 0.50, cricket: 0.22, cicada: 0.00, windF: 720, windQ: 1.35, surf: 0.00, air: 0.90 }, // Taiga
  { bird: 0.08, cricket: 0.50, cicada: 0.95, windF: 430, windQ: 0.50, surf: 0.00, air: 1.05 }, // Desert
  { bird: 0.50, cricket: 0.90, cicada: 0.70, windF: 480, windQ: 0.60, surf: 0.00, air: 1.00 }, // Savanna
  { bird: 0.20, cricket: 0.00, cicada: 0.00, windF: 380, windQ: 0.50, surf: 0.00, air: 1.05 }, // Tundra
  { bird: 0.05, cricket: 0.00, cicada: 0.00, windF: 300, windQ: 0.45, surf: 0.00, air: 1.10 }, // Snowfield
  { bird: 0.25, cricket: 0.08, cicada: 0.00, windF: 560, windQ: 0.50, surf: 0.00, air: 1.15 }, // Highlands
  { bird: 0.90, cricket: 1.00, cicada: 0.30, windF: 540, windQ: 0.75, surf: 0.00, air: 1.00 }, // Meadow
  { bird: 0.10, cricket: 0.35, cicada: 0.80, windF: 400, windQ: 0.50, surf: 0.00, air: 1.05 }, // Badlands
];
const DEFAULT_AIR = BIOME_AIR[2];

// Bird song patterns, so a forest is not one motif on repeat. Each is a list of
// [semitone offset, length] pairs played over a common root.
const SONGS = [
  [[0, 0.07], [4, 0.07], [7, 0.11]],
  [[7, 0.05], [7, 0.05], [12, 0.14]],
  [[0, 0.05], [-3, 0.05], [0, 0.05], [5, 0.10]],
  [[12, 0.09], [7, 0.06], [9, 0.16]],
  [[0, 0.20]],
  [[5, 0.04], [9, 0.04], [12, 0.04], [16, 0.09]],
];

/** 0 in full daylight, 1 in full dark, with dawn and dusk ramps between. */
export function nightness(t) {
  const x = ((t % 1) + 1) % 1;
  if (x < 0.20) return 1;
  if (x < 0.30) return 1 - (x - 0.20) / 0.10;
  if (x < 0.78) return 0;
  if (x < 0.90) return (x - 0.78) / 0.12;
  return 1;
}

/** Peaks through the two hours after sunrise, which is when birds actually sing. */
function dawnChorus(t) {
  const x = ((t % 1) + 1) % 1;
  if (x > 0.24 && x < 0.40) return 1 - Math.abs(x - 0.30) / 0.10;
  if (x > 0.68 && x < 0.80) return 0.5 * (1 - Math.abs(x - 0.74) / 0.06);
  return 0;
}

export class Ambience {
  /**
   * @param ctx     live AudioContext
   * @param out     bus every bed and one-shot feeds
   * @param send    reverb send, for the handful of things that want a tail
   * @param noise   shared pink-noise buffer
   * @param budget  (cat) => boolean; the shared voice allocator
   */
  constructor(ctx, out, send, noise, budget) {
    this.ctx = ctx;
    this.out = out;
    this.send = send;
    this.noise = noise;
    this.budget = budget || (() => true);
    this.beds = {};
    this.stats = { oneShots: 0, dropped: 0, rearms: 0 };
    // last target written per bed, so an unchanged frame writes nothing
    this._armed = {};
    this._state = {
      wind: 0, water: 0, cave: 0, underwater: 0,
      rain: 0, surf: 0, biome: 2, time: 0.35, openness: 1, depth: 0,
    };
    this._build();
    this._tick = this._tick.bind(this);
    this._timer = setTimeout(this._tick, 1200);
  }

  // --- construction ----------------------------------------------------------

  /** One looping noise bed: source → filter → [modulated gain] → level → out. */
  _bed(name, type, freq, q, { am = 0, amRate = 0, rate = 1 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const level = ctx.createGain();
    level.gain.value = 0;

    let head = f;
    let amGain = null;
    if (am > 0) {
      amGain = ctx.createGain();
      // base sits at 1-am so the LFO swings between 1-2am and 1
      amGain.gain.value = 1 - am;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = amRate;
      const ld = ctx.createGain(); ld.gain.value = am;
      lfo.connect(ld).connect(amGain.gain);
      lfo.start();
      f.connect(amGain);
      head = amGain;
    }
    head.connect(level).connect(this.out);
    src.connect(f);
    src.start(0, Math.random() * 2);
    const bed = { src, f, level, am: amGain };
    this.beds[name] = bed;
    this._armed[name] = 0;
    return bed;
  }

  _build() {
    const ctx = this.ctx;

    // Wind is two beds: a wide body whose centre frequency the gust LFO sweeps,
    // and a thin high hiss that only appears in the open and up high.
    this._bed('wind', 'bandpass', 520, 0.7, { rate: 0.9 });
    this._bed('windHi', 'highpass', 2600, 0.5, { rate: 1.15 });
    const gust = ctx.createOscillator();
    gust.frequency.value = 0.055;
    const gd = ctx.createGain(); gd.gain.value = 260;
    gust.connect(gd).connect(this.beds.wind.f.frequency);
    gust.start();
    this._gustDepth = gd;

    // Surf: a low band with a very slow swell riding its level. The swell is a
    // second gain in series so `set()` still owns the one it writes.
    this._bed('surf', 'bandpass', 380, 0.5, { rate: 0.55 });
    const swellGain = ctx.createGain(); swellGain.gain.value = 0.6;
    // splice the swell in ahead of the level gain
    this.beds.surf.f.disconnect();
    this.beds.surf.f.connect(swellGain).connect(this.beds.surf.level);
    const swell = ctx.createOscillator();
    swell.type = 'sine'; swell.frequency.value = 0.085;
    const sd = ctx.createGain(); sd.gain.value = 0.4;
    swell.connect(sd).connect(swellGain.gain);
    swell.start();

    // Moving water nearby: a stream/lapping band, brighter and busier than surf.
    this._bed('water', 'bandpass', 900, 0.6, { rate: 1.1 });

    // Rain in two halves so drizzle and a downpour are different sounds, not one
    // sound at two volumes: hiss alone is drizzle, hiss plus roar is a storm.
    this._bed('rainHiss', 'highpass', 2000, 0.5, { rate: 1.3 });
    this._bed('rainBody', 'bandpass', 620, 0.45, { rate: 0.75 });

    // Underground: a dead low rumble with no high end at all.
    this._bed('cave', 'lowpass', 180, 1.0, { rate: 0.5 });

    // Submerged: darker still, plus a slow warble on the cutoff that reads as
    // water moving over the ears.
    this._bed('sub', 'lowpass', 260, 0.9, { rate: 0.4 });
    const warble = ctx.createOscillator();
    warble.type = 'sine'; warble.frequency.value = 0.23;
    const wd = ctx.createGain(); wd.gain.value = 90;
    warble.connect(wd).connect(this.beds.sub.f.frequency);
    warble.start();

    // Insects. Crickets are a narrow high band chopped twice: a slow phrase and
    // a fast trill inside it. Cicadas are wider, faster, and never stop.
    this._bed('cricket', 'bandpass', 4700, 11, { am: 0.5, amRate: 2.7, rate: 1.4 });
    const trill = ctx.createGain(); trill.gain.value = 0.5;
    this.beds.cricket.am.disconnect();
    this.beds.cricket.am.connect(trill).connect(this.beds.cricket.level);
    const tl = ctx.createOscillator();
    tl.type = 'square'; tl.frequency.value = 24;
    const td = ctx.createGain(); td.gain.value = 0.5;
    tl.connect(td).connect(trill.gain);
    tl.start();

    this._bed('cicada', 'bandpass', 3300, 7, { am: 0.35, amRate: 13, rate: 1.25 });
  }

  // --- per-frame state -------------------------------------------------------

  /**
   * Ride every bed to the level the current state implies. Extra fields are all
   * optional: a caller that only knows about wind/water/cave/underwater still
   * gets a sensible bed, it just gets no time of day or biome colour.
   */
  set(s) {
    if (!this.ctx) return;
    const st = this._state;
    st.wind = s.wind ?? st.wind;
    st.water = s.water ?? st.water;
    st.cave = s.cave ?? st.cave;
    st.underwater = s.underwater ?? st.underwater;
    st.rain = s.rain ?? 0;
    st.biome = s.biome ?? st.biome;
    st.time = s.time ?? st.time;
    st.depth = s.depth ?? 0;
    st.openness = s.openness ?? (1 - Math.min(1, st.cave));
    const air = BIOME_AIR[st.biome | 0] || DEFAULT_AIR;
    st.surf = s.surf ?? air.surf * Math.min(1, st.water * 1.6);

    const night = nightness(st.time);
    const out = st.openness * (1 - st.underwater);
    const dry = 1 - Math.min(1, st.rain * 1.4);

    // Wind colour follows the terrain, not just its level.
    this._param(this.beds.wind.f.frequency, air.windF, 12);
    this._param(this.beds.wind.f.Q, air.windQ, 0.05);
    this._param(this._gustDepth.gain, air.windF * 0.5, 10);

    const w = st.wind * air.air;
    this._arm('wind', w * 0.046 * (0.35 + 0.65 * out));
    this._arm('windHi', w * 0.016 * out * st.openness);
    this._arm('surf', st.surf * 0.055 * out);
    this._arm('water', st.water * 0.040 * out);
    this._arm('rainHiss', st.rain * 0.055 * out);
    this._arm('rainBody', Math.max(0, st.rain - 0.35) * 0.075 * out);
    this._arm('cave', st.cave * 0.080 * (1 - st.underwater));
    this._arm('sub', st.underwater * 0.10);
    // Insects need warmth, dark (or heat), dry air and open sky.
    this._arm('cricket', air.cricket * night * dry * out * 0.030);
    this._arm('cicada', air.cicada * (1 - night) * dry * out * 0.022);
  }

  /** Ride a level gain, skipping the write when it has not meaningfully moved. */
  _arm(name, target) {
    const prev = this._armed[name];
    if (Math.abs(target - prev) < 0.0012) return;
    this._armed[name] = target;
    this.stats.rearms++;
    this.beds[name].level.gain.setTargetAtTime(target, this.ctx.currentTime, 0.55);
  }

  /** Same idea for a non-level AudioParam. */
  _param(p, target, eps) {
    if (Math.abs(p.value - target) < eps) return;
    p.setTargetAtTime(target, this.ctx.currentTime, 1.2);
  }

  // --- sparse detail ---------------------------------------------------------

  _tick() {
    this._timer = null;
    if (!this.ctx || this.ctx.state === 'closed') return;
    const st = this._state;
    const air = BIOME_AIR[st.biome | 0] || DEFAULT_AIR;
    const night = nightness(st.time);
    const dry = 1 - Math.min(1, st.rain * 1.4);
    const open = st.openness * (1 - st.underwater) * (1 - Math.min(1, st.cave));
    let gap = 1.1 + Math.random() * 1.6;

    if (st.underwater > 0.5) {
      if (Math.random() < 0.45) this._bubbles();
      // A low moan, rarely. It is the one thing down there that suggests the
      // ocean has a size, and it stops being eerie the moment it is frequent.
      else if (Math.random() < 0.06) this._moan();
      gap = 1.6 + Math.random() * 2.4;
    } else if (st.cave > 0.6) {
      if (Math.random() < 0.30) this._drip();
      else if (Math.random() < 0.05) this._groan();
      gap = 2.2 + Math.random() * 4.0;
    } else {
      const song = air.bird * (1 - night) * dry * open * (0.35 + 0.65 * dawnChorus(st.time));
      const owl = (air.bird > 0.4 ? 1 : 0.2) * night * dry * open;
      if (Math.random() < song * 0.85) this._bird(air);
      else if (Math.random() < owl * 0.10) this._owl();
      else if (Math.random() < st.wind * open * 0.16) this._howl(air);
      gap = 1.4 + Math.random() * 3.2 * (1 - song * 0.5);
    }

    this._timer = setTimeout(this._tick, gap * 1000);
  }

  _ok() {
    if (!this.budget('amb')) { this.stats.dropped++; return false; }
    this.stats.oneShots++;
    return true;
  }

  /** Short whistled phrase. Sine only: anything richer reads as a synth lead. */
  _bird(air) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.random() * 0.3;
    const song = SONGS[(Math.random() * SONGS.length) | 0];
    const root = 1700 + Math.random() * 1500 * (air.windQ > 1 ? 1 : 0.7);
    const lvl = 0.020 + Math.random() * 0.016;
    let tn = t;
    for (const [semi, len] of song) {
      const f = root * Math.pow(2, semi / 12);
      const o = ctx.createOscillator();
      o.type = 'sine';
      // every note bends; a flat one sounds like a test tone
      o.frequency.setValueAtTime(f * 0.94, tn);
      o.frequency.exponentialRampToValueAtTime(f, tn + len * 0.3);
      o.frequency.exponentialRampToValueAtTime(f * (0.9 + Math.random() * 0.25), tn + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(lvl, tn + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + len);
      o.connect(g).connect(this.out);
      if (this.send) g.connect(this.send);
      o.start(tn); o.stop(tn + len + 0.03);
      tn += len + 0.012 + Math.random() * 0.03;
    }
  }

  /** Two soft low pulses. Deliberately the only night bird. */
  _owl() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.random() * 0.4;
    const f0 = 330 + Math.random() * 90;
    for (let i = 0; i < 2; i++) {
      const tn = t + i * 0.42;
      const d = i ? 0.34 : 0.22;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0 * (i ? 0.94 : 1), tn);
      o.frequency.linearRampToValueAtTime(f0 * (i ? 0.88 : 0.97), tn + d);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.030, tn + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      o.connect(g).connect(this.out);
      if (this.send) g.connect(this.send);
      o.start(tn); o.stop(tn + d + 0.05);
    }
  }

  /** A gust that rises and falls on its own, over the top of the wind bed. */
  _howl(air) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = 2.2 + Math.random() * 3.0;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = air.windQ * 2.2 + 1.4;
    const top = air.windF * (1.6 + Math.random() * 1.4);
    bp.frequency.setValueAtTime(air.windF, t);
    bp.frequency.linearRampToValueAtTime(top, t + d * 0.45);
    bp.frequency.linearRampToValueAtTime(air.windF * 0.8, t + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.030 + Math.random() * 0.02, t + d * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.1);
  }

  /** Cave drip: a tuned ping with a click on the front, straight into reverb. */
  _drip() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.random() * 0.6;
    const f = 700 + Math.random() * 1500;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.9, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.16);
    o.connect(g).connect(this.out);
    if (this.send) g.connect(this.send);
    o.start(t); o.stop(t + 0.2);
  }

  /** Distant rock settling. Almost sub-audible; it is felt, not heard. */
  _groan() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = 2.0 + Math.random() * 2.5;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.playbackRate.value = 0.2 + Math.random() * 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(55, t + d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    src.connect(lp).connect(g).connect(this.out);
    src.start(t, Math.random() * 2); src.stop(t + d + 0.1);
  }

  /** A run of rising bubbles. Underwater's equivalent of a bird. */
  _bubbles() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = 2 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const tn = t + i * (0.03 + Math.random() * 0.09);
      const d = 0.05 + Math.random() * 0.07;
      const f = 260 + Math.random() * 700;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, tn);
      o.frequency.exponentialRampToValueAtTime(f * (2.2 + Math.random()), tn + d);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tn);
      g.gain.linearRampToValueAtTime(0.030, tn + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0004, tn + d);
      o.connect(g).connect(this.out);
      o.start(tn); o.stop(tn + d + 0.03);
    }
  }

  /** Very low, very slow. Rare on purpose. */
  _moan() {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const d = 3.5 + Math.random() * 3;
    const f = 52 + Math.random() * 40;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * (0.7 + Math.random() * 0.6), t + d);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.6 + Math.random() * 0.5;
    const ld = ctx.createGain(); ld.gain.value = f * 0.04;
    lfo.connect(ld).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + d * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0004, t + d);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + d + 0.1);
    lfo.start(t); lfo.stop(t + d + 0.1);
  }

  dispose() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}
