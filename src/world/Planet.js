// Main-thread view of the flat map: a mirror of the voxel array for physics and
// raycasting, plus the chunk meshes streamed in from the worker.
//
// THE AXIS CONVENTION lives in Grid.js and is not restated here. In short: map
// x is world X, layer k is world Y and up is +Y everywhere, map y is world Z, a
// cell's centre is `(x + 0.5, k + 0.5, y + 0.5)`. Storage is `col * D + k` with
// `col = x * W + y`, column major, and both map axes wrap.
//
// What that deletes, against the cube this replaces: the fold, `normalizeCell`,
// `cellWrite` and the Chebyshev ownership rule, `COL_BASE`/`COL_STEP` (a column
// is contiguous now, so the base is `col * D` and the step is 1), the per-face
// normal used as a ray fallback, and `centerOf` as a direction times a radius.

import * as THREE from 'three';
import {
  W, D, COLUMNS, CELLS, CHUNK_T, CHUNK_K, CK,
  NUM_REGIONS, REGION_COLS, regionOfCol, regionColumns, chunkIdx, contCell,
  nearOffset,
} from './Layout.js';
import { wrap } from './Grid.js';
import {
  IS_SOLID, BLOCKS_MOTION, RENDER_TYPE, R_LIQUID, R_CROSS, IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, FACING_DEFAULT,
  plantMask, plantBox, PLANT_MASK_N, ID,
} from './Blocks.js';
import { GROUP_OPAQUE, GROUP_CUTOUT, GROUP_LIQUID } from './Mesher.js';

const _cell = { cx: 0, cy: 0, ck: 0 };

/** The divider, hoisted so the raycast's inner loop is an integer compare. */
const PORTAL_ID = ID.portal;

/**
 * Drop a vertex buffer's CPU copy once the driver has taken it.
 *
 * Chunk geometry is written once by the mesher, uploaded once, and never read
 * on this side again: the raycast marches `this.blocks`, not triangles, and a
 * changed chunk is remeshed from scratch rather than patched in place. Measured
 * on a settled 2 666-mesh view that was 243.8 MiB of main heap that nothing
 * would ever read.
 *
 * The price is a re-mesh if the WebGL context is ever lost, because the arrays
 * needed to re-upload are gone. This game has no context-loss handling at all,
 * so a lost context already ends the session with or without this.
 */
function discardArray() { this.array = null; }

/**
 * Half-thickness, in cells, given to a cross plant's quads by the raycast.
 *
 * `emitCross` builds two flat quads through the middle of the cell: one
 * spanning x and standing at the middle of y, the other spanning y and standing
 * at the middle of x, both the full height of the cell. In cell coordinates
 * that is exactly the two planes `frac(cx) = 0.5` and `frac(cy) = 0.5`.
 *
 * The marcher enters a cell once and would otherwise never sample either plane,
 * so a cross cell is the one case where the DDA stops being a DDA and walks the
 * segment through the cell in small steps. At 0.045 and a cell one unit across,
 * 0.10 is about four samples deep at the worst (perpendicular) incidence, so a
 * plant is never missed; a grazing ray only spends longer inside.
 *
 * This is only the *slab*, though, and a slab is not a plant. Two things used
 * to be wrong with stopping here, and both were reported from the field -
 * "those transparent parts is blocking the crosshair":
 *
 *  - The *texture* was ignored, so the transparent gaps within a plant's own
 *    quad counted as the plant. Measured on the baked atlas, `tall_grass` fills
 *    17.6% of its tile and reaches only two thirds of the way up it. The gaps
 *    are read straight off the tile's alpha now - see `setPlantMasks`.
 *
 *  - Two thirds of the plants on this planet are not billboards at all. The
 *    flowers, the sixteen land flora, the reef and the six modelled crops are
 *    drawn as WAM model instances and the mesher emits no quad for them, so the
 *    plus prism was never even the right *family* of shape: a clover is a third
 *    of a cell tall and the whole cell is eight times its footprint. Those take
 *    a cylinder measured off the model instead - see `plantBox`.
 *
 * Both shapes are optional. Before the atlas has decoded and the models have
 * loaded there is nothing to consult, and the plus prism is what a plant gets;
 * it is forgiving rather than tight, which is the right way round for a
 * fallback.
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
function insideCross(id, cx, cy, ck, x, y) {
  const di = cx - x - 0.5, dj = cy - y - 0.5;
  const dk = ck - Math.floor(ck);

  // A modelled plant: its own bounding cylinder, standing on the cell floor.
  const box = plantBox(id);
  if (box) return dk <= box.top && di * di + dj * dj <= box.r2;

  const near_i = Math.abs(di) <= CROSS_HALF;   // near the quad that spans y
  const near_j = Math.abs(dj) <= CROSS_HALF;   // near the quad that spans x
  if (!near_i && !near_j) return false;

  const mask = plantMask(id);
  if (!mask) return true;
  const N = PLANT_MASK_N;
  // `emitCross` gives the quad's bottom edge v = 1 and its top edge v = 0, and
  // the atlas is uploaded unflipped, so row 0 of the tile is the top of the
  // cell. That is the row a grass tile is empty in.
  let row = ((1 - dk) * N) | 0;
  if (row < 0) row = 0; else if (row >= N) row = N - 1;
  if (near_j && mask[row * N + maskCol(di, N)]) return true;
  if (near_i && mask[row * N + maskCol(dj, N)]) return true;
  return false;
}

/** How finely a cross plant's cell is sampled. See `CROSS_HALF`. */
const CROSS_STEP = 0.045;

/** The six axis-aligned face normals, in the DDA's axis order (X, Y, Z). */
const AXIS_N = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
];

export class Planet {
  constructor(materials) {
    this.blocks = new Uint8Array(CELLS);
    this.colBiome = new Uint8Array(COLUMNS);
    /**
     * Sparse side-table for directional blocks: cell index (`col * D + k`, the
     * same indexing `blocks` uses) -> facing 0..3. Only a handful of cells are
     * ever in here, so none of the hot paths pay for it, and packing facing
     * bits into the block byte would put a mask in all of them.
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
    /**
     * Where the viewer is, in world x and z, so a chunk can be drawn on the
     * side of the wrap the viewer is standing on. See `setView`.
     */
    this.viewX = 0;
    this.viewZ = 0;
    /**
     * Kept, and it is a zero vector that means nothing.
     *
     * `Sky.update` still takes a planet centre because the cube had one. A flat
     * map has no centre and no radial anything, so this is the origin and the
     * sky should stop asking for it. Integration point, in `main.js`.
     */
    this.center = new THREE.Vector3(0, 0, 0);
    /**
     * The mirror is full-sized from the start but only partly filled.
     *
     * The worker builds the world a region at a time and posts each one over as
     * it is made, so `blocks` is authoritative only where `live` says it is.
     * Everywhere else it is zeroes, which reads as air - and air is exactly the
     * wrong default for physics, because the player would walk off a cliff into
     * a region that has not been built rather than onto ground that has not
     * arrived yet.
     */
    this.live = new Uint8Array(NUM_REGIONS);
    /**
     * Which regions have had a byte written into them, as distinct from `live`,
     * which is which have been *generated*. They must not be conflated: marking
     * a region live because something wrote one voxel into it would be a lie in
     * exactly the direction that walks the player off a cliff. This is only ever
     * asked "is any of this region non-zero", which is what `resetWorld` needs.
     */
    this._written = new Uint8Array(NUM_REGIONS);
    /** Height field for the whole map - cheap, eager, and always complete. */
    this.colHeight = new Float32Array(COLUMNS);
  }

  /** The per-column tables, which arrive complete before any voxel does. */
  setGlobals(colBiome, colHeight) {
    this.colBiome = colBiome;
    this.colHeight = colHeight;
    this._buildFootprintFloor();
  }

  /**
   * The lowest worldgen ground layer under each chunk footprint, so the
   * streamer can tell a buried chunk from one on the surface.
   *
   * A chunk footprint is exactly a region's footprint, so this is one float per
   * region, built once from a height field that arrives complete before any
   * voxel does. Taking the *minimum* over the 256 columns rather than the mean
   * is the safe direction: a footprint that straddles a canyon rim reports the
   * canyon floor, so the wall the player can see across the gorge is never
   * called buried.
   *
   * `colHeight` is a LAYER now, not a radius. It is the terrain surface before
   * caves are carved and before anything is stamped on top of it, and both of
   * those errors point the same, safe way.
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
   * "Entirely" means its top face is still a whole chunk's depth below the
   * lowest column in it, so there is always at least one fully built chunk of
   * geometry between the lowest ground over a footprint and the first chunk
   * this will call buried.
   */
  chunkBuried(id) {
    const floor = this._footFloor;
    if (!floor) return false;
    const ck = id % CK;
    return (ck + 1) * CHUNK_K < floor[(id - ck) / CK] - CHUNK_K;
  }

  /**
   * Wipe the mirror between worlds. The arrays are kept; only the data goes.
   *
   * Region by region rather than `blocks.fill(0)`, and the reason is residency
   * rather than the memset. The mirror is 137 MB of which a session touches the
   * regions it has actually streamed, and a full-array fill writes every page of
   * it, so the process holds the whole thing resident for the rest of the run
   * whatever the player does.
   *
   * Exact, not an optimisation that mostly holds. `_written` is set by both
   * writers of `blocks` and by nothing else, so a region it does not name has
   * never been written since the last reset.
   */
  resetWorld() {
    const tmp = new Int32Array(REGION_COLS);
    for (let rid = 0; rid < NUM_REGIONS; rid++) {
      if (!this._written[rid]) continue;
      regionColumns(rid, tmp);
      // Sixteen contiguous runs, not 256: a region's columns sharing an x are
      // consecutive and storage is column major, so a run of CHUNK_T columns is
      // one run of CHUNK_T * D cells.
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
   * The wire format is `(column, layer)` packed, which is now the same order
   * storage uses, so each of the sixteen runs is a straight `set` rather than
   * the scatter the cube needed.
   * @param {(rid:number) => void} onRegion called once per region, after it lands
   */
  applyRegions(ids, data, onRegion) {
    const tmp = new Int32Array(REGION_COLS);
    const RUN = CHUNK_T * D;
    for (let n = 0; n < ids.length; n++) {
      const rid = ids[n];
      regionColumns(rid, tmp);
      const o = n * REGION_COLS * D;
      for (let row = 0; row < CHUNK_T; row++) {
        this.blocks.set(
          data.subarray(o + row * RUN, o + row * RUN + RUN),
          tmp[row * CHUNK_T] * D,
        );
      }
      this.live[rid] = 1;
      this._written[rid] = 1;
      onRegion?.(rid);
    }
  }

  /** Has this column been generated? */
  liveCol(col) { return this.live[regionOfCol(col)] === 1; }

  // --- directional facing ---------------------------------------------------

  /**
   * The cell's side-table byte, or 0 when it has none. Zero is the correct
   * default for every meaning the byte carries - upright log, lower slab,
   * untouched water - and collision reads this on the hot path, so it must not
   * hand back undefined.
   */
  facingAt(col, k) { return this.facing.get(col * D + k) ?? 0; }

  /**
   * Keep the side-table in step with an edit. Directional blocks keep (or take)
   * a facing; anything else drops the entry, so a broken or replaced block can
   * never leave a stale facing behind for whatever is placed there next.
   * @returns {number} the facing now stored, or -1 if the cell has none
   */
  applyFacing(col, k, id, want) {
    const idx = col * D + k;
    // Logs store an axis here rather than a horizontal facing, water stores its
    // flow level, and a shaped block stores its orientation. Same table,
    // different meaning per block - a cell is never two of those things at once.
    //
    // This asks IS_SHAPED rather than naming slabs alone. Naming them is what
    // dropped stairs: they are neither axis, slab, liquid nor directional, so
    // every placed stair fell through to the delete below.
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

  at(col, k) { return (k < 0 || k >= D) ? 0 : this.blocks[col * D + k]; }
  // The second of the two writers, so it carries the `_written` mark too.
  setAt(col, k, id) {
    if (k < 0 || k >= D) return;
    this.blocks[col * D + k] = id;
    this._written[regionOfCol(col)] = 1;
  }
  solidAt(col, k) { return (k < 0 || k >= D) ? false : IS_SOLID[this.blocks[col * D + k]] === 1; }
  liquidAt(col, k) { return (k < 0 || k >= D) ? false : RENDER_TYPE[this.blocks[col * D + k]] === R_LIQUID; }

  /** Continuous cell coordinates for a world point. Wraps x and y. */
  cellOf(x, y, z, out = _cell) { return contCell(x, y, z, out); }

  /**
   * Integer cell address for a world point, or null when it is above or below
   * the world.
   *
   * There is no other way to be off-world: x and z wrap, so a horizontal
   * position always names a column. That is the whole of what the fold and
   * `normalizeCell` used to do.
   */
  cellAt(x, y, z) {
    const k = Math.floor(y);
    if (k < 0 || k >= D) return null;
    const cx = wrap(Math.floor(x)), cy = wrap(Math.floor(z));
    return { col: cx * W + cy, k, x: cx, y: cy };
  }

  blockAtWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? this.blocks[a.col * D + a.k] : 0;
  }

  /**
   * Does a thing travelling through the world stop at this point?
   *
   * `BLOCKS_MOTION` rather than `IS_SOLID`, and the difference is the divider:
   * a portal block is deliberately not solid so that a *player* can walk into
   * one, and every caller of this is something that may not. An arrow, a
   * dropped item, a blast line and a mob's line of sight all stop at a divider.
   * See the note over `BLOCKS_MOTION` in Blocks.js.
   *
   * The player's own box does NOT come through here — it reads `IS_SOLID`
   * directly in `Player._overlap` — which is what keeps the one exception one
   * exception.
   */
  isSolidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? BLOCKS_MOTION[this.blocks[a.col * D + a.k]] === 1 : false;
  }

  isLiquidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? RENDER_TYPE[this.blocks[a.col * D + a.k]] === R_LIQUID : false;
  }

  /**
   * Highest non-air, non-water layer in a column - the *ground*, not the top of
   * what is standing on it.
   *
   * Read that twice before using it near water. On a lake or a sea this is the
   * bed, and the water is at `surfaceK(col) + 1`; `liquidAt(col, surfaceK(col))`
   * is therefore the sand, and always false. That has caused a shipped bug
   * (winter ice scanned from the wrong layer and froze nothing) and two
   * measurements that confidently reported a world with no water on it.
   *
   * Leaves and logs are not air either, so under a tree this is the canopy top.
   */
  surfaceK(col) {
    const base = col * D;
    for (let k = D - 1; k >= 0; k--) {
      const b = this.blocks[base + k];
      if (b !== 0 && RENDER_TYPE[b] !== R_LIQUID) return k;
    }
    return -1;
  }

  /**
   * Cell centre in world space. Arithmetic, not a direction times a radius.
   *
   * The cube's version of this line was the single most expensive leftover of
   * the conversion before it: it put the centre of every cell on a sphere
   * inscribed in the cube, up to 17 units from the cell it names, so a block
   * highlighted here and the block a ray actually hit were two different places
   * and mining looked like it did nothing.
   */
  centerOf(col, k, out = new THREE.Vector3()) {
    const y = col % W;
    return out.set((col - y) / W + 0.5, k + 0.5, y + 0.5);
  }

  // --- drawing across the wrap ----------------------------------------------

  /**
   * Tell the planet where the viewer is, so chunks are drawn on the side of the
   * wrap the viewer is standing on.
   *
   * Chunk vertices are built at ABSOLUTE map positions and the offset lives in
   * the mesh's own transform, which is a multiple of W on x and z. Standing at
   * x = 1247 and looking east, the terrain at x = 0..10 is 1 247 units away in
   * absolute coordinates and is simply not there to see; seated against this it
   * is drawn one unit east, which is where it is.
   *
   * **Every frame, writing only when the value changes.** The alternative was to
   * seat a mesh once when it is built and never touch it again, which is sound
   * today and rests on an invariant nobody would think to protect: a chunk's
   * offset only changes when the viewer passes half a map from it, and the
   * streamer evicts at 190 units, so 434 units of margin make it unreachable.
   * That is a real argument and it is exactly the kind that stops being true
   * when somebody raises the view distance. This costs a compare per resident
   * mesh - about 2 600 of them, six arithmetic operations each - and is correct
   * with no invariant at all, including after a teleport, a respawn or a portal,
   * none of which move the player politely.
   *
   * Idempotent and cheap, so calling it per frame is fine; calling it only when
   * the player crosses a chunk boundary would also be correct.
   */
  setView(x, z) {
    this.viewX = x;
    this.viewZ = z;
    for (const mesh of this.meshes.values()) this._seat(mesh);
  }

  /** Put one mesh on the copy of its chunk nearest the viewer. */
  _seat(mesh) {
    const u = mesh.userData;
    const ox = nearOffset(this.viewX, u.chunkX);
    const oz = nearOffset(this.viewZ, u.chunkZ);
    if (mesh.position.x === ox && mesh.position.z === oz) return;
    mesh.position.set(ox, 0, oz);
    mesh.updateMatrix();
  }

  /**
   * An absolute world position, moved to the copy nearest the viewer - which is
   * the space the terrain is actually drawn in.
   *
   * Anything positioned in the scene from a wrapped column has this bug and
   * needs this: a mob, a dropped item, a particle, the block highlight. Nothing
   * within half a map of the viewer moves, so this is a no-op except across a
   * seam, which is the only place it was ever wrong.
   */
  viewOf(x, y, z, out = new THREE.Vector3()) {
    return out.set(x + nearOffset(this.viewX, x), y, z + nearOffset(this.viewZ, z));
  }

  /** `centerOf` in the space the terrain is drawn in. */
  viewCenterOf(col, k, out = new THREE.Vector3()) {
    const y = col % W;
    return this.viewOf((col - y) / W + 0.5, k + 0.5, y + 0.5, out);
  }

  // --- chunk meshes ---------------------------------------------------------

  applyChunk(cx, cy, ck, groups) {
    const id = chunkIdx(cx, cy, ck);
    // The middle of the chunk's footprint, in absolute world x and z. The middle
    // rather than the corner so that which copy is nearest is decided by the
    // chunk as a whole; see `_seat`.
    const chunkX = cx * CHUNK_T + CHUNK_T * 0.5;
    const chunkZ = cy * CHUNK_T + CHUNK_T * 0.5;
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
        // A cutout casts the shape of its art, not the shape of its quad.
        if (gi === GROUP_CUTOUT && this.materials.cutoutDepth) {
          mesh.customDepthMaterial = this.materials.cutoutDepth;
        }
        mesh.receiveShadow = gi !== GROUP_LIQUID;
        mesh.matrixAutoUpdate = false;
        // Which chunk this is, so `setView` can re-seat it without decoding a
        // string key. The vertices are absolute; the transform is the offset.
        mesh.userData.chunkX = chunkX;
        mesh.userData.chunkZ = chunkZ;
        // Onto the copy the viewer can see, now rather than at the next
        // `setView`: a chunk that arrives across the seam would otherwise be
        // drawn a map width away for a frame. A fresh mesh is at the origin with
        // an identity matrix, which is already what a zero offset wants, so
        // `_seat` skipping that case leaves it correct.
        this._seat(mesh);
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
   * March a ray through the map.
   *
   * A proper DDA now, not the fixed-step sampler the cubesphere needed. Cells
   * are unit cubes on the world axes, so the exact entry and exit of every cell
   * along the ray is two subtractions, and three consequences follow that the
   * sampler could not have:
   *
   *  - No cell can be skipped and none is visited twice, whatever the step size
   *    would have been.
   *  - The hit normal is EXACT. It is the face the ray crossed to enter the
   *    cell, so there is no fallback normal to get wrong. The cube's version
   *    subtracted two cell centres and normalised, and fell back to the face's
   *    own outward normal when there was no previous cell.
   *  - `prevCol`/`prevK` is genuinely the cell on the other side of the face
   *    that was hit, which is what a block is placed against.
   *
   * The marcher walks UNWRAPPED integer cell coordinates and wraps only when it
   * turns one into a column. That is deliberate: wrapping the coordinate itself
   * would put a discontinuity in the middle of the march at the seam, and the
   * ray does not care that the map joins up there. It cannot escape the map
   * because there is no edge to escape through - `colIndex` wraps - so the only
   * way out is up or down, and those are the `k` bounds.
   *
   * Cross plants are the one block that is not treated as a full cell: see
   * `CROSS_HALF`. Their cell is walked in small steps because a billboard has no
   * volume for a DDA to enter.
   *
   * @returns {{col,k,prevCol,prevK,id,dist,point:THREE.Vector3,normal:THREE.Vector3}|null}
   */
  raycast(origin, dir, maxDist = 6, opts = {}) {
    const hitLiquid = !!opts.hitLiquid;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    if (dx === 0 && dy === 0 && dz === 0) return null;

    // The cell the ray starts in, in unwrapped coordinates.
    let ix = Math.floor(ox), iy = Math.floor(oy), iz = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const idx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const idy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const idz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tx = dx !== 0 ? (dx > 0 ? ix + 1 - ox : ox - ix) * idx : Infinity;
    let ty = dy !== 0 ? (dy > 0 ? iy + 1 - oy : oy - iy) * idy : Infinity;
    let tz = dz !== 0 ? (dz > 0 ? iz + 1 - oz : oz - iz) * idz : Infinity;

    let t = 0;
    // Which axis the ray crossed to enter the current cell, and in which
    // direction. -1 for the cell the ray starts inside, which it did not enter.
    let axis = -1, sign = 0;
    let prevCol = -1, prevK = -1;

    const hit = (col, k, id, tHit, hAxis, hSign) => {
      const point = new THREE.Vector3(ox + dx * tHit, oy + dy * tHit, oz + dz * tHit);
      const normal = new THREE.Vector3();
      if (hAxis >= 0) {
        const n = AXIS_N[hAxis];
        normal.set(-hSign * n[0], -hSign * n[1], -hSign * n[2]);
      } else {
        // The ray began inside the block it hit, so there is no face to name.
        // The dominant axis of the ray, reversed, is the honest answer and is
        // the only case in this function that guesses.
        const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        if (ax >= ay && ax >= az) normal.set(-sx, 0, 0);
        else if (ay >= az) normal.set(0, -sy, 0);
        else normal.set(0, 0, -sz);
      }
      return { col, k, prevCol, prevK, id, dist: tHit, point, normal };
    };

    // Bounded by geometry, not by trust: a ray of length L crosses at most
    // L + 1 boundaries per axis.
    const guard = 3 * (Math.ceil(maxDist) + 2);
    for (let n = 0; n < guard; n++) {
      const tExit = Math.min(tx, ty, tz);
      if (t > maxDist) break;

      if (iy >= 0 && iy < D) {
        const col = wrap(ix) * W + wrap(iz);
        const id = this.blocks[col * D + iy];
        // A divider is scenery you walk into, not a block you point at.
        //
        // It stopped the ray and reported itself, so the crosshair named
        // "Portal", the highlight box drew on it and every interaction in
        // main.js was offered a target it can do nothing with. The owner's
        // words: *"why is portal treated like a block not like water"*. Water
        // is skipped two lines below for exactly this reason.
        //
        // It STOPS rather than being skipped, which is the one way it is not
        // like water: skipping would hand the ray whatever is on the far side,
        // and the far side is another face of the world — you would be mining
        // Rime's hillside from Solace through two metres of wall. Returning
        // null keeps the wall a wall and simply gives the crosshair nothing,
        // which is what a doorway made of light should give it.
        if (id === PORTAL_ID) return null;
        if (id !== 0 && (hitLiquid || RENDER_TYPE[id] !== R_LIQUID)) {
          if (RENDER_TYPE[id] === R_CROSS) {
            // No volume to enter: walk the segment inside this cell instead.
            const end = Math.min(tExit, maxDist);
            for (let s = t; s <= end; s += CROSS_STEP) {
              const px = ox + dx * s, py = oy + dy * s, pz = oz + dz * s;
              contCell(px, py, pz, _cell);
              if (insideCross(id, _cell.cx, _cell.cy, _cell.ck, wrap(ix), wrap(iz))) {
                return hit(col, iy, id, s, axis, sign);
              }
            }
          } else if (t <= maxDist) {
            return hit(col, iy, id, t, axis, sign);
          }
        }
        prevCol = col; prevK = iy;
      } else {
        // Above or below the world: nothing to place against either.
        prevCol = -1; prevK = -1;
      }

      if (tExit > maxDist) break;
      t = tExit;
      if (tx <= ty && tx <= tz) { ix += sx; tx += idx; axis = 0; sign = sx; }
      else if (ty <= tz) { iy += sy; ty += idy; axis = 1; sign = sy; }
      else { iz += sz; tz += idz; axis = 2; sign = sz; }
    }
    return null;
  }
}

// `opts.face` and `opts.blocked` are gone from `raycast`, and nothing replaces
// them. They gated a cast to one cube face so that a block belonging to another
// face could be seen but never mined, built on, used or fished - the whole
// cross-face interaction gate, and the outline that had to be invented to
// explain it. There are no shared cells to arbitrate now: a divider is solid
// unbreakable rock and stops a ray by being a block, which is a rule that needs
// no explaining. Callers passing `face` are harmless; the option is ignored.
