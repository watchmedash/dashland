// Random weather with smooth transitions. Precipitation falls as snow wherever
// the ground is cold, and every value here eases toward its target so the sky
// never snaps.

import { BIOME } from '../world/Constants.js';
import { snowLine } from './Seasons.js';

/**
 * `fog` tops out at 1.9 because that is where it stops reaching anything.
 *
 * The consumer is `uFogDensity = 0.0013 * Math.min(1.9, w.fog)` in main.js, and
 * the ceiling is not incidental — the aerial-perspective note in
 * VoxelMaterial.js sizes the whole haze curve against "a storm's 1.9", which
 * puts f at 0.83 on the horizon. The table did not agree with it: rain asked for
 * 2.1 and storm for 2.8, both of which clamp to the same 1.9, so a storm was
 * exactly as hazy as the rain it grew out of and the difference between the two
 * numbers had never once been on screen. Every value now lands inside the range
 * that arrives, with storm sitting on the ceiling the shader is tuned for and
 * rain a clear step below it.
 */
/**
 * `sun` is how much daylight gets past the cloud, and it is the only thing in
 * this table the *ground* feels: main multiplies both the sun's colour and the
 * directional's intensity by it, and scales the terrain's sky fill by
 * (0.5 + sun * 0.5) on top.
 *
 * Overcast was 0.55, which is a thin haze and not a deck. Measured on one
 * column at noon, switching to overcast took the ground from luma 56 to 43 —
 * 23% — with the sun's shadows still crisply cast underneath, so it read as a
 * clear day with a grey backdrop rather than as weather. It is 0.36 now, which
 * lands the same ground at ~35 (-38%) and leaves the directional too weak to
 * draw a hard edge.
 *
 * Rain and storm move with it, not because either was reported but because they
 * have to stay below overcast to keep the ladder in order; the gaps between the
 * four are preserved in ratio. Storm at 0.15 is the darkest daylight in the
 * game and is meant to be.
 */
const STATES = {
  clear: { weight: 34, coverage: 0.62, opacity: 0.72, precip: 0.00, sun: 1.00, wind: 0.55, fog: 1.0, dur: [240, 620] },
  fair: { weight: 30, coverage: 0.40, opacity: 0.86, precip: 0.00, sun: 0.94, wind: 0.8, fog: 1.1, dur: [200, 520] },
  overcast: { weight: 18, coverage: 0.16, opacity: 0.95, precip: 0.00, sun: 0.36, wind: 1.0, fog: 1.4, dur: [160, 380] },
  rain: { weight: 13, coverage: 0.08, opacity: 0.97, precip: 0.62, sun: 0.24, wind: 1.4, fog: 1.65, dur: [120, 300] },
  storm: { weight: 5, coverage: 0.02, opacity: 1.00, precip: 1.00, sun: 0.15, wind: 2.1, fog: 1.9, dur: [80, 190] },
};

const COLD_BIOMES = new Set([BIOME.SNOW, BIOME.TUNDRA]);

export class Weather {
  constructor() {
    this.state = 'fair';
    this.timer = 120;
    this.cold = false;

    this.coverage = STATES.fair.coverage;
    this.opacity = STATES.fair.opacity;
    this.precip = 0;
    this.sun = 1;
    this.wind = 0.8;
    this.fog = 1.1;
    this.type = 'rain';
    this.lightning = 0;
    this.onThunder = null;
  }

  _pick() {
    const entries = Object.entries(STATES);
    // Whatever it is doing now is a third as likely to be what it does next, so
    // the sky keeps moving. That is the only rule here — no pair of states is
    // treated specially, which is worth saying because the comment this replaces
    // claimed two that were never implemented.
    const total = entries.reduce((a, [k, s]) => a + (k === this.state ? s.weight * 0.35 : s.weight), 0);
    let r = Math.random() * total;
    for (const [k, s] of entries) {
      r -= k === this.state ? s.weight * 0.35 : s.weight;
      if (r <= 0) return k;
    }
    return 'fair';
  }

  /**
   * @param {number} chill 0..1 from the season — how much of the year's cold is
   *   in force. At 1 the whole planet is below freezing and rain falls as snow
   *   in the tropics; the biome and altitude rules still apply underneath, so
   *   the poles are white all year and only the middle of the world changes.
   */
  update(dt, biomeId, altitude, chill = 0) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.state = this._pick();
      const d = STATES[this.state].dur;
      this.timer = d[0] + Math.random() * (d[1] - d[0]);
    }

    const s = STATES[this.state];
    const k = Math.min(1, dt * 0.14);
    this.coverage += (s.coverage - this.coverage) * k;
    this.opacity += (s.opacity - this.opacity) * k;
    this.precip += (s.precip - this.precip) * k;
    this.sun += (s.sun - this.sun) * k;
    this.wind += (s.wind - this.wind) * k;
    this.fog += (s.fog - this.fog) * k;

    // Deep winter freezes everywhere; the shoulder seasons only push the
    // snowline down the mountains rather than flipping the whole planet.
    //
    // `snowLine` is that middle clause, unchanged, moved to Seasons.js so the
    // ground cover and the falling precipitation are answering one question
    // with one number. The biome clause stays here and is deliberately NOT part
    // of it: a cold biome makes it *snow* at any height, which is a fact about
    // the sky, while how much of that snow survives on the ground is the
    // altitude question `snowLine` answers.
    this.cold = COLD_BIOMES.has(biomeId) || altitude > snowLine(chill) || chill > 0.75;
    this.type = this.cold ? 'snow' : 'rain';

    // lightning during storms
    this.lightning = Math.max(0, this.lightning - dt * 3.2);
    if (this.state === 'storm' && this.precip > 0.6 && Math.random() < dt * 0.09) {
      this.lightning = 1;
      this.onThunder?.();
    }
  }

  // `raining` and `snowing` used to sit here and were deleted rather than wired
  // up. Both were exported-looking predicates over `precip` and `cold` that
  // nothing read: everything that actually reacts to the weather reads the raw
  // fields instead — the particle field takes `type` and `precip`, the ambience
  // bed takes `precip`, the cloud shader takes `coverage`/`opacity`, and the
  // status chip takes `label` below. Two more names for one threshold is how
  // the threshold drifts apart from the thing it is supposed to describe.
  get label() {
    if (this.precip > 0.75) return this.cold ? 'Blizzard' : 'Storm';
    if (this.precip > 0.2) return this.cold ? 'Snow' : 'Rain';
    if (this.coverage < 0.25) return 'Overcast';
    if (this.coverage < 0.5) return 'Cloudy';
    return 'Clear';
  }

  toJSON() { return { state: this.state, timer: this.timer }; }
  fromJSON(d) { if (d) { this.state = d.state || 'fair'; this.timer = d.timer ?? 120; } }
}
