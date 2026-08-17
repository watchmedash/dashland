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
// Cube planet. F is 2*PLANET_R so a face column maps 1:1 onto a block, and is
// a multiple of CHUNK_T. See Cube.js.
export const F = 416;                // cells per face axis
/*
 * 66 -> 99. Mountains, which the planet did not have room for.
 *
 * The ceiling was R_TERRAIN_MAX 314 against a waterline of 290: twenty-four
 * blocks of relief, about eleven player-heights for the tallest thing on the
 * planet. That is a hill, and no amount of tuning the noise makes it a
 * mountain — the roof was the limit, not the generator.
 *
 * Widening the sphere does not help and is the intuitive wrong answer: F is
 * the horizontal cell count, so 5x F is the same twenty-four-block hills
 * further apart, at five times the memory. Height lives here.
 *
 * Still a multiple of CHUNK_K = 11, because CK below divides by it and a
 * fractional chunk count would silently lose the top of the world.
 *
 * The bill, and it is not small: every per-voxel array grows by half. Blocks
 * are one byte each and exist twice (the main thread's mirror and the worker's
 * authority), and the light field is four more — sun, r, g, b. At 66 that was
 * about 510 MB; at 99 it is about 770.
 */
// Cube: k is depth along a face normal, not a radius. R_MIN is the normal
// coordinate of layer 0 and every offset from it is unchanged, so all the
// k-space arithmetic downstream still reads the same.
export const D = 88;                 // layers along the face normal
export const R_MIN = 175;            // normal coordinate of layer 0
export const R_MAX = R_MIN + D;      // 263

/** Half-size of the planet: the sea-level face plane sits here. */
export const PLANET_R = 208;
/** Half-size of the storage array. Must cover R_MAX. */
export const ARR_R = 264;
export const SIDE = ARR_R * 2;               // 528
export const CELLS = SIDE * SIDE * SIDE;     // 147 197 952

export const COLUMNS = FACES * F * F;        // 1 038 336
export const NUM_VOXELS = COLUMNS * D;       // 91 373 568

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

/** Face and region grid coordinates to a region id. `regionColumns` inverts it. */
export const regionIdx = (f, ri, rj) => ((f * CT + ri) * CT + rj);

/** Which region owns a column. */
export function regionOfCol(col) {
  const f = (col / (F * F)) | 0;
  const rem = col - f * F * F;
  const i = (rem / F) | 0;
  // Through `regionIdx` rather than repeating its arithmetic: the packing had
  // been written out twice, and two copies of an index formula are two things
  // to keep in step for no gain.
  return regionIdx(f, (i / CHUNK_T) | 0, ((rem % F) / CHUNK_T) | 0);
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
/*
 * 3: aquifers and hot springs.
 *
 * Both write voxels no previous generator wrote. The aquifer pass puts water —
 * and the stone shell that keeps it in — into the limestone band of every
 * column whose lens field clears its threshold, which also re-seals cave cells
 * the carve pass had opened there. The hot spring pass digs a pool into the
 * surface of a handful of snow, tundra and mountain columns. A save made
 * against version 2 has neither, and regenerating its unvisited regions with
 * this generator would leave visited ground riddled with sealed cavities its
 * neighbours do not have.
 */
/*
 * 4: the forage pass, and a coarser cactus lattice.
 *
 * Five new species are scattered by `landFloraAt` and one by `caveFloraAt` -
 * prickly pear and agave in the desert, stonecrop on mountain scree, icecap
 * moss in the snow and tundra, truffle on the shallow cave floor - along with
 * five orchard trees and the lingonberry, which now also takes MOUNTAIN. All of
 * them write a voxel no previous generator wrote.
 *
 * The cactus lattice changed with them, and that one moves ground a version 3
 * save already has: cacti were drawn on a checkerboard, `(i + j) & 1`, and are
 * now drawn on every second column of BOTH axes so no two can touch even at a
 * corner. The roll doubled to 0.138 to hold the count. A desert regenerated by
 * this generator therefore has its cacti in different columns from the one that
 * made the save, which is exactly the "visited valley in terrain that no longer
 * joins up with it" this stamp exists to prevent.
 *
 * Bumping refuses an older save rather than damaging it: `_saveFitsWorld`
 * returns OLD and the file is left untouched on disk.
 *
 * ---
 *
 * **5, on 2026-08-13.** Three changes to what the generator writes, landed the
 * same day, and each one is independently sufficient.
 *
 * The pine cone was standing on its point. `stampTree` read its taper from the
 * wrong end - `t` was 0 at the treetop while `l` counts downward - so the
 * widest ring landed at the crown and the narrowest at the skirt. Measured over
 * 1,500 pines on seed 4242, mean leaves at `top` went 50.8 to 12.1 and at
 * `top - 4` went 21.7 to 36.0, and a tree now carries about 20% fewer leaf
 * cells. Every conifer on the planet is a different shape.
 *
 * Quicksand and powder snow are two new block ids the generator scatters:
 * 3.8-4.6% of desert columns and 5.5-5.9% of snowfield columns across three
 * seeds. An old save opened on this build would have hazards in the regions it
 * has never visited and none in the regions it has, with the seam on a region
 * boundary - which is exactly the failure this stamp exists to prevent, and it
 * is the same argument the cactus lattice made for 4.
 *
 * Two things that did NOT contribute, recorded so the next reader does not go
 * looking for them: the tornado writes nothing into worldgen (every block it
 * moves is a runtime edit through `_applyEdits`, indistinguishable from mining
 * a flower), and whirlpools are a pure function of seed and column evaluated on
 * the main thread, so the generator writes not one byte differently for them.
 *
 * ---
 *
 * **A third thing that did not contribute, and it is the interesting one: the
 * deathcap.** It is a new block id the generator scatters — 1.6% of forest and
 * 1.4% of pine-forest columns — which is word for word the argument the
 * quicksand and the powder snow made two paragraphs above, and it is
 * nonetheless not a bump. The difference is *what kind of cell is written*.
 *
 * Quicksand and powder snow replace ground. A pool is dug into a dune and a
 * drift is sunk into a snowfield, so a version-5 save regenerating an unvisited
 * desert gets terrain its visited desert does not have, with the discontinuity
 * on a region boundary — you can walk to the seam and see one side is holed and
 * the other is not. The cactus lattice that forced 4 is the same complaint
 * again: blocks that already existed are somewhere else now.
 *
 * `landFloraAt` cannot do that. It writes exactly one cell, `k + 1`, the air
 * above a surface it does not touch, and only where that surface is already the
 * soil the plant's rule names. Every column keeps its height, its caves, its
 * ores, its lakes and its trees. So the worst a stale save can produce is that
 * one species of mushroom is present in the regions generated after this build
 * and absent in the regions generated before it — which is indistinguishable
 * from the biome noise that already decides whether any given wood has ferns in
 * it, and is invisible to a player who has no way to know which regions were
 * streamed on which day.
 *
 * Set against that, a bump refuses every planet made since be4a0b0 landed this
 * morning. Refusing a save is the correct trade when the alternative is a
 * broken world; it is the wrong trade when the alternative is a slightly
 * patchier distribution of a mushroom. **The rule this records for the next
 * flora species: a pass that only decorates the surface does not bump. A pass
 * that moves, carves or replaces ground always does.**
 */
export const GEN_VERSION = 9;

// All five keep their distance from R_MIN, so the crust reads the same from
// below: core three layers up, mantle eight. What changed is the room above
// them — sea level sits 40 layers over layer 0 instead of 30, and the terrain
// ceiling 24 over the waterline instead of 12.
export const R_CORE = 178;           // unbreakable core shell
export const R_MANTLE = 183;
/*
 * The waterline drops eight layers as well, and that part is free.
 *
 * Every block of it is a block of relief that costs no memory at all: the
 * terrain ceiling is measured from here, so lowering the sea raises the
 * mountains without touching D. Eight rather than the twelve first considered,
 * because the crust between the mantle and the waterline is where the caves and
 * the ore live — that band goes from 32 layers to 24, and taking twelve would
 * have left twenty, which starts to squeeze the deep ore against the mantle.
 */
export const R_SEA = 208;            // ocean surface radius
export const R_SURFACE = 208.9;      // mean land radius
/*
 * Two below R_MAX (349), because a clamp that bites is a plateau where a peak
 * should be. Against the new waterline this is 65 blocks of relief where there
 * were 24.
 */
export const R_TERRAIN_MAX = 261;

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
export const R_SEABED_MIN = 190;
export const R_CANYON_MIN = 191;

export const GRAVITY = 26;

// Biome ids
export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, PINE_FOREST: 4,
  DESERT: 5, SAVANNA: 6, TUNDRA: 7, SNOW: 8, MOUNTAIN: 9, MEADOW: 10, BADLANDS: 11,
  CINDER: 12,
};

/**
 * What each face of the cube is for.
 *
 * A face is the natural unit for this: it is a flat, bounded, self-contained
 * world with its own gravity, and the seams already stop weather, trees and
 * wildlife crossing. So instead of scattering every biome over all six sides,
 * two of them are given a job. The owner: "dedicate snowfield/pole only to a
 * single face ... and one face like nether for basalt, lava etc."
 *
 *   +Y  the cap: snow and tundra, and nothing else grows there
 *   -Y  the cinderlands: basalt, ash and lava where the sea would be
 *   the four sides  the ordinary world, and the only place you spawn
 *
 * Ice above, fire below, temperate around the middle.
 */
export const FACE_NORMAL = 0;
export const FACE_POLAR = 1;
export const FACE_CINDER = 2;
/** Indexed by face: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_ROLE = [
  FACE_NORMAL, FACE_NORMAL, FACE_POLAR, FACE_CINDER, FACE_NORMAL, FACE_NORMAL,
];

/**
 * What each face is called, same index order.
 *
 * Rime and Pyre are the two dedicated faces and are one syllable each because
 * each is nothing but its element. The other four are a day, and they are in
 * RING ORDER on purpose: walking +X -> +Z -> -X -> -Z is walking Aurora ->
 * Zenith -> Vesper -> Umbra, so the name tells you which way round the planet
 * you are going and which face comes next. That is the whole reason for the
 * set, so a swapped name has to keep its place in the day.
 */
export const FACE_NAME = ['Aurora', 'Vesper', 'Rime', 'Pyre', 'Zenith', 'Umbra'];

/**
 * What each face does to the body walking on it, indexed by FACE_ROLE.
 *
 * This is section 6e of CUBE-PLANET.md - per-face physics - and it is what
 * gives the two dedicated faces a reason to exist beyond scenery. Each is a
 * trade rather than a penalty, so going there is a decision:
 *
 *   the cap      heavy going, but you last. Half again as slow, and stamina
 *                drains at two thirds, so it is the face you cross on foot
 *                when you have a long way to go and nothing chasing you.
 *   cinderlands  light and quick to tire. The low gravity lets you clear twice
 *                the height, which is how you get over lava, and stamina burns
 *                half again as fast, which is the clock on being there.
 *
 * `jump` is a multiplier on HEIGHT, not on the impulse - height goes with the
 * square of take-off speed, so doubling it is a factor of sqrt(2) on the
 * velocity. Doubling the impulse instead would have quadrupled the height.
 */
export const FACE_PHYSICS = [
  { speed: 1, jump: 1, staminaDrain: 1, fog: 1 },
  // The cap gets weather as well as physics: a snowfield is a whiteout, and it
  // is the one place where not being able to see far is the character of the
  // ground rather than a limitation of it.
  { speed: 1 / 1.5, jump: 1, staminaDrain: 1 / 1.5, fog: 2.1 },
  // The cinderlands are hazier than ordinary air but not blinding - heat and
  // ash, and you need to see the lava coming.
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
  // Tundra, and the same complaint as the snow row below it. Tundra ground is
  // drifts of snow over frost-heaved gravel — measured, 37% of its surface
  // columns are the snow block — so a player standing in one is standing in a
  // snow biome whatever the biome table calls it, and its conifers were coming
  // out at [0.43, 0.59, 0.45] after the needle multiplier: an ordinary summer
  // green. Pulled cold and desaturated so the product lands at
  // [0.38, 0.53, 0.50], which is short of the snow row's blue-grey and well
  // clear of the pine forest's [0.31, 0.59, 0.26]. The grass term is left
  // alone: tundra grows no grass block for it to tint.
  { grass: [0.60, 0.68, 0.56], foliage: [0.42, 0.54, 0.54], water: [0.28, 0.54, 0.68] },
  // Snow. The foliage term is a *multiplier* on an already green needle tile, so
  // a pale green multiplier still leaves a green tree: "trees growing in snow
  // biomes looks green af" was this row. Green pulled well under red and blue so
  // the product lands cold and desaturated rather than merely lighter, which is
  // what a conifer under snow reads as.
  { grass: [0.70, 0.80, 0.78], foliage: [0.52, 0.58, 0.62], water: [0.36, 0.62, 0.76] },
  { grass: [0.48, 0.62, 0.44], foliage: [0.38, 0.54, 0.36], water: [0.24, 0.52, 0.68] },
  { grass: [0.62, 0.84, 0.46], foliage: [0.50, 0.76, 0.38], water: [0.22, 0.54, 0.72] },
  { grass: [0.76, 0.60, 0.36], foliage: [0.66, 0.54, 0.30], water: [0.30, 0.50, 0.56] },
  // Cinderlands. The grass and foliage rows exist only because the tint is
  // applied by index and nothing green grows here; they are dark so that
  // anything carried in and planted reads as out of place rather than lush.
  // The water row is what a lava sea takes.
  { grass: [0.34, 0.24, 0.22], foliage: [0.30, 0.20, 0.18], water: [0.90, 0.34, 0.10] },
];
