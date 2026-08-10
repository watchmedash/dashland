// Player controller. Movement and collision happen in cubesphere cell space,
// where the grid is aligned to gravity — so it is exactly as solid as a flat
// voxel world, with no sinking or staircase artefacts.

import * as THREE from 'three';
import { GRAVITY, F, D, R_MIN, cidx } from '../world/Constants.js';
import { cellToWorld, tangentFrame, stepColumn, normalizeCell } from '../world/Sphere.js';
import {
  RENDER_TYPE, R_LIQUID, IS_SOLID, IS_SHAPED, IS_LADDER, IS_FENCE, ID, collisionBoxes, isPassable,
  CONTACT_HURT,
} from '../world/Blocks.js';
// Imported rather than re-declared so there is exactly one "how much slower is
// water" number in the game. Items.js owns it, Skills.js quotes it in prose
// ("three times slower"), and `miningDrag` below is the only thing that applies
// it. Items.js imports Blocks.js and nothing else, so this is not a cycle.
import { UNDERWATER_MINING } from '../game/Items.js';

/** The extent of an ordinary full block, so the shaped path stays branch-free. */
const FULL_BOX = [[0, 0, 0, 1, 1, 1]];

const EYE = 1.62;
/**
 * Standing height of the collision box, in cells. Exported because the player's
 * body model is scaled to it — a rig measured at its own rest height and then
 * fitted to this number stands exactly as tall as the thing that collides.
 */
export const HEIGHT = 1.8;
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
/**
 * How close counts as touching, in cells, for contact damage. Two orders of
 * magnitude above SKIN so a box resting against a wall is unambiguously in
 * contact, and small enough that the cell next door is not. See contactHurt.
 */
const TOUCH = 0.015;
/** Blocks of fall you walk away from, and half-hearts per block beyond it. */
/** Stamina you need back before a spent sprint can start again — about 1.2s. */
const SPRINT_RESUME = 0.15;

/**
 * The *base* free fall, in blocks. Agility adds to it — see `skills.fallFree`,
 * which starts from this same 3.0 — so this constant is now what a player with
 * no tree attached falls for free, and the floor everything else builds on.
 */
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

/**
 * Camera modes, in the order the cycle key walks them.
 *
 * First person is index 0 and is the default because it is the finished one —
 * the viewmodel, the swing tracks, the hand light are all built for it. The
 * other two exist so you can see the body: one over the shoulder, one facing
 * you, which is the only way to look at your own character.
 */
export const VIEW_FIRST = 0;
export const VIEW_BACK = 1;
export const VIEW_FRONT = 2;
export const VIEW_COUNT = 3;

/**
 * How far the third-person camera sits from the eye, in cells.
 *
 * Far enough that a 1.8-cell body fits the frame with room around it, close
 * enough that it is still your character and not a diorama. The same distance
 * both ways: a selfie view that sat closer than the over-the-shoulder one made
 * the two feel like different games.
 */
const THIRD_DIST = 3.6;
/**
 * How far above the eye and to the player's right the boom is anchored, in
 * cells.
 *
 * Both are measured in the *tangent frame* — `this.up` and `forward x up` —
 * and not in world +Y, which on a sphere is only "up" at one point on the
 * planet.
 *
 * The side offset is the whole of the fix for "the held pickaxe is behind the
 * body". A camera on the look axis sees the back of a torso and nothing else,
 * because the torso is exactly what is between it and the right hand. 0.55 puts
 * the body about nine degrees off centre at rest, which is enough to clear the
 * shoulder and not enough to read as a camera that has come loose.
 *
 * Both scale down with the pull-in (see `updateCamera`), so a camera squeezed
 * against a wall is not also being pushed sideways into it.
 */
const CAM_LIFT = 0.35;
const CAM_SIDE = 0.55;
/**
 * The steepest the boom may be aimed *downward*, in radians.
 *
 * Without it the boom is the exact reverse of the look direction, so looking
 * *up* drives the camera *down* — and on flat ground it is underground well
 * before the pitch limit. Measured against the real terrain march: at 30 degrees
 * of up-pitch the pull-in already had the camera at 2.97 cells, at 40 at 2.25
 * and at 60 at 1.57, i.e. a player who merely looked up at a hilltop got the
 * back of their own head. This is not the ground being hit "too aggressively";
 * the boom was pointed into it.
 *
 * 0.35 rad (20 degrees) keeps the camera 0.74 cells above the feet at full
 * extension, which clears flat ground with the pad to spare. Rising is not
 * clamped — a boom that swings *up* when you look down is the ordinary
 * over-the-head view, and a ceiling is what the pull-in is for.
 */
const CAM_DEPRESS = 0.35;
/**
 * Clearance kept between the camera and whatever the ray hit.
 *
 * Not a taste value — the camera has a frustum, and stopping the *point* at the
 * wall puts the near plane inside it, which renders as the wall's interior
 * filling half the screen. 0.32 against a 0.06 near plane covers the corners of
 * the near rectangle at the default fov with room to spare.
 */
const CAM_PAD = 0.32;
/**
 * The most of the frame's height a 1.8-cell body may occupy before third person
 * stops being worth having.
 *
 * This is the number the old `THIRD_MIN = 0.55` should always have been. A
 * distance floor cannot answer the question on its own, because how large the
 * body draws is set by the distance *and* the fov, and the fov is now composed
 * from the base setting, the sprint kick, the bow's 16% narrowing and the zoom.
 * Inverting "how much of the screen is the body" gives a floor that moves with
 * all four: 1.8 / (2 d tan(fov/2)) = BODY_MAX_FRAC.
 *
 * At the default 75 degrees that is 1.89 cells. The measured failure was a
 * camera resting at 1.17 with the body drawn — 1.01 of the frame height, a head
 * and nothing else — because the only two thresholds in the file were 0.55
 * (give up) and Character.js's 0.9 (stop drawing the body), and everything
 * between 0.9 and roughly 2.0 is the band where the body fills the screen.
 * Nothing occupied that band deliberately; it was simply never named.
 */
const BODY_MAX_FRAC = 0.65;
/**
 * A floor under the floor, in cells, so a very wide fov cannot decide that a
 * camera all but touching the player's back is fine.
 *
 * There is deliberately no ceiling to match it. If the fov narrows far enough
 * that no reachable distance would keep the body small — full zoom is 22
 * degrees, which wants nine cells of boom — the floor simply exceeds anything
 * the boom can offer and the view collapses to first person, which is the right
 * answer and needs no special case. (`main.js` only lets the zoom key run in
 * first person today, so this is a guard rather than a behaviour.)
 */
const CAM_MIN_LO = 1.6;
/**
 * How much further than the floor the camera must be able to sit before a view
 * that gave up takes itself back.
 *
 * Hysteresis, and it is the whole of the anti-jitter argument: without it the
 * obstacle distance wandering by a hair would flip the view between third and
 * first person at frame rate, which is worse than either. A ratio rather than a
 * fixed gap so that it stays hysteresis when the fov moves the floor: drawing a
 * bow narrows the view and so raises the floor, and a fixed gap measured
 * against the *narrow* floor could sit above the distance that was fine a
 * moment ago — leaving the view stuck in first person after the shot.
 */
const CAM_RESUME_K = 1.18;
/**
 * How the boom moves. Coming *in* is instant — a camera that eases into a wall
 * is a camera inside a wall — and going back out is an exponential rate per
 * second, so stepping out of a doorway is a push rather than a snap.
 *
 * The collapse to first person is the one shrink that is eased instead of
 * taken, in cells per second, and that is safe for a reason worth stating:
 * collapsing moves the camera *toward* the player, which is away from whatever
 * caused it, so no intermediate position can be inside the obstacle.
 */
const CAM_OUT_RATE = 6;
const CAM_COLLAPSE_RATE = 12;

/**
 * Vertical fov at full zoom, in degrees.
 *
 * 22 against the default 75 is 3.4x by angle and 3.9x by the tangent that
 * actually decides how large a thing draws — a decent pair of binoculars, and
 * enough to tell a husk from a cow across a valley, which is the whole reason
 * to hold the key. Much under 15 and the sway of ordinary standing makes it
 * unusable; much over 30 and it is not worth a key at all.
 */
export const ZOOM_FOV = 22;
/**
 * How fast the zoom comes on and goes off, as an exponential rate per second.
 *
 * This is only the first of two lags: the result feeds `updateCamera`, whose
 * own fov filter runs at 8/s, and the two cascade. Measured on the pair at
 * 60fps, full zoom is 86% there at 0.30s and 94% at 0.40s — deliberate rather
 * than snappy, because it is a glass being raised and not a rifle being
 * shouldered, and because the same curve has to carry the fov back down when
 * something jumps you.
 */
const ZOOM_RATE = 16;

/**
 * One step of the zoom ramp. Pure, so the curve can be checked without a
 * camera.
 *
 * The `min(1, ...)` is not decoration: `dt` is clamped to 0.1 by the frame loop
 * but ZOOM_RATE * 0.1 is 1.6, and without the clamp a single long frame would
 * carry the ramp 60% *past* the target and then oscillate back.
 */
export function stepZoom(zoom, want, dt) {
  return zoom + ((want ? 1 : 0) - zoom) * Math.min(1, ZOOM_RATE * dt);
}

/**
 * What to multiply mouse look by at this fov, so a given movement of the hand
 * still slides the picture by the same fraction of the screen.
 *
 * The ratio of the *tangents*, not of the angles. What a mouse movement is
 * worth is how far it drags the image, and the image lives on the tangent
 * plane. The angle ratio is the version that looks obviously right and is not:
 * measured against "does the same flick sweep the same fraction of the screen",
 * it comes out 15% fast at full zoom, where this comes out 0.5% — and 15% is
 * enough to make aiming feel broken rather than merely mistuned. At 22 against
 * 75 this is 0.2533.
 */
export function lookScaleFor(fov, baseFov) {
  const t = (deg) => Math.tan(deg * Math.PI / 360);
  return t(fov) / t(baseFov);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _aim = new THREE.Vector3();
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
    /**
     * The skill tree, if there is one. Optional for the same reason `water` and
     * `mobs` are: this class is built before the game around it, and a Player
     * with nothing attached still has to walk, sprint and fall properly. Every
     * read below is written so that `null` gives exactly the numbers this file
     * used before the tree existed.
     * @type {import('../game/Skills.js').Skills|null}
     */
    this.skills = null;
    this.headInWater = false;
    /** feet in hot spring water — see the tuff test in `update` */
    this.inSpring = false;
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
    // Overwritten every frame from the skill tree once one exists; this is what
    // a player with no Skills instance gets. Keep it equal to REACH_BASE in
    // Skills.js — the two are separate constants and drifting apart would mean
    // learning the first level of Reach silently changed your arm by more or
    // less than the half block it advertises.
    this.reach = 3.0;
    this.walkTimer = 0;
    this.lastStepDist = 0;
    this.swingT = 1;             // arm swing, 0..1
    this.onStep = null;
    this.onLand = null;
    this.onHurt = null;
    this.moveAmount = 0;
    /**
     * How far the camera ended up behind (or in front of) the eye this frame,
     * after the terrain pull-in. 0 means first person — or a third-person view
     * that had to give up because there was nowhere to put the camera. The body
     * model reads this to decide whether it can be drawn without the camera
     * ending up inside its head.
     *
     * It is 0 from the *instant* the view gives up rather than when the camera
     * finishes sliding home, because the two questions are different: where to
     * put the camera is a position that may be eased, and whether the body can
     * be drawn is a decision that has already been taken. Easing the published
     * distance instead would draw the body for the tenth of a second the
     * collapse takes, at exactly the range where it is nothing but a head.
     */
    this.cameraDist = 0;
    /**
     * The boom's own state: the eased distance the camera is actually at, and
     * whether third person has given up for now. Both live across frames — see
     * `updateCamera`, where they are the difference between a camera that
     * settles and one that chatters against a slope.
     */
    this._camD = 0;
    this._camGive = false;
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
    // Arriving somewhere is not falling. `fallStart` is only ever cleared
    // inside `update`, and `update` does not run while you are dead — so it
    // froze at whatever it held when you died and was still there on the
    // first frame after respawning. Die past the top of any hop on a mountain,
    // respawn at a bed by the sea, and the game billed you for the altitude
    // difference: enough to kill you again on arrival and spill the inventory
    // you had just come back for.
    this.fallStart = null;
    this._sync();
    const ref = Math.abs(this.up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.forward.copy(ref).sub(_a.copy(this.up).multiplyScalar(ref.dot(this.up))).normalize();
    this.pitch = -0.08;
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
   * The worst CONTACT_HURT among the blocks the body is actually pressed
   * against, or 0 — which is what it is almost always.
   *
   * "Touching" has to mean touching. Collision leaves the box flush against
   * whatever stopped it with only SKIN (1e-4 of a cell) to spare, so the test is
   * the ordinary box overlap grown by TOUCH — a centimetre and a half, wide
   * enough to survive the bisection in _contactI leaving you a hair short of the
   * wall, far too narrow to reach a cactus you are merely standing near. A whole
   * cell of slack was the other option and it is wrong: it charges you for
   * walking down the aisle *between* two cacti without brushing either.
   *
   * Grown on all six sides, so standing on top of one counts. That is the
   * Minecraft behaviour and it is the one that matches what you can see — your
   * feet are in the spines.
   *
   * The caller decides how often to ask; this is a query about right now and it
   * has no timer of its own. Mobs can use it the same way once something wants
   * to: nothing here is about the player except the box it reads.
   */
  contactHurt(height = this.crouching ? HEIGHT - 0.35 : HEIGHT) {
    const p = this.planet;
    const c = this.cell;
    let f = c.f, ai = c.ci, aj = c.cj;
    if (ai < 0 || ai >= F || aj < 0 || aj >= F) {
      _nc.f = f; _nc.ci = ai; _nc.cj = aj; _nc.ck = c.ck;
      normalizeCell(_nc);
      f = _nc.f; ai = _nc.ci; aj = _nc.cj;
    }
    const baseI = Math.floor(ai), baseJ = Math.floor(aj);
    if (baseI < 0 || baseI >= F || baseJ < 0 || baseJ >= F) return 0;
    const baseCol = cidx(f, baseI, baseJ);
    const lo = ai - HALF_W - TOUCH, hi = ai + HALF_W + TOUCH;
    const loJ = aj - HALF_W - TOUCH, hiJ = aj + HALF_W + TOUCH;
    const loK = c.ck - TOUCH, hiK = c.ck + height + TOUCH;
    let worst = 0;
    for (let di = -1; di <= 1; di++) {
      const cLo = baseI + di;
      if (Math.min(hi, cLo + 1) - Math.max(lo, cLo) <= 0) continue;
      for (let dj = -1; dj <= 1; dj++) {
        const cLoJ = baseJ + dj;
        if (Math.min(hiJ, cLoJ + 1) - Math.max(loJ, cLoJ) <= 0) continue;
        const col = stepColumn(baseCol, di, dj);
        // One layer below the feet and one above the head: the grown box can
        // reach into either, and being stood on top of a cactus is the case
        // that lives in the layer below.
        for (let k = Math.floor(loK); k <= Math.floor(hiK); k++) {
          const bid = p.at(col, k);
          const hurt = CONTACT_HURT[bid];
          if (hurt <= worst) continue;
          const boxes = IS_SHAPED[bid]
            ? collisionBoxes(bid, p.facingAt(col, k))
            : FULL_BOX;
          for (let b = 0; b < boxes.length; b++) {
            const [bi0, bj0, bk0, bi1, bj1, bk1] = boxes[b];
            if (Math.min(hi, cLo + bi1) - Math.max(lo, cLo + bi0) <= 0) continue;
            if (Math.min(hiJ, cLoJ + bj1) - Math.max(loJ, cLoJ + bj0) <= 0) continue;
            if (Math.min(hiK, k + bk1) - Math.max(loK, k + bk0) <= 0) continue;
            worst = hurt;
            break;
          }
        }
      }
    }
    return worst;
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

    // A hot spring is the only water on the planet with tuff under it: the four
    // lake beds are mud/peat/clay/sand/gravel/slate/basalt and the seabed is
    // sand and gravel, so three block reads identify a pool without the worker
    // having to ship the per-column water style (1.3 MB) to the main thread.
    //
    // Two reads down rather than one because the pool is two deep in the middle
    // and one on the shelf, and `feet` sits at a different k in each. One read
    // up because the *other* water that can rest on tuff is a deep aquifer lens
    // inside the granite band, where `stratum` also returns tuff — but a spring
    // is built exactly two deep, so air within two of the feet excludes it.
    // This is the same predicate `_tickSteam` uses to place the steam, which is
    // what stops the visible cue and the effect ever disagreeing.
    this.inSpring = !!feet && this.inWater && !this.inLava
      && (p.at(feet.col, feet.k - 1) === ID.tuff || p.at(feet.col, feet.k - 2) === ID.tuff)
      && p.at(feet.col, feet.k + 2) === 0;

    // ---- desired tangential velocity, expressed in cells/second ----
    // Agility scales all three gaits by the same small factor rather than only
    // the sprint. A branch that made sprinting faster and walking no faster
    // would be a branch that punishes you for being in a cave, where there is
    // nowhere to sprint; and the crouch has to keep its ratio to the walk or
    // sneaking along a ledge stops feeling like the same action.
    let speed = (this.crouching ? 2.0 : this.sprinting ? 6.8 : 4.4)
      * (this.skills?.speedScale ?? 1);
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
      // Agility buys the blocks you fall for free; tolerance softens what is
      // left of the ones you do not. Both are read through `skills`, and with
      // no tree attached this is exactly the arithmetic it always was.
      const free = this.skills?.fallFree ?? FALL_FREE;
      if (drop > free && !this.inWater) {
        // Soaked *before* rounding, so a level of tolerance can turn a 1-point
        // scrape into nothing rather than being rounded straight back up.
        //
        // Still applied here rather than routed out to main's `_takeHit`, which
        // was the other way to soak it. `_takeHit` exists to give a blow its
        // immunity window, its knockback and its named killer, and a fall wants
        // none of the three — it cannot gang up, it already shoved you, and
        // `onHurt` below is what names it. What it was actually missing was the
        // damage reduction, and that is what it now has.
        const raw = (drop - free) * FALL_PER_BLOCK;
        const dmg = Math.round(this.skills ? this.skills.soak(raw, 'fall') : raw);
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

    // Only the drain is scaled, never the recovery. Both would have been the
    // obvious move and it doubles the effect of every level while making the
    // branch impossible to describe in one line — endurance is how long you can
    // keep going, and 8% a level off the drain already says that.
    if (this.sprinting && tanSpeed > 3) {
      this.stamina = Math.max(0, this.stamina - dt * 0.055 * (this.skills?.staminaScale ?? 1));
    } else this.stamina = Math.min(1, this.stamina + dt * 0.12);

    // The arm labours when the water does. A penalty the player cannot see is
    // indistinguishable from a bug in the mining code, and this is the channel
    // that costs nothing to read: main.js re-swings the moment this reaches 1,
    // so the whole cadence of digging — arm, particles, the dig sound — slows
    // together with the timer.
    //
    // The square root, not the drag itself: at 9× a full swing would take two
    // and a half seconds and read as the animation having frozen. √9 = 3 gives
    // a stroke about every nine tenths of a second, which is roughly one swing
    // per block of wet sand — laboured, and still obviously alive.
    if (this.swingT < 1) {
      this.swingT = Math.min(1, this.swingT + dt * 3.4 / Math.sqrt(this.miningDrag));
    }
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

  /**
   * A world tangential vector as (i, j) components in this frame — the public
   * face of the solve above.
   *
   * The minimap needs it. That map is drawn on a grid of column offsets, i.e.
   * in cell space, so "which way on the map is the player facing" and "where on
   * its rim does north sit" are both this question. Going through the Gram
   * solve rather than a pair of dot products matters here for the same reason
   * it matters for movement: ea and eb are not orthogonal away from a face
   * centre, and a plain projection skews the answer by up to a few degrees near
   * a cube corner — visible as a map that is subtly rotated off the way you are
   * looking, which is worse than no map.
   */
  tangentToCell(v, out = { i: 0, j: 0 }) {
    return this._toCellVelocity(v.x, v.y, v.z, out);
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

  /**
   * How much slower the world makes you swing right now: 1 on dry land.
   *
   * Two conditions, one number, applied once each — a rule you can state in a
   * sentence and therefore learn from playing:
   *
   *   head under water   ×3   the swing is dragging water the whole way down
   *   adrift in water    ×3   there is nothing under your feet to push against
   *
   * so a diver standing on the seabed is 3× slower and one treading water above
   * it is 9×. Minecraft's are 5 and 5 for a total of 25; three is the number
   * Items.js already chose for water and the reasoning there holds for both
   * halves — 25 puts a single block of stone past a whole lungful, which stops
   * being a rule and starts being a wall. Nine leaves a breath at the seabed
   * worth roughly four blocks of stone with a stone pick standing, or one
   * floating, which is exactly the decision this is for: sink, or drain it.
   *
   * The float half is deliberately gated on being *in water* rather than on
   * `grounded` alone. A jump lasts about four tenths of a second and you take
   * your weight into the swing with you; buoyancy lasts as long as you like and
   * does not. Taxing a jumping builder on dry land would be a different game.
   *
   * Lungs is the aqua-affinity node and it did not need inventing: it is
   * already the diver branch, already behind agility, and its own note in
   * Skills.js says it exists to make the seabed "a place you can work". Each
   * level takes a quarter off the water half only, 3.0 down to 2.0 at lungs 4.
   * It never touches the float half, so standing on the bed stays worth its
   * full 3× no matter how deep the tree goes — the skill buys you a better
   * swing, not permission to stop diving.
   */
  get miningDrag() {
    let d = 1;
    if (this.headInWater) {
      d *= Math.max(1, UNDERWATER_MINING - 0.25 * (this.skills?.level?.lungs ?? 0));
    }
    // `inWater` is true in lava as well — that is what gives lava its wading
    // physics — so it is excluded by name, the same way `headInWater` excludes
    // it. Burning to death is punishment enough without a mining tax.
    if (this.inWater && !this.inLava && !this.grounded) d *= UNDERWATER_MINING;
    return d;
  }

  swing() { this.swingT = 0; }

  // --- camera ---------------------------------------------------------------

  /**
   * @param {number} view VIEW_FIRST / VIEW_BACK / VIEW_FRONT. Only the camera
   *   moves: `eye`, `lookDir` and therefore reach, mining and the crosshair are
   *   unchanged in every mode — you interact from the body, not from wherever
   *   the camera happens to have been pushed to.
   * @param {number} zoom 0..1, already eased by the caller — see `stepZoom`.
   */
  updateCamera(camera, dt, baseFov, allowBob = true, view = VIEW_FIRST, zoom = 0) {
    const targetEye = this.crouching ? CROUCH_EYE : EYE;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, 12 * dt);

    const right = _c.copy(this.forward).cross(this.up).normalize();
    this.lookDir.copy(this.forward).multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(this.up, Math.sin(this.pitch)).normalize();

    this.eye.copy(this.position).addScaledVector(this.up, this.eyeHeight - this.stepOffset);
    // Head bob is a first-person effect and only a first-person effect. Applied
    // to a camera three and a half cells out it stops reading as footfalls and
    // starts reading as a handheld shot of someone else walking.
    const b = allowBob && view === VIEW_FIRST ? this.bobAmount : 0;
    if (b > 0.001) {
      this.eye.addScaledVector(this.up, Math.sin(this.bob * 2) * 0.042 * b);
      this.eye.addScaledVector(right, Math.cos(this.bob) * 0.05 * b);
    }

    // The fov is settled *before* the boom, not after, because the boom's
    // give-up threshold is derived from it — see BODY_MAX_FRAC. Drawing a bow
    // narrows the view in every mode, and a floor that did not follow it would
    // let the body swell by a sixth at exactly the moment you are aiming.
    //
    // The sprint kick is faded out as the zoom comes in rather than added to
    // it. Six degrees on a 75-degree view is a lean forward; the same six on a
    // 22-degree one is a 27% error in the magnification, and you can be
    // sprinting the moment you raise the glass.
    const targetFov = THREE.MathUtils.lerp(baseFov + this.fovBoost * 6, ZOOM_FOV, zoom);
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, 8 * dt);
      camera.updateProjectionMatrix();
    }

    const camPos = _a.copy(this.eye);
    // Where the camera would like to be, as an offset from the eye — and where
    // it is allowed to be, after the world has had its say.
    //
    // Everything below is built in the player's own tangent frame: `this.up`
    // and `right`. On a sphere those are the only "up" and "sideways" there
    // are, and world +Y is up at exactly one point on the planet.
    this.cameraDist = 0;
    if (view === VIEW_FIRST) {
      this._camD = 0;
      this._camGive = false;
      _aim.copy(camPos).add(this.lookDir);
    } else {
      const back = view === VIEW_BACK;
      // The boom's own elevation, which is the look pitch only until the look
      // pitch would bury it. See CAM_DEPRESS.
      const elev = back ? Math.min(this.pitch, CAM_DEPRESS) : Math.max(this.pitch, -CAM_DEPRESS);
      _v3.copy(this.forward).multiplyScalar(Math.cos(elev))
        .addScaledVector(this.up, Math.sin(elev))
        .multiplyScalar(back ? -1 : 1);
      // The whole offset, boom and shoulder together, as one vector. Marching
      // *it* rather than the boom alone is what keeps the pull-in honest: the
      // camera slides along this line toward the eye, so the lift and the side
      // step shrink with the distance and cannot push it into the wall the
      // boom just backed away from.
      _v4.copy(_v3).multiplyScalar(THIRD_DIST)
        .addScaledVector(this.up, CAM_LIFT)
        .addScaledVector(right, CAM_SIDE);
      const len = _v4.length();
      _v4.multiplyScalar(1 / len);
      // March the world and stop short of the first solid thing. Without this
      // the camera happily sits inside the hillside you are standing against
      // and you are looking at the inside of the terrain — the standard failure
      // of a fixed-offset third-person camera, and `planet.raycast` is exactly
      // the tool for it. Liquids are deliberately not hit: swimming would
      // otherwise slam the camera to the surface every stroke, and the
      // underwater post pass already sells being submerged.
      const hit = this.planet.raycast(this.eye, _v4, len + CAM_PAD);
      const avail = hit ? Math.max(0, Math.min(len, hit.dist - CAM_PAD)) : len;

      // How close the camera may sit before the body stops being a body and
      // becomes a head filling the frame. Inverted from the fov, so it is right
      // at 75 degrees, while sprinting, and with a bow drawn.
      const minD = Math.max(CAM_MIN_LO,
        HEIGHT / (2 * BODY_MAX_FRAC * Math.tan(camera.fov * Math.PI / 360)));
      if (this._camGive) { if (avail >= minD * CAM_RESUME_K) this._camGive = false; }
      else if (avail < minD) this._camGive = true;

      const want = this._camGive ? 0 : avail;
      if (want < this._camD) {
        // Straight to it when a wall arrives, eased only for the collapse — the
        // one shrink that moves away from the thing that caused it.
        this._camD = this._camGive
          ? Math.max(want, this._camD - CAM_COLLAPSE_RATE * dt)
          : want;
      } else {
        this._camD += (want - this._camD) * Math.min(1, CAM_OUT_RATE * dt);
      }
      camPos.addScaledVector(_v4, this._camD);
      this.cameraDist = this._camGive ? 0 : this._camD;
      // Aim along the look axis rather than at the head. With the camera on
      // that axis the two are identical — which is what they were before the
      // shoulder offset existed — but once it is off the axis, aiming at the
      // head swings the whole picture toward the body every time the camera
      // pulls in, and what you are looking at slides off the screen. A fixed
      // point out along the look direction keeps the view pointing where the
      // player is pointing, whatever the boom had to do.
      _aim.copy(this.eye).addScaledVector(this.lookDir, back ? THIRD_DIST : -THIRD_DIST);
    }
    camera.position.copy(camPos);
    _m.lookAt(camPos, _aim, this.up);
    camera.quaternion.setFromRotationMatrix(_m);
    if (b > 0.001) camera.rotateZ(Math.cos(this.bob) * 0.011 * b);
  }
}
