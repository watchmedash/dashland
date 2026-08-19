// A tornado: a funnel that crosses the landscape, throws whatever is standing
// in it, and strips the ground bare behind it.
//
// ---- why this is a module and not four methods on Weather --------------------
//
// Weather.js is a table of six numbers a state and a lerp toward them. It has no
// position, no planet, no player and no mobs, and every one of those is load
// bearing here: the funnel walks the surface, it shoves the player, it tumbles
// animals and it edits blocks. Explosion.js already settled this argument for
// the identical case and the shape is copied from it deliberately — take the
// `game` object, use its doors, and stay out of main.js.
//
// What DOES belong in Weather is the decision. Whether a tornado exists at all
// is a fact about the sky, and it is rolled there (`Weather.wantsTornado`)
// against `precip`, so a tornado can only ever grow out of weather the player
// has already watched arrive. This file owns the event; Weather owns the odds.
//
// ---- how often, and where ---------------------------------------------------
//
// One roll per second while `precip > 0.55`, at TORNADO_RATE 0.006, plus a hard
// TORNADO_COOLDOWN of 420s so two can never crowd, and never more than one at a
// time.
//
// Measured against the real table in Weather.js (400 000 state transitions
// simulated): `rain` and `storm` together occupy 11.45% of wall time and a wet
// spell starts every 27.4 minutes. 0.006 a second is therefore one tornado per
// ~24 minutes of play in eligible country. A player who spends half their time
// in forest, mountain, ocean or snow — all of which are refused below — sees one
// every 45 minutes or so. A session sees one or two. That is the band the brief
// asked for: often enough that it is a mechanic, rare enough that it is an
// event.
//
// Biome-gated, and this is one of the three structural answers to "what stops it
// flattening a base". A tornado forms over open, flat, warm ground: plains,
// meadow, savanna, desert, badlands. It refuses ocean (a waterspout is a
// different thing and would want water physics nobody has written), forest and
// pine forest (the funnel would be invisible inside a canopy, which fails the
// legibility test below), mountain, tundra and snow. Five of twelve biomes,
// which leaves seven the player can settle in and never see one.
//
// ---- what it destroys -------------------------------------------------------
//
// Anything with `0 <= hardness < SHRED_HARDNESS`, which is 0.35.
//
// That number was chosen by reading the block table rather than by taste. Every
// block on the planet under 0.35 is a plant: leaves at 0.25, driftwood at 0.30,
// aloe and truffle and mireroot at 0.20, and everything else — three flowers,
// tall grass, fern, clover, lavender, marram, saplings, mushrooms and all seven
// crops at all four growth rungs — at 0.05 to 0.15. Sixty-eight blocks, and the
// audit that produced that list found **not one placeable building material
// among them**. The first thing above the line is glass at 0.40; a torch is
// 0.40, snow 0.50, sand 0.50, dirt 0.60, planks and logs and stone 2.00 and up.
//
// So the rule is not "a tornado is weak", it is "a tornado takes what has roots
// and leaves what has walls". A funnel through a homestead strips the field, the
// flowerbed and the canopy of the shade tree, and does not scratch the house,
// the fence, the glass in the window or the torch on the wall.
//
// Submerged flora is exempt on top of that (`submerged: true` — kelp, sea grass,
// sea lettuce, sea grape). It is under the water, the funnel is not, and
// dredging a reef by walking a storm over it is not a mechanic anyone asked for.
//
// Measured end to end rather than argued: marched through mixed woodland for
// thirty seconds it cleared 550 cells of ten kinds, and the hardest thing it
// took was 0.25 —
//
//     leaves_pine 284   leaves_birch 80   leaves_oak 68
//     tall_grass   69   alpine_aster 28   clover     9
//     lingonberry   5   flower_red    3   golden_grass 2   swampreed 2
//
// Not one log, not one dirt, not one stone. Which is the answer to "what does it
// do to trees": it takes the canopy and leaves the trunk standing, and a
// stripped wood is a thing you can see happened. (The pine canopy shape and its
// leaf count both moved today under commit 6444f9f; nothing here reads the
// shape, only the hardness, so a thinner fir simply loses fewer cells.)
//
// ---- what stops it flattening an unattended base ----------------------------
//
// Three things, and none of them is a difficulty toggle:
//
//  1. **The hardness line above.** It cannot break a building material. Ever.
//  2. **It is armed on the player.** It spawns 45 to 75 cells from the player
//     and dies the moment it is more than LEASH 150 cells away. There is no
//     tornado anywhere the player is not, so a base the player has walked away
//     from is not somewhere a tornado can happen. (A bed in this game does not
//     skip the night — see `_useBed` in main.js — so "asleep in it" is not a
//     state that exists; "away from it" is, and this covers that.)
//  3. **Crops it takes, it hands back.** Every shredded cell rolls
//     `computeDrops`, so a wheat field is violently *harvested* rather than
//     deleted, and the player is by construction standing right there to pick it
//     up. Capped per tick so a long run through a meadow cannot flood the world
//     with entities — see SHRED_DROPS.
//
// ---- what it does to the player ---------------------------------------------
//
// It does no direct damage at all. Not one point. Every wound a tornado causes
// is a fall, which is a system that already exists and that the player already
// understands.
//
// Inside PULL_R 11 the horizontal shove is written straight into the player's
// knock channel — the same two fields a husk's blow uses — as a spiral: mostly
// tangential with SUCK 0.45 of inward, so you are carried *round* the funnel and
// only slowly drawn in. Strength ramps from nothing at PULL_R to full at CORE_R
// 3, so the outer band is a stagger and the middle is not survivable on your
// feet.
//
// Inside CORE_R you are lifted, at LIFT_RATE 8.5 layers/s — a shade above the
// 8.4 of a jump, so it reads as an updraft rather than a hop — **and the lift is
// hard-capped at LIFT_MAX 9 cells above the ground you were standing on when it
// took you.** That cap is the entire safety argument and it is arithmetic, not
// tuning:
//
//     fall damage = (drop - FALL_FREE) * FALL_PER_BLOCK = (9 - 3) * 1 = 6
//
// Measured, not asserted. Held in the core for twelve seconds and released, the
// player peaked at 8.92 cells above where they were taken from — LIFT_MAX, to
// within the frame the cut lands on — and the landing cost 2 on one run and 7 on
// another. The 7 is not the cap failing: the funnel had carried the player one
// cell downhill while it held them, and (8.92 + 1 - 3) = 6.92 rounds to 7. The
// number this file controls is the lift, and the lift is 9.
//
// **Worst case for an unarmoured player at full health: 6 of 20.** For scale, a
// yeti swings for 7 and kills a stationary unarmoured player in three blows;
// one full trip up a tornado costs less than one yeti swing. Standing in the
// core and being picked up over and over would take four such cycles to kill,
// at roughly four seconds each — and unlike a yeti you can simply leave, because
// the funnel travels at SPEED 3.2 cells/s against a 4.4 walk. Walking away from
// a tornado works. That is deliberate.
//
// The one thing the cap cannot bound is the terrain: thrown off a clifftop you
// fall as far as the cliff is high. That is true of every knockback in the game
// already and it is the player's business where they choose to stand.
//
// The knock is refreshed with knockT 0.24 rather than the full KNOCK_TIME 0.34.
// Player.update blends the knock over the steering by `knockT / KNOCK_TIME`, so
// topping it up at 0.34 every frame would *replace* the player's input entirely
// and the controls would go dead. 0.24 leaves 29% of your own steering, which is
// enough to lean toward the edge and get out, and nowhere near enough to stand
// still. And it is written directly rather than through `Player.knockback()`,
// which is not laziness: `knockback` pops you 0.9 upward off the ground to break
// friction for a single blow, and doing that every frame for twenty seconds is a
// player vibrating a few centimetres off the floor with ground friction
// permanently disabled.
//
// ---- what it does to mobs ---------------------------------------------------
//
// The same shove, through `Mobs.shove` — the knock channel and the tumble flag
// `hurt()` already sets, with no damage attached. A tornado does not kill a cow,
// it relocates one. Animals and monsters go through the identical door, because
// wind does not check whether a thing is hostile, and a husk being thrown out of
// the fight it was winning is the best thing about being caught in one.
//
// Fired at SHOVE_HZ 6 rather than every frame: the mob knock decays over 0.34s,
// so six a second keeps every body in the ring continuously airborne without
// walking the mob list sixty times a second for it.
//
// ---- legibility -------------------------------------------------------------
//
// A hazard has to be seen before it is felt. Six things, in the order the player
// meets them:
//
//   1. It only happens in rain or a storm, which are already dark, loud and
//      visibly approaching several minutes ahead.
//   2. `audio.squall(1)` on formation — the existing weather-front gust, the
//      same sound a storm's arrival already makes.
//   3. A toast that says `Tornado` and nothing else.
//   4. The funnel is FUNNEL_H 34 cells tall and drawn from the ground to the
//      cloud base, so it clears every hill on a plain and is visible from far
//      outside the distance it can reach.
//   5. It spawns no closer than SPAWN_MIN 45 cells. It can never appear on top
//      of you.
//   6. `weather.wind` is driven up while it is near, which the ambience bed and
//      `_updateAudio` already consume, so it roars louder as it closes. No new
//      audio code: the wiring for "the wind is up" has existed since the first
//      weather commit and this is what it was for.
//
// And SPINUP 6s at each end, over which strength ramps 0 -> 1 -> 0, so the first
// and last six seconds of its life are harmless. It cannot touch down at full
// force.
//
// ---- what it costs ----------------------------------------------------------
//
// Measured in the real game, paired against the idle median taken seconds
// earlier at the same spot on the same seed, funnel at full strength and filling
// the frame at 11.5 cells:
//
//     high tier   18.8 -> 19.1 ms   (+0.3, +1.6%)
//     low  tier   16.7 -> 16.6 ms   (nothing measurable)
//
// The terrain writing is not where the money goes. Timing the one door across a
// whole run: 56 calls, 594 cells, and `_applyEdits` costs 0.1ms at both the 50th
// and 90th percentile and 0.3ms at its worst. One batch a pass at 6 Hz is why.
//
// There is one 24ms spike and it is not this file's: the first `Drops.spawn` of
// any item kind builds a mesh, which measures 24.3ms against a 0.1ms median for
// every call after it. Mining a single flower pays exactly the same cost. A
// tornado meets several species in a hurry, so it is more likely than most
// things to trip several of them close together, which is what SHRED_DROPS
// bounds.
//
// ---- saves ------------------------------------------------------------------
//
// The terrain it changed persists, for free and correctly: every edit goes
// through `_applyEdits`, which marks the region edited, so a stripped field is
// in the partial save exactly like a mined tunnel.
//
// **The funnel itself deliberately does not resume.** A save records the weather
// state and its timer, and `Weather` now also records the tornado cooldown so
// the roll cannot be save-scummed — but not the funnel's position. A tornado in
// flight is a world position eleven cells from the player, and a player who
// quits, comes back and is killed by something that materialised during the
// loading screen has been cheated. Loading into a storm that then produces a new
// one is fine; loading into the middle of one is not. Whether that is right is a
// judgement call and it is written here so it can be reversed on purpose.

import * as THREE from 'three';
import { BLOCKS, ID } from '../world/Blocks.js';
import { computeDrops } from './Items.js';
import { stepColumn } from '../world/Layout.js';
import { wrap } from '../world/Grid.js';
import { wrapDist, relTo } from './Wrap.js';
import { D, BIOME, GRAVITY } from '../world/Constants.js';

/** Cells from the axis inside which you are lifted rather than merely dragged. */
const CORE_R = 3.0;
/** Cells from the axis inside which anything is pulled at all. */
const PULL_R = 11.0;
/** Cells from the axis inside which plants are torn out. */
const SHRED_R = 4.0;
/** Height of the drawn funnel, in cells. */
export const FUNNEL_H = 34;

/** How fast the funnel crosses the ground, in cells/s. A walk is 4.4. */
const SPEED = 3.2;
/** Seconds it takes to reach full strength, and to die away again. */
const SPINUP = 6;
/** Seconds a funnel lives, before the spin-up and spin-down at either end. */
const LIFE = [55, 95];
/** Cells from the player it may form. */
const SPAWN_MIN = 45, SPAWN_MAX = 75;
/** Cells from the player at which it gives up and dissipates. */
const LEASH = 150;

/** Hardness at or above which nothing moves. See the audit at the head. */
const SHRED_HARDNESS = 0.35;
/** Seconds between terrain passes. */
const SHRED_PERIOD = 1 / 6;
/**
 * Drop entities a single terrain pass may spawn.
 *
 * A rate limit and not a total, deliberately, because `Drops` already owns the
 * total: it caps the world at 260 and evicts ordinary litter before anything
 * from a death, so a tornado cannot flood the planet however long it runs. What
 * this bounds is the *spike* — without it a single pass through a meadow could
 * ask for forty drops at once, and the first spawn of any item kind builds a
 * mesh, which measured at 24.3ms against a 0.1ms median.
 *
 * Measured over a 30s run through mixed woodland: 550 cells taken, 66 drops.
 */
const SHRED_DROPS = 6;
/** Layers above and below the funnel's foot the shred reaches. */
const SHRED_UP = 8, SHRED_DOWN = 2;

/** Mob shoves a second. */
const SHOVE_HZ = 6;

/** How much of the spiral is inward rather than round. */
const SUCK = 0.45;
/** Cells/s the player is carried at, at full strength on the core edge. */
const PLAYER_FORCE = 11.0;
/** Layers/s of updraft in the core. A jump leaves the ground at 8.4. */
const LIFT_RATE = 8.5;
/**
 * Cells above the ground it took you from that you may end up. Caps the fall,
 * and is the whole of the damage argument: (9 - 3 free) * 1 = 6 of 20.
 */
const LIFT_MAX = 9;
/**
 * How far you keep going after the updraft lets go.
 *
 * Measured before it was derived. Cutting the lift at LIFT_MAX and walking away
 * put the player 10.3 cells up, not 9, and 10.3 rounds the fall to 7 damage
 * rather than 6 — level with a yeti swing instead of under one, which is exactly
 * the claim this file makes and would have been wrong.
 *
 * It is not a fudge factor: a body leaving at LIFT_RATE under GRAVITY coasts
 * v² / 2g = 8.5² / 52 = 1.39 cells, and 9 + 1.39 = 10.39 is the number that was
 * measured. Cutting the lift a coast early is what makes LIFT_MAX mean the
 * height you actually reach.
 */
const LIFT_COAST = (LIFT_RATE * LIFT_RATE) / (2 * GRAVITY);
/** Seconds of knock refreshed each frame. See the note at the head. */
const KNOCK_HOLD = 0.24;

/** `weather.wind` is driven to this at the funnel's foot. The table tops at 2.1. */
const WIND_PEAK = 3.4;

/** Biomes a funnel may form over. */
const SPAWN_BIOMES = new Set([
  BIOME.PLAINS, BIOME.MEADOW, BIOME.SAVANNA, BIOME.DESERT, BIOME.BADLANDS,
]);

const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _rad = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _foot = new THREE.Vector3();

/** The one up. Shared, never written to. */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Is this column's surface under water?
 *
 * The same question `siteTornado` asks of a candidate, spelled once so the walk
 * and the siting cannot drift apart about where the sea is. `surfaceK` answers
 * with the *bed* under water, which is exactly why the test has to be about the
 * cell above it rather than about the height: a funnel seated by height alone
 * stands on a sea floor fifteen cells under the surface, drawn from a point
 * nobody can see, still shoving and lifting whoever is swimming over it.
 */
function afloat(planet, col) {
  const k = planet.surfaceK(col);
  return k < 0 || planet.liquidAt(col, k + 1);
}

/**
 * Roll for, and site, a new funnel.
 *
 * Separate from the constructor because siting can fail — the ground under the
 * candidate point may be the wrong biome, or under water, or off the end of a
 * face — and a constructor that sometimes produces nothing is worse than a
 * function that returns null.
 *
 * @returns {Tornado|null}
 */
export function siteTornado(game) {
  const planet = game.planet;
  const p = game.player;
  if (!p) return null;
  // Four attempts, then give up and let the next second's roll try again. A
  // retry loop that insists is how a tornado ends up in the one eligible cell of
  // a coastline; four samples of a random bearing either finds open country
  // nearby or correctly concludes there is none.
  for (let n = 0; n < 4; n++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
    // One gravity, so a bearing is just an angle in the world's own XZ plane
    // and the player's tangent frame - which no longer exists - is not needed
    // to build one. Wrapped, because a funnel sited a hundred cells east of a
    // player near the map's edge is sited on the other side of the wrap.
    _a.set(wrap(p.position.x + Math.cos(ang) * dist), p.position.y,
      wrap(p.position.z + Math.sin(ang) * dist));
    const at = planet.cellAt(_a.x, _a.y, _a.z);
    if (!at) continue;
    const k = planet.surfaceK(at.col);
    if (k < 0) continue;
    const biome = planet.colBiome[at.col];
    if (!SPAWN_BIOMES.has(biome)) continue;
    // Not out of the sea. `surfaceK` returns the *bed* under water, so this is
    // the one test that stops a funnel forming on a lake floor.
    if (planet.liquidAt(at.col, k + 1)) continue;
    return new Tornado(game, at.col, k + 1);
  }
  return null;
}

export class Tornado {
  /**
   * @param {object} game  needs `planet`, `player`, `mobs`, `drops`, `particles`,
   *                       `audio`, `ui`, `weather` and `_applyEdits`
   * @param {number} col   column the foot stands in
   * @param {number} k     layer the foot stands on
   */
  constructor(game, col, k) {
    this.game = game;
    this.col = col;
    this.k = k;
    this.pos = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.age = 0;
    this.life = LIFE[0] + Math.random() * (LIFE[1] - LIFE[0]);
    this.strength = 0;
    /** Countdown to the next re-fire of the roar bed; see `update`. */
    this._roarT = 0;
    this.dead = false;
    /** Radius the player's feet were at when the core first took them. */
    this._heldFrom = 0;
    this._held = false;
    this._shredT = 0;
    this._shoveT = 0;
    /** Bearing, in the funnel's own tangent frame, and how fast it wanders. */
    this._bearing = Math.random() * Math.PI * 2;
    this._turn = (Math.random() - 0.5) * 0.16;
    this._seat();
    /** For the harness: worst frame cost of a terrain pass, and cells taken. */
    this.stats = { cells: 0, drops: 0, worstMs: 0, totalMs: 0, passes: 0 };
  }

  /**
   * Put the foot back on the ground under `this.col`.
   *
   * `surfaceK` is the topmost non-liquid block, which under a tree is the
   * *canopy* — its own docstring says so, and it has caused shipped bugs twice
   * already. A funnel seated on a canopy stands eight cells in the air with its
   * shredding radius centred on the leaves it is meant to be stripping from
   * below. So walk down past anything the funnel itself would tear out (the same
   * SHRED_HARDNESS line, which is exactly the set of blocks that are "standing on
   * the ground" rather than "being the ground") and seat on what is left.
   *
   * Bounded at 12, which is taller than any canopy the generator makes and stops
   * this becoming a scan down the whole column over a deep bank of vines.
   *
   * **It seats the radius and leaves the bearing alone**, and that is the whole
   * of the travel bug. This used to copy `centerOf(col, k)` straight over
   * `this.pos`, i.e. round the foot to the middle of its own cell on every
   * frame it ran — and it runs every frame, out of `_travel`. A frame's walk at
   * SPEED 3.2 is 3.2/60 = 0.053 cells, which never leaves the column it started
   * in, so `cellAt` handed back the same column and this then threw the step
   * away. The funnel could only ever move on a frame long enough to cross half
   * a cell in one go, which is about 6fps.
   *
   * Measured on the shipped code before this, seed 4242, a funnel sited in
   * plains and watched from a standing start: **45.4 seconds at full strength,
   * 0.00 cells of track, one column visited**, against the 145 those seconds
   * are worth. Everything the head of this file says about a funnel that
   * crosses the landscape — the wandering track, the stripped wood you can see
   * happened, "walking away from a tornado works" because it travels at 3.2
   * against a walk of 4.4 — was describing something that stood still and
   * chewed a four-cell disc for a minute and a half.
   */
  _seat() {
    const planet = this.game.planet;
    let k = planet.surfaceK(this.col);
    for (let n = 0; n < 12 && k > 0; n++) {
      const b = BLOCKS[planet.at(this.col, k)];
      if (!b || b.hardness < 0 || b.hardness >= SHRED_HARDNESS) break;
      k--;
    }
    if (k >= 0) this.k = k + 1;
    planet.centerOf(this.col, this.k, _foot);
    // The first seat has no bearing to keep: the constructor hands us a column
    // and nothing else.
    if (this.pos.lengthSq() < 1e-6) this.pos.copy(_foot);
    // Height only, so the track the funnel has walked is kept. Half a cell down,
    // so the visible funnel meets the ground rather than hovering over it. The
    // cube did this as a length and a normalize, i.e. as a radius, which is the
    // one shape of arithmetic that has no meaning on a flat map.
    this.pos.y = _foot.y - 0.5;
    this.up.copy(UP);
  }

  /**
   * @returns {boolean} still alive
   */
  update(dt) {
    if (this.dead) return false;
    this.age += dt;
    const total = this.life + SPINUP * 2;
    if (this.age >= total) { this.dead = true; return false; }
    // 0 -> 1 over SPINUP, hold, 1 -> 0 over SPINUP. Smoothstepped at both ends
    // so touchdown is a swell rather than a switch.
    const inT = Math.min(1, this.age / SPINUP);
    const outT = Math.min(1, (total - this.age) / SPINUP);
    const raw = Math.min(inT, outT);
    this.strength = raw * raw * (3 - 2 * raw);

    this._travel(dt);

    const p = this.game.player;
    if (p) {
      const far = wrapDist(p.position, this.pos);
      if (far > LEASH) { this.dead = true; return false; }
      this._pullPlayer(dt, p);
      // The ambience bed and `_updateAudio` both read `weather.wind` already, so
      // the roar is free. Overwritten every frame after Weather has eased its
      // own value, which is why this can simply assign rather than accumulate.
      const w = this.game.weather;
      if (w) {
        const near = 1 - Math.min(1, far / 60);
        w.wind = Math.max(w.wind, w.wind + (WIND_PEAK - w.wind) * near * this.strength);
      }

      // The funnel's own roar. Until now the whole event had exactly one sound
      // in it, the `squall` gust on formation, and then a mile-wide column of
      // air crossed the map in silence. `Audio.tornado` is built like `churn`,
      // as a condition rather than an event, so it is re-fired on a timer and
      // approach makes it LOUDER rather than more frequent. The period is
      // shorter than the voice's own 2.4-3.2s length so the beds overlap and
      // the roar never gaps.
      this._roarT -= dt;
      if (this._roarT <= 0 && this.strength > 0.04) {
        this._roarT = 1.7 + Math.random() * 0.5;
        this.game.audio?.tornado(
          Math.min(1, (1 - Math.min(1, far / 90)) * this.strength), this.pos);
      }
    }

    this._shredT += dt;
    if (this._shredT >= SHRED_PERIOD) { this._shredT = 0; this._shred(); }

    this._shoveT += dt;
    if (this._shoveT >= 1 / SHOVE_HZ) {
      this._shoveT = 0;
      this.game.mobs?.shove(this.pos, this.up, PULL_R, CORE_R, this.strength);
    }

    this.game.particles?.tornado(this.pos, this.up, this.strength);
    return true;
  }

  /**
   * Walk the foot across the ground.
   *
   * The bearing wanders rather than holding a straight line, because a funnel
   * that tracks dead straight is a thing the player solves once — step sideways
   * and never think about it again. `_turn` is re-rolled slowly so the track
   * curves without ever doubling back into ground it has already stripped.
   */
  _travel(dt) {
    this._bearing += this._turn * dt;
    if (Math.random() < dt * 0.12) this._turn = (Math.random() - 0.5) * 0.16;
    const planet = this.game.planet;
    // The ground is a plane and up is +Y, so the bearing is an angle in XZ and
    // the three cross products that used to build a tangent basis out of it are
    // gone. Moving in world space rather than on the grid is kept, because the
    // step is a twentieth of a cell and has to accumulate.
    _dir.set(Math.cos(this._bearing), 0, Math.sin(this._bearing));
    // Advance the foot itself, not a scratch point beside it. A frame's step is
    // a twentieth of a cell and has to be able to accumulate across frames until
    // it is worth a column; stepping a copy and asking which column it landed in
    // asks the same question sixty times and gets the same answer. `_seat` keeps
    // the bearing this builds up — see the note there.
    const step = SPEED * dt * this.strength;
    this.pos.addScaledVector(_dir, step);
    this.pos.x = wrap(this.pos.x); this.pos.z = wrap(this.pos.z);
    const at = planet.cellAt(this.pos.x, this.pos.y, this.pos.z);
    if (at && at.col !== this.col) {
      if (afloat(planet, at.col)) {
        // Not out to sea. `siteTornado` refuses a column whose surface is under
        // water and the head of this file says why — a waterspout is a different
        // thing and would want water physics nobody has written — but the walk
        // never re-asked, because until the step above worked there was no walk.
        // A funnel that reaches the shore turns and follows it.
        //
        // The step is taken back rather than merely not adopted: the position is
        // what the next frame walks from, so leaving it out over the water would
        // let the foot drift off its column indefinitely while `col` stayed on
        // the beach, and the drawn funnel would slide away from the ground it is
        // standing on.
        this.pos.addScaledVector(_dir, -step);
        this.pos.x = wrap(this.pos.x); this.pos.z = wrap(this.pos.z);
        this._bearing += Math.PI * (0.5 + Math.random() * 0.5);
        this._turn = (Math.random() - 0.5) * 0.16;
      } else this.col = at.col;
    }
    this._seat();
  }

  /**
   * The spiral, written into the player's knock channel.
   *
   * See the long note at the head of the file for why this does not call
   * `Player.knockback` and why `knockT` is held short of KNOCK_TIME.
   */
  _pullPlayer(dt, p) {
    // Distance from the AXIS, not from the foot: the funnel is a line, and a
    // player standing eight cells up a hillside beside it is eight cells away
    // horizontally whatever their altitude.
    relTo(_a, this.pos, p.position);
    const h = _a.dot(this.up);
    if (h < -3 || h > FUNNEL_H) { this._held = false; return; }
    _rad.copy(_a).addScaledVector(this.up, -h);
    const d = _rad.length();
    if (d > PULL_R) { this._held = false; return; }
    if (d > 1e-4) _rad.multiplyScalar(1 / d); else _rad.set(1, 0, 0);
    // Round the axis, plus a little inward. Cross order gives the same hand of
    // spin every time, which matters: a tornado that span one way on Tuesday and
    // the other on Wednesday would teach the player nothing.
    _tan.copy(this.up).cross(_rad).normalize();
    _dir.copy(_tan).addScaledVector(_rad, -SUCK).normalize();

    // Full at the core edge, nothing at the outer edge, squared so the outer
    // band is a nudge and the middle is not negotiable.
    const t = Math.max(0, Math.min(1, (PULL_R - d) / (PULL_R - CORE_R)));
    const mag = PLAYER_FORCE * t * t * this.strength;
    if (mag < 0.4) { this._held = false; return; }

    // Straight into the player's knock channel, which is world X and Z. The
    // cube had to rotate this into the body's own tangent frame first; there is
    // one frame now and it is the world's.
    p.knockX = _dir.x * mag;
    p.knockZ = _dir.z * mag;
    p.knockT = KNOCK_HOLD;

    // The lift, and its cap. `_heldFrom` is recorded on the frame the core first
    // takes you and is the ground you will be measured against when you land.
    if (d < CORE_R && this.strength > 0.3) {
      // Height, not a radius. `position.length()` was the distance from the
      // planet's centre and there is no centre; the lift cap is measured in
      // layers off the world's one up axis.
      const r = p.position.y;
      if (!this._held) { this._held = true; this._heldFrom = r; }
      if (r < this._heldFrom + LIFT_MAX - LIFT_COAST) {
        p.vel.y = Math.max(p.vel.y, LIFT_RATE * this.strength);
        p.grounded = false;
      }
    } else {
      this._held = false;
    }
  }

  /**
   * Tear out everything with roots inside the funnel.
   *
   * The column sweep is copied from `Explosion.explode` and, as there, it is a
   * plain square of columns now: `stepColumn` wraps, the map has no seam to fold
   * through, and the offsets cannot collide, so there is nothing left to dedupe
   * or to extend a face's own coordinates for.
   */
  _shred() {
    if (this.strength < 0.25) return;
    const t0 = performance.now();
    const planet = this.game.planet;
    const edits = [];
    const spoil = [];
    const N = Math.ceil(SHRED_R);
    for (let di = -N; di <= N; di++) {
      for (let dj = -N; dj <= N; dj++) {
        const col = stepColumn(this.col, di, dj);
        for (let dk = -SHRED_DOWN; dk <= SHRED_UP; dk++) {
          const k = this.k + dk;
          if (k < 0 || k >= D) continue;
          const id = planet.at(col, k);
          if (!id || id === ID.core) continue;
          const b = BLOCKS[id];
          // Liquids (`hardness < 0`) and the reef. See the head of the file.
          if (!b || b.hardness < 0 || b.hardness >= SHRED_HARDNESS) continue;
          if (b.submerged) continue;
          planet.centerOf(col, k, _c);
          relTo(_a, this.pos, _c);
          const hh = _a.dot(this.up);
          if (hh < -SHRED_DOWN || hh > SHRED_UP + 2) continue;
          _rad.copy(_a).addScaledVector(this.up, -hh);
          if (_rad.length() > SHRED_R * this.strength) continue;
          edits.push({ col, k, id: 0 });
          if (spoil.length < SHRED_DROPS) spoil.push({ col, k, id });
        }
      }
    }
    if (!edits.length) return;

    // The one door. Marks the region edited so the stripped field is in the
    // partial save, tells the worker so the mirror and the mesh agree, patches
    // occlusion, and runs the crush / unsupported / gravity passes — so a
    // saplings-and-flowers pass that undercuts nothing costs nothing extra, and
    // a shredded stalk under a stacked crop takes the rest of it with it.
    //
    // One call for the whole pass. See the same note in Explosion.js.
    this.game._applyEdits(edits);

    let dropped = 0;
    for (const s of spoil) {
      planet.centerOf(s.col, s.k, _c);
      for (const dr of computeDrops(s.id)) {
        this.game.drops?.spawn(_c.x, _c.y, _c.z, dr.item, dr.count);
        dropped++;
      }
    }

    const ms = performance.now() - t0;
    this.stats.cells += edits.length;
    this.stats.drops += dropped;
    this.stats.passes++;
    this.stats.totalMs += ms;
    if (ms > this.stats.worstMs) this.stats.worstMs = ms;
  }
}
