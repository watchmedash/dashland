// Skylight and coloured block light, flood-filled over the map's 6-neighbour
// graph (four neighbouring columns, wrapping, + up/down the column).
//
// The cube needed COL_BASE/COL_STEP to find a column's cells, because its
// storage strided differently per face. The flat map stores a column's layers
// contiguously at `col * D + k`, so a block index and a light index are the same
// number and both are written out directly.

import { D, COLUMNS, CELLS } from './Constants.js';
import { W } from './Grid.js';
import { colNeighbor } from './Layout.js';
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

// `neighborIndex(index, dir)` was deleted from here rather than wired up. It
// was an exported six-neighbour walk over a voxel index, and nothing called it:
// `_flood` is the only code that walks neighbours and it does the same six steps
// inline, because it also needs each step's attenuation and cannot afford a call
// per voxel per channel. A second, slower spelling of the flood's hot loop is
// the one that goes stale when the graph changes.

/**
 * Where the BFS queue starts, and how far it is ever allowed to go.
 *
 * It used to be `Int32Array(NUM_VOXELS)` outright — 127 885 824 entries, 487.8
 * MiB — on the theory that a flood could in principle enqueue every voxel in
 * the world. It never comes close. Measured over a session that generated the
 * spawn area and then travelled ~190 cells across it, the high-water tail was
 * 6 319 911 entries (24.1 MiB, 4.94% of the array) with nothing dropped, so
 * about 465 MiB of a 1.9 GB footprint was scratch space that was allocated,
 * committed and never written to. The one entry point that could plausibly
 * want the whole world at once was `computeAll`, which nothing called and which
 * has since been deleted; every remaining caller floods a region and a ring.
 *
 * 8M entries is the start: comfortably over the measured peak, so the ordinary
 * session never grows at all, and 32 MiB instead of 488. The ceiling is the old
 * size, so the pathological case is exactly as safe as it was before the change
 * rather than merely likely to be fine.
 *
 * No compatibility question arises here, and it is worth being explicit about
 * why: this is scratch. It holds nothing between calls, it is never posted
 * anywhere, and the light field it fills is itself derived data — recomputed
 * from blocks on load and never written to a save. Changing its size cannot
 * change a save, a seed or a single voxel.
 */
const QUEUE_START = 8 * 1024 * 1024;
const QUEUE_MAX = CELLS;

export class LightField {
  constructor() {
    this.sun = new Uint8Array(CELLS);
    this.r = new Uint8Array(CELLS);
    this.g = new Uint8Array(CELLS);
    this.b = new Uint8Array(CELLS);
    this._queue = new Int32Array(QUEUE_START);
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
   * Make room for `need` queue entries and return the queue.
   *
   * Doubling, and capped at QUEUE_MAX. Every caller has to use the array this
   * returns rather than one it captured earlier: growing replaces `this._queue`,
   * and writing into the old one afterwards would enqueue into a buffer the
   * flood has already stopped reading. Returning the array instead of relying on
   * the field is what makes that hard to get wrong.
   */
  _ensureQueue(need) {
    const q = this._queue;
    if (need <= q.length || q.length >= QUEUE_MAX) return q;
    let cap = q.length;
    while (cap < need && cap < QUEUE_MAX) cap *= 2;
    if (cap > QUEUE_MAX) cap = QUEUE_MAX;
    const next = new Int32Array(cap);
    next.set(q);
    this._queue = next;
    return next;
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
  _seedSky(blocks, col, tail) {
    // At most D entries go in below, so one check per column covers the lot.
    const q = this._ensureQueue(tail + D);
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

  // `computeAll(blocks, onProgress)` was deleted from here rather than left in
  // place. It lit the whole planet in one pass — seed every one of the 259 584
  // columns, flood, then sweep all 127 885 824 voxels four times looking for
  // emitters — and nothing has called it since the world went lazy: the worker
  // builds light per region (`computeRegion`) because a region is what it has
  // blocks for, and a whole-planet pass on a planet that is mostly ungenerated
  // would flood through columns `live` marks as absent. It was also the only
  // caller that could plausibly want the queue at its NUM_VOXELS ceiling, which
  // is what the note on QUEUE_MAX above measures against.

  _flood(blocks, field, head, tail) {
    let q = this._queue;
    let cap = q.length;
    const live = this.live;
    while (head < tail) {
      const i = q[head++];
      const lv = field[i];
      if (lv <= 1) continue;
      const k = i % D;
      const colBase = i - k;
      const col = colBase / D;
      // The neighbour walk is inlined and wraps on both axes, which is the whole
      // of the graph now: no seam, no turn, no ownership test.
      const cy = col % W, cx = (col - cy) / W;
      for (let d = 0; d < 6; d++) {
        let ni, at;
        // The two vertical steps read ATTEN_V and the four tangential ones read
        // ATTEN. Picked inside each branch rather than by selecting an array
        // afterwards: the branches already exist, and choosing between two typed
        // arrays in the hot line is what turns a monomorphic load polymorphic.
        if (d === 4) {
          if (k + 1 >= D) continue;
          ni = i + 1; at = ATTEN_V[blocks[colBase + k + 1]];
        } else if (d === 5) {
          if (k === 0) continue;
          ni = i - 1; at = ATTEN_V[blocks[colBase + k - 1]];
        } else {
          const nc = d === 0 ? (cx * W + (cy === 0 ? W - 1 : cy - 1))
            : d === 1 ? (cx * W + (cy === W - 1 ? 0 : cy + 1))
              : d === 2 ? ((cx === 0 ? W - 1 : cx - 1) * W + cy)
                : ((cx === W - 1 ? 0 : cx + 1) * W + cy);
          if (live !== null && live[nc] === 0) continue;
          ni = nc * D + k;
          at = ATTEN[blocks[nc * D + k]];
        }
        if (at === 255) continue;
        const nv = lv - at;
        if (nv > field[ni]) {
          field[ni] = nv;
          // The common case is the same single compare it always was; growing is
          // the cold branch. The guard stays after the grow as a backstop rather
          // than as the plan: a cell can be enqueued more than once (every time
          // its level improves), so even QUEUE_MAX is not a proof against
          // overflow. Dropping an entry costs some light in a corner, which the
          // next relight fixes; there is nothing to be gained by crashing.
          if (tail < cap) q[tail++] = ni;
          else if (cap < QUEUE_MAX) {
            q = this._ensureQueue(cap * 2);
            cap = q.length;
            if (tail < cap) q[tail++] = ni;
          }
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

    // --- sunlight ---
    let tail = 0;
    for (const list of all) {
      for (let n = 0; n < list.length; n++) {
        const col = list[n];
        const base = col * D;
        tail = this._seedSky(blocks, col, tail);
        // Pull light in from the columns beyond the ring, which keep whatever
        // they already have. Without this the outermost course of the ring is
        // recomputed as if the rest of the planet were dark and the seam moves
        // outward instead of disappearing.
        for (let d = 0; d < 4; d++) {
          const nb = colNeighbor(col, d);
          if (inSet[nb]) continue;
          if (this.live !== null && this.live[nb] === 0) continue;
          const q = this._ensureQueue(tail + D);
          for (let k = 0; k < D; k++) {
            const at = ATTEN[blocks[base + k]];
            if (at === 255) continue;
            const v = this.sun[nb * D + k] - at;
            if (v > this.sun[base + k]) { this.sun[base + k] = v; q[tail++] = base + k; }
          }
        }
      }
    }
    this._flood(blocks, this.sun, 0, tail);

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
          let q = this._ensureQueue(tail + D);
          for (let k = 0; k < D; k++) {
            const b = blocks[base + k];
            const v = LIGHT_EMIT[b] > 0 ? Math.round(LIGHT_EMIT[b] * (scale[b] / 255)) : 0;
            if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
          }
          for (let d = 0; d < 4; d++) {
            const nb = colNeighbor(col, d);
            if (inSet[nb]) continue;
            if (this.live !== null && this.live[nb] === 0) continue;
            q = this._ensureQueue(tail + D);
            for (let k = 0; k < D; k++) {
              const at = ATTEN[blocks[base + k]];
              if (at === 255) continue;
              const v = chan[nb * D + k] - at;
              if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
            }
          }
        }
      }
      this._flood(blocks, chan, 0, tail);
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
          const n = colNeighbor(c, d);
          if (!region.has(n)) { region.add(n); next.push(n); }
        }
      }
      frontier = next;
      if (!next.length) break;
    }

    const cols = [...region];
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

    const inRegion = (col) => region.has(col);

    // --- sunlight ---
    let tail = 0;
    for (const col of cols) {
      const base = col * D;
      tail = this._seedSky(blocks, col, tail);
      // pull light in from neighbouring columns outside the region
      for (let d = 0; d < 4; d++) {
        const n = colNeighbor(col, d);
        if (inRegion(n)) continue;
        const q = this._ensureQueue(tail + D);
        for (let k = 0; k < D; k++) {
          const at = ATTEN[blocks[base + k]];
          if (at === 255) continue;
          const v = this.sun[n * D + k] - at;
          if (v > this.sun[base + k]) { this.sun[base + k] = v; q[tail++] = base + k; }
        }
      }
    }
    this._flood(blocks, this.sun, 0, tail);

    // --- coloured block light ---
    const chans = [this.r, this.g, this.b];
    const scales = [LIGHT_R, LIGHT_G, LIGHT_B];
    for (let c = 0; c < 3; c++) {
      const chan = chans[c], scale = scales[c];
      tail = 0;
      for (const col of cols) {
        const base = col * D;
        let q = this._ensureQueue(tail + D);
        for (let k = 0; k < D; k++) {
          const b = blocks[base + k];
          let v = LIGHT_EMIT[b] > 0 ? Math.round(LIGHT_EMIT[b] * (scale[b] / 255)) : 0;
          if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
        }
        for (let d = 0; d < 4; d++) {
          const n = colNeighbor(col, d);
          if (inRegion(n)) continue;
          q = this._ensureQueue(tail + D);
          for (let k = 0; k < D; k++) {
            const at = ATTEN[blocks[base + k]];
            if (at === 255) continue;
            const v = chan[n * D + k] - at;
            if (v > chan[base + k]) { chan[base + k] = v; q[tail++] = base + k; }
          }
        }
      }
      this._flood(blocks, chan, 0, tail);
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
