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

/**
 * Precipitation above which a funnel can form.
 *
 * 0.55 sits between `rain`'s target of 0.62 and `overcast`'s 0.00, so it means
 * "rain that has been falling long enough to have eased most of the way in" —
 * the ease runs at dt*0.14, so a rain band clears this about six seconds after
 * it starts and a storm well before that. It is deliberately a reading of the
 * *eased* value rather than a test on `state`: a tornado should never form on
 * the frame the sky changes its mind.
 */
const TORNADO_PRECIP = 0.55;
/**
 * Per second, while the test above holds.
 *
 * Simulated against this table (400 000 transitions): `rain` and `storm` occupy
 * 11.45% of wall time. 0.006 a second is one roll landing per 167 seconds of wet
 * weather, i.e. **one tornado per ~24 minutes of play** before the biome gate in
 * Tornado.js refuses seven of the twelve biomes. For a player who moves around,
 * that lands nearer 45 minutes. A session sees one or two.
 *
 * The two failure modes either side are both named in the brief and both real:
 * at 0.02 it is one every seven minutes, which is a nuisance you build around;
 * at 0.001 it is one every two and a half hours, which is a feature most players
 * never meet.
 */
const TORNADO_RATE = 0.006;
/**
 * Seconds after one forms before another may.
 *
 * Longer than the longest storm (190s) and longer than the longest tornado
 * (95 + 12 = 107s), so this is not a throttle on a single weather system — it is
 * the guarantee that two cannot be in living memory of each other. Persisted, so
 * quitting and reloading cannot reroll it.
 */
const TORNADO_COOLDOWN = 420;

/**
 * Strikes per second on Tempest, counting the distant ones.
 *
 * 0.3 is a bolt somewhere in view every 3.3 seconds. That is far more often than
 * a real storm and it is meant to be: the face's whole identity is that the sky
 * is trying to kill you, and a strike a minute reads as ordinary weather. Most
 * of them land a long way off — `Lightning.js` owns that split — so what this
 * number actually sets is how loud and how lit the face is, not how much it
 * hurts.
 */
const STRIKE_RATE = 0.30;

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
    /**
     * Seconds until a funnel may form. Starts at the full cooldown so a brand
     * new world cannot be met by one in its first storm — the first seven
     * minutes of a save are the ones with no shelter, no bed and no tools in
     * them.
     */
    this.tornadoCooldown = TORNADO_COOLDOWN;
    /**
     * On the storm face, where the sky is not weather any more.
     *
     * Written by `update` from the caller's face test rather than owned here,
     * for the same reason `cold` is: this class is a table and a lerp, and it
     * has never known where the player is standing.
     */
    this.tempest = false;
    /**
     * The sealed face's own sky, or null out in the world: 'storm' on
     * Tempest, 'clear' on Pyre.
     *
     * One field for two faces because they need exactly the same machinery -
     * hold the sky you interrupted, pin a state, never run the timer - and
     * differ only in which state they pin. `tempest` is kept beside it as the
     * narrower question `wantsStrike` and the lightning roll actually ask.
     */
    this._face = null;
    /** The sky the storm face interrupted, so leaving gives it back. */
    this._held = null;
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
  /**
   * @param {boolean} tempest is the player on the storm face? The whole of the
   *   permanent-storm override, and it is the same shape as the cinderlands'
   *   `skyTimeOfDay` in main.js: a face is a region with its own sky, so it
   *   overrides the global cycle rather than biasing it. Rime's whiteout and
   *   Pyre's eternal night are the precedent this follows.
   */
  /**
   * @param {boolean} dry is the player on the cinderlands? The same override
   *   pointed the other way, and the owner's question is the whole argument:
   *   *"why is it snowing/raining in pyre face? it shouldn't"*.
   *
   *   It could rain there because the weather cycle is global and Pyre was
   *   never excused from it, and it could SNOW there because `chill > 0.75` is
   *   a whole-planet clause — so for a quarter of every year the lava face had
   *   blizzards over it. Neither is a fact about the cinderlands; both are the
   *   ordinary world's sky drawn on a sealed face that has no season, no sea to
   *   evaporate and an eternal night of its own.
   *
   *   Pinned to `clear` rather than to a new dry state, because clear already
   *   means precip 0 and is the sky the face reads best under: coverage 0.62 is
   *   what lets the ash haze and the lava glow be the only things in it.
   */
  update(dt, biomeId, altitude, chill = 0, tempest = false, dry = false) {
    // A sealed face owns its own sky, and there are two of them now. They are
    // opposites and they share every line below: one pins the storm on, the
    // other pins all weather off.
    const face = tempest ? 'storm' : dry ? 'clear' : null;
    if (face !== this._face) {
      // Held and given back, rather than re-rolled on the way out. A portal is
      // instantaneous, so a player who steps out of the storm should find the
      // weather they left behind, not a fresh draw that happens to be a second
      // storm — or, worse, a clear noon that makes the face they just left look
      // like it was never really raining.
      if (face) { this._held = { state: this.state, timer: this.timer }; this.state = face; }
      else if (this._held) { this.state = this._held.state; this.timer = this._held.timer; this._held = null; }
      // Nothing held: the save was written on the storm face, so there is no
      // sky to give back and the world outside gets a fresh draw rather than
      // three minutes of a storm it never had.
      else this.timer = 0;
      this._face = face;
      this.tempest = tempest;
    }
    // Permanent means the clock never runs out, not that it is paused: the
    // timer is simply never consulted while the face holds the sky.
    if (this._face) {
      this.state = this._face;
      this.timer = STATES[this._face].dur[1];
    }

    this.timer -= dt;
    if (!this._face && this.timer <= 0) {
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
    //
    // Never on Tempest, and not because the arithmetic would come out wrong.
    // The face sits nine layers either side of the waterline, so the altitude
    // clause could not fire, but `chill > 0.75` is a whole-planet clause and
    // would turn the permanent storm into a permanent blizzard for a quarter of
    // every year. A sealed face does not have a season.
    this.cold = !this._face
      && (COLD_BIOMES.has(biomeId) || altitude > snowLine(chill) || chill > 0.75);
    this.type = this.cold ? 'snow' : 'rain';

    // lightning during storms
    //
    // The flash decays here wherever you are; what lights it does not. On
    // Tempest the strike system owns both the flash and the thunder, because it
    // knows where the bolt landed and this roll does not — see `wantsStrike`.
    this.lightning = Math.max(0, this.lightning - dt * 3.2);
    if (!this.tempest && this.state === 'storm' && this.precip > 0.6 && Math.random() < dt * 0.09) {
      this.lightning = 1;
      this.onThunder?.();
    }

    this.tornadoCooldown = Math.max(0, this.tornadoCooldown - dt);
  }

  /**
   * Should a funnel form this frame?
   *
   * The odds live here and the event lives in Tornado.js, which is the split the
   * head of that file argues for: whether a tornado exists at all is a fact
   * about the sky, and this table is what the sky is. The siting, the physics
   * and the biome gate are not — they need a planet, a player and a mob list,
   * none of which this class has ever heard of.
   *
   * The caller re-arms the cooldown, not this method, because siting can fail —
   * the ground 60 cells out may be ocean — and a roll that burns seven minutes
   * of cooldown on a funnel that never appeared is a bug the player cannot see.
   */
  wantsTornado(dt) {
    if (this.tornadoCooldown > 0) return false;
    if (this.precip <= TORNADO_PRECIP) return false;
    return Math.random() < dt * TORNADO_RATE;
  }

  /** Called once a funnel has actually been sited. */
  armedTornado() { this.tornadoCooldown = TORNADO_COOLDOWN; }

  /**
   * Should a bolt come down this frame?
   *
   * Exactly the split `wantsTornado` argues for, and for exactly the reason:
   * whether the sky strikes is a fact about the sky, while where it lands, what
   * it hits and how much that costs need a planet and a player this class has
   * never heard of. Those live in Lightning.js.
   *
   * The storm face only. An ordinary storm keeps the flash and the roll of
   * thunder it has always had and nothing lands out of it — a bolt that can hurt
   * you in weather that arrives unannounced anywhere in the world is a different
   * design, and not one that was asked for.
   */
  wantsStrike(dt) {
    if (!this.tempest) return false;
    return Math.random() < dt * STRIKE_RATE;
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

  /**
   * The tornado *cooldown* round-trips; a tornado in flight deliberately does
   * not. See the save note at the head of Tornado.js — reloading into the middle
   * of one is a death the player never saw coming, and reloading into the storm
   * that then produces one is not.
   *
   * `?? TORNADO_COOLDOWN` rather than `?? 0` on the way back in, so an old save
   * with no field lands on the same "not in the first seven minutes" footing a
   * new world does rather than being eligible the instant it loads.
   */
  toJSON() { return { state: this.state, timer: this.timer, tornado: this.tornadoCooldown }; }
  fromJSON(d) {
    if (!d) return;
    this.state = d.state || 'fair';
    this.timer = d.timer ?? 120;
    this.tornadoCooldown = d.tornado ?? TORNADO_COOLDOWN;
  }
}
