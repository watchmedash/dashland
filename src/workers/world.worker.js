// Owns the authoritative voxel + light data for the cubesphere, generates the
// planet region by region as it is asked for, and meshes chunks off the main
// thread.
//
// The planet is not built up front. `WorldGen.generateGlobal` runs once and
// produces only the per-column tables — height, biome, shore distance, canyon
// mask, water connectivity, volcano sites — which is about a second and a half
// of work and a few megabytes. The voxels themselves are built a region at a
// time, the first time a mesh request needs one. See Constants.js for what a
// region is and WorldGen's `generateGlobal` for why the split falls where it
// does.

import { WorldGen, APRON, DECOR_MARGIN } from '../world/WorldGen.js';
import { LightField, MAX_LIGHT } from '../world/Lighting.js';
import { meshChunk } from '../world/Mesher.js';
import {
  F, D, CHUNK_T, CHUNK_K, CT, CK, NUM_REGIONS, REGION_COLS,
  REGION_VOXELS, COLUMNS, NUM_VOXELS, chunkIdx, regionOfCol, regionColumns,
} from '../world/Constants.js';
import { COL_NB } from '../world/Sphere.js';
import {
  IS_DIRECTIONAL, IS_AXIS, IS_SHAPED, IS_FENCE, RENDER_TYPE, R_LIQUID, FACING_DEFAULT,
} from '../world/Blocks.js';

/**
 * Does this block keep an entry in the side-table? Several unrelated things
 * share that byte: a kiln's horizontal facing, a log's axis, water's flow
 * level, a slab's half, a stair's orientation and a ladder's wall. Only the
 * first was listed here originally, so a placed log and every flowing water
 * cell had their entry deleted the moment the edit reached the worker — the
 * main thread resolved them correctly and the mesher never saw them.
 *
 * It now asks IS_SHAPED rather than naming the shapes one at a time. Listing
 * them individually is what let stairs slip through: they are neither
 * directional nor slabs, so a placed stair lost its orientation in transit and
 * came back facing whichever way the default pointed.
 *
 * A fence is the exception the other way round: it is shaped but stores
 * nothing, because its shape is its neighbours. An entry per post would be a
 * quarter of a million zeroes round a large paddock and mean nothing.
 */
const hasSideData = (id) => (IS_DIRECTIONAL[id] || IS_AXIS[id] || IS_SHAPED[id]
  || RENDER_TYPE[id] === R_LIQUID) && !IS_FENCE[id];

let gen = null;
let blocks = null;
let colBiome = null;
let light = null;
/** Mirror of Planet.facing: cell index (`col * D + k`) → facing 0..3. */
let facing = new Map();

/**
 * How far a region has got, as three independent flags rather than one ladder,
 * because a save arrives already past the first two and still needs the third.
 *
 *   hasTerrain  rock, soil, caves and ore are in the block array
 *   hasDecor    trees, boulders, flora and any volcano over it are stamped
 *   hasLight    the light field has been computed for it
 *
 * They are not the same set. A region gets terrain because it happens to be
 * within six columns of one somebody is actually standing in — its neighbour
 * needs to know what is there to hang a canopy over the boundary — and that is
 * all it gets until it is asked for in its own right.
 */
const hasTerrain = new Uint8Array(NUM_REGIONS);
const hasDecor = new Uint8Array(NUM_REGIONS);
const hasLight = new Uint8Array(NUM_REGIONS);
/** Per-column form of hasDecor, for the light field. See LightField.live. */
const colLive = new Uint8Array(COLUMNS);

/**
 * Skylight's exact horizontal reach: it starts at 15 and loses at least one per
 * step. A column further than this from a new region cannot be affected by it,
 * so a ring of this width is the whole correction and not an estimate.
 */
const LIGHT_REACH = MAX_LIGHT;

/**
 * Rebuild the side-table from transferred [index, facing] pairs, then give any
 * directional block that has no entry a sane default. That second pass is what
 * makes a save written before facing existed load without a hole in it.
 */
function restoreFacing(pairs) {
  facing = new Map();
  if (!pairs || !pairs.length) return;
  for (const [idx, v] of pairs) facing.set(idx, v & 7);
  /**
   * The backfill walks the regions the save actually restored, not the whole
   * planet.
   *
   * It used to be `for (let i = 0; i < blocks.length; i++)` — all 127 885 824
   * voxels, on every load — and the scan was the smaller half of the cost.
   * `blocks` is freshly allocated a few lines up in the same handler, so
   * everything outside a restored region is a zero byte that no page has been
   * written to yet; reading all of it is what drags the entire 122 MB array into
   * residency. Measured on this machine, touching one page of every 4 KB of an
   * array that size costs 129 MB of working set, and none of it is memory the
   * session goes on to use.
   *
   * Restricting it to `hasDecor` is exact rather than a heuristic. Both restore
   * paths set that flag over precisely the regions they wrote — `restoreRegions`
   * per region, and the pre-streaming whole-planet path with `hasDecor.fill(1)`
   * — and air is not a directional block, so every cell this now skips would
   * have failed `IS_DIRECTIONAL` anyway. The map comes out with the same entries.
   */
  const rcols = new Int32Array(REGION_COLS);
  for (let rid = 0; rid < NUM_REGIONS; rid++) {
    if (!hasDecor[rid]) continue;
    regionColumns(rid, rcols);
    for (let c = 0; c < REGION_COLS; c++) {
      const base = rcols[c] * D;
      for (let k = 0; k < D; k++) {
        const i = base + k;
        if (IS_DIRECTIONAL[blocks[i]] && !facing.has(i)) facing.set(i, FACING_DEFAULT);
      }
    }
  }
}

function transfers(groups, crossLight) {
  const t = [];
  for (const g of groups) {
    if (!g) continue;
    t.push(g.position.buffer, g.normal.buffer, g.tangent.buffer, g.uv.buffer,
      g.aux.buffer, g.blockLight.buffer, g.tint.buffer, g.quadSize.buffer,
      g.index.buffer);
  }
  // Transferred, not copied, exactly like the vertex data. It is only tens of
  // bytes for a typical chunk, but a plain array of {col, k, light} objects
  // would be structured-cloned per entry per remesh — and a remesh happens
  // every time any block within seventeen cells of a flower changes.
  if (crossLight) t.push(crossLight.buffer);
  return t;
}

/**
 * A fingerprint of the last mesh posted for each resident chunk, so an
 * unchanged rebuild can be dropped before it crosses the wire.
 *
 * The marking above is deliberately conservative — "this cell changed, so
 * rebuild everything that could read it" — because the cheap alternative is the
 * one that leaves seams. Most of what it catches genuinely changed; the rest is
 * a chunk that samples a relit cell and has no face there to show it, which
 * underground is most of them. Measured over a walk across seven region
 * boundaries: 125 chunks rebuilt per step, 86 of them different.
 *
 * The mesh still gets built either way — this cannot save that, and it is not
 * meant to. What it saves is the expensive half: a structured clone, eight
 * BufferAttributes, a bounding sphere and a GPU upload on the main thread, for
 * geometry identical to what is already in VRAM. Hashing a chunk is tens of
 * microseconds against that.
 */
const meshHash = new Map();

/** FNV-1a over the words of a buffer. Not a checksum against an adversary. */
function hashInto(h, buf) {
  // A word view needs a 4-aligned start and the mesher's arrays are all freshly
  // allocated, so this is the path every time; the byte fallback is there so a
  // future subarray cannot turn a fast path into a thrown RangeError.
  if ((buf.byteOffset & 3) === 0) {
    const w = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619) >>> 0;
  } else {
    const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
  }
  // The trailing bytes a word view cannot reach, plus the length itself so two
  // differently sized arrays can never collide on a shared prefix.
  return Math.imul(h ^ buf.byteLength, 16777619) >>> 0;
}

function meshFingerprint(groups) {
  let h = 2166136261;
  for (let gi = 0; gi < 4; gi++) {
    const g = groups[gi];
    if (!g) { h = Math.imul(h ^ 0x9e37, 16777619) >>> 0; continue; }
    h = hashInto(h, g.position);
    h = hashInto(h, g.uv);
    h = hashInto(h, g.aux);
    h = hashInto(h, g.blockLight);
    h = hashInto(h, g.tint);
    h = hashInto(h, g.index);
  }
  return h;
}

function meshAndPost(f, ci, cj, ck) {
  const { groups, crossLight } = meshChunk(blocks, colBiome, gen.colWaterStyle,
    light, facing, f, ci, cj, ck);
  // Normal, tangent and crossLight are left out of the fingerprint: the first
  // two are a function of the face a quad sits on, so they cannot differ
  // between two meshes whose positions and indices agree, and crossLight is
  // derived from the same light bytes `blockLight` already covers.
  const id = chunkIdx(f, ci, cj, ck);
  const fp = meshFingerprint(groups);
  if (meshHash.get(id) === fp) return;
  meshHash.set(id, fp);
  // `crossLight` rides with the geometry rather than in a message of its own,
  // because it must land in the same tick as the mesh it belongs to: it is the
  // light of blocks this chunk deliberately did *not* mesh, and the main thread
  // keys it by chunk id. Two messages could interleave with an eviction and
  // leave a chunk holding light for flowers it no longer has.
  self.postMessage({ type: 'chunk', f, ci, cj, ck, groups, crossLight },
    transfers(groups, crossLight));
}

/**
 * Chunks that currently have a mesh on the main thread. An edit only remeshes
 * what is resident — otherwise every block placed would rebuild geometry for
 * parts of the planet nobody is looking at, and post it to a main thread that
 * would throw it away.
 */
const resident = new Set();

/** Mesh a batch of chunk ids, reporting progress if this is the first load. */
function meshBatch(ids, withProgress) {
  // Outermost layers first, so the surface appears before the deep rock.
  const order = [...ids].sort((a, b) => (b % CK) - (a % CK));
  let done = 0;
  for (const id of order) {
    if (resident.has(id)) continue;
    const ck = id % CK;
    const t = (id - ck) / CK;
    const cj = t % CT;
    const t2 = (t - cj) / CT;
    const ci = t2 % CT;
    meshAndPost((t2 - ci) / CT, ci, cj, ck);
    resident.add(id);
    if (withProgress && (++done & 15) === 0) {
      self.postMessage({ type: 'progress', p: 0.85 + 0.15 * (done / order.length), label: 'Building terrain' });
    }
  }
}

/**
 * The 21 columns `markChunkAround` reaches — itself, its four neighbours and
 * their four neighbours — reduced to each one's chunk id with `ck` left off.
 *
 * A chunk id is `((f * CT + ci) * CT + cj) * CK + ck`, so everything but the
 * last term depends on the column alone. Caching that here is what makes the
 * neighbourhood walk cost once per *column* instead of once per cell: all three
 * callers iterate k inside one column — the edge diff walks D layers of one
 * column, and both light callbacks report changed cells column by column — so a
 * single-entry memo hits on 98 of every 99 calls.
 *
 * The list keeps its duplicates. Two graph steps from a column reach itself and
 * its neighbours several times over, and the caller's Set is what removes them;
 * pruning here would only move the same work earlier.
 */
const _naBase = new Int32Array(21);
let _naCol = -1;

function neighborhoodBases(col) {
  if (_naCol === col) return _naBase;
  _naCol = col;
  let n = 0;
  const put = (c) => {
    const f = (c / (F * F)) | 0;
    const rem = c - f * F * F;
    const ci = ((rem / F) | 0) / CHUNK_T | 0;
    const cj = (rem % F) / CHUNK_T | 0;
    _naBase[n++] = ((f * CT + ci) * CT + cj) * CK;
  };
  put(col);
  for (let d = 0; d < 4; d++) {
    const nb = COL_NB[col * 4 + d];
    put(nb);
    for (let e = 0; e < 4; e++) put(COL_NB[nb * 4 + e]);
  }
  return _naBase;
}

/**
 * Which radial chunk a layer falls in, clamped exactly as it always was:
 * `Math.min(CK - 1, Math.max(0, Math.floor(k / CHUNK_K)))`. `k` is only ever
 * non-negative here after the guard, so the truncating `| 0` is the floor.
 */
const ckOf = (k) => (k < 0 ? 0 : Math.min(CK - 1, (k / CHUNK_K) | 0));

/**
 * Mark every chunk that draws anything from this cell — not just the one that
 * contains it.
 *
 * A face is lit and occluded by the cell on the *other side* of it, so a chunk
 * routinely reads a cell that is not in it: a top face samples `k + 1`, an
 * inward face `k - 1`, a side face the neighbour column, and every
 * ambient-occlusion corner reads a diagonal. Marking only the containing chunk
 * therefore misses the reader.
 *
 * It bites hardest on light, because an opaque block's light is always 0 and so
 * never *changes*: place a torch under a stone ceiling that happens to sit above
 * a radial chunk boundary and the air below it relights, the ceiling block does
 * not, its chunk is never marked, and the ceiling stays black until something
 * unrelated rebuilds it. Laterally the same thing draws a dark seam along a
 * tile boundary. Chunks are 16 columns and 11 layers, so the boundaries are
 * regular and so are the artefacts.
 *
 * Two steps through the adjacency graph rather than arithmetic on the column
 * index, which is wrong across a cube seam. The Set makes the overlap free.
 *
 * The three radial steps are collapsed rather than walked. `ck` is monotonic in
 * `k`, and a chunk is CHUNK_K = 11 layers deep, so `k - 1`, `k` and `k + 1` land
 * in the same radial chunk ten times in eleven and in two distinct ones
 * otherwise — never three. Skipping a repeat is therefore exact, not an
 * approximation, and it is the same set either way because the Set was already
 * absorbing the repeats.
 */
function markChunkAround(set, col, k) {
  const base = neighborhoodBases(col);
  let prev = -1;
  for (let dk = -1; dk <= 1; dk++) {
    const ck = ckOf(k + dk);
    if (ck === prev) continue;
    prev = ck;
    for (let n = 0; n < 21; n++) set.add(base[n] + ck);
  }
}

// --- region generation -------------------------------------------------------

/** A chunk id names exactly one region: drop its radial index. */
const regionOfChunk = (id) => (id - (id % CK)) / CK;

const _mark = new Uint8Array(COLUMNS);
let _dbuf = new Int32Array(1 << 16);

/**
 * Every column within `steps` graph steps of `cols`, including `cols` itself.
 *
 * Over the column graph rather than over face coordinates, because both callers
 * care about real adjacency and a cube seam is where those two stop agreeing —
 * a region on the edge of a face has neighbours on another face, in another
 * frame, and a rectangle in (i, j) does not find them.
 */
function dilate(cols, steps) {
  let buf = _dbuf;
  let n = 0;
  const push = (c) => {
    if (n === buf.length) {
      const b2 = new Int32Array(buf.length * 2);
      b2.set(buf);
      buf = b2;
    }
    buf[n++] = c;
  };
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!_mark[c]) { _mark[c] = 1; push(c); }
  }
  let start = 0;
  for (let s = 0; s < steps; s++) {
    const end = n;
    for (let i = start; i < end; i++) {
      const c = buf[i];
      for (let d = 0; d < 4; d++) {
        const nb = COL_NB[c * 4 + d];
        if (nb < 0 || _mark[nb]) continue;
        _mark[nb] = 1;
        push(nb);
      }
    }
    start = end;
    if (start === n) break;
  }
  _dbuf = buf;
  const out = buf.slice(0, n);
  for (let i = 0; i < n; i++) _mark[buf[i]] = 0;
  return out;
}

/**
 * The columns of `cols` that lie within `steps` of something outside it — its
 * inward-facing rim, not the ring around it.
 *
 * Two dilations rather than a distance field: out to find what surrounds the
 * set, then back in from that to find which of the set it can reach. Over the
 * column graph for the usual reason, and it cannot use `_mark` to hold the
 * membership test across a `dilate` call, because `dilate` uses `_mark` itself
 * and would then skip its own seeds. Hence a second flag array.
 */
const _inSet = new Uint8Array(COLUMNS);

function perimeter(cols, steps) {
  for (let n = 0; n < cols.length; n++) _inSet[cols[n]] = 1;
  const around = dilate(cols, steps);
  const outer = [];
  for (let n = 0; n < around.length; n++) if (!_inSet[around[n]]) outer.push(around[n]);
  const back = dilate(outer, steps);
  const out = [];
  for (let n = 0; n < back.length; n++) if (_inSet[back[n]]) out.push(back[n]);
  for (let n = 0; n < cols.length; n++) _inSet[cols[n]] = 0;
  return out;
}

/** The columns of a list of regions, as one array. */
function collectCols(rids) {
  const out = new Int32Array(rids.length * REGION_COLS);
  const tmp = new Int32Array(REGION_COLS);
  for (let n = 0; n < rids.length; n++) {
    regionColumns(rids[n], tmp);
    out.set(tmp, n * REGION_COLS);
  }
  return out;
}

function ensureTerrain(rid) {
  if (hasTerrain[rid]) return;
  hasTerrain[rid] = 1;
  const cols = regionColumns(rid, new Int32Array(REGION_COLS));
  for (let n = 0; n < REGION_COLS; n++) gen.terrainColumn(blocks, cols[n]);
}

/**
 * Which regions a volcano will eventually write into.
 *
 * A site is rejected during selection unless its whole apron fits inside its
 * own face, so this is a rectangle in that face's coordinates and needs no
 * seam handling at all — which is the second reason that rule is worth keeping.
 */
function volcanoRegions(site) {
  const out = [];
  const i0 = Math.floor((site.i - APRON) / CHUNK_T);
  const i1 = Math.floor((site.i + APRON) / CHUNK_T);
  const j0 = Math.floor((site.j - APRON) / CHUNK_T);
  const j1 = Math.floor((site.j + APRON) / CHUNK_T);
  for (let ri = i0; ri <= i1; ri++) {
    for (let rj = j0; rj <= j1; rj++) out.push((site.f * CT + ri) * CT + rj);
  }
  return out;
}

/**
 * Pull a volcano's whole footprint into the batch that touches any of it.
 *
 * A cone is forty columns across and reads the ground under every one of them,
 * so it cannot be built a region at a time and it cannot be built after the
 * trees: it would find a canopy where it expected soil, and it would overwrite
 * ground that a neighbouring region had already grown a forest on and posted to
 * the main thread. Generating all sixteen of its regions together is the only
 * arrangement that keeps the stamp atomic. It costs a longer pause the first
 * time a volcano comes over the horizon — 150ms or so, in the worker, at the
 * far edge of the view distance rather than underfoot.
 */
function expandForVolcanoes(set) {
  if (!gen.volcanoes) return;
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const site of gen.volcanoes) {
      if (site.stamped) continue;
      if (!site.regions) site.regions = volcanoRegions(site);
      let touches = false;
      for (const r of site.regions) if (set.has(r)) { touches = true; break; }
      if (!touches) continue;
      for (const r of site.regions) if (!set.has(r)) { set.add(r); grew = true; }
    }
    if (!grew) break;
  }
}

/**
 * Bring a set of regions all the way up: terrain, decoration, light.
 *
 * Everything here is a batch rather than a loop over single regions, and that
 * is deliberate. Decoration needs a margin of terrain around it and lighting
 * needs a ring of relight around it, and those margins overlap heavily between
 * neighbouring regions — doing three hundred regions one at a time would pay
 * for the overlap three hundred times. The first load asks for the whole
 * horizon at once and gets one margin and one ring for all of it.
 *
 * @returns {number[]} the regions whose voxels changed, for the main thread
 */
function ensureRegions(rids, onProgress) {
  const want = new Set();
  for (const r of rids) if (!hasDecor[r]) want.add(r);
  expandForVolcanoes(want);
  const fresh = [...want];
  const dirty = new Set();

  if (fresh.length) {
    onProgress?.(0.05, 'Laying rock and soil');
    const cols = collectCols(fresh);

    /**
     * The two courses of this batch that a chunk outside it can see, and what
     * they hold before anything is written to them.
     *
     * A chunk is culled and lit by the columns just *outside* itself, so a
     * region that has had a mesh on screen since before this batch existed is
     * reading into `cols` — and the blocks about to land there are decoration,
     * which is exactly the part of worldgen that arrives late. A region gets
     * terrain as somebody else's `DECOR_MARGIN` long before it is decorated in
     * its own right, so the neighbour meshed against bare ground and kept that
     * mesh; the trunk, the canopy and the boulder that turn up afterwards never
     * reach it. That is a straight seam along a region boundary, sixteen
     * columns long, in the shadow the missing tree should have cast — and it
     * survives until something unrelated rebuilds the chunk, which is precisely
     * what breaking a block near it does.
     *
     * Snapshotted here rather than diffed some other way because this is the
     * last moment the old state exists, and taken before `ensureTerrain`
     * because that is the state the neighbour was meshed against: DECOR_MARGIN
     * is 6, so anything within two columns of a decorated region had its rock
     * and soil laid in the batch that decorated it, never later.
     *
     * Two courses, and no more, because the reader can be no further away than
     * that: the mesher's ambient-occlusion corners reach a diagonal, which is
     * two steps, and a column three steps inside the batch has no chunk outside
     * it that samples it. Everything deeper in is about to be meshed from
     * scratch anyway.
     */
    const edge = perimeter(cols, 2);
    const edgeWas = new Uint8Array(edge.length * D);
    for (let n = 0; n < edge.length; n++) {
      const base = edge[n] * D;
      edgeWas.set(blocks.subarray(base, base + D), n * D);
    }

    // Terrain for the region and for everything a canopy could reach in from.
    // See WorldGen.decorateRegion.
    const margin = dilate(cols, DECOR_MARGIN);
    const need = new Set();
    for (let n = 0; n < margin.length; n++) need.add(regionOfCol(margin[n]));
    let done = 0;
    for (const rid of need) {
      ensureTerrain(rid);
      if (onProgress && (++done & 31) === 0) {
        onProgress(0.05 + 0.70 * (done / need.size), 'Laying rock and soil');
      }
    }

    onProgress?.(0.76, 'Lighting the vents');
    for (const site of gen.volcanoes) {
      if (site.stamped || !site.regions) continue;
      if (!site.regions.some((r) => want.has(r))) continue;
      gen.stampVolcano(blocks, site);
    }

    onProgress?.(0.78, 'Growing forests');
    const rcols = new Int32Array(REGION_COLS);
    for (const rid of fresh) {
      regionColumns(rid, rcols);
      // Ascending column order, which is the order the old planet-wide pass
      // walked in and the reason the result does not depend on which region
      // was built first.
      const dec = dilate(rcols, DECOR_MARGIN);
      dec.sort();
      gen.decorateRegion(blocks, rcols, dec);
      hasDecor[rid] = 1;
    }
    // Only now — the light flood treats a column that is not live as opaque,
    // and a half-decorated region must look like solid ground, not like a hole.
    for (const rid of fresh) {
      regionColumns(rid, rcols);
      for (let n = 0; n < REGION_COLS; n++) colLive[rcols[n]] = 1;
    }

    // What a chunk already on screen can now see of this batch. See `edge` and
    // the snapshot above.
    for (let n = 0; n < edge.length; n++) {
      const base = edge[n] * D, o = n * D;
      for (let k = 0; k < D; k++) {
        if (edgeWas[o + k] !== blocks[base + k]) markChunkAround(dirty, edge[n], k);
      }
    }
  }

  const dark = [];
  const seen = new Set();
  for (const r of rids) if (!hasLight[r] && !seen.has(r)) { seen.add(r); dark.push(r); }
  for (const r of fresh) if (!hasLight[r] && !seen.has(r)) { seen.add(r); dark.push(r); }

  if (dark.length) {
    onProgress?.(0.86, 'Kindling sunlight');
    const cols = collectCols(dark);
    // Dilate first, *then* flag what to exclude. The other order looks
    // equivalent and is not: `dilate` seeds through `_mark` as well, so a set
    // pre-flagged in it is a set whose every seed is skipped — the frontier
    // starts empty, `reach` comes back empty, and the ring is empty every time.
    // That is the whole reason a newly lit region never relit anything around
    // it: `computeRegion` was handed no edge to snapshot, so it had nothing to
    // diff and reported no change, and the neighbours already on screen kept
    // the light they were built with. A dark seam along a region boundary until
    // an edit rebuilt the chunk. Nothing crashes when a ring is empty, which is
    // why it stayed.
    const reach = dilate(cols, LIGHT_REACH);
    /**
     * The new regions' own rim goes in the diffed list too, even though it is
     * already in `cols`.
     *
     * `computeRegion` recomputes both lists and reports only the second, on the
     * reasoning that the new region has no mesh yet and is about to get one.
     * True of the region — not true of its neighbour. A chunk samples the light
     * of the cells across its boundary for its side faces and its ambient
     * occlusion, so the neighbour's mesh is holding this batch's light, and this
     * batch's light is the one thing here that was zero five lines ago. Nothing
     * inside the ring changes at all in that case: measured on a region lit
     * alone and then surrounded, the ring diff reported zero changed cells and
     * two of its nine chunks were still wrong, entirely in `blockLight`.
     *
     * Listing a column twice is safe by construction — the snapshot is taken
     * before either list is cleared, seeding is idempotent, and the membership
     * flags are set and cleared per list.
     */
    const rim = perimeter(cols, 2);
    for (let n = 0; n < cols.length; n++) _inSet[cols[n]] = 1;
    const ring = [];
    for (let n = 0; n < reach.length; n++) {
      const c = reach[n];
      if (!_inSet[c] && colLive[c]) ring.push(c);
    }
    for (let n = 0; n < cols.length; n++) _inSet[cols[n]] = 0;
    for (let n = 0; n < rim.length; n++) ring.push(rim[n]);
    // markChunkAround, not markChunk, for the reason its own comment gives: a
    // cell's light is read by chunks that do not contain it. The relight ring
    // is fifteen columns wide, so it reaches past the neighbours the block pass
    // above already covered, and out there the reader is the only thing that
    // changed.
    light.computeRegion(blocks, cols, ring, (col, k) => markChunkAround(dirty, col, k));
    for (const r of dark) hasLight[r] = 1;
  }

  onProgress?.(1, 'Building terrain');
  return { fresh, dirty };
}

/** Ship freshly built regions to the main thread's mirror. */
function postRegions(fresh) {
  if (!fresh.length) return;
  const ids = new Int32Array(fresh);
  const data = new Uint8Array(fresh.length * REGION_VOXELS);
  const tmp = new Int32Array(REGION_COLS);
  for (let n = 0; n < fresh.length; n++) {
    regionColumns(fresh[n], tmp);
    let o = n * REGION_VOXELS;
    // Sixteen contiguous runs, not 256 — columns of one region that share an
    // `i` are consecutive in the block array, so a row of the tile is one copy.
    for (let row = 0; row < CHUNK_T; row++) {
      const base = tmp[row * CHUNK_T] * D;
      data.set(blocks.subarray(base, base + CHUNK_T * D), o);
      o += CHUNK_T * D;
    }
  }
  self.postMessage({ type: 'regions', ids, data }, [ids.buffer, data.buffer]);
}

/** The reverse, for a save being restored. */
function restoreRegions(ids, data) {
  const tmp = new Int32Array(REGION_COLS);
  for (let n = 0; n < ids.length; n++) {
    const rid = ids[n];
    regionColumns(rid, tmp);
    let o = n * REGION_VOXELS;
    for (let row = 0; row < CHUNK_T; row++) {
      const base = tmp[row * CHUNK_T] * D;
      blocks.set(data.subarray(o, o + CHUNK_T * D), base);
      o += CHUNK_T * D;
    }
    hasTerrain[rid] = 1;
    hasDecor[rid] = 1;
    for (let c = 0; c < REGION_COLS; c++) colLive[tmp[c]] = 1;
  }
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init' || msg.type === 'load') {
    gen = new WorldGen(msg.seed);
    blocks = new Uint8Array(NUM_VOXELS);
    hasTerrain.fill(0); hasDecor.fill(0); hasLight.fill(0); colLive.fill(0);
    resident.clear();
    meshHash.clear();

    // The whole eager half of worldgen, and the only part a New Game waits on.
    const res = gen.generateGlobal((p, label) => self.postMessage({
      type: 'progress', p: p * 0.55, label,
    }));
    // A save carries its own biome map. It is derived data — the same seed
    // regenerates it exactly — but a save written by a version whose climate
    // thresholds have since moved would otherwise come back with the terrain it
    // stored and the biome tints of a different planet.
    colBiome = msg.colBiome ? new Uint8Array(msg.colBiome) : res.colBiome;

    light = new LightField();
    light.live = colLive;

    if (msg.type === 'load') {
      self.postMessage({ type: 'progress', p: 0.58, label: 'Restoring your planet' });
      if (msg.regions && msg.data) {
        restoreRegions(new Int32Array(msg.regions), new Uint8Array(msg.data));
      } else if (msg.blocks) {
        // A save from before the world went lazy: the entire block array, and
        // every region of it already built.
        blocks.set(new Uint8Array(msg.blocks));
        hasTerrain.fill(1); hasDecor.fill(1); colLive.fill(1);
      }
      /**
       * A volcano that is already in the save must never be built again.
       *
       * Restored blocks are authoritative — they carry whatever the player did
       * to the cone — and `stampVolcano` would pave straight over them. This is
       * safe to decide one site at a time because a volcano is all-or-nothing:
       * `expandForVolcanoes` pulls its entire footprint into whichever batch
       * first touches any of it, so its sixteen regions are always live
       * together and are always saved together. There is no half a volcano.
       */
      for (const site of gen.volcanoes) {
        if (!site.regions) site.regions = volcanoRegions(site);
        if (site.regions.some((r) => hasDecor[r])) site.stamped = true;
      }
      restoreFacing(msg.facing);
    }

    const bio = colBiome.slice();
    const hgt = res.colHeight.slice();
    // No voxels ride along with this. The main thread gets the per-column
    // tables — which is what it needs to place the player and to reason about
    // ground it has not built yet — and the blocks arrive region by region as
    // `regions` messages once it says which chunks it wants.
    self.postMessage({
      type: 'world', colBiome: bio, colHeight: hgt, spawn: res.spawn,
      live: msg.type === 'load' ? [...liveRegionIds()] : [],
    }, [bio.buffer, hgt.buffer]);

    self.postMessage({ type: 'progress', p: 0.62, label: 'Laying rock and soil' });
    return;
  }

  if (msg.type === 'chunks') {
    // The fingerprint goes with the residency: the main thread has disposed
    // this chunk's geometry, so the next mesh has to be posted whatever it
    // hashes to.
    for (const id of msg.drop || []) { resident.delete(id); meshHash.delete(id); }
    const add = msg.add || [];

    const rids = [];
    const seen = new Set();
    for (const id of add) {
      const r = regionOfChunk(id);
      if (!seen.has(r)) { seen.add(r); rids.push(r); }
    }

    const { fresh, dirty } = ensureRegions(rids, msg.initial
      ? (p, label) => self.postMessage({ type: 'progress', p: 0.62 + 0.23 * p, label })
      : null);
    postRegions(fresh);

    const added = new Set(add);
    meshBatch(add, !!msg.initial);
    // Relighting a new region takes light away from its neighbours, and some of
    // those already have a mesh on screen. `meshBatch` has just claimed the new
    // chunks, so anything still in `dirty` and resident is genuinely stale.
    for (const id of dirty) {
      if (!resident.has(id) || added.has(id)) continue;
      const ck = id % CK;
      const t = (id - ck) / CK;
      const cj = t % CT;
      const t2 = (t - cj) / CT;
      const ci = t2 % CT;
      meshAndPost((t2 - ci) / CT, ci, cj, ck);
    }

    if (msg.initial) self.postMessage({ type: 'ready' });
    else self.postMessage({ type: 'streamDone' });
    return;
  }

  if (msg.type === 'edit') {
    const dirty = new Set();
    const seeds = [];
    for (const ed of msg.edits) {
      const idx = ed.col * D + ed.k;
      blocks[idx] = ed.id;
      // The main thread resolves the facing and sends it explicitly; a
      // non-directional block clears the entry so it cannot go stale.
      // Water is the one case where a missing byte is meaningful rather than
      // absent: level 0 means "never flowed", i.e. a worldgen source, and that
      // is also what a brim-full cell should read as. So the default is 0 for
      // everything except a kiln, whose front has to point somewhere.
      if (hasSideData(ed.id)) {
        facing.set(idx, (ed.facing ?? (IS_DIRECTIONAL[ed.id] ? FACING_DEFAULT : 0)) & 7);
      } else {
        facing.delete(idx);
      }
      seeds.push(ed.col);
      // The edited cell and everything that reads it. That means the *diagonal*
      // columns too, not only the four axis neighbours: the mesher resolves
      // `nPiPj`/`nPiMj`/`nMiPj`/`nMiMj` and every ambient-occlusion corner
      // quartet includes one. Edit the +i+j corner column of a chunk and the
      // cell diagonally across the boundary samples it for both its occlusion
      // and its smooth light, in a chunk nothing had marked.
      //
      // The relight pass below does not rescue it. It reports only cells whose
      // light byte actually changed, and out in open sky the neighbour still
      // gets full sun from directly above — so nothing changes there, nothing
      // is queued, and a quarter of the contact shadow is missing until that
      // chunk is rebuilt for some unrelated reason. Roughly one edit in 256
      // lands on a corner column.
      //
      markChunkAround(dirty, ed.col, ed.k);
    }

    light.relight(blocks, seeds, 17, (col, k) => markChunkAround(dirty, col, k));

    for (const id of dirty) {
      // Rebuilding a chunk with no mesh would post geometry the main thread
      // immediately discards, and relighting can dirty chunks far out of sight.
      if (!resident.has(id)) continue;
      const ck = id % CK;
      const t = (id - ck) / CK;
      const cj = t % CT;
      const t2 = (t - cj) / CT;
      const ci = t2 % CT;
      const f = (t2 - ci) / CT;
      meshAndPost(f, ci, cj, ck);
    }
    // No reply. There used to be an `editDone` carrying `msg.id` back, and the
    // main thread has no case for it in `_onWorldMessage` — the id it sends is
    // its own local `editSeq`, used there as a cache stamp for the highlight and
    // the tooltip and never compared against anything the worker says. So the
    // ack was a message per placed block that fell through a switch. An edit is
    // acknowledged by the chunk meshes it causes, which are posted above.
  }
};

/** Regions the main thread should already consider filled — a restored save. */
function* liveRegionIds() {
  for (let r = 0; r < NUM_REGIONS; r++) if (hasDecor[r]) yield r;
}
