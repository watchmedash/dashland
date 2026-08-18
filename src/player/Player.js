// Player controller.
//
// One gravity, everywhere. See NINE-FACES.md section 3. The map is flat and
// wraps on x and y, so a cell is a unit cube, world space IS cell space, and
// the whole per-face frame machinery the cube needed is gone: no `viewUp`, no
// tangent frame, no velocity rotation, no crossing, no normalisation. Up is
// `(0, 1, 0)` and it is a constant.
//
// The axis convention is Grid.js's and only Grid.js's:
//
//   map x  -> world X
//   layer k -> world Y, up is +Y
//   map y  -> world Z
//
// `this.position` is the authoritative body position, in world space, at the
// FEET, with X and Z wrapped onto the map. `this.cell` is the integer cell it
// is in and is derived from it every frame - see `_sync`.

import * as THREE from 'three';
import { GRAVITY, FACE_ROLE, FACE_PHYSICS } from '../world/Constants.js';
import {
  W, D, wrap, delta, colIndex, faceAt, cellOf, isWall, isSealed, portalHop, wallExit,
} from '../world/Grid.js';
import {
  IS_SOLID, IS_SHAPED, IS_LADDER, IS_FENCE, IS_GATE, ID, collisionBoxes, isPassable,
  CONTACT_HURT, CONTACT_POISON, SINK, SINK_BUOYANT, GRIP,
} from '../world/Blocks.js';
// Imported rather than re-declared so there is exactly one "how much slower is
// water" number in the game. Items.js owns it, Skills.js quotes it in prose
// ("three times slower"), and `miningDrag` below is the only thing that applies
// it. Items.js imports Blocks.js and nothing else, so this is not a cycle.
import { UNDERWATER_MINING } from '../game/Items.js';

/** The extent of an ordinary full block, so the shaped path stays branch-free. */
const FULL_BOX = [[0, 0, 0, 1, 1, 1]];

/** Scratch for `Grid.portalHop`, which is asked every frame. */
const _pAxis = { axis: 0, dx: 0, dy: 0, span: 1, near: 0 };

/**
 * What the face you are standing on does to the body.
 *
 * Keyed by the face LABEL from `Grid.faceAt`, which is what `FACE_ROLE` is
 * indexed by now: a face is a region of one flat map, not a side of a solid,
 * and nothing about gravity comes out of this table any more. It is speed,
 * jump height, stamina and fog, which are gameplay and stay.
 */
const physicsAt = (x, y) => FACE_PHYSICS[FACE_ROLE[faceAt(x, y)]] || FACE_PHYSICS[0];

const EYE = 1.62;
/**
 * Standing height of the collision box, in cells. Exported because the player's
 * body model is scaled to it — a rig measured at its own rest height and then
 * fitted to this number stands exactly as tall as the thing that collides.
 */
export const HEIGHT = 1.8;
/**
 * Half-width of the collision box, in cells.
 *
 * A cell is a unit cube everywhere now, so this is a plain constant and there
 * is nothing left to derive it from. It was one on the cube too, for a reason
 * worth keeping: deriving it from a world radius made the box shrink as the
 * player climbed.
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
/** Stamina you need back before a spent sprint can start again — about 1.2s. */
const SPRINT_RESUME = 0.15;

/**
 * Nourishment below which every gait starts to taper. Half the bar, which is
 * the number that was asked for, and it is also where the meter has already
 * been on screen for a while: the HUD reveals the row the moment energy leaves
 * full, so by the time this bites the player has been looking at it.
 *
 * Above this, nothing here does anything at all. That matters more than the
 * penalty does — energy sits above 0.5 for the first half of every stretch
 * between meals, so most of play must be bit-for-bit what it was.
 */
const ENERGY_TIRED = 0.50;
/**
 * Nourishment below which sprinting is refused outright.
 *
 * No hysteresis pair like SPRINT_RESUME above, and it does not need one: energy
 * only ever falls while you are moving (main's `_tickVitals` drains it), and the
 * two things that put it back are eating, which is a jump of at least 0.06, and
 * a hot-spring soak, which is gated on standing still. So there is no frame
 * where refusing the sprint makes energy go back up, which is exactly the
 * feedback loop the stamina gate had to be split in two to break.
 */
const ENERGY_NO_SPRINT = 0.15;
/**
 * What fraction of normal speed an empty bar leaves you with.
 *
 * 0.70 puts a starving walk at 4.4 * 0.70 = 3.08 cells/s. Chosen against the
 * two gaits either side of it: it is a clear third off the 4.4 walk, so it
 * reads as dragging, and it is still half again the 2.0 crouch, so being
 * starving never feels like being permanently stuck in sneak. Lower than this
 * and crossing a plain to reach food stops being a journey and becomes a
 * punishment, on top of the -1 health per 8s starvation already costs.
 */
const ENERGY_FLOOR = 0.70;

/**
 * Free fall, in blocks. Nothing adds to it any more.
 *
 * The Agility branch used to buy 0.4 a level on top of it, through
 * `skills.fallFree`, which is why that field exists and starts from this same
 * 3.0. The four-bar tree does not sell it, so `fallFree` is pinned at 3.0 and
 * this is simply what every player falls for free, tree or no tree.
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
 * What fraction of your speed a sink block leaves you with.
 *
 * 0.32 puts a walk through quicksand at 4.4 * 0.32 = 1.41 cells/s — half the
 * 2.73 of swimming, and the slowest a body moves anywhere in this game. That is
 * the point: the water penalty (0.62) is a place you can cross, and this has to
 * be a place you would rather go round.
 *
 * Sprint is not exempted and does not need excluding by name. It multiplies the
 * same 0.32, so a sprint through a pool makes 2.18 cells/s — faster, and the
 * `moving` test below means it is also driving you straight to the bottom,
 * which is the trade the whole hazard is built on.
 */
const SINK_MOVE = 0.32;
/**
 * Seconds of holding still before quicksand will let you push off.
 *
 * Long enough that the reflex - thrash, then jump - does not work and you have
 * to notice that stopping is what helps. Short enough that once you have
 * noticed, the way out is immediate rather than a wait.
 */
const SINK_CALM = 0.9;
/**
 * Cells per second you rise while you hold still in a *buoyant* sink block.
 *
 * Quicksand only. A drift of powder snow has no such rate and that is the point
 * of SINK_BUOYANT: holding still in snow does nothing at all.
 *
 * Deliberately slower than any block's `sink` rate. That asymmetry IS the
 * hazard: at quicksand's 0.9 down against 0.55 up, a second of struggling costs
 * you a second and a half of standing still, so a player who panics loses
 * ground and a player who stops gets it back. Both directions are alive, so
 * there is never a frame where the pool has you and nothing you can do matters,
 * which is the line between a hazard and a bug report.
 *
 * It also has to be strong enough that being caught is never permanent with
 * nothing in hand. Measured with no equipment, from the floor of a two-deep
 * pool: 2.1s of holding nothing floats the feet back to the rim.
 */
const SINK_RISE = 0.55;
/**
 * How fast the vertical rate converges on whichever of the two it is aiming
 * for, per second.
 *
 * Not instant, and not for smoothness. It is what makes the shuffle out of a
 * pool a rhythm the player can feel: a tap of forward does not put the body at
 * full sink speed, so short steps cost less depth than long ones and learning
 * that is learning how to get out. 9/s settles in about a third of a second.
 */
const SINK_RATE_LERP = 9;
/**
 * Cells per second you haul yourself up the side of a *non-buoyant* sink block
 * — a drift of powder snow — while your steering is pressed into something you
 * cannot walk through.
 *
 * Powder snow only. It is the escape, because in a drift there is no other one:
 * you sink whatever you do, so the exit cannot be a rate that beats the sink,
 * it has to be a place. The place is the side of the hole.
 *
 * 1.6 on purpose, which is the block's own sink rate exactly. A drift takes you
 * down at 1.6 and gives you back at 1.6 once you have hold of an edge, so the
 * whole cost of falling in is the walk to the wall — and a player who reaches
 * one immediately loses only the depth they fell. Faster and the drift is a
 * dip; slower and reaching the wall stops feeling like the answer, because you
 * would still be watching the white screen for seconds after solving it.
 *
 * There is no equipment in this and nothing to aim: it is the wish direction
 * against the collision the body is already doing. See `_pressingWall`.
 */
const SINK_CLIMB = 1.6;

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
 * before the pitch limit. 0.35 rad (20 degrees) keeps the camera 0.74 cells
 * above the feet at full extension, which clears flat ground with the pad to
 * spare. Rising is not clamped — a boom that swings *up* when you look down is
 * the ordinary over-the-head view, and a ceiling is what the pull-in is for.
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
 * How large the body draws is set by the distance *and* the fov, and the fov is
 * composed from the base setting, the sprint kick, the bow's 16% narrowing and
 * the zoom. Inverting "how much of the screen is the body" gives a floor that
 * moves with all four: 1.8 / (2 d tan(fov/2)) = BODY_MAX_FRAC. At the default
 * 75 degrees that is 1.89 cells.
 */
const BODY_MAX_FRAC = 0.65;
/**
 * A floor under the floor, in cells, so a very wide fov cannot decide that a
 * camera all but touching the player's back is fine.
 */
const CAM_MIN_LO = 1.6;
/**
 * How much further than the floor the camera must be able to sit before a view
 * that gave up takes itself back.
 *
 * Hysteresis, and it is the whole of the anti-jitter argument: without it the
 * obstacle distance wandering by a hair would flip the view between third and
 * first person at frame rate. A ratio rather than a fixed gap so that it stays
 * hysteresis when the fov moves the floor.
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
 * it comes out 15% fast at full zoom, where this comes out 0.5%. At 22 against
 * 75 this is 0.2533.
 */
export function lookScaleFor(fov, baseFov) {
  const t = (deg) => Math.tan(deg * Math.PI / 360);
  return t(fov) / t(baseFov);
}

/** The one up vector, shared and never written to. */
const UP = new THREE.Vector3(0, 1, 0);

const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _aim = new THREE.Vector3();
const _hit = { depth: 0, axis: -1, push: 0 };

export class Player {
  constructor(planet) {
    this.planet = planet;
    /**
     * Authoritative position: the FEET, in world space, X and Z wrapped onto
     * the map. World space is cell space, so this is also the continuous cell
     * coordinate and there is no second copy of it to disagree.
     */
    this.position = new THREE.Vector3();
    /** World-space velocity, cells/s on every axis. */
    this.vel = { x: 0, y: 0, z: 0 };
    /** The integer cell the feet are in. Derived - see `_sync`. */
    this.cell = { x: 0, y: 0, k: 0 };
    /** Which of the nine faces that cell is labelled with, 1..9. */
    this.face = 1;
    /** decaying shove from the last blow, on the horizontal axes */
    this.knockX = 0; this.knockZ = 0; this.knockT = 0;
    /**
     * Up. A constant, on every face, forever.
     *
     * Its own vector rather than the shared `UP` because half the game reads it
     * (`particles.footDust`, `sky.setSolarTime`, the body model's basis) and a
     * shared instance would hand every one of them the same object to scribble
     * on by accident.
     */
    this.up = new THREE.Vector3(0, 1, 0);

    /** Heading, radians. `forward` is derived from it and stays horizontal. */
    this.yaw = 0;
    this.pitch = 0;
    this.forward = new THREE.Vector3(0, 0, -1);

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
    /**
     * The sink block the feet are inside, or 0. See SINK in Blocks.js.
     *
     * The id and not a boolean, because the two things that read it outside
     * this class both want to know *which*: the Game plays the block's own
     * material as the sound of going under, and the cold clock only runs in
     * powder snow.
     */
    this.inSink = 0;
    this._sinkCalm = 0;
    /** Its `SINK` rate, cached so the physics does not look the table up twice. */
    this.sinkRate = 0;
    /** Feet in the pool's top layer, which is the one place a jump works. */
    this.sinkTop = false;
    /**
     * Downward drag from a whirlpool, in cells/s², written by the Game each
     * frame and 0 everywhere else on the map.
     *
     * A field set from outside rather than something this class works out, for
     * the same reason `energy`, `water` and `skills` are: a Player built with
     * nothing attached has to move exactly as it always did, and where the
     * whirlpools are is not a question about a body. See `game/Whirlpool.js`.
     */
    this.whirlPull = 0;
    /** The funnel's horizontal drag, on the map axes. See WHIRL_SUCK. */
    this.whirlX = 0;
    this.whirlZ = 0;
    this.whirlSpin = 0;
    /**
     * Eye inside a sink block: buried, and the one state in the game where the
     * camera is inside opaque geometry on purpose. The Game turns it into a
     * full-screen tint — without one you would be looking at the inside faces of
     * the neighbouring cells, which reads as the world having fallen apart.
     */
    this.headInSink = false;
    /** feet in hot spring water — see the tuff test in `update` */
    this.inSpring = false;
    /** seconds still alight after leaving the lava */
    this.burning = 0;
    /**
     * Whether the box is against something that poisons. Written by
     * `contactHurt` on the same scan that produces the number, read by
     * `Game._tickPoison`. False on every frame but the ones spent standing in a
     * deathcap.
     */
    this.contactPoison = false;
    this.sprinting = false;
    this.crouching = false;
    this.bob = 0;
    this.bobAmount = 0;
    this.fovBoost = 0;
    this.health = 20;
    this.maxHealth = 20;
    this.stamina = 1;
    /**
     * Nourishment, 0..1, mirrored here from the Game each frame.
     *
     * Not the same meter as `stamina` and not owned by this class. Stamina is
     * the sprint budget and refills itself at 0.12/s; energy is food, it only
     * goes up when you eat, and the Game is where it lives. This field is a
     * copy so the movement code can read it without the Player having to know
     * what a Game is — same reason `skills` and `water` are set from outside.
     *
     * Defaults to 1 so a Player built with nothing attached moves at exactly
     * the speeds this file used before nourishment governed anything.
     */
    this.energy = 1;
    this.fallStart = null;
    this.onLadder = false;
    /**
     * World-space direction you must push to be leaning on the ladder you are
     * touching, written by `_touchingLadder` and read by the climb. Zero when
     * there is no ladder.
     */
    this._climbX = 0; this._climbZ = 0;
    this.eyeHeight = EYE;
    this.stepOffset = 0;         // smooths the camera over 1-block step-ups
    this.autoJump = false;       // walk up a one-block ledge without jumping
    this.lookDir = new THREE.Vector3(0, 0, -1);
    this.eye = new THREE.Vector3();
    // Overwritten every frame from the skill tree once one exists; this is what
    // a player with no Skills instance gets. Keep it equal to REACH in
    // Skills.js — the two are separate constants, and now that no branch sells
    // arm length there is nothing left to hide a disagreement between them: a
    // body with a Skills instance and one without would simply have different
    // arms for ever. It was 3.0 while a Reach branch existed to sell the other
    // 1.5 back.
    this.reach = 4.5;
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
     * be drawn is a decision that has already been taken.
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
    /**
     * The last position whose column was NOT a divider.
     *
     * The whole of how a portal knows which way to send you. It is a remembered
     * position rather than a direction on purpose: a heading can be turned
     * mid-step and an input can be released, but where you were standing a
     * frame ago cannot be argued with, so walking in backwards works. See
     * `_portalTransit`.
     */
    this._freeX = 0; this._freeZ = 0;
    /** Fired on a transit, so the Game can play it. */
    this.onPortal = null;

    this._updateForward();
    this._sync();
  }

  // --- placement ------------------------------------------------------------

  /**
   * Stand the body on top of layer `k` of a column.
   *
   * `col` is a `Grid.colIndex`, so there is no face to unpack out of it any
   * more and no chance of unpacking it the wrong way round.
   */
  spawnAtColumn(col, k) {
    const y = col % W;
    const x = (col - y) / W;
    this.position.set(x + 0.5, k + 1.02, y + 0.5);
    this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
    // Arriving somewhere is not falling. `fallStart` is only ever cleared
    // inside `update`, and `update` does not run while you are dead — so it
    // froze at whatever it held when you died and was still there on the
    // first frame after respawning. Die past the top of any hop on a mountain,
    // respawn at a bed by the sea, and the game billed you for the altitude
    // difference: enough to kill you again on arrival and spill the inventory
    // you had just come back for.
    this.fallStart = null;
    this.pitch = -0.08;
    this._sync();
  }

  /** Put the body at a world point. Wrapping is `_sync`'s job. */
  setPosition(wx, wy, wz) {
    this.position.set(wx, wy, wz);
    this._sync();
  }

  /**
   * Is the player's box overlapping a ladder cell?
   *
   * Deliberately generous on the horizontal axes — the plate is a seventh of a
   * cell thick, and requiring the box to actually touch it would mean losing
   * your grip every time you nudged the stick.
   *
   * It also records, in `_climbX`/`_climbZ`, the direction you have to push to
   * be leaning ON the ladder rather than away from it. That is what lets
   * forward climb: without a direction, "am I holding W into it" cannot be
   * asked at all, and Space was the only way up. The directions of every ladder
   * in contact are summed, so a body in the inside corner of two ladders climbs
   * on either of the two ways of pressing into the corner.
   */
  _touchingLadder(height) {
    const p = this.planet;
    this._climbX = 0; this._climbZ = 0;
    const px = this.position.x, pz = this.position.z, py = this.position.y;
    const baseX = Math.floor(px), baseZ = Math.floor(pz);
    const k0 = Math.floor(py + FOOT);
    const k1 = Math.floor(py + height - FOOT);
    let found = false;
    const fx = px - baseX, fz = pz - baseZ;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 1) continue;      // no diagonals
        const col = colIndex(baseX + dx, baseZ + dz);
        for (let k = k0; k <= k1; k++) {
          if (!IS_LADDER[p.at(col, k)]) continue;
          if (dx === 0 && dz === 0) {
            // Standing inside the ladder's own cell: the way to push is at the
            // wall it is nailed to, which is what its facing byte names.
            // 0:+x 1:-x 2:+z 3:-z, the order blockBoxes reads it in.
            const dir = p.facingAt(col, k) & 3;
            this._climbX += dir === 0 ? 1 : dir === 1 ? -1 : 0;
            this._climbZ += dir === 2 ? 1 : dir === 3 ? -1 : 0;
            found = true;
            break;
          }
          // A ladder in the next cell only holds you if you are pressed up
          // against that side of your own cell — and the way to push is simply
          // towards it.
          if ((dx === 1 && fx > 1 - LADDER_GRIP) || (dx === -1 && fx < LADDER_GRIP)
            || (dz === 1 && fz > 1 - LADDER_GRIP) || (dz === -1 && fz < LADDER_GRIP)) {
            this._climbX += dx; this._climbZ += dz;
            found = true;
          }
          break;
        }
      }
    }
    return found;
  }

  /**
   * Is the steering you asked for aimed at something the body cannot walk into?
   *
   * The grip test for the powder snow climb, and it is deliberately not a
   * second copy of `_touchingLadder`. A ladder is a specific block you have to
   * be against; the side of a drift is *whatever the hole is cut into* — the
   * snowfield beside it, the rim's own two solid layers, the mountainside it
   * drifted against — and the only thing they have in common is that the
   * collision solver already refuses to let you through them. So ask the solver
   * rather than the block table, and the climb works against every one of them
   * without naming any.
   *
   * Asked with the wish velocity rather than the actual velocity, for the
   * reason the ladder gives: pressing into a wall is exactly the case where
   * collision has already zeroed the velocity you would be reading.
   *
   * The probe is 0.35 cells ahead of the box, a shade over HALF_W. Generous on
   * purpose and generous in the same way LADDER_GRIP is: a body pinned against
   * a wall at 1.41 cells/s wanders a little, and losing the climb for a frame
   * because a nudge took you a hundredth of a cell off the face would read as
   * the drift letting go of you at random. It cannot produce a false grip in
   * open snow — 0.35 is less than half a cell, so there is nothing to catch on
   * inside a drift's own interior.
   */
  _pressingWall(height, wx, wz) {
    const n = Math.hypot(wx, wz);
    if (n < 1e-3) return false;
    const s = 0.35 / n;
    return this._blocked(
      this.position.x + wx * s, this.position.z + wz * s, this.position.y, height,
    );
  }

  /**
   * Keep the player's box out of animal bodies.
   *
   * A circle and not the oriented footprint. The footprint is a rectangle
   * turned to face the animal's heading, and resolving a box against a rotated
   * box for something this small is a lot of maths to make a cow feel very
   * slightly more cow-shaped. `radius` is the longer half-axis, so this is the
   * footprint's circumscribed circle.
   *
   * The wall wins. The push is only taken if the destination is legal, so an
   * animal cannot press you into geometry — you simply stay put and it is the
   * animal's own separation that has to give.
   *
   * Separation goes through `Grid.delta`, not through raw subtraction: a cow
   * standing across the map's wrap is a cow one step away, and a raw difference
   * would call it 1247 cells off and quietly stop pushing at the seam.
   */
  _pushOutOfMobs(height) {
    const mobs = this.mobs;
    if (!mobs) return;
    const pos = this.position;
    for (const m of mobs.list) {
      const mx = m.position.x, my = m.position.y, mz = m.position.z;
      if (pos.y >= my + m.tall || pos.y + height <= my) continue;
      const dx = delta(mx, pos.x), dz = delta(mz, pos.z);
      const need = m.radius + HALF_W;
      const d2 = dx * dx + dz * dz;
      if (d2 >= need * need) continue;
      let ux, uz;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        ux = dx / d; uz = dz / d;
      } else {
        // Dead centre — a body that spawned on top of us. Any direction will
        // do; forward is the one the player is already looking at.
        ux = this.forward.x; uz = this.forward.z;
      }
      const nx = mx + ux * need, nz = mz + uz * need;
      if (this._blocked(nx, nz, pos.y, height)) continue;
      pos.x = nx; pos.z = nz;
    }
    this._sync();
  }

  /**
   * Shove the player away from a world point — what a husk's blow feels like.
   *
   * The small upward pop matters as much as the push: without it you are shoved
   * along the ground and friction eats it immediately, and being knocked
   * backwards off a ledge is the whole reason not to fight beside one.
   *
   * The horizontal offset goes through `Grid.delta` so a blow landed across the
   * wrap shoves you away from the thing that hit you rather than straight into
   * it.
   */
  knockback(x, y, z, strength = 5.0) {
    const dx = delta(x, this.position.x);
    const dy = this.position.y - y;
    const dz = delta(z, this.position.z);
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-5) return;
    this.knockX = (dx / l) * strength;
    this.knockZ = (dz / l) * strength;
    this.knockT = KNOCK_TIME;
    // A token lift, not a hop. Airborne damping is a twelfth of ground friction,
    // so any real pop turns the shove ballistic: at 3.1 a single blow carried
    // the player four blocks, and how far depended mostly on which way the hill
    // sloped. This is just enough to break friction for a moment so the push
    // reads.
    if (this.grounded) { this.vel.y = Math.max(this.vel.y, 0.9); this.grounded = false; }
  }

  /**
   * Wrap the body onto the map and refresh the cell it is in.
   *
   * All that is left of what used to rebuild a tangent frame, rotate the
   * velocity into it and roll the camera. Gravity does not turn, so nothing
   * about the body depends on where on the map it stands.
   */
  _sync() {
    this.position.x = wrap(this.position.x);
    this.position.z = wrap(this.position.z);
    cellOf(this.position.x, this.position.y, this.position.z, this.cell);
    this.face = faceAt(this.cell.x, this.cell.y);
    // The near side of any divider stepped into next. Written here rather than
    // at the end of `update` so that a body placed by `setPosition` — a spawn,
    // a load, a respawn — has one from its first frame.
    /**
     * The last standing place whose WHOLE FOOTPRINT was clear of a divider.
     *
     * This tested the centre cell only, and that is what made a refused
     * crossing a trap. Transit fires on CONTACT - the frame a shoulder first
     * touches the plane - so the centre is still outside the wall at that
     * moment and this kept writing the touching position down as safe. When a
     * corner or a sealed-to-sealed join then refused, `_ejectFromPortal` put
     * the body back exactly where it already was, it touched again on the next
     * frame, and it refused again: a body pinned against a divider it cannot
     * pass and cannot back away from. "I just got stuck inside a portal."
     *
     * Testing the four corners of the box means the remembered spot is always
     * one the body can stand in with nothing of it in the wall, so an eject
     * genuinely moves it clear.
     */
    if (!this._touchingWall(this.position.x, this.position.z)) {
      this._freeX = this.position.x; this._freeZ = this.position.z;
    }
  }

  /** Rebuild `forward` from `yaw`. Horizontal, unit, and yaw 0 is -Z. */
  _updateForward() {
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  look(dx, dy, sensitivity, invertY) {
    this.yaw -= dx * sensitivity;
    // Kept in a turn of itself so a long session cannot drift the angle into
    // the range where the sine loses digits.
    const TAU = Math.PI * 2;
    this.yaw = ((this.yaw % TAU) + TAU) % TAU;
    this._updateForward();
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + (invertY ? dy : -dy) * sensitivity,
      -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02,
    );
  }

  // --- collision ------------------------------------------------------------

  /** Does the AABB at this world position overlap solid geometry? */
  _blocked(x, z, y, height) {
    return this._overlap(x, z, y, height, null);
  }

  /**
   * Core box/solid test.
   *
   * When `hit` is supplied it comes back describing the deepest overlapping
   * cell and the *shallowest* way out of it, so a caller can push the player
   * out the short way.
   *
   * There is no seam case and no off-face case. `colIndex` wraps, so a box
   * straddling x = 0 tests the columns at W-1 exactly as it tests any other
   * neighbour, and the arithmetic below stays in unwrapped local coordinates
   * where the overlaps are ordinary subtractions.
   */
  _overlap(x, z, y, height, hit) {
    const p = this.planet;
    const baseX = Math.floor(x), baseZ = Math.floor(z);
    const k0 = Math.floor(y + FOOT);
    const k1 = Math.floor(y + height - FOOT);
    // A fence is the one block taller than its own cell, so the cell below the
    // feet can still hold something the body is standing inside. Without this
    // extra layer you could jump a fence by clearing one block instead of the
    // one and a half it stands.
    const kLow = k0 - 1;
    if (hit) { hit.depth = 0; hit.axis = -1; hit.push = 0; }
    let found = false;

    for (let dx = -1; dx <= 1; dx++) {
      const lo = baseX + dx, hi = lo + 1;
      const ovX = Math.min(x + HALF_W, hi) - Math.max(x - HALF_W, lo);
      if (ovX <= 0) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const loz = baseZ + dz, hiz = loz + 1;
        const ovZ = Math.min(z + HALF_W, hiz) - Math.max(z - HALF_W, loz);
        if (ovZ <= 0) continue;
        const col = colIndex(lo, loz);
        for (let k = kLow; k <= k1; k++) {
          const bid = p.at(col, k);
          if (!IS_SOLID[bid]) continue;
          // The extra layer below is only ever about fences: everything else
          // ends at its own ceiling and was already answered for by cell k0.
          // A shut gate is a fence — `collisionBoxes` gives it the same 1.5 —
          // so it needs the same extra layer, or the half cell of fence that
          // stands proud of its own cell would be there along a run and missing
          // at the gate, which is a sprint-height gap in the one place a pen
          // has a doorway.
          if (k < k0 && !IS_FENCE[bid] && !IS_GATE[bid]) continue;
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
          for (let b = 0; b < boxes.length; b++) {
            const [bx0, bz0, bk0, bx1, bz1, bk1] = boxes[b];
            const bLoX = lo + bx0, bHiX = lo + bx1;
            const bLoZ = loz + bz0, bHiZ = loz + bz1;
            const bOvX = Math.min(x + HALF_W, bHiX) - Math.max(x - HALF_W, bLoX);
            if (bOvX <= 0) continue;
            const bOvZ = Math.min(z + HALF_W, bHiZ) - Math.max(z - HALF_W, bLoZ);
            if (bOvZ <= 0) continue;
            const kLo = k + bk0, kHi = k + bk1;
            const ovK = Math.min(y + height, kHi) - Math.max(y, kLo);
            if (ovK <= 0) continue;
            found = true;
            if (!hit) return true;
            const depth = Math.min(bOvX, bOvZ, ovK);
            if (depth <= hit.depth) continue;
            hit.depth = depth;
            if (depth === bOvX) {
              hit.axis = 0;
              hit.push = (x < (bLoX + bHiX) * 0.5 ? -1 : 1) * (bOvX + SKIN);
            } else if (depth === bOvZ) {
              hit.axis = 1;
              hit.push = (z < (bLoZ + bHiZ) * 0.5 ? -1 : 1) * (bOvZ + SKIN);
            } else {
              hit.axis = 2;
              hit.push = (y + height * 0.5 < (kLo + kHi) * 0.5 ? -1 : 1) * (ovK + SKIN);
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
   * enough to survive the bisection in _contactX leaving you a hair short of the
   * wall, far too narrow to reach a cactus you are merely standing near. A whole
   * cell of slack was the other option and it is wrong: it charges you for
   * walking down the aisle *between* two cacti without brushing either.
   *
   * Grown on all six sides, so standing on top of one counts. That is the
   * Minecraft behaviour and it is the one that matches what you can see — your
   * feet are in the spines.
   */
  contactHurt(height = this.crouching ? HEIGHT - 0.35 : HEIGHT) {
    // Cleared up front rather than at each `return`, so a bail-out cannot leave
    // last frame's answer standing. A stale `true` here is a player being
    // poisoned by a mushroom they have already walked away from.
    this.contactPoison = false;
    const p = this.planet;
    const px = this.position.x, py = this.position.y, pz = this.position.z;
    const baseX = Math.floor(px), baseZ = Math.floor(pz);
    const lo = px - HALF_W - TOUCH, hi = px + HALF_W + TOUCH;
    const loZ = pz - HALF_W - TOUCH, hiZ = pz + HALF_W + TOUCH;
    const loK = py - TOUCH, hiK = py + height + TOUCH;
    let worst = 0;
    let poison = false;
    for (let dx = -1; dx <= 1; dx++) {
      const cLo = baseX + dx;
      if (Math.min(hi, cLo + 1) - Math.max(lo, cLo) <= 0) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const cLoZ = baseZ + dz;
        if (Math.min(hiZ, cLoZ + 1) - Math.max(loZ, cLoZ) <= 0) continue;
        const col = colIndex(cLo, cLoZ);
        // One layer below the feet and one above the head: the grown box can
        // reach into either, and being stood on top of a cactus is the case
        // that lives in the layer below.
        for (let k = Math.floor(loK); k <= Math.floor(hiK); k++) {
          const bid = p.at(col, k);
          const hurt = CONTACT_HURT[bid];
          const pois = CONTACT_POISON[bid];
          // Two reasons to look at a cell now, and a cell is worth the box test
          // if it can improve *either* answer. The old single test was
          // `hurt <= worst`, which would have skipped every deathcap in the
          // world: they carry no `hurt` at all, so a poison block could never
          // beat a `worst` of zero and the box test would never run on one.
          if (hurt <= worst && !(pois && !poison)) continue;
          const boxes = IS_SHAPED[bid]
            ? collisionBoxes(bid, p.facingAt(col, k))
            : FULL_BOX;
          for (let b = 0; b < boxes.length; b++) {
            const [bx0, bz0, bk0, bx1, bz1, bk1] = boxes[b];
            if (Math.min(hi, cLo + bx1) - Math.max(lo, cLo + bx0) <= 0) continue;
            if (Math.min(hiZ, cLoZ + bz1) - Math.max(loZ, cLoZ + bz0) <= 0) continue;
            if (Math.min(hiK, k + bk1) - Math.max(loK, k + bk0) <= 0) continue;
            if (hurt > worst) worst = hurt;
            if (pois) poison = true;
            break;
          }
        }
      }
    }
    // The second answer, written to a field rather than returned beside the
    // first. Every caller of this — `_tickContact` and `Mobs` — wants the number
    // and only the number, and changing the return type to a pair would have
    // meant an allocation per body per frame for a fact that is false almost
    // always. `contactPoison` is read by `_tickPoison` on the same frame the
    // number is read by `_tickContact`, which is the only ordering that matters.
    this.contactPoison = poison;
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
    const pos = this.position;
    let moved = false;
    for (let n = 0; n < 8; n++) {
      if (!this._overlap(pos.x, pos.z, pos.y, height, _hit) || _hit.axis < 0) break;
      moved = true;
      if (_hit.axis === 0) {
        pos.x += _hit.push;
        if (this.vel.x * _hit.push < 0) this.vel.x = 0;
      } else if (_hit.axis === 1) {
        pos.z += _hit.push;
        if (this.vel.z * _hit.push < 0) this.vel.z = 0;
      } else {
        pos.y += _hit.push;
        if (_hit.push > 0) { this.grounded = true; this.vel.y = Math.max(0, this.vel.y); }
        else this.vel.y = Math.min(0, this.vel.y);
      }
      if (!this._blocked(pos.x, pos.z, pos.y, height)) return true;
    }
    // Eight pushes and still inside: there is no legal position nearby — a gap
    // too small to occupy at all. Lift out through the top as a last resort so
    // the player can never be sealed inside the world.
    for (let n = 0; n < 6 && this._blocked(pos.x, pos.z, pos.y, height); n++) {
      pos.y = Math.floor(pos.y + FOOT) + 1 + SKIN;
      this.vel.y = Math.max(0, this.vel.y);
      this.grounded = true;
    }
    return moved;
  }

  /**
   * The highest solid surface at or just below `y` under the box's footprint.
   *
   * The landing correction used to be `Math.floor(y) + SKIN`, which assumes
   * every floor sits on a layer boundary. A slab's top is at k + 0.5, so on one
   * the player either hovered half a block up or sank into it, and `grounded`
   * never latched — which also meant no jumping. Ask the blocks where their
   * tops are instead of assuming.
   *
   * @returns {number} rest height, or -1 if there is nothing to stand on
   */
  _surfaceBelow(x, z, y) {
    const p = this.planet;
    const baseX = Math.floor(x), baseZ = Math.floor(z);
    // The feet can overlap up to four columns; the floor is the highest of them.
    let best = -1;
    for (let dx = -1; dx <= 1; dx++) {
      if (Math.min(x + HALF_W, baseX + dx + 1) - Math.max(x - HALF_W, baseX + dx) <= 0) continue;
      for (let dz = -1; dz <= 1; dz++) {
        if (Math.min(z + HALF_W, baseZ + dz + 1) - Math.max(z - HALF_W, baseZ + dz) <= 0) continue;
        const col = colIndex(baseX + dx, baseZ + dz);
        // Only the cell the feet are in and the one under it can hold the floor.
        for (let k = Math.floor(y + FOOT); k >= Math.floor(y + FOOT) - 1; k--) {
          const id = p.at(col, k);
          if (!IS_SOLID[id]) continue;
          const boxes = IS_SHAPED[id] ? collisionBoxes(id, p.facingAt(col, k)) : FULL_BOX;
          for (let b = 0; b < boxes.length; b++) {
            const [bx0, bz0, , bx1, bz1, bk1] = boxes[b];
            // Only a box actually under the feet counts. A stair's riser is at
            // the back of its cell, so standing on the low half must not snap
            // you up to the riser's top.
            if (Math.min(x + HALF_W, baseX + dx + bx1) - Math.max(x - HALF_W, baseX + dx + bx0) <= 0) continue;
            if (Math.min(z + HALF_W, baseZ + dz + bz1) - Math.max(z - HALF_W, baseZ + dz + bz0) <= 0) continue;
            const surface = k + bk1;
            if (surface <= y + FOOT + SKIN && surface > best) best = surface;
          }
        }
      }
    }
    return best < 0 ? -1 : best + SKIN;
  }

  /**
   * Would a step to (x, z) put the feet over nothing, from a place that has
   * something under them?
   *
   * The sneak rule, and the second half of it is the load-bearing half. A
   * destination with no support only counts as a step off the edge if where you
   * are standing right now HAS support - otherwise a body that got over the void
   * some other way (shoved off, spat out of a collision, standing on a block
   * that was mined out from under it with Ctrl held) would have every axis
   * refused and would hang in the air for as long as the key was down.
   *
   * Support is `_surfaceBelow` and deliberately nothing new: it is the same
   * notion of ground the landing uses, and it asks it of the whole footprint, so
   * any part of the box still over solid counts as standing. That is what lets
   * you sneak out and hang half off a ledge, which is the thing the mechanic is
   * for.
   */
  _steppingOff(x, z, y) {
    return this._surfaceBelow(x, z, y) < 0
      && this._surfaceBelow(this.position.x, this.position.z, y) >= 0;
  }

  /**
   * Bisect along x between a free position and a blocked one so the player
   * stops *touching* the wall instead of a whole sub-step short of it. Always
   * returns a position that tested clear.
   */
  _contactX(from, to, z, y, height) {
    if (this._blocked(from, z, y, height)) return from;
    let lo = from, hi = to;
    for (let n = 0; n < 6; n++) {
      const mid = (lo + hi) * 0.5;
      if (this._blocked(mid, z, y, height)) hi = mid; else lo = mid;
    }
    return lo;
  }

  /** As _contactX, along z. */
  _contactZ(from, to, x, y, height) {
    if (this._blocked(x, from, y, height)) return from;
    let lo = from, hi = to;
    for (let n = 0; n < 6; n++) {
      const mid = (lo + hi) * 0.5;
      if (this._blocked(x, mid, y, height)) hi = mid; else lo = mid;
    }
    return lo;
  }

  /**
   * How much of your normal speed a half-empty stomach leaves you, 0.70..1.
   *
   * Exactly 1 above ENERGY_TIRED, so the first half of every stretch between
   * meals is untouched, then a smoothstep down to ENERGY_FLOOR at empty.
   *
   * Smoothstep rather than a straight line because a line has a corner at the
   * threshold: you would feel the exact frame you crossed 50%, which is a
   * switch flipping, and the point is to feel yourself tiring.
   *
   * Measured, walking speed in cells/s beside the multiplier:
   *   energy 0.50 -> 1.000  (4.40 walk)   nothing has happened yet
   *   energy 0.45 -> 0.992  (4.36 walk)   below noticing
   *   energy 0.35 -> 0.935  (4.12 walk)   about a step per second down
   *   energy 0.25 -> 0.850  (3.74 walk)   unmistakable
   *   energy 0.15 -> 0.765  (3.37 walk)   sprint cuts out here, 24% down already
   *   energy 0.00 -> 0.700  (3.08 walk)
   */
  _energyScale() {
    const e = this.energy;
    if (e >= ENERGY_TIRED) return 1;
    const t = Math.min(1, (ENERGY_TIRED - e) / ENERGY_TIRED);  // 0 at threshold, 1 at empty
    const s = t * t * (3 - 2 * t);
    return 1 - (1 - ENERGY_FLOOR) * s;
  }

  /** The column the feet are over. */
  _col() {
    return colIndex(Math.floor(this.position.x), Math.floor(this.position.z));
  }

  // --- the dividers ----------------------------------------------------------

  /**
   * Step through a divider.
   *
   * **The divider IS the portal**, one column thick and filled with portal from
   * layer 0 to layer D. It is not solid, so walking at one puts your feet inside
   * it, and this is what happens next: you come out on the far side, standing on
   * the ground there, keeping your heading and your momentum.
   *
   * Three things this has to get right, and all three have failed a version of
   * this feature before.
   *
   * **Which way through is worked out from where you CAME FROM**, not from where
   * you are looking and not from where you are walking. Walk in backwards, get
   * spun round by a mob mid-step, or fall in sideways off a ledge and a rule
   * written on the yaw or on the input sends you back out the side you entered.
   * The last column the feet were in that was not a divider is the near side,
   * full stop, and the far side is the column one step beyond the divider on the
   * axis the divider is thin on. `Grid.portalHop` owns that axis.
   *
   * **A divider is not always one column thick.** Where two sealed faces touch
   * their rings sit back to back, so the step is near interior, wall, wall, far
   * interior - three columns, not two. `portalHop` reports that as a span of
   * two, and it also reports which side the body must have come from, because a
   * double wall has open ground on one side only. Those runs used to be refused
   * outright; all four sides of a sealed face are passable now, by the owner's
   * call.
   *
   * **Not every divider column is a way through.** A ring corner is walled on
   * every side and `portalHop` refuses it; a body that walks into one is put
   * back where it came from rather than being let through to somewhere it
   * should not be.
   *
   * A RING CORNER is refused by that same rule and should not be: the ring
   * turns there, so the column is walled on both axes, and the owner's report
   * is that a portal which works along the whole run stops working at its end.
   * `_cornerStep` is the second chance, and it reads the same provenance -
   * leave a corner by the axis whose far side is open ground, which by the
   * geometry `Grid.wallExit` sets out is always outward into the cross. So a
   * corner lets you out of a sealed face and never into one.
   *
   * **You are never left in rock or in the air.** This replaces falling: the
   * column you are standing in is empty of anything solid all the way to
   * bedrock, so a body that entered and was not moved through would drop the
   * full depth of the world. So the arrival seats you on the far column's real
   * surface, found by scanning the voxels rather than by trusting a height
   * field - `colHeight` is the height FIELD, and what a player stands on is
   * whatever the surface pass laid on top of it, which is a layer or two higher.
   *
   * @returns {boolean} whether a transit happened
   */
  _portalTransit(height) {
    const pos = this.position;
    /**
     * On CONTACT, not on the centre crossing over.
     *
     * This read the cell the body's centre was in, so you walked HALF_W into an
     * opaque sheet before it fired: a frame or two with the eye inside the
     * material, which is the glitch. "TP should be instant when we touch a
     * portal so no glitch."
     *
     * The box is tested instead, so the transit happens on the frame the
     * shoulder first touches the plane. The near edge is taken rather than the
     * centre: a body straddling the boundary is touching it, and the far edge
     * would fire a whole cell early while you were still clear of it.
     */
    let cx = wrap(Math.floor(pos.x)), cz = wrap(Math.floor(pos.z));
    if (portalHop(cx, cz, _pAxis) === null) {
      // The four corners of the footprint, nearest first. `Math.floor` of each
      // edge is the column that edge is in.
      const xs = [wrap(Math.floor(pos.x - HALF_W)), wrap(Math.floor(pos.x + HALF_W))];
      const zs = [wrap(Math.floor(pos.z - HALF_W)), wrap(Math.floor(pos.z + HALF_W))];
      let found = false;
      for (const tx of xs) {
        for (const tz of zs) {
          if (found || (tx === cx && tz === cz)) continue;
          if (portalHop(tx, tz, _pAxis) !== null) { cx = tx; cz = tz; found = true; }
        }
      }
      // Second choice, and only ever reached when the body is standing on open
      // ground with a corner under one shoulder: a run column beside it would
      // have been taken above, so walking along a divider still goes through
      // the run rather than being grabbed by the corner at its end.
      if (!found && !isWall(cx, cz)) {
        for (const tx of xs) {
          for (const tz of zs) {
            if (found || (tx === cx && tz === cz)) continue;
            if (this._cornerStep(tx, tz) !== null) { cx = tx; cz = tz; found = true; }
          }
        }
      }
    }
    const ax = portalHop(cx, cz, _pAxis);
    if (ax === null) {
      // Either ordinary ground - the case on almost every frame - or a divider
      // the strict rule will not read. `isWall` is the authority on which.
      if (!isWall(cx, cz)) return false;
      const corner = this._cornerStep(cx, cz);
      if (corner === null) {
        this._ejectFromPortal(height);
        return false;
      }
      return this._arrive(wrap(cx + corner.dx), wrap(cz + corner.dz), corner.dx !== 0, height);
    }

    // Where the divider's own coordinate is on the thin axis, and where the
    // body was standing before it stepped in.
    const here = ax.axis === 0 ? cx : cz;
    const from = ax.axis === 0
      ? wrap(Math.floor(this._freeX))
      : wrap(Math.floor(this._freeZ));
    let s = Math.sign(delta(here, from));
    if (ax.span === 2) {
      // A double wall reads its own near side and needs nothing from the
      // traveller: only one of its two sides is open ground, so the side you
      // came from is a fact about the column rather than a guess about you.
      // None of the fallbacks below can apply, and none of them should - they
      // would answer a question that has already been answered exactly.
      s = ax.near;
    } else {
      // The fallbacks, in order of how much they are trusted. A body that was
      // already inside the divider last frame has no near side to read, which
      // can only happen if it was put there by something other than walking - a
      // respawn, a load, a knockback across two columns in a frame.
      if (Math.abs(delta(here, from)) !== 1 || s === 0) {
        const v = ax.axis === 0 ? this.vel.x : this.vel.z;
        s = Math.abs(v) > 0.05 ? -Math.sign(v) : 0;
      }
      if (s === 0) {
        // Nothing to read at all. Put them out into the connected world rather
        // than into the sealed face: being dropped into Pyre by an ambiguity is
        // far worse than being dropped into the meadow beside it.
        const plus = ax.axis === 0 ? wrap(cx + 1) : cx;
        const plusY = ax.axis === 0 ? cz : wrap(cz + 1);
        s = isSealed(faceAt(plus, plusY)) ? 1 : -1;
      }
    }

    // From the near side: through the divider - one column, or two where two
    // rings are back to back - and out the far side.
    const step = s * ax.span;
    const fx = ax.axis === 0 ? wrap(cx - step) : cx;
    const fz = ax.axis === 0 ? cz : wrap(cz - step);
    return this._arrive(fx, fz, ax.axis === 0, height);
  }

  /**
   * The way out of a divider column the strict rule refuses, or null.
   *
   * The corner case, and it is read from the same place the run's direction is:
   * `_freeX`/`_freeZ`, the last column the feet were in that was not a divider.
   * That column is the near side, so the far side is the step the other way,
   * and `Grid.wallExit` says whether it is open ground - which at a corner
   * means the cross, and at a corner-to-corner join means nothing at all.
   *
   * A ring corner whose two runs both face the cross has two ways out. Both are
   * correct and they land one column apart, so the tie goes to the axis the
   * body is actually travelling on: you come out ahead of where you were going
   * rather than being turned through ninety degrees.
   */
  _cornerStep(cx, cz) {
    const sx = Math.sign(delta(cx, wrap(Math.floor(this._freeX))));
    const sz = Math.sign(delta(cz, wrap(Math.floor(this._freeZ))));
    const okX = sx !== 0 && wallExit(cx, cz, -sx, 0);
    const okZ = sz !== 0 && wallExit(cx, cz, 0, -sz);
    if (okX && okZ) {
      return Math.abs(this.vel.z) > Math.abs(this.vel.x)
        ? { dx: 0, dz: -sz } : { dx: -sx, dz: 0 };
    }
    if (okX) return { dx: -sx, dz: 0 };
    if (okZ) return { dx: 0, dz: -sz };
    return null;
  }

  /**
   * Put the body down on the far column, and say a transit happened.
   *
   * Only the thin axis moves. Keeping the coordinate along the divider means
   * you come out where you went in rather than being snapped to the middle of a
   * cell you were walking past.
   */
  _arrive(fx, fz, alongX, height) {
    const pos = this.position;
    if (alongX) pos.x = fx + 0.5; else pos.z = fz + 0.5;
    pos.y = this._standingHeightAt(pos.x, pos.z, height);
    // Arriving is not falling, exactly as `spawnAtColumn` says.
    this.fallStart = null;
    this.grounded = true;
    if (this.vel.y < 0) this.vel.y = 0;
    this._sync();
    this._freeX = pos.x; this._freeZ = pos.z;
    this.onPortal?.();
    return true;
  }

  /**
   * Put a body back out of a divider it may not pass through.
   *
   * The last column it stood in that was not a divider, which is one step away
   * by construction, plus the inward half of the velocity taken off so it does
   * not simply walk straight back in on the next frame.
   */
  /** Is any corner of the body's footprint in a divider column? */
  _touchingWall(x, z) {
    for (const dx of [-HALF_W, HALF_W]) {
      for (const dz of [-HALF_W, HALF_W]) {
        if (isWall(Math.floor(x + dx), Math.floor(z + dz))) return true;
      }
    }
    return false;
  }

  _ejectFromPortal(height) {
    const pos = this.position;
    pos.x = this._freeX; pos.z = this._freeZ;
    /**
     * ...and if even that is in a divider, walk out until something is not.
     *
     * `_freeX` is now only written from footprint-clear ground, so this should
     * never fire. It exists because the failure it guards against is the one
     * the player cannot recover from on their own: a body inside a sheet that
     * is solid to everything except itself, with no floor under it for eighty
     * layers. A load, a respawn, a teleport or a knockback that lands there
     * would otherwise leave the game unplayable, and the cost of the guard is
     * a handful of arithmetic on a frame that was already going wrong.
     */
    if (this._touchingWall(pos.x, pos.z)) {
      let best = null;
      for (let r = 1; r <= 4 && !best; r++) {
        for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r],
          [r, r], [-r, r], [r, -r], [-r, -r]]) {
          const nx = wrap(Math.floor(pos.x) + dx) + 0.5;
          const nz = wrap(Math.floor(pos.z) + dz) + 0.5;
          if (this._touchingWall(nx, nz)) continue;
          best = [nx, nz];
          break;
        }
      }
      if (best) { pos.x = best[0]; pos.z = best[1]; }
      pos.y = this._standingHeightAt(pos.x, pos.z, height);
      this.fallStart = null;
      this.grounded = true;
      if (this.vel.y < 0) this.vel.y = 0;
    } else if (this._blocked(pos.x, pos.z, pos.y, height)) {
      pos.y = this._standingHeightAt(pos.x, pos.z, height);
    }
    this.vel.x *= 0.2; this.vel.z *= 0.2;
    this._sync();
  }

  /**
   * Where the feet rest over a world point, in world Y.
   *
   * The voxels, top down, rather than any height field: see the note in
   * `_portalTransit`. Water is not solid, so this lands you on the bed of a sea
   * and you swim up, which is the right answer for arriving in one - the far
   * side of a divider is ordinary world and can be anything.
   */
  _standingHeightAt(wx, wz, height) {
    const p = this.planet;
    const col = colIndex(Math.floor(wx), Math.floor(wz));
    let k = D - 1;
    for (; k >= 0; k--) if (IS_SOLID[p.at(col, k)]) break;
    let y = k + 1 + SKIN;
    // Standing on it means fitting above it. A canopy, an overhang or a cave
    // roof over the arrival column would otherwise leave the head in rock.
    for (let n = 0; n < D && this._blocked(wx, wz, y, height); n++) y += 1;
    return Math.min(y, D - 2);
  }

  update(dt, input) {
    const p = this.planet;
    const pos = this.position;

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
    if (!this.crouching && this._blocked(pos.x, pos.z, pos.y, HEIGHT)) this.crouching = true;
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
    // Nourishment is a second, independent veto on top of that. Being spent and
    // being starving are different states and they are allowed to stack: an
    // empty stamina bar refills in 8s and an empty energy bar takes a meal.
    const wantsSprint = (input.down('ShiftLeft') || input.down('ShiftRight'))
      && iz > 0 && !this.crouching;
    this.sprinting = wantsSprint && this.stamina > (this.sprinting ? 0 : SPRINT_RESUME)
      && this.energy > ENERGY_NO_SPRINT;

    // ---- environment ----
    //
    // Feet and head share a column: the head is directly above the feet, and on
    // a flat map "directly above" is the same (x, z) rather than a different
    // cell on a different normal. So one column read answers both.
    const col = this._col();
    const feetK = Math.floor(pos.y);
    const headK = Math.floor(pos.y + EYE);
    // liquidAt is true for lava as well, which is what gives lava its wading
    // physics for free — but it is also why lava went unnoticed by everything
    // that asked "am I in water?". The block id is the only way to tell.
    const feetId = p.at(col, feetK);
    this.inWater = p.liquidAt(col, feetK);
    this.inLava = feetId === ID.lava;
    this.headInWater = p.liquidAt(col, headK) && !this.inLava;

    // Ground that is not ground. Read off the feet cell exactly as `inWater`
    // is, so the two answer the same question about the same cell and cannot
    // disagree about which one the body is standing in.
    //
    // Water wins where they meet, and they do meet — quicksand is impermeable
    // to the flow sim (it is not `IS_REPLACEABLE`, so `Water._canEnter` calls
    // it a wall), but a pool with a bucket emptied into it puts water in the
    // cell above and a body wading there is swimming, not sinking. Swimming is
    // the more forgiving of the two and the one the player can see.
    this.inSink = this.inWater ? 0 : (SINK[feetId] > 0 ? feetId : 0);
    this.sinkRate = SINK[this.inSink];
    this.headInSink = !this.inWater && SINK[p.at(col, headK)] > 0;
    /**
     * Feet still in the pool's top layer: there is open air directly over them.
     *
     * This is what a jump is allowed to push off, and the window is deliberately
     * about ONE cell rather than about a distance. A body sinking at quicksand's
     * 0.9 cells/s crosses that layer in a little over a second, so falling into
     * a pool gives you a second to get back out of it and no more. A drift is
     * faster (1.6, so two thirds of a second) and it is also the only chance the
     * drift gives you, because there is no floating back up in snow.
     */
    this.sinkTop = !!this.inSink && SINK[p.at(col, feetK + 1)] === 0;

    // A hot spring is the only water on the map with tuff under it: the four
    // lake beds are mud/peat/clay/sand/gravel/slate/basalt and the seabed is
    // sand and gravel, so three block reads identify a pool without the worker
    // having to ship the per-column water style to the main thread.
    //
    // Two reads down rather than one because the pool is two deep in the middle
    // and one on the shelf, and the feet sit at a different k in each. One read
    // up because the *other* water that can rest on tuff is a deep aquifer lens
    // inside the granite band, where `stratum` also returns tuff — but a spring
    // is built exactly two deep, so air within two of the feet excludes it.
    this.inSpring = this.inWater && !this.inLava
      && (p.at(col, feetK - 1) === ID.tuff || p.at(col, feetK - 2) === ID.tuff)
      && p.at(col, feetK + 2) === 0;

    // ---- desired horizontal velocity, in cells/second ----
    // Agility scales all three gaits by the same small factor rather than only
    // the sprint. A branch that made sprinting faster and walking no faster
    // would be a branch that punishes you for being in a cave, where there is
    // nowhere to sprint; and the crouch has to keep its ratio to the walk or
    // sneaking along a ledge stops feeling like the same action.
    //
    // What the face you are standing on does to you. Keyed by the face LABEL
    // from `Grid.faceAt` - see FACE_ROW - because a face is a region of the map
    // now and not a side of a solid.
    const face = physicsAt(this.cell.x, this.cell.y);
    let speed = (this.crouching ? 2.0 : this.sprinting ? 6.8 : 4.4)
      * (this.skills?.speedScale ?? 1) * this._energyScale() * face.speed;
    if (this.inWater) speed *= 0.62;
    if (this.inSink) speed *= SINK_MOVE;

    // Forward is horizontal and up is +Y, so the steering basis is two
    // constants of the yaw and there is nothing to project out.
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);   // forward x up
    const wx = (this.forward.x * iz + rx * ix) * speed;
    const wz = (this.forward.z * iz + rz * ix) * speed;

    // Footing. Ice gives you almost none of the ground's grip, so you build
    // speed slowly and keep it far too long - which is what sliding is. Held to
    // a floor of the airborne numbers rather than going to zero, or standing on
    // ice would be standing on nothing.
    const grip = this.grounded ? GRIP[this.groundBlock()] ?? 1 : 1;
    const accel = this.grounded ? Math.max(11, 42 * grip) : 11;
    if (moving) {
      const t = Math.min(1, accel * dt);
      this.vel.x += (wx - this.vel.x) * t;
      this.vel.z += (wz - this.vel.z) * t;
    } else {
      // A sink block damps harder than water and harder than the ground. Let go
      // of the keys in one and the body stops where it is rather than coasting,
      // which is what "held" feels like — and it also means holding still is a
      // clean, unambiguous input rather than a slow drift you have to wait out.
      const damp = this.inSink ? 18 : this.grounded ? Math.max(1.2, 14 * grip) : this.inWater ? 4 : 1.2;
      const f2 = Math.max(0, 1 - damp * dt);
      this.vel.x *= f2; this.vel.z *= f2;
    }

    // Being hit shoves you, and the shove wins over steering for a moment
    // before handing control back. It blends *over* the velocity rather than
    // adding to it, which is what makes it predictable: added, the result was
    // decided by how long the token upward pop kept you off the ground, and
    // airborne damping is a twelfth of ground friction. Blended, displacement is
    // simply strength × KNOCK_TIME / 2.
    if (this.knockT > 0) {
      const d = this.knockT / KNOCK_TIME;
      this.vel.x += (this.knockX - this.vel.x) * d;
      this.vel.z += (this.knockZ - this.vel.z) * d;
      this.knockT = Math.max(0, this.knockT - dt);
    }

    // Being carried by a current.
    //
    // `Water.flowAt` answers in the feet column's own two axes, `i` and `j`,
    // which ARE the map's x and y and therefore world X and Z. There is one
    // frame in the world now, so there is nothing to convert and nothing to get
    // wrong at a seam.
    //
    // Added to the velocity rather than blended over it, unlike a blow: a blow
    // is a moment and should override you, a river is a condition you swim
    // against. Blending would have pinned you to the current's speed and made
    // swimming upstream impossible, which is the exact failure this is trying
    // to avoid.
    if (this.inWater && this.water) {
      const fl = this.water.flowAt(col, feetK);
      if (fl) {
        const push = FLOW_PUSH * fl.s * dt;
        this.vel.x += fl.i * push;
        this.vel.z += fl.j * push;
        // fl.k — the plunge of a waterfall — is deliberately ignored. Dragging
        // the player down inside a falling column fights the swim-up key at the
        // bottom of the shaft, and gravity is already taking you over the lip
        // with all the horizontal speed the run-up gave you.
      }
    }

    // ---- vertical velocity ----
    // Declared here rather than at the integrate step below, because the ladder
    // test needs it first and `const` does not hoist.
    const height = this.crouching ? HEIGHT - 0.35 : HEIGHT;
    this.onLadder = !this.inWater && !this.inSink && this._touchingLadder(height);
    if (this.onLadder) {
      // Holding forward *into* the ladder climbs it, which is the whole of how
      // anyone expects a ladder to work and was the one way it did not: Space
      // was the only lift, so going up a shaft meant tapping jump all the way.
      // The test is on the steering you asked for rather than on the velocity
      // you got, because pressing into a wall is exactly the case where
      // collision has already zeroed the velocity you would be reading.
      //
      // Space still lifts, and still lifts on its own: you climb a ladder in a
      // one-block shaft by facing any of the four walls, and there is no reason
      // to make the player face the right one. Ctrl goes down, and holding
      // nothing holds you where you are — a ladder you slide off the moment you
      // stop pressing something is a rope, not a ladder.
      const into = wx * this._climbX + wz * this._climbZ;
      const up = input.down('Space') || into > 0.01;
      const climb = up ? CLIMB_SPEED : this.crouching ? -CLIMB_SPEED * 0.8 : 0;
      this.vel.y += (climb - this.vel.y) * Math.min(1, 14 * dt);
      if (this.grounded && up) this.grounded = false;
    } else if (this.inWater) {
      this.vel.y -= GRAVITY * 0.22 * dt;
      if (input.down('Space')) this.vel.y += 15 * dt;
      if (this.crouching) this.vel.y -= 9 * dt;
      // A whirlpool, and the reason it is here rather than blended over the
      // velocity is the reason a river's current is added rather than blended
      // (see FLOW_PUSH): a blow is a moment and should override you, a body of
      // water doing something is a condition you swim against. Added, the swim
      // key still works and simply loses; blended, holding Space would do
      // literally nothing, which is a wall rather than a hazard.
      if (this.whirlPull > 0 && !this.inLava) this.vel.y -= this.whirlPull * dt;
      if (!this.inLava && (this.whirlX || this.whirlZ)) {
        this.vel.x += this.whirlX * dt;
        this.vel.z += this.whirlZ * dt;
      }
      // The swirl, as a rotation of the horizontal velocity rather than a
      // tangential force. A force pumps energy in and slings you OUT - measured,
      // it made the escape faster - where a rotation keeps the speed you have
      // and only bends it. See WHIRL_SPIN.
      if (!this.inLava && this.whirlSpin) {
        const a = this.whirlSpin * dt;
        const cs = Math.cos(a), sn = Math.sin(a);
        const vx = this.vel.x, vz = this.vel.z;
        this.vel.x = vx * cs - vz * sn;
        this.vel.z = vx * sn + vz * cs;
      }
      this.vel.y *= Math.max(0, 1 - 3.2 * dt);
      this.vel.y = Math.max(this.vel.y, -5);
    } else if (this.inSink) {
      /*
       * Two hazards out of one field, and they are deliberate opposites. Which
       * one this cell is comes from SINK_BUOYANT, not from a block id.
       *
       *   - **Quicksand — struggle and you go down, hold still and you come
       *     up.**
       *   - **Powder snow — you go down whatever you do.** A drift has no
       *     buoyancy to hold still for. You sink at 1.6 until the floor of the
       *     drift stops you, head under, and the way out is to wade to the side
       *     of the hole and climb it. See SINK_CLIMB.
       *
       * Gravity is not applied at all here, and that is the load-bearing line
       * rather than an optimisation. A body accelerating under gravity through
       * a cell it does not collide with is a body that reaches 26 cells/s and
       * leaves the world through the floor; the sink rate is a *velocity*, so it
       * is terminal from the first frame and there is nothing to clamp.
       *
       * **Jump is the whole lesson, and it works in exactly one place.** With
       * the feet still in the pool's top layer it is an ordinary jump and it is
       * the way out. One layer down, with the stuff closed over your feet, it
       * is not a jump at all — it counts as struggling and it drives you
       * further under, which is the one thing a player will do by reflex when
       * the ground gives way. So the rule the pool teaches is *get back to the
       * top first, then push off*, and it teaches it by having the reflex fail
       * in a way you can immediately undo.
       *
       * **The drift's escape is the climb, and it is one condition: your
       * steering is pressed into something you cannot walk through.** It reuses
       * the collision the body is already doing (`_pressingWall`), so it is not
       * a new input, not a new key and not something to aim.
       *
       * The obvious alternative was to let Space climb, and it is the one thing
       * that must not: Space deep in quicksand counts as struggling and drives
       * you under. One key that lifts you in snow and sinks you in sand is
       * worse than either hazard on its own.
       */
      const buoyant = SINK_BUOYANT[this.inSink] === 1;
      const struggling = moving || input.down('Space');
      // Stillness is the mechanic, so stillness has to be what buys the exit.
      // The jump used to be available the instant the feet were in the top
      // layer, which meant you could walk into a pool and hop straight back out
      // without the hazard ever happening. Now the pool has to let go of you
      // first - hold still, float up, and the push-off arrives a beat later.
      //
      // Snow keeps the old rule and must: it has no buoyancy to wait for, so a
      // calm timer there would be a hazard with no exit.
      this._sinkCalm = buoyant
        ? (struggling ? 0 : this._sinkCalm + dt)
        : SINK_CALM;
      if (this.sinkTop && input.down('Space') && this._sinkCalm >= SINK_CALM) {
        this.vel.y = 8.4;
      } else if (buoyant) {
        const target = struggling ? -this.sinkRate : SINK_RISE;
        this.vel.y += (target - this.vel.y) * Math.min(1, SINK_RATE_LERP * dt);
      } else {
        // Snow. Down at the block's rate unless you have hold of a side, and
        // there is no third case: holding still is the same as anything else
        // that is not a wall, which is what "it swallows you" has to mean.
        const climbing = moving && this._pressingWall(height, wx, wz);
        const target = climbing ? SINK_CLIMB : -this.sinkRate;
        this.vel.y += (target - this.vel.y) * Math.min(1, SINK_RATE_LERP * dt);
      }
    } else {
      // The face's own pull. One everywhere but Tempest, which is a fifth —
      // see FACE_PHYSICS, which owns the number and the argument.
      //
      // Applied to the fall and NOT to the take-off, which is what makes the
      // storm face feel the way it does: the jump impulse is unchanged, so the
      // same push against a fifth of the pull carries five times as high and
      // takes about 2.2 times as long each way.
      this.vel.y -= GRAVITY * face.gravity * dt;
      if (this.grounded && input.down('Space')) {
        // sqrt of the height multiplier: height goes with the square of the
        // take-off speed. See FACE_PHYSICS.
        this.vel.y = 8.4 * Math.sqrt(face.jump);
        this.grounded = false;
      }
      // Terminal velocity scales with the pull as well, or a long drift under
      // low gravity would quietly accelerate to the same 58 as anywhere else
      // and arrive at the bottom exactly as fast.
      this.vel.y = Math.max(this.vel.y, -58 * face.gravity);
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
    const speedCells = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const steps = Math.max(1, Math.min(16, Math.ceil(speedCells * dt / 0.4)));
    const sdt = dt / steps;

    /*
     * Sneaking holds the edge, per axis.
     *
     * Per axis is the whole of what makes it feel right: refuse the step that
     * would take you off and take the one that would not, so sidling along a
     * ledge works. Cancelling both axes together is the version that reads as
     * being stuck.
     *
     * It is a walk that is stopped, not a jump. `wasGrounded` is already false
     * on the frame Space fires - the jump above clears `grounded` before it is
     * read here - so a crouched player still leaves the ground, and everything
     * after take-off is airborne and untouched.
     *
     * Off in water, in a sink block and on a ladder, because in none of those
     * is the floor what is holding you up, and off while a blow is still on you:
     * being knocked off a ledge is the reason not to fight beside one, and a
     * shove you can hold Ctrl through is not a shove. A river's push and a
     * whirlpool's drag need no exemption of their own - both only apply in
     * water, which is already excluded. Ice does NOT get one: a slide is your
     * own momentum, and stopping it at the lip is exactly what the player asked
     * for by crouching.
     */
    const sneak = this.crouching && wasGrounded && !this.onLadder
      && !this.inWater && !this.inSink && this.knockT <= 0;

    for (let s = 0; s < steps; s++) {
      // x axis
      const nx = pos.x + this.vel.x * sdt;
      if (sneak && this._steppingOff(nx, pos.z, pos.y)) {
        this.vel.x = 0;
      } else if (this._blocked(nx, pos.z, pos.y, height)) {
        if (this._tryStepUp(nx, pos.z, height, wasGrounded)) pos.x = nx;
        else { pos.x = this._contactX(pos.x, nx, pos.z, pos.y, height); this.vel.x = 0; }
      } else pos.x = nx;

      // z axis
      const nz = pos.z + this.vel.z * sdt;
      if (sneak && this._steppingOff(pos.x, nz, pos.y)) {
        this.vel.z = 0;
      } else if (this._blocked(pos.x, nz, pos.y, height)) {
        if (this._tryStepUp(pos.x, nz, height, wasGrounded)) pos.z = nz;
        else { pos.z = this._contactZ(pos.z, nz, pos.x, pos.y, height); this.vel.z = 0; }
      } else pos.z = nz;

      // y axis. Both rest positions are derived from the *pre-move* height,
      // which is known clear, and are re-tested before being taken — so a
      // sideways overlap can never be mistaken for a floor and answered by
      // launching the player up to the top of it. If neither rest position is
      // usable we are embedded; _escape resolves that properly below.
      const ny = pos.y + this.vel.y * sdt;
      if (this._blocked(pos.x, pos.z, ny, height)) {
        if (this.vel.y <= 0) {
          // Landing may correct upward by at most the foot tolerance — never by
          // a whole layer, which is what let a wall hoist the player onto it.
          // The clamp has to allow the correction SKIN past FOOT: the rest
          // position is floor(y + FOOT) + SKIN, which is exactly FOOT + SKIN
          // above y when the feet sit a hair under a layer boundary.
          const rest = this._surfaceBelow(pos.x, pos.z, pos.y);
          if (rest >= 0 && rest <= pos.y + FOOT + SKIN && !this._blocked(pos.x, pos.z, rest, height)) {
            pos.y = rest;
            this.grounded = true;
          }
        } else {
          const rest = Math.ceil(pos.y + height) - height - SKIN;
          if (rest >= pos.y - FOOT && rest <= ny && !this._blocked(pos.x, pos.z, rest, height)) pos.y = rest;
        }
        this.vel.y = 0;
      } else {
        pos.y = ny;
      }
    }

    // Explicit ground probe. Relying on the landing correction alone to set
    // `grounded` makes the flag depend on a collision firing *this* frame — but
    // a player standing still is already resting, so nothing fires and the flag
    // decays to false. Probe just under the feet instead: that is stable at
    // rest, and it also recovers a box that ended up a hair inside the floor.
    if (!this.grounded && this.vel.y <= 0 &&
        this._blocked(pos.x, pos.z, pos.y - FOOT * 2, height)) {
      this.grounded = true;
      const rest = this._surfaceBelow(pos.x, pos.z, pos.y);
      if (rest > pos.y && rest <= pos.y + FOOT + SKIN &&
          !this._blocked(pos.x, pos.z, rest, height)) pos.y = rest;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    if (pos.y < SKIN) { pos.y = SKIN; this.vel.y = 0; this.grounded = true; }
    if (pos.y > D - 2) { pos.y = D - 2; this.vel.y = Math.min(0, this.vel.y); }

    // The dividers, before the safety nets. A portal column is empty of
    // anything solid all the way to bedrock, so a body that entered one and was
    // not moved through would fall the depth of the world — which is why this
    // runs every frame and not on some interaction. See `_portalTransit`.
    this._portalTransit(height);

    // Safety net: never end a frame with the box inside geometry.
    this._escape(height);

    // ...nor inside an animal.
    this._pushOutOfMobs(height);

    this._sync();

    // ---- fall damage ----
    //
    // Minecraft's curve, near enough: three blocks are free, and past that it
    // is one half-heart per block. Height should be the thing you respect before
    // hostiles exist, and the fall you can survive should be the one you chose
    // to take.
    //
    // Height is simply the world Y of the feet. On the cube it was the distance
    // from the planet's centre, which is exactly the kind of "position as a
    // radius" reading this conversion is about.
    const y = pos.y;
    // Catching a ladder ends the fall, the same as landing does — otherwise
    // climbing down a long shaft charges you for the whole descent the moment
    // you step off at the bottom.
    if (this.onLadder) this.fallStart = null;
    // A pool breaks a fall, exactly as water does, and this is not a courtesy
    // — it is the difference between a hazard and a hidden instant death. A
    // drift of powder snow in a mountain hollow is precisely the thing a player
    // lands in at speed after missing a ledge, and charging for the drop as
    // well as the burial would make the softest surface on the map the most
    // lethal. It is also Minecraft's rule for the same block.
    if (this.inSink) this.fallStart = null;
    if (!this.grounded && !this.inWater && !this.inSink && !this.onLadder) {
      if (this.fallStart === null && this.vel.y < -0.2) this.fallStart = y;
      // Track the highest point, not the point where the descent began: a jump
      // off a ledge starts the clock *after* the arc has already peaked, so a
      // running leap into a ravine was charged for less than it should be.
      else if (this.fallStart !== null && y > this.fallStart) this.fallStart = y;
    } else if (this.fallStart !== null) {
      const drop = this.fallStart - y;
      // Agility buys the blocks you fall for free; tolerance softens what is
      // left of the ones you do not. Both are read through `skills`, and with
      // no tree attached this is exactly the arithmetic it always was.
      const free = this.skills?.fallFree ?? FALL_FREE;
      if (drop > free && !this.inWater) {
        // Soaked *before* rounding, so a level of tolerance can turn a 1-point
        // scrape into nothing rather than being rounded straight back up.
        // `fallHurt` is the face's, and on Tempest it is a fifth. Read at the
        // moment of LANDING rather than where the fall began, which is the
        // honest reading of a drop that crossed a divider: what breaks your
        // legs is the ground you hit.
        const raw = (drop - free) * FALL_PER_BLOCK * physicsAt(this.cell.x, this.cell.y).fallHurt;
        const dmg = Math.round(this.skills ? this.skills.soak(raw, 'fall') : raw);
        if (dmg > 0) { this.health = Math.max(0, this.health - dmg); this.onHurt?.(dmg); }
      }
      if (drop > 0.6) this.onLand?.(Math.min(1, drop / 8));
      this.fallStart = null;
    }

    // ---- gait ----
    const tanSpeed = Math.hypot(this.vel.x, this.vel.z);
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
      this.stamina = Math.max(0, this.stamina - dt * 0.055
        * (this.skills?.staminaScale ?? 1) * face.staminaDrain);
    } else this.stamina = Math.min(1, this.stamina + dt * 0.12);

    // The arm labours when the water does. A penalty the player cannot see is
    // indistinguishable from a bug in the mining code, and this is the channel
    // that costs nothing to read: main.js re-swings the moment this reaches 1,
    // so the whole cadence of digging — arm, particles, the dig sound — slows
    // together with the timer.
    if (this.swingT < 1) {
      this.swingT = Math.min(1, this.swingT + dt * 3.4 / Math.sqrt(this.miningDrag));
    }
  }

  /**
   * Auto-step onto a one-block ledge without jumping.
   *
   * Off by default. It is a convenience, not a physics rule — it lets you walk
   * up terrain you never asked to climb, which makes precise movement along a
   * ledge or around a build harder rather than easier. `autoJump` in settings
   * turns it back on. `grounded` is reset before the horizontal axes resolve,
   * so eligibility comes from last frame's state.
   */
  _tryStepUp(x, z, height, wasGrounded) {
    if (!this.autoJump) return false;
    if (!(wasGrounded || this.grounded)) return false;
    // Never step while rising: mid-jump the box must be stopped by a wall, not
    // hoisted over it.
    if (this.vel.y > 0.1) return false;
    const pos = this.position;
    const lifted = Math.floor(pos.y + FOOT) + 1 + SKIN;
    const rise = lifted - pos.y;
    if (rise <= 0 || rise > 1.06) return false;
    if (this._blocked(x, z, lifted, height)) return false;
    this.stepOffset = Math.min(0.55, this.stepOffset + rise);
    pos.y = lifted;
    this.grounded = true;
    return true;
  }

  /**
   * A world direction as map-axis components, for the minimap.
   *
   * The identity, now: map x IS world X and map y IS world Z. It stays a named
   * method rather than being inlined at the call site because the caller is
   * asking a question about the map, and the answer would be silently wrong if
   * anyone ever mixed up which of world Y and Z the map's second axis is.
   */
  tangentToCell(v, out = { x: 0, y: 0 }) {
    out.x = v.x; out.y = v.z;
    return out;
  }

  /** The block directly under the feet. */
  groundBlock() {
    return this.planet.at(this._col(), Math.floor(this.position.y - 0.2));
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
   * being a rule and starts being a wall.
   *
   * The float half is deliberately gated on being *in water* rather than on
   * `grounded` alone. A jump lasts about four tenths of a second and you take
   * your weight into the swing with you; buoyancy lasts as long as you like and
   * does not.
   *
   * Lungs is the aqua-affinity node: each level takes a quarter off the water
   * half only, so the branch's nine levels retire the penalty outright — 3.0 at
   * lungs 0, 1.0 from lungs 8 up, where the clamp catches it. That the last
   * rung buys nothing here is deliberate: the branch is sold on breath, this is
   * the thing that made short breath worth complaining about, and a ninth level
   * of it would have to invent a *bonus* to have anything left to give.
   * It never touches the float half, so
   * standing on the bed stays worth its full 3× no matter how deep the tree
   * goes — the skill buys you a better swing, not permission to stop diving.
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

    // Up is +Y and never moves, so there is no view-up to chase and no roll to
    // play out. Everything below is the ordinary flat-world camera.
    const right = _c.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.lookDir.copy(this.forward).multiplyScalar(Math.cos(this.pitch));
    this.lookDir.y = Math.sin(this.pitch);
    this.lookDir.normalize();

    this.eye.copy(this.position);
    this.eye.y += this.eyeHeight - this.stepOffset;
    // Head bob is a first-person effect and only a first-person effect. Applied
    // to a camera three and a half cells out it stops reading as footfalls and
    // starts reading as a handheld shot of someone else walking.
    const b = allowBob && view === VIEW_FIRST ? this.bobAmount : 0;
    if (b > 0.001) {
      this.eye.y += Math.sin(this.bob * 2) * 0.042 * b;
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
      _v3.copy(this.forward).multiplyScalar(Math.cos(elev));
      _v3.y = Math.sin(elev);
      _v3.multiplyScalar(back ? -1 : 1);
      // The whole offset, boom and shoulder together, as one vector. Marching
      // *it* rather than the boom alone is what keeps the pull-in honest: the
      // camera slides along this line toward the eye, so the lift and the side
      // step shrink with the distance and cannot push it into the wall the
      // boom just backed away from.
      _v4.copy(_v3).multiplyScalar(THIRD_DIST).addScaledVector(right, CAM_SIDE);
      _v4.y += CAM_LIFT;
      const len = _v4.length();
      _v4.multiplyScalar(1 / len);
      // March the world and stop short of the first solid thing. Without this
      // the camera happily sits inside the hillside you are standing against
      // and you are looking at the inside of the terrain. Liquids are
      // deliberately not hit: swimming would otherwise slam the camera to the
      // surface every stroke, and the underwater post pass already sells being
      // submerged.
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
      // pulls in, and what you are looking at slides off the screen.
      _aim.copy(this.eye).addScaledVector(this.lookDir, back ? THIRD_DIST : -THIRD_DIST);
    }
    camera.position.copy(camPos);
    _m.lookAt(camPos, _aim, UP);
    camera.quaternion.setFromRotationMatrix(_m);
    if (b > 0.001) camera.rotateZ(Math.cos(this.bob) * 0.011 * b);
  }
}
