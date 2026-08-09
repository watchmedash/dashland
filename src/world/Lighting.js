// Skylight and coloured block light, flood-filled over the cubesphere's
// 6-neighbour graph (four tangential neighbours + up/down the column).

import { D, COLUMNS, NUM_VOXELS } from './Constants.js';
import { COL_NB } from './Sphere.js';
import {
  BLOCKS, IS_OPAQUE, IS_SLAB, IS_STAIR, LIGHT_EMIT, LIGHT_R, LIGHT_G, LIGHT_B, N_BLOCKS,
} from './Blocks.js';

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

/**
 * What sky light pays to come *straight down* through a cell — as distinct from
 * ATTEN above, which is what any light pays to cross into a cell sideways.
 *
 * These have to be two tables, and the reason is that the seed pass down a
 * column previously used the wrong one of them. It walked from the top of the
 * world until `ATTEN === 255` and wrote MAX_LIGHT into everything it passed,
 * which means it stopped at opaque blocks *and at nothing else*. Every
 * non-opaque block in the game was therefore perfectly transparent to daylight
 * from above, however solid it actually is:
 *
 *   - a slab or a stair roof passed the full fifteen, so a hut roofed in slabs
 *     was lit inside exactly like the meadow outside it;
 *   - so did twenty-five metres of ocean, so a seabed read as open sky;
 *   - so did any depth of canopy.
 *
 * On its own that is invisible — the shader's `sunAmt` saturates at 15 and the
 * *shadow map* is what darkens a forest floor, so nothing on screen was reading
 * these cells as bright. It stops being invisible the moment anything wants to
 * ask "is this cell under the open sky?", which is the one question that
 * separates daylight shade from underground and is the gate any daylight lift
 * has to hang on (see the note on the canopy below, and NIGHT_OPEN_GAIN in
 * VoxelMaterial, which already asks it after dark). With the old table the
 * honest answer was "yes" for the bottom of the sea and the inside of a
 * slab-roofed room.
 *
 * 255 means the column is roofed here: nothing below it is under the sky, and
 * whatever light gets there has to come in sideways like a cave's. A slab and a
 * stair are 255 for the descent while staying 1 in ATTEN, which is exactly the
 * asymmetry the block is — half a cell of rock is a roof to something standing
 * under it and no obstacle at all to light travelling past it in a wall.
 *
 * **Leaves are deliberately zero.** A canopy is a sieve, not a lid — the leaf
 * tile is a third holes, which is why the mesher goes to such trouble to keep
 * its alpha sharp — and a forest floor is emphatically not underground. Charging
 * for it would push the floor of a dense wood down the `sunAmt` curve, which is
 * the wrong direction: the standing complaint about this planet is that a wood
 * at nine in the morning is dark enough to want torches in it. Sky light reaching
 * the floor of a wood at full strength is what lets the render layer tell that
 * floor apart from a cave and light it accordingly, and the canopy's *shadow* is
 * already drawn — properly, per leaf, with dappling — by the sun's shadow map.
 */
export const SKY_ATTEN = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) {
  const b = BLOCKS[i];
  if (IS_OPAQUE[i] || IS_SLAB[i] || IS_STAIR[i]) SKY_ATTEN[i] = 255;
  // Water and ice absorb with depth rather than sealing: one level per cell, so
  // a shallow bar stays sunlit, a lake bed is dim and the floor of a deep ocean
  // is as dark as it should have been all along.
  else if (b.name === 'water' || b.name === 'ice') SKY_ATTEN[i] = 1;
  else SKY_ATTEN[i] = 0;
}

/**
 * ATTEN for a step taken *up or down* rather than sideways.
 *
 * The seed above is only half of a roof. A slab three cells over the floor also
 * has fifteen levels of daylight sitting on top of it, and the flood steps down
 * out of that at ATTEN's cost of one — so the seed would stop at the slab and
 * the flood would pour straight through it and land 11 on the floor below,
 * which is a hut lit almost as well as the meadow. (Measured: exactly 11.)
 *
 * Blocking the vertical step is the other half, and it is right for block light
 * as well as for the sun: a torch under a staircase does not shine up through
 * the treads. Only the vertical steps are affected, so a slab set into a wall
 * still passes light past itself exactly as it always has.
 */
const ATTEN_V = new Uint8Array(N_BLOCKS);
for (let i = 0; i < N_BLOCKS; i++) ATTEN_V[i] = SKY_ATTEN[i] === 255 ? 255 : ATTEN[i];

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

  /**
   * Seed one column from the sky: walk down from the top of the world writing
   * daylight into every cell until the column is roofed.
   *
   * The one place the sky enters the world, shared by all three entry points
   * below so they cannot drift — they used to carry three copies of the same
   * six lines and the copies are what let the bug in SKY_ATTEN sit in all of
   * them at once.
   *
   * @returns the new queue tail
   */
  _seedSky(blocks, col, q, tail) {
    const base = col * D;
    let v = MAX_LIGHT;
    for (let k = D - 1; k >= 0; k--) {
      const c = SKY_ATTEN[blocks[base + k]];
      if (c === 255) break;
      if (c !== 0) {
        v -= c;
        // Out of daylight, but still under the sky rather than roofed: stop
        // seeding and let anything further down be reached sideways, exactly
        // as a cave is.
        if (v <= 0) break;
      }
      this.sun[base + k] = v;
      q[tail++] = base + k;
    }
    return tail;
  }

  computeAll(blocks, onProgress = () => {}) {
    this.sun.fill(0); this.r.fill(0); this.g.fill(0); this.b.fill(0);
    const q = this._queue;
    let tail = 0;

    // seed: every cell above the highest opaque block in its column sees sky
    for (let col = 0; col < COLUMNS; col++) {
      tail = this._seedSky(blocks, col, q, tail);
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
        let ni, at;
        // The two vertical steps read ATTEN_V and the four tangential ones read
        // ATTEN. Picked inside each branch rather than by selecting an array
        // afterwards: the branches already exist, and choosing between two typed
        // arrays in the hot line is what turns a monomorphic load polymorphic.
        if (d === 4) { if (k + 1 >= D) continue; ni = i + 1; at = ATTEN_V[blocks[ni]]; }
        else if (d === 5) { if (k === 0) continue; ni = i - 1; at = ATTEN_V[blocks[ni]]; }
        else {
          const nc = COL_NB[col * 4 + d];
          if (live !== null && live[nc] === 0) continue;
          ni = nc * D + k;
          at = ATTEN[blocks[ni]];
        }
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
        tail = this._seedSky(blocks, col, q, tail);
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
      tail = this._seedSky(blocks, col, q, tail);
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
