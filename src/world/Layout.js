// Storage layout and chunking for the flat wrapped map.
//
// `Grid.js` is the contract and is not edited here. It says where a column IS -
// which face labels it, how the wrap works, how far apart two columns are - and
// it fixes THE AXIS CONVENTION in one place:
//
//   map x   ->  world X
//   layer k ->  world Y, and up is +Y everywhere
//   map y   ->  world Z
//
// so a cell's centre is `(x + 0.5, k + 0.5, y + 0.5)`. Every crossing between
// map space and world space goes through `Grid.worldOf` / `Grid.cellOf`; the
// only thing added below is the fractional corner the mesher needs, and it is
// written as the same convention minus the half.
//
// This file says how a cell is STORED and which chunk it belongs to. Nothing
// here imports three.js, so `Planet.test.mjs` runs it under plain node.

import { W, D, COLUMNS, CELLS, wrap, colIndex } from './Grid.js';

export { W, D, COLUMNS, CELLS };

/** The one up vector. */
export const UP = [0, 1, 0];

/** Fall out of the world: below the array, not away from a planet. */
export const KILL_Y = -64;

// --- storage ---------------------------------------------------------------
//
// `blocks[col * D + k]`, column major, so a column's layers are contiguous.
// That is what the mesher and the raycast both walk, and it is exactly the
// index `Grid.cellIndex` builds - this is the (col, k) spelling of it.

/** Flat array index for a cell, or -1 outside the layer range. */
export const cellIdx = (col, k) => (k < 0 || k >= D ? -1 : col * D + k);

/** The x of a column index. */
export const colX = (col) => (col - (col % W)) / W;
/** The y of a column index. */
export const colY = (col) => col % W;

export function colParts(col, out = { x: 0, y: 0 }) {
  out.y = col % W;
  out.x = (col - out.y) / W;
  return out;
}

/**
 * Step (dx, dy) columns from `col`, wrapping.
 *
 * One piece of arithmetic, correct for any distance, because the map is flat.
 * The cube needed `walkColumns` to turn ninety degrees at every seam, and a
 * long walk that did not turn landed in a clamped heap on the border.
 */
export function stepColumn(col, dx, dy) {
  const y = col % W;
  const x = (col - y) / W;
  return colIndex(x + dx, y + dy);
}

/** Neighbour column, in Grid's direction order: north, south, west, east. */
export const colNeighbor = (col, dir) => (
  dir === 0 ? stepColumn(col, 0, -1)
    : dir === 1 ? stepColumn(col, 0, 1)
      : dir === 2 ? stepColumn(col, -1, 0)
        : stepColumn(col, 1, 0));

// --- chunks and regions ----------------------------------------------------

export const CHUNK_T = 16;               // columns per chunk on x and y
export const CHUNK_K = 11;               // layers per chunk
export const CW = W / CHUNK_T;           // 78 chunks per map axis
export const CK = D / CHUNK_K;           // 8 chunks up
export const NUM_CHUNKS = CW * CW * CK;  // 48 672

/** Wrap a chunk coordinate. Chunk space wraps because column space does. */
export const cwrap = (c) => ((c % CW) + CW) % CW;

/** Chunk id from chunk coordinates, wrapping on both map axes. */
export const chunkIdx = (cx, cy, ck) => (cwrap(cx) * CW + cwrap(cy)) * CK + ck;

export function chunkDecode(id, out = { cx: 0, cy: 0, ck: 0 }) {
  out.ck = id % CK;
  const t = (id - out.ck) / CK;
  out.cy = t % CW;
  out.cx = (t - out.cy) / CW;
  return out;
}

/**
 * A region is one chunk footprint taken to its full depth: the unit of
 * generation, where a chunk is the unit of meshing. Same split the cube had and
 * for the same reasons - the generator's expensive work is per column and runs
 * the whole column at once, and a mesh request names a chunk, so a region that
 * is exactly a chunk's footprint makes "generate what this needs" a lookup.
 */
export const NUM_REGIONS = CW * CW;              // 6 084
export const REGION_COLS = CHUNK_T * CHUNK_T;    // 256
export const REGION_VOXELS = REGION_COLS * D;    // 22 528

export const regionIdx = (rx, ry) => cwrap(rx) * CW + cwrap(ry);

/** A chunk id names exactly one region: drop its layer index. */
export const regionOfChunk = (id) => (id - (id % CK)) / CK;

/** Which region owns a column. */
export function regionOfCol(col) {
  const y = col % W;
  const x = (col - y) / W;
  return ((x / CHUNK_T) | 0) * CW + ((y / CHUNK_T) | 0);
}

/**
 * The 256 column indices a region owns, ascending.
 *
 * Sixteen contiguous runs of sixteen, and that is a property of the packing
 * rather than a coincidence: `col = x * W + y`, so the columns sharing an x are
 * consecutive. The region wire format and `resetWorld` both rely on it.
 */
export function regionColumns(rid, out = new Int32Array(REGION_COLS)) {
  const ry = rid % CW;
  const rx = (rid - ry) / CW;
  const x0 = rx * CHUNK_T, y0 = ry * CHUNK_T;
  let n = 0;
  for (let dx = 0; dx < CHUNK_T; dx++) {
    const base = (x0 + dx) * W + y0;
    for (let dy = 0; dy < CHUNK_T; dy++) out[n++] = base + dy;
  }
  return out;
}

// --- world space -----------------------------------------------------------

/**
 * World position of a cell corner, with fractional x, y and k allowed.
 *
 * The mesher builds every vertex from this, and on a flat map it is the whole
 * of the geometry: a face is a plane, a cell is a unit cube, and a point
 * between four corners is a plain linear blend. Half a unit below `worldOf`, by
 * construction, so the two cannot drift.
 */
export function cellCorner(x, y, k, out = [0, 0, 0]) {
  out[0] = x; out[1] = k; out[2] = y;
  return out;
}

/**
 * World point -> CONTINUOUS cell coordinates, wrapping x and y.
 *
 * `Grid.cellOf` is the integer answer and is what almost everything wants. This
 * keeps the fraction, which two callers genuinely need: the raycast's sub-cell
 * test for cross plants, and anything asking where within a cell it stands.
 * `ck` is not wrapped - there is no wrap on the gravity axis, and a caller
 * above or below the world has to be told so.
 */
export function contCell(wx, wy, wz, out = { cx: 0, cy: 0, ck: 0 }) {
  const fx = Math.floor(wx), fz = Math.floor(wz);
  out.cx = wrap(fx) + (wx - fx);
  out.cy = wrap(fz) + (wz - fz);
  out.ck = wy;
  return out;
}

/** Integer column for a world point. */
export const colAtWorld = (wx, wz) => colIndex(Math.floor(wx), Math.floor(wz));

// --- drawing across the wrap -----------------------------------------------
//
// Storage wraps, and world space does not. A column at x = 3 and a column at
// x = W - 1 are four apart on the map and 1 244 apart in world coordinates, so
// anything placed at its absolute world position is drawn a whole map width
// away from a viewer standing on the other side of the join. On the ground that
// is a hole in the terrain at each of the two wrap lines and at their crossing.
//
// The fix is to draw the COPY NEAREST THE VIEWER. Every world coordinate has
// copies at `v + n * W` for every integer n; exactly one of them is within half
// a map of the viewer, and that is the one to draw. Note what this deliberately
// does NOT do: it does not re-base the world around the camera. The offset is
// zero for everything within W/2 of the view, which is everything except what is
// across a seam, so a position that was already right stays untouched and only
// the far copy moves.

/**
 * The multiple of W to add to world coordinate `v` to bring it as near `view` as
 * the wrap allows. Always a multiple of W, and zero within half a map.
 *
 * Deliberately the same way round as `Grid.delta`, including at exactly half a
 * map, so the two can never disagree about which copy is nearer.
 */
export function nearOffset(view, v) {
  // Into [0, W) first and only then down, which is what puts the range at
  // (-W/2, W/2] and makes a viewer exactly half a map away agree with `delta`
  // about which copy is nearer. Taking the raw remainder instead leaves it
  // signed, and the two then disagree at exactly the half - the one input where
  // the answer is a coin toss and the one place a disagreement is invisible
  // until it is a seam.
  let d = (((v - view) % W) + W) % W;
  if (d > W / 2) d -= W;
  return view + d - v;
}

/** `v`, moved to the copy nearest `view`. */
export const nearWorld = (view, v) => v + nearOffset(view, v);
