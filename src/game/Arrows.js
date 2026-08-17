// Arrows in flight: the only thing on this planet that travels under its own
// momentum rather than being carried.
//
// It is deliberately built on `Drops.js` rather than beside it, because a drop
// already solved the one part of this that is easy to get wrong and hard to
// see: gravity on a sphere. "Down" is not -Y anywhere except directly over the
// north pole. Every step here derives the local up as `normalize(pos - centre)`
// and pulls the arrow along its negative, exactly as `Drops.update` does — which
// is why an arrow loosed on the far side of the world arcs the same way as one
// loosed at the spawn, and why the tests in `scripts/`-adjacent harnesses can
// fire from all six cube faces and assert the same fall.
//
// What it does *not* borrow from drops is the collision. A drop moves a few
// hundredths of a cell a frame and can afford to test its destination and stop;
// an arrow at full draw covers a whole cell per frame at 60fps and four at
// 15fps, so testing only the endpoint shoots straight through walls. The step is
// therefore marched in sub-cell increments, and the mob test is the segment, not
// the point — see `update`.

import * as THREE from 'three';
import { GRAVITY } from '../world/Constants.js';
import { wrap } from '../world/Grid.js';
import { wrapDist } from './Wrap.js';
import { ID } from '../world/Blocks.js';
import { hasModel, worldModel } from '../render/ItemModels.js';

/**
 * How much of the world's gravity an arrow feels.
 *
 * Half, and not because an arrow is light. Full gravity against the muzzle
 * speeds in `Items.js` gives an arc a player cannot lead: at 64 cells/s a shot
 * forty cells out drops nearly six cells, which is a mob's whole body twice
 * over, and every miss reads as the bow being broken rather than as the shot
 * being short. Halved, that same shot drops 2.9 cells — enough that range is
 * something you aim off for, little enough that point-and-click works inside
 * about twenty cells. This is a feel constant and is written down as one.
 */
const ARROW_G = 0.5;

/** Air drag, per second. Small: it exists so a stray shot dies rather than orbits. */
const DRAG = 0.06;
/** Water drag, per second. An arrow entering a lake stops being a threat. */
const WATER_DRAG = 6.0;

/** Seconds an arrow may stay in the air, and seconds it stays stuck once landed. */
const MAX_FLIGHT = 12;
const STUCK_LIFE = 30;

/**
 * The longest step, in cells, that is tested as a single point.
 *
 * A cell is ~1 unit, so anything under 1 catches a one-block wall; 0.35 also
 * catches a slab-thin ledge taken at a shallow angle. The cost is bounded — a
 * full-draw arrow at a 60fps frame is three probes — and it is the difference
 * between a projectile and a teleport.
 */
const SUBSTEP = 0.35;

/** How many arrows may exist at once. The oldest goes when the cap is reached. */
const MAX = 48;

/**
 * How close you have to be to a stuck arrow to pull it out, in cells, and how
 * long it must have been there before you can.
 *
 * Stuck arrows used to be gone for good, which was a deliberate call and the
 * player disagreed with it: in Minecraft you walk your shots back, and a bow
 * whose ammunition is strictly consumed is a bow you stop using. The radius is
 * `Drops.PICKUP_RADIUS` minus a little — 1.85 there starts a *magnet*, and a
 * drop then flies the rest of the way, where an arrow buried in a wall visibly
 * stays where it is, so its radius has to be the whole of the reach rather than
 * the beginning of one.
 *
 * The delay exists because the common shot is at something a few cells away, and
 * without it an arrow that sticks in the block by your feet is collected on the
 * frame it lands — the shot reads as never having been fired. A third of a
 * second is under the time it takes to look at where it went. `Drops` has the
 * same guard at 0.45 and for the same reason.
 */
const PICKUP_RADIUS = 1.5;
const PICKUP_DELAY = 0.33;

const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class Arrows {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/Planet.js').Planet} planet
   * @param {number} itemId the arrow item, for its model
   */
  constructor(scene, planet, itemId) {
    this.planet = planet;
    this.item = itemId;
    /** @type {Array<object>} */
    this.list = [];

    this.group = new THREE.Group();
    this.group.name = 'arrows';
    scene?.add(this.group);

    /**
     * Hits waiting to be paid out, drained after the flight loop.
     *
     * This is `Mobs._kills` discipline and it is here for the same reason: what
     * `hurt()` does on the far side of a killing blow is spill drops, play a
     * death clip and — for a species with no clip — splice the mob out of a list
     * this loop's `raycast` is walking. Collecting the hits and applying them
     * once the loop is over means no callee can mutate anything a live cursor is
     * pointing at, and it makes "did the arrow connect?" a value a test can read
     * without a mob system present at all.
     * @type {Array<{mob:object, damage:number, from:THREE.Vector3, power:number}>}
     */
    this._hits = [];

    /** Told when an arrow lands on a mob, so main can play the sound. */
    this.onHit = null;
    /** Told when an arrow sticks in the ground, with the world point. */
    this.onStick = null;
  }

  /**
   * Loose one.
   *
   * @param {THREE.Vector3} pos muzzle point — the eye, pushed out a little so
   *   the first substep is not already inside the player's own head.
   * @param {THREE.Vector3} dir unit aim direction
   * @param {number} speed cells/s
   * @param {number} damage health units at the moment of impact
   * @param {number} power 0..1, carried so the knockback can scale with the draw
   * @returns {object} the arrow record, so a caller (or a test) can watch it
   */
  spawn(pos, dir, speed, damage, power = 1) {
    if (this.list.length >= MAX) this._remove(0);
    const a = {
      pos: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      from: pos.clone(),
      damage, power,
      age: 0,
      stuck: false,
      mesh: null,
    };
    this.list.push(a);
    this._attach(a);
    return a;
  }

  /**
   * Give an arrow something to draw itself with.
   *
   * The model loads over the network, so the first arrow anyone fires is very
   * likely to be in the air before its GLTF lands. It flies with a stand-in
   * sliver until then and trades up when the real thing arrives, which is the
   * trick `Drops._upgrade` uses and for the same reason: this runs from the
   * frame loop and must never wait.
   */
  _attach(a) {
    const model = hasModel(this.item) ? worldModel(this.item, (m) => {
      if (!this.list.includes(a)) return;
      this.group.remove(a.mesh);
      a.mesh = m;
      this.group.add(m);
    }) : null;
    a.mesh = model || new THREE.Mesh(stubGeo(), stubMat());
    this.group.add(a.mesh);
  }

  _remove(i) {
    const a = this.list[i];
    if (!a) return;
    this.group.remove(a.mesh);
    this.list.splice(i, 1);
  }

  clear() {
    for (const a of this.list) this.group.remove(a.mesh);
    this.list.length = 0;
    this._hits.length = 0;
  }

  /**
   * One frame of flight for every arrow, then the hits.
   *
   * @param {number} dt
   * @param {{raycast:Function, hurt:Function}} [mobs] optional, so the flight
   *   half of this can be exercised with nothing else in the world
   * @param {{position:THREE.Vector3}} [player] who might walk into a stuck one
   * @param {{collect:Function, hasRoom:Function}} [io] the *same* pair `Drops`
   *   takes, deliberately: `collect(item, count, wear) -> taken` and
   *   `hasRoom(item) -> boolean`. Passing the identical contract means an arrow
   *   goes into the bag through the one door every other pickup in the game
   *   uses — same stacking rules, same full-inventory answer, same sound and
   *   toast — rather than through a second one that would drift from it. Both
   *   this and `player` are optional and the whole feature is simply absent when
   *   either is missing, which is what lets the flight be tested on its own.
   */
  update(dt, mobs = null, player = null, io = null) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const a = this.list[i];
      a.age += dt;
      if (a.stuck) {
        if (a.age > STUCK_LIFE) this._remove(i);
        else this._collect(a, i, player, io);
        continue;
      }
      if (a.age > MAX_FLIGHT) { this._remove(i); continue; }

      this.step(a, dt, mobs);
      // Burnt up in lava: gone, and not collectable. Checked before the pose,
      // since there is nothing left to point anywhere.
      if (a.burnt) { this._remove(i); continue; }
      if (!a.stuck && !a.hitMob) this._pose(a);
      if (a.hitMob) this._remove(i);
    }

    // Drained, never applied inside the loop above. See `_hits`.
    if (this._hits.length) {
      for (const h of this._hits) {
        if (!mobs || h.mob.health <= 0) continue;
        // Whether this arrow was the last one, passed on. An arrow is the game's
        // *second* way to kill something and the melee path in main.js is where
        // the mark and the xp are awarded from — so without this a player who
        // fights entirely with a bow earns nothing for any of it.
        const killed = mobs.hurt(h.mob, h.damage, h.from, h.power);
        this.onHit?.(h.mob, h.damage, killed);
      }
      this._hits.length = 0;
    }
  }

  /**
   * Walk one back out of the ground.
   *
   * Returns true when the arrow left the list, so the caller knows its index is
   * now somebody else's — the same contract `_remove` implies everywhere else in
   * this file.
   *
   * The order of the two guards is not arbitrary. `hasRoom` is asked *before*
   * `collect`, exactly as `Drops.update` asks it, because `collect` is allowed
   * to take a partial stack and an arrow is one item: without the check, a full
   * bag would have `collect` return 0 every frame you stood near a shot, which
   * is harmless but means the game asks the inventory a question it already
   * knows the answer to sixty times a second for as long as you loiter. With it,
   * a full inventory leaves the arrow lying there — visibly still yours to come
   * back for — which is the behaviour the ground already has for everything else.
   *
   * And the pickup is only ever offered to a *stuck* arrow (the caller's branch
   * guarantees it): one in flight is travelling at up to 64 cells a second and
   * would be collected by anyone who happened to be standing along the shot,
   * including the archer at point-blank range.
   */
  _collect(a, i, player, io) {
    if (!player || !io) return false;
    if (a.age < PICKUP_DELAY) return false;
    if (wrapDist(a.pos, player.position) > PICKUP_RADIUS) return false;
    if (!io.hasRoom(this.item)) return false;
    if (!(io.collect(this.item, 1) > 0)) return false;
    this._remove(i);
    return true;
  }

  /**
   * Advance one arrow by `dt`, marching the step in sub-cell probes.
   *
   * Split out of `update` because it is the whole of the physics and the whole
   * of what a test wants to call: give it a position, a velocity and a planet,
   * and it answers with where the arrow is next and whether it stopped. Nothing
   * in here touches the scene graph or the mob list beyond a raycast.
   */
  step(a, dt, mobs = null) {
    // Up is +Y and it is +Y everywhere, so there is no local up to compute and
    // no radial to take from a centre. What used to be a normalize per step is
    // one subtraction on one component.
    const cell = this.planet.cellAt?.(a.pos.x, a.pos.y, a.pos.z);
    const here = cell ? this.planet.at(cell.col, cell.k) : 0;
    const wet = here === ID.water;

    a.vel.y -= GRAVITY * ARROW_G * dt;
    a.vel.multiplyScalar(Math.max(0, 1 - (wet ? WATER_DRAG : DRAG) * dt));

    _step.copy(a.vel).multiplyScalar(dt);
    const len = _step.length();
    if (len < 1e-6) return;
    _dir.copy(_step).multiplyScalar(1 / len);

    // The creature test is the whole segment, once, rather than one test per
    // probe: `Mobs.raycast` already answers "nearest body along this ray within
    // this distance", which is exactly the question, and asking it per substep
    // would be the same answer three times.
    if (mobs) {
      const hit = mobs.raycast(a.pos, _dir, len);
      if (hit && hit.mob.health > 0 && !(hit.mob.dying > 0)) {
        a.pos.addScaledVector(_dir, hit.dist);
        a.hitMob = hit.mob;
        this._hits.push({ mob: hit.mob, damage: a.damage, from: a.from, power: a.power });
        return;
      }
    }

    const steps = Math.max(1, Math.ceil(len / SUBSTEP));
    const inc = len / steps;
    for (let s = 0; s < steps; s++) {
      _probe.copy(a.pos).addScaledVector(_dir, inc);
      // Lava burns the shaft up. Tested here in the sub-step march and not off
      // `here` at the top of this method, for the same reason the wall test is:
      // `here` is one sample per frame, and a full-draw arrow crosses four
      // cells in a 15fps frame, so a sheet of lava one cell thick was something
      // an arrow simply flew through — it took the water drag two lines up but
      // nothing at all from the molten rock. A drop that lands in lava already
      // burns (`Drops.update`); an arrow is the only other thing in the game
      // that can be thrown into some.
      if (this.planet.blockAtWorld?.(_probe.x, _probe.y, _probe.z) === ID.lava) {
        a.pos.copy(_probe);
        a.burnt = true;
        this.onBurn?.(a.pos);
        return;
      }
      if (this.planet.isSolidWorld(_probe.x, _probe.y, _probe.z)) {
        // Stop where it entered, not where it would have ended up. Burying the
        // shaft in the block is what makes a stuck arrow read as a stuck arrow
        // rather than as one lying on top of the world; a fifth of the sub-step
        // is enough to bite and not enough to disappear.
        a.pos.addScaledVector(_dir, inc * 0.2);
        a.stuck = true;
        a.age = 0;
        // Posed *before* the velocity is cleared, and the order is not
        // cosmetic: `_pose` reads the velocity to know which way the head is
        // pointing, and a stuck arrow with a zero velocity would fall back to
        // the model's own +Z and snap to face world north at the instant it
        // landed — the one frame the player is looking straight at it.
        this._pose(a);
        a.vel.set(0, 0, 0);
        this.onStick?.(a.pos);
        return;
      }
      a.pos.copy(_probe);
    }
    // Back onto the map. A shot fired across the wrap otherwise leaves an arrow
    // whose x is off the end of the world, and every distance measured to it -
    // the pickup below, the despawn - is a thousand cells out.
    a.pos.x = wrap(a.pos.x); a.pos.z = wrap(a.pos.z);
  }

  /** Point the model along the flight and write its matrix. */
  _pose(a) {
    if (!a.mesh) return;
    // The KayKit arrow is modelled head-along +Z (checked against the atlas:
    // the -Z end samples the blue fletching, the +Z end the grey head), so
    // aligning +Z with the velocity puts the point where it is going.
    const v = a.vel.lengthSq() > 1e-8 ? _dir.copy(a.vel).normalize() : _dir.set(0, 0, 1);
    _q.setFromUnitVectors(Z_AXIS, v);
    _scale.setScalar(ARROW_SCALE);
    _m.compose(a.pos, _q, _scale);
    a.mesh.matrix.copy(_m);
    a.mesh.matrixAutoUpdate = false;
    a.mesh.matrixWorldNeedsUpdate = true;
  }
}

/**
 * How long an arrow is in the world, in cells.
 *
 * `worldModel` hands back the geometry normalised to one unit on its longest
 * axis (see `fitMax` in ItemModels), so this is the length directly. Just under
 * a block: long enough to see against terrain at twenty cells, short enough that
 * one sticking out of a wall does not look like a fence post.
 */
const ARROW_SCALE = 0.85;

// --- the stand-in ------------------------------------------------------------

let _stubGeo = null;
let _stubMat = null;

/**
 * What an arrow flies as before its model has loaded: a sliver along +Z, the
 * same axis and the same unit length the real model is normalised to, so
 * `_pose` needs no special case and the swap is invisible beyond the shape.
 */
function stubGeo() {
  if (!_stubGeo) {
    _stubGeo = new THREE.BoxGeometry(0.06, 0.06, 1);
  }
  return _stubGeo;
}

function stubMat() {
  if (!_stubMat) {
    _stubMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.9, metalness: 0 });
  }
  return _stubMat;
}
