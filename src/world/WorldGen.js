// Cubesphere planet generator. Terrain is built per radial column, so the
// surface is a true height field over the sphere — every block sits upright.

import { Noise, makeRng, hash3, clamp, lerp, smoothstep } from '../util/Noise.js';
import {
  F, D, FACES, R_MIN, R_CORE, R_MANTLE, R_SEA, R_SURFACE, R_TERRAIN_MAX,
  COLUMNS, NUM_VOXELS, vidx, cidx, BIOME,
} from './Constants.js';
import { centerDir, colNeighbor, colParts, patchColumn } from './Sphere.js';
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

    let h = R_SURFACE;
    h += continent * 7.5;
    h += Math.min(0, continent) * 3.0;              // carve real ocean basins
    h += land * peaks * 7.5 * (0.35 + mask * 0.65);
    h += land * hills * 1.6;
    h += detail * 0.18;
    if (h < R_SEA + 1.2 && h > R_SEA - 3) h = lerp(h, R_SEA - 0.4, 0.4);
    return clamp(h, R_MIN + 6, R_TERRAIN_MAX);
  }

  /**
   * Which rock sits at radius `r` under a given direction.
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
    if (rr >= 126) return p > 0.52 ? ID.andesite : ID.stone;
    if (rr >= 120) return p > 0.50 ? ID.marble : ID.limestone;
    if (rr >= 114) return p > 0.48 ? ID.granite : (p < -0.50 ? ID.tuff : ID.andesite);
    if (rr >= 110.5) return p > 0.54 ? ID.azurite : (p < -0.62 ? ID.geode_stone : ID.slate);
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

  generate(onProgress = () => {}) {
    const blocks = new Uint8Array(NUM_VOXELS);
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
      onProgress(0.02 + 0.18 * ((f + 1) / FACES), 'Sculpting the sphere');
    }

    // Relax the height field across the column graph. Voxel terrain quantises
    // to whole layers, so any residual high-frequency noise becomes a forest of
    // one-column spikes; a couple of gentle passes leaves the big landforms
    // intact and kills the needles.
    onProgress(0.20, 'Weathering the surface');
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

    // slope from the finished height field — exact, unlike sampling the noise
    for (let col = 0; col < COLUMNS; col++) {
      const h = colHeight[col];
      let s = 0;
      for (let d = 0; d < 4; d++) s += Math.abs(colHeight[colNeighbor(col, d)] - h);
      colSlope[col] = s * 0.25;
    }

    // ---- 2. fill columns ---------------------------------------------------
    onProgress(0.22, 'Laying rock and soil');
    for (let f = 0; f < FACES; f++) {
      for (let i = 0; i < F; i++) {
        for (let j = 0; j < F; j++) {
          const col = cidx(f, i, j);
          const h = colHeight[col];
          const bi = colBiome[col];
          const rocky = colSlope[col] > 1.35;
          const base = col * D;
          centerDir(f, i, j, dir);

          // Surface material varies within a biome, not just between biomes: the
          // same field that drifts tundra snow is reused to break up ocean silt,
          // podzol under pines and the grit in a savanna, so no biome is a flat
          // wash of one block.
          const patch = this.nDetail.fbm3(dir[0] * 14, dir[1] * 14, dir[2] * 14, 3, 2, 0.5);

          let top, sub;
          switch (bi) {
            case BIOME.OCEAN: top = patch > 0.16 ? ID.mud : ID.gravel; sub = ID.stone; break;
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
          // Sandy shallows, but only just off the shore. This used to be a flat
          // "anything under sea level + 0.4 is sand" rule running independently
          // of the biome, which is the other half of why the planet looked like
          // one continuous beach — a column could be labelled Plains and still
          // be built entirely out of sand.
          if (h < R_SEA + 0.4 && bi !== BIOME.SNOW && shoreDist[col] <= BEACH_REACH + 1) {
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
              id = r <= R_SEA ? ID.water : ID.air;
            } else {
              const depth = h - r;
              if (depth < 1.0) id = top;
              else if (depth < 4.0) id = sub;
              else id = this.stratum(r, dir[0], dir[1], dir[2]);
            }
            blocks[base + k] = id;
          }
        }
      }
      onProgress(0.22 + 0.24 * ((f + 1) / FACES), 'Laying rock and soil');
    }

    // ---- 3. caves ----------------------------------------------------------
    onProgress(0.47, 'Carving caverns');
    const nc = this.nCave;
    for (let col = 0; col < COLUMNS; col++) {
      const h = colHeight[col];
      const base = col * D;
      const f = (col / (F * F)) | 0;
      const rem = col - f * F * F;
      centerDir(f, (rem / F) | 0, rem % F, dir);
      for (let k = 0; k < D; k++) {
        if (!CARVEABLE[blocks[base + k]]) continue;
        const r = R_MIN + k + 0.5;
        if (r < R_MANTLE + 1.5 || r > h - 2.2) continue;
        const px = dir[0] * r, py = dir[1] * r, pz = dir[2] * r;
        const a = nc.ridged3(px * 0.062, py * 0.062, pz * 0.062, 3, 2.1, 0.5);
        const b = nc.ridged3(px * 0.062 + 40.5, py * 0.062, pz * 0.062 - 22.3, 3, 2.1, 0.5);
        const cav = nc.fbm3(px * 0.035 + 11.1, py * 0.035, pz * 0.035, 3, 2, 0.5);
        if (Math.min(a, b) > 0.86 || cav > 0.58) {
          blocks[base + k] = (r < R_MANTLE + 4 && cav > 0.7) ? ID.lava : ID.air;
        }
      }
      if ((col & 4095) === 0) onProgress(0.47 + 0.1 * (col / COLUMNS), 'Carving caverns');
    }

    // ---- 4. ores -----------------------------------------------------------
    onProgress(0.58, 'Seeding ore veins');
    // Depth bands, deepest and rarest first. The loop takes the first vein that
    // claims a cell and stops, so listing a common shallow ore above a rare deep
    // one would starve the deep one wherever their bands touch.
    //
    // Two of the old entries were dead. `gold_ore` ran lo 108 hi 30 and
    // `crystal_ore` lo 108 hi 26 — the radii are 100..144, so `hi` was below
    // `lo` and both tests were unreachable for every voxel on the planet. Gold
    // and crystal did not generate at all.
    //
    // The ladder the bands describe, from the surface down:
    //   131-142  coal, copper                     stone
    //   124-131  coal, copper, iron               stone / limestone
    //   116-124  iron, silver, gold, moss         limestone / andesite
    //   112-116  amethyst, crystal, sulfur        andesite / granite / tuff
    //   108-116  the deep seam, in slate          slate / azurite
    //   108-112  emerald, sapphire, ruby, void    slate
    const ores = [
      { id: ID.voidstone_ore, scale: 0.62, thr: 0.60, lo: R_MANTLE, hi: 111, seed: 907 },
      { id: ID.ruby_ore, scale: 0.50, thr: 0.58, lo: R_MANTLE, hi: 112.5, seed: 719 },
      { id: ID.sapphire_ore, scale: 0.50, thr: 0.58, lo: R_MANTLE, hi: 113, seed: 733 },
      { id: ID.emerald_ore, scale: 0.48, thr: 0.57, lo: R_MANTLE, hi: 114, seed: 641 },
      { id: ID.deep_crystal_ore, scale: 0.46, thr: 0.60, lo: R_MANTLE, hi: 113, seed: 811 },
      { id: ID.deep_gold_ore, scale: 0.38, thr: 0.58, lo: R_MANTLE, hi: 114, seed: 557 },
      { id: ID.deep_silver_ore, scale: 0.36, thr: 0.57, lo: R_MANTLE, hi: 113.5, seed: 463 },
      { id: ID.deep_iron_ore, scale: 0.30, thr: 0.55, lo: R_MANTLE, hi: 116, seed: 389 },
      { id: ID.deep_copper_ore, scale: 0.28, thr: 0.55, lo: R_MANTLE, hi: 115, seed: 293 },
      { id: ID.deep_coal_ore, scale: 0.24, thr: 0.53, lo: R_MANTLE, hi: 116, seed: 197 },

      { id: ID.sulfur_ore, scale: 0.34, thr: 0.57, lo: R_MANTLE, hi: 118, seed: 101 },
      { id: ID.amethyst_ore, scale: 0.42, thr: 0.60, lo: R_MANTLE + 2, hi: 120, seed: 149 },
      { id: ID.crystal_ore, scale: 0.40, thr: 0.62, lo: 112, hi: 121, seed: 219 },
      { id: ID.gold_ore, scale: 0.34, thr: 0.60, lo: 114, hi: 125, seed: 143 },
      { id: ID.silver_ore, scale: 0.32, thr: 0.58, lo: 113, hi: 124, seed: 89 },
      { id: ID.iron_ore, scale: 0.26, thr: 0.56, lo: 116, hi: R_SURFACE - 2, seed: 71 },
      { id: ID.copper_ore, scale: 0.24, thr: 0.55, lo: 120, hi: R_TERRAIN_MAX, seed: 37 },
      { id: ID.coal_ore, scale: 0.20, thr: 0.52, lo: 118, hi: R_TERRAIN_MAX, seed: 0 },

      { id: ID.gravel, scale: 0.14, thr: 0.58, lo: R_MANTLE + 4, hi: R_TERRAIN_MAX, seed: 311 },
      // Clay and moss keep the bands they always had — clay's `lo` was 32, i.e.
      // below the innermost radius, so it has always meant "everywhere the host
      // rock reaches". Narrowing it here would quietly halve the brick supply.
      { id: ID.clay, scale: 0.22, thr: 0.62, lo: R_MANTLE, hi: R_SEA, seed: 407 },
      { id: ID.moss_stone, scale: 0.18, thr: 0.60, lo: R_MANTLE, hi: R_SURFACE, seed: 503 },
      // Moss is the only way to get a soft green block underground, and it is
      // shallow on purpose: it belongs to the cave mouth, not to the deep.
      { id: ID.moss_block, scale: 0.20, thr: 0.66, lo: 124, hi: R_SURFACE, seed: 601 },
    ];
    const no = this.nOre;
    for (let col = 0; col < COLUMNS; col++) {
      const base = col * D;
      const f = (col / (F * F)) | 0;
      const rem = col - f * F * F;
      centerDir(f, (rem / F) | 0, rem % F, dir);
      for (let k = 0; k < D; k++) {
        if (!ORE_HOST[blocks[base + k]]) continue;
        const r = R_MIN + k + 0.5;
        const px = dir[0] * r, py = dir[1] * r, pz = dir[2] * r;
        for (const o of ores) {
          if (r < o.lo || r > o.hi) continue;
          const n = no.fbm3(px * o.scale + o.seed, py * o.scale, pz * o.scale + o.seed * 0.5, 3, 2, 0.5);
          if (n > o.thr) { blocks[base + k] = o.id; break; }
        }
      }
    }

    // ---- 5. trees + scatter ------------------------------------------------
    onProgress(0.7, 'Growing forests');
    this.placeTrees(blocks, colHeight, colBiome, colSlope, rng);
    onProgress(0.86, 'Scattering flora');
    this.placeFlora(blocks, colHeight, colBiome, rng);

    // ---- 6. structures -----------------------------------------------------
    // No ruins, crypts or vaults. A planet you can walk around in four minutes
    // reads as *yours*; salting it with somebody else's architecture makes it
    // read as a level someone built, which is the opposite of the point. The
    // builder is kept — Structures.js still compiles and its patch mapping is
    // used elsewhere — so this is one line to put back if that judgement
    // changes.
    this.structureCounts = {};

    onProgress(0.95, 'Ready');
    return { blocks, colBiome, colHeight, structures: this.structureCounts };
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

  placeTrees(blocks, colHeight, colBiome, colSlope, rng) {
    for (let col = 0; col < COLUMNS; col++) {
      const bi = colBiome[col];
      if (colSlope[col] > 1.5) continue;
      const k = this.surfaceK(blocks, col);
      // need some headroom, but the land surface sits around k=30 of 44 — this
      // bound has to be generous or it rejects the entire planet
      if (k < 0 || k > D - 7) continue;
      const surf = blocks[col * D + k];

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
      else if (surf === ID.sand && bi === BIOME.DESERT) { kind = 'cactus'; chance = 0.02; }

      if (!kind || rng() > chance) continue;
      this.stampTree(blocks, kind, col, k + 1, rng);
    }

    // boulders
    for (let col = 0; col < COLUMNS; col++) {
      if (rng() > 0.0022) continue;
      const k = this.surfaceK(blocks, col);
      if (k < 0 || k > D - 5) continue;
      const surf = blocks[col * D + k];
      if (surf !== ID.grass && surf !== ID.stone && surf !== ID.snow) continue;
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
            if (blocks[c * D + kk] === ID.air) {
              blocks[c * D + kk] = mossy && rng() < 0.5 ? ID.moss_stone : ID.stone;
            }
          }
        }
      }
    }
  }

  stampTree(blocks, kind, col, k0, rng) {
    const set = (c, k, id, force = false) => {
      if (k < 0 || k >= D) return;
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
      oak: { h: [5, 7], log: ID.log_oak, leaf: ID.leaves_oak, rad: 2.6, shape: 'round' },
      birch: { h: [6, 9], log: ID.log_birch, leaf: ID.leaves_birch, rad: 2.2, shape: 'round' },
      pine: { h: [7, 11], log: ID.log_pine, leaf: ID.leaves_pine, rad: 3.0, shape: 'cone' },
      savanna: { h: [5, 7], log: ID.log_oak, leaf: ID.leaves_oak, rad: 3.3, shape: 'flat' },
    }[kind];

    // never let a canopy run off the top of the column
    const room = Math.max(3, D - 2 - k0 - Math.ceil(cfg.rad));
    const h = Math.min(room, cfg.h[0] + Math.floor(rng() * (cfg.h[1] - cfg.h[0] + 1)));
    for (let n = 0; n < h; n++) set(col, k0 + n, cfg.log, true);

    const blob = (ck, rad, ragged) => {
      const ri = Math.ceil(rad);
      for (let di = -ri; di <= ri; di++) {
        for (let dj = -ri; dj <= ri; dj++) {
          for (let dk = -ri; dk <= ri; dk++) {
            const d = Math.sqrt(di * di + dj * dj + dk * dk);
            if (d > rad + (rng() - 0.5) * ragged * 2) continue;
            if (d > rad * 0.7 && rng() < ragged) continue;
            set(at(di, dj), ck + dk, cfg.leaf);
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
      blob(top, cfg.rad, 0.25);
      blob(top - 2, cfg.rad * 0.85, 0.3);
    }
  }

  placeFlora(blocks, colHeight, colBiome, rng) {
    const n = this.nBiome;
    const dir = [0, 0, 0];
    for (let col = 0; col < COLUMNS; col++) {
      const k = this.surfaceK(blocks, col);
      if (k < 0 || k >= D - 2) continue;
      const base = col * D;
      const surf = blocks[base + k];
      if (blocks[base + k + 1] !== ID.air) continue;

      const f = (col / (F * F)) | 0;
      const rem = col - f * F * F;
      centerDir(f, (rem / F) | 0, rem % F, dir);
      const bi = colBiome[col];

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
      }

      // cave mushrooms: look for open pockets under the surface
      for (let kk = 2; kk < k - 2; kk++) {
        if (blocks[base + kk] === ID.air && CARVEABLE[blocks[base + kk - 1]]
          && rng() < 0.006) {
          blocks[base + kk] = ID.mushroom;
        }
      }
    }
  }
}
