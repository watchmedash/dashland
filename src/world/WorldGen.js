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
import { ID, N_BLOCKS, supports } from './Blocks.js';
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

/**
 * Aquifers: water that lives in the rock rather than on top of it.
 *
 * The band is the limestone one and a little either side of it, because that
 * is the rock a cavern belongs in and because it is where a player digging
 * straight down first meets something that is not dirt. In absolute terms it is
 * roughly 268..279, which under ordinary land (h around 283) is six to fifteen
 * blocks below the surface — deep enough that the roof is never a skylight,
 * shallow enough to be found by digging rather than by spelunking.
 *
 * The lens is a two-octave field sampled on the *direction* alone, so an
 * aquifer is a broad flat sheet rather than a ball: one field says where, a
 * second says how deep the middle of it sits, and the amount by which the first
 * clears its threshold says how thick it is there. Sampling a 3D field at the
 * voxel's own position instead gives isolated blobs a block or two across
 * scattered through the crust, which is not an aquifer and reads as generator
 * noise. Low frequency for the same reason: 5.5 over a unit sphere is a feature
 * about fifty columns across, so one aquifer is a place you can swim along.
 *
 * AQ_ROOF is the one number the enclosure argument rests on — see
 * `_aqRecord`, which takes it against the *minimum* of the column's own height
 * and its four neighbours'.
 */
const AQ_LO = BAND_LIMESTONE - 3.0;
const AQ_HI = BAND_STONE + 1.5;
const AQ_MID = (AQ_LO + AQ_HI) * 0.5;
const AQ_ROOF = 6;             // blocks of rock that must stand over the top cell
const AQ_THR = 0.42;           // lens field cutoff — how much of the planet has one
/**
 * 18 and not the 13 first tried. The lens field only just clears its cutoff
 * over most of the ground it claims, so the thickness is dominated by the
 * multiplier and not by the cap: at 13 the mean aquifer was two blocks deep and
 * only a sixth of its cells were roomy enough to be given an air pocket, which
 * is a wet seam rather than somewhere to swim.
 */
const AQ_THICK = 18;           // blocks of lens per unit of field over the cutoff
const AQ_MAX_THICK = 7;
const AQ_AIR = 2;              // layers of air left under the roof, at most
/**
 * The layer window the pass touches, one guard layer wider than the band on
 * each side. The guard is not decoration: the seal has to be able to write the
 * cell directly above the topmost water and directly below the lowest, and
 * those can only fall outside the window if the window is exactly the band.
 */
const AQ_K0 = Math.max(1, Math.floor(AQ_LO - R_MIN - 0.5) - 1);
const AQ_K1 = Math.min(D - 2, Math.ceil(AQ_HI - R_MIN - 0.5) + 1);

/**
 * Hot springs. Small, rare, and deliberately on a lattice.
 *
 * A pool is three columns across, so whether a column is inside one is a
 * question every other decoration pass has to be able to answer — a tree
 * standing in the water is exactly the kind of thing a region boundary makes
 * inconsistent. Answering it by searching the neighbourhood for a spring means
 * evaluating the whole spring test for forty-nine columns per column, per
 * region, over the margin as well. Restricting centres to one column in
 * SPRING_LATTICE^2 makes the search O(1): a seven-wide window contains at most
 * one column congruent to SPRING_LI, so there is at most one candidate to test.
 *
 * The cost is that spring positions are quantised to an eight-column grid,
 * which nobody can see at a density of one per several thousand candidates.
 */
const SPRING_LATTICE = 8;
const SPRING_LI = 3;
const SPRING_LJ = 5;
const SPRING_R = 2.6;          // rim radius, in columns
const SPRING_RI = 1.6;         // water radius — every 4-neighbour of a water
const SPRING_CHANCE = 0.085;   // column is therefore inside the rim
const SPRING_BIOMES = [BIOME.SNOW, BIOME.TUNDRA, BIOME.MOUNTAIN];

/**
 * Fallen logs: a windfall lying on the forest floor.
 *
 * On a lattice, for exactly the reason the hot springs are (see SPRING_LATTICE),
 * and then for a second reason of its own. A run is up to seven columns long, so
 * without a lattice every column on the planet would have to evaluate a
 * seven-cell run — seven ground tests, seven tree decisions, seven 5x5 boulder
 * sweeps — to find out that it does not have a log. One column in
 * LOG_LATTICE^2 is a candidate, so that work happens for 1.5% of columns and the
 * minimum separation between two windfalls is eight columns, which makes an
 * overlapping pair impossible without anybody asking about anybody.
 *
 * The run is *centred* on its candidate column rather than starting there, and
 * that is a correctness constraint rather than a cosmetic one. DECOR_MARGIN is
 * 6: a feature may not reach further than six columns from the column that
 * decides it, and — less obviously — may not *read* further than that either,
 * because terrain is only guaranteed to exist over the margin. A centred run of
 * seven reaches three, and the boulder sweep two past the end of it, for a total
 * read radius of five. A run that started at its candidate would reach six and
 * read eight, and the two columns past the margin would be whatever the block
 * array happened to be holding — air in an ungenerated region, real ground in a
 * generated one, which is a decision that depends on where the player walked in.
 */
const LOG_LATTICE = 8;
const LOG_LI = 6;
const LOG_LJ = 2;
const LOG_MIN = 3;
const LOG_MAX = 7;
/**
 * How likely a candidate column carries one, by biome.
 *
 * Against a standing tree's 0.115 per column in a wood, 0.62 per candidate is
 * 0.62/64 = 0.0097 per column: one windfall for every twelve trees, which is
 * something you come across on a walk rather than something you have to look
 * for. The open biomes are much lower because the trees there are, too — a log
 * in a meadow should read as the one tree that used to be there.
 */
const LOG_CHANCE = [];
LOG_CHANCE[BIOME.FOREST] = 0.62;
LOG_CHANCE[BIOME.PINE_FOREST] = 0.62;
LOG_CHANCE[BIOME.MEADOW] = 0.16;
LOG_CHANCE[BIOME.PLAINS] = 0.09;
/**
 * What a log will lie on. Every one of these is solid, which is the whole point:
 * the fallen-log ids carry no `needsFloor`, so an unsupported one simply hangs
 * in the air and nothing downstream will ever take it down.
 */
const LOG_FLOOR = new Uint8Array(N_BLOCKS);
for (const n of ['grass', 'podzol', 'dirt', 'coarse_dirt', 'moss_block', 'snow']) LOG_FLOOR[ID[n]] = 1;
/** The two ids per species, indexed [axis 0:i 1:j]. */
const LOG_IDS = {
  oak: [ID.log_oak_i, ID.log_oak_j],
  birch: [ID.log_birch_i, ID.log_birch_j],
  pine: [ID.log_pine_i, ID.log_pine_j],
};

/** Shared scratch for the per-column passes — they are called a million times. */
const _fillDir = [0, 0, 0];
/** Aquifers and springs get their own, because they run inside the others. */
const _aqDir = [0, 0, 0];
const _spParts = { f: 0, i: 0, j: 0 };
/**
 * Two more for the fallen logs, and they have to be two. The log pass holds a
 * candidate's coordinates across a loop that calls `_springNear` — which owns
 * `_spParts` — and inside that loop walks a second column's neighbourhood.
 * Sharing any of the three would rewrite the centre halfway through the run.
 */
const _logParts = { f: 0, i: 0, j: 0 };
const _logNb = { f: 0, i: 0, j: 0 };

/**
 * Inland lakes.
 *
 * Until this pass the only standing water on the planet was the ocean and the
 * two canyons that breach it, which is why every body of water read the same:
 * they were all literally the same water, at the same altitude, over the same
 * depth-graded seabed. A lake is the opposite proposition — a small, closed
 * surface at whatever altitude the ground around it happens to sit at, with a
 * bed and a bank that belong to the country it is in rather than to the sea.
 *
 * Four kinds, and they are meant to be told apart at a glance and from a
 * distance: a POND is a round, waist-to-chest-deep bowl of mud and clay with a
 * mossy bank and sometimes an islet in it; a TARN is small, near-cylindrical
 * and deep, cut into gravel and slate high on a mountain; a MARSH is wide,
 * ankle-deep, ragged at the edge, and floored with peat; an OASIS is a rare
 * pocket of sand and water in a desert, and is the one worth walking to.
 *
 * Candidates sit on a lattice, like the hot springs and the fallen logs, for
 * the same reason and for one more. The same reason: it turns "is there a lake
 * near this column" from a search into arithmetic. The one more: LAKE_LATTICE
 * is greater than twice the largest disc plus its guard ring, so two lakes can
 * never touch, and the containment argument below never has to consider a
 * second lake having moved the ground under this one's rim.
 */
const LAKE_LATTICE = 26;
const LAKE_LI = 11;
const LAKE_LJ = 17;
/** Kinds. The low three bits of `lakeKind`; the two flags live above them. */
const LAKE_POND = 1;
const LAKE_TARN = 2;
const LAKE_MARSH = 3;
const LAKE_OASIS = 4;
/** Bank rather than bed: not carved, re-surfaced, and never holds water. */
const LAKE_SHORE = 0x80;
/** Bed raised back above the waterline: an islet in a large pond. */
const LAKE_ISLE = 0x40;
/**
 * The hard ceiling on the wobbled radius. Everything else is pinned to it:
 * LAKE_LATTICE is 2 * (this + 1 guard column) rounded up, LAKE_EDGE keeps a
 * whole disc on one face, and LAKE_BFS is the L1 radius that provably contains
 * a Euclidean disc of this size — L1 distance is what the column graph
 * measures, and a diamond of radius r only reaches r/sqrt(2) on the diagonal.
 */
const LAKE_MAX_R = 11.5;
const LAKE_EDGE = 16;
const LAKE_BFS = Math.ceil((LAKE_MAX_R + 2.5) * Math.SQRT2) + 1;
const LAKE_DISC_MAX = 2 * LAKE_BFS * LAKE_BFS + 2 * LAKE_BFS + 1 + 64;
/**
 * Columns per radian. The mapping is equi-angular along a face axis — see
 * Sphere.js — so a column is exactly pi/(2F) of arc there, and within about
 * 15% of it anywhere else on the face. That is what lets the profile be taken
 * from real angular distance instead of from graph distance: graph distance is
 * L1, and a lake shaped by an L1 radius comes out a diamond.
 */
const LAKE_COL_PER_RAD = 2 * F / Math.PI;
/**
 * Freeboard: how far the water surface sits below the *lowest* column of the
 * ring that touches the lake.
 *
 * This is the whole containment argument, and it is structural rather than
 * checked. Worldgen liquid is a permanent source (see Water.js
 * `_seedWaterRegion`) — a lake with one cell of leak does not find a level, it
 * pours into whatever it found forever. So the surface is defined *from* the
 * ring: take the minimum ground height over every column that is a tangential
 * neighbour of a carved column, and put the water 0.8 below it. Every one of
 * those columns is then, by construction, solid rock at and below the water's
 * own layers, and no test after the fact is needed or trusted.
 */
const LAKE_FREEBOARD = 0.8;
/**
 * Blocks of clearance a cave must leave under a lake's *surface*, in the bed
 * and in the ring alike.
 *
 * The ordinary rule (`skin`, 2.2 blocks under the ground) is not enough here
 * and the failure is one-sided in the worst way: a ring column stands only
 * LAKE_FREEBOARD over the surface, so a cave in it may open 2.2 below its own
 * ground — which is above the lake's floor — and the lake drains sideways into
 * the cave system. This is the deepest lake plus that same 2.2 and a little
 * over, so no cave can reach the water from any direction.
 */
const LAKE_CAVE_CLEAR = 11;
/** Per kind, indexed by the id: [rMin, rMax], [depthMin, depthMax]. */
const LAKE_R = [];
const LAKE_DEPTH = [];
/** Outline wobble: two octaves of simplex on the direction, as a fraction. */
const LAKE_WOBBLE = [];
/** How rough the bed is, in blocks. */
const LAKE_BED_ROUGH = [];
/** Which biomes host it, how likely a candidate takes, and how flat it needs. */
const LAKE_CHANCE = [];
const LAKE_TOL = [];
const LAKE_MIN_ALT = [];
/**
 * The one that decides whether a site is a lake or an excavation: how much
 * ground, per column of bed and averaged over it, stood above the finished
 * waterline and therefore had to be cut away.
 *
 * It replaced two tests that both looked more obvious and were both useless.
 * The relief over the disc throws out a hollow, which is the best possible
 * site. And the *fraction* of the bed standing above the water is about 0.95
 * everywhere, on flat ground included — necessarily, because the waterline is
 * set from the lowest column of the rim, so almost everything is above it by
 * definition. Averaging the depth of the cut instead has a floor of roughly
 * 1.3 on perfectly level ground (the freeboard plus how far the rim's minimum
 * sits under its mean) and climbs from there with the slope, which is exactly
 * the quantity being asked about.
 */
const LAKE_CUT = [];
/*
 * LAKE_MIN_ALT is barely above the waterline for the three lowland kinds, and
 * that is measured rather than slack. The height field flattens low ground
 * toward the sea, and the biome classifier hands everything above about
 * R_SEA + 5 to Mountain or Snow — so Plains, Forest, Meadow, Savanna, Tundra,
 * Desert and Badlands all live in a five-block band over sea level, with a
 * median of about two. A floor of R_SEA + 4, which looks conservative, rejected
 * 84 of 100 candidates outright and left the planet with four lakes on it, all
 * of them tarns.
 *
 * Nothing is lost by dropping it, because altitude was never what held a lake
 * in: the ring does, at whatever height the ring happens to be. What keeps a
 * lake away from the sea is the `submerged` and shore-distance tests, which
 * say what they mean. The floor here only stops a "lake" being cut into ground
 * that is already under the waterline.
 */
LAKE_R[LAKE_POND] = [4.5, 8.5];
LAKE_DEPTH[LAKE_POND] = [2.6, 4.2];
LAKE_WOBBLE[LAKE_POND] = [0.18, 0.09];
LAKE_BED_ROUGH[LAKE_POND] = 0.5;
LAKE_CHANCE[LAKE_POND] = 0.9;
LAKE_TOL[LAKE_POND] = 6.0;
LAKE_CUT[LAKE_POND] = 2.0;
LAKE_MIN_ALT[LAKE_POND] = R_SEA - 0.25;
LAKE_R[LAKE_TARN] = [3, 5];
LAKE_DEPTH[LAKE_TARN] = [4.5, 7.5];
LAKE_WOBBLE[LAKE_TARN] = [0.10, 0.05];
LAKE_BED_ROUGH[LAKE_TARN] = 0.8;
LAKE_CHANCE[LAKE_TARN] = 0.55;
// Mountains are not flat and a tarn is not owed one — it wants a corrie, which
// is uneven by definition. The rim rule keeps it honest whatever the ground
// does, so this is only here to throw out a cliff face.
LAKE_TOL[LAKE_TARN] = 9.0;
LAKE_CUT[LAKE_TARN] = 3.2;
LAKE_MIN_ALT[LAKE_TARN] = R_SEA + 9;
LAKE_R[LAKE_MARSH] = [6.5, 9.5];
LAKE_DEPTH[LAKE_MARSH] = [1.7, 2.3];
LAKE_WOBBLE[LAKE_MARSH] = [0.26, 0.12];
LAKE_BED_ROUGH[LAKE_MARSH] = 0.35;
LAKE_CHANCE[LAKE_MARSH] = 0.85;
LAKE_TOL[LAKE_MARSH] = 5.0;
LAKE_CUT[LAKE_MARSH] = 2.0;
LAKE_MIN_ALT[LAKE_MARSH] = R_SEA - 0.25;
LAKE_R[LAKE_OASIS] = [3, 4.5];
LAKE_DEPTH[LAKE_OASIS] = [2.2, 3.2];
LAKE_WOBBLE[LAKE_OASIS] = [0.14, 0.07];
LAKE_BED_ROUGH[LAKE_OASIS] = 0.3;
// Rare on purpose. A desert with a pool every few hundred metres is not a
// desert, and the whole value of an oasis is that finding one is an event.
LAKE_CHANCE[LAKE_OASIS] = 0.45;
LAKE_TOL[LAKE_OASIS] = 5.0;
LAKE_CUT[LAKE_OASIS] = 2.0;
LAKE_MIN_ALT[LAKE_OASIS] = R_SEA - 0.25;
/** The least water a site has to hold to be worth being a lake at all. */
const LAKE_MIN_DEPTH = 1.5;
const LAKE_MIN_CELLS = 8;

/** Scratch for the lake pass. It runs once, planet-wide, before any voxel. */
const _lakeDir = [0, 0, 0];
const _lakeCtr = [0, 0, 0];
const _lakeParts = { f: 0, i: 0, j: 0 };

/**
 * The reef.
 *
 * Two passes, and they are deliberately different shapes because the things
 * they grow are different things. A reef is a *place* — a bank of coral thirty
 * or forty columns across with a grass skirt round it, which you either swim
 * into or you do not — so it comes from a lattice of candidate centres like the
 * hot springs and the fallen logs. Sea grass and kelp are *cover*, the
 * underwater equivalent of tall grass, so they come from a per-column roll
 * modulated by a noise field and they run everywhere the water will take them,
 * reefs included. Scattering coral the way flora is scattered was the first
 * thing tried and it reads as confetti: every column of the shelf with one
 * lonely head on it and nothing that looks like a reef.
 *
 * Everything both passes decide is read off the terrain tables (`colHeight`,
 * `colBiome`, `submerged`, `lakeSurf`) and the column's own `colRng`, never off
 * what is already standing in the block array — the rule `decorateRegion`
 * exists to enforce. The one block read is the floor cell itself, which is
 * terrain by construction.
 *
 * --- the two rules that are not taste ------------------------------------
 *
 * `floorK` is the topmost solid cell of the column and `topK` the topmost
 * *water* cell. A prop goes at `floorK + 1` and must satisfy `k < topK`: the
 * topmost water cell of a column owns that column's sea-surface quad, and
 * anything standing in it punches a visible hole through the surface of the
 * ocean. So a reef prop needs two cells of water over the floor, and a kelp
 * stalk of `n` needs `n + 1`. This is the same rule `main.js` enforces on the
 * player's own placement path, and it is the reason REEF_DEPTH_MIN is 2 rather
 * than 1 — the depth band and the topK test have to agree or the shallow rim of
 * every reef would be rolled and then thrown away.
 */
const REEF_LATTICE = 8;
const REEF_LI = 1;
const REEF_LJ = 4;
/**
 * The ocean's topmost water cell, which is the same layer on every column of
 * the planet: cell `k` is centred at `R_MIN + k + 0.5` and water is every cell
 * whose centre is at or under R_SEA, so it is one number and not a search.
 * Deriving it from the constants rather than scanning the block array for the
 * last `ID.water` is not an optimisation — a scan would be reading the column
 * *after* an earlier pass may have written into it.
 */
const SEA_TOP_K = Math.floor(R_SEA - R_MIN - 0.5);
/** Depth below the waterline of the floor cell whose layer is `k`. */
const depthOfK = (k) => R_SEA - (R_MIN + k + 0.5);
/**
 * A reef's radius, in columns.
 *
 * Capped under half the lattice on purpose: 2 x 3.4 < 8, so two candidates can
 * never claim the same column and a reef is never a decision about which of two
 * overlapping discs went first. Two adjacent candidates that both fire come out
 * as two heads nearly touching, which is what makes a bank rather than a blob.
 *
 * Worst-case reach is 3 columns from the candidate — the largest `|di|` with
 * `hypot(di, dj) <= 3.4` — against DECOR_MARGIN's 6, and the pass reads nothing
 * further than it writes: every column of the disc is tested from its own
 * tables and its own floor cell. There is no sweep of a neighbourhood anywhere
 * in it, which is the mistake the fallen logs made.
 *
 * The upper end is also what the *bathymetry* will take. `oceanDepthAt` puts
 * the whole 2..12 band inside about eleven columns of continental slope, so a
 * disc much wider than this has half of itself out of the band whatever it does
 * and comes apart into fragments. Measured at radius 3.9 the median reef was
 * two columns; at 3.4 it is eleven.
 */
const REEF_R_MIN = 2.6;
const REEF_R_MAX = 3.4;
/** How many lattice candidates in warm water actually carry a reef. */
const REEF_CHANCE = 0.55;
/**
 * The depth band, in blocks below R_SEA, measured to the floor cell's centre.
 *
 * 2 was the shallowest a prop can stand without owning the surface quad, and
 * the band ran to 12 — so measured in the running game the whole distribution
 * sat between 2 and 11 and peaked at 5. That is the shelf you can stand on and
 * see the bottom of, which is exactly the complaint: a reef you meet by wading
 * is not something you dive for.
 *
 * 5 to 16 instead. The floor is deep enough that a reef is under the surface
 * rather than beside it, and 16 is against the real bathymetry — the ocean
 * bottoms out at R_SEA - R_SEABED_MIN = 17 — so the band now reaches the foot
 * of the slope instead of stopping a third of the way down it. The shallow
 * limit stays a limit for the surface-quad reason, it just is not the one
 * doing the work any more.
 */
const REEF_DEPTH_MIN = 5.0;
const REEF_DEPTH_MAX = 16.0;
/**
 * Where reefs are, as a function of the seabed temperature term.
 *
 * `_seaTemp` is the *same* expression `fillColumn` uses to decide whether a
 * shallow is polar, temperate or warm — factored out rather than copied, so a
 * reef cannot end up on a climate the ground it stands on disagrees with.
 * 0.45 is exactly `fillColumn`'s "warm sea" threshold, the one that lays pale
 * sand and moss; reefs fade in from 0.30 so the edge of a reef province is a
 * thinning rather than a line, and are at full strength by 0.80.
 */
const REEF_TEMP_MIN = 0.30;
const REEF_TEMP_FULL = 0.80;
/**
 * The clam, and therefore the pearl economy.
 *
 * `sea_shell` is the only source of `pearl` in the game, so this number is not a
 * scatter rate, it is a drop rate. Per reef column, before the falloff — a reef
 * of ~40 valid columns carries about one, so a pearl is a thing you find by
 * swimming into a reef and looking, not a thing you farm. See the harness
 * numbers in the report for what it comes to planet-wide.
 */
const REEF_SHELL = 0.055;
/** One coral head in five is bleached, so a reef is not uniformly bright. */
const REEF_DEAD = 0.20;
/**
 * Sea grass and kelp: cover rather than landmark.
 *
 * A wider depth band than the coral and a much wider climate one — grass grows
 * anywhere that is not polar, kelp likes it *cool*, which is why its window is
 * the other way up from the coral's and overlaps it only at the edges. A kelp
 * forest off a temperate coast and a coral bank off a tropical one are then two
 * different places rather than the same place twice.
 */
const SEAB_DEPTH_MIN = 1.5;
const SEAB_DEPTH_MAX = 13.0;
const GRASS_TEMP_MIN = -0.05;
const KELP_TEMP_MIN = -0.10;
const KELP_TEMP_MAX = 0.62;
/** Kelp needs headroom: `n` segments want `n + 1` cells of water. */
const KELP_MIN = 3;
const KELP_MAX = 8;
/**
 * Peak per-column odds, at the centre of a patch of the density field. Both are
 * multiplied by a smoothed fbm raised to a power, so the mean is far lower than
 * this and the cover comes in meadows instead of an even dusting.
 */
const GRASS_PEAK = 0.62;
const KELP_PEAK = 0.34;
/**
 * Fresh water gets weed, and only weed.
 *
 * Kelp and sea grass in a pond or a marsh is a reasonable reading of what those
 * blocks are; coral, sponges and a giant clam in one are not, so the reef pass
 * refuses lakes outright and this pass takes only the two plants. A tarn is out
 * as well — it is scoured rock at altitude, and the one lake kind whose bed has
 * no soil on it at all. An oasis is out because a desert spring is not a weed
 * bed. The `topK` rule matters more here than in the sea, not less: a lake's
 * surface cell owns its own surface quad exactly as the ocean's does, and a
 * marsh is ankle-deep, so most marsh columns have one cell of water and take
 * nothing.
 */
const LAKE_WEED = new Uint8Array(8);
// Empty on purpose. Sea grass and kelp were allowed in ponds and marshes on the
// reasoning that freshwater weed is a real thing — but in play they read as the
// reef having leaked inland: the player's report was "the corals even appear in
// lakes", and measurement said no coral ever had. It was these, 20 cells of
// them above sea level, and the eye does not sort a strand of sea grass from a
// coral at a glance. Both entries stay written out rather than deleted so the
// next person can see this was decided rather than never considered.
//
// LAKE_WEED[LAKE_POND] = 1;
// LAKE_WEED[LAKE_MARSH] = 1;

/** Scratch for the two reef passes. Neither nests inside anything. */
const _reefDir = [0, 0, 0];
const _reefParts = { f: 0, i: 0, j: 0 };

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
 *
 * It is also a bound on how far a pass may *read*, not only on how far it may
 * write: terrain is only guaranteed to exist over the margin, and reading past
 * it gets air in an ungenerated region and real ground in a generated one. The
 * fallen logs are sized against that — a centred run of seven reaches three and
 * its boulder sweep two further, for five. See LOG_LATTICE.
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
    this.nAq = new Noise(seed + 606);
    this.nLake = new Noise(seed + 707);
    /**
     * Water surface radius per column, 0 where there is no lake — see
     * `carveLakes`. A Float32Array(COLUMNS) is 5 MB resident, which is real
     * money and is spent knowingly: it is read by the fill loop, by the cave
     * carve and by four decoration passes, all of which run per column and in
     * no particular order, so there is nowhere cheaper to keep it. Against the
     * 770 MB voxel field it is under a percent.
     *
     * Set on the bed *and* on the ring of columns that touch it. A ring column
     * stands above the surface by construction, so the fill loop's water test
     * is simply never true there — but the cave carve needs to know.
     */
    this.lakeSurf = null;
    /** Kind, plus the shore and islet flags. See LAKE_POND and friends. */
    this.lakeKind = null;
    /**
     * One packed aquifer record per column, built on demand.
     *
     * Four bytes: computed flag, first water layer, last layer, first air
     * layer (255 for none). Empty is encoded as bot > top. A flat array rather
     * than a Map because every column asks for its four neighbours' records as
     * well as its own — the hit rate is 80% and a Map's overhead per entry is
     * twenty times the record. 5 MB against a voxel field of 770.
     */
    this._aq = null;
    /** Spring centres, keyed by column. Only lattice columns are ever asked. */
    this._spring = new Map();
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

    // ---- inland lakes ------------------------------------------------------
    // After the flood fill and the canyons, and before the slope — deliberately
    // in that order. After, because a lake refuses any site the sea or a gorge
    // has already claimed, and both of those are only settled by then. Before,
    // because slope is derived from the finished height field a few lines down:
    // carving afterwards would leave every lake's bank claiming to be flat,
    // and the flatness of a bank is what several later passes decide on.
    onProgress(0.95, 'Filling the lakes');
    this.carveLakes(colHeight, colBiome, canyonMask, submerged, shoreDist);

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
      // Nor standing in a lake: the spawn test reads the height field, which
      // after the lake pass describes the bed rather than the water over it.
      if (this.lakeKind[col]) continue;
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
   * Is this column inside a lake — the carved basin, not its bank?
   *
   * Every decoration pass asks this, and asks it of the *tables* rather than
   * of the blocks, for the reason spelled out in `_treeKind`: a pass that
   * looked at what was standing in the cell above the ground would be asking
   * whether the region next door had been decorated yet.
   *
   * Most of the work is already done for free — a bed column's ground is under
   * water, and trees, logs and flora all refuse liquid — but the margin of a
   * lake can come out dry, and a dry patch of clay is not somewhere a pine
   * should be standing. The bank is deliberately *not* covered: a tree leaning
   * over the water is exactly what a lakeside should look like, and a canopy
   * cannot displace water because leaves are only laid into air.
   */
  inLakeBed(col) {
    const lk = this.lakeKind;
    return lk !== null && lk[col] !== 0 && (lk[col] & LAKE_SHORE) === 0;
  }

  /**
   * The climate of a piece of seabed, from a unit direction through it.
   *
   * This is the temperature term of the biome climate and nothing else — the
   * latitude ramp plus the same low-frequency wobble that makes the biome map
   * ragged — recomputed on demand rather than stored, because a
   * Float32Array(COLUMNS) would be 5 MB resident for a value only submerged
   * columns ever ask for.
   *
   * It lives here, out of `fillColumn`'s ocean case, because the reef passes
   * need the identical number. Two expressions that agree today and are edited
   * separately tomorrow is how you get coral growing on polar gravel: the
   * ground would say one climate and the thing standing on it another.
   */
  _seaTemp(dir) {
    return 1 - Math.abs(dir[1]) * 1.35
      + this.nBiome.fbm3(dir[0] * 2.2, dir[1] * 2.2, dir[2] * 2.2, 3, 2, 0.5) * 0.45;
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
    const {
      colHeight, colBiome, colSlope, canyonMask, shoreDist, submerged,
      lakeSurf, lakeKind,
    } = this;
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
        const temp = this._seaTemp(dir);
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

    /**
     * A lake bed and its bank, last, so nothing above can repaint them.
     *
     * Last and not earlier for two specific reasons. The `rocky` rule fires on
     * slope, and the wall of a tarn is the steepest ground on the planet — it
     * would turn every deep lake into a bare stone hole. And the beach rule
     * fires on altitude near the waterline, which a low pond can land in.
     *
     * The bed of each kind is a different material and so is its bank, because
     * that is most of what tells them apart from the shore: mud and clay under
     * a mossy bank for a pond, gravel and slate for a tarn, peat for a marsh,
     * sand for an oasis. The bank is deliberately left partly as whatever the
     * biome wears, so it reads as ground that got wet rather than as a painted
     * ring — and where the biome's own grass survives, the flora pass grows
     * tall grass on it, which is the reed line.
     */
    const lk = lakeKind[col];
    if (lk) {
      const kind = lk & 7;
      const grit = this.colRng(col, 0x4a6d)();
      if (lk & LAKE_ISLE) {
        // An islet. Real ground, standing out of the water — so it wears the
        // land's own coat rather than the lake's, with a mossy fringe.
        top = grit < 0.22 ? ID.moss_block : (bi === BIOME.DESERT ? ID.sand : ID.grass);
        sub = bi === BIOME.DESERT ? ID.sand : ID.dirt;
      } else if (lk & LAKE_SHORE) {
        switch (kind) {
          case LAKE_TARN:
            top = patch > 0.12 ? ID.slate : (grit < 0.45 ? ID.gravel : top);
            sub = ID.gravel; break;
          case LAKE_MARSH:
            top = grit < 0.34 ? ID.peat : (patch > 0.1 ? ID.mud : top);
            sub = ID.peat; break;
          case LAKE_OASIS:
            top = grit < 0.25 ? ID.moss_block : ID.sand;
            sub = ID.sand; break;
          default:
            top = patch > 0.14 ? ID.moss_block : (grit < 0.3 ? ID.mud : top);
            sub = grit < 0.5 ? ID.coarse_dirt : ID.dirt; break;
        }
      } else {
        switch (kind) {
          case LAKE_TARN:
            // Scoured rock, and the one lake bed with no soil on it at all.
            top = patch > 0.18 ? ID.slate : (grit < 0.28 ? ID.basalt : ID.gravel);
            sub = ID.slate; break;
          case LAKE_MARSH:
            top = patch > 0.15 ? ID.mud : (grit < 0.3 ? ID.coarse_dirt : ID.peat);
            sub = ID.peat; break;
          case LAKE_OASIS:
            top = grit < 0.2 ? ID.clay : ID.sand;
            sub = ID.sandstone; break;
          default:
            top = patch > 0.24 ? ID.gravel : (grit < 0.38 ? ID.clay : ID.mud);
            sub = ID.clay; break;
        }
      }
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
        // Two independent waters: the sea, which is everything below R_SEA the
        // flood fill could reach, and a lake, which is everything below its own
        // surface. `lakeSurf` is 0 off a lake, so the second test costs one
        // compare per cell and cannot fire by accident.
        id = ((r <= R_SEA && submerged[col]) || r <= lakeSurf[col]) ? ID.water : ID.air;
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
      /**
       * Under a lake — bed or bank — the skin rule is not enough on its own,
       * and the way it fails is the flood bug rather than a cosmetic one.
       *
       * A bank column stands only LAKE_FREEBOARD over the water, so `h - skin`
       * there is *above* the lake's floor: a passage running past the lake
       * opens into its side, and a worldgen liquid is a permanent source, so it
       * does not find a level — it pours into the cave system forever. The bed
       * has the same problem from underneath, with less margin than it looks.
       *
       * So both are measured from the water surface instead, which is the one
       * number every column round a lake agrees on. LAKE_CAVE_CLEAR is the
       * deepest lake plus a skin, so the seal exists whatever the profile did.
       */
      const ls = this.lakeSurf[col];
      const ceil = ls > 0 ? Math.min(h - skin, ls - LAKE_CAVE_CLEAR) : h - skin;
      for (let k = 0; k < D; k++) {
        if (!CARVEABLE[blocks[base + k]]) continue;
        const r = R_MIN + k + 0.5;
        if (r < R_MANTLE + 1.5 || r > ceil) continue;
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

  /**
   * The aquifer record for one column, computed once and kept.
   *
   * Reads the height field and two noise fields and nothing else — no blocks,
   * no neighbours' records — so it is a pure function of (seed, column) and can
   * be asked at any time, in any order, from either side of a region boundary.
   * That is what the seal in `aquiferColumn` needs: a column decides which of
   * *its own* cells must be solid by asking what its neighbours' water looks
   * like, and both sides of every boundary get the same answer.
   *
   * The roof is measured against the lowest of the column's own height and its
   * four neighbours', and this is the whole enclosure argument. A water cell at
   * radius r therefore satisfies r <= colHeight[nb] - AQ_ROOF for every
   * tangential neighbour nb, so the cell the seal writes beside it is six
   * blocks under that neighbour's surface — solid rock, never a stone block
   * hanging in the air over a hillside, and never a hole in the sky above the
   * water.
   *
   * @returns {number} the record's offset into `_aq`
   */
  _aqRecord(col) {
    let a = this._aq;
    if (a === null) a = this._aq = new Uint8Array(COLUMNS * 4);
    const o = col * 4;
    if (a[o]) return o;
    a[o] = 1; a[o + 1] = 1; a[o + 2] = 0; a[o + 3] = 255;   // empty: bot > top

    let hMin = this.colHeight[col];
    for (let d = 0; d < 4; d++) {
      const hh = this.colHeight[colNeighbor(col, d)];
      if (hh < hMin) hMin = hh;
    }
    const roof = hMin - AQ_ROOF;
    if (roof <= AQ_LO) return o;

    const dir = this._dirOf(col, _aqDir);
    const lens = this.nAq.fbm3(dir[0] * 5.5, dir[1] * 5.5, dir[2] * 5.5, 2, 2, 0.5);
    if (lens <= AQ_THR) return o;
    const thick = Math.min(AQ_MAX_THICK, (lens - AQ_THR) * AQ_THICK);
    if (thick < 1) return o;

    // Where the sheet sits within the band. Without this an aquifer is a
    // perfectly concentric shell, which is the same complaint the strata had:
    // two shafts sunk a hundred columns apart would meet the water at exactly
    // the same depth.
    const mid = AQ_MID + this.nAq.simplex3(
      dir[0] * 3.1 + 19.4, dir[1] * 3.1, dir[2] * 3.1,
    ) * 3.2;
    const top = Math.min(mid + thick * 0.5, AQ_HI, roof);
    const bot = Math.max(mid - thick * 0.5, AQ_LO);
    if (top < bot) return o;

    const kBot = Math.max(AQ_K0 + 1, Math.ceil(bot - R_MIN - 0.5));
    const kTop = Math.min(AQ_K1 - 1, Math.floor(top - R_MIN - 0.5));
    if (kTop < kBot) return o;
    // An air gap under the roof, so a big aquifer is somewhere to surface
    // rather than somewhere to drown. Only when there is room for one: a
    // three-block lens with two blocks of air in it is a cave with a puddle.
    const air = (kTop - kBot + 1) >= 4 ? kTop - Math.min(AQ_AIR - 1, 1) : 256;

    a[o + 1] = kBot; a[o + 2] = kTop; a[o + 3] = Math.min(255, air);
    return o;
  }

  /** 0 nothing, 1 water, 2 air — the aquifer's own cells. */
  _aquiferAt(col, k) {
    const o = this._aqRecord(col);
    const a = this._aq;
    if (k < a[o + 1] || k > a[o + 2]) return 0;
    return k >= a[o + 3] ? 2 : 1;
  }

  /**
   * Aquifers, for one already-carved column, and the stone that holds them in.
   *
   * Runs after the cave pass on purpose. A cave cannot eat water — water is not
   * CARVEABLE — but it can very happily open a passage in the column *next
   * door* at the same layer, and worldgen liquid is registered as a permanent
   * source by the water sim (see `Water` and `_seedWaterRegion`): one open side
   * is not a leak, it is a spring that fills the cave system and never stops.
   * So every cell of this column that touches aquifer water — above, below, or
   * across any of the four tangential neighbours — is put back to rock if the
   * carve pass took it. The neighbours do the same for their own cells when
   * their turn comes, and because `_aqRecord` reads nothing but the height
   * field and noise, the two sides cannot disagree about where the water is.
   *
   * Before the ore pass rather than after, so the seal weathers like the rock
   * around it instead of standing out as a clean shell of bare stone.
   */
  aquiferColumn(blocks, col) {
    const oOwn = this._aqRecord(col);
    const a = this._aq;
    const nb0 = colNeighbor(col, 0), nb1 = colNeighbor(col, 1);
    const nb2 = colNeighbor(col, 2), nb3 = colNeighbor(col, 3);
    // Cheapest possible rejection, and it is the common case by a long way:
    // if neither this column nor any of its four neighbours holds water in the
    // band, there is nothing to place and nothing to seal.
    const oA = this._aqRecord(nb0), oB = this._aqRecord(nb1);
    const oC = this._aqRecord(nb2), oD = this._aqRecord(nb3);
    if (a[oOwn + 1] > a[oOwn + 2] && a[oA + 1] > a[oA + 2] && a[oB + 1] > a[oB + 2]
      && a[oC + 1] > a[oC + 2] && a[oD + 1] > a[oD + 2]) return;

    const base = col * D;
    const dir = this._dirOf(col, _aqDir);
    for (let k = AQ_K0; k <= AQ_K1; k++) {
      const mine = this._aquiferAt(col, k);
      if (mine) { blocks[base + k] = mine === 1 ? ID.water : ID.air; continue; }
      const touching = this._aquiferAt(col, k - 1) || this._aquiferAt(col, k + 1)
        || this._aquiferAt(nb0, k) || this._aquiferAt(nb1, k)
        || this._aquiferAt(nb2, k) || this._aquiferAt(nb3, k);
      if (!touching) continue;
      const cur = blocks[base + k];
      if (cur === ID.air || cur === ID.water || cur === ID.lava) {
        blocks[base + k] = this.stratum(R_MIN + k + 0.5, dir[0], dir[1], dir[2]);
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
   *
   * The aquifer pass is the one that bends "reads no column but its own", and
   * only as far as four neighbours' *height field* entries and their aquifer
   * records — never their blocks. See `_aqRecord` for why that is still
   * independent of the order regions are built in.
   */
  terrainColumn(blocks, col) {
    this.fillColumn(blocks, col);
    this.carveColumn(blocks, col);
    this.aquiferColumn(blocks, col);
    this.oreColumn(blocks, col);
  }

  /**
   * Cut inland lakes into the height field.
   *
   * A height-field pass, for the same reason the canyons are one: lower the
   * ground and the fill loop builds the basin as ordinary terrain, with its own
   * soil and its own water, and every pass after it — caves, ore, trees, the
   * slope test — is reasoning about the surface that is actually there. The one
   * thing this does that the canyons do not is publish a *water surface* per
   * column, because a lake's level has nothing to do with sea level and cannot
   * be recovered from the height field afterwards.
   *
   * Three things make it correct rather than merely plausible:
   *
   *  - The profile is taken from real angular distance to the centre, not from
   *    distance over the column graph. The graph is 4-connected, so its metric
   *    is L1 and every lake shaped by it comes out a diamond with its corners
   *    on the compass points. Distance is measured on the sphere and converted
   *    to columns, and the radius itself is wobbled by two octaves of simplex
   *    on the direction, so an outline is organic without being noisy.
   *
   *  - The water surface is defined from the ring, not from the centre. See
   *    LAKE_FREEBOARD: `rim` is the minimum ground height over every column
   *    that touches a carved one, and nothing in that ring is ever carved, so
   *    the ring is provably solid at every layer the water occupies. A lake
   *    cannot leak sideways, and there is no post-hoc check to get wrong.
   *
   *  - The candidates are a lattice coarser than twice the largest lake, so no
   *    two discs — or a disc and another lake's ring — can ever meet, and the
   *    rim of a lake cannot be moved by a lake carved after it.
   *
   * Rejected far more often than accepted, and deliberately: a site goes if it
   * touches the sea's flood fill or a canyon, if any of it is ocean or beach,
   * if it sits too low for its kind, or if the ground under it is more uneven
   * than that kind tolerates. What survives is ground that could plausibly have
   * held water in the first place.
   */
  carveLakes(colHeight, colBiome, canyonMask, submerged, shoreDist) {
    const lakeSurf = new Float32Array(COLUMNS);
    const lakeKind = new Uint8Array(COLUMNS);
    this.lakeSurf = lakeSurf;
    this.lakeKind = lakeKind;
    this.lakes = [];

    /**
     * Which site last touched a column, and where it sits in that site's list.
     * Two planet-wide scratch arrays rather than a Map per site: there are
     * about a thousand candidates and a disc is nine hundred columns, so a Map
     * would allocate a million short-lived entries to answer a question an
     * integer compare answers. Both are dropped when this returns.
     */
    const seen = new Int32Array(COLUMNS).fill(-1);
    const slot = new Int32Array(COLUMNS);
    const disc = new Int32Array(LAKE_DISC_MAX);
    const gdist = new Int16Array(LAKE_DISC_MAX);
    const adist = new Float32Array(LAKE_DISC_MAX);
    const rEff = new Float32Array(LAKE_DISC_MAX);
    /** 0 outside, 1 bed (carved), 2 surround, 3 ring (touches the bed). */
    const role = new Uint8Array(LAKE_DISC_MAX);
    const newH = new Float32Array(LAKE_DISC_MAX);
    const ctr = _lakeCtr, dir = _lakeDir, p = _lakeParts;
    let sid = 0;

    for (let f = 0; f < FACES; f++) {
      for (let ci = LAKE_LI; ci < F - LAKE_EDGE; ci += LAKE_LATTICE) {
        if (ci < LAKE_EDGE) continue;
        for (let cj = LAKE_LJ; cj < F - LAKE_EDGE; cj += LAKE_LATTICE) {
          if (cj < LAKE_EDGE) continue;
          const col = cidx(f, ci, cj);
          const bi = colBiome[col];

          // Every draw before every test, so a site that is thrown away costs
          // the same rolls as one that is kept and the stream stays a pure
          // function of the column. Same rule as the boulders and the logs.
          const rng = this.colRng(col, 0x1a7e);
          const roll = rng(), pickR = rng(), pickD = rng(), pickMix = rng();
          const isleRoll = rng(), isleAng = rng(), isleRad = rng();

          let kind = 0;
          if (bi === BIOME.MOUNTAIN || bi === BIOME.SNOW) kind = LAKE_TARN;
          else if (bi === BIOME.DESERT || bi === BIOME.BADLANDS) kind = LAKE_OASIS;
          else if (bi === BIOME.PLAINS || bi === BIOME.MEADOW || bi === BIOME.TUNDRA) {
            kind = pickMix < 0.45 ? LAKE_MARSH : LAKE_POND;
          } else if (bi === BIOME.FOREST || bi === BIOME.PINE_FOREST) {
            // A wooded fen is a marsh too, and rarer than the open kind.
            kind = pickMix < 0.25 ? LAKE_MARSH : LAKE_POND;
          } else if (bi === BIOME.SAVANNA) kind = pickMix < 0.3 ? LAKE_MARSH : LAKE_POND;
          if (!kind || roll > LAKE_CHANCE[kind]) continue;
          // The cheap tests on the centre alone, before the disc is walked.
          if (submerged[col] || canyonMask[col]) continue;
          if (colHeight[col] < LAKE_MIN_ALT[kind]) continue;

          const rr = LAKE_R[kind], dd = LAKE_DEPTH[kind], wob = LAKE_WOBBLE[kind];
          const rBase = rr[0] + pickR * (rr[1] - rr[0]);
          const depthMax = dd[0] + pickD * (dd[1] - dd[0]);
          const rough = LAKE_BED_ROUGH[kind];
          centerDir(f, ci, cj, ctr);

          // ---- the disc, over the column graph ----------------------------
          sid++;
          let n = 1, over = false;
          seen[col] = sid; slot[col] = 0; disc[0] = col; gdist[0] = 0;
          for (let qi = 0; qi < n; qi++) {
            const c = disc[qi];
            const g = gdist[qi];
            if (g >= LAKE_BFS) continue;
            for (let d = 0; d < 4; d++) {
              const nb = colNeighbor(c, d);
              if (nb < 0 || seen[nb] === sid) continue;
              if (n >= LAKE_DISC_MAX) { over = true; break; }
              seen[nb] = sid; slot[nb] = n;
              disc[n] = nb; gdist[n] = g + 1; n++;
            }
            if (over) break;
          }
          if (over) continue;

          // ---- shape it, and check the ground it is being cut into --------
          let bad = false, nBed = 0;
          const minAlt = LAKE_MIN_ALT[kind];
          for (let t = 0; t < n; t++) {
            const c = disc[t];
            this._dirOf(c, dir);
            const chord = Math.hypot(dir[0] - ctr[0], dir[1] - ctr[1], dir[2] - ctr[2]);
            const da = 2 * Math.asin(Math.min(1, chord * 0.5)) * LAKE_COL_PER_RAD;
            adist[t] = da;
            role[t] = 0; rEff[t] = 0;
            // No radius can reach past the clamp, so this is exact, not a
            // guess — and it keeps the noise off the 80% of the ball that is
            // only there because an L1 diamond has to be big to hold a circle.
            if (da > LAKE_MAX_R + 2.5) continue;
            const s1 = this.nLake.simplex3(dir[0] * 46, dir[1] * 46, dir[2] * 46);
            const s2 = this.nLake.simplex3(dir[0] * 110 + 5.3, dir[1] * 110, dir[2] * 110 - 2.7);
            const re = Math.max(2, Math.min(LAKE_MAX_R,
              rBase * (1 + wob[0] * s1 + wob[1] * s2)));
            rEff[t] = re;
            // The surround is validated two and a half columns wider than it
            // is painted, so that every possible neighbour of a bed column has
            // already been looked at by the time the ring is collected.
            if (da > re + 2.5) continue;
            role[t] = da <= re - 1 ? 1 : 2;
            if (submerged[c] || canyonMask[c]) { bad = true; break; }
            const b2 = colBiome[c];
            // Off the coast entirely, bank included. The biome test alone
            // leaves a lake able to bite into the column behind a beach, which
            // reads as the sea having got in — and is one dug block from being
            // true. `shoreDist` is only grown to BEACH_REACH + 1 and left at
            // 255 elsewhere, so this is exactly "within two columns of water".
            if (b2 === BIOME.OCEAN || b2 === BIOME.BEACH
              || shoreDist[c] <= BEACH_REACH + 1) { bad = true; break; }
            const hh = colHeight[c];
            if (hh < minAlt || hh > R_TERRAIN_MAX - 6) { bad = true; break; }
            if (role[t] === 1) nBed++;
          }
          if (bad || nBed < LAKE_MIN_CELLS) continue;

          // ---- the ring, and therefore the waterline ----------------------
          let rim = Infinity, ringHi = -Infinity;
          for (let t = 0; t < n && !bad; t++) {
            if (role[t] !== 1) continue;
            const c = disc[t];
            for (let d = 0; d < 4; d++) {
              const nb = colNeighbor(c, d);
              // Both of these are unreachable — the ball is wider than the
              // disc and the surround is validated wider still — and both are
              // a silent flood if they ever stop being, so the site goes
              // rather than the assumption.
              if (nb < 0 || seen[nb] !== sid) { bad = true; break; }
              const t2 = slot[nb];
              if (role[t2] === 1) continue;
              if (role[t2] === 0) { bad = true; break; }
              role[t2] = 3;
              if (colHeight[nb] < rim) rim = colHeight[nb];
              if (colHeight[nb] > ringHi) ringHi = colHeight[nb];
            }
          }
          if (bad || rim === Infinity) continue;
          /**
           * A cliff, rather than a shore. Deliberately generous — this only
           * throws out the sites where part of the rim towers over the rest,
           * and LAKE_CUT below is what actually decides whether the ground is
           * level enough to hold water. Measured on the shoreline and not over
           * the whole disc, because the relief over the disc throws out a
           * hollow, which is the best thing that can happen to a lake site.
           */
          if (ringHi - rim > LAKE_TOL[kind]) continue;
          const surf = rim - LAKE_FREEBOARD;

          // ---- the bed profile --------------------------------------------
          let deepest = 0, water = 0, cut = 0;
          for (let t = 0; t < n; t++) {
            if (role[t] !== 1) continue;
            const c = disc[t];
            const u = Math.min(1, adist[t] / rEff[t]);
            this._dirOf(c, dir);
            const bump = this.nLake.simplex3(
              dir[0] * 130 + 21.7, dir[1] * 130, dir[2] * 130,
            ) * rough;
            /**
             * What separates the kinds in the water more than any block does.
             * A tarn is very nearly a cylinder — steep walls, flat floor, you
             * are out of your depth one step from the edge. A marsh is a pan
             * with almost no wall at all. A pond is the parabola in between,
             * which is the shape that gives a wadeable margin and a middle you
             * have to swim.
             */
            let prof;
            switch (kind) {
              case LAKE_TARN: prof = Math.min(1, (1 - u) * 2.6); break;
              case LAKE_MARSH: prof = 1 - u * u * u * u; break;
              case LAKE_OASIS: prof = 1 - u * u * u; break;
              default: prof = 1 - u * u;
            }
            // `min`, never `max`: the carve may deepen the ground it found but
            // must never raise it, or a lake cut into a slope would build
            // itself a wall of earth on the downhill side.
            const hn = Math.min(colHeight[c], surf - (depthMax * prof + bump));
            newH[t] = hn;
            const dep = surf - hn;
            if (dep > deepest) deepest = dep;
            if (dep > 0.5) water++;
            if (colHeight[c] > surf) cut += colHeight[c] - surf;
          }
          // Lake or excavation — see LAKE_CUT. A block or so of ground over
          // the waterline, averaged across the basin, is the bank every lake
          // has; three is a hole cut in a hillside.
          if (deepest < LAKE_MIN_DEPTH || water < LAKE_MIN_CELLS
            || cut > nBed * LAKE_CUT[kind]) continue;

          // An islet, in a big pond only. It is ground raised back over the
          // waterline inside the basin, which cannot leak by construction —
          // the thing that holds the water in is the ring, and this is nowhere
          // near it.
          let oi = 0, oj = 0, isleR = 0;
          if (kind === LAKE_POND && rBase >= 7.2 && isleRoll < 0.25) {
            const ang = isleAng * Math.PI * 2;
            const off = rBase * 0.34;
            oi = Math.round(Math.cos(ang) * off);
            oj = Math.round(Math.sin(ang) * off);
            isleR = 1.3 + isleRad * 1.5;
          }

          // ---- commit ------------------------------------------------------
          let nIsle = 0;
          for (let t = 0; t < n; t++) {
            const c = disc[t];
            const rl = role[t];
            if (rl === 1) {
              let hn = newH[t];
              let flag = 0;
              if (isleR > 0) {
                colParts(c, p);
                const di = p.i - (ci + oi), dj = p.j - (cj + oj);
                if (di * di + dj * dj <= isleR * isleR) {
                  if (hn < surf + 0.9) hn = surf + 0.9;
                  flag = LAKE_ISLE; nIsle++;
                }
              }
              colHeight[c] = hn;
              lakeSurf[c] = surf;
              lakeKind[c] = kind | flag;
            } else if (rl === 3) {
              // The ring proper. It gets `lakeSurf` as well as the bank
              // material, because the cave carve has to know how far to keep
              // away — see LAKE_CAVE_CLEAR. It never holds water: its ground
              // stands LAKE_FREEBOARD above the surface by construction.
              lakeSurf[c] = surf;
              lakeKind[c] = kind | LAKE_SHORE;
            } else if (rl === 2 && adist[t] <= rEff[t] + 1.5) {
              // Bank, but not touching the water. Re-surfaced and nothing
              // more — and pointedly *no* `lakeSurf`, because out here the
              // ground is not guaranteed to stand above the waterline and a
              // water test that came out true would be a leak.
              lakeKind[c] = kind | LAKE_SHORE;
            }
          }
          this.lakes.push({
            f, i: ci, j: cj, col, kind, biome: bi,
            r: rBase, surf, depth: deepest, cells: water, bed: nBed, isle: nIsle,
          });
        }
      }
    }

    const counts = [0, 0, 0, 0, 0];
    for (let t = 0; t < this.lakes.length; t++) counts[this.lakes[t].kind]++;
    this.lakeCounts = {
      pond: counts[LAKE_POND], tarn: counts[LAKE_TARN],
      marsh: counts[LAKE_MARSH], oasis: counts[LAKE_OASIS],
      total: this.lakes.length,
    };
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

      /**
       * Nothing of the apron may be lake.
       *
       * The cone is stamped into the *block array* long after the height field
       * settled, and it re-lays the ground it covers — so a vent sited over a
       * lake would bury the bed, leave the water standing in mid-air, and then
       * have that water pour off the new slope as a permanent source. The scan
       * is over the whole apron rather than the cone, because the scorched
       * ground is re-laid too.
       *
       * Step two, not one: the smallest lake is four columns across including
       * its bank, so a lattice of two cannot miss one. It only runs for a
       * candidate that has already passed every other test, of which there are
       * a handful on the whole planet.
       */
      for (let di = -APRON; di <= APRON && !bad; di += 2) {
        for (let dj = -APRON; dj <= APRON; dj += 2) {
          if (Math.hypot(di, dj) > APRON) continue;
          if (this.lakeKind[patchColumn(parts.f, parts.i, parts.j, di, dj)]) { bad = true; break; }
        }
      }
      if (bad) continue;

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
   * Is this column the centre of a hot spring, and if so at what layer does its
   * pool sit? -1 for no.
   *
   * Every test here reads the global per-column tables and nothing else. That
   * is not a style preference: `_springNear` is asked by the tree, boulder and
   * flora passes, all three of which run over a *margin* of neighbouring
   * regions so that a decision comes out the same from either side. A single
   * block read would make the answer depend on which region the player walked
   * into first, and a pine growing out of the middle of the pool from one
   * approach and not the other is exactly the seam that costs.
   *
   * The footprint is kept inside one cube face, the same rule the volcano and
   * the structures follow: a pool folded over a seam loses cells, and — more
   * to the point here — a column on the far side of a seam has different face
   * coordinates and would never find this centre on the lattice.
   */
  _springCenter(col) {
    const hit = this._spring.get(col);
    if (hit !== undefined) return hit;
    const kb = this._springCenterUncached(col);
    this._spring.set(col, kb);
    return kb;
  }

  _springCenterUncached(col) {
    const p = colParts(col, _spParts);
    if (p.i % SPRING_LATTICE !== SPRING_LI || p.j % SPRING_LATTICE !== SPRING_LJ) return -1;
    const edge = Math.ceil(SPRING_R) + 2;
    if (p.i < edge || p.i >= F - edge || p.j < edge || p.j >= F - edge) return -1;
    if (!SPRING_BIOMES.includes(this.colBiome[col])) return -1;
    // Flat, dry, well clear of the waterline and out of any gorge. The height
    // test is what keeps a pool from ever meeting the sea: the water surface
    // ends up a block below this and the sea cannot reach uphill.
    if (this.colSlope[col] > 0.35) return -1;
    if (this.canyonNear[col] < CANYON_NEAR_MAX) return -1;
    if (this.colHeight[col] < R_SEA + 3.0) return -1;
    if (this.colRng(col, 0x8b17)() > SPRING_CHANCE) return -1;
    // Not on a volcano's apron. Mountain is a host biome for both, and the cone
    // is stamped from the *block array* after the height field says the ground
    // is flat — so a pool sited by height would be cut into the middle of a
    // scorched slope it knows nothing about. The sites are chosen planet-wide
    // before any region exists, so reading them here is as deterministic as
    // reading the height field.
    if (this.volcanoes) {
      for (let v = 0; v < this.volcanoes.length; v++) {
        const s = this.volcanoes[v];
        if (s.f !== p.f) continue;
        if (Math.hypot(s.i - p.i, s.j - p.j) <= APRON + SPRING_R + 1) return -1;
      }
    }

    const kc = this.groundKOf(col);
    if (kc < 6 || kc > D - 6) return -1;
    let lo = kc, hi = kc;
    const ri = Math.ceil(SPRING_R);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        if (Math.hypot(di, dj) > SPRING_R) continue;
        const c = patchColumn(p.f, p.i, p.j, di, dj);
        const bi = this.colBiome[c];
        if (bi === BIOME.OCEAN || bi === BIOME.BEACH) return -1;
        // Not into a lake or its bank. A hot spring cuts its own bowl and lays
        // its own rim, and doing that to ground a lake already owns would put
        // one pool's floor through the other's wall.
        if (this.lakeKind[c]) return -1;
        const g = this.groundKOf(c);
        if (g < 0) return -1;
        if (g < lo) lo = g;
        if (g > hi) hi = g;
      }
    }
    // A pool needs a level shelf to sit in. One layer of step is absorbed by
    // laying the rim at the lowest of them; two is a slope, and cutting a bowl
    // into a slope leaves a wall of water on the downhill side.
    if (hi - lo > 1) return -1;
    return lo;
  }

  /**
   * The hot spring covering this column, or -1.
   *
   * O(1): a seven-column window contains at most one column congruent to
   * SPRING_LI modulo SPRING_LATTICE, so there is at most one centre that could
   * possibly reach here. See SPRING_LATTICE for why that matters.
   */
  _springNear(col) {
    const p = colParts(col, _spParts);
    const ri = ((p.i - SPRING_LI) % SPRING_LATTICE + SPRING_LATTICE) % SPRING_LATTICE;
    const i0 = ri <= SPRING_R ? p.i - ri
      : (SPRING_LATTICE - ri <= SPRING_R ? p.i + (SPRING_LATTICE - ri) : -1);
    if (i0 < 0 || i0 >= F) return -1;
    const rj = ((p.j - SPRING_LJ) % SPRING_LATTICE + SPRING_LATTICE) % SPRING_LATTICE;
    const j0 = rj <= SPRING_R ? p.j - rj
      : (SPRING_LATTICE - rj <= SPRING_R ? p.j + (SPRING_LATTICE - rj) : -1);
    if (j0 < 0 || j0 >= F) return -1;
    if (Math.hypot(p.i - i0, p.j - j0) > SPRING_R) return -1;
    return this._springCenter(cidx(p.f, i0, j0));
  }

  /**
   * One column's hot spring, if it has one, clipped to a region.
   *
   * The pool is cut two blocks into the ground and filled, and the ring around
   * it is laid flat at the same layer in a mineral crust — sulfur over tuff,
   * which is the palette's nearest thing to a travertine terrace and shares no
   * block with an ordinary lake shore. The rim is what makes the feature read:
   * a three-column puddle in the snow with a snow edge is a puddle.
   *
   * Enclosure, which the water sim makes a correctness question rather than a
   * cosmetic one — every worldgen liquid cell is a permanent source. The water
   * surface is at kb-1, one *below* the rim's own top at kb, so at the water's
   * own layer every tangential neighbour of every water column is either more
   * water or rim: SPRING_RI is one less than SPRING_R, so a water column's four
   * neighbours cannot leave the footprint. Underneath, the pass writes its own
   * floor at kb-3 rather than trusting the ground: the cave carve is allowed
   * within 2.2 blocks of the surface, so a passage can already be running
   * directly beneath, and a pool with a hole in the bottom empties into it
   * forever.
   *
   * Every write is unconditional and every draw from the stream happens before
   * the region clip, so what a cell ends up holding does not depend on what was
   * there or on which region stamped it.
   */
  springAt(blocks, col, rid) {
    const kb = this._springCenter(col);
    if (kb < 0) return;
    const p = colParts(col, _spParts);
    const rng = this.colRng(col, 0x3c0d);
    const ri = Math.ceil(SPRING_R);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        const d = Math.hypot(di, dj);
        if (d > SPRING_R) continue;
        const c = patchColumn(p.f, p.i, p.j, di, dj);
        const crust = rng() < 0.42 ? ID.sulfur_ore : ID.tuff;
        if (regionOfCol(c) !== rid) continue;
        const b = c * D;
        if (d <= SPRING_RI) {
          blocks[b + kb - 3] = ID.tuff;
          blocks[b + kb - 2] = ID.water;
          blocks[b + kb - 1] = ID.water;
        } else {
          blocks[b + kb - 3] = ID.tuff;
          blocks[b + kb - 2] = ID.tuff;
          blocks[b + kb - 1] = ID.tuff;
          blocks[b + kb] = crust;
        }
        // Clear the headroom either way. On the rim this is what levels a
        // one-layer step into the terrace; over the water it is what stops a
        // drift of snow sitting on top of the pool.
        for (let k = kb + (d <= SPRING_RI ? 0 : 1); k <= kb + 2 && k < D; k++) {
          blocks[b + k] = ID.air;
        }
      }
    }
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
    const t = this._treeKind(blocks, col);
    if (!t) return;
    this.stampTree(blocks, t.kind, col, t.k + 1, t.rng, rid);
  }

  /**
   * Does a tree stand on this column, and what is it? `null` for no.
   *
   * Split out of `treeAt` so the fallen-log pass can ask the question without
   * growing anything: a windfall lying through a standing trunk is the single
   * most obvious way this can look wrong, and the trunk is written with
   * `force`, so the log would not even survive to be seen.
   *
   * The stream is handed back rather than re-derived. `stampTree` continues to
   * draw from exactly the sequence the decision left behind — re-seeding it
   * would be a different tree — and the log pass simply throws it away.
   *
   * Every test in here reads the global per-column tables or terrain blocks and
   * nothing decoration writes, which is what lets both callers run over a
   * region's margin and agree from either side. See `decorateRegion`.
   */
  _treeKind(blocks, col) {
    const bi = this.colBiome[col];
    if (this.colSlope[col] > 1.5) return null;
    if (this.inLakeBed(col)) return null;
    // Nothing takes root in a hot spring. Asked of the terrain rather than of
    // the blocks — see `_springCenter`.
    if (this._springNear(col) >= 0) return null;
    // The gorge and its rim. See CANYON_TREE_THIN.
    const thin = CANYON_TREE_THIN[this.canyonNear[col]];
    if (thin <= 0) return null;
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
    if (k < 0 || k > D - 7) return null;
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
    if (above === ID.water || above === ID.lava) return null;
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

    if (!kind || rng() > chance * thin) return null;
    return { kind, k, rng };
  }

  /**
   * Does a boulder stand on this column? Split out of `boulderAt` for the same
   * reason `_treeKind` was split out of `treeAt` — the fallen-log pass has to
   * be able to ask without building anything — and the cheap roll is first, so
   * asking it of a hundred columns costs a hundred xorshifts and no terrain
   * lookups at all for 99.8% of them.
   */
  _boulderKind(blocks, col) {
    const rng = this.colRng(col, 0xb0d1);
    if (rng() > 0.0022) return null;
    // Same reason as `treeAt`: the ground, not whatever is standing on it.
    const k = this.groundKOf(col);
    if (k < 0 || k > D - 5) return null;
    const surf = blocks[col * D + k];
    if (surf !== ID.grass && surf !== ID.stone && surf !== ID.snow) return null;
    // A boulder is scenery, and a gorge floor already has rock lying about it.
    if (this.canyonNear[col] === 0) return null;
    if (this.inLakeBed(col)) return null;
    if (this._springNear(col) >= 0) return null;
    return { rng, k };
  }

  /** One column's boulder, if it has one, clipped to a region. */
  boulderAt(blocks, col, rid) {
    const b = this._boulderKind(blocks, col);
    if (!b) return;
    const { rng, k } = b;
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

  /**
   * The windfall this column carries, decided from the terrain alone.
   *
   * Returns the whole plan — where, which way, how long, which species, where
   * the break is — or `null`. Nothing is written and no block outside a five
   * column radius is read, which is what lets `decorateRegion` run this over a
   * margin of somebody else's columns and get the same answer either way round.
   *
   * The three things a log must not lie in — a hot spring, a standing trunk, a
   * boulder — are each asked as a *decision* rather than looked for in the
   * block array (`_springNear`, `_treeKind`, `_boulderKind`). Looking would be
   * the obvious way and it is unsound: the block array is shared across
   * regions, so whether a neighbouring region's trees are standing in it yet
   * depends entirely on which region the player walked into first.
   */
  _fallenLog(blocks, col) {
    const p = colParts(col, _logParts);
    const f = p.f, ci = p.i, cj = p.j;
    if (ci % LOG_LATTICE !== LOG_LI || cj % LOG_LATTICE !== LOG_LJ) return null;
    const bi = this.colBiome[col];
    const chance = LOG_CHANCE[bi] || 0;
    if (chance <= 0) return null;
    const rng = this.colRng(col, 0x1c9b);
    if (rng() > chance) return null;

    // Every draw happens before every test, so a run that is rejected costs the
    // same rolls as one that is kept and the stream stays a function of the
    // column alone — the same rule the boulder pass learned the hard way.
    const axis = rng() < 0.5 ? 0 : 1;
    const len = LOG_MIN + Math.floor(rng() * (LOG_MAX - LOG_MIN + 1));
    // Rotted through in the middle. It is one cell and it is most of what
    // separates a windfall from a row of blocks; only on a long run, where
    // there is still something left on both sides of the break.
    const gap = (len >= 5 && rng() < 0.38) ? 1 + Math.floor(rng() * (len - 2)) : -1;
    const pickSpecies = rng();

    // Centred on the candidate — see LOG_LATTICE for why that is a constraint
    // and not a preference.
    const off0 = -((len - 1) >> 1);
    const along = axis === 0 ? ci : cj;
    // The run stays inside one face. `_i` and `_j` name the *face's* tangential
    // axes, and past a cube seam the neighbouring face's i points somewhere
    // else entirely — a trunk that crossed one would visibly kink and wear its
    // end grain sideways.
    if (along + off0 < 0 || along + off0 + len > F) return null;

    // Not on a volcano's apron. The cone is stamped into the block array after
    // the height field is settled, so `groundKOf` there describes the ground the
    // volcano replaced. Same test and same reason as `_springCenterUncached`.
    if (this.volcanoes) {
      for (let v = 0; v < this.volcanoes.length; v++) {
        const s = this.volcanoes[v];
        if (s.f !== f) continue;
        if (Math.hypot(s.i - ci, s.j - cj) <= APRON + LOG_MAX) return null;
      }
    }

    const k = this.groundKOf(col);
    if (k < 1 || k > D - 3) return null;
    for (let n = 0; n < len; n++) {
      const d = off0 + n;
      const c = axis === 0 ? patchColumn(f, ci, cj, d, 0) : patchColumn(f, ci, cj, 0, d);
      if (!this._logRests(blocks, c, k)) return null;
    }

    // The species the wood around it is made of — the same rule `_treeKind`
    // uses, so a windfall never comes out of a species the forest it is lying
    // in does not grow.
    const kind = bi === BIOME.PINE_FOREST ? 'pine'
      : bi === BIOME.MEADOW ? 'birch'
        : bi === BIOME.FOREST ? (pickSpecies < 0.68 ? 'oak' : 'birch')
          : (pickSpecies < 0.6 ? 'oak' : 'birch');
    return { f, ci, cj, axis, len, gap, off0, k, kind, id: LOG_IDS[kind][axis] };
  }

  /**
   * Can one cell of a run lie here, on layer `k`?
   *
   * The level test is the load-bearing one. A fallen log carries no
   * `needsFloor`, so nothing downstream will ever take an unsupported one down
   * — one cell of step under a seven-cell run is one cell of log hanging in the
   * air, forever. Demanding that every column of the run have its ground on the
   * same layer is both the support rule and the "level enough" rule, and it is
   * the reason a windfall is something you find in a clearing rather than
   * draped down a hillside.
   */
  _logRests(blocks, c, k) {
    /**
     * What the far end of a run may lie on is a question about the *ground*,
     * not about the biome, and the two are not interchangeable here.
     *
     * Requiring every cell to sit in a biome that grows logs was the obvious
     * rule and it very nearly deleted the pine windfall from the planet:
     * PINE_FOREST is 1.26% of the surface and comes in patches a few dozen
     * columns across, ringed by mountain and snow, so a five-cell run centred
     * anywhere but the middle of one had a foot outside and was thrown away.
     * Measured, 93 of the planet's 237 level pine candidates survived every
     * other test and none of them survived this one.
     *
     * LOG_FLOOR is the rule that was actually wanted. It is soil, turf and
     * snow — the things a wood grows on — and it already refuses sand, red
     * sand, gravel and bare rock, so a trunk still cannot run out of the trees
     * and across a desert. What it now allows is the treeline, which is where
     * a windfall belongs anyway.
     */
    const bi = this.colBiome[c];
    if (bi === BIOME.OCEAN || bi === BIOME.BEACH) return false;
    if (this.colSlope[c] > 1.2) return false;
    // Out of the gorge and off its rim, like everything else that decorates.
    if (this.canyonNear[c] < CANYON_NEAR_MAX) return false;
    if (this.inLakeBed(c)) return false;
    if (this._springNear(c) >= 0) return false;
    if (this.groundKOf(c) !== k) return false;
    if (!LOG_FLOOR[blocks[c * D + k]]) return false;
    // Liquid specifically, not "is it air" — for exactly the reason spelled out
    // at length in `_treeKind`. Terrain puts air or water in the cell above the
    // ground and nothing else; decoration puts trees and boulders there, and
    // asking about those would be asking whether the region next door has been
    // decorated yet.
    const above = blocks[c * D + k + 1];
    if (above === ID.water || above === ID.lava) return false;
    // Nothing lies through a standing trunk, and nothing lies through a
    // boulder — which is up to two columns across, hence the sweep.
    if (this._treeKind(blocks, c)) return false;
    const q = colParts(c, _logNb);
    const qf = q.f, qi = q.i, qj = q.j;
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        if (this._boulderKind(blocks, patchColumn(qf, qi, qj, di, dj))) return false;
      }
    }
    return true;
  }

  /** One column's fallen log, if it has one, clipped to a region. */
  logAt(blocks, col, rid) {
    const plan = this._fallenLog(blocks, col);
    if (plan === null) return;
    for (let n = 0; n < plan.len; n++) {
      if (n === plan.gap) continue;
      const d = plan.off0 + n;
      const c = plan.axis === 0
        ? patchColumn(plan.f, plan.ci, plan.cj, d, 0)
        : patchColumn(plan.f, plan.ci, plan.cj, 0, d);
      if (rid >= 0 && regionOfCol(c) !== rid) continue;
      blocks[c * D + plan.k + 1] = plan.id;
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

    /**
     * How big *this* tree is, as one multiplier on both trunk and crown.
     *
     * The bands above are three to five values wide — an oak was exactly 6, 7
     * or 8 — and, worse, `rad` was a constant per kind, so every oak on the
     * planet wore an identical crown. That is the half that was actually
     * missing: two trees of different heights under the same canopy read as
     * the same tree at two distances, which is what "almost same height trees"
     * is describing even though height is not really the culprit.
     *
     * Three modes rather than one wide band. Widening the band alone makes the
     * extremes exactly as common as the middle, which is neither a forest nor
     * a nursery; a wood reads as grown when most of it sits in a believable
     * middle and the eye can pick out the odd runt and the odd giant standing
     * in it.
     */
    const pick = rng();
    const size = pick < 0.13 ? 0.34 + rng() * 0.22        // sapling / young tree
      : pick > 0.92 ? 1.26 + rng() * 0.24                 // giant
        : 0.78 + rng() * 0.38;                            // the everyday spread

    /**
     * The crown follows the trunk, damped — and the damping is a correctness
     * constraint rather than taste. DECOR_MARGIN is 6, so nothing a column
     * decides may reach more than six columns from it. Pine is widest at 3.0;
     * 3.0 * 1.22 plus the cone's own +0.4 rounds to five columns. Raising
     * either number without raising DECOR_MARGIN buys a straight edge of
     * missing leaves down every region boundary.
     */
    const rad = cfg.rad * (0.55 + 0.45 * Math.min(size, 1.5));

    // never let a canopy run off the top of the column
    const room = Math.max(3, D - 2 - k0 - Math.ceil(rad));
    const span = cfg.h[0] + Math.floor(rng() * (cfg.h[1] - cfg.h[0] + 1));
    const h = Math.max(2, Math.min(room, Math.round(span * size)));
    for (let n = 0; n < h; n++) set(col, k0 + n, cfg.log, true);

    /**
     * A young tree is not a scale model of an old one. The crown profile below
     * hangs three courses under the treetop, which on a two- or three-block
     * trunk swallows the trunk whole and puts leaves in the dirt — so a sapling
     * gets its own shape: a tuft on a stick, corners mostly clipped so it does
     * not read as a cube.
     */
    if (h <= 3) {
      const tk = k0 + h - 1;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di && dj && rng() < 0.6) continue;
          set(at(di, dj), tk, cfg.leaf);
        }
      }
      set(col, tk + 1, cfg.leaf);
      return;
    }

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
        // `r` is this layer's radius; `rad` is the whole tree's. Using the
        // latter inside the loop would give every course the full width and
        // turn the crown into a cylinder.
        const r = rad * profile[n];
        if (r <= 0) continue;
        const ri = Math.ceil(r);
        const ck = ckTop - (profile.length - 1 - n);
        for (let di = -ri; di <= ri; di++) {
          for (let dj = -ri; dj <= ri; dj++) {
            const d = Math.hypot(di, dj);
            if (d > r + (rng() - 0.5) * ragged) continue;
            if (d > r * 0.72 && rng() < ragged * 0.5) continue;
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
        const r = rad * (1 - t * 0.82) + 0.4;
        const ri = Math.ceil(r);
        for (let di = -ri; di <= ri; di++)
          for (let dj = -ri; dj <= ri; dj++) {
            if (Math.hypot(di, dj) > r) continue;
            set(at(di, dj), top - l, cfg.leaf);
          }
      }
      set(col, top + 1, cfg.leaf);
    } else if (cfg.shape === 'flat') {
      const ri = Math.ceil(rad);
      for (let dk = 0; dk <= 1; dk++)
        for (let di = -ri; di <= ri; di++)
          for (let dj = -ri; dj <= ri; dj++) {
            if (Math.hypot(di, dj) > rad - dk * 0.8) continue;
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
    if (this._springNear(col) >= 0) return;
    // Nothing grows in a lake bed. The water above the ground already stops
    // most of it, but a lake's margin can come out dry, and a mushroom in an
    // air pocket under the bed would be a hole waiting to be dug into.
    if (this.inLakeBed(col)) return;
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

  // --- the reef --------------------------------------------------------------

  /**
   * The topmost *water* cell of a column, or -1 if it holds no water.
   *
   * Two independent waters, exactly as `fillColumn` fills them: the sea, which
   * is everything at or below R_SEA the flood fill could reach, and a lake,
   * which is everything at or below its own surface. A column can in principle
   * be under both — a pond sitting in a coastal hollow — so it is the higher of
   * the two, because that is the one whose cell carries the surface quad.
   */
  _topWaterK(col) {
    let top = this.submerged[col] ? SEA_TOP_K : -1;
    const ls = this.lakeSurf[col];
    if (ls > 0) {
      const lk = Math.floor(ls - R_MIN - 0.5);
      if (lk > top) top = lk;
    }
    return top >= D ? D - 1 : top;
  }

  /**
   * The floor a reef prop would stand on in this column, or -1.
   *
   * `groundKOf` is the height field, not a scan, so this is answerable for a
   * column whose voxels are not built yet — but the `supports` test is a real
   * block read, and it is worth its cost. The cell is terrain by construction
   * (caves keep a skin under the surface, and an ore vein swaps one rock for
   * another), so it cannot be reading somebody else's decoration. Every
   * material the ocean case lays — sand, clay, mud, gravel, slate, basalt,
   * moss, packed ice — is a full cube and passes; what this actually catches is
   * the column whose surface cell a cave or a canyon opened, and the day a
   * seabed grows something that is not a cube it will catch that too.
   * `needsFloor` on the blocks means the alternative is not a cosmetic bug: a
   * prop whose floor does not support it comes down the moment anything near it
   * is disturbed.
   */
  _reefFloorK(blocks, col) {
    const k = this.groundKOf(col);
    if (k < 1 || k > D - 3) return -1;
    return supports(blocks[col * D + k]) ? k : -1;
  }

  /**
   * Put one single-cell prop on the floor of a column. The whole topK rule is
   * the second line, and every prop in both passes goes through here.
   */
  _propAt(blocks, col, id, floorK, topK) {
    const k = floorK + 1;
    if (k >= topK) return false;
    if (blocks[col * D + k] !== ID.water) return false;
    blocks[col * D + k] = id;
    return true;
  }

  /**
   * A kelp stalk: `n` segments from `floorK + 1` up, all or nothing.
   *
   * Only the base needs a floor — a kelp segment supports the segment above it,
   * which is what `STACKS` is for — so the run is checked for water and then
   * written, rather than being grown one cell at a time and left half-built if
   * it meets something. `base + n - 1 < topK` leaves at least one cell of clear
   * water over the tip, so a stalk never reaches the surface cell.
   *
   * @returns {number} segments written, 0 if the stalk did not fit
   */
  _kelpAt(blocks, col, n, floorK, topK) {
    const base = floorK + 1;
    if (n < KELP_MIN || base + n - 1 >= topK) return 0;
    const b = col * D;
    for (let s = 0; s < n; s++) if (blocks[b + base + s] !== ID.water) return 0;
    for (let s = 0; s < n; s++) blocks[b + base + s] = ID.kelp;
    return n;
  }

  /**
   * The reef this column is the centre of, decided from terrain alone, or null.
   *
   * On a lattice for the reason SPRING_LATTICE spells out and REEF_R_MAX
   * repeats: it turns "is there a reef near this column" into arithmetic, and it
   * puts a floor under the distance between two of them. Nothing is written and
   * nothing outside the candidate column itself is read, so `decorateRegion` can
   * run it over a margin of somebody else's columns and get the same answer from
   * either side.
   *
   * Every draw happens before every test, the rule the boulder pass learned the
   * hard way — a rejected candidate costs the same rolls as a kept one, so the
   * stream stays a pure function of the column.
   */
  _reefSite(col) {
    const p = colParts(col, _reefParts);
    if (p.i % REEF_LATTICE !== REEF_LI || p.j % REEF_LATTICE !== REEF_LJ) return null;
    // Sea only, and never a lake. Coral in a pond is the one thing this pass is
    // most likely to be asked to do by accident: a coastal pond is submerged,
    // is at sea level and has a floor two cells down, so it passes every test
    // here except this one.
    if (this.colBiome[col] !== BIOME.OCEAN || !this.submerged[col]) return null;
    if (this.lakeKind[col]) return null;
    const floorK = this.groundKOf(col);
    if (floorK < 1 || floorK > D - 3) return null;
    const depth = depthOfK(floorK);
    if (depth < REEF_DEPTH_MIN || depth > REEF_DEPTH_MAX) return null;

    const dir = _reefDir;
    this._dirOf(col, dir);
    const warm = clamp((this._seaTemp(dir) - REEF_TEMP_MIN)
      / (REEF_TEMP_FULL - REEF_TEMP_MIN), 0, 1);
    if (warm <= 0) return null;

    const rng = this.colRng(col, 0xd33f);
    const roll = rng();
    const rad = REEF_R_MIN + rng() * (REEF_R_MAX - REEF_R_MIN);
    // How thick this particular reef is in the middle. Without it every reef
    // comes out the same density and a bank of three reads as one texture.
    const rich = 0.55 + rng() * 0.45;
    if (roll > REEF_CHANCE * warm) return null;
    return { f: p.f, i: p.i, j: p.j, rad, rich, warm };
  }

  /**
   * One column's reef, if it has one, clipped to a region.
   *
   * Dense in the middle and thinning to nothing at the rim, with the grass
   * skirt running the other way — that gradient is the whole difference between
   * a reef and a patch of coral. `w` is 1 at the centre and 0 at the rim; the
   * coral term is `w` with a knee in it so the core stays solid instead of
   * fading from the first column out, and the grass term rises as the coral
   * falls, so the carpet is thickest exactly where the heads stop.
   *
   * Each column draws from its own `colRng`, not from the centre's stream, so
   * the order the disc is walked in cannot change what any column gets — which
   * is what lets the region clip be a `continue` rather than something that has
   * to keep the stream in step.
   */
  reefAt(blocks, col, rid) {
    const site = this._reefSite(col);
    if (site === null) return;
    const ri = Math.ceil(site.rad);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        const d = Math.hypot(di, dj);
        if (d > site.rad) continue;
        // Grid arithmetic on the *face*, then a re-projection, because a reef
        // eight columns across can sit on a cube seam and the neighbouring
        // face's i points somewhere else entirely.
        const c = patchColumn(site.f, site.i, site.j, di, dj);
        if (rid >= 0 && regionOfCol(c) !== rid) continue;
        if (this.colBiome[c] !== BIOME.OCEAN || !this.submerged[c]) continue;
        if (this.lakeKind[c]) continue;
        const floorK = this._reefFloorK(blocks, c);
        if (floorK < 0) continue;
        const depth = depthOfK(floorK);
        if (depth < REEF_DEPTH_MIN || depth > REEF_DEPTH_MAX) continue;

        const w = 1 - d / site.rad;
        const rng = this.colRng(c, 0xc0a1);
        const r = rng();
        const pShell = REEF_SHELL * (0.30 + 0.70 * w);
        /**
         * A solid core with a short shoulder, and — the part that took three
         * goes to get right — *nothing* at the rim.
         *
         * A plain falloff (`w^1.35`, then `0.35 + 0.65 w^1.6`) leaves a low but
         * non-zero chance out at the edge of the disc, and the edge of a disc is
         * most of its area. Measured, that put a third of all reefs into
         * one-column fragments: single heads standing alone in open water, which
         * is exactly the confetti a cluster pass exists to avoid. The
         * smoothstep takes the outer 42% of the radius to zero, so the reef has
         * a body and an edge, and what is left standing beyond that edge is the
         * grass skirt below rather than a stray coral.
         */
        const pCoral = Math.min(0.90,
          site.rich * site.warm * 1.25 * smoothstep(0, 0.42, w));
        const pGrass = 0.28 + 0.34 * (1 - w);

        let id;
        if (r < pShell) {
          id = ID.sea_shell;
        } else if (r < pShell + pCoral) {
          const c2 = rng();
          id = c2 < 0.22 ? ID.sea_sponge
            : c2 < 0.52 ? ID.coral_branch
              : c2 < 0.76 ? ID.coral_brain
                : ID.coral_fan;
          // A sponge is not a coral and does not bleach. Rolled unconditionally
          // all the same, so the stream does not fork on which head came up.
          const bleach = rng() < REEF_DEAD;
          if (id !== ID.sea_sponge && bleach) id = ID.coral_dead;
        } else if (r < pShell + pCoral + pGrass) {
          id = ID.sea_grass;
        } else {
          continue;
        }
        this._propAt(blocks, c, id, floorK, SEA_TOP_K);
      }
    }
  }

  /**
   * Sea grass and kelp for one column — the underwater flora pass.
   *
   * Writes only into this column, like `floraAt`, so it needs no region clip,
   * and it runs *after* the reefs for the same reason `floraAt` runs after the
   * trees: every reef that can reach this column has already been stamped by
   * the time we get here, so the water test below sees the finished cell. That
   * is deterministic rather than lucky — a reef only ever writes into its own
   * region, and every candidate that could reach this column is inside the
   * margin this region was handed.
   *
   * Density comes from a low-frequency field raised to a power rather than from
   * a flat per-column chance. A flat chance at the same mean is an even dusting
   * of single blades over the entire shelf; the field gives beds with clear
   * water between them, which is the same trick the surface flora plays with
   * `dens`.
   */
  seabedFloraAt(blocks, col) {
    const topK = this._topWaterK(col);
    if (topK < 2) return;
    const inLake = this.lakeSurf[col] > 0;
    // Fresh water takes weed and nothing else, and only two of the four kinds.
    if (inLake && (!this.inLakeBed(col) || !LAKE_WEED[this.lakeKind[col] & 7])) return;
    if (!inLake && (this.colBiome[col] !== BIOME.OCEAN || !this.submerged[col])) return;
    const floorK = this._reefFloorK(blocks, col);
    if (floorK < 0 || floorK + 1 >= topK) return;
    // The sea's depth band; a lake is its own bottom and has no business being
    // measured against the ocean's waterline.
    if (!inLake) {
      const depth = depthOfK(floorK);
      if (depth < SEAB_DEPTH_MIN || depth > SEAB_DEPTH_MAX) return;
    }

    const dir = _reefDir;
    this._dirOf(col, dir);
    // A pond is fresh water at whatever altitude the land put it, so the
    // seabed climate term means nothing there. Weed grows in all of them.
    const temp = inLake ? 0.2 : this._seaTemp(dir);
    // Two fields at two frequencies and two offsets, so a kelp forest and a
    // grass bed are not the same patch wearing two hats.
    const gf = this.nDetail.fbm3(dir[0] * 7.5, dir[1] * 7.5, dir[2] * 7.5, 3, 2, 0.5);
    const kf = this.nDetail.fbm3(dir[0] * 5.0 + 31.7, dir[1] * 5.0, dir[2] * 5.0 - 12.3, 3, 2, 0.5);
    const gDens = clamp(gf * 0.5 + 0.55, 0, 1);
    const kDens = clamp(kf * 0.5 + 0.42, 0, 1);

    const rng = this.colRng(col, 0x5ea9);
    const r = rng();
    const n = KELP_MIN + Math.floor(rng() * (KELP_MAX - KELP_MIN + 1));

    const canGrass = inLake || temp > GRASS_TEMP_MIN;
    const canKelp = inLake || (temp > KELP_TEMP_MIN && temp < KELP_TEMP_MAX);
    const pKelp = canKelp ? KELP_PEAK * Math.pow(kDens, 2.6) : 0;
    const pGrass = canGrass ? GRASS_PEAK * Math.pow(gDens, 2.2) : 0;

    if (r < pKelp) {
      // A stalk that does not fit falls through to nothing rather than to
      // grass: the alternative is a kelp bed in deep water that turns into a
      // lawn wherever the bottom rises, which reads as a bug.
      this._kelpAt(blocks, col, Math.min(n, topK - floorK - 1), floorK, topK);
    } else if (r < pKelp + pGrass) {
      this._propAt(blocks, col, ID.sea_grass, floorK, topK);
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
   * Springs, logs, trees, boulders, then flora, each as a complete sweep. They
   * interact: a boulder is only laid in air, flora reads the surface a canopy
   * may have raised, and a fallen log has to be laid while the cell above the
   * ground still holds terrain (see `_fallenLog`).
   */
  decorateRegion(blocks, cols, margin) {
    const rid = regionOfCol(cols[0]);
    // Springs first: they move the ground, and the three passes after them all
    // ask `_springNear` rather than looking at what is there, so this ordering
    // is for the blocks' sake and not for the decisions'.
    for (let n = 0; n < margin.length; n++) this.springAt(blocks, margin[n], rid);
    // Fallen logs before the trees, and this is the one ordering here that is
    // about the blocks rather than about taste. A log decides from terrain
    // only — so it must run while the cells above the ground still *hold*
    // terrain — and a trunk is stamped with `force`, so a standing tree would
    // overwrite a windfall that had already been laid through it. The log pass
    // refuses those columns outright, which makes the two agree; running
    // second as well would make the agreement depend on the order.
    for (let n = 0; n < margin.length; n++) this.logAt(blocks, margin[n], rid);
    for (let n = 0; n < margin.length; n++) this.treeAt(blocks, margin[n], rid);
    for (let n = 0; n < margin.length; n++) this.boulderAt(blocks, margin[n], rid);
    for (let n = 0; n < cols.length; n++) this.floraAt(blocks, cols[n]);
    // The two underwater passes, last, and in this order. A reef is a feature
    // laid over a margin like a tree is; the grass and kelp are cover laid one
    // column at a time like `floraAt` is, and they run second so that a blade
    // and a coral head never both claim the cell above the same piece of
    // seabed. Nothing above this touches water: trees and flora refuse a liquid
    // cell outright and a boulder is only ever laid into air.
    for (let n = 0; n < margin.length; n++) this.reefAt(blocks, margin[n], rid);
    for (let n = 0; n < cols.length; n++) this.seabedFloraAt(blocks, cols[n]);
  }
}
