// Skylight and coloured block light, flood-filled over the cubesphere's
// 6-neighbour graph (four tangential neighbours + up/down the column).

import { D, COLUMNS, NUM_VOXELS } from './Constants.js';
import { COL_NB } from './Sphere.js';
import { BLOCKS, IS_OPAQUE, LIGHT_EMIT, LIGHT_R, LIGHT_G, LIGHT_B, N_BLOCKS } from './Blocks.js';

export const MAX_LIGHT = 15;

/** Light cost of passing through each block (255 blocks entirely). */
export const ATTEN = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (IS_OPAQUE[i]) ATTEN[i] = 255;
  else if (b.name.startsWith('leaves')) ATTEN[i] = 2;
  else if (b.name === 'water') ATTEN[i] = 2;
  else ATTEN[i] = 1;
}

/** Six neighbours of a voxel index; returns -1 when off the top/bottom. */
export function neighborIndex(index, dir) {
  const k = index % D;
  if (dir === 4) return k + 1 < D ? index + 1 : -1;      // outward
  if (dir === 5) return k > 0 ? index - 1 : -1;          // inward
  const col = (index - k) / D;
  return COL_NB[col * 4 + dir] * D + k;
}

export class LightField {
  constructor() {
    this.sun = new Uint8Array(NUM_VOXELS);
    this.r = new Uint8Array(NUM_VOXELS);
    this.g = new Uint8Array(NUM_VOXELS);
    this.b = new Uint8Array(NUM_VOXELS);
    this._queue = new Int32Array(NUM_VOXELS);
    /**
     * Which columns have actually been generated, or null for "all of them".
     *
     * Light does not cross into a column that does not exist yet, and this is
     * the only place that can be enforced. An ungenerated region is all zero
     * bytes, which is `air` — so without this the flood pours straight through
     * it, comes out somewhere on the far side, and lights the inside of a cave
     * in a region that has been generated. Worse, it is not self-correcting:
     * when the region between them is finally built it relights itself and a
     * margin around it, and the stale glow further out is beyond that margin
     * and stays.
     *
     * Treating a missing column as opaque instead makes the boundary behave
     * exactly like bedrock, which is both correct and cheap: the flood already
     * tests attenuation on every step, and this is one more array read on the
     * lateral ones.
     */
    this.live = null;
  }

  computeAll(blocks, onProgress = () => {}) {
    this.sun.fill(0); this.r.fill(0); this.g.fill(0); this.b.fill(0);
    const q = this._queue;
    let tail = 0;

    // seed: every cell above the highest opaque block in its column sees sky
    for (let col = 0; col < COLUMNS; col++) {
      const base = col * D;
      for (let k = D - 1; k >= 0; k--) {
        if (ATTEN[blocks[base + k]] === 255) break;
        this.sun[base + k] = MAX_LIGHT;
        q[tail++] = base + k;
      }
      if ((col & 8191) === 0) onProgress(0.5 * (col / COLUMNS));
    }
    this._flood(blocks, this.sun, q, 0, tail);
    onProgress(0.7);

    const chans = [this.r, this.g, this.b];
    const scales = [LIGHT_R, LIGHT_G, LIGHT_B];
    const seeds = [];
    for (let i = 0; i < NUM_VOXELS; i++) if (LIGHT_EMIT[blocks[i]] > 0) seeds.push(i);
    for (let c = 0; c < 3; c++) {
      const chan = chans[c], scale = scales[c];
      tail = 0;
      for (const i of seeds) {
        const b = blocks[i];
        const v = Math.round(LIGHT_EMIT[b] * (scale[b] / 255));
        if (v > chan[i]) { chan[i] = v; q[tail++] = i; }
      }
      this._flood(blocks, chan, q, 0, tail);
    }
    onProgress(1);
  }

  _flood(blocks, field, q, head, tail) {
    const cap = q.length;
    const live = this.live;
    while (head < tail) {
      const i = q[head++];
      const lv = field[i];
      if (lv <= 1) continue;
      const k = i % D;
      const colBase = i - k;
      const col = colBase / D;
      for (let d = 0; d < 6; d++) {
        let ni;
        if (d === 4) { if (k + 1 >= D) continue; ni = i + 1; }
        else if (d === 5) { if (k === 0) continue; ni = i - 1; }
        else {
          const nc = COL_NB[col * 4 + d];
          if (live !== null && live[nc] === 0) continue;
          ni = nc * D + k;
        }
        const at = ATTEN[blocks[ni]];
        if (at === 255) continue;
        const nv = lv - at;
        if (nv > field[ni]) {
          field[ni] = nv;
          if (tail < cap) q[tail++] = ni;
        }
      }
    }
  }

  /**
   * Light a freshly generated batch of regions, plus the ring of already-lit
   * columns around it.
   *
   * The ring is not optional and it is not a fudge. Skylight travels sideways —
   * fifteen columns at most, one level per step — so a column just outside a new
   * region was lit against a neighbour that was empty at the time, and building
   * that neighbour has to be allowed to take that light away again. Fifteen is
   * the exact reach, so a ring of fifteen is exact rather than approximate.
   *
   * `edge` is that ring; `cols` is the new work. Both get cleared and recomputed
   * together — the whole set has to be flooded as one, because light entering
   * the ring from outside is what carries into the new region. Only the ring is
   * snapshotted and diffed, because the new region has no mesh yet and is about
   * to get one either way; the ring may already be on screen and the caller
   * needs to know which of it to rebuild.
   *
   * This is `relight` without the Set-of-columns bookkeeping. That version is
   * built for one edit and a radius of seventeen — a few thousand columns with a
   * Map of snapshots keyed by column — and the first load asks for a hundred
   * thousand of them at once, where a Map entry and a fresh Uint8Array per
   * column is most of the cost of the pass.
   */
  computeRegion(blocks, cols, edge, changedCol = () => {}) {
    const inSet = this._inSet || (this._inSet = new Uint8Array(COLUMNS));
    for (let n = 0; n < cols.length; n++) inSet[cols[n]] = 1;
    for (let n = 0; n < edge.length; n++) inSet[edge[n]] = 1;

    if (!this._snap || this._snap.length < edge.length * D * 4) {
      this._snap = new Uint8Array(edge.length * D * 4);
    }
    const snap = this._snap;
    for (let n = 0; n < edge.length; n++) {
      const base = edge[n] * D, o = n * D * 4;
      for (let k = 0; k < D; k++) {
        snap[o + k] = this.sun[base + k];
        snap[o + D + k] = this.r[base + k];
        snap[o + D * 2 + k] = this.g[base + k];
        snap[o + D * 3 + k] = this.b[base + k];
      }
    }

    const all = [cols, edge];
    for (const list of all) {
      for (let n = 0; n < list.length; n++) {
        const base = list[n] * D;
        this.sun.fill(0, base, base + D);
        this.r.fill(0, base, base + D);
        this.g.fill(0, base, base + D);
        this.b.fill(0, base, base + D);
      }
    }

    const q = this._queue;

    // --- sunlight ---
    let tail = 0;
    for (const list of all) {
      for (let n = 0; n < list.length; n++) {
        const col = list[n];
        const base = col * D;
        for (let k = D - 1; k >= 0; k--) {
          if (ATTEN[blocks[base + k]] === 255) break;
          this.sun[base + k] = MAX_LIGHT;
          q[tail++] = base + k;
        }
        // Pull light in from the columns beyond the ring, which keep whatever
        // they already have. Without this the outermost course of the ring is
        // recomputed as if the rest of the planet were dark and the seam moves
        // outward instead of disappearing.
        for (let d = 0; d < 4; d++) {
          const nb = COL_NB[col * 4 + d];
          if (inSet[nb]) continue;
          if (this.live !== null && this.live[nb] === 0) continue;
          for (let k = 0; k < D; k++) {
            const at = ATTEN[blocks[base + k]];
            if (at === 255) continue;
            const v = this.sun[nb * D + k] - at;
            if (v > this.sun[base + k]) { this.sun[base + k] = v; q[tail++] = base + k; }
          }
        }
      }
    }
    this._flood(blocks, this.sun, q, 0, tail);

    // --- coloured block light ---
    const chans = [this.r, this.g, this.b];
    const scales = [LIGHT_R, LIGHT_G, LIGHT_B];
    for (let c = 0; c < 3; c++) {
      const chan = chans[c], scale = scales[c];
      tail = 0;
      for (const list of all) {
        for (let n = 0; n < list.length; n++) {
          const col = list[n];
          const base = col * D;
          for (let k = 0; k < D; k++) {
            const b = blocks[base + k];
            const v = LIGHT_EMIT[b] > 0 ? Math.round(LIGHT_EMIT[b] * (scale[b] / 255)) : 0;
            if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
          }
          for (let d = 0; d < 4; d++) {
            const nb = COL_NB[col * 4 + d];
            if (inSet[nb]) continue;
            if (this.live !== null && this.live[nb] === 0) continue;
            for (let k = 0; k < D; k++) {
              const at = ATTEN[blocks[base + k]];
              if (at === 255) continue;
              const v = chan[nb * D + k] - at;
              if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
            }
          }
        }
      }
      this._flood(blocks, chan, q, 0, tail);
    }

    for (let n = 0; n < edge.length; n++) {
      const col = edge[n], base = col * D, o = n * D * 4;
      for (let k = 0; k < D; k++) {
        if (snap[o + k] !== this.sun[base + k] || snap[o + D + k] !== this.r[base + k]
          || snap[o + D * 2 + k] !== this.g[base + k] || snap[o + D * 3 + k] !== this.b[base + k]) {
          changedCol(col, k);
        }
      }
    }

    for (let n = 0; n < cols.length; n++) inSet[cols[n]] = 0;
    for (let n = 0; n < edge.length; n++) inSet[edge[n]] = 0;
  }

  /**
   * Recompute light in a neighbourhood of a set of columns. Seeds from the
   * border so light from outside still bleeds in, then reports which columns
   * actually changed.
   */
  relight(blocks, seedCols, radius, changed) {
    // gather the affected column set by walking the adjacency graph
    const region = new Set();
    let frontier = [...seedCols];
    region.add(...frontier);
    for (const c of frontier) region.add(c);
    for (let step = 0; step < radius; step++) {
      const next = [];
      for (const c of frontier) {
        for (let d = 0; d < 4; d++) {
          const n = COL_NB[c * 4 + d];
          if (!region.has(n)) { region.add(n); next.push(n); }
        }
      }
      frontier = next;
      if (!next.length) break;
    }

    const cols = [...region];
    const fields = [this.sun, this.r, this.g, this.b];
    const before = new Map();
    for (const col of cols) {
      const base = col * D;
      const snap = new Uint8Array(D * 4);
      for (let k = 0; k < D; k++) {
        snap[k] = this.sun[base + k];
        snap[D + k] = this.r[base + k];
        snap[D * 2 + k] = this.g[base + k];
        snap[D * 3 + k] = this.b[base + k];
        this.sun[base + k] = 0; this.r[base + k] = 0; this.g[base + k] = 0; this.b[base + k] = 0;
      }
      before.set(col, snap);
    }

    const q = this._queue;
    const inRegion = (col) => region.has(col);

    // --- sunlight ---
    let tail = 0;
    for (const col of cols) {
      const base = col * D;
      for (let k = D - 1; k >= 0; k--) {
        if (ATTEN[blocks[base + k]] === 255) break;
        this.sun[base + k] = MAX_LIGHT;
        q[tail++] = base + k;
      }
      // pull light in from neighbouring columns outside the region
      for (let d = 0; d < 4; d++) {
        const n = COL_NB[col * 4 + d];
        if (inRegion(n)) continue;
        for (let k = 0; k < D; k++) {
          const at = ATTEN[blocks[base + k]];
          if (at === 255) continue;
          const v = this.sun[n * D + k] - at;
          if (v > this.sun[base + k]) { this.sun[base + k] = v; q[tail++] = base + k; }
        }
      }
    }
    this._flood(blocks, this.sun, q, 0, tail);

    // --- coloured block light ---
    const chans = [this.r, this.g, this.b];
    const scales = [LIGHT_R, LIGHT_G, LIGHT_B];
    for (let c = 0; c < 3; c++) {
      const chan = chans[c], scale = scales[c];
      tail = 0;
      for (const col of cols) {
        const base = col * D;
        for (let k = 0; k < D; k++) {
          const b = blocks[base + k];
          let v = LIGHT_EMIT[b] > 0 ? Math.round(LIGHT_EMIT[b] * (scale[b] / 255)) : 0;
          if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
        }
        for (let d = 0; d < 4; d++) {
          const n = COL_NB[col * 4 + d];
          if (inRegion(n)) continue;
          for (let k = 0; k < D; k++) {
            const at = ATTEN[blocks[base + k]];
            if (at === 255) continue;
            const v = chan[n * D + k] - at;
            if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
          }
        }
      }
      this._flood(blocks, chan, q, 0, tail);
    }

    for (const col of cols) {
      const base = col * D;
      const snap = before.get(col);
      for (let k = 0; k < D; k++) {
        if (snap[k] !== this.sun[base + k] || snap[D + k] !== this.r[base + k]
          || snap[D * 2 + k] !== this.g[base + k] || snap[D * 3 + k] !== this.b[base + k]) {
          changed(col, k);
        }
      }
    }
  }
}
