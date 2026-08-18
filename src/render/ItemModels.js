// Real 3D art for the items that are not blocks: tools, weapons, torches, food.
//
// The tools, weapons and produce come from CC0 packs; the raw materials are
// ours, authored in WAM (see CREDITS.md for both). Either way it is low-poly,
// flat shaded, one mesh per file, and one shared texture atlas per pack — or
// none at all, where the colour rides on the vertices. That makes them cheap
// enough to drop straight into the first-person view model: every item in the
// game is one geometry and one material, and an atlas is fetched once for the
// whole pack that needs it.
//
// The same meshes back the inventory icons (`iconModel`, painted by
// `ui/Icons.js`), which is the whole point of routing both through here: what
// you see in your fist and what you see in the grid are the same object.
//
// Nothing here blocks world load. `heldModel()`/`iconModel()` answer
// synchronously from cache or return null, and the caller keeps whatever it was
// already showing (the hand-drawn sprite) until the promise lands. If
// `public/models/` is missing the fetch fails, the failure is remembered, and
// the sprite stays forever.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEMS, ARMOUR_TIERS } from '../game/Items.js';

const BASE = 'models/';

/**
 * The packs, and how their art wants to be treated.
 *
 * `tint` marks the packs whose greys are tool heads and get re-coloured per
 * tier; the produce pack is authored flat and keeps its own colours. `nearest`
 * is for palette textures — the produce atlas is 8x8, one texel per colour, so
 * any filtering at all bleeds neighbouring swatches across every UV seam.
 */
const PACKS = {
  tools:   { atlas: 'tools_bits_texture.png',   tint: true },
  weapons: { atlas: 'weapons_bits_texture.png', tint: true },
  produce: { atlas: 'produce_colortex.png',     tint: false, nearest: true },
  // Kenney's Food Kit. Shipped as GLB with the atlas as a sibling file, hence
  // `ext` — every other pack here is .gltf + .bin. The GLB names that texture by
  // relative URI, so `food/Textures/colormap.png` has to keep that exact path on
  // disk even though the material below is built from our own copy of it.
  //
  // `fitMax` is the one that matters: the shared normalisation divides by the
  // model's *height*, which is right for a pickaxe and ruinous for a pizza — a
  // 4cm-tall disc came out twenty times too wide. Food is as often flat as it is
  // upright, so the longest axis is what gets fitted instead.
  food:    { atlas: 'food/Textures/colormap.png', tint: false, nearest: true, ext: 'glb', fitMax: true },
  // Ours, authored in WAM (see `art/wam/items/*.wam`). No atlas at all: the palette
  // is baked per vertex, which is what lets a four-colour model still be one
  // merged geometry and one material like everything else here. `flat` is the
  // other half of the look — the source meshes ship no normals precisely so
  // that this side gets to derive hard-edged ones.
  wam:     { atlas: null, tint: false, flat: true },
  // The fish pack — the same rigged bodies `game/Mobs.js` swims past you, reused
  // as the fifteen catchable species. It is the first pack here with no atlas
  // *and* no vertex colours: the models carry no UVs at all and every colour on
  // them is a `baseColorFactor` on one of three to six materials, which is how a
  // clownfish is orange with white bands and 1,530 triangles.
  //
  // `bakeColor` is the whole of the adaptation. This file's contract is one
  // geometry and one material per item, so the per-primitive colours are written
  // into a COLOR_0 attribute at load and the pack then rides the same
  // vertex-colour material the WAM models do. Six materials become one draw call
  // and nothing downstream — the icon painter, the view model, the ground drop —
  // learns that this pack is different.
  //
  // `flat` is deliberately off, unlike WAM: these ship real normals and a fish
  // is a smooth body. Faceting one would make it read as a carving.
  // `ext` because the pack ships as GLB, like the food kit and unlike the
  // .gltf + .bin packs above.
  fish:    { atlas: null, tint: false, bakeColor: true, ext: 'glb' },
  // Kenney's Survival Kit 2.0, CC0 and verified on disk in the pack's own
  // `License.txt` (a copy of which ships beside the model). Same shape as the
  // Food Kit above and for the same reason — GLB with the atlas as a sibling,
  // named by relative URI, so `survival/Textures/colormap.png` has to keep that
  // exact path — but it is a *different* colormap and not the food kit's, so it
  // is a second pack rather than a second `file` prefix.
  //
  // `fitMax` because this pack is furniture: a workbench is 0.326 x 0.287 x
  // 0.296, wider than it is tall, and fitting its *height* to one would arrive
  // 1.14 cells across and grow through the wall beside it. See `bench` in POSE.
  survival: { atlas: 'survival/Textures/colormap.png', tint: false, nearest: true, ext: 'glb', fitMax: true },
  // The one collectible, and treated exactly as the fish pack is: GLB, no
  // atlas, no UVs worth keeping, and its two colours (root and leaf) living on
  // `baseColorFactor` rather than on a texture. `bakeColor` moves them onto the
  // vertices so the merged result is still one geometry and one material.
  // Smooth normals like the fish and unlike WAM — the model ships real ones.
  quest:    { atlas: null, tint: false, bakeColor: true, ext: 'glb' },
  // The currency, converted out of the supplier's .blend by headless Blender the
  // way the monsters pack was. GLB with a sibling colour map, and `nearest` for
  // the same reason the produce atlas has it: the map is flat islands of yellow
  // on black, so a filtered sample near an island edge is a dark rim on a coin
  // that is 46px wide most of the time. The pack ships an AO map too and it is
  // deliberately not here — it is near-white everywhere and there is nothing at
  // this size for it to shade.
  coin:     { atlas: 'coin_colortex.png', tint: false, nearest: true, ext: 'glb' },
};
const BLANK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=';

/**
 * How each model sits in the hand, and how it sits in its inventory icon.
 *
 * `height` is the model's long axis in view units after normalising (the old
 * sprite was 0.36 tall, but a real sword needs the length to read as a sword).
 * `grip` is where along that axis the fist closes, 0 at the butt of the handle
 * and 1 at the tip — the geometry is recentred there so the swing pivots around
 * the hand and not around the model's own origin.
 *
 * `icon` is a separate rotation for the icon painter, which frames the model
 * head-on and doesn't inherit the arm's tilt. Tools take the diagonal the old
 * hand-drawn art used — head high and to the right, handle down to the left —
 * so a grid of modelled and drawn icons still scans as one set. The shovel is
 * the exception and keeps its blade at the bottom: it is the way the tool is
 * modelled and the way it is held, and rolling it a half turn to match the
 * others would put the icon and the fist at odds, which is the thing this
 * whole path exists to stop.
 *
 * ### `pos`, and why every one of them was rewritten
 *
 * Reported: "some tools at hand look floating and not attached to the hand, like
 * the shovel, bow, arrow, fishing rod, items that are small enough like flowers,
 * and some items like fish are also floating and wrong angle in hand."
 *
 * **`pos` is not a lift. It is the offset between the fist and the item, and the
 * fist is a point on the fingertips.** `ViewModel._tryArms` scales the
 * character's arm so its bounding box's far end lands exactly on `HAND_LOCAL`,
 * which is the parent of the item rig — so there is no hand flesh beyond that
 * point to hide a gap behind, and whatever `pos` is, is daylight. Then
 * `_setMesh` multiplies it by `HELD_SCALE`, which is 1.56, so every nudge in
 * this table was being drawn 56% longer than it was written.
 *
 * Measured through the real glTF and the real chain, as the distance from the
 * fist point to the nearest point of the item's *surface* in view units (not to
 * its nearest vertex, which flatters a coarse mesh, and not by silhouette area,
 * which cannot see it at all): **16 of 106 items were in contact with the fist.
 * The mean gap was 0.0657 view units and the worst was 0.176 — a lollypop
 * floating four tenths of its own length off the hand.** The two poses the owner
 * had approved were the two smallest gaps in the table, 0.015 for the pickaxe
 * and 0.025 for the sword, and every item named in the report was in the top
 * fifteen. That is the whole bug: the approved items were approved because their
 * `pos` happened to be near zero.
 *
 * Every `pos` here is now solved rather than written: **the fist is moved the
 * shortest distance that puts it on the item, and then slid back up the authored
 * lift's own direction as far as it can go while staying on.** Two quantities per
 * pose, both measured. Afterwards: **106 of 106 in contact, mean gap 0.0070,
 * worst 0.009.**
 *
 * The cost, stated rather than buried: an item that hangs off the fist sits
 * where the fist is, and the fist is at NDC y -1.03 — below the bottom edge, by
 * design, because that is Minecraft's composition (see `REST` in
 * `ViewModel.js`). So attaching everything dropped the family, mean top edge
 * -0.16 -> -0.32 in NDC. A long tool does not care: it reaches up out of the
 * corner the way a pickaxe always did. A *small* item gripped through its middle
 * ended up half under the screen, so for ten of those `grip` came down as well —
 * the fist closes UNDER a small object rather than through it, which is both how
 * a hand works and what puts the object back in frame. That is a grip change and
 * not a lift, so it costs no contact and it carries to the third-person body.
 *
 * **What `pos` may not be used for.** `pos` is dropped by
 * `Character._wearPose`, so it is first person only. It is a framing nudge and
 * never a grip: if an item needs moving to sit *in the hand*, that is `grip`
 * and `root` below, both of which carry to the body.
 *
 * ### `grip`, `root`, and why there are two of them
 *
 * There are two origins on every model and they used to be one number, which is
 * the fault this pass exists to fix.
 *
 * - **`grip`** is where the fist closes, as a fraction of the model's height.
 *   It decides where the item hangs off the hand in *both* views.
 * - **`root`** is the height that stands on the ground, same units. It decides
 *   where a planted flower, coral or fungus sits, because `BlockModels.sync`
 *   puts the geometry's origin on the floor of the cell. It defaults to `grip`,
 *   and only because that is where the shipped world placement is — the two
 *   were one translate in `loadGeometry`.
 *
 * While they were one number, `grip` was frozen for every plantable item:
 * lowering a flower's grip buried the flower. It is not frozen now. **A pose
 * that changes its `grip` states its old value as `root`** and the world does
 * not move; the five entries carrying a `root` below are exactly that change,
 * and the world templates were dumped before and after to prove it.
 *
 * The other half of the fault was lateral. `loadGeometry` centred X and Z on
 * the *bounding box*, so the grip point was (bbox XZ centre, grip x height) —
 * and for a model whose mass is not stacked over that centre there is no value
 * of `grip` that lands on the material. Measured: a hollow pail was off the
 * metal at every grip from 0.02 to 0.90, an L-shaped claw missed by 0.095, a
 * pair of boots and a bunch of cherries put the fist in the gap between them,
 * and a donut put it through the hole. On the body, where `pos` is dropped, that
 * was **81 of 106 items in contact and a worst gap of 0.19 view units**. Those
 * used to be patched with an off-axis `pos`, which is a first-person-only
 * plaster over a model-space fault; the grip origin is measured off the
 * material now (see `gripAnchorXZ`) and the plasters are gone.
 *
 * After: **106 of 106 in contact in both views** — first person mean 0.0034,
 * worst 0.0050; on the body every item's grip point is inside its own material,
 * mean 0.0000. Forty-four of the 106 anchors moved; the other sixty-two are
 * bit-identical, because for them the bounding-box centre was already in the
 * material and the measurement leaves it alone.
 */
const ICON_ROT = [0.22, 0.62, 0];       // produce and anything unposed
// Long-handled things, on the drawn diagonal. The yaw is deliberately shallow:
// at three-quarters a pickaxe turns the flat of its head away from the key
// light and every tier came out the same charcoal wedge.
const TOOL_ICON = [0.12, 0.42, -0.42];

/**
 * A food-kit pose. Twenty-odd of these differ only in which file they name and
 * how big the thing is, so they are generated rather than written out; the
 * arguments are exactly the parts that vary.
 *
 * `flat` is the second orientation the kit needs. A plate, a pizza or an open
 * bowl is modelled lying in the XZ plane, and at the default tilt the icon
 * camera and the view model both see it edge-on — a pizza was a brown line.
 * Pitching it forward about X brings the top face round to face the viewer; the
 * icon takes more of it than the hand does, because the hand is also holding the
 * thing at an angle already.
 *
 * The `pos` default here is the one the whole kit used to share, and most of the
 * kit no longer takes it: it is 0.226 view units of daylight once `HELD_SCALE`
 * is on it, which was the largest gap in the table. Anything that needed less
 * passes its own solved `pos` through `extra`. See the note on `POSE`.
 */
function food(file, height, flat = false, extra = {}) {
  return {
    file: `food/${file}`, pack: 'food', height, grip: 0.5,
    rot: flat ? [0.72, -0.50, 0.10] : [0.10, -0.50, 0.10],
    pos: [0.02, 0.13, -0.06],
    icon: flat ? [0.95, 0.55, 0] : undefined,
    ...extra,
  };
}

/**
 * A pose for one of the fifteen species, off the same rigged body that swims
 * past the float.
 *
 * They differ in one number — how big the fish is — so like `food()` above they
 * are generated rather than written out fifteen times. Everything else is shared
 * because it is a fact about the pack rather than about the animal: all sixteen
 * models in it are authored nose along +Z, dorsal along +Y, and symmetric about
 * X, which is what lets one `spin`, one `grip` and one `rot` hold for the lot.
 *
 *  - `spin` stands the fish on its tail so that `grip` indexes its *length*.
 *    See the long note in `loadGeometry`; without it the fist is pinned to the
 *    middle of the body, which is not how anyone has ever held a fish.
 *  - `grip` at 0.16 is a sixth of the way up from the tail fin, in the meat of
 *    the wrist of the tail. It carries to the third-person body, unlike `pos`.
 *  - `rot` is **solved, not dialled**, on the three metrics `HAND_TILT` is
 *    stated in, through the real chain: flank dead face-on, nothing of the
 *    length pointing into the screen, and a chosen screen angle for that
 *    length. Solved: **36.0 degrees on screen / 0.000 out of plane / 1.000
 *    face-on**, back up.
 *
 *    Both of the last two matter here more than they do for a pickaxe. A fish
 *    seen along its length is a diamond with two eyes on it, and the whole point
 *    of fifteen species is that a clownfish and a koi are different objects at
 *    toolbar size — which they only are in profile. The very first attempt was
 *    dialled by hand and got that wrong outright: it stood the fish nose-on to
 *    the camera and filled a fifth of the frame with an eyeball.
 *
 *    **36 degrees and not 64.8, which is what this said before and is the one
 *    number that was still wrong.** The profile was already exact — re-measured
 *    with the arm allowed to settle it reads 1.000 face-on and 0.000
 *    foreshortened, so that half of the note was true — but the fish was stood
 *    up on its tail at nearer vertical than horizontal, and a vertical fish is a
 *    lump with an eye whatever else is right about it. Measured on the shipped
 *    pose, a clownfish drew 196px wide by 238px tall in a 1280x720 frame:
 *    portrait, in a frame that is not. At 36 it draws 252 x 198 — landscape,
 *    which is the shape the animal is. It is the same reasoning `icon` below
 *    already used and the hand did not, and the hand needs it *more*, because
 *    16:9 is further from square than an icon slot is.
 *
 *    Size was measured at the same time and deliberately **not** changed. The
 *    silhouette a held fish paints is 1.5% to 3.6% of the frame across the
 *    fifteen; the food family it belongs to runs 1.2% (cooked poultry) to 9.5%
 *    (roast), with bread at 4.1% and an apple at 5.0%. The fish are already at
 *    the small end of their own family, and rotating in the screen plane cannot
 *    change a silhouette's area anyway — so `height` stands where it was.
 *
 *  - `pos` is solved *after* `rot` and only exists because of it. Turning a
 *    model about its grip swings its bulk somewhere else: at 36 degrees the body
 *    ran off the bottom-right corner, which cost half the silhouette to the
 *    frame edge (3.1% -> 1.5%) and clipped every species. Three Newton steps on
 *    a measured Jacobian put the centre back at (0.79, 0.80) of the frame, where
 *    bread (0.79, 0.83) and the food kit's own fillet (0.79, 0.84) sit. After
 *    it, **no species clips any edge**.
 *
 * `icon` is solved the same way against its own framing, which has no
 * `HAND_TILT` in it: 40 degrees across the slot, face-on, no foreshortening. A
 * fish is half again as long as it is deep, so a diagonal is what lets it be
 * drawn largest in a square. Untouched here, and now doing the same job as the
 * hand rather than the opposite one.
 *
 * No `fitMax`: after the spin the length *is* the height, so the shared
 * normalisation already fits the axis that matters.
 */
function fish(file, height, extra = {}) {
  return {
    file: `fish/fish-${file}`, pack: 'fish', height,
    spin: [-Math.PI / 2, 0, 0],
    // Held in the middle of the body, and offset into the palm.
    //
    // Reported as "fish float and are not attached to the hand compared to
    // other items", and the numbers said the same thing: every other held
    // object in the game - the pearl, every food - grips at 0.5 with an offset
    // of a few hundredths, while this template gripped at 0.16 with an offset
    // of -0.137 across and +0.143 up. 0.16 is the tail fin, and the offset then
    // carried the whole body up and to the LEFT, clear of the fist. Screenshot
    // before the change: a clownfish hanging in mid-air beside the hand.
    //
    // 0.5 is the middle of the body, which is where a hand holds a fish, and
    // the offset is the pearl's - the item this was compared against.
    grip: 0.5,
    rot: [1.5708, 0.6283, -1.5708],
    pos: [0.0110, 0.0640, -0.0270],
    icon: [1.571, 0.698, -1.571],
    ...extra,
  };
}

export const POSE = {
  // **The head is rolled, and the numbers below are a composition rather than a
  // hand-tuned triple.** The head is a double-pointed bar: measured off the mesh
  // (the metal vertices, via the same `isMetal` the draw groups use) its point
  // axis is model X to three decimals and sits 89.6° to the haft, with its two
  // extremes at x = ±0.724. Carried through this pose that axis landed at
  // (0.769, 0.522, 0.369) — which projects to a bar leaning **55.8° off
  // vertical on screen**, i.e. nearer horizontal than not, with a point out to
  // each side. Reported as "the points are on the sides not up/down", and that
  // is exactly what it was.
  //
  // The correction has to be a roll about the model's **own** long axis, which
  // is not a change to any one component here: an Euler in this table is read
  // in the *view* frame, so adding to a component turns the tool relative to
  // the screen and drags the haft — and with it the aim of the swing — along
  // with it. What is wanted is `R' = R · Ry(θ)`, post-multiplied, because
  // post-multiplying composes in the model's own axes. Solved for the θ that
  // zeroes the head's sideways component and evaluated once: θ = -0.9244 rad
  // (-53.0°), giving the triple below. The haft is bit-identical afterwards —
  // measured, it moves 0.0e+0 degrees — so the swing still aims where it aimed.
  //
  // After: the head bar sits at (0.000, 0.577, 0.817), 0.02° off vertical on
  // screen, one point above the other, and the *lower* point leads into the
  // screen — which is the end that should meet the block on a downward strike.
  //
  // One cost, measured and left in deliberately: standing the head up turns its
  // flat away from the view model's key light, from 0.87 of square-on to 0.32.
  // That is the effect the note on `TOOL_ICON` describes, and it is why the
  // *icon* is not rolled to match — there the haft is near-vertical, so a head
  // perpendicular to it can only be horizontal on screen anyway, and a
  // pickaxe's icon is supposed to read as a bar across a shaft. If the head
  // comes out too dark in the hand, rolling back toward -0.79 rad trades it
  // back: at -45° the light returns to 0.43 for 12.5° of lean.
  // `height` 0.46 -> 0.54 is a consequence of the roll and not a separate
  // opinion. Turning the head out of the frame costs silhouette: measured, the
  // pickaxe covered 0.1008 square view units before and 0.0383 after, a 62%
  // loss, which took the game's signature tool below the sword (0.040) and the
  // axe (0.044) and level with a torch. That is how a fixed orientation comes
  // back as "the pickaxe looks small now" — the bow's report, one entry down.
  // 0.54 restores it to 0.053, a shade above the shovel's 0.052, so the pick is
  // once more the largest of the tools without being what it was; the rest of
  // the loss is inherent to holding the head edge-on and is not recoverable by
  // scaling. Revert this one number if it reads too big.
  pick:   { file: 'pickaxe',      pack: 'tools',   height: 0.54, grip: 0.18, rot: [0.955, -1.296, 1.577], pos: [0.018, -0.035, 0],     icon: TOOL_ICON },
  axe:    { file: 'axe',          pack: 'tools',   height: 0.40, grip: 0.2, rot: [-0.35, -0.95, 0.40], pos: [-0.008, 0.004, -0.005],  icon: TOOL_ICON },
  // The shovel is the one tool the pick's pose does not transfer to, and it had
  // the pick's rotation copied verbatim. It is modelled the other way up —
  // T-grip at the top, blade hanging below — so the pick's *backward* pitch,
  // which is what lifts a pickaxe head ready to swing, dropped the shovel's
  // blade down and behind the fist with the scoop rolled away from the ground.
  //
  // Positive pitch instead: the shaft leans back over the shoulder and the
  // blade drops forward and down where the ground is.
  //
  // **That last sentence is the one that was wrong, and it survived the half
  // turn below because the half turn does not touch it.** Reported after the
  // flip shipped: "the shovel is fixed but its angle is leaning back to player,
  // it should lean forward like how I am holding a torch." Measured as the
  // angle of the tool's long axis out of the screen plane in the vertical plane,
  // positive meaning the top tips *away* from the camera:
  //
  //     torch    +15.8 deg      (the player's reference, and the shallowest)
  //     sword    +29.6
  //     pickaxe  +35.7
  //     axe      +39.0
  //     shovel   -22.6          <- the only tool in the game leaning back
  //
  // **The flip did not cause this.** The shovel measured -22.5997 before it and
  // -22.5997 after — bit for bit, against the exact product; the shipped triple
  // reads -22.6123 and the whole of that 0.013 is the rounding to three decimal
  // places, not the turn. That equality is not a coincidence: a half turn
  // about the model's Z reverses which *end* of the long axis is up but leaves
  // the axis line itself exactly where it was, so it can move the composition
  // and never the lean. The lean has been backwards since `pitch` was first set
  // positive, and the flip only made it visible by putting the tool the right
  // way up to be looked at. Two faults, one pose, found one at a time — which is
  // worth recording, because the obvious guess after a flip is that the flip
  // inverted a sign, and here the measurement says plainly that it did not.
  //
  // So `pitch` goes from +0.50 to **-0.17**, which is the value that puts the
  // shovel on the torch's +15.8 rather than a number picked by eye. Only the
  // pitch moves; the yaw, the roll and the half turn are untouched, and the
  // three things the flip settled all hold or improve:
  //
  //     above the fist   0.69 -> 0.67   (family 0.82-0.86; the constraint was ~0.69)
  //     scoop toward us  0.75 -> 0.84   (model +Z's view z; higher is more face-on)
  //     silhouette       0.0846 -> 0.0903
  //
  // The torch is not the outlier here and the shovel is: every other held tool
  // already leans forward, and matching the reference the player named puts the
  // shovel in the family rather than in tension with it. It lands at the shallow
  // end of the band on purpose — the torch is what was asked for, and a shovel
  // pitched like an axe is a shovel held ready to swing rather than carried.
  //
  // What the original reasoning was reaching for is still true and is now got at
  // the other way round: the blade wants to read as the end that goes into the
  // ground. Post-flip it is the end held high and forward, and the dig track
  // drives it down and away from there, which is the same stroke described from
  // the correct starting pose.
  //
  // This note used to add that the scoop's hollow is the model's -Z face and
  // ends up pointing away, so you watch the back of the blade go in. Both
  // halves are wrong, and measuring the mesh is what settles it: across the
  // blade the rim sits at mean z +0.055 and the floor at -0.006, so the dish is
  // open toward **+Z**. Under this rotation +Z lands at (-0.52, -0.41, 0.75) in
  // the view frame — toward the camera and tipped a little down. So what you
  // actually get is the inside of the scoop turned to face you, which is the
  // better of the two pictures and the one worth keeping; only the account of
  // it was back to front.
  //
  // `grip` follows from that: the fist closes on the shaft above the blade, at
  // 0.70 of the model's height. It was 0.22, which is *inside the blade* — the
  // swing was pivoting around the digging end. And because everything below the
  // grip now hangs down from a fist that already sits near the bottom of the
  // frame, `pos` lifts the whole tool clear of the arm; without that the blade
  // is simply below the screen.
  //
  // **Turned end for end, on the third report that the held shovel is upside
  // down, and against two measurement passes that said it was not.**
  //
  // Both of those passes are still correct about what they measured, and both
  // are preserved below, because what they got wrong is worth more than what
  // they got right:
  //
  //   - the blade really is at the model's -Y and the grip at +Y. The pack
  //     paints heads in cool greys and handles in warm browns — the same
  //     property `isMetal` below sorts the draw groups by — and sampled through
  //     it the shovel's bottom 45% is steel (mean rgb 78,100,114 at the very
  //     bottom) and its top 55% wood (196,143,104 at the very top). Not in
  //     doubt, and `grip: 0.70` is genuinely on the shaft above the blade. Do
  //     not "restore" 0.22.
  //   - and under the old rotation the model's +Y — the grip — genuinely did
  //     point up: (-0.17, 0.91, 0.38) in the view frame, 24.5° off screen-up.
  //
  // **Both true, and the pose still read as inverted, because "which way is the
  // grip pointing" is the wrong question.** The question the eye actually asks
  // is where the mass of the tool sits relative to the fist, and measured
  // across the family the shovel was the only one of the four long tools with
  // its length *below* the hand:
  //
  //     pickaxe   y -0.090 .. 0.420      82% above the fist
  //     sword     y -0.070 .. 0.341      83% above
  //     axe       y -0.046 .. 0.289      86% above
  //     shovel    y -0.292 .. 0.132      31% above   <- the odd one out
  //
  // Grip 0.70 with the blade at -Y puts seven tenths of the object under the
  // hand. That is a shovel held near the top of the shaft with the blade
  // dangling at the bottom of the frame, which is what "upside down" describes
  // even though no axis is reversed — and it is why sampling the atlas could
  // never find it. The sign error is not in the atlas reading; it is that the
  // atlas reading was answering a different question from the player's.
  //
  // The turn is Rz(π) folded in ahead of the pose — a half turn about the
  // model's *thin* axis (Z, 0.156 units against Y's 1.577), not about its long
  // one, because a half turn about the long axis spins the tool without
  // swapping its ends and the ends are the whole point. Z is also the axis that
  // leaves the scoop where it was: the dish is open toward model +Z (rim at mean
  // z +0.055, floor at -0.006) and Rz(π) fixes +Z, so it still lands at
  // (-0.52, -0.41, 0.75) — the inside of the blade turned toward the camera,
  // which was the better of the two pictures and is kept. Rx(π) would have
  // swapped the ends too and shown you the back of the blade.
  //
  // Result: y -0.132 .. 0.294, 69% above the fist, which is the family's shape;
  // and the silhouette goes 0.0765 -> 0.0846 square view units, so nothing is
  // paid for it. `grip` stays 0.70 for the reason it was 0.70 — it is the point
  // on the shaft the hand closes on, which is a fact about the shovel and not
  // about the pose. Read from the end that is now lowest on screen it is 0.30,
  // which is the 0.16-0.20 the other three carry.
  //
  // `pos` is the old lift undone, and only that: +0.28 existed to haul a tool
  // that hung below the fist back into frame. It does not hang now. -0.02/+0.12
  // is the value that leaves the projected centre exactly where it was, so this
  // change is an orientation and nothing else — the shovel does not also move.
  //
  // **What this implies for the rest of the family, since it is the same
  // measurement chain.** The axe, sword and pickaxe are not affected: all three
  // measure 82-86% above the fist, which is the arrangement the shovel has just
  // been brought into, and none of them has been reported. The chain's fault
  // was never a sign flip that would infect them — it was that "is the grip
  // up?" was accepted as the whole test. The check that would have caught this
  // one is the table above, and it is now written down.
  //
  // The icon is deliberately left alone. It has not been reported, it is a
  // different framing (a slot, not a fist), and the toolbar's convention is
  // head-up across every tool.
  // **Up the band again, from the torch's lean to the sword's**, on "shovel can
  // lean forward more like the sword". This is the third time this one angle has
  // been asked about and the second time it has moved, so it is worth being
  // precise about what changed and what did not.
  //
  // The lean is the tool's long axis out of the screen plane, positive when the
  // top tips away from the camera, and it is the same measurement the table
  // twenty lines up is in. The pitch inside the composition is the only thing
  // that moves it, so it is solved for rather than nudged — bisected on the
  // sword's own measured value:
  //
  //     pitch -0.170  ->  lean +15.55   (the torch's, where the last pass put it)
  //     pitch -0.381  ->  lean +27.43   (the sword's, to two decimal places)
  //
  // The two settled properties the previous passes bought both survive, which is
  // the whole reason to move a pitch inside the composition instead of writing a
  // new triple:
  //
  //     above the fist   67% -> 66%    (family 82-88%; the constraint was ~69%)
  //     scoop toward us  0.840 -> 0.791 (model +Z's view z; 1.0 is dead face-on)
  //
  // `grip` is untouched at 0.70 for the reason it has always been 0.70: it is
  // where the hand closes on the shaft, which is a fact about the shovel and not
  // about the pose. Do not "restore" 0.22.
  //
  // Note that this is the *grip* half of the report only. The same sentence also
  // asked for everything to be bigger, to lean back and to sit further right,
  // and none of that is here: those are framing and they are three constants in
  // `ViewModel.js` (`HELD_SCALE`, `HAND_TILT`, `REST`), applied at the fist so
  // that the third-person body — which reads this table through
  // `Character._buildPosedItem` — is untouched by them.
  //
  // **Those three have since been re-solved against Minecraft's own figures, and
  // the "lean" this note is written in is no longer the measurement first person
  // is judged on** — see the long note on `HAND_TILT`. What that pass leaves the
  // shovel with, measured through the real glTF at 16:9: its long axis 31.9
  // degrees clockwise of vertical on screen with the shaft high and to the
  // right, 7.2 degrees out of the screen plane, and its flat 8.6 degrees off
  // square to the camera — the second best face-on reading of any tool in the
  // game, against the sword's 9.0. The two constraints this entry owns are
  // untouched and were re-measured after it: `grip` is still 0.70, and 93% of
  // the tool sits above the fist (the constraint is "roughly two thirds").
  //
  // `rot` is `Rxyz(-0.381, -0.55, 0.20) · Rz(π)` evaluated out. Both halves are
  // described above and neither is a dialled number; if this needs retuning,
  // change the pitch in that construction and re-evaluate rather than nudging
  // the composed triple, whose first component is no longer the pitch.
  shovel: { file: 'shovel',       pack: 'tools',   height: 0.46, grip: 0.7, rot: [-0.381, -0.550, -2.942],  pos: [-0.003, 0.018, -0.021], icon: [0.18, 0.52, -0.26] },
  // The roll is the whole of this entry's history. At `rot.z` 1.00 it was two
  // and a half times the next largest in the table — the axe's 0.40 — and the
  // number to read it by is where that leaves the blade: the tip sat **66° off
  // vertical**, against 39° for the pickaxe, 41° for the axe, 25° for the
  // shovel and 20° for the torch. A sword carried at two thirds of a right
  // angle is not held high, it is held *across*, tip back over the left
  // shoulder, and that is what "held the wrong way" was.
  //
  // 0.45 brings the tip to 36°, in among the other long tools rather than
  // outside them. Pitch and yaw are untouched on purpose: they are what turns
  // the flat of the blade toward the camera rather than its edge (model +Z
  // lands 0.80 out of the screen either way, unchanged by this), and the lateral
  // slash in `ViewModel`'s `SWINGS.sword` was authored against them.
  //
  // Worth being explicit, because it was reported in the same breath as the
  // shovel and the two are not the same fault: this is one wrong number in one
  // pose. There is no shared frame error. Every pose in this table lands on the
  // third-person body at exactly its first-person orientation — measured across
  // all of them, worst case 0.0° — so nothing here is inherited.
  sword:  { file: 'sword_B',      pack: 'weapons', height: 0.50, grip: 0.16, rot: [-0.25, -0.60, 0.45], pos: [0.025, 0.025, -0.019],  icon: [0.05, 0.30, -0.42] },

  // --- archery --------------------------------------------------------------
  //
  // The two models in this file that are not authored standing up, and the
  // reason `fitMax` became a per-pose flag (see `loadGeometry`). KayKit lays the
  // bow along **X** — 1.96 units tip to tip and 0.09 thick — and the arrow along
  // **Z**. The shared normalisation divides by the model's *height*, so the bow
  // came out of it twenty-one units tall: a wall, seen from the inside. Fitting
  // the longest axis instead is the food kit's existing answer to the same
  // problem, and it was already written; it was only nailed to the pack.
  //
  // `grip` is measured on Y either way and both models are a hair thick in Y, so
  // 0.5 is as near to "no offset" as makes no difference — which is correct for
  // both. A bow is held at the middle of the stave and an arrow at the middle of
  // the shaft, and the recentre in `loadGeometry` already puts X and Z on the
  // fist.
  //
  // **The rotation is a mapping, not a taste.** Measured off the mesh: the bow's
  // stave runs along model X, its limbs curve toward -Z and its string is a
  // straight run of verts at z = -0.28 — so the archer stands on -Z and the
  // arrow leaves along +Z. In the view model's hand space the camera looks down
  // -Z, so the shot would come out of the screen's -Z if `rot` mapped model X to
  // view Y (the stave stands up) and model +Z to view -Z. That is exactly
  // Ry(π)·Rz(π/2), or [0, π, π/2] in three's XYZ Euler order, and it is what
  // this entry used to be, to within a few hundredths.
  //
  // **It cannot be both, and squaring it to the shot is the wrong half to
  // keep.** Those two constraints together pin all three axes: with X on view Y
  // and +Z on view -Z, the model's own Y — the normal of the plane the bow lies
  // in — is forced onto view X, which points the bow's plane straight off the
  // side of the screen and leaves the camera looking at its *edge*. Measured on
  // the real constants: the held bow projected to 0.090 x 0.613 view units and a
  // silhouette of 0.017 square units, against 0.168 for a pickaxe. A tenth of a
  // pickaxe, and the shape of it a vertical line — which is why it read as
  // small when it is in fact the longest thing in this table. Nothing about the
  // *size* was wrong; the bow was turned edge-on and there was nothing to see.
  //
  // So the yaw comes ~50° off the shot and the stave stays upright. The bow is
  // not a gunsight — the arrow is aimed by `ViewModel.setDraw`, which nocks a
  // separate model down the view's -Z and is unaffected by any of this — and
  // turning the stave to show its curve and its string is what makes the object
  // in the fist legible as a bow at all. That takes the silhouette to 0.075
  // square units, four and a half times what it was, and `height` to 0.78, where
  // the stave spans about three quarters of the visible frame.
  //
  // The icon is the same fault in the same model and takes the same answer. Flat
  // on its side it fitted a 0.94 x 0.32 bar into a square slot and used a
  // twentieth of it; standing the stave up on the slot's diagonal, with the arc
  // turned toward the viewer, doubles the covered area and is the pose the
  // silhouette is actually recognisable in.
  //
  // **That is what the icon was reaching for and [0.16, 0.40, 0.90] did not
  // reach it.** The stave went onto the diagonal — 54.8 degrees across the slot,
  // 0.993 of its length in the screen plane, so that half was right — but the
  // one measurement that decides whether you are looking at a bow or at its edge
  // was never checked. The bow lies in its model's X-Z plane and its normal is
  // model Y; carried through that triple, model Y lands at (-0.721, 0.565,
  // 0.400), which is **0.400 face-on, 66 degrees off square to the camera**. So
  // the icon was still looking down the edge of the stave, exactly as the note
  // above says the held pose was: in the grid it drew a dark hairline about a
  // quarter the length of the arrow beside it, with the string visible only as a
  // second hair against the first. The held pose does better than the icon at
  // 0.775 face-on, which is why the bow in the fist reads and the bow in the
  // toolbar does not.
  //
  // Solved rather than nudged, and the two constraints determine all three
  // angles between them: model Y onto view +Z (the plane square to the camera)
  // and model X — the stave — onto the slot's 40-degree diagonal. Build the
  // basis from those two, take its third column, read the XYZ Euler off it:
  // [1.571, 0.698, 0]. Measured back through the same chain, **1.000 face-on,
  // 1.000 of the stave in the screen plane, 40.0 degrees across the slot.**
  //
  // 40 degrees and not 45 because it is the fish's number, and for the fish's
  // reason: a shape half again as long as it is deep is drawn largest across a
  // square on a diagonal. `fish()`'s own icon is [1.571, 0.698, -1.571] and
  // shares the first two components with this, which is not a coincidence —
  // both are "this flat thing, face-on, laid along the diagonal", and the roll
  // is the only part that differs because the two models carry their length on
  // different axes.
  //
  // **What this does not fix, stated rather than implied: the bow is still the
  // smallest thing in its row.** Measured off the painted 96px icon, covered
  // area went 5.3% -> 5.4% and the silhouette box 35x47 -> 39x33, against the
  // arrow's 41x71 and an iron sword's 64x51 in the same sheet — and the arrow's
  // 71 is exactly the 0.74 of the box `FILL` aims at, so the arrow is framed and
  // the bow is not. Turning a flat object face-on cannot change its area
  // anyway; what it changes is whether you can tell what it is, and that is the
  // whole of the gain here — the string now separates from the stave instead of
  // lying along it as a second hair. Why the painter under-fills this one model
  // is a different question from which way it is pointing, it is not answered
  // here, and it should be looked at against `ModelIconPainter.paint`'s framing
  // rather than by scaling this entry.
  //
  // The held `rot` is deliberately untouched. It is the one that `SWINGS` and
  // `setDraw` were authored against, it has been through its own solve, and it
  // was not what was wrong.
  bow: {
    file: 'bow_A_withString', pack: 'weapons', height: 0.78, grip: 0.5, fitMax: true,
    rot: [0.12, 2.26, 1.40], pos: [-0.0008, 0.0012, 0.0062], icon: [1.571, 0.698, 0],
  },
  // **The arrow is the one model in this table whose long axis is Z**, and both
  // of its rotations were written as though it were Y, like the stick and the
  // feather they were copied from. The comment here used to say the pose was the
  // drawn diagonal "rather than pointed at the camera, which is what the model's
  // own axis would give" — and pointed at the camera is exactly what it gave,
  // because the numbers that put a *stick's* +Y on the diagonal leave a shaft
  // that runs along +Z untouched. Measured: the held shaft sat 55° out of the
  // screen plane and covered 0.009 square units, a nineteenth of a pickaxe. That
  // is the "floating in the hand instead of held like a stick" report: what you
  // see of a shaft aimed at your eye is a dot at the fist.
  //
  // The fix is the stick's own rotation with a quarter turn folded in ahead of
  // it — R = R_stick · Rx(-π/2), which is what carries +Z to where the stick
  // puts +Y — evaluated once and written out. So these numbers are not a taste
  // either: the shaft now lands 17° out of the screen plane, which is the
  // stick's angle to the last degree, and the icon 3°, which is the stick's
  // icon. The head is the +Z end (the -Z end is the fletching: the atlas is
  // bright blue there and steel grey at the tip), so it carries head-up, the way
  // you would hold one.
  //
  // `grip` is nearly inert here and is left at 0.5 to say so: it is a fraction
  // of the model's *height*, and Y is this model's thinnest axis. What puts the
  // fist on the shaft is `loadGeometry`'s centring of X and Z — which used to be
  // on the bounding box and is now on the material at that height. It moves the
  // anchor 0.36 of the arrow's length along Z, because the bbox centre of an
  // arrow whose height is its thinnest axis is not on the shaft at all: measured
  // on the body, where there is no `pos` to hide behind, the old anchor was
  // outside the material and the new one is inside it.
  arrow: {
    file: 'arrow_A', pack: 'weapons', height: 0.46, grip: 0.5, fitMax: true,
    rot: [-1.87, -0.28, -0.42], pos: [0.002, 0.009, -0.003], icon: [-1.52, 0.46, 0.11],
  },
  // `glow`: the fraction of the model's own height over which the head lights
  // up. On this art the last fifth is the wrapped, burning end and nothing else.
  // A torch you are holding is lit — it was only ever lit once planted, which
  // made carrying one through a cave look like carrying a stick.
  torch:  { file: 'torch',        pack: 'tools',   height: 0.50, grip: 0.24, rot: [-0.20, -0.35, 0.22], pos: [0.016, 0.047, -0.016],  icon: [0.08, 0.55, -0.26], glow: [0.78, 0.94] },
  // **The pose that used to be pinned by a fault and is not any more.** A pail is
  // hollow, and `loadGeometry` used to put the grip point at the bounding box's
  // X/Z centre — which for this model is the empty air inside the bucket.
  // Swept, the fist was off the metal at every grip from 0.02 to 0.90, worst
  // 0.166 view units at the middle. 0.94 was the rim: the one height where the
  // bbox centre and the material happened to coincide, so it was the only value
  // that worked, and it cost the framing — gripped at the rim a pail hangs, and
  // its top edge sat at NDC -0.83, most of it under the bottom of the screen.
  //
  // The grip origin is measured off the material now (`gripAnchorXZ`), so any
  // height lands on the wall of the pail and `grip` is free to be chosen for the
  // picture instead. 0.55 is a hand round the middle of the pail, which puts the
  // whole of it in frame. `root` holds the dropped and world copy exactly where
  // the rim grip left it.
  bucket: { file: 'bucket_metal', pack: 'tools',   height: 0.36, grip: 0.55, root: 0.94, rot: [0, -0.55, 0.14],     pos: [-0.002, 0, -0.002],  icon: [0.16, 0.60, 0] },
  // **The key is `rod` and not `fishing_rod`, and that is not a nickname.**
  // `poseKeyFor` sends anything carrying a `tool` block down `POSE[tool.kind]`
  // and never consults `BY_NAME` for it, so an entry under the item's name is
  // one this file can never reach — which is exactly why the rod was the only
  // tool in the game still painting as drawn art while every pickaxe, axe,
  // shovel, sword and bow had a model. There was no missing mesh; there was a
  // missing key.
  //
  // Ours, in WAM, because no pack here ships one. `grip` is low because the
  // whole butt of this model is the handle — dark cork to about a tenth of the
  // height, with the reel just above it — and the fist has to close under the
  // reel or it closes *on* it. Everything above that is pole, line and float,
  // which is the part that has to stay in frame; hence a `pos` lift in the
  // shovel's spirit rather than the bucket's.
  rod:    { file: 'wam/fishing_rod', pack: 'wam',  height: 0.52, grip: 0.12, rot: [-0.18, -0.40, 0.26], pos: [0.0022, 0.0029, 0.0283],  icon: [0.10, 0.36, -0.28] },

  // Food. Held small and close — an apple filling as much of the frame as a
  // pickaxe reads as a beach ball. `grip` sits at the middle of the fruit
  // rather than at a handle, so it turns in the fist instead of orbiting it.
  apple:  { file: 'applered01', pack: 'produce', height: 0.24, grip: 0.5, rot: [0.10, -0.50, 0.10], pos: [0.017, 0.104, -0.052] },
  // The gourd itself, now that it is a vegetable rather than a block (see
  // `pumpkin` in Items.js). It takes `pumpkin01`, which the roast used to
  // borrow, and the roast moves to the food kit's pumpkin — see its line down
  // there. That is the split the rest of this table already runs on: raw
  // produce comes off the produce pack, cooked things come off the food kit.
  //
  // The two had to stop sharing a mesh whatever the packs. `height` is not what
  // the icon camera fits — it frames the model to the slot — so a bigger
  // pumpkin and a smaller one are the *same picture* at 46px, and pumpkin and
  // roast sit next to each other in one workflow.
  pumpkin: { file: 'pumpkin01',  pack: 'produce', height: 0.30, grip: 0.5, rot: [0.10, -0.55, 0.10], pos: [0.02, 0.15, -0.06] },
  // The berry. It drew the food kit's cherry bunch until now, which is the same
  // mesh `cherry` carries — two different foods, one object, and no way to tell
  // a handful of berries from a handful of cherries in the toolbar.
  berries: { file: 'raspberry01', pack: 'produce', height: 0.20, grip: 0.5, rot: [0.10, -0.50, 0.10], pos: [0.017, 0.104, -0.052] },
  // The pod, and the only item in the game that had no model at all — it fell
  // through to the hand-drawn card. `spin` is the fish's trick and is here for
  // the fish's reason: the pod is authored lying along Z, so without it `height`
  // normalises the wrong axis and `grip` indexes the pod's thickness.
  // `grip` and `rot` are the raw green bean's, so the pair are held the same
  // way; gripping the middle of a pod hung half of it below the bottom of the
  // viewport. The icon takes a roll the held pose does not, for the snow pea's
  // reason: a pod stood upright is a sliver in a square slot, and the diagonal
  // is the longest line a slot has.
  cooked_greenbean: {
    file: 'bean01', pack: 'produce', height: 0.26, grip: 0.26,
    spin: [-Math.PI / 2, 0, 0],
    rot: [-0.06, -0.48, 0.24], pos: [0.013, 0.082, -0.022], icon: [0.14, 0.44, -0.62],
  },

  // The collectible. Authored upright with the root at the bottom and the tuft
  // on top, so `height` fits the long axis without `fitMax` and `grip` reads
  // straight: 0.45 is the top of the root, where a hand actually closes on a
  // carrot, and the leaves fall over the fist.
  gold_carrot: { file: 'gold_carrot', pack: 'quest', height: 0.30, grip: 0.45, rot: [0.06, -0.50, 0.24], pos: [0.008, 0.05, -0.016], icon: [0.10, 0.42, -0.18] },

  // --- Kenney food kit ------------------------------------------------------
  //
  // `height` here is the model's longest axis, not its height (see `fitMax`), so
  // the numbers are comparable across a cherry and a pizza: 0.2 is something you
  // pop in your mouth, 0.34 is something you need both hands for.
  //
  // bread, meat and cooked_meat moved here off the WAM set. The WAM loaf was a
  // brown lozenge and the two meats were the same drumstick in two browns — at
  // 46px in the inventory neither read as what it was.
  // `loaf-round` and not `loaf`: the tin loaf is a brown box with no scoring on
  // it, and in a 46px slot it was indistinguishable from a crate.
  // The roast, off `pumpkin01` and onto the kit's own pumpkin. It shares that
  // mesh with the stuffed squash, which is what the kit is for and what half
  // this list already does — the bowls, the pots and the platters are shared
  // three ways apiece. Sharing with the *raw* gourd was the one that could not
  // stand: you smelt one into the other.
  roast:       food('pumpkin', 0.28, false, { pos: [0.02, 0.15, -0.06] }),
  bread:       food('loaf-round', 0.30, false, { pos: [0.016, 0.103, -0.047] }),
  meat:        food('meat-raw', 0.30, true, { pos: [0.02, 0.13, -0.06] }),
  cooked_meat: food('meat-cooked', 0.30, true, { pos: [0.02, 0.13, -0.06] }),

  // `berries` used to be here on `cherries` and is now a raspberry from the
  // produce pack, up with the apple. Left as a note rather than deleted quietly:
  // this table is read top to bottom and a second `berries` key down here would
  // win, which is exactly how it would come back.
  carrot:      food('carrot', 0.28, false, { grip: 0.02, pos: [0.002, 0.013, -0.006] }),
  cherry:      food('cherries', 0.24, false, { grip: 0.04, pos: [0.002, 0.012, -0.006] }),
  corn:        food('corn', 0.30, false, { pos: [0.011, 0.073, -0.034] }),
  tomato:      food('tomato', 0.22, false, { pos: [0.016, 0.104, -0.048] }),
  egg:         food('egg', 0.20, false, { grip: 0.18, pos: [0.009, 0.062, -0.028] }),
  // The fish is modelled nose-down-Z and is only a third as wide as it is long,
  // so at the shared yaw it was a dark sliver pointing at the camera. The yaw is
  // nearly a quarter turn instead, which puts the flank across the view, and the
  // roll runs that length along the icon's diagonal so it can be drawn bigger
  // without leaving the slot.
  // **Re-solved on "items like fish are floating and wrong angle in hand".** The
  // yaw the note above describes did turn the flank across the view, but it left
  // the fish's long axis 40 degrees out of the screen plane and leaning at -51
  // degrees on screen: a fish drawn foreshortened, pointing away and down the
  // wrong diagonal. `rot` is now solved rather than dialled — minimised over the
  // three metrics `HAND_TILT` is stated in (`ViewModel.js`), scoring the long
  // axis as a *line* mod 180 so the two diagonals cannot be confused:
  //
  //     long axis on screen   -51 deg  ->  25 deg   (the family's, from HAND_TILT)
  //     out of the screen      40 deg  ->   0
  //     flank to the camera    40 deg  ->   1       (0 is dead face-on)
  //
  // The icon is untouched: it is a different framing and has not been reported.
  fish:        food('fish', 0.30, false, { pos: [0.007, 0.044, -0.02], rot: [1.17, 0.33, -1.10], icon: [0.15, 1.34, 0.38] }),
  cheese:      food('cheese', 0.24, false, { pos: [0.0104, 0.0693, -0.0323] }),

  cooked_fish: food('sushi-salmon', 0.26, true, { pos: [0.01, 0.065, -0.03] }),
  cooked_egg:  food('egg-cooked', 0.26, true, { pos: [0.0088, 0.0578, -0.0264] }),
  salad:       food('salad', 0.26, true, { pos: [0.017, 0.11, -0.051] }),
  pancakes:    food('pancakes', 0.26, true, { pos: [0.013, 0.085, -0.039] }),

  sandwich:    food('sandwich', 0.28, true, { pos: [0.013, 0.0845, -0.039] }),
  soup:        food('bowl-soup', 0.26, true, { pos: [0.016, 0.104, -0.048] }),
  pie:         food('pie', 0.30, true, { pos: [0.02, 0.129, -0.06] }),
  cake:        food('cake', 0.30, false, { pos: [0.018, 0.115, -0.053] }),
  // The stew pot takes the flat pose for the same reason the bowls do: side-on
  // it is a grey cylinder, and everything that says "stew" is inside it.
  stew:        food('pot-stew', 0.30, true, { pos: [0.017, 0.11, -0.051] }),
  /**
   * The cooking station, held and standing on its own block.
   *
   * A lidded pot rather than a brick cube, and it is the one full-block item in
   * the game with a model. The note at the head of `BY_NAME` says a full block
   * is better as its cube preview and it is right about the lantern, which is a
   * lamp whose whole shape is the cube. It is not right here: the cooker's
   * identity is the pot on top of it, not the brickwork, and a brick cube in
   * the hand is indistinguishable from a brick.
   *
   * **One state, and it is the open pot.** The kit carries `pot`, `pot-lid`,
   * `pot-stew` and `pot-stew-lid`, which is a ready-made idle / cooking / done
   * machine — and there is nothing here to drive it. The station holds no
   * ingredients between uses (see `_buildCraftUI` in UI.js): it works out of
   * the player's own craft grid, so the only thing an open pot could report is
   * what the player is carrying, and that would open every cooker on the planet
   * at once. A lid that never moves is honest; a lid that moves for the wrong
   * reason is not. If the station is ever given its own slots, the other three
   * models are the state machine and this is where they go.
   */
  kitchen:     food('pot', 0.24, true, { pos: [0.014, 0.088, -0.041] }),
  /**
   * The workbench, and the one pose here that is also the block itself.
   *
   * Every other block-backed item in this table either has no model (and is
   * drawn as its atlas cube, in the hand, in the icon and on the ground) or has
   * one that is an ornament standing on a cube, which is the kitchen above. The
   * bench is neither: it is `R_MODEL`, so this geometry *is* the block, and the
   * fist, the icon, the ground drop and the placed block are all the same
   * object for the first time. That is the whole reason the render class was
   * worth building — the crate was turned down partly because adopting a model
   * for the placed block alone would have put a different box in your hand from
   * the one that lands.
   *
   * The pack's `fitMax` normalises the longest axis, which here is X at 0.3257
   * against a height of 0.2866, so the model arrives 0.880 tall in its own
   * units. `MODELLED_BLOCKS` in main.js asks for exactly that height, which is
   * what lands it one cell wide and not 1.14 — including the hammer handle,
   * which is the piece that overhangs furthest.
   *
   * Tilted forward like the flat foods rather than stood on edge: side-on a
   * workbench is a plank on four legs, and the hammer, the saw marks and the
   * sheet of paper that say "this is where you make things" are all on the top.
   */
  bench: {
    file: 'survival/workbench', pack: 'survival', height: 0.30, grip: 0.5,
    rot: [0.62, -0.52, 0.10], pos: [0.02, 0.115, -0.053], icon: [0.88, 0.58, 0],
  },
  pizza:       food('pizza', 0.30, true, { pos: [0.02, 0.13, -0.06] }),
  burger:      food('burger-cheese', 0.26, false, { pos: [0.02, 0.13, -0.06] }),

  cookie:      food('cookie', 0.24, true, { pos: [0.015, 0.097, -0.045] }),
  donut:       food('donut-sprinkles', 0.24, true, { pos: [0.0068, 0.0433, -0.02] }),
  ice_cream:   food('ice-cream', 0.28, false, { grip: 0.02, pos: [0.003, 0.016, -0.007] }),
  chocolate:   food('chocolate', 0.26, true, { pos: [0.014, 0.094, -0.043] }),
  muffin:      food('muffin', 0.24, false, { pos: [0.013, 0.083, -0.038] }),
  // The lollypop is a disc on a stick and the kit's shared pose held it edge-on:
  // its plate sat 86 degrees to the view axis, six degrees off invisible, which
  // is the same failure the note above `bow` records. Solved on the fish's three
  // metrics: 86 -> 0 degrees, and the axis onto the family's 25-degree diagonal.
  // `grip` at the very bottom of the model puts the fist under the stick, which
  // is where a hand goes and is what lifts the sweet back into frame.
  candy:       food('lollypop', 0.28, false, { grip: 0.02, pos: [0.002, 0.011, -0.005], rot: [-0.95, -2.13, -0.63] }),
  croissant:   food('croissant', 0.26, true, { pos: [0.013, 0.083, -0.038] }),

  // --- the kitchen's catalogue ----------------------------------------------
  //
  // Forty-one dishes off the Kenney food kit, which the owner pointed at for
  // exactly this. Every one of them is a model the pack already had rather than
  // a `.wam` authored for it: the loader, the atlas and the `food()` helper
  // above have been carrying this pack since the first fourteen meals, so a
  // dish that the kit can represent costs one line here and nothing else.
  //
  // Reuse is deliberate where it happens. Six files serve two dishes each — a
  // broth bowl is a broth bowl whether the broth is glowcap or chowder — which
  // is the same call `berries` and `cherry` already share `cherries` on, and
  // `meat`, `cooked_meat` and both poultries already make about a drumstick.
  //
  // **One number and one flag per dish, and no solved framing.** The rest of
  // this table carries hand-solved `pos` and `rot` triples, several of them
  // Newton-stepped against a measured Jacobian, and every one of those is a
  // measurement of one object. Forty-one of them is not a thing to do by eye,
  // and doing it badly is worse than not doing it: the family default is the
  // pose the food kit was fitted to and it lands every dish inside the
  // silhouette band the existing meals occupy. `flat` is the one bit that
  // genuinely cannot be defaulted — a plate or an open bowl is modelled lying
  // in the XZ plane and reads as a line edge-on, which is the fault the note on
  // `food()` describes. It is set per dish against what the model is.
  //
  // 0.28 rather than the kit's spread of 0.20 to 0.30 because these are dishes
  // rather than ingredients: a Royal Roast should not arrive in the hand at the
  // size of a cherry. Anything that reads wrong is one number here.
  scrap_bowl:       food('bowl', 0.28, false),
  mixed_bowl:       food('bowl-cereal', 0.28, true),
  hearty_bowl:      food('bowl-broth', 0.28, true),
  feast_plate:      food('plate-deep', 0.28, true),
  grand_platter:    food('plate-rectangle', 0.28, true),
  fruit_cup:        food('ice-cream-cup', 0.28, false),
  berry_jam:        food('honey', 0.28, false),
  melon_ice:        food('popsicle', 0.28, false),
  hard_tack:        food('loaf-baguette', 0.28, false),
  trail_mix:        food('bag', 0.28, false),
  cactus_cooler:    food('frappe', 0.28, false),
  kelp_crisps:      food('fries', 0.28, false),
  stuffed_mushroom: food('dim-sum', 0.28, true),
  glow_broth:       food('bowl-soup', 0.28, true),
  honey_toast:      food('waffle', 0.28, true),
  omelette:         food('plate-dinner', 0.28, true),
  fish_cakes:       food('rice-ball', 0.28, false),
  crab_roll:        food('sub', 0.28, false),
  veg_skewer:       food('skewer-vegetables', 0.28, false),
  poultry_wrap:     food('taco', 0.28, false),
  kelp_noodles:     food('chinese', 0.28, true),
  pumpkin_soup:     food('bowl-cereal', 0.28, true),
  bean_pot:         food('pan-stew', 0.28, true),
  sushi_plate:      food('maki-salmon', 0.28, true),
  sausage_roll:     food('meat-sausage', 0.28, false),
  reef_chowder:     food('bowl-broth', 0.28, true),
  roast_dinner:     food('plate-sauerkraut', 0.28, true),
  harbour_paella:   food('pan-stew', 0.28, true),
  meat_pie:         food('mincemeat-pie', 0.28, true),
  glazed_bird:      food('turkey', 0.28, false),
  truffle_pasta:    food('steamer', 0.28, false),
  stuffed_squash:   food('pumpkin', 0.28, false),
  lotus_curry:      food('tajine', 0.28, false),
  desert_tagine:    food('tajine', 0.28, false),
  frost_pudding:    food('pudding', 0.28, false),
  abyss_platter:    food('maki-roe', 0.28, true),
  truffle_feast:    food('styrofoam-dinner', 0.28, true),
  royal_roast:      food('whole-ham', 0.28, false),
  harvest_feast:    food('plate-dinner', 0.28, true),
  reef_banquet:     food('steamer', 0.28, false),
  grand_gateau:     food('cake-birthday', 0.28, false),

  // --- the composed dishes --------------------------------------------------
  //
  // Eight families over four rungs, and every one of them is a model the kit
  // already has and several of them are models a named dish already uses. That
  // is the same reuse the catalogue above makes six times over — a broth bowl
  // is a broth bowl — and it is load-bearing here rather than convenient: these
  // thirty-two are named on the spot for a pile that matched nothing, so the
  // one thing they must not do is look scarcer than the dishes worth finding.
  // The family is carried by the name and by the icon tint; the rung is carried
  // by the vessel, which climbs bowl to pot to plate to board across each row.
  fish_broth:       food('bowl-soup', 0.28, true),
  fish_stew:        food('pot-stew', 0.28, false),
  fish_board:       food('plate-deep', 0.28, true),
  angler_feast:     food('maki-roe', 0.28, true),
  meat_hash:        food('plate-sauerkraut', 0.28, true),
  meat_stew:        food('pan-stew', 0.28, true),
  meat_roast:       food('whole-ham', 0.28, false),
  hunter_feast:     food('turkey', 0.28, false),
  reef_broth:       food('bowl-broth', 0.28, true),
  reef_pot:         food('pot', 0.28, false),
  reef_plate:       food('plate-dinner', 0.28, true),
  tide_banquet:     food('steamer', 0.28, false),
  fruit_bowl:       food('bowl', 0.28, false),
  fruit_compote:    food('honey', 0.28, false),
  fruit_platter:    food('plate-deep', 0.28, true),
  orchard_feast:    food('plate-rectangle', 0.28, true),
  garden_bowl:      food('salad', 0.28, true),
  garden_stew:      food('pan-stew', 0.28, true),
  garden_plate:     food('plate-dinner', 0.28, true),
  garden_feast:     food('plate-rectangle', 0.28, true),
  spore_bowl:       food('bowl-cereal', 0.28, true),
  cap_stew:         food('pot-stew', 0.28, false),
  cap_plate:        food('dim-sum', 0.28, true),
  forest_feast:     food('steamer', 0.28, false),
  grain_mash:       food('bowl-cereal', 0.28, true),
  grain_porridge:   food('bowl-broth', 0.28, true),
  grain_plate:      food('pancakes', 0.28, true),
  harvest_board:    food('plate-rectangle', 0.28, true),
  sugar_bowl:       food('ice-cream-cup', 0.28, false),
  sweet_pudding:    food('pudding', 0.28, false),
  sweet_platter:    food('donut-sprinkles', 0.28, false),
  sugar_feast:      food('cake-birthday', 0.28, false),

  // --- the fish -------------------------------------------------------------
  //
  // Fifteen species, and `height` is the only thing that varies: it is what the
  // player is being told apart from the colour, so a tetra is a minnow and a
  // goblin shark is an armful. The numbers are in the models' own proportions,
  // read off the pack (a tetra and a royal gramma are the two smallest bodies in
  // it, a goblin shark and an anglerfish the two largest) rather than by feel.
  //
  // They sit around 0.22 where the food kit's `fish` sits at 0.30, and that is
  // the tail grip paying for itself rather than an inconsistency. `height` is
  // the whole model; what reaches out of the corner is the part *past the fist*,
  // and that is 84% of one of these against 50% of a middle-gripped fillet. Held
  // at 0.30 the head was a foot past the right edge of the screen; 0.22 x 0.84
  // puts the same amount of fish on screen as 0.30 x 0.50 does.
  //
  // `fish` — the generic Raw Fish, from a bear's mouth or a shark's — keeps the
  // food kit's fillet above and is deliberately not one of these. It is the fish
  // you did not catch, and it should not look like a species you did.
  clownfish:     fish('clownfish', 0.23),
  yellowtang:    fish('yellowtang', 0.22),
  butterflyfish: fish('butterflyfish', 0.22),
  bluetang:      fish('bluetang', 0.22),
  royalgramma:   fish('royalgramma', 0.20),
  puffer:        fish('puffer', 0.21),
  moorishidol:   fish('moorishidol', 0.22),
  tetra:         fish('tetra', 0.20),
  goldfish:      fish('goldfish', 0.23),
  koi:           fish('koi', 0.24),
  betta:         fish('betta', 0.22),
  piranha:       fish('piranha', 0.22),
  anglerfish:    fish('anglerfish', 0.25),
  blobfish:      fish('blobfish', 0.22),
  goblinshark:   fish('goblinshark', 0.24),

  // --- WAM materials --------------------------------------------------------
  //
  // Three families, and the family decides the pose far more than the item
  // does. Lumps (ore, coal, flint, seeds) are held small and turned to a
  // three-quarter so the facets that carry their colour all catch light;
  // shafts (stick, wheat, feather) take the drawn diagonal so they read as
  // something you are carrying rather than pointing; bars and bundles (ingots,
  // bread, hide) are laid across the fist, which needs `rot.z` near a quarter
  // turn because the models are authored standing on their long axis.
  //
  // `height` is the long axis. These are materials, not tools: none of them
  // gets more than about half the frame a pickaxe takes, or the hand stops
  // reading as a hand.
  stick:      { file: 'wam/stick',      pack: 'wam', height: 0.38, grip: 0.4, rot: [-0.18, -0.40, 0.30],  pos: [0.007, 0.014, -0.007], icon: [0.10, 0.10, -0.46] },
  coal:       { file: 'wam/coal',       pack: 'wam', height: 0.17, grip: 0.5, rot: [0.16, -0.55, 0.12],   pos: [0.011, 0.062, -0.028], icon: [0.22, 1.75, 0] },
  charcoal:   { file: 'wam/charcoal',   pack: 'wam', height: 0.22, grip: 0.08, rot: [0.10, -0.50, 0.55],   pos: [0.004, 0.022, -0.01], icon: [0.18, 0.62, -0.38] },
  raw_iron:   { file: 'wam/raw_iron',   pack: 'wam', height: 0.18, grip: 0.5, rot: [0.16, -0.60, 0.12],   pos: [0.019, 0.104, -0.047], icon: [0.22, 0.66, 0] },
  raw_gold:   { file: 'wam/raw_gold',   pack: 'wam', height: 0.18, grip: 0.5, rot: [0.16, -0.30, 0.12],   pos: [0.016, 0.089, -0.04], icon: [0.22, 0.30, 0] },
  iron_ingot: { file: 'wam/iron_ingot', pack: 'wam', height: 0.26, grip: 0.5, rot: [0.10, -0.55, 1.30],   pos: [0.0009, 0.0052, -0.0023], icon: [0.50, 0.60, 1.30] },
  gold_ingot: { file: 'wam/gold_ingot', pack: 'wam', height: 0.26, grip: 0.5, rot: [0.10, -0.55, 1.30],   pos: [0.0009, 0.0052, -0.0023], icon: [0.50, 0.60, 1.30] },
  crystal:    { file: 'wam/crystal',    pack: 'wam', height: 0.26, grip: 0.45, rot: [0.06, -0.60, 0.28],   pos: [0.009, 0.069, -0.022], icon: [0.10, 0.55, -0.20] },
  flint:      { file: 'wam/flint',      pack: 'wam', height: 0.19, grip: 0.18, rot: [0.10, -0.75, 0.34],   pos: [0.008, 0.044, -0.02], icon: [0.06, 0.60, -0.24] },
  wheat:      { file: 'wam/wheat',      pack: 'wam', height: 0.36, grip: 0.42, rot: [-0.14, -0.35, 0.34],  pos: [0.005, 0.071, -0.004], icon: [0.06, 0.20, -0.30] },
  seeds:      { file: 'wam/seeds',      pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10],   pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  // The six crop seeds share the one seed model, and deliberately so: a seed is
  // a seed to look at, and six near-identical meshes would be six downloads to
  // tell them apart by a pixel. The label and the icon tint carry the
  // difference. Without an entry here each one is a flat card in the hand,
  // which is what they were.
  strawberry_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  squash_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  greenbean_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  snowpea_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  hops_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  grape_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  watermelon_seeds: { file: 'wam/seeds', pack: 'wam', height: 0.17, grip: 0.14, rot: [0.30, -0.55, 0.10], pos: [0.012, 0.03, -0.03], icon: [0.42, 0.60, 0] },
  // The hide's roll is what lays it across the fist, and it is also what makes
  // its *icon* yaw a different question from every other one in this table: once
  // the roll has turned the model's long axis across the frame, a yaw does not
  // turn the object in front of the camera any more, it swings that length away
  // from it. At 0.92 the pelt was 54° out of the screen plane and drawn at about
  // three fifths of the length it has. Reduced until it reads as a laid-out
  // skin; the roll, which is the part that was chosen, is untouched.
  hide:       { file: 'wam/hide',       pack: 'wam', height: 0.26, grip: 0.5, rot: [0.10, -0.50, 1.30],   pos: [0.0114, 0.0636, -0.0285], icon: [0.24, 0.40, 1.32] },
  feather:    { file: 'wam/feather',    pack: 'wam', height: 0.32, grip: 0.38, rot: [-0.16, -0.40, 0.36],  pos: [0.0031, 0.0375, -0.0056], icon: [0.06, 0.30, -0.38] },

  // The rest of the ladder, on the same three family poses. Ores and the
  // sulfur crust take the lump pose; the cast bars take the ingot pose, which
  // is the one with the quarter turn in `rot.z` because those models are
  // authored along their long axis and stood up on export.
  raw_copper:   { file: 'wam/raw_copper',   pack: 'wam', height: 0.18, grip: 0.5, rot: [0.16, -0.45, 0.12], pos: [0.017, 0.094, -0.043], icon: [0.22, 0.52, 0] },
  raw_silver:   { file: 'wam/raw_silver',   pack: 'wam', height: 0.18, grip: 0.5, rot: [0.16, -0.60, 0.12], pos: [0.019, 0.104, -0.047], icon: [0.22, 0.66, 0] },
  sulfur:       { file: 'wam/sulfur',       pack: 'wam', height: 0.18, grip: 0.5, rot: [0.16, -0.50, 0.12], pos: [0.016, 0.089, -0.041], icon: [0.22, 0.40, 0] },
  copper_ingot: { file: 'wam/copper_ingot', pack: 'wam', height: 0.26, grip: 0.5, rot: [0.10, -0.55, 1.30], pos: [0.0009, 0.0052, -0.0023], icon: [0.50, 0.60, 1.30] },
  silver_ingot: { file: 'wam/silver_ingot', pack: 'wam', height: 0.26, grip: 0.5, rot: [0.10, -0.55, 1.30], pos: [0.0009, 0.0052, -0.0023], icon: [0.50, 0.60, 1.30] },

  // Gems, on the crystal's pose: held a touch higher than a lump and turned
  // less far off the camera, because what a gem has that a lump does not is
  // facets, and at three-quarters the front facet turns away from the key
  // light and the whole stone flattens to one tone.
  //
  // The cut stones (ruby, sapphire, emerald) are shorter in the frame than the
  // grown crystals: they are one compact object rather than a cluster, so at
  // the cluster's height they filled the slot edge to edge.
  amethyst:   { file: 'wam/amethyst',   pack: 'wam', height: 0.24, grip: 0.26, rot: [0.06, -0.55, 0.24],   pos: [0.007, 0.054, -0.017], icon: [0.10, 0.50, -0.18] },
  ruby:       { file: 'wam/ruby',       pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.01, 0.067, -0.024], icon: [0.14, 0.40, -0.12] },
  sapphire:   { file: 'wam/sapphire',   pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.01, 0.067, -0.024], icon: [0.14, 0.40, -0.12] },
  emerald:    { file: 'wam/emerald',    pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.01, 0.067, -0.024], icon: [0.14, 0.40, -0.12] },
  // The shard is a wafer with its broken face on +Z, so it takes the flint
  // treatment: turned to show the flat of the blade, not its edge, where it
  // would be a two-pixel line.
  void_shard: { file: 'wam/void_shard', pack: 'wam', height: 0.23, grip: 0.1, rot: [0.06, -0.34, 0.30],   pos: [0.005, 0.033, -0.011], icon: [0.08, 0.24, -0.20] },
  // Cinder is a lump, but its whole read is the hot seam, and the seam is a 22°
  // stripe on the model's +Z face. Both poses are therefore nearly square to
  // the camera: at the lump family's usual three-quarter turn the crack went
  // round the side and the icon was a plain black pebble.
  cinder:     { file: 'wam/cinder',     pack: 'wam', height: 0.19, grip: 0.5, rot: [0.16, -0.22, 0.12],   pos: [0.014, 0.079, -0.036], icon: [0.22, 0.14, 0] },

  // The coin is modelled standing on its rim with the struck device on both
  // faces, so both poses are shallow yaws: the whole object is that face, and
  // anything approaching three-quarters turns it into a sliver. Held small —
  // it is a coin, and at lump size it read as a dinner plate.
  // `height` 0.15 -> 0.22 and the fist under the coin rather than through it.
  // Once it is attached, a 0.15-tall coin is drawn 0.23 view units long and the
  // fist is at NDC y -1.03, so more than half of it was below the bottom edge.
  // 0.22 with `grip` 0.16 brings the top back to -0.54 with the fist still on
  // the metal. It is still the smallest thing in the game and is meant to be.
  //
  // The model is a supplied one now rather than the WAM disc it was tuned on,
  // and it keeps every number of that tuning: it is authored lying flat, so
  // `spin` stands it on its rim facing +Z, which is where the WAM coin already
  // was. Same size, same fist, same two yaws.
  // `height` is a raw multiplier on the model's own units, not a target size,
  // so it does not survive a model swap. The WAM coin was 0.158 units across
  // and the supplied one is 2.0 - 12.7x - which at the inherited 0.22 rendered
  // a 0.44 dinner plate in the fist. 0.0174 puts it back at the WAM coin's
  // 0.0348. The icon is unaffected either way: `iconModel` resets the scale to
  // 1 and frames on the bounding box.
  coin:       { file: 'coin',           pack: 'coin', height: 0.0174, grip: 0.16, spin: [0, 1.5708, 0], rot: [0.10, -0.30, 0.10],   pos: [0.003, 0.022, -0.009], icon: [0.12, 0.26, 0] },
  // The sapling takes the shaft pose — it is a stem with a crown on top, and
  // the drawn diagonal is what the other tall, thin items use. `grip` is low
  // on purpose: you carry a seedling by its stem, so the fist closes under the
  // foliage rather than through it.
  sapling:    { file: 'wam/sapling',    pack: 'wam', height: 0.34, grip: 0.18, root: 0.3, rot: [-0.12, -0.35, 0.30],  pos: [0.0036, 0.0261, -0.0036], icon: [0.08, 0.30, -0.18] },
  // The crab claw is modelled as an L — arm up, pincer reaching along +Z — and
  // everything that makes it read as a claw lives in the plane of that reach.
  // Both poses are therefore near a quarter turn in yaw, which is what puts the
  // open jaws across the view instead of pointing them at the camera; it is the
  // fish's problem and takes the fish's answer. `grip` is low because the fist
  // closes on the arm, not on the claw: at 0.5 it would have gripped the palm
  // and swung the whole thing around the pincer.
  // The claw is an L, so its bounding box's X/Z centre is in the crook between
  // the arm and the pincer and no `grip` used to put the fist on either: swept,
  // the closest it got was 0.095 view units at any grip below 0.30. That is what
  // the off-axis `pos` here used to be patching, first person only. The grip
  // origin is measured off the material now and lands in the middle of the arm,
  // so `pos` is a plain lift again and the body grips the claw too.
  crab_claw:  { file: 'wam/crab_claw',  pack: 'wam', height: 0.30, grip: 0.24, rot: [0.06, -1.30, 0.24],  pos: [0.0061, 0.0481, -0.0131], icon: [0.10, 1.45, 0.34] },

  // The drumstick, and the last two foods that were still hand-drawn sprites
  // in a line-up of twenty-seven modelled ones. `meat` and `cooked_meat` moved
  // to the Kenney kit and left `ART.meat` — which is a picture of a drumstick —
  // serving only the two poultry items, so the flat one in the hotbar was
  // literally the bird.
  //
  // `grip` is the number that matters and it is not the family default: you
  // hold a drumstick *by the bone*, and the bone is the upper 48% of this model
  // (meat from y 0 to 0.17, shaft and knuckle from there to 0.32). 0.62 closes
  // the fist just above the cut band, so the meat hangs below the hand the way
  // it does in life; at the lump family's 0.5 the fist is inside the muscle and
  // the thing orbits its own middle. `pos` lifts it for the same reason the
  // shovel's does — most of the object is now below the grip.
  //
  // Two models and not one aliased pair, which is the opposite of the call made
  // for the crab. A claw is the same object cooked or raw; a drumstick is not,
  // and this exact pair is the one the retired WAM meats failed on — "the same
  // drumstick in two browns", per the note above `bread`. So the cooked one is
  // roasted *shape* as well as colour: the muscle pulls back off the bone as it
  // cooks, which leaves a squatter drum (widest at 0.15 of the height against
  // the raw one's 0.25) over a longer run of exposed bone (meat ends at 0.42 of
  // the height rather than 0.50). They separate on silhouette alone, before any
  // colour is resolved, which is the test the retired pair could not pass.
  //
  // `grip` follows the meat line in each: the fist closes on the bone just
  // above it, so the drum hangs under the hand.
  poultry:        { file: 'wam/poultry',        pack: 'wam', height: 0.28, grip: 0.62, rot: [0.06, -0.45, 0.22], pos: [0.007, 0.055, -0.015], icon: [0.12, 0.42, -0.18] },
  cooked_poultry: { file: 'wam/cooked_poultry', pack: 'wam', height: 0.28, grip: 0.56, rot: [0.06, -0.45, 0.22], pos: [0.003, 0.021, -0.006], icon: [0.12, 0.42, -0.18] },

  // The three flowers, on the sapling's pose — they are the same object, a stem
  // with something on top, and `grip` is low for the same reason: you carry a
  // picked flower by the stalk, so the fist closes under the head rather than
  // through it. Held smaller than the sapling because a bloom that fills as much
  // of the frame as a seedling reads as a cabbage.
  //
  // These three are also the only entries in this table that are *world*
  // geometry as well: `render/BlockModels.js` instances the same meshes where
  // the blocks are planted. Nothing here changes for that — `worldModel()`
  // strips the pose — but it does mean these numbers only ever decide the fist
  // and the icon, and the world size lives over there.
  //
  // Each icon rotation is the one that shows what makes that flower itself:
  //
  //  - crimson is an upright teardrop and is the same from every yaw, so it
  //    takes the drawn diagonal unchanged;
  //  - azure nods along its own +Z, which is straight at the icon camera — the
  //    fish's problem exactly, so it takes the fish's near-quarter-turn and the
  //    nod goes across the frame instead of pointing out of it;
  //  - gold is a flat plate of petals facing up. At the family's shallow pitch
  //    the icon saw it edge-on and the daisy was a gold line; pitching it most
  //    of the way over — the `flat` treatment the food kit's plates and pizzas
  //    need — brings the face round. Not all the way: past about 0.6 the stalk
  //    disappears behind the head and it stops reading as a flower at all.
  flower_red:  { file: 'wam/flower_red',  pack: 'wam', height: 0.30, grip: 0.16, root: 0.28, rot: [-0.10, -0.40, 0.26], pos: [0.003, 0.0182, -0.003], icon: [0.12, 0.34, -0.18] },
  flower_blue: { file: 'wam/flower_blue', pack: 'wam', height: 0.30, grip: 0.16, root: 0.28, rot: [0.02, -1.25, 0.26],  pos: [0.0023, 0.0142, -0.0023], icon: [0.14, 1.32, -0.12] },
  flower_gold: { file: 'wam/flower_gold', pack: 'wam', height: 0.30, grip: 0.16, root: 0.28, rot: [0.24, -0.40, 0.22],  pos: [0.002, 0.0126, -0.002], icon: [0.52, 0.32, -0.14] },

  // The glowcap, on the flowers' pose with two departures.
  //
  // Both rotations are almost flat in pitch, where every other plant here takes
  // a tilt. A mushroom's whole read is the overhang, and an overhang is only
  // visible in profile: pitched forward like the daisy, the cap becomes a
  // purple disc seen from above with the stalk hidden underneath it and there
  // is nothing left to say what the object is. Side-on it is unmistakable at
  // any size, so the yaw does the work and the pitch stays out of the way.
  //
  // `grip` is higher than the flowers' 0.28 — the fist closes above the veil
  // ruff, which is where you would actually take hold of a mushroom, and low
  // enough that it is still on the stalk and not in the gills.
  //
  // `glowMatch` rather than the torch's `glow`: see `glowPalette`. The colour
  // is the block's own `lightColor` ([0.6, 0.85, 0.7] in `world/Blocks.js`)
  // scaled back to about seven tenths, which is bright enough to read as lit in
  // a dark cave without washing the mint out of the gills to white.
  mushroom:    { file: 'wam/mushroom',    pack: 'wam', height: 0.26, grip: 0.22, root: 0.38, rot: [0.02, -0.45, 0.22],  pos: [0.006, 0.03, -0.012], icon: [0.04, 0.42, -0.16],
                 // tol 0.22 -> 0.10 and a lighter body lift. The key is a pale
                 // mint and the stalk is a pale cream, which at 0.22 sat inside
                 // the match: the glow was landing on the whole body instead of
                 // the gills, and the flat lift on top of it took what colour
                 // was left. Reported as the drops being grey/white. Tight
                 // enough now that only the mint reads as lit.
                 glowMatch: {
                   hex: '#b6efd0', color: [0.42, 0.60, 0.49],
                   tol: 0.10, lift: [0.035, 0.03, 0.04],
                 } },

  // --- the reef -------------------------------------------------------------
  //
  // Eight blocks and one material, all WAM, and all eight blocks are also world
  // geometry — `render/BlockModels.js` instances them where the blocks are, the
  // way it does the flowers. So unlike every pose above, the numbers here are
  // *only* about the fist and the icon: the size a coral is on the seabed comes
  // from `MODELLED_PLANTS` in `main.js`, which scales each model to a fraction
  // of a cell.
  //
  // The poses divide by what each model's read is:
  //
  //  - the branching corals and the kelp are upright things whose silhouette is
  //    the whole story, so they take the flowers' shallow pitch and a yaw that
  //    turns the forks across the frame rather than pointing them at the
  //    camera;
  //  - the sea fan is a *plane* and has the daisy's problem in its purest form
  //    — square-on to the icon camera it is a purple line. Both its rotations
  //    are near a quarter turn in yaw so the fan faces the viewer;
  //  - the brain coral, the sponge cluster and the clam are masses, and a mass
  //    reads from anywhere, so those take the family pose unchanged.
  //
  // `grip` runs low on all of them: these are held by the stem or the base,
  // which is where a hand would take a piece of coral, and a fist closing
  // halfway up a branching colony hides the forks that identify it.
  coral_branch: { file: 'wam/coral_branch', pack: 'wam', height: 0.30, grip: 0.26, rot: [-0.08, -0.55, 0.24], pos: [0.015, 0.092, -0.015], icon: [0.10, 0.50, -0.18] },
  coral_fan:    { file: 'wam/coral_fan',    pack: 'wam', height: 0.30, grip: 0.24, rot: [0.02, -1.35, 0.22],  pos: [0.007, 0.04, -0.007], icon: [0.12, 1.40, -0.10] },
  coral_brain:  { file: 'wam/coral_brain',  pack: 'wam', height: 0.24, grip: 0.42, rot: [0.10, -0.45, 0.16],  pos: [0.004, 0.019, -0.007], icon: [0.22, 0.40, -0.10] },
  coral_dead:   { file: 'wam/coral_dead',   pack: 'wam', height: 0.30, grip: 0.26, rot: [-0.08, -0.75, 0.24], pos: [0.015, 0.091, -0.015], icon: [0.10, 0.70, -0.18] },
  kelp:         { file: 'wam/kelp',         pack: 'wam', height: 0.34, grip: 0.3, rot: [-0.12, -0.40, 0.28], pos: [0.0008, 0.0108, -0.0024], icon: [0.08, 0.36, -0.20] },
  sea_grass:    { file: 'wam/sea_grass',    pack: 'wam', height: 0.23, grip: 0.3, rot: [-0.06, -0.50, 0.26], pos: [0.0006, 0.0081, -0.0018], icon: [0.10, 0.46, -0.16] },
  sea_sponge:   { file: 'wam/sea_sponge',   pack: 'wam', height: 0.26, grip: 0.4, rot: [0.06, -0.50, 0.18],  pos: [0.02, 0.11, -0.04], icon: [0.16, 0.46, -0.12] },
  // The clam is the one that has to show its inside. Its mantle — the bright
  // strip between the valves and the only saturated thing on the model — faces
  // straight up, so both rotations pitch it well forward, the food kit's `flat`
  // treatment. Square-on it is two grey shells and nothing else.
  sea_shell:    { file: 'wam/sea_shell',    pack: 'wam', height: 0.22, grip: 0.36, rot: [0.46, -0.40, 0.16],  pos: [0.016, 0.081, -0.032], icon: [0.72, 0.34, -0.08] },
  pearl:        { file: 'wam/pearl',        pack: 'wam', height: 0.22, grip: 0.5, rot: [0.10, -0.30, 0.10],  pos: [0.011, 0.064, -0.027], icon: [0.12, 0.26, 0] },

  // The larder and the lamp, on the same three rules as the reef above.
  //
  // Sea lettuce has the sea fan's problem in a milder form: it is four broad
  // sheets and edge-on it is four lines, so both its rotations turn it well off
  // square and its icon takes a steep pitch as well — a rosette is read from
  // above, which is also how a swimmer meets it. The grapes are an upright with
  // a silhouette that is the whole story (beads on a string), so they take the
  // branching coral's shallow pose unchanged.
  //
  // The anemone is the one that has to show its *inside*, exactly as the clam
  // does: the glow is on the tentacle tips and they hook up and inward over an
  // oral disc, so square-on from the side it is a dark cup with some pale
  // specks past the rim. Both rotations pitch it forward hard, and the icon
  // nearly all the way, which is the food kit's `flat` treatment used for a
  // block — the crown, seen from above, is the thing worth putting in a slot.
  sea_lettuce:   { file: 'wam/sea_lettuce',   pack: 'wam', height: 0.255, grip: 0.3, rot: [0.10, -1.10, 0.24], pos: [0.0024, 0.014, -0.0024], icon: [0.42, 1.15, -0.14] },
  sea_grape:     { file: 'wam/sea_grape',     pack: 'wam', height: 0.30, grip: 0.26, rot: [-0.06, -0.50, 0.26], pos: [0.007, 0.04, -0.007], icon: [0.10, 0.44, -0.18] },
  abyss_anemone: { file: 'wam/abyss_anemone', pack: 'wam', height: 0.225, grip: 0.36, rot: [0.44, -0.40, 0.16],  pos: [0.005, 0.025, -0.01], icon: [0.70, 0.34, -0.08] },
  // Dried kelp is item-only and is a stack of flat sheets, so it is held and
  // shown the way the food kit holds anything flat: gripped low at the fold,
  // turned enough that the stepped margins read rather than the back sheet's
  // blank face.
  dried_kelp:    { file: 'wam/dried_kelp',    pack: 'wam', height: 0.22, grip: 0.34, rot: [0.14, -0.44, 0.20],  pos: [0.014, 0.078, -0.021], icon: [0.24, 0.38, -0.10] },
  // The comb has the sea fan's problem and takes the sea fan's answer in a
  // milder form: everything that identifies it — seven hexagonal cell mouths —
  // is on one face, and at the lump family's three-quarter turn that face goes
  // round the side and leaves a gold brick. Both rotations are shallow in yaw
  // so the cells stay square to the viewer, and the icon is shallower still.
  // Held at the middle: it is a chunk, not a handle.
  honeycomb:     { file: 'wam/honeycomb',     pack: 'wam', height: 0.22, grip: 0.48, rot: [0.10, -0.26, 0.14],  pos: [0.011, 0.066, -0.022], icon: [0.14, 0.20, -0.08] },

  // The land flora. Sixteen entries, and they are grouped by *what the model
  // needs the camera to do* rather than by biome, because that is the only
  // thing a pose is about.
  //
  // Uprights whose read is a vertical silhouette — a spike, a sheaf, a seed
  // head. These take the branching coral's pose almost unchanged: a shallow
  // yaw, gripped low on the stem, because turning one of these far off square
  // only ever hides one stalk behind another.
  thornbrush:   { file: 'wam/thornbrush',   pack: 'wam', height: 0.28, grip: 0.3, rot: [-0.08, -0.55, 0.24], pos: [0.0146, 0.0926, -0.0068], icon: [0.12, 0.50, -0.18] },
  golden_grass: { file: 'wam/golden_grass', pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.10, -0.42, 0.28], pos: [-0.0004, 0.0067, -0.0026], icon: [0.10, 0.38, -0.20] },
  firebloom:    { file: 'wam/firebloom',    pack: 'wam', height: 0.34, grip: 0.26, rot: [-0.10, -0.40, 0.26], pos: [0, 0, 0], icon: [0.08, 0.34, -0.20] },
  marram:       { file: 'wam/marram',       pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.10, -0.46, 0.28], pos: [0.01, 0.068, -0.01], icon: [0.10, 0.40, -0.20] },
  lavender:     { file: 'wam/lavender',     pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.08, -0.44, 0.26], pos: [-0.0003, 0.0067, 0.0009], icon: [0.10, 0.38, -0.18] },
  cotton_grass: { file: 'wam/cotton_grass', pack: 'wam', height: 0.30, grip: 0.28, rot: [-0.08, -0.44, 0.26], pos: [0.0085, 0.0578, -0.0085], icon: [0.10, 0.38, -0.18] },

  // Clumps read from a three-quarter view, the flowers' treatment: enough yaw
  // that the clump has depth, not so much that the leader hides the buds.
  aloe:         { file: 'wam/aloe',         pack: 'wam', height: 0.244, grip: 0.34, rot: [0.06, -0.50, 0.22],  pos: [0.0022, 0.0146, -0.0105], icon: [0.18, 0.46, -0.14] },
  snowbell:     { file: 'wam/snowbell',     pack: 'wam', height: 0.26, grip: 0.3, rot: [0.02, -0.45, 0.24],  pos: [0.002, 0.011, -0.002], icon: [0.10, 0.42, -0.16] },
  lingonberry:  { file: 'wam/lingonberry',  pack: 'wam', height: 0.227, grip: 0.36, rot: [1.04, 0.66, 0.18],   pos: [0.002, -0.01, 0.01], icon: [0.16, 0.44, -0.14] },
  // Held low and turned so the volva is in shot. The swollen sack at the foot is
  // the field mark that says deathcap rather than mushroom, and a pose that put
  // the cap between the eye and the base would have thrown away the one thing
  // the item art has to say.
  deathcap:     { file: 'wam/deathcap',     pack: 'wam', height: 0.30, grip: 0.30, rot: [-0.06, -0.50, 0.22], pos: [0, 0, 0], icon: [0.10, 0.42, -0.16] },
  fern:         { file: 'wam/fern',         pack: 'wam', height: 0.28, grip: 0.3, rot: [-0.06, -0.52, 0.26], pos: [0.002, 0.0108, -0.002], icon: [0.12, 0.48, -0.16] },

  // The two that are read from *above*, the sea lettuce problem: a mat seen
  // square-on from the side is a line. Both rotations pitch them well forward
  // and the icons nearly onto their backs, because a trefoil and a star are
  // shapes that exist only in plan view.
  clover:       { file: 'wam/clover',       pack: 'wam', height: 0.192, grip: 0.32, rot: [0.42, -0.55, 0.18],  pos: [0.0064, 0.0076, -0.0021], icon: [0.78, 0.46, -0.10] },
  alpine_aster: { file: 'wam/alpine_aster', pack: 'wam', height: 0.186, grip: 0.32, rot: [0.44, -0.50, 0.18],  pos: [0.0026, 0.0031, -0.0009], icon: [0.80, 0.42, -0.10] },
  // The wild harvest and the orchard. `file` is what `worldModel` resolves, so
  // a modelled block with no entry here plants fine and draws NOTHING - which
  // is exactly what happened the first time these went in.
  //
  // The held pose numbers were the family defaults rather than individually
  // measured, and one of them was reported: the icecap moss is the joint
  // smallest plant on the planet (0.26 of a cell) and was held at the same 0.22
  // as a hops vine that stands three and a half times taller.
  //
  // Audited across all seventy modelled plants, the hand was nearly FLAT — held
  // heights spanned 0.20 to 0.34, a factor of 1.7, against world heights from
  // 0.22 to 1.0, a factor of 4.5. The hand was compressing the whole range of
  // the world into almost nothing, and the small end paid for it.
  //
  // The heights here now carry a term for how big the thing actually is:
  // min(1, sqrt(worldHeight / 0.5)), applied to what was already there. The
  // square root keeps a truffle visible rather than strictly proportional — a
  // linear term would make it a fifth of a firebloom and unreadable in a slot.
  //
  // SHRINK ONLY, which is a deliberate limit rather than the whole idea. The
  // report was "too big", so the cap at 1 means nothing in the game got larger
  // than it was and no pose that reads correctly today can have been broken by
  // it. The cost is that the top of the range is still compressed: a kelp stalk
  // is a whole cell in the world and is still held at a flower's size. Lifting
  // that cap to 1.45 is the one change that would finish the job.
  //
  // `pos` is deliberately NOT scaled with them. It is the offset between the
  // fist and the grip point — a fact about the hand, not about the item — so a
  // model shrinks around the place it is held rather than drifting off it.
  cactusfruit:  { file: 'wam/cactusfruit',  pack: 'wam', height: 0.30, grip: 0.30, rot: [0.10, -0.46, 0.20], pos: [0.0020, 0.0090, -0.0040], icon: [0.30, 0.42, -0.14] },
  agave:        { file: 'wam/agave',        pack: 'wam', height: 0.28, grip: 0.32, rot: [0.10, -0.48, 0.20], pos: [0.0020, 0.0090, -0.0040], icon: [0.30, 0.42, -0.14] },
  stonecrop:    { file: 'wam/stonecrop',    pack: 'wam', height: 0.198, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  icecapmoss:   { file: 'wam/icecapmoss',   pack: 'wam', height: 0.159, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  swampreed:    { file: 'wam/swampreed',    pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.06, -0.44, 0.24], pos: [-0.0003, 0.0067, 0.0009], icon: [0.12, 0.38, -0.16] },
  mireroot:     { file: 'wam/mireroot',     pack: 'wam', height: 0.26, grip: 0.30, rot: [0.10, -0.46, 0.20], pos: [0.0020, 0.0080, -0.0030], icon: [0.30, 0.42, -0.14] },
  lotus:        { file: 'wam/lotus',        pack: 'wam', height: 0.17, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  truffle:      { file: 'wam/truffle',      pack: 'wam', height: 0.133, grip: 0.34, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0030, -0.0010], icon: [0.70, 0.42, -0.10] },

  // The farm's produce — what the crop below drops, which is a different object
  // from the crop itself and is modelled separately in `art/wam/items/`. Five
  // entries, and they exist because without them these five ids fell through to
  // the hand-drawn card: the owner's report was "the new fruits are 2d in hand",
  // and a flat card is exactly what an item with no `file` gets.
  //
  // The poses split the way the rest of this table does, by what the model needs
  // the camera to do rather than by what the food is:
  //
  //  - the squash is a mass, and a mass reads from anywhere, so it takes the
  //    lump family's pose gripped through its middle;
  //  - the beans, the peas and the hops are uprights held at the butt, the
  //    branching coral's treatment — a shallow yaw, because turning a bundle far
  //    off square only hides one pod behind another;
  //  - the snow peas take more turn than the family and a steeper pitch on top
  //    of it. They are four flat paddles, the family yaw left three of them
  //    edge-on, and that is the sea fan's problem exactly. Their *icon* takes
  //    the sea fan's full answer at 1.20 of yaw, which the held pose cannot: a
  //    quarter turn in the fist swung the bundle out past the right edge of the
  //    viewport, where the icon camera has no edge to swing past.
  //
  // The grape bunch is gripped at 0.40 rather than up at its stalk, where a hand
  // would really take it: `grip` is a fraction of the model's height, the stalk
  // is the top eighth of this model, and a fist closing there leaves the whole
  // bunch hanging below the bottom of the viewport.
  //
  // `pos` is the offset from the fist to the item and NOT a lift, per the long
  // note above — but the fist sits at NDC y -1.03, below the bottom edge, so a
  // `pos` near zero is an item you cannot see. These five are the food family's
  // measured range (y 0.08 to 0.10), which is what the sponge, the cluster and
  // the apple carry: far enough up the arm to be in frame, short enough to stay
  // in contact. Measured by eye against `apple` and `lingonberry` in the same
  // world, not solved — worth a pass with the contact solver the note describes.
  squash:    { file: 'wam/squash',    pack: 'wam', height: 0.26, grip: 0.44, rot: [0.10, -0.46, 0.18], pos: [0.016, 0.095, -0.040], icon: [0.22, 0.42, -0.12] },
  greenbean: { file: 'wam/greenbean', pack: 'wam', height: 0.28, grip: 0.26, rot: [-0.06, -0.48, 0.24], pos: [0.013, 0.082, -0.022], icon: [0.14, 0.44, -0.18] },
  snowpea:   { file: 'wam/snowpea',   pack: 'wam', height: 0.26, grip: 0.26, rot: [0.16, -0.62, 0.22], pos: [0.013, 0.082, -0.022], icon: [0.20, 1.20, -0.14] },
  hops:      { file: 'wam/hops',      pack: 'wam', height: 0.26, grip: 0.28, rot: [0.04, -0.44, 0.22], pos: [0.014, 0.088, -0.026], icon: [0.16, 0.40, -0.16] },
  grape:     { file: 'wam/grape',     pack: 'wam', height: 0.26, grip: 0.40, rot: [0.06, -0.50, 0.20], pos: [0.016, 0.092, -0.034], icon: [0.18, 0.46, -0.14] },
  // The melon is the one piece of produce on this planet a hand closes *around*
  // rather than over, so it takes the largest height in the food family and a
  // grip near the middle of its own long axis. Its source stands it on its end
  // for exactly this: `height` here normalises on the Y extent, and the model's
  // Y extent is the melon's length.
  watermelon: { file: 'wam/watermelon', pack: 'wam', height: 0.34, grip: 0.50, rot: [0.06, -0.48, 0.16], pos: [0.016, 0.095, -0.036], icon: [0.16, 0.44, -0.12] },

  // The farm. Twenty-eight entries for seven crops, one per growth stage, and they
  // are here for `file` rather than for the pose: `worldModel` resolves a
  // planted block's art through this table, so a crop stage with no line here
  // sows, grows, ticks and drops correctly and draws absolutely nothing. That
  // is the failure this comment exists to prevent — it has no error, no warning
  // and no missing-texture chequerboard, just an empty furrow.
  //
  // None of these is ever actually held: a crop is broken into produce and
  // seeds, and neither of those is the block. The rot/pos/icon numbers are
  // therefore the flowers' family defaults rather than turntable-measured, and
  // the only ones worth measuring later are the two climbers, whose models are
  // tall enough that a default grip catches them well below the middle.
  strawberry_0: { file: 'wam/strawberry_0', pack: 'wam', height: 0.146, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  strawberry_1: { file: 'wam/strawberry_1', pack: 'wam', height: 0.209, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  strawberry_2: { file: 'wam/strawberry_2', pack: 'wam', height: 0.26, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  strawberry_3: { file: 'wam/strawberry_3', pack: 'wam', height: 0.28, grip: 0.32, rot: [0.30, -0.50, 0.18], pos: [0.0024, 0.0040, -0.0010], icon: [0.60, 0.42, -0.12] },
  squash_0:     { file: 'wam/squash_0',     pack: 'wam', height: 0.146, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  squash_1:     { file: 'wam/squash_1',     pack: 'wam', height: 0.209, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  squash_2:     { file: 'wam/squash_2',     pack: 'wam', height: 0.26, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  squash_3:     { file: 'wam/squash_3',     pack: 'wam', height: 0.28, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  greenbean_0:  { file: 'wam/greenbean_0',  pack: 'wam', height: 0.146, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  greenbean_1:  { file: 'wam/greenbean_1',  pack: 'wam', height: 0.218, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  greenbean_2:  { file: 'wam/greenbean_2',  pack: 'wam', height: 0.28, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  greenbean_3:  { file: 'wam/greenbean_3',  pack: 'wam', height: 0.30, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  snowpea_0:    { file: 'wam/snowpea_0',    pack: 'wam', height: 0.146, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  snowpea_1:    { file: 'wam/snowpea_1',    pack: 'wam', height: 0.218, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  snowpea_2:    { file: 'wam/snowpea_2',    pack: 'wam', height: 0.28, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  snowpea_3:    { file: 'wam/snowpea_3',    pack: 'wam', height: 0.30, grip: 0.30, rot: [0.06, -0.48, 0.22], pos: [0.0020, 0.0080, -0.0030], icon: [0.20, 0.44, -0.14] },
  hops_0:       { file: 'wam/hops_0',       pack: 'wam', height: 0.159, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  hops_1:       { file: 'wam/hops_1',       pack: 'wam', height: 0.249, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  hops_2:       { file: 'wam/hops_2',       pack: 'wam', height: 0.30, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  hops_3:       { file: 'wam/hops_3',       pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  grape_0:      { file: 'wam/grape_0',      pack: 'wam', height: 0.159, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  grape_1:      { file: 'wam/grape_1',      pack: 'wam', height: 0.249, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  grape_2:      { file: 'wam/grape_2',      pack: 'wam', height: 0.30, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  grape_3:      { file: 'wam/grape_3',      pack: 'wam', height: 0.32, grip: 0.28, rot: [-0.04, -0.46, 0.24], pos: [0.0000, 0.0070, 0.0000], icon: [0.12, 0.40, -0.16] },
  watermelon_0: { file: 'wam/watermelon_0', pack: 'wam', height: 0.146, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  watermelon_1: { file: 'wam/watermelon_1', pack: 'wam', height: 0.209, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  watermelon_2: { file: 'wam/watermelon_2', pack: 'wam', height: 0.26, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },
  watermelon_3: { file: 'wam/watermelon_3', pack: 'wam', height: 0.28, grip: 0.32, rot: [0.20, -0.48, 0.20], pos: [0.0020, 0.0060, -0.0030], icon: [0.44, 0.42, -0.14] },

  // Underground. The mushroom's own pose for the toadstools — a cap is read
  // from slightly below so the overhang shows — and the clam's steeper one for
  // the shelf fungus, whose plates only separate when you are not level with
  // them. The crystal cluster takes the gem kit's pose: gripped near the middle
  // of the matrix, turned so the points fan across the slot rather than at it.
  cave_mushroom:   { file: 'wam/cave_mushroom',   pack: 'wam', height: 0.22, grip: 0.38, rot: [0.02, -0.45, 0.22], pos: [0.006, 0.03, -0.012], icon: [0.04, 0.42, -0.16] },
  shelf_fungus:    { file: 'wam/shelf_fungus',    pack: 'wam', height: 0.225, grip: 0.38, rot: [0.34, -0.44, 0.18], pos: [0.022, 0.092, -0.037], icon: [0.52, 0.40, -0.12] },
  crystal_cluster: { file: 'wam/crystal_cluster', pack: 'wam', height: 0.26, grip: 0.4, rot: [0.10, -0.55, 0.20], pos: [0.02, 0.11, -0.04], icon: [0.18, 0.52, -0.14] },

  // --- armour ---------------------------------------------------------------
  //
  // Four shapes for twenty items: each is worn by all five tiers, which are
  // separated by `tintAll` (see `tintedMaterial`) rather than by geometry.
  // That is the opposite call to the poultry pair above and it is the right one
  // here — an iron helm and a copper helm really are one helm in two metals,
  // where a raw and a roasted drumstick are two objects.
  //
  // The models are therefore authored in near-white neutral grey, because a
  // multiply cannot put a hue onto something that already has one: anything
  // saturated in the source would drag every tier back toward itself, which is
  // the same trap the note on `TIER_LOOK` records for the KayKit steel.
  //
  // `grip` is the odd one across the set and follows what a hand would take
  // hold of rather than the middle of the box: a helm by its crown, a
  // chestplate at the shoulder line, leggings at the waist band — all near the
  // top, so the piece hangs under the fist — and boots low, because a pair of
  // boots is picked up by the ankles with the feet below.
  //
  // `fitMax` on the chest and the boots: both are authored wider (or deeper)
  // than they are tall, and normalising those by *height* is what turned a low
  // wide thing into a giant — the same fault the food kit and the bow carry the
  // flag for.
  armour_helm:  { file: 'wam/armour_helm',  pack: 'wam', height: 0.30, grip: 0.62, tintAll: true, rot: [0.10, -0.55, 0.10], pos: [0.02, 0.1, -0.04], icon: [0.14, 0.50, -0.10] },
  armour_chest: { file: 'wam/armour_chest', pack: 'wam', height: 0.36, grip: 0.72, tintAll: true, fitMax: true, rot: [0.10, -0.50, 0.10], pos: [0, 0.084, -0.037], icon: [0.14, 0.44, -0.10] },
  armour_legs:  { file: 'wam/armour_legs',  pack: 'wam', height: 0.34, grip: 0.78, tintAll: true, rot: [0.08, -0.50, 0.12], pos: [0.014, 0.096, -0.027], icon: [0.12, 0.44, -0.12] },
  armour_boots: { file: 'wam/armour_boots', pack: 'wam', height: 0.30, grip: 0.55, tintAll: true, fitMax: true, rot: [0.14, -0.55, 0.10], pos: [0.02, 0.1, -0.04], icon: [0.20, 0.48, -0.08] },

  // Driftwood is the one authored wider than it is tall on purpose, so it
  // normalises on its longest axis instead of its height — without `fitMax` a
  // low tangle would be scaled up by its own thickness and arrive as a log
  // across the whole slot. Same reason the bow carries it.
  //
  // And being *wide* is also why it can't take the near-quarter yaw the fish
  // and the sea fan take. That turn is the right answer for a model whose long
  // axis is Z, where it swings the length across the frame; driftwood's long
  // axis is X, where the identical turn swings it into the camera instead. It
  // was 72° out of the screen plane in both poses — a wide tangle drawn end-on,
  // which is the very thing `fitMax` is here to stop it looking like. A shallow
  // yaw keeps the span across the view, where the forks read.
  driftwood:    { file: 'wam/driftwood',    pack: 'wam', height: 0.28, grip: 0.44, fitMax: true, rot: [0.16, -0.40, 0.22], pos: [0.01, 0.062, -0.016], icon: [0.24, 0.40, -0.10] },
};

/**
 * Item name -> pose key, for the items that carry no `tool` block.
 *
 * Exported alongside `POSE` and `poseKeyFor` purely so an offline audit can
 * walk the registry and check that what the world draws, what the fist holds
 * and what the toolbar paints are the same object for every item. Nothing in
 * the game reads them from outside this file.
 */
export const BY_NAME = {
  // The lantern is deliberately absent: it is a full block, and held as its own
  // model it read as a grey lump seen from above — the cube preview of what you
  // are about to place is both clearer and truer.
  torch: 'torch',
  // The bow is absent here on purpose: it carries `tool.kind === 'bow'`, so
  // `poseKeyFor` finds it by the same route a pickaxe is found and never reaches
  // this table. The arrow has no tool block and does.
  arrow: 'arrow',
  bucket: 'bucket',
  // All three pails are one model. What tells them apart is `fill` on the item
  // def, which `fillDisc` turns into a disc at the rim — and `meshKey` includes
  // it, so the three get three cached meshes off one geometry rather than
  // fighting over one.
  water_bucket: 'bucket',
  lava_bucket: 'bucket',
  apple: 'apple',
  roast: 'roast',
  // The vegetable, not the block. It kept its item id and lost its `block`, so
  // it reaches this table by the same route an apple does.
  pumpkin: 'pumpkin',
  // The WAM materials are one model per item id, so the map is an identity —
  // written out anyway rather than inferred, because this table is also the
  // list of what has a model and what is still hand-drawn.
  stick: 'stick',
  coal: 'coal',
  charcoal: 'charcoal',
  raw_iron: 'raw_iron',
  raw_gold: 'raw_gold',
  iron_ingot: 'iron_ingot',
  gold_ingot: 'gold_ingot',
  crystal: 'crystal',
  flint: 'flint',
  wheat: 'wheat',
  seeds: 'seeds',
  strawberry_seeds: 'seeds',
  squash_seeds: 'seeds',
  greenbean_seeds: 'seeds',
  snowpea_seeds: 'seeds',
  hops_seeds: 'seeds',
  grape_seeds: 'seeds',
  watermelon_seeds: 'seeds',
  hide: 'hide',
  feather: 'feather',
  raw_copper: 'raw_copper',
  raw_silver: 'raw_silver',
  sulfur: 'sulfur',
  copper_ingot: 'copper_ingot',
  silver_ingot: 'silver_ingot',
  amethyst: 'amethyst',
  ruby: 'ruby',
  sapphire: 'sapphire',
  emerald: 'emerald',
  void_shard: 'void_shard',
  cinder: 'cinder',
  coin: 'coin',
  gold_carrot: 'gold_carrot',
  // The sapling is the only *block* in this table. Everything else here is an
  // item with no cube form because it never was a block; the sapling has a
  // block id but renders as a cross, so `ViewModel` and `Drops` had nothing to
  // build for it but a pair of sprite cards. Planted, it stays the world's
  // cross billboard — that is the mesher's business and is untouched — but in
  // the fist, in the icon grid and lying on the ground it is now a real object.
  sapling: 'sapling',
  // The flowers went further than the sapling did. They are cross blocks too,
  // but unlike the sapling they are also modelled *planted* — see
  // `render/BlockModels.js` — so for these three the fist, the icon, the drop
  // and the ground are one object with nothing left over.
  flower_red: 'flower_red',
  flower_blue: 'flower_blue',
  flower_gold: 'flower_gold',
  // The glowcap is at the sapling's stage rather than the flowers': a model in
  // the fist, in the icon grid and on the ground, but planted it is still the
  // mesher's cross billboard. Finishing it is two edits that have to land
  // together — `mushroom` added to `FLOWER_NAMES` in `main.js` (which builds
  // the per-id scan that instances the model in the world) *and* to the
  // `MODELLED_CROSS` list in `world/Mesher.js` (which stops the mesher drawing
  // the billboard underneath it). Either one alone renders nothing: the model
  // without the suppression is a model inside a billboard, and the suppression
  // without the model is an empty cell.
  mushroom: 'mushroom',
  // The reef, at the flowers' stage rather than the glowcap's: model in the
  // fist, in the icon grid, on the ground *and* planted. There is no billboard
  // behind any of these to fall back on — see the note above their poses.
  coral_branch: 'coral_branch',
  coral_fan: 'coral_fan',
  coral_brain: 'coral_brain',
  coral_dead: 'coral_dead',
  kelp: 'kelp',
  sea_grass: 'sea_grass',
  sea_sponge: 'sea_sponge',
  // A clam is never in your hand — it drops a pearl, not itself — but the entry
  // has to exist all the same: `BlockModels.prime` borrows a *kind's* art from
  // the matching item, so the model the seabed draws is reached through this
  // map. Delete the line and the reef loses its clams.
  sea_shell: 'sea_shell',
  pearl: 'pearl',
  // The larder and the lamp, at the flowers' stage like the reef: fist, icon,
  // ground and planted, with no billboard behind any of them.
  sea_lettuce: 'sea_lettuce',
  sea_grape: 'sea_grape',
  abyss_anemone: 'abyss_anemone',
  dried_kelp: 'dried_kelp',
  // Item-only, like the dried kelp: a bee drops it and nothing places it.
  honeycomb: 'honeycomb',
  // The land flora and the cave floor, all sixteen at the reef's stage: fist,
  // icon, ground and planted, with no billboard behind any of them.
  //
  // Three of these are never in a hand — thornbrush and driftwood drop sticks,
  // the crystal cluster drops amethysts — and they are listed anyway for the
  // clam's reason, which is the one thing about this map that is easy to get
  // wrong: `BlockModels.prime` reaches a *planted* block's art through the
  // matching item's pose. Drop the line because the item is never picked up and
  // the biome loses the plant off the ground, not out of the toolbar.
  thornbrush: 'thornbrush',
  aloe: 'aloe',
  golden_grass: 'golden_grass',
  firebloom: 'firebloom',
  cotton_grass: 'cotton_grass',
  snowbell: 'snowbell',
  alpine_aster: 'alpine_aster',
  cactusfruit: 'cactusfruit',
  agave: 'agave',
  stonecrop: 'stonecrop',
  icecapmoss: 'icecapmoss',
  swampreed: 'swampreed',
  mireroot: 'mireroot',
  lotus: 'lotus',
  truffle: 'truffle',
  marram: 'marram',
  lavender: 'lavender',
  clover: 'clover',
  fern: 'fern',
  lingonberry: 'lingonberry',
  deathcap: 'deathcap',
  // The farm. Not one of these twenty-four is ever an item in an inventory —
  // the crop breaks into produce and seed — and they are listed anyway for the
  // reason given above the thornbrush, which is the whole trap this table sets:
  // `BlockModels.prime` reaches a *planted* block's art through the matching
  // name here, so dropping a line because "nothing picks it up" empties the
  // furrow rather than a toolbar slot.
  strawberry_0: 'strawberry_0',
  strawberry_1: 'strawberry_1',
  strawberry_2: 'strawberry_2',
  strawberry_3: 'strawberry_3',
  squash_0: 'squash_0',
  squash_1: 'squash_1',
  squash_2: 'squash_2',
  squash_3: 'squash_3',
  greenbean_0: 'greenbean_0',
  greenbean_1: 'greenbean_1',
  greenbean_2: 'greenbean_2',
  greenbean_3: 'greenbean_3',
  snowpea_0: 'snowpea_0',
  snowpea_1: 'snowpea_1',
  snowpea_2: 'snowpea_2',
  snowpea_3: 'snowpea_3',
  hops_0: 'hops_0',
  hops_1: 'hops_1',
  hops_2: 'hops_2',
  hops_3: 'hops_3',
  grape_0: 'grape_0',
  grape_1: 'grape_1',
  grape_2: 'grape_2',
  grape_3: 'grape_3',
  watermelon_0: 'watermelon_0',
  watermelon_1: 'watermelon_1',
  watermelon_2: 'watermelon_2',
  watermelon_3: 'watermelon_3',
  cave_mushroom: 'cave_mushroom',
  shelf_fungus: 'shelf_fungus',
  crystal_cluster: 'crystal_cluster',
  driftwood: 'driftwood',
  // The one place this map is not an identity, and deliberately: raw and
  // steamed crab are one model. A claw is a claw cooked or not — the shell is
  // already the orange it turns — so the pair share `crab_claw` rather than
  // carrying a second near-identical mesh for the sake of the naming.
  crab_meat: 'crab_claw',
  cooked_crab_meat: 'crab_claw',
  poultry: 'poultry',
  cooked_poultry: 'cooked_poultry',
  // Food kit. Identity again, and again written out so this stays the list of
  // what is modelled — the food line-up is the part most likely to grow.
  bread: 'bread',
  meat: 'meat',
  cooked_meat: 'cooked_meat',
  berries: 'berries',
  carrot: 'carrot',
  // The five picked crops. Identity, and the second half of the fix for "the new
  // fruits are 2d in hand" — a `POSE` entry alone changes nothing for an item
  // with no `tool` block, because `poseKeyFor` only ever reaches the table above
  // through this one.
  squash: 'squash',
  greenbean: 'greenbean',
  // The cooked half of the pair, and the last item in the game with no model.
  cooked_greenbean: 'cooked_greenbean',
  snowpea: 'snowpea',
  hops: 'hops',
  grape: 'grape',
  watermelon: 'watermelon',
  // **`cherry` and not `cherries`**, which is what this said and is the one
  // entry in the table that named a pose that does not exist. `cherries` is the
  // *file* in the food kit; the pose built from it is keyed `cherry`, like every
  // other line here is keyed by the item it belongs to.
  //
  // The failure is worse than a missing model, which is why it is written down.
  // `poseKeyFor` handed back the dangling key, `hasModel` agreed there was a
  // model, and `iconModel` then read `.icon` off `undefined` and **threw** —
  // and nothing on the icon path catches that, because `IconFactory._paint`
  // guards the *render* and not the lookup. So it came out of `icons.item()`
  // and took the whole inventory repaint down with it, every slot at once, from
  // the first cherry in the bag. Found by painting all 362 items into one
  // contact sheet: the page carrying `cherry` drew nothing at all.
  //
  // `poseKeyFor` now refuses a dangling name the way it already refused an
  // unmodelled tool kind, so the next one of these is a plain icon rather than a
  // dead panel. This line is still the fix; that is the seatbelt.
  cherry: 'cherry',
  corn: 'corn',
  tomato: 'tomato',
  egg: 'egg',
  fish: 'fish',
  cheese: 'cheese',
  cooked_fish: 'cooked_fish',
  cooked_egg: 'cooked_egg',
  salad: 'salad',
  pancakes: 'pancakes',
  sandwich: 'sandwich',
  soup: 'soup',
  pie: 'pie',
  cake: 'cake',
  stew: 'stew',
  kitchen: 'kitchen',
  // The workbench, and the only entry in this table that is also what gets
  // placed. The lantern's note at the head of this map still stands for a block
  // whose whole shape is its cube; the bench is `R_MODEL`, so there is no cube
  // to prefer — the same geometry is the fist, the icon, the ground drop and
  // the block in the world.
  bench: 'bench',
  pizza: 'pizza',
  burger: 'burger',
  cookie: 'cookie',
  donut: 'donut',
  ice_cream: 'ice_cream',
  chocolate: 'chocolate',
  muffin: 'muffin',
  candy: 'candy',
  croissant: 'croissant',
  // The kitchen catalogue. Identity throughout, written out rather than
  // inferred, because this table is also the list of what has a model.
  scrap_bowl:       'scrap_bowl',
  mixed_bowl:       'mixed_bowl',
  hearty_bowl:      'hearty_bowl',
  feast_plate:      'feast_plate',
  grand_platter:    'grand_platter',
  fruit_cup:        'fruit_cup',
  berry_jam:        'berry_jam',
  melon_ice:        'melon_ice',
  hard_tack:        'hard_tack',
  trail_mix:        'trail_mix',
  cactus_cooler:    'cactus_cooler',
  kelp_crisps:      'kelp_crisps',
  stuffed_mushroom: 'stuffed_mushroom',
  glow_broth:       'glow_broth',
  honey_toast:      'honey_toast',
  omelette:         'omelette',
  fish_cakes:       'fish_cakes',
  crab_roll:        'crab_roll',
  veg_skewer:       'veg_skewer',
  poultry_wrap:     'poultry_wrap',
  kelp_noodles:     'kelp_noodles',
  pumpkin_soup:     'pumpkin_soup',
  bean_pot:         'bean_pot',
  sushi_plate:      'sushi_plate',
  sausage_roll:     'sausage_roll',
  reef_chowder:     'reef_chowder',
  roast_dinner:     'roast_dinner',
  harbour_paella:   'harbour_paella',
  meat_pie:         'meat_pie',
  glazed_bird:      'glazed_bird',
  truffle_pasta:    'truffle_pasta',
  stuffed_squash:   'stuffed_squash',
  lotus_curry:      'lotus_curry',
  desert_tagine:    'desert_tagine',
  frost_pudding:    'frost_pudding',
  abyss_platter:    'abyss_platter',
  truffle_feast:    'truffle_feast',
  royal_roast:      'royal_roast',
  harvest_feast:    'harvest_feast',
  reef_banquet:     'reef_banquet',
  grand_gateau:     'grand_gateau',
  // The thirty-two composed dishes. Identity again, for the reason the line
  // above says: this table is also the list of what has a model.
  fish_broth:       'fish_broth',
  fish_stew:        'fish_stew',
  fish_board:       'fish_board',
  angler_feast:     'angler_feast',
  meat_hash:        'meat_hash',
  meat_stew:        'meat_stew',
  meat_roast:       'meat_roast',
  hunter_feast:     'hunter_feast',
  reef_broth:       'reef_broth',
  reef_pot:         'reef_pot',
  reef_plate:       'reef_plate',
  tide_banquet:     'tide_banquet',
  fruit_bowl:       'fruit_bowl',
  fruit_compote:    'fruit_compote',
  fruit_platter:    'fruit_platter',
  orchard_feast:    'orchard_feast',
  garden_bowl:      'garden_bowl',
  garden_stew:      'garden_stew',
  garden_plate:     'garden_plate',
  garden_feast:     'garden_feast',
  spore_bowl:       'spore_bowl',
  cap_stew:         'cap_stew',
  cap_plate:        'cap_plate',
  forest_feast:     'forest_feast',
  grain_mash:       'grain_mash',
  grain_porridge:   'grain_porridge',
  grain_plate:      'grain_plate',
  harvest_board:    'harvest_board',
  sugar_bowl:       'sugar_bowl',
  sweet_pudding:    'sweet_pudding',
  sweet_platter:    'sweet_platter',
  sugar_feast:      'sugar_feast',
  // The fifteen species. Identity again, and the map is what makes them models
  // rather than sprites in all three places at once: the fist, the icon grid and
  // the ground drop. `fish` above stays the food kit's fillet — see the note on
  // their poses.
  clownfish: 'clownfish',
  yellowtang: 'yellowtang',
  butterflyfish: 'butterflyfish',
  bluetang: 'bluetang',
  royalgramma: 'royalgramma',
  puffer: 'puffer',
  moorishidol: 'moorishidol',
  tetra: 'tetra',
  goldfish: 'goldfish',
  koi: 'koi',
  betta: 'betta',
  piranha: 'piranha',
  anglerfish: 'anglerfish',
  blobfish: 'blobfish',
  goblinshark: 'goblinshark',

  // --- armour ---------------------------------------------------------------
  //
  // Twenty ids, four models. Five tiers of each slot share a shape and are told
  // apart by colour alone, which is the one case in this file where that is the
  // right call rather than the failure mode: a copper helm and an iron helm *are*
  // the same helm in two metals, unlike a raw and a cooked drumstick, which are
  // two different objects. See `tintAll` on the poses for how the tier colour
  // gets onto a shared mesh.
  //
  // Worth knowing before touching any of this: armour is a **retired system**.
  // Nothing crafts it, nothing drops it and nothing equips it — see the note
  // above `ARMOUR_TIERS` in `game/Items.js`. These twenty definitions exist so
  // that ids sitting in old saves, in crates and in traders' stock still resolve
  // to something with a label and a picture. So this is not new content; it is
  // the last twenty items in the game that were still hand-drawn, finally
  // drawn the way everything else is.
  hide_helm: 'armour_helm',       hide_chest: 'armour_chest',
  hide_legs: 'armour_legs',       hide_boots: 'armour_boots',
  copper_helm: 'armour_helm',     copper_chest: 'armour_chest',
  copper_legs: 'armour_legs',     copper_boots: 'armour_boots',
  iron_helm: 'armour_helm',       iron_chest: 'armour_chest',
  iron_legs: 'armour_legs',       iron_boots: 'armour_boots',
  crystal_helm: 'armour_helm',    crystal_chest: 'armour_chest',
  crystal_legs: 'armour_legs',    crystal_boots: 'armour_boots',
  cinder_helm: 'armour_helm',     cinder_chest: 'armour_chest',
  cinder_legs: 'armour_legs',     cinder_boots: 'armour_boots',
};

/**
 * Per-tier treatment of the head, blade or fitting.
 *
 * All four tiers share one model, so the silhouette can't tell them apart and
 * the material has to. The metal half of the mesh drops the atlas entirely and
 * takes a flat tier colour — KayKit's metal texels are flat fields anyway, so
 * nothing is lost, and tinting *over* them was hopeless: the atlas steel is a
 * strongly blue-leaning grey that dragged wood's brown and crystal's cyan back
 * towards the same slate no matter how the multiplier was graded.
 *
 * `sat`/`light` re-grade the item's own hex to a lit-surface lightness — the raw
 * values are icon colours and read as shadow at this size. Metalness stays low:
 * the view model has one directional and one hemisphere light and no environment
 * map, and a truly metallic material with nothing to reflect renders black.
 * "Polished" here is low roughness plus a bright colour.
 */
const TIER_LOOK = {
  1: { roughness: 0.95, metalness: 0.00, emissive: 0.00, sat: 1.00, light: 0.42 },
  2: { roughness: 0.82, metalness: 0.05, emissive: 0.00, sat: 0.40, light: 0.60 },
  3: { roughness: 0.20, metalness: 0.35, emissive: 0.00, sat: 0.35, light: 0.80 },
  4: { roughness: 0.14, metalness: 0.15, emissive: 0.40, sat: 1.00, light: 0.64 },
  // Cinder reads as forge-hot rather than polished: rough, barely metallic and
  // the only tier that glows harder than astral, so it is recognisable in hand
  // at a glance in a dark cave — which is where it will mostly be used.
  // Dark, hot metal rather than a bright field: at `light: 0.52` the head came
  // out the flat orange of a traffic cone and read as cheaper than astral. A
  // deep base with a strong emissive gives the same total brightness at noon
  // while leaving somewhere for the glow to actually show after dark.
  5: { roughness: 0.45, metalness: 0.28, emissive: 0.52, sat: 0.92, light: 0.34 },
};

/**
 * The same idea as `TIER_LOOK`, for the armour ladder, and deliberately not
 * `TIER_LOOK` itself.
 *
 * Borrowing the tool ladder was tried first and does not work, for a reason
 * worth writing down because it is the whole difficulty of this table: the two
 * ladders' *hues* are not spread the same way. The tools run wood, stone, iron,
 * astral, cinder — one brown at the bottom and one hot red at the top, a long
 * way apart in lightness. Armour runs hide, copper, iron, astral, cinder, and
 * **three of its five are warm oranges**: hide at hue 28°, copper at 23°,
 * cinder at 14°. Hue cannot separate them, so lightness and saturation have to,
 * and they have to be chosen against each other rather than inherited.
 *
 * Measured, in linear RGB on the models' lit face (their authored greys times
 * this colour), worst pair of all ten:
 *
 *   - raw hexes, flat multiply, no regrade        0.083  (copper vs cinder)
 *   - regraded through TIER_LOOK                  0.086  (hide vs cinder)
 *   - this table                                  0.237  (copper vs cinder)
 *
 * 0.22 is the tolerance `glowPalette` picks colours apart with a few hundred
 * lines down, so 0.237 clears the bar this file already set itself, and every
 * other pair is 0.29 or better.
 *
 * The one honest cost: copper's grade is a light warm bronze rather than the
 * saturated orange its icon hex is, because the saturated orange is where
 * cinder has to live. It is not arbitrary — a polished copper *is* pale — and
 * the two do not rely on colour alone anyway: copper is 0.35 metal at 0.52
 * rough, cinder is a hot surface with an emissive over half, and neither of
 * those shows up in the number above.
 *
 * Hide takes no metalness at all and the highest roughness in the set, which is
 * the other half of why it stays clear of cinder: it is boiled leather and
 * should read as cloth next to a glowing plate.
 */
const ARMOUR_LOOK = {
  1: { sat: 0.50, light: 0.22, roughness: 0.95, metalness: 0.00, emissive: 0.00 }, // hide
  2: { sat: 0.85, light: 0.62, roughness: 0.52, metalness: 0.35, emissive: 0.00 }, // copper
  3: { sat: 0.28, light: 0.84, roughness: 0.26, metalness: 0.45, emissive: 0.00 }, // iron
  4: { sat: 1.00, light: 0.70, roughness: 0.18, metalness: 0.20, emissive: 0.35 }, // astral
  5: { sat: 1.00, light: 0.40, roughness: 0.45, metalness: 0.25, emissive: 0.55 }, // cinder
};

/** Which item art maps to which model. */
export function poseKeyFor(def) {
  if (def.tool) return POSE[def.tool.kind] ? def.tool.kind : null;
  // The same guard as the tool branch above, and it is here because the two
  // branches disagreeing is what let `cherry -> 'cherries'` become a crash
  // rather than a missing model. A name that resolves to no pose has to answer
  // null, exactly as an unmodelled tool kind does: then `hasModel` says no, the
  // hand-drawn art stands in, and the worst case is one plain icon instead of a
  // dead inventory. It cannot cost anything when the table is right, because
  // every value in it is a key of `POSE`.
  const key = BY_NAME[def.name];
  return key && POSE[key] ? key : null;
}

/**
 * A piece of armour's tier as a 1..5 ordinal, or 0 if it isn't armour.
 *
 * Armour carries no tier on its definition — `def.armour` is slot, points and
 * durability, and the tier survives only in the item's *name*, which the
 * generator builds as `${tier}_${slot}`. So it is read back off the name and
 * looked up in the table that made it, rather than guessed from the colour.
 *
 * Worth having rather than leaving every piece at tier 0, because tier 0 is
 * what `TIER_LOOK` is not indexed by: a flat multiply left copper and cinder
 * 0.083 apart in linear RGB (both are mid oranges) where the next closest pair
 * in the set is 0.202. Running them through the same per-tier regrade the tools
 * use is what pulls them back apart — copper to a desaturated light tan, cinder
 * to a deep red that carries its own emissive — and it is a ladder that already
 * exists and is already tuned.
 *
 * The two ladders are not the same metals, but they are the same *shape*:
 * hide/copper/iron/crystal/cinder lands on rough, dull, polished, glowing,
 * forge-hot in exactly the order `TIER_LOOK` runs in.
 */
function armourTier(def) {
  if (!def.armour || !def.name) return 0;
  const cut = def.name.lastIndexOf('_');
  if (cut < 0) return 0;
  const i = Object.keys(ARMOUR_TIERS).indexOf(def.name.slice(0, cut));
  return i < 0 ? 0 : i + 1;
}

/** @returns {{key:string, tier:number, tint:string, fill:string|null}|null} */
function modelSpecFor(itemId) {
  const def = ITEMS[itemId];
  if (!def) return null;
  const key = poseKeyFor(def);
  if (!key) return null;
  return {
    key, tier: def.tool?.tier ?? armourTier(def), tint: def.color ?? '#ffffff',
    // A pail and a pail of water are one model, and telling them apart matters
    // more in the inventory than anywhere else — so the contents are modelled.
    fill: def.fill ?? null,
  };
}

// The tint is part of the key only for the poses that actually bake it into a
// material (`tintAll`). Everywhere else `spec.tint` is the item's icon colour
// and has no effect on the mesh, so putting it in unconditionally would split
// the cache — one geometry upload per *colour* rather than per model — for
// nothing. Where it does matter it is essential: the five armour tiers share a
// pose key and a tier of 0, so without this a copper helm and an iron helm are
// the same cache entry and whichever loaded first colours both.
const meshKey = (spec) =>
  `${spec.key}|${spec.tier}|${spec.fill ?? ''}${POSE[spec.key]?.tintAll ? `|${spec.tint}` : ''}`;

// --- shared resources -------------------------------------------------------

const atlasCache = new Map();   // pack -> Promise<{texture, mask}>
const modelCache = new Map();   // pose key -> Promise<{geometry, pack}>
const meshCache = new Map();    // "key|tier" -> THREE.Mesh (template, cloned out)
const matCache = new Map();     // "pack|tier" -> Material
const failed = new Set();

let loader = null;
function gltfLoader() {
  if (loader) return loader;
  const mgr = new THREE.LoadingManager();
  // The models' own baseColor image is redundant — we substitute our shared
  // atlas after load — so hand the parser a 1x1 instead of a second 1024². The
  // Kenney colormap is caught here too: without it the GLB pulls a 512² PNG the
  // material never reads, once per model.
  mgr.setURLModifier((url) => (/(_bits_texture|colormap)\.png$/.test(url) ? BLANK : url));
  loader = new GLTFLoader(mgr);
  return loader;
}

/**
 * The atlas, plus a lookup that says whether a texel is "metal".
 *
 * KayKit paints handles and leather in warm desaturated browns and every blade,
 * head and fitting in pure greys (r == g == b). That one property is enough to
 * separate the part that should take the tier colour from the part that should
 * stay wood — no per-model authoring, and it works for both packs.
 */
function loadAtlas(pack) {
  let p = atlasCache.get(pack);
  if (p) return p;
  const cfg = PACKS[pack];
  // A pack whose colour lives in the mesh has nothing to fetch. Answering with
  // the same shape as a real atlas keeps every caller below unaware of it.
  if (!cfg.atlas) {
    p = Promise.resolve({ texture: null, isMetal: null });
    atlasCache.set(pack, p);
    return p;
  }
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (!cfg.tint) {
        const texture = new THREE.Texture(img);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.magFilter = cfg.nearest ? THREE.NearestFilter : THREE.LinearFilter;
        texture.minFilter = cfg.nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = !cfg.nearest;
        texture.needsUpdate = true;
        resolve({ texture, isMetal: null });
        return;
      }
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const texture = new THREE.Texture(img);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;                 // glTF UV convention
      texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      const isMetal = (u, v) => {
        const x = Math.min(img.width - 1, Math.max(0, (u * img.width) | 0));
        // glTF UVs put v = 0 at the top of the image (hence flipY = false on the
        // texture), which is also where getImageData's row 0 is — no flip here.
        const y = Math.min(img.height - 1, Math.max(0, (v * img.height) | 0));
        const i = (y * img.width + x) * 4;
        const r = px[i], gg = px[i + 1], b = px[i + 2], a = px[i + 3];
        if (a < 8) return false;
        // Near-black is outline and shadow: tinting it only muddies the read.
        if (r < 46 && gg < 46 && b < 46) return false;
        // Everything warm — handle wood, leather grips, rope, flame, the orange
        // gems — is left alone; anything neutral or cool is blade, head, fitting
        // and takes the tier colour. KayKit's steel is a blue-leaning grey, so
        // testing for a *neutral* grey misses it; testing for "not warm" doesn't.
        return b >= r - 8;
      };
      resolve({ texture, isMetal });
    };
    img.onerror = () => reject(new Error(`atlas ${pack} failed`));
    img.src = `${BASE}${cfg.atlas}`;
  });
  atlasCache.set(pack, p);
  return p;
}

/**
 * One geometry per model: every node baked into world space, merged, normalised
 * to unit height and recentred on the grip.
 *
 * Its triangles are then sorted so every metal one comes first, and two draw
 * groups are laid over the result — group 0 is the head/blade, group 1 is
 * everything else. That is what lets a single shared geometry be drawn with a
 * flat tier colour on the metal and the atlas on the wood, with no per-tier copy
 * of the vertex data.
 */
/**
 * Where the fist closes on a model, in the XZ plane, at one height.
 *
 * `loadGeometry` puts the geometry's origin on the **bounding box**'s X and Z
 * centre, and for most models that is also a point inside the material — an
 * apple, an ingot, a torch shaft. For a model whose mass is not stacked over
 * that centre it is a point in mid-air, and then there is no value of `grip`
 * that lands the fist on the object: measured, a hollow pail was off the metal
 * at every grip from 0.02 to 0.90 (worst 0.166 at the middle), an L-shaped claw
 * missed by 0.095 at any grip below 0.30, and the rosettes whose stems miss the
 * middle missed by their own stem spacing. That is a fact about the model space,
 * not about the pose, and it is why those entries used to carry an off-axis
 * `pos` — a first-person-only patch, since `Character._wearPose` drops `pos`.
 *
 * So the anchor is measured off the geometry instead. Cross-section at the grip
 * height; if the bbox centre is inside it, keep it — which is what leaves the
 * ninety-odd models that were already right bit-identical — and if it is not,
 * step out to the nearest wall and stop in the **middle** of it rather than on
 * its surface, so that the first-person `pos` still has somewhere to move
 * without leaving the material.
 *
 * Cheap enough to do at load: one pass over the triangles for the section, one
 * pass over the section for the ray. A WAM model is ~200 triangles.
 *
 * @param {THREE.BufferGeometry} geo already recentred and normalised, so the
 *   bounding box's X and Z centre is the origin
 * @param {number} y the grip height in that same frame
 * @returns {[number, number]|null} x and z, or null when nothing is there
 */
function gripAnchorXZ(geo, y) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const count = idx ? idx.count : pos.count;
  const at = (i) => (idx ? idx.getX(i) : i);
  // The section, as 2D segments in (x, z).
  const seg = [];
  const px = [0, 0, 0], py = [0, 0, 0], pz = [0, 0, 0];
  for (let t = 0; t < count; t += 3) {
    for (let c = 0; c < 3; c++) {
      const v = at(t + c);
      px[c] = pos.getX(v); py[c] = pos.getY(v); pz[c] = pos.getZ(v);
    }
    // Every edge that straddles the plane contributes one crossing point; a
    // triangle cut by a plane gives exactly two of them.
    const hit = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      const ya = py[a], yb = py[b];
      if ((ya < y && yb < y) || (ya > y && yb > y) || ya === yb) continue;
      const f = (y - ya) / (yb - ya);
      if (f < 0 || f > 1) continue;
      hit.push(px[a] + (px[b] - px[a]) * f, pz[a] + (pz[b] - pz[a]) * f);
    }
    if (hit.length >= 4) seg.push(hit[0], hit[1], hit[2], hit[3]);
  }
  if (!seg.length) return null;

  // Crossings of the ray from the origin along `d`, as ray parameters.
  //
  // Franklin's rule, and it has to be: the section comes out of the triangles as
  // loose segments in whatever order each triangle wound, so the two segments
  // that meet at a corner of the outline may both call that corner their start
  // or both call it their end. A half-open test on the segment's own parameter
  // then counts that corner twice or not at all, and the parity — which is the
  // whole answer — flips. Testing the *sign* of each endpoint across the ray
  // instead is orientation-free: a shared corner has one sign, so exactly one of
  // the two segments straddles. Caught by an ingot reading "outside" its own
  // middle, which is where a solid trapezoid's centre certainly is.
  const crossings = (dx, dz) => {
    const ts = [];
    for (let i = 0; i < seg.length; i += 4) {
      const ax = seg[i], az = seg[i + 1], bx = seg[i + 2], bz = seg[i + 3];
      const pa = dx * az - dz * ax;              // signed distance across the ray
      const pb = dx * bz - dz * bx;
      if ((pa > 0) === (pb > 0)) continue;
      const f = pa / (pa - pb);
      const t = (ax + (bx - ax) * f) * dx + (az + (bz - az) * f) * dz;
      if (t > 1e-9) ts.push(t);
    }
    return ts.sort((a, b) => a - b);
  };

  // Odd number of crossings ahead of it means the origin is already inside the
  // material, and then nothing moves: this is the ninety-odd models the old
  // bounding-box centre was always right for.
  if (crossings(1, 0).length % 2 === 1) return [0, 0];

  // Outside. Walk to the nearest wall...
  let bestD = Infinity, bx = 0, bz = 0;
  for (let i = 0; i < seg.length; i += 4) {
    const ax = seg[i], az = seg[i + 1], cx = seg[i + 2], cz = seg[i + 3];
    const ex = cx - ax, ez = cz - az;
    const len2 = ex * ex + ez * ez;
    const u = len2 < 1e-16 ? 0 : Math.max(0, Math.min(1, -(ax * ex + az * ez) / len2));
    const qx = ax + ex * u, qz = az + ez * u;
    const d = qx * qx + qz * qz;
    if (d < bestD) { bestD = d; bx = qx; bz = qz; }
  }
  const len = Math.hypot(bx, bz);
  if (!(len > 1e-9)) return [0, 0];
  const dx = bx / len, dz = bz / len;
  // ...and stop halfway through it. The first interval of the ray that is
  // inside the material starts at the wall we just found and ends where the ray
  // leaves it again, so its midpoint is the middle of the nearest limb: the
  // middle of a pail's wall, the middle of a claw's arm, the middle of the stem
  // nearest the centre of a rosette.
  const ts = crossings(dx, dz);
  if (ts.length < 2) return [bx, bz];
  const mid = (ts[0] + ts[1]) / 2;
  return [dx * mid, dz * mid];
}

function loadGeometry(key) {
  let p = modelCache.get(key);
  if (p) return p;
  const pose = POSE[key];
  p = Promise.all([
    new Promise((res, rej) => {
      const ext = PACKS[pose.pack].ext ?? 'gltf';
      gltfLoader().load(`${BASE}${pose.file}.${ext}`, res, undefined, rej);
    }),
    loadAtlas(pose.pack),
  ]).then(([gltf, atlas]) => {
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    const bake = PACKS[pose.pack].bakeColor;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      g.deleteAttribute('tangent');
      if (bake) {
        // A pack whose colour lives on its *materials* rather than on an atlas
        // or on the mesh. One item is one material here, so the only place the
        // per-primitive colour can survive the merge is the vertices — bake it
        // now, while each primitive still knows which material it wore.
        //
        // `material.color` is already in the renderer's linear working space
        // (GLTFLoader decodes `baseColorFactor`, which glTF defines as linear),
        // which is the same space `vertexColors` multiplies in, so this is a
        // move rather than a conversion and the model renders identically.
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        const n = g.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        const r = src?.color?.r ?? 1, gg = src?.color?.g ?? 1, b = src?.color?.b ?? 1;
        for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b; }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        // Dead weight once the bind pose is baked into world space, and
        // `mergeGeometries` refuses a set of parts whose attributes disagree.
        g.deleteAttribute('skinIndex');
        g.deleteAttribute('skinWeight');
        g.deleteAttribute('uv');
      }
      parts.push(g);
    });
    if (!parts.length) throw new Error(`${key}: no mesh`);
    let geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    // Flat shading, done here rather than by asking the material for it: the
    // WAM meshes carry no normals at all, and `flatShading` on a
    // MeshStandardMaterial only derives them per fragment from derivatives,
    // which needs *some* normal attribute to exist. Splitting the triangles and
    // computing face normals is the honest version, and at ~200 triangles a
    // model the vertex count it costs is noise.
    if (PACKS[pose.pack].flat) {
      geo = geo.toNonIndexed();
      geo.computeVertexNormals();
    }
    /**
     * `spin` — a rotation of the MODEL, applied before anything is measured.
     *
     * Everything else in a pose happens after the normalisation; this happens
     * before it, and the difference is the whole reason it exists. **`grip` is a
     * fraction of the model's height and only ever of its height** — X and Z are
     * centred on the material by `gripAnchorXZ` and are not offered to the pose
     * at all — so for a model whose long axis is not Y there is no value of
     * `grip` that moves the fist along its length. The fist is stuck at the
     * middle.
     *
     * The fish pack is authored nose along +Z, and a fish is held by the tail.
     * Standing it on its tail here puts its length on Y, and then `grip: 0.16`
     * means what it says: the fist closes a sixth of the way up from the tail,
     * in both views, and `rot` is left free to be a carrying angle rather than
     * an attempt to disguise a grip through the belly.
     *
     * Undefined for every other pose in the table, and those are untouched.
     */
    if (pose.spin) {
      geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(pose.spin[0], pose.spin[1], pose.spin[2])));
    }
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = bb.max.y - bb.min.y;
    // `grip` stays a fraction of the *height* either way — it is where the fist
    // closes on the model as it stands — but what gets fitted to one unit is the
    // longest axis for packs that ask for it. See `fitMax` in PACKS.
    //
    // The pose may override the pack, which is what the bow and the arrow need:
    // the weapons pack is shared with the sword, and a sword is authored upright
    // and wants its height fitted like everything else. `fitMax` is a fact about
    // an individual model's axis, not about who published it — the pack-level
    // flag survives because for the food kit it happens to be true of all
    // twenty-odd of them.
    const span = (pose.fitMax ?? PACKS[pose.pack].fitMax)
      ? Math.max(bb.max.x - bb.min.x, h, bb.max.z - bb.min.z)
      : h;
    const s = 1 / Math.max(1e-4, span);
    // **The geometry's own origin is the WORLD origin, and only that.** It is
    // the point `BlockModels.sync` stands on the floor of a cell, and it is
    // therefore not free: move it and every planted flower, coral and fungus in
    // the game moves with it. `root` is that height as a fraction, and it
    // defaults to `grip` because that is where the shipped world placement is —
    // the two used to be one number and this is the seam between them. A pose
    // that changes its `grip` must state its `root` to hold the world still.
    const root = pose.root ?? pose.grip;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + root * h), -(bb.min.z + bb.max.z) / 2);
    geo.scale(s, s, s);

    if (PACKS[pose.pack].tint) splitMetalGroup(geo, atlas);

    // ...and the grip origin is the other one: where the fist closes. Y is the
    // authored `grip`, measured from the same place `root` is; X and Z are
    // measured off the material at that height rather than taken from the
    // bounding box. See `gripAnchorXZ`.
    const gy = (pose.grip - root) * h * s;
    const xz = gripAnchorXZ(geo, gy) ?? [0, 0];
    const grip = [xz[0], gy, xz[1]];
    return { geometry: geo, grip, pack: pose.pack, held: null };
  });
  modelCache.set(key, p);
  return p;
}

/**
 * Reorder the index buffer so metal triangles lead, then mark the two groups. A
 * triangle counts as metal when at least two of its corners sample a metal texel,
 * which keeps the seam on the model's own material boundary — KayKit splits its
 * vertices at every hard edge, so those boundaries fall exactly on triangle
 * edges anyway.
 */
function splitMetalGroup(geo, atlas) {
  const uv = geo.getAttribute('uv');
  const idx = geo.getIndex();
  const metalVert = new Uint8Array(uv.count);
  for (let i = 0; i < uv.count; i++) metalVert[i] = atlas.isMetal(uv.getX(i), uv.getY(i)) ? 1 : 0;

  const src = idx ? idx.array : null;
  const triCount = (src ? src.length : uv.count) / 3;
  const get = (i) => (src ? src[i] : i);
  const metal = [], rest = [];
  for (let t = 0; t < triCount; t++) {
    const a = get(t * 3), b = get(t * 3 + 1), c = get(t * 3 + 2);
    const votes = metalVert[a] + metalVert[b] + metalVert[c];
    (votes >= 2 ? metal : rest).push(a, b, c);
  }
  const out = metal.concat(rest);
  geo.setIndex(out.length > 65535 ? new THREE.Uint32BufferAttribute(out, 1)
    : new THREE.Uint16BufferAttribute(out, 1));
  geo.clearGroups();
  geo.addGroup(0, metal.length, 0);
  geo.addGroup(metal.length, rest.length, 1);
}

const _hsl = { h: 0, s: 0, l: 0 };
/** Re-grade one hex by a look's saturation and lightness. */
function regrade(hex, look) {
  const c = new THREE.Color(hex);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return c.setHSL(_hsl.h, Math.min(1, _hsl.s * look.sat), look.light, THREE.SRGBColorSpace);
}

/** The item's tier colour, re-graded to read as a lit surface rather than an icon. */
function tintColor(hex, tier) {
  return regrade(hex, TIER_LOOK[tier]);
}

/**
 * Make the burning end of a model glow, and leave the rest of it alone.
 *
 * The first version bolted a flame quad on and lifted the whole mesh with a
 * flat emissive so it would not be black at night. Both were wrong. The flat
 * lift raised the texture's darks along with its lights, which is exactly what
 * flattening a texture means — the shaft stopped reading as carved wood and
 * started reading as a plain shape, and the model looked untextured when in
 * fact it was the emissive drowning it. And a torch does not need a separate
 * fire: its head *is* the fire. Ramp the glow in over the top of the model and
 * the same mesh does both jobs.
 *
 * The shaft still gets a whisper of lift, because nothing in the world scene
 * shines on these — the voxel light is baked into chunk vertices and a model is
 * not a chunk — so with none at all it goes black the moment the sun leaves.
 *
 * `loY`/`hiY` are in the geometry's own space, so this survives whatever scale
 * the pose applies and one material serves the held torch, the icon, the drop
 * and the planted one alike.
 */
export function glowTop(material, loY, hiY) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowLo = { value: loY };
    shader.uniforms.uGlowHi = { value: hiY };
    shader.uniforms.uGlowColor = { value: new THREE.Vector3(1.30, 0.54, 0.15) };
    shader.uniforms.uBodyLift = { value: new THREE.Vector3(0.13, 0.10, 0.07) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLocalY;
        uniform float uGlowLo;
        uniform float uGlowHi;
        uniform vec3 uGlowColor;
        uniform vec3 uBodyLift;`)
      .replace('#include <emissivemap_fragment>', `
        float gT = smoothstep(uGlowLo, uGlowHi, vLocalY);
        // Multiplied by the texel, not added over it, so the head keeps the
        // shape the art gave it instead of becoming a bright blob.
        totalEmissiveRadiance += uBodyLift * diffuseColor.rgb
          + uGlowColor * gT * (0.35 + 0.65 * diffuseColor.r);`);
  };
  material.customProgramCacheKey = () => 'glowtop';
  material.needsUpdate = true;
  return material;
}

/**
 * Make one *colour* of a model glow, wherever on it that colour appears.
 *
 * `glowTop` above is a height ramp, which is exactly right for a torch — the
 * fire is at the top and nowhere else — and useless for the glowcap, whose
 * clump has three separate caps at three different heights. Every band a ramp
 * could cover either misses the two buttons in the lower half or drags the
 * leader's stalk in with them.
 *
 * What the glowing parts do have in common is that they are one palette entry.
 * A WAM model carries its palette as vertex colours (see `PACKS.wam`), so the
 * gills can be selected by asking how far each fragment's own colour is from
 * the authored `Gill` hex. The palette is four flat fills with nothing between
 * them, so this is a clean separation and not a threshold to tune: the nearest
 * other entry sits 0.34 away in linear RGB and the tolerance is 0.22.
 *
 * `hex` goes through THREE.Color, which converts sRGB to the linear working
 * space — the same conversion `art/wam/scripts/export_items.py` bakes into COLOR_0, so
 * the two land on the same numbers. Comparing the authored hex against a
 * *linear* fragment without it puts the key colour a long way from anything on
 * the model and nothing glows at all.
 */
export function glowPalette(material, { hex, color, tol = 0.22, lift = [0.10, 0.09, 0.11] }) {
  const key = new THREE.Color(hex);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowKey = { value: new THREE.Vector3(key.r, key.g, key.b) };
    shader.uniforms.uGlowTol = { value: tol };
    shader.uniforms.uGlowColor = { value: new THREE.Vector3(color[0], color[1], color[2]) };
    shader.uniforms.uBodyLift = { value: new THREE.Vector3(lift[0], lift[1], lift[2]) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uGlowKey;
        uniform float uGlowTol;
        uniform vec3 uGlowColor;
        uniform vec3 uBodyLift;`)
      .replace('#include <emissivemap_fragment>', `
        float gT = 1.0 - smoothstep(uGlowTol * 0.4, uGlowTol, distance(diffuseColor.rgb, uGlowKey));
        totalEmissiveRadiance += uBodyLift * diffuseColor.rgb + uGlowColor * gT;`);
  };
  // Not 'glowtop'. The two hooks emit different shader source, and a shared
  // cache key hands the second material the first one's compiled program —
  // which is a torch-shaped ramp reading uniforms that no longer exist.
  material.customProgramCacheKey = () => 'glowpalette';
  material.needsUpdate = true;
  return material;
}

/**
 * A pack material with *this* model's lit parts lit, cached per pose key.
 *
 * Per key and not per pack: the torch shares the `tools` atlas with the pickaxe
 * and the bucket, and neither of those has a burning end.
 */
function glowMaterial(id0, key, geo, src) {
  const id = `glow|${id0}`;
  let m = matCache.get(id);
  if (m) return m;
  const pose = POSE[key];
  if (pose.glow) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = Math.max(1e-3, bb.max.y - bb.min.y);
    m = glowTop(src.clone(), bb.min.y + h * pose.glow[0], bb.min.y + h * pose.glow[1]);
  } else {
    m = glowPalette(src.clone(), pose.glowMatch);
  }
  matCache.set(id, m);
  return m;
}

/** The atlas-textured half: handles, leather, rope, flame. One per pack. */
function atlasMaterial(pack, texture) {
  const id = `atlas|${pack}`;
  let m = matCache.get(id);
  if (m) return m;
  m = !PACKS[pack].atlas
    ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 })
    : PACKS[pack].tint
    ? new THREE.MeshStandardMaterial({ map: texture, roughness: 0.78, metalness: 0.02 })
    // Produce is modelled with open stalks and leaf cards, so backfaces have to
    // draw or a pumpkin has a hole where its stem sits.
    : new THREE.MeshStandardMaterial({
      map: texture, roughness: 0.62, metalness: 0, side: THREE.DoubleSide,
    });
  matCache.set(id, m);
  return m;
}

/**
 * A WAM model's own vertex colours, multiplied by one flat item colour.
 *
 * The third colouring route in this file, and the cheapest. `atlasMaterial`
 * paints a model with the pack's texture; `metalMaterial` replaces half a
 * KayKit mesh with a flat tier colour chosen by draw group. This one keeps the
 * whole mesh and multiplies — which only works because the models that ask for
 * it are authored in near-white neutral grey, so the multiply *is* the colour
 * rather than a stain over one. That is a constraint on the art, and it is
 * written on the poses that carry `tintAll` as well as here.
 *
 * Cached per pack *and* colour, which is the whole point: four armour meshes
 * and five tier colours come to four geometries and up to twenty materials,
 * against twenty meshes if the tiers had been modelled apart.
 */
function tintedMaterial(pack, hex, tier) {
  const id = `tinted|${pack}|${hex}|${tier}`;
  let m = matCache.get(id);
  if (m) return m;
  const look = ARMOUR_LOOK[tier];
  m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // `THREE.Color` converts the hex out of sRGB into the renderer's linear
    // working space, which is the space the WAM exporter already bakes COLOR_0
    // in (see the note on `glowPalette`), so the two multiply in the same units.
    //
    // Regraded through the tool ladder where there is one (see `armourTier`).
    // The raw hexes are icon colours: at this size, unregraded, copper and
    // cinder are the same orange.
    color: look ? regrade(hex, look) : new THREE.Color(hex),
    // A shade harder and glossier than the plain WAM material: everything that
    // routes through here is metal plate or boiled hide, and at the WAM
    // default (0.85 rough, 0.02 metal) a full set read as five paper cut-outs.
    roughness: look ? look.roughness : 0.58,
    metalness: look ? look.metalness : 0.14,
  });
  // Astral and cinder carry their own light, the same as the gear does — which
  // is the second thing keeping cinder off copper, and the only one that still
  // works after dark.
  if (look && look.emissive > 0) m.emissive = regrade(hex, look).multiplyScalar(look.emissive);
  matCache.set(id, m);
  return m;
}

/** The flat tier-coloured half: heads, blades, fittings. One per tier. */
function metalMaterial(tier, tintHex) {
  const id = `metal|${tier}`;
  let m = matCache.get(id);
  if (m) return m;
  const look = TIER_LOOK[tier];
  m = new THREE.MeshStandardMaterial({
    color: tintColor(tintHex, tier),
    roughness: look.roughness,
    metalness: look.metalness,
  });
  // Astral gear carries its own light — the one tier that reads instantly even
  // in a pitch-black cave, which is where you'd be using it.
  if (look.emissive > 0) m.emissive = tintColor(tintHex, tier).multiplyScalar(look.emissive);
  matCache.set(id, m);
  return m;
}

/**
 * The same geometry with its origin moved from the world root to the grip.
 *
 * Built on demand and cached on the load record, so a model that is only ever
 * planted (the thornbrush, the clam, the crystal cluster) never pays for it,
 * and one that is only ever held never builds a second copy either — most
 * models want exactly one of the two. Where the grip and the root coincide, and
 * they do for everything whose material sits over its own bounding-box centre
 * at the grip height, this hands back the one geometry rather than a copy of
 * it: measured across the table, that is the large majority.
 */
function heldGeometry(base) {
  if (base.held) return base.held;
  const [x, y, z] = base.grip;
  base.held = (Math.abs(x) + Math.abs(y) + Math.abs(z)) < 1e-6
    ? base.geometry
    : base.geometry.clone().translate(-x, -y, -z);
  return base.held;
}

/**
 * The posed mesh for one model at one tier, in one of the two origins.
 *
 * The geometry is shared across all four tiers — only the material array
 * differs — so a full set of tools costs seven geometries and six materials in
 * total.
 *
 * `held` picks the origin. **True is the fist's and false is the ground's**, and
 * they are not the same point: see `loadGeometry`. The pose's rotation, scale
 * and `pos` are the held presentation and go on either way, because
 * `worldModel` and `iconModel` both reset them on the clone they hand out.
 */
function buildMesh(spec, base, atlas, held) {
  const id = `${meshKey(spec)}|${held ? 'h' : 'w'}`;
  let mesh = meshCache.get(id);
  if (mesh) return mesh;
  const pose0 = POSE[spec.key];
  const geo = held ? heldGeometry(base) : base.geometry;
  const pack = atlasMaterial(base.pack, atlas.texture);
  const skin = pose0.tintAll
    ? tintedMaterial(base.pack, spec.tint, spec.tier)
    : pose0.glow || pose0.glowMatch
    // Keyed by the *geometry* and not by the variant: `glowTop` is a ramp on the
    // geometry's own `position.y`, so a model whose grip and root differ needs
    // one material per copy — and a model where they agree, which is the usual
    // case and includes the torch, keeps the single shared material that lets
    // the one in your fist, the one in the toolbar and the three hundred on the
    // walls compile one program between them.
    ? glowMaterial(geo === base.geometry ? spec.key : `${spec.key}|h`, spec.key, geo, pack)
    : pack;
  const split = PACKS[base.pack].tint && spec.tier > 0;
  mesh = new THREE.Mesh(geo, split ? [metalMaterial(spec.tier, spec.tint), skin] : skin);
  if (spec.fill) mesh.add(fillDisc(geo, spec.fill));
  const pose = POSE[spec.key];
  mesh.scale.setScalar(pose.height);
  mesh.rotation.set(pose.rot[0], pose.rot[1], pose.rot[2]);
  mesh.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
  meshCache.set(id, mesh);
  return mesh;
}

/**
 * The waterline inside a pail: a disc across the model's widest axis, set at
 * the height the rim sits at. The bucket's handle arches well above that rim
 * and is part of the same bounding box, hence the fraction rather than the top.
 *
 * **Centred on the bounding box and not on the origin**, which is the whole of
 * the fix here. The disc used to sit at x = z = 0 on the grounds that the
 * geometry is recentred there — and that stopped being true for exactly this
 * model when `gripAnchorXZ` went in. A pail is hollow, so its bbox centre is
 * empty air; the grip anchor is therefore stepped out onto the *wall*, and
 * `heldGeometry` translates the origin to it. The disc then drew concentric
 * with the wall rather than with the pail: measured on the icon it hung half
 * outside the silhouette, a slab of water (and, worse, of lava) floating in mid
 * air off the right-hand side of the bucket, above the rim. Both the water and
 * the lava pail showed it, in the grid and in the fist.
 *
 * The bbox centre is the right anchor whichever origin the geometry carries: it
 * is the axis of the pail, which is what a waterline is centred on, and for the
 * ground template — where the anchor and the origin do coincide — it is the
 * same point the disc was already at, so nothing that was right moves.
 */
function fillDisc(geo, hex) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const r = Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 * 0.86;
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(r, 24),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex), roughness: 0.18, metalness: 0.1,
      side: THREE.DoubleSide,
    }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(
    (bb.min.x + bb.max.x) / 2,
    bb.min.y + (bb.max.y - bb.min.y) * 0.62,
    (bb.min.z + bb.max.z) / 2,
  );
  return disc;
}

/**
 * The posed mesh for an item, or null if there isn't one yet.
 *
 * Never throws and never blocks: on a miss it starts the load and calls `onReady`
 * once (if given) when the mesh exists. Callers keep their fallback art until
 * then.
 *
 * Returns a clone, like `iconModel` and `worldModel` do. It used to hand back
 * the cached template itself, on the grounds that only one item is ever in
 * hand — which stopped being true when the offhand arrived. Both hands equip
 * through the same path, so holding a torch in each gave them the same
 * Object3D, and `add` reparents: the main hand's torch silently vanished into
 * the left fist while you went on mining with it. Nothing corrected it either,
 * because the equip guard early-returns on an unchanged item id and `remove` on
 * the hand that no longer owns the mesh is a no-op.
 *
 * Cloning shares geometry and materials, so the cost is an Object3D and a
 * matrix per equip, not a re-upload.
 *
 * @param {number} itemId
 * @param {(mesh: THREE.Mesh) => void} [onReady]
 * @returns {THREE.Mesh|null}
 */
export function heldModel(itemId, onReady) {
  return requestMesh(itemId, onReady ? (mesh) => onReady(mesh.clone()) : null,
    (m) => m.clone(), true);
}

/**
 * The same model, freshly instanced and turned to face the icon painter.
 *
 * A clone rather than the shared template because a mesh has exactly one
 * parent: handing the icon scene the object that is currently in the player's
 * fist would take it out of the fist. Geometry and materials are still shared,
 * so a clone is three numbers and a matrix.
 *
 * @param {number} itemId
 * @param {(mesh: THREE.Mesh) => void} [onReady]
 * @returns {THREE.Mesh|null}
 */
export function iconModel(itemId, onReady) {
  const spec = modelSpecFor(itemId);
  if (!spec) return null;
  const rot = POSE[spec.key].icon ?? ICON_ROT;
  const pose = (tmpl) => {
    // `clone` and not `new Mesh(geometry, material)`: geometry and materials are
    // shared either way, but a bucket carries its waterline as a child and
    // rebuilding the mesh by hand would leave it behind.
    const m = tmpl.clone();
    m.position.set(0, 0, 0);
    m.scale.setScalar(1);
    m.rotation.set(rot[0], rot[1], rot[2]);
    return m;
  };
  // The icon takes the *grip* origin, like the fist, and not because the icon
  // cares where the grip is: `ModelIconPainter.paint` frames on the mesh's own
  // bounding box, so the origin cannot move an icon at all. Sharing the held
  // template is simply one fewer geometry, and it keeps the promise this file is
  // built on — what you see in your fist and what you see in the grid are the
  // same object.
  return requestMesh(itemId, onReady ? (tmpl) => onReady(pose(tmpl)) : null, pose, true);
}

/**
 * Cached template mesh for an item, or null while it loads.
 *
 * @param {number} itemId
 * @param {((mesh: THREE.Mesh) => void)|null} onReady called once, late, with
 *   whatever `wrap` produced — the callers keep their fallback art until then.
 * @param {(mesh: THREE.Mesh) => THREE.Mesh} [wrap]
 * @param {boolean} [held] which origin the template is built around — the fist's
 *   or the ground's. See `buildMesh`.
 */
function requestMesh(itemId, onReady, wrap = (m) => m, held = false) {
  const spec = modelSpecFor(itemId);
  if (!spec) return null;
  const have = meshCache.get(`${meshKey(spec)}|${held ? 'h' : 'w'}`);
  if (have) return wrap(have);
  if (failed.has(spec.key)) return null;
  Promise.all([loadGeometry(spec.key), loadAtlas(POSE[spec.key].pack)])
    .then(([base, atlas]) => {
      const mesh = buildMesh(spec, base, atlas, held);
      if (onReady) onReady(mesh);
    })
    .catch((err) => {
      // Missing public/models/, a 404, a corrupt file — all the same to the
      // caller: this key never gets a model and the sprite art stands in.
      console.warn(`[ItemModels] ${spec.key} unavailable, using sprite art`, err);
      failed.add(spec.key);
      modelCache.delete(spec.key);
    });
  return null;
}

/**
 * The model as a *thing standing in the world*: a fresh clone, upright along
 * +Y, unrotated and unscaled, for a caller that will place it itself.
 *
 * The held and icon poses both bake in a rotation chosen to flatter a camera
 * that is a fixed distance away. A torch planted in the ground is seen from
 * every side and from above, so it wants none of that — just the model, the
 * right way up.
 *
 * It also wants the other origin. `BlockModels.sync` puts the geometry's origin
 * on the floor of the cell, so what that origin is *is* where a planted flower
 * stands, laterally and vertically; the fist's grip point is a different point
 * and moving one used to move the other. This is the whole reason for the two
 * templates. See `loadGeometry`.
 */
export function worldModel(itemId, onReady) {
  const pose = (tmpl) => {
    const m = tmpl.clone();
    m.position.set(0, 0, 0);
    m.rotation.set(0, 0, 0);
    m.scale.setScalar(1);
    return m;
  };
  return requestMesh(itemId, onReady ? (tmpl) => onReady(pose(tmpl)) : null, pose);
}

const tipCache = new Map();   // pose key -> [x, y, z] in the held template's space

/**
 * The far end of a held model, in the held template's own space.
 *
 * There is one thing in the game that has to be drawn from a point *on* an item
 * rather than from the item: the fishing line, which runs from the rod's tip to
 * a float ten feet out in the world. It used to start from a constant —
 * `(0.30, -0.24, -0.55)` in camera space — and measured against the real chain
 * that constant is **0.69 view units** from the tip, against a rod that is only
 * 0.81 units long in hand: the line left from the lower right of the screen
 * while the rod tip was up in the top right corner. The number was never wrong
 * so much as never checked, which is the same fault as the grips.
 *
 * "The far end" is the model's own +Y extreme, averaged over the ring of
 * vertices within 3% of it so that a single stray corner cannot define it. For
 * every model in this table +Y is the end away from the hand — that is what
 * `grip` measures along — so this needs no per-pose authoring. Measured on
 * `wam/fishing_rod`, it lands on the tip ring the `.wam` source calls
 * `shaft2 at=1.00`, which is where the file hangs its own modelled cord (0.010
 * model units lower, 0.013 view units once posed).
 *
 * Null until the model has loaded; the caller keeps its fallback.
 *
 * @param {number} itemId
 * @param {THREE.Vector3} out
 * @returns {THREE.Vector3|null}
 */
export function tipPoint(itemId, out) {
  const spec = modelSpecFor(itemId);
  if (!spec) return null;
  const mesh = meshCache.get(`${meshKey(spec)}|h`);
  if (!mesh) return null;
  let p = tipCache.get(spec.key);
  if (!p) {
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const cut = bb.max.y - (bb.max.y - bb.min.y) * 0.03;
    const pos = geo.getAttribute('position');
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < cut) continue;
      sx += pos.getX(i); sy += pos.getY(i); sz += pos.getZ(i); n++;
    }
    p = n ? [sx / n, sy / n, sz / n] : [0, bb.max.y, 0];
    tipCache.set(spec.key, p);
  }
  return out.set(p[0], p[1], p[2]);
}

/**
 * The two colours the rod's float is made of, as they sit in the model's
 * `COLOR_0` attribute.
 *
 * The WAM exporter writes vertex colour as normalised unsigned bytes in the
 * *linear* working space, which is what glTF specifies and what three.js reads
 * back through `getX`. So these are not the hex codes in `fishing_rod.wam` —
 * they are those codes decoded. Measured off the shipped buffer:
 *
 *     Float #f2ece0  ->  (226, 214, 190) / 255
 *     Red   #cf3b2c  ->  (159,  11,   6) / 255
 *
 * Every other vertex in the model wears one of the five remaining palette
 * entries (Grip, Pole, Dark, Metal, Cord), so these two identify the float
 * exactly, with no per-triangle authoring and nothing to keep in sync. If the
 * `.wam` palette changes, this list is what fails — loudly, by handing back a
 * geometry with no triangles in it, which the caller reports.
 */
const BOBBER_COLORS = [
  [226 / 255, 214 / 255, 190 / 255],
  [159 / 255, 11 / 255, 6 / 255],
];
/** Colour match tolerance. An eighth of a byte step; the palette entries are far apart. */
const BOBBER_TOL = 0.02;

let bobberBase = null;   // the extracted geometry, built once

/**
 * The float on the water, cut out of the rod that threw it.
 *
 * The report was *"make the bobber match the one in rod model"*, and the rod
 * genuinely carries one: `art/wam/items/fishing_rod.wam` builds a two-tone
 * loft called `bobber` hanging off the tip, and it is the thing that stops the
 * item icon reading as a stick. What was on the water was a plain red sphere,
 * so the rod in your fist and the float thirty cells away were two different
 * objects.
 *
 * There is no separate node to take: the pack compiles one mesh, one material
 * and one merged primitive, and `loadGeometry` merges further still. What
 * survives the merge is the vertex colour, so the float is identified by its
 * two palette entries (see `BOBBER_COLORS`) and the triangles wearing them are
 * copied into a geometry of their own. One triangle's first corner decides it:
 * WAM splits vertices at every material band, so a triangle is never half one
 * colour and half another.
 *
 * The result is recentred and normalised to one unit on its longest axis, so
 * the caller scales it to whatever a float should be in cells rather than
 * inheriting the rod's proportions. Model +Y stays up: the loft is authored
 * pale above the waterline and red below, which is the way round it has to be
 * placed on the water.
 *
 * @param {number} rodItemId the fishing rod
 * @param {(geo: THREE.BufferGeometry) => void} [onReady]
 * @returns {THREE.BufferGeometry|null} null while the rod is still loading
 */
export function bobberGeometry(rodItemId, onReady) {
  if (bobberBase) return bobberBase;
  const cut = (mesh) => {
    if (bobberBase) return bobberBase;
    const src = mesh.geometry;
    const pos = src.getAttribute('position');
    const col = src.getAttribute('color');
    const nrm = src.getAttribute('normal');
    if (!col) { console.warn('[ItemModels] rod has no vertex colour; float stays generic'); return null; }
    const idx = src.getIndex();
    const n = idx ? idx.count : pos.count;
    const at = (i) => (idx ? idx.getX(i) : i);
    const isFloat = (v) => BOBBER_COLORS.some(([r, g, b]) =>
      Math.abs(col.getX(v) - r) < BOBBER_TOL
      && Math.abs(col.getY(v) - g) < BOBBER_TOL
      && Math.abs(col.getZ(v) - b) < BOBBER_TOL);
    const P = [], C = [], N = [];
    for (let t = 0; t < n; t += 3) {
      if (!isFloat(at(t))) continue;
      for (let k = 0; k < 3; k++) {
        const v = at(t + k);
        P.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        C.push(col.getX(v), col.getY(v), col.getZ(v));
        if (nrm) N.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      }
    }
    if (!P.length) { console.warn('[ItemModels] no float found on the rod model'); return null; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    if (N.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const c = bb.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);
    const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    geo.scale(1 / span, 1 / span, 1 / span);
    bobberBase = geo;
    return geo;
  };
  // The *world* template, not the held one: the held pose bakes in a carrying
  // rotation and a hand-flattering scale, and a float on a lake wants neither.
  const mesh = worldModel(rodItemId, onReady ? (m) => { const g = cut(m); if (g) onReady(g); } : null);
  return mesh ? cut(mesh) : null;
}

/**
 * The same geometry with the rod's own float removed, cached on the source.
 *
 * A cast puts a bobber on the water, and the rod in your fist carries a
 * modelled one too - so during a cast there were two, and once they became
 * literally the same object it read as a duplication bug rather than as art.
 * The float stays on the model for the idle pose and the icon, where it is what
 * stops a fishing rod reading as a plain stick.
 *
 * Built from whatever geometry it is handed rather than from the source file,
 * because the held mesh is a posed clone in its own space - a complement built
 * from the world template would drop in at the wrong place. Same vertex colour
 * test `bobberGeometry` uses, inverted.
 */
export function withoutBobber(geo) {
  if (!geo) return geo;
  if (geo.userData.noFloat) return geo.userData.noFloat;
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  if (!col) return geo;
  const nrm = geo.getAttribute('normal');
  const idx = geo.getIndex();
  const n = idx ? idx.count : pos.count;
  const at = (i) => (idx ? idx.getX(i) : i);
  const isFloat = (v) => BOBBER_COLORS.some(([r, g, b]) =>
    Math.abs(col.getX(v) - r) < BOBBER_TOL
    && Math.abs(col.getY(v) - g) < BOBBER_TOL
    && Math.abs(col.getZ(v) - b) < BOBBER_TOL);
  const P = [], C = [], N = [];
  for (let t = 0; t < n; t += 3) {
    if (isFloat(at(t))) continue;
    for (let k = 0; k < 3; k++) {
      const v = at(t + k);
      P.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      C.push(col.getX(v), col.getY(v), col.getZ(v));
      if (nrm) N.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
    }
  }
  if (!P.length || P.length === pos.count * 3) return geo;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  if (N.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  out.computeBoundingSphere();
  geo.userData.noFloat = out;
  out.userData.withFloat = geo;
  return out;
}

/** True when this item has (or is expected to have) a 3D model at all. */
export function hasModel(itemId) {
  const spec = modelSpecFor(itemId);
  return !!spec && !failed.has(spec.key);
}
