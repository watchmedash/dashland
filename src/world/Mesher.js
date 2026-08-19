// Chunk mesher for the flat wrapped map.
//
// Every cell face is a quad on one of six world-axis directions, everywhere.
// There is no per-face basis, no tangent frame, no curved corner and no
// handedness question left to answer at runtime - the six windings are worked
// out once, below, and each one's normal falls out of its own vertex order.
//
// The one thing worth knowing before reading: THE MAP FRAME IS LEFT HANDED
// against world space. `Grid.js` fixes map x -> world X, map y -> world Z and
// layer k -> world Y, and X cross Z is MINUS Y, so a quad wound the obvious way
// round the map's (x, y) faces backwards. Each of the six orders below is
// therefore the mirror of what the (i, j) cube used, and the top and bottom caps
// carry u along the map's y with v along its x rather than the other way about.
// Getting that backwards renders half the world inside out, which is why it is
// spelled out here rather than inferred.
//
// Neighbour lookups WRAP. A chunk at x = 0 has neighbours at x = W - 1; treating
// the edge as empty would put a wall of faces round the map.

import { BIOME, BIOME_COLORS } from './Constants.js';
import { faceAt, worldOf } from './Grid.js';
import {
  W, D, CHUNK_T, CHUNK_K, cellCorner, stepColumn,
} from './Layout.js';
import {
  BLOCKS, N_BLOCKS, IS_OPAQUE, IS_LEAF, RENDER_TYPE, TILE_SIDE,
  TINT_ID, R_CROSS, R_LIQUID, R_GLASS, R_LADDER, R_TORCH, R_MODEL, SEALS_FACES,
  IS_DIRECTIONAL, IS_AXIS, IS_SLAB, IS_SHAPED,
  IS_SUBMERGED,
  FACING_DEFAULT, sideTile, capTile, axisOf, blockBoxes, IS_FENCE, fenceLinks,
  IS_STAIR, stairShape,
  TILES, TILE_INDEX,
} from './Blocks.js';

/**
 * Flow level of a full water source, mirroring Water.LEVEL_MAX. The side-table
 * byte a liquid cell carries is its flow level, and both ends of the range mean
 * "brim-full": 7 is a source the simulation placed, 0 is a cell it never touched
 * (worldgen's oceans and lakes).
 */
const LEVEL_SOURCE = 7;

/** Rime: the ice face. A leaf standing on it is snowed on all year. */
const FACE_RIME = 1;

/**
 * Quarter-turns of UV so a lying log's grain runs along its axis.
 *
 * `sideTile` already puts the rings on the two faces the trunk runs through and
 * bark on the other four, which is the half of the job you notice first. The
 * half you notice second is that the bark is *directional*: its grain runs up
 * the texture, so a log laid on its side kept vertical grain and read as an
 * upright log wearing the wrong end caps.
 *
 * Which faces need it falls out of the UV conventions and is not symmetric, and
 * the CAPS are inverted against the cube's version of this function. On a side
 * face u runs horizontally and v runs along +k, as before. On a cap, u now runs
 * along the map's y and v along its x - see the header - so a log along x
 * already has its grain along the cap's v and is the one that must be left
 * alone, where on the cube it was the one that turned.
 *
 * `dir` is 0:+x 1:-x 2:+y 3:-y 4:top 5:bottom.
 */
function grainRot(id, facing, dir) {
  const ax = axisOf(id, facing);
  if (!ax) return 0;
  if (ax === 1) return (dir === 2 || dir === 3) ? 1 : 0;
  return (dir === 0 || dir === 1 || dir >= 4) ? 1 : 0;
}

export const GROUP_OPAQUE = 0;
export const GROUP_CUTOUT = 1;
export const GROUP_TRANSPARENT = 2;
export const GROUP_LIQUID = 3;
/**
 * The divider, and it is its own pass because it is opaque and water is not.
 *
 * It rode in GROUP_LIQUID to borrow that material's swell, fresnel and
 * world-space sampling. It still borrows all three — `materials.portal` is the
 * same shader patch — but it no longer borrows `transparent`, `depthWrite:
 * false` and `DoubleSide` with them, which is what made a full-height wall
 * flicker as you turned. See the note beside `portal` in VoxelMaterial.js.
 */
export const GROUP_PORTAL = 4;
export const GROUP_COUNT = 5;

export const GROUP = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (b.render === R_LIQUID) GROUP[i] = GROUP_LIQUID;
  // The divider gets the liquid SHADER and an opaque BODY, which is what this
  // group is for: it is the one material in the game with a swell, a sky
  // fresnel and world-space sampling, and a wall wants all three — but a wall
  // is also solid, and blending one against itself with no depth is what the
  // owner saw as lines and glitches along it.
  //
  // It is NOT `render: R_LIQUID` — that is a simulation property (flow,
  // swimming, drowning, placement, the surface-height mesh path) and a divider
  // is none of those. Only the group moves, so the block is still meshed as a
  // full cube and still seals, occludes and blocks motion.
  else if (b.name === 'portal') GROUP[i] = GROUP_PORTAL;
  else if (b.render === R_CROSS) GROUP[i] = GROUP_CUTOUT;
  // A ladder is mostly holes. Drawn in the opaque group its alpha was simply
  // ignored, so the gaps between the rungs came out as solid timber.
  else if (b.render === R_LADDER) GROUP[i] = GROUP_CUTOUT;
  else if (b.render === R_GLASS) GROUP[i] = b.name.startsWith('leaves') ? GROUP_CUTOUT : GROUP_TRANSPARENT;
  else GROUP[i] = GROUP_OPAQUE;
}

/** Leaves. Sways in the wind, and LEAF_SNOW_FRAG whitens it in winter. */
const WAVE_LEAVES = 4;
/**
 * Leaves whose COLUMN is a snowfield, which is the same wave in every respect
 * the vertex shader cares about and a different one in the only respect the
 * fragment shader does: LEAF_SNOW_FRAG holds this one white all year instead of
 * only in winter.
 *
 * This exists because the ground a tree grew from is the one thing a leaf
 * fragment cannot work out for itself. It knows its own altitude, which is five
 * to twelve blocks above that ground, so an altitude gate whitens every
 * sea-level forest in July; it cannot know the biome either. The column knows,
 * the mesher is already holding the column, and the wave id is the one channel
 * that reaches the fragment with a whole integer to spare in it.
 *
 * BIOME.SNOW and not COLD_BIOMES, which would add TUNDRA. A snowfield's top
 * block is `ID.snow` for every column of it, so the ground under those trees is
 * white by construction. Tundra's is drifted, so it is a brown and white mottle
 * in July and a canopy laid solid white over it would be the inconsistency this
 * is trying to remove.
 */
const WAVE_LEAVES_COLD = 5;
/**
 * The divider. A liquid in everything the renderer does and a wall in
 * everything else — see GROUP below.
 *
 * Six, and the id is the whole of the risk in this feature. Every test on the
 * wave id in VoxelMaterial that was written open-ended ("> 3.5 is leaves",
 * "> 2.5 is lava") swallows a new id silently, which is exactly how a wave-id
 * collision once lit every leaf on the planet. Both of those are banded now and
 * this one is banded too; nothing in that file tests a wave id open-ended any
 * more.
 */
const WAVE_PORTAL = 6;

const WAVE = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (b.render === R_CROSS) WAVE[i] = 1;
  else if (b.name === 'water') WAVE[i] = 2;
  else if (b.name === 'lava') WAVE[i] = 3;
  else if (b.name === 'portal') WAVE[i] = WAVE_PORTAL;
  else if (b.name.startsWith('leaves')) WAVE[i] = WAVE_LEAVES;
}

/**
 * Cross blocks that are drawn as real geometry instead, and so must not also be
 * drawn as a billboard here.
 *
 * The flowers are modelled - `render/BlockModels.js` instances a WAM model at
 * every one near the player - and a cross quad is a full cell wide, so no model
 * small enough to be a flower can hide one. It is this or two of everything.
 *
 * Grass, saplings, mushrooms and wheat are *not* in this set and should stay
 * out of it: the billboard is the right answer for anything whose read is a
 * texture rather than a silhouette, and it is the only one that carries the
 * chunk's baked voxel light and the wind sway.
 */
const MODELLED_CROSS = new Uint8Array(N_BLOCKS);
// `sapling` sits here rather than with the flowers because it was the one
// block whose three pictures disagreed after the icon audit: it has a WAM
// model, so your fist, the ground drop and the inventory slot all showed it,
// while the planted block was still the mesher's tinted billboard.
for (const n of ['flower_red', 'flower_blue', 'flower_gold', 'mushroom', 'sapling',
  // The reef. Unlike the flowers these have no billboard to fall back on - they
  // were authored as models and carry no tile of their own - so this list and
  // `MODELLED_PLANTS` in `main.js` have to agree or the seabed is empty.
  'coral_branch', 'coral_fan', 'coral_brain', 'coral_dead',
  'kelp', 'sea_grass', 'sea_sponge', 'sea_shell',
  'sea_lettuce', 'sea_grape', 'abyss_anemone',
  // The land flora and the cave floor, on exactly the same footing: no tile, no
  // billboard, the model is all there is.
  'thornbrush', 'aloe', 'golden_grass', 'firebloom',
  'cotton_grass', 'snowbell', 'alpine_aster', 'marram',
  'lavender', 'clover', 'fern', 'lingonberry',
  'cave_mushroom', 'shelf_fungus', 'crystal_cluster', 'driftwood',
  'cactusfruit', 'agave', 'stonecrop', 'icecapmoss',
  // The gourd. It was an opaque cube until the produce model was wired to the
  // planted block; see its entry in Blocks.js, which is where the reasoning is.
  'pumpkin',
  'swampreed', 'mireroot', 'lotus', 'truffle',
  'deathcap',
  // The farm. Wheat stays out and keeps its billboard because it has four
  // authored tiles in the atlas; these seven have no tile at all. All four
  // stages of each, because a crop's stages are four separate block ids.
  'strawberry_0', 'strawberry_1', 'strawberry_2', 'strawberry_3',
  'squash_0', 'squash_1', 'squash_2', 'squash_3',
  'greenbean_0', 'greenbean_1', 'greenbean_2', 'greenbean_3',
  'snowpea_0', 'snowpea_1', 'snowpea_2', 'snowpea_3',
  'hops_0', 'hops_1', 'hops_2', 'hops_3',
  'grape_0', 'grape_1', 'grape_2', 'grape_3',
  'watermelon_0', 'watermelon_1', 'watermelon_2', 'watermelon_3']) {
  const i = BLOCKS.findIndex((b) => b.name === n);
  if (i > 0) MODELLED_CROSS[i] = 1;
}

const AO_CURVE = [0.36, 0.60, 0.80, 1.0];

// --- baked light for the modelled crosses ------------------------------------
//
// The blocks in MODELLED_CROSS are the ones this file deliberately does *not*
// emit geometry for, and losing the geometry lost the light with it: a modelled
// flower is an InstancedMesh built on the main thread, which holds `blocks` and
// nothing else, so it had no cell to sample and a flower beside a torch stayed
// unlit by it.
//
// It is reachable, because the sample is *right here*. So keep it: one word per
// modelled-cross cell, shipped alongside the geometry as a transferable.
//
// ### The word
//
//   bits  0.. 3  block light r   0..15
//   bits  4.. 7  block light g   0..15
//   bits  8..11  block light b   0..15
//   bits 12..15  skylight        0..15
//   bits 16..27  address within the chunk, ((dx * CHUNK_T) + dy) * CHUNK_K + dk
//
// 28 bits, so one Uint32 and no packing games. The address is chunk-*local* on
// purpose: a global cell index needs 27 bits on its own. A chunk is 16 x 16 x 11
// = 2816 cells, which is 12 bits, and the receiver already knows which chunk it
// is unpacking because the message says so.
//
// Entries come out sorted by address, for free, because the emit loop walks x
// then y then k ascending and the address is that same odometer. The main thread
// binary-searches it and relies on that; if this loop is ever reordered, sort.
//
// Modelled *blocks* (`R_MODEL`) ride the same buffer, for the same reason and
// with the same word. The only difference is where the sample is taken: a
// flower's own cell holds light and a workbench's cell is opaque and holds none,
// so a modelled block samples its brightest neighbour instead.
export const CROSS_LIGHT_ADDR_SHIFT = 16;

/**
 * Unpack one word's block light into `out` as three 0..1 floats.
 *
 * Block light only; the skylight nibble is `crossSky`. They are separate calls
 * because they are separate quantities that land in different places in the
 * shader - this one is added to the block-light term, that one scales the
 * scene's indirect light - and every caller of this one hands in a length-3
 * array.
 */
export function crossLightRGB(w, out) {
  out[0] = (w & 15) / 15;
  out[1] = ((w >>> 4) & 15) / 15;
  out[2] = ((w >>> 8) & 15) / 15;
  return out;
}

/**
 * Unpack one word's skylight as a 0..1 float: how much sky reaches this cell.
 *
 * This used to be shipped and thrown away, on the grounds that a modelled
 * flower already got the sun through the shadow map *and* through the entity
 * fill, which `Sky` dimmed by the **player's** sky exposure - so consuming it
 * here would have counted the sky a third time.
 *
 * That fill is no longer global. A mob and a dropped item each probe the sky
 * over themselves now (`Drops._probeSky`), and a planted flower was left as the
 * one entity in the world with no answer of its own: measured at noon, a
 * mushroom under three layers of stone read 3% darker than one in the open
 * while the dropped one beside it read 16%. This nibble is the sample it was
 * missing, and it was already in the word.
 */
export function crossSky(w) {
  return ((w >>> 12) & 15) / 15;
}

/**
 * Growable Uint32 list, allocated lazily so a chunk with no flowers in it -
 * which is nearly all of them, including every chunk of solid rock - pays
 * nothing at all, not even an empty typed array.
 */
class CrossLightBuf {
  constructor() { this.data = null; this.len = 0; }
  push(w) {
    if (!this.data) this.data = new Uint32Array(32);
    else if (this.len === this.data.length) {
      const d = new Uint32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.len++] = w;
  }
  out() { return this.len ? this.data.slice(0, this.len) : null; }
}

// --- growable buffers -------------------------------------------------------

class Buf {
  constructor(stride) { this.data = new Float32Array(2048 * stride); this.len = 0; }
  reset() { this.len = 0; }
  need(n) {
    if (this.len + n <= this.data.length) return;
    let cap = this.data.length || 1024;
    while (cap < this.len + n) cap *= 2;
    const d = new Float32Array(cap); d.set(this.data.subarray(0, this.len)); this.data = d;
  }
  push2(a, b) { this.need(2); const d = this.data; d[this.len++] = a; d[this.len++] = b; }
  push3(a, b, c) { this.need(3); const d = this.data; d[this.len++] = a; d[this.len++] = b; d[this.len++] = c; }
  push4(a, b, c, e) { this.need(4); const d = this.data; d[this.len++] = a; d[this.len++] = b; d[this.len++] = c; d[this.len++] = e; }
  out() { return this.data.slice(0, this.len); }
}

class IBuf {
  constructor() { this.data = new Uint32Array(4096); this.len = 0; }
  reset() { this.len = 0; }
  quad(v) {
    if (this.len + 6 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2); d.set(this.data); this.data = d;
    }
    const d = this.data;
    d[this.len++] = v; d[this.len++] = v + 1; d[this.len++] = v + 2;
    d[this.len++] = v; d[this.len++] = v + 2; d[this.len++] = v + 3;
  }
  out() { return this.data.slice(0, this.len); }
}

class Group {
  constructor() {
    this.pos = new Buf(3); this.nrm = new Buf(3); this.tan = new Buf(3);
    this.uv = new Buf(2); this.aux = new Buf(4); this.blk = new Buf(3); this.tint = new Buf(3);
    // How far this quad's uv runs, so a fragment can tell where its own quad
    // begins and ends. See the note beside `quadSize` in `emit`.
    this.qsz = new Buf(2);
    this.idxb = new IBuf(); this.verts = 0;
  }
  reset() {
    this.pos.reset(); this.nrm.reset(); this.tan.reset(); this.uv.reset();
    this.aux.reset(); this.blk.reset(); this.tint.reset(); this.qsz.reset();
    this.idxb.reset(); this.verts = 0;
  }
  get empty() { return this.verts === 0; }
  serialize() {
    return {
      position: this.pos.out(), normal: this.nrm.out(), tangent: this.tan.out(),
      uv: this.uv.out(), aux: this.aux.out(), blockLight: this.blk.out(),
      tint: this.tint.out(), quadSize: this.qsz.out(), index: this.idxb.out(),
    };
  }
}

/**
 * The four groups, allocated once and reused by every `meshChunk` call.
 *
 * A fresh `Group` costs 2048 entries per stride however small the chunk turns
 * out to be - about 205 KB, and `meshChunk` was building four of them on entry
 * and dropping all four on exit. A first load meshes thousands of chunks, so
 * that was gigabytes allocated, zeroed by the VM and handed straight back.
 * Measured in the worker's own profile it was 438 ms in the `Buf` constructor
 * and 217 ms in the garbage collector against 7.5 s of total worker CPU.
 *
 * Reuse is safe because nothing a group holds outlives the call: `out()` is
 * `data.slice`, a copy, so every array that leaves in the payload is already a
 * fresh allocation and none of them alias the pool. The one thing to keep true
 * is that `meshChunk` must not overlap itself, and it is a straight-line
 * synchronous function in a single-threaded worker with no await in it.
 */
const _pool = [];

// --- helpers ----------------------------------------------------------------

/**
 * For liquids the tint attribute is repurposed: x carries normalised water
 * depth, y a shoreline flag, and z the body of water's identity - a marsh, a
 * tarn, a hot spring, a waterfall or the ocean.
 */
function tintOf(id, biomeId) {
  const t = TINT_ID[id];
  if (!t) return [1, 1, 1];
  const c = BIOME_COLORS[biomeId] || BIOME_COLORS[2];
  if (t === 1) return c.grass;
  if (t === 2) return c.foliage;
  // Pine needles: cooler and a touch deeper than broadleaf foliage. This used
  // to multiply the biome colour by (0.72, 0.82, 0.78), which stacked on top of
  // an already very dark pine tile and turned whole conifers black.
  if (t === 3) { const f = c.foliage; return [f[0] * 0.90, f[1] * 0.98, f[2] * 0.93]; }
  return [c.foliage[0] * 0.9, c.foliage[1] * 1.0, c.foliage[2] * 0.85];
}

/**
 * Layers that must never take a block's biome tint, whatever block they land on.
 *
 * The tint is a property of the *block* and multiplies every fragment of it, so
 * a grass block's bottom face - which is the plain `dirt` tile - came out
 * multiplied by the biome grass colour. Measured in a plains biome the same soil
 * rendered 140/102/70 on a dirt block and 77/80/28 on the grass block beside it.
 *
 * Only whole faces can be settled here; the side face is soil and foliage in one
 * tile and is masked per texel instead.
 */
const WHITE = [1, 1, 1];
const UNTINTED_LAYER = new Uint8Array(TILES.length);
for (const t of ['dirt']) UNTINTED_LAYER[TILE_INDEX[t]] = 1;

function faceVisible(a, b) {
  if (a === 0) return false;
  // `SEALS_FACES` and not `IS_OPAQUE`, and the difference is one class of block:
  // a modelled one is opaque to the light and draws no triangles, so there is
  // nothing there to hide this face behind.
  if (SEALS_FACES[b]) return false;
  const ga = GROUP[a];
  // "Fast leaves": a face between two leaf blocks is never seen, only its own
  // dark interior, so a canopy used to read as a stack of hollow crates.
  if (IS_LEAF[a] && IS_LEAF[b]) return false;
  if (ga === GROUP_TRANSPARENT && b === a) return false;
  // `b === a`, like the line above it. Testing only the *group* culled the face
  // between water and lava as well, and those two genuinely do end up touching.
  if (ga === GROUP_LIQUID && GROUP[b] === GROUP_LIQUID && b === a) return false;
  // Reef life is *inside* the water, so the water has no face there either.
  // Without this every coral is a cell-sized bubble and a kelp stalk is a
  // chimney of it. One-way on purpose: the plant is a cross block and never
  // reaches this test at all.
  if (ga === GROUP_LIQUID && IS_SUBMERGED[b]) return false;
  return true;
}

const _c0 = [0, 0, 0], _c1 = [0, 0, 0], _c2 = [0, 0, 0], _c3 = [0, 0, 0];
const _cc = { x: 0, y: 0, z: 0 };
const _n = [0, 0, 0], _t = [0, 0, 0];

/**
 * Mesh one chunk.
 * @param {Uint8Array} blocks  `blocks[col * D + k]`
 * @param {Uint8Array} colBiome  per-column biome
 * @param {Uint8Array} colWater  per-column water identity
 * @param {{sun,r,g,b}} light
 * @param {Map<number,number>} facing sparse cell index -> facing 0..3
 * @param {number} cx chunk coordinate on the map's x
 * @param {number} cy chunk coordinate on the map's y
 * @param {number} ck chunk coordinate on the layer axis
 * @returns {{groups: Array, crossLight: Uint32Array|null}}
 */
export function meshChunk(blocks, colBiome, colWater, light, facing, cx, cy, ck) {
  const groups = _pool;
  for (let g = 0; g < GROUP_COUNT; g++) {
    if (groups[g]) groups[g].reset(); else groups[g] = new Group();
  }
  const crossLight = new CrossLightBuf();
  const x0 = cx * CHUNK_T, y0 = cy * CHUNK_T, kBase = ck * CHUNK_K;
  const x1 = x0 + CHUNK_T, y1 = y0 + CHUNK_T, k1 = Math.min(D, kBase + CHUNK_K);
  const { sun, r: lr, g: lg, b: lb } = light;

  // A cell's block id. Storage is `col * D + k`, so this is the whole of it -
  // no COL_BASE, no COL_STEP and no sign that depends on which face you are on.
  const at = (col, k) => (k < 0 || k >= D ? 0 : blocks[col * D + k]);
  // Ambient occlusion, and only ambient occlusion: does the cell next door have
  // geometry in it that would shade this corner? `SEALS_FACES` rather than
  // `IS_OPAQUE` because a modelled block has no geometry to shade with.
  const sealsAt = (col, k) => (k < 0 || k >= D ? 0 : SEALS_FACES[blocks[col * D + k]]);

  /** Smooth light at a corner shared by up to 4 open cells. */
  const cornerLight = (cols, ks, outv) => {
    let s = 0, r = 0, g = 0, b = 0, n = 0;
    for (let q = 0; q < 4; q++) {
      const c = cols[q], k = ks[q];
      if (k < 0 || k >= D) { s += 15; n++; continue; }
      const vi = c * D + k;
      if (IS_OPAQUE[blocks[vi]]) continue;
      s += sun[vi]; r += lr[vi]; g += lg[vi]; b += lb[vi]; n++;
    }
    if (!n) n = 1;
    outv[0] = s / n / 15; outv[1] = r / n / 15; outv[2] = g / n / 15; outv[3] = b / n / 15;
  };

  const ao = (s1, s2, sc) => ((s1 && s2) ? 0 : 3 - (s1 + s2 + sc));

  const lv = [0, 0, 0, 0];
  const cornerData = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const aoData = [0, 0, 0, 0];
  /**
   * Per-corner surface height, as a fraction of the cell; 1 for everything but
   * water. Indexed by CORNER IDENTITY and not by vertex order:
   *
   *   0 = (x, y)   1 = (x+1, y)   2 = (x+1, y+1)   3 = (x, y+1)
   *
   * The six faces below each pick the two or four of these they touch. Keeping
   * one identity per map corner is what guarantees no seam - every quantity here
   * is a function of the corner and the level and nothing else, so two faces
   * meeting at a corner always compute the same number.
   */
  const cornerTop = [1, 1, 1, 1];
  /**
   * How much of the wave a liquid vertex takes, per corner: 1 on the free
   * surface, 0 on the bed and everywhere inside the body.
   *
   * The shader used to displace every water vertex equally, which moved the
   * whole body of water through the terrain instead of rippling the top of it.
   * Hi is the corner at the cell's brim (level k+1), Lo the one at its floor.
   */
  const cornerWaveHi = [0, 0, 0, 0], cornerWaveLo = [0, 0, 0, 0];
  const cornerCols = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  // Per-vertex wave amount for the quad being emitted, and whether to use it.
  const waveAmt = [1, 1, 1, 1];
  let useWaveAmt = false;
  /**
   * How much cell a liquid surface needs above the floor before it takes the
   * full sink. The shader's swell bottoms out 0.16 of a cell below the brim, so
   * a film of flowing water thinner than that would be pushed through its own
   * floor and z-fight the block underneath.
   */
  const WAVE_HEADROOM = 0.2;
  let liquidDepth = 0, liquidShore = 0, liquidStyle = 0;
  /** Whether the column being meshed stands on the ice face. See `emit`. */
  let _rime = false;
  // per-corner water depth, so the shallow-to-deep gradient and the foam band
  // interpolate across the surface instead of stepping block by block
  const liquidCorner = [0, 0, 0, 0];
  /**
   * Per-corner shoreline. The depth has been per corner for a while; the shore
   * flag stayed per CELL, so the foam rim could only ever be a set of whole-block
   * rectangles. The fraction of the corner's four columns that are land, doubled
   * and clamped, so a corner *on* a straight waterline still reads a full 1 and
   * the foam keeps the strength it was tuned at, while the far corner of the same
   * quad reads 0 and the rim fades out across the block.
   */
  const liquidCornerShore = [0, 0, 0, 0];
  let useCornerDepth = false;

  /**
   * Height of the liquid surface inside cell (c, k), as a fraction of the cell.
   * A source is brim-full; each step the flow loses drops it a little further.
   * Level 0 means "unmarked" - worldgen's oceans and lakes - which are sources.
   */
  const liquidTop = (c, k) => {
    const lvl = facing?.get(c * D + k) ?? 0;
    if (lvl === 0 || lvl === LEVEL_SOURCE) return 1;
    // Minecraft's ramp: the tail of a flow is a film, not a half block.
    return (lvl + 1) / 9;
  };

  /**
   * Surface height at one corner of a liquid top face, averaged over the up-to-4
   * cells meeting there.
   *
   * Averaging rather than using the cell's own height is not cosmetic: faces
   * between two liquid cells are culled, so neighbouring cells at different flow
   * levels have no wall between them. Flat per-cell tops would leave a gap at
   * every step down and you would see straight into the water body through it.
   *
   * Liquid directly above means this cell is submerged, not a surface, so the
   * corner goes to the brim and meets the column above without a seam.
   */
  const liquidCornerTop = (cols4, k) => {
    let sum = 0, n = 0;
    for (let q = 0; q < 4; q++) {
      const c = cols4[q];
      if (RENDER_TYPE[at(c, k)] !== R_LIQUID) continue;
      if (RENDER_TYPE[at(c, k + 1)] === R_LIQUID) return 1;
      sum += liquidTop(c, k); n++;
    }
    return n ? sum / n : 1;
  };

  /**
   * How much of the free surface a corner is, at boundary level L.
   *
   * A vertex is on the free surface where there is liquid immediately below it
   * and something that is not liquid immediately above: that is the face the
   * wind acts on. A fraction rather than a flag on purpose - where a flowing
   * surface steps down, one column is open above the level and its neighbour is
   * not, and a flag would move one of the two quads meeting there and not the
   * other.
   */
  const liquidCornerWave = (cols4, L) => {
    let below = 0, open = 0;
    for (let q = 0; q < 4; q++) {
      const c = cols4[q];
      if (RENDER_TYPE[at(c, L - 1)] !== R_LIQUID) continue;
      below++;
      if (RENDER_TYPE[at(c, L)] !== R_LIQUID) open++;
    }
    return below ? open / below : 0;
  };

  /** How many liquid layers sit at and below (col, k). 0 if not liquid. */
  const depthOf = (c, k) => {
    if (RENDER_TYPE[at(c, k)] !== R_LIQUID) return 0;
    let d = 0;
    while (d < 20 && RENDER_TYPE[at(c, k - d)] === R_LIQUID) d++;
    return d;
  };

  /**
   * Emit an axis-aligned box that occupies part of one cell.
   *
   * Slabs got by with a single adjusted extent threaded through the existing
   * six-face code. A stair is two boxes, and hand-writing another pair of face
   * blocks for it would be the third copy of the same thing.
   *
   * Light and AO come from the cell, not the box: they do not vary within a cell.
   * `skip` names faces to leave out - the seam where a stair's two boxes meet is
   * interior and must not be drawn, or it z-fights with itself.
   *
   * Windings match the six full-cell faces below, mirrored for the left-handed
   * map frame; see the file header.
   *
   * @param {number[]} lo  [x, y, k] box corner within the cell, each 0..1
   * @param {number[]} hi  opposite corner
   * @param {object}   skip {pi, mi, pj, mj, up, dn} truthy to omit that face
   */
  const emitBox = (g, id, biomeId, x, y, k, lo, hi, dirF, skip, allCap) => {
    const [a0, b0, c0] = lo, [a1, b1, c1] = hi;
    // A box may ask for its cap tile on every face - see the torch head in
    // blockBoxes. Without it the flame only ever faces the sky.
    const side = allCap ? () => capTile(id, dirF, true)
      : (dir) => sideTile(id, dir, dirF);
    if (!skip.up) {
      emit(g, id, capTile(id, dirF, true), biomeId,
        cellCorner(x + a0, y + b0, k + c1, _c0), cellCorner(x + a0, y + b1, k + c1, _c1),
        cellCorner(x + a1, y + b1, k + c1, _c2), cellCorner(x + a1, y + b0, k + c1, _c3),
        b1 - b0, a1 - a0);
    }
    if (!skip.dn) {
      emit(g, id, capTile(id, dirF, false), biomeId,
        cellCorner(x + a0, y + b1, k + c0, _c0), cellCorner(x + a0, y + b0, k + c0, _c1),
        cellCorner(x + a1, y + b0, k + c0, _c2), cellCorner(x + a1, y + b1, k + c0, _c3),
        b1 - b0, a1 - a0);
    }
    if (!skip.pi) {
      emit(g, id, side(0), biomeId,
        cellCorner(x + a1, y + b1, k + c0, _c0), cellCorner(x + a1, y + b0, k + c0, _c1),
        cellCorner(x + a1, y + b0, k + c1, _c2), cellCorner(x + a1, y + b1, k + c1, _c3),
        b1 - b0, c1 - c0);
    }
    if (!skip.mi) {
      emit(g, id, side(1), biomeId,
        cellCorner(x + a0, y + b0, k + c0, _c0), cellCorner(x + a0, y + b1, k + c0, _c1),
        cellCorner(x + a0, y + b1, k + c1, _c2), cellCorner(x + a0, y + b0, k + c1, _c3),
        b1 - b0, c1 - c0);
    }
    if (!skip.pj) {
      emit(g, id, side(2), biomeId,
        cellCorner(x + a0, y + b1, k + c0, _c0), cellCorner(x + a1, y + b1, k + c0, _c1),
        cellCorner(x + a1, y + b1, k + c1, _c2), cellCorner(x + a0, y + b1, k + c1, _c3),
        a1 - a0, c1 - c0);
    }
    if (!skip.mj) {
      emit(g, id, side(3), biomeId,
        cellCorner(x + a1, y + b0, k + c0, _c0), cellCorner(x + a0, y + b0, k + c0, _c1),
        cellCorner(x + a0, y + b0, k + c1, _c2), cellCorner(x + a1, y + b0, k + c1, _c3),
        a1 - a0, c1 - c0);
    }
  };

  const emit = (g, id, layer, biomeId, p0, p1, p2, p3, uMax, vMax, uvRot = 0) => {
    // normal & tangent from the actual quad
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    _n[0] = ay * bz - az * by; _n[1] = az * bx - ax * bz; _n[2] = ax * by - ay * bx;
    const nl = Math.hypot(_n[0], _n[1], _n[2]) || 1;
    _n[0] /= nl; _n[1] /= nl; _n[2] /= nl;
    const al = Math.hypot(ax, ay, az) || 1;
    _t[0] = ax / al; _t[1] = ay / al; _t[2] = az / al;

    const tint = GROUP[id] === GROUP_LIQUID
      ? [liquidDepth, liquidShore, liquidStyle]
      : (UNTINTED_LAYER[layer] ? WHITE : tintOf(id, biomeId));
    // A leaf standing over a snowfield gets its own wave id, so the shader can
    // keep it under snow in July as well as in December. `biomeId` is the
    // column's, already resolved for the tint, so this costs one compare on the
    // quads of one block class. `_rime` is the same test the cube spelled as
    // FACE_ROLE[f] === FACE_POLAR: the ice face is white by construction, so a
    // stand of pines with some trunks over snow and some over ice does not get
    // its canopy split between two waves.
    const wave = (WAVE[id] === WAVE_LEAVES && (biomeId === BIOME.SNOW || _rime))
      ? WAVE_LEAVES_COLD : WAVE[id];
    const uv = [[0, 0], [uMax, 0], [uMax, vMax], [0, vMax]];
    const pts = [p0, p1, p2, p3];
    const v0 = g.verts;
    for (let c = 0; c < 4; c++) {
      g.pos.push3(pts[c][0], pts[c][1], pts[c][2]);
      g.nrm.push3(_n[0], _n[1], _n[2]);
      g.tan.push3(_t[0], _t[1], _t[2]);
      g.uv.push2(uv[(c + uvRot) & 3][0], uv[(c + uvRot) & 3][1]);
      // The quad's own uv extent, carried per vertex because a fragment cannot
      // recover it: `uv` runs 0..uMax by 0..vMax, and those are whole numbers
      // for a full cell face but a FRACTION for a shaped block. The mining crack
      // overlay is the only consumer - see BREAK_FRAG. Without it a slab's side
      // face drew half the pattern with its centre on the top edge.
      g.qsz.push2(uMax, vMax);
      // The fraction of aux.w is how much of the wave this vertex takes and the
      // integer part is which wave it is, so the amount is scaled by 0.99 and
      // never reaches 1: a full-strength water vertex at 3.0 would floor to 3
      // and come out as lava.
      g.aux.push4(layer, AO_CURVE[aoData[c]], cornerData[c][0],
        wave === 0 ? 0 : wave + (useWaveAmt ? waveAmt[c] * 0.99 : 0.99));
      g.blk.push3(cornerData[c][1], cornerData[c][2], cornerData[c][3]);
      if (useCornerDepth) g.tint.push3(liquidCorner[c], liquidCornerShore[c], tint[2]);
      else g.tint.push3(tint[0], tint[1], tint[2]);
    }
    g.idxb.quad(v0);
    g.verts += 4;
    useCornerDepth = false;
    useWaveAmt = false;
  };

  /** Load the four per-vertex wave amounts for the quad about to be emitted. */
  const setWave = (a, b, c, d) => {
    waveAmt[0] = a; waveAmt[1] = b; waveAmt[2] = c; waveAmt[3] = d;
    useWaveAmt = true;
  };

  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const col = x * W + y;
      const biomeId = colBiome[col];
      _rime = faceAt(x, y) === FACE_RIME;
      // Neighbour columns, resolved once per column. WRAPPED: a column on the
      // map's edge has real neighbours on the other side of it, and treating the
      // edge as empty would ring the world in a wall of faces.
      const nPx = stepColumn(col, 1, 0), nMx = stepColumn(col, -1, 0);
      const nPy = stepColumn(col, 0, 1), nMy = stepColumn(col, 0, -1);
      // diagonals for AO
      const nPxPy = stepColumn(nPx, 0, 1), nPxMy = stepColumn(nPx, 0, -1);
      const nMxPy = stepColumn(nMx, 0, 1), nMxMy = stepColumn(nMx, 0, -1);

      for (let k = kBase; k < k1; k++) {
        const id = blocks[col * D + k];
        if (id === 0) continue;
        const rt = RENDER_TYPE[id];
        if (rt === R_CROSS) {
          if (!MODELLED_CROSS[id]) emitCross(groups[GROUP_CUTOUT], x, y, k, col, id, biomeId, light);
          // ...and if it *is* modelled, keep the light sample the billboard would
          // have baked in. This is the only line in the whole mesh loop that a
          // non-flower cell can reach and it is inside a branch that already
          // ended in `continue`.
          else {
            const vi = col * D + k;
            crossLight.push(
              (((x - x0) * CHUNK_T + (y - y0)) * CHUNK_K + (k - kBase)) << CROSS_LIGHT_ADDR_SHIFT
              | (sun[vi] & 15) << 12 | (lb[vi] & 15) << 8 | (lg[vi] & 15) << 4 | (lr[vi] & 15),
            );
          }
          continue;
        }
        const grp = groups[GROUP[id]];
        // The side-table carries a different meaning per block: a horizontal
        // facing for a kiln, an axis for a log. -1 for the overwhelming majority
        // of cells, so no Map lookup at all.
        const dirF = IS_DIRECTIONAL[id]
          ? (facing?.get(col * D + k) ?? FACING_DEFAULT)
          : (IS_AXIS[id] ? (facing?.get(col * D + k) ?? 0) : -1);

        // water depth + shoreline, handed to the liquid shader via `tint`
        if (rt === R_LIQUID) {
          let d = 0;
          while (d < 20 && RENDER_TYPE[at(col, k - d)] === R_LIQUID) d++;
          liquidDepth = Math.min(1, d / 7);
          liquidShore = (IS_OPAQUE[at(nPx, k)] || IS_OPAQUE[at(nMx, k)]
            || IS_OPAQUE[at(nPy, k)] || IS_OPAQUE[at(nMy, k)]) ? 1 : 0;
          // Per column, not per cell, so every quad of one body of water agrees
          // and there is no seam down the middle of a lake.
          liquidStyle = colWater ? colWater[col] : 0;
        } else if (GROUP[id] === GROUP_LIQUID) {
          // The divider: in the liquid group without being a liquid, so `emit`
          // will send the three liquid channels for it. They mean nothing here
          // and the shader's portal branch reads none of them - but left alone
          // they would carry whatever the last water cell in this chunk wrote,
          // which is a per-chunk value on a wall that runs across the map.
          liquidDepth = 0; liquidShore = 0; liquidStyle = 0;
        }

        // A torch is drawn as its own model, close to the player, by BlockModels.
        // Emitting the boxes as well would put a brown post inside the flame.
        // Everything else about a torch still comes from the voxel.
        if (rt === R_TORCH) continue;
        /**
         * A modelled block: no geometry at all, and its light kept for the model
         * that will stand here.
         *
         * The sample is the **brightest of the six neighbours**, not the cell
         * itself, and that is forced rather than chosen. A modelled block is
         * opaque, so the light solver never propagates into its cell and every
         * channel there reads 0 - sample it and every workbench on the planet is
         * a black bench. Brightest rather than an average because the question
         * this answers is "is there a torch on this bench", and an average would
         * divide that light by six and read as unlit.
         */
        if (rt === R_MODEL) {
          let ms = 0, mr = 0, mg = 0, mb = 0;
          for (let n = 0; n < 6; n++) {
            const nc = n === 0 ? nPx : n === 1 ? nMx : n === 2 ? nPy : n === 3 ? nMy : col;
            const nk = n === 4 ? k + 1 : n === 5 ? k - 1 : k;
            if (nk < 0 || nk >= D) continue;
            const vn = nc * D + nk;
            if (IS_OPAQUE[blocks[vn]]) continue;
            if (sun[vn] > ms) ms = sun[vn];
            if (lr[vn] > mr) mr = lr[vn];
            if (lg[vn] > mg) mg = lg[vn];
            if (lb[vn] > mb) mb = lb[vn];
          }
          crossLight.push(
            (((x - x0) * CHUNK_T + (y - y0)) * CHUNK_K + (k - kBase)) << CROSS_LIGHT_ADDR_SHIFT
            | (ms & 15) << 12 | (mb & 15) << 8 | (mg & 15) << 4 | (mr & 15),
          );
          continue;
        }
        if (IS_SHAPED[id]) {
          // 0x7FF: the low three bits are the facing every shape reads, and
          // bits 3..10 are the second slab a cell may be holding. Masking to 7
          // here would draw the cell as a single half and leave the other one
          // stored, invisible and solid.
          const byte = (facing?.get(col * D + k) ?? 0) & 0x7FF;
          // A fence has no stored orientation: its shape is its neighbours, and
          // those are already resolved for this column.
          // A fence has no stored orientation: its shape is its neighbours, and
          // those are already resolved for this column. A stair has a stored
          // facing AND a neighbour-read corner, and the corner rides the same
          // argument - see `stairShape`.
          const nbCols = [nPx, nMx, nPy, nMy];
          const links = IS_FENCE[id]
            ? fenceLinks(at(nPx, k), at(nMx, k), at(nPy, k), at(nMy, k))
            : IS_STAIR[id]
              ? stairShape(byte, (d) => [at(nbCols[d], k),
                (facing?.get(nbCols[d] * D + k) ?? 0) & 7])
              : 0;
          const boxes = blockBoxes(id, byte, links);
          // Light comes from the cell: a shaped block sits in open air by
          // definition. Occlusion cannot be left flat, though - a slab rendered
          // at a constant 3 reads as cardboard laid on a shaded floor - so this
          // darkens the whole block by how boxed-in its cell is.
          let walled = 0;
          if (SEALS_FACES[at(nPx, k)]) walled++;
          if (SEALS_FACES[at(nMx, k)]) walled++;
          if (SEALS_FACES[at(nPy, k)]) walled++;
          if (SEALS_FACES[at(nMy, k)]) walled++;
          if (SEALS_FACES[at(col, k - 1)]) walled++;
          const shade = Math.max(0, 3 - (walled >> 1));
          cornerLight([col, col, col, col], [k, k, k, k], lv);
          for (let c = 0; c < 4; c++) {
            aoData[c] = shade;
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1];
            cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          }
          for (let b = 0; b < boxes.length; b++) {
            const [bi0, bj0, bk0, bi1, bj1, bk1] = boxes[b];
            const skip = {};
            // Drop a face only where another box of the same block covers the
            // WHOLE of it. Touching used to be enough, and touching is not the
            // same question: a rail laid against a fence post covered 13.7% of
            // that face and took away 100% of it, so a post in the middle of a
            // run lost both its x faces and you looked straight through the
            // timber. A stair had the same hole at 50%.
            //
            // Coverage is tested per box rather than against the union, so a
            // face buried by two boxes that neither covers alone is drawn and
            // hidden rather than dropped. That is the safe way round - the cost
            // is a quad, the alternative is a hole.
            for (let o = 0; o < boxes.length; o++) {
              if (o === b) continue;
              const [oi0, oj0, ok0, oi1, oj1, ok1] = boxes[o];
              const iIn = oi0 <= bi0 && oi1 >= bi1;
              const jIn = oj0 <= bj0 && oj1 >= bj1;
              const kIn = ok0 <= bk0 && ok1 >= bk1;
              if (jIn && kIn && bi1 === oi0) skip.pi = 1;
              if (jIn && kIn && bi0 === oi1) skip.mi = 1;
              if (iIn && kIn && bj1 === oj0) skip.pj = 1;
              if (iIn && kIn && bj0 === oj1) skip.mj = 1;
              if (iIn && jIn && bk1 === ok0) skip.up = 1;
              if (iIn && jIn && bk0 === ok1) skip.dn = 1;
            }
            // A face flush with the cell wall can still be hidden by a solid
            // neighbour, exactly as a full cube's would be.
            if (bi1 === 1 && SEALS_FACES[at(nPx, k)]) skip.pi = 1;
            if (bi0 === 0 && SEALS_FACES[at(nMx, k)]) skip.mi = 1;
            if (bj1 === 1 && SEALS_FACES[at(nPy, k)]) skip.pj = 1;
            if (bj0 === 0 && SEALS_FACES[at(nMy, k)]) skip.mj = 1;
            if (bk1 === 1 && SEALS_FACES[at(col, k + 1)]) skip.up = 1;
            if (bk0 === 0 && SEALS_FACES[at(col, k - 1)]) skip.dn = 1;
            // A box may name its own block to be drawn as, and exactly one
            // thing uses it: the second half of a cell holding two different
            // slabs. It takes that block's tiles AND that block's draw group,
            // so an oak slab under a glass one comes out timber under glass.
            const bid = boxes[b][7] || id;
            emitBox(bid === id ? grp : groups[GROUP[bid]], bid, biomeId, x, y, k,
              [bi0, bj0, bk0], [bi1, bj1, bk1], -1, skip, boxes[b][6]);
          }
          continue;
        }

        const slabUp = 0;
        const cellLo = 0;

        if (rt === R_LIQUID) {
          // The four columns meeting at each corner, in corner-identity order.
          const cc = cornerCols;
          cc[0][0] = col; cc[0][1] = nMx; cc[0][2] = nMy; cc[0][3] = nMxMy;
          cc[1][0] = col; cc[1][1] = nPx; cc[1][2] = nMy; cc[1][3] = nPxMy;
          cc[2][0] = col; cc[2][1] = nPx; cc[2][2] = nPy; cc[2][3] = nPxPy;
          cc[3][0] = col; cc[3][1] = nMx; cc[3][2] = nPy; cc[3][3] = nMxPy;
          for (let c = 0; c < 4; c++) {
            cornerTop[c] = liquidCornerTop(cc[c], k);
            cornerWaveHi[c] = liquidCornerWave(cc[c], k + 1)
              * Math.min(1, cornerTop[c] / WAVE_HEADROOM);
            cornerWaveLo[c] = liquidCornerWave(cc[c], k);
          }
        } else {
          const t = IS_SLAB[id] ? (slabUp ? 1 : 0.5) : 1;
          cornerTop[0] = t; cornerTop[1] = t; cornerTop[2] = t; cornerTop[3] = t;
        }

        // A flow that does not reach the brim has a real surface even with a
        // solid block resting on top of it - there is air in the gap - so the
        // ordinary visibility test would lose its top face entirely and the flow
        // would simply not be there to look at. A lower slab has the same problem
        // for the same reason.
        const openSurface = (rt === R_LIQUID
          && (cornerTop[0] < 1 || cornerTop[1] < 1 || cornerTop[2] < 1 || cornerTop[3] < 1))
          || (IS_SLAB[id] && !slabUp);

        // ---- up (+Y) ----
        // Vertex order (x,y) (x,y+1) (x+1,y+1) (x+1,y), i.e. corners 0 3 2 1.
        if (faceVisible(id, at(col, k + 1)) || openSurface) {
          // kk stays an integer: it addresses cells for the light and occlusion
          // lookups. Only the emitted corner heights are lowered. Sampling the
          // layer above would be right for an ordinary top face, but a surface
          // roofed by a solid block would then read its light from inside that
          // block - every lookup opaque, so the water came out pure black.
          const kk = ((openSurface && IS_OPAQUE[at(col, k + 1)]) || (IS_SLAB[id] && !slabUp))
            ? k : k + 1;
          const cols = [
            [col, nMx, nMy, nMxMy], [col, nMx, nPy, nMxPy],
            [col, nPx, nPy, nPxPy], [col, nPx, nMy, nPxMy],
          ];
          const corner = [0, 3, 2, 1];
          for (let c = 0; c < 4; c++) {
            const s1 = sealsAt(cols[c][1], kk), s2 = sealsAt(cols[c][2], kk), sc = sealsAt(cols[c][3], kk);
            aoData[c] = ao(s1, s2, sc);
            cornerLight(cols[c], [kk, kk, kk, kk], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          }
          if (rt === R_LIQUID) {
            useCornerDepth = true;
            for (let c = 0; c < 4; c++) {
              let sum = 0, land = 0;
              for (let q = 0; q < 4; q++) {
                sum += depthOf(cols[c][q], k);
                // The corner's own layer, which is the layer the foam is drawn
                // in. Not k+1: a bank one block proud of the water would then
                // count as land for a corner the water does not actually touch.
                if (IS_OPAQUE[at(cols[c][q], k)]) land++;
              }
              // Deliberately /6 while the per-cell value on the sides is /7. The
              // two have disagreed since corner depth was added; left alone
              // because every dScale in LIQUID_MAP_FRAG was tuned by
              // photographing surfaces that came through this line.
              liquidCorner[c] = Math.min(1, (sum / 4) / 6);
              liquidCornerShore[c] = Math.min(1, land / 2);
            }
            setWave(cornerWaveHi[0], cornerWaveHi[3], cornerWaveHi[2], cornerWaveHi[1]);
          }
          emit(grp, id, capTile(id, dirF, true), biomeId,
            cellCorner(x, y, k + cornerTop[corner[0]], _c0),
            cellCorner(x, y + 1, k + cornerTop[corner[1]], _c1),
            cellCorner(x + 1, y + 1, k + cornerTop[corner[2]], _c2),
            cellCorner(x + 1, y, k + cornerTop[corner[3]], _c3),
            1, 1, grainRot(id, dirF, 4));
        }

        // ---- down (-Y) ----
        // Vertex order (x,y+1) (x,y) (x+1,y) (x+1,y+1), i.e. corners 3 0 1 2.
        // An upper slab's underside floats at half height inside its own cell,
        // so nothing below can hide it - the mirror of the lower slab's top.
        if (faceVisible(id, at(col, k - 1)) || (IS_SLAB[id] && slabUp)) {
          const kk = k + cellLo;
          const cols = [
            [col, nMx, nPy, nMxPy], [col, nMx, nMy, nMxMy],
            [col, nPx, nMy, nPxMy], [col, nPx, nPy, nPxPy],
          ];
          // Light an underhung slab from its own cell rather than from the solid
          // one beneath it, which would read as unlit.
          const below = (IS_SLAB[id] && slabUp) ? k : k - 1;
          for (let c = 0; c < 4; c++) {
            const s1 = sealsAt(cols[c][1], below), s2 = sealsAt(cols[c][2], below), sc = sealsAt(cols[c][3], below);
            aoData[c] = ao(s1, s2, sc);
            cornerLight(cols[c], [below, below, below, below], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          }
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[3], cornerWaveLo[0], cornerWaveLo[1], cornerWaveLo[2]);
          }
          emit(grp, id, capTile(id, dirF, false), biomeId,
            cellCorner(x, y + 1, kk, _c0), cellCorner(x, y, kk, _c1),
            cellCorner(x + 1, y, kk, _c2), cellCorner(x + 1, y + 1, kk, _c3),
            1, 1, grainRot(id, dirF, 5));
        }

        // ---- +x ----
        // Vertex order (x+1,y+1,lo) (x+1,y,lo) (x+1,y,hi) (x+1,y+1,hi):
        // corners 2 1 1 2, u along -y, v along +k.
        if (faceVisible(id, at(nPx, k))) {
          const nb = nPx;
          const nbPy = nPxPy, nbMy = nPxMy;
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPy, k - 1); setC(1, nbMy, k - 1); setC(2, nbMy, k + 1); setC(3, nbPy, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[2], cornerWaveLo[1], cornerWaveHi[1], cornerWaveHi[2]);
          }
          emit(grp, id, sideTile(id, 0, dirF), biomeId,
            cellCorner(x + 1, y + 1, k + cellLo, _c0), cellCorner(x + 1, y, k + cellLo, _c1),
            cellCorner(x + 1, y, k + cornerTop[1], _c2),
            cellCorner(x + 1, y + 1, k + cornerTop[2], _c3), 1, 1, grainRot(id, dirF, 0));
        }
        // ---- -x ----
        // Vertex order (x,y,lo) (x,y+1,lo) (x,y+1,hi) (x,y,hi): corners 0 3 3 0.
        if (faceVisible(id, at(nMx, k))) {
          const nb = nMx;
          const nbPy = nMxPy, nbMy = nMxMy;
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMy, k - 1); setC(1, nbPy, k - 1); setC(2, nbPy, k + 1); setC(3, nbMy, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[0], cornerWaveLo[3], cornerWaveHi[3], cornerWaveHi[0]);
          }
          emit(grp, id, sideTile(id, 1, dirF), biomeId,
            cellCorner(x, y, k + cellLo, _c0), cellCorner(x, y + 1, k + cellLo, _c1),
            cellCorner(x, y + 1, k + cornerTop[3], _c2),
            cellCorner(x, y, k + cornerTop[0], _c3), 1, 1, grainRot(id, dirF, 1));
        }
        // ---- +y ----
        // Vertex order (x,y+1,lo) (x+1,y+1,lo) (x+1,y+1,hi) (x,y+1,hi):
        // corners 3 2 2 3, u along +x, v along +k.
        if (faceVisible(id, at(nPy, k))) {
          const nb = nPy;
          const nbPx = nPxPy, nbMx = nMxPy;
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMx, k - 1); setC(1, nbPx, k - 1); setC(2, nbPx, k + 1); setC(3, nbMx, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[3], cornerWaveLo[2], cornerWaveHi[2], cornerWaveHi[3]);
          }
          emit(grp, id, sideTile(id, 2, dirF), biomeId,
            cellCorner(x, y + 1, k + cellLo, _c0), cellCorner(x + 1, y + 1, k + cellLo, _c1),
            cellCorner(x + 1, y + 1, k + cornerTop[2], _c2),
            cellCorner(x, y + 1, k + cornerTop[3], _c3), 1, 1, grainRot(id, dirF, 2));
        }
        // ---- -y ----
        // Vertex order (x+1,y,lo) (x,y,lo) (x,y,hi) (x+1,y,hi): corners 1 0 0 1.
        if (faceVisible(id, at(nMy, k))) {
          const nb = nMy;
          const nbPx = nPxMy, nbMx = nMxMy;
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPx, k - 1); setC(1, nbMx, k - 1); setC(2, nbMx, k + 1); setC(3, nbPx, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[1], cornerWaveLo[0], cornerWaveHi[0], cornerWaveHi[1]);
          }
          emit(grp, id, sideTile(id, 3, dirF), biomeId,
            cellCorner(x + 1, y, k + cellLo, _c0), cellCorner(x, y, k + cellLo, _c1),
            cellCorner(x, y, k + cornerTop[0], _c2),
            cellCorner(x + 1, y, k + cornerTop[1], _c3), 1, 1, grainRot(id, dirF, 3));
        }
      }
    }
  }

  return {
    groups: groups.map((g) => (g.empty ? null : g.serialize())),
    crossLight: crossLight.out(),
  };
}

// --- cross plants -----------------------------------------------------------

function emitCross(g, x, y, k, col, id, biomeId, light) {
  // Two flat quads through the middle of the cell, on the world axes. The frame
  // is the same everywhere now, so there is nothing per-face to look up and
  // nothing to normalise: up is +Y, the two spans are +X and +Z.
  worldOf(x, y, k, _cc);
  const cx = _cc.x, cy = _cc.y, cz = _cc.z;

  const vi = col * D + k;
  const sl = light.sun[vi] / 15;
  const br = light.r[vi] / 15, bg = light.g[vi] / 15, bb = light.b[vi] / 15;
  const tint = tintOf(id, biomeId);
  const layer = TILE_SIDE[id];
  const halfW = 0.52, halfH = 0.5;

  for (let plane = 0; plane < 2; plane++) {
    // plane 0 spans world X, plane 1 spans world Z.
    const ax = plane === 0 ? 1 : 0;
    const az = plane === 0 ? 0 : 1;
    // The plane's own normal is deliberately not computed. A cross plant is
    // shaded with UP as its normal, so both quads and both sides of each quad
    // take the same light and a tuft of grass never has a dark half depending on
    // which way the sun is round.
    const v0 = g.verts;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const uvp = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (let c = 0; c < 4; c++) {
      const [su, sv] = pts[c];
      g.pos.push3(cx + ax * su * halfW, cy + sv * halfH, cz + az * su * halfW);
      g.nrm.push3(0, 1, 0);
      g.tan.push3(ax, 0, az);
      g.uv.push2(uvp[c][0], uvp[c][1]);
      // A cross plant's two planes each span their tile exactly once.
      g.qsz.push2(1, 1);
      g.aux.push4(layer, 1.0, sl, 1 + (sv > 0 ? 0.99 : 0.04));
      g.blk.push3(br, bg, bb);
      g.tint.push3(tint[0], tint[1], tint[2]);
    }
    g.idxb.quad(v0);
    g.verts += 4;
  }
}
