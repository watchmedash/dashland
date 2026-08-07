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
        else ni = COL_NB[col * 4 + d] * D + k;
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
