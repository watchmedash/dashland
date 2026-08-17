// The nine-face generator. One flat map, `W` by `W` columns and `D` layers
// deep, wrapping on both axes, with one gravity. Terrain is still built per
// column, so the surface is a height field and every block sits upright.
//
// WHAT WENT, and it is most of the win: there are no cube seams, so there is no
// border fade, no border lift, no seam walk band, no slope limiter, no sea
// re-flood, no seam floor, no spawn or tree edge margin, and no canyon or lake
// suppression in a band. Every one of those existed to manage two faces meeting
// at an angle. Nothing meets at an angle now.
//
// The five cross faces (2, 4, 5, 6, 8) are generated as ONE field and nothing at
// all is done at a tile boundary; the four corners (1 Rime, 3 Tempest,
// 7 Verdant, 9 Pyre) are sealed rooms, each the whole of one biome, walled off
// by the dividers this file also builds.

import { makeRng, clamp, lerp, smoothstep } from '../util/Noise.js';
import {
  D, W, SEA_K, K_CORE, K_MANTLE, K_SURFACE, K_TERRAIN_MAX,
  K_SEABED_MIN, K_CANYON_MIN,
  COLUMNS, CHUNK_T, BIOME, regionOfCol,
  FACE_ROLE, FACE_NORMAL, FACE_RIME, FACE_TEMPEST, FACE_VERDANT, FACE_PYRE,
} from './Constants.js';
import {
  wrap, faceAt, isWall, delta, START_FACE, faceOrigin, colIndex, F,
  gateAt, GATE_H, DIR_STEP,
} from './Grid.js';
import { Periodic, surfScale, MAXA } from './Periodic.js';
import { ID, N_BLOCKS, IS_OPAQUE, supports, growsOn } from './Blocks.js';

// --- the flat map's own arithmetic -------------------------------------------
//
// Four one-liners that replace the whole of `Sphere.js`. There is no ownership
// rule, no fold and no normalisation: a column index is `x * W + y` and a cell
// index is that times `D` plus the layer, and reading or writing a cell is the
// same function, because no two columns share a cell any more.

/** Column index for a possibly out-of-range (x, y). */
const colOf = (x, y) => wrap(x) * W + wrap(y);
/** Cell index. Column major, so a column's layers stay contiguous. */
const cellAt = (col, k) => col * D + k;
/** `cellWrite` and `cellIndex` were two names for this. They are one now. */
const _xy = { x: 0, y: 0 };
/** The (x, y) a column index came from, into a caller-owned scratch. */
function colXY(col, out = _xy) {
  out.y = col % W;
  out.x = (col - out.y) / W;
  return out;
}
/** North, south, west, east. Every column has all four; none can be missing. */
const NB_DX = [0, 0, -1, 1], NB_DY = [-1, 1, 0, 0];
function colNeighbor(col, d) {
  const y = col % W, x = (col - y) / W;
  return colOf(x + NB_DX[d], y + NB_DY[d]);
}
/** The column `(dx, dy)` from (x, y). No re-projection: the map is flat. */
const patchCol = (x, y, dx, dy) => colOf(x + dx, y + dy);

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
 * The crust is K_MANTLE up to SEA_K — everything above the waterline shares the
 * topmost band, which is what the old absolute thresholds did too. The four
 * fractions are the old edges (126, 120, 114, 110.5) re-expressed against the
 * old crust of 108..130, so the proportions of every stratum are preserved
 * exactly while the thicknesses grow with the shell.
 */
const CRUST = SEA_K - K_MANTLE;
/**
 * A radius from the old 108-mantle/130-sea crust, placed in the current one.
 *
 * The ore ladder was tuned by hand against those numbers over a long time, and
 * the depths are meaningful relative to each other — the deep seam sits under
 * the shallow one, gold under silver, moss just below the surface. Rescaling
 * them all through one function keeps every one of those relationships exactly
 * as it was tuned, which re-deriving each band by eye would not.
 */
const band = (r108) => K_MANTLE + (r108 - 108) * (CRUST / 22);

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
 * The bound is against MAXA rather than against 1: the periodic lattice's
 * ceiling is not the simplex's, and using the wrong one here would either skip
 * ore that should have generated or stop skipping anything.
 *
 * @returns the fbm value, or -1 when it provably cannot reach `thr`.
 */
function veinNoise(no, x, y, k, sc, koff, thr) {
  const s1 = no.volOne(x, y, k, sc, koff);
  if (s1 + 0.5 * MAXA <= thr * 1.5) return -1;
  return (s1 + 0.5 * no.volOne(x, y, k, sc * 2, koff * 2)) / 1.5;
}
const BAND_STONE = K_MANTLE + CRUST * 0.818;      // was 126
const BAND_LIMESTONE = K_MANTLE + CRUST * 0.545;  // was 120
const BAND_GRANITE = K_MANTLE + CRUST * 0.273;    // was 114
const BAND_SLATE = K_MANTLE + CRUST * 0.114;      // was 110.5

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
 * How far the domain warp moves a sample point, in columns.
 *
 * The cube warped a unit direction by 0.16 and a column subtended 0.0037765 of
 * one, so 0.16 was 42 columns of displacement. Written in columns here because
 * columns are what the map has, and because a number in the units of the thing
 * it moves is a number the next reader can check against a screenshot.
 */
const WARP_COLS = 42.4;

/**
 * The ocean's depth profile, in blocks below sea level, as a function of how
 * many columns a cell sits from the nearest land.
 *
 * The sea used to bottom out at six blocks and sit at one for half its area,
 * because the height field flattens everything within three units of sea level
 * toward SEA_K - 0.4 — the same line that stops the coast fraying into a
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
// An `OCEAN_MAX_DEPTH = SEA_K - K_SEABED_MIN` sat here with nothing reading it,
// and its comment said 15 when the two constants have made it 17 for some time —
// a stale number in a name that looks like the floor of the sea. The floor is
// real and is applied where it can be: `Math.max(K_SEABED_MIN, ...)` clamps the
// bathymetry as it is written into colHeight.

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
 * What grows on the *grit* a canyon lays on its floor — the gravel and the red
 * sand, as opposed to the coarse dirt, which is soil and takes the ordinary
 * turf plants.
 *
 * Indexed by biome, and it has to be, which is the bug this table fixes. The
 * grit branch of `floraAt` scattered `thornbrush` on every gravel canyon floor
 * on the planet regardless of where that floor was, and a canyon is cut wherever
 * the walk happened to go — so measured planet-wide, 550 of the 1,726 thorn
 * bushes in the world were standing in snow, mountain and forest gorges. The
 * soil rule could not catch it: gravel is legitimately thornbrush ground (see
 * FLORA_SOIL), so every one of them was botanically fine and geographically
 * absurd, which is the other half of "plants growing on wrong biome/block".
 *
 * A hole means that biome's gorge floor keeps its grit bare, and most of them
 * are holes on purpose. Nothing in the palette roots in gravel *and* belongs in
 * a meadow, a forest or a plain — those biomes' own plants (clover, fern,
 * lavender) all take turf and nothing else — so the honest answer there is
 * nothing at all, and the coarse-dirt half of the same branch still gives those
 * gorges their tufts of grass. Snow is a hole for the same reason from the
 * other end: the snowbell only grows in snow, and a snow gorge's floor is
 * scoured down to gravel.
 *
 * `growsOn` remains the authority — the species chosen here is still put
 * through `_floraSoilOk` — so this narrows what may grow and can never widen it.
 */
const CANYON_SCRUB = [];
CANYON_SCRUB[BIOME.DESERT] = ID.thornbrush;
CANYON_SCRUB[BIOME.BADLANDS] = ID.thornbrush;
CANYON_SCRUB[BIOME.MOUNTAIN] = ID.alpine_aster;
// Tundra used to be here with `cotton_grass`, and it is a hole now for the
// snow biome's reason: the sedge lost gravel when the soil table was tightened
// (see FLORA_SOIL), and a canyon's grit is gravel and red sand. Leaving the
// entry in would have been dead code — `_floraSoilOk` refuses every column it
// could reach — and dead code that looks like an intent is worse than the hole.

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
  { id: ID.voidstone_ore, scale: 0.62, thr: 0.60, lo: K_MANTLE, hi: band(111), seed: 907 },
  { id: ID.ruby_ore, scale: 0.50, thr: 0.58, lo: K_MANTLE, hi: band(112.5), seed: 719 },
  { id: ID.sapphire_ore, scale: 0.50, thr: 0.58, lo: K_MANTLE, hi: band(113), seed: 733 },
  { id: ID.emerald_ore, scale: 0.48, thr: 0.57, lo: K_MANTLE, hi: band(114), seed: 641 },
  { id: ID.deep_crystal_ore, scale: 0.46, thr: 0.60, lo: K_MANTLE, hi: band(113), seed: 811 },
  { id: ID.deep_gold_ore, scale: 0.38, thr: 0.58, lo: K_MANTLE, hi: band(114), seed: 557 },
  { id: ID.deep_silver_ore, scale: 0.36, thr: 0.57, lo: K_MANTLE, hi: band(113.5), seed: 463 },
  { id: ID.deep_iron_ore, scale: 0.30, thr: 0.55, lo: K_MANTLE, hi: band(116), seed: 389 },
  { id: ID.deep_copper_ore, scale: 0.28, thr: 0.55, lo: K_MANTLE, hi: band(115), seed: 293 },
  { id: ID.deep_coal_ore, scale: 0.24, thr: 0.53, lo: K_MANTLE, hi: band(116), seed: 197 },

  { id: ID.sulfur_ore, scale: 0.34, thr: 0.57, lo: K_MANTLE, hi: band(118), seed: 101 },
  { id: ID.amethyst_ore, scale: 0.42, thr: 0.60, lo: K_MANTLE + 2, hi: band(120), seed: 149 },
  { id: ID.crystal_ore, scale: 0.40, thr: 0.62, lo: band(112), hi: band(121), seed: 219 },
  { id: ID.gold_ore, scale: 0.34, thr: 0.60, lo: band(114), hi: band(125), seed: 143 },
  { id: ID.silver_ore, scale: 0.32, thr: 0.58, lo: band(113), hi: band(124), seed: 89 },
  { id: ID.iron_ore, scale: 0.26, thr: 0.56, lo: band(116), hi: K_SURFACE - 2, seed: 71 },
  { id: ID.copper_ore, scale: 0.24, thr: 0.55, lo: band(120), hi: K_TERRAIN_MAX, seed: 37 },
  { id: ID.coal_ore, scale: 0.20, thr: 0.52, lo: band(118), hi: K_TERRAIN_MAX, seed: 0 },

  { id: ID.gravel, scale: 0.14, thr: 0.58, lo: K_MANTLE + 4, hi: K_TERRAIN_MAX, seed: 311 },
  // Clay and moss keep the bands they always had — clay's `lo` was 32, i.e.
  // below the innermost radius, so it has always meant "everywhere the host
  // rock reaches". Narrowing it here would quietly halve the brick supply.
  { id: ID.clay, scale: 0.22, thr: 0.62, lo: K_MANTLE, hi: SEA_K, seed: 407 },
  { id: ID.moss_stone, scale: 0.18, thr: 0.60, lo: K_MANTLE, hi: K_SURFACE, seed: 503 },
  // Moss is the only way to get a soft green block underground, and it is
  // shallow on purpose: it belongs to the cave mouth, not to the deep.
  { id: ID.moss_block, scale: 0.20, thr: 0.66, lo: band(124), hi: K_SURFACE, seed: 601 },
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
  const r = k + 0.5;
  ORE_BY_LAYER.push(ORES.filter((o) => r >= o.lo && r <= o.hi));
}

/**
 * The cinderlands' own ore, in the layers above every ordinary band.
 *
 * The bands in ORES stop well below the ground you walk on — iron ends two
 * blocks under mean sea level, gold and crystal lower still — so the top of a
 * cinder cliff carries coal and copper and nothing else, and the only way to
 * find anything worth the trip is to guess and dig. That is the owner's report.
 *
 * Each entry is the *same field* as its counterpart in ORES: same scale, same
 * seed, so this is not a second set of veins but the existing ones allowed to
 * keep going upward on one face. `lo` is the ore's own ordinary `hi`, so the
 * two never overlap and the seam is continuous through the join.
 *
 * What keeps it a reward rather than a strip mine is the threshold. Every one
 * of these sits well above the band it continues (0.66-0.72 against 0.55-0.62),
 * so only the fat core of a vein survives the climb: the seam thins as it rises
 * and breaks into pockets near the surface, which is what makes finding one
 * feel like reading the ground.
 */
const ORE_CINDER_SURFACE = [
  { id: ID.crystal_ore, scale: 0.40, thr: 0.76, lo: band(121), hi: K_TERRAIN_MAX, seed: 219 },
  { id: ID.gold_ore, scale: 0.34, thr: 0.74, lo: band(125), hi: K_TERRAIN_MAX, seed: 143 },
  { id: ID.sulfur_ore, scale: 0.34, thr: 0.70, lo: band(118), hi: K_TERRAIN_MAX, seed: 101 },
  { id: ID.silver_ore, scale: 0.32, thr: 0.72, lo: band(124), hi: K_TERRAIN_MAX, seed: 89 },
  { id: ID.iron_ore, scale: 0.26, thr: 0.66, lo: K_SURFACE - 2, hi: K_TERRAIN_MAX, seed: 71 },
];

/** The cinder seams alone, per layer, and the same list folded into ORE_BY_LAYER. */
const ORE_CINDER_ONLY = [];
const ORE_CINDER_BY_LAYER = [];
for (let k = 0; k < D; k++) {
  const r = k + 0.5;
  const mine = ORE_CINDER_SURFACE.filter((o) => r >= o.lo && r <= o.hi);
  ORE_CINDER_ONLY.push(mine);
  // Rarest first, as in ORES: the loop stops at the first vein that claims a
  // cell, so a common shallow ore listed above a rare one starves it.
  ORE_CINDER_BY_LAYER.push(mine.concat(ORE_BY_LAYER[k]));
}

/**
 * The skin of a cinder column, which no vein could reach before.
 *
 * The other half of "you can only guess and dig", and the bigger half: the top
 * four blocks of a cinder column are basalt, ash and magma stone, none of which
 * is an ORE_HOST — so however far a seam climbs it is still capped by rock that
 * cannot carry it, and the open ground reads as bare everywhere the slope pass
 * has not already turned it to stone.
 *
 * Only ORE_CINDER_SURFACE is allowed through it, and that restriction is the
 * whole difference between a reward and a strip mine. Let the ordinary bucket
 * in as well and coal and copper — threshold 0.52 and 0.55 before the cinder
 * bonus, by far the commonest things in the table — freckle every basalt slab
 * on the face: measured, 3 100 of them showing in a 200-column patch.
 *
 * Magma stone is deliberately not here, for ORE_HOST's own reason: it glows,
 * and a glowing pocket is a landmark that should not be buried under ore.
 * Sunstone is not either, for the same reason and more so.
 */
const CINDER_SKIN_HOST = new Uint8Array(N_BLOCKS);
CINDER_SKIN_HOST[ID.basalt] = 1;
CINDER_SKIN_HOST[ID.ash_stone] = 1;

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
const AQ_K0 = Math.max(1, Math.floor(AQ_LO - 0.5) - 1);
const AQ_K1 = Math.min(D - 2, Math.ceil(AQ_HI - 0.5) + 1);

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
/**
 * Three radii, not two, and the pool got half as wide again.
 *
 * At 2.6/1.6 the water was three columns across and two blocks deep against a
 * 1.8-block player, so the only thing you could do in a hot spring was swim in
 * it — head under, breath meter running — which is what a well is for. A bath
 * you can sit in is a floor at chest height, and a voxel world has exactly two
 * offers: one block of water (shin) or two (over your head). So it is both. The
 * middle stays two deep, the ring around it is one, and the step between them
 * is a ledge you stand on with the water at your waist.
 *
 * SPRING_RI is SPRING_R minus exactly 1 and has to stay that way: it is what
 * makes the enclosure structural. A unit step moves a column's radius by at
 * most 1, so every 4-neighbour of a water column is inside the rim, and no
 * water cell can have an open side. See `springAt`.
 */
const SPRING_R = 3.7;          // rim radius, in columns
const SPRING_RI = 2.7;         // water radius — SPRING_R - 1, see above
const SPRING_RD = 1.5;         // the deep middle; outside it the pool is a shelf
/**
 * 0.14 and not the old 0.085. The flatness test runs over the rim radius, so
 * widening the pool made it much harder to satisfy — a 3.7-column disc has to
 * be level to within one block where a 2.6-column one did. Measured over the
 * whole planet: at the old chance the wider pool gave 71 springs against 179,
 * which is a feature you would not find. This puts it back to the same order.
 */
const SPRING_CHANCE = 0.14;
// Moved off the cap and onto the cinderlands. A hot spring is water heated
// from below, so a face of basalt and lava is where it belongs and a snowfield
// is where it never made sense - the owner: "having hotsprings in snow face
// doesn't make sense, perhaps put that hotspring in magma face". Mountain stays
// because an alpine spring is the one temperate case that reads correctly.
const SPRING_BIOMES = [BIOME.CINDER, BIOME.MOUNTAIN];

/**
 * Waterfalls: a seep in a cliff face, falling into water that is already there.
 *
 * ---- why there were none, and why relaxing anything is the wrong fix -------
 *
 * Every cell of worldgen liquid becomes a permanent `sources` entry the first
 * time its region is seeded, and a source never drains. So the generator has
 * exactly one obligation about water and it is absolute: whatever it writes has
 * to be a FIXED POINT of `Water.update`, or the first player edit anywhere near
 * it wakes the cell and it starts spreading. LAKE_FREEBOARD and LAKE_CAVE_CLEAR
 * are that obligation discharged for lakes, and they are load-bearing. Nothing
 * here loosens them.
 *
 * Read against the tick, a source cell is inert when both of these hold:
 *
 *   - the cell below it is not somewhere the liquid can go (rule: fall first),
 *   - every tangential neighbour is solid or is liquid at least as deep
 *     (rule: creep outward, losing a level a step).
 *
 * A visible fall breaks the second one by definition: the whole point is open
 * air beside the water. What makes this possible anyway is the sim's OTHER
 * rule, the one that exists so a filled shaft does not become a thirty-storey
 * wall of water walking across the floor: a NON-source cell with liquid both
 * above and below it is the middle of a falling column, and it does not creep
 * at all. So the body of a fall is inert for free — provided it is registered as
 * flowing water rather than as a spring, which is what `_seedWaterRegion` is
 * for, and provided it never runs out of liquid above or below it.
 *
 * That fixes the shape of the feature completely, and every constraint below is
 * one of those two ends:
 *
 *   THE FOOT is submerged. The fall lands in water that already exists — the
 *   sea, or a lake — so the lowest falling cell has liquid beneath it and is
 *   still a middle cell. Landing on dry rock would make it a FOOT cell, which
 *   spreads six columns at full strength, and on a slope those six columns fall
 *   again and spread six more. That is the unbounded case, and it is excluded
 *   by never generating it. No plunge pool is dug, because a dug pool is a new
 *   basin to prove watertight and the planet already has two that are proven.
 *
 *   THE HEAD is roofed and walled. The topmost cell has air above it, so it is
 *   not a middle cell and cannot be flowing water either — nothing feeds it, and
 *   `_maybeDry` would drain the fall from the top down. It has to be a spring,
 *   and a spring is only inert if all four of its sides are shut. So the pass
 *   writes stone into all four tangential neighbours at the head layer and one
 *   cell of roof over it, unconditionally, whatever was there. The water
 *   emerges from under a rock lip one layer down, where the column is already
 *   inert. Containment at the head is therefore structural — it is written, not
 *   tested — which is the only kind that survives a cave the site test never
 *   asked about.
 *
 * The fall is ONE column wide and that is a correctness constraint, not a
 * style: `_seedWaterRegion` identifies falling water by "liquid above, liquid
 * below, no tangential liquid, at least one tangential air", and the third
 * clause is what tells a waterfall apart from the inside of the ocean beside a
 * cave mouth. Two adjacent falling columns would each veto the other.
 *
 * The whole footprint is required to sit inside one region, for the same
 * reason: the seed pass runs per region and can only read its own blocks, so a
 * fall straddling a boundary would have its air neighbours read as unbuilt and
 * come back a spring.
 */
const FALL_CHANCE = 0.5;
/** Layers of drop. Under seven reads as a spill, not a fall. */
const FALL_MIN_DROP = 7;
/**
 * 40 and not D. Every falling cell is a `level` entry that is written to the
 * save, and the cap is what bounds that: a 40-layer fall is 40 entries.
 */
const FALL_MAX_DROP = 40;
/** Head clearance: the lip sits this far under the cliff-top column's surface. */
const FALL_LIP = 2;

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
/**
 * The four standing trees. Trunks are a little taller than they were: the crown
 * hangs three courses below its top, so a five-block trunk put leaves at knee
 * height and the tree read as a bush; these leave two or three clear blocks of
 * trunk. Module scope because `_treeSize` and `stampTree` both read it.
 */
/**
 * How tall a cactus grows: 2 to CACTUS_MAX segments. Named because
 * `_cactusHasRoom` has to bound the layers a cactus will occupy without
 * drawing the height, and a literal in two places is how the room check and
 * the plant it protects come to disagree.
 */
const CACTUS_MAX_STEP = 3;
const CACTUS_MAX = 1 + CACTUS_MAX_STEP;

const TREE_CFG = {
  oak: { h: [6, 8], log: ID.log_oak, leaf: ID.leaves_oak, rad: 2.6, shape: 'round' },
  birch: { h: [7, 10], log: ID.log_birch, leaf: ID.leaves_birch, rad: 2.2, shape: 'round' },
  pine: { h: [7, 11], log: ID.log_pine, leaf: ID.leaves_pine, rad: 3.0, shape: 'cone' },
  savanna: { h: [5, 7], log: ID.log_oak, leaf: ID.leaves_oak, rad: 3.3, shape: 'flat' },
  /**
   * Verdant's tree, and the only reason the face reads as a jungle rather than
   * as a green field.
   *
   * Taller and much wider than anything in the cross: `_treeSize` damps the
   * crown by up to 1.225 and the round profile frays another 0.45 past that, so
   * 3.8 comes out at 5.1 columns of reach against DECOR_MARGIN's 6 — the widest
   * a tree is allowed to be without a canopy running off the edge of the margin
   * a region was handed. It uses the oak's own log and leaf so the face needs no
   * new art to exist; what makes it a jungle is the density, the height and the
   * tint row, not a second green.
   */
  jungle: { h: [11, 16], log: ID.log_oak, leaf: ID.leaves_oak, rad: 3.8, shape: 'round' },
};

/** The two ids per species, indexed [axis 0:i 1:j]. */
const LOG_IDS = {
  oak: [ID.log_oak_i, ID.log_oak_j],
  birch: [ID.log_birch_i, ID.log_birch_j],
  pine: [ID.log_pine_i, ID.log_pine_j],
};

/**
 * Sink patches — quicksand in a desert, powder snow in a snowfield: how big,
 * how rare, and how deep.
 *
 * Not on a lattice, unlike the springs, the lakes and the fallen logs, and the
 * difference is what the feature IS. Those three are objects — a pool, a tarn,
 * a trunk — that have a centre, a radius and a rim, and a lattice is how you
 * ask "is there one near this column" in O(1). A patch of ground that has gone
 * soft has no centre. It is a property of the ground, like the podzol under a
 * pine wood and the drift over tundra, and both of those are noise fields read
 * per column in exactly this pass. So this is one more `fbm3` beside `patch`,
 * and it costs a column what those cost.
 *
 * QS_FREQ 34 against `patch`'s 14, which that comment measures at "a blob about
 * twenty columns across": the same arithmetic puts one of these at about eight,
 * and the part of it standing over the threshold at four to six. That is the
 * size it has to be. Much larger and there is no way round it and no way out of
 * the middle of it; much smaller and it is a puddle you step over without ever
 * finding out what it was.
 *
 * QS_RIM is the whole of the legibility argument, and it is worth more than the
 * colour — which matters most for the snow, where there is no colour to have.
 * A patch is deep in the middle and exactly ONE layer at the edge, so the first
 * thing that happens to anybody walking into one is that they go in to the
 * ankle and stop, with solid ground under the boot and the whole body clear.
 * Everything after that is a choice the player made with the evidence in front
 * of them, which is the difference between a hazard and an ambush.
 *
 * The two members differ only in how deep the middle is, and that is the whole
 * of what makes them feel unalike. A quicksand pool is two layers, so the eye
 * goes under and the escape is a shuffle. A snow drift is three, so you fall
 * in — it is a fall, that is the point of the block — and the escape is longer
 * than the shiver takes to start.
 */
const QS_FREQ = 34;
const QS_THR = 0.40;
const QS_RIM = 0.06;
const SINK_DEPTH_SAND = 2;
const SINK_DEPTH_SNOW = 3;
/**
 * Rock that must stand under a patch before a cave may open, in blocks.
 *
 * The ordinary skin is 2.2, which is wrong here by up to two cells. A
 * three-layer drift occupies depths 0..3, so its floor is the cell centred at
 * depth 3.5 — well past 2.2, so the carve is allowed to take it. The result is
 * not a cosmetic seam: it is a drift with a cavern roof for a bottom, and a
 * body that sinks through one arrives in the dark at whatever speed the drop is
 * worth. This is the deepest patch plus the ordinary skin, and since the carve
 * tests `depth >= skin` it makes the floor and the cell under it solid by
 * construction rather than by a check afterwards.
 */
const QS_CAVE_CLEAR = SINK_DEPTH_SNOW + 2.2;

/**
 * Shared (x, y) scratch for the per-column passes — they are called a million
 * times. These were `[0, 0, 0]` unit directions on the cube; a column's sample
 * point is now just its own map coordinates.
 */
const _fillXY = { x: 0, y: 0 };
/** Aquifers and springs get their own, because they run inside the others. */
const _aqXY = { x: 0, y: 0 };
const _spParts = { x: 0, y: 0 };
/**
 * Two more for the fallen logs, and they have to be two. The log pass holds a
 * candidate's coordinates across a loop that calls `_springNear` — which owns
 * `_spParts` — and inside that loop walks a second column's neighbourhood.
 * Sharing any of the three would rewrite the centre halfway through the run.
 */
const _logParts = { x: 0, y: 0 };
const _logNb = { x: 0, y: 0 };
/**
 * And one for the cactus's room check, which holds its centre live across a
 * sweep that calls `_treeKind` — which owns `_spParts` through `_springNear`
 * and allocates its own for the parity test. Sharing either would move the
 * centre halfway through the sweep.
 */
const _cactusParts = { x: 0, y: 0 };
/** And one for the waterfalls, which run in their own sweep. */
const _fallParts = { x: 0, y: 0 };

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
/**
 * A plunge basin: the fifth kind, and the one that exists to have a waterfall
 * come into it.
 *
 * The planet had no waterfalls and could not have one, and the reason turned
 * out not to be the water rules at all — it was that the height field has no
 * cliffs next to water. Measured over every one of the 448 000 columns that
 * hold water, the largest step between a water column and a tangential
 * neighbour on the whole planet is EIGHT layers, and only one column on the
 * planet reaches it; the median is under two. Ground six columns inland of a
 * shore is typically five layers up. There is nowhere for water to fall from.
 *
 * So the basin makes its own. It is a tarn in shape — steep walls, flat floor —
 * but it is sited by the two tests that all four older kinds use to REJECT a
 * hillside, run the other way round. LAKE_TOL is how far the rim may tower over
 * its own lowest point before the site is called a cliff rather than a shore,
 * and LAKE_CUT is how much ground, per bed column, had to be dug away to reach
 * the waterline. Every other kind wants both small. This one wants them large,
 * which is exactly a bowl bitten out of a mountainside with one wall standing
 * fifteen or twenty layers over the water.
 *
 * Nothing about the containment argument changes and nothing about it is
 * relaxed. The surface is still `rim - LAKE_FREEBOARD` with `rim` the MINIMUM
 * ground over a ring that is never carved, so the basin is still provably
 * sealed at every layer it holds water; LAKE_CAVE_CLEAR still applies, because
 * `lakeSurf` is what the cave carve reads. TOL and CUT were only ever site
 * taste, and this kind's taste is the opposite one.
 */
const LAKE_PLUNGE = 5;
/** Bank rather than bed: not carved, re-surfaced, and never holds water. */
const LAKE_SHORE = 0x80;
/** Bed raised back above the waterline: an islet in a large pond. */
const LAKE_ISLE = 0x40;
/**
 * The hard ceiling on the wobbled radius. Everything else is pinned to it:
 * LAKE_LATTICE is 2 * (this + 1 guard column) rounded up, and LAKE_BFS is the
 * L1 radius that provably contains a Euclidean disc of this size — L1 distance
 * is what the column graph measures, and a diamond of radius r only reaches
 * r/sqrt(2) on the diagonal.
 *
 * There is no longer a rule about keeping a disc on one face: a lake that
 * straddles a join inside the cross is a lake that straddles a join, and
 * nothing about the join is different from any other pair of columns.
 */
const LAKE_MAX_R = 11.5;
const LAKE_BFS = Math.ceil((LAKE_MAX_R + 2.5) * Math.SQRT2) + 1;
const LAKE_DISC_MAX = 2 * LAKE_BFS * LAKE_BFS + 2 * LAKE_BFS + 1 + 64;
// A `LAKE_COL_PER_RAD` stood here, converting angular distance on the sphere
// into columns so a lake would not come out an L1 diamond. The map is flat and
// wraps, so the distance between two columns is `hypot(delta(x), delta(y))` in
// columns already, and the conversion has nothing left to convert.
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
 * SEA_K + 5 to Mountain or Snow — so Plains, Forest, Meadow, Savanna, Tundra,
 * Desert and Badlands all live in a five-block band over sea level, with a
 * median of about two. A floor of SEA_K + 4, which looks conservative, rejected
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
LAKE_MIN_ALT[LAKE_POND] = SEA_K - 0.25;
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
LAKE_MIN_ALT[LAKE_TARN] = SEA_K + 9;
LAKE_R[LAKE_MARSH] = [6.5, 9.5];
LAKE_DEPTH[LAKE_MARSH] = [1.7, 2.3];
LAKE_WOBBLE[LAKE_MARSH] = [0.26, 0.12];
LAKE_BED_ROUGH[LAKE_MARSH] = 0.35;
LAKE_CHANCE[LAKE_MARSH] = 0.85;
LAKE_TOL[LAKE_MARSH] = 5.0;
LAKE_CUT[LAKE_MARSH] = 2.0;
LAKE_MIN_ALT[LAKE_MARSH] = SEA_K - 0.25;
LAKE_R[LAKE_OASIS] = [3, 4.5];
LAKE_DEPTH[LAKE_OASIS] = [2.2, 3.2];
LAKE_WOBBLE[LAKE_OASIS] = [0.14, 0.07];
LAKE_BED_ROUGH[LAKE_OASIS] = 0.3;
// Rare on purpose. A desert with a pool every few hundred metres is not a
// desert, and the whole value of an oasis is that finding one is an event.
LAKE_CHANCE[LAKE_OASIS] = 0.45;
LAKE_TOL[LAKE_OASIS] = 5.0;
LAKE_CUT[LAKE_OASIS] = 2.0;
LAKE_MIN_ALT[LAKE_OASIS] = SEA_K - 0.25;
LAKE_R[LAKE_PLUNGE] = [3.4, 5.4];
LAKE_DEPTH[LAKE_PLUNGE] = [4.0, 6.0];
LAKE_WOBBLE[LAKE_PLUNGE] = [0.12, 0.06];
LAKE_BED_ROUGH[LAKE_PLUNGE] = 0.7;
LAKE_CHANCE[LAKE_PLUNGE] = 0.6;
/**
 * 26 and 15, against a tarn's 9 and 3.2, and these two numbers ARE the feature.
 *
 * TOL lets one side of the rim stand 26 layers over the lowest side, which is
 * the wall the water comes over. CUT lets fifteen layers of ground per bed
 * column be dug away to reach the waterline, which is what a bowl bitten into
 * a mountainside costs. Both are site taste and neither touches the seal — see
 * LAKE_PLUNGE. What they cannot be is unbounded: a basin whose rim towers 40
 * layers is a mineshaft, and the drop is capped again at the fall itself by
 * FALL_MAX_DROP.
 */
LAKE_TOL[LAKE_PLUNGE] = 26.0;
LAKE_CUT[LAKE_PLUNGE] = 15.0;
/** Mountain country only, and well clear of the sea. */
LAKE_MIN_ALT[LAKE_PLUNGE] = SEA_K + 8;
/** The least water a site has to hold to be worth being a lake at all. */
const LAKE_MIN_DEPTH = 1.5;
const LAKE_MIN_CELLS = 8;

/**
 * What KIND of water a column holds, for the renderer and nothing else.
 *
 * Every body of water on the planet was one block, one shader and one pair of
 * hardcoded colours, graded only by depth — so a peat marsh, a slate tarn and
 * the open ocean differed exactly as much as the shallow end of a bay differs
 * from the deep end of it, which is to say a marsh read as "ocean, three blocks
 * down". The beds and the banks were already four different materials; the
 * water above them was not.
 *
 * This is a per-column byte the mesher hands to the liquid shader through the
 * spare third channel of the `tint` attribute, which the liquid path already
 * repurposes for depth and shoreline and leaves at zero. Deliberately NOT a new
 * block id: water is the most-touched id in the game — the flow sim, buckets,
 * freezing, drowning, the reef's cover rule, six `=== ID.water` tests in
 * main.js — and five more of it would be five more chances for one of those to
 * miss a case. A byte the renderer reads and nothing else reads cannot break
 * the sim by construction.
 *
 * It is worker-resident and never transferred or saved: 1.3 MB against the
 * 128 MB block array, and it is a pure function of the seed, so regenerating it
 * on load is the same work as regenerating the terrain it describes.
 *
 * 1..5 are exactly LAKE_POND..LAKE_PLUNGE, so the lake pass can assign
 * `lakeKind & 7` straight across. Do not reorder them apart. 7 is the last
 * value the three spare bits hold; a sixth body of water needs a wider field.
 */
export const WATER_OCEAN = 0;
export const WATER_POND = 1;
export const WATER_TARN = 2;
export const WATER_MARSH = 3;
export const WATER_OASIS = 4;
export const WATER_PLUNGE = 5;
export const WATER_SPRING = 6;
export const WATER_FALL = 7;

/** Scratch for the lake pass. It runs once, world-wide, before any voxel. */
const _lakeXY = { x: 0, y: 0 };

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
 * the planet: cell `k` is centred at `k + 0.5` and water is every cell
 * whose centre is at or under SEA_K, so it is one number and not a search.
 * Deriving it from the constants rather than scanning the block array for the
 * last `ID.water` is not an optimisation — a scan would be reading the column
 * *after* an earlier pass may have written into it.
 */
const SEA_TOP_K = Math.floor(SEA_K - 0.5);
/** Depth below the waterline of the floor cell whose layer is `k`. */
const depthOfK = (k) => SEA_K - (k + 0.5);
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
 * The depth band, in blocks below SEA_K, measured to the floor cell's centre.
 *
 * 2 was the shallowest a prop can stand without owning the surface quad, and
 * the band ran to 12 — so measured in the running game the whole distribution
 * sat between 2 and 11 and peaked at 5. That is the shelf you can stand on and
 * see the bottom of, which is exactly the complaint: a reef you meet by wading
 * is not something you dive for.
 *
 * 5 to 16 instead. The floor is deep enough that a reef is under the surface
 * rather than beside it, and 16 is against the real bathymetry — the ocean
 * bottoms out at SEA_K - K_SEABED_MIN = 17 — so the band now reaches the foot
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
 * Sea grapes, which are a reef thing and only a reef thing.
 *
 * Taken out of the *grass skirt* rather than out of the coral, and that is not
 * an implementation detail. Caulerpa grows on the open sand between heads, not
 * on the heads; putting the band after the coral term means a reef's coral
 * count is exactly what it was before this pass existed, and what changes is
 * that some of the carpet at the edges and in the gaps is now something you can
 * eat. A band inserted before the coral would have quietly thinned every reef
 * on the planet to pay for a vegetable.
 *
 * Warm-scaled like the coral, and rising toward the rim (`1 - w`) for the same
 * reason the grass does: the middle of a reef is heads, the edge is sand.
 *
 * Measured planet-wide at this value: 2,441 grapes, against 1,136-1,698 of each
 * coral and 1,581 sponges � the most common thing on a reef that is not carpet,
 * which is right for the plant a diver is supposed to come home with. The coral
 * counts are unchanged to the block by this pass, which is what taking the band
 * out of the skirt rather than out of the heads bought.
 */
const REEF_GRAPE = 0.30;
/**
 * Sea lettuce: the third kind of cover, and the one you can eat.
 *
 * Its own noise field at its own frequency and offset, exactly as the kelp and
 * the grass have theirs — three fields, so a lettuce bed, a kelp forest and a
 * grass meadow are three different places rather than one place wearing three
 * hats. The peak is under two thirds of the grass's and the exponent is higher,
 * which measures out at 7,994 planet-wide against sea grass's 26,891 and kelp's
 * 13,646 — common enough that a hungry swimmer finds one without hunting, rare
 * enough that a shelf does not read as a salad bar. Almost all of it comes out
 * of the *empty* cells rather than out of the carpet: the same measurement puts
 * sea grass down only 1,623 for a pass that added 7,994.
 *
 * Warmer-limited than the grass (which will grow anywhere that is not polar)
 * because Ulva is a shallow, sunlit plant and because the two need to be
 * separable — a player has to be able to learn "the pale broad one is food",
 * and that is easier where they are not perfectly co-extensive.
 */
const LETTUCE_PEAK = 0.40;
const LETTUCE_TEMP_MIN = 0.05;
/**
 * The abyssal anemone: the deep floor's light, and the rarest thing that grows.
 *
 * Depth is the whole gate. The reef band tops out at 16 and the ocean bottoms
 * out at SEA_K - K_SEABED_MIN = 17, so "below the reef" is not a clean cut —
 * instead this fades in from 13.5 and is only at full strength at 16.5, which
 * in practice means the flat floor beyond the foot of the continental slope.
 * The two bands do overlap between 13.5 and 16, and the overlap is thin twice
 * over: a reef needs warm water and a lattice hit, and the anemone's own
 * probability there is a fraction of its full one. Where they do land on the
 * same column the reef wins, because `reefAt` runs first and `_propAt` refuses
 * a cell that is not water — that is an ordering, not a race.
 *
 * ABYSS_CHANCE is a per-column probability at full depth and in the middle of a
 * patch, so the planet-wide count is far below what it looks like: measured, 341
 * over the whole world against the giant clam's 440, and 58% of them are on the
 * flat bottom at depth 17. The clump exponent is what stops those few hundred being an even
 * dusting — an anemone you meet is usually within sight of another, so finding
 * one is worth swimming around for, and the dark floor between the patches is
 * genuinely empty.
 */
const ABYSS_DEPTH_MIN = 13.5;
const ABYSS_DEPTH_FULL = 16.5;
const ABYSS_CHANCE = 0.060;
const ABYSS_CLUMP = 6.0;
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
const _reefXY = { x: 0, y: 0 };

/**
 * The land flora, the cave floor, and the stands.
 *
 * Three passes, and they exist because before them the entire surface of the
 * planet grew four things, all four keyed off one block. `floraAt` tests
 * `surf === ID.grass` and then scatters `tall_grass` and three flowers, so a
 * meadow, a plain, a forest floor and a mountain shoulder are the same ground
 * cover at the same density, and every biome that is not grass-topped — desert,
 * badlands, tundra, snow, beach, and the whole of the underground — grows
 * nothing whatsoever. `floraAt` is left exactly as it was; these run after it
 * and fill what it leaves.
 *
 * The split into three is by *shape of decision*, which is the only split that
 * matters here:
 *
 *   landFloraAt   one column, own column only, noise-modulated. The carpet.
 *   caveFloraAt   one column, own column only, walks the column's air pockets.
 *   standAt       a lattice site and a disc, over the margin. The landmark.
 *
 * The first two need no region clip for `floraAt`'s reason — they write into
 * their own column and nowhere else. The third is a feature like a reef and is
 * clipped like one.
 */

/**
 * Peak per-column odds for the carpet, before the density field.
 *
 * Every one of these is multiplied by `pow(dens, LAND_CLUMP)` where `dens` is a
 * low-frequency fbm, which is the same trick `seabedFloraAt` plays and it is
 * doing the same job: a flat probability at the same mean is an even dusting of
 * single plants over an entire biome, and what reads as a biome is beds of one
 * thing with bare ground between them. The exponent is a little higher than the
 * seabed's because there is more contrast to buy on land — you can see a long
 * way across a plain, and a plain that is uniformly 12% clover is a texture
 * rather than a place.
 *
 * The numbers are not all the same order and that is the point. A savanna is
 * *made of* golden grass and reads wrong at anything under a third; a snowbell
 * is meant to be the one dark thing in an hour of white, so it is at 5%; and
 * driftwood sits at half a percent because a beach with driftwood every ten
 * paces is a lumber yard. See the harness counts in the report.
 */
const LAND_CLUMP = 1.9;

/**
 * The stands: a lattice site, a disc, and one species massed inside it.
 *
 * `landFloraAt` gives every biome a carpet, which fixes "the ground is bare"
 * and does not fix "there is nothing to walk toward". A carpet is by
 * construction the same everywhere it is; what makes a place worth crossing is
 * something you can see the edge of. So seven biomes get a stand — a patch two
 * to seven columns across of that biome's *signature* plant at high density,
 * rare enough that meeting one is an event.
 *
 * On a lattice for the reason SPRING_LATTICE spells out at length, and with the
 * same arithmetic constraint: `2 * STAND_R_MAX < STAND_LATTICE` (6.8 < 8), so
 * two sites can never claim the same column and there is at most one candidate
 * per axis to test. `STAND_R_MAX` is also under DECOR_MARGIN (6), which is the
 * hard bound — a disc that reached further would write outside the margin the
 * region was handed.
 *
 * `(STAND_LI, STAND_LJ)` is `(5, 7)` and had to be chosen: springs sit at
 * (3, 5), reefs at (1, 4) and fallen logs at (6, 2), all modulo 8, and a stand
 * co-sited with any of them would be a stand that is always in the same place
 * relative to that feature.
 */
const STAND_LATTICE = 8;
const STAND_LI = 5;
const STAND_LJ = 7;
const STAND_R_MIN = 2.1;
const STAND_R_MAX = 3.4;
/**
 * How full a stand is at its own centre, before the site's own `rich` roll and
 * the falloff. Not 1.0: a solid disc of one plant reads as a texture swap and a
 * bug, and what says "a stand of lavender" is lavender with ground showing
 * through it.
 */
const STAND_FILL = 0.92;

/**
 * Which biome carries which stand, and how often a lattice candidate takes.
 *
 * Indexed by biome id, so the lookup in `_standSite` is an array read. A hole
 * means that biome has no stand, and five of the twelve are holes on purpose:
 * ocean and beach have no room for one, plains and forest already carry the
 * densest carpets on the planet (clover and fern), and the desert's landmark is
 * the cactus, which has been there all along.
 *
 * The chances look large next to a tree's 0.115 and they are not comparable:
 * this is per *lattice candidate*, which is one column in 64, and it is then
 * cut again by the terrain tests. A badlands stand at 0.16 works out at roughly
 * one per 400 columns of badlands.
 */
const STAND_SPEC = [];
// The badlands takes nearly double everyone else's chance, and it is earned
// rather than chosen: it is the smallest land biome on the planet (1.7% of
// columns) and the most heavily cut by its own canyons, so the same number that
// gives a meadow 133 stands gave it 43. It is also the biome with the least
// else in it, which is exactly why it needed the landmark.
STAND_SPEC[BIOME.BADLANDS] = { id: ID.firebloom, chance: 0.30 };
STAND_SPEC[BIOME.MEADOW] = { id: ID.lavender, chance: 0.20 };
STAND_SPEC[BIOME.PINE_FOREST] = { id: ID.lingonberry, chance: 0.22 };
STAND_SPEC[BIOME.SAVANNA] = { id: ID.aloe, chance: 0.14 };
STAND_SPEC[BIOME.MOUNTAIN] = { id: ID.alpine_aster, chance: 0.18 };
STAND_SPEC[BIOME.SNOW] = { id: ID.snowbell, chance: 0.12 };
// The tundra stand is the one that no longer fills its disc. The sedge now
// takes coarse dirt and nothing else, so `standAt`'s soil test drops every
// column of the disc that came out snow or gravel — and that is wanted rather
// than tolerated: the drift field this ground is cut from is smooth fbm at
// frequency 16, so the soil comes in contiguous patches a dozen columns across,
// and a sedge bog that stops at the edge of the thawed ground reads as a bog
// rather than as a circle stamped on the biome.
STAND_SPEC[BIOME.TUNDRA] = { id: ID.cotton_grass, chance: 0.20 };

/**
 * What a stand is allowed to replace.
 *
 * Air, and the four things `floraAt` scatters — a stand of lavender that
 * stopped at every blade of tall grass would come out as lace. Everything else
 * is refused, and the list is written out rather than expressed as "any cross
 * block" for two reasons that both bite: a tree trunk stands at exactly the
 * cell this pass writes into (`stampTree` starts at `groundK + 1`), and a
 * cactus is a cross block whose upper segments would be left hanging in the air
 * if the bottom one were taken.
 */
const STAND_CLEARS = new Uint8Array(N_BLOCKS);
for (const n of ['air', 'tall_grass', 'flower_red', 'flower_gold', 'flower_blue']) {
  STAND_CLEARS[ID[n]] = 1;
}

/**
 * The cave floor.
 *
 * Caves were bare rock end to end. The one thing that grew down there was the
 * glowcap, at 0.006 per pocket cell out of `floraAt`'s stream, which is a plant
 * every few hundred metres of passage — right for a light source and wrong as
 * the only sign of life in the entire underground.
 *
 * Three species and they are separated by *depth*, so descending is legible:
 * the toadstools and the brackets are a shallow-cave thing and thin out with
 * depth, and the crystal is the opposite and is what the deep is for. The
 * density field is shared by all three at a low frequency and a high exponent,
 * so a cave system has gardens in it and long dead stretches between them,
 * which is the same shape `abyssAt` gives the deep sea floor and for the same
 * reason: a find is only a find if there was nothing for a while before it.
 *
 * These are per *valid floor cell*, of which a deep column has many, so they
 * are an order below what the surface numbers look like. See the report.
 */
const CAVE_CLUMP = 2.2;
const CAVE_MUSH = 0.80;
const CAVE_SHELF = 0.34;
const CAVE_CRYSTAL = 0.45;
/**
 * The two depth ramps, and they are measured against the *crust*, not against
 * D.
 *
 * That distinction cost a whole pass. Written first against D (99) the crystal
 * ramp's denominator was three times the depth the world actually has: the
 * ground sits around layer 32 and the deepest plantable cave floor is about 45
 * under it, so `(under - 22) / (99 - 22)` never got above 0.1 and the planet
 * came out with **four** crystal clusters on it. The histogram in the harness
 * is where that showed up, and the numbers below are set against it: half of
 * all cave floor is within 15 of the surface and almost none is past 40.
 *
 * Fungus is full strength to 8 under and gone by 26; the crystal has not
 * started until 16 and is full at 34. The overlap from 16 to 26 is the band
 * that has all three, which is what makes the descent read as a change of
 * place rather than as a switch being thrown.
 */
const CAVE_WARM_FULL = 8;
const CAVE_WARM_END = 26;
const CAVE_COLD_MIN = 16;
const CAVE_COLD_FULL = 34;

/** Scratch for the three land-flora passes. None nests inside another. */
const _landXY = { x: 0, y: 0 };
const _standParts = { x: 0, y: 0 };

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

/**
 * BORDER_FADE, BORDER_LIFT, BORDER_FLAT, SEAM_WALK_BAND, SEAM_MAX_STEP,
 * TREE_EDGE_MARGIN, SPAWN_EDGE_MARGIN, `seamFloor` and the seam slope limiter
 * all stood here and are all gone.
 *
 * Between them they flattened a 24-column shelf around every face, lifted it
 * clear of the waterline, capped the terrain behind it to a one-block-a-column
 * cone, put a floor under it so the sea could not climb in, ran a 200-pass
 * limiter over the band, re-flooded the sea afterwards because the limiter had
 * moved the ground under it, erased any canyon or lake that fell inside it, and
 * kept trees and the spawn point out of it. That is eleven percent of every face
 * spent, and a long tail of bugs, on the single problem of two faces meeting at
 * ninety degrees.
 *
 * There is no such meeting now. A join inside the cross is a coordinate
 * carrying on, so the generator does NOTHING there — that is the whole of the
 * change, and the test asserts it by measuring neighbour height steps at a join
 * against steps mid-tile. A join that is a divider is not a join at all: there
 * is unbreakable rock in the way, and `fillWall` puts it there.
 */
/**
 * How much easier every ore vein is to hit on the cinderlands.
 *
 * Subtracted from each vein's noise threshold, so the seams that already exist
 * get fatter rather than new ones appearing - the same map, thicker. 0.06
 * against thresholds in the 0.52-0.58 band is enough to be worth the trip
 * without making the face the only place worth mining.
 */
const ORE_CINDER_BONUS = 0.06;

/**
 * How coarse the sunstone field on the cinderlands is, and how much of it wins.
 *
 * The frequency is against a unit direction, the same scale `patch` (14) is
 * quoted in, and the two knobs do different jobs: the frequency sets how far
 * apart the outcrops are, the threshold how big each one is. High frequency was
 * tried first and is wrong — a smooth field cut near its peak leaves single
 * columns, so 74 gave 874 one-block specks over a 200-column patch rather than
 * outcrops. Low and steep gives the opposite and correct thing: 32 blobs a
 * median of four columns across, one per 1225 columns.
 *
 * The threshold is what the face's mood hangs on. At 0.84 the median walk to
 * the nearest light is 19 blocks and a tenth of the face is more than 54 from
 * one; 0.78 halves both and starts to read as lit rather than as landmarked.
 */
const GLOW_CINDER_FREQ = 11;
const GLOW_CINDER_THR = 0.84;

/**
 * The divider: what a sealed face's wall is made of.
 *
 * `Grid.isWall` says which columns, and they are the outermost ring of each
 * corner face, which gives all twelve sealed joins a wall for free and leaves
 * the connected cross entirely untouched.
 *
 * Full depth, from layer 0: the owner asked for a boundary visible from inside
 * a cave, and that half is unchanged.
 *
 * The TOP is not the top of the array, and that was a mistake worth recording.
 * Filling to D read the requirement "higher than max build height" literally,
 * and max build height is 86 while the ground beside a wall is a measured
 * median of 35 and a maximum of 65. So every divider stood 53 layers over the
 * terrain it divided: one column thick, four hundred long, and seen through a
 * 150-unit draw distance it read as a black monolith rather than as a wall.
 * "It's literally a huge cube made of edgestones."
 *
 * It follows the ground now, WALL_RISE over the highest of its four terrain
 * neighbours. That is unjumpable and unclimbable without deliberately building
 * a tower, which is a different thing from unclimbable in principle - and worth
 * the trade, because a wall you can see the top of is a wall, and one you
 * cannot is scenery.
 *
 * `edgestone` is unbreakable (hardness below zero) and drops nothing, so it can
 * never enter an inventory and therefore can never be placed. See Blocks.js.
 */
const WALL_RISE = 14;

function fillWall(blocks, col, colHeight) {
  // Follow the ground rather than the sky. The four neighbours are the terrain
  // this wall is dividing; a wall column's own `colHeight` is a placeholder set
  // to K_TERRAIN_MAX so that slope and altitude tests refuse it, so reading it
  // here would give the flat 86 that made this a monolith.
  const p = _wallXY;
  colXY(col, p);
  let ground = SEA_K;
  for (let d = 0; d < 4; d++) {
    const dx = d === 2 ? -1 : d === 3 ? 1 : 0;
    const dy = d === 0 ? -1 : d === 1 ? 1 : 0;
    const nx = wrap(p.x + dx), ny = wrap(p.y + dy);
    if (isWall(nx, ny)) continue;
    const h = colHeight[colIndex(nx, ny)];
    if (h > ground) ground = h;
  }
  let top = Math.min(D, Math.round(ground) + WALL_RISE);
  // A gate column has to be tall enough to hold its own opening and a lintel.
  if (gateAt(p.x, p.y, _gate)) top = Math.min(D, Math.max(top, Math.round(ground) + GATE_H + 3));
  for (let k = 0; k < top; k++) blocks[cellAt(col, k)] = ID.edgestone;

  // The way through. See `Grid.gateAt`: a hole, not a teleport, because the
  // sealed face is already touching the cross on the other side of this column.
  if (!gateAt(p.x, p.y, _gate)) return;
  // Cut it against the two columns the gate actually joins, not against the
  // four neighbours: the wall's height uses the HIGHEST of its neighbours, and
  // a sill at that height is a doorway partway up a cliff on the lower side.
  // Measured before this, four of the eight gates were unreachable from one
  // side, the worst by seven layers. Floor to the lower ground so both sides
  // can step in, ceiling to the higher one so both have headroom.
  const [gdx, gdy] = DIR_STEP[_gate.dir];
  const hOut = colHeight[colIndex(wrap(p.x + gdx), wrap(p.y + gdy))];
  const hIn = colHeight[colIndex(wrap(p.x - gdx), wrap(p.y - gdy))];
  // Generous on both ends. `colHeight` is the height FIELD, and the ground a
  // player actually stands on is whatever the surface pass put on top of it -
  // snow, a plant, a shore - so a gate cut exactly to the field is a layer or
  // two out on one side and becomes a crawl. One under and three over absorbs
  // that.
  const sill = Math.max(0, Math.floor(Math.min(hOut, hIn)) - 1);
  const head = Math.min(D - 1, Math.ceil(Math.max(hOut, hIn)) + GATE_H + 3);
  for (let k = sill; k < head; k++) blocks[cellAt(col, k)] = 0;
  // A lintel of sunstone over it, and it is not decoration: eight gates on a
  // 1248-column map, each five columns wide in a wall four hundred long, is a
  // needle in a haystack. This is the only part of a divider that emits light,
  // so a gate is a warm line visible from well outside the draw distance the
  // wall itself resolves at.
  if (head < top) blocks[cellAt(col, head)] = ID.glowstone;
}
const _gate = { x: 0, y: 0, dir: 0 };
const _wallXY = { x: 0, y: 0 };

export class WorldGen {
  constructor(seed = 20260805) {
    this.seed = seed;
    // Every one of these is periodic over W on both axes. See Periodic.js: the
    // lattice cell at x and the cell at x + W are the same cell, so value and
    // derivative match at the wrap by construction rather than by tuning.
    this.n = new Periodic(seed);
    this.nWarp = new Periodic(seed + 101);
    this.nCave = new Periodic(seed + 202);
    this.nOre = new Periodic(seed + 303);
    this.nBiome = new Periodic(seed + 404);
    this.nDetail = new Periodic(seed + 505);
    this.nAq = new Periodic(seed + 606);
    this.nLake = new Periodic(seed + 707);
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
    /** Per-column water identity for the renderer. See WATER_OCEAN. */
    this.colWaterStyle = null;
    /** How many waterfalls this generator has actually written. Diagnostics. */
    this.fallCount = 0;
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

  /**
   * The ground height of a column, as a layer.
   *
   * Every field in here is periodic over W on both axes, including the domain
   * warp — a warp whose own field is periodic moves the sample point at x and
   * the sample point at x + W by the same amount, so the pair stay exactly W
   * apart and the warped field is periodic too. That is the whole of the flat
   * map's new requirement and it is asserted directly in the test.
   *
   * Nothing here knows about tiles. The five cross faces are one field; the
   * four corners get their character from `_faceShape` below and from the biome,
   * not from a different generator.
   */
  height(x, y) {
    const w = this.nWarp;
    // Domain warp, in COLUMNS. The cube warped a unit direction by 0.16, and a
    // column was 0.0037765 of one, so 0.16 was 42 columns; this is that number
    // written in the units the map actually has.
    const wx = w.one(x, y, 0, surfScale(2.1)) * WARP_COLS;
    const wy = w.one(x, y, 31.4, surfScale(2.1)) * WARP_COLS;
    const px = x + wx, py = y + wy;

    const continent = this.n.fbm(px, py, 0, surfScale(1.25), 4, 0.55);
    const land = smoothstep(-0.10, 0.20, continent);
    // Broad ridges rather than needles: high-frequency ridged noise on a world
    // this size turns into single-column spikes.
    const ridge = this.n.ridged(px, py, 0, surfScale(1.9), 4, 0.5);
    const peaks = Math.pow(clamp(ridge * 1.15 - 0.14, 0, 1), 1.8);
    const hills = this.nDetail.fbm(px, py, 0, surfScale(3.2), 4, 0.5);
    const detail = this.nDetail.fbm(px, py, 0, surfScale(8), 3, 0.5);
    const mask = smoothstep(0.25, 0.75,
      this.n.fbm(px, py, 9.1, surfScale(1.9), 3, 0.5) * 0.5 + 0.5);

    // Amplitudes in blocks, carried across unchanged: they were tuned against a
    // waterline at layer 33 and a ceiling at 86, and both are still there. At
    // the extreme this is K_SURFACE + 12 + 34 + 3 = 82.9 against a clamp of 86,
    // and a clamp that bites is a plateau where a peak should be.
    let h = K_SURFACE;
    h += continent * 12.0;
    h += Math.min(0, continent) * 5.0;              // carve real ocean basins
    h += land * peaks * 34.0 * (0.35 + mask * 0.65);
    h += land * hills * 3.0;
    h += detail * 0.18;
    if (h < SEA_K + 1.2 && h > SEA_K - 3) h = lerp(h, SEA_K - 0.4, 0.4);
    return clamp(this._faceShape(x, y, h), 6, K_TERRAIN_MAX);
  }

  /**
   * What a sealed face does to the height field it inherits.
   *
   * Rime and Pyre take it unchanged, which is exactly what the cube did with
   * them: the cap and the cinderlands were the ordinary terrain generator with a
   * different biome and a different liquid, and the port keeps that so the two
   * faces come out the places they already were.
   *
   * Tempest and Verdant are new and each is one line, because the character of a
   * face belongs in what is built on it rather than in a second height field:
   *
   *   Tempest has NO SAFE HIGH GROUND, which is the brief, so everything over
   *   the waterline is compressed toward it. Nothing on the face stands more
   *   than about six layers up, there is no summit to shelter behind, and the
   *   low ground is left alone so the face keeps its standing water.
   *
   *   Verdant is lifted clear of the sea and given back its relief. A jungle is
   *   land — a sealed room that came out half ocean would be a lagoon — so the
   *   floor is raised over the waterline and the ridges are exaggerated, which
   *   is what gives the canopy its valleys.
   */
  _faceShape(x, y, h) {
    const role = FACE_ROLE[faceAt(x, y)];
    if (role === FACE_TEMPEST) {
      // Nothing on the face stands more than about ten layers over the water,
      // whatever the ridged term wanted, so there is no summit to shelter
      // behind. The low ground is left alone and keeps its standing water.
      return h <= SEA_K ? h : SEA_K + Math.pow(h - SEA_K, 0.55) * 1.1;
    }
    if (role === FACE_VERDANT) {
      // Lifted 2.5 layers clear of the waterline, with the relief above it
      // untouched and the ground below it flattened to a fifth. So the face is
      // land end to end apart from a few shallow pools, and the highest ground
      // still lands short of K_TERRAIN_MAX — a clamp that bites is a plateau
      // where a peak should be, and that is as true on a sealed face as it is
      // in the cross.
      const over = h - SEA_K;
      return SEA_K + 2.5 + (over > 0 ? over : over * 0.18);
    }
    return h;
  }

  /**
   * Which rock sits at the layer whose centre is `r`, in the column (x, y).
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
  stratum(r, x, y) {
    const k = r - 0.5;
    const rr = r + this.nDetail.volFbm(x, y, k, 0.045, 2, 0.5) * 3.4;
    const p = this.nOre.volOne(x, y, k, 0.13, 3.7);
    if (rr >= BAND_STONE) return p > 0.52 ? ID.andesite : ID.stone;
    if (rr >= BAND_LIMESTONE) return p > 0.50 ? ID.marble : ID.limestone;
    if (rr >= BAND_GRANITE) return p > 0.48 ? ID.granite : (p < -0.50 ? ID.tuff : ID.andesite);
    if (rr >= BAND_SLATE) return p > 0.54 ? ID.azurite : (p < -0.62 ? ID.geode_stone : ID.slate);
    // The last two blocks before the mantle. Magma stone and crystalline rock
    // both emit, so this band is the only lit stratum — reaching it should look
    // like arriving somewhere rather than like more of the same grey.
    return p > 0.30 ? ID.magma_stone : (p < -0.46 ? ID.crystal_stone : ID.slate);
  }

  climate(x, y, h) {
    /**
     * The latitude term, and it is the one piece of climate the flat map had to
     * be given rather than ported.
     *
     * On the cube it was `|dy|` — the distance from the equatorial plane — which
     * is a real, smooth, globally consistent number on a sphere and does not
     * exist on a torus. Nothing about a wrapped square has a pole. Substituting
     * a linear ramp in `y` is the obvious answer and is wrong twice over: it
     * does not wrap, so it is a discontinuity at exactly the seam this whole
     * conversion is about, and it would make the climate belts run along the
     * tile rows, which is precisely the "biomes lined up with the faces" the
     * cross is supposed to stop.
     *
     * So the belts come from a very low frequency periodic field instead,
     * mapped into [0, 1] with the same mean and spread `|dy|` had. Cold country
     * is then a place on the map rather than a band, and the thresholds in
     * `biomeAt` — every one of them measured against the old distribution — keep
     * their meaning.
     */
    const lat = clamp(0.5 + this.nBiome.fbm(x, y, 0, surfScale(0.9), 3, 0.5) * 1.55, 0, 1);
    let temp = 1 - lat * 1.35;
    temp += this.nBiome.fbm(x, y, 12.7, surfScale(2.2), 3, 0.5) * 0.45;
    // Altitude cooling. Gentle, and it only starts biting well above the mean.
    temp -= Math.max(0, h - K_SURFACE - 4) * 0.028;
    const hum = this.nBiome.fbm(x, y, 51.3, surfScale(2.9), 4, 0.5) * 0.5 + 0.5;
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
  biomeAt(h, temp, hum, role = FACE_NORMAL) {
    // Pyre is the whole face, sea bed and all: the low ground is not ocean, it
    // is where the lava sits. See `fillColumn`. Ported unchanged off the cube's
    // cinderlands, including the ore and the sunstone outcrops.
    if (role === FACE_PYRE) return BIOME.CINDER;
    // Verdant is one biome end to end for Pyre's reason — a sealed room is a
    // place, not a climate map — and it stays jungle under its own water, so
    // there is no ocean case to fall through to.
    if (role === FACE_VERDANT) return BIOME.JUNGLE;
    if (h < SEA_K - 0.6) return role === FACE_TEMPEST ? BIOME.STORM : BIOME.OCEAN;
    // Tempest above the waterline. Sodden, scoured ground, and it is the whole
    // face: the standing water is part of it rather than a sea in it.
    if (role === FACE_TEMPEST) return BIOME.STORM;
    // Rime. Snow above the waterline, tundra only where the ground is low and
    // dry, so there is somewhere on it that is not a snowfield. The cube's cap,
    // unchanged.
    if (role === FACE_RIME) return hum < 0.34 && h < K_SURFACE ? BIOME.TUNDRA : BIOME.SNOW;
    // Alpine ground is settled by height before climate: a peak is a peak at any
    // latitude, and a cold one wears a snow cap rather than turning into tundra.
    // No snow anywhere but the cap. A cold peak wears bare rock and a cold
    // lowland is tundra; both used to turn white, which is what put snowfields
    // on every face. Carried snow still lies wherever it is put.
    if (h > K_SURFACE + 3.8) return BIOME.MOUNTAIN;
    if (temp < -0.26) return BIOME.TUNDRA;
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

    // ---- 1. height field + climate ----------------------------------------
    //
    // One loop over one map. The cube ran this six times, once per face, and
    // then spent the rest of the function undoing what the six had done to each
    // other at the borders.
    onProgress(0.02, 'Sculpting the world');
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) colHeight[x * W + y] = this.height(x, y);
      if ((x & 63) === 0) onProgress(0.02 + 0.58 * (x / W), 'Sculpting the world');
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

    /**
     * Slope limit: no column stands more than MAX_STEP over any of its four
     * neighbours.
     *
     * This is section 6c of CUBE-PLANET.md and it was never implemented. It is
     * not a polish pass - a step of two blocks is above jump height, so it is a
     * wall, and the noise makes them all over the planet. It showed up worst at
     * a face border, where the height fade ramps the ground up to meet the seam
     * and the noise on top of that ramp turns the last few columns into a
     * cliff: measured on the column the owner was stuck in, the surfaces
     * running out to the edge were 27, 29, 29, 30, 31, 32 - that 27 to 29 is
     * the wall, and it ringed the whole face.
     *
     * Scoped to the band around each seam rather than applied planet-wide, and
     * that is deliberate. Run over everything it also files down canyon walls
     * and mountain faces - measured, 11 216 neighbour steps of more than a
     * block remain in open terrain and the worst is 19, which is a gorge and is
     * MEANT to be steep. A cliff you have to walk around is a landscape; a
     * cliff ringing the only route to the next face is a bug.
     *
     * Lowering rather than raising, so the limiter can only ever cut a cliff
     * down; raising would fill valleys and quietly undo the terrain.
     *
     * Sweeps rather than one pass: the constraint propagates one column per
     * pass, so a tall cliff needs as many passes as it is high. Twelve caps
     * every step the noise produces (the relaxed field's own extremes are well
     * inside that) without the cost of converging a mountain, which does not
     * need converging - a mountain is meant to be climbed round, not over.
     */
    // Biomes are decided from the *relaxed* height, not the raw noise. Deciding
    // first meant a column could be classified as an alpine peak and then be
    // smoothed down into a gentle rise — a snow cap with no mountain under it.
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < W; y++) {
        const col = x * W + y;
        const h = colHeight[col];
        const { temp, hum } = this.climate(x, y, h);
        colBiome[col] = this.biomeAt(h, temp, hum, FACE_ROLE[faceAt(x, y)]);
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
        if (colHeight[col] > SEA_K + 2.2) continue;
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

      for (let x = 0; x < W; x++) {
        for (let y = 0; y < W; y++) {
          const col = x * W + y;
          const d = oceanDist[col];
          if (d <= 0) continue;
          // A flat plate at the bottom of the profile reads as a swimming
          // pool. This is the same field the crust uses for its band edges,
          // at low frequency and small amplitude: seamounts and hollows of a
          // couple of blocks, enough to give the deep somewhere to swim over.
          const bump = this.n.fbm(x, y, 61.7, surfScale(3.4), 3, 0.5) * 1.9;
          const want = SEA_K - oceanDepthAt(d) + bump;
          // `min` so an existing basin that was already deeper keeps its
          // floor, and the clamp so no amount of noise can put the seabed
          // into the rock the mantle and the cave pass need.
          colHeight[col] = Math.max(K_SEABED_MIN, Math.min(colHeight[col], want));
        }
      }
    }

    // ---- canyons -----------------------------------------------------------
    onProgress(0.93, 'Cutting the gorges');
    const canyonMask = this.carveCanyons(colHeight, colBiome, rng);
    // A gorge used to be erased anywhere within 56 columns of a face border,
    // because a wall thirty blocks high across the only walkable route between
    // two faces is a wall. A canyon may now run through a join inside the cross
    // and nothing needs to be done about it; where it meets a divider it stops
    // against unbreakable rock, which is what a divider is for.

    // ---- what the sea can actually reach -----------------------------------
    /**
     * Which sub-sea-level columns are connected to the ocean.
     *
     * The fill pass has always decided water by altitude alone — anything
     * below SEA_K and above the ground is water — and until there were canyons
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
        // The cinderlands have no ocean biome - the whole face is CINDER - so
        // their basins are seeded by height instead, and what fills them is
        // lava. See the liquid pick in `fillColumn`.
        if (colBiome[col] === BIOME.OCEAN
          || (colBiome[col] === BIOME.CINDER && colHeight[col] < SEA_K - 0.6)
          || (colBiome[col] === BIOME.STORM && colHeight[col] < SEA_K - 0.6)
          || (colBiome[col] === BIOME.JUNGLE && colHeight[col] < SEA_K - 0.6)) {
          submerged[col] = 1; queue[qn++] = col;
        }
      }
      // The cutoff is SEA_K - 0.5, not SEA_K, and the half block matters. The
      // topmost cell the fill can put water in has its centre at 129.5, so a
      // column standing at 129.7 holds no water — but there is a lot of such
      // ground, because the height field deliberately flattens everything near
      // sea level toward SEA_K - 0.4 and that pile lands just above the line.
      // Letting it conduct made a continuous wet web out of every coastal
      // plain on the planet, and four of the six canyons filled through it
      // from a shore they never actually reached.
      const WET = SEA_K - 0.5;
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
          if (canyonMask[nb] === 2) { colHeight[nb] = SEA_K + 0.2; continue; }
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
    // A lake basin used to be erased inside the seam apron, the apron's floor
    // re-asserted over the finished field, a 200-pass slope limiter run across
    // it, and the sea then re-flooded because the limiter had moved the ground
    // out from under it. Four passes, all of them about the same ninety-degree
    // corner, and all four are gone. Nothing after this moves the height field,
    // so nothing after this has to repair what it moved.


    /**
     * Water identity, straight off the lake pass. See WATER_OCEAN.
     *
     * A single sweep here rather than a write inside the commit loop, because
     * `lakeSurf > 0` is exactly "this column can hold lake water" — bed and
     * ring both — and restating that test inside the four branches of the
     * commit is how the two would drift apart. Everything else on the planet
     * is 0, which is the ocean and is also the honest default for the aquifers
     * and for any water a player pours.
     */
    this.colWaterStyle = new Uint8Array(COLUMNS);
    for (let col = 0; col < COLUMNS; col++) {
      if (this.lakeSurf[col] > 0) this.colWaterStyle[col] = this.lakeKind[col] & 7;
    }

    /**
     * The dividers, in the height field.
     *
     * The wall columns get a height at the ceiling so that everything derived
     * from the field agrees a divider is solid ground to the top: the slope
     * term below sees a cliff, `groundKOf` answers with the top layer, and every
     * decoration pass that tests altitude, slope or ground refuses them without
     * having to know walls exist. The voxels themselves are written by
     * `fillWall`, which does not consult this.
     *
     * The lake and canyon passes have already run, and neither can have touched
     * a wall column: both refuse ocean and beach, and a wall's own biome is set
     * below. What this does have to undo is any lake or gorge that reached one
     * from outside, which the two lines here do.
     */
    for (let col = 0; col < COLUMNS; col++) {
      const y = col % W, x = (col - y) / W;
      if (!isWall(x, y)) continue;
      colHeight[col] = K_TERRAIN_MAX;
      colBiome[col] = BIOME.MOUNTAIN;
      submerged[col] = 0;
      canyonMask[col] = 0;
      this.lakeKind[col] = 0;
      this.lakeSurf[col] = 0;
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
    // No ruins, crypts or vaults. A world you can walk around in a few minutes
    // reads as *yours*; salting it with somebody else's architecture makes it
    // read as a level someone built, which is the opposite of the point.
    //
    // The import of `Structures.js` that used to sit at the top of this file,
    // never called, so the builder kept being parsed, is gone with the cube:
    // that builder places a patch in FACE coordinates through `patchColumn`,
    // which no longer exists. Putting structures back means porting it, not
    // uncommenting a line, and pretending otherwise with a dead import would be
    // the worse of the two.

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
    let best = -1, bestScore = -1, pass = 0;
    for (let n = 0; n < 40000; n++) {
      // Half the budget insisting on face 5, half taking any ordinary face.
      if (n === 20000) { if (best >= 0) break; pass = 1; }
      const col = (rng() * COLUMNS) | 0;
      const bi = this.colBiome[col];
      if (bi === BIOME.OCEAN || bi === BIOME.BEACH) continue;
      // You wake up in the ordinary world. The four sealed faces are places to
      // travel to, not to be dropped into with nothing — and there is no way
      // out of one except the portal, so a spawn in Pyre would be a soft lock.
      // `SPAWN_EDGE_MARGIN` stood under this and is gone with the rest of the
      // border machinery: the cross has no rim to be pushed away from.
      {
        const yy = col % W;
        const f = faceAt((col - yy) / W, yy);
        if (FACE_ROLE[f] !== FACE_NORMAL) continue;
        // ...and on the first pass, only the middle of the cross. Face 5 is the
        // one cross face whose four neighbours are all cross faces, so it is the
        // only place you can wake up without a divider within half a face. The
        // second pass drops this and takes any ordinary ground.
        if (pass === 0 && f !== START_FACE) continue;
      }
      // Not in a gorge and not on its rim: waking up fourteen blocks down a
      // slot canyon is a memorable start and a miserable one.
      if (this.canyonNear[col] < CANYON_NEAR_MAX) continue;
      // Nor standing in a lake: the spawn test reads the height field, which
      // after the lake pass describes the bed rather than the water over it.
      if (this.lakeKind[col]) continue;
      const h = this.colHeight[col];
      if (h < SEA_K + 1.5 || h > K_SURFACE + 3.0) continue;
      let score = 4 - Math.min(4, this.colSlope[col] * 3);
      if (bi === BIOME.PLAINS || bi === BIOME.MEADOW || bi === BIOME.FOREST) score += 2;
      if (score > bestScore) { bestScore = score; best = col; }
      if (bestScore > 5.5) break;
    }
    // The fallback was column 0, which is the corner of face 1: inside Rime,
    // behind a divider, with no portal within reach. A seed unlucky enough to
    // reach it would have started the game sealed in an ice room, which is the
    // soft lock the face test above exists to prevent. The middle of face 5 is
    // ordinary ground by construction.
    if (best >= 0) return best;
    const o = faceOrigin(START_FACE);
    return colIndex(o.x + (F >> 1), o.y + (F >> 1));
  }

  /**
   * A column's own map coordinates, into a caller-owned scratch.
   *
   * This was `_dirOf`, which turned a column into a unit direction so the noise
   * could be sampled on the sphere. There is no direction now: a column's
   * sample point IS its (x, y), and every field is periodic over the map rather
   * than closed over a shell.
   */
  _xyOf(col, out) {
    return colXY(col, out);
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
    const k = Math.floor(this.colHeight[col] - 0.5);
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
   * The climate of a piece of seabed, from its column's own coordinates.
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
  _seaTemp(x, y) {
    const lat = clamp(0.5 + this.nBiome.fbm(x, y, 0, surfScale(0.9), 3, 0.5) * 1.55, 0, 1);
    return 1 - lat * 1.35 + this.nBiome.fbm(x, y, 12.7, surfScale(2.2), 3, 0.5) * 0.45;
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
   * The sink block this column's ground is made of, or 0 — the desert's
   * quicksand or the snowfield's powder snow.
   *
   * The biome picks it and nothing else does, which is why it is a lookup and
   * not a parameter: a patch of soft ground is the ground it is in, gone soft.
   * `sinkDepthOf` below asks the same question by asking whether this is 0, so
   * the two can never disagree about where a patch is allowed to be.
   */
  sinkIdOf(col) {
    const bi = this.colBiome[col];
    if (bi === BIOME.DESERT) return ID.quicksand;
    if (bi === BIOME.SNOW) return ID.powder_snow;
    return 0;
  }

  /**
   * How many layers of sink block this column wears, or 0.
   *
   * Its own method rather than four lines inside `fillColumn`, because the cave
   * carve has to ask the same question — see QS_CAVE_CLEAR — and the two
   * answers must be the same answer. Recomputed there rather than stored: a
   * `Uint8Array(COLUMNS)` is 1.3 MB resident to cache one `fbm3`, and both
   * callers already have the direction vector in hand.
   *
   * Every test here reads a global table that is fixed before any voxel is
   * written, so this gives the same answer whichever region asks and in
   * whatever order — which is the rule every pass in this file lives by.
   *
   * The site tests, and what each one is keeping out:
   *
   *   - **desert or snowfield, and nothing else** — see `sinkIdOf`. Quicksand
   *     is saturated sand and the desert is the one biome where a dark wet
   *     patch is both plausible and unmistakably not what is round it. Powder
   *     snow is loose snow and `BIOME.SNOW` is the one biome whose surface is
   *     snow in every column, which matters more here than it does for the
   *     sand: a drift wears the same tile as the field it sits in, so a drift
   *     on tundra gravel would be a white square on brown ground and one on a
   *     mountainside would be a white square on stone. Tundra was in this
   *     clause and came out for exactly that; its snow is a noise field over
   *     bare soil, so more than half of it is not white. Beach came out for a
   *     different reason: no beach column clears the waterline test below on
   *     any of the three seeds measured, and a clause that never fires is a
   *     claim about the planet that is not true.
   *   - **not in a canyon.** The gorge floor already has a palette of its own
   *     and it is the one place a player has no way to walk round anything.
   *   - **not a lake bed or bank.** A lake's containment is an argument about
   *     the ring of columns round it being solid rock at the water's own
   *     layers, and putting a two-block hole in that ring would be putting a
   *     hole in the argument. Quicksand is impermeable to the flow sim, so
   *     nothing would visibly leak — the bank would simply stop being the
   *     thing the proof is about, which is worse.
   *   - **well clear of the waterline.** Same rule from the sea's side, plus
   *     the plain one: a pool at the tideline is a pool full of water, and a
   *     hazard you cannot tell from a shallow is not a hazard.
   *   - **not steep.** `rocky` repaints anything over 1.35 of slope to bare
   *     stone anyway, and sand does not pool on a dune face.
   */
  sinkDepthOf(col, p) {
    const id = this.sinkIdOf(col);
    if (!id) return 0;
    if (this.canyonMask[col] || this.lakeKind[col] || this.submerged[col]) return 0;
    if (this.colSlope[col] > 0.9) return 0;
    if (this.colHeight[col] < SEA_K + 1.6) return 0;
    const q = this.nDetail.fbm(p.x, p.y, 0, surfScale(QS_FREQ), 3, 0.5);
    if (q <= QS_THR) return 0;
    if (q <= QS_THR + QS_RIM) return 1;
    return id === ID.powder_snow ? SINK_DEPTH_SNOW : SINK_DEPTH_SAND;
  }

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
    const p = _fillXY;
    this._xyOf(col, p);
    // The dividers, first and unconditionally: a wall column is not terrain and
    // has nothing else decided about it. See `fillWall`.
    if (isWall(p.x, p.y)) { fillWall(blocks, col, colHeight); return; }
    const h = colHeight[col];
    const bi = colBiome[col];
    const rime = FACE_ROLE[faceAt(p.x, p.y)] === FACE_RIME;
    const rocky = colSlope[col] > 1.35;

    // Surface material varies within a biome, not just between biomes: the
    // same field that drifts tundra snow is reused to break up ocean silt,
    // podzol under pines and the grit in a savanna, so no biome is a flat
    // wash of one block.
    const patch = this.nDetail.fbm(p.x, p.y, 0, surfScale(14), 3, 0.5);

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
        const depth = SEA_K - h;
        // Bands against the ocean this planet actually has, which is
        // SEA_K - K_SEABED_MIN = 17 layers. The numbers here were 4 and 11 for
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
        const temp = this._seaTemp(p.x, p.y);
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
      // Bare volcanic rock, mottled so it is not one flat grey. Ash where the
      // ground is loose, magma stone in the hollows where the heat is closest.
      case BIOME.CINDER:
        top = patch > 0.22 ? ID.ash_stone : (patch < -0.24 ? ID.magma_stone : ID.basalt);
        sub = patch < -0.10 ? ID.magma_stone : ID.basalt;
        break;
      /**
       * Tempest: ground that has been rained on for as long as there has been
       * ground. Scoured to bare rock on the rises, standing mud and peat in the
       * hollows, and nothing that would look dry from a distance.
       *
       * The palette is deliberately three cold greys and a brown rather than
       * anything new: what makes the face is the sky and the water on it, and a
       * storm face in bright materials would read as a swamp with a filter over
       * it. Mud and peat are the only soil, so `growsOn` keeps the ordinary land
       * carpet off it almost everywhere without a single special case.
       */
      case BIOME.STORM:
        top = patch > 0.20 ? ID.andesite
          : (patch < -0.22 ? ID.mud : (rocky ? ID.stone : ID.gravel));
        sub = patch < -0.10 ? ID.peat : ID.andesite;
        break;
      /**
       * Verdant: jungle floor. Deep leaf litter over clay, mossed wherever the
       * canopy is thickest, and never bare — a jungle with stone showing through
       * is a hillside.
       *
       * `rocky` is overridden below for this biome for that reason, which is the
       * one place the two new faces need the fill loop to treat them specially.
       */
      case BIOME.JUNGLE:
        top = patch > 0.18 ? ID.moss_block
          : (patch < -0.20 ? ID.coarse_dirt : ID.grass);
        sub = patch < -0.05 ? ID.clay : ID.dirt;
        break;
      case BIOME.MOUNTAIN: top = rocky ? ID.stone : ID.grass; sub = ID.stone; break;
      case BIOME.PINE_FOREST: top = patch > 0.08 ? ID.podzol : ID.grass; sub = ID.dirt; break;
      case BIOME.SAVANNA: top = ID.grass; sub = patch > -0.05 ? ID.coarse_dirt : ID.dirt; break;
      case BIOME.TUNDRA: {
        // Frozen ground: drifts of snow lying over bare, frost-heaved
        // soil and stone. Tundra had no case here at all and fell through
        // to grass — the same block as a meadow, which is how a biome
        // named for permafrost ended up green and full of flowers.
        const drift = this.nDetail.fbm(p.x, p.y, 0, surfScale(16), 3, 0.5);
        top = drift > 0.10 ? ID.snow : (drift < -0.24 ? ID.gravel : ID.coarse_dirt);
        // Permafrost bog. Peat is a fuel, so the biome that grows almost
        // no wood is the one that hands you something to burn instead.
        sub = drift < -0.05 ? ID.peat : ID.dirt;
        break;
      }
      default: top = ID.grass; sub = ID.dirt; break;
    }
    // Verdant is exempt: the jungle's own case has already decided what a steep
    // column wears, and a jungle whose slopes are bare stone is not one.
    if (rocky && bi !== BIOME.DESERT && bi !== BIOME.BADLANDS
      && bi !== BIOME.JUNGLE && bi !== BIOME.STORM) { top = ID.stone; sub = ID.stone; }
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
    if (h < SEA_K + 0.4 && bi !== BIOME.OCEAN && bi !== BIOME.SNOW
      && bi !== BIOME.STORM && bi !== BIOME.JUNGLE
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
          case LAKE_PLUNGE:
            // Wet rock and moss. The bank of a plunge basin is the foot of a
            // cliff, so it wears the cliff's own material with the damp on it
            // rather than anything that grew there.
            top = patch > 0.1 ? ID.moss_block : (grit < 0.4 ? ID.gravel : ID.stone);
            sub = ID.stone; break;
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
          case LAKE_PLUNGE:
            // Scoured to bare rock and shingle, with none of a tarn's slate:
            // this floor is what a falling column of water has been grinding.
            top = patch > 0.2 ? ID.stone : (grit < 0.45 ? ID.gravel : ID.cobblestone);
            sub = ID.stone; break;
          default:
            top = patch > 0.24 ? ID.gravel : (grit < 0.38 ? ID.clay : ID.mud);
            sub = ID.clay; break;
        }
      }
    }

    /**
     * A patch of ground that is not ground, over the top of everything the
     * biome and the lake decided.
     *
     * Last, like the lake bed and for the same reason: it replaces the surface
     * rather than tinting it, and anything that ran after it would repaint a
     * pool back into sand. What is UNDER it is untouched — `sub` is still
     * sandstone under a desert pool — so the floor a body settles on is the
     * floor that column was always going to have.
     */
    /**
     * Sunstone outcrops, and the only reason Pyre is walkable.
     *
     * The cinderlands take no sun at all, so without a light of their own the
     * face is a black room: the owner's report is that you cannot see where
     * you are going or where you have been. Magma stone is already scattered
     * here but it is `light: 6`, which lights the block and nothing else.
     *
     * One low-frequency simplex rather than an fbm, thresholded high: the field
     * is smooth, so what clears the bar is an isolated round blob a few columns
     * across, which is an outcrop. An fbm would fray it into speckle.
     *
     * Last, with the lake bed and the sink, so nothing above repaints an
     * outcrop back into basalt — `rocky` in particular turns every steep column
     * to stone, and a cliff is exactly where a seam should show.
     *
     * The darkness is the character of the face and has to survive, so this is
     * tuned for landmarks to steer by and not for daylight: see GLOW_CINDER_THR.
     */
    if (bi === BIOME.CINDER
      && this.nDetail.one(p.x, p.y, 91.7, surfScale(GLOW_CINDER_FREQ)) > GLOW_CINDER_THR) {
      top = ID.glowstone; sub = ID.glowstone;
    }

    const sinkD = this.sinkDepthOf(col, p);
    const sinkId = sinkD ? this.sinkIdOf(col) : 0;

    for (let k = 0; k < D; k++) {
      const r = k + 0.5;
      let id;
      if (r < K_CORE) id = ID.core;
      else if (r < K_MANTLE) {
        const m = this.nCave.volFbm(p.x, p.y, k, 0.22, 3, 0.5);
        id = m > 0.42 ? ID.obsidian
          : m > 0.16 ? ID.ash_stone
            : (m < -0.5 ? ID.lava : ID.basalt);
      } else if (r > h) {
        // Two independent waters: the sea, which is everything below SEA_K the
        // flood fill could reach, and a lake, which is everything below its own
        // surface. `lakeSurf` is 0 off a lake, so the second test costs one
        // compare per cell and cannot fire by accident.
        // What fills a basin: lava on Pyre, and on Rime a sheet of ice over the
        // sea rather than open water, because a pole whose ocean is liquid is
        // just a cold coast.
        id = ((r <= SEA_K && submerged[col]) || r <= lakeSurf[col])
          ? (bi === BIOME.CINDER ? ID.lava
            : (rime && r > SEA_K - 1.6 ? ID.ice : ID.water))
          : ID.air;
      } else {
        const depth = h - r;
        if (depth < sinkD) id = sinkId;
        else if (depth < 1.0) id = top;
        else if (depth < 4.0) id = sub;
        else id = this.stratum(r, p.x, p.y);
      }
      blocks[cellAt(col, k)] = id;
    }
  }

  /** Caves, for one already-filled column. */
  carveColumn(blocks, col) {
    const nc = this.nCave;
    const canyonMask = this.canyonMask;
    const h = this.colHeight[col];
    const p = _fillXY;
    this._xyOf(col, p);
    // No cave in a divider. It is unbreakable rock to the top of the world and
    // a passage through one would be a way round a wall.
    if (isWall(p.x, p.y)) return;
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
      // A sink patch needs more rock under it than a skin. See QS_CAVE_CLEAR:
      // the ordinary 2.2 leaves the patch's own floor cell carveable, and a
      // pool with a cavern under it is a hole, not a hazard.
      const skin = canyonMask[col] ? 1.0
        : (this.sinkDepthOf(col, p) ? QS_CAVE_CLEAR : 2.2);
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
      /**
       * The sea's version of that guard, and it was missing.
       *
       * `skin` is measured against this column's OWN height and so says
       * nothing about the sea standing beside it. Where the seabed next door
       * is more than a skin lower — the wall of a drowned canyon, the flank of
       * a seabed knoll — `h - skin` is above that neighbour's water, and the
       * carve opens a passage straight into the ocean. Measured with the
       * waterfall pass off, over 145k columns per seed: 18 such cells on seed
       * 20260805 and none on 1234567 or 999331, the deepest twelve layers
       * under the waterline. Rare, but it is the sea, and the sea is a
       * permanent source: the largest of the two breaches filled a 144-cell
       * void to sea level, and nothing in the geometry bounds the next one.
       *
       * The band that must stay solid is everything strictly above the lowest
       * neighbouring seabed and at or below the waterline, which is exactly
       * where a neighbour holds sea. Above the waterline there is no water to
       * let in, so a cliff column keeps every cave it had up there rather than
       * losing the lot to a single clamped ceiling. Height field and
       * `submerged` only, both fixed before any voxel is written, so this is
       * the same answer from either side of a region boundary.
       */
      let kWet0 = D;
      for (let d = 0; d < 4; d++) {
        const nb = colNeighbor(col, d);
        if (!this.submerged[nb]) continue;
        const kb = Math.floor(this.colHeight[nb] - 0.5) + 1;
        if (kb < kWet0) kWet0 = kb;
      }
      const kWet1 = Math.floor(SEA_K - 0.5);
      for (let k = 0; k < D; k++) {
        if (!CARVEABLE[blocks[cellAt(col, k)]]) continue;
        if (k >= kWet0 && k <= kWet1) continue;
        const r = k + 0.5;
        if (r < K_MANTLE + 1.5 || r > ceil) continue;
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
        const c1 = nc.volOne(p.x, p.y, k, 0.035, 11.1);
        const cav = c1 + 0.75 * MAXA <= 0.52 * 1.75 ? -1
          : (c1 + 0.5 * nc.volOne(p.x, p.y, k, 0.070, 22.2)
            + 0.25 * nc.volOne(p.x, p.y, k, 0.140, 44.4)) / 1.75;
        let open = cav > 0.52;
        if (!open) {
          // Tunnels as a thin shell around an isosurface, not as the peak of a
          // ridge. Two ridged fields both near their peak is an intersection of
          // two *volumes*, and an intersection of volumes is a blob - which is
          // why loosening the old thresholds bought more pockets rather than
          // more cave. `abs(f) < eps` is the shell around f = 0, and a shell is
          // a surface: it winds, and it joins up with itself.
          //
          // Measured by flood fill over one 64-cube of crust, same rock for
          // each, counting six-connected components of open cells:
          //
          //   two ridges 0.78    611 components, largest 674, 8.1% of the void
          //   shell .050 @0.045 1110 components, largest 695, 6.0%
          //   shell .065 @0.030  204 components, largest 3734, 26.6%
          //
          // A quarter of the underground void in one navigable system, against
          // an eighth spread over six hundred pockets. It is also cheaper: two
          // single-octave samples where the ridges cost three octaves each.
          //
          // The second shell is deliberately wider (2.2x). Two equal shells
          // intersect in a curve - a line you cannot walk down. A narrow shell
          // crossed by a broad one is a corridor with the width of the narrow
          // one and the run of the broad one.
          const q = 0.030;
          // 0.085, not 0.065. The shell threshold is the cave's THICKNESS, and
          // at 0.065 a shaft that met one met a seam: measured over 225
          // straight-down digs, 37.3% hit a cave and the mean opening was 2.1
          // cells - just tall enough to stand in and nothing more, which is not
          // the "found a cave" moment the rewrite was for. At 0.085 the same sweep
          // gives a 4.3 cell mean opening: somewhere to walk.
          //
          // It stops at 0.085 rather than going further because the opening is
          // exposed surface and surface is frame time. Measured minutes apart
          // on the same machine: 0.065 medians 19.5 ms, 0.085 medians 22, 0.100
          // medians 22-26 with p95 up to 38. Cave quality between 0.085 and
          // 0.100 is inside seed noise; the frame cost is not.
          open = Math.abs(nc.volOne(p.x, p.y, k, q, 5.5)) < 0.085
            && Math.abs(nc.volOne(p.x, p.y, k, q, -31.2)) < 0.143;
        }
        if (open) {
          blocks[cellAt(col, k)] = (r < K_MANTLE + 4 && cav > 0.7) ? ID.lava : ID.air;
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

    const q = this._xyOf(col, _aqXY);
    const lens = this.nAq.fbm(q.x, q.y, 0, surfScale(5.5), 2, 0.5);
    if (lens <= AQ_THR) return o;
    const thick = Math.min(AQ_MAX_THICK, (lens - AQ_THR) * AQ_THICK);
    if (thick < 1) return o;

    // Where the sheet sits within the band. Without this an aquifer is a
    // perfectly concentric shell, which is the same complaint the strata had:
    // two shafts sunk a hundred columns apart would meet the water at exactly
    // the same depth.
    const mid = AQ_MID + this.nAq.one(q.x, q.y, 19.4, surfScale(3.1)) * 3.2;
    const top = Math.min(mid + thick * 0.5, AQ_HI, roof);
    const bot = Math.max(mid - thick * 0.5, AQ_LO);
    if (top < bot) return o;

    const kBot = Math.max(AQ_K0 + 1, Math.ceil(bot - 0.5));
    const kTop = Math.min(AQ_K1 - 1, Math.floor(top - 0.5));
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
    const w = colXY(col, _fillXY);
    if (isWall(w.x, w.y)) return;
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

    const q = this._xyOf(col, _aqXY);
    for (let k = AQ_K0; k <= AQ_K1; k++) {
      const mine = this._aquiferAt(col, k);
      if (mine === 2) { blocks[cellAt(col, k)] = ID.air; continue; }
      if (mine === 1) {
        /**
         * Water goes in only where no neighbour's air pocket is at this layer,
         * and the rest of the lens gets rock. Without this line the air gap is
         * not a gap for long.
         *
         * `air` in `_aqRecord` is measured down from each column's OWN kTop,
         * and kTop moves with the roof and with the `mid` field, so two
         * adjacent columns routinely disagree about where the water stops: X
         * still has water at layer 25 while Y's pocket has already started
         * there. Both cells are the aquifer's own, so the seal below never
         * looks at them, and the pair comes out of worldgen as a block of
         * water standing against open air with nothing holding it — the "lake
         * hanging in the air" the water sim's header is about. Measured over
         * 145k columns on three seeds: 1559 / 1003 / 999 such cells, every one
         * of them (100%) facing a neighbour's own pocket rather than a cave,
         * and a faithful replay of the flow rules drowned 2215 of the 4582
         * pocket cells in the sample. AQ_AIR is 2 layers, so half the air a
         * big aquifer was given to surface into was going under.
         *
         * The rule is exact rather than approximate, and it has to be: X puts
         * water at k only if no neighbour has air at k, so "X water beside Y
         * air" is unsatisfiable by construction. It is also symmetric — Y
         * refuses water under the same test against X's pocket — and it reads
         * nothing but `_aqRecord`, which is a pure function of (seed, column),
         * so both sides of a region boundary reach the same answer whichever
         * was built first.
         *
         * A neighbourhood minimum over the water top would have been the
         * obvious alternative and does not work: making X's surface agree with
         * every neighbour's forces the surface to be constant over the whole
         * connected aquifer, and connectivity is exactly what a column-local
         * pass cannot see. Rock in the one column that disagrees costs 6.2%,
         * 8.7% and 8.4% of the lens on the three seeds measured, leaves the air
         * pocket exactly the size it was, and needs no such knowledge.
         */
        const dry = this._aquiferAt(nb0, k) === 2 || this._aquiferAt(nb1, k) === 2
          || this._aquiferAt(nb2, k) === 2 || this._aquiferAt(nb3, k) === 2;
        blocks[cellAt(col, k)] = dry ? this.stratum(k + 0.5, q.x, q.y) : ID.water;
        continue;
      }
      const touching = this._aquiferAt(col, k - 1) || this._aquiferAt(col, k + 1)
        || this._aquiferAt(nb0, k) || this._aquiferAt(nb1, k)
        || this._aquiferAt(nb2, k) || this._aquiferAt(nb3, k);
      if (!touching) continue;
      const cur = blocks[cellAt(col, k)];
      if (cur === ID.air || cur === ID.water || cur === ID.lava) {
        blocks[cellAt(col, k)] = this.stratum(k + 0.5, q.x, q.y);
      }
    }
  }

  /** Ore veins, for one already-carved column. See ORE_BY_LAYER. */
  oreColumn(blocks, col) {
    const no = this.nOre;
    const p = _fillXY;
    this._xyOf(col, p);
    if (isWall(p.x, p.y)) return;
    // The cinderlands are the reason to go there. See ORE_CINDER_BONUS, and
    // ORE_CINDER_SURFACE / CINDER_SKIN_HOST for the seams that reach daylight.
    const cinder = this.colBiome[col] === BIOME.CINDER;
    const oreBonus = cinder ? ORE_CINDER_BONUS : 0;
    const layers = cinder ? ORE_CINDER_BY_LAYER : ORE_BY_LAYER;
    for (let k = 0; k < D; k++) {
      const cur = blocks[cellAt(col, k)];
      let bucket;
      if (ORE_HOST[cur]) bucket = layers[k];
      else if (cinder && CINDER_SKIN_HOST[cur]) bucket = ORE_CINDER_ONLY[k];
      else continue;
      if (bucket.length === 0) continue;
      for (let oi = 0; oi < bucket.length; oi++) {
        const o = bucket[oi];
        // Two octaves, not three. A vein is a blob — the third octave was
        // adding detail an order of magnitude smaller than one block, which
        // no player can ever see, at a third of the cost of the single most
        // expensive loop in worldgen. `veinNoise` then skips the second
        // octave whenever the first already rules the threshold out, which is
        // most of the time.
        // Lowering the threshold widens the blob rather than adding new ones:
        // the same seams, thicker, so what changes is how much you get out of a
        // vein rather than the shape of the map.
        const thr = o.thr - oreBonus;
        const n = veinNoise(no, p.x, p.y, k, o.scale, o.seed, thr);
        if (n > thr) { blocks[cellAt(col, k)] = o.id; break; }
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
    const p = _lakeXY;
    let sid = 0;

    // The lattice runs over the whole map. LAKE_LATTICE is 26 and W is 1248, so
    // 26 divides it 48 times exactly — a lattice that did not divide W would
    // put two candidates a short step apart across the wrap and break its own
    // separation guarantee there. 1248 = 2^5 * 3 * 13, which is why 26 works.
    {
      for (let ci = LAKE_LI; ci < W; ci += LAKE_LATTICE) {
        for (let cj = LAKE_LJ; cj < W; cj += LAKE_LATTICE) {
          const col = ci * W + cj;
          const bi = colBiome[col];

          // Every draw before every test, so a site that is thrown away costs
          // the same rolls as one that is kept and the stream stays a pure
          // function of the column. Same rule as the boulders and the logs.
          const rng = this.colRng(col, 0x1a7e);
          const roll = rng(), pickR = rng(), pickD = rng(), pickMix = rng();
          const isleRoll = rng(), isleAng = rng(), isleRad = rng();

          let kind = 0;
          // The high country hosts two, and the plunge basin is the rarer of
          // them because it is a much bigger intervention in the hillside.
          if (bi === BIOME.MOUNTAIN || bi === BIOME.SNOW) {
            kind = pickMix < 0.40 ? LAKE_PLUNGE : LAKE_TARN;
          }
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
            this._xyOf(c, p);
            // Distance in columns, straight off the map and through the wrap.
            // The cube had to go via a chord and an arcsine to avoid an L1
            // diamond; `delta` is the same protection here and is two
            // subtractions.
            const da = Math.hypot(delta(ci, p.x), delta(cj, p.y));
            adist[t] = da;
            role[t] = 0; rEff[t] = 0;
            // No radius can reach past the clamp, so this is exact, not a
            // guess — and it keeps the noise off the 80% of the ball that is
            // only there because an L1 diamond has to be big to hold a circle.
            if (da > LAKE_MAX_R + 2.5) continue;
            const s1 = this.nLake.one(p.x, p.y, 0, surfScale(46));
            const s2 = this.nLake.one(p.x, p.y, 5.3, surfScale(110));
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
            if (hh < minAlt || hh > K_TERRAIN_MAX - 6) { bad = true; break; }
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
            this._xyOf(c, p);
            const bump = this.nLake.one(p.x, p.y, 21.7, surfScale(130)) * rough;
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
              // Steeper again than a tarn, and flat-floored: what the water
              // under a fall has cut for itself is a shaft, not a bowl.
              case LAKE_PLUNGE: prof = Math.min(1, (1 - u) * 3.2); break;
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
                colXY(c, p);
                const di = delta(ci + oi, p.x), dj = delta(cj + oj, p.y);
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
            x: ci, y: cj, col, kind, biome: bi,
            r: rBase, surf, depth: deepest, cells: water, bed: nBed, isle: nIsle,
          });
        }
      }
    }

    // Diagnostics, like `fallCount` and `volcanoCount`: written once at the end
    // of the pass and read by nothing in the game. `this.lakes` is the same —
    // the lake records the sim and the renderer actually use are `lakeSurf`,
    // `lakeKind` and `colWaterStyle`, all of them per-column tables written
    // above. Kept because a planet with no tarns on it is a thing you want to be
    // able to ask about from a console, not because anything downstream reads it.
    const counts = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < this.lakes.length; t++) counts[this.lakes[t].kind]++;
    this.lakeCounts = {
      pond: counts[LAKE_POND], tarn: counts[LAKE_TARN],
      marsh: counts[LAKE_MARSH], oasis: counts[LAKE_OASIS],
      plunge: counts[LAKE_PLUNGE],
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
   * over `stratum` like anywhere else, a floor below SEA_K fills with water
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
    const nW = this.nWarp;
    const nD = this.nDetail;
    // One step is one column, and on a flat map that is literally one column:
    // the walk carries a position in columns and a heading in radians, and
    // advances by the unit vector. The cube did the same thing on a great
    // circle, with a `1 / R_SURFACE` step, two rotation matrices per step and a
    // re-normalisation to stop the position drifting off the shell. None of
    // that has anything left to do.

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
    const walk = (x0, y0, a0, o) => {
      let px = x0, py = y0, ang = a0;
      const trail = [];
      let floorR = Infinity;
      let wet = -1;                       // step at which the path went under water
      // Contour steering is anchored to the height the canyon *started* at, not
      // to the height of the column it is standing on. Chasing the current
      // height is a random walk in altitude: each step's error is small, two
      // hundred of them are not, and the canyon slides downhill and finds the
      // coast anyway — which is the whole thing contour steering exists to
      // avoid.
      let anchor = 0;

      for (let st = 0; st < o.len; st++) {
        const cx = Math.round(px), cy = Math.round(py);
        const col = colOf(cx, cy);
        const hRim = colHeight[col];
        if (st === 0) anchor = hRim;

        const sFrac = st / o.len;
        const head = smoothstep(0, 0.10, sFrac);
        let tail = smoothstep(1.0, 0.84, sFrac);

        /**
         * What happens at the coast, and it is the single most important
         * decision in this pass.
         *
         * The land stands two and a bit layers out of the water on average, so
         * *every* canyon worth cutting has its floor below sea level along
         * almost its whole length, and the fill pass would drown all of them.
         * So most canyons are closed off short of the coast, tapering to
         * nothing over sixteen columns; whether they end up wet is then settled
         * properly by the connectivity fill in `generateGlobal`.
         *
         * `o.sea` opts two of the six out of that and lets them run straight
         * into the water at full depth. A drowned gorge is worth having: it is
         * the one place a fifteen-block dive starts from dry land.
         */
        if (o.sea) {
          if (wet < 0 && hRim < SEA_K - 0.5) wet = st;
          if (wet >= 0) { tail = 1; if (st - wet > 12) break; }
        } else {
          if (wet < 0 && hRim < SEA_K + 1.5) wet = st;
          if (wet >= 0) {
            const ct = 1 - (st - wet) / 16;
            if (ct <= 0) break;
            if (ct < tail) tail = ct;
          }
        }

        const dn = nD.one(px, py, o.dseed, surfScale(3.1));
        const wn = nD.one(px, py, o.wseed, surfScale(4.3));
        const dep = o.dep * head * tail * (0.76 + 0.42 * (dn * 0.5 + 0.5));
        const wid = o.wid * (0.70 + 0.58 * (wn * 0.5 + 0.5));

        if (dep >= 0.8) {
          let fr = hRim - dep;
          // Only the watercourses hold their floor monotone downhill; that is
          // what makes one read as somewhere water went rather than as a
          // trench. A contoured slot canyon deliberately does not — its floor
          // follows the plateau. It is also released the moment either taper
          // starts biting, or it would pin the floor at full depth right
          // through the close-out and end the gorge at a cliff.
          if (floorR < Infinity && o.steer < 0 && head * tail > 0.98) {
            fr = Math.min(fr, floorR + 0.05);
          }
          fr = Math.max(fr, hRim - CANYON_MAX_DEPTH, K_CANYON_MIN);
          floorR = fr;

          const ri = Math.ceil(wid) + 1;
          for (let di = -ri; di <= ri; di++) {
            for (let dj = -ri; dj <= ri; dj++) {
              const dist = Math.hypot(di, dj);
              if (dist > wid) continue;
              // Flat floor, near-vertical wall: full depth out to 0.58 of the
              // half-width, then the whole drop is spent in the last 0.42.
              const w = smoothstep(1.0, 0.58, dist / wid);
              if (w <= 0.001) continue;
              // No re-projection and no lost cells. The cube stamped this
              // footprint in the path column's own face frame, which stopped
              // being 1:1 across a seam and dropped a handful of the disc.
              const c = patchCol(cx, cy, di, dj);
              // A divider is not ground a gorge may cut. It is unbreakable to
              // the top of the world, and a canyon that took a bite out of one
              // would be a hole in the only thing sealing a corner face.
              if (isWall(cx + di, cy + dj)) continue;
              const cRim = colHeight[c];
              let hh = cRim + (fr - cRim) * w;
              // Terrace the wall. Free scenery: the crust's bands sit at fixed
              // layers, so a wall that steps in three-block courses puts a
              // walkable ledge at the limestone line and again at the granite
              // one, and the gorge shows its own stratigraphy.
              if (w < 0.92) hh = fr + Math.ceil((hh - fr) / CANYON_BENCH) * CANYON_BENCH;
              if (o.sea) wetOwn[c] = 1;
              if (hh < target[c]) target[c] = hh;
            }
          }
        }

        if ((st & 7) === 0) trail.push([px, py, ang]);

        // --- steer ---
        let bestA = 0, bestScore = Infinity;
        for (let c = -2; c <= 2; c++) {
          const a = c * 0.34;
          const hh = colHeight[colOf(
            Math.round(px + Math.cos(ang + a) * 6),
            Math.round(py + Math.sin(ang + a) * 6),
          )];
          const score = o.steer < 0 ? hh : o.steer > 0 ? -hh : Math.abs(hh - anchor);
          if (score < bestScore) { bestScore = score; bestA = a; }
        }
        const wander = nW.one(px, py, o.wseed, surfScale(5.7)) * 0.19;
        let turn = wander + bestA * 0.40;
        // Cap the turn per column. Uncapped, the downhill term wins on a slope
        // and the path spirals round the contour until it eats its own tail.
        if (turn > 0.22) turn = 0.22; else if (turn < -0.22) turn = -0.22;
        ang += turn;

        px += Math.cos(ang); py += Math.sin(ang);
      }
      return trail;
    };

    // --- pick well-separated highland sources ---
    const starts = [];
    const SEP = 260;      // columns; the cube's 0.70 dot on a unit sphere
    for (let t = 0; t < 200000 && starts.length < CANYON_COUNT; t++) {
      const col = (rng() * COLUMNS) | 0;
      const bi = colBiome[col];
      if (bi === BIOME.OCEAN || bi === BIOME.BEACH) continue;
      // Start on high ground. A canyon head at sea level has nowhere to run to,
      // and the depth budget is measured down from the rim — a head three
      // blocks above the water gets a three-block ditch.
      if (colHeight[col] < K_SURFACE + 3.0) continue;
      const cy = col % W, cx = (col - cy) / W;
      // Not on a corner face. A gorge two hundred columns long does not fit in
      // a sealed room, and one that started in the cross and wandered into a
      // corner would be a route through a divider.
      if (FACE_ROLE[faceAt(cx, cy)] !== FACE_NORMAL) continue;
      let clash = false;
      for (const st of starts) {
        // Separation through the wrap, which is what `delta` is for. Raw
        // subtraction would call two heads on opposite edges of the map far
        // apart when they are one step from each other.
        if (Math.hypot(delta(cx, st[0]), delta(cy, st[1])) < SEP) { clash = true; break; }
      }
      if (clash) continue;
      starts.push([cx, cy]);
    }

    for (let n = 0; n < starts.length; n++) {
      const st = starts[n];
      const len = 130 + ((rng() * 91) | 0);
      // The first two run to the sea and drown; the rest stop short of it. See
      // the coast note in `walk` for why the split exists at all.
      const sea = n < 2;
      const trail = walk(st[0], st[1], rng() * Math.PI * 2, {
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
        // Leave the trunk at roughly a right angle, either side, with a little
        // downstream lean so it is a confluence and not a T.
        const sgn = rng() < 0.5 ? -1 : 1;
        const sk = 0.55 + rng() * 0.35;
        walk(q[0], q[1], q[2] + sgn * sk * Math.PI * 0.5, {
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
      colHeight[col] = Math.max(K_CANYON_MIN, t);
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
    const parts = { x: 0, y: 0 };
    const sites = [];

    for (let t = 0; t < 300000 && sites.length < VOLCANO_TARGET; t++) {
      const col = (rng() * COLUMNS) | 0;
      if (!HOSTS.includes(colBiome[col]) || claim[col] || canyonMask[col]) continue;
      const h = colHeight[col];
      // The height window is narrow and both edges are load-bearing. Below
      // SEA_K + 2.5 the crater floor is at or under the waterline and one
      // player tunnel from the coast turns the vent into a pool. The upper edge
      // is where a six-block cone stops fitting under the two clear layers the
      // shell keeps at the top — expressed against D rather than as the
      // bare 135.5 it was, which was that same ceiling on the old 144 shell.
      if (h < SEA_K + 2.5 || h > D - 8.5) continue;
      if (colSlope[col] > 0.85) continue;
      colXY(col, parts);
      // The apron no longer has to stay on one face — a disc that crosses a
      // join inside the cross crosses nothing — but it must not reach a
      // divider, because a cone stamped over one would fill a wall column with
      // ash and open the room behind it.
      {
        let onWall = false;
        for (let a = -APRON; a <= APRON && !onWall; a += 4) {
          for (let b = -APRON; b <= APRON; b += 4) {
            if (isWall(parts.x + a, parts.y + b)) { onWall = true; break; }
          }
        }
        if (onWall) continue;
      }

      // Flat enough, dry enough, and nobody else's ground.
      let lo = 99, hi = -99, bad = false;
      for (let di = -CONE; di <= CONE && !bad; di += 3) {
        for (let dj = -CONE; dj <= CONE; dj += 3) {
          const c = patchCol(parts.x, parts.y, di, dj);
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
          if (this.lakeKind[patchCol(parts.x, parts.y, di, dj)]) { bad = true; break; }
        }
      }
      if (bad) continue;

      // Claim the apron so the next candidate cannot stand in it. The stamp
      // used to do this as it laid the ground; it has to happen here now,
      // because the next candidate is chosen long before anything is built.
      for (let di = -APRON; di <= APRON; di++) {
        for (let dj = -APRON; dj <= APRON; dj++) {
          if (Math.hypot(di, dj) > APRON) continue;
          claim[patchCol(parts.x, parts.y, di, dj)] = 1;
        }
      }

      sites.push({
        x: parts.x, y: parts.y,
        kBase: hi,                            // build off the high side, so no
        seed: (rng() * 0x7fffffff) | 0,       // part of the cone is left buried
        stamped: false,
      });
    }

    this.volcanoes = sites;
    /** Diagnostics. Nothing in the game reads it; `volcanoes` is the real list. */
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
    const sx = site.x, sy = site.y;

    const groundK = (col) => {
        for (let k = D - 1; k >= 0; k--) {
        const b = blocks[cellAt(col, k)];
        if (b !== ID.air && b !== ID.water) return k;
      }
      return -1;
    };
    const set = (col, k, id) => { if (k >= 0 && k < D) blocks[cellAt(col, k)] = id; };
    const get = (col, k) => (k >= 0 && k < D ? blocks[cellAt(col, k)] : ID.stone);

    {
      const kBase = site.kBase;
      const kSummit = kBase + CONE_H;
      const kCrater = kSummit - 3;

      // --- apron: burnt ground, thinning outward ---
      for (let di = -APRON; di <= APRON; di++) {
        for (let dj = -APRON; dj <= APRON; dj++) {
          const d = Math.hypot(di, dj);
          if (d > APRON) continue;
          const c = patchCol(sx, sy, di, dj);
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
          const c = patchCol(sx, sy, di, dj);
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
          const c = patchCol(sx, sy, di, dj);
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
            const c = patchCol(sx, sy, di, dj);
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
    for (let k = D - 1; k >= 0; k--) {
      const b = blocks[cellAt(col, k)];
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
    const p = colXY(col, _spParts);
    // The lattice is over the whole map rather than over a face, which it can
    // be because SPRING_LATTICE divides W: 1248 = 2^5 * 3 * 13, and 8 goes into
    // it 156 times. A lattice that did not divide W would break its own pattern
    // at the wrap, which is the flat map's version of the seam bug.
    if (p.x % SPRING_LATTICE !== SPRING_LI || p.y % SPRING_LATTICE !== SPRING_LJ) return -1;
    if (!SPRING_BIOMES.includes(this.colBiome[col])) return -1;
    // Flat, dry, well clear of the waterline and out of any gorge. The height
    // test is what keeps a pool from ever meeting the sea: the water surface
    // ends up a block below this and the sea cannot reach uphill.
    if (this.colSlope[col] > 0.35) return -1;
    if (this.canyonNear[col] < CANYON_NEAR_MAX) return -1;
    if (this.colHeight[col] < SEA_K + 3.0) return -1;
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
        if (Math.hypot(delta(p.x, s.x), delta(p.y, s.y)) <= APRON + SPRING_R + 1) return -1;
      }
    }

    const kc = this.groundKOf(col);
    if (kc < 6 || kc > D - 6) return -1;
    let lo = kc, hi = kc;
    const ri = Math.ceil(SPRING_R);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        if (Math.hypot(di, dj) > SPRING_R) continue;
        const c = patchCol(p.x, p.y, di, dj);
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
    const p = colXY(col, _spParts);
    const ri = ((p.x - SPRING_LI) % SPRING_LATTICE + SPRING_LATTICE) % SPRING_LATTICE;
    const x0 = ri <= SPRING_R ? p.x - ri
      : (SPRING_LATTICE - ri <= SPRING_R ? p.x + (SPRING_LATTICE - ri) : null);
    if (x0 === null) return -1;
    const rj = ((p.y - SPRING_LJ) % SPRING_LATTICE + SPRING_LATTICE) % SPRING_LATTICE;
    const y0 = rj <= SPRING_R ? p.y - rj
      : (SPRING_LATTICE - rj <= SPRING_R ? p.y + (SPRING_LATTICE - rj) : null);
    if (y0 === null) return -1;
    if (Math.hypot(p.x - x0, p.y - y0) > SPRING_R) return -1;
    return this._springCenter(colOf(x0, y0));
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
    const p = colXY(col, _spParts);
    const px = p.x, py = p.y;
    const rng = this.colRng(col, 0x3c0d);
    const ri = Math.ceil(SPRING_R);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        const d = Math.hypot(di, dj);
        if (d > SPRING_R) continue;
        const c = patchCol(px, py, di, dj);
        const crust = rng() < 0.42 ? ID.sulfur_ore : ID.tuff;
        // Before the region clip, like every draw from the stream above it: the
        // style of a column has to come out the same whichever region stamps
        // the pool, and a column outside this region is one the neighbouring
        // region will write the same value into when its turn comes.
        if (d <= SPRING_RI) this.colWaterStyle[c] = WATER_SPRING;
        if (regionOfCol(c) !== rid) continue;
            if (d <= SPRING_RI) {
          // The bath. Two deep in the middle, one on the shelf around it, and
          // the water surface at kb-1 either way — which is what keeps the
          // enclosure argument above intact: there is exactly one water layer
          // that reaches the rim, and its neighbours are rim or more water.
          const deep = d <= SPRING_RD;
          blocks[cellAt(c, kb - 3)] = ID.tuff;
          blocks[cellAt(c, kb - 2)] = deep ? ID.water : ID.tuff;
          blocks[cellAt(c, kb - 1)] = ID.water;
        } else {
          blocks[cellAt(c, kb - 3)] = ID.tuff;
          blocks[cellAt(c, kb - 2)] = ID.tuff;
          blocks[cellAt(c, kb - 1)] = ID.tuff;
          blocks[cellAt(c, kb)] = crust;
        }
        // Clear the headroom either way. On the rim this is what levels a
        // one-layer step into the terrace; over the water it is what stops a
        // drift of snow sitting on top of the pool.
        for (let k = kb + (d <= SPRING_RI ? 0 : 1); k <= kb + 2 && k < D; k++) {
          blocks[cellAt(c, k)] = ID.air;
        }
      }
    }
  }

  /**
   * The surface of the water a column already holds, as a radius, or 0.
   *
   * A lake first and the sea second, because a lake column can be both — a
   * coastal pond sits over ground the flood fill also reached — and the lake is
   * the one whose surface is actually there. A bank column is not water: it has
   * `lakeSurf` so the cave carve can keep away from it, and its ground stands
   * over that surface by construction.
   */
  _fallBaseR(col) {
    const ls = this.lakeSurf[col];
    if (ls > 0) return this.inLakeBed(col) ? ls : 0;
    return this.submerged[col] ? SEA_K : 0;
  }

  /**
   * Does a waterfall come down this column, and between which layers?
   *
   * Terrain tables only, like every other decoration decision — see
   * `_treeKind` — so the answer is the same from either side of a boundary and
   * can be asked before a single voxel of the site exists.
   */
  _fallSite(col) {
    const wsR = this._fallBaseR(col);
    if (wsR <= 0) return null;
    const kW = Math.floor(wsR - 0.5);
    if (kW < 2 || kW > D - 6) return null;
    // Two layers of water under the fall. One would put the foot cell on the
    // bed, where a single mined block turns it into a spreading foot; two is
    // somewhere it can land.
    if (this.groundKOf(col) > kW - 2) return null;
    /**
     * The whole 3x3 footprint inside one region. `_seedWaterRegion` can only
     * read the region it is seeding, so a fall with a neighbour on the far side
     * of a boundary would have that neighbour read as unbuilt, fail the "open
     * side" test, and come back a spring — which is the flood. A region is
     * CHUNK_T columns square, so keeping one column off each edge is the whole
     * of it, and it also keeps the patch on one cube face.
     */
    const p = colXY(col, _fallParts);
    const li = p.x % CHUNK_T, lj = p.y % CHUNK_T;
    if (li < 1 || li > CHUNK_T - 2 || lj < 1 || lj > CHUNK_T - 2) return null;
    /**
     * A checkerboard, and it is the cheapest possible way to make two falls
     * tangentially adjacent IMPOSSIBLE rather than merely unlikely. Two
     * 4-neighbours always differ in (i + j) parity, so no two candidates can
     * touch. That matters because `_seedWaterRegion` tells falling water from
     * the inside of a lake by "no tangential liquid": a pair of neighbouring
     * falls would each veto the other, both would come back springs, and a
     * spring with an open side is the flood this whole feature is built to
     * avoid. The parity costs half the candidates and FALL_CHANCE pays it back.
     */
    if ((p.x + p.y) % 2 !== 0) return null;
    if (this.colRng(col, 0x4f13)() > FALL_CHANCE) return null;

    // The lip hangs off the tallest neighbour, set FALL_LIP into its rock so
    // there is something over the head cell to be a roof.
    let maxG = -1, openFull = 0;
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
      if (n < 0) return null;
      const g = this.groundKOf(n);
      if (g > maxG) maxG = g;
    }
    const kTop = maxG - FALL_LIP;
    const drop = kTop - kW;
    if (drop < FALL_MIN_DROP || drop > FALL_MAX_DROP) return null;
    // At least one side has to be open for the fall's whole height, or the
    // water is a shaft inside a hill and nobody ever sees it. Open means the
    // neighbour's ground is under the waterline too; a neighbour that is rock
    // partway up simply walls that part of the fall, which is fine and is what
    // a fall in a corner looks like.
    for (let d = 0; d < 4; d++) {
      if (this.groundKOf(colNeighbor(col, d)) <= kW) openFull++;
    }
    if (openFull < 1) return null;

    // Not on a volcano, for the reason the hot springs are not: the cone is
    // stamped from the block array after the height field is settled, so a
    // fall sited by height alone would be a column of water hanging inside a
    // scorched slope the site test knows nothing about.
    if (this.volcanoes) {
      for (let v = 0; v < this.volcanoes.length; v++) {
        const s = this.volcanoes[v];
        if (Math.hypot(delta(p.x, s.x), delta(p.y, s.y)) <= APRON + 2) return null;
      }
    }
    return { kW, kTop };
  }

  /**
   * One column's waterfall. See FALL_CHANCE for why it is shaped like this;
   * this is only the writing.
   *
   * No region clip inside the loop, unlike every other pass here, because there
   * is nothing to clip: `_fallSite` refuses any site whose footprint leaves its
   * region, so either the whole feature belongs to `rid` or none of it does.
   * That is also why this is called over a region's own columns rather than
   * over its margin — a fall in the next region along cannot reach in.
   */
  fallAt(blocks, col, rid) {
    if (regionOfCol(col) !== rid) return;
    const site = this._fallSite(col);
    if (!site) return;
    const { kW, kTop } = site;

    // What the cliff is made of, so the lip is not a grey patch on red rock.
    // Read off terrain rather than chosen, and terrain is region-independent —
    // but a cave can have taken it, so there is a fallback.
    let rock = ID.stone;
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
      const id = blocks[cellAt(n, kTop)];
      if (IS_OPAQUE[id] && id !== ID.core) { rock = id; break; }
    }

    // The water. Head at kTop, body below it, down to the cell that sits on the
    // sea or the lake. Unconditional: these cells are air by construction — the
    // ground of this column is under the waterline — and writing them anyway is
    // what makes the result independent of which pass ran first.
    for (let k = kW + 1; k <= kTop; k++) blocks[cellAt(col, k)] = ID.water;
    // The lip: a roof over the head and four shut sides at its own layer. This
    // is the part that is written rather than tested. A source cell with one
    // open side spreads six columns every tick it is woken, so "there was rock
    // there anyway" is not good enough — a cave, an ore vein or a later change
    // to the carve would all be silent ways to lose it.
    blocks[cellAt(col, kTop + 1)] = rock;
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
        blocks[cellAt(n, kTop)] = rock;
      // Second layer only where the column is open, so the lip reads as a shelf
      // of rock rather than as one floating tile. Where the neighbour is
      // already cliff this would be replacing its own stone with its own stone.
      if (this.groundKOf(n) < kTop) blocks[cellAt(n, kTop + 1)] = rock;
    }
    // Foam and speed at the fall itself, and at the patch of the pool it lands
    // in — the style is per column, so the cell where it hits reads aerated,
    // which is exactly right. See WATER_OCEAN.
    this.colWaterStyle[col] = WATER_FALL;
    this.fallCount++;
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
  _treeKind(blocks, col, noCrowdCheck = false) {
    const bi = this.colBiome[col];
    // A TREE_EDGE_MARGIN stood here keeping the last six columns of every face
    // bare, because a canopy stamped in one face's (i, j) threw half its leaves
    // onto the next face's gravity. A canopy now spans a join the way it spans
    // any other pair of columns.
    // Nothing takes root on Pyre.
    if (bi === BIOME.CINDER) return null;
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
     * ever sits at or below the ground layer, so `blocks[cellAt(col, k)]` is still
     * the real surface block, and the volcano — the one pass that does move the
     * ground — is always stamped before any of this runs.
     */
    const k = this.groundKOf(col);
    // need some headroom, but the land surface sits around k=40 of 66 — this
    // bound has to be generous or it rejects the entire planet
    if (k < 0 || k > D - 7) return null;
    const surf = blocks[cellAt(col, k)];
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
    const above = blocks[cellAt(col, k + 1)];
    if (above === ID.water || above === ID.lava) return null;
    const rng = this.colRng(col, 0x7a11);

    let kind = null, chance = 0;
    // Podzol is a pine-forest floor block, so pines have to be allowed to
    // stand on it or the biome would thin out wherever it appears.
    // Verdant, first, because its ground is three blocks and two of them are
    // not the turf the branch below tests for. The chance is the highest in the
    // table by a wide margin and that IS the face: a forest's 0.115 leaves gaps
    // you can see the sky through, and a canopy you cannot see the sky through
    // is what a player is walking into a sealed jungle to find.
    if (bi === BIOME.JUNGLE
      && (surf === ID.grass || surf === ID.moss_block || surf === ID.coarse_dirt)) {
      kind = 'jungle'; chance = 0.20;
    } else if (surf === ID.grass || surf === ID.podzol) {
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
      // and the lattice does not carry across: a pair can still meet exactly on
      // a seam line. Counted rather than guessed at - of 2,583,552 adjacent
      // column pairs on the planet, 1,856 share parity and every one of them is
      // a seam crossing, none are inside a face. Half of those are the
      // even-even ones that could host anything at all, and on seed 4242 not
      // one of the 928 is in a cactus biome on dry land. The block rule handles
      // them the moment anyone builds there.
      //
      //
      // 0.069 and not the 0.04 it was, and it is the same compensation the
      // parity rule made when it halved the eligible columns: `_cactusHasRoom`
      // below now throws out every site that is boxed in, which measures at 42%
      // of them — a desert is dunes, and a dune steps a layer often enough that
      // the terrain alone accounts for most of it. Left at 0.04 the fix would
      // have taken the planet from 655 cacti to 380, which is not what "stop
      // generating illegal ones" is supposed to mean. Measured back at 655.
      // ...and a checkerboard is not enough, because a checkerboard's DIAGONAL
      // neighbours are all eligible. Reported as "I can't put cacti in left,
      // right, top and bottom but I can place in right top, left top, left
      // bottom and right bottom", and it is generated terrain as well as
      // placement: measured over 1,089 live desert columns, 0 pairs touched
      // orthogonally (the parity gate works) and 3 pairs touched at a corner,
      // which is 6 of the 29 cacti there - one in five.
      //
      // So take every second column on BOTH axes rather than every second cell
      // of the sum. The nearest other eligible column is then two steps away
      // along at least one axis, which no 8-neighbourhood reaches, so no two
      // cacti can touch at an edge or at a corner. Same shape of rule as
      // before - a decision off the column's own coordinates, costing no reads
      // and no rng - just a coarser lattice.
      //
      // 0.138 and not 0.069 for the same reason 0.069 was not 0.04: the lattice
      // went from half the columns to a quarter, so the roll doubles to hold
      // the desert's cactus count roughly where it was.
      // Every second column on BOTH axes, which is what keeps two cacti from
      // touching even at a corner. W is even, so the lattice survives the wrap —
      // on the cube it did not, and a pair could meet exactly on a seam line.
      const cp = colXY(col);
      if ((cp.x & 1) === 0 && (cp.y & 1) === 0) { kind = 'cactus'; chance = 0.138; }
    }

    if (!kind || rng() > chance * thin) return null;
    if (kind === 'cactus' && !noCrowdCheck && !this._cactusHasRoom(blocks, col, k)) return null;
    return { kind, k, rng };
  }

  /**
   * Is there room beside this column for a cactus?
   *
   * `NEEDS_ROOM` is the block rule: a cactus refuses to be placed against a
   * solid neighbour, and an existing one breaks the moment a block lands beside
   * it. The parity trick above keeps two cacti apart, which was the only half of
   * that rule the generator obeyed — measured planet-wide, 246 of the world's
   * 1,949 cacti were standing against something else. Generating one is showing
   * the player an arrangement they are not allowed to build, and it is not
   * cosmetic: the first edit anywhere near it takes the plant apart.
   *
   * Three sources, cheapest first, and every one of them is asked as a
   * *decision* off the terrain rather than looked for in the block array — the
   * rule `_fallenLog` follows and for the identical reason. Looking would ask
   * whether the region next door had been decorated yet.
   *
   *  - Terrain. A neighbouring column whose ground stands even one layer higher
   *    puts solid rock against the cactus's lowest segment. This is the bulk of
   *    it, 229 of the 246, and it is four array reads.
   *  - A boulder. Its cells reach two columns from its centre, so a centre
   *    within three can touch us.
   *  - A tree. The widest canopy is five columns of radius, so a trunk within
   *    six can put a leaf against us — and six is exactly DECOR_MARGIN, the
   *    bound on how far a decision may read as well as write, so that is the
   *    largest sweep legal here.
   *
   *    The sweep alone is far too blunt to *act* on: refusing every cactus
   *    within six columns of any tree threw away 195 of the planet's 655 to fix
   *    eight cells, because a desert borders a savanna and a savanna has trees
   *    in it. So each candidate tree is sized with `_treeSize` — the same
   *    expression `stampTree` uses, shared for exactly this reason — and it only
   *    counts if its crown actually reaches one of our four neighbours at one of
   *    our own layers. `CACTUS_MAX` rather than this cactus's real height
   *    because the height comes off `rng` and drawing it here would move the
   *    stream `stampTree` is about to use; being two layers pessimistic costs
   *    almost nothing and keeps the decision out of the stream.
   *
   * `noCrowdCheck` breaks the recursion: a neighbour that is itself a cactus
   * candidate must not run its own sweep. It cannot change the answer either
   * way, because a cactus is not something this refuses for — the parity rule
   * already guarantees no cactus is tangentially adjacent to another.
   */
  _cactusHasRoom(blocks, col, k) {
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      if (nb < 0 || this.groundKOf(nb) > k) return false;
    }
    const p = colXY(col, _cactusParts);
    const pi = p.x, pj = p.y;
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        if (this._boulderKind(blocks, patchCol(pi, pj, di, dj))) return false;
      }
    }
    const kLo = k + 1, kHi = k + CACTUS_MAX;
    for (let di = -DECOR_MARGIN; di <= DECOR_MARGIN; di++) {
      for (let dj = -DECOR_MARGIN; dj <= DECOR_MARGIN; dj++) {
        if (di === 0 && dj === 0) continue;
        const t = this._treeKind(blocks, patchCol(pi, pj, di, dj), true);
        if (t === null || t.kind === 'cactus') continue;
        const s = this._treeSize(t.kind, t.k + 1, t.rng);
        if (t.k + 1 > kHi || s.hiK < kLo) continue;
        // Does any column the crown covers touch one of our four neighbours?
        // The trunk is the centre column, which the same test catches at
        // distance 0.
        const near = Math.min(
          Math.hypot(di - 1, dj), Math.hypot(di + 1, dj),
          Math.hypot(di, dj - 1), Math.hypot(di, dj + 1),
        );
        if (near <= s.reach) return false;
      }
    }
    return true;
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
    const surf = blocks[cellAt(col, k)];
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
    const bpx = colXY(col).x, bpy = colXY(col).y;
    for (let di = -rad; di <= rad; di++) {
      for (let dj = -rad; dj <= rad; dj++) {
        for (let dk = 0; dk <= rad; dk++) {
          if (di * di + dj * dj + dk * dk > rad * rad + 0.5) continue;
          // Same reason as the canopy below: a boulder is up to five columns
          // across and must not fold over a seam.
          const c = patchCol(bpx, bpy, di, dj);
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
          if (blocks[cellAt(c, kk)] !== ID.air) continue;
          blocks[cellAt(c, kk)] = id;
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
    const p = colXY(col, _logParts);
    const ci = p.x, cj = p.y;
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
    // and not a preference. There is no longer a rule keeping the run inside
    // one face: the map's x is the map's x everywhere, so a trunk that crosses
    // a join keeps its grain.
    const off0 = -((len - 1) >> 1);

    // Not on a volcano's apron. The cone is stamped into the block array after
    // the height field is settled, so `groundKOf` there describes the ground the
    // volcano replaced. Same test and same reason as `_springCenterUncached`.
    if (this.volcanoes) {
      for (let v = 0; v < this.volcanoes.length; v++) {
        const s = this.volcanoes[v];
        if (Math.hypot(delta(ci, s.x), delta(cj, s.y)) <= APRON + LOG_MAX) return null;
      }
    }

    const k = this.groundKOf(col);
    if (k < 1 || k > D - 3) return null;
    for (let n = 0; n < len; n++) {
      const d = off0 + n;
      const c = axis === 0 ? patchCol(ci, cj, d, 0) : patchCol(ci, cj, 0, d);
      if (!this._logRests(blocks, c, k)) return null;
    }

    // The species the wood around it is made of — the same rule `_treeKind`
    // uses, so a windfall never comes out of a species the forest it is lying
    // in does not grow.
    const kind = bi === BIOME.PINE_FOREST ? 'pine'
      : bi === BIOME.MEADOW ? 'birch'
        : bi === BIOME.FOREST ? (pickSpecies < 0.68 ? 'oak' : 'birch')
          : (pickSpecies < 0.6 ? 'oak' : 'birch');
    return { ci, cj, axis, len, gap, off0, k, kind, id: LOG_IDS[kind][axis] };
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
    if (!LOG_FLOOR[blocks[cellAt(c, k)]]) return false;
    // Liquid specifically, not "is it air" — for exactly the reason spelled out
    // at length in `_treeKind`. Terrain puts air or water in the cell above the
    // ground and nothing else; decoration puts trees and boulders there, and
    // asking about those would be asking whether the region next door has been
    // decorated yet.
    const above = blocks[cellAt(c, k + 1)];
    if (above === ID.water || above === ID.lava) return false;
    // Nothing lies through a standing trunk, and nothing lies through a
    // boulder — which is up to two columns across, hence the sweep.
    if (this._treeKind(blocks, c)) return false;
    const q = colXY(c, _logNb);
    const qi = q.x, qj = q.y;
    for (let di = -2; di <= 2; di++) {
      for (let dj = -2; dj <= 2; dj++) {
        if (this._boulderKind(blocks, patchCol(qi, qj, di, dj))) return false;
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
        ? patchCol(plan.ci, plan.cj, d, 0)
        : patchCol(plan.ci, plan.cj, 0, d);
      if (rid >= 0 && regionOfCol(c) !== rid) continue;
      blocks[cellAt(c, plan.k + 1)] = plan.id;
    }
  }

  /**
   * How big *this* tree comes out, and therefore how far it reaches.
   *
   * Drawn from the stream `_treeKind` left behind, in exactly the order
   * `stampTree` used to draw it — this is that code, moved rather than copied.
   * It is shared because a second caller now needs the same answer:
   * `_cactusHasRoom` has to know whether a particular tree's canopy can put a
   * block against a particular cactus, and a canopy and the rule that keeps out
   * of its way are the classic pair of expressions that agree on the day they
   * are written and not after the next tuning pass.
   *
   * `reach` is the widest any layer of the crown gets, fraying included, and
   * `hiK` the topmost layer any part of the tree can occupy. The lowest is
   * always `k0`, because the trunk starts there whatever the crown does.
   *
   * @param {number} k0 the layer the trunk starts at
   */
  _treeSize(kind, k0, rng) {
    const cfg = TREE_CFG[kind];
    /**
     * One multiplier on both trunk and crown.
     *
     * The bands in TREE_CFG are three to five values wide — an oak was exactly
     * 6, 7 or 8 — and, worse, `rad` was a constant per kind, so every oak on
     * the planet wore an identical crown. That is the half that was actually
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

    // The three crown shapes below, read off the three branches of `stampTree`:
    // a sapling is a 3x3 tuft with one cell over it, a cone's widest course is
    // `rad + 0.4` and it caps one layer over the top, a flat crown is `rad` at
    // the top and one above, and a round one frays out to half of `ragged` and
    // closes two layers over the top.
    const top = k0 + h - 1;
    let reach, hiK;
    if (h <= 3) { reach = 1.5; hiK = top + 1; }
    else if (cfg.shape === 'cone') { reach = rad + 0.4; hiK = top + 1; }
    else if (cfg.shape === 'flat') { reach = rad; hiK = top + 1; }
    else { reach = rad + 0.45; hiK = top + 2; }
    return { cfg, rad, h, reach, hiK };
  }

  stampTree(blocks, kind, col, k0, rng, rid = -1) {
    const set = (c, k, id, force = false) => {
      if (k < 0 || k >= D) return;
      if (rid >= 0 && regionOfCol(c) !== rid) return;
      const cur = blocks[cellAt(c, k)];
      if (cur === ID.air || force) blocks[cellAt(c, k)] = id;
    };
    const tp = colXY(col);
    const tx = tp.x, ty = tp.y;
    const at = (di, dj) => patchCol(tx, ty, di, dj);

    if (kind === 'cactus') {
      const h = 2 + Math.floor(rng() * CACTUS_MAX_STEP);
      // `force`, exactly as a trunk is written, and for a sharper version of
      // the trunk's reason. `set` skips a cell that is not air, so a cactus
      // whose *base* cell had already been claimed — by a leaf off an oak
      // leaning in from the forest next door, which is the only thing that ever
      // reaches a desert column at ground level — lost that segment and grew
      // from the one above instead: a cactus standing on a leaf, unsupported,
      // which `NEEDS_FLOOR` then takes down the first time anything near it is
      // disturbed. Forcing makes the run solid from `k0` up whatever it meets,
      // and stays order-independent because `set` still refuses to write
      // outside the region being decorated.
      for (let n = 0; n < h; n++) set(col, k0 + n, ID.cactus, true);
      return;
    }

    const { cfg, rad, h } = this._treeSize(kind, k0, rng);
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
      /**
       * A conifer, widest at the skirt and closing to a spire.
       *
       * `l` counts DOWNWARD from the treetop, because that is the end the
       * layer count is anchored to, so the taper has to be read backwards:
       * `t` is 1 at the crown and 0 at the bottom course. Written the other
       * way round — `t = l / levels` — the widest ring landed at `top` and the
       * narrowest at `top - levels`, which is a cone standing on its point.
       * Measured on a stock pine (rad 3.40 after damping, h 9, 5 levels) it
       * ran 3.40 at the crown down to 0.94 at the skirt; a fir is the exact
       * reverse of that and now is.
       *
       * The vertical extent is untouched, and that is a constraint rather than
       * a nicety: leaves still run `top - levels` to `top + 1` and the widest
       * course is still `rad + 0.4`, which are the two numbers `_treeSize`
       * publishes as `hiK` and `reach` so a neighbouring region knows how far
       * to look. Only which course gets which radius has changed.
       *
       * `lq` is the whorls. A fir does not taper as a smooth ice-cream cone; it
       * carries its branches in rings, two or three courses deep, with a step
       * between them. Quantising the taper into pairs of courses gets that for
       * one modulo and no noise: each pair takes the radius of its UPPER
       * member, so the profile is still monotonic — the first attempt notched
       * alternate courses instead and put a narrow ring under a wide one, a
       * waist rather than a step. Taking the upper member also means every
       * radius here is one the smooth taper already produced, so the widest
       * course is still at most `rad + 0.4` and `reach` stays an upper bound.
       *
       * Deterministic, so the cone still draws without touching `rng` — a draw
       * here would move the stream the caller uses next.
       */
      const levels = Math.floor(h * 0.65);
      for (let l = 0; l <= levels; l++) {
        const lq = l - (l % 2);
        const t = 1 - lq / levels;
        /*
         * A spire still has to be a spire, not a bare pole.
         *
         * Reported: "some pine trees have exposed 2 layer trunk without leaves
         * under the top leaf". The crown course is `rad * 0.18 + 0.4`, and when
         * `rad` damps under about 3.06 that lands below 1.0 - at which point
         * `hypot(1, 0) = 1.0 > r` throws out all four neighbours and the course
         * places only `(0, 0)`, which is the trunk's own column, where `set`
         * refuses because a log is already there. So the course placed NOTHING,
         * and the whorl quantisation above made it the top TWO courses at once,
         * which is exactly the two bare layers in the report. The single tip
         * leaf still went on above them.
         *
         * Computed across the size range before the floor:
         *
         *   rad 3.4, h 9   l=0 r=1.01 -> 5 cells   l=1 r=1.01 -> 5 cells
         *   rad 3.0, h 9   l=0 r=0.94 -> 1 cell    l=1 r=0.94 -> 1 cell
         *
         * which is why it was "some" pines: `rad` varies per tree and only the
         * ones that damp below the threshold fail. At exactly 1.0 the four
         * neighbours come back, because the test is `>` and not `>=`.
         *
         * The widest course does not move and the vertical extent does not
         * change, so `_treeSize`'s `reach` and `hiK` are untouched and both
         * remain upper bounds.
         */
        const r = Math.max(rad * (1 - t * 0.82) + 0.4, 1.0);
        if (r <= 0) continue;
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
    const surf = blocks[cellAt(col, k)];
    if (blocks[cellAt(col, k + 1)] !== ID.air) return;

    const n = this.nBiome;
    const p = _fillXY;
    this._xyOf(col, p);
    const bi = this.colBiome[col];
    const rng = this.colRng(col, 0xf10a);
    const inCanyon = this.canyonNear[col] === 0;

    if (surf === ID.grass) {
      const dens = n.fbm(p.x, p.y, 0, surfScale(9), 3, 0.5) * 0.5 + 0.5;
      const pr = 0.12 + dens * 0.55;
      const h = rng();
      if (h < pr * 0.72) blocks[cellAt(col, k + 1)] = ID.tall_grass;
      else if (h < pr * 0.82) {
        const c = rng();
        blocks[cellAt(col, k + 1)] = c < 0.34 ? ID.flower_red : c < 0.67 ? ID.flower_gold : ID.flower_blue;
      } else if (h < pr * 0.84 && (bi === BIOME.FOREST || bi === BIOME.MEADOW)) {
        blocks[cellAt(col, k + 1)] = ID.pumpkin;
      }
    } else if (inCanyon && (surf === ID.coarse_dirt || surf === ID.gravel || surf === ID.red_sand)) {
      // The other half of the canyon rule. Taking the trees away and leaving
      // it at that gives a bare stone trench, which reads as unfinished rather
      // than as dry — so the floor keeps a thin scatter of cover on whatever
      // the canyon re-surfaced it with. Sparse enough to see the ground
      // through, which is the point: what makes a gorge legible is the strata
      // in its walls and the shadow on its floor, and both survive scrub where
      // neither survives a canopy.
      //
      // **The species is chosen by the ground and by the biome, and both halves
      // of that came from a bug report.** It used to scatter tall grass and
      // flowers over all three of these surfaces, which is where "grass in
      // gravel" came from: a canyon re-surfaces its floor with gravel and red
      // sand, and turf plants were being laid on both. Grass now takes only the
      // coarse dirt — the one of the three that is soil.
      //
      // The grit then took `thornbrush` unconditionally, which fixed the soil
      // and left the geography: a gorge is cut wherever the walk went, so a
      // third of the planet's thorn scrub was standing on snowfields and
      // mountainsides. `growsOn` cannot catch that — gravel *is* thornbrush
      // ground — so the species now comes from CANYON_SCRUB, which is indexed
      // by biome, and `_floraSoilOk` still has the final word.
      const h = rng();
      if (surf === ID.coarse_dirt) {
        if (h < 0.11) blocks[cellAt(col, k + 1)] = ID.tall_grass;
        else if (h < 0.125) {
          blocks[cellAt(col, k + 1)] = rng() < 0.5 ? ID.flower_gold : ID.flower_red;
        }
      } else if (h < 0.085) {
        const scrub = CANYON_SCRUB[bi];
        if (scrub && this._floraSoilOk(scrub, surf)) blocks[cellAt(col, k + 1)] = scrub;
      }
    }

    // cave mushrooms: look for open pockets under the surface. `growsOn` as
    // well as CARVEABLE: the two nearly agree, and where they do not — a
    // sandstone cave wall under a desert — it is the soil table that decides,
    // because that is the table the harness measures against.
    //
    // A pocket needs a *ceiling* as well as a floor, which is the one test this
    // loop was missing and `caveFloraAt` has always had. Without it a single
    // air cell between two slabs of rock counts as a pocket, so the pass grew
    // glowcaps sealed inside the crust where nobody can see or reach them —
    // measured, 100 of the planet's 674 — and, five times over, grew one in the
    // cell directly under a pool of lava. The test sits *after* the roll on
    // purpose: drawing at the same rate as before keeps every mushroom that was
    // already correct exactly where it was, and only removes the bad ones.
    for (let kk = 2; kk < k - 2; kk++) {
      if (blocks[cellAt(col, kk)] === ID.air && CARVEABLE[blocks[cellAt(col, kk - 1)]]
        && rng() < 0.006 && blocks[cellAt(col, kk + 1)] === ID.air
        && growsOn(ID.mushroom, blocks[cellAt(col, kk - 1)])) {
        blocks[cellAt(col, kk)] = ID.mushroom;
      }
    }
  }

  // --- the land flora ---------------------------------------------------------

  /**
   * May this plant root on this surface cell, structurally and botanically?
   *
   * The two questions are genuinely different and both have to be asked.
   * `supports` is the block rule — every one of these carries `needsFloor`, so
   * one placed on something that cannot hold it falls the moment the cell below
   * is disturbed. `growsOn` is the soil rule from `Blocks.js`, and it is the
   * one that was missing: `supports` admits gravel, bare stone, glass and the
   * top of a fence, which is how the world ended up with tall grass growing in
   * scree.
   *
   * Both are reads of *terrain*, never of decoration, so a column answers this
   * the same from either side of a region boundary.
   */
  _floraSoilOk(id, surf) {
    return growsOn(id, surf) && supports(surf);
  }

  /**
   * The carpet: one column's biome ground cover.
   *
   * Writes only into this column, so like `floraAt` it needs no region clip.
   *
   * **`groundKOf` and not `surfaceK`, and that one word is worth several
   * thousand plants.** `floraAt` uses `surfaceK`, which is the topmost solid
   * cell — under a wood that is the canopy, and grass does not grow on leaves,
   * so the surface pass quietly does nothing at all under a tree. That is
   * invisible until you count it: a forest column carries a canopy with
   * probability well over one (chance 0.115 against a canopy covering some 28
   * columns), so *the forest floor is the one place on the planet the old pass
   * could never reach*. Measured with `surfaceK`, this pass put 557 ferns on
   * the whole planet; with `groundKOf` it puts them where an understorey
   * actually goes.
   *
   * The cell it writes into is `groundK + 1`, which is also where a trunk, a
   * fallen log and the bottom of a boulder sit, and the air test below is what
   * keeps it out of all three.
   *
   * It runs *after* `floraAt` and takes only cells that pass left empty, which
   * is what keeps the meadows and plains looking like themselves: the grass and
   * the three flowers are placed first at exactly the rates they always were,
   * and this fills in around them. On the eight biomes `floraAt` never touched
   * at all, "around them" is the whole ground.
   *
   * One roll, one species. A second roll per column would let two plants
   * compete for one cell and only one of them ever win, which is a slower way
   * of writing the same cumulative bands.
   */
  landFloraAt(blocks, col) {
    // Water first and cheapest. A submerged column's surface cell is water and
    // the air test below would catch it anyway, but a lake's *bank* is dry
    // ground the lake pass has already dressed, and a marsh's margin comes out
    // dry as often as not — so both are named rather than left to luck.
    if (this.submerged[col] || this.lakeSurf[col] > 0) return;
    if (this.inLakeBed(col)) return;
    if (this._springNear(col) >= 0) return;

    const k = this.groundKOf(col);
    if (k < 1 || k >= D - 2) return;
    if (blocks[cellAt(col, k + 1)] !== ID.air) return;
    // ...and a ceiling on it is as good as no room at all. A boulder is a
    // hemisphere sat on the ground, so a column one step below its centre gets
    // the overhang rather than the rock: `k + 1` comes out air and `k + 2` is
    // stone, and the pass grew a plant into a sealed one-cell gap under it.
    // Measured planet-wide, 245 of them — asters, ferns, clover and snowbells
    // that nothing can see and nothing can reach. `caveFloraAt` has always
    // demanded the same headroom for the same reason.
    //
    // This reads a cell decoration writes, which is safe here for the reason
    // the `k + 1` test above it is safe: the boulder pass runs over this
    // region's whole margin before this pass runs over its columns, and no
    // other region ever writes into ours — so what is found is the finished
    // answer and it is the same from either side of a boundary.
    if (IS_OPAQUE[blocks[cellAt(col, k + 2)]]) return;
    const surf = blocks[cellAt(col, k)];
    const bi = this.colBiome[col];

    const q = _landXY;
    this._xyOf(col, q);
    // One field for all of it, at a frequency that makes patches a few dozen
    // columns across. Two species inside one biome share it deliberately —
    // clover and lavender should thicken and thin together, because what they
    // are between them is "the rich part of the meadow".
    const f = this.nDetail.fbm(q.x, q.y, 73.1, surfScale(8.4), 3, 0.5);
    const dp = Math.pow(clamp(f * 0.5 + 0.5, 0, 1), LAND_CLUMP);
    const r = this.colRng(col, 0xa17c)();

    let id = 0;
    // The waterside, before the biome is asked anything.
    //
    // There is no swamp biome on this planet, so the first attempt keyed these
    // three off mud and peat underfoot - and generated exactly nothing, because
    // this function returns above on every submerged column, lake surface, lake
    // bed and spring. It only ever sees dry land. Mud is a lake BED block, so
    // the test could not fire: measured over three sites with 191 and 93 wet
    // surface columns between them, zero plants.
    //
    // The dry column beside water is the one place it can fire, and it is also
    // the right picture: reeds stand at the bank, not out in the pond. No new
    // rng is drawn - the same `r` the biome branches use is thresholded here -
    // so no column's stream moves and nothing downstream shifts.
    let waterside = false;
    for (let d = 0; d < 4 && !waterside; d++) {
      const nb = colNeighbor(col, d);
      if (nb >= 0 && (this.submerged[nb] || this.lakeSurf[nb] > 0)) waterside = true;
    }
    if (waterside) {
      // Reeds and a lotus only. Mireroot was here and generated nothing:
      // measured over 1,528 bank columns, the DRY bank is basalt (375) and sand
      // (251) - the clay and mud are lake BED, which this function excludes
      // before it ever gets here - and mireroot takes neither. It is a bog
      // root, so it went to the tundra below, where the ground is coarse dirt.
      if (r < 0.38 * dp) id = ID.swampreed;
      else if (r < 0.50 * dp) id = ID.lotus;
      if (id && this._floraSoilOk(id, surf)) blocks[cellAt(col, k + 1)] = id;
      return;
    }
    switch (bi) {
      // Dry and hot. Both of these are an order below everything green: what
      // makes a desert read as a desert is how much of it is nothing.
      // The desert's two foods sit above the scrub in this ladder, not below
      // it: a prickly pear is the thing you are looking for out here, and the
      // whole point of a desert is that there is little enough of it that
      // finding one matters. Together they are still under a tenth of the
      // ground, which keeps the emptiness the branch above is protecting.
      case BIOME.DESERT:
        if (r < 0.075 * dp) id = ID.thornbrush;
        else if (r < 0.092 * dp) id = ID.aloe;
        else if (r < 0.115 * dp) id = ID.cactusfruit;
        else if (r < 0.130 * dp) id = ID.agave;
        break;
      case BIOME.BADLANDS:
        if (r < 0.080 * dp) id = ID.thornbrush;
        else if (r < 0.090 * dp) id = ID.firebloom;
        else if (r < 0.108 * dp) id = ID.cactusfruit;
        break;
      // A savanna *is* its grass, so this is the densest carpet on the planet
      // and the aloe is a rounding error beside it.
      case BIOME.SAVANNA:
        if (r < 0.75 * dp) id = ID.golden_grass;
        else if (r < 0.775 * dp) id = ID.aloe;
        break;
      // Clover under, golden grass over: a plain gets two layers, which is what
      // separates it from a meadow at a glance now that both are green.
      case BIOME.PLAINS:
        if (r < 0.40 * dp) id = ID.clover;
        else if (r < 0.53 * dp) id = ID.golden_grass;
        break;
      case BIOME.MEADOW:
        if (r < 0.42 * dp) id = ID.clover;
        else if (r < 0.55 * dp) id = ID.lavender;
        break;
      // The forest floor, and the one place a single species is allowed to own
      // the ground: a fern understorey under oaks is what a forest looks like.
      //
      // The deathcap is the exception to that ownership and it is deliberately
      // a small one. It is filed right behind the fern rather than in front of
      // it because it has to stand IN the understorey - a poisonous mushroom in
      // a clearing is one nobody ever brushes, and brushing it is the whole
      // hazard. See `_tickPoison`.
      //
      // **These two thresholds are nominal and the ground rate is about a
      // quarter of them**, which is worth writing down because reading 3.2%
      // here and measuring 0.85% in the world looks like a bug and is not:
      // `dp` is the per-column density field and it averages about 0.23 over a
      // wood. Measured on seed 4242 over 5,041 streamed forest columns, the
      // fern's nominal 0.75 lands at 17.4% and the deathcap's 0.032 lands at
      // 0.853%; the ratio between the two is 0.049 nominal and 0.049 measured,
      // which is the only number here that is actually authored. One mushroom
      // per 117 forest columns and one per 162 under the pines, so a 21-by-21
      // view of a wood holds about four.
      //
      // The first cut was half this and was measured at one per 270, which is a
      // hazard a player can cross a whole forest without meeting.
      case BIOME.FOREST:
        if (r < 0.75 * dp) id = ID.fern;
        else if (r < 0.782 * dp) id = ID.deathcap;
        break;
      // Under the pines it takes the podzol, which is the ground the lingonberry
      // does not. Slightly scarcer than under the oaks: a pine floor is open and
      // a white stalk on brown litter is far easier to see coming.
      case BIOME.PINE_FOREST:
        if (r < 0.32 * dp) id = ID.fern;
        else if (r < 0.58 * dp) id = ID.lingonberry;
        else if (r < 0.608 * dp) id = ID.deathcap;
        break;
      // The one biome whose ground is three different blocks under one carpet,
      // so it is the one biome that picks its species by what it is standing
      // on. Sedge on the thawed soil, snowbell in the drifts, nothing in the
      // scree — see the cotton grass entry in FLORA_SOIL for why the sedge no
      // longer takes all three.
      //
      // Reading `surf` to choose is safe and is not the "decisions read terrain
      // only" rule being bent: `surf` *is* terrain, written by `fillColumn`
      // before any region is decorated, so a column answers this the same from
      // either side of a boundary. The roll is spent before the branch, so the
      // column's stream is unchanged and so is the carpet's density.
      case BIOME.TUNDRA:
        if (r < 0.45 * dp) id = surf === ID.snow ? ID.snowbell : ID.cotton_grass;
        else if (r < 0.56 * dp) id = ID.icecapmoss;
        // The bog root, on the thawed soil the sedge takes. Its soil rule keeps
        // it off the drifts and the scree, so it marks the wet third of a
        // tundra the same way the cotton grass does.
        else if (r < 0.63 * dp) id = ID.mireroot;
        break;
      // Five percent, and it is the highest-value five percent here. A snow
      // field is an hour of white; the snowbell is the only thing in it.
      case BIOME.SNOW:
        if (r < 0.10 * dp) id = ID.snowbell;
        // ...and one thing to eat, so a snowfield is survivable on foot. It
        // takes snow, which the snowbell also takes, so the two share the white
        // and the field is no longer a single-species hour.
        else if (r < 0.20 * dp) id = ID.icecapmoss;
        break;
      // The largest land biome on the planet — 344,489 columns, more than any
      // other — and it grew exactly one species. An aster and nothing else is
      // what made a mountainside read as empty from a distance, and it left the
      // biome you spend the most time crossing with nothing in it to pick.
      //
      // The lingonberry is the right second species and needs no new art: it is
      // an alpine berry in life, it already exists for the pine forest, and its
      // soil rule is turf — so it takes the grassy shoulders and `_floraSoilOk`
      // keeps it off the scree and the bare stone, which is where a berry bush
      // has no business being anyway.
      case BIOME.MOUNTAIN:
        if (r < 0.22 * dp) id = ID.alpine_aster;
        else if (r < 0.30 * dp) id = ID.lingonberry;
        // Stonecrop takes the bare rock the other two refuse, so it fills the
        // scree rather than competing for the same grassy shoulders.
        else if (r < 0.40 * dp) id = ID.stonecrop;
        break;
      // Marram binds the dune and driftwood is the beachcomber's find, so the
      // second is two orders below the first. A shoreline with a log on it
      // every ten paces is a lumber yard.
      case BIOME.BEACH:
        if (r < 0.42 * dp) id = ID.marram;
        else if (r < 0.48 * dp) id = ID.driftwood;
        break;
      // Verdant's understorey, and it is the densest carpet in the table for
      // the same reason its canopy is the densest canopy: what a jungle floor
      // is, is that you cannot see it. Fern for the bulk, with the two wetland
      // species the shade and the standing water earn, and the deathcap at the
      // forest's own ratio because rotting leaf litter is where one grows.
      case BIOME.JUNGLE:
        if (r < 0.82 * dp) id = ID.fern;
        else if (r < 0.88 * dp) id = ID.swampreed;
        else if (r < 0.92 * dp) id = ID.mireroot;
        else if (r < 0.955 * dp) id = ID.deathcap;
        break;
      // Tempest grows nothing, and that is written out rather than left to the
      // default so the next reader can see it was decided. The face is scoured
      // rock, gravel and standing mud with the wind never off it; a carpet on it
      // would be a carpet that has no business surviving there, and the bare
      // ground is most of what makes the place read as hostile.
      default: return;
    }
    // The soil test comes *after* the species is chosen, and that ordering is
    // the whole design: a biome says what would like to grow here and the
    // ground says whether it may. A mountain shoulder that has weathered to
    // bare stone grows no aster, and the roll is spent either way, so the
    // column's stream does not depend on what it is standing on.
    if (id && this._floraSoilOk(id, surf)) blocks[cellAt(col, k + 1)] = id;
  }

  /**
   * The cave floor: one column's underground flora.
   *
   * Own column only, so no region clip — and unlike everything on the surface
   * it walks the whole column rather than looking at one cell, because a cave
   * column has as many floors as the carve left it.
   *
   * The floor test is the same `supports` the reef uses plus `CARVEABLE`, and
   * both are needed for different reasons: `supports` is the block rule (these
   * all carry `needsFloor`), and `CARVEABLE` is what says the cell under this
   * pocket is *rock the cave pass could have cut*, which keeps the plants out
   * of the air gaps inside a structure or under a fallen log.
   *
   * The headroom test above it is what stops a mushroom appearing inside a
   * one-cell crack that nobody can enter and nobody can see into.
   *
   * It runs after `floraAt`, which scatters its glowcaps into these same
   * pockets, and refuses any cell that is not air — so a glowcap always wins
   * its cell. That is an ordering and not a race: both passes read only this
   * column's terrain, which is finished before decoration starts.
   */
  caveFloraAt(blocks, col) {
    const kTop = this.groundKOf(col);
    // A column needs a surface to be under, and enough crust under that to
    // hold a passage worth walking. The ground sits around layer 32 and the
    // mantle starts at the bottom of the array, so ten is the point below which
    // there is no cave to be in.
    if (kTop < 10) return;

    const q = _landXY;
    this._xyOf(col, q);
    // Its own frequency and its own plane of the lattice, like every other
    // density field in this file: a cave garden and a meadow drawn from one
    // field are one field wearing two hats.
    const f = this.nDetail.fbm(q.x, q.y, 88.1, surfScale(4.3), 3, 0.5);
    const lush = Math.pow(clamp(f * 0.5 + 0.5, 0, 1), CAVE_CLUMP);
    const rng = this.colRng(col, 0x6d3e);

    // Stop three under the surface: the top of a cave that breaks the ground is
    // daylight, and a cave mushroom growing in it reads as a surface plant that
    // has come out wrong.
    const kMax = Math.min(kTop - 3, D - 3);
    for (let k = 2; k <= kMax; k++) {
      if (blocks[cellAt(col, k)] !== ID.air) continue;
      if (blocks[cellAt(col, k + 1)] !== ID.air) continue;
      const floor = blocks[cellAt(col, k - 1)];
      // CARVEABLE says "this is rock a passage could have been cut through",
      // which is what keeps these out of the air gaps inside a structure or
      // under a fallen log. The soil test per species is checked below, once
      // the species is known — a crystal takes rock only and the two fungi
      // take a dirt floor as well, so they cannot share one gate here.
      if (!CARVEABLE[floor] || !supports(floor)) continue;

      const under = kTop - k;
      // The two gradients, and they run opposite ways on purpose so that
      // descending is legible: the fungus is a shallow-cave thing that gives
      // out, and the crystal has not started until well below it. They overlap
      // from 16 to 26, so there is a band with all three, a shallow zone with
      // only fungus, and a deep zone with only the mineral.
      const warm = 1 - smoothstep(CAVE_WARM_FULL, CAVE_WARM_END, under);
      const cold = smoothstep(CAVE_COLD_MIN, CAVE_COLD_FULL, under);

      const r = rng();
      const pMush = CAVE_MUSH * lush * warm;
      const pShelf = CAVE_SHELF * lush * warm;
      const pCrystal = CAVE_CRYSTAL * lush * cold;
      let id = 0;
      // The truffle rides the fungus band and is a fifth of it: it takes soil
      // and never rock (see its soil rule), so it appears only in the dirt
      // pockets of a shallow cave, which is exactly where one should be dug up
      // and is rare enough that finding one is an event.
      const pTruffle = CAVE_MUSH * 0.2 * lush * warm;
      if (r < pMush) id = ID.cave_mushroom;
      else if (r < pMush + pShelf) id = ID.shelf_fungus;
      else if (r < pMush + pShelf + pTruffle) id = ID.truffle;
      else if (r < pMush + pShelf + pTruffle + pCrystal) id = ID.crystal_cluster;
      if (id && growsOn(id, floor)) blocks[cellAt(col, k)] = id;
    }
  }

  /**
   * The stand this column is the centre of, decided from terrain alone, or null.
   *
   * The reef's `_reefSite` with the sea taken out of it, and everything that
   * function's docstring says applies here word for word: on a lattice so the
   * separation is arithmetic, nothing written, nothing read outside the
   * candidate column itself, and every draw taken before the roll that can
   * reject it so a rejected candidate costs the same rolls as a kept one.
   *
   * The flatness bound is tighter than a tree's 1.5 and looser than a hot
   * spring's 0.35: a stand does not level the ground the way a spring does, so
   * it can take a slope, but a disc of one plant poured down a 2-block-a-column
   * scarp reads as a spill.
   */
  _standSite(col) {
    const p = colXY(col, _standParts);
    if (p.x % STAND_LATTICE !== STAND_LI || p.y % STAND_LATTICE !== STAND_LJ) return null;
    const spec = STAND_SPEC[this.colBiome[col]];
    if (spec === undefined) return null;
    if (this.submerged[col] || this.lakeKind[col]) return null;
    if (this.colSlope[col] > 1.1) return null;
    // Out of the gorge itself, and one column clear of its lip. `canyonNear` is
    // the dilation and 0 means "in one", so this is "not in one and not on the
    // edge of one".
    //
    // The first cut insisted on CANYON_NEAR_MAX — "nowhere near a canyon at
    // all" — and that quietly gutted the one biome that needed a stand most:
    // the badlands *is* canyon country, so almost every candidate in it was
    // being thrown away by a rule meant to stop a disc of flowers pouring over
    // a cliff edge. Two columns of clearance does that job and leaves the mesas
    // between the gorges usable.
    if (this.canyonNear[col] < 2) return null;
    const k = this.groundKOf(col);
    if (k < 1 || k > D - 4) return null;
    // `_springNear` owns `_spParts`, which is why this pass has `_standParts`
    // of its own — `p` is still live below.
    if (this._springNear(col) >= 0) return null;

    const rng = this.colRng(col, 0x9c4b);
    const roll = rng();
    const rad = STAND_R_MIN + rng() * (STAND_R_MAX - STAND_R_MIN);
    // How thickly this particular stand grew, so a valley with two of them in
    // it does not read as one texture stamped twice.
    const rich = 0.62 + rng() * 0.38;
    if (roll > spec.chance) return null;
    return { x: p.x, y: p.y, bi: this.colBiome[col], rad, rich, id: spec.id };
  }

  /**
   * One column's stand, if it has one, clipped to a region.
   *
   * Structurally `reefAt` on dry land, including the part that matters: every
   * column in the disc draws from *its own* `colRng`, never from the centre's,
   * so the order the disc is walked in cannot change what any column gets and
   * the region clip can be a plain `continue`.
   *
   * `groundKOf` and not `surfaceK`, because this runs over the margin and
   * `surfaceK` under a canopy returns the canopy — which is to say it encodes
   * whether the neighbouring region has been decorated yet. The cell this
   * writes into is `groundK + 1`, which is exactly where a trunk stands, and
   * `STAND_CLEARS` is what keeps it from eating one.
   */
  standAt(blocks, col, rid) {
    const site = this._standSite(col);
    if (site === null) return;
    const ri = Math.ceil(site.rad);
    for (let di = -ri; di <= ri; di++) {
      for (let dj = -ri; dj <= ri; dj++) {
        const d = Math.hypot(di, dj);
        if (d > site.rad) continue;
        const c = patchCol(site.x, site.y, di, dj);
        if (rid >= 0 && regionOfCol(c) !== rid) continue;
        // The stand stops at its biome's edge rather than running over it. A
        // lavender field that spills two columns into the neighbouring desert
        // is the one thing that would make the whole pass read as a bug.
        if (this.colBiome[c] !== site.bi) continue;
        if (this.submerged[c] || this.lakeSurf[c] > 0) continue;
        if (this.inLakeBed(c)) continue;
        if (this._springNear(c) >= 0) continue;
        if (this.colSlope[c] > 1.4) continue;
        const k = this.groundKOf(c);
        if (k < 1 || k >= D - 2) continue;
            const surf = blocks[cellAt(c, k)];
        if (!this._floraSoilOk(site.id, surf)) continue;
        if (!STAND_CLEARS[blocks[cellAt(c, k + 1)]]) continue;
        // Headroom, for the reason spelled out in `landFloraAt`: the cell above
        // the ground can be clear under a boulder's overhang and still be a
        // sealed gap.
        if (IS_OPAQUE[blocks[cellAt(c, k + 2)]]) continue;

        const w = 1 - d / site.rad;
        // The reef's smoothstep, and here for the same measured reason: a plain
        // linear falloff leaves a low but non-zero chance out at the rim, and
        // the rim is most of a disc's area, so most of what the pass produced
        // was single plants standing alone a long way from anything. Taking the
        // outer fifth to zero gives the stand a body and an edge.
        //
        // The knee is at 0.20 and not the reef's 0.42 because a reef is up to
        // seven columns of radius and this is three: the same fraction of a
        // much smaller disc is most of the stand. Measured at 0.34 a stand came
        // out at 6-9 plants, which is a clump; at 0.20, with the fill and the
        // minimum radius both raised, it is the patch you can pick out from the
        // other side of a valley, which is the only reason the pass exists.
        if (this.colRng(c, 0x2f85)() < site.rich * STAND_FILL * smoothstep(0, 0.20, w)) {
          blocks[cellAt(c, k + 1)] = site.id;
        }
      }
    }
  }

  // --- the reef --------------------------------------------------------------

  /**
   * The topmost *water* cell of a column, or -1 if it holds no water.
   *
   * Two independent waters, exactly as `fillColumn` fills them: the sea, which
   * is everything at or below SEA_K the flood fill could reach, and a lake,
   * which is everything at or below its own surface. A column can in principle
   * be under both — a pond sitting in a coastal hollow — so it is the higher of
   * the two, because that is the one whose cell carries the surface quad.
   */
  _topWaterK(col) {
    let top = this.submerged[col] ? SEA_TOP_K : -1;
    const ls = this.lakeSurf[col];
    if (ls > 0) {
      const lk = Math.floor(ls - 0.5);
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
    return supports(blocks[cellAt(col, k)]) ? k : -1;
  }

  /**
   * Put one single-cell prop on the floor of a column. The whole topK rule is
   * the second line, and every prop in both passes goes through here.
   */
  _propAt(blocks, col, id, floorK, topK) {
    const k = floorK + 1;
    if (k >= topK) return false;
    if (blocks[cellAt(col, k)] !== ID.water) return false;
    blocks[cellAt(col, k)] = id;
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
    for (let s = 0; s < n; s++) if (blocks[cellAt(col, base + s)] !== ID.water) return 0;
    for (let s = 0; s < n; s++) blocks[cellAt(col, base + s)] = ID.kelp;
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
    const p = colXY(col, _reefXY);
    if (p.x % REEF_LATTICE !== REEF_LI || p.y % REEF_LATTICE !== REEF_LJ) return null;
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

    const warm = clamp((this._seaTemp(p.x, p.y) - REEF_TEMP_MIN)
      / (REEF_TEMP_FULL - REEF_TEMP_MIN), 0, 1);
    if (warm <= 0) return null;

    const rng = this.colRng(col, 0xd33f);
    const roll = rng();
    const rad = REEF_R_MIN + rng() * (REEF_R_MAX - REEF_R_MIN);
    // How thick this particular reef is in the middle. Without it every reef
    // comes out the same density and a bank of three reads as one texture.
    const rich = 0.55 + rng() * 0.45;
    if (roll > REEF_CHANCE * warm) return null;
    return { x: p.x, y: p.y, rad, rich, warm };
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
        const c = patchCol(site.x, site.y, di, dj);
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
        // Grapes come out of the carpet, not out of the coral — see REEF_GRAPE.
        const pGrape = REEF_GRAPE * site.warm * (0.30 + 0.70 * (1 - w));

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
        } else if (r < pShell + pCoral + pGrape) {
          id = ID.sea_grape;
        } else if (r < pShell + pCoral + pGrape + pGrass) {
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

    const q = _reefXY;
    this._xyOf(col, q);
    // A pond is fresh water at whatever altitude the land put it, so the
    // seabed climate term means nothing there. Weed grows in all of them.
    const temp = inLake ? 0.2 : this._seaTemp(q.x, q.y);
    // Three fields at three frequencies and three planes, so a kelp forest, a
    // lettuce bed and a grass meadow are not one patch wearing three hats.
    const gf = this.nDetail.fbm(q.x, q.y, 0, surfScale(7.5), 3, 0.5);
    const kf = this.nDetail.fbm(q.x, q.y, 31.7, surfScale(5.0), 3, 0.5);
    const lf = this.nDetail.fbm(q.x, q.y, -18.4, surfScale(6.2), 3, 0.5);
    const gDens = clamp(gf * 0.5 + 0.55, 0, 1);
    const kDens = clamp(kf * 0.5 + 0.42, 0, 1);
    const lDens = clamp(lf * 0.5 + 0.46, 0, 1);

    const rng = this.colRng(col, 0x5ea9);
    const r = rng();
    const n = KELP_MIN + Math.floor(rng() * (KELP_MAX - KELP_MIN + 1));

    const canGrass = inLake || temp > GRASS_TEMP_MIN;
    const canKelp = inLake || (temp > KELP_TEMP_MIN && temp < KELP_TEMP_MAX);
    // Salt water only. Lakes never reach this line today — LAKE_WEED is empty,
    // so `inLake` has already returned above — but writing the condition out
    // says what the answer would be if a weed were ever let back into a pond:
    // sea lettuce is food, and a food that grows in every puddle is a food
    // nobody has to swim for.
    const canLettuce = !inLake && temp > LETTUCE_TEMP_MIN;
    const pKelp = canKelp ? KELP_PEAK * Math.pow(kDens, 2.6) : 0;
    const pGrass = canGrass ? GRASS_PEAK * Math.pow(gDens, 2.2) : 0;
    const pLettuce = canLettuce ? LETTUCE_PEAK * Math.pow(lDens, 2.4) : 0;

    if (r < pKelp) {
      // A stalk that does not fit falls through to nothing rather than to
      // grass: the alternative is a kelp bed in deep water that turns into a
      // lawn wherever the bottom rises, which reads as a bug.
      this._kelpAt(blocks, col, Math.min(n, topK - floorK - 1), floorK, topK);
    } else if (r < pKelp + pLettuce) {
      this._propAt(blocks, col, ID.sea_lettuce, floorK, topK);
    } else if (r < pKelp + pLettuce + pGrass) {
      this._propAt(blocks, col, ID.sea_grass, floorK, topK);
    }
  }

  /**
   * The deep floor's anemones, for one column.
   *
   * A separate pass rather than a fourth band in `seabedFloraAt`, and the
   * reason is the depth bands: that pass stops at SEAB_DEPTH_MAX (13) and this
   * one starts at 13.5, so the two are disjoint by construction and neither can
   * take a cell the other wanted. Folding them together would mean one function
   * whose two halves share nothing but a floor lookup.
   *
   * Writes only into its own column, like `floraAt` and `seabedFloraAt`, so it
   * needs no region clip. It runs last of everything, which means a reef prop
   * that reached this deep is already standing here — `_propAt` refuses a cell
   * that is not water, so the reef simply wins, deterministically, rather than
   * the two passes overwriting each other in whatever order they happened to
   * run. Every decision is off the terrain tables and this column's own
   * `colRng`, so a region boundary cannot disagree with itself.
   */
  abyssAt(blocks, col) {
    if (this.colBiome[col] !== BIOME.OCEAN || !this.submerged[col]) return;
    if (this.lakeKind[col]) return;
    const topK = this._topWaterK(col);
    if (topK < 2) return;
    const floorK = this._reefFloorK(blocks, col);
    if (floorK < 0 || floorK + 1 >= topK) return;
    const depth = depthOfK(floorK);
    if (depth < ABYSS_DEPTH_MIN) return;

    const q = _reefXY;
    this._xyOf(col, q);
    // A low frequency and a high exponent: patches a few columns across with
    // long empty floor between them. See ABYSS_CLUMP.
    const af = this.nDetail.fbm(q.x, q.y, 57.3, surfScale(3.1), 3, 0.5);
    const aDens = clamp(af * 0.5 + 0.5, 0, 1);
    const deep = clamp((depth - ABYSS_DEPTH_MIN) / (ABYSS_DEPTH_FULL - ABYSS_DEPTH_MIN), 0, 1);
    const rng = this.colRng(col, 0x2b9f);
    if (rng() < ABYSS_CHANCE * Math.pow(aDens, ABYSS_CLUMP) * deep) {
      this._propAt(blocks, col, ID.abyss_anemone, floorK, topK);
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
    // The three land passes, in this order and for reasons that are all
    // orderings rather than taste.
    //
    // The stands run over the margin like a reef does, because a stand is a
    // feature several columns across; they run *after* `floraAt` so that pass
    // is untouched by them — a stand that ran first would leave a non-air cell
    // where `floraAt` tests for one, and `floraAt` bails on the whole column
    // when it finds one, cave mushrooms included. Running second, a stand
    // overwrites the tall grass it lands on (see STAND_CLEARS), which is what
    // makes it read as a stand rather than as lace.
    //
    // The carpet runs after the stands and takes only cells left empty, so a
    // meadow comes out as lavender where the stand is and clover around it,
    // rather than the two competing. Every stand that could reach a column in
    // `cols` is inside the margin this region was handed, so what it finds is
    // finished and the same from either side of a boundary.
    //
    // The cave pass is disjoint from both by depth and runs last of the three.
    for (let n = 0; n < margin.length; n++) this.standAt(blocks, margin[n], rid);
    for (let n = 0; n < cols.length; n++) this.landFloraAt(blocks, cols[n]);
    for (let n = 0; n < cols.length; n++) this.caveFloraAt(blocks, cols[n]);
    // The two underwater passes, last, and in this order. A reef is a feature
    // laid over a margin like a tree is; the grass and kelp are cover laid one
    // column at a time like `floraAt` is, and they run second so that a blade
    // and a coral head never both claim the cell above the same piece of
    // seabed. Nothing above this touches water: trees and flora refuse a liquid
    // cell outright and a boulder is only ever laid into air.
    for (let n = 0; n < margin.length; n++) this.reefAt(blocks, margin[n], rid);
    for (let n = 0; n < cols.length; n++) this.seabedFloraAt(blocks, cols[n]);
    // The deep floor, last. Disjoint from the cover pass by depth and beaten by
    // the reef where the two bands overlap — see `abyssAt`.
    for (let n = 0; n < cols.length; n++) this.abyssAt(blocks, cols[n]);
    // The waterfalls, last of everything and over this region's own columns
    // only. Last because the lip and the column of water are written
    // unconditionally and must win: a fall stands in open air over water, which
    // is ground no other pass claims, but the lip reaches one column sideways
    // into the cliff beside it and that column is ordinary land. Own columns
    // only because `_fallSite` refuses any site that would reach outside its
    // region, so there is nothing in the margin that could write in here.
    for (let n = 0; n < cols.length; n++) this.fallAt(blocks, cols[n], rid);
  }
}
