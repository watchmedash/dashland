// Main-thread view of the cubesphere: a mirror of the voxel array for physics
// and raycasting, plus the chunk meshes streamed in from the worker.

import * as THREE from 'three';
import {
  F, D, R_MIN, R_MAX, COLUMNS, NUM_VOXELS, vidx, cidx, chunkIdx,
  CHUNK_T, CHUNK_K, CT, CK,
} from './Constants.js';
import { worldToCell, cellToWorld, stepColumn, centerDir, tangentFrame, cellArc } from './Sphere.js';
import {
  IS_SOLID, RENDER_TYPE, R_LIQUID, IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, FACING_DEFAULT,
} from './Blocks.js';
import { GROUP_OPAQUE, GROUP_CUTOUT, GROUP_LIQUID } from './Mesher.js';

const _cell = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 };
const _p = [0, 0, 0];

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
  }

  setWorld(blocks, colBiome, facingPairs) {
    this.blocks = blocks;
    this.colBiome = colBiome;
    this.facing = new Map();
    if (facingPairs) for (const [idx, v] of facingPairs) this.facing.set(idx, v);
  }

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

  upAt(pos, out = new THREE.Vector3()) { return out.copy(pos).normalize(); }
  radiusAt(pos) { return pos.length(); }

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

  surfaceRadiusDir(dir) {
    const c = worldToCell(dir.x * 40, dir.y * 40, dir.z * 40, _cell);
    const i = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
    const j = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
    const col = cidx(c.f, i, j);
    const k = this.surfaceK(col);
    return k < 0 ? 0 : R_MIN + k + 1;
  }

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
      geo.setIndex(new THREE.BufferAttribute(payload.index, 1));
      geo.computeBoundingSphere();

      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        mesh = new THREE.Mesh(geo, mats[gi]);
        mesh.castShadow = gi === GROUP_OPAQUE || gi === GROUP_CUTOUT;
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
   * @returns {{col,k,prevCol,prevK,id,dist,point:THREE.Vector3,normal:THREE.Vector3}|null}
   */
  raycast(origin, dir, maxDist = 6, opts = {}) {
    const step = 0.045;
    let prevCol = -1, prevK = -1;
    let curCol = -1, curK = -1;
    const hitLiquid = !!opts.hitLiquid;

    for (let t = 0; t <= maxDist; t += step) {
      const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
      const c = worldToCell(x, y, z, _cell);
      const k = Math.floor(c.ck);
      if (k < 0 || k >= D) { prevCol = -1; prevK = -1; continue; }
      const i = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
      const j = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
      const col = cidx(c.f, i, j);
      if (col === curCol && k === curK) continue;
      prevCol = curCol; prevK = curK;
      curCol = col; curK = k;

      const id = this.blocks[col * D + k];
      if (id === 0) continue;
      if (RENDER_TYPE[id] === R_LIQUID && !hitLiquid) continue;

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
