// Main-thread view of the cubesphere: a mirror of the voxel array for physics
// and raycasting, plus the chunk meshes streamed in from the worker.

import * as THREE from 'three';
import {
  F, D, R_MIN, COLUMNS, NUM_VOXELS, cidx, chunkIdx, CHUNK_T,
  NUM_REGIONS, REGION_COLS, REGION_VOXELS, regionOfCol, regionColumns,
} from './Constants.js';
import { worldToCell, centerDir } from './Sphere.js';
import {
  IS_SOLID, RENDER_TYPE, R_LIQUID, R_CROSS, IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, FACING_DEFAULT,
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
 * What it gets wrong: the plant is 0.15 cells fatter than it looks in every
 * direction, so the crosshair grabs it from a hair outside its silhouette; and
 * the *texture* is ignored, so the transparent gaps within a flower's own quad
 * — the space either side of the stem — still count as the flower. Matching
 * those would mean sampling the atlas per ray step, which is far past what a
 * per-frame label is worth. Both errors are in the forgiving direction: they
 * make a plant slightly easier to hit, never harder.
 */
const CROSS_HALF = 0.15;

/** Is this sample point within a cross plant's quads? See `CROSS_HALF`. */
function insideCross(c, i, j) {
  return Math.abs(c.ci - i - 0.5) <= CROSS_HALF || Math.abs(c.cj - j - 0.5) <= CROSS_HALF;
}

export class Planet {
  constructor(materials) {
    this.blocks = new Uint8Array(NUM_VOXELS);
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
    /** Height field for the whole planet — cheap, eager, and always complete. */
    this.colHeight = new Float32Array(COLUMNS);
  }

  /** The per-column tables, which arrive complete before any voxel does. */
  setGlobals(colBiome, colHeight) {
    this.colBiome = colBiome;
    this.colHeight = colHeight;
  }

  /** Wipe the mirror between worlds. The arrays are kept; only the data goes. */
  resetWorld() {
    this.blocks.fill(0);
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
      let o = n * REGION_VOXELS;
      for (let row = 0; row < CHUNK_T; row++) {
        const base = tmp[row * CHUNK_T] * D;
        this.blocks.set(data.subarray(o, o + CHUNK_T * D), base);
        o += CHUNK_T * D;
      }
      this.live[rid] = 1;
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

  at(col, k) { return (k < 0 || k >= D) ? 0 : this.blocks[col * D + k]; }
  setAt(col, k, id) { if (k >= 0 && k < D) this.blocks[col * D + k] = id; }
  solidAt(col, k) { return (k < 0 || k >= D) ? false : IS_SOLID[this.blocks[col * D + k]] === 1; }
  liquidAt(col, k) { return (k < 0 || k >= D) ? false : RENDER_TYPE[this.blocks[col * D + k]] === R_LIQUID; }

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
    return a ? this.blocks[a.col * D + a.k] : 0;
  }

  isSolidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? IS_SOLID[this.blocks[a.col * D + a.k]] === 1 : false;
  }

  isLiquidWorld(x, y, z) {
    const a = this.cellAt(x, y, z);
    return a ? RENDER_TYPE[this.blocks[a.col * D + a.k]] === R_LIQUID : false;
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
    const base = col * D;
    for (let k = D - 1; k >= 0; k--) {
      const b = this.blocks[base + k];
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
      const id = this.blocks[col * D + k];
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
      if (curCross && !insideCross(c, i, j)) continue;

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
