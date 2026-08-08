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
import { ITEMS } from '../game/Items.js';

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
  // Ours, authored in WAM (see `wam/items/*.wam`). No atlas at all: the palette
  // is baked per vertex, which is what lets a four-colour model still be one
  // merged geometry and one material like everything else here. `flat` is the
  // other half of the look — the source meshes ship no normals precisely so
  // that this side gets to derive hard-edged ones.
  wam:     { atlas: null, tint: false, flat: true },
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

const POSE = {
  pick:   { file: 'pickaxe',      pack: 'tools',   height: 0.46, grip: 0.18, rot: [-0.42, -0.62, 0.34], pos: [0.02, -0.04, 0],     icon: TOOL_ICON },
  axe:    { file: 'axe',          pack: 'tools',   height: 0.40, grip: 0.20, rot: [-0.35, -0.95, 0.40], pos: [0.03, 0.04, -0.02],  icon: TOOL_ICON },
  // The shovel is the one tool the pick's pose does not transfer to, and it had
  // the pick's rotation copied verbatim. It is modelled the other way up —
  // T-grip at the top, blade hanging below — so the pick's *backward* pitch,
  // which is what lifts a pickaxe head ready to swing, dropped the shovel's
  // blade down and behind the fist with the scoop rolled away from the ground.
  //
  // Positive pitch instead: the shaft leans back over the shoulder, the blade
  // drops forward and down where the ground is, and the scoop's hollow (the
  // model's -Z face) ends up pointing up and forward — so the player sees the
  // back of the blade going in, and the lift at the end of the dig track brings
  // the hollow up towards them holding what it just cut.
  //
  // `grip` follows from that: the fist closes on the shaft above the blade, at
  // 0.70 of the model's height. It was 0.22, which is *inside the blade* — the
  // swing was pivoting around the digging end. And because everything below the
  // grip now hangs down from a fist that already sits near the bottom of the
  // frame, `pos` lifts the whole tool clear of the arm; without that the blade
  // is simply below the screen.
  shovel: { file: 'shovel',       pack: 'tools',   height: 0.46, grip: 0.70, rot: [0.50, -0.55, 0.20],  pos: [-0.04, 0.28, -0.14], icon: [0.18, 0.52, -0.26] },
  sword:  { file: 'sword_B',      pack: 'weapons', height: 0.50, grip: 0.16, rot: [-0.25, -0.60, 1.00], pos: [0.04, 0.04, -0.03],  icon: [0.05, 0.30, -0.42] },
  torch:  { file: 'torch',        pack: 'tools',   height: 0.50, grip: 0.24, rot: [-0.20, -0.35, 0.22], pos: [0.02, 0.06, -0.02],  icon: [0.08, 0.55, -0.26] },
  bucket: { file: 'bucket_metal', pack: 'tools',   height: 0.36, grip: 0.55, rot: [0, -0.55, 0.14],     pos: [0.03, 0.05, -0.03],  icon: [0.16, 0.60, 0] },

  // Food. Held small and close — an apple filling as much of the frame as a
  // pickaxe reads as a beach ball. `grip` sits at the middle of the fruit
  // rather than at a handle, so it turns in the fist instead of orbiting it.
  apple:  { file: 'applered01', pack: 'produce', height: 0.24, grip: 0.50, rot: [0.10, -0.50, 0.10], pos: [0.02, 0.12, -0.06] },
  roast:  { file: 'pumpkin01',  pack: 'produce', height: 0.28, grip: 0.50, rot: [0.10, -0.55, 0.10], pos: [0.02, 0.15, -0.06] },

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
  bread:       food('loaf-round', 0.30),
  meat:        food('meat-raw', 0.30, true),
  cooked_meat: food('meat-cooked', 0.30, true),

  berries:     food('cherries', 0.22),
  carrot:      food('carrot', 0.28),
  corn:        food('corn', 0.30),
  tomato:      food('tomato', 0.22),
  egg:         food('egg', 0.20),
  // The fish is modelled nose-down-Z and is only a third as wide as it is long,
  // so at the shared yaw it was a dark sliver pointing at the camera. The yaw is
  // nearly a quarter turn instead, which puts the flank across the view, and the
  // roll runs that length along the icon's diagonal so it can be drawn bigger
  // without leaving the slot.
  fish:        food('fish', 0.30, false, { rot: [0.10, -1.30, 0.30], icon: [0.15, 1.34, 0.38] }),
  cheese:      food('cheese', 0.24),

  cooked_fish: food('sushi-salmon', 0.26, true),
  cooked_egg:  food('egg-cooked', 0.26, true),
  salad:       food('salad', 0.26, true),
  pancakes:    food('pancakes', 0.26, true),

  sandwich:    food('sandwich', 0.28, true),
  soup:        food('bowl-soup', 0.26, true),
  pie:         food('pie', 0.30, true),
  cake:        food('cake', 0.30),
  // The stew pot takes the flat pose for the same reason the bowls do: side-on
  // it is a grey cylinder, and everything that says "stew" is inside it.
  stew:        food('pot-stew', 0.30, true),
  pizza:       food('pizza', 0.30, true),
  burger:      food('burger-cheese', 0.26),

  cookie:      food('cookie', 0.24, true),
  donut:       food('donut-sprinkles', 0.24, true),
  ice_cream:   food('ice-cream', 0.28),
  chocolate:   food('chocolate', 0.26, true),
  muffin:      food('muffin', 0.24),
  candy:       food('lollypop', 0.28),
  croissant:   food('croissant', 0.26, true),

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
  stick:      { file: 'wam/stick',      pack: 'wam', height: 0.38, grip: 0.40, rot: [-0.18, -0.40, 0.30],  pos: [0.02, 0.04, -0.02], icon: [0.10, 0.10, -0.46] },
  coal:       { file: 'wam/coal',       pack: 'wam', height: 0.17, grip: 0.50, rot: [0.16, -0.55, 0.12],   pos: [0.02, 0.11, -0.05], icon: [0.22, 1.75, 0] },
  charcoal:   { file: 'wam/charcoal',   pack: 'wam', height: 0.22, grip: 0.50, rot: [0.10, -0.50, 0.55],   pos: [0.02, 0.11, -0.05], icon: [0.18, 0.62, -0.38] },
  raw_iron:   { file: 'wam/raw_iron',   pack: 'wam', height: 0.18, grip: 0.50, rot: [0.16, -0.60, 0.12],   pos: [0.02, 0.11, -0.05], icon: [0.22, 0.66, 0] },
  raw_gold:   { file: 'wam/raw_gold',   pack: 'wam', height: 0.18, grip: 0.50, rot: [0.16, -0.30, 0.12],   pos: [0.02, 0.11, -0.05], icon: [0.22, 0.30, 0] },
  iron_ingot: { file: 'wam/iron_ingot', pack: 'wam', height: 0.26, grip: 0.50, rot: [0.10, -0.55, 1.30],   pos: [0.02, 0.11, -0.05], icon: [0.50, 0.60, 1.30] },
  gold_ingot: { file: 'wam/gold_ingot', pack: 'wam', height: 0.26, grip: 0.50, rot: [0.10, -0.55, 1.30],   pos: [0.02, 0.11, -0.05], icon: [0.50, 0.60, 1.30] },
  crystal:    { file: 'wam/crystal',    pack: 'wam', height: 0.26, grip: 0.45, rot: [0.06, -0.60, 0.28],   pos: [0.02, 0.16, -0.05], icon: [0.10, 0.55, -0.20] },
  flint:      { file: 'wam/flint',      pack: 'wam', height: 0.19, grip: 0.50, rot: [0.10, -0.75, 0.34],   pos: [0.02, 0.11, -0.05], icon: [0.06, 0.60, -0.24] },
  wheat:      { file: 'wam/wheat',      pack: 'wam', height: 0.36, grip: 0.42, rot: [-0.14, -0.35, 0.34],  pos: [0.02, 0.20, -0.02], icon: [0.06, 0.20, -0.30] },
  seeds:      { file: 'wam/seeds',      pack: 'wam', height: 0.17, grip: 0.50, rot: [0.30, -0.55, 0.10],   pos: [0.02, 0.05, -0.05], icon: [0.42, 0.60, 0] },
  hide:       { file: 'wam/hide',       pack: 'wam', height: 0.26, grip: 0.50, rot: [0.10, -0.50, 1.30],   pos: [0.02, 0.11, -0.05], icon: [0.24, 0.92, 1.32] },
  feather:    { file: 'wam/feather',    pack: 'wam', height: 0.32, grip: 0.38, rot: [-0.16, -0.40, 0.36],  pos: [0.02, 0.18, -0.02], icon: [0.06, 0.30, -0.38] },

  // The rest of the ladder, on the same three family poses. Ores and the
  // sulfur crust take the lump pose; the cast bars take the ingot pose, which
  // is the one with the quarter turn in `rot.z` because those models are
  // authored along their long axis and stood up on export.
  raw_copper:   { file: 'wam/raw_copper',   pack: 'wam', height: 0.18, grip: 0.50, rot: [0.16, -0.45, 0.12], pos: [0.02, 0.11, -0.05], icon: [0.22, 0.52, 0] },
  raw_silver:   { file: 'wam/raw_silver',   pack: 'wam', height: 0.18, grip: 0.50, rot: [0.16, -0.60, 0.12], pos: [0.02, 0.11, -0.05], icon: [0.22, 0.66, 0] },
  sulfur:       { file: 'wam/sulfur',       pack: 'wam', height: 0.18, grip: 0.50, rot: [0.16, -0.50, 0.12], pos: [0.02, 0.11, -0.05], icon: [0.22, 0.40, 0] },
  copper_ingot: { file: 'wam/copper_ingot', pack: 'wam', height: 0.26, grip: 0.50, rot: [0.10, -0.55, 1.30], pos: [0.02, 0.11, -0.05], icon: [0.50, 0.60, 1.30] },
  silver_ingot: { file: 'wam/silver_ingot', pack: 'wam', height: 0.26, grip: 0.50, rot: [0.10, -0.55, 1.30], pos: [0.02, 0.11, -0.05], icon: [0.50, 0.60, 1.30] },

  // Gems, on the crystal's pose: held a touch higher than a lump and turned
  // less far off the camera, because what a gem has that a lump does not is
  // facets, and at three-quarters the front facet turns away from the key
  // light and the whole stone flattens to one tone.
  //
  // The cut stones (ruby, sapphire, emerald) are shorter in the frame than the
  // grown crystals: they are one compact object rather than a cluster, so at
  // the cluster's height they filled the slot edge to edge.
  amethyst:   { file: 'wam/amethyst',   pack: 'wam', height: 0.24, grip: 0.45, rot: [0.06, -0.55, 0.24],   pos: [0.02, 0.16, -0.05], icon: [0.10, 0.50, -0.18] },
  ruby:       { file: 'wam/ruby',       pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.02, 0.14, -0.05], icon: [0.14, 0.40, -0.12] },
  sapphire:   { file: 'wam/sapphire',   pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.02, 0.14, -0.05], icon: [0.14, 0.40, -0.12] },
  emerald:    { file: 'wam/emerald',    pack: 'wam', height: 0.20, grip: 0.48, rot: [0.10, -0.45, 0.18],   pos: [0.02, 0.14, -0.05], icon: [0.14, 0.40, -0.12] },
  // The shard is a wafer with its broken face on +Z, so it takes the flint
  // treatment: turned to show the flat of the blade, not its edge, where it
  // would be a two-pixel line.
  void_shard: { file: 'wam/void_shard', pack: 'wam', height: 0.23, grip: 0.45, rot: [0.06, -0.34, 0.30],   pos: [0.02, 0.15, -0.05], icon: [0.08, 0.24, -0.20] },
  // Cinder is a lump, but its whole read is the hot seam, and the seam is a 22°
  // stripe on the model's +Z face. Both poses are therefore nearly square to
  // the camera: at the lump family's usual three-quarter turn the crack went
  // round the side and the icon was a plain black pebble.
  cinder:     { file: 'wam/cinder',     pack: 'wam', height: 0.19, grip: 0.50, rot: [0.16, -0.22, 0.12],   pos: [0.02, 0.11, -0.05], icon: [0.22, 0.14, 0] },

  // The coin is modelled standing on its rim with the struck device on both
  // faces, so both poses are shallow yaws: the whole object is that face, and
  // anything approaching three-quarters turns it into a sliver. Held small —
  // it is a coin, and at lump size it read as a dinner plate.
  coin:       { file: 'wam/coin',       pack: 'wam', height: 0.15, grip: 0.50, rot: [0.10, -0.30, 0.10],   pos: [0.02, 0.12, -0.05], icon: [0.12, 0.26, 0] },
  // The sapling takes the shaft pose — it is a stem with a crown on top, and
  // the drawn diagonal is what the other tall, thin items use. `grip` is low
  // on purpose: you carry a seedling by its stem, so the fist closes under the
  // foliage rather than through it.
  sapling:    { file: 'wam/sapling',    pack: 'wam', height: 0.34, grip: 0.30, rot: [-0.12, -0.35, 0.30],  pos: [0.02, 0.14, -0.02], icon: [0.08, 0.30, -0.18] },
};

/** Item name -> pose key, for the items that carry no `tool` block. */
const BY_NAME = {
  // The lantern is deliberately absent: it is a full block, and held as its own
  // model it read as a grey lump seen from above — the cube preview of what you
  // are about to place is both clearer and truer.
  torch: 'torch',
  bucket: 'bucket',
  water_bucket: 'bucket',
  apple: 'apple',
  roast: 'roast',
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
  // The sapling is the only *block* in this table. Everything else here is an
  // item with no cube form because it never was a block; the sapling has a
  // block id but renders as a cross, so `ViewModel` and `Drops` had nothing to
  // build for it but a pair of sprite cards. Planted, it stays the world's
  // cross billboard — that is the mesher's business and is untouched — but in
  // the fist, in the icon grid and lying on the ground it is now a real object.
  sapling: 'sapling',
  // Food kit. Identity again, and again written out so this stays the list of
  // what is modelled — the food line-up is the part most likely to grow.
  bread: 'bread',
  meat: 'meat',
  cooked_meat: 'cooked_meat',
  berries: 'berries',
  carrot: 'carrot',
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
  pizza: 'pizza',
  burger: 'burger',
  cookie: 'cookie',
  donut: 'donut',
  ice_cream: 'ice_cream',
  chocolate: 'chocolate',
  muffin: 'muffin',
  candy: 'candy',
  croissant: 'croissant',
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

/** Which item art maps to which model. */
function poseKeyFor(def) {
  if (def.tool) return POSE[def.tool.kind] ? def.tool.kind : null;
  return BY_NAME[def.name] ?? null;
}

/** @returns {{key:string, tier:number, tint:string, fill:string|null}|null} */
function modelSpecFor(itemId) {
  const def = ITEMS[itemId];
  if (!def) return null;
  const key = poseKeyFor(def);
  if (!key) return null;
  return {
    key, tier: def.tool?.tier ?? 0, tint: def.color ?? '#ffffff',
    // A pail and a pail of water are one model, and telling them apart matters
    // more in the inventory than anywhere else — so the contents are modelled.
    fill: def.fill ?? null,
  };
}

const meshKey = (spec) => `${spec.key}|${spec.tier}|${spec.fill ?? ''}`;

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
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      g.deleteAttribute('tangent');
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
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const h = bb.max.y - bb.min.y;
    // `grip` stays a fraction of the *height* either way — it is where the fist
    // closes on the model as it stands — but what gets fitted to one unit is the
    // longest axis for packs that ask for it. See `fitMax` in PACKS.
    const span = PACKS[pose.pack].fitMax
      ? Math.max(bb.max.x - bb.min.x, h, bb.max.z - bb.min.z)
      : h;
    const s = 1 / Math.max(1e-4, span);
    geo.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + pose.grip * h), -(bb.min.z + bb.max.z) / 2);
    geo.scale(s, s, s);

    if (PACKS[pose.pack].tint) splitMetalGroup(geo, atlas);
    return { geometry: geo, pack: pose.pack };
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
/** The item's tier colour, re-graded to read as a lit surface rather than an icon. */
function tintColor(hex, tier) {
  const look = TIER_LOOK[tier];
  const c = new THREE.Color(hex);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return c.setHSL(_hsl.h, Math.min(1, _hsl.s * look.sat), look.light, THREE.SRGBColorSpace);
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
 * The posed mesh for one model at one tier. The geometry is shared across all
 * four tiers — only the material array differs — so a full set of tools costs
 * seven geometries and six materials in total.
 */
function buildMesh(spec, base, atlas) {
  const id = meshKey(spec);
  let mesh = meshCache.get(id);
  if (mesh) return mesh;
  const skin = atlasMaterial(base.pack, atlas.texture);
  const split = PACKS[base.pack].tint && spec.tier > 0;
  mesh = new THREE.Mesh(base.geometry, split ? [metalMaterial(spec.tier, spec.tint), skin] : skin);
  if (spec.fill) mesh.add(fillDisc(base.geometry, spec.fill));
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
  disc.position.y = bb.min.y + (bb.max.y - bb.min.y) * 0.62;
  return disc;
}

/**
 * The posed mesh for an item, or null if there isn't one yet.
 *
 * Never throws and never blocks: on a miss it starts the load and calls `onReady`
 * once (if given) when the mesh exists. Callers keep their fallback art until
 * then. Meshes are shared — the same object is handed out every time, which is
 * safe because only one item is ever in hand.
 *
 * @param {number} itemId
 * @param {(mesh: THREE.Mesh) => void} [onReady]
 * @returns {THREE.Mesh|null}
 */
export function heldModel(itemId, onReady) {
  return requestMesh(itemId, onReady ? (mesh) => onReady(mesh) : null);
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
  return requestMesh(itemId, onReady ? (tmpl) => onReady(pose(tmpl)) : null, pose);
}

/**
 * Cached template mesh for an item, or null while it loads.
 *
 * @param {number} itemId
 * @param {((mesh: THREE.Mesh) => void)|null} onReady called once, late, with
 *   whatever `wrap` produced — the callers keep their fallback art until then.
 * @param {(mesh: THREE.Mesh) => THREE.Mesh} [wrap]
 */
function requestMesh(itemId, onReady, wrap = (m) => m) {
  const spec = modelSpecFor(itemId);
  if (!spec) return null;
  const have = meshCache.get(meshKey(spec));
  if (have) return wrap(have);
  if (failed.has(spec.key)) return null;
  Promise.all([loadGeometry(spec.key), loadAtlas(POSE[spec.key].pack)])
    .then(([base, atlas]) => {
      const mesh = buildMesh(spec, base, atlas);
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

/** True when this item has (or is expected to have) a 3D model at all. */
export function hasModel(itemId) {
  const spec = modelSpecFor(itemId);
  return !!spec && !failed.has(spec.key);
}
