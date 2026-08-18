// World constants for the nine-face map.
//
// The planet is not a solid any more. It is one flat `W` by `W` grid of columns,
// `D` layers deep, wrapping on both axes, with one gravity. See NINE-FACES.md.
//
// THE RADIUS FAMILY IS GONE. R_MIN, R_MAX, R_SEA, R_SURFACE, PLANET_R, ARR_R and
// SIDE all described a shell around a centre and there is no centre now. Every
// one of them has been retired rather than left to be imported by accident,
// because `direction * radius` survived seven separate places through the cube
// conversion and the only reliable way to kill that bug class is to delete the
// numbers it needs. What replaces them is a LAYER, counted from bedrock up, and
// the offsets between the old radii are preserved exactly: the cube's R_MIN was
// 175, so every K_ below is its old radius minus 175.
//
// Sea level is not here at all. It is `SEA_K` in Grid.js, which owns the
// coordinate system, and is re-exported from here only so a caller that already
// imports this file does not have to import two.

import {
  F, D, W, G, COLUMNS, CELLS, SEA_K, SEALED, CROSS, isSealed,
} from './Grid.js';

export { F, D, W, G, COLUMNS, CELLS, SEA_K };

/** Nine faces, and they are labels on regions of one map, not nine slabs. */
export const FACES = 9;

/**
 * The crust, as layers.
 *
 * Layer 0 is the bottom of the world. The core shell and the mantle keep the
 * distance from it they had on the cube — core three layers up, mantle eight —
 * so the rock reads the same from below, and everything above them is measured
 * against SEA_K at 33.
 */
export const K_CORE = 3;             // unbreakable core shell
export const K_MANTLE = 8;
/** Mean land height. The cube's R_SURFACE 208.9. */
export const K_SURFACE = 33.9;
/**
 * Two under the top layer, because a clamp that bites is a plateau where a peak
 * should be. Against the waterline this is 53 layers of relief.
 */
export const K_TERRAIN_MAX = 86;
/**
 * How far down the two subtractive surface passes may reach.
 *
 * K_SEABED_MIN buys an 18-layer ocean while leaving seven layers of crust over
 * the mantle, which is the margin the number is actually pinned to. K_CANYON_MIN
 * is one higher on purpose: a gorge floor is walkable ground with soil on it and
 * things spawning on it, and a floor cut into magma stone would read as a rift.
 */
export const K_SEABED_MIN = 15;
export const K_CANYON_MIN = 16;

export const GRAVITY = 26;

// --- chunks ------------------------------------------------------------------

export const CHUNK_T = 16;           // columns per chunk on x and y
export const CHUNK_K = 11;           // layers per chunk
export const CT = W / CHUNK_T;       // 78 chunks per map axis
export const CK = D / CHUNK_K;       // 8 chunks tall
export const NUM_CHUNKS = CT * CT * CK;   // 48 672

/** Chunk id from its grid coordinates. */
export const chunkIdx = (cx, cy, ck) => ((cx * CT + cy) * CK + ck);

// --- regions -----------------------------------------------------------------
//
// The unit of *generation*, as distinct from CHUNK_*, which is the unit of
// meshing. A region is one CHUNK_T x CHUNK_T footprint of columns taken to its
// full depth — the same tile as a chunk, but all CK of them stacked.
//
// Unchanged in shape from the cube, and it did not need changing: the argument
// for it was that the generator's expensive work is per column and runs the
// whole column at once, and that a mesh request always names a chunk, so a
// region that is exactly a chunk's footprint makes "generate what this request
// needs" a lookup rather than a search. Both still hold.
//
// 6 084 of them at 22 528 voxels each.

export const NUM_REGIONS = CT * CT;               // 6 084
export const REGION_COLS = CHUNK_T * CHUNK_T;     // 256
export const REGION_VOXELS = REGION_COLS * D;     // 22 528

/** Region grid coordinates to a region id. `regionColumns` inverts it. */
export const regionIdx = (rx, ry) => (rx * CT + ry);

/** Which region owns a column. `col` is Grid's `colIndex(x, y)`. */
export function regionOfCol(col) {
  const y = col % W;
  const x = (col - y) / W;
  return regionIdx((x / CHUNK_T) | 0, (y / CHUNK_T) | 0);
}

/** The 256 column indices a region owns, ascending. */
export function regionColumns(rid, out = new Int32Array(REGION_COLS)) {
  const ry = rid % CT;
  const rx = (rid - ry) / CT;
  let n = 0;
  for (let x = rx * CHUNK_T; x < rx * CHUNK_T + CHUNK_T; x++) {
    for (let y = ry * CHUNK_T; y < ry * CHUNK_T + CHUNK_T; y++) out[n++] = x * W + y;
  }
  return out;
}

/**
 * How far from the player a chunk keeps a mesh, and how far out it survives
 * before being freed.
 *
 * The horizon argument that set these was a sphere's — sqrt(2*R*h) — and there
 * is no horizon on a flat map, so what these numbers now bound is simply how far
 * you can see. They are left where the cube had them because that is the draw
 * distance the game was tuned and measured at; chunk count grows with the square
 * of the load distance, so this is not a knob to guess high on. The gap up to
 * KEEP is hysteresis, so walking a boundary does not thrash.
 */
export const CHUNK_LOAD_DIST = 150;
export const CHUNK_KEEP_DIST = 190;

/**
 * Bumped whenever a change to WorldGen would produce different terrain for the
 * same seed.
 *
 * This exists because a save no longer stores the whole planet — it stores the
 * regions the player has actually been to, and everything else is regenerated
 * from the seed on load. That is only honest as long as the generator that
 * regenerates it is the generator that made it. Without the stamp, tuning a
 * noise threshold would leave old saves with a visited valley sitting in the
 * middle of terrain that no longer joins up with it, which is a much worse
 * outcome than being told the save cannot be opened.
 *
 * The history of 3 through 9 is in git; it was several screens of it, and every
 * entry argued the same rule, which is worth keeping and is this: **a pass that
 * only decorates the surface does not bump. A pass that moves, carves or
 * replaces ground always does.**
 *
 * **BUMP IT WHENEVER THE GENERATOR MOVES. The owner, 2026-08-18: "GEN_VERSION
 * should be bumped always, I don't care about saves, we are still in
 * development."** So the judgement call this comment used to describe - is this
 * change worth breaking a save for - is settled and is no longer a judgement
 * call. A pass that changes what the generator emits bumps this, in the same
 * commit, without asking. The rule below about decoration versus ground is kept
 * because it still describes what COUNTS as a change, but the cost side of it
 * has stopped mattering while the game is being built.
 *
 * **11: nothing grows through a divider.** `stampTree` and `boulderAt` were
 * both reaching over a wall - a crown reaches five columns and a divider is one
 * thick, so leaves landed on the far side. Measured over all twelve dividers,
 * 1581 tree cells and 2 boulder cells crossed; zero now. The change is confined
 * to the five columns either side of a divider.
 *
 * **10: the nine faces.** The coordinate system, the face count, the storage
 * order and the generator all change at once. There is no version of this that
 * an older save could survive and none was offered — see NINE-FACES.md section
 * 6, which says so in advance.
 */
export const GEN_VERSION = 12;

// --- biomes ------------------------------------------------------------------

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, PINE_FOREST: 4,
  DESERT: 5, SAVANNA: 6, TUNDRA: 7, SNOW: 8, MOUNTAIN: 9, MEADOW: 10, BADLANDS: 11,
  CINDER: 12,
  // The two new sealed faces. Each is the whole of its face, exactly as CINDER
  // is the whole of Pyre: a sealed room is one place, not a climate map.
  STORM: 13, JUNGLE: 14,
};

/**
 * What each face is for.
 *
 * Five of the nine are the ordinary world and are one continuous field with no
 * per-face anything in it; the four corners are each a single dedicated biome.
 * Rime and Pyre are ported off the cube, where they were the +Y and -Y faces.
 *
 *   1 Rime      ice
 *   3 Tempest   permanent storm
 *   7 Verdant   jungle
 *   9 Pyre      fire
 */
export const FACE_NORMAL = 0;
export const FACE_RIME = 1;
export const FACE_TEMPEST = 2;
export const FACE_VERDANT = 3;
export const FACE_PYRE = 4;

/**
 * Indexed by FACE NUMBER, 1..9, so index 0 is a hole and reading it is a bug
 * rather than a silent wrong answer.
 */
export const FACE_ROLE = [
  -1,
  FACE_RIME, FACE_NORMAL, FACE_TEMPEST,
  FACE_NORMAL, FACE_NORMAL, FACE_NORMAL,
  FACE_VERDANT, FACE_NORMAL, FACE_PYRE,
];

/**
 * What each face is called, same index order and the same hole at 0.
 *
 * The four specials are one word each because each is nothing but its element.
 * The five ordinary ones are a day, and 2, 6, 8, 4 are in RING ORDER on
 * purpose: the cross loops both ways through the middle, so walking one of those
 * loops walks the day in order and the name tells you which way round you are
 * going. Solace is the middle and is where you start: the one face with no
 * element on it and nothing arranged to kill you.
 */
export const FACE_NAME = [
  '',
  'Rime', 'Aurora', 'Tempest',
  'Zenith', 'Solace', 'Vesper',
  'Verdant', 'Umbra', 'Pyre',
];

/**
 * What each face does to the body walking on it, indexed by FACE_ROLE.
 *
 * Each is a trade rather than a penalty, so going there is a decision. Rime and
 * Pyre keep exactly what the cube's cap and cinderlands had. The two new faces
 * are given the same shape of bargain:
 *
 *   Rime      heavy going, but you last. The face you cross on foot when you
 *             have a long way to go and nothing chasing you.
 *   Tempest   the wind will not let you stand still. Quick, and it costs you:
 *             there is no safe high ground and nowhere to wait it out.
 *   Verdant   the undergrowth is the terrain. Slow, and the air is thick, so
 *             the fog is close and the stamina goes.
 *   Pyre      light and quick to tire. The low gravity is how you get over
 *             lava, and the stamina burn is the clock on being there.
 *
 * `jump` is a multiplier on HEIGHT, not on the impulse — height goes with the
 * square of take-off speed, so doubling it is a factor of sqrt(2) on the
 * velocity.
 */
export const FACE_PHYSICS = [
  { speed: 1, jump: 1, staminaDrain: 1, fog: 1 },
  { speed: 1 / 1.5, jump: 1, staminaDrain: 1 / 1.5, fog: 2.1 },
  { speed: 1.25, jump: 1, staminaDrain: 1.4, fog: 1.8 },
  { speed: 1 / 1.3, jump: 1, staminaDrain: 1.3, fog: 1.6 },
  { speed: 1, jump: 2, staminaDrain: 1.5, fog: 1.35 },
];

/** grass tint, foliage tint, water tint */
export const BIOME_COLORS = [
  { grass: [0.32, 0.55, 0.42], foliage: [0.30, 0.52, 0.38], water: [0.16, 0.42, 0.62] },
  { grass: [0.72, 0.74, 0.52], foliage: [0.55, 0.68, 0.40], water: [0.22, 0.55, 0.70] },
  { grass: [0.55, 0.78, 0.40], foliage: [0.45, 0.70, 0.34], water: [0.20, 0.50, 0.68] },
  { grass: [0.42, 0.70, 0.34], foliage: [0.34, 0.60, 0.28], water: [0.18, 0.46, 0.60] },
  { grass: [0.38, 0.60, 0.38], foliage: [0.26, 0.48, 0.32], water: [0.16, 0.42, 0.56] },
  { grass: [0.80, 0.74, 0.42], foliage: [0.68, 0.66, 0.36], water: [0.26, 0.60, 0.72] },
  { grass: [0.74, 0.76, 0.38], foliage: [0.62, 0.66, 0.32], water: [0.24, 0.56, 0.68] },
  // Tundra ground is drifts of snow over frost-heaved gravel — measured, 37% of
  // its surface columns are the snow block — so it is pulled cold and
  // desaturated, short of the snow row's blue-grey and well clear of the pine
  // forest's green. The grass term is left alone: tundra grows no grass block.
  { grass: [0.60, 0.68, 0.56], foliage: [0.42, 0.54, 0.54], water: [0.28, 0.54, 0.68] },
  // Snow. The foliage term is a *multiplier* on an already green needle tile, so
  // a pale green multiplier still leaves a green tree. Green is pulled well
  // under red and blue so the product lands cold rather than merely lighter.
  { grass: [0.70, 0.80, 0.78], foliage: [0.52, 0.58, 0.62], water: [0.36, 0.62, 0.76] },
  { grass: [0.48, 0.62, 0.44], foliage: [0.38, 0.54, 0.36], water: [0.24, 0.52, 0.68] },
  { grass: [0.62, 0.84, 0.46], foliage: [0.50, 0.76, 0.38], water: [0.22, 0.54, 0.72] },
  { grass: [0.76, 0.60, 0.36], foliage: [0.66, 0.54, 0.30], water: [0.30, 0.50, 0.56] },
  // Cinderlands. The grass and foliage rows exist only because the tint is
  // applied by index and nothing green grows here; they are dark so that
  // anything carried in and planted reads as out of place rather than lush.
  // The water row is what a lava sea takes.
  { grass: [0.34, 0.24, 0.22], foliage: [0.30, 0.20, 0.18], water: [0.90, 0.34, 0.10] },
  // Tempest. Everything on this face is seen through rain, so both plant terms
  // are pulled toward the grey-green of wet ground under a black sky, and the
  // water is the near-colourless one of standing rain rather than of a sea.
  { grass: [0.40, 0.48, 0.44], foliage: [0.32, 0.42, 0.40], water: [0.34, 0.40, 0.46] },
  // Verdant. The most saturated row in the table on purpose: the whole face is
  // canopy, and a jungle that reads as a slightly greener forest is not worth
  // walking into. The water is the dark green-brown of shaded standing water.
  { grass: [0.26, 0.62, 0.24], foliage: [0.18, 0.54, 0.20], water: [0.14, 0.38, 0.30] },
];
