// Cubesphere planet generator. Terrain is built per radial column, so the
// surface is a true height field over the sphere — every block sits upright.

import { Noise, makeRng, hash3, clamp, lerp, smoothstep } from '../util/Noise.js';
import {
  F, D, FACES, R_MIN, R_MAX, R_CORE, R_MANTLE, R_SEA, R_SURFACE, R_TERRAIN_MAX,
  R_SEABED_MIN, R_CANYON_MIN,
  COLUMNS, NUM_VOXELS, vidx, cidx, BIOME, regionOfCol,
} from './Constants.js';
import {
  centerDir, colNeighbor, colParts, patchColumn, dirToFace, axisToGrid,
} from './Sphere.js';
import { ID, N_BLOCKS } from './Blocks.js';
import { placeStructures } from './Structures.js';

/**
 * Rock a cave is allowed to eat through, and rock a vein is allowed to replace.
 *
 * Both passes used to test `=== ID.stone`. The moment the crust became eleven
 * different rocks that test stopped matching anything below the limestone band,
 * so caves and ore both stopped at about a third of the way down and the whole
 * deep planet came out solid and empty. Anything laid by `stratum` has to be
 * listed here or it is inert.
 *
 * The two sets differ by the glowing pockets: a cave may open into magma stone
 * or a geode, but a vein may not overwrite one — those are the landmarks that
 * tell a player how deep they are, and burying them under coal wastes them.
 */
/**
 * Where one rock stops and the next begins, as a fraction of the crust.
 *
 * The crust is R_MANTLE up to R_SEA — everything above the waterline shares the
 * topmost band, which is what the old absolute thresholds did too. The four
 * fractions are the old edges (126, 120, 114, 110.5) re-expressed against the
 * old crust of 108..130, so the proportions of every stratum are preserved
 * exactly while the thicknesses grow with the shell.
 */
const CRUST = R_SEA - R_MANTLE;
/**
 * A radius from the old 108-mantle/130-sea crust, placed in the current one.
 *
 * The ore ladder was tuned by hand against those numbers over a long time, and
 * the depths are meaningful relative to each other — the deep seam sits under
 * the shallow one, gold under silver, moss just below the surface. Rescaling
 * them all through one function keeps every one of those relationships exactly
 * as it was tuned, which re-deriving each band by eye would not.
 */
const band = (r108) => R_MANTLE + (r108 - 108) * (CRUST / 22);

/**
 * Two-octave fbm against a threshold, with an exact early-out.
 *
 * The ore pass is the single most expensive thing worldgen does, and almost all
 * of that work is thrown away: a vein threshold sits at 0.52–0.66, so the
 * overwhelming majority of voxels evaluate the whole thing only to fall short.
 *
 * A two-octave fbm at gain 0.5 is `(s1 + 0.5 * s2) / 1.5`, and simplex output
 * cannot exceed 1 — so once the first octave is known, the largest value the
 * second could possibly produce is `(s1 + 0.5) / 1.5`. If that is already under
 * the threshold, the second octave cannot change the answer and is not worth
 * computing. This is a bound, not an approximation: the ore that generates is
 * bit-for-bit the ore that generated before.
 *
 * @returns the fbm value, or -1 when it provably cannot reach `thr`.
 */
function veinNoise(no, x, y, z, thr) {
  const s1 = no.simplex3(x, y, z);
  if (s1 + 0.5 <= thr * 1.5) return -1;
  // Exactly what `fbm3(x, y, z, 2, 2, 0.5)` does with its second octave: the
  // caller's coordinates, times the lacunarity. Deriving them any other way
  // risks a different float and therefore a different planet.
  return (s1 + 0.5 * no.simplex3(x * 2, y * 2, z * 2)) / 1.5;
}
const BAND_STONE = R_MANTLE + CRUST * 0.818;      // was 126
const BAND_LIMESTONE = R_MANTLE + CRUST * 0.545;  // was 120
const BAND_GRANITE = R_MANTLE + CRUST * 0.273;    // was 114
const BAND_SLATE = R_MANTLE + CRUST * 0.114;      // was 110.5

const CARVEABLE = new Uint8Array(N_BLOCKS);
const ORE_HOST = new Uint8Array(N_BLOCKS);
const STRATA = ['stone', 'limestone', 'marble', 'granite', 'andesite', 'slate', 'tuff', 'azurite'];
for (const n of STRATA) { CARVEABLE[ID[n]] = 1; ORE_HOST[ID[n]] = 1; }
for (const n of ['dirt', 'sandstone', 'red_sandstone', 'coarse_dirt', 'peat', 'mud',
  'magma_stone', 'geode_stone', 'crystal_stone', 'ash_stone']) CARVEABLE[ID[n]] = 1;

/**
 * How many columns inland the sand reaches from the water's edge. The coastline
 * on this planet is very long — low ground is flattened toward sea level, which
 * frays the shore into a fractal — so each extra column of reach costs several
 * percent of the whole surface. One is a shore; two already reads as a desert.
 */
const BEACH_REACH = 1;

/**
 * The ocean's depth profile, in blocks below sea level, as a function of how
 * many columns a cell sits from the nearest land.
 *
 * The sea used to bottom out at six blocks and sit at one for half its area,
 * because the height field flattens everything within three units of sea level
 * toward R_SEA - 0.4 — the same line that stops the coast fraying into a
 * fractal also drowns the basins. Deepening the *noise* to compensate was tried
 * and it does not work: the flattening runs afterwards and eats it, and turning
 * the flattening down brings back a shoreline with a thousand islands in it.
 *
 * So depth is imposed after the fact, from distance offshore rather than from
 * altitude. That is what makes a shelf possible at all — an altitude rule
 * cannot tell "one block under water beside a beach" from "one block under
 * water two hundred columns out", and those want opposite treatment.
 *
 * Three regimes, and the first one is the load-bearing one: the shelf keeps the
 * first three columns under 2.5 blocks so a beach is still something you wade
 * into rather than a ledge you fall off. The slope is deliberately steep, near
 * 45 degrees — you swim down it, you do not walk it, and a gentle one would eat
 * the entire width of every small sea before reaching any depth worth diving.
 */
const SHELF_COLS = 3;          // wadeable, 0.8 blocks per column
const SLOPE_COLS = 11;         // continental slope, 0.95 blocks per column
const OCEAN_MAX_DEPTH = R_SEA - R_SEABED_MIN;   // 15

function oceanDepthAt(d) {
  if (d <= SHELF_COLS) return d * 0.8;
  const shelf = SHELF_COLS * 0.8;
  if (d <= SHELF_COLS + SLOPE_COLS) return shelf + (d - SHELF_COLS) * 0.95;
  return shelf + SLOPE_COLS * 0.95 + (d - SHELF_COLS - SLOPE_COLS) * 0.18;
}

/**
 * Canyon sizing, in columns and blocks. A cell is about 0.92 units across and a
 * great circle is roughly 823 columns, so these are all fractions of a planet
 * rather than fractions of a continent.
 *
 * Length 130-220 columns is a quarter of the way round the planet at most: far
 * enough that walking one end to the other is a trip with a middle to it, short
 * enough that it is a place rather than a feature of the globe. Anything Earth
 * would call a canyon — the Grand Canyon is 446 km, six times the circumference
 * of this planet — is not a size this world has.
 *
 * Depth 10-18 blocks against a total planetary relief of 18 is the point. The
 * highest ground is only eighteen blocks above the lowest, so the only way to
 * get somewhere with real vertical scale is to cut down rather than build up,
 * and a canyon is the one landform that can do that without a mountain range.
 * At 18 deep the rim is out of jump reach from the floor and the strata bands
 * the crust already has — limestone at 120, granite at 114 — come out in the
 * wall as visible courses.
 *
 * Width 4-11 columns at the rim. Narrower than the depth almost everywhere, so
 * the thing reads as a slot you are down inside rather than as a valley.
 */
const CANYON_COUNT = 6;
const CANYON_MAX_DEPTH = 20;
const CANYON_BENCH = 3;        // wall terrace height, in blocks

/**
 * How far the canyon's influence on vegetation reaches, and how hard it bites.
 *
 * Index by `canyonNear` — 0 inside the gorge, 1..3 columns out from it, 4 for
 * everything else — and multiply the biome's tree chance by what comes back.
 *
 * Zero at the rim itself is deliberate and it is the entry that actually does
 * the work: a canopy is up to four columns across, so a tree standing *on* the
 * lip hangs most of itself over the drop. One at each index further out gets
 * the forest back to full density within four columns, which reads as the wood
 * thinning toward a clearing rather than as a circle cut out of it.
 *
 * Nothing here stops undergrowth. A gorge floor with tufts of grass and the odd
 * flower on it still reads as a gorge; a gorge with a roof on it does not.
 */
const CANYON_NEAR_MAX = 4;
const CANYON_TREE_THIN = [0, 0, 0.35, 0.65, 1];

/**
 * Ore bands, deepest and rarest first. The loop takes the first vein that
 * claims a cell and stops, so listing a common shallow ore above a rare deep
 * one would starve the deep one wherever their bands touch.
 *
 * Two of the old entries were dead. `gold_ore` ran lo 108 hi 30 and
 * `crystal_ore` lo 108 hi 26 — the radii are 100..144, so `hi` was below
 * `lo` and both tests were unreachable for every voxel on the planet. Gold
 * and crystal did not generate at all.
 *
 * The ladder the bands describe, from the surface down:
 *   131-142  coal, copper                     stone
 *   124-131  coal, copper, iron               stone / limestone
 *   116-124  iron, silver, gold, moss         limestone / andesite
 *   112-116  amethyst, crystal, sulfur        andesite / granite / tuff
 *   108-116  the deep seam, in slate          slate / azurite
 *   108-112  emerald, sapphire, ruby, void    slate
 */
const ORES = [
  { id: ID.voidstone_ore, scale: 0.62, thr: 0.60, lo: R_MANTLE, hi: band(111), seed: 907 },
  { id: ID.ruby_ore, scale: 0.50, thr: 0.58, lo: R_MANTLE, hi: band(112.5), seed: 719 },
  { id: ID.sapphire_ore, scale: 0.50, thr: 0.58, lo: R_MANTLE, hi: band(113), seed: 733 },
  { id: ID.emerald_ore, scale: 0.48, thr: 0.57, lo: R_MANTLE, hi: band(114), seed: 641 },
  { id: ID.deep_crystal_ore, scale: 0.46, thr: 0.60, lo: R_MANTLE, hi: band(113), seed: 811 },
  { id: ID.deep_gold_ore, scale: 0.38, thr: 0.58, lo: R_MANTLE, hi: band(114), seed: 557 },
  { id: ID.deep_silver_ore, scale: 0.36, thr: 0.57, lo: R_MANTLE, hi: band(113.5), seed: 463 },
  { id: ID.deep_iron_ore, scale: 0.30, thr: 0.55, lo: R_MANTLE, hi: band(116), seed: 389 },
  { id: ID.deep_copper_ore, scale: 0.28, thr: 0.55, lo: R_MANTLE, hi: band(115), seed: 293 },
  { id: ID.deep_coal_ore, scale: 0.24, thr: 0.53, lo: R_MANTLE, hi: band(116), seed: 197 },

  { id: ID.sulfur_ore, scale: 0.34, thr: 0.57, lo: R_MANTLE, hi: band(118), seed: 101 },
  { id: ID.amethyst_ore, scale: 0.42, thr: 0.60, lo: R_MANTLE + 2, hi: band(120), seed: 149 },
  { id: ID.crystal_ore, scale: 0.40, thr: 0.62, lo: band(112), hi: band(121), seed: 219 },
  { id: ID.gold_ore, scale: 0.34, thr: 0.60, lo: band(114), hi: band(125), seed: 143 },
  { id: ID.silver_ore, scale: 0.32, thr: 0.58, lo: band(113), hi: band(124), seed: 89 },
  { id: ID.iron_ore, scale: 0.26, thr: 0.56, lo: band(116), hi: R_SURFACE - 2, seed: 71 },
  { id: ID.copper_ore, scale: 0.24, thr: 0.55, lo: band(120), hi: R_TERRAIN_MAX, seed: 37 },
  { id: ID.coal_ore, scale: 0.20, thr: 0.52, lo: band(118), hi: R_TERRAIN_MAX, seed: 0 },

  { id: ID.gravel, scale: 0.14, thr: 0.58, lo: R_MANTLE + 4, hi: R_TERRAIN_MAX, seed: 311 },
  // Clay and moss keep the bands they always had — clay's `lo` was 32, i.e.
  // below the innermost radius, so it has always meant "everywhere the host
  // rock reaches". Narrowing it here would quietly halve the brick supply.
  { id: ID.clay, scale: 0.22, thr: 0.62, lo: R_MANTLE, hi: R_SEA, seed: 407 },
  { id: ID.moss_stone, scale: 0.18, thr: 0.60, lo: R_MANTLE, hi: R_SURFACE, seed: 503 },
  // Moss is the only way to get a soft green block underground, and it is
  // shallow on purpose: it belongs to the cave mouth, not to the deep.
  { id: ID.moss_block, scale: 0.20, thr: 0.66, lo: band(124), hi: R_SURFACE, seed: 601 },
];

/**
 * Which ores can possibly appear at each layer, worked out once.
 *
 * A band test is `r < o.lo || r > o.hi`, and `r` is a function of `k` alone —
 * so the answer is the same for every one of the 1.3M columns and was being
 * recomputed for all of them. This is by far the most expensive thing worldgen
 * does, so the 22 comparisons per voxel it removes are worth having, and more
 * usefully the bucket is *short*: the deep layers carry ten candidates and the
 * bulk of the crust six or seven, rather than the whole table every time.
 *
 * Module scope rather than a field, now that the pass runs a column at a time:
 * rebuilding it per region would be 66 filters for 256 columns of work.
 */
const ORE_BY_LAYER = [];
for (let k = 0; k < D; k++) {
  const r = R_MIN + k + 0.5;
  ORE_BY_LAYER.push(ORES.filter((o) => r >= o.lo && r <= o.hi));
}

/** Shared scratch for the per-column passes — they are called a million times. */
const _fillDir = [0, 0, 0];

/**
 * Volcano geometry. Module scope rather than locals now that choosing a site
 * and building it are two different passes run at two different times, and both
 * have to agree about how big the thing is — the region bookkeeping in the
 * worker needs APRON too, to know which regions a site will eventually write.
 */
export const APRON = 20;   // columns of scorched ground
const CONE = 11;           // columns of raised cone
const CONE_H = 6;          // blocks at the summit
const VENT = 4;            // columns of crater
const VOLCANO_TARGET = 4;

/**
 * How far outside a region its decoration pass has to look. A pine's canopy is
 * radius 3.0 plus up to 0.45 of fraying and one column of rounding; a boulder
 * reaches 2. Six is that with room to spare, and being generous here is cheap —
 * it costs a wider overlap, and getting it wrong costs a visible seam.
 */
export const DECOR_MARGIN = 6;

// Scratch for dirToColumn — this is called a million times in the canyon walk.
const _dtf = { f: 0, a: 0, b: 0 };
const _dtc = { f: 0, i: 0, j: 0, col: 0 };

/** World direction → the column containing it. */
function dirToColumn(x, y, z, out = _dtc) {
  dirToFace(x, y, z, _dtf);
  const i = Math.min(F - 1, Math.max(0, Math.floor(axisToGrid(_dtf.a))));
  const j = Math.min(F - 1, Math.max(0, Math.floor(axisToGrid(_dtf.b))));
  out.f = _dtf.f; out.i = i; out.j = j;
  out.col = cidx(_dtf.f, i, j);
  return out;
}

export class WorldGen {
  constructor(seed = 20260805) {
    this.seed = seed;
    this.n = new Noise(seed);
    this.nWarp = new Noise(seed + 101);
    this.nCave = new Noise(seed + 202);
    this.nOre = new Noise(seed + 303);
    this.nBiome = new Noise(seed + 404);
    this.nDetail = new Noise(seed + 505);
  }

  height(dx, dy, dz) {
    const w = this.nWarp;
    const wx = w.simplex3(dx * 2.1, dy * 2.1, dz * 2.1) * 0.16;
    const wy = w.simplex3(dx * 2.1 + 31.4, dy * 2.1, dz * 2.1) * 0.16;
    const wz = w.simplex3(dx * 2.1, dy * 2.1 + 17.7, dz * 2.1) * 0.16;
    const x = dx + wx, y = dy + wy, z = dz + wz;

    const continent = this.n.fbm3(x * 1.25, y * 1.25, z * 1.25, 4, 2, 0.55);
    const land = smoothstep(-0.10, 0.20, continent);
    // broad ridges rather than needles — high-frequency ridged noise on a
    // sphere this small turns into single-column spikes
    const ridge = this.n.ridged3(x * 1.9, y * 1.9, z * 1.9, 4, 2.0, 0.5);
    const peaks = Math.pow(clamp(ridge * 1.15 - 0.14, 0, 1), 1.8);
    const hills = this.nDetail.fbm3(x * 3.2, y * 3.2, z * 3.2, 4, 2, 0.5);
    const detail = this.nDetail.fbm3(x * 8, y * 8, z * 8, 3, 2, 0.5);
    const mask = smoothstep(0.25, 0.75, this.n.fbm3(x * 1.9 + 9.1, y * 1.9, z * 1.9, 3, 2, 0.5) * 0.5 + 0.5);

    // Amplitudes in blocks, and the third time they have been let out to meet a
    // roof that moved. The relief available over the waterline was 12, then 24,
    // and is now 65 — D went to 99 and the sea came down eight — so a ceiling
    // that was the binding constraint on every summit is no longer the thing
    // deciding what a mountain looks like.
    //
    // Peaks take most of it, as before and for the same reason: it is the
    // ridged term and the only one that makes a summit. Putting the increase
    // into `continent` instead lifts whole landmasses uniformly, which from the
    // ground reads as nothing at all. `hills` goes up too, so the land between
    // the summits stops being a plain.
    //
    // The basin term is deepened as well. With the waterline eight lower the
    // sea would otherwise have become a puddle over the old floor; -5 puts the
    // deepest ocean at about 266, comfortably clear of the mantle at 258, and
    // keeps enough water column for the deep-water fish that need eight layers.
    //
    // The sum still has to clear R_TERRAIN_MAX with room: at the extreme this
    // is R_SURFACE + 12 + 46 + 3 = 343.9 against a clamp of 347, and a clamp
    // that bites is a plateau where a peak should be.
    let h = R_SURFACE;
    h += continent * 12.0;
    h += Math.min(0, continent) * 5.0;              // carve real ocean basins
    h += land * peaks * 46.0 * (0.35 + mask * 0.65);
    h += land * hills * 3.0;
    h += detail * 0.18;
    if (h < R_SEA + 1.2 && h > R_SEA - 3) h = lerp(h, R_SEA - 0.4, 0.4);
    return clamp(h, R_MIN + 6, R_TERRAIN_MAX);
  }

  /**
   * Which rock sits at radius `r` under a given direction.
   *
   * The band edges are fractions of the crust — the mantle to the waterline —
   * and not the absolute radii they used to be. Those were written when sea
   * level was 130 and the mantle 108, and they said so nowhere: enlarging the
   * planet moved every radius past all four thresholds at once, so the entire
   * crust came out as the topmost band and the strata simply vanished. A
   * fraction survives the next enlargement too.
   *
   * Bands are ordered by depth and their edges are pushed around by a
   * low-frequency field, so the limestone/andesite line crosses one shaft
   * several blocks deeper than the next; perfectly concentric shells read as
   * a layer cake the moment two shafts are dug side by side.
   *
   * A second, higher-frequency sample picks pockets inside each band. It is a
   * single-octave simplex rather than another fbm because this runs once per
   * crust voxel — roughly three million of them — and the pockets only need to
   * be blobs, not landforms.
   */
  stratum(r, dx, dy, dz) {
    const px = dx * r, py = dy * r, pz = dz * r;
    const rr = r + this.nDetail.fbm3(px * 0.045, py * 0.045, pz * 0.045, 2, 2, 0.5) * 3.4;
    const p = this.nOre.simplex3(px * 0.13 + 3.7, py * 0.13, pz * 0.13);
    if (rr >= BAND_STONE) return p > 0.52 ? ID.andesite : ID.stone;
    if (rr >= BAND_LIMESTONE) return p > 0.50 ? ID.marble : ID.limestone;
    if (rr >= BAND_GRANITE) return p > 0.48 ? ID.granite : (p < -0.50 ? ID.tuff : ID.andesite);
    if (rr >= BAND_SLATE) return p > 0.54 ? ID.azurite : (p < -0.62 ? ID.geode_stone : ID.slate);
    // The last two blocks before the mantle. Magma stone and crystalline rock
    // both emit, so this band is the only lit stratum — reaching it should look
    // like arriving somewhere rather than like more of the same grey.
    return p > 0.30 ? ID.magma_stone : (p < -0.46 ? ID.crystal_stone : ID.slate);
  }

  climate(dx, dy, dz, h) {
    const lat = Math.abs(dy);
    let temp = 1 - lat * 1.35;
    temp += this.nBiome.fbm3(dx * 2.2, dy * 2.2, dz * 2.2, 3, 2, 0.5) * 0.45;
    // Altitude cooling at 0.055/unit put a modest 8-unit rise a full 0.33 below
    // its surroundings — enough to tip a hill inside a temperate forest all the
    // way to snow. Gentler, and it only starts biting well above the surface.
    temp -= Math.max(0, h - R_SURFACE - 4) * 0.028;
    const hum = this.nBiome.fbm3(dx * 2.9 + 51.3, dy * 2.9, dz * 2.9, 4, 2, 0.5) * 0.5 + 0.5;
    return { temp, hum };
  }

  /**
   * Climate → biome. Beach is deliberately absent: it is a shoreline, not an
   * altitude, and is grown out from the water afterwards.
   *
   * Thresholds are set from the measured distribution of the climate fields
   * rather than picked by eye. Humidity is a narrow fbm clustered around 0.5 —
   * its 5th and 95th percentiles are only 0.28 and 0.72 — so a cutoff at 0.66
   * claims the top tenth of the planet, which is why forest used to be rarer
   * than desert. Temperature is much wider, roughly -0.4 to 1.0.
   */
  biomeAt(h, temp, hum) {
    if (h < R_SEA - 0.6) return BIOME.OCEAN;
    // Alpine ground is settled by height before climate: a peak is a peak at any
    // latitude, and a cold one wears a snow cap rather than turning into tundra.
    if (h > R_SURFACE + 3.8) return temp < -0.05 ? BIOME.SNOW : BIOME.MOUNTAIN;
    if (temp < -0.26) return BIOME.SNOW;
    if (temp < -0.02) return BIOME.TUNDRA;
    // Hot and dry, driest first. Badlands used to sit *after* desert and savanna
    // with a range that was a strict subset of theirs, so it was unreachable in
    // all but a sliver — 0.1% of the planet.
    if (temp > 0.54 && hum < 0.38) return BIOME.BADLANDS;
    if (temp > 0.44 && hum < 0.46) return BIOME.DESERT;
    if (temp > 0.34 && hum < 0.52) return BIOME.SAVANNA;
    if (hum > 0.56) return temp > 0.25 ? BIOME.FOREST : BIOME.PINE_FOREST;
    if (hum > 0.48) return BIOME.MEADOW;
    return BIOME.PLAINS;
  }

  /**
   * The global phase: everything that has to see the whole planet at once, and
   * deliberately nothing else.
   *
   * Splitting worldgen in two is the whole reason a New Game takes a few
   * seconds instead of half a minute, and the line is drawn where the
   * measurements put it rather than where the code happened to be divided.
   * Timed over the whole planet: the height field 0.9s, weathering and biomes
   * 0.5s, the ocean fill 0.05s, the canyons 0.07s, choosing the volcano sites
   * 0.004s — a second and a half between them, and all of it per-column
   * bookkeeping a few megabytes wide. Against that: rock and soil 5.3s, caves
   * 6.4s, ore veins 14.8s. Twenty-seven seconds of voxel work, every bit of it
   * per column, and not one column of it needing any column but its own.
   *
   * So the cheap passes stay eager and the expensive ones go lazy, region by
   * region. Which way round that goes is not a preference: a canyon walks a
   * path across the whole sphere, the sea is a flood fill outward from the
   * ocean, the shore distance is a flood fill inward from it, and the volcano
   * sites are chosen against every other site on the planet. None of those four
   * can answer "what does this one region look like" without having answered
   * for the rest of the planet first. The voxel passes can, and that is the only
   * reason any of this works.
   *
   * Everything produced here is kept on `this`: the per-column methods below are
   * the second half of the same generator and read all of it.
   */
  generateGlobal(onProgress = () => {}) {
    const colBiome = new Uint8Array(COLUMNS);
    const colHeight = new Float32Array(COLUMNS);
    const colSlope = new Float32Array(COLUMNS);
    const rng = makeRng(this.seed ^ 0x5bf03635);
    const dir = [0, 0, 0];

    // ---- 1. height field + climate ----------------------------------------
    onProgress(0.02, 'Sculpting the sphere');
    for (let f = 0; f < FACES; f++) {
      for (let i = 0; i < F; i++) {
        for (let j = 0; j < F; j++) {
          const col = cidx(f, i, j);
          centerDir(f, i, j, dir);
          colHeight[col] = this.height(dir[0], dir[1], dir[2]);
        }
      }
      onProgress(0.02 + 0.58 * ((f + 1) / FACES), 'Sculpting the sphere');
    }

    // Relax the height field across the column graph. Voxel terrain quantises
    // to whole layers, so any residual high-frequency noise becomes a forest of
    // one-column spikes; a couple of gentle passes leaves the big landforms
    // intact and kills the needles.
    onProgress(0.60, 'Weathering the surface');
    {
      const tmp = new Float32Array(COLUMNS);
      for (let pass = 0; pass < 3; pass++) {
        tmp.set(colHeight);
        for (let col = 0; col < COLUMNS; col++) {
          let sum = tmp[col] * 1.6;
          for (let d = 0; d < 4; d++) sum += tmp[colNeighbor(col, d)];
          colHeight[col] = sum / 5.6;
        }
      }
    }

    // Biomes are decided from the *relaxed* height, not the raw noise. Deciding
    // first meant a column could be classified as an alpine peak and then be
    // smoothed down into a gentle rise — a snow cap with no mountain under it.
    for (let f = 0; f < FACES; f++) {
      for (let i = 0; i < F; i++) {
        for (let j = 0; j < F; j++) {
          const col = cidx(f, i, j);
          centerDir(f, i, j, dir);
          const h = colHeight[col];
          const { temp, hum } = this.climate(dir[0], dir[1], dir[2], h);
          colBiome[col] = this.biomeAt(h, temp, hum);
        }
      }
    }

    // Then de-speckle. Climate noise plus a hard threshold scatters lone
    // columns of the wrong biome through otherwise uniform ground — a single
    // snow column in the middle of a forest, which is what this looked like in
    // play. A column that disagrees with three or four of its neighbours is
    // noise, not a landform, so it takes the majority.
    {
      const tmp = new Uint8Array(COLUMNS);
      const tally = new Uint8Array(16);
      for (let pass = 0; pass < 2; pass++) {
        tmp.set(colBiome);
        for (let col = 0; col < COLUMNS; col++) {
          const mine = tmp[col];
          tally.fill(0);
          let best = mine, bestN = 0, agree = 0;
          for (let d = 0; d < 4; d++) {
            const b = tmp[colNeighbor(col, d)];
            const n = ++tally[b];
            if (b === mine) agree++;
            if (n > bestN) { bestN = n; best = b; }
          }
          // ocean and beach are decided by height, not climate — leave them be
          if (mine === BIOME.OCEAN || mine === BIOME.BEACH) continue;
          if (best === BIOME.OCEAN || best === BIOME.BEACH) continue;
          if (agree === 0 && bestN >= 3) colBiome[col] = best;
        }
      }
    }

    // ---- shoreline ---------------------------------------------------------
    // A beach is where the land meets the water, not everything within a block
    // of sea level. Claiming it by altitude made a *quarter* of the planet sand:
    // low ground is deliberately flattened toward sea level a few lines up, so
    // the height field piles up in exactly that band. Growing the shore out of
    // the ocean instead gives a shoreline of even width whatever the terrain
    // does, and hands the rest of the low ground back to its climate.
    const shoreDist = new Uint8Array(COLUMNS).fill(255);
    {
      const queue = [];
      for (let col = 0; col < COLUMNS; col++) {
        if (colBiome[col] === BIOME.OCEAN) { shoreDist[col] = 0; queue.push(col); }
      }
      for (let qi = 0; qi < queue.length; qi++) {
        const col = queue[qi];
        const d = shoreDist[col];
        if (d >= BEACH_REACH + 1) continue;
        for (let n = 0; n < 4; n++) {
          const nb = colNeighbor(col, n);
          if (nb < 0 || shoreDist[nb] !== 255) continue;
          shoreDist[nb] = d + 1;
          queue.push(nb);
        }
      }
      for (let col = 0; col < COLUMNS; col++) {
        if (colBiome[col] === BIOME.OCEAN || shoreDist[col] > BEACH_REACH) continue;
        // a cliff dropping straight into the sea is a headland, not a beach
        if (colHeight[col] > R_SEA + 2.2) continue;
        // a frozen coast keeps its snow rather than turning tropical
        if (colBiome[col] === BIOME.SNOW) continue;
        colBiome[col] = BIOME.BEACH;
      }
    }

    // ---- ocean basins ------------------------------------------------------
    // Distance offshore, in columns, by a flood fill outward from the coast.
    // Seeded from the *land* side so the first ocean column comes out at 1 and
    // the profile in `oceanDepthAt` can be written in the units a player feels:
    // "three columns out you are still standing up".
    //
    // This runs after the biome pass and only ever lowers ground that is
    // already ocean, so nothing is reclassified — a column that was Ocean stays
    // Ocean, and land is untouched. Doing it before the biome pass instead
    // moved the coastline, which moved the beaches, which moved the shore
    // distance field the beaches were grown from.
    onProgress(0.90, 'Flooding the basins');
    {
      const oceanDist = new Int16Array(COLUMNS).fill(-1);
      const queue = new Int32Array(COLUMNS);
      let qn = 0;
      for (let col = 0; col < COLUMNS; col++) {
        if (colBiome[col] === BIOME.OCEAN) continue;
        for (let d = 0; d < 4; d++) {
          if (colBiome[colNeighbor(col, d)] === BIOME.OCEAN) {
            oceanDist[col] = 0; queue[qn++] = col; break;
          }
        }
      }
      for (let qi = 0; qi < qn; qi++) {
        const col = queue[qi];
        const dd = oceanDist[col] + 1;
        for (let n = 0; n < 4; n++) {
          const nb = colNeighbor(col, n);
          if (nb < 0 || oceanDist[nb] >= 0 || colBiome[nb] !== BIOME.OCEAN) continue;
          oceanDist[nb] = dd;
          queue[qn++] = nb;
        }
      }

      for (let f = 0; f < FACES; f++) {
        for (let i = 0; i < F; i++) {
          for (let j = 0; j < F; j++) {
            const col = cidx(f, i, j);
            const d = oceanDist[col];
            if (d <= 0) continue;
            centerDir(f, i, j, dir);
            // A flat plate at the bottom of the profile reads as a swimming
            // pool. This is the same field the crust uses for its band edges,
            // at low frequency and small amplitude: seamounts and hollows of a
            // couple of blocks, enough to give the deep somewhere to swim over.
            const bump = this.n.fbm3(dir[0] * 3.4 + 61.7, dir[1] * 3.4, dir[2] * 3.4, 3, 2, 0.5) * 1.9;
            const want = R_SEA - oceanDepthAt(d) + bump;
            // `min` so an existing basin that was already deeper keeps its
            // floor, and the clamp so no amount of noise can put the seabed
            // into the rock the mantle and the cave pass need.
            colHeight[col] = Math.max(R_SEABED_MIN, Math.min(colHeight[col], want));
          }
        }
      }
    }

    // ---- canyons -----------------------------------------------------------
    onProgress(0.93, 'Cutting the gorges');
    const canyonMask = this.carveCanyons(colHeight, colBiome, rng);

    // ---- what the sea can actually reach -----------------------------------
    /**
     * Which sub-sea-level columns are connected to the ocean.
     *
     * The fill pass has always decided water by altitude alone — anything
     * below R_SEA and above the ground is water — and until there were canyons
     * that was exactly equivalent, because the only ground below sea level was
     * ocean floor by definition. It stopped being equivalent the moment a
     * gorge was cut fourteen blocks into land that stands two blocks out of the
     * water: an altitude rule fills every canyon on the planet to the brim,
     * including the ones nowhere near a coast.
     *
     * So connectivity is settled here instead, as a flood fill outward from the
     * ocean over columns whose ground is under sea level. What it reaches is
     * sea, what it does not is a dry depression. It also quietly removes the
     * one-block puddles that used to appear in any inland dip that happened to
     * land in the half-block band between the ocean cutoff and sea level.
     */
    const submerged = new Uint8Array(COLUMNS);
    {
      const queue = new Int32Array(COLUMNS);
      let qn = 0;
      for (let col = 0; col < COLUMNS; col++) {
        if (colBiome[col] === BIOME.OCEAN) { submerged[col] = 1; queue[qn++] = col; }
      }
      // The cutoff is R_SEA - 0.5, not R_SEA, and the half block matters. The
      // topmost cell the fill can put water in has its centre at 129.5, so a
      // column standing at 129.7 holds no water — but there is a lot of such
      // ground, because the height field deliberately flattens everything near
      // sea level toward R_SEA - 0.4 and that pile lands just above the line.
      // Letting it conduct made a continuous wet web out of every coastal
      // plain on the planet, and four of the six canyons filled through it
      // from a shore they never actually reached.
      const WET = R_SEA - 0.5;
      for (let qi = 0; qi < qn; qi++) {
        const col = queue[qi];
        for (let n = 0; n < 4; n++) {
          const nb = colNeighbor(col, n);
          if (nb < 0 || submerged[nb] || colHeight[nb] >= WET) continue;
          /**
           * A gorge marked dry gets a sill instead of a flood.
           *
           * The two designated sea canyons breach the coast on purpose; the
           * other four are supposed to stay dry, and steering them away from
           * the water is not enough on its own. A canyon is up to eleven
           * columns wide and the walk only knows about the ground under the
           * path — so a trunk running along a headland at rim 134 can put the
           * far edge of its own footprint into a bay it never went near, and
           * one such cell floods the entire system through the fill.
           *
           * Raising the frontier column back to just over the waterline seals
           * it in one column, which is all the fill and all the voxel geometry
           * need. It reads as a bar of ground across the gorge mouth, and it
           * is a good thing to find: the canyon behind it is fourteen blocks
           * below sea level, and the bar is diggable.
           */
          if (canyonMask[nb] === 2) { colHeight[nb] = R_SEA + 0.2; continue; }
          submerged[nb] = 1;
          queue[qn++] = nb;
        }
      }
    }

    // slope from the finished height field — exact, unlike sampling the noise
    for (let col = 0; col < COLUMNS; col++) {
      const h = colHeight[col];
      let s = 0;
      for (let d = 0; d < 4; d++) s += Math.abs(colHeight[colNeighbor(col, d)] - h);
      colSlope[col] = s * 0.25;
    }

    // ---- how near is a gorge? ----------------------------------------------
    /**
     * Distance in columns to the nearest canyon column, capped at 4.
     *
     * This is the fix for canyons coming out as wooded gullies. The floor and
     * the terraced walls were never the problem on their own — `canyonMask`
     * already re-surfaces them in gravel and coarse dirt, which is not a block
     * a tree will stand on. What planted them was the *rim*: a rim column is
     * ordinary forest, its canopy is up to four columns across, and a gorge is
     * four to eleven columns wide. Two rows of oaks facing each other across a
     * six-column slot close over the top of it, and from above and from inside
     * the canyon simply is not there any more.
     *
     * So the thinning has to reach outside the mask, which means knowing how
     * far outside. Three steps of dilation over the column graph is enough:
     * a canopy cannot reach further than that, and beyond it the forest is
     * left completely alone.
     */
    const canyonNear = new Uint8Array(COLUMNS).fill(CANYON_NEAR_MAX);
    {
      const queue = new Int32Array(COLUMNS);
      let qn = 0;
      for (let col = 0; col < COLUMNS; col++) {
        if (canyonMask[col]) { canyonNear[col] = 0; queue[qn++] = col; }
      }
      for (let qi = 0; qi < qn; qi++) {
        const col = queue[qi];
        const d = canyonNear[col] + 1;
        if (d >= CANYON_NEAR_MAX) continue;
        for (let n = 0; n < 4; n++) {
          const nb = colNeighbor(col, n);
          if (nb < 0 || canyonNear[nb] <= d) continue;
          canyonNear[nb] = d;
          queue[qn++] = nb;
        }
      }
    }

    // Published before the volcano pass, because that reads them.
    this.colHeight = colHeight;
    this.colBiome = colBiome;
    this.colSlope = colSlope;
    this.canyonMask = canyonMask;
    this.canyonNear = canyonNear;
    this.shoreDist = shoreDist;
    this.submerged = submerged;

    // ---- volcanic fields: where, but not yet what ---------------------------
    // Site selection is planet-wide — a site is rejected for standing too near
    // another one — so it has to happen here. The *building* is voxel work over
    // a forty-column disc and waits until somebody goes near it; see
    // `stampVolcano`.
    onProgress(0.97, 'Lighting the vents');
    this.placeVolcanoSites(rng);

    // ---- structures --------------------------------------------------------
    // No ruins, crypts or vaults. A planet you can walk around in four minutes
    // reads as *yours*; salting it with somebody else's architecture makes it
    // read as a level someone built, which is the opposite of the point. The
    // builder is kept — Structures.js still compiles and its patch mapping is
    // used elsewhere — so this is one line to put back if that judgement
    // changes.
    this.structureCounts = {};

    onProgress(1, 'Ready');
    return { colBiome, colHeight, spawn: this.pickSpawn() };
  }

  /**
   * A first guess at somewhere to wake up, made from the height field alone.
   *
   * The old spawn search read the *voxels* — is the top block grass, is there
   * headroom, how level are the four neighbours — and there are no voxels to
   * read until a region has been generated, which is a circle: the region to
   * generate is the one around the spawn. So the worker picks a column from the
   * height field and the biome map, which is all it needs to find open, level,
   * dry ground, and the main thread refines the answer against real blocks once
   * that neighbourhood has actually been built.
   */
  pickSpawn() {
    const rng = makeRng(this.seed ^ 0x1d5b3f11);
    let best = -1, bestScore = -1;
    for (let n = 0; n < 20000; n++) {
      const col = (rng() * COLUMNS) | 0;
      const bi = this.colBiome[col];
      if (bi === BIOME.OCEAN || bi === BIOME.BEACH) continue;
      // Not in a gorge and not on its rim: waking up fourteen blocks down a
      // slot canyon is a memorable start and a miserable one.
      if (this.canyonNear[col] < CANYON_NEAR_MAX) continue;
      const h = this.colHeight[col];
      if (h < R_SEA + 1.5 || h > R_SURFACE + 3.0) continue;
      let score = 4 - Math.min(4, this.colSlope[col] * 3);
      if (bi === BIOME.PLAINS || bi === BIOME.MEADOW || bi === BIOME.FOREST) score += 2;
      if (score > bestScore) { bestScore = score; best = col; }
      if (bestScore > 5.5) break;
    }
    return best < 0 ? 0 : best;
  }

  /** Unit direction through a column's centre, into the shared scratch. */
  _dirOf(col, out) {
    const f = (col / (F * F)) | 0;
    const rem = col - f * F * F;
    return centerDir(f, (rem / F) | 0, rem % F, out);
  }

  /**
   * The ground layer of a column, read off the height field rather than out of
   * the block array.
   *
   * The fill loop makes everything at r > h air or water and everything below it
   * solid, so this is exactly what scanning down from the top would find — and
   * unlike the scan it can be asked before the column exists. Neither caves nor
   * ore change the answer: caves keep `skin` blocks of rock under the surface,
   * and a vein replaces one rock with another.
   */
  groundKOf(col) {
    const k = Math.floor(this.colHeight[col] - R_MIN - 0.5);
    return k < 0 ? -1 : (k >= D ? D - 1 : k);
  }

  /**
   * A private random stream for one column.
   *
   * Everything scattered on the surface — trees, boulders, grass, mushrooms —
   * used to draw from one sequential `rng` walked in column order, and that is
   * exactly the thing lazy generation cannot have: the hundredth column's trees
   * depend on how many times the first ninety-nine called it, so a planet
   * generated in the order the player walks would be a different planet. Seeding
   * per column from the world seed makes the answer a pure function of (seed,
   * column), which is the invariant the whole design rests on.
   *
   * The mixing is not decoration. xorshift32 seeded with a small integer takes
   * several rounds to look random, and column indices are consecutive — feeding
   * them in raw gave visibly correlated forests, with trees in diagonal stripes.
   */
  colRng(col, salt) {
    let s = Math.imul(col ^ 0x9e3779b9, 0x85ebca6b);
    s = Math.imul(s ^ (s >>> 13) ^ salt ^ this.seed, 0xc2b2ae35);
    s ^= s >>> 16;
    return makeRng(s | 0);
  }

  // --- per-column voxel work -------------------------------------------------

  /**
   * Rock, soil and sea for one column. Reads nothing but this column's own
   * entry in the global tables, which is what makes it safe to run in any order
   * and at any time.
   */
  fillColumn(blocks, col) {
    const { colHeight, colBiome, colSlope, canyonMask, shoreDist, submerged } = this;
    const dir = _fillDir;
    const h = colHeight[col];
    const bi = colBiome[col];
    const rocky = colSlope[col] > 1.35;
    const base = col * D;
    this._dirOf(col, dir);

    // Surface material varies within a biome, not just between biomes: the
    // same field that drifts tundra snow is reused to break up ocean silt,
    // podzol under pines and the grit in a savanna, so no biome is a flat
    // wash of one block.
    const patch = this.nDetail.fbm3(dir[0] * 14, dir[1] * 14, dir[2] * 14, 3, 2, 0.5);

    let top, sub;
    switch (bi) {
      // The seabed changes with depth, not just with noise.
      //
      // It was mud-or-gravel everywhere, which was invisible while the
      // ocean was a puddle: the only water you could see the bottom of
      // was the beach shelf, so the seabed read as "sand" and the two
      // blocks it actually uses never got a look in. Now that there is a
      // real water column, the floor is worth reading — so it goes sandy
      // in the shallows where a beach would naturally continue under the
      // water, silt and gravel over the slope, and clay and bare stone in
      // the deep where nothing settles.
      case BIOME.OCEAN: {
        const depth = R_SEA - h;
        // Bands against the ocean this planet actually has, which is
        // R_SEA - R_SEABED_MIN = 17 layers. The numbers here were 4 and 11 for
        // a 15-layer sea and were never checked again when the shell grew; they
        // are re-derived rather than carried, because a threshold tuned to a
        // depth the world no longer reaches is a band that never fires.
        //
        // Climate splits the shallows and deliberately not the deep. Light,
        // ice and anything that grows stop mattering below the slope, so a
        // polar deep and a tropical deep are the same cold dark rock.
        //
        // `temp` is the temperature term of the biome climate, recomputed here
        // rather than stored: a Float32Array(COLUMNS) would be 5 MB resident
        // for a value only seabed columns ever read, against one extra fbm on
        // those same columns.
        const temp = 1 - Math.abs(dir[1]) * 1.35
          + this.nBiome.fbm3(dir[0] * 2.2, dir[1] * 2.2, dir[2] * 2.2, 3, 2, 0.5) * 0.45;
        // `patch` is frequency 14 — a blob about twenty columns across, which
        // on its own still reads as flat ground with a smear on it. `grit` is
        // the single-column speckle that makes a bed look like a bed at the
        // range you swim over it. Salt 0x5eab is unused: 0x7a11 is trees,
        // 0xb0d1 boulders, 0xf10a flora.
        const grit = this.colRng(col, 0x5eab)();
        if (depth > 13) {
          // The deep floor. Nothing settles and nothing lights it, so it is
          // rock rather than soil. Basalt for the majority on purpose — it is
          // in neither CARVEABLE nor ORE_HOST, so it is one surface the ore
          // pass cannot freckle and the cave pass cannot open. The slate
          // outcrops *are* ORE_HOST, which is the point: a seam showing on the
          // floor of the deep is a reason to have swum down.
          top = patch > 0.26 ? ID.slate : ((patch < -0.22 || grit < 0.06) ? ID.clay : ID.basalt);
          sub = patch > 0.26 ? ID.stone : ID.slate;
        } else if (depth > 8) {
          // The foot of the slope, where the silt fans out and stops. Clay
          // majority with the first slate showing through, so the descent has
          // a middle instead of switching from mud straight to bedrock.
          top = patch > 0.20 ? ID.gravel : ((patch < -0.24 || grit < 0.10) ? ID.slate : ID.clay);
          sub = grit < 0.4 ? ID.slate : ID.clay;
        } else if (temp < -0.05) {
          // A polar sea. No sand at all, and that is a rule rather than a
          // preference: a frozen coast is kept out of BIOME.BEACH by the
          // shoreline pass, so sand running under the water there would be
          // sand coming from nowhere.
          top = depth < 3
            ? (patch > 0.24 ? ID.packed_ice : (patch < -0.18 ? ID.coarse_dirt : ID.gravel))
            : (patch > 0.14 ? ID.clay : (grit < 0.12 ? ID.coarse_dirt : ID.gravel));
          sub = depth < 3 ? (grit < 0.35 ? ID.coarse_dirt : ID.gravel) : ID.clay;
        } else if (temp > 0.45) {
          // A warm sea. The shallows are the one place with light, warmth and
          // water at once, so they get the only green ground that is not turf.
          // Moss over pale sand is as close to a reef as a palette with no
          // coral in it gets.
          top = depth < 3
            ? (patch > 0.20 ? ID.moss_block : ((patch < -0.24 || grit < 0.08) ? ID.clay : ID.sand))
            : (patch > 0.18 ? ID.clay : (patch < -0.20 ? ID.mud : ID.sand));
          sub = depth < 3 ? ID.sand : (grit < 0.4 ? ID.mud : ID.sand);
        } else {
          // A temperate sea: sand in the shallows so a beach keeps going under
          // the water it runs into, silt and gravel down the slope.
          top = depth < 3
            ? (patch > 0.22 ? ID.gravel : ((patch < -0.26 || grit < 0.07) ? ID.clay : ID.sand))
            : (patch > 0.16 ? ID.gravel : ((patch < -0.14 || grit < 0.10) ? ID.clay : ID.mud));
          sub = depth < 3 ? ID.sand : (grit < 0.5 ? ID.mud : ID.dirt);
        }
        break;
      }
      case BIOME.BEACH: top = ID.sand; sub = ID.sand; break;
      case BIOME.DESERT: top = ID.sand; sub = ID.sandstone; break;
      // Badlands is the only red ground on the planet. It used to be plain
      // sandstone, which made it indistinguishable from a desert cliff.
      case BIOME.BADLANDS: top = patch > 0 ? ID.red_sand : ID.red_sandstone; sub = ID.red_sandstone; break;
      case BIOME.SNOW: top = ID.snow; sub = patch < -0.2 ? ID.packed_ice : ID.dirt; break;
      case BIOME.MOUNTAIN: top = rocky ? ID.stone : ID.grass; sub = ID.stone; break;
      case BIOME.PINE_FOREST: top = patch > 0.08 ? ID.podzol : ID.grass; sub = ID.dirt; break;
      case BIOME.SAVANNA: top = ID.grass; sub = patch > -0.05 ? ID.coarse_dirt : ID.dirt; break;
      case BIOME.TUNDRA: {
        // Frozen ground: drifts of snow lying over bare, frost-heaved
        // soil and stone. Tundra had no case here at all and fell through
        // to grass — the same block as a meadow, which is how a biome
        // named for permafrost ended up green and full of flowers.
        const drift = this.nDetail.fbm3(dir[0] * 16, dir[1] * 16, dir[2] * 16, 3, 2, 0.5);
        top = drift > 0.10 ? ID.snow : (drift < -0.24 ? ID.gravel : ID.coarse_dirt);
        // Permafrost bog. Peat is a fuel, so the biome that grows almost
        // no wood is the one that hands you something to burn instead.
        sub = drift < -0.05 ? ID.peat : ID.dirt;
        break;
      }
      default: top = ID.grass; sub = ID.dirt; break;
    }
    if (rocky && bi !== BIOME.DESERT && bi !== BIOME.BADLANDS) { top = ID.stone; sub = ID.stone; }
    // A canyon is cut in the height field, so without this the floor and
    // the terraces inherit whatever the rim wears and a fourteen-block
    // gorge comes out lined with meadow turf — a green ditch. The walls
    // already handle themselves: they are steep, so the `rocky` test
    // above turns them to stone, and everything below four blocks of
    // depth is `stratum` and shows the bands the carve exposed.
    if (canyonMask[col]) {
      if (bi === BIOME.DESERT || bi === BIOME.BADLANDS) {
        top = patch > 0.1 ? ID.red_sand : ID.gravel; sub = ID.red_sandstone;
      } else {
        top = patch > 0.22 ? ID.coarse_dirt : ID.gravel; sub = ID.stone;
      }
    }
    // Sandy shallows, but only just off the shore. This used to be a flat
    // "anything under sea level + 0.4 is sand" rule running independently
    // of the biome, which is the other half of why the planet looked like
    // one continuous beach — a column could be labelled Plains and still
    // be built entirely out of sand.
    //
    // `bi !== BIOME.OCEAN` is the whole seabed fix, and it is one clause.
    // `shoreDist` is seeded at 0 on every ocean column — that is how the beach
    // ring is grown *outward from* the water — so this distance test was true
    // for the entire ocean rather than for its rim, and repainted every seabed
    // on the planet sand over sand. The depth-varied seabed in the switch above
    // had never once reached a player. What this rule is actually for is
    // carrying a beach the last half block into water the height field put
    // below the line without the biome pass calling it Ocean, and it still
    // does exactly that.
    if (h < R_SEA + 0.4 && bi !== BIOME.OCEAN && bi !== BIOME.SNOW
      && shoreDist[col] <= BEACH_REACH + 1) {
      top = ID.sand; sub = ID.sand;
    }

    for (let k = 0; k < D; k++) {
      const r = R_MIN + k + 0.5;
      let id;
      if (r < R_CORE) id = ID.core;
      else if (r < R_MANTLE) {
        const m = this.nCave.fbm3(dir[0] * r * 0.22, dir[1] * r * 0.22, dir[2] * r * 0.22, 3, 2, 0.5);
        id = m > 0.42 ? ID.obsidian
          : m > 0.16 ? ID.ash_stone
            : (m < -0.5 ? ID.lava : ID.basalt);
      } else if (r > h) {
        id = (r <= R_SEA && submerged[col]) ? ID.water : ID.air;
      } else {
        const depth = h - r;
        if (depth < 1.0) id = top;
        else if (depth < 4.0) id = sub;
        else id = this.stratum(r, dir[0], dir[1], dir[2]);
      }
      blocks[base + k] = id;
    }
  }

  /** Caves, for one already-filled column. */
  carveColumn(blocks, col) {
    const nc = this.nCave;
    const canyonMask = this.canyonMask;
    const h = this.colHeight[col];
    const base = col * D;
    const dir = _fillDir;
    this._dirOf(col, dir);
    {
      // How much rock a cave has to leave under the surface. 2.2 everywhere
      // else, because a cave that breaks daylight at random leaves the planet
      // pocked with holes nobody dug — but in a canyon that is exactly the
      // thing worth having. A gorge floor fourteen blocks down is already
      // halfway to the cave band, and a mouth in the wall is how the two
      // systems become one place instead of two. At 1.0 the cave still has to
      // genuinely reach the floor to open; it does so where a passage runs
      // close underneath, which is a handful of openings per canyon rather
      // than a sieve.
      const skin = canyonMask[col] ? 1.0 : 2.2;
      for (let k = 0; k < D; k++) {
        if (!CARVEABLE[blocks[base + k]]) continue;
        const r = R_MIN + k + 0.5;
        if (r < R_MANTLE + 1.5 || r > h - skin) continue;
        const px = dir[0] * r, py = dir[1] * r, pz = dir[2] * r;
        // Cheapest term first, and short-circuit on it.
        //
        // The condition is `min(a, b) > 0.86 || cav > 0.58`, and the two ridged
        // fields cost three octaves each against `cav`'s one field — so every
        // voxel that a chamber already claims was paying for two tunnel samples
        // whose answer could not change the outcome. Evaluating `cav` first and
        // returning on it makes the blob-carved voxels free of the tunnel cost.
        // This is the second most expensive loop in worldgen at 13s of 63.
        // Same exact early-out as the ore veins, one octave deeper: a
        // three-octave fbm at gain 0.5 normalises by 1.75, so after the first
        // octave the most the remaining two can add is 0.75/1.75. If that
        // cannot reach 0.58 the chamber is ruled out and the other two octaves
        // are never computed.
        const cx = px * 0.035 + 11.1, cy = py * 0.035, cz = pz * 0.035;
        const c1 = nc.simplex3(cx, cy, cz);
        const cav = c1 + 0.75 <= 0.58 * 1.75 ? -1
          : (c1 + 0.5 * nc.simplex3(cx * 2, cy * 2, cz * 2)
            + 0.25 * nc.simplex3(cx * 4, cy * 4, cz * 4)) / 1.75;
        let open = cav > 0.58;
        if (!open) {
          const a = nc.ridged3(px * 0.062, py * 0.062, pz * 0.062, 3, 2.1, 0.5);
          // `b` only matters if `a` already cleared the bar — `min(a, b)` can
          // never exceed 0.86 when `a` does not.
          open = a > 0.86
            && nc.ridged3(px * 0.062 + 40.5, py * 0.062, pz * 0.062 - 22.3, 3, 2.1, 0.5) > 0.86;
        }
        if (open) {
          blocks[base + k] = (r < R_MANTLE + 4 && cav > 0.7) ? ID.lava : ID.air;
        }
      }
    }
  }

  /** Ore veins, for one already-carved column. See ORE_BY_LAYER. */
  oreColumn(blocks, col) {
    const no = this.nOre;
    const base = col * D;
    const dir = _fillDir;
    this._dirOf(col, dir);
    for (let k = 0; k < D; k++) {
      if (!ORE_HOST[blocks[base + k]]) continue;
      const bucket = ORE_BY_LAYER[k];
      if (bucket.length === 0) continue;
      const r = R_MIN + k + 0.5;
      const px = dir[0] * r, py = dir[1] * r, pz = dir[2] * r;
      for (let oi = 0; oi < bucket.length; oi++) {
        const o = bucket[oi];
        // Two octaves, not three. A vein is a blob — the third octave was
        // adding detail an order of magnitude smaller than one block, which
        // no player can ever see, at a third of the cost of the single most
        // expensive loop in worldgen. `veinNoise` then skips the second
        // octave whenever the first already rules the threshold out, which is
        // most of the time.
        const n = veinNoise(no, px * o.scale + o.seed, py * o.scale, pz * o.scale + o.seed * 0.5, o.thr);
        if (n > o.thr) { blocks[base + k] = o.id; break; }
      }
    }
  }

  /**
   * Everything a column's voxels need, in the order the three passes always ran
   * in.
   *
   * They used to be three sweeps over the whole planet, and interleaving them
   * per column changes nothing: none of the three ever reads a column but its
   * own, so fill-then-carve-then-ore for one column at a time produces the same
   * bytes as fill-everywhere-then-carve-everywhere-then-ore-everywhere. What it
   * buys is that the column is touched once instead of three times, and — the
   * point of the whole exercise — that a column can be built without building
   * its neighbours.
   */
  terrainColumn(blocks, col) {
    this.fillColumn(blocks, col);
    this.carveColumn(blocks, col);
    this.oreColumn(blocks, col);
  }

  /**
   * Cut a canyon system into the height field.
   *
   * This is a height-field pass, not a voxel pass, and that is the whole design
   * decision. Carving the voxel array directly was the obvious approach and it
   * costs more than it buys: the canyon then has to lay its own floor soil, mix
   * its own water below sea level, and keep `colHeight` in sync anyway or every
   * later pass — caves, ore, trees, the slope test — is reasoning about a
   * surface that is no longer there. Lowering the height field instead means
   * the fill pass builds the gorge as ordinary terrain. The floor gets soil
   * over `stratum` like anywhere else, a floor below R_SEA fills with water
   * because the fill loop already does that, and the walls come out showing the
   * limestone and granite courses for nothing, because a wall column is just a
   * column whose neighbour is fourteen blocks lower.
   *
   * The cost is that a height field cannot make an overhang or an arch. On a
   * planet where the total relief is eighteen blocks that is a fair trade.
   *
   * Each canyon is walked one column at a time as a path on the sphere, and the
   * walk is steered downhill: five candidate headings are sampled six columns
   * ahead and the lowest wins, blended with a smooth wander so the result bends
   * rather than beelines. Downhill steering is what makes the ends terminate
   * sensibly without any special case — water runs to the sea, so a canyon that
   * follows the ground finds the coast on its own, and the ones that do not
   * shallow out into a dry wash instead of stopping at a wall.
   *
   * @returns {Uint8Array} per-column mask: 1 where the ground was cut by more
   *   than a block and a half, which the fill and cave passes both read.
   */
  carveCanyons(colHeight, colBiome, rng) {
    const mask = new Uint8Array(COLUMNS);
    const target = new Float32Array(COLUMNS).fill(Infinity);
    // Which columns a sea-going gorge touched at all — not which one cut them
    // deepest. Ownership by depth is the wrong test where two systems cross:
    // the dry one is usually the deeper, and letting it claim the crossing
    // puts a dam across the middle of a river.
    const wetOwn = new Uint8Array(COLUMNS);
    const cell = { f: 0, i: 0, j: 0, col: 0 };
    const nW = this.nWarp;
    const nD = this.nDetail;
    // One step is one column: a canyon has to be able to bend on the scale of
    // the blocks it is cut into, and a column subtends 1/R at the surface.
    const STEP = 1 / R_SURFACE;
    const AHEAD = Math.cos(STEP * 6), AHEAD_S = Math.sin(STEP * 6);
    const CS = Math.cos(STEP), SN = Math.sin(STEP);

    /**
     * Walk one watercourse and stamp it.
     *
     * `o.steer` is -1 downhill, +1 uphill, 0 along the contour, and all three
     * are in use for a reason.
     *
     * Downhill is what a watercourse does and it is what the two drowned
     * gorges want. It is wrong for everything else here: the planet stands two
     * blocks out of the water on average, so a path that always takes the
     * lower of five headings is at the coast within thirty columns, and the
     * first version of this closed out four of six canyons before they were a
     * third grown. Contour steering — take the heading closest to the height
     * you are already at — keeps a canyon out on the plateau it started on,
     * which is where a slot canyon belongs and where there is room for one.
     *
     * Uphill is for tributaries. A tributary is walked *outward from the
     * confluence*, which means climbing, because that is the direction it has
     * to taper in. Walking it downhill from its head instead needs the head
     * chosen first, and a head chosen at random lands in the wrong basin about
     * half the time and the tributary runs away from its trunk.
     *
     * @returns {Array<number[]>} sampled points along the path, for branching
     */
    const walk = (p0, t0, o) => {
      let px = p0[0], py = p0[1], pz = p0[2];
      let tx = t0[0], ty = t0[1], tz = t0[2];
      // orthonormalise the tangent against the position once; the advance step
      // keeps them orthogonal from then on
      let d = px * tx + py * ty + pz * tz;
      tx -= px * d; ty -= py * d; tz -= pz * d;
      let l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;

      const trail = [];
      let floorR = Infinity;
      let wet = -1;                       // step at which the path went under water
      // Contour steering is anchored to the height the canyon *started* at,
      // not to the height of the column it is currently standing on. Chasing
      // the current height is a random walk in altitude: each step's error is
      // small, two hundred of them are not, and the canyon slides two or three
      // blocks downhill over its length and finds the coast anyway — which is
      // the whole thing contour steering exists to avoid.
      let anchor = 0;

      for (let s = 0; s < o.len; s++) {
        dirToColumn(px, py, pz, cell);
        const col = cell.col;
        const hRim = colHeight[col];
        if (s === 0) anchor = hRim;

        const sFrac = s / o.len;
        const head = smoothstep(0, 0.10, sFrac);
        let tail = smoothstep(1.0, 0.84, sFrac);

        /**
         * What happens at the coast, and it is the single most important
         * decision in this pass.
         *
         * Sea level is 130 and median land is 132.3 — the whole planet stands
         * two and a bit blocks out of the water. So *every* canyon worth
         * cutting has its floor below sea level along almost its entire
         * length; measured on the first working version, 84% of canyon floor
         * columns were under the waterline, and the fill pass drowned all of
         * them. Six flooded trenches is not what was asked for and is not
         * worth having: you cannot climb into a fjord.
         *
         * So most canyons are closed off short of the coast, tapering to
         * nothing over sixteen columns so the gorge dies out in the coastal
         * plain rather than ending in a wall of seawater. Whether they end up
         * wet is then settled properly, by the connectivity fill further down
         * — a floor below sea level that has no path to the sea stays dry, the
         * way a rift basin does.
         *
         * `o.sea` opts two of the six out of that and lets them run straight
         * into the water at full depth. A drowned gorge is worth having as
         * well: it is the one place a fifteen-block dive starts from dry land,
         * and it is the only reason the shelf and the deep are reachable
         * without swimming out of sight of the shore.
         */
        if (o.sea) {
          if (wet < 0 && hRim < R_SEA - 0.5) wet = s;
          if (wet >= 0) { tail = 1; if (s - wet > 12) break; }
        } else {
          if (wet < 0 && hRim < R_SEA + 1.5) wet = s;
          if (wet >= 0) {
            const ct = 1 - (s - wet) / 16;
            if (ct <= 0) break;
            if (ct < tail) tail = ct;
          }
        }

        const dn = nD.simplex3(px * 3.1 + o.dseed, py * 3.1, pz * 3.1);
        const wn = nD.simplex3(px * 4.3 + o.wseed, py * 4.3, pz * 4.3);
        const dep = o.dep * head * tail * (0.76 + 0.42 * (dn * 0.5 + 0.5));
        const W = o.wid * (0.70 + 0.58 * (wn * 0.5 + 0.5));

        if (dep >= 0.8) {
          let fr = hRim - dep;
          // Only the watercourses hold their floor monotone downhill; that is
          // what makes one read as somewhere water went rather than as a
          // trench. A contoured slot canyon deliberately does not — its floor
          // follows the plateau, which is what a slot canyon does. It is also
          // released the moment either taper starts biting: otherwise it wins
          // the `min` and pins the floor at full depth right through the
          // close-out, turning a gorge that was supposed to die out into one
          // that stops at a cliff.
          if (floorR < Infinity && o.steer < 0 && head * tail > 0.98) {
            fr = Math.min(fr, floorR + 0.05);
          }
          fr = Math.max(fr, hRim - CANYON_MAX_DEPTH, R_CANYON_MIN);
          floorR = fr;

          const ri = Math.ceil(W) + 1;
          for (let di = -ri; di <= ri; di++) {
            for (let dj = -ri; dj <= ri; dj++) {
              const dist = Math.hypot(di, dj);
              if (dist > W) continue;
              // Flat floor, near-vertical wall: full depth out to 0.58 of the
              // half-width, then the whole drop is spent in the last 0.42.
              const w = smoothstep(1.0, 0.58, dist / W);
              if (w <= 0.001) continue;
              // The footprint is stamped in the path column's own face frame.
              // Across a cube seam that mapping stops being exactly 1:1 and
              // loses a handful of cells out of a disc this size — in a
              // building that is a hole in a wall, here it is one column of
              // canyon wall that came out a block wider. Refusing seam
              // crossings the way `placeStructures` does is not an option: a
              // canyon two hundred columns long crosses seams by definition.
              const c = patchColumn(cell.f, cell.i, cell.j, di, dj);
              const cRim = colHeight[c];
              let hh = cRim + (fr - cRim) * w;
              // Terrace the wall. Free scenery: the crust's bands sit at fixed
              // radii, so a wall that steps in three-block courses puts a
              // walkable ledge at the limestone line and again at the granite
              // one, and the gorge shows its own stratigraphy instead of being
              // a smooth ramp of whatever rock the rim happened to be made of.
              if (w < 0.92) hh = fr + Math.ceil((hh - fr) / CANYON_BENCH) * CANYON_BENCH;
              if (o.sea) wetOwn[c] = 1;
              if (hh < target[c]) target[c] = hh;
            }
          }
        }

        if ((s & 7) === 0) trail.push([px, py, pz, tx, ty, tz]);

        // --- steer ---
        const ux = py * tz - pz * ty, uy = pz * tx - px * tz, uz = px * ty - py * tx;
        let bestA = 0, bestScore = Infinity;
        for (let c = -2; c <= 2; c++) {
          const a = c * 0.34;
          const ca = Math.cos(a), sa = Math.sin(a);
          const qx = tx * ca + ux * sa, qy = ty * ca + uy * sa, qz = tz * ca + uz * sa;
          const hh = colHeight[dirToColumn(
            px * AHEAD + qx * AHEAD_S, py * AHEAD + qy * AHEAD_S, pz * AHEAD + qz * AHEAD_S, cell,
          ).col];
          const score = o.steer < 0 ? hh : o.steer > 0 ? -hh : Math.abs(hh - anchor);
          if (score < bestScore) { bestScore = score; bestA = a; }
        }
        const wander = nW.simplex3(px * 5.7 + o.wseed, py * 5.7, pz * 5.7) * 0.19;
        let turn = wander + bestA * 0.40;
        // Cap the turn per column. Uncapped, the downhill term wins on a slope
        // and the path spirals round the contour until it eats its own tail.
        if (turn > 0.22) turn = 0.22; else if (turn < -0.22) turn = -0.22;
        const ct = Math.cos(turn), st = Math.sin(turn);
        tx = tx * ct + ux * st; ty = ty * ct + uy * st; tz = tz * ct + uz * st;

        // --- advance along the great circle in the tangent's direction ---
        const nx = px * CS + tx * SN, ny = py * CS + ty * SN, nz = pz * CS + tz * SN;
        tx = tx * CS - px * SN; ty = ty * CS - py * SN; tz = tz * CS - pz * SN;
        px = nx; py = ny; pz = nz;
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl; py /= pl; pz /= pl;
      }
      return trail;
    };

    // --- pick well-separated highland sources ---
    const dir = [0, 0, 0];
    const starts = [];
    for (let t = 0; t < 200000 && starts.length < CANYON_COUNT; t++) {
      const col = (rng() * COLUMNS) | 0;
      const bi = colBiome[col];
      if (bi === BIOME.OCEAN || bi === BIOME.BEACH) continue;
      // Start on high ground. A canyon head at sea level has nowhere to run to,
      // and the depth budget is measured down from the rim — a head three
      // blocks above the water gets a three-block ditch.
      if (colHeight[col] < R_SURFACE + 3.0) continue;
      const p = colParts(col);
      centerDir(p.f, p.i, p.j, dir);
      let clash = false;
      for (const s of starts) {
        if (s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2] > 0.70) { clash = true; break; }
      }
      if (clash) continue;
      starts.push([dir[0], dir[1], dir[2]]);
    }

    for (let n = 0; n < starts.length; n++) {
      const p = starts[n];
      // any direction in the tangent plane will do — the steering takes over
      // within a dozen columns
      const ax = Math.abs(p[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const bx = [p[1] * ax[2] - p[2] * ax[1], p[2] * ax[0] - p[0] * ax[2], p[0] * ax[1] - p[1] * ax[0]];
      const cx = [p[1] * bx[2] - p[2] * bx[1], p[2] * bx[0] - p[0] * bx[2], p[0] * bx[1] - p[1] * bx[0]];
      const a0 = rng() * Math.PI * 2;
      const t0 = [
        bx[0] * Math.cos(a0) + cx[0] * Math.sin(a0),
        bx[1] * Math.cos(a0) + cx[1] * Math.sin(a0),
        bx[2] * Math.cos(a0) + cx[2] * Math.sin(a0),
      ];

      const len = 130 + ((rng() * 91) | 0);
      // The first two run to the sea and drown; the rest stop short of it. See
      // the coast note in `walk` for why the split exists at all.
      const sea = n < 2;
      const trail = walk(p, t0, {
        len, dep: 10 + rng() * 8, wid: 4 + rng() * 7,
        dseed: rng() * 100, wseed: rng() * 100, steer: sea ? -1 : 0, sea,
      });

      // One or two tributaries per trunk, joining somewhere in the middle
      // third. Shallower and narrower than the trunk, because a tributary that
      // matches its trunk turns a canyon into a crossroads.
      const branches = 1 + (rng() < 0.55 ? 1 : 0);
      for (let b = 0; b < branches && trail.length > 6; b++) {
        const idx = Math.min(trail.length - 2,
          Math.max(1, ((0.25 + rng() * 0.45) * trail.length) | 0));
        const q = trail[idx];
        // leave the trunk at roughly a right angle, either side
        const sgn = rng() < 0.5 ? -1 : 1;
        const ux = q[1] * q[5] - q[2] * q[4];
        const uy = q[2] * q[3] - q[0] * q[5];
        const uz = q[0] * q[4] - q[1] * q[3];
        const sk = 0.55 + rng() * 0.35;   // a little downstream lean, not a T
        walk([q[0], q[1], q[2]],
          [q[3] * (1 - sk) + ux * sgn * sk, q[4] * (1 - sk) + uy * sgn * sk,
            q[5] * (1 - sk) + uz * sgn * sk],
          {
            len: (len * (0.30 + rng() * 0.25)) | 0,
            dep: 7 + rng() * 5, wid: 3 + rng() * 4,
            dseed: rng() * 100, wseed: rng() * 100, steer: 1, sea,
          });
      }
    }

    for (let col = 0; col < COLUMNS; col++) {
      const t = target[col];
      if (t === Infinity) continue;
      const h = colHeight[col];
      if (t >= h - 1.5) continue;
      colHeight[col] = Math.max(R_CANYON_MIN, t);
      // 1 for a gorge that is allowed to drown, 2 for one that must not.
      mask[col] = wetOwn[col] ? 1 : 2;
    }
    return mask;
  }

  /**
   * Volcanic fields: a low shield cone with a lava vent in its crater, a ring
   * of radiating fissures, and a scorched apron around the lot.
   *
   * Two constraints shape all of this and both are recorded elsewhere in the
   * tree. The first is `buildCrater`'s note that paving a bowl in lava-cracked
   * rock "read as a lava lake, not as a scar" — so the molten *area* here is
   * tiny and the region is made to glow by other means. Ash stone and basalt do
   * the bulk of the ground, magma stone is scattered through the apron as a
   * solid emissive block, and actual `ID.lava` appears only at the bottom of
   * the vent and in the last layer of a fissure four blocks down. From standing
   * height a fissure is a glowing crack, which is what a scar looks like.
   *
   * The second is `buildLavaChamber`'s note on the water sim: worldgen liquid
   * is registered as a source by `Water.seedSources` and `Water._place` writes
   * `ID.water` whatever the liquid was, so a large lava pool becomes a large
   * water pool the first time a player mines its rim. Every lava cell placed
   * here therefore has obsidian directly under it and obsidian or untouched
   * rock on all four sides at its own layer — the pool cannot drain, and there
   * is nothing near enough for it to drain *into*, which is the other half of
   * why the vent sits on top of a cone rather than in a pit.
   *
   * The cone is only six blocks tall, and that is the shell talking, not
   * taste. Mean land is layer 30 of 44 and the top two layers have to stay
   * clear, so a landmark you build *up* has about eight layers to work with
   * before it runs out of planet. The apron is what actually makes the region
   * legible from a distance: forty columns of grey burnt ground with orange in
   * it, against grass.
   */
  /**
   * Choose the sites, planet-wide, without building anything.
   *
   * This half has to be eager: a candidate is rejected for standing on ground
   * another site has already claimed, so the answer for one site depends on
   * every site before it, and asking "is there a volcano in this region" cannot
   * be answered locally. It is also nearly free — four sites out of at most
   * 300 000 tries against three per-column tables, measured at 4ms.
   *
   * The one thing that had to change to get it out of the voxel array is the
   * ground test, which used to scan each column from the top for the first
   * non-air block. `groundKOf` reads the same answer off the height field; see
   * its note for why the two agree.
   */
  placeVolcanoSites(rng) {
    const { colHeight, colBiome, colSlope, canyonMask } = this;
    const HOSTS = [BIOME.BADLANDS, BIOME.DESERT, BIOME.SAVANNA, BIOME.MOUNTAIN, BIOME.PLAINS];
    const claim = new Uint8Array(COLUMNS);
    const parts = { f: 0, i: 0, j: 0 };
    const sites = [];

    for (let t = 0; t < 300000 && sites.length < VOLCANO_TARGET; t++) {
      const col = (rng() * COLUMNS) | 0;
      if (!HOSTS.includes(colBiome[col]) || claim[col] || canyonMask[col]) continue;
      const h = colHeight[col];
      // The height window is narrow and both edges are load-bearing. Below
      // R_SEA + 2.5 the crater floor is at or under the waterline and one
      // player tunnel from the coast turns the vent into a pool. The upper edge
      // is where a six-block cone stops fitting under the two clear layers the
      // shell keeps at the top — expressed against R_MAX rather than as the
      // bare 135.5 it was, which was that same ceiling on the old 144 shell.
      if (h < R_SEA + 2.5 || h > R_MAX - 8.5) continue;
      if (colSlope[col] > 0.85) continue;
      colParts(col, parts);
      // Keep the whole apron on one face. Same reason as `placeStructures`: a
      // forty-column disc folded over a seam loses cells, and unlike a canyon
      // wall a cone with holes in it reads as broken.
      //
      // Lazy generation leans on this a second time. Because the footprint
      // cannot leave its face, "which regions does this volcano touch" is a
      // rectangle in face coordinates rather than a walk over the column graph.
      if (parts.i < APRON || parts.i >= F - APRON
        || parts.j < APRON || parts.j >= F - APRON) continue;

      // Flat enough, dry enough, and nobody else's ground.
      let lo = 99, hi = -99, bad = false;
      for (let di = -CONE; di <= CONE && !bad; di += 3) {
        for (let dj = -CONE; dj <= CONE; dj += 3) {
          const c = patchColumn(parts.f, parts.i, parts.j, di, dj);
          const g = this.groundKOf(c);
          if (g < 0 || g > D - 3 - CONE_H) { bad = true; break; }
          if (colBiome[c] === BIOME.OCEAN || colBiome[c] === BIOME.BEACH) { bad = true; break; }
          if (canyonMask[c] || claim[c]) { bad = true; break; }
          if (g < lo) lo = g;
          if (g > hi) hi = g;
        }
      }
      if (bad || hi - lo > 4) continue;

      // Claim the apron so the next candidate cannot stand in it. The stamp
      // used to do this as it laid the ground; it has to happen here now,
      // because the next candidate is chosen long before anything is built.
      for (let di = -APRON; di <= APRON; di++) {
        for (let dj = -APRON; dj <= APRON; dj++) {
          if (Math.hypot(di, dj) > APRON) continue;
          claim[patchColumn(parts.f, parts.i, parts.j, di, dj)] = 1;
        }
      }

      sites.push({
        f: parts.f, i: parts.i, j: parts.j,
        kBase: hi,                            // build off the high side, so no
        seed: (rng() * 0x7fffffff) | 0,       // part of the cone is left buried
        stamped: false,
      });
    }

    this.volcanoes = sites;
    this.volcanoCount = sites.length;
  }

  /**
   * Build one chosen site. Every column within APRON of it must already have
   * had `terrainColumn` run, and none of them may have been decorated yet — the
   * cone reads the ground layer out of the block array, and a tree standing on
   * that ground would answer the question with its own canopy.
   */
  stampVolcano(blocks, site) {
    if (site.stamped) return;
    site.stamped = true;
    const rng = makeRng(site.seed);
    const parts = { f: site.f, i: site.i, j: site.j };

    const groundK = (col) => {
      const base = col * D;
      for (let k = D - 1; k >= 0; k--) {
        const b = blocks[base + k];
        if (b !== ID.air && b !== ID.water) return k;
      }
      return -1;
    };
    const set = (col, k, id) => { if (k >= 0 && k < D) blocks[col * D + k] = id; };
    const get = (col, k) => (k >= 0 && k < D ? blocks[col * D + k] : ID.stone);

    {
      const kBase = site.kBase;
      const kSummit = kBase + CONE_H;
      const kCrater = kSummit - 3;

      // --- apron: burnt ground, thinning outward ---
      for (let di = -APRON; di <= APRON; di++) {
        for (let dj = -APRON; dj <= APRON; dj++) {
          const d = Math.hypot(di, dj);
          if (d > APRON) continue;
          const c = patchColumn(parts.f, parts.i, parts.j, di, dj);
          if (d <= CONE - 1) continue;        // the cone lays its own ground
          const g = groundK(c);
          if (g < 1 || g >= D - 1) continue;
          // Fade the scorch out rather than ending it at a circle. A hard edge
          // makes the whole thing read as a decal somebody stuck on the grass.
          const fade = 1 - (d - CONE + 1) / (APRON - CONE + 2);
          if (rng() > 0.15 + fade * 0.85) continue;
          const q = rng();
          let id;
          if (q < 0.035 + fade * 0.05) id = ID.magma_stone;   // the glow, solid
          else if (q < 0.10) id = ID.sulfur_ore;
          else if (q < 0.34) id = ID.basalt;
          else if (q < 0.74) id = ID.ash_stone;
          else id = rng() < 0.5 ? ID.gravel : ID.coarse_dirt;
          set(c, g, id);
          if (get(c, g + 1) !== ID.air) set(c, g + 1, ID.air);
        }
      }

      // --- the cone ---
      for (let di = -CONE; di <= CONE; di++) {
        for (let dj = -CONE; dj <= CONE; dj++) {
          const d = Math.hypot(di, dj);
          if (d > CONE) continue;
          const c = patchColumn(parts.f, parts.i, parts.j, di, dj);
          const g = groundK(c);
          if (g < 1 || g >= D - 1) continue;
          // A summit plateau out to the crater lip, then flanks. The obvious
          // profile — full height only at the centre — does not work here: the
          // crater has to be cut *into* something, and a peak that is already
          // down to three blocks by the time it reaches the crater wall has no
          // wall left to cut, so the bowl came out as a dent in the slope. The
          // 1.5 power on the flank is what keeps it a shield rather than a
          // spoil heap.
          const ft = Math.max(0, (d - VENT - 1) / (CONE - VENT - 1));
          const kTop = kBase + Math.round(CONE_H * Math.pow(1 - ft, 1.5));
          for (let k = Math.min(g, kBase - 1) + 1; k <= kTop; k++) {
            const q = rng();
            set(c, k, q < 0.20 ? ID.basalt : q < 0.26 ? ID.magma_stone : ID.ash_stone);
          }
          for (let k = kTop + 1; k < D; k++) {
            if (get(c, k) === ID.air) break;
            set(c, k, ID.air);
          }
        }
      }

      // --- crater, vent pool, and the obsidian that keeps it there ---
      for (let di = -VENT; di <= VENT; di++) {
        for (let dj = -VENT; dj <= VENT; dj++) {
          const d = Math.hypot(di, dj);
          if (d > VENT) continue;
          const c = patchColumn(parts.f, parts.i, parts.j, di, dj);
          for (let k = kCrater + 1; k < D; k++) {
            if (get(c, k) === ID.air) break;
            set(c, k, ID.air);
          }
          // Bowl floor and its liner. The liner matters: the cave pass has
          // already run and may have opened a passage a few blocks under this
          // exact spot, and a vent pool with a hole under it drains the first
          // time anybody disturbs it.
          set(c, kCrater - 1, ID.obsidian);
          set(c, kCrater, d < 2.4 ? ID.lava : ID.obsidian);
        }
      }

      // --- radiating fissures ---
      // The lava is one layer at the bottom of a four-block slot. Standing on
      // the rim you see a glowing line in the ground; you have to climb down to
      // it to be burnt by it, which is the difference between a hazard and a
      // wall of the stuff.
      const molten = [];
      const fissures = 3 + ((rng() * 3) | 0);
      for (let n = 0; n < fissures; n++) {
        let ang = rng() * Math.PI * 2;
        const len = 10 + ((rng() * 13) | 0);
        let fi = Math.cos(ang) * (CONE - 3), fj = Math.sin(ang) * (CONE - 3);
        for (let s = 0; s < len; s++) {
          ang += (rng() - 0.5) * 0.34;
          fi += Math.cos(ang); fj += Math.sin(ang);
          const wide = rng() < 0.35 ? 1 : 0;
          for (let w = 0; w <= wide; w++) {
            const di = Math.round(fi) + (w ? Math.round(-Math.sin(ang)) : 0);
            const dj = Math.round(fj) + (w ? Math.round(Math.cos(ang)) : 0);
            if (Math.hypot(di, dj) > APRON - 1) continue;
            const c = patchColumn(parts.f, parts.i, parts.j, di, dj);
            const g = groundK(c);
            if (g < 6 || g >= D - 1) continue;
            const kF = g - 4;
            for (let k = kF; k < D; k++) {
              if (k > g && get(c, k) === ID.air) break;
              set(c, k, ID.air);
            }
            set(c, kF - 1, ID.obsidian);
            set(c, kF, ID.lava);
            molten.push(c, kF);
          }
        }
      }

      /**
       * Seal every fissure's sides, once all of them are cut.
       *
       * Doing it inline as each column was filled left leaks and the reason is
       * worth writing down: a fissure is cut four blocks below whatever the
       * *local* ground is, so two neighbouring columns of the same crack sit at
       * different layers wherever the ground steps by one. The lower of the two
       * then clears its slot straight through the higher one's lava layer,
       * after that layer has already been sealed and filled. Ordering cannot
       * fix it — either neighbour can be the lower one. Sweeping afterwards can.
       *
       * The other thing this catches is the cave pass, which ran two passes ago
       * and is allowed within 2.2 blocks of the surface: a passage can already
       * be sitting beside a slot cut four blocks down. Lava with an open side
       * does not stay a scar — it becomes a flow the first time the player
       * edits near it, and `Water._place` writes `ID.water` whatever the liquid
       * was, so what comes back is not even lava.
       */
      for (let m = 0; m < molten.length; m += 2) {
        const c = molten[m], k = molten[m + 1];
        if (get(c, k) !== ID.lava) continue;      // a later cut took this one
        if (get(c, k - 1) === ID.air || get(c, k - 1) === ID.water) set(c, k - 1, ID.obsidian);
        for (let nb = 0; nb < 4; nb++) {
          const s2 = colNeighbor(c, nb);
          const cur = get(s2, k);
          if (cur === ID.air || cur === ID.water) set(s2, k, ID.obsidian);
        }
      }
    }
  }

  /** Highest solid layer in a column, or -1. */
  surfaceK(blocks, col) {
    const base = col * D;
    for (let k = D - 1; k >= 0; k--) {
      const b = blocks[base + k];
      if (b !== ID.air && b !== ID.water) return k;
    }
    return -1;
  }

  /**
   * One column's tree, if it has one, clipped to a region.
   *
   * `rid` is the region whose cells are allowed to be written; a caller running
   * the decoration pass over a region's *margin* passes its own id, so a tree
   * standing five columns outside still drops the half of its canopy that
   * overhangs the region and nothing else. That is what makes a seam invisible
   * without any region ever writing into another one — see `decorateRegion`.
   */
  treeAt(blocks, col, rid) {
    const bi = this.colBiome[col];
    if (this.colSlope[col] > 1.5) return;
    // The gorge and its rim. See CANYON_TREE_THIN.
    const thin = CANYON_TREE_THIN[this.canyonNear[col]];
    if (thin <= 0) return;
    /**
     * The ground, from the height field — not `surfaceK`, and this is the one
     * subtle thing in the whole lazy scheme.
     *
     * `surfaceK` scans down for the first block that is not air, so under a
     * canopy it answers with the canopy. That was harmless when one global pass
     * grew every tree before any of them could be looked at. It is not harmless
     * now: a region's decoration pass runs over its neighbours' columns too, and
     * whether those neighbours have already grown their own trees depends
     * entirely on which region the player walked into first. Measured, it moved
     * four hundred voxels per nine regions — a tree that exists from one
     * approach and not from the other.
     *
     * The height field cannot disagree with itself. Nothing decoration places
     * ever sits at or below the ground layer, so `blocks[col * D + k]` is still
     * the real surface block, and the volcano — the one pass that does move the
     * ground — is always stamped before any of this runs.
     */
    const k = this.groundKOf(col);
    // need some headroom, but the land surface sits around k=40 of 66 — this
    // bound has to be generous or it rejects the entire planet
    if (k < 0 || k > D - 7) return;
    const surf = blocks[col * D + k];
    // Nothing grows out of a flooded cell.
    //
    // `stampTree` writes with `set()`, which skips a cell that is not air — so
    // on a desert shore whose sand top sits exactly one cell under the water
    // line, a cactus lost its *base* segment to the water and the rest landed
    // from k+2 upward: a cactus standing on the sea. It needs the 4% roll, the
    // parity, and precisely one cell of depth, so it is a handful of columns on
    // a planet — but a cactus is now a block that falls when nothing holds it
    // up, and generating one that is already unsupported is generating a lie
    // the physics will not agree with.
    //
    // Tested here rather than in `stampTree` because this is where a tree is
    // *decided*: a trunk has the same problem for the same reason, and one
    // guard covers every kind rather than one per stamp.
    // Liquid specifically, not "anything but air", which is what this said and
    // is the one thing it must not say.
    //
    // `treeAt` is run over the *margin* — columns belonging to neighbouring
    // regions — precisely so that a canopy overhanging a boundary is decided
    // the same way from both sides. That only works while it reads terrain and
    // nothing else, because terrain is written before any decoration anywhere.
    // `k + 1` is exactly the layer decoration lands in: a neighbour's leaves,
    // its grass, another trunk. So "is it air?" quietly became "has the region
    // next door been decorated yet?", and the answer depended on which way the
    // player walked in. Measured at 152 differing cells across four regions
    // generated forwards versus backwards — pines sliced off flat along a
    // straight boundary, which is what half a canopy missing looks like.
    //
    // Liquid is terrain, so testing for it keeps the guard doing its job — the
    // sand shore one cell under the water line that used to grow a cactus
    // standing on the sea — while leaving the answer a pure function of the
    // ground.
    const above = blocks[col * D + k + 1];
    if (above === ID.water || above === ID.lava) return;
    const rng = this.colRng(col, 0x7a11);

    let kind = null, chance = 0;
    // Podzol is a pine-forest floor block, so pines have to be allowed to
    // stand on it or the biome would thin out wherever it appears.
    if (surf === ID.grass || surf === ID.podzol) {
      if (bi === BIOME.FOREST) { kind = rng() < 0.68 ? 'oak' : 'birch'; chance = 0.115; }
      else if (bi === BIOME.PINE_FOREST) { kind = 'pine'; chance = 0.115; }
      else if (bi === BIOME.PLAINS) { kind = rng() < 0.6 ? 'oak' : 'birch'; chance = 0.014; }
      else if (bi === BIOME.MEADOW) { kind = 'birch'; chance = 0.03; }
      else if (bi === BIOME.SAVANNA) { kind = 'savanna'; chance = 0.022; }
      else if (bi === BIOME.MOUNTAIN) { kind = 'pine'; chance = 0.022; }
    } else if (bi === BIOME.TUNDRA && (surf === ID.dirt || surf === ID.snow || surf === ID.gravel)) {
      // Tundra is no longer a grass biome, so its pines have to be claimed by
      // biome rather than by surface block or it would come out treeless.
      // Sparse on purpose, and sparser than the number suggests: a pine's
      // canopy covers many columns, so tree *chance* and canopy *coverage*
      // are an order of magnitude apart. 0.026 closed the canopy over 55% of
      // the biome and read as taiga; 0.006 still gave 23%, level with plains
      // at less than half the chance. Tundra is where trees give up.
      kind = 'pine'; chance = 0.0018;
    } else if (surf === ID.snow) { kind = 'pine'; chance = 0.028; }
    else if (surf === ID.sand && bi === BIOME.DESERT) {
      // Cacti grow only on a checkerboard, which is what keeps two of them from
      // ever standing shoulder to shoulder.
      //
      // A cactus now refuses to be placed beside anything solid, and breaks if
      // something is built against it, so a desert that *generated* a pair
      // would be showing the player an arrangement they are not allowed to
      // make. At an independent 0.02 per column, roughly 2% of cacti had a
      // neighbour: rare enough never to be noticed in one desert, certain
      // across a planet.
      //
      // Parity rather than "ask the neighbour", because columns are generated
      // independently and in no guaranteed order — reading the neighbour's
      // blocks answers differently depending on which of the two was built
      // first, and re-deriving its roll means re-deriving its surface, biome
      // and thinning as well. Tangential neighbours always differ in
      // (i + j) parity, so a checkerboard cannot produce an adjacent pair and
      // needs to know nothing about anybody. The chance doubles to keep the
      // same number of cacti in the same desert, since half the columns are now
      // ineligible.
      //
      // Not perfect at a cube seam, where the two faces have their own i and j
      // and parity does not carry across: a pair can still meet exactly on a
      // seam line. That is a handful of columns on the whole planet against
      // 1.3 million, and the block rule handles them the moment anyone builds
      // there.
      const cp = colParts(col);
      if (((cp.i + cp.j) & 1) === 0) { kind = 'cactus'; chance = 0.04; }
    }

    if (!kind || rng() > chance * thin) return;
    this.stampTree(blocks, kind, col, k + 1, rng, rid);
  }

  /** One column's boulder, if it has one, clipped to a region. */
  boulderAt(blocks, col, rid) {
    const rng = this.colRng(col, 0xb0d1);
    if (rng() > 0.0022) return;
    // Same reason as `treeAt`: the ground, not whatever is standing on it.
    const k = this.groundKOf(col);
    if (k < 0 || k > D - 5) return;
    const surf = blocks[col * D + k];
    if (surf !== ID.grass && surf !== ID.stone && surf !== ID.snow) return;
    // A boulder is scenery, and a gorge floor already has rock lying about it.
    if (this.canyonNear[col] === 0) return;
    const rad = 1 + Math.floor(rng() * 2);
    const mossy = rng() < 0.4;
    const bp = colParts(col);
    for (let di = -rad; di <= rad; di++) {
      for (let dj = -rad; dj <= rad; dj++) {
        for (let dk = 0; dk <= rad; dk++) {
          if (di * di + dj * dj + dk * dk > rad * rad + 0.5) continue;
          // Same reason as the canopy below: a boulder is up to five columns
          // across and must not fold over a seam.
          const c = patchColumn(bp.f, bp.i, bp.j, di, dj);
          const kk = k + 1 + dk;
          if (kk >= D) continue;
          /**
           * One draw per candidate cell, before either test.
           *
           * The original only drew when the cell was air, which made the
           * stream's position depend on what was already standing there — and a
           * boulder at the edge of a region reaches cells in the next one along,
           * whose contents depend on whether that region has been decorated yet.
           * So the same boulder came out mossy approached from one side and bare
           * from the other. Drawing unconditionally makes the whole stream a
           * function of the column alone, which is the property the region
           * scheme needs and the only one it needs.
           */
          const id = mossy && rng() < 0.5 ? ID.moss_stone : ID.stone;
          if (rid >= 0 && regionOfCol(c) !== rid) continue;
          if (blocks[c * D + kk] !== ID.air) continue;
          blocks[c * D + kk] = id;
        }
      }
    }
  }

  stampTree(blocks, kind, col, k0, rng, rid = -1) {
    const set = (c, k, id, force = false) => {
      if (k < 0 || k >= D) return;
      if (rid >= 0 && regionOfCol(c) !== rid) return;
      const cur = blocks[c * D + k];
      if (cur === ID.air || force) blocks[c * D + k] = id;
    };
    // A canopy is three or four columns across, which is wide enough to care
    // which way is which. Walking the grid answers in the destination face's
    // frame, so a tree near a cube seam had leaves land on columns other leaves
    // had already claimed — up to 23 of a 49-column spread — and grew with a
    // bite out of one side. Trees away from a seam are untouched: the two
    // agree exactly whenever the canopy stays on one face.
    const tp = colParts(col);
    const at = (di, dj) => patchColumn(tp.f, tp.i, tp.j, di, dj);

    if (kind === 'cactus') {
      const h = 2 + Math.floor(rng() * 3);
      for (let n = 0; n < h; n++) set(col, k0 + n, ID.cactus);
      return;
    }

    const cfg = {
      // Trunks a little taller than they were. The crown hangs three courses
      // below its top, so a five-block trunk put leaves at knee height and the
      // tree read as a bush; these leave two or three clear blocks of trunk.
      oak: { h: [6, 8], log: ID.log_oak, leaf: ID.leaves_oak, rad: 2.6, shape: 'round' },
      birch: { h: [7, 10], log: ID.log_birch, leaf: ID.leaves_birch, rad: 2.2, shape: 'round' },
      pine: { h: [7, 11], log: ID.log_pine, leaf: ID.leaves_pine, rad: 3.0, shape: 'cone' },
      savanna: { h: [5, 7], log: ID.log_oak, leaf: ID.leaves_oak, rad: 3.3, shape: 'flat' },
    }[kind];

    // never let a canopy run off the top of the column
    const room = Math.max(3, D - 2 - k0 - Math.ceil(cfg.rad));
    const h = Math.min(room, cfg.h[0] + Math.floor(rng() * (cfg.h[1] - cfg.h[0] + 1)));
    for (let n = 0; n < h; n++) set(col, k0 + n, cfg.log, true);

    /**
     * A canopy as a stack of discs, one per layer, with the radius given as a
     * fraction of the tree's own.
     *
     * This replaced two overlapping spheres centred on the trunk. Measured on
     * real trees, that gave leaves per layer running 1, 8, 32, 46, 54, 58, 59,
     * 49, 14, 0 from the ground up — a mass that begins two blocks off the
     * ground, swallows the trunk, and then stops. Both ends of that are wrong:
     * a tree wants a visible trunk under it, and a crown that closes rather
     * than one that is cut off. A profile makes the silhouette something you
     * can read and tune directly instead of something that falls out of the
     * intersection of two spheres.
     *
     * `ragged` frays the rim; the interior is left solid so the canopy still
     * reads as a mass rather than as confetti.
     */
    const crown = (ckTop, profile, ragged) => {
      for (let n = 0; n < profile.length; n++) {
        const rad = cfg.rad * profile[n];
        if (rad <= 0) continue;
        const ri = Math.ceil(rad);
        const ck = ckTop - (profile.length - 1 - n);
        for (let di = -ri; di <= ri; di++) {
          for (let dj = -ri; dj <= ri; dj++) {
            const d = Math.hypot(di, dj);
            if (d > rad + (rng() - 0.5) * ragged) continue;
            if (d > rad * 0.72 && rng() < ragged * 0.5) continue;
            set(at(di, dj), ck, cfg.leaf);
          }
        }
      }
    };

    const top = k0 + h - 1;
    if (cfg.shape === 'cone') {
      const levels = Math.floor(h * 0.65);
      for (let l = 0; l <= levels; l++) {
        const t = l / levels;
        const rad = cfg.rad * (1 - t * 0.82) + 0.4;
        const ri = Math.ceil(rad);
        for (let di = -ri; di <= ri; di++)
          for (let dj = -ri; dj <= ri; dj++) {
            if (Math.hypot(di, dj) > rad) continue;
            set(at(di, dj), top - l, cfg.leaf);
          }
      }
      set(col, top + 1, cfg.leaf);
    } else if (cfg.shape === 'flat') {
      const ri = Math.ceil(cfg.rad);
      for (let dk = 0; dk <= 1; dk++)
        for (let di = -ri; di <= ri; di++)
          for (let dj = -ri; dj <= ri; dj++) {
            if (Math.hypot(di, dj) > cfg.rad - dk * 0.8) continue;
            if (rng() < 0.15) continue;
            set(at(di, dj), top + dk, cfg.leaf);
          }
    } else {
      // Bottom to top: a narrow skirt, two full courses, then a rounded crown
      // that closes over the trunk. The last entry is what stops the tree
      // ending in a flat lid.
      crown(top + 2, [0.55, 0.85, 1.0, 1.0, 0.78, 0.42], 0.9);
    }
  }

  /**
   * Ground cover for one column. Writes only into this column, so unlike trees
   * and boulders it needs no clipping — but it does have to run *after* every
   * tree that can reach here, because `surfaceK` under a canopy is the canopy.
   */
  floraAt(blocks, col) {
    const k = this.surfaceK(blocks, col);
    if (k < 0 || k >= D - 2) return;
    const base = col * D;
    const surf = blocks[base + k];
    if (blocks[base + k + 1] !== ID.air) return;

    const n = this.nBiome;
    const dir = _fillDir;
    this._dirOf(col, dir);
    const bi = this.colBiome[col];
    const rng = this.colRng(col, 0xf10a);
    const inCanyon = this.canyonNear[col] === 0;

    if (surf === ID.grass) {
      const dens = n.fbm3(dir[0] * 9, dir[1] * 9, dir[2] * 9, 3, 2, 0.5) * 0.5 + 0.5;
      const p = 0.12 + dens * 0.55;
      const h = rng();
      if (h < p * 0.72) blocks[base + k + 1] = ID.tall_grass;
      else if (h < p * 0.82) {
        const c = rng();
        blocks[base + k + 1] = c < 0.34 ? ID.flower_red : c < 0.67 ? ID.flower_gold : ID.flower_blue;
      } else if (h < p * 0.84 && (bi === BIOME.FOREST || bi === BIOME.MEADOW)) {
        blocks[base + k + 1] = ID.pumpkin;
      }
    } else if (inCanyon && (surf === ID.coarse_dirt || surf === ID.gravel || surf === ID.red_sand)) {
      // The other half of the canyon rule. Taking the trees away and leaving
      // it at that gives a bare stone trench, which reads as unfinished rather
      // than as dry — so the floor keeps a thin scatter of grass and the odd
      // flower on whatever the canyon re-surfaced it with. Sparse enough to see
      // the ground through, which is the point: what makes a gorge legible is
      // the strata in its walls and the shadow on its floor, and both survive
      // scrub where neither survives a canopy.
      const h = rng();
      if (h < 0.11) blocks[base + k + 1] = ID.tall_grass;
      else if (h < 0.125) {
        blocks[base + k + 1] = rng() < 0.5 ? ID.flower_gold : ID.flower_red;
      }
    }

    // cave mushrooms: look for open pockets under the surface
    for (let kk = 2; kk < k - 2; kk++) {
      if (blocks[base + kk] === ID.air && CARVEABLE[blocks[base + kk - 1]]
        && rng() < 0.006) {
        blocks[base + kk] = ID.mushroom;
      }
    }
  }

  /**
   * Everything that stands *on* the ground, for one region.
   *
   * This is the only pass that cannot be done a column at a time, and the whole
   * seam problem lives here. A canopy is up to four columns wide, so a tree in
   * the next region along owns cells in this one, and a region that only grew
   * its own trees would come out with a straight edge of missing leaves down
   * every boundary.
   *
   * The fix is to grow the neighbours' trees too and throw away everything they
   * put outside us. `margin` is this region's columns dilated by
   * DECOR_MARGIN over the column graph — far enough that no tree outside it can
   * reach in — walked in ascending column order, which is the order the old
   * planet-wide loop walked in. So every cell inside the region sees exactly
   * the set of trees, in exactly the order, that a single global pass would
   * have given it. Nothing is written outside the region, no region depends on
   * another having been decorated, and the result does not depend on which
   * region was built first. It costs 2.6x the tree work for the overlap, which
   * against the terrain pass is nothing.
   *
   * The alternative — let a tree write across the boundary and hope the
   * neighbour has been filled — was the obvious approach and it is unsound in
   * both directions: write into an ungenerated neighbour and the terrain pass
   * overwrites the leaves when it eventually runs, write into a decorated one
   * and the answer depends on who went first.
   *
   * Trees, then boulders, then flora, each as a complete sweep. That is the
   * order the three passes ran in globally and they interact: a boulder is only
   * laid in air, and flora reads the surface a canopy may have raised.
   */
  decorateRegion(blocks, cols, margin) {
    const rid = regionOfCol(cols[0]);
    for (let n = 0; n < margin.length; n++) this.treeAt(blocks, margin[n], rid);
    for (let n = 0; n < margin.length; n++) this.boulderAt(blocks, margin[n], rid);
    for (let n = 0; n < cols.length; n++) this.floraAt(blocks, cols[n]);
  }
}
