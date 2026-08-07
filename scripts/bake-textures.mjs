// Bake the block texture arrays offline.
//
// Starts from the procedural generator (which still owns every tile the pack
// can't supply — ores, plants, tools, machines), then overlays hand-painted
// materials from the Lynocs pack where there's a good match. The result is
// three grid atlases the browser loads instantly, replacing ~10s of runtime
// texture synthesis.
//
//   node scripts/bake-textures.mjs

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { materialFiles, loadMap } from './texlib.mjs';
import { TILES } from '../src/world/Blocks.js';
import { generateTileArrays, generateCrackAtlas } from '../src/render/TextureGen.js';

const SIZE = 256;
// 12 rather than 8: at 146 tiles an 8-wide grid is a 2048x4864 strip, and the
// decoder has to hold the whole thing as RGBA before slicing. Twelve keeps the
// sheet close to square (3072x3328) for the same pixel count.
const COLS = 12;
const OUT = 'public/tiles';

// --- material mapping -------------------------------------------------------
// tile: [category, variant, options]
//   tint      desaturate so the runtime biome tint has room to work
//   bright    exposure multiplier on albedo
//   contrast  gain around the tile's own mean luminance (raises std-dev)
//   warm      per-channel trim, [r, g, b]; nudges a hue off dead neutral
//   rough     roughness multiplier
//   holes     punch alpha with noise (leaves)
//   overlayOn composite this tile as a fringe on top of another tile
const MAP = {
  // Cave Wall/10 has the right *pattern* for base rock — irregular natural
  // cracked slabs rather than the mortared masonry every other grey variant in
  // the pack turns out to be — but it is the worst-exposed tile in its folder
  // on every measure: mean luminance 75/255 and std-dev 16 against a folder
  // median of ~105/35, and its only hue is a slight blue (R 74 < B 81).
  //
  // That combination is what made placed stone read as a flat card: with almost
  // no albedo variation and no hue of its own, a shaded face is just the blue
  // sky fill written straight to the screen, so stone in shadow measured 0.73
  // saturation of pure navy while cobblestone next to it sat at 0.33. Lifting
  // the exposure to the same band as cobblestone/sandstone, widening the range
  // around its own mean, and trimming the blue back below the red gives the
  // rock something of its own to show in both sun and shade.
  stone: ['Cave Wall', 10, { bright: 1.8, contrast: 1.22, warm: [1.06, 1.0, 0.9] }],
  dirt: ['Mud', 6],
  grass_top: ['Grass', 2, { tint: 0.55, bright: 1.06 }],
  sand: ['Sand', 3],
  sandstone: ['Desert', 3],
  sandstone_top: ['Sand', 3],
  // Beach/6 is pale sand — it read as a second sand block, not as gravel.
  // Small loose pebbles, darkened and desaturated so it sits below cobblestone.
  gravel: ['Cobble Stone', 3, { bright: 1.62, tint: 0.72, warm: [1.02, 1.0, 0.97] }],
  clay: ['Mud', 5],
  ice: ['Ice', 3],
  water: ['Water', 1],

  // Bark on a standing trunk has to run up the side face, the way planks and
  // pine already do. Tree Bark variants 2 and 3 are the only two in the folder
  // whose grain lies across the tile rather than along it (measured gy/gx of
  // 1.50 and 2.12 against ~0.6 for every other variant) — and they were the two
  // picked for the oak and birch log sides, so those two species' logs were
  // lying on their side while pine next to them stood up. Quarter-turn them
  // rather than swapping variants, so the species keep their painted colours.
  log_oak: ['Tree Bark', 2, { rot90: true }],
  log_oak_top: ['Tree Bark', 8],
  // Leaves: `holes` used to punch a third of the tile away, which combined with
  // the (now culled) leaf-vs-leaf faces made canopies read as hollow crates.
  // Keep just enough holes to break the silhouette. `bright` is tuned so the
  // three species land in the same luminance band after the biome tint — the
  // pine variant of Bush_Hedge is far darker at source and used to render as a
  // black tree standing next to lit oaks.
  leaves_oak: ['Bush_Hedge', 6, { tint: 0.35, bright: 1.55, holes: 0.19 }],
  log_birch: ['Tree Bark', 3, { rot90: true }],
  log_birch_top: ['Tree Bark', 9],
  leaves_birch: ['Bush_Hedge', 1, { tint: 0.35, bright: 1.10, holes: 0.21 }],
  log_pine: ['Tree Bark', 1],
  log_pine_top: ['Tree Bark', 5],
  leaves_pine: ['Bush_Hedge', 2, { tint: 0.45, bright: 2.55, holes: 0.17 }],

  planks: ['Wood Planks', 4],
  // Mined stone becomes cobblestone, so the two have to read as the same rock.
  // Raw cobble is a brown stone (luminance 97, saturation 0.35) against graded
  // stone's neutral 136 — side by side they looked like different materials.
  // Desaturated and lifted to just under stone, which is what rubble should be.
  cobblestone: ['Cobble Stone', 5, { bright: 1.28, tint: 0.84, warm: [1.02, 1.0, 0.98] }],
  stone_brick: ['Stone Wall', 4],
  brick: ['Stone Wall', 11],
  moss_stone: ['Wall_with_plants', 1, { tint: 0.7 }],
  basalt: ['Volcano', 6],
  obsidian: ['Cave Wall', 6],
  core: ['Volcano', 5],
  lava: ['Volcano', 2],
  glowstone: ['Cave Floor', 7],
  crystal_block: ['Ice', 1],
  iron_block: ['Metal Plates', 6],
  gold_block: ['Pile of Gold', 1],
  snow: ['Snow Ground', 11],

  farmland: ['Mud', 10],
  farmland_wet: ['Mud', 10, { bright: 0.55, rough: 0.45 }],
  dirt_path: ['Mud', 1],

  // --- strata ---------------------------------------------------------------
  // Picked so the bands read as a gradient of value as well as of hue: pale
  // limestone under the soil, neutral andesite and marble in the middle,
  // near-black slate at the bottom. Everything from the pack's cave and cave-
  // adjacent folders is lit for a dark scene, so all of it needs the same
  // exposure lift `stone` needed.
  //
  // Cave Wall 1 and 2 were the first picks for limestone and marble and both
  // were wrong: at contact-sheet size they read as pale rock, but they are
  // *stalagmite fields* seen side-on, so as a cube face they came out as rows
  // of teeth. Sedimentary slabs instead — a rock face, which is what the walls
  // of a shaft are.
  limestone: ['Ground', 6, { bright: 1.08 }],
  // Ground 14 is the pack's only pale stone that is not also a brick, but it is
  // flecked green with moss. Pulled most of the way to luminance so it reads as
  // stone rather than as a second mossy block.
  marble: ['Ground', 14, { tint: 0.5, bright: 1.14 }],
  granite: ['Cave Wall', 7, { bright: 1.35, contrast: 1.12 }],
  // Burned Earth is one rubble painted at three exposures, so it supplies the
  // whole neutral value ramp: pale ash in the mantle, mid-grey andesite in the
  // middle crust, near-black slate at the bottom. They are three bands apart in
  // depth and separated by ~2.5 stops, so the shared source never shows.
  andesite: ['Burned Earth', 2, { bright: 1.45, contrast: 1.15, tint: 0.55 }],
  slate: ['Burned Earth', 3, { bright: 1.0, contrast: 1.25, warm: [0.96, 0.98, 1.06] }],
  ash_stone: ['Burned Earth', 1, { bright: 1.75, tint: 0.9 }],
  tuff: ['Ground', 15, { bright: 1.4, contrast: 1.15 }],
  magma_stone: ['Cave Wall', 5, { bright: 1.15 }],
  geode_stone: ['Cave Wall', 8, { bright: 1.15 }],
  crystal_stone: ['Cave Wall', 9, { bright: 1.1 }],
  azurite: ['Ground', 7, { bright: 1.1 }],

  // --- cut stone ------------------------------------------------------------
  // Smooth stone is the *same rock* as stone with the grain taken off, so it is
  // baked from stone's own source flattened rather than from a different
  // material — anything else and a smelted block stops matching what it came
  // from, which is the mistake cobblestone was already fixed for.
  smooth_stone: ['Cave Wall', 10, { bright: 2.5, contrast: 0.3, warm: [1.05, 1.0, 0.92] }],
  flagstone: ['Floor', 3],
  cobble_tan: ['Floor', 9],
  limestone_brick: ['Floor', 5],
  marble_brick: ['Damaged Wall', 4],
  granite_brick: ['Stone Wall', 9],
  andesite_brick: ['Damaged Wall', 5],
  slate_brick: ['Floor', 6, { bright: 0.85, contrast: 1.1 }],
  mossy_stone_brick: ['Stone Wall', 5, { tint: 0.7 }],
  sandstone_brick: ['Stone Wall', 7],
  smooth_sandstone: ['Indoor Walls', 3],

  // --- coloured bricks ------------------------------------------------------
  // Stone Wall is a single painted brick family, so these need no correction:
  // they were authored against each other and already sit in one value band.
  brick_tan: ['Stone Wall', 3],
  brick_crimson: ['Stone Wall', 6],
  brick_azure: ['Stone Wall', 8],
  brick_rose: ['Stone Wall', 13],
  brick_olive: ['Stone Wall', 10],
  brick_jade: ['Stone Wall', 12],
  brick_amber: ['Stone Wall', 14],
  brick_cyan: ['Stone Wall', 15],
  brick_ember: ['Stone Wall', 2],

  // --- finishes -------------------------------------------------------------
  mosaic_white: ['Tiles', 1],
  mosaic_blue: ['Tiles', 2],
  mosaic_green: ['Tiles', 3],
  plaster: ['Indoor Walls', 1],
  shingle_red: ['Roof', 1],
  shingle_green: ['Roof', 10],
  shingle_dark: ['Roof', 3],
  shingle_rose: ['Roof', 9],

  // --- timber ---------------------------------------------------------------
  // Wood Planks 1/6/8/9 run across the tile and 3/4 run along it; the four
  // picked here are all cross-grain like the existing `planks`, so a wall built
  // out of two species doesn't have its boards pointing different ways.
  planks_birch: ['Wood Planks', 8],
  planks_pine: ['Wood Planks', 1],
  planks_dark: ['Wood Planks', 6],
  planks_grey: ['Wood Planks', 9],

  // --- earth ----------------------------------------------------------------
  coarse_dirt: ['Mud', 8],
  mud: ['Mud', 4, { bright: 0.7 }],
  dried_mud: ['Mud', 7],
  peat: ['Mud', 2, { bright: 0.55 }],
  podzol_top: ['Mud', 9],
  red_sand: ['Sand', 10, { warm: [1.08, 0.86, 0.7] }],
  red_sandstone: ['Desert', 4, { warm: [1.12, 0.82, 0.68] }],
  moss_block: ['Swamp', 4, { tint: 0.6 }],

  // --- ice ------------------------------------------------------------------
  packed_ice: ['Ice', 5],
  blue_ice: ['Ice', 6],
  snow_brick: ['Snow Ground', 11],

  // --- infernal + light -----------------------------------------------------
  hell_brick: ['Hell', 4],
  magma_brick: ['Hell', 2],
  glowstone_verdant: ['Cave Floor', 13],
  glowstone_azure: ['Cave Floor', 1],

  // --- storage --------------------------------------------------------------
  copper_block: ['Pile of Gold', 4, { warm: [1.1, 0.82, 0.7] }],
  silver_block: ['Metal Plates', 7, { bright: 1.12 }],
  // Nothing in the pack is a block of coal. Small loose lumps at a quarter of
  // the exposure gravel gets from the same source: the shape is right and the
  // value is four stops away from anything it could be mistaken for.
  coal_block: ['Cobble Stone', 3, { bright: 0.42, tint: 0.95, contrast: 1.3, rough: 0.75 }],
  amethyst_block: ['Cave Floor', 6],
  ruby_block: ['Cave Floor', 4],
  sapphire_block: ['Cave Floor', 9],
  emerald_block: ['Cave Floor', 5],
  void_block: ['Cave Floor', 11],
};

// Side tiles built by blending a top material over a base material.
const FRINGE = {
  grass_side: { base: 'dirt', top: 'grass_top', height: 0.15, jitter: 0.07 },
  snow_side: { base: 'dirt', top: 'snow', height: 0.26, jitter: 0.10 },
};

// Tiles drawn as procedural detail ON TOP of a pack material. The generator
// writes only the detail and uses alpha as the coverage mask, so ore veins,
// crate bracing and kiln fittings all sit on the same rock and timber as the
// blocks around them.
const DECALS = {
  crate: 'planks',
  bench_top: 'planks',
  bench_side: 'planks',
  bed_top: 'planks',
  bed_side: 'planks',
  ladder: 'planks',
  door: 'planks',
  door_top: 'planks',
  sign: 'planks',
  fence: 'planks',
  kiln_side: 'stone_brick',
  kiln_top: 'stone_brick',
  kiln_front: 'stone_brick',
  kiln_front_lit: 'stone_brick',
  coal_ore: 'stone',
  iron_ore: 'stone',
  gold_ore: 'stone',
  crystal_ore: 'stone',
  copper_ore: 'stone',
  silver_ore: 'stone',
  sulfur_ore: 'stone',
  amethyst_ore: 'stone',
  ruby_ore: 'stone',
  sapphire_ore: 'stone',
  emerald_ore: 'stone',
  // The deep seam sits in slate, which is what makes a `deep_` ore legible as
  // "you are far enough down" rather than as a recolour of the shallow one.
  voidstone_ore: 'slate',
  deep_coal_ore: 'slate',
  deep_copper_ore: 'slate',
  deep_iron_ore: 'slate',
  deep_silver_ore: 'slate',
  deep_gold_ore: 'slate',
  deep_crystal_ore: 'slate',
};

// ---------------------------------------------------------------------------

const layerIndex = Object.fromEntries(TILES.map((t, i) => [t, i]));
const nLayers = TILES.length;
const ROWS = Math.ceil(nLayers / COLS);
const per = SIZE * SIZE * 4;

console.log(`baking ${nLayers} tiles @ ${SIZE}px  ->  ${COLS}x${ROWS} atlas`);

// 1. Procedural pass. This now only draws what the pack has no equivalent for:
//    plants, glass, torches, and the decals listed above.
process.stdout.write('  procedural baseline… ');
const base = generateTileArrays(null, SIZE);
console.log('done');

const albedo = Buffer.from(base.albedo);
const normal = Buffer.from(base.normal);
const arm = Buffer.from(base.arm);

// --- helpers ----------------------------------------------------------------

async function rawOf(file, { normalMap = false } = {}) {
  if (!file) return null;
  const { data } = await loadMap(file)
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;   // RGB, SIZE*SIZE*3
}

/**
 * Turn a SIZE×SIZE RGB buffer a quarter turn: dest(x, y) = src(y, SIZE-1-x).
 *
 * Used where the pack's grain runs the wrong way for the face the tile lands
 * on. A tangent-space normal map has to be turned as well as re-sampled — its
 * XY *is* a direction in the plane being rotated — so the channels are remapped
 * too. Under this rotation the destination's +X axis is the source's +Y and the
 * destination's +Y is the source's -X, giving R' = G and G' = 255 - R. Skipping
 * that leaves the relief lit from a direction the pixels no longer agree with.
 */
function rotate90(src, isNormalMap) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const s = ((SIZE - 1 - x) * SIZE + y) * 3;
      const d = (y * SIZE + x) * 3;
      if (isNormalMap) {
        out[d] = src[s + 1];
        out[d + 1] = 255 - src[s];
        out[d + 2] = src[s + 2];
      } else {
        out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2];
      }
    }
  }
  return out;
}

function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** Cheap tileable value noise for alpha holes and fringe jitter. */
function noiseField(size, cells, seed) {
  let s = seed | 0 || 1;
  const rnd = () => { s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0; return (s >>> 0) / 4294967296; };
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy) % cells, y1 = (y0 + 1) % cells, ty = sm(fy - Math.floor(fy));
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx) % cells, x1 = (x0 + 1) % cells, tx = sm(fx - Math.floor(fx));
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1];
      const c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      const top = a + (b - a) * tx, bot = c + (d - c) * tx;
      out[y * size + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** Write one baked material into the layer buffers. */
async function bakeTile(tileName, category, variant, opts = {}) {
  const li = layerIndex[tileName];
  if (li === undefined) { console.warn(`  ? unknown tile ${tileName}`); return false; }
  const files = materialFiles(category, variant);
  if (!files?.diffuse) { console.warn(`  ! no diffuse for ${category}/${variant}`); return false; }

  let [dif, nrm, ao, smooth, metal] = await Promise.all([
    rawOf(files.diffuse), rawOf(files.normal), rawOf(files.ao),
    rawOf(files.smoothness), rawOf(files.metallic),
  ]);

  if (opts.rot90) {
    dif = rotate90(dif, false);
    if (nrm) nrm = rotate90(nrm, true);
    if (ao) ao = rotate90(ao, false);
    if (smooth) smooth = rotate90(smooth, false);
    if (metal) metal = rotate90(metal, false);
  }

  const holes = opts.holes ? noiseField(SIZE, 9, 1234 + li * 77) : null;
  const off = li * per;
  const tint = opts.tint ?? 0;
  const bright = opts.bright ?? 1;
  const contrast = opts.contrast ?? 1;
  const warm = opts.warm ?? null;
  const roughMul = opts.rough ?? 1;

  // `contrast` pivots on the tile's own mean luminance, so widening the range
  // brightens and darkens by equal amounts rather than sliding the whole tile.
  let pivot = 0;
  if (contrast !== 1) {
    for (let i = 0; i < SIZE * SIZE; i++) pivot += lum(dif[i * 3], dif[i * 3 + 1], dif[i * 3 + 2]);
    pivot /= SIZE * SIZE;
  }

  for (let i = 0; i < SIZE * SIZE; i++) {
    let r = dif[i * 3], g = dif[i * 3 + 1], b = dif[i * 3 + 2];
    if (tint > 0) {
      // pull toward luminance so the runtime biome tint controls the hue
      const l = lum(r, g, b);
      r = r + (l - r) * tint; g = g + (l - g) * tint; b = b + (l - b) * tint;
    }
    if (contrast !== 1) {
      r = pivot + (r - pivot) * contrast;
      g = pivot + (g - pivot) * contrast;
      b = pivot + (b - pivot) * contrast;
    }
    if (warm) { r *= warm[0]; g *= warm[1]; b *= warm[2]; }
    r *= bright; g *= bright; b *= bright;
    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    const o = off + i * 4;
    albedo[o] = Math.min(255, r);
    albedo[o + 1] = Math.min(255, g);
    albedo[o + 2] = Math.min(255, b);
    albedo[o + 3] = holes ? (holes[i] < opts.holes ? 0 : 255) : 255;

    if (nrm) {
      normal[o] = nrm[i * 3];
      normal[o + 1] = nrm[i * 3 + 1];
      normal[o + 2] = nrm[i * 3 + 2];
      normal[o + 3] = 255;
    }
    const aoV = ao ? ao[i * 3] : 255;
    const smV = smooth ? smooth[i * 3] : 40;
    const mtV = metal ? metal[i * 3] : 0;
    arm[o] = aoV;
    arm[o + 1] = Math.max(6, Math.min(255, (255 - smV) * roughMul));
    arm[o + 2] = mtV;
    arm[o + 3] = 255;
  }
  return true;
}

/** Blend `top` over `base` along a jittered horizontal fringe near v = 1. */
function bakeFringe(tileName, cfg) {
  const li = layerIndex[tileName];
  const bi = layerIndex[cfg.base];
  const ti = layerIndex[cfg.top];
  if (li === undefined || bi === undefined || ti === undefined) return false;
  const jitter = noiseField(SIZE, 7, 909 + li * 13);
  const off = li * per, bOff = bi * per, tOff = ti * per;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      // texture row 0 is the BOTTOM of a side face, so measure from the top
      const v = 1 - y / SIZE;
      const edge = cfg.height + (jitter[i] - 0.5) * cfg.jitter * 2;
      const t = v <= edge ? 1 : 0;
      const o = off + i * 4, bo = bOff + i * 4, to = tOff + i * 4;
      for (let c = 0; c < 4; c++) {
        albedo[o + c] = t ? albedo[to + c] : albedo[bo + c];
        normal[o + c] = t ? normal[to + c] : normal[bo + c];
        arm[o + c] = t ? arm[to + c] : arm[bo + c];
      }
      albedo[o + 3] = 255;   // side faces are always opaque
    }
  }
  return true;
}

/** Composite a decal layer over its base material using the decal's alpha. */
function compositeDecal(tileName, baseName) {
  const li = layerIndex[tileName];
  const bi = layerIndex[baseName];
  if (li === undefined || bi === undefined) return false;
  const off = li * per, bOff = bi * per;

  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = off + i * 4, b = bOff + i * 4;
    const m = albedo[o + 3] / 255;
    for (let c = 0; c < 3; c++) {
      albedo[o + c] = albedo[o + c] * m + albedo[b + c] * (1 - m);
      normal[o + c] = normal[o + c] * m + normal[b + c] * (1 - m);
      arm[o + c] = arm[o + c] * m + arm[b + c] * (1 - m);
    }
    arm[o + 3] = arm[o + 3] * m + arm[b + 3] * (1 - m);
    albedo[o + 3] = 255;      // these are all solid blocks
  }
  return true;
}

// --- run --------------------------------------------------------------------

let baked = 0;
for (const [tile, [cat, variant, opts]] of Object.entries(MAP)) {
  const ok = await bakeTile(tile, cat, variant, opts);
  if (ok) { baked++; process.stdout.write(`\r  materials: ${baked}/${Object.keys(MAP).length}  `); }
}
console.log('');

for (const [tile, cfg] of Object.entries(FRINGE)) {
  if (bakeFringe(tile, cfg)) console.log(`  fringe: ${tile}`);
}
let decals = 0;
for (const [tile, base] of Object.entries(DECALS)) {
  if (compositeDecal(tile, base)) decals++;
}
console.log(`  decals over pack bases: ${decals}`);

// --- assemble the atlases ---------------------------------------------------

/**
 * @param {'srgb'|'normal'|'data'} kind how hard this map is to compress badly
 */
async function writeAtlas(buf, name, kind) {
  const W = COLS * SIZE, H = ROWS * SIZE;
  const sheet = Buffer.alloc(W * H * 4);
  for (let li = 0; li < nLayers; li++) {
    const cx = (li % COLS) * SIZE, cy = Math.floor(li / COLS) * SIZE;
    for (let y = 0; y < SIZE; y++) {
      const src = li * per + y * SIZE * 4;
      const dst = ((cy + y) * W + cx) * 4;
      buf.copy(sheet, dst, src, src + SIZE * 4);
    }
  }
  // WebP keeps alpha and cuts the atlases from ~20 MB to a few MB. The three
  // maps do not deserve the same treatment:
  //
  //   normal  near-lossless. A normal is a *direction*; a compressor free to
  //           shift a channel by a few counts tilts the surface, and the error
  //           lands in the specular highlight where it reads as banding.
  //   arm     ordinary lossy. Ambient occlusion, roughness and metalness are
  //           three independent scalars, each feeding a broad response rather
  //           than a direction — a count or two of error is invisible. This map
  //           was on the normal setting only because it is also linear data,
  //           and at 146 tiles that inheritance cost more than every other
  //           atlas combined: 8.3 MB against albedo's 2.5.
  //   srgb    ordinary lossy, slightly higher quality since it is what you
  //           actually look at.
  const pipeline = sharp(sheet, { raw: { width: W, height: H, channels: 4 } });
  const opts = kind === 'normal'
    ? { nearLossless: true, quality: 80, alphaQuality: 100, effort: 6 }
    : { quality: kind === 'srgb' ? 93 : 88, alphaQuality: 100, effort: 6 };
  await pipeline.webp(opts).toFile(path.join(OUT, `${name}.webp`));
  const kb = Math.round(fs.statSync(path.join(OUT, `${name}.webp`)).size / 1024);
  console.log(`  ${name}.webp  ${W}x${H}  ${kb} KB`);
}

fs.mkdirSync(OUT, { recursive: true });
await writeAtlas(albedo, 'albedo', 'srgb');
await writeAtlas(normal, 'normal', 'normal');
await writeAtlas(arm, 'arm', 'data');

// crack overlay
const crack = generateCrackAtlas(10, 64);
{
  const S = crack.size, N = crack.layers;
  const sheet = Buffer.alloc(S * N * S * 4);
  for (let l = 0; l < N; l++) {
    const src = Buffer.from(crack.data.buffer, l * S * S * 4, S * S * 4);
    for (let y = 0; y < S; y++) src.copy(sheet, ((y) * S * N + l * S) * 4, y * S * 4, (y + 1) * S * 4);
  }
  await sharp(sheet, { raw: { width: S * N, height: S, channels: 4 } })
    .webp({ lossless: true, alphaQuality: 100 })
    .toFile(path.join(OUT, 'crack.webp'));
  console.log(`  crack.webp  ${S * N}x${S}`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  size: SIZE, cols: COLS, rows: ROWS, layers: nLayers, ext: 'webp',
  crack: { size: crack.size, layers: crack.layers },
  tiles: TILES,
  bakedFromPack: Object.keys(MAP).length + Object.keys(FRINGE).length + Object.keys(DECALS).length,
}, null, 2));

console.log(`\ndone — ${baked} pack materials, ${Object.keys(FRINGE).length} fringes, ${decals} decals`);
