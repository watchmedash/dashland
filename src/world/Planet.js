// Main-thread view of the cubesphere: a mirror of the voxel array for physics
// and raycasting, plus the chunk meshes streamed in from the worker.

import * as THREE from 'three';
import {
  F, D, R_MIN, COLUMNS, CELLS, cidx, chunkIdx, CHUNK_T, CHUNK_K, CK,
  NUM_REGIONS, REGION_COLS, REGION_VOXELS, regionOfCol, regionColumns,
} from './Constants.js';
import { worldToCell, centerDir, cellIndex, COL_BASE, COL_STEP } from './Sphere.js';
import {
  IS_SOLID, RENDER_TYPE, R_LIQUID, R_CROSS, IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, FACING_DEFAULT,
  plantMask, plantBox, PLANT_MASK_N,
} from './Blocks.js';
import { GROUP_OPAQUE, GROUP_CUTOUT, GROUP_LIQUID } from './Mesher.js';

const _cell = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 };
const _p = [0, 0, 0];

/**
 * Drop a vertex buffer's CPU copy once the driver has taken it.
 *
 * Chunk geometry is written once by the mesher, uploaded once, and never read
 * on this side again: nothing in `src/` touches a chunk's attributes after
 * `applyChunk` builds them (the only `geometry.attributes` reads in the game
 * are the highlight box and the fishing line, neither of which is chunk
 * geometry, and the GTAO cutout proxy asks whether `aux` *exists*, not what is
 * in it). The raycast marches `this.blocks`, not triangles, and a changed chunk
 * is remeshed from scratch rather than patched in place — so the array sitting
 * behind each attribute is a duplicate of what is already in VRAM. Measured on
 * a settled 2 666-mesh view: 21 328 buffers, 90 bytes per vertex (84 of
 * attributes plus 6 of index) over 2 839 896 vertices, 243.8 MiB of main heap
 * that nothing would ever read.
 *
 * The price is a re-mesh if the WebGL context is ever lost, because the arrays
 * needed to re-upload are gone. Worth being plain about it: this game has no
 * context-loss handling at all today — there is no `webglcontextlost` or
 * `webglcontextrestored` listener anywhere in the source — so a lost context
 * already ends the session, with or without this. It is a cost to pay when
 * somebody writes that handler, not one being incurred now.
 */
function discardArray() { this.array = null; }

/**
 * Half-thickness, in cells, given to a cross plant's quads by the raycast.
 *
 * `emitCross` builds two flat quads through the middle of the cell: one
 * spanning the i axis and standing at the middle of j, the other spanning j and
 * standing at the middle of i, both the full height of the cell. In continuous
 * cell coordinates that is exactly the two planes `frac(ci) = 0.5` and
 * `frac(cj) = 0.5` — which is the whole reason this test lives in cell space
 * rather than world space. The planet is a cubesphere: those "planes" are
 * curved sheets in world space and no world-axis-aligned box describes them,
 * but `worldToCell` has already done that mapping for the marcher, so the test
 * is two subtractions on numbers we are holding anyway.
 *
 * A true ray/quad intersection was considered and rejected. The marcher is a
 * sampler, not a DDA — it has no entry and exit point for the cell to solve
 * between, and cell space along the ray is not linear, so an "exact" solve
 * would need its own root-find per plant. This is cast every frame for the
 * crosshair label, so instead the zero-thickness quads are given a thickness
 * and the existing samples are asked whether any of them land in it. At a step
 * of 0.045 and a cell arc near 0.95 world units, 0.15 cells is about six
 * samples deep at the worst (perpendicular) incidence, so a plant is never
 * missed; a grazing ray only spends longer inside.
 *
 * This is only the *slab*, though, and a slab is not a plant. Two things used
 * to be wrong with stopping here, and both were reported from the field —
 * "those transparent parts is blocking the crosshair", from a player trying to
 * name something behind a tuft of grass:
 *
 *  - The *texture* was ignored, so the transparent gaps within a plant's own
 *    quad counted as the plant. Measured on the baked atlas, `tall_grass` fills
 *    17.6% of its tile and reaches only two thirds of the way up it, so the
 *    picker was claiming most of a cell of empty sky for every tuft. The gaps
 *    are the whole complaint, and they are now read straight off the tile's
 *    alpha — see `setPlantMasks`. This comment used to argue that sampling the
 *    atlas per step was "far past what a per-frame label is worth"; that
 *    judgement was made without measuring either side of it. It is one byte
 *    read off a 1 KB array per step.
 *
 *  - Two thirds of the plants on this planet are not billboards at all. The
 *    flowers, the sixteen land flora, the reef and the six modelled crops are
 *    drawn as WAM model instances and the mesher emits no quad for them, so the
 *    plus prism above was never even the right *family* of shape for them: a
 *    clover is a third of a cell tall and a third across, and the whole cell is
 *    eight times its footprint. Those take a cylinder measured off the model
 *    itself instead — see `plantBox`.
 *
 * Both shapes are optional. Before the atlas has decoded and the models have
 * loaded there is nothing to consult, and the plus prism below is what a plant
 * gets; it is forgiving rather than tight, which is the right way round for a
 * fallback.
 *
 * The half-thickness came down with the texture test, from 0.15 to 0.10. It is
 * now only depth — how far either side of a zero-thickness quad a sample still
 * counts — because the silhouette is the mask's job, and 0.10 is still 4.2
 * samples deep at the worst incidence.
 *
 * What this is worth, measured. Casting one ray per screen pixel over an 80x45
 * grid from standing height, the share of the whole screen that named a plant
 * rather than what was behind it: meadow 21.8% -> 11.2%, plains 33.9% -> 21.8%,
 * tundra 10.7% -> 3.8%, savanna 6.8% -> 5.2%. Against the plant's own drawn
 * silhouette, one plant on cleared ground and the frame diffed against the same
 * frame with the cell set to air, the picker claimed 2.1x the pixels a tuft of
 * grass covers and 8.4x a clover's; it now claims 1.4x and 2.4x. Aimed at the
 * plant instead of past it, every plant tested is still picked and broken from
 * one, two and three cells away, over a two-degree cone of aim error.
 */
const CROSS_HALF = 0.10;

/**
 * How wide `emitCross` actually builds a quad, in cells. Slightly over one, so
 * a row of plants has no gap in it; the mask is stretched over the same span or
 * the silhouette would be read a texel out at the edges.
 */
const CROSS_SPAN = 1.04;

/** Where along a quad's width, 0..1 of the way across the mask, a sample sits. */
function maskCol(u, n) {
  const x = ((u / CROSS_SPAN + 0.5) * n) | 0;
  return x < 0 ? 0 : (x >= n ? n - 1 : x);
}

/** Is this sample point inside the plant that is drawn here? See `CROSS_HALF`. */
function insideCross(id, c, i, j) {
  const di = c.ci - i - 0.5, dj = c.cj - j - 0.5;
  const dk = c.ck - Math.floor(c.ck);

  // A modelled plant: its own bounding cylinder, standing on the cell floor.
  const box = plantBox(id);
  if (box) return dk <= box.top && di * di + dj * dj <= box.r2;

  const near_i = Math.abs(di) <= CROSS_HALF;   // near the quad that spans j
  const near_j = Math.abs(dj) <= CROSS_HALF;   // near the quad that spans i
  if (!near_i && !near_j) return false;

  const mask = plantMask(id);
  if (!mask) return true;
  const N = PLANT_MASK_N;
  // `emitCross` gives the quad's bottom edge v = 1 and its top edge v = 0, and
  // the atlas is uploaded unflipped, so row 0 of the tile is the top of the
  // cell. That is the row a grass tile is empty in.
  let row = ((1 - dk) * N) | 0;
  if (row < 0) row = 0; else if (row >= N) row = N - 1;
  // The quad spanning i is the one standing at the middle of j, so it is the
  // one a sample near `dj = 0` is on, and `di` is the distance along it.
  if (near_j && mask[row * N + maskCol(di, N)]) return true;
  if (near_i && mask[row * N + maskCol(dj, N)]) return true;
  return false;
}

export class Planet {
  constructor(materials) {
    this.blocks = new Uint8Array(CELLS);
    this.colBiome = new Uint8Array(COLUMNS);
    /**
     * Sparse side-table for directional blocks: cell index (`col * D + k`, the
     * same indexing `blocks` uses) → facing 0..3. Only a handful of cells are
     * ever in here, so none of the hot paths — mesher, lighting, physics,
     * raycast — pay for it, and packing facing bits into the block byte (which
     * would put a mask in all of them) is avoided.
     */
    this.facing = new Map();
    this.materials = materials;
    this.root = new THREE.Group();
    this.root.name = 'planet';
    this.opaqueRoot = new THREE.Group();
    this.cutoutRoot = new THREE.Group();
    this.transRoot = new THREE.Group();
    this.liquidRoot = new THREE.Group();
    this.transRoot.renderOrder = 5;
    this.liquidRoot.renderOrder = 6;
    this.root.add(this.opaqueRoot, this.cutoutRoot, this.transRoot, this.liquidRoot);
    this.meshes = new Map();
    this.center = new THREE.Vector3(0, 0, 0);
    /**
     * The mirror is full-sized from the start but only partly filled.
     *
     * The worker builds the planet a region at a time and posts each one over
     * as it is made, so `blocks` is authoritative only where `live` says it is.
     * Everywhere else it is zeroes, which reads as air — and air is exactly the
     * wrong default for physics, because the player would walk off a cliff into
     * a region that has not been built rather than onto ground that has not
     * arrived yet. `liveAt` is what the few places that could be asked about
     * ungenerated ground use to tell the two apart; everything else is safe
     * because the streamer keeps a hundred and fifty units of built world
     * around the player at all times and nothing in the game reaches that far.
     */
    this.live = new Uint8Array(NUM_REGIONS);
    /**
     * Which regions have had a byte written into them, as distinct from `live`,
     * which is which have been *generated*.
     *
     * They are nearly the same set and must not be conflated: `live` is what
     * physics consults to tell built ground from ground that has not arrived,
     * and marking a region live because something wrote one voxel into it would
     * be a lie in exactly the direction that walks the player off a cliff. This
     * is only ever asked "is any of this region non-zero", which is what
     * `resetWorld` needs and nothing else does.
     *
     * Maintained in the two places that write `blocks` and nowhere else —
     * `applyRegions` and `setAt`. Nothing outside this file touches the array:
     * every `planet.blocks[...]` in `src/` is a read.
     */
    this._written = new Uint8Array(NUM_REGIONS);
    /** Height field for the whole planet — cheap, eager, and always complete. */
    this.colHeight = new Float32Array(COLUMNS);
  }

  /** The per-column tables, which arrive complete before any voxel does. */
  setGlobals(colBiome, colHeight) {
    this.colBiome = colBiome;
    this.colHeight = colHeight;
    this._buildFootprintFloor();
  }

  /**
   * The lowest worldgen ground radius under each chunk footprint, so the
   * streamer can tell a buried chunk from one on the skin of the planet.
   *
   * A chunk footprint is exactly a region's footprint — `chunkIdx` is
   * `regionIdx * CK + ck` — so this is one float per region, 5 046 of them,
   * built once from a height field that arrives complete before any voxel does.
   * Taking the *minimum* over the 256 columns rather than the mean is the safe
   * direction: a footprint that straddles a canyon rim reports the canyon floor,
   * so the wall the player can see across the gorge is never called buried.
   *
   * `colHeight` is the terrain surface before caves are carved and before
   * anything is stamped on top of it. Both of those errors point the same, safe
   * way. Trees, ruins and player builds stand *above* it, so they only make this
   * an underestimate of where the real surface is, which classifies fewer chunks
   * as buried. Caves cut *below* it, and cave walls are precisely the geometry
   * this is here to find.
   */
  _buildFootprintFloor() {
    const floor = this._footFloor || (this._footFloor = new Float32Array(NUM_REGIONS));
    const h = this.colHeight;
    const tmp = new Int32Array(REGION_COLS);
    for (let rid = 0; rid < NUM_REGIONS; rid++) {
      regionColumns(rid, tmp);
      let lo = Infinity;
      for (let n = 0; n < REGION_COLS; n++) { const v = h[tmp[n]]; if (v < lo) lo = v; }
      floor[rid] = lo;
    }
  }

  /**
   * Is this chunk entirely under the ground of its own footprint?
   *
   * "Entirely" means its top face, `R_MIN + (ck + 1) * CHUNK_K`, is still a
   * whole chunk's depth below the lowest column in it — so there is always at
   * least one fully built chunk of geometry between the lowest worldgen ground
   * over a footprint and the first chunk this will call buried. The streamer
   * gives these a much shorter leash; see `_streamChunks`.
   */
  chunkBuried(id) {
    const floor = this._footFloor;
    if (!floor) return false;
    const ck = id % CK;
    return R_MIN + (ck + 1) * CHUNK_K < floor[(id - ck) / CK] - CHUNK_K;
  }

  /**
   * Wipe the mirror between worlds. The arrays are kept; only the data goes.
   *
   * Region by region rather than `blocks.fill(0)` over the whole array, and the
   * reason is residency rather than the memset. The mirror is 122 MB of which a
   * session touches the regions it has actually streamed — about 10 MB after a
   * first load — and a full-array fill writes every page of it, so the process
   * holds the whole thing resident for the rest of the run whatever the player
   * does. Measured on this machine, writing one byte per 4 KB page of an array
   * this size costs 129 MB of working set. This runs on every new game and every
   * save load, so it was not an edge case: it was the reason the mirror was
   * always fully resident.
   *
   * Exact, not an optimisation that mostly holds. `_written` is set by both
   * writers of `blocks` and by nothing else, so a region it does not name has
   * never been written since the last reset and is still the zeroes the array
   * was allocated with.
   */
  resetWorld() {
    const tmp = new Int32Array(REGION_COLS);
    for (let rid = 0; rid < NUM_REGIONS; rid++) {
      if (!this._written[rid]) continue;
      regionColumns(rid, tmp);
      // Sixteen contiguous runs, not 256, for the reason `applyRegions` gives.
      for (let row = 0; row < CHUNK_T; row++) {
        const base = tmp[row * CHUNK_T] * D;
        this.blocks.fill(0, base, base + CHUNK_T * D);
      }
    }
    this._written.fill(0);
    this.live.fill(0);
    this.facing.clear();
  }

  /**
   * Copy freshly generated regions into the mirror.
   *
   * A region's 256 columns are sixteen contiguous runs in the block array — the
   * ones sharing an `i` are consecutive — so this is sixteen copies per region
   * rather than 256. Both ends of the wire pack it the same way.
   * @param {(rid:number) => void} onRegion called once per region, after it lands
   */
  applyRegions(ids, data, onRegion) {
    const tmp = new Int32Array(REGION_COLS);
    for (let n = 0; n < ids.length; n++) {
      const rid = ids[n];
      regionColumns(rid, tmp);
      // The wire format is still (column, layer) packed; storage is not, so
      // this is a scatter rather than a contiguous set.
      let o = n * REGION_VOXELS;
      for (let c = 0; c < REGION_COLS; c++) {
        const col = tmp[c];
        const base = COL_BASE[col], step = COL_STEP[col];
        for (let k = 0; k < D; k++) this.blocks[base + k * step] = data[o + k];
        o += D;
      }
      this.live[rid] = 1;
      this._written[rid] = 1;
      onRegion?.(rid);
    }
  }

  /** Has this column been generated? */
  liveCol(col) { return this.live[regionOfCol(col)] === 1; }

  // Two more were deleted from here rather than kept: `liveAt(x, y, z)`, the
  // world-space spelling of `liveCol` that nothing ever asked in world space,
  // and `setWorld`, the pre-streaming whole-planet handover. `setWorld` marked
  // every region live and replaced the facing map wholesale, which is exactly
  // the state a lazily built planet must never be put into, and it had carried a
  // "nothing calls it now" note for long enough to prove nothing would.

  // --- directional facing ---------------------------------------------------

  /**
   * The cell's side-table byte, or 0 when it has none. Zero is the correct
   * default for every meaning the byte carries — upright log, lower slab,
   * untouched water — and collision reads this on the hot path, so it must not
   * hand back undefined.
   */
  facingAt(col, k) { return this.facing.get(cellIndex(col, k)) ?? 0; }

  /**
   * Keep the side-table in step with an edit. Directional blocks keep (or take)
   * a facing; anything else drops the entry, so a broken or replaced block can
   * never leave a stale facing behind for whatever is placed there next.
   * @returns {number} the facing now stored, or -1 if the cell has none
   */
  applyFacing(col, k, id, want) {
    const idx = cellIndex(col, k);
    // Logs store an axis here rather than a horizontal facing, water stores its
    // flow level, and a shaped block stores its orientation. Same table,
    // different meaning per block — a cell is never two of those things at once.
    //
    // This asks IS_SHAPED rather than naming slabs alone. Naming them is what
    // dropped stairs: they are neither axis, slab, liquid nor directional, so
    // every placed stair fell through to the delete below and read back as the
    // default orientation. The worker's own copy of this test had the identical
    // gap, so the byte was being discarded at both ends of the wire.
    if (IS_AXIS[id] || IS_SHAPED[id] || RENDER_TYPE[id] === R_LIQUID) {
      const a = want ?? this.facing.get(idx) ?? 0;
      if (a) this.facing.set(idx, a & 7); else this.facing.delete(idx);
      return a & 7;
    }
    if (!IS_DIRECTIONAL[id]) { this.facing.delete(idx); return -1; }
    const v = (want ?? this.facing.get(idx) ?? FACING_DEFAULT) & 3;
    this.facing.set(idx, v);
    return v;
  }

  /** Serialisable form: a plain array of [cellIndex, facing] pairs. */
  facingPairs() { return [...this.facing]; }

  // --- voxel access ---------------------------------------------------------

  at(col, k) { return (k < 0 || k >= D) ? 0 : this.blocks[COL_BASE[col] + k * COL_STEP[col]]; }
  // The second of the two writers, so it carries the `_written` mark too. An
  // edit almost always lands in a region `applyRegions` has already marked; the
  // mark is here so `resetWorld` stays correct without having to assume that.
  setAt(col, k, id) {
    if (k < 0 || k >= D) return;
    this.blocks[COL_BASE[col] + k * COL_STEP[col]] = id;
    this._written[regionOfCol(col)] = 1;
  }
  solidAt(col, k) { return (k < 0 || k >= D) ? false : IS_SOLID[this.blocks[COL_BASE[col] + k * COL_STEP[col]]] === 1; }
  liquidAt(col, k) { return (k < 0 || k >= D) ? false : RENDER_TYPE[this.blocks[COL_BASE[col] + k * COL_STEP[col]]] === R_LIQUID; }

  /** Continuous cell coordinates for a world point. */
  cellOf(x, y, z, out = _cell) { return worldToCell(x, y, z, out); }

  /** Integer cell address for a world point, or null if off-world. */
  cellAt(x, y, z) {
    const c = worldToCell(x, y, z, _cell);
    const k = Math.floor(c.ck);
    if (k < 0 || k >= D) return null;
    const i = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
    const j = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
    return { col: cidx(c.f, i, j), k, f: c.f, i, j };
  }

  blockAtWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? this.at(a.col, a.k) : 0;
  }

  isSolidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? this.solidAt(a.col, a.k) : false;
  }

  isLiquidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? this.liquidAt(a.col, a.k) : false;
  }

  // `upAt(pos)` and `radiusAt(pos)` lived here and were deleted: on a planet
  // centred at the origin they are `pos.clone().normalize()` and `pos.length()`,
  // and every caller in the game writes those directly rather than reaching for
  // the planet to do it. A method that only restates a vector operation reads
  // like it knows something about the world, and this one did not.

  /**
   * Highest non-air, non-water layer in a column — the *ground*, not the top of
   * what is standing on it.
   *
   * Read that twice before using it near water. On a lake or a sea this is the
   * bed, and the water is at `surfaceK(col) + 1`; `liquidAt(col, surfaceK(col))`
   * is therefore the sand, and always false. That has now caused a shipped bug
   * (winter ice scanned from the wrong layer and froze nothing) and two
   * measurements that confidently reported a planet with no water on it, on a
   * planet that is a fifth water.
   *
   * Leaves and logs are not air either, so under a tree this is the canopy top
   * rather than the soil.
   */
  surfaceK(col) {
    const base = COL_BASE[col], step = COL_STEP[col];
    for (let k = D - 1; k >= 0; k--) {
      const b = this.blocks[base + k * step];
      if (b !== 0 && RENDER_TYPE[b] !== R_LIQUID) return k;
    }
    return -1;
  }

  // `surfaceRadiusDir(dir)` was deleted from here: a no-caller helper that took
  // a direction and returned the radius of the ground under it. It leaned on
  // `worldToCell` being scale-free in f/i/j by pushing the direction out to
  // radius 40 — a point 210 units below layer 0, whose `ck` is meaningless and
  // was duly ignored — which is a thing a reader has to work out before they can
  // trust the two lines around it. `surfaceK` takes a column and everyone who
  // wants ground already has one.

  /** Cell centre in world space. */
  centerOf(col, k, out = new THREE.Vector3()) {
    const f = (col / (F * F)) | 0;
    const rem = col - f * F * F;
    centerDir(f, (rem / F) | 0, rem % F, _p);
    const r = R_MIN + k + 0.5;
    return out.set(_p[0] * r, _p[1] * r, _p[2] * r);
  }

  // --- chunk meshes ---------------------------------------------------------

  applyChunk(f, ci, cj, ck, groups) {
    const id = chunkIdx(f, ci, cj, ck);
    const roots = [this.opaqueRoot, this.cutoutRoot, this.transRoot, this.liquidRoot];
    const mats = [this.materials.opaque, this.materials.cutout, this.materials.transparent, this.materials.liquid];

    for (let gi = 0; gi < 4; gi++) {
      const key = `${id}:${gi}`;
      const payload = groups[gi];
      let mesh = this.meshes.get(key);

      if (!payload) {
        if (mesh) {
          roots[gi].remove(mesh);
          mesh.geometry.dispose();
          this.meshes.delete(key);
        }
        continue;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3));
      geo.setAttribute('atangent', new THREE.BufferAttribute(payload.tangent, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));
      geo.setAttribute('aux', new THREE.BufferAttribute(payload.aux, 4));
      geo.setAttribute('blockLight', new THREE.BufferAttribute(payload.blockLight, 3));
      geo.setAttribute('tint', new THREE.BufferAttribute(payload.tint, 3));
      geo.setAttribute('quadSize', new THREE.BufferAttribute(payload.quadSize, 2));
      geo.setIndex(new THREE.BufferAttribute(payload.index, 1));
      // Before the arrays are released: this is the one thing on the main thread
      // that does read them, and the sphere it computes is what frustum culling
      // and the shadow map use for the life of the mesh.
      geo.computeBoundingSphere();
      for (const name in geo.attributes) geo.attributes[name].onUpload(discardArray);
      geo.index.onUpload(discardArray);

      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        mesh = new THREE.Mesh(geo, mats[gi]);
        mesh.castShadow = gi === GROUP_OPAQUE || gi === GROUP_CUTOUT;
        // A cutout casts the shape of its art, not the shape of its quad. Without
        // this the shadow pass uses a plain MeshDepthMaterial, which cannot read
        // the tile atlas, and a grass tuft lays down two solid slabs.
        if (gi === GROUP_CUTOUT && this.materials.cutoutDepth) {
          mesh.customDepthMaterial = this.materials.cutoutDepth;
        }
        mesh.receiveShadow = gi !== GROUP_LIQUID;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        roots[gi].add(mesh);
        this.meshes.set(key, mesh);
      }
    }
  }

  /** Free every mesh belonging to one chunk. Used by the streamer on eviction. */
  dropChunk(id) {
    for (let gi = 0; gi < 4; gi++) {
      const key = `${id}:${gi}`;
      const mesh = this.meshes.get(key);
      if (!mesh) continue;
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(key);
    }
  }

  clearMeshes() {
    for (const mesh of this.meshes.values()) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
  }

  // --- raycast --------------------------------------------------------------

  /**
   * March a ray through the sphere. Steps are small enough that no cell is
   * skipped, and the previous cell is remembered so blocks can be placed
   * against the face that was hit.
   *
   * Cross plants (tall grass, flowers, wheat) are the one block that is *not*
   * treated as a full cell: see `CROSS_HALF` below.
   * @returns {{col,k,prevCol,prevK,id,dist,point:THREE.Vector3,normal:THREE.Vector3}|null}
   */
  raycast(origin, dir, maxDist = 6, opts = {}) {
    const step = 0.045;
    let prevCol = -1, prevK = -1;
    let curCol = -1, curK = -1;
    let curCross = false;
    const hitLiquid = !!opts.hitLiquid;

    for (let t = 0; t <= maxDist; t += step) {
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const c = worldToCell(x, y, z, _cell);
      const k = Math.floor(c.ck);
      if (k < 0 || k >= D) { prevCol = -1; prevK = -1; curCross = false; continue; }
      const i = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
      const j = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
      const col = cidx(c.f, i, j);
      const id = this.at(col, k);
      if (col === curCol && k === curK) {
        // Every other block fills its cell, so entering it once is enough to
        // decide. A cross plant does not, so keep sampling it — the test below
        // is per-point, not per-cell.
        if (!curCross) continue;
      } else {
        prevCol = curCol; prevK = curK;
        curCol = col; curK = k;
        curCross = RENDER_TYPE[id] === R_CROSS;
      }

      if (id === 0) continue;
      if (RENDER_TYPE[id] === R_LIQUID && !hitLiquid) continue;
      if (curCross && !insideCross(id, c, i, j)) continue;

      const point = new THREE.Vector3(x, y, z);
      const normal = new THREE.Vector3();
      if (prevCol >= 0) {
        this.centerOf(prevCol, prevK, normal).sub(this.centerOf(col, k, new THREE.Vector3())).normalize();
      } else {
        normal.copy(point).normalize();
      }
      return { col, k, prevCol, prevK, id, dist: t, point, normal };
    }
    return null;
  }
}
