// Placed structures: ruins, camps, crypts, monoliths and the rest of the things
// that give the planet somewhere to walk to.
//
// Everything here runs as the last worldgen pass, after caves, ore and trees.
// The order is not cosmetic. Caves are carved through `CARVEABLE` rock and ore
// veins overwrite `ORE_HOST` rock; both of those tests match the brick and
// stone a structure is built from only by accident, and running them afterwards
// would open a cave through a crypt wall or fill a monolith with coal. Trees
// are last of the terrain passes and force their trunks over anything already
// there, so a hall built before them would grow an oak through its own floor.
// Building last means every structure clears its own volume once and keeps it.
//
// Loot is placed as blocks, not container contents. A crate is a plain block —
// per-crate inventory would need a store in `main.js` alongside `this.kilns`,
// which this workstream is not allowed to touch — so the pattern throughout is
// a valuable block set into the floor with a crate standing on top of it. The
// crate is the marker; breaking it uncovers the prize.

import { makeRng } from '../util/Noise.js';
import {
  F, D, R_MIN, COLUMNS, cidx, BIOME,
} from './Constants.js';
import {
  colParts, centerDir, patchColumn,
} from './Sphere.js';
import { ID } from './Blocks.js';

// ---------------------------------------------------------------------------
// Local frames on a cubesphere
// ---------------------------------------------------------------------------

/**
 * A structure's footprint: the block of columns around a centre column, indexed
 * by signed (di, dj) offsets in the centre's own face frame.
 *
 * The obvious way to build this is repeated `colNeighbor`/`stepColumn`. It is
 * wrong for anything wider than a couple of columns near a cube edge, and the
 * failure is not a crash — it is a building that visibly bends. `colNeighbor`
 * answers in the *destination* column's face frame, so the moment a walk steps
 * over a seam the meaning of "+j" rotates by ninety degrees and the rest of the
 * row peels off sideways. A hall straddling a cube edge came out as two halves
 * at right angles to each other.
 *
 * So the patch is resolved the way the adjacency table itself is built: extend
 * the centre's face coordinates past +-1, which `faceDir` accepts and maps onto
 * the neighbouring face through the same tangent warp, then read the result
 * back with `dirToFace`. The local frame stays the centre's frame the whole way
 * across the seam, so nothing folds.
 *
 * It still does not survive the crossing cleanly. The centre's extended
 * coordinates and the neighbouring face's own coordinates are different
 * parameterisations of the same sphere, and they diverge with distance past
 * the edge: measured on a 35x35 patch, a footprint whose centre sits on a cube
 * edge collapses 68 of its 1 225 cells onto a column some other cell already
 * claimed — walls come out with holes in them and one side of the building is
 * a third narrower than the other. Eight columns in it is still 20 cells. So
 * `placeStructures` refuses any site whose footprint would leave its face, and
 * this mapping only ever has to be exact, which within one face it is.
 */
const _parts = { f: 0, i: 0, j: 0 };

/**
 * One column of a local patch, without building the whole patch.
 *
 * This lives in Sphere.js now: worldgen stamps tree canopies three and four
 * columns wide and was walking the grid to do it, which put a bite out of every
 * canopy near a seam. Two copies of a mapping this subtle is one too many.
 */
const patchCol = patchColumn;

class Site {
  /**
   * @param {Uint8Array} blocks voxel array, written in place
   * @param {Int16Array} groundK topmost solid layer per column
   * @param {number} col centre column
   * @param {number} rad half-width of the footprint, in columns
   */
  constructor(blocks, groundK, col, rad) {
    this.blocks = blocks;
    this.groundK = groundK;
    this.rad = rad;
    this.n = rad * 2 + 1;
    this.cols = new Int32Array(this.n * this.n);

    const p = colParts(col, _parts);
    const f = p.f, pi = p.i, pj = p.j;
    for (let di = -rad; di <= rad; di++) {
      for (let dj = -rad; dj <= rad; dj++) {
        this.cols[(di + rad) * this.n + (dj + rad)] = patchCol(f, pi, pj, di, dj);
      }
    }
  }

  /** Column at a local offset, or -1 outside the footprint. */
  col(di, dj) {
    if (di < -this.rad || di > this.rad || dj < -this.rad || dj > this.rad) return -1;
    return this.cols[(di + this.rad) * this.n + (dj + this.rad)];
  }

  /** Topmost solid terrain layer under a local offset, or -1. */
  gk(di, dj) {
    const c = this.col(di, dj);
    return c < 0 ? -1 : this.groundK[c];
  }

  get(di, dj, k) {
    const c = this.col(di, dj);
    if (c < 0 || k < 0 || k >= D) return ID.stone;
    return this.blocks[c * D + k];
  }

  set(di, dj, k, id) {
    const c = this.col(di, dj);
    if (c < 0 || k < 0 || k >= D) return;
    this.blocks[c * D + k] = id;
  }

  /** Write only where the cell is currently empty — for props over rubble. */
  setIfAir(di, dj, k, id) {
    const c = this.col(di, dj);
    if (c < 0 || k < 0 || k >= D) return;
    const cur = this.blocks[c * D + k];
    if (cur === ID.air || cur === ID.water) this.blocks[c * D + k] = id;
  }

  /** Clear a vertical run to air. Inclusive of both ends. */
  clear(di, dj, k0, k1) {
    for (let k = k0; k <= k1; k++) this.set(di, dj, k, ID.air);
  }

  fill(i0, i1, j0, j1, k0, k1, id) {
    for (let di = i0; di <= i1; di++) {
      for (let dj = j0; dj <= j1; dj++) {
        for (let k = k0; k <= k1; k++) this.set(di, dj, k, id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/**
 * The coloured brick, mosaic, plaster and shingle families exist in the block
 * table and worldgen never placed one of them. Each palette is a whole building
 * — walls, a contrasting trim course, a floor and a roof — so a ruin reads as
 * one structure rather than as a heap of assorted masonry.
 *
 * `biomes` is a hint, not a filter: a ruin picks from the palettes that claim
 * its biome so a desert hall is sandy and a taiga one is slate, but every
 * palette stays reachable somewhere.
 */
const PALETTES = [
  {
    wall: 'brick_tan', trim: 'plaster', floor: 'cobble_tan', roof: 'shingle_rose',
    post: 'sandstone_brick',
    biomes: [BIOME.DESERT, BIOME.BADLANDS, BIOME.SAVANNA, BIOME.BEACH],
  },
  {
    wall: 'brick_crimson', trim: 'sandstone_brick', floor: 'flagstone', roof: 'shingle_red',
    post: 'smooth_sandstone',
    biomes: [BIOME.DESERT, BIOME.BADLANDS, BIOME.SAVANNA, BIOME.PLAINS],
  },
  {
    wall: 'brick_olive', trim: 'mosaic_green', floor: 'flagstone', roof: 'shingle_green',
    post: 'andesite_brick',
    biomes: [BIOME.FOREST, BIOME.MEADOW, BIOME.PLAINS, BIOME.SAVANNA],
  },
  {
    wall: 'brick_jade', trim: 'mosaic_white', floor: 'marble_brick', roof: 'shingle_green',
    post: 'marble_brick',
    biomes: [BIOME.FOREST, BIOME.MEADOW, BIOME.PINE_FOREST],
  },
  {
    wall: 'brick_azure', trim: 'mosaic_blue', floor: 'marble_brick', roof: 'shingle_dark',
    post: 'limestone_brick',
    biomes: [BIOME.SNOW, BIOME.TUNDRA, BIOME.MOUNTAIN, BIOME.PINE_FOREST],
  },
  {
    wall: 'brick_ember', trim: 'brick_amber', floor: 'slate_brick', roof: 'shingle_dark',
    post: 'granite_brick',
    biomes: [BIOME.MOUNTAIN, BIOME.BADLANDS, BIOME.PINE_FOREST],
  },
  {
    wall: 'brick_rose', trim: 'mosaic_white', floor: 'limestone_brick', roof: 'shingle_rose',
    post: 'plaster',
    biomes: [BIOME.MEADOW, BIOME.PLAINS, BIOME.FOREST],
  },
  {
    wall: 'brick_cyan', trim: 'mosaic_blue', floor: 'flagstone', roof: 'shingle_dark',
    post: 'marble_brick',
    biomes: [BIOME.SNOW, BIOME.TUNDRA, BIOME.MOUNTAIN],
  },
];

// resolve names to ids once — `ID` lookups in a stamping loop are a Map hit per block
for (const p of PALETTES) {
  p.wall = ID[p.wall]; p.trim = ID[p.trim]; p.floor = ID[p.floor];
  p.roof = ID[p.roof]; p.post = ID[p.post];
}

function palette(biome, rng) {
  const fits = PALETTES.filter((p) => p.biomes.includes(biome));
  const pool = fits.length ? fits : PALETTES;
  return pool[(rng() * pool.length) | 0];
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

/**
 * Four tiers, priced by the tool a player needs to take them home. Blocks are
 * used rather than raw ore because a block is nine ingots' worth: finding one
 * has to be worth the walk, and the ore version of the same reward is already
 * lying in the ground everywhere.
 *
 * The tier gates are the ones already on the blocks — `gold_block` and
 * `crystal_block` need no tier at all, `silver_block` and `amethyst_block` need
 * stone, the gems need iron and `void_block` needs an astral pick. So a legend
 * cache is genuinely a thing you come back for.
 */
const LOOT_COMMON = ['coal_block', 'copper_block', 'iron_block', 'clay', 'planks'];
const LOOT_GOOD = ['iron_block', 'silver_block', 'gold_block', 'amethyst_block', 'copper_block'];
const LOOT_RARE = ['gold_block', 'emerald_block', 'ruby_block', 'sapphire_block', 'crystal_block'];
const LOOT_LEGEND = ['void_block', 'emerald_block', 'ruby_block', 'sapphire_block', 'crystal_block'];
for (const t of [LOOT_COMMON, LOOT_GOOD, LOOT_RARE, LOOT_LEGEND]) {
  for (let i = 0; i < t.length; i++) t[i] = ID[t[i]];
}

const pick = (arr, rng) => arr[(rng() * arr.length) | 0];

/**
 * One cache: the prize set into the floor, a crate standing on it.
 *
 * The prize is deliberately visible from above as a different floor tile even
 * before the crate is broken — a crate that turns out to be scenery teaches a
 * player to stop opening them.
 */
function cache(site, di, dj, k, table, rng) {
  site.set(di, dj, k, pick(table, rng));
  site.set(di, dj, k + 1, ID.crate);
}

// ---------------------------------------------------------------------------
// Surface structures
// ---------------------------------------------------------------------------

/**
 * Level a rectangular pad: floor at `kF`, everything above cleared, everything
 * below packed down to the terrain so the building never floats over a dip.
 * Returns nothing; callers build on top of `kF`.
 */
function pad(site, i0, i1, j0, j1, kF, floorId, footId) {
  for (let di = i0; di <= i1; di++) {
    for (let dj = j0; dj <= j1; dj++) {
      // Clear to the top of the shell rather than to the height of the build.
      // Clearing only as far as the walls reach was what forced every surface
      // structure down to the coast: a pine is eleven blocks tall, so "clear
      // enough to swallow a tree" became the headroom budget, and with mean
      // land at layer 30 of 44 that left almost nowhere inland to stand. The
      // cells above a building are air anyway; clearing them costs nothing.
      site.clear(di, dj, kF + 1, D - 1);
      site.set(di, dj, kF, floorId);
      // foundation down to whichever is lower, the terrain or four blocks
      const g = site.gk(di, dj);
      for (let k = kF - 1; k >= Math.min(kF - 4, g); k--) {
        if (site.get(di, dj, k) === ID.air || site.get(di, dj, k) === ID.water) {
          site.set(di, dj, k, footId);
        }
      }
    }
  }
}

/**
 * A broken hall. Two rooms, a corner tower stub and a wall line you can still
 * read all the way round even where it has come down to one course.
 *
 * The decay is per-column and biased: most of the perimeter keeps at least one
 * course so the floor plan survives, one whole side is knocked down to rubble
 * so the ruin has a way in, and the four corners are left tall because corners
 * are the last part of a masonry wall to go.
 */
function buildRuin(site, ctx) {
  const { rng } = ctx;
  const p = palette(ctx.biome, rng);
  const wi = 4 + ((rng() * 3) | 0);          // 9..13 columns across
  const wj = 3 + ((rng() * 3) | 0);          // 7..11 columns deep
  const H = 4 + ((rng() * 3) | 0);
  const kF = site.gk(0, 0);
  if (kF < 8 || kF > D - 6) return false;

  pad(site, -wi, wi, -wj, wj, kF, p.floor, p.post);

  // the collapsed side, as an axis and a sign
  const openAxis = rng() < 0.5;
  const openSign = rng() < 0.5 ? -1 : 1;

  const wall = (di, dj) => {
    const corner = (Math.abs(di) === wi && Math.abs(dj) === wj);
    const onOpen = openAxis ? (di === openSign * wi) : (dj === openSign * wj);
    let h;
    if (corner) h = H;
    else if (onOpen) h = rng() < 0.7 ? 0 : 1;
    else {
      const t = rng();
      h = t < 0.14 ? 0 : t < 0.45 ? 1 + ((rng() * 2) | 0) : 2 + ((rng() * (H - 1)) | 0);
    }
    for (let k = 1; k <= h; k++) {
      // a trim course two up, and whatever is left of it at the broken top
      const id = (k === 2 || (k === h && rng() < 0.3)) ? p.trim : p.wall;
      site.set(di, dj, kF + k, id);
    }
  };

  for (let di = -wi; di <= wi; di++) { wall(di, -wj); wall(di, wj); }
  for (let dj = -wj + 1; dj <= wj - 1; dj++) { wall(-wi, dj); wall(wi, dj); }

  // interior partition with a doorway, so the plan is two rooms not one shed
  const px = ((rng() * 3) | 0) - 1;
  const doorJ = ((rng() * (wj - 1)) | 0) - ((wj - 1) >> 1);
  for (let dj = -wj + 1; dj <= wj - 1; dj++) {
    if (Math.abs(dj - doorJ) <= 1) continue;
    const h = rng() < 0.25 ? 0 : 1 + ((rng() * (H - 1)) | 0);
    for (let k = 1; k <= h; k++) site.set(px, dj, kF + k, p.wall);
  }

  // a corner tower that outlived the roof
  const ti = rng() < 0.5 ? -wi : wi;
  const tj = rng() < 0.5 ? -wj : wj;
  const th = Math.min(D - 2 - kF, H + 2 + ((rng() * 4) | 0));
  for (let di = 0; di <= 2; di++) {
    for (let dj = 0; dj <= 2; dj++) {
      const ci = ti - Math.sign(ti) * di;
      const cj = tj - Math.sign(tj) * dj;
      const ring = (di === 0 || dj === 0 || di === 2 || dj === 2);
      if (!ring) { site.clear(ci, cj, kF + 1, kF + th); continue; }
      // the tower shears off at an angle rather than stopping level
      const top = th - ((di + dj) * (1 + ((rng() * 2) | 0)));
      for (let k = 1; k <= top; k++) {
        site.set(ci, cj, kF + k, k % 4 === 3 ? p.trim : p.wall);
      }
    }
  }

  // fallen roof: shingles lying on the floor where the tiles came down
  for (let di = -wi + 1; di <= wi - 1; di++) {
    for (let dj = -wj + 1; dj <= wj - 1; dj++) {
      if (rng() < 0.08) site.setIfAir(di, dj, kF + 1, p.roof);
      else if (rng() < 0.05) site.setIfAir(di, dj, kF + 1, ID.mossy_stone_brick);
    }
  }

  // rubble scattered outside the wall line
  for (let di = -wi - 3; di <= wi + 3; di++) {
    for (let dj = -wj - 3; dj <= wj + 3; dj++) {
      if (Math.abs(di) <= wi && Math.abs(dj) <= wj) continue;
      if (rng() > 0.06) continue;
      const g = site.gk(di, dj);
      if (g < 0 || g >= D - 2) continue;
      site.setIfAir(di, dj, g + 1, rng() < 0.5 ? ID.mossy_stone_brick : ID.cobblestone);
    }
  }

  // 2-3 caches, always inside the walls
  const n = 2 + ((rng() * 2) | 0);
  for (let c = 0; c < n; c++) {
    const di = ((rng() * (wi * 2 - 3)) | 0) - (wi - 2);
    const dj = ((rng() * (wj * 2 - 3)) | 0) - (wj - 2);
    cache(site, di, dj, kF, rng() < 0.3 ? LOOT_RARE : LOOT_GOOD, rng);
  }
  return true;
}

/**
 * Somebody camped here and did not come back. A kiln, a bench, a crate, a
 * lantern on a post — the lantern is what makes a camp findable after dark,
 * which matters more than any of the rest of it.
 */
function buildCamp(site, ctx) {
  const { rng } = ctx;
  const cold = ctx.biome === BIOME.SNOW || ctx.biome === BIOME.TUNDRA;
  const kF = site.gk(0, 0);
  if (kF < 8 || kF > D - 10) return false;

  const ground = cold ? ID.snow_brick : ID.dirt_path;
  const plank = cold ? ID.planks_pine : (rng() < 0.5 ? ID.planks_grey : ID.planks_dark);

  // Trodden ground. The floor has to be laid over every column a prop stands
  // on, so the ragged edge is applied outside the built area only — an earlier
  // version let the random thinning eat the lean-to's own footing and left the
  // back wall half-buried in the hillside it was standing on.
  const floorCell = (di, dj) => {
    site.clear(di, dj, kF + 1, D - 1);
    site.set(di, dj, kF, ground);
    const g = site.gk(di, dj);
    for (let k = kF - 1; k >= Math.min(kF - 3, g); k--) site.setIfAir(di, dj, k, ID.coarse_dirt);
  };
  const s = rng() < 0.5 ? -1 : 1;
  for (let di = -4; di <= 4; di++) {
    for (let dj = -4; dj <= 4; dj++) {
      const d = Math.hypot(di, dj);
      const built = Math.abs(dj) <= 2 && (di * s) >= 2 && (di * s) <= 3;
      if (!built && (d > 3.4 || (d > 2.4 && rng() < 0.5))) continue;
      floorCell(di, dj);
    }
  }
  floorCell(-2, 2);

  site.set(-1, -1, kF + 1, ID.kiln);
  site.set(1, -1, kF + 1, ID.bench);
  cache(site, 1, 1, kF, rng() < 0.25 ? LOOT_GOOD : LOOT_COMMON, rng);

  // the lean-to: two posts, a back wall, a slab roof over it
  for (let dj = -2; dj <= 2; dj++) {
    site.set(s * 3, dj, kF + 1, plank);
    site.set(s * 3, dj, kF + 2, plank);
  }
  site.set(s * 2, -2, kF + 1, ID.log_oak);
  site.set(s * 2, -2, kF + 2, ID.log_oak);
  site.set(s * 2, 2, kF + 1, ID.log_oak);
  site.set(s * 2, 2, kF + 2, ID.log_oak);
  for (let dj = -2; dj <= 2; dj++) {
    site.set(s * 3, dj, kF + 3, ID.slab_planks_pine);
    site.set(s * 2, dj, kF + 3, ID.slab_planks_pine);
  }

  // fire pit and the lantern post
  site.set(0, 0, kF, ID.cobblestone);
  for (let d = 0; d < 4; d++) {
    const di = d < 2 ? (d === 0 ? 1 : -1) : 0;
    const dj = d < 2 ? 0 : (d === 2 ? 1 : -1);
    site.set(di, dj, kF, ID.cobblestone);
  }
  site.set(0, 0, kF + 1, ID.torch);
  const li = -2, lj = 2;
  site.set(li, lj, kF + 1, ID.log_oak);
  site.set(li, lj, kF + 2, ID.log_oak);
  site.set(li, lj, kF + 3, ID.lantern);
  return true;
}

/**
 * A standing stone on a plinth, tall enough to be a bearing from a long way
 * off, with a sealed vault under it. There is no way in: the plinth is the
 * clue, and digging is the answer.
 */
function buildMonolith(site, ctx) {
  const { rng } = ctx;
  const kF = site.gk(0, 0);
  const H = Math.min(8 + ((rng() * 4) | 0), D - 3 - kF);
  if (kF < 12 || H < 5) return false;

  // A bare ring around the plinth. Without it the first monolith built in a
  // pine forest was shorter than the trees ringing it and could not be seen
  // from ten columns away, which defeats the only thing a monolith is for.
  // Nothing grows here; the ground is scorched back to grit.
  for (let di = -7; di <= 7; di++) {
    for (let dj = -7; dj <= 7; dj++) {
      const d = Math.hypot(di, dj);
      if (d > 7 || d <= 3) continue;
      const g = site.gk(di, dj);
      if (g < 1 || g >= D - 2) continue;
      site.clear(di, dj, g + 1, D - 1);
      if (d < 5.5 || rng() < 0.5) site.set(di, dj, g, rng() < 0.3 ? ID.gravel : ID.coarse_dirt);
    }
  }

  pad(site, -3, 3, -3, 3, kF, ID.andesite_brick, ID.andesite);
  site.fill(-2, 2, -2, 2, kF + 1, kF + 1, ID.flagstone);

  const shaftId = rng() < 0.5 ? ID.obsidian : ID.slate_brick;
  const glow = rng() < 0.5 ? ID.glowstone_azure : ID.glowstone_verdant;
  for (let k = 2; k <= H; k++) {
    for (let di = 0; di <= 1; di++) {
      for (let dj = 0; dj <= 1; dj++) {
        // inlaid light every fourth course, on one corner only, so the shaft
        // reads as carved rather than striped
        const lit = (k % 4 === 0) && di === 0 && dj === 0;
        site.set(di - 1, dj - 1, kF + k, lit ? glow : shaftId);
      }
    }
  }
  // the top is snapped off at an angle
  site.set(0, 0, kF + H + 1, shaftId);

  for (const [ci, cj] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
    const h = 2 + ((rng() * 3) | 0);
    for (let k = 1; k <= h; k++) site.set(ci, cj, kF + k, ID.slate);
  }

  // sealed vault, five down
  const kv = kF - 5;
  site.fill(-2, 2, -2, 2, kv - 1, kv + 4, ID.slate_brick);
  site.fill(-1, 1, -1, 1, kv, kv + 2, ID.air);
  site.set(0, 0, kv + 2, glow);
  cache(site, 0, 0, kv, LOOT_RARE, rng);
  site.set(-1, -1, kv, pick(LOOT_GOOD, rng));
  site.set(1, 1, kv, pick(LOOT_GOOD, rng));
  return true;
}

/** A stand of trees that turned to stone. No canopy, no drop, all silhouette. */
function buildGrove(site, ctx) {
  const { rng } = ctx;
  const rad = 5 + ((rng() * 4) | 0);
  const kC = site.gk(0, 0);
  if (kC < 8 || kC > D - 12) return false;

  for (let di = -rad; di <= rad; di++) {
    for (let dj = -rad; dj <= rad; dj++) {
      if (Math.hypot(di, dj) > rad) continue;
      const g = site.gk(di, dj);
      if (g < 1 || g >= D - 10) continue;
      // strip whatever grew here — a petrified grove with a live oak in it
      // reads as a bug, and trees run before this pass
      site.clear(di, dj, g + 1, D - 1);
      if (rng() < 0.6) site.set(di, dj, g, rng() < 0.5 ? ID.coarse_dirt : ID.gravel);
    }
  }

  const trunks = 8 + ((rng() * 7) | 0);
  for (let t = 0; t < trunks; t++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * rad;
    const di = Math.round(Math.cos(a) * r);
    const dj = Math.round(Math.sin(a) * r);
    const g = site.gk(di, dj);
    if (g < 1 || g >= D - 10) continue;
    const rock = rng() < 0.55 ? ID.stone : (rng() < 0.5 ? ID.andesite : ID.tuff);
    const h = 3 + ((rng() * 5) | 0);
    for (let k = 1; k <= h; k++) site.set(di, dj, g + k, rock);
    // one dead limb, high up
    if (h >= 4) {
      const bi = rng() < 0.5 ? 1 : -1;
      const bj = rng() < 0.5 ? 1 : -1;
      site.setIfAir(di + bi, dj, g + h - 1, rock);
      if (rng() < 0.5) site.setIfAir(di + bi * 2, dj + bj, g + h, rock);
    }
    if (rng() < 0.35) site.setIfAir(di, dj + 1, g + 1, ID.mushroom);
    if (rng() < 0.25) site.set(di, dj, g, ID.amethyst_ore);
  }

  cache(site, 0, 0, site.gk(0, 0), LOOT_GOOD, rng);
  return true;
}

/**
 * An impact crater, and the thing that made it still sitting in the middle.
 *
 * This is the one place voidstone and deep crystal break the surface. Both
 * normally sit below radius 116 behind an astral pick, so a crater is a look at
 * the end of the ore ladder from the top of it — and the ejecta ring hands over
 * sulfur and a tier-3 gem you can actually carry away today.
 */
function buildCrater(site, ctx) {
  const { rng } = ctx;
  const rad = 7 + ((rng() * 5) | 0);
  const dep = 5 + ((rng() * 4) | 0);
  const kG = site.gk(0, 0);
  if (kG < 12 || kG > D - 8) return false;

  for (let di = -rad - 2; di <= rad + 2; di++) {
    for (let dj = -rad - 2; dj <= rad + 2; dj++) {
      const d = Math.hypot(di, dj);
      if (d > rad + 2.5) continue;
      const g = site.gk(di, dj);
      if (g < 6 || g >= D - 6) continue;

      const t = d / rad;
      if (d <= rad) {
        // A quartic rather than a parabola. The parabola put the deepest point
        // only at the exact centre and sloped all the way out, so a crater of
        // radius eleven and depth five read as a shallow dish; this gives a
        // flat floor and a wall you have to climb.
        const bowl = Math.round(dep * (1 - t * t * t * t));
        const kFloor = g - bowl;
        // clear to the top of the shell: a pine is eleven blocks tall and
        // clearing eight left canopies floating over the bowl
        site.clear(di, dj, kFloor + 1, D - 1);
        // Basalt is not the grey rock its name suggests: in this pack it is
        // drawn as lava-cracked stone, and paving the bowl with it turned the
        // whole crater molten orange — it read as a lava lake, not as a scar.
        // It is kept as an accent for the hot ring only. Ashstone and grit do
        // the work, which is also what makes the ejecta apron read as burnt
        // ground rather than as more rock.
        let id;
        if (t < 0.35) id = rng() < 0.16 ? ID.magma_stone : ID.ash_stone;
        else if (t < 0.75) id = rng() < 0.14 ? ID.basalt : ID.ash_stone;
        else id = rng() < 0.5 ? ID.gravel : ID.coarse_dirt;
        if (t > 0.35 && rng() < 0.13) id = ID.sulfur_ore;
        site.set(di, dj, kFloor, id);
      } else {
        // ejecta piled on the rim
        site.clear(di, dj, g + 2, D - 1);
        if (rng() < 0.6) site.setIfAir(di, dj, g + 1, rng() < 0.5 ? ID.ash_stone : ID.gravel);
      }
    }
  }

  // the impactor: an obsidian rind over a lit core
  const kC = kG - dep;
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      for (let dk = 0; dk <= 3; dk++) {
        const d = Math.hypot(di, dj, dk - 1);
        if (d > 2.4) continue;
        const inner = d < 1.3;
        let id = inner ? ID.magma_stone : ID.obsidian;
        if (inner && rng() < 0.45) id = ID.voidstone_ore;
        else if (!inner && rng() < 0.22) id = ID.deep_crystal_ore;
        site.set(di, dj, kC + dk, id);
      }
    }
  }
  cache(site, rad - 2, 0, kG - Math.round(dep * (1 - ((rad - 2) / rad) ** 2)), LOOT_RARE, rng);
  return true;
}

// ---------------------------------------------------------------------------
// Underground structures
// ---------------------------------------------------------------------------

/**
 * A crypt, cut into the iron-and-silver band, with a stairwell that surfaces.
 *
 * The stair is the whole point. A sealed room at depth twelve is found by
 * accident once a planet; a brick-lipped hole in the ground is found on purpose,
 * and a hole in the ground with steps going down it is an invitation.
 */
function buildCrypt(site, ctx) {
  const { rng } = ctx;
  const kG = site.gk(0, 0);
  const dep = 9 + ((rng() * 4) | 0);
  const kF = kG - dep;
  const roomH = 4;
  if (kF < 10 || kG >= D - 4) return false;

  const wi = 4 + ((rng() * 2) | 0);
  const wj = 3 + ((rng() * 2) | 0);

  // shell first, then hollow it — the ceiling and floor come free that way
  site.fill(-wi - 1, wi + 1, -wj - 1, wj + 1, kF - 1, kF + roomH + 1, ID.slate_brick);
  site.fill(-wi, wi, -wj, wj, kF, kF, ID.flagstone);
  site.fill(-wi, wi, -wj, wj, kF + 1, kF + roomH, ID.air);
  site.fill(-wi, wi, -wj, wj, kF + roomH + 1, kF + roomH + 1, ID.andesite_brick);

  // pillars with a lantern on top
  for (const ci of [-wi + 2, wi - 2]) {
    for (const cj of [-wj + 1, wj - 1]) {
      for (let k = 1; k <= roomH - 1; k++) site.set(ci, cj, kF + k, ID.marble_brick);
      site.set(ci, cj, kF + roomH, ID.lantern);
    }
  }
  // damp: the odd course of the wall has given way to moss
  for (let di = -wi; di <= wi; di++) {
    for (let k = 1; k <= roomH; k++) {
      if (rng() < 0.12) site.set(di, -wj - 1, kF + k, ID.mossy_stone_brick);
      if (rng() < 0.12) site.set(di, wj + 1, kF + k, ID.mossy_stone_brick);
    }
  }

  // three biers down the middle, each with its cache
  for (let n = 0; n < 3; n++) {
    const dj = (n - 1) * 2;
    site.set(-1, dj, kF + 1, ID.marble_brick);
    site.set(0, dj, kF + 1, ID.marble_brick);
    site.set(1, dj, kF + 1, ID.marble_brick);
    cache(site, 0, dj, kF + 1, n === 1 ? LOOT_RARE : LOOT_GOOD, rng);
  }

  // doorway out of the +i wall
  for (let dj = -1; dj <= 1; dj++) site.fill(wi, wi + 1, dj, dj, kF + 1, kF + 3, ID.air);

  // stair: one column out, one layer up, until it reaches daylight
  let k = kF;
  let di = wi + 2;
  for (let n = 0; n < dep + 10 && di <= site.rad - 3; n++, di++) {
    const g = site.gk(di, 0);
    if (g < 0) return true;
    // Line the shaft rather than build it. Filling the casing unconditionally
    // meant that wherever the ground fell away beside the stair a 5x7 block of
    // masonry stood out of the hillside with no opening in it — the stairwell
    // looked like a wall somebody had abandoned.
    for (let dj = -2; dj <= 2; dj++) {
      for (let kk = k - 1; kk <= k + 4; kk++) {
        const cur = site.get(di, dj, kk);
        if (cur !== ID.air && cur !== ID.water) site.set(di, dj, kk, ID.stone_brick);
      }
    }
    site.fill(di, di, -1, 1, k, k, ID.stone_brick);
    site.fill(di, di, -1, 1, k + 1, k + 3, ID.air);
    if (k >= g) {
      // daylight. Open the shaft and put a brick lip round it so the entrance
      // is legible from ground level rather than being a hole in the grass.
      for (let ii = di - 1; ii <= di + 1; ii++) {
        for (let dj = -2; dj <= 2; dj++) {
          const gg = site.gk(ii, dj);
          if (gg < 0 || gg >= D - 2) continue;
          const inner = Math.abs(dj) <= 1 && ii >= di - 1;
          site.clear(ii, dj, gg + 1, gg + 4);
          if (!inner) site.set(ii, dj, gg, rng() < 0.5 ? ID.mossy_stone_brick : ID.stone_brick);
          else site.clear(ii, dj, k + 1, gg + 2);
        }
      }
      return true;
    }
    k++;
  }
  return true;
}

/** A hollow lined with crystal. No entrance — this is a reward for caving. */
function buildGeode(site, ctx) {
  const { rng } = ctx;
  const kG = site.gk(0, 0);
  const rad = 4 + ((rng() * 4) | 0);
  const kC = ctx.deepK;
  if (kC - rad - 2 < 3 || kC + rad + 2 > kG - 5) return false;

  for (let di = -rad - 1; di <= rad + 1; di++) {
    for (let dj = -rad - 1; dj <= rad + 1; dj++) {
      for (let dk = -rad - 1; dk <= rad + 1; dk++) {
        const d = Math.hypot(di, dj, dk);
        if (d > rad + 1) continue;
        if (d > rad - 1) {
          const t = rng();
          site.set(di, dj, kC + dk,
            t < 0.18 ? ID.amethyst_ore : t < 0.28 ? ID.crystal_ore : ID.crystal_stone);
        } else {
          site.set(di, dj, kC + dk, ID.air);
        }
      }
    }
  }

  // inward spikes, and the seam on the floor
  for (let n = 0; n < 14; n++) {
    const a = rng() * Math.PI * 2, b = Math.acos(rng() * 2 - 1);
    const ux = Math.sin(b) * Math.cos(a), uy = Math.sin(b) * Math.sin(a), uz = Math.cos(b);
    const len = 1 + ((rng() * 3) | 0);
    for (let s = 0; s < len; s++) {
      const t = rad - 1 - s;
      const id = rng() < 0.4 ? ID.amethyst_ore : ID.crystal_ore;
      site.set(Math.round(ux * t), Math.round(uy * t), kC + Math.round(uz * t), id);
    }
  }
  for (let di = -rad; di <= rad; di++) {
    for (let dj = -rad; dj <= rad; dj++) {
      const d = Math.hypot(di, dj);
      if (d > rad - 1) continue;
      const kf = kC - Math.floor(Math.sqrt(Math.max(0, (rad - 1) ** 2 - d * d)));
      if (rng() < 0.22) site.set(di, dj, kf, ID.deep_crystal_ore);
    }
  }
  site.set(0, 0, kC + rad - 2, ID.glowstone_azure);
  cache(site, 0, 0, kC - rad + 1, LOOT_RARE, rng);
  return true;
}

/**
 * A magma chamber with somebody's shrine on an island in the middle of it.
 *
 * The lava is kept to a shallow moat with an obsidian lip. Worldgen-placed
 * liquid is registered as a source by `Water.seedSources` and only starts
 * moving when the player edits next to it — and `Water._place` writes `ID.water`
 * whatever the liquid was, so a big lava pool would turn into a big water pool
 * the first time anyone mined the rim. A shallow one keeps that pre-existing
 * quirk to the size it already has in cave lava.
 */
function buildLavaChamber(site, ctx) {
  const { rng } = ctx;
  const kG = site.gk(0, 0);
  const rad = 5 + ((rng() * 4) | 0);
  const kC = ctx.deepK;
  if (kC - rad - 2 < 3 || kC + rad + 2 > kG - 6) return false;

  for (let di = -rad - 1; di <= rad + 1; di++) {
    for (let dj = -rad - 1; dj <= rad + 1; dj++) {
      for (let dk = -rad - 1; dk <= rad + 1; dk++) {
        const d = Math.hypot(di, dj, dk);
        if (d > rad + 1) continue;
        if (d > rad - 1) {
          const t = rng();
          site.set(di, dj, kC + dk,
            t < 0.035 ? ID.voidstone_ore : t < 0.24 ? ID.hell_brick : ID.basalt);
        } else {
          site.set(di, dj, kC + dk, ID.air);
        }
      }
    }
  }

  // floor of the chamber, then a shallow moat inside an obsidian lip
  const kFloor = kC - rad + 1;
  for (let di = -rad; di <= rad; di++) {
    for (let dj = -rad; dj <= rad; dj++) {
      const d = Math.hypot(di, dj);
      if (d > rad - 1) continue;
      site.set(di, dj, kFloor - 1, ID.obsidian);
      if (d > 2.6) site.set(di, dj, kFloor, ID.lava);
      else site.set(di, dj, kFloor, ID.obsidian);
    }
  }

  // the shrine on the island
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      if (Math.hypot(di, dj) > 2.4) continue;
      site.set(di, dj, kFloor, ID.hell_brick);
    }
  }
  for (const [ci, cj] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    site.set(ci, cj, kFloor + 1, ID.magma_brick);
    site.set(ci, cj, kFloor + 2, ID.magma_brick);
    site.set(ci, cj, kFloor + 3, ID.glowstone);
  }
  cache(site, 0, 0, kFloor, LOOT_LEGEND, rng);
  site.set(-1, 0, kFloor + 1, ID.crate);
  site.set(-1, 0, kFloor, pick(LOOT_LEGEND, rng));
  site.set(1, 0, kFloor + 1, ID.crate);
  site.set(1, 0, kFloor, pick(LOOT_LEGEND, rng));
  return true;
}

/**
 * The polar vault. Restricted to the two ice caps, a handful per planet, and
 * the only structure whose cache is legendary all the way through.
 *
 * Nothing else on the planet rewards going to a pole, and the caps are the one
 * place a player can reliably navigate to without coordinates: walk until the
 * sun stops moving.
 */
function buildPolarVault(site, ctx) {
  const { rng } = ctx;
  const kF = site.gk(0, 0);
  if (kF < 10 || kF > D - 14) return false;

  pad(site, -5, 5, -5, 5, kF, ID.snow_brick, ID.packed_ice);

  const tiers = [[4, 1, 2], [3, 3, 2], [2, 5, 2]];
  for (const [half, k0, h] of tiers) {
    for (let di = -half; di <= half; di++) {
      for (let dj = -half; dj <= half; dj++) {
        for (let k = k0; k < k0 + h; k++) {
          const edge = Math.abs(di) === half || Math.abs(dj) === half;
          site.set(di, dj, kF + k, edge && k === k0 + h - 1 ? ID.blue_ice : ID.snow_brick);
        }
      }
    }
  }
  for (let k = 7; k <= 10; k++) site.set(0, 0, kF + k, ID.packed_ice);
  site.set(0, 0, kF + 11, ID.glowstone_azure);

  // the chamber, sealed under the base
  const kv = kF - 5;
  site.fill(-3, 3, -3, 3, kv - 1, kv + 5, ID.blue_ice);
  site.fill(-2, 2, -2, 2, kv, kv + 3, ID.air);
  site.set(0, 0, kv + 3, ID.glowstone_azure);
  for (const [ci, cj] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    site.set(ci, cj, kv, ID.void_block);
  }
  cache(site, 0, 0, kv, LOOT_LEGEND, rng);
  cache(site, -1, 1, kv, LOOT_LEGEND, rng);
  cache(site, 1, -1, kv, LOOT_LEGEND, rng);
  return true;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * The catalogue. `target` is how many the planet should end up with; `tries` is
 * how many candidate columns each is allowed to reject before giving up, so a
 * type whose biome is scarce on this seed comes out short rather than looping.
 *
 * Order matters: rarest first. Every placed structure claims a disc, and a
 * common type placed first would have eaten the ground the rare ones need.
 */
const KINDS = [
  {
    name: 'polar_vault', target: 6, rad: 6, clearance: 14, headroom: 12, maxSlope: 0.8,
    maxRelief: 6, build: buildPolarVault, deep: false, polar: 0.95, tries: 400000,
  },
  {
    name: 'crater', target: 5, rad: 14, clearance: 20, headroom: 8, maxSlope: 0.9,
    maxRelief: 6, build: buildCrater, deep: false,
  },
  {
    name: 'monolith', target: 10, rad: 8, clearance: 14, headroom: 8, maxSlope: 0.7,
    maxRelief: 4, build: buildMonolith, deep: false,
    // Open ground only. A standing stone is a landmark, and a landmark inside
    // a closed canopy is just a rock.
    biomes: [BIOME.PLAINS, BIOME.MEADOW, BIOME.SAVANNA, BIOME.DESERT, BIOME.BADLANDS,
      BIOME.TUNDRA, BIOME.SNOW, BIOME.MOUNTAIN, BIOME.BEACH],
  },
  {
    name: 'petrified_grove', target: 14, rad: 10, clearance: 16, headroom: 9, maxSlope: 1.0,
    maxRelief: 7, build: buildGrove, deep: false,
    biomes: [BIOME.PLAINS, BIOME.SAVANNA, BIOME.BADLANDS, BIOME.MOUNTAIN,
      BIOME.TUNDRA, BIOME.DESERT, BIOME.MEADOW],
  },
  {
    name: 'ruin', target: 30, rad: 12, clearance: 16, headroom: 6, maxSlope: 0.7,
    maxRelief: 5, build: buildRuin, deep: false,
  },
  {
    name: 'camp', target: 40, rad: 5, clearance: 10, headroom: 4, maxSlope: 1.0,
    maxRelief: 4, build: buildCamp, deep: false,
  },

  {
    name: 'lava_chamber', target: 30, rad: 10, clearance: 14, headroom: 2,
    build: buildLavaChamber, deep: true, band: [12, 17],
  },
  {
    name: 'geode_cavern', target: 55, rad: 9, clearance: 12, headroom: 2,
    build: buildGeode, deep: true, band: [14, 22],
  },
  {
    name: 'crypt', target: 60, rad: 24, clearance: 15, headroom: 4,
    build: buildCrypt, deep: true,
  },
];

/**
 * Place every structure in the catalogue.
 *
 * @param {Uint8Array} blocks voxel array, written in place
 * @param {Float32Array} colHeight
 * @param {Uint8Array} colBiome
 * @param {Float32Array} colSlope
 * @param {number} seed
 * @returns {Object<string, number>} how many of each kind actually landed
 */
export function placeStructures(blocks, colHeight, colBiome, colSlope, seed) {
  const rng = makeRng((seed ^ 0x7f4a7c15) | 0);

  // Topmost solid layer per column, from the height field rather than by
  // scanning `blocks`. Trees and flora are already in the array by now, so a
  // scan would put a hall's floor on top of a canopy.
  const groundK = new Int16Array(COLUMNS);
  for (let col = 0; col < COLUMNS; col++) {
    groundK[col] = Math.max(0, Math.min(D - 1, Math.floor(colHeight[col] - R_MIN - 0.5)));
  }

  // Two claim masks. A crypt's stairwell surfaces, so it claims both; a geode
  // and a ruin can share the same patch of ground quite happily.
  const claimSurf = new Uint8Array(COLUMNS);
  const claimDeep = new Uint8Array(COLUMNS);
  const counts = {};
  const dir = [0, 0, 0];
  const parts = { f: 0, i: 0, j: 0 };

  for (const kind of KINDS) {
    let placed = 0;
    const tries = kind.tries ?? kind.target * 2000;
    for (let t = 0; t < tries && placed < kind.target; t++) {
      const col = (rng() * COLUMNS) | 0;

      // --- cheap rejects, before any patch is touched ---
      const bi = colBiome[col];
      if (bi === BIOME.OCEAN) continue;
      const g = groundK[col];
      // `headroom` is what the tallest part of the build needs above the floor.
      // The shell is only 44 layers deep and mean land sits at layer 30, so a
      // twelve-block tower genuinely does not fit on a mountain — this is the
      // reason surface structures favour low ground.
      if (g < 12 || g > D - 2 - kind.headroom) continue;
      if (claimSurf[col] && (!kind.deep || kind.name === 'crypt')) continue;
      if (claimDeep[col] && kind.deep) continue;

      colParts(col, parts);
      // Keep the whole footprint on one cube face. See the note on `Site`:
      // across a seam the local frame stays unfolded but stops being 1:1, and
      // a building loses cells out of its walls. Excluding a band `rad` wide
      // along each face edge costs a third of the planet for the largest
      // structures and nothing measurable in the counts — placement is
      // rejection sampling with two thousand tries per structure.
      if (parts.i < kind.rad || parts.i >= F - kind.rad
        || parts.j < kind.rad || parts.j >= F - kind.rad) continue;
      centerDir(parts.f, parts.i, parts.j, dir);
      if (kind.polar && Math.abs(dir[1]) < kind.polar) continue;
      if (kind.biomes && !kind.biomes.includes(bi)) continue;
      // Steep ground: a hall terraced into a cliff is a retaining wall, not a
      // ruin, and the levelling pass only reaches four blocks down.
      if (!kind.deep && colSlope[col] > kind.maxSlope) continue;

      // --- separation, on a coarse cross rather than the whole disc ---
      // Building a full patch just to reject the candidate was the expensive
      // version of this: at a clearance of 20 that is 1 681 tangent-warp
      // resolutions per *rejected* site, and most sites are rejected.
      const cl = kind.clearance;
      const mask = kind.deep ? claimDeep : claimSurf;
      let clash = false;
      for (let d = -cl; d <= cl && !clash; d += 4) {
        if (mask[patchCol(parts.f, parts.i, parts.j, d, 0)]
          || mask[patchCol(parts.f, parts.i, parts.j, 0, d)]
          || mask[patchCol(parts.f, parts.i, parts.j, d, d)]
          || mask[patchCol(parts.f, parts.i, parts.j, d, -d)]) clash = true;
      }
      if (clash) continue;

      // --- flatness over the actual footprint ---
      if (!kind.deep) {
        const step = Math.max(1, kind.rad >> 2);
        let lo = 99, hi = -99, wet = 0, n = 0;
        for (let di = -kind.rad; di <= kind.rad; di += step) {
          for (let dj = -kind.rad; dj <= kind.rad; dj += step) {
            const c = patchCol(parts.f, parts.i, parts.j, di, dj);
            const gg = groundK[c];
            if (gg < lo) lo = gg;
            if (gg > hi) hi = gg;
            // The centre column being dry says nothing about the footprint.
            // Every early ruin came out standing half in the sea, because the
            // only low ground flat enough to pass the relief test was the shore.
            if (colBiome[c] === BIOME.OCEAN) wet++;
            n++;
          }
        }
        if (hi - lo > kind.maxRelief) continue;
        if (wet * 8 > n) continue;
      }

      const site = new Site(blocks, groundK, col, kind.rad);
      const ctx = {
        rng,
        biome: bi,
        // Deep structures pick their own radial band. Passing it in rather than
        // letting each builder roll one keeps the band next to the catalogue,
        // where the ore ladder it has to line up with is visible.
        deepK: kind.band
          ? kind.band[0] + ((rng() * (kind.band[1] - kind.band[0] + 1)) | 0)
          : 0,
      };
      if (!kind.build(site, ctx)) continue;

      for (let di = -cl; di <= cl; di++) {
        for (let dj = -cl; dj <= cl; dj++) {
          if (di * di + dj * dj > cl * cl) continue;
          const c = patchCol(parts.f, parts.i, parts.j, di, dj);
          mask[c] = 1;
          // A crypt breaks the surface, so it has to hold ground on both masks
          // or a ruin will be dropped straight on top of its stairwell.
          if (kind.name === 'crypt') claimSurf[c] = 1;
        }
      }
      placed++;
    }
    counts[kind.name] = placed;
  }
  return counts;
}
