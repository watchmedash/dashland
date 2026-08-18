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
import { heldModel, hasModel, worldModel, tipPoint, withoutBobber} from '../render/ItemModels.js';
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

/**
 * **The first-person composition, and it is five constants rather than a
 * hundred and six poses.**
 *
 * The report was one sentence with four asks in it: "shovel can lean forward
 * more like the sword and make it little bigger, actually everything at hand
 * could be bigger, but the hand can be shorter and be straight not pointing in
 * the middle, and to be honest everything hand held should be leaning backwards
 * also leaning more to the right, like how minecraft does it".
 *
 * Three of the four are about the *frame* — how big the thing in your fist is,
 * where on screen it sits, and how it is tipped relative to the camera — and
 * exactly one is about a particular tool's grip (the shovel; that one is
 * `POSE.shovel` in `ItemModels.js` and is the only edit made there). Framing
 * belongs here and grip belongs there, and the split is not a filing preference:
 *
 *  - `ItemModels.POSE` is read by **both** views. `Character._buildPosedItem`
 *    takes the same `heldModel` clone for the third-person body, and that file
 *    already establishes the rule this follows — it drops `pose.pos` on the
 *    grounds that the nudge is "screen framing, not grip", and framing does not
 *    survive a change of camera. A global lean and a global size baked into 106
 *    poses would have been carried onto the body, where nobody asked for it and
 *    where it cannot be seen from here. Applied at the fist, third person is
 *    bit-identical.
 *  - and one hundred and six triples is a hundred and six chances to typo a
 *    change that is, by the player's own description, the same change to all of
 *    them.
 *
 * **What Minecraft is, taken from its numbers rather than from anyone's words.**
 * Five passes over this file were spent on adjectives — forward, back, leaning,
 * sideways — and each one moved the family somewhere the next report called by
 * the same name. So none of the constants below is an adjective any more. Every
 * one of them is either a figure lifted straight out of Minecraft or the
 * solution of an equation stated in screen terms, and the outcome of each is
 * measured, in degrees and in NDC, in the note that carries it.
 *
 * The three figures lifted, and where each lands:
 *
 *   - `ItemInHandRenderer.applyItemArmTransform` translates the held item by
 *     **(0.56, -0.52, -0.72)** blocks in the eye's own frame, at a default fov
 *     of **70** — which is this camera's fov exactly. That is `REST`: the fist
 *     is put on that point to four decimal places.
 *   - the `item/handheld` display transform's **scale 0.68** on a 16x16 sprite
 *     whose art runs corner to corner. That is `HELD_SCALE`.
 *   - its **rotation [0, -90, 25]** — from which only the 25 survives, as the
 *     angle the long axis makes on screen, for the reason set out on
 *     `HAND_TILT`: the other two turns describe a card and we are not holding
 *     cards.
 *
 * And the composition those produce, which is what a screenshot is judged on:
 *
 *   1. the item's long axis lies **on the screen diagonal, head high and to the
 *      right**, foot low and to the left;
 *   2. its **face is turned toward the camera**, so the object is readable —
 *      this is the one place a solid model must part company with Minecraft,
 *      whose card is drawn exactly edge-on and whose legibility comes from its
 *      being a picture in the first place;
 *   3. it sits **low in the bottom right**, large, and cropped by the right
 *      edge;
 *   4. and the arm is a **stub** entering the bottom-right corner, not a limb
 *      reaching across the view.
 *
 * Measured through the real glTF at 16:9 across all 106 posed items, this table
 * went from a mean 3.40% of the frame to 4.00%, and over the 48 items flat
 * enough for "edge-on" to mean anything the mean angle of the flat to the view
 * axis went 39.3 to 37.5 degrees, with the pickaxe — the worst in the game at
 * 86.7, six degrees off invisible — coming back to 60.2.
 */

/**
 * How much bigger everything in the fist is drawn, over its authored `height`.
 *
 * **Solved against Minecraft's scale, not chosen.** Minecraft draws a held tool
 * at `scale 0.68` on a sprite one block square, and the art on those sprites
 * runs corner to corner with about a pixel of margin — so the tool is drawn
 * `0.68 * 14 * sqrt(2) / 16 = 0.842` blocks long, and the eye is a block and a
 * bit from it. This table's longest item is the pickaxe at `height` 0.54, so
 *
 *     HELD_SCALE = 0.842 / 0.54 = 1.559
 *
 * is the multiplier at which our biggest tool is drawn exactly as long, in view
 * units, as Minecraft's. Everything else keeps its place in the table's relative
 * sizing, which is deliberate and hard-won — an apple is meant to be smaller
 * than a pickaxe, and Minecraft's answer to that (every item the same 16x16
 * card) is the one part of its sizing worth *not* copying.
 *
 * Measured through the real glTF at 16:9, over all 106 posed items: mean
 * coverage 3.40% -> 4.00% of the frame, and the pickaxe's long axis 1.36 -> 1.57
 * in NDC, against the 1.85 that Minecraft's 0.842 blocks subtend at its own
 * distance. It is drawn a little shorter than Minecraft's because ours is
 * anchored at the grip and Minecraft's at the card's centre, so the near end
 * sits nearer the eye; the head — which is the end the composition is built on —
 * lands where Minecraft's lands. See `REST`.
 *
 * Applied in `_setMesh`, which is the one funnel every held mesh goes through —
 * authored model, generated cube and fallback sprite alike — so a block in the
 * hand grows with a pickaxe rather than being forgotten.
 */
const HELD_SCALE = 1.56;

/**
 * The carry tilt: a view-space rotation laid over every held item's own pose,
 * and the whole of the item's orientation on screen.
 *
 * **It is stated ZYX, and that is the load-bearing part of this constant.** In
 * that order the matrix is `Rz . Ry . Rx`, so the roll is the *last* turn and is
 * therefore a roll about the view axis — the axis the camera looks down. Which
 * makes the three numbers separable, and separable is what six revisions of a
 * single XYZ triple never were:
 *
 *     x, y   set the angle of the item's flat to the view axis, and the angle
 *            of its long axis out of the screen plane;
 *     z      sets the angle of the long axis *on screen*, and nothing else. A
 *            rotation about the view axis cannot change either of the other two
 *            (checked: the pickaxe's flat and out-of-plane figures are identical
 *            to eight decimal places at z = 0 and at z = -0.805).
 *
 * **The three metrics, defined, because five reports were lost in the words.**
 * Every figure below is measured off the real glTF through this exact chain.
 *
 *  - *screen angle*: the long axis projected to the screen, in degrees
 *    clockwise from straight up, taken head-end first. +25 is the head a
 *    quarter-turn's-worth to the right of vertical, foot down and to the left.
 *  - *out of plane*: how far the long axis leaves the screen plane. 0 is the
 *    item drawn at its full length; 90 is the item pointing at the eye.
 *  - *flat to the view axis*: the angle between the plate normal — the model's
 *    thinnest principal axis — and the view axis. 0 is the face square to the
 *    camera, 90 is edge-on. **This is the metric that catches edge-on and
 *    silhouette area is not**: forcing the pickaxe exactly edge-on for a control
 *    reads 90.0 here while its covered area goes *up*, 4.50% face-on to 5.41%.
 *    Never judge this by area again.
 *
 * The thin axis only means anything when it is thinner than the middle one, so
 * every family figure quoted is over the 48 items whose third principal sigma is
 * under 0.6 of their second. A torch is 0.99 — a round pole with no face to
 * lose, however it is turned — and letting shapes like that into the average is
 * how a fit gets talked into sacrificing the tools to the fruit.
 *
 * **Where the numbers come from.** Minecraft's `item/handheld` first-person
 * transform is `rotation [0, -90, 25]` on a generated card. Reproduced, that
 * card's long axis leans +-45 degrees, its on-screen roll is 25 degrees, and its
 * flat sits at exactly 90 degrees to the view axis. Only the middle figure
 * transfers: the +-45 is an artefact of which way the sprite's own diagonal runs
 * and says nothing about a mesh, and the 90 is the one property that must *not*
 * be copied, because a card drawn edge-on is still a picture and a pickaxe drawn
 * edge-on is a stick. So:
 *
 *     z = -0.805    the roll that puts the family's long axes on Minecraft's
 *                   25 degrees, head high and to the right. Solved, as the
 *                   weighted circular mean of the ten long-handled items' own
 *                   screen angles minus 25, not dialled.
 *     x = 0.240     the attitude that turns the family's faces toward the
 *     y = 0.440     camera. Solved as a two-dimensional search minimising, over
 *                   21 weighted items, the flat's angle to the view axis and the
 *                   long axis's angle out of the screen plane, with a hard wall
 *                   past 60 degrees so that no single item can be traded toward
 *                   edge-on to flatter an average.
 *
 * What that lands, against the shipped `(0.70, 0, -0.13)` XYZ:
 *
 *     item     screen angle      out of plane        flat to view axis
 *     pick     -9.4 -> +22.7     6.1 -> 11.5         86.7 -> 60.2
 *     axe     -13.9 -> +12.7     5.9 -> 19.9         52.6 -> 29.6
 *     shovel   -3.0 -> +31.9    14.0 ->  7.2         32.2 ->  8.6
 *     sword   -14.8 -> +20.4    11.4 ->  4.3         37.8 ->  9.0
 *     torch    -4.8 -> +34.8    24.5 ->  3.1         24.8 -> 28.6
 *     rod     -27.8 -> +22.8    35.9 -> 22.7         42.4 -> 61.0
 *     stick   -10.6 -> +29.8    23.8 ->  4.8         38.9 ->  6.6
 *     bow     (its long axis is a stave, not a handle) 53.8 -> 64.5
 *
 * Every one of those eight carried its head high and to the **left** before, by
 * between 3 and 28 degrees. That is the thing five rounds of adjectives were
 * circling and never named: the family was composed on the wrong diagonal.
 *
 * **The two costs, stated rather than buried.** The rod goes 42.4 -> 61.0 and
 * the carried bow 53.8 -> 64.5, and they lose because they want the opposite
 * yaw from the pickaxe — the three of them trade almost one for one along `y`.
 * The pickaxe is weighted three times either of them and started 26 degrees
 * worse than either ends up, the bow's covered area *doubles* over the same
 * change (0.82% -> 1.67%) and its drawn pose is untouched (see `DRAW.aim`), and
 * nothing here is within 25 degrees of edge-on. Across the whole 106, the count
 * of items past 75 degrees is unchanged at three — but it is no longer the
 * pickaxe, the sea grape and the coral fan (86.7, 86.2, 76.2, all now 52-60);
 * it is a lollypop, a berry cluster and a lingonberry.
 *
 * Applied to the mesh in `_setMesh`, i.e. **about the item's own grip**, which
 * is where the origin already is (`loadGeometry` puts it there) and is what a
 * wrist does. Not applied to `this.hand`, which would tilt the nocked arrow with
 * it; and not applied to `armPivot`, which would take the arm along. It is
 * *pre*-multiplied there, so it is a turn of the screen rather than a turn of
 * the tool in the fist — see the note at that line.
 */
const HAND_TILT = new THREE.Euler(0.24, 0.44, -0.805, 'ZYX');

// Where the shoulder sits in view space. The hand hangs off the far end of the
// limb, so these are the hand rest points pushed back down the arm: hand ≈
// shoulder plus the limb vector.
//
// **The fist is put on Minecraft's own hand point, exactly.**
// `ItemInHandRenderer.applyItemArmTransform` translates the held item by
// **(0.56, -0.52, -0.72)** blocks in the eye's frame, and Minecraft's default
// field of view is 70 degrees, which is this camera's to the degree — so that
// triple is not an analogy, it is the same measurement in the same units seen
// through the same lens, and it can simply be adopted.
//
// `REST` is therefore solved rather than stated: the fist lands at
// `REST + Rx(ARM_REST_ROT.x) . HAND_LOCAL`, so
//
//     REST = (0.56, -0.52, -0.72) - (0, 0.1362, -0.3549) = (0.56, -0.656, -0.365)
//
// and the measured fist comes out at (0.5600, -0.5198, -0.7199). It was
// (0.50, -0.44, -0.72): 0.06 units to the right and 0.08 down, at the same
// depth, which is Minecraft's own composition — the item low in the bottom right
// with its handle running off the corner.
//
// What it does to the frame, measured through the real glTF at 16:9 with the
// tilt and scale above, as the head end of each tool in NDC (the composition is
// built on the head, which is the end held high and to the right):
//
//     pick  (0.84,  0.07)    sword (0.84,  0.27)    torch (1.02,  0.12)
//     axe   (0.54,  0.04)    rod   (1.17,  0.60)    stick (0.81, -0.25)
//
// against (1.00, 0.14) for Minecraft's own card taken through its display
// transform — head high, hard against the right edge, a little above the middle.
// The pickaxe's rightmost point reaches 1.84 in NDC, so it is cropped by the
// right edge as Minecraft's is.
//
// The one cost is the arm: the fist is 0.08 lower, so the stand-in limb's
// visible wedge in the bottom-right corner goes from 1.98% of the frame to
// 0.93%, entering at NDC y -0.82. That is the direction the composition asks for
// — "a stub coming up from the corner, not a limb across the screen" — but it is
// the number to move first if the hand ever reads as missing.
const REST = new THREE.Vector3(0.56, -0.656, -0.365);
/**
 * Where the fist goes when there is nothing in it.
 *
 * **The reported bug — "breaking a block with barehand have no animation as
 * hand is not showing as punching" — was this constant, and the hand was not
 * unanimated but off screen.** `punch()` was firing, the track was sampling, the
 * shoulder was moving; the limb it moved was simply outside the viewport for
 * every frame of the swing. Traced through the real chain at 16:9, with the fist
 * at `REST + Rx(ARM_REST_ROT.x) . HAND_LOCAL`:
 *
 *     rest point            fist in view space          fist in NDC
 *     REST                  (0.560, -0.520, -0.720)     (0.625, -1.031)
 *     REST_EMPTY, was       (0.620, -0.500, -0.640)     (0.778, -1.116)
 *     REST_EMPTY, now       (0.560, -0.363, -0.720)     (0.625, -0.720)
 *
 * The viewport is -1..1. Both of the first two rows are below its bottom edge,
 * and the reason the *held* case survives that is the thing in the fist: a
 * pickaxe is `HELD_SCALE * 0.54` long and reaches up into frame from a grip that
 * is not in it. An empty hand has nothing to reach with, so it is simply gone.
 *
 * **What the old note got wrong, since it is worth naming.** It claimed the
 * empty hand kept the 0.06 to the right and none of the 0.08 down "because 0.08
 * lower takes it to 0.00" — and the y it wrote is indeed 0.02 *higher* than
 * `REST`'s. But it also pulled z from -0.365 to -0.285, and a fist 0.08 nearer
 * the eye sees a frame that much smaller: the half-height at the fist goes 0.504
 * to 0.448, so the same view-space y is 8% further out of shot. The two edits
 * were made for opposite reasons and only one of them was measured. Nearer the
 * eye is not the same as higher up the screen.
 *
 * **So the depth goes back to `REST`'s and the height is solved.** At the fist's
 * depth of 0.72 the half-height is 0.5041, and NDC y -0.72 — low in the frame,
 * clear of the hotbar, with the forearm running off the bottom corner — wants
 * `F.y = -0.363`, which is the number below plus `HAND_LOCAL`'s carry. That is
 * `REST` with the fist lifted 0.157 and nothing else changed, which is exactly
 * the trade `REST`'s own closing note offers: "it is the number to move first if
 * the hand ever reads as missing."
 *
 * **And the punch really was played to an empty screen.** Rasterised silhouette
 * of the right arm alone — the view model's own scene rendered to a 1280x720
 * target with the character's real glTF limb on the shoulder, everything else
 * cleared, non-black pixels counted — sampled across the `default` jab that a
 * bare fist used to swing:
 *
 *     swing clock       old REST_EMPTY      new REST_EMPTY
 *     0.00 (rest)         0.000%              2.990%
 *     0.25                0.000%              1.931%
 *     0.38                0.000%              1.547%
 *     0.50 (the strike)   0.000%              1.227%
 *
 * Zero. Not small, not clipped at the corner — no pixels at any point in the
 * animation. Whatever `punch()` did was correct and invisible, which is exactly
 * what the report describes and why it describes it as the hand "not showing".
 * At the new rest point the limb enters at NDC y -1.0 and tops out at -0.616.
 *
 * Only ever read when the **right** fist is empty (see `update`), so no held
 * item's composition moves by a thousandth: `REST` is untouched and the tool
 * case renders the identical pixels it rendered before.
 */
const REST_EMPTY = new THREE.Vector3(0.56, -0.499, -0.365);

// Fist position in arm-local space. The counter-rotation cancels the arm's rest
// tilt: an item's own pose is then expressed in view space, the way it reads on
// screen, while still inheriting every bit of the arm's swing.
//
// **0.52 -> 0.38, which is "the hand can be shorter".** This one number is the
// whole of the limb's length, for both limbs there can be: the stand-in box is
// built to it below, and `_tryArms` *scales the character's real arm* so its far
// end lands exactly here — so shortening the anchor shortens whichever limb is
// on screen, and no swing amplitude, bob term or item offset has to move for it.
// The real arm scales uniformly, so it comes in 27% thinner as well, which is
// the other half of a stub.
const HAND_LOCAL = new THREE.Vector3(0, 0.01, -0.38);

/**
 * The limb's rest attitude — and it is now a pitch and nothing else.
 *
 * It was (0.30, 0.16, 0.12): a yaw that swung the far end of the arm 9 degrees
 * toward the middle of the screen and a roll that leaned it 7 more, so the limb
 * arrived across the frame pointing at the crosshair. Measured, the stand-in
 * limb ran along (-0.159, 0.292, -0.943) in view space — the x is the part the
 * report is about, and it is the literal reading of "be straight not pointing in
 * the middle".
 *
 * Zeroing both leaves the limb running dead ahead and slightly up, out of the
 * bottom-right corner, which is Minecraft's stub. The pitch goes 0.30 -> 0.34 to
 * put back the height the yaw was contributing.
 *
 * This costs nothing elsewhere: the fist group counter-rotates by exactly this
 * Euler (see the constructor), so every item pose stays expressed in view space
 * whatever this becomes, and the swing tracks are offsets *from* it.
 */
const ARM_REST_ROT = new THREE.Euler(0.34, 0, 0);

// The offhand arm, mirrored across the view's centre line: the shoulder moves to
// the left of the screen. The two rotations that used to lean the limb inward —
// yaw and roll — were the ones that changed sign, and both are now zero, so the
// mirror is the shoulder's x and nothing else. Pitch never changed sign: both
// arms hang at the same angle below the eye. There is no separate REST_EMPTY
// here because an empty offhand draws nothing at all; see `setOffhand`.
const OFF_REST = new THREE.Vector3(-0.56, -0.656, -0.365);
const OFF_ARM_REST_ROT = new THREE.Euler(0.34, 0, 0);

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
 *    it is drawn). At 0.85 out and 1.55 long, the stave over-fills the viewport
 *    — 3.10 of 2.00 in NDC, cropped top and bottom — and its centre line sits
 *    78% of the way across, on the right.
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
 * **The last row has been re-measured twice since, and both times the absolute
 * figures came out a little different from the ones above.** They are left as
 * written because they are still the shape of the animation — the rise, the
 * arm's retreat and the monotone growth are what the rows are for — but the
 * full-draw numbers to trust are the ones beside `aim` below, taken by
 * rasterising the real glTF at 16:9 with the bow's transform composed straight
 * from `aim` (which is what `_poseDraw` produces at t = 1, since `drawEase(1)`
 * and `turnEase(1)` are both exactly 1). On that measurement the pose these
 * rows describe reads 3.35% and 2.77 NDC rather than 3.56% and 2.48; the two
 * angles reproduce to a tenth of a degree, so the poses agree and only the
 * silhouette metric differs. Do not mix the two scales in one comparison.
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
  /**
   * **Bigger and further right, on "bow is perfect now but can be bigger and
   * more little to the right".** Only `p.x` and `len` move; the rotation is not
   * touched, which is what keeps every property the last two passes settled —
   * the stave stays 4.6 degrees off vertical, the shot stays 25.0 degrees off
   * the view axis, and the plane stays exactly as face-on as it was.
   *
   *   len   1.41 -> 1.55   (+10% linear, 1.21x the covered area)
   *   p.x   0.42 -> 0.52   (+0.10 view units at z -0.85)
   *
   * Re-measured through the real glTF at 16:9, bow only, at full draw:
   *
   *                        was        now
   *     coverage           3.35%      3.76%
   *     NDC height         2.77       3.10   (the viewport is 2.00; it is meant
   *     NDC width          0.33       0.40    to over-fill and crop, see above)
   *     NDC centre         (0.446,    (0.555,
   *                         -0.114)    -0.108)
   *     across the frame   72.3%      77.7%
   *     right edge         0.612      0.755  (1.000 is the edge of the screen)
   *
   * `p.z` is deliberately left at -0.85. Pulling the bow toward the eye is the
   * other way to make it bigger and it is the wrong one: it costs stave length
   * off the top and bottom for the same width, and it steepens the perspective
   * on a shape whose whole legibility is that you can see its curve.
   *
   * The nock is unaffected, which is the property `string`/`pull` were moved
   * into the bow's model space for. Measured at this `len`, the nock point's
   * distance to the nearest vertex of the string's straight run is 0.2294 in
   * bow-model units against 0.2522 before — it tracks the retune instead of
   * being left behind by it, which is exactly what that change bought.
   */
  aim: { p: [0.52, -0.07, -0.85], r: [-3.077, -0.431, -1.488], len: 1.55 },
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
 * no path around it. ^8 is there to spend as little of the charge as possible in
 * that crossing: the slerp is 57% done by the tenth of the charge and 83% by the
 * fifth, so the edge-on frames are few and early rather than spread across the
 * pull.
 *
 * What this does NOT do, despite what this note used to claim, is get the turn
 * over before the bow is worth looking at. Measured on the shipped constants
 * through the real glTF at 16:9: the worst plane angle is 88.4 degrees at draw
 * 0.10 for the right hand and 87.3 at 0.06 for the left, and the bow is not
 * small when it happens — it never drops below 2.4% of the frame, because that
 * is its coverage at rest. The old sentence assumed the carried bow was
 * effectively off screen and picked a threshold ("2% of the frame") the bow is
 * always above. There is no exponent that hides the crossing; only one that
 * shortens it, which is what ^8 buys. Retune only against a rendered frame.
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

/**
 * The rod, while a line is out.
 *
 * The complaint this answers is that a cast changed nothing you were holding:
 * the float was thirty cells away on the water, the line ran to it, and the rod
 * sat in the idle carry as though it had never been swung. So it leans out —
 * the hand drops and comes back a little towards the body, and the shoulder
 * pitches forward, which takes the far end of the rod down and out over the
 * water and puts the tip nearer the line it is holding.
 *
 * Deliberately a *lean and not a salute*, and the numbers are what keep it
 * there: a quarter radian is fifteen degrees of pitch, against the bow's
 * `DRAW.r[0]`, which is several times more and takes the whole arm out of
 * frame. The test is that you notice the rod has changed without being able to
 * say by how much. It was half this to begin with and did not survive a
 * side-by-side against the idle pose, which is the only way to judge it.
 *
 * Same shape as `DRAW.p`/`DRAW.r` — an offset laid additively on the shoulder,
 * not a track — so it composes with the walking bob, the equip dip and the
 * cast's own swing rather than fighting any of them. It is mirrored onto the
 * offhand by the same rule everything else is: the sideways offset and the two
 * rotations that lean the limb inward change sign, and the rest does not.
 *
 * **This is the hold, not the throw.** The throw is `SWINGS.rod`, a track like
 * every other tool's, and the two are layered rather than sequenced: the flick
 * plays out of the swing clock while this eases in underneath it at
 * `CAST_RATE`. `main.js` turns it on at the release rather than at the click,
 * so the lean arrives as the line does.
 */
const CAST = {
  p: [-0.02, -0.07, 0.06],
  r: [-0.26, 0.06, 0.15],
};

/**
 * The wind-up, which is the cast lean run backwards.
 *
 * The hold that decides how far the line goes was invisible: the button charged
 * for three quarters of a second and the arm did not move, so the only way to
 * know how hard you were about to throw was to throw it. The rod comes back
 * over the shoulder instead - in and up on the position, rolled back on the
 * rotation - and `CAST` then takes it forward, so the two poses read as one
 * motion with the release in the middle.
 *
 * Deliberately larger than CAST and opposite in Z. A wind-up you can only just
 * see is the same problem as no wind-up at all, and this one has to be legible
 * out of the corner of the eye while you are looking at the water.
 */
const WIND = {
  p: [0.05, 0.06, -0.13],
  r: [0.42, -0.10, -0.22],
};
/** How fast the rod winds back and settles, in units per second. Quicker than
 *  CAST_RATE so the arm keeps up with a fast flick of the button. */
const WIND_RATE = 11;

/** How fast the rod leans out and comes back, in units per second. */
const CAST_RATE = 6;

/**
 * The meal, and it is `CAST`'s shape rather than a track of its own.
 *
 * The report was "no eating animation in hands when eating a food": a berry
 * left the bag, the crumbs flew and the hand did not move for the whole 1.3
 * seconds it took. So the food comes up to the mouth and stays there while it
 * is chewed.
 *
 * **An additive shoulder offset on an eased clock, not a `SWINGS` track**, and
 * the reason is the one property the meal has that no track has: it can be
 * abandoned. A track is a fixed animation played at the player from t=0 to
 * t=1, and eating is a pose held for as long as the button is — releasing it a
 * third of the way through has to put the hand back from wherever it got to,
 * not run out the rest of a stroke. `CAST` is the same fact and eases the same
 * way, so this borrows its fact/eased pair (`_eat` / `_eatT`) wholesale and
 * interruption costs no code at all: main sets the fact to 0 and the arm
 * travels home from where it is.
 *
 * Being additive is also what keeps it out of the swing's way. If the player
 * attacks mid-meal the jab plays at the same shoulder and the two sum, exactly
 * as `CAST` and `SWINGS.rod` sum during a throw — and in practice the meal is
 * over by then anyway, because every path in `main.js` that acts on a button
 * zeroes `eating` first. The layering is there so that the frame in between is
 * a hand doing both rather than a hand snapping between two poses.
 *
 * The numbers are the fist walked from `REST` to the mouth. `REST` puts it at
 * view space (0.560, -0.520, -0.720) and the mouth is a little below and in
 * front of the eye, so the offset is in toward the centre line, up, and a touch
 * nearer — `p.z` is deliberately the smallest of the three for the reason set
 * out on `DRAW`: coming at the camera is how a gesture turns into a hand
 * looming over the thing it is meant to be showing.
 *
 * Measured through the real chain in the running game, right fist, chew phase
 * zero:
 *
 *     fist in view space    fist in NDC
 *     rest    (0.560, -0.520, -0.720)   (0.694, -1.031)
 *     eating  (0.359, -0.154, -0.577)   (0.555, -0.381)
 *
 * so the fist rises two thirds of the frame and comes a fifth of the way in
 * from the right edge, landing just below and right of the crosshair. The food
 * is therefore in shot and the middle of the screen is not covered by it. The
 * depth costs 0.14 units, which draws the item about a quarter larger — enough
 * that the meal reads, and well short of the 38% that turned the bow draw into
 * a hand.
 *
 * The offhand mirrors to (-0.555, -0.382) and the right fist does not move by a
 * ten-thousandth while the left eats, which is what the two shares of one clock
 * below are for.
 *
 * `r` turns the item's head in toward the mouth: pitch raises the far end of
 * the limb, and the yaw and roll are what tip an apple's top toward the middle
 * of the screen instead of presenting it side-on. Both of those are the pair
 * that changes sign for the offhand, by the same rule everything else here
 * mirrors on.
 */
const EAT = {
  p: [-0.31, 0.26, 0.06],
  r: [0.36, -0.30, 0.34],
};

/**
 * The chewing, laid over the raise.
 *
 * A small nod in and down and back out, so the food is worried at rather than
 * parked in front of the face for a second. It is a continuous oscillation and
 * not keys, because the meal's length is `main.js`'s to change and a bite count
 * baked into keyframes would silently retime with it.
 *
 * `rate` is in radians per second: 19 puts almost exactly four chews in the
 * 1.3s meal, which is what `audio.eat()` plays — four wet grains and a swallow
 * — so the gesture and the sound land on the same beats without either being
 * told about the other.
 *
 * Amplitudes are tiny on purpose. The fist is 0.38 out along the limb and the
 * food is further still, so 0.07 rad of pitch here is a visible nod; anything
 * at the scale of the swing tracks would be gnawing rather than eating.
 * Multiplied by `_eatT`, so the bob fades in with the raise and out with the
 * settle and there is no frame where a hand at rest twitches.
 */
const CHEW = {
  rate: 19,
  p: [0, -0.018, 0.014],
  r: [0.07, 0, 0.025],
};

/**
 * How fast the food goes up and comes back, in units per second.
 *
 * Faster than `CAST_RATE` because the meal is short: at 12 the raise is
 * essentially done in a quarter second, which leaves about 0.8s of chewing in
 * the middle of a 1.3s meal and a quarter second to settle. Slower than this
 * and a meal is over before the hand arrives; faster and the food teleports to
 * the mouth, which is the thing being fixed.
 */
const EAT_RATE = 12;

/**
 * Where in the rod's swing the float leaves the tip.
 *
 * A fraction of the normalised swing clock, and it is the *end of the flick* —
 * key 3 of `SWINGS.rod` — because that is the frame the tip is travelling
 * fastest and pointing where the throw is going. Released at the click instead,
 * as it used to be, the float was already in the air before the arm had begun
 * to move and the animation was decoration bolted onto a teleport.
 *
 * Stated here and turned into seconds by `CAST_RELEASE`, so `main.js` never
 * hard-codes a delay that a re-timed track would silently invalidate.
 */
const CAST_RELEASE_KEY = 0.56;

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
  // The cast. Reported: *"add animation when throwing cast ... instead of just
  // straight throw and sudden cast"* — the rod went from the idle carry to the
  // lean below with nothing in between, and the float was in the water on the
  // same frame as the click.
  //
  // A wind-up and a flick, and it is the only track here whose *timing* is
  // load-bearing rather than only its shape: `CAST_RELEASE_KEY` names the key
  // the float leaves at, and `main.js` holds the throw back until then. So the
  // three keys after t=0 are read as a sentence — take the tip back over the
  // shoulder, whip it forward and down, ride out the follow-through — and the
  // float leaves on the second of them.
  //
  // `rate` 2.9 makes the whole clock 345ms and the release land at 193ms. That
  // is deliberately at the fast end of this table: a cast is a flick of the
  // wrist, and anything slower reads as a bowler's run-up. The wind-up gets
  // 117ms of it, which is enough to see the direction reverse and not enough to
  // wait for.
  //
  // Amplitudes are the pickaxe's, not the sword's: the wind-up is +0.52 rad of
  // pitch against the pick's +0.46, and the flick -0.46 against its -0.44. The
  // rod is long and light and the same shoulder angle throws its tip further
  // than a pick head, which is what pays for the extra motion being legible
  // without the arm leaving the frame.
  rod: {
    rate: 2.9,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.34, p: [0.03, 0.09, 0.13], r: [0.52, 0.10, -0.12], e: 'in3' },   // wind up
      { t: 0.56, p: [-0.02, -0.06, -0.20], r: [-0.46, -0.08, 0.14], e: 'out3' }, // flick — the float goes
      { t: 0.72, p: [-0.01, -0.02, -0.10], r: [-0.22, -0.04, 0.06], e: 'out3' }, // follow through
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  /**
   * The bare fist, and it is its own track rather than `default`'s.
   *
   * `default` is what a block, a torch or an apple swings on, and those are all
   * *placing* motions with an object in the hand that the eye is already
   * following. A bare punch has no object, so the fist itself is the whole of
   * the animation and it has to carry the stroke on its own — which means a
   * wind-up you can see and a drive that arrives, not a half-second dip.
   *
   * It is a separate entry and not a retune of `default` for one reason: every
   * block, torch and item of food in the game swings on `default`, and none of
   * them was reported. One report, one change.
   *
   * The amplitudes are the pickaxe's shape at the sword's pace. Pitch is the
   * axis that reads here — the fist is 0.38 out along the limb, so 0.4 rad at
   * the shoulder is most of the lower third of the screen — and the wind-up is
   * deliberately shorter than the strike so the blow lands rather than rocks.
   * `rate` 4.0 makes the whole thing 250ms, between the sword's 217 and the
   * jab's 278: a punch is quick and it is not a slash.
   *
   * Rasterised on the same silhouette measurement as `REST_EMPTY`, right arm
   * alone at 16:9, with the top of the limb in NDC beside it:
   *
   *     key                 coverage   top      fist in NDC
   *     0.00  rest            2.99%    -0.616   (0.625, -0.720)
   *     0.20  cock back       4.09%    -0.385   (0.761, -0.484)
   *     0.46  land it         1.86%    -0.677   (0.449, -0.778)
   *
   * The stroke is therefore *up and nearer, then away and across* — the fist
   * grows by a third into the wind-up and falls to two thirds of rest on the
   * blow. That is the right way round: a punch that only got bigger would be a
   * hand pushed at the camera, and one that only got smaller would be a hand
   * being withdrawn.
   */
  fist: {
    rate: 4.0,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      // Cock back. `p.z` is +0.06 and deliberately small: coming toward the eye
      // is what makes a wind-up read, and it is also how the bow draw once ended
      // up as a hand looming over its own bow (see `DRAW`). At 0.06 the fist
      // grows 9% and stops.
      { t: 0.20, p: [0.03, 0.06, 0.06], r: [0.30, 0.05, -0.07], e: 'in' },
      { t: 0.46, p: [-0.03, -0.03, -0.25], r: [-0.40, -0.07, 0.09], e: 'out' }, // land it
      { t: 0.60, p: [-0.02, 0.00, -0.14], r: [-0.22, -0.04, 0.05], e: 'out3' }, // knock back
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Blocks, torches, food: the old short jab, which is still the right motion
  // for placing. A bare hand has `fist` above.
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
 * Seconds from the click to the float leaving the rod's tip.
 *
 * Derived from the track rather than restated beside it, so that re-timing the
 * cast moves the throw with it and the two can never disagree. Currently
 * 0.56 / 2.9 = **193ms**.
 */
export const CAST_RELEASE = CAST_RELEASE_KEY / SWINGS.rod.rate;

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
const _tip = new THREE.Vector3();
const _mT = new THREE.Matrix4();
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _mC = new THREE.Matrix4();
const _pA = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _sA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _qB = new THREE.Quaternion();
const _sB = new THREE.Vector3();
/** `HAND_TILT` as a quaternion, built once — see `_setMesh`. */
const _tiltQ = new THREE.Quaternion().setFromEuler(HAND_TILT);
const _aimP = new THREE.Vector3(...DRAW.aim.p);
const _aimQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...DRAW.aim.r));
const _aimS = new THREE.Vector3(DRAW.aim.len, DRAW.aim.len, DRAW.aim.len);

/**
 * The same aim for a bow drawn in the **left** fist: `DRAW.aim` reflected in the
 * screen's centre line, and *derived* from it rather than stated beside it.
 *
 * That matters more here than anywhere else in this file. `DRAW.aim` is the pose
 * the player signed off — near-vertical stave, no arm in frame, the arrow
 * crossing to the crosshair — and it took three passes and two reports to land
 * (see the turn table on `DRAW`). A second literal triple for the other hand is a
 * second thing to retune every time that one moves, and the first report after it
 * drifted would be "the left hand's bow is wrong" with no way to tell which of
 * the two was.
 *
 * **The reflection, and why it is a conjugation.** Mirroring the scene in the
 * plane x = 0 is `S = diag(-1, 1, 1)`. A point goes to `S p`, which is the x
 * negated below. An orientation goes to `S R S`, which is still a proper rotation
 * (two sign flips in the determinant) — and since `S` is improper, conjugating by
 * it reverses the turn: `S rot(n, θ) S = rot(S n, -θ)`. In quaternion terms that
 * is exactly `(x, y, z, w) -> (x, -y, -z, w)`, which is the line below and is why
 * there is no Euler anywhere in it. Composing Eulers by hand is what put a sign
 * error in the offhand rest three revisions ago.
 *
 * **What it does to the bow, checked against its geometry rather than assumed.**
 * The bow lies in its own XZ plane: stave along model X, symmetric tip to tip at
 * x = ±0.9787, string a straight run at model z = -0.28, shot along +Z. Under
 * `S R S`:
 *
 *   - the shot (`R ẑ`) goes to `S R ẑ` — mirrored, so it crosses the frame toward
 *     the crosshair from the other side, which is the whole ask;
 *   - the stave axis (`R x̂`) goes to `-S R x̂`. The extra sign is a tip-for-tip
 *     swap, and the stave is symmetric tip to tip, so the picture is the mirror
 *     picture and not a bow standing on its head;
 *   - the string's offset from the grip is `-Z` in model space and therefore
 *     rides the same mirror.
 *
 * And the nock is untouched by any of it: `_poseDraw` sites it at a model-space z
 * on the bow's own matrix, so its distance to the string is a length in bow model
 * units and a rotation — mirrored or not — cannot change it. Measured, not
 * argued: identical to four decimals in both hands at draw 0.5 and 1.0.
 */
const _aimPL = new THREE.Vector3(-DRAW.aim.p[0], DRAW.aim.p[1], DRAW.aim.p[2]);
const _aimQL = new THREE.Quaternion(_aimQ.x, -_aimQ.y, -_aimQ.z, _aimQ.w);

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
    // Pivot sits at the shoulder; the limb extends forward, away from the
    // camera. Kept slim and short — anything nearer than ~0.4 units balloons
    // under perspective and swallows the corner of the screen.
    //
    // This box is the stand-in. The character's arm replaces the *mesh* and
    // nothing else: the pivot, the item anchor and every number in the swing
    // tracks belong to this group, which is why a real arm can be swapped in
    // without retuning any of them.
    // 0.62 -> 0.48 with the same overhang past the fist, following `HAND_LOCAL`
    // down from 0.52 to 0.38. The box still runs from just behind the shoulder
    // (z +0.03) to just past the fist (z -0.45), so the knuckles are covered and
    // nothing else is.
    const armGeo = new THREE.BoxGeometry(0.14, 0.14, 0.48);
    armGeo.translate(0, 0, -0.21);
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
    /**
     * Which fist the bow is being drawn in, and therefore which arm retreats,
     * which anchor carries the arrow and which of the two aims the bow is taken
     * to. Told by `setDraw`; `'right'` until something says otherwise, so a
     * caller that has no opinion gets what this did before there was a choice.
     */
    this._drawHand = 'right';

    /**
     * Whether a fishing line is out, as a 0..1 the pose eases along. See `CAST`.
     *
     * Two numbers rather than one because a cast starts and ends on a single
     * frame at either end and the arm must not teleport: `_cast` is the fact
     * and `_castT` is what the shoulder is actually at.
     */
    this._cast = 0;
    this._castT = 0;
    // The wind-up, and what the shoulder is actually at - the same fact/eased
    // pair the cast keeps, for the same reason: the charge can go 0 -> 1 -> 0
    // in a few frames and the arm must not teleport.
    this._wind = 0;
    this._windT = 0;
    /** Which fist is holding the cast rod, so the other arm is untouched. */
    this._castHand = 'right';

    /**
     * Whether a meal is in progress, as the same fact/eased pair the cast keeps
     * — see `EAT`. `_chew` is the chewing bob's own phase, free-running while
     * the pose is up so that a meal interrupted and restarted does not snap the
     * nod back to the top of its cycle.
     */
    this._eat = 0;
    this._eatT = 0;
    this._chew = 0;
    /** Which fist the food is in. Food can be eaten from either. */
    this._eatHand = 'right';

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
   * from the offhand — it carried and it showed. The right button's fall-through
   * repealed that: when the main hand has no answer for what you are aiming at,
   * the offhand is the hand that places, eats, feeds or draws a bow, so a tool
   * there has to swing like that tool. The track is resolved per hand in `_equip`
   * and `punch` picks the one belonging to the hand that acted — which `main.js`
   * names explicitly, from the slot it charged the action to.
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
    // kind — blocks, torches, food — falls back to the jab; an *empty* fist
    // gets `fist`, which is the punch the jab was standing in for.
    h.track = itemId > 0
      ? (SWINGS[ITEMS[itemId]?.tool?.kind] || SWINGS.default)
      : SWINGS.fist;
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
    // The composition pass, and this is the only place it happens.
    //
    // Every held mesh in the game arrives here — the authored model out of
    // `ItemModels`, the generated cube a plain block is drawn as, and the flat
    // sprite that stands in while a GLB loads — so applying `HELD_SCALE` and
    // `HAND_TILT` at this one line is what makes "everything at hand" mean
    // everything rather than "the tools". See the note on those two constants.
    //
    // The rotation is *pre*-multiplied: the mesh's own quaternion is its
    // authored pose expressed in view space (the fist counter-rotates the arm's
    // rest tilt for exactly that reason), so pre-multiplying lays the carry tilt
    // on in the same frame — a tip of the screen, not a turn of the tool in the
    // fist. Post-multiplying would rotate in the item's own axes and give a
    // different, and wrong, answer per item.
    //
    // The mesh is always a fresh object at this point — a clone from
    // `heldModel`, or a Mesh built two dozen lines up — so this is never applied
    // twice to the same transform. `_clearMesh` above has already emptied the
    // rig, which is the other half of that guarantee.
    mesh.quaternion.premultiply(_tiltQ);
    mesh.scale.multiplyScalar(HELD_SCALE);
    mesh.position.multiplyScalar(HELD_SCALE);
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
   * Where the tip of a held model is in **world** space, or null.
   *
   * For the one thing the world scene has to draw *from* a held item: the
   * fishing line, which runs from the rod's tip to a float out on the water.
   * The rod is drawn in this file's own scene and has no world position at all,
   * which is why the line used to start from a constant near the camera — and
   * measured through the real chain that constant sits **0.69 view units** from
   * the tip of a rod that is 0.81 units long in hand. It was pointing at the
   * lower right of the screen while the tip was in the upper right corner.
   *
   * Two frames have to be crossed and both matter:
   *
   * - **Space.** The item hangs off `hand -> rig -> mesh`, so its own
   *   `matrixWorld` is in this scene, and this scene's camera is the one at
   *   `this.camera`. Going through that camera's inverse gives eye space, which
   *   is the only frame the two scenes share.
   * - **Field of view.** This camera is fixed at 70 degrees (see the
   *   constructor) and the world's follows `settings.fov`, default 75 and
   *   pushed further by sprint and pulled to 44 by the zoom. A point copied
   *   across without correcting lands somewhere else on the screen: NDC is
   *   `(x / -z) / tan(fov/2)`, so holding the screen position fixed means
   *   scaling x and y by `tan(worldHalf) / tan(70/2)` — 1.096 at the default,
   *   0.601 at full zoom. Both cameras render the full canvas, so the aspect
   *   term is common and cancels.
   *
   * @param {number} itemId the item whose tip is wanted; whichever hand holds it
   * @param {THREE.PerspectiveCamera} worldCamera
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3|null} null when that item is not in a fist, or its
   *   model has not loaded yet, or first person is not what is being drawn
   */
  tipAnchorWorld(itemId, worldCamera, out) {
    if (!this.enabled) return null;
    const h = this.hands.right.item === itemId ? this.hands.right
      : this.hands.left.item === itemId ? this.hands.left : null;
    if (!h || !h.mesh || !h.modelled) return null;
    if (!tipPoint(itemId, _tip)) return null;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    _tip.applyMatrix4(h.mesh.matrixWorld)
      .applyMatrix4(_mT.copy(this.camera.matrixWorld).invert());
    const k = Math.tan(THREE.MathUtils.degToRad(worldCamera.fov) / 2)
      / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    _tip.x *= k; _tip.y *= k;
    worldCamera.updateMatrixWorld();
    return out.copy(_tip).applyMatrix4(worldCamera.matrixWorld);
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
   * **A bow can be drawn from either fist**, so the hand is an argument. It was
   * `this.hand` throughout, back when a bow only ever drew from the main hand;
   * once the offhand could draw one, that hard-coding put the bow in the left
   * fist and the arrow floating out on the right, because the two are parented to
   * different anchors and only the arrow's was fixed. Everything the draw touches
   * — this anchor, the arm that retreats in `update`, and the aim `_poseDraw`
   * carries the bow to — now reads `_drawHand`, so there is one answer rather
   * than three chances to disagree.
   *
   * The arrow is reparented rather than rebuilt when the hand changes: it is the
   * same model on the same string, and swapping a bow between fists mid-draw
   * should not cost a mesh.
   *
   * @param {number} t 0..1
   * @param {number} [arrowItem] the item id to draw on the string
   * @param {'right'|'left'} [hand] the fist holding the bow. `main.js` passes
   *   `_handOf(bow.slot)` — the slot the draw was actually charged to — rather
   *   than letting this guess from what is in the fists.
   */
  setDraw(t, arrowItem = 0, hand = 'right') {
    this._drawHand = this.hands[hand] ? hand : 'right';
    this.draw = Math.max(0, Math.min(1, t));
    if (this.draw <= 0) {
      if (this.nock) this.nock.visible = false;
      return;
    }
    if (arrowItem && arrowItem !== this._nockItem) {
      if (this.nock) { this.nock.parent?.remove(this.nock); this.nock = null; }
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
      };
      const now = worldModel(arrowItem, build);
      if (now) build(now);
    }
    if (this.nock) {
      // Parented here and not in `build`, so that the late arrival of a lazily
      // loaded arrow and a bow that changed hands mid-draw are the same one
      // line. Guarded because three's `add` detaches and re-appends even when the
      // parent is already this one, and this runs every frame of every draw.
      const anchor = this.hands[this._drawHand].anchor;
      if (this.nock.parent !== anchor) anchor.add(this.nock);
      this.nock.visible = true;
    }
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
    const key = this._drawHand;
    const h = this.hands[key];
    const limb = h.arm || h.stub;
    const drawing = t > 0 && h.mesh && h.modelled
      && ITEMS[h.item]?.tool?.kind === 'bow';
    // The hand that is *not* drawing, every frame, whether or not the other one
    // is. This used to be one hand's business because the draw was one hand's,
    // and a bow moved from the right fist to the left would otherwise leave the
    // right rig frozen at full draw — a bow-sized pickaxe hanging in front of the
    // eye, held by an arm that is still hidden. Resetting a rig is three writes
    // that are already the common case, so there is nothing to save by guessing.
    for (const k of HANDS) {
      if (k === key) continue;
      const o = this.hands[k];
      o.rig.position.set(0, 0, 0);
      o.rig.quaternion.identity();
      o.rig.scale.setScalar(1);
      const ol = o.arm || o.stub;
      if (ol) ol.visible = true;
    }
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
    h.pivot.updateMatrix();
    h.anchor.updateMatrix();
    _mA.multiplyMatrices(h.pivot.matrix, h.anchor.matrix);          // hand -> view
    h.mesh.updateMatrix();

    // Where the bow would be if nothing were drawing it, and where it is going.
    // The destination is `DRAW.aim` for the right fist and its mirror for the
    // left; see `_aimPL`. Only the target moves — the blend, the eases and the
    // rig solve below are the same arithmetic for either hand, because the hand's
    // own matrix above is already the mirrored one.
    _mB.multiplyMatrices(_mA, h.mesh.matrix).decompose(_pA, _qA, _sA);
    const dw = drawEase(t);
    _pA.lerp(key === 'left' ? _aimPL : _aimP, dw);
    _qA.slerp(key === 'left' ? _aimQL : _aimQ, turnEase(t));
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
   * There is a line in the water, or there is not.
   *
   * Told by `main.js` at the two moments the cast begins and ends, rather than
   * polled: the view model has no idea what a lake is, and "is something on the
   * end of this" is not a question it could answer if it wanted to.
   *
   * @param {boolean} on
   * @param {'right'|'left'} [hand] the fist the rod is in. Kept from the last
   *   cast on the way down, so the arm that leaned is the arm that comes back.
   */
  /**
   * How far the cast is wound up, 0 to 1.
   *
   * Told every frame while a rod is in hand, unlike `setCast`, because this is
   * a continuous value and not an event. Shares `_castHand`, so the fist that
   * winds up is the fist that throws.
   *
   * @param {number} t
   * @param {'right'|'left'} [hand]
   */
  setCastCharge(t, hand) {
    this._wind = Math.max(0, Math.min(1, t || 0));
    if (this._wind > 0 && this.hands[hand]) this._castHand = hand;
  }

  setCast(on, hand) {
    this._cast = on ? 1 : 0;
    if (on && this.hands[hand]) this._castHand = hand;
    // The rod's own float goes while its float is on the water. Two of the same
    // object, one in your fist and one twenty cells away on the end of the line,
    // reads as a duplication bug. Swapped on the mesh rather than rebuilt: the
    // complement is cached on the geometry, so this is a pointer assignment.
    for (const k of ['right', 'left']) {
      const h = this.hands[k];
      const g = h && h.mesh && h.mesh.geometry;
      if (!g) continue;
      if (on && k === this._castHand) {
        const alt = withoutBobber(g);
        if (alt !== g) h.mesh.geometry = alt;
      } else if (g.userData.withFloat) {
        h.mesh.geometry = g.userData.withFloat;
      }
    }
  }

  /**
   * A meal is or is not in progress, in the fist that is holding the food.
   *
   * Told every frame from `this.eating` rather than started and stopped at the
   * edges, because `main.js` abandons a meal from six places — a release, a
   * placement, a full stomach, a bow, a feed that was not one — and an
   * animation that has to be turned off by name at each of them is one branch
   * away from a hand stuck at the mouth. A level, sampled where the swing and
   * the cast are already sampled, cannot get out of step with the fact.
   *
   * @param {boolean} on whether the player is chewing this frame
   * @param {'right'|'left'} [hand] the fist the food is in
   */
  setEating(on, hand) {
    this._eat = on ? 1 : 0;
    if (on && this.hands[hand]) this._eatHand = hand;
  }

  /**
   * The hand that would act if nobody says otherwise.
   *
   * **A fallback, and no longer the rule.** It reads the one guess this view can
   * make from what it is holding: the right arm swings whenever the right fist
   * has anything in it, and the left only when the right is empty and the left is
   * not. That is a guess because the real answer lives in the inventory and
   * depends on the button and on what you are aiming at — the left button is the
   * main hand's however empty it is, and the right button falls through to the
   * offhand on whether the main hand has a *use* for the target, not on whether
   * it is full. So `main.js` names the hand at every call site, from the slot it
   * actually charged the action to (`_handOf`), and this is what is left for a
   * caller that has no slot to point at.
   *
   * The `left.item > 0` half is what keeps a bare-handed punch on the right arm:
   * with both fists empty the offhand *arm* is not drawn at all, so swinging it
   * would be an invisible punch.
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
    // Whose retreat this is. The arm that leaves is the arm holding the bow, and
    // with a bow in the offhand that is the left one — the right may well be
    // holding the pickaxe you are carrying it with, and sinking *that* out of
    // frame is a tool the player did not put away. Split as two shares of the one
    // clock rather than two clocks: only one hand can be drawing, so `rdw + ldw`
    // is always exactly `aw` and there is no state that can drift.
    const rdw = this._drawHand === 'left' ? 0 : aw;
    const ldw = aw - rdw;
    const drawX = DRAW.p[0] * rdw;
    const drawY = DRAW.p[1] * rdw;
    const drawZ = DRAW.p[2] * rdw;

    // The cast lean, split between the two arms exactly as the draw is: one
    // share each, summing to `this._castT`, so only the fist holding the rod
    // moves and there is no second piece of state to drift.
    this._castT += (this._cast - this._castT) * Math.min(1, dt * CAST_RATE);
    if (this._castT < 0.002) this._castT = 0;
    const rcw = this._castHand === 'left' ? 0 : this._castT;
    const lcw = this._castT - rcw;

    // ...and the wind-up, on the same split and its own clock.
    this._windT += (this._wind - this._windT) * Math.min(1, dt * WIND_RATE);
    if (this._windT < 0.002) this._windT = 0;
    const rww = this._castHand === 'left' ? 0 : this._windT;
    const lww = this._windT - rww;

    // The meal, on the same one-clock-two-shares split as the draw and the cast.
    // The chew phase only runs while the pose is up, so a hand at rest holds
    // whatever phase it settled at instead of counting through a cycle nobody
    // can see. `chew` already carries `_eatT`, so the bob fades in and out with
    // the raise and every term below can be written as though it did not.
    this._eatT += (this._eat - this._eatT) * Math.min(1, dt * EAT_RATE);
    if (this._eatT < 0.002) this._eatT = 0;
    if (this._eatT > 0) this._chew += dt * CHEW.rate;
    const rew = this._eatHand === 'left' ? 0 : this._eatT;
    const lew = this._eatT - rew;
    const chew = Math.sin(this._chew) * this._eatT;

    const px = rest.x + bx + _swingP.x * sw + drawX + CAST.p[0] * rcw + WIND.p[0] * rww
      + (EAT.p[0] + CHEW.p[0] * chew) * rew;
    const py = rest.y + by + _swingP.y * sw + equipY + drawY + CAST.p[1] * rcw + WIND.p[1] * rww
      + (EAT.p[1] + CHEW.p[1] * chew) * rew;
    const pz = rest.z + _swingP.z * sw + drawZ + CAST.p[2] * rcw + WIND.p[2] * rww
      + (EAT.p[2] + CHEW.p[2] * chew) * rew;

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
      ARM_REST_ROT.x + _swingR.x * sw + eq * 0.55 + DRAW.r[0] * rdw + CAST.r[0] * rcw + WIND.r[0] * rww
        + (EAT.r[0] + CHEW.r[0] * chew) * rew,
      ARM_REST_ROT.y + _swingR.y * sw + DRAW.r[1] * rdw + CAST.r[1] * rcw + WIND.r[1] * rww
        + EAT.r[1] * rew,
      ARM_REST_ROT.z + _swingR.z * sw + DRAW.r[2] * rdw + CAST.r[2] * rcw + WIND.r[2] * rww
        + (EAT.r[2] + CHEW.r[2] * chew) * rew,
    );

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
    //
    // The draw's retreat is mirrored onto it by that same rule: the sideways
    // offset and the two rotations that lean the limb inward — yaw and roll —
    // change sign, the sink, the depth and the pitch do not. `ldw` is zero on
    // every frame the offhand is not the drawing hand, so an offhand that is
    // merely carrying is untouched by any of this.
    if (this.offArmPivot.visible) {
      if (this.offEquipT < 1) this.offEquipT = Math.min(1, this.offEquipT + dt * 5.0);
      const oeq = 1 - this.offEquipT;
      this.offArmPivot.position.set(
        OFF_REST.x - bx - _swingP.x * osw - DRAW.p[0] * ldw - CAST.p[0] * lcw
          - (EAT.p[0] + CHEW.p[0] * chew) * lew,
        OFF_REST.y + by + _swingP.y * osw - oeq * 0.42 + DRAW.p[1] * ldw + CAST.p[1] * lcw
          + (EAT.p[1] + CHEW.p[1] * chew) * lew,
        OFF_REST.z + _swingP.z * osw - this._sprintEase * 0.05 + DRAW.p[2] * ldw + CAST.p[2] * lcw
          + (EAT.p[2] + CHEW.p[2] * chew) * lew,
      );
      this.offArmPivot.rotation.set(
        OFF_ARM_REST_ROT.x + _swingR.x * osw + oeq * 0.55 + DRAW.r[0] * ldw + CAST.r[0] * lcw + WIND.r[0] * lww
          + (EAT.r[0] + CHEW.r[0] * chew) * lew,
        OFF_ARM_REST_ROT.y - _swingR.y * osw - DRAW.r[1] * ldw - CAST.r[1] * lcw
          - EAT.r[1] * lew,
        OFF_ARM_REST_ROT.z - _swingR.z * osw - DRAW.r[2] * ldw - CAST.r[2] * lcw
          - (EAT.r[2] + CHEW.r[2] * chew) * lew,
      );
    }

    // The bow's own half of the draw, and the limb going dark behind it.
    //
    // **After both shoulders, not between them.** `_poseDraw` builds the drawing
    // hand's view-space matrix out of `pivot.matrix` and `anchor.matrix` by hand,
    // so it has to run once this frame's shoulder is on them — and for a bow in
    // the left fist that shoulder is the one set immediately above. Called from
    // where it used to be, the offhand draw solved against last frame's arm and
    // the bow lagged the walk cycle by a frame. Nothing about the right hand
    // cares: `armPivot` was written well above and the offhand block does not
    // touch it.
    this._poseDraw(shown, aw);

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
