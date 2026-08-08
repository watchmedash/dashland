// Player controller. Movement and collision happen in cubesphere cell space,
// where the grid is aligned to gravity — so it is exactly as solid as a flat
// voxel world, with no sinking or staircase artefacts.

import * as THREE from 'three';
import { GRAVITY, F, D, R_MIN, cidx } from '../world/Constants.js';
import { cellToWorld, worldToCell, tangentFrame, stepColumn, normalizeCell } from '../world/Sphere.js';
import {
  RENDER_TYPE, R_LIQUID, IS_SOLID, IS_SHAPED, IS_LADDER, IS_FENCE, ID, collisionBoxes, isPassable,
} from '../world/Blocks.js';

/** The extent of an ordinary full block, so the shaped path stays branch-free. */
const FULL_BOX = [[0, 0, 0, 1, 1, 1]];

const EYE = 1.62;
const HEIGHT = 1.8;
/**
 * Half-width of the collision box, in CELL units.
 *
 * Everything in the solver lives in cell space, where a block is exactly one
 * cell wide and one layer tall at every radius. The box must therefore be a
 * constant there too. Deriving it from a world radius (RADIUS / frame.arcA)
 * made it *shrink as the player climbed* — cells are wider in world units the
 * further out you are — so a player resting against a wall crept a little
 * closer on the way up and came back down already inside it. 0.34 matches the
 * old world-space width at the surface almost exactly.
 */
const HALF_W = 0.34;
const CROUCH_EYE = 1.32;
const SKIN = 0.0001;   // keeps the box strictly outside the geometry it rests on
const FOOT = 0.002;    // ground tolerance, so resting on a surface is stable
/** Blocks of fall you walk away from, and half-hearts per block beyond it. */
/** Stamina you need back before a spent sprint can start again — about 1.2s. */
const SPRINT_RESUME = 0.15;

const FALL_FREE = 3.0;
const FALL_PER_BLOCK = 1.0;
/** Seconds a blow keeps shoving you. Matches the shove husks take from you. */
const KNOCK_TIME = 0.34;
/** Cells per second up or down a ladder. Slower than walking, on purpose. */
const CLIMB_SPEED = 3.2;
/** How close to the shared wall you must be for a neighbouring ladder to hold. */
const LADDER_GRIP = 0.62;
/**
 * How hard a current shoves you, in cells/s² at full strength.
 *
 * The number that matters is not this one but the speed it settles at, and
 * that depends on what is damping you. Adrift and not steering, water damps at
 * 4/s, so 11 settles at 2.75 cells/s — a shade above the 2.73 you make swimming
 * — and you are unmistakably being carried. Standing in a shallow stream,
 * ground friction of 14/s holds it to 0.79, a slow slide rather than a shove.
 *
 * Swimming against it, steering lerps at 11/s toward your intended velocity and
 * the current only offsets that equilibrium by about 1 cell/s, so you still make
 * 1.7 cells/s straight upstream and rather more across the channel. That
 * asymmetry is the whole design: let go and the river has you, swim and it
 * doesn't. A current you cannot leave is not a river, it is a wall.
 */
const FLOW_PUSH = 11;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = [0, 0, 0];
const _nc = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 };
const _hit = { depth: 0, axis: -1, push: 0 };

export class Player {
  constructor(planet) {
    this.planet = planet;
    /** authoritative position, in cell space */
    this.cell = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 };
    /** cell-space velocity: cells/s tangentially, layers/s radially */
    this.vel = { i: 0, j: 0, k: 0 };
    /** decaying shove from the last blow, in cell space */
    this.knockI = 0; this.knockJ = 0; this.knockT = 0;
    this.position = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, -1);
    this.frame = { ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1 };

    this.pitch = 0;
    this.grounded = false;
    this.inWater = false;
    this.inLava = false;
    /**
     * The flow simulation, if there is one. Optional on purpose — the player is
     * built before it is, and a world loaded without it should still walk.
     * @type {import('../game/Water.js').Water|null}
     */
    this.water = null;
    this.headInWater = false;
    /** seconds still alight after leaving the lava */
    this.burning = 0;
    this.sprinting = false;
    this.crouching = false;
    this.bob = 0;
    this.bobAmount = 0;
    this.fovBoost = 0;
    this.health = 20;
    this.maxHealth = 20;
    this.stamina = 1;
    this.fallStart = null;
    this.onLadder = false;
    this.eyeHeight = EYE;
    this.stepOffset = 0;         // smooths the camera over 1-block step-ups
    this.autoJump = false;       // walk up a one-block ledge without jumping
    this.lookDir = new THREE.Vector3(0, 0, -1);
    this.eye = new THREE.Vector3();
    this.reach = 5.0;
    this.walkTimer = 0;
    this.lastStepDist = 0;
    this.swingT = 1;             // arm swing, 0..1
    this.onStep = null;
    this.onLand = null;
    this.onHurt = null;
    this.moveAmount = 0;
    /** Set by main once Mobs exists, so the box can be kept out of bodies. */
    this.mobs = null;
  }

  // --- placement ------------------------------------------------------------

  spawnAtColumn(col, k) {
    const f = (col / (F * F)) | 0;
    const rem = col - f * F * F;
    this.cell.f = f;
    this.cell.ci = ((rem / F) | 0) + 0.5;
    this.cell.cj = (rem % F) + 0.5;
    this.cell.ck = k + 1.02;
    this.vel.i = 0; this.vel.j = 0; this.vel.k = 0;
    this._sync();
    const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.forward.copy(ref).sub(_a.copy(this.up).multiplyScalar(ref.dot(this.up))).normalize();
    this.pitch = -0.08;
  }

  setWorldPosition(v) {
    worldToCell(v.x, v.y, v.z, this.cell);
    this.vel.i = 0; this.vel.j = 0; this.vel.k = 0;
    this.knockT = 0;
    this._sync();
  }

  /**
   * Is the player's box overlapping a ladder cell?
   *
   * Deliberately generous on the tangential axes — the plate is a seventh of a
   * cell thick, and requiring the box to actually touch it would mean losing
   * your grip every time you nudged the stick.
   */
  _touchingLadder(height) {
    const c = this.cell;
    const p = this.planet;
    const baseI = Math.floor(c.ci), baseJ = Math.floor(c.cj);
    if (baseI < 0 || baseI >= F || baseJ < 0 || baseJ >= F) return false;
    const baseCol = cidx(c.f, baseI, baseJ);
    const k0 = Math.floor(c.ck + FOOT);
    const k1 = Math.floor(c.ck + height - FOOT);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (Math.abs(di) + Math.abs(dj) > 1) continue;      // no diagonals
        const col = stepColumn(baseCol, di, dj);
        for (let k = k0; k <= k1; k++) {
          if (!IS_LADDER[p.at(col, k)]) continue;
          if (di === 0 && dj === 0) return true;
          // A ladder in the next cell only holds you if you are pressed up
          // against that side of your own cell.
          const fi = c.ci - baseI, fj = c.cj - baseJ;
          if (di === 1 && fi > 1 - LADDER_GRIP) return true;
          if (di === -1 && fi < LADDER_GRIP) return true;
          if (dj === 1 && fj > 1 - LADDER_GRIP) return true;
          if (dj === -1 && fj < LADDER_GRIP) return true;
        }
      }
    }
    return false;
  }

  /**
   * Keep the player's box out of animal bodies.
   *
   * Until now the player collided with blocks and nothing else, and the only
   * body-vs-body resolution in the game was the animals' own sidestep — which
   * is deliberately one-sided, because being shoved around by livestock is
   * worse than walking through it. That worked while every animal was about
   * player-sized. It stopped working when a giraffe arrived: an animal backed
   * against a wall has nowhere to yield to, so you walked straight in, your eye
   * ended up inside the barrel, and because the art is double-sided you got a
   * clear view of the far flank from the inside.
   *
   * A circle and not the oriented footprint. The footprint is a rectangle
   * turned to face the animal's heading, and resolving a box against a rotated
   * box for something this small is a lot of maths to make a cow feel very
   * slightly more cow-shaped. `radius` is the longer half-axis, so this is the
   * footprint's circumscribed circle — generous by up to the difference between
   * halfW and halfL, which for everything but the two giants is under 0.35 of a
   * cell.
   *
   * The wall wins. The push is only taken if the destination is legal, so an
   * animal cannot press you into geometry — you simply stay put and it is the
   * animal's own separation that has to give.
   */
  _pushOutOfMobs(height) {
    const mobs = this.mobs;
    if (!mobs) return;
    const c = this.cell;
    for (const m of mobs.list) {
      // Cell coordinates on two different cube faces are not comparable, and a
      // player and an animal within a metre of each other are on the same face
      // everywhere except exactly on a seam. Not worth the frame conversion.
      if (m.cell.f !== c.f) continue;
      if (c.ck >= m.cell.ck + m.tall || c.ck + height <= m.cell.ck) continue;
      const di = c.ci - m.cell.ci, dj = c.cj - m.cell.cj;
      const need = m.radius + HALF_W;
      const d2 = di * di + dj * dj;
      if (d2 >= need * need) continue;
      let ux, uj;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        ux = di / d; uj = dj / d;
      } else {
        // Dead centre — a body that spawned on top of us. Any direction will
        // do; forward is the one the player is already looking at.
        const fwd = this._toCellVelocity(this.forward.x, this.forward.y, this.forward.z);
        const l = Math.hypot(fwd.i, fwd.j) || 1;
        ux = fwd.i / l; uj = fwd.j / l;
      }
      const ni = m.cell.ci + ux * need, nj = m.cell.cj + uj * need;
      if (ni < 0 || ni >= F || nj < 0 || nj >= F) continue;
      if (this._blocked(ni, nj, c.ck, height)) continue;
      c.ci = ni; c.cj = nj;
    }
  }

  /**
   * Shove the player away from a world point — what a husk's blow feels like.
   *
   * The small upward pop matters as much as the push: without it you are shoved
   * along the ground and friction eats it immediately, and being knocked
   * backwards off a ledge is the whole reason not to fight beside one.
   */
  knockback(x, y, z, strength = 5.0) {
    const dx = this.position.x - x, dy = this.position.y - y, dz = this.position.z - z;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-5) return;
    const v = this._toCellVelocity((dx / l) * strength, (dy / l) * strength, (dz / l) * strength);
    this.knockI = v.i;
    this.knockJ = v.j;
    this.knockT = KNOCK_TIME;
    // A token lift, not a hop. Airborne damping is a twelfth of ground friction,
    // so any real pop turns the shove ballistic: at 3.1 a single blow carried
    // the player four blocks, and how far depended mostly on which way the hill
    // sloped — 0.8 blocks on one measurement and 3.5 on the next. This is just
    // enough to break friction for a moment so the push reads.
    if (this.grounded) { this.vel.k = Math.max(this.vel.k, 0.9); this.grounded = false; }
  }

  /** Refresh world position, tangent frame and up from the cell coordinates. */
  _sync() {
    const c = this.cell;
    cellToWorld(c.f, c.ci, c.cj, c.ck, _p);
    this.position.set(_p[0], _p[1], _p[2]);
    tangentFrame(c.f, c.ci, c.cj, c.ck, this.frame);
    const nu = _a.set(this.frame.up[0], this.frame.up[1], this.frame.up[2]);
    if (this.up.lengthSq() > 0.5) {
      _q.setFromUnitVectors(this.up, nu);
      this.forward.applyQuaternion(_q);
    }
    this.up.copy(nu);
    this.forward.sub(_b.copy(this.up).multiplyScalar(this.forward.dot(this.up)));
    if (this.forward.lengthSq() < 1e-6) {
      const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      this.forward.copy(ref).sub(_b.copy(this.up).multiplyScalar(ref.dot(this.up)));
    }
    this.forward.normalize();
  }

  look(dx, dy, sensitivity, invertY) {
    _q.setFromAxisAngle(this.up, -dx * sensitivity);
    this.forward.applyQuaternion(_q);
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + (invertY ? dy : -dy) * sensitivity,
      -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02,
    );
  }

  // --- collision ------------------------------------------------------------

  /** Does the AABB at these cell coordinates overlap solid geometry? */
  _blocked(ci, cj, ck, height) {
    return this._overlap(ci, cj, ck, height, null);
  }

  /**
   * Core box/solid test.
   *
   * When `hit` is supplied it comes back describing the deepest overlapping
   * cell and the *shallowest* way out of it, so a caller can push the player
   * out the short way. Only meaningful when ci/cj are already on this.cell.f
   * (i.e. after normalizeCell), which is the case everywhere it is used.
   */
  _overlap(ci, cj, ck, height, hit) {
    const p = this.planet;
    // A move can leave the face before normalizeCell runs. Re-anchor rather
    // than bailing out: returning "not solid" for an off-face address opened a
    // hole in the collision every time the player crossed a cube edge.
    let f = this.cell.f, ai = ci, aj = cj;
    if (ci < 0 || ci >= F || cj < 0 || cj >= F) {
      _nc.f = f; _nc.ci = ci; _nc.cj = cj; _nc.ck = ck;
      normalizeCell(_nc);
      f = _nc.f; ai = _nc.ci; aj = _nc.cj;
    }
    const baseI = Math.floor(ai), baseJ = Math.floor(aj);
    // Still off the grid: fail solid, never as air.
    if (baseI < 0 || baseI >= F || baseJ < 0 || baseJ >= F) return true;
    const baseCol = cidx(f, baseI, baseJ);
    const k0 = Math.floor(ck + FOOT);
    const k1 = Math.floor(ck + height - FOOT);
    // A fence is the one block taller than its own cell, so the cell below the
    // feet can still hold something the body is standing inside. Without this
    // extra layer you could jump a fence by clearing one block instead of the
    // one and a half it stands.
    const kLow = k0 - 1;
    if (hit) { hit.depth = 0; hit.axis = -1; hit.push = 0; }
    let found = false;

    for (let di = -1; di <= 1; di++) {
      const lo = baseI + di, hi = lo + 1;
      const ovI = Math.min(ai + HALF_W, hi) - Math.max(ai - HALF_W, lo);
      if (ovI <= 0) continue;
      for (let dj = -1; dj <= 1; dj++) {
        const loj = baseJ + dj, hij = loj + 1;
        const ovJ = Math.min(aj + HALF_W, hij) - Math.max(aj - HALF_W, loj);
        if (ovJ <= 0) continue;
        const col = stepColumn(baseCol, di, dj);
        for (let k = kLow; k <= k1; k++) {
          const bid = p.at(col, k);
          if (!IS_SOLID[bid]) continue;
          // The extra layer below is only ever about fences: everything else
          // ends at its own ceiling and was already answered for by cell k0.
          if (k < k0 && !IS_FENCE[bid]) continue;
          // You climb a ladder and you walk through an open door; neither is
          // something to bump into. They keep their boxes so the mesher and the
          // mob ground scan still see a surface there.
          if (isPassable(bid, p.facingAt(col, k))) continue;
          // A shaped block fills only part of its cell, so the cell index alone
          // no longer says where the solid is. Test the real boxes instead of
          // assuming k..k+1 — otherwise you would stand a full block above a
          // half slab and walk into the empty air over a stair's low side.
          const boxes = IS_SHAPED[bid]
            ? collisionBoxes(bid, p.facingAt(col, k))
            : FULL_BOX;
          for (let bx = 0; bx < boxes.length; bx++) {
            const [bi0, bj0, bk0, bi1, bj1, bk1] = boxes[bx];
            const bLoI = lo + bi0, bHiI = lo + bi1;
            const bLoJ = loj + bj0, bHiJ = loj + bj1;
            const bOvI = Math.min(ai + HALF_W, bHiI) - Math.max(ai - HALF_W, bLoI);
            if (bOvI <= 0) continue;
            const bOvJ = Math.min(aj + HALF_W, bHiJ) - Math.max(aj - HALF_W, bLoJ);
            if (bOvJ <= 0) continue;
            const kLo = k + bk0, kHi = k + bk1;
            const ovK = Math.min(ck + height, kHi) - Math.max(ck, kLo);
            if (ovK <= 0) continue;
            found = true;
            if (!hit) return true;
            const depth = Math.min(bOvI, bOvJ, ovK);
            if (depth <= hit.depth) continue;
            hit.depth = depth;
            if (depth === bOvI) {
              hit.axis = 0;
              hit.push = (ai < (bLoI + bHiI) * 0.5 ? -1 : 1) * (bOvI + SKIN);
            } else if (depth === bOvJ) {
              hit.axis = 1;
              hit.push = (aj < (bLoJ + bHiJ) * 0.5 ? -1 : 1) * (bOvJ + SKIN);
            } else {
              hit.axis = 2;
              hit.push = (ck + height * 0.5 < (kLo + kHi) * 0.5 ? -1 : 1) * (ovK + SKIN);
            }
          }
        }
      }
    }
    return found;
  }

  /**
   * Push the box out of anything it is inside, along the shallowest axis.
   *
   * The old safety net only ever pushed *upward* by whole layers, so a hair of
   * horizontal overlap with a wall — which is what you get from a block placed
   * against you, or from a badly resolved corner — was "resolved" by lifting
   * the player to the top of that wall.
   */
  _escape(height) {
    const c = this.cell;
    let moved = false;
    for (let n = 0; n < 8; n++) {
      if (!this._overlap(c.ci, c.cj, c.ck, height, _hit) || _hit.axis < 0) break;
      moved = true;
      if (_hit.axis === 0) {
        c.ci += _hit.push;
        if (this.vel.i * _hit.push < 0) this.vel.i = 0;
      } else if (_hit.axis === 1) {
        c.cj += _hit.push;
        if (this.vel.j * _hit.push < 0) this.vel.j = 0;
      } else {
        c.ck += _hit.push;
        if (_hit.push > 0) { this.grounded = true; this.vel.k = Math.max(0, this.vel.k); }
        else this.vel.k = Math.min(0, this.vel.k);
      }
      if (c.ci < 0 || c.ci >= F || c.cj < 0 || c.cj >= F) { normalizeCell(c); this._sync(); }
      if (!this._blocked(c.ci, c.cj, c.ck, height)) return true;
    }
    // Eight pushes and still inside: there is no legal position nearby — a gap
    // too small to occupy at all. Lift out through the top as a last resort so
    // the player can never be sealed inside the world.
    for (let n = 0; n < 6 && this._blocked(c.ci, c.cj, c.ck, height); n++) {
      c.ck = Math.floor(c.ck + FOOT) + 1 + SKIN;
      this.vel.k = Math.max(0, this.vel.k);
      this.grounded = true;
    }
    return moved;
  }

  /**
   * The highest solid surface at or just below `ck` under the box's footprint.
   *
   * The landing correction used to be `Math.floor(ck) + SKIN`, which assumes
   * every floor sits on a layer boundary. A slab's top is at k + 0.5, so on one
   * the player either hovered half a block up or sank into it, and `grounded`
   * never latched — which also meant no jumping. Ask the blocks where their
   * tops are instead of assuming.
   *
   * @returns {number} rest height, or -1 if there is nothing to stand on
   */
  _surfaceBelow(ci, cj, ck) {
    const p = this.planet;
    const baseI = Math.floor(ci), baseJ = Math.floor(cj);
    if (baseI < 0 || baseI >= F || baseJ < 0 || baseJ >= F) return -1;
    const baseCol = cidx(this.cell.f, baseI, baseJ);
    // The feet can overlap up to four columns; the floor is the highest of them.
    let best = -1;
    for (let di = -1; di <= 1; di++) {
      if (Math.min(ci + HALF_W, baseI + di + 1) - Math.max(ci - HALF_W, baseI + di) <= 0) continue;
      for (let dj = -1; dj <= 1; dj++) {
        if (Math.min(cj + HALF_W, baseJ + dj + 1) - Math.max(cj - HALF_W, baseJ + dj) <= 0) continue;
        const col = stepColumn(baseCol, di, dj);
        // Only the cell the feet are in and the one under it can hold the floor.
        for (let k = Math.floor(ck + FOOT); k >= Math.floor(ck + FOOT) - 1; k--) {
          const id = p.at(col, k);
          if (!IS_SOLID[id]) continue;
          const boxes = IS_SHAPED[id] ? collisionBoxes(id, p.facingAt(col, k)) : FULL_BOX;
          for (let b = 0; b < boxes.length; b++) {
            const [bi0, bj0, , bi1, bj1, bk1] = boxes[b];
            // Only a box actually under the feet counts. A stair's riser is at
            // the back of its cell, so standing on the low half must not snap
            // you up to the riser's top.
            if (Math.min(ci + HALF_W, baseI + di + bi1) - Math.max(ci - HALF_W, baseI + di + bi0) <= 0) continue;
            if (Math.min(cj + HALF_W, baseJ + dj + bj1) - Math.max(cj - HALF_W, baseJ + dj + bj0) <= 0) continue;
            const surface = k + bk1;
            if (surface <= ck + FOOT + SKIN && surface > best) best = surface;
          }
        }
      }
    }
    return best < 0 ? -1 : best + SKIN;
  }

  /**
   * Bisect along i between a free position and a blocked one so the player
   * stops *touching* the wall instead of a whole sub-step short of it. Always
   * returns a position that tested clear.
   */
  _contactI(from, to, cj, ck, height) {
    if (this._blocked(from, cj, ck, height)) return from;
    let lo = from, hi = to;
    for (let n = 0; n < 6; n++) {
      const mid = (lo + hi) * 0.5;
      if (this._blocked(mid, cj, ck, height)) hi = mid; else lo = mid;
    }
    return lo;
  }

  /** As _contactI, along j. */
  _contactJ(from, to, ci, ck, height) {
    if (this._blocked(ci, from, ck, height)) return from;
    let lo = from, hi = to;
    for (let n = 0; n < 6; n++) {
      const mid = (lo + hi) * 0.5;
      if (this._blocked(ci, mid, ck, height)) hi = mid; else lo = mid;
    }
    return lo;
  }

  update(dt, input) {
    const p = this.planet;
    const c = this.cell;
    const fr = this.frame;

    // ---- intent ----
    let ix = 0, iz = 0;
    if (input.down('KeyW')) iz += 1;
    if (input.down('KeyS')) iz -= 1;
    if (input.down('KeyD')) ix += 1;
    if (input.down('KeyA')) ix -= 1;
    const moving = ix !== 0 || iz !== 0;
    const len = Math.hypot(ix, iz) || 1;
    ix /= len; iz /= len;

    this.crouching = input.down('ControlLeft') || input.down('ControlRight');
    // No headroom to stand back up: stay crouched. Growing the box into a
    // ceiling and then shoving it out is how you end up on top of the ceiling.
    if (!this.crouching && this._blocked(c.ci, c.cj, c.ck, HEIGHT)) this.crouching = true;
    // Sprinting needs a reserve to *start* and only stops at empty.
    //
    // The gate used to be a single `stamina > 0.02` on both, and that is a
    // flip-flop, not a threshold: run yourself down to 2%, and the frame you
    // cross it you stop sprinting, which switches stamina from draining at
    // 0.055/s to recovering at 0.12/s, which puts you back over 2% by the very
    // next frame, which starts you sprinting again. It oscillated at frame
    // rate, and since sprinting also pulls the view model's arm back by 5cm,
    // what the player actually saw was the hand shaking at 2% stamina.
    //
    // Two different numbers break the loop, and they also read better: you jog
    // to a stop when you are spent, and you have to get some wind back before
    // you can go again rather than stuttering along at zero.
    const wantsSprint = (input.down('ShiftLeft') || input.down('ShiftRight'))
      && iz > 0 && !this.crouching;
    this.sprinting = wantsSprint && this.stamina > (this.sprinting ? 0 : SPRINT_RESUME);

    // ---- environment ----
    const feet = p.cellAt(this.position.x, this.position.y, this.position.z);
    const headP = _b.copy(this.position).addScaledVector(this.up, EYE);
    // liquidAt is true for lava as well, which is what gives lava its wading
    // physics for free — but it is also why lava went unnoticed by everything
    // that asked "am I in water?". The block id is the only way to tell.
    const feetId = feet ? p.at(feet.col, feet.k) : 0;
    this.inWater = feet ? p.liquidAt(feet.col, feet.k) : false;
    this.inLava = feetId === ID.lava;
    this.headInWater = p.isLiquidWorld(headP.x, headP.y, headP.z) && !this.inLava;

    // ---- desired tangential velocity, expressed in cells/second ----
    let speed = this.crouching ? 2.0 : this.sprinting ? 6.8 : 4.4;
    if (this.inWater) speed *= 0.62;

    const right = _c.copy(this.forward).cross(this.up).normalize();
    const wish = _a.set(0, 0, 0).addScaledVector(this.forward, iz).addScaledVector(right, ix);
    const w2 = this._toCellVelocity(wish.x * speed, wish.y * speed, wish.z * speed);
    const wi = w2.i, wj = w2.j;

    const accel = this.grounded ? 42 : 11;
    if (moving) {
      const t = Math.min(1, accel * dt);
      this.vel.i += (wi - this.vel.i) * t;
      this.vel.j += (wj - this.vel.j) * t;
    } else {
      const damp = this.grounded ? 14 : this.inWater ? 4 : 1.2;
      const f2 = Math.max(0, 1 - damp * dt);
      this.vel.i *= f2; this.vel.j *= f2;
    }

    // Being hit shoves you, and the shove wins over steering for a moment
    // before handing control back. It blends *over* the velocity rather than
    // adding to it, which is what makes it predictable: added, the result was
    // decided by how long the token upward pop kept you off the ground, and
    // airborne damping is a twelfth of ground friction — so the same blow moved
    // the player anywhere from 0.01 to 3.5 blocks depending on the hillside.
    // Blended, displacement is simply strength × KNOCK_TIME / 2.
    if (this.knockT > 0) {
      const d = this.knockT / KNOCK_TIME;
      this.vel.i += (this.knockI - this.vel.i) * d;
      this.vel.j += (this.knockJ - this.vel.j) * d;
      this.knockT = Math.max(0, this.knockT - dt);
    }

    // Being carried by a current.
    //
    // Water.flowAt answers in the *feet column's own* (i, j) frame, which is
    // the same frame vel.i/vel.j are already in — the player's cell address and
    // the cell being asked about are the same column. So there is deliberately
    // no conversion here, and therefore nothing to get wrong on a cube seam.
    // (Drops have to go the long way round through tangentFrame, because they
    // live in world space.)
    //
    // Added to the velocity rather than blended over it, unlike a blow: a blow
    // is a moment and should override you, a river is a condition you swim
    // against. Blending would have pinned you to the current's speed and made
    // swimming upstream impossible, which is the exact failure this is trying
    // to avoid.
    if (this.inWater && this.water && feet) {
      const fl = this.water.flowAt(feet.col, feet.k);
      if (fl) {
        const push = FLOW_PUSH * fl.s * dt;
        this.vel.i += fl.i * push;
        this.vel.j += fl.j * push;
        // fl.k — the plunge of a waterfall — is deliberately ignored. Dragging
        // the player down inside a falling column fights the swim-up key at the
        // bottom of the shaft, and gravity is already taking you over the lip
        // with all the tangential speed the run-up gave you.
      }
    }

    // ---- radial velocity ----
    // Declared here rather than at the integrate step below, because the ladder
    // test needs it first and `const` does not hoist.
    const height = this.crouching ? HEIGHT - 0.35 : HEIGHT;
    this.onLadder = !this.inWater && this._touchingLadder(height);
    if (this.onLadder) {
      // Hold Space to go up, Ctrl to go down, and neither to stay put — a
      // ladder you slide off the moment you stop pressing something is a rope,
      // not a ladder. Walking into the wall is what keeps you attached, so
      // stepping backwards drops you off it, which is how you get off at the
      // bottom without a special case.
      const climb = input.down('Space') ? CLIMB_SPEED
        : this.crouching ? -CLIMB_SPEED * 0.8 : 0;
      this.vel.k += (climb - this.vel.k) * Math.min(1, 14 * dt);
      if (this.grounded && input.down('Space')) this.grounded = false;
    } else if (this.inWater) {
      this.vel.k -= GRAVITY * 0.22 * dt;
      if (input.down('Space')) this.vel.k += 15 * dt;
      if (this.crouching) this.vel.k -= 9 * dt;
      this.vel.k *= Math.max(0, 1 - 3.2 * dt);
      this.vel.k = Math.max(this.vel.k, -5);
    } else {
      this.vel.k -= GRAVITY * dt;
      if (this.grounded && input.down('Space')) {
        this.vel.k = 8.4;
        this.grounded = false;
      }
      this.vel.k = Math.max(this.vel.k, -58);
    }

    // ---- integrate with axis-separated collision ----
    const wasGrounded = this.grounded;
    this.grounded = false;

    // World edits (a block placed against us, a tree grown through us) can leave
    // the box embedded between frames. Clear that before integrating, so the
    // solve below always starts from a legal position.
    this._escape(height);

    // sub-step so fast falls can't tunnel through a block: no sub-step may
    // advance more than 0.4 cells along any axis.
    const speedCells = Math.hypot(this.vel.i, this.vel.j, this.vel.k);
    const steps = Math.max(1, Math.min(16, Math.ceil(speedCells * dt / 0.4)));
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      // i axis
      const ni = c.ci + this.vel.i * sdt;
      if (this._blocked(ni, c.cj, c.ck, height)) {
        if (this._tryStepUp(ni, c.cj, height, wasGrounded)) c.ci = ni;
        else { c.ci = this._contactI(c.ci, ni, c.cj, c.ck, height); this.vel.i = 0; }
      } else c.ci = ni;

      // j axis
      const nj = c.cj + this.vel.j * sdt;
      if (this._blocked(c.ci, nj, c.ck, height)) {
        if (this._tryStepUp(c.ci, nj, height, wasGrounded)) c.cj = nj;
        else { c.cj = this._contactJ(c.cj, nj, c.ci, c.ck, height); this.vel.j = 0; }
      } else c.cj = nj;

      // k axis. Both rest positions are derived from the *pre-move* height,
      // which is known clear, and are re-tested before being taken — so a
      // sideways overlap can never be mistaken for a floor and answered by
      // launching the player up to the top of it. If neither rest position is
      // usable we are embedded; _escape resolves that properly below.
      const nk = c.ck + this.vel.k * sdt;
      if (this._blocked(c.ci, c.cj, nk, height)) {
        if (this.vel.k <= 0) {
          // Landing may correct upward by at most the foot tolerance — never by
          // a whole layer, which is what let a wall hoist the player onto it.
          // The clamp has to allow the correction SKIN past FOOT: the rest
          // position is floor(ck + FOOT) + SKIN, which is exactly FOOT + SKIN
          // above ck when the feet sit a hair under a layer boundary. Comparing
          // against FOOT alone rejected the only legal rest position there, so
          // the player stood embedded 0.002 deep with grounded never set — and
          // therefore could not jump at all.
          const rest = this._surfaceBelow(c.ci, c.cj, c.ck);
          if (rest >= 0 && rest <= c.ck + FOOT + SKIN && !this._blocked(c.ci, c.cj, rest, height)) {
            c.ck = rest;
            this.grounded = true;
          }
        } else {
          const rest = Math.ceil(c.ck + height) - height - SKIN;
          if (rest >= c.ck - FOOT && rest <= nk && !this._blocked(c.ci, c.cj, rest, height)) c.ck = rest;
        }
        this.vel.k = 0;
      } else {
        c.ck = nk;
      }

      // crossing a cube edge re-anchors us onto the neighbouring face
      if (c.ci < 0 || c.ci >= F || c.cj < 0 || c.cj >= F) {
        // carry the velocity through the seam in world space, so strafing and
        // running keep their true heading across a cube edge
        const worldV = _v4.copy(this._toWorldVelocity(_v3));
        normalizeCell(c);
        this._sync();
        const re = this._toCellVelocity(worldV.x, worldV.y, worldV.z);
        this.vel.i = re.i; this.vel.j = re.j;
      }
    }

    // Explicit ground probe. Relying on the landing correction alone to set
    // `grounded` makes the flag depend on a collision firing *this* frame — but
    // a player standing still is already resting, so nothing fires and the flag
    // decays to false. Probe just under the feet instead: that is stable at
    // rest, and it also recovers a box that ended up a hair inside the floor.
    if (!this.grounded && this.vel.k <= 0 &&
        this._blocked(c.ci, c.cj, c.ck - FOOT * 2, height)) {
      this.grounded = true;
      const rest = this._surfaceBelow(c.ci, c.cj, c.ck);
      if (rest > c.ck && rest <= c.ck + FOOT + SKIN &&
          !this._blocked(c.ci, c.cj, rest, height)) c.ck = rest;
      if (this.vel.k < 0) this.vel.k = 0;
    }

    if (c.ck < SKIN) { c.ck = SKIN; this.vel.k = 0; this.grounded = true; }
    if (c.ck > D - 2) { c.ck = D - 2; this.vel.k = Math.min(0, this.vel.k); }

    // Safety net: never end a frame with the box inside geometry.
    this._escape(height);

    // ...nor inside an animal.
    this._pushOutOfMobs(height);

    this._sync();

    // ---- fall damage ----
    //
    // Minecraft's curve, near enough: three blocks are free, and past that it
    // is one half-heart per block. The old numbers were both softer and flatter
    // — 4.2 free and 1.1 per block after — which meant nothing under five
    // blocks registered at all and a genuinely lethal drop still left you
    // walking. Height should be the thing you respect before hostiles exist,
    // and the fall you can survive should be the one you chose to take.
    const r = this.position.length();
    // Catching a ladder ends the fall, the same as landing does — otherwise
    // climbing down a long shaft charges you for the whole descent the moment
    // you step off at the bottom.
    if (this.onLadder) this.fallStart = null;
    if (!this.grounded && !this.inWater && !this.onLadder) {
      if (this.fallStart === null && this.vel.k < -0.2) this.fallStart = r;
      // Track the highest point, not the point where the descent began: a jump
      // off a ledge starts the clock *after* the arc has already peaked, so a
      // running leap into a ravine was charged for less than it should be.
      else if (this.fallStart !== null && r > this.fallStart) this.fallStart = r;
    } else if (this.fallStart !== null) {
      const drop = this.fallStart - r;
      if (drop > FALL_FREE && !this.inWater) {
        const dmg = Math.round((drop - FALL_FREE) * FALL_PER_BLOCK);
        if (dmg > 0) { this.health = Math.max(0, this.health - dmg); this.onHurt?.(dmg); }
      }
      if (drop > 0.6) this.onLand?.(Math.min(1, drop / 8));
      this.fallStart = null;
    }

    // ---- gait ----
    const tanSpeed = Math.hypot(this.vel.i * fr.arcA, this.vel.j * fr.arcB);
    this.moveAmount = tanSpeed;
    if (this.grounded && tanSpeed > 0.6) {
      this.walkTimer += dt * tanSpeed * (this.sprinting ? 1.35 : 1.15);
      const stride = this.sprinting ? 1.9 : 2.35;
      if (this.walkTimer - this.lastStepDist > stride) {
        this.lastStepDist = this.walkTimer;
        this.onStep?.(this.groundBlock());
      }
    }
    const targetBob = this.grounded && tanSpeed > 0.6 ? Math.min(1, tanSpeed / 6) : 0;
    this.bobAmount += (targetBob - this.bobAmount) * Math.min(1, 8 * dt);
    this.bob += dt * tanSpeed * 1.9;
    this.fovBoost += ((this.sprinting && tanSpeed > 3 ? 1 : 0) - this.fovBoost) * Math.min(1, 6 * dt);
    this.stepOffset *= Math.max(0, 1 - 16 * dt);

    if (this.sprinting && tanSpeed > 3) this.stamina = Math.max(0, this.stamina - dt * 0.055);
    else this.stamina = Math.min(1, this.stamina + dt * 0.12);

    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt * 3.4);
  }

  /**
   * Climb a single block if there is headroom. `grounded` is reset before the
   * horizontal axes resolve, so eligibility comes from last frame's state.
   */
  /**
   * Auto-step onto a one-block ledge without jumping.
   *
   * Off by default. It is a convenience, not a physics rule — it lets you walk
   * up terrain you never asked to climb, which makes precise movement along a
   * ledge or around a build harder rather than easier. `autoJump` in settings
   * turns it back on.
   */
  _tryStepUp(ci, cj, height, wasGrounded) {
    if (!this.autoJump) return false;
    if (!(wasGrounded || this.grounded)) return false;
    // Never step while rising: mid-jump the box must be stopped by a wall, not
    // hoisted over it.
    if (this.vel.k > 0.1) return false;
    const c = this.cell;
    const lifted = Math.floor(c.ck + FOOT) + 1 + SKIN;
    const rise = lifted - c.ck;
    if (rise <= 0 || rise > 1.06) return false;
    if (this._blocked(ci, cj, lifted, height)) return false;
    this.stepOffset = Math.min(0.55, this.stepOffset + rise);
    c.ck = lifted;
    this.grounded = true;
    return true;
  }

  /**
   * Decompose a world-space tangential vector into cell-space rates.
   * ea and eb are NOT orthogonal away from a face centre, so a plain pair of
   * dot products skews the result — solve the 2x2 Gram system instead.
   */
  _toCellVelocity(vx, vy, vz, out = { i: 0, j: 0 }) {
    const fr = this.frame;
    const A = vx * fr.ea[0] + vy * fr.ea[1] + vz * fr.ea[2];
    const B = vx * fr.eb[0] + vy * fr.eb[1] + vz * fr.eb[2];
    const c = fr.ea[0] * fr.eb[0] + fr.ea[1] * fr.eb[1] + fr.ea[2] * fr.eb[2];
    const det = 1 - c * c;
    let alpha, beta;
    if (det < 1e-6) { alpha = A; beta = B; }
    else { alpha = (A - c * B) / det; beta = (B - c * A) / det; }
    out.i = alpha / fr.arcA;
    out.j = beta / fr.arcB;
    return out;
  }

  /** Cell-space tangential velocity back into world space. */
  _toWorldVelocity(out = _v3) {
    const fr = this.frame;
    const a = this.vel.i * fr.arcA, b = this.vel.j * fr.arcB;
    out.set(
      fr.ea[0] * a + fr.eb[0] * b,
      fr.ea[1] * a + fr.eb[1] * b,
      fr.ea[2] * a + fr.eb[2] * b,
    );
    return out;
  }

  groundBlock() {
    const c = this.cell;
    const baseI = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
    const baseJ = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
    const col = cidx(c.f, baseI, baseJ);
    return this.planet.at(col, Math.floor(c.ck - 0.2));
  }

  swing() { this.swingT = 0; }

  // --- camera ---------------------------------------------------------------

  updateCamera(camera, dt, baseFov, allowBob = true) {
    const targetEye = this.crouching ? CROUCH_EYE : EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, 12 * dt);

    const right = _c.copy(this.forward).cross(this.up).normalize();
    this.lookDir.copy(this.forward).multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(this.up, Math.sin(this.pitch)).normalize();

    this.eye.copy(this.position).addScaledVector(this.up, this.eyeHeight - this.stepOffset);
    const b = allowBob ? this.bobAmount : 0;
    if (b > 0.001) {
      this.eye.addScaledVector(this.up, Math.sin(this.bob * 2) * 0.042 * b);
      this.eye.addScaledVector(right, Math.cos(this.bob) * 0.05 * b);
    }

    const camPos = _a.copy(this.eye);
    camera.position.copy(camPos);
    _m.lookAt(camPos, _b.copy(camPos).add(this.lookDir), this.up);
    camera.quaternion.setFromRotationMatrix(_m);
    if (b > 0.001) camera.rotateZ(Math.cos(this.bob) * 0.011 * b);

    const targetFov = baseFov + this.fovBoost * 6;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, 8 * dt);
      camera.updateProjectionMatrix();
    }
  }
}
