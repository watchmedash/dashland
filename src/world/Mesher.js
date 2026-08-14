// Cubesphere chunk mesher. Each cell face becomes a quad whose four corners
// come from the exact sphere mapping, so neighbouring chunks share vertices and
// the surface curves smoothly with no cracks. Radial (side) faces merge along
// the column axis, which is perfectly straight, so merging introduces no error.

import {
  F, D, CHUNK_T, CHUNK_K, R_MIN, vidx, cidx, BIOME, BIOME_COLORS,
} from './Constants.js';
import { CORNER_DIR, CENTER_DIR, COL_NB, stepColumn } from './Sphere.js';
import {
  BLOCKS, N_BLOCKS, IS_OPAQUE, IS_LEAF, RENDER_TYPE, TILE_TOP, TILE_SIDE, TILE_BOTTOM,
  TINT_ID, R_CROSS, R_LIQUID, R_GLASS, R_LADDER, R_TORCH, R_MODEL, SEALS_FACES,
  IS_DIRECTIONAL, IS_AXIS, IS_SLAB, IS_SHAPED,
  IS_SUBMERGED,
  FACING_DEFAULT, sideTile, capTile, axisOf, blockBoxes, IS_FENCE, fenceLinks,
  TILES, TILE_INDEX,
} from './Blocks.js';

/**
 * Flow level of a full water source, mirroring Water.LEVEL_MAX. The side-table
 * byte a liquid cell carries is its flow level, and both ends of the range mean
 * "brim-full": 7 is a source the simulation placed, 0 is a cell it never touched
 * (worldgen's oceans and lakes).
 */
const LEVEL_SOURCE = 7;

/**
 * Quarter-turns of UV so a lying log's grain runs along its axis.
 *
 * `sideTile` already puts the rings on the two faces the trunk runs through and
 * bark on the other four, which is the half of the job you notice first. The
 * half you notice second is that the bark is *directional*: its grain runs up
 * the texture, and up the texture is up the world on every face, so a log laid
 * on its side kept vertical grain and read as an upright log wearing the wrong
 * end caps. Rotating the bark faces a quarter turn is what actually lays it
 * down.
 *
 * Which faces need it falls out of the UV conventions and is not symmetric.
 * On a side face u runs tangentially and v runs along +k; on the top face u
 * runs along i and v along j. So for a log along i the bark is on the j faces
 * (grain currently along k, wants i) *and* on the caps of the cell (grain along
 * j, wants i) — both turn. For a log along j the bark on the i faces turns, but
 * the top and bottom already have their v along j and must be left alone.
 *
 * `dir` is 0:+i 1:-i 2:+j 3:-j 4:top 5:bottom.
 */
function grainRot(id, facing, dir) {
  const ax = axisOf(id, facing);
  if (!ax) return 0;
  if (ax === 1) return (dir === 2 || dir === 3 || dir >= 4) ? 1 : 0;
  return (dir === 0 || dir === 1) ? 1 : 0;
}

export const GROUP_OPAQUE = 0;
export const GROUP_CUTOUT = 1;
export const GROUP_TRANSPARENT = 2;
export const GROUP_LIQUID = 3;
export const GROUP_COUNT = 4;

export const GROUP = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (b.render === R_LIQUID) GROUP[i] = GROUP_LIQUID;
  else if (b.render === R_CROSS) GROUP[i] = GROUP_CUTOUT;
  // A ladder is mostly holes. Drawn in the opaque group its alpha was simply
  // ignored, so the gaps between the rungs came out as solid timber and the
  // whole thing read as a plank with a ladder painted on it — on the wall and
  // in the inventory both.
  else if (b.render === R_LADDER) GROUP[i] = GROUP_CUTOUT;
  else if (b.render === R_GLASS) GROUP[i] = b.name.startsWith('leaves') ? GROUP_CUTOUT : GROUP_TRANSPARENT;
  else GROUP[i] = GROUP_OPAQUE;
}

/** Leaves. Sways in the wind, and LEAF_SNOW_FRAG whitens it in winter. */
const WAVE_LEAVES = 4;
/**
 * Leaves whose COLUMN is a snowfield, which is the same wave in every respect
 * the vertex shader cares about — the leaf branch there is `wType > 3.5` and
 * takes both — and a different one in the only respect the fragment shader
 * does: LEAF_SNOW_FRAG holds this one white all year instead of only in winter.
 *
 * This exists because the ground a tree grew from is the one thing a leaf
 * fragment cannot work out for itself. It knows its own altitude, which is five
 * to twelve blocks above that ground, so an altitude gate whitens every
 * sea-level forest in July; it cannot know the biome, because a snowfield is
 * `1 - 1.35*|lat|` plus three octaves of fbm minus an altitude term, relaxed,
 * de-speckled and then grown into by the beach pass, none of which is a
 * closed-form function of a world position. The column knows, the mesher is
 * already holding the column, and the wave id is the one channel that reaches
 * the fragment with a whole integer to spare in it.
 *
 * Cost is one comparison in `emit`, no new attribute, no new byte per vertex,
 * and nothing at all in the save: a wave id is meshed, never stored.
 *
 * BIOME.SNOW and not COLD_BIOMES, which would add TUNDRA. A snowfield's top
 * block is `ID.snow` for every column of it, so the ground under those trees is
 * white by construction at any latitude and in any season. Tundra's is drifted
 * — snow, gravel and coarse dirt by a noise threshold — so it is a brown and
 * white mottle in July and a canopy laid solid white over it would be the
 * inconsistency this is trying to remove. Weather.js puts tundra in COLD_BIOMES
 * to decide that falling precipitation there is snow rather than rain, which is
 * a question about the sky and not about the ground.
 */
const WAVE_LEAVES_COLD = 5;

const WAVE = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (b.render === R_CROSS) WAVE[i] = 1;
  else if (b.name === 'water') WAVE[i] = 2;
  else if (b.name === 'lava') WAVE[i] = 3;
  else if (b.name.startsWith('leaves')) WAVE[i] = WAVE_LEAVES;
}


/**
 * Cross blocks that are drawn as real geometry instead, and so must not also be
 * drawn as a billboard here.
 *
 * The flowers are modelled — `render/BlockModels.js` instances a WAM model at
 * every one near the player — and a cross quad is a full cell wide, so no model
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
// while the planted block was still the mesher's tinted billboard. This entry
// and its MODELLED_PLANTS height go together, or the block is a model inside a
// billboard, or an empty cell.
for (const n of ['flower_red', 'flower_blue', 'flower_gold', 'mushroom', 'sapling',
  // The reef. Unlike the flowers these have no billboard to fall back on —
  // they were authored as models and carry no tile of their own — so this list
  // and `MODELLED_PLANTS` in `main.js` have to agree or the seabed is empty:
  // a name here and not there draws nothing at all.
  'coral_branch', 'coral_fan', 'coral_brain', 'coral_dead',
  'kelp', 'sea_grass', 'sea_sponge', 'sea_shell',
  // The two edible plants and the deep light, on exactly the same footing.
  'sea_lettuce', 'sea_grape', 'abyss_anemone',
  // The land flora and the cave floor, on exactly the same footing again: no
  // tile, no billboard, the model is all there is. The tile atlas is baked from
  // a texture pack that is not in this tree, so for these sixteen the model was
  // never one of two options — it was the only one available.
  'thornbrush', 'aloe', 'golden_grass', 'firebloom',
  'cotton_grass', 'snowbell', 'alpine_aster', 'marram',
  'lavender', 'clover', 'fern', 'lingonberry',
  'cave_mushroom', 'shelf_fungus', 'crystal_cluster', 'driftwood',
  // The wild harvest. Same footing as the rest: authored as models, no tile and
  // no billboard, so a name here and not in MODELLED_PLANTS draws nothing at
  // all - and one missing from here draws a flat card instead of the model.
  'cactusfruit', 'agave', 'stonecrop', 'icecapmoss',
  'swampreed', 'mireroot', 'lotus', 'truffle',
  // The one plant here that is not harvest. Same footing all the same: no tile,
  // no billboard, and a name missing from either this list or `MODELLED_PLANTS`
  // leaves the forest floor empty where the generator put one.
  'deathcap',
  // The farm. Wheat stays out of this set and keeps its billboard because it
  // has four authored tiles in the atlas and they read fine; these seven have no
  // tile at all, so a name missing from here draws an untextured card and a
  // name missing from `MODELLED_PLANTS` draws nothing whatsoever. All four
  // stages of each, because a crop's stages are four separate block ids and
  // this array is indexed by id - listing only the ripe rung would leave a
  // field invisible for the whole time it is worth watching.
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
// unlit by it. (See the header of `render/BlockModels.js`, which recorded that
// as unreachable.)
//
// It is reachable, because the sample is *right here*. `emitCross` reads
// `light.sun/r/g/b` at exactly this cell for exactly this kind of block, at
// exactly the moment the chunk is meshed — and then the MODELLED_CROSS test
// throws it away. So keep it: one word per modelled-cross cell, shipped
// alongside the geometry as a transferable, looked up per instance by
// `BlockModels`.
//
// ### The word
//
//   bits  0.. 3  block light r   0..15
//   bits  4.. 7  block light g   0..15
//   bits  8..11  block light b   0..15
//   bits 12..15  skylight        0..15
//   bits 16..27  address within the chunk, ((di * CHUNK_T) + dj) * CHUNK_K + dk
//
// 28 bits, so one Uint32 and no packing games. The address is chunk-*local* on
// purpose: a global cell index (col * D + k) needs 27 bits on its own — the
// planet has 85 million voxels — and would have forced a second array or a
// 64-bit split. A chunk is 16 x 16 x 11 = 2816 cells, which is 12 bits, and the
// receiver already knows which chunk it is unpacking because the message says
// so. Nothing smaller is honest: dropping skylight would fit 16 bits of payload
// into a Uint16 pair, but that is the same four bytes in two buffers.
//
// Cost is four bytes per modelled-cross cell and nothing at all for a chunk
// with none — the buffer is only allocated on the first hit and a chunk with no
// flowers ships `null`, which is the overwhelming majority of them. A surface
// chunk over a meadow at the flora generator's densest is ~4% of 256 columns,
// so ten to twenty cells: 40-80 bytes against the ~200 KB of vertex data that
// chunk is already sending.
//
// Entries come out sorted by address, for free, because the emit loop walks i
// then j then k ascending and the address is that same odometer. The main
// thread binary-searches it and relies on that; if this loop is ever reordered,
// sort here.
// Modelled *blocks* (`R_MODEL`) ride the same buffer, for the same reason and
// with the same word. The only difference is where the sample is taken: a
// flower's own cell holds light and a workbench's cell is opaque and holds
// none, so a modelled block samples its brightest neighbour instead. See the
// `R_MODEL` branch in the mesh loop.
export const CROSS_LIGHT_ADDR_SHIFT = 16;

/**
 * Unpack one word's block light into `out` as three 0..1 floats.
 *
 * Skylight is deliberately not returned. It is shipped because it is four spare
 * bits in a word we are sending anyway and because the sun half of this problem
 * will eventually want it, but nothing consumes it today: a modelled flower
 * already gets the sun through the shadow map and the entity fill (see
 * `BlockModels._fit`), and feeding it voxel skylight as well would be counting
 * the sky twice on every flower in the open.
 */
export function crossLightRGB(w, out) {
  out[0] = (w & 15) / 15;
  out[1] = ((w >>> 4) & 15) / 15;
  out[2] = ((w >>> 8) & 15) / 15;
  return out;
}

/**
 * Growable Uint32 list, allocated lazily so a chunk with no flowers in it —
 * which is nearly all of them, including every chunk of solid rock — pays
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
 * A `Group` is eight `Buf`s and an `IBuf`, and a fresh one costs 2048 entries
 * per stride however small the chunk turns out to be: 23 floats of stride plus
 * the index buffer is about 205 KB, and `meshChunk` was building four of them —
 * 820 KB — on entry and dropping all four on exit. A first load meshes ~3 150
 * chunks, so that is roughly 2.6 GB allocated, zeroed by the VM and handed
 * straight back to the collector. Measured in the worker's own profile it was
 * 438 ms in the `Buf` constructor and 217 ms in the garbage collector, against
 * 7.5 s of total worker CPU.
 *
 * Three of the four are usually the wasteful ones: a chunk of solid rock emits
 * nothing at all into the cutout, transparent and liquid groups, and
 * `serialize` is never even called on them — `groups.map` ships `null` for an
 * empty group — so their 615 KB was allocated purely to be thrown away.
 *
 * Reuse is safe here because nothing a group holds outlives the call. `out()`
 * is `data.slice(0, len)`, a copy, so every array that leaves in the payload is
 * already the mesher's own fresh allocation and none of them alias the pool.
 * The one thing to keep true is that `meshChunk` must not overlap itself: it is
 * a straight-line synchronous function in a single-threaded worker with no
 * await in it, and the only caller is `meshAndPost`, which posts and returns.
 *
 * The pool keeps whatever high-water mark the biggest chunk needed and does not
 * shrink, which is the point — after the first few chunks `need` never grows
 * again and the steady state is zero allocation per mesh. A chunk is 16x16x11
 * cells, so the ceiling is bounded by geometry rather than by session length.
 */
const _pool = [];

// --- helpers ----------------------------------------------------------------

/**
 * For liquids the tint attribute is repurposed: x carries normalised water
 * depth, y a shoreline flag, and z the body of water's identity — a marsh, a
 * tarn, a hot spring, a waterfall or the ocean. See WATER_OCEAN in WorldGen for
 * why that rides here rather than in a block id of its own.
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
 * a grass block's bottom face — which is the plain `dirt` tile — came out
 * multiplied by the biome grass colour. Measured on the baked atlas, the tile
 * itself is exact: grass_side's lower 70% and `dirt` agree to a mean 0.03 counts
 * per channel. Measured in a plains biome, the tint is [0.55, 0.78, 0.40], so
 * the same soil rendered 140/102/70 on a dirt block and 77/80/28 on the grass
 * block beside it — a different, olive earth, which is what the playtest called
 * out ("grass block also uses different dirt color").
 *
 * The face's *layer* is what says "this texel is soil, not foliage", and it is
 * already threaded into `emit`. Only whole faces can be settled here; the side
 * face is soil and foliage in one tile and is masked per texel instead, see the
 * arm-alpha tint mask in scripts/bake-textures.mjs and VoxelMaterial's MAP_FRAG.
 */
const WHITE = [1, 1, 1];
const UNTINTED_LAYER = new Uint8Array(TILES.length);
for (const t of ['dirt']) UNTINTED_LAYER[TILE_INDEX[t]] = 1;

function faceVisible(a, b) {
  if (a === 0) return false;
  // `SEALS_FACES` and not `IS_OPAQUE`, and the difference is one class of block:
  // a modelled one is opaque to the light and draws no triangles, so there is
  // nothing there to hide this face behind. Cull against it and a workbench set
  // against a wall shows daylight through the wall between its legs.
  if (SEALS_FACES[b]) return false;
  const ga = GROUP[a];
  // "Fast leaves": a face between two leaf blocks is never seen, only its own
  // dark interior, so a canopy used to read as a stack of hollow crates. Culling
  // leaf-against-leaf (any species, like Minecraft) leaves the canopy as a solid
  // shell and removes the majority of foliage triangles.
  if (IS_LEAF[a] && IS_LEAF[b]) return false;
  if (ga === GROUP_TRANSPARENT && b === a) return false;
  // `b === a`, like the line above it. Testing only the *group* culled the face
  // between water and lava as well, and those two genuinely do end up touching:
  // the flow sim refuses to let water enter a lava cell, so a bucket poured near
  // a mantle pool leaves them side by side. Neither cell drew the shared quad,
  // which left a hole straight through into the inside of the pool.
  if (ga === GROUP_LIQUID && GROUP[b] === GROUP_LIQUID && b === a) return false;
  // Reef life is *inside* the water, so the water has no face there either.
  //
  // Without this every coral is a cell-sized bubble: the ocean draws its own
  // underside all round the plant's cell and you swim through a reef looking at
  // the inside surface of the sea. A kelp stalk, being a run of them up one
  // column, is a chimney of it. The cell genuinely does not hold water — a
  // voxel is one id — but nothing about that is worth showing the player, and
  // the honest picture is the one where the water carries on through.
  //
  // One-way on purpose. This asks "should the *liquid* draw a wall against a
  // submerged plant", and the answer is no; the plant is a cross block and
  // never reaches this test at all, so there is no matching case for `a` being
  // the plant. The cost of the rule is at the boundary of a water body, where a
  // coral placed against open air would leave the sea's flank open — which is
  // why worldgen is asked to keep the reef under a covering cell of water, and
  // why `_placeBlock` refuses to plant one anywhere else.
  if (ga === GROUP_LIQUID && IS_SUBMERGED[b]) return false;
  return true;
}

const _c0 = [0, 0, 0], _c1 = [0, 0, 0], _c2 = [0, 0, 0], _c3 = [0, 0, 0];
const _n = [0, 0, 0], _t = [0, 0, 0];

function cornerAt(f, i, j, k, out) {
  const o = ((f * (F + 1) + i) * (F + 1) + j) * 3;
  const r = R_MIN + k;
  out[0] = CORNER_DIR[o] * r; out[1] = CORNER_DIR[o + 1] * r; out[2] = CORNER_DIR[o + 2] * r;
  return out;
}

/**
 * As cornerAt, but `i` and `j` may fall between grid corners.
 *
 * CORNER_DIR is a table indexed by whole corner, so handing cornerAt a
 * fractional i or j computes a fractional array offset and reads nonsense —
 * which surfaces as NaN vertex positions and a geometry with no bounding
 * sphere, not as an exception. Shaped blocks need points inside a cell, so
 * those are interpolated between the four surrounding corners and renormalised:
 * a blend of unit vectors is not itself a unit vector, and skipping that would
 * pull the mid-face slightly toward the planet's centre.
 *
 * The two neighbours are clamped to the last corner of the face, and that is
 * not a nicety. The fast path above needs *both* fractions to be zero, so a box
 * face flush with the far wall of the very last cell — i whole at F, j inside
 * the cell — came through here with i0 = F and read the row past the end of the
 * table. Its weight is zero, but `undefined * 0` is NaN, not nothing, and one
 * NaN vertex takes the whole chunk's bounding sphere with it: the geometry
 * stops being culled and Three prints a warning with no hint of where it came
 * from. It cost a fence line laid across a cube seam to find. Any block with a
 * face at the cell wall and a fractional edge across it can do this — a door
 * standing in the last column has been able to since the day doors were added.
 */
function cornerLerp(f, i, j, k, out) {
  const i0 = Math.floor(i), j0 = Math.floor(j);
  const fi = i - i0, fj = j - j0;
  if (fi === 0 && fj === 0) return cornerAt(f, i0, j0, k, out);
  const S = F + 1;
  const ip = i0 < F ? i0 + 1 : i0, jp = j0 < F ? j0 + 1 : j0;
  const row0 = (f * S + i0) * S, row1 = (f * S + ip) * S;
  const o00 = (row0 + j0) * 3, o10 = (row1 + j0) * 3;
  const o01 = (row0 + jp) * 3, o11 = (row1 + jp) * 3;
  const w00 = (1 - fi) * (1 - fj), w10 = fi * (1 - fj);
  const w01 = (1 - fi) * fj, w11 = fi * fj;
  let x = CORNER_DIR[o00] * w00 + CORNER_DIR[o10] * w10 + CORNER_DIR[o01] * w01 + CORNER_DIR[o11] * w11;
  let y = CORNER_DIR[o00 + 1] * w00 + CORNER_DIR[o10 + 1] * w10
        + CORNER_DIR[o01 + 1] * w01 + CORNER_DIR[o11 + 1] * w11;
  let z = CORNER_DIR[o00 + 2] * w00 + CORNER_DIR[o10 + 2] * w10
        + CORNER_DIR[o01 + 2] * w01 + CORNER_DIR[o11 + 2] * w11;
  const inv = 1 / (Math.hypot(x, y, z) || 1);
  const r = (R_MIN + k) * inv;
  out[0] = x * r; out[1] = y * r; out[2] = z * r;
  return out;
}

/**
 * Mesh one chunk.
 * @param {Uint8Array} blocks
 * @param {Uint8Array} colBiome  per-column biome
 * @param {Uint8Array} colWater  per-column water identity — see WATER_OCEAN in
 *   WorldGen. Absent on a world built before it existed, which reads as 0 for
 *   every column and is the ocean, so nothing has to test for it.
 * @param {{sun,r,g,b}} light
 * @param {Map<number,number>} facing sparse cell index —  facing 0..3; only
 *   directional blocks have an entry, so this is never touched for ordinary
 *   terrain.
 * @returns {{groups: Array, crossLight: Uint32Array|null}} the four render
 *   groups as before, plus the baked light of every modelled-cross cell in this
 *   chunk (null when there are none). See CROSS_LIGHT_ADDR_SHIFT.
 */
export function meshChunk(blocks, colBiome, colWater, light, facing, f, ci, cj, ck) {
  // One Group per draw group, from GROUP_COUNT rather than from four literal
  // constructors: the count was already declared next to the group ids and a
  // fifth group added there would otherwise silently index past the end here.
  // Reused rather than rebuilt; see `_pool`.
  const groups = _pool;
  for (let g = 0; g < GROUP_COUNT; g++) {
    if (groups[g]) groups[g].reset(); else groups[g] = new Group();
  }
  const crossLight = new CrossLightBuf();
  const i0 = ci * CHUNK_T, j0 = cj * CHUNK_T, k0 = ck * CHUNK_K;
  const i1 = Math.min(F, i0 + CHUNK_T), j1 = Math.min(F, j0 + CHUNK_T), k1 = Math.min(D, k0 + CHUNK_K);
  const { sun, r: lr, g: lg, b: lb } = light;

  // sample a voxel's block id through the adjacency graph
  const at = (col, k) => (k < 0 || k >= D ? 0 : blocks[col * D + k]);
  // Ambient occlusion, and only ambient occlusion: does the cell next door have
  // geometry in it that would shade this corner? `SEALS_FACES` rather than
  // `IS_OPAQUE` because a modelled block has no geometry to shade with — see the
  // note over `SEALS_FACES` in Blocks.js.
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
  // per-corner surface height (fraction of the cell); 1 for everything but water
  const cornerTop = [1, 1, 1, 1];
  /**
   * How much of the wave a liquid vertex takes, per corner: 1 on the free
   * surface, 0 on the bed and everywhere inside the body.
   *
   * The shader used to displace every water vertex equally, which moved the
   * whole body of water through the terrain instead of rippling the top of it.
   * Hi is the corner at the cell's brim (level k+1), Lo the one at its floor
   * (level k); the side faces need both because they span the two.
   *
   * The four column sets a corner is made of are resolved once into cornerCols
   * and shared with cornerTop, which is what guarantees the two agree — and
   * what guarantees no seam. Every quantity here is a function of the corner
   * and the level and nothing else, so two faces meeting at a corner always
   * compute the same number, whichever cell they belong to.
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
   * floor and z-fight the block underneath. Scaling by top/0.2 caps the sink at
   * four fifths of whatever height the film actually has.
   */
  const WAVE_HEADROOM = 0.2;
  let liquidDepth = 0, liquidShore = 0, liquidStyle = 0;
  // per-corner water depth, so the shallow-to-deep gradient and the foam band
  // interpolate across the surface instead of stepping block by block
  const liquidCorner = [0, 0, 0, 0];
  /**
   * Per-corner shoreline, and it is the half of the line above that was claimed
   * and not delivered.
   *
   * The depth has been per corner for a while; the shore flag stayed per CELL, a
   * flat 0 or 1 for the whole quad, and the shader multiplies the two together
   * to decide where the foam is. So the foam rim could only ever be a set of
   * whole-block rectangles: the quad touching land carried the whole rim and its
   * neighbour one block out carried none of it, however shallow that neighbour
   * was. Counted on seed 4242 over a beach, recomputing exactly what this file
   * emits: of 711 water surface quads, 512 had four different corner depths and
   * a mean corner spread of 0.108 — the gradient is genuinely there — while all
   * 41 shoreline quads were flat in y, by construction, because a per-cell flag
   * has nowhere else to go.
   *
   * The fraction of the corner's four columns that are land, doubled and clamped,
   * so a corner *on* a straight waterline (two of its four columns are land)
   * still reads a full 1 and the foam keeps the strength it was tuned at. What
   * changes is that the far corner of the same quad reads 0, so the rim now
   * fades out across the block instead of ending at its edge.
   */
  const liquidCornerShore = [0, 0, 0, 0];
  let useCornerDepth = false;

  /**
   * Height of the liquid surface inside cell (c, k), as a fraction of the cell.
   * A source is brim-full; each step the flow loses drops it a little further,
   * so a thin overflow reads as a thin sheet with a lip rather than a full slab.
   * Level 0 means "unmarked" — worldgen's oceans and lakes — which are sources.
   */
  const liquidTop = (c, k) => {
    const lvl = facing?.get(c * D + k) ?? 0;
    if (lvl === 0 || lvl === LEVEL_SOURCE) return 1;
    // Minecraft's ramp: the tail of a flow is a film, not a half block. A ramp
    // that only reached about a third of a block at the far edge still read as
    // a slab with a bevel — the thinning has to be dramatic to look like water
    // running out rather than water stopping.
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
   * Shared corners make the surface continuous instead — one connected sheet
   * that slopes away from the source.
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
   * wind acts on, and it is the only water in the world that should move. Of
   * the up-to-four columns meeting at this corner, only the ones that hold
   * liquid below the level have an opinion; the fraction of those that are open
   * above it is the answer. No liquid below at all means this corner is not
   * water and the value is 0.
   *
   * A fraction rather than a flag on purpose. Where a flowing surface steps
   * down, one column is open above the level and its neighbour is not, and a
   * flag would move one of the two quads meeting there and not the other. The
   * average is the same number on both sides, so the sheet stays welded — the
   * same argument, over the same four columns, that liquidCornerTop is built
   * on.
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
   * blocks for it would be the third copy of the same thing — so shaped blocks
   * build out of this instead.
   *
   * Light and AO come from the cell, not the box: they do not vary within a
   * cell, and sampling them per box would be six lookups for no visible gain.
   * `skip` names faces to leave out — the seam where a stair's two boxes meet
   * is interior and must not be drawn, or it z-fights with itself.
   *
   * @param {number[]} lo  [i, j, k] box corner within the cell, each 0..1
   * @param {number[]} hi  opposite corner
   * @param {object}   skip {pi, mi, pj, mj, up, dn} truthy to omit that face
   */
  const emitBox = (g, id, biomeId, f, i, j, k, lo, hi, dirF, skip, allCap) => {
    const [i0, j0, k0] = lo, [i1, j1, k1] = hi;
    // A box may ask for its cap tile on every face — see the torch head in
    // blockBoxes. Without it the flame only ever faces the sky.
    const side = allCap ? () => capTile(id, dirF, true)
      : (dir) => sideTile(id, dir, dirF);
    // Faces are wound so the normal points out of the box, matching the
    // full-cube path — emit() derives the normal from the winding.
    if (!skip.up) {
      emit(g, id, capTile(id, dirF, true), biomeId,
        cornerLerp(f, i + i0, j + j0, k + k1, _c0), cornerLerp(f, i + i1, j + j0, k + k1, _c1),
        cornerLerp(f, i + i1, j + j1, k + k1, _c2), cornerLerp(f, i + i0, j + j1, k + k1, _c3),
        i1 - i0, j1 - j0);
    }
    if (!skip.dn) {
      emit(g, id, capTile(id, dirF, false), biomeId,
        cornerLerp(f, i + i0, j + j0, k + k0, _c0), cornerLerp(f, i + i0, j + j1, k + k0, _c1),
        cornerLerp(f, i + i1, j + j1, k + k0, _c2), cornerLerp(f, i + i1, j + j0, k + k0, _c3),
        i1 - i0, j1 - j0);
    }
    if (!skip.pi) {
      emit(g, id, side(0), biomeId,
        cornerLerp(f, i + i1, j + j0, k + k0, _c0), cornerLerp(f, i + i1, j + j1, k + k0, _c1),
        cornerLerp(f, i + i1, j + j1, k + k1, _c2), cornerLerp(f, i + i1, j + j0, k + k1, _c3),
        j1 - j0, k1 - k0);
    }
    if (!skip.mi) {
      emit(g, id, side(1), biomeId,
        cornerLerp(f, i + i0, j + j1, k + k0, _c0), cornerLerp(f, i + i0, j + j0, k + k0, _c1),
        cornerLerp(f, i + i0, j + j0, k + k1, _c2), cornerLerp(f, i + i0, j + j1, k + k1, _c3),
        j1 - j0, k1 - k0);
    }
    if (!skip.pj) {
      emit(g, id, side(2), biomeId,
        cornerLerp(f, i + i1, j + j1, k + k0, _c0), cornerLerp(f, i + i0, j + j1, k + k0, _c1),
        cornerLerp(f, i + i0, j + j1, k + k1, _c2), cornerLerp(f, i + i1, j + j1, k + k1, _c3),
        i1 - i0, k1 - k0);
    }
    if (!skip.mj) {
      emit(g, id, side(3), biomeId,
        cornerLerp(f, i + i0, j + j0, k + k0, _c0), cornerLerp(f, i + i1, j + j0, k + k0, _c1),
        cornerLerp(f, i + i1, j + j0, k + k1, _c2), cornerLerp(f, i + i0, j + j0, k + k1, _c3),
        i1 - i0, k1 - k0);
    }
  };

  const emit = (g, id, layer, biomeId, p0, p1, p2, p3, uMax, vMax, uvRot = 0) => {
    // normal & tangent from the actual quad
    let ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    let bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    _n[0] = ay * bz - az * by; _n[1] = az * bx - ax * bz; _n[2] = ax * by - ay * bx;
    const nl = Math.hypot(_n[0], _n[1], _n[2]) || 1;
    _n[0] /= nl; _n[1] /= nl; _n[2] /= nl;
    const al = Math.hypot(ax, ay, az) || 1;
    _t[0] = ax / al; _t[1] = ay / al; _t[2] = az / al;

    const tint = GROUP[id] === GROUP_LIQUID
      ? [liquidDepth, liquidShore, liquidStyle]
      : (UNTINTED_LAYER[layer] ? WHITE : tintOf(id, biomeId));
    // A leaf standing over a snowfield gets its own wave id, so the shader can
    // keep it under snow in July as well as in December. See WAVE_LEAVES_COLD.
    // `biomeId` is the column's, already resolved for the tint on the line
    // above, so this costs one integer compare on the quads of one block class.
    const wave = (WAVE[id] === WAVE_LEAVES && biomeId === BIOME.SNOW)
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
      // recover it: `uv` above runs 0..uMax by 0..vMax, and those are whole
      // numbers for a greedy-merged cube face (one unit per cell) but a
      // FRACTION for a shaped block, whose quad covers only part of its tile.
      // The mining crack overlay is the only consumer — see BREAK_FRAG. Without
      // this it samples the crack at fract(uv), which is a clean 0..1 only when
      // the quad happens to be whole cells, so a slab's side face drew half the
      // pattern with its centre on the top edge and a stair drew that same half
      // twice, once per box.
      //
      // Not for the torch, which is the test case this was wrongly chased with
      // twice: `rt === R_TORCH` above skips the voxel path entirely, so a torch
      // has no quads here at all and is drawn by BlockModels with a material
      // that never includes BREAK_FRAG. No uv arithmetic can crack one.
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

  for (let i = i0; i < i1; i++) {
    for (let j = j0; j < j1; j++) {
      const col = cidx(f, i, j);
      const biomeId = colBiome[col];
      // tangential neighbours, resolved once per column
      const nPi = COL_NB[col * 4 + 0], nMi = COL_NB[col * 4 + 1];
      const nPj = COL_NB[col * 4 + 2], nMj = COL_NB[col * 4 + 3];
      // diagonals for AO
      const nPiPj = COL_NB[nPi * 4 + 2], nPiMj = COL_NB[nPi * 4 + 3];
      const nMiPj = COL_NB[nMi * 4 + 2], nMiMj = COL_NB[nMi * 4 + 3];

      for (let k = k0; k < k1; k++) {
        const id = blocks[col * D + k];
        if (id === 0) continue;
        const rt = RENDER_TYPE[id];
        if (rt === R_CROSS) {
          if (!MODELLED_CROSS[id]) emitCross(groups[GROUP_CUTOUT], f, i, j, k, col, id, biomeId, light);
          // ...and if it *is* modelled, keep the light sample the billboard
          // would have baked in. This is the only line in the whole mesh loop
          // that a non-flower cell can reach and it is inside a branch that
          // already ended in `continue`, so no vertex path is touched and no
          // block that is not a modelled cross pays for it.
          else {
            const vi = col * D + k;
            crossLight.push(
              (((i - i0) * CHUNK_T + (j - j0)) * CHUNK_K + (k - k0)) << CROSS_LIGHT_ADDR_SHIFT
              | (sun[vi] & 15) << 12 | (lb[vi] & 15) << 8 | (lg[vi] & 15) << 4 | (lr[vi] & 15),
            );
          }
          continue;
        }
        const grp = groups[GROUP[id]];
        // -1 for the overwhelming majority of cells: no Map lookup at all.
        // The side-table carries a different meaning per block: a horizontal
        // facing for a kiln, an axis for a log. -1 for the overwhelming
        // majority of cells, so no Map lookup at all.
        const dirF = IS_DIRECTIONAL[id]
          ? (facing?.get(col * D + k) ?? FACING_DEFAULT)
          : (IS_AXIS[id] ? (facing?.get(col * D + k) ?? 0) : -1);

        // water depth + shoreline, handed to the liquid shader via `tint`
        if (rt === R_LIQUID) {
          let d = 0;
          while (d < 20 && RENDER_TYPE[at(col, k - d)] === R_LIQUID) d++;
          liquidDepth = Math.min(1, d / 7);
          liquidShore = (IS_OPAQUE[at(nPi, k)] || IS_OPAQUE[at(nMi, k)]
            || IS_OPAQUE[at(nPj, k)] || IS_OPAQUE[at(nMj, k)]) ? 1 : 0;
          // Per column, not per cell, so every quad of one body of water agrees
          // and there is no seam down the middle of a lake. Lava takes it too
          // and ignores it: the shader branches on the wave id long before it
          // looks at this.
          liquidStyle = colWater ? colWater[col] : 0;
        }

        // Surface height at each of the cell's four top corners, in corner order
        // (i,j) (i+1,j) (i+1,j+1) (i,j+1). 1 — the brim — for everything that is
        // not flowing water, so the ordinary block path is untouched. The side
        // faces below reuse these, which is what keeps a lowered top welded to
        // its own walls instead of sinking inside a full-height box.
        // Shaped blocks — slabs and stairs — are built out of sub-cell boxes
        // instead of going through the six-face path below. They occupy part of
        // their cell, so no neighbour can hide any of their faces and the only
        // ones to drop are the seams where their own boxes meet.
        // A torch is drawn as its own model, close to the player, by
        // BlockModels — see _syncBlockModels. Emitting the boxes as well would
        // put a brown post inside the flame. Everything else about a torch
        // still comes from the voxel: it lights, it collides, it is mined and
        // saved exactly as before, and only the picture changes.
        if (rt === R_TORCH) continue;
        /**
         * A modelled block: no geometry at all, and its light kept for the
         * model that will stand here. See `R_MODEL` in Blocks.js.
         *
         * The sample is the **brightest of the six neighbours**, not the cell
         * itself, and that is forced rather than chosen. A modelled block is
         * opaque, so the light solver never propagates into its cell and every
         * channel there reads 0 — sample it and every workbench on the planet is
         * a black bench. A flower has no such problem because a flower's cell is
         * air, which is why `emitCross` above can simply read `vi`.
         *
         * Brightest rather than an average because the question this answers is
         * "is there a torch on this bench", and a bench with a torch on one side
         * and rock on the other five is lit. An average would divide that light
         * by six and read as unlit.
         */
        if (rt === R_MODEL) {
          let ms = 0, mr = 0, mg = 0, mb = 0;
          for (let n = 0; n < 6; n++) {
            const nc = n === 0 ? nPi : n === 1 ? nMi : n === 2 ? nPj : n === 3 ? nMj : col;
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
            (((i - i0) * CHUNK_T + (j - j0)) * CHUNK_K + (k - k0)) << CROSS_LIGHT_ADDR_SHIFT
            | (ms & 15) << 12 | (mb & 15) << 8 | (mg & 15) << 4 | (mr & 15),
          );
          continue;
        }
        if (IS_SHAPED[id]) {
          const byte = (facing?.get(col * D + k) ?? 0) & 7;
          // A fence has no stored orientation: its shape is its neighbours, and
          // those are already resolved for this column.
          const links = IS_FENCE[id]
            ? fenceLinks(at(nPi, k), at(nMi, k), at(nPj, k), at(nMj, k))
            : 0;
          const boxes = blockBoxes(id, byte, links);
          // Light comes from the cell: a shaped block sits in open air by
          // definition, so its own cell is the honest sample, and light does
          // not vary within one anyway.
          //
          // Occlusion cannot be left flat, though. Every other block in the
          // world gets corner AO, so a slab rendered at a constant 3 reads as
          // cardboard laid on a shaded floor. There are no sub-cell corners to
          // sample, so this darkens the whole block by how boxed-in its cell
          // is — a stair in the open stays bright, one set into a wall picks up
          // the same contact shadow its neighbours have.
          let walled = 0;
          if (SEALS_FACES[at(nPi, k)]) walled++;
          if (SEALS_FACES[at(nMi, k)]) walled++;
          if (SEALS_FACES[at(nPj, k)]) walled++;
          if (SEALS_FACES[at(nMj, k)]) walled++;
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
            // same question: a fence post is 0.25 x 0.25 x 1.5 and a rail is
            // 0.16 x 0.16, so a rail laid against the post covered 13.7% of
            // that face and took away 100% of it. A post in the middle of a run
            // lost both its +i and -i faces and you looked straight through the
            // timber — which is the "sides go transparent at some angles" fault,
            // and it is angle-dependent precisely because only the faces the
            // rails link to are lost. A stair had the same hole at 50%: the
            // riser touches half the tread's top and the whole top went.
            //
            // Coverage is tested per box rather than against the union, so a
            // face buried by two boxes that neither covers alone is drawn and
            // hidden rather than dropped. That is the safe way round — the cost
            // is a quad, the alternative is a hole — and it costs nothing in
            // practice: no shape in the table is built that way.
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
            if (bi1 === 1 && SEALS_FACES[at(nPi, k)]) skip.pi = 1;
            if (bi0 === 0 && SEALS_FACES[at(nMi, k)]) skip.mi = 1;
            if (bj1 === 1 && SEALS_FACES[at(nPj, k)]) skip.pj = 1;
            if (bj0 === 0 && SEALS_FACES[at(nMj, k)]) skip.mj = 1;
            if (bk1 === 1 && SEALS_FACES[at(col, k + 1)]) skip.up = 1;
            if (bk0 === 0 && SEALS_FACES[at(col, k - 1)]) skip.dn = 1;
            emitBox(grp, id, biomeId, f, i, j, k,
              [bi0, bj0, bk0], [bi1, bj1, bk1], -1, skip, boxes[b][6]);
          }
          continue;
        }

        const slabUp = 0;
        const cellLo = 0;

        if (rt === R_LIQUID) {
          // corners (i,j) (i+1,j) (i+1,j+1) (i,j+1), each with the four columns
          // that meet there — the same sets cornerTop has always used, hoisted
          // so the wave amounts are built from exactly the same geometry.
          const cc = cornerCols;
          cc[0][0] = col; cc[0][1] = nMi; cc[0][2] = nMj; cc[0][3] = nMiMj;
          cc[1][0] = col; cc[1][1] = nPi; cc[1][2] = nMj; cc[1][3] = nPiMj;
          cc[2][0] = col; cc[2][1] = nPi; cc[2][2] = nPj; cc[2][3] = nPiPj;
          cc[3][0] = col; cc[3][1] = nMi; cc[3][2] = nPj; cc[3][3] = nMiPj;
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
        // solid block resting on top of it — there is air in the gap. The
        // ordinary visibility test only asks whether the cell above is opaque,
        // so water running under an overhang lost its top face entirely and the
        // flow simply was not there to look at.
        //
        // A lower slab has the same problem for the same reason: its top sits
        // at half height with air above it inside its own cell, so whatever is
        // in the cell above cannot hide it.
        const openSurface = (rt === R_LIQUID
          && (cornerTop[0] < 1 || cornerTop[1] < 1 || cornerTop[2] < 1 || cornerTop[3] < 1))
          || (IS_SLAB[id] && !slabUp);

        // ---- outward (+k) ----
        if (faceVisible(id, at(col, k + 1)) || openSurface) {
          // kk stays an integer: it addresses cells for the light and occlusion
          // lookups below. Only the emitted corner heights are lowered.
          //
          // Sampling the layer above would be right for an ordinary top face,
          // but a surface roofed by a solid block would then read its light from
          // inside that block — every lookup opaque, so the water came out pure
          // black. Fall back to the water's own layer there.
          const kk = ((openSurface && IS_OPAQUE[at(col, k + 1)]) || (IS_SLAB[id] && !slabUp))
            ? k : k + 1;
          const cols = [
            [col, nMi, nMj, nMiMj], [col, nPi, nMj, nPiMj],
            [col, nPi, nPj, nPiPj], [col, nMi, nPj, nMiPj],
          ];
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
              // two have disagreed since corner depth was added and the shader's
              // own comment documents /7; left alone because every dScale in
              // LIQUID_MAP_FRAG was tuned by photographing surfaces that came
              // through this line, so "fixing" it here would quietly re-tune
              // seven kinds of water. Worth doing deliberately, once, with the
              // constants in front of you.
              liquidCorner[c] = Math.min(1, (sum / 4) / 6);
              liquidCornerShore[c] = Math.min(1, land / 2);
            }
            setWave(cornerWaveHi[0], cornerWaveHi[1], cornerWaveHi[2], cornerWaveHi[3]);
          }
          emit(grp, id, capTile(id, dirF, true), biomeId,
            cornerAt(f, i, j, k + cornerTop[0], _c0), cornerAt(f, i + 1, j, k + cornerTop[1], _c1),
            cornerAt(f, i + 1, j + 1, k + cornerTop[2], _c2), cornerAt(f, i, j + 1, k + cornerTop[3], _c3),
            1, 1, grainRot(id, dirF, 4));
        }

        // ---- inward (-k) ----
        // An upper slab's underside floats at half height inside its own cell,
        // so nothing below can hide it — the mirror of the lower slab's top.
        if (faceVisible(id, at(col, k - 1)) || (IS_SLAB[id] && slabUp)) {
          const kk = k + cellLo;
          const cols = [
            [col, nMi, nMj, nMiMj], [col, nMi, nPj, nMiPj],
            [col, nPi, nPj, nPiPj], [col, nPi, nMj, nPiMj],
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
            setWave(cornerWaveLo[0], cornerWaveLo[3], cornerWaveLo[2], cornerWaveLo[1]);
          }
          emit(grp, id, capTile(id, dirF, false), biomeId,
            cornerAt(f, i, j, kk, _c0), cornerAt(f, i, j + 1, kk, _c1),
            cornerAt(f, i + 1, j + 1, kk, _c2), cornerAt(f, i + 1, j, kk, _c3),
            1, 1, grainRot(id, dirF, 5));
        }

        // ---- tangential faces ----
        // +i: corners vary in j (u) and k (v)
        if (faceVisible(id, at(nPi, k))) {
          const nb = nPi;
          const nbPj = COL_NB[nb * 4 + 2], nbMj = COL_NB[nb * 4 + 3];
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMj, k - 1); setC(1, nbPj, k - 1); setC(2, nbPj, k + 1); setC(3, nbMj, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[1], cornerWaveLo[2], cornerWaveHi[2], cornerWaveHi[1]);
          }
          emit(grp, id, sideTile(id, 0, dirF), biomeId,
            cornerAt(f, i + 1, j, k + cellLo, _c0), cornerAt(f, i + 1, j + 1, k + cellLo, _c1),
            cornerAt(f, i + 1, j + 1, k + cornerTop[2], _c2),
            cornerAt(f, i + 1, j, k + cornerTop[1], _c3), 1, 1, grainRot(id, dirF, 0));
        }
        // -i
        if (faceVisible(id, at(nMi, k))) {
          const nb = nMi;
          const nbPj = COL_NB[nb * 4 + 2], nbMj = COL_NB[nb * 4 + 3];
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPj, k - 1); setC(1, nbMj, k - 1); setC(2, nbMj, k + 1); setC(3, nbPj, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[3], cornerWaveLo[0], cornerWaveHi[0], cornerWaveHi[3]);
          }
          emit(grp, id, sideTile(id, 1, dirF), biomeId,
            cornerAt(f, i, j + 1, k + cellLo, _c0), cornerAt(f, i, j, k + cellLo, _c1),
            cornerAt(f, i, j, k + cornerTop[0], _c2),
            cornerAt(f, i, j + 1, k + cornerTop[3], _c3), 1, 1, grainRot(id, dirF, 1));
        }
        // +j — corners ordered so UV.u stays tangential and UV.v runs along +k,
        // matching the other side faces (otherwise the texture is rotated 90°).
        if (faceVisible(id, at(nPj, k))) {
          const nb = nPj;
          const nbPi = COL_NB[nb * 4 + 0], nbMi = COL_NB[nb * 4 + 1];
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPi, k - 1); setC(1, nbMi, k - 1); setC(2, nbMi, k + 1); setC(3, nbPi, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[2], cornerWaveLo[3], cornerWaveHi[3], cornerWaveHi[2]);
          }
          emit(grp, id, sideTile(id, 2, dirF), biomeId,
            cornerAt(f, i + 1, j + 1, k + cellLo, _c0), cornerAt(f, i, j + 1, k + cellLo, _c1),
            cornerAt(f, i, j + 1, k + cornerTop[3], _c2),
            cornerAt(f, i + 1, j + 1, k + cornerTop[2], _c3), 1, 1, grainRot(id, dirF, 2));
        }
        // -j
        if (faceVisible(id, at(nMj, k))) {
          const nb = nMj;
          const nbPi = COL_NB[nb * 4 + 0], nbMi = COL_NB[nb * 4 + 1];
          const setC = (c, colSide, kSide) => {
            const s1 = sealsAt(colSide, k), s2 = sealsAt(nb, kSide), sc = sealsAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMi, k - 1); setC(1, nbPi, k - 1); setC(2, nbPi, k + 1); setC(3, nbMi, k + 1);
          if (rt === R_LIQUID) {
            setWave(cornerWaveLo[0], cornerWaveLo[1], cornerWaveHi[1], cornerWaveHi[0]);
          }
          emit(grp, id, sideTile(id, 3, dirF), biomeId,
            cornerAt(f, i, j, k + cellLo, _c0), cornerAt(f, i + 1, j, k + cellLo, _c1),
            cornerAt(f, i + 1, j, k + cornerTop[1], _c2),
            cornerAt(f, i, j, k + cornerTop[0], _c3), 1, 1, grainRot(id, dirF, 3));
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

function emitCross(g, f, i, j, k, col, id, biomeId, light) {
  const o = ((f * F + i) * F + j) * 3;
  const r = R_MIN + k + 0.5;
  const upx = CENTER_DIR[o], upy = CENTER_DIR[o + 1], upz = CENTER_DIR[o + 2];
  const cx = upx * r, cy = upy * r, cz = upz * r;

  // tangent basis from neighbouring corner directions so plants align with the grid
  const oa = ((f * (F + 1) + i + 1) * (F + 1) + j) * 3;
  const ob = ((f * (F + 1) + i) * (F + 1) + j) * 3;
  let t1x = CORNER_DIR[oa] - CORNER_DIR[ob];
  let t1y = CORNER_DIR[oa + 1] - CORNER_DIR[ob + 1];
  let t1z = CORNER_DIR[oa + 2] - CORNER_DIR[ob + 2];
  const l1 = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= l1; t1y /= l1; t1z /= l1;
  const t2x = upy * t1z - upz * t1y, t2y = upz * t1x - upx * t1z, t2z = upx * t1y - upy * t1x;

  const vi = col * D + k;
  const sl = light.sun[vi] / 15;
  const br = light.r[vi] / 15, bg = light.g[vi] / 15, bb = light.b[vi] / 15;
  const tint = tintOf(id, biomeId);
  const layer = TILE_SIDE[id];
  const halfW = 0.52, halfH = 0.5;

  for (let plane = 0; plane < 2; plane++) {
    const ax = plane === 0 ? t1x : t2x;
    const ay = plane === 0 ? t1y : t2y;
    const az = plane === 0 ? t1z : t2z;
    // The plane's own normal is deliberately not computed here. A cross plant
    // is shaded with the COLUMN'S UP as its normal — `g.nrm.push3(upx, upy,
    // upz)` below — so both quads and both sides of each quad take the same
    // light and a tuft of grass never has a dark half depending on which way
    // the sun is round. The true quad normal used to be worked out on every
    // plane of every plant and then dropped on the floor, which read as if the
    // shading were about to use it.
    const v0 = g.verts;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const uvp = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (let c = 0; c < 4; c++) {
      const [su, sv] = pts[c];
      g.pos.push3(
        cx + ax * su * halfW + upx * sv * halfH,
        cy + ay * su * halfW + upy * sv * halfH,
        cz + az * su * halfW + upz * sv * halfH,
      );
      g.nrm.push3(upx, upy, upz);
      g.tan.push3(ax, ay, az);
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
