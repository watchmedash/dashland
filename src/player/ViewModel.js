// First-person viewmodel: the player's hands and whatever they are holding.
// Rendered in its own scene on top of the composited frame so it can never
// clip into geometry.
//
// The arms are the chosen character's own — the `arm-left` and `arm-right`
// subtrees lifted out of a clone of the same GLB the third-person body uses, so
// what you see down the front of the screen and what somebody else would see of
// you are the same limbs wearing the same skin. They used to be a pair of
// procedurally textured boxes, which meant every one of the fifteen characters
// had the same teal sleeves in first person and the choice stopped meaning
// anything the moment you looked forward. Those boxes are still here as the
// fallback for a character model that has not arrived or never will; see
// `_tryArms`.

import * as THREE from 'three';
import { ITEMS } from '../game/Items.js';
import { BLOCKS, RENDER_TYPE, R_CROSS } from '../world/Blocks.js';
import { createItemBlockMaterial } from '../render/VoxelMaterial.js';
import { heldModel, hasModel, worldModel } from '../render/ItemModels.js';
import * as MobModels from '../game/MobModels.js';
import { characterUrl, DEFAULT_CHARACTER } from './Character.js';

const _lampColor = new THREE.Color();
const _box = new THREE.Box3();

/** The two hands, in the order everything here iterates them. */
const HANDS = ['right', 'left'];

/**
 * The rig node whose subtree is one arm. Same names `Character.js` uses, and
 * deliberately not imported from it: that module keeps its copy private, and a
 * shared constant between the body and the viewmodel would tie two rigs
 * together that only happen to be the same rig.
 */
const ARM_NODE = { right: 'arm-right', left: 'arm-left' };

// Where the shoulder sits in view space. The hand hangs off the far end of the
// limb, so these are the old hand rest points pushed back down the arm: hand ≈
// shoulder plus the limb vector, which at the rest rotation puts the item at
// about (0.40, -0.40, -0.72). At that depth, with a 70° vertical fov, the
// visible height is ~1.0 units — an item scaled 0.4 fills about a third of the
// screen, which is where a first-person held item should sit.
const REST = new THREE.Vector3(0.48, -0.56, -0.23);
const REST_EMPTY = new THREE.Vector3(0.54, -0.62, -0.15);

// Fist position in arm-local space. The limb is a 0.62-long box running from the
// pivot to z = -0.59, so the fist closes just shy of its end. The counter-
// rotation cancels the arm's rest tilt: an item's own pose is then expressed in
// view space, the way it reads on screen, while still inheriting every bit of
// the arm's swing.
const HAND_LOCAL = new THREE.Vector3(0, 0.01, -0.52);
const ARM_REST_ROT = new THREE.Euler(0.30, 0.16, 0.12);

// The offhand arm, mirrored across the view's centre line: the shoulder moves
// to the left of the screen and the two rotations that lean the limb inward —
// yaw and roll — change sign. Pitch does not: both arms hang at the same angle
// below the eye, and negating it would have the left arm reaching up out of
// frame. There is no separate REST_EMPTY here because an empty offhand draws
// nothing at all; see `setOffhand`.
const OFF_REST = new THREE.Vector3(-0.48, -0.56, -0.23);
const OFF_ARM_REST_ROT = new THREE.Euler(0.30, -0.16, -0.12);

/**
 * The bow draw.
 *
 * **The subject of this animation is the bow, and the arm is not in it.** That
 * is the whole of the redesign, and it is worth stating why, because the two
 * things it replaced were each a reasonable idea that produced the same wrong
 * picture.
 *
 * The draw used to be six numbers added to the *shoulder*: the limb came in
 * across the body, up toward eye level and 0.20 units back toward the eye, and
 * everything hanging off it — the fist, the sleeve, the bow — grew by the 38%
 * that buys. The nearest and largest thing on that chain is the player's own
 * hand, so what the gesture actually showed was a hand looming at the camera
 * with a bow somewhere behind it. Measured on the real chain, the arm went from
 * 2.6% of the frame to 9.6% while the bow went from 1.05% to 1.48%: the arm
 * gained six times what the bow did, and ended up covering nearly three times
 * as much of the screen. "The hand got bigger instead" is exactly correct.
 *
 * So the bow gets its own transform, in `aim`, and the arm gets out of the way:
 *
 *  - `p` / `r` are still the shoulder's offsets, but they now *retreat* — the
 *    limb sinks and its far end drops out of the bottom of the frame. By 40% of
 *    the charge the arm covers no pixels at all, and `hide` then stops drawing
 *    it entirely, at a point where it has already been off screen for a tenth of
 *    the draw (so there is nothing to pop).
 *  - `aim` is where the *bow* goes, stated in view space — the frame the player
 *    is actually looking at — rather than as an offset from a hand that is on
 *    its way out of shot. `p` is the middle of the stave, `r` the bow model's
 *    orientation on screen, `len` the stave's length in view units (the model is
 *    normalised to one unit on its longest axis, so `len` is literally how long
 *    it is drawn). At 0.85 out and 1.41 long, the stave over-fills the viewport
 *    — 2.48 of 2.00 in NDC, cropped top and bottom — and its centre line sits
 *    three quarters of the way across, on the right.
 *  - `r` was solved, not dialled: the bow lies in its own XZ plane (stave along
 *    model X, string a straight run at model z = -0.28, shot along +Z), so
 *    standing the stave up off vertical and turning the shot across the frame
 *    pins all three axes. The shipped draw before any of this ended with the
 *    plane 70 degrees off face-on, which is a bow seen very nearly edge-on.
 *
 *    **Halved, on a report that the drawn bow is "sideways instead of facing
 *    forward a little... the idea is correct, just way too sideways".** The
 *    first pass turned the shot 67.6 degrees off the view axis to get the stave
 *    and the string to read, which is a bow held nearly across the player. It is
 *    now 25 degrees, which is `r` slerped 0.369 of the way from square-to-shot
 *    toward that first answer:
 *
 *      shot direction     was (-0.904, 0.192, -0.382)   now (-0.418, 0.059, -0.907)
 *      off the shot       was 67.6 deg                  now 25.0 deg
 *      stave off vertical was 12.0 deg                  now  4.6 deg
 *      plane off face-on  was 22.4 deg                  now 65.1 deg
 *
 *    That last row is the cost and it is unavoidable rather than a mistake: the
 *    bow's plane *contains* its shot, so every degree the shot comes back toward
 *    the camera is a degree the plane turns edge-on. The question is only
 *    whether it stays clear of the failure, and it does. Bounding-box silhouette
 *    through the real glTF, rescaled to the units the earlier figures are in
 *    (the edge-on control reproduces at 0.0159 against the recorded 0.017, so
 *    the scales agree):
 *
 *      edge-on, the broken pose    0.017
 *      carried in the fist         0.075
 *      drawn, before this          0.102
 *      drawn, now                  0.049   <- 2.9x the failure, at the same height
 *
 *    and at the draw's own scale (`len` 1.41, not the 0.78 those are measured
 *    at) it is 0.160, about what a pickaxe covers. The bow is not going back to
 *    a vertical line.
 *
 *    `string` and `pull` need no adjustment for any of this, and that was the
 *    point of moving them into the bow's model space — see `_poseDraw`. Checked
 *    rather than assumed: the nock point's distance to the nearest vertex of the
 *    string's straight run is identical under the old and new rotations at
 *    t = 0, 0.5 and 1 (0.5477 / 0.3686 / 0.1912 in both), because the nock is
 *    stated in bow space and carried by the bow's own matrix. Retuning the pose
 *    cannot take the arrow off the string.
 *
 * What that does to the frame, measured off the real glTF through the real
 * chain at 16:9 (bow and arm as rasterised screen coverage, not bounding boxes).
 * **These rows are from the 67.6-degree pose** — the turn above changes the bow
 * column and the last two, and the rise, the arm's retreat and the heights are
 * untouched by a rotation:
 *
 *   draw   bow    arm     plane off face-on   stave off vertical   bow height
 *   0.00   1.05%  2.56%   39 deg              6 deg                1.45 NDC
 *   0.25   1.94%  1.05%   34 deg             10 deg                1.89
 *   0.50   2.63%  0.00%   23 deg             12 deg                2.20
 *   0.75   3.32%  0.00%   23 deg             12 deg                2.42
 *   1.00   3.56%  0.00%   22 deg             12 deg                2.48
 *
 * The bow rises the whole way (its centre goes -0.65 -> -0.17 NDC), which is the
 * property the previous rebuild bought and this must not give back: coming
 * toward the camera costs apparent height, and a draw that sinks reads as a
 * shrug. It rises because the bow is carried to `aim` in *view* space, so its
 * path on screen is a straight line to the destination whatever the arm is doing
 * underneath it.
 *
 * `string` and `pull` are the nocked arrow, and both are in the bow model's own
 * space now rather than in the hand's — see `_poseDraw`. That is what re-sites
 * the arrow against the bow's pose instead of against a constant that was true
 * of a pose two revisions ago: at the old hand-space `nock`, the arrow's nock
 * point lands a full bow-length from the grip.
 */
const DRAW = {
  p: [-0.02, -0.42, 0.04],
  r: [-0.85, 0.26, -0.14],
  /**
   * Where the bow goes, in view space. `r` is 25 degrees off the shot — see the
   * turn table above before changing it, and note that this is the *only*
   * rotation the bow has at full draw: `POSE.bow.rot` in `render/ItemModels.js`
   * is the carried pose and is slerped entirely out of the picture by then, so
   * a "the drawn bow is turned wrong" report is always this number and never
   * that one.
   */
  aim: { p: [0.42, -0.07, -0.85], r: [-3.077, -0.431, -1.488], len: 1.41 },
  /** The limb stops being drawn once its retreat is this far along. */
  hide: 0.35,
  /**
   * The string's straight run of verts, in the bow model's normalised space.
   * Measured: raw z = -0.28 on a model 1.9575 units tip to tip and recentred,
   * which is -0.066. The grip is at +0.078.
   */
  string: -0.066,
  /** How far back along the shot the nock travels by full draw, in view units. */
  pull: 0.36,
  /** How long the nocked arrow is drawn, in view units. */
  scale: 1.10,
};

/**
 * The three clocks the draw runs on, and they are three because they are three
 * different jobs.
 *
 * `drawEase` is the rise: ease-out, so the bow is most of the way up almost at
 * once — it is the feedback that the button did something — and then holds while
 * the charge fills.
 *
 * `armEase` is the arm's retreat, and it is slower than the rise on purpose.
 * The limb is what the player's eye is already on when the draw starts, so it
 * leaves under the bow rather than ahead of it; ^1.5 puts it off screen by 40%
 * of the charge, monotonically, with no frame where it grows.
 *
 * `turnEase` is the roll that presents the bow's plane, and it is far faster
 * than either. The turn from the carrying grip to the aim is very nearly a half
 * roll, and a half roll passes through edge-on whichever way it goes — there is
 * no path around it. What there is, is the option to have it over before there
 * is a bow on screen to look at: at ^8 the crossing happens at 7% of the charge,
 * with the bow still at its resting 1.3% of the frame down in the corner, and
 * from the moment the bow covers 2% of the frame the plane is never more than
 * 31 degrees off face-on. On the rise's clock instead it is 77 degrees — edge-on
 * while the bow is already large, which is the thing being fixed.
 */
const drawEase = (t) => t * (2 - t);
const armEase = (t) => t * Math.sqrt(t);
const turnEase = (t) => 1 - (1 - t) ** 8;

/**
 * How fast the draw pose lets go, in units per second.
 *
 * Only the falling edge is eased. The rise is already a ramp — `main.js` hands
 * over a charge clock that takes about a second to fill — but releasing is one
 * frame, and the arm now travels far enough out of frame that snapping it back
 * is a limb appearing from nowhere. `PlayerCharacter._drawW` eases its own
 * release for the same reason and this is the first-person half of it.
 */
const DRAW_FALL = 12;

// --- swing animations -------------------------------------------------------
// Every tool used to play the same forward-and-down jab, so a pickaxe, a sword
// and a bare fist all read as punching. Each kind now gets its own track.
//
// A track is a list of keyframes on a normalised 0..1 swing clock. `p` is a
// position offset from the arm's rest point and `r` an offset from its rest
// rotation, both applied to the SHOULDER (armPivot) — the fist and the held
// item hang off it and must never be posed separately, or they come apart.
// `e` names the easing used to reach the NEXT key.
//
// Amplitudes stay small on purpose: the item sits ~0.52 units out along the
// limb, so a radian at the shoulder throws it half a screen. Anything past
// about 0.65 rad of pitch or yaw walks the tool out of frame.
const EASE = {
  linear: (t) => t,
  in: (t) => t * t,                             // accelerate — a driven stroke
  in3: (t) => t * t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  out3: (t) => 1 - (1 - t) ** 3,                // snappy settle
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
};

const SWINGS = {
  // Overhead: rises and back, then drives head-first down and forward into the
  // block, with a short recoil off the impact before it recovers. Slowest of
  // the set — it should feel like it weighs something.
  pick: {
    rate: 2.7,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.28, p: [0.02, 0.11, 0.10], r: [0.46, 0.04, -0.06], e: 'in' },     // wind up
      { t: 0.55, p: [-0.02, -0.05, -0.22], r: [-0.44, -0.02, 0.10], e: 'out' },// strike
      { t: 0.67, p: [-0.01, -0.01, -0.13], r: [-0.26, -0.01, 0.05], e: 'out3' },// recoil
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Diagonal chop from high-right down across the body. The down-stroke takes
  // barely a fifth of the clock; the rest is the slower haul back up.
  axe: {
    rate: 3.1,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.22, p: [0.09, 0.10, 0.08], r: [0.34, -0.22, -0.30], e: 'in' },
      { t: 0.44, p: [-0.13, -0.06, -0.22], r: [-0.36, 0.28, 0.46], e: 'out' },
      { t: 0.54, p: [-0.10, -0.05, -0.16], r: [-0.27, 0.22, 0.38], e: 'inOut' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // A dig, not a strike: a shallow pull back, then forward and down into the
  // ground, then a scooping lift that rolls the blade up and back.
  shovel: {
    rate: 3.0,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.16, p: [0.00, 0.04, 0.07], r: [0.14, 0.02, -0.04], e: 'in' },
      { t: 0.44, p: [0.00, -0.10, -0.24], r: [-0.32, 0.04, -0.02], e: 'out' },  // bite
      { t: 0.70, p: [-0.02, 0.08, -0.10], r: [0.36, -0.06, 0.16], e: 'inOut' }, // scoop up
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Lateral slash across the view, right to left. Fastest track by a wide
  // margin, and it snaps back rather than drifting.
  sword: {
    rate: 4.6,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.16, p: [0.10, 0.06, 0.06], r: [0.14, -0.42, -0.24], e: 'in' },
      { t: 0.40, p: [-0.20, 0.02, -0.14], r: [0.02, 0.66, 0.36], e: 'out3' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // A bow has no swing at all — see `setDraw`, which poses the arm continuously
  // off the draw clock instead. The entry exists so that `_equip`'s
  // `SWINGS[tool.kind]` lookup finds something for `tool.kind === 'bow'` rather
  // than silently handing a bow the punch track, and it is deliberately almost
  // nothing: the one motion a bow makes that is not a draw is the little recoil
  // as the string goes, which `punch()` plays on release.
  bow: {
    rate: 5.2,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out3' },
      { t: 0.22, p: [0.02, 0.01, 0.06], r: [0.06, 0.10, 0], e: 'out' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Blocks, torches, food, bare hands: the old short jab, which is still the
  // right motion for placing and for a plain punch.
  default: {
    rate: 3.6,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'inOut' },
      { t: 0.50, p: [0, -0.07, -0.24], r: [-0.44, 0, -0.16], e: 'inOut' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
};

/**
 * Sample a swing track at clock position s (0..1) into `outP` / `outR`.
 * @param {{keys:Array}} track
 */
function sampleSwing(track, s, outP, outR) {
  const keys = track.keys;
  let i = 0;
  while (i < keys.length - 2 && s >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const u = span > 0 ? Math.min(1, Math.max(0, (s - a.t) / span)) : 1;
  const e = (EASE[a.e] || EASE.linear)(u);
  outP.set(
    a.p[0] + (b.p[0] - a.p[0]) * e,
    a.p[1] + (b.p[1] - a.p[1]) * e,
    a.p[2] + (b.p[2] - a.p[2]) * e,
  );
  outR.set(
    a.r[0] + (b.r[0] - a.r[0]) * e,
    a.r[1] + (b.r[1] - a.r[1]) * e,
    a.r[2] + (b.r[2] - a.r[2]) * e,
  );
}

const _swingP = new THREE.Vector3();
const _swingR = new THREE.Vector3();

// Scratch for `_poseDraw`, which runs every frame of a draw and must not
// allocate. `_mA`..`_mC` are matrices in view space, `_pA`/`_qA`/`_sA` the
// pieces a transform decomposes into.
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _mC = new THREE.Matrix4();
const _pA = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _sA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _qB = new THREE.Quaternion();
const _sB = new THREE.Vector3();
const _aimP = new THREE.Vector3(...DRAW.aim.p);
const _aimQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...DRAW.aim.r));
const _aimS = new THREE.Vector3(DRAW.aim.len, DRAW.aim.len, DRAW.aim.len);

/**
 * The stand-in arm's skin: a teal sleeve with a cuff and a bare hand.
 *
 * Kept, now that the real arm is the chosen character's own limb, because the
 * character model may not be there — a cold load, a slow network, a missing
 * file. See `_tryArms`. It is what first person looked like before this and it
 * is what it falls back to, so the mode is never empty-handed in the literal
 * sense of having no arm at all.
 */
function makeArmTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const band = (y0, y1, base, jitter) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < S; x++) {
        const col = new THREE.Color(base);
        col.offsetHSL(0, 0, (Math.random() - 0.5) * jitter);
        g.fillStyle = `#${col.getHexString()}`;
        g.fillRect(x, y, 1, 1);
      }
    }
  };
  band(0, 40, '#4c8a92', 0.07);     // sleeve
  band(40, 64, '#e2ae82', 0.05);    // hand
  // cuff
  g.fillStyle = 'rgba(40,70,74,.85)';
  g.fillRect(0, 38, S, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

export class ViewModel {
  constructor(dropsFactory) {
    this.dropsFactory = dropsFactory;
    this._sprintEase = 0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 12);

    this.key = new THREE.DirectionalLight(0xffffff, 1.9);
    this.key.position.set(-0.5, 0.9, 0.6);
    this.fill = new THREE.HemisphereLight(0xbcd6f5, 0x54463a, 1.1);
    this.scene.add(this.key, this.fill);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // --- arm ---
    const armTex = makeArmTexture();
    const armMat = new THREE.MeshStandardMaterial({ map: armTex, roughness: 0.88, metalness: 0 });
    this.armMat = armMat;
    // Pivot sits at the shoulder; the limb extends forward, away from the
    // camera. Kept slim and short — anything nearer than ~0.4 units balloons
    // under perspective and swallows the corner of the screen.
    //
    // This box is the stand-in. The character's arm replaces the *mesh* and
    // nothing else: the pivot, the item anchor and every number in the swing
    // tracks belong to this group, which is why a real arm can be swapped in
    // without retuning any of them.
    const armGeo = new THREE.BoxGeometry(0.14, 0.14, 0.62);
    armGeo.translate(0, 0, -0.28);
    this.arm = new THREE.Mesh(armGeo, armMat);
    this.armPivot = new THREE.Group();
    this.armPivot.add(this.arm);
    this.root.add(this.armPivot);

    // --- held item anchor ---
    // A child of the arm, not a sibling of it. As siblings the two were animated
    // independently and their swing terms had opposite signs, so a mining swing
    // drove the fist one way and whatever it held the other — it read as two
    // hands striking out of step. Parented, the item can only move with the limb.
    this.hand = new THREE.Group();
    this.hand.position.copy(HAND_LOCAL);
    // reversed order + negated angles is the exact inverse of the XYZ rest tilt
    this.hand.rotation.set(-ARM_REST_ROT.x, -ARM_REST_ROT.y, -ARM_REST_ROT.z, 'ZYX');
    this.armPivot.add(this.hand);

    // --- offhand arm ---
    // Built once, hidden by default, and posed only on the frames it is shown.
    // First person with an empty offhand — which is every frame of a new game,
    // and the state this view was tuned in — therefore renders exactly what it
    // rendered before this existed: one arm, in the same place, with the same
    // swing. That is not a hope, it is the `visible` flag and the early return
    // in `update` below.
    //
    // Same geometry and same material as the right arm, placed rather than
    // mirrored with a negative scale: a negatively scaled mesh has its winding
    // reversed, so it renders inside out under backface culling and its normals
    // face away from the key light. The limb box is symmetric, so there is
    // nothing a mirror would buy.
    this.offArmPivot = new THREE.Group();
    this.offArm = new THREE.Mesh(armGeo, armMat);
    this.offArmPivot.add(this.offArm);
    this.offHand = new THREE.Group();
    this.offHand.position.set(-HAND_LOCAL.x, HAND_LOCAL.y, HAND_LOCAL.z);
    this.offHand.rotation.set(
      -OFF_ARM_REST_ROT.x, -OFF_ARM_REST_ROT.y, -OFF_ARM_REST_ROT.z, 'ZYX');
    this.offArmPivot.add(this.offHand);
    this.offArmPivot.visible = false;
    this.root.add(this.offArmPivot);

    this.blockMaterial = createItemBlockMaterial();
    this.spriteCache = new Map();

    /**
     * What each hand is holding, and the mesh showing it.
     *
     * One record per hand rather than the three loose fields this used to be
     * (`heldItem`, `heldMesh`, `ownsGeometry`), because every one of them has to
     * exist twice and a `heldMeshLeft` beside a `heldMesh` is how the two
     * quietly drift apart. `heldItem` survives as a getter — the swing clock,
     * the equip dip and `update`'s rest-point choice are all the right hand's
     * alone and still read it by name.
     *
     * `glow` is a per-hand spare of the block material, for blocks that are
     * themselves alight. The viewmodel has no voxel light in it — that is baked
     * into the world mesh — so a block that glows in your hand renders from its
     * raw albedo, and the albedo of a thing that emits light is nearly black
     * with bright cracks in it. Held, the planet hearth came out as dark mud
     * with holes. There used to be one spare, on the reasoning that only one
     * item is in the hand at a time; that reasoning is what the offhand
     * repeals. Sharing it meant a hearth in the left hand rewrote the emissive
     * a torch in the right had set, and whichever was equipped last lit both.
     */
    this.hands = {
      right: {
        anchor: this.hand, pivot: this.armPivot, stub: this.arm, arm: null,
        rig: null,
        item: -1, mesh: null, owns: false, modelled: false, track: SWINGS.default,
        glow: createItemBlockMaterial(),
      },
      left: {
        anchor: this.offHand, pivot: this.offArmPivot, stub: this.offArm, arm: null,
        rig: null,
        item: -1, mesh: null, owns: false, modelled: false, track: SWINGS.default,
        glow: createItemBlockMaterial(),
      },
    };

    /**
     * A group between each fist and what it is holding, so an item can be posed
     * *relative to the hand* instead of only with it.
     *
     * Identity on every frame of every other animation, and that is the point:
     * the swing tracks, the bob and the equip dip all still drive the shoulder
     * and the item still rides the limb exactly as it did. What the rig buys is
     * the one case where they must come apart — the bow draw, where the bow has
     * to grow and turn while the arm does the opposite of growing. Posing the
     * shoulder cannot express that, because everything on that chain grows
     * together and the biggest, nearest thing on it is the hand.
     *
     * One per hand rather than one for the drawing hand, so `_setMesh` has a
     * single rule and there is no branch that could put an item in the wrong
     * parent. The offhand's is never touched.
     */
    for (const key of HANDS) {
      const h = this.hands[key];
      h.rig = new THREE.Group();
      h.anchor.add(h.rig);
    }

    /**
     * Whose arms these are. Defaulted rather than left null so that the common
     * case — a player who never touches the picker — needs no wiring at all,
     * and so that `setCharacter` with the default id is correctly a no-op.
     */
    this.charUrl = characterUrl(DEFAULT_CHARACTER);
    this._armsBuilt = false;

    /**
     * How far the bow is drawn, 0..1, and the arrow sitting on the string.
     *
     * A separate clock from `swing` and not a track on it. A swing is a fixed
     * animation the game plays *at* you; a draw is a pose the player is holding,
     * and the whole point of the mechanic is that the frame you are looking at
     * is the charge you would release. Driving it off `swing` would mean the arm
     * ran to the end of a track and let go on its own.
     */
    this.draw = 0;
    /**
     * The draw the *pose* is at, which lags `draw` on the way down only. See
     * `DRAW_FALL`.
     */
    this._drawShown = 0;
    /** The nocked arrow's mesh, built on the first draw and then kept. */
    this.nock = null;
    this._nockItem = 0;

    this.swing = 1;
    /** Which arm the current swing belongs to. See `punch`. */
    this.swingHand = 'right';
    this.swingTrack = SWINGS.default;
    this.bob = 0;
    this.equipT = 1;      // 0 = just swapped, 1 = settled
    this.offEquipT = 1;   // the offhand arm's own dip clock
    this.enabled = true;
    /**
     * Told whenever the arm swings, so the third-person body can swing too.
     *
     * A hook rather than a second call at every site that mines, places, eats,
     * casts or hits: there are eight of them in main, and the ninth one someone
     * adds next month would silently animate one body and not the other. There
     * is exactly one definition of "the player swung", and it is `punch`.
     *
     * Called with the hand that swung, so the body swings the same arm the view
     * model does. A listener that ignores the argument gets the old behaviour.
     * @type {?(hand:'right'|'left')=>void}
     */
    this.onPunch = null;
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // --- the chosen character's arms -------------------------------------------

  /**
   * Wear a character's arms in first person.
   *
   * Safe before its GLB exists and safe to call repeatedly: all this records is
   * a URL, and `update` builds the arms on the first frame `MobModels` can hand
   * them over. Until then — and forever, if the file never arrives — first
   * person draws the stand-in limb it always drew.
   *
   * @param {string} id a `CHARACTER_IDS` letter
   */
  setCharacter(id) {
    const url = characterUrl(id);
    if (url === this.charUrl) return;
    this.charUrl = url;
    for (const h of HANDS) this._dropArm(this.hands[h]);
    this._armsBuilt = false;
    this._tryArms();
  }

  /**
   * Take the `arm-*` subtrees out of a clone of the character and hang them off
   * the two shoulders. Does nothing until the GLB is loaded, and gives up for
   * good once it has run — a second attempt could only produce the same arms.
   *
   * **Why a subtree and not a bone.** The rig is not skinned: `character-a.glb`
   * is eight plain nodes and every clip keys their rotations directly, so an arm
   * is a node with a mesh on it and `getObjectByName` is the whole of "find the
   * arm". `MobModels.instantiate` is used rather than reaching for the
   * prototype because the prototype must never be reparented — it is what every
   * husk in the world is cloned from — and instantiate already hands back a
   * private clone. Its mixer and its other six nodes are dropped on the floor:
   * this arm is posed by the swing tracks below, not by any clip, so there is
   * nothing here for a mixer to drive.
   *
   * **No material work at all, on purpose.** The clone's materials are the
   * prototype's, which `MobModels.lit()` has already rebuilt as standard
   * materials around the file's own `map` — so the arm arrives lit by this
   * scene's key and fill, warms to `handLight` with everything else, and wears
   * the chosen character's own skin because that skin is the texture its GLB
   * points at. Touching those materials is how these models render flat white
   * (see the note on `lit`), and the viewmodel needs nothing from them that the
   * body has not already got.
   *
   * **Fitted by measurement rather than by a constant.** The limb hangs down its
   * node's -Y from a shoulder at the node origin; the fist is the far end of
   * that. Scaling so the far end lands exactly on `HAND_LOCAL` is what keeps the
   * held item where it was tuned — the item anchor does not move, the arm is
   * built to reach it, and no swing amplitude, bob term or item offset changed
   * for any of this.
   *
   * **The mirror is free.** `arm-left`'s mesh sits at x 0..0.4 in its own node
   * space and `arm-right`'s at -0.4..0 — the pack mirrors the geometry, not the
   * node — so centring each measured limb on its own shoulder is all the
   * mirroring there is. Nothing is scaled by -1, which would reverse the winding
   * and turn the arm inside out under backface culling.
   */
  _tryArms() {
    if (this._armsBuilt || !MobModels.isReady(this.charUrl)) return;
    const model = MobModels.instantiate(this.charUrl);
    if (!model) return;
    this._armsBuilt = true;

    for (const key of HANDS) {
      const h = this.hands[key];
      const node = model.root.getObjectByName(ARM_NODE[key]);
      if (!node) continue;
      // Off the torso and onto our own shoulder: the node carries the rig's
      // shoulder offset in its position, and here the shoulder is the origin.
      node.parent?.remove(node);
      node.position.set(0, 0, 0);
      node.quaternion.identity();
      node.traverse((n) => {
        if (!n.isMesh) return;
        // `prepare` turns these on for the world body. Nothing in this scene
        // casts or receives, and a shadow-casting arm in a scene with no shadow
        // map is a per-frame cost for no pixels.
        n.castShadow = false;
        n.receiveShadow = false;
      });

      _box.setFromObject(node);
      const len = -_box.min.y || 1;              // shoulder at 0, fist at min.y
      const s = -HAND_LOCAL.z / len;             // fist lands on the item anchor
      const holder = new THREE.Group();
      // Two turns, and the second one is not cosmetic. X swings a limb that
      // hangs down -Y out along -Z, in front of the eye. Y turns the rig round
      // to face the camera's forward: the pack builds its characters looking
      // along +Z and a three camera looks along -Z, so first person is standing
      // *inside* a body that faces the other way. Without it the arm is
      // laterally flipped on its own long axis — the back of the forearm on top
      // where the front belongs, and the outer sleeve turned in toward the
      // middle of the screen. Both are the sort of wrong that reads as "the
      // texture looks a bit off" rather than as a transform bug, which is why
      // the mapping was checked axis by axis: with the Y turn the arm's front
      // face points up (as your own does when you reach forward) and each arm's
      // outward side faces its own side of the screen.
      holder.rotation.set(Math.PI / 2, Math.PI, 0);   // XYZ order: Rx then Ry
      holder.scale.setScalar(s);
      // Centre the limb on the shoulder line. Positive, not negative: the Y
      // turn has already flipped the measured centre to the far side.
      holder.position.x = (_box.min.x + _box.max.x) * 0.5 * s;
      holder.add(node);

      h.pivot.add(holder);
      h.arm = holder;
      h.stub.visible = false;
    }
  }

  /**
   * Put a hand back on the stand-in limb. Nothing is disposed: the geometry and
   * the materials under here are the loaded prototype's, shared with every other
   * instance of that character, and freeing them would take the body and the
   * husks with them. Detaching is the whole of the release.
   */
  _dropArm(h) {
    if (!h.arm) return;
    h.pivot.remove(h.arm);
    h.arm = null;
    h.stub.visible = true;
  }

  /** What the right hand is holding. Read by the swing and the rest point. */
  get heldItem() { return this.hands.right.item; }

  setHeld(itemId, iconFactory) {
    if (itemId === this.hands.right.item) return;
    this.equipT = 0;
    this._equip(this.hands.right, itemId, iconFactory);
  }

  /**
   * What the left hand is holding.
   *
   * It used to have no swing track, on the reasoning that nothing is ever used
   * from the offhand — it carried and it showed. `Inventory.active()` repealed
   * that: with the main hand empty the offhand is the hand that mines, places
   * and eats, so a pickaxe there has to swing like a pickaxe. The track is
   * resolved per hand in `_equip` and `punch` picks the one belonging to the
   * hand that acted.
   *
   * It has its own equip clock so that swapping dips both arms on their own
   * schedules, which is what makes the swap read as one gesture.
   */
  setOffhand(itemId, iconFactory) {
    const h = this.hands.left;
    if (itemId === h.item) return;
    this.offEquipT = 0;
    this._equip(h, itemId, iconFactory);
    // The whole arm goes, not just the item. A bare left forearm hanging in
    // frame with nothing in it is what the right arm's REST_EMPTY exists to
    // handle, and an offhand that is empty far more often than not does not
    // earn that screen space.
    this.offArmPivot.visible = h.item > 0;
  }

  /**
   * @param {{anchor:THREE.Group, item:number, mesh:THREE.Mesh, owns:boolean,
   *   glow:THREE.Material}} h the hand being filled
   */
  _equip(h, itemId, iconFactory) {
    h.item = itemId;
    // Which swing plays is a property of what's in the fist, so it's resolved
    // on equip rather than looked up every frame. Everything without a tool
    // kind — blocks, torches, food, empty hands — falls back to the jab.
    h.track = SWINGS[ITEMS[itemId]?.tool?.kind] || SWINGS.default;
    this._clearMesh(h);
    if (!itemId) return;

    // An id with no definition (a save written by an older build, a renamed
    // item) must not reach the render loop: throwing here kills the rAF chain
    // and the whole game freezes on a black-box frame. Drops guards this the
    // same way — show empty hands and carry on.
    const def = ITEMS[itemId];
    if (!def) { h.item = null; return; }
    // Show authored art whenever there is any, and fall back to a textured cube
    // for the ordinary blocks that have none.
    //
    // This used to ask `RENDER_TYPE[def.block] !== R_CROSS`, which worked only
    // because the torch — the one block with a real model — happened to be the
    // one block drawn as a cross. Giving the torch a proper 3D shape in the
    // world therefore took the model out of the player's hand and replaced it
    // with a cube, a change nobody would think to look for in a mesher commit.
    // Asking whether the model exists cannot come apart that way.
    //
    // There are two questions here and they are not the same one. "Does this
    // have 3D art of its own?" chooses between a model and generated art, and
    // that is what hasModel answers. "Does its generated art have a cube form?"
    // chooses between a cube and a flat sprite — and a cross block (flower,
    // tall grass, sapling) has no cube form at all: Drops builds it as a plane.
    //
    // Asking only the first question meant a flower took the cube path, and the
    // cube path hands the *voxel* material a sprite's plane. That material
    // reads per-vertex layer, tint and tangent attributes that a plane has
    // none of, so it sampled nothing and the flower came out as a black card
    // in the fist.
    const isCube = def.block !== undefined && !hasModel(itemId)
      && RENDER_TYPE[def.block] !== R_CROSS;
    let mesh = null;
    if (isCube) {
      const src = this.dropsFactory(itemId);
      // Light it by its own light if it has any, so a hearth or a lantern in
      // the hand looks like the thing that is lighting the room.
      const emit = BLOCKS[def.block]?.light ?? 0;
      let mat = this.blockMaterial;
      if (emit > 0) {
        const lc = BLOCKS[def.block].lightColor || [1, 1, 1];
        // A glowing block is mostly dark rock with hot seams, and the two need
        // to stay far apart. The key and fill here are strong enough to lift
        // the rock to the same tone as the seams, so hold the albedo down
        // against them — a thing that makes its own light is not also a thing
        // that takes the room's light well.
        h.glow.color.setScalar(0.52);
        // Now the emissive can be worth having. It rides the tile's own
        // luminance (see the emissivemap override in createItemBlockMaterial),
        // so this lands on the seams and leaves the rock alone; the earlier
        // attempt had to be kept near zero only because it hit both equally.
        const s = 0.30 + (emit / 15) * 0.55;
        h.glow.emissive.setRGB(lc[0] * s, lc[1] * s, lc[2] * s);
        mat = h.glow;
      }
      if (src) mesh = new THREE.Mesh(src.geometry, mat);
    } else {
      // Tools, weapons and torches have real 3D art. It loads lazily, so the
      // first equip of a given model still shows the sprite for a frame or two
      // and swaps itself in when the geometry lands — and if the models aren't
      // there at all, the sprite is simply what you keep.
      const model = heldModel(itemId, (m) => this._adoptModel(h, itemId, m));
      if (model) { this._setMesh(h, model, false, true); return; }
    }
    if (!isCube) {
      let mat = this.spriteCache.get(itemId);
      if (!mat) {
        const tex = new THREE.TextureLoader().load(iconFactory.item(itemId));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        mat = new THREE.MeshStandardMaterial({
          map: tex, transparent: true, alphaTest: 0.35,
          side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05,
        });
        this.spriteCache.set(itemId, mat);
      }
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    }
    if (!mesh) return;

    // Both sit a little forward of the fist. The item anchor is at the end of
    // the limb now, so anything centred on it is skewered by the arm box — a
    // flat sprite especially, which came out sliced in half lengthways.
    if (isCube) {
      mesh.scale.setScalar(0.30);
      mesh.rotation.set(0.18, -0.70, 0.05);
      mesh.position.set(0, 0.03, -0.06);
    } else {
      // flat items read best held edge-on, like a card in the fist
      mesh.scale.setScalar(0.36);
      mesh.rotation.set(0, -1.10, 0.46);
      mesh.position.set(0.02, 0.06, -0.11);
    }
    this._setMesh(h, mesh, !isCube);
  }

  /**
   * @param {object} h the hand record
   * @param {THREE.Mesh} mesh
   * @param {boolean} owned true when this view model made the geometry and is
   *   the only thing holding it — sprite planes are per-equip and have to be
   *   released. Block and model geometry is shared out of a cache and must not
   *   be disposed here.
   * @param {boolean} [modelled] true only for authored 3D art out of
   *   `ItemModels` — a real model, at its authored pose, normalised to one unit
   *   on its longest axis. The bow draw needs to know, because it sizes the bow
   *   in view units against exactly that normalisation: applied to the flat
   *   sprite the fist holds for the frame or two before the GLB lands, it would
   *   blow a 0.36-unit card up to 1.41.
   */
  _setMesh(h, mesh, owned, modelled = false) {
    this._clearMesh(h);
    h.rig.add(mesh);
    h.mesh = mesh;
    h.owns = owned;
    h.modelled = modelled;
  }

  _clearMesh(h) {
    if (!h.mesh) return;
    h.rig.remove(h.mesh);
    if (h.owns) h.mesh.geometry.dispose();
    h.mesh = null;
    h.owns = false;
    h.modelled = false;
    // The rig belongs to the item that has just left, not to the hand. Left
    // posed, the next thing put in this fist would arrive wearing the last one's
    // draw — which for a bow released and swapped in the same frame is a torch
    // the size of the screen.
    h.rig.position.set(0, 0, 0);
    h.rig.quaternion.identity();
    h.rig.scale.setScalar(1);
  }

  /**
   * Late arrival of a lazily loaded model: only swap if it's still in that
   * hand. The hand is captured with the request rather than looked up, because
   * between the request and the callback the same item may have moved from one
   * hand to the other — checking `heldItem` alone would drop the model into the
   * right hand when it was the left that asked.
   */
  _adoptModel(h, itemId, mesh) {
    if (itemId !== h.item) return;
    this._setMesh(h, mesh, false, true);
  }

  /**
   * Hold the bow at `t` of a full draw, with `arrowItem` on the string.
   *
   * Called every frame while the use button is down and once with 0 when it is
   * not, which is the whole of the state: there is no start, no stop and no
   * animation clock to keep in sync with the one `main.js` is already keeping.
   * If the game's idea of the charge and the arm's ever disagree, the arm is
   * wrong by exactly one frame and self-corrects on the next.
   *
   * The arrow is a child of the item anchor, not of the bow mesh. The bow is a
   * cached template that `heldModel` hands out clones of and that the icon
   * painter and the third-person body may be holding at the same time; hanging
   * anything off it would put an arrow on all of them.
   *
   * @param {number} t 0..1
   * @param {number} [arrowItem] the item id to draw on the string
   */
  setDraw(t, arrowItem = 0) {
    this.draw = Math.max(0, Math.min(1, t));
    if (this.draw <= 0) {
      if (this.nock) this.nock.visible = false;
      return;
    }
    if (arrowItem && arrowItem !== this._nockItem) {
      if (this.nock) { this.hand.remove(this.nock); this.nock = null; }
      this._nockItem = arrowItem;
      // `worldModel` and not `heldModel`: the held pose is the diagonal an arrow
      // takes when you are *carrying* one, which is the wrong object entirely
      // for one lying on a string. This wants the raw model, upright and
      // unrotated, so the transform below is the only thing deciding where it
      // points.
      const build = (m) => {
        if (this.nock || this._nockItem !== arrowItem) return;
        // Neither posed nor aimed here. Both are `_poseDraw`'s, every frame,
        // off the bow's own matrix: the model is normalised to one unit on its
        // longest axis with its head on +Z, and the bow's shot is *also* its
        // +Z (see the archery note in ItemModels), so an arrow that simply
        // wears the bow's rotation is an arrow on the string — whatever pose
        // the bow is in and whatever that file does to it next.
        m.scale.setScalar(DRAW.scale);
        this.nock = m;
        this.hand.add(m);
      };
      const now = worldModel(arrowItem, build);
      if (now) build(now);
    }
    if (this.nock) this.nock.visible = true;
  }

  /**
   * Carry the bow to `DRAW.aim`, take the limb out of the picture, and put the
   * arrow on the string.
   *
   * **The blend is in view space, not on the rig's own local numbers, and that
   * is load-bearing.** What the rig gets set to is whatever makes the bow's
   * world transform equal a straight interpolation from where the hand happens
   * to be holding it to a fixed pose in front of the eye. Two things follow, and
   * neither is available from a local offset:
   *
   *  - the bow's path across the screen is a straight line to the destination,
   *    so it rises the whole way even though the arm underneath it is on its way
   *    *down* and out of frame. Blending the rig's local transform instead sends
   *    the bow diving with the arm for the first quarter of the charge and then
   *    hauling back up, which measured as -0.65 -> -0.92 -> -0.08 NDC: it sinks
   *    before it rises, which is the exact fault the previous rebuild fixed.
   *  - at full draw the bow is *anchored*, not offset: the walking bob, the
   *    sprint pull-back and the equip dip all still move the shoulder and none
   *    of them move the bow. A held aim that is rock steady is the correct
   *    reading of a pose the player is holding to line up a shot, and it comes
   *    out of the frame choice rather than out of a special case.
   *
   * The turn runs on `turnEase` and everything else on `drawEase`; see the note
   * on the eases for why the roll has to be the fast one.
   *
   * @param {number} t the draw the pose is at, 0..1
   * @param {number} aw the same draw on the arm's slower clock
   */
  _poseDraw(t, aw) {
    const h = this.hands.right;
    const limb = h.arm || h.stub;
    const drawing = t > 0 && h.mesh && h.modelled
      && ITEMS[h.item]?.tool?.kind === 'bow';
    if (!drawing) {
      // Unconditional, and cheaply so: an item that is not a drawn bow always
      // finds its rig at rest, whatever left it posed.
      h.rig.position.set(0, 0, 0);
      h.rig.quaternion.identity();
      h.rig.scale.setScalar(1);
      if (limb) limb.visible = true;
      return;
    }

    // The limb, once its retreat has taken it off screen. Measured: it covers
    // no pixels from `armEase` 0.25 onward, and `DRAW.hide` is 0.35 — a tenth
    // of the draw later — so this can only ever hide something that is already
    // invisible. `h.arm || h.stub` so the character's own arm is hidden when
    // there is one and the stand-in when there is not; writing to both would
    // put the stand-in back on top of the real limb.
    if (limb) limb.visible = aw < DRAW.hide;

    // The hand's transform in view space, built rather than read: `root` is at
    // identity, so the chain is two local matrices and a multiply. Asking three
    // for `matrixWorld` here would mean an `updateMatrixWorld(true)` over the
    // whole arm subtree every frame, ahead of the one the renderer already does.
    this.armPivot.updateMatrix();
    this.hand.updateMatrix();
    _mA.multiplyMatrices(this.armPivot.matrix, this.hand.matrix);   // hand -> view
    h.mesh.updateMatrix();

    // Where the bow would be if nothing were drawing it, and where it is going.
    _mB.multiplyMatrices(_mA, h.mesh.matrix).decompose(_pA, _qA, _sA);
    const dw = drawEase(t);
    _pA.lerp(_aimP, dw);
    _qA.slerp(_aimQ, turnEase(t));
    _sA.lerp(_aimS, dw);
    _mB.compose(_pA, _qA, _sA);                                     // bow -> view

    // rig = hand^-1 . bow . mesh^-1
    _mC.copy(_mA).invert().multiply(_mB).multiply(_mA.copy(h.mesh.matrix).invert());
    _mC.decompose(h.rig.position, h.rig.quaternion, h.rig.scale);

    if (!this.nock || !this.nock.visible) return;
    // The arrow, sited in the bow's own model space and then carried into the
    // hand's by the bow's matrix — which is the whole of "re-sited against the
    // new bow pose". `DRAW.string` is the string's own z on the model, so the
    // nock is on the string by construction and stays there if `ItemModels`
    // retunes the bow's rotation, position or height again.
    _mC.multiply(h.mesh.matrix);                                    // bow -> hand
    const bowScale = _sB.setFromMatrixColumn(_mC, 0).length() || 1;
    // Half the shaft, so that the *nock* — not the arrow's middle — lands on the
    // string. Both lengths are view units and the bow's model is not, hence the
    // divide.
    const half = (DRAW.scale / 2) / bowScale;
    const pull = (DRAW.pull * t) / bowScale;
    this.nock.position.set(0, 0, DRAW.string - pull + half).applyMatrix4(_mC);
    this.nock.quaternion.setFromRotationMatrix(_mB.extractRotation(_mC));
  }

  /**
   * The hand that would act if nobody says otherwise.
   *
   * This is `Inventory.active()`'s rule read off the fists instead of off the
   * slots: the offhand acts only when the main hand is empty and it is not. The
   * rule is duplicated rather than plumbed through because the viewmodel is
   * handed both slots' contents every frame — it already knows the answer — and
   * a hand argument at all nine `punch` sites in main is nine chances for one of
   * them to disagree with the inventory about who just mined.
   *
   * The `left.item > 0` half matters: with both hands empty `active()` returns
   * the empty offhand, but the offhand *arm* is not even drawn then, so a bare
   * punch is the right arm's — which is also the arm you can see.
   */
  actingHand() {
    return this.hands.right.item > 0 || this.hands.left.item <= 0 ? 'right' : 'left';
  }

  /**
   * Kick off the mining / placing swing.
   *
   * @param {'right'|'left'} [hand] which arm did it. Omitted — as every caller
   *   omits it — the acting hand is derived from what is in the two fists.
   *   Pass it explicitly for a swing that is not about what you are holding.
   */
  punch(hand = this.actingHand()) {
    const h = this.hands[hand] ? hand : 'right';
    this.swingHand = h;
    this.swingTrack = this.hands[h].track || SWINGS.default;
    this.swing = 0;
    this.onPunch?.(h);
  }

  /**
   * The same clock, without telling the body.
   *
   * A bow's release is a kick at the shoulder and a hand that stays where it
   * was; it is emphatically not a strike, and `punch` is wired straight to
   * `PlayerCharacter.punch`, which plays a melee attack clip over the whole
   * rig. Routing the loose through there made the third-person body swing an
   * invisible sword at the moment the arrow left — and it fought the draw pose
   * for the arm on the way out of it.
   *
   * So: the view model's own track plays, the body's does not. The body has its
   * own answer to a release, which is coming off the draw pose.
   */
  recoil(hand = this.actingHand()) {
    const h = this.hands[hand] ? hand : 'right';
    this.swingHand = h;
    this.swingTrack = this.hands[h].track || SWINGS.default;
    this.swing = 0;
  }

  /**
   * @param {{r:number,g:number,b:number}} [handLight] local block light at the
   *   player, 0..1 per channel. The view model lives in its own scene, so it
   *   sees none of the world's voxel lighting — without this, whatever you are
   *   holding stays lit by the sky alone and a torch-lit cave leaves your own
   *   hands in the dark.
   */
  update(dt, player, sky, handLight) {
    // The character's GLB is fetched by the world loader and lands whenever it
    // lands, which is after this view model was built and may be after the
    // player is already walking around. Polled here rather than pushed from the
    // loader because the poll is a `Map.has` and the push would be a fourth
    // party to a handshake between main, the loader and two rigs.
    if (!this._armsBuilt) this._tryArms();

    const holding = this.heldItem > 0;
    const rest = holding ? REST : REST_EMPTY;

    const track = this.swingTrack || SWINGS.default;
    // Per-animation rate: a sword slash finishes in ~230 ms, a pickaxe takes
    // ~385 ms to load up, drop and recover.
    if (this.swing < 1) this.swing = Math.min(1, this.swing + dt * track.rate);
    if (this.equipT < 1) this.equipT = Math.min(1, this.equipT + dt * 5.0);

    // walking bob
    this.bob += dt * player.moveAmount * 1.9;
    const bobAmt = Math.min(1, player.moveAmount / 5) * (player.grounded ? 1 : 0.25);
    const bx = Math.cos(this.bob) * 0.024 * bobAmt;
    const by = Math.abs(Math.sin(this.bob)) * 0.020 * bobAmt;

    // Swing pose, sampled from this item's own track.
    sampleSwing(track, this.swing, _swingP, _swingR);
    // Whose swing it is. The tracks are authored for the right arm, so the arm
    // that is not swinging simply takes none of them — one multiplier rather
    // than a second sample, and with `sw` at 1 every number below is the number
    // that was tuned.
    const sw = this.swingHand === 'right' ? 1 : 0;
    const osw = 1 - sw;

    // equip dip when the held item changes
    const eq = 1 - this.equipT;
    const equipY = -eq * 0.42;

    // The draw, layered on top of everything else the arm is doing.
    //
    // Additive rather than a track of its own, and that is what lets it coexist
    // with the walking bob, the equip dip and the release recoil without any of
    // them being special-cased: a drawing archer still sways as they walk, and
    // the recoil `punch()` plays on release lands on an arm that is already on
    // its way back from the draw.
    //
    // What the shoulder does here is *leave*: it sinks and drops the far end of
    // the limb out of the bottom of the frame, so that by 40% of the charge the
    // arm covers no pixels and the bow is the only held thing on screen. The bow
    // itself is not posed from here at all any more — see `_poseDraw`.
    //
    // Only the fall is eased (`DRAW_FALL`); the rise is already a ramp.
    if (this.draw >= this._drawShown) this._drawShown = this.draw;
    else {
      this._drawShown += (this.draw - this._drawShown) * Math.min(1, dt * DRAW_FALL);
      if (this._drawShown < 0.002) this._drawShown = 0;
    }
    const shown = this._drawShown;
    const aw = armEase(shown);
    const drawX = DRAW.p[0] * aw;
    const drawY = DRAW.p[1] * aw;
    const drawZ = DRAW.p[2] * aw;

    const px = rest.x + bx + _swingP.x * sw + drawX;
    const py = rest.y + by + _swingP.y * sw + equipY + drawY;
    const pz = rest.z + _swingP.z * sw + drawZ;

    // Shoulder anchor sits low-right, just behind the near plane. Everything —
    // bob, swing, equip dip, sprint — is applied here and nowhere else; the fist
    // and the held item are along for the ride.
    // Sprint pulls the arm back, eased rather than snapped. A hard 0/1 meant
    // any frame that changed its mind about sprinting jumped the hand 5cm and
    // back, and running yourself out of stamina used to change its mind every
    // single frame — the hand shook. The oscillation itself is fixed in Player
    // (you now have to recover before you can sprint again), but a term that
    // teleports the hand on a boolean is worth easing whatever feeds it.
    const sprint = player.sprinting ? 1 : 0;
    this._sprintEase += (sprint - this._sprintEase) * Math.min(1, dt * 9);
    this.armPivot.position.set(px, py, pz - this._sprintEase * 0.05);
    this.armPivot.rotation.set(
      // Rest tilt plus this frame's swing offset. Negative pitch drops the far
      // end of the limb (a strike), positive raises it (a wind-up or a scoop).
      // The tracks keep their pitch inside ±0.6: the fist is half a unit from
      // the pivot, so a radian here throws the item clean out of frame.
      ARM_REST_ROT.x + _swingR.x * sw + eq * 0.55 + DRAW.r[0] * aw,
      ARM_REST_ROT.y + _swingR.y * sw + DRAW.r[1] * aw,
      ARM_REST_ROT.z + _swingR.z * sw + DRAW.r[2] * aw,
    );

    // The bow's own half of the draw, and the limb going dark behind it.
    this._poseDraw(shown, aw);

    // The offhand arm, on the frames there is one. Everything above has already
    // run and is untouched by this — the two arms share the bob phase and the
    // sprint ease and nothing else, which is the whole reason the offhand can
    // be added without re-tuning a single number of the finished hand.
    //
    // The swing term is here now, and `osw` is zero on every frame it used to
    // be absent — an offhand that is only carrying still does not swing. It is
    // non-zero exactly when the offhand is the hand that acted, which is when
    // the main hand is empty; see `actingHand`.
    //
    // Mirrored on the same rule as `OFF_ARM_REST_ROT`: the sideways offset and
    // the two rotations that lean the limb inward — yaw and roll — change sign,
    // pitch does not. A track's forward-and-down is forward-and-down for either
    // arm; only its across-the-body component belongs to a side.
    //
    // `bx` is negated so the two arms sway apart and together as you walk rather
    // than sliding across the screen in step, which is what a shared sign looked
    // like — one arm chasing the other.
    if (this.offArmPivot.visible) {
      if (this.offEquipT < 1) this.offEquipT = Math.min(1, this.offEquipT + dt * 5.0);
      const oeq = 1 - this.offEquipT;
      this.offArmPivot.position.set(
        OFF_REST.x - bx - _swingP.x * osw,
        OFF_REST.y + by + _swingP.y * osw - oeq * 0.42,
        OFF_REST.z + _swingP.z * osw - this._sprintEase * 0.05,
      );
      this.offArmPivot.rotation.set(
        OFF_ARM_REST_ROT.x + _swingR.x * osw + oeq * 0.55,
        OFF_ARM_REST_ROT.y - _swingR.y * osw,
        OFF_ARM_REST_ROT.z - _swingR.z * osw,
      );
    }

    if (sky) {
      const p = sky.palette;
      this.key.color.copy(p.sun);
      this.key.intensity = 0.5 + p.sunIntensity * 0.9;
      this.fill.color.copy(p.zenith).lerp(p.horizon, 0.5).lerp(new THREE.Color(1, 1, 1), 0.4);
      this.fill.groundColor.copy(p.fog).multiplyScalar(0.6);
      this.fill.intensity = 0.5 + p.sunIntensity * 0.5;

      // Nearby torches, lanterns and a lit kiln warm the hands. Folded into the
      // fill rather than added as a third light, so it tints the whole item the
      // way a fire in the room would instead of casting a second shadow.
      if (handLight) {
        const l = Math.max(handLight.r, handLight.g, handLight.b);
        if (l > 0.002) {
          _lampColor.setRGB(handLight.r, handLight.g, handLight.b);
          const w = Math.min(1, l * 1.5);
          this.fill.color.lerp(_lampColor, w * 0.8);
          this.fill.groundColor.lerp(_lampColor, w * 0.5);
          this.fill.intensity += l * 1.9;
          this.key.intensity += l * 0.5;
        }
      }
    }
  }

  render(renderer) {
    if (!this.enabled) return;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAuto;
  }
}
