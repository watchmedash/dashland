// Cubesphere chunk mesher. Each cell face becomes a quad whose four corners
// come from the exact sphere mapping, so neighbouring chunks share vertices and
// the surface curves smoothly with no cracks. Radial (side) faces merge along
// the column axis, which is perfectly straight, so merging introduces no error.

import {
  F, D, CHUNK_T, CHUNK_K, R_MIN, vidx, cidx, BIOME_COLORS,
} from './Constants.js';
import { CORNER_DIR, CENTER_DIR, COL_NB, stepColumn } from './Sphere.js';
import {
  BLOCKS, N_BLOCKS, IS_OPAQUE, IS_LEAF, RENDER_TYPE, TILE_TOP, TILE_SIDE, TILE_BOTTOM,
  TINT_ID, R_CROSS, R_LIQUID, R_GLASS, R_LADDER, R_TORCH, IS_DIRECTIONAL, IS_AXIS, IS_SLAB, IS_SHAPED,
  IS_SUBMERGED,
  FACING_DEFAULT, sideTile, capTile, axisOf, blockBoxes, IS_FENCE, fenceLinks,
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

const WAVE = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (b.render === R_CROSS) WAVE[i] = 1;
  else if (b.name === 'water') WAVE[i] = 2;
  else if (b.name === 'lava') WAVE[i] = 3;
  else if (b.name.startsWith('leaves')) WAVE[i] = 4;
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
for (const n of ['flower_red', 'flower_blue', 'flower_gold', 'mushroom',
  // The reef. Unlike the flowers these have no billboard to fall back on —
  // they were authored as models and carry no tile of their own — so this list
  // and `MODELLED_PLANTS` in `main.js` have to agree or the seabed is empty:
  // a name here and not there draws nothing at all.
  'coral_branch', 'coral_fan', 'coral_brain', 'coral_dead',
  'kelp', 'sea_grass', 'sea_sponge', 'sea_shell',
  // The two edible plants and the deep light, on exactly the same footing.
  'sea_lettuce', 'sea_grape', 'abyss_anemone']) {
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
    this.idxb = new IBuf(); this.verts = 0;
  }
  get empty() { return this.verts === 0; }
  serialize() {
    return {
      position: this.pos.out(), normal: this.nrm.out(), tangent: this.tan.out(),
      uv: this.uv.out(), aux: this.aux.out(), blockLight: this.blk.out(),
      tint: this.tint.out(), index: this.idxb.out(),
    };
  }
}

// --- helpers ----------------------------------------------------------------

/**
 * For liquids the tint attribute is repurposed: x carries normalised water
 * depth and y a shoreline flag, which is what the liquid shader needs to grade
 * shallow-to-deep colour and lay foam along the coast.
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

function faceVisible(a, b) {
  if (a === 0) return false;
  if (IS_OPAQUE[b]) return false;
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
 * @param {{sun,r,g,b}} light
 * @param {Map<number,number>} facing sparse cell index —  facing 0..3; only
 *   directional blocks have an entry, so this is never touched for ordinary
 *   terrain.
 * @returns {{groups: Array, crossLight: Uint32Array|null}} the four render
 *   groups as before, plus the baked light of every modelled-cross cell in this
 *   chunk (null when there are none). See CROSS_LIGHT_ADDR_SHIFT.
 */
export function meshChunk(blocks, colBiome, light, facing, f, ci, cj, ck) {
  const groups = [new Group(), new Group(), new Group(), new Group()];
  const crossLight = new CrossLightBuf();
  const i0 = ci * CHUNK_T, j0 = cj * CHUNK_T, k0 = ck * CHUNK_K;
  const i1 = Math.min(F, i0 + CHUNK_T), j1 = Math.min(F, j0 + CHUNK_T), k1 = Math.min(D, k0 + CHUNK_K);
  const { sun, r: lr, g: lg, b: lb } = light;

  // sample a voxel's block id through the adjacency graph
  const at = (col, k) => (k < 0 || k >= D ? 0 : blocks[col * D + k]);
  const opaqueAt = (col, k) => (k < 0 || k >= D ? 0 : IS_OPAQUE[blocks[col * D + k]]);

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
  let liquidDepth = 0, liquidShore = 0;
  // per-corner water depth, so the shallow-to-deep gradient and the foam band
  // interpolate across the surface instead of stepping block by block
  const liquidCorner = [0, 0, 0, 0];
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
      ? [liquidDepth, liquidShore, 0]
      : tintOf(id, biomeId);
    const wave = WAVE[id];
    const uv = [[0, 0], [uMax, 0], [uMax, vMax], [0, vMax]];
    const pts = [p0, p1, p2, p3];
    const v0 = g.verts;
    for (let c = 0; c < 4; c++) {
      g.pos.push3(pts[c][0], pts[c][1], pts[c][2]);
      g.nrm.push3(_n[0], _n[1], _n[2]);
      g.tan.push3(_t[0], _t[1], _t[2]);
      g.uv.push2(uv[(c + uvRot) & 3][0], uv[(c + uvRot) & 3][1]);
      g.aux.push4(layer, AO_CURVE[aoData[c]], cornerData[c][0], wave === 0 ? 0 : wave + 0.99);
      g.blk.push3(cornerData[c][1], cornerData[c][2], cornerData[c][3]);
      if (useCornerDepth) g.tint.push3(liquidCorner[c], tint[1], 0);
      else g.tint.push3(tint[0], tint[1], tint[2]);
    }
    g.idxb.quad(v0);
    g.verts += 4;
    useCornerDepth = false;
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
          if (IS_OPAQUE[at(nPi, k)]) walled++;
          if (IS_OPAQUE[at(nMi, k)]) walled++;
          if (IS_OPAQUE[at(nPj, k)]) walled++;
          if (IS_OPAQUE[at(nMj, k)]) walled++;
          if (IS_OPAQUE[at(col, k - 1)]) walled++;
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
            // Drop any face that coincides with another box of the same block.
            for (let o = 0; o < boxes.length; o++) {
              if (o === b) continue;
              const [oi0, oj0, ok0, oi1, oj1, ok1] = boxes[o];
              const iOv = Math.min(bi1, oi1) > Math.max(bi0, oi0);
              const jOv = Math.min(bj1, oj1) > Math.max(bj0, oj0);
              const kOv = Math.min(bk1, ok1) > Math.max(bk0, ok0);
              if (jOv && kOv && bi1 === oi0) skip.pi = 1;
              if (jOv && kOv && bi0 === oi1) skip.mi = 1;
              if (iOv && kOv && bj1 === oj0) skip.pj = 1;
              if (iOv && kOv && bj0 === oj1) skip.mj = 1;
              if (iOv && jOv && bk1 === ok0) skip.up = 1;
              if (iOv && jOv && bk0 === ok1) skip.dn = 1;
            }
            // A face flush with the cell wall can still be hidden by a solid
            // neighbour, exactly as a full cube's would be.
            if (bi1 === 1 && IS_OPAQUE[at(nPi, k)]) skip.pi = 1;
            if (bi0 === 0 && IS_OPAQUE[at(nMi, k)]) skip.mi = 1;
            if (bj1 === 1 && IS_OPAQUE[at(nPj, k)]) skip.pj = 1;
            if (bj0 === 0 && IS_OPAQUE[at(nMj, k)]) skip.mj = 1;
            if (bk1 === 1 && IS_OPAQUE[at(col, k + 1)]) skip.up = 1;
            if (bk0 === 0 && IS_OPAQUE[at(col, k - 1)]) skip.dn = 1;
            emitBox(grp, id, biomeId, f, i, j, k,
              [bi0, bj0, bk0], [bi1, bj1, bk1], -1, skip, boxes[b][6]);
          }
          continue;
        }

        const slabUp = 0;
        const cellLo = 0;

        if (rt === R_LIQUID) {
          cornerTop[0] = liquidCornerTop([col, nMi, nMj, nMiMj], k);
          cornerTop[1] = liquidCornerTop([col, nPi, nMj, nPiMj], k);
          cornerTop[2] = liquidCornerTop([col, nPi, nPj, nPiPj], k);
          cornerTop[3] = liquidCornerTop([col, nMi, nPj, nMiPj], k);
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
            const s1 = opaqueAt(cols[c][1], kk), s2 = opaqueAt(cols[c][2], kk), sc = opaqueAt(cols[c][3], kk);
            aoData[c] = ao(s1, s2, sc);
            cornerLight(cols[c], [kk, kk, kk, kk], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          }
          if (rt === R_LIQUID) {
            useCornerDepth = true;
            for (let c = 0; c < 4; c++) {
              let sum = 0;
              for (let q = 0; q < 4; q++) sum += depthOf(cols[c][q], k);
              liquidCorner[c] = Math.min(1, (sum / 4) / 6);
            }
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
            const s1 = opaqueAt(cols[c][1], below), s2 = opaqueAt(cols[c][2], below), sc = opaqueAt(cols[c][3], below);
            aoData[c] = ao(s1, s2, sc);
            cornerLight(cols[c], [below, below, below, below], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
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
            const s1 = opaqueAt(colSide, k), s2 = opaqueAt(nb, kSide), sc = opaqueAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMj, k - 1); setC(1, nbPj, k - 1); setC(2, nbPj, k + 1); setC(3, nbMj, k + 1);
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
            const s1 = opaqueAt(colSide, k), s2 = opaqueAt(nb, kSide), sc = opaqueAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPj, k - 1); setC(1, nbMj, k - 1); setC(2, nbMj, k + 1); setC(3, nbPj, k + 1);
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
            const s1 = opaqueAt(colSide, k), s2 = opaqueAt(nb, kSide), sc = opaqueAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbPi, k - 1); setC(1, nbMi, k - 1); setC(2, nbMi, k + 1); setC(3, nbPi, k + 1);
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
            const s1 = opaqueAt(colSide, k), s2 = opaqueAt(nb, kSide), sc = opaqueAt(colSide, kSide);
            aoData[c] = ao(s1, s2, sc);
            cornerLight([nb, colSide, nb, colSide], [k, k, kSide, kSide], lv);
            cornerData[c][0] = lv[0]; cornerData[c][1] = lv[1]; cornerData[c][2] = lv[2]; cornerData[c][3] = lv[3];
          };
          setC(0, nbMi, k - 1); setC(1, nbPi, k - 1); setC(2, nbPi, k + 1); setC(3, nbMi, k + 1);
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

const _cp = [0, 0, 0];
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
    const nx = plane === 0 ? t2x : -t1x;
    const ny = plane === 0 ? t2y : -t1y;
    const nz = plane === 0 ? t2z : -t1z;
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
      g.aux.push4(layer, 1.0, sl, 1 + (sv > 0 ? 0.99 : 0.04));
      g.blk.push3(br, bg, bb);
      g.tint.push3(tint[0], tint[1], tint[2]);
    }
    g.idxb.quad(v0);
    g.verts += 4;
  }
}
