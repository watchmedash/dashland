// Cubesphere world constants.
//
// The planet is a quadrilateralised cube: six FxF grids of radial columns,
// each column D layers deep. Every voxel is a curved hexahedron whose "up" is
// the radial direction, so blocks stand upright everywhere on the surface —
// no staircase terracing, unlike an axis-aligned voxel cube.

// Scale note: a cell must stay about one block across, and its width is
// (R * pi/2) / F — so the face resolution and the radius have to move together.
// F 64 -> 208 with R_SEA 40 -> 130 keeps the cell at 0.98 units while giving
// 10.6x the surface area.
//
// Second enlargement, F 208 -> 464 with R_SEA 130 -> 290: 4.98x the surface
// area at a cell width of 0.982, near enough identical to the 0.98 before it.
// 464 and not the 465 that would land exactly on sqrt(5), because CT = F /
// CHUNK_T has to come out whole and 464/16 = 29.
//
// The shell got thicker too, which the first enlargement deliberately did not
// do — and every landform the planet was missing wanted thickness rather than
// width. D 44 -> 66 (still whole against CHUNK_K = 11) buys 22 more layers, and
// they are spent on both ends: 24 blocks of terrain above sea instead of 12,
// and 32 layers of crust between the mantle and the waterline instead of 22, so
// an ocean trench and a canyon can both exist without meeting in the middle.
export const FACES = 6;
export const F = 464;                // cells per face axis
export const D = 66;                 // radial layers
export const R_MIN = 250;            // radius of layer 0
export const R_MAX = R_MIN + D;      // 316

export const COLUMNS = FACES * F * F;        // 1 291 776
export const NUM_VOXELS = COLUMNS * D;       // 85 257 216

export const CHUNK_T = 16;           // cells per chunk along i and j
export const CHUNK_K = 11;           // layers per chunk
export const CT = F / CHUNK_T;       // 29 chunks per face axis
export const CK = D / CHUNK_K;       // 6 chunks radially
export const NUM_CHUNKS = FACES * CT * CT * CK;   // 30 276

/**
 * How far from the player a chunk keeps a mesh, and how far out it survives
 * before being freed. Meshing the whole planet was fine at 384 chunks; at 30 276
 * it would be several gigabytes of geometry resident at all times.
 *
 * The horizon does the work here, and it grows with the square root of the
 * radius rather than with the radius — sqrt(2*R*h). At R_SEA 130 an eye two
 * blocks up saw the ground fall away at ~23 units and the tallest terrain stay
 * visible to ~79, so 100 covered everything. At 290 those become ~34 and ~132.
 *
 * 150 is that 132 with a little margin, and it is deliberately *not* the 223
 * that scaling the old number by the radius would have given: chunk count grows
 * with the square of this distance, so guessing high here is what turns a
 * bigger planet into a slideshow. The gap up to 190 is hysteresis, so walking a
 * boundary doesn't thrash.
 */
export const CHUNK_LOAD_DIST = 150;
export const CHUNK_KEEP_DIST = 190;

/** voxel index from (face, i, j, k) */
export const vidx = (f, i, j, k) => (((f * F + i) * F + j) * D + k);
/** column index from (face, i, j) */
export const cidx = (f, i, j) => ((f * F + i) * F + j);

export const chunkIdx = (f, ci, cj, ck) => (((f * CT + ci) * CT + cj) * CK + ck);

// --- regions -----------------------------------------------------------------
//
// The unit of *generation*, as distinct from CHUNK_*, which is the unit of
// meshing. A region is one CHUNK_T x CHUNK_T footprint of columns taken to its
// full depth — the same tile as a chunk, but all CK of them stacked.
//
// Two reasons it is that and not something else. The generator's expensive work
// (rock and soil, caves, ore) is per *column* and runs the whole column at once,
// so splitting a region radially would buy nothing and cost a second pass over
// the same noise. And a mesh request always names a chunk, so a region that is
// exactly a chunk's footprint means "generate what this request needs" is a
// lookup rather than a search — a batch of chunk ids maps onto a set of region
// ids by dropping the ck.
//
// 5 046 of them at 16 896 voxels each. Small enough that one is a few
// milliseconds of work, large enough that the per-region bookkeeping and the
// generation margins are not most of the cost.
export const NUM_REGIONS = FACES * CT * CT;       // 5 046
export const REGION_COLS = CHUNK_T * CHUNK_T;     // 256
export const REGION_VOXELS = REGION_COLS * D;     // 16 896

export const regionIdx = (f, ri, rj) => ((f * CT + ri) * CT + rj);

/** Which region owns a column. */
export function regionOfCol(col) {
  const f = (col / (F * F)) | 0;
  const rem = col - f * F * F;
  const i = (rem / F) | 0;
  return ((f * CT + ((i / CHUNK_T) | 0)) * CT + (((rem % F) / CHUNK_T) | 0));
}

/** The 256 column indices a region owns, ascending. */
export function regionColumns(rid, out = new Int32Array(REGION_COLS)) {
  const rj = rid % CT;
  const t = (rid - rj) / CT;
  const ri = t % CT;
  const f = (t - ri) / CT;
  let n = 0;
  for (let i = ri * CHUNK_T; i < ri * CHUNK_T + CHUNK_T; i++) {
    for (let j = rj * CHUNK_T; j < rj * CHUNK_T + CHUNK_T; j++) out[n++] = cidx(f, i, j);
  }
  return out;
}

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
 */
export const GEN_VERSION = 1;

// All five keep their distance from R_MIN, so the crust reads the same from
// below: core three layers up, mantle eight. What changed is the room above
// them — sea level sits 40 layers over layer 0 instead of 30, and the terrain
// ceiling 24 over the waterline instead of 12.
export const R_CORE = 253;           // unbreakable core shell
export const R_MANTLE = 258;
export const R_SEA = 290;            // ocean surface radius
export const R_SURFACE = 290.9;      // mean land radius
export const R_TERRAIN_MAX = 314;

/**
 * How far down the two subtractive surface passes are allowed to reach.
 *
 * Everything has to share the crust. Sea level is layer 40 and the mantle
 * starts at layer 8, so an ocean basin and a canyon are competing for the same
 * thirty-two layers, and whatever is left under them is all the rock a cave, an
 * ore vein or a deep structure has to live in.
 *
 * R_SEABED_MIN buys a 25-block ocean — comfortably past losing sight of the
 * surface — while still leaving seven layers of crust over the mantle, which is
 * more than the cave pass's own floor at R_MANTLE + 1.5 needs. That seven-layer
 * margin is what the number is actually pinned to, not the depth; the extra
 * ocean is what the thicker shell bought.
 *
 * R_CANYON_MIN is one higher on purpose. A canyon floor is walkable ground with
 * soil laid on it and things spawning on it, so it wants to stay above the
 * pre-mantle band where the rock starts glowing: a gorge whose floor was cut
 * into magma stone would read as a rift, not as a canyon.
 */
export const R_SEABED_MIN = 265;
export const R_CANYON_MIN = 266;

export const GRAVITY = 26;

// Biome ids
export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, PINE_FOREST: 4,
  DESERT: 5, SAVANNA: 6, TUNDRA: 7, SNOW: 8, MOUNTAIN: 9, MEADOW: 10, BADLANDS: 11,
};

/** grass tint, foliage tint, water tint */
export const BIOME_COLORS = [
  { grass: [0.32, 0.55, 0.42], foliage: [0.30, 0.52, 0.38], water: [0.16, 0.42, 0.62] },
  { grass: [0.72, 0.74, 0.52], foliage: [0.55, 0.68, 0.40], water: [0.22, 0.55, 0.70] },
  { grass: [0.55, 0.78, 0.40], foliage: [0.45, 0.70, 0.34], water: [0.20, 0.50, 0.68] },
  { grass: [0.42, 0.70, 0.34], foliage: [0.34, 0.60, 0.28], water: [0.18, 0.46, 0.60] },
  { grass: [0.38, 0.60, 0.38], foliage: [0.26, 0.48, 0.32], water: [0.16, 0.42, 0.56] },
  { grass: [0.80, 0.74, 0.42], foliage: [0.68, 0.66, 0.36], water: [0.26, 0.60, 0.72] },
  { grass: [0.74, 0.76, 0.38], foliage: [0.62, 0.66, 0.32], water: [0.24, 0.56, 0.68] },
  { grass: [0.60, 0.68, 0.56], foliage: [0.48, 0.60, 0.48], water: [0.28, 0.54, 0.68] },
  { grass: [0.70, 0.80, 0.78], foliage: [0.56, 0.70, 0.66], water: [0.36, 0.62, 0.76] },
  { grass: [0.48, 0.62, 0.44], foliage: [0.38, 0.54, 0.36], water: [0.24, 0.52, 0.68] },
  { grass: [0.62, 0.84, 0.46], foliage: [0.50, 0.76, 0.38], water: [0.22, 0.54, 0.72] },
  { grass: [0.76, 0.60, 0.36], foliage: [0.66, 0.54, 0.30], water: [0.30, 0.50, 0.56] },
];
