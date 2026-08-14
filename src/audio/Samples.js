// The one asset path in the audio engine.
//
// Everything else under src/audio is synthesised, and that is deliberate: a
// sound played hundreds of times a session (footsteps, mining, mob voices)
// needs continuous per-play randomisation, which a handful of samples cannot
// give without machine-gunning. Samples are here only for the opposite case —
// sounds where character matters and the repeat rate is low enough that a
// recording's fixed detail is an asset rather than a tell.
//
// Three rules this module exists to enforce:
//
// 1. Nothing waits for it. `load()` is fired and forgotten; world generation
//    already costs 8.5-11s and audio must not add to it. Every consumer keeps
//    its procedural implementation and only swaps over if and when a buffer
//    actually turns up.
// 2. Failure is silent and total. A 404, a decode error, an offline start, a
//    browser without Ogg Opus — all resolve to null, and the game sounds
//    exactly as it did before this module existed. Never throw into a caller.
// 3. A suspended context is normal, not an error. An AudioContext built before
//    the first user gesture reports 'suspended', and the tab-hide path suspends
//    it again. `decodeAudioData` does not care — it is a pure decode and does
//    not touch the context clock — so loading proceeds regardless. It is the
//    playback side that gates on `_live()`, and it already did.
//
// Paths are relative with no leading slash, matching TileAtlas. `base: './'` in
// vite.config.js is load-bearing: GitHub Pages serves this under /dashland/ and
// the Steam / Microsoft Store wrappers load off the filesystem, so an absolute
// '/audio/...' would 404 in both.

const BASE = 'audio';

/** Files and the reason each one earns its bytes. Sizes are the shipped Opus. */
export const SAMPLES = {
  // 6.0s seamless loop, crossfaded. Replaces the rainHiss/rainBody noise beds.
  rain: 'rain_loop.ogg',
  // 12.0s seamless loop. Replaces the surf noise bed.
  surf: 'surf_loop.ogg',
  // 2.7s. Layered ON TOP of the procedural rumble, not a replacement for it.
  thunderCrack: 'thunder_crack.ogg',

  // 6.0s seamless loop. Replaces NOTHING: there was no continuous fire sound in
  // the game at all, so a torch, a lit kiln and a lava lake were silent. Serves
  // both placed fire beds — the lava one is this same buffer at rate 0.48
  // through a lowpass, which is why there is no second file for it.
  fire: 'fire_loop.ogg',
  // 6.0s seamless loops. Replace the `cricket` and `cicada` noise beds.
  crickets: 'crickets_loop.ogg',
  cicada: 'cicada_loop.ogg',

  // Monster voices, layered ON TOP of the synthesised ones. Each is played at a
  // different rate per species, so one buffer is several animals; see
  // MOB_SAMPLE in Audio.js for which species reads which and at what rate.
  shriekBug: 'shriek_bug.ogg',
  wailGhost: 'wail_ghost.ogg',
  gurgleDeep: 'gurgle_deep.ogg',
  exhaleHusk: 'exhale_husk.ogg',
  // Swapped in for the layer above when the voice is a hurt or a death.
  yellPain: 'yell_pain.ogg',

  // Impacts, all layered rather than substituted. `swingAir` is the odd one:
  // it layers under a MISS rather than over a hit, and it is the only recording
  // in here that supplies the body while the synth supplies the texture.
  swingAir: 'swing_air.ogg',
  hitFlesh: 'hit_flesh.ogg',
  punch: 'punch.ogg',
  arrowHit: 'arrow_hit.ogg',
  blastCrack: 'blast_crack.ogg',
};

/**
 * Load order, loudest-gap-first.
 *
 * `loadAll` is sequential (see below) so this list is a priority order, and it
 * is not the order the object literal happens to be in. The two weather beds
 * come first because a storm is the loudest thing in the game and the one a
 * player is most likely to be standing in during the first minute; fire is
 * third because it is the only entry here that replaces silence rather than a
 * synthesised stand-in, so until it lands there is nothing at all.
 */
export const LOAD_ORDER = [
  'rain', 'surf', 'fire', 'thunderCrack',
  'shriekBug', 'wailGhost', 'gurgleDeep', 'exhaleHusk', 'yellPain',
  'swingAir', 'hitFlesh', 'punch', 'arrowHit', 'blastCrack',
  'crickets', 'cicada',
];

export class Samples {
  constructor(ctx) {
    this.ctx = ctx;
    /** name -> AudioBuffer, only once decoded. Absent means "still procedural". */
    this.buf = {};
    this.stats = { requested: 0, ready: 0, failed: 0, bytes: 0, ms: 0 };
    this._pending = {};
  }

  /** True once `name` is decoded and safe to build a source from. */
  has(name) { return !!this.buf[name]; }
  get(name) { return this.buf[name] || null; }

  /**
   * Fetch and decode one file. Idempotent, and never rejects.
   *
   * `decodeAudioData` is promise-form here; the callback form is the only one
   * old Safari has, so both are wired. Either way a failure lands in the same
   * place: `failed`, no buffer, and the procedural path keeps running.
   */
  load(name, file = SAMPLES[name]) {
    if (!file || !this.ctx) return Promise.resolve(null);
    if (this.buf[name]) return Promise.resolve(this.buf[name]);
    if (this._pending[name]) return this._pending[name];
    this.stats.requested++;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const p = fetch(`${BASE}/${file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${file}: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => {
        this.stats.bytes += ab.byteLength;
        return new Promise((res, rej) => {
          // Chrome/Firefox/Safari 15+ return a promise; older Safari does not
          // and returns undefined, in which case the callbacks are the only
          // thing that ever fires.
          const maybe = this.ctx.decodeAudioData(ab, res, rej);
          if (maybe && typeof maybe.then === 'function') maybe.then(res, rej);
        });
      })
      .then((b) => {
        this.buf[name] = b;
        this.stats.ready++;
        this.stats.ms = Math.max(this.stats.ms,
          (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        return b;
      })
      .catch(() => {
        // Deliberately swallowed. There is nothing a player can do about it and
        // the fallback is the sound they would have had anyway.
        this.stats.failed++;
        return null;
      })
      .finally(() => { delete this._pending[name]; });

    this._pending[name] = p;
    return p;
  }

  /**
   * Start every sample. Returns a promise only so a test can await it; the game
   * ignores it on purpose.
   *
   * Sequential rather than parallel: on a slow connection three concurrent
   * fetches compete with the chunk meshes and the tile atlas, which are what
   * the player is actually waiting to see. In series these ride along in the
   * gaps and the last one lands late with no consequence, because every
   * consumer is still making the procedural sound until it does.
   */
  async loadAll(names = LOAD_ORDER, onReady = null) {
    for (const n of names) {
      const b = await this.load(n);
      // Per file, not once at the end. The list is fifteen entries long and
      // strictly sequential, so waiting for the last one would hold the rain
      // bed hostage to a monster growl that nothing is waiting for.
      if (b && onReady) { try { onReady(n, b); } catch { /* never a caller's problem */ } }
    }
    return this.stats;
  }
}
