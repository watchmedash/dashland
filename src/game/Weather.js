// Random weather with smooth transitions. Precipitation falls as snow wherever
// the ground is cold, and every value here eases toward its target so the sky
// never snaps.

import { BIOME } from '../world/Constants.js';

const STATES = {
  clear: { weight: 34, coverage: 0.62, opacity: 0.72, precip: 0.00, sun: 1.00, wind: 0.55, fog: 1.0, dur: [240, 620] },
  fair: { weight: 30, coverage: 0.40, opacity: 0.86, precip: 0.00, sun: 0.94, wind: 0.8, fog: 1.1, dur: [200, 520] },
  overcast: { weight: 18, coverage: 0.16, opacity: 0.95, precip: 0.00, sun: 0.55, wind: 1.0, fog: 1.5, dur: [160, 380] },
  rain: { weight: 13, coverage: 0.08, opacity: 0.97, precip: 0.62, sun: 0.34, wind: 1.4, fog: 2.1, dur: [120, 300] },
  storm: { weight: 5, coverage: 0.02, opacity: 1.00, precip: 1.00, sun: 0.20, wind: 2.1, fog: 2.8, dur: [80, 190] },
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
    this.cold = COLD_BIOMES.has(biomeId) || altitude > 9 - chill * 9 || chill > 0.75;
    this.type = this.cold ? 'snow' : 'rain';

    // lightning during storms
    this.lightning = Math.max(0, this.lightning - dt * 3.2);
    if (this.state === 'storm' && this.precip > 0.6 && Math.random() < dt * 0.09) {
      this.lightning = 1;
      this.onThunder?.();
    }
  }

  get raining() { return this.precip > 0.05 && !this.cold; }
  get snowing() { return this.precip > 0.05 && this.cold; }
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
