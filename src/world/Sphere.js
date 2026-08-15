// Cube-planet geometry. Keeps the export names the cubesphere had, so callers
// still speak (col, k); only the mapping to world space changed.
//
// col = (face, i, j) with i, j in [0, F), F = 2 * PLANET_R, so a column is one
// block wide. k is depth along the face normal: normal coordinate = R_MIN + k.
// Cells are perfect cubes, one unit each, everywhere.

import {
  FACES, F, D, R_MIN, PLANET_R, ARR_R, SIDE, COLUMNS, cidx,
} from './Constants.js';

// Per face: outward normal, and the two in-face axes (i runs along A, j along B).
export const FACE_N = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
// A x B must equal N on every face. Three of them used to be left-handed, which
// flips the winding of every quad the mesher emits (so half the planet renders
// back-faces and is invisible), mirrors the frame the camera is built from, and
// mirrors the axes physics and mob seating read. One sign per face fixes all of
// it, so the signs below are not cosmetic.
export const FACE_R = [
  [0, 1, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0],
];
export const FACE_U = [
  [0, 0, 1], [0, 0, -1], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0],
];

/** Which world axis each face's normal / A / B lies on, and its sign. */
const AX_N = [0, 0, 1, 1, 2, 2];
const SG_N = [1, -1, 1, -1, 1, -1];
const AX_A = [1, 1, 0, 0, 0, 0];
const SG_A = [1, 1, 1, 1, 1, -1];
const AX_B = [2, 2, 2, 2, 1, 1];
const SG_B = [1, -1, -1, 1, 1, 1];

/** In-face coordinate -> world coordinate on that axis, and back. */
const aOut = (f, ci) => (SG_A[f] > 0 ? ci - PLANET_R : PLANET_R - ci);
const bOut = (f, cj) => (SG_B[f] > 0 ? cj - PLANET_R : PLANET_R - cj);
const aIn = (f, w) => (SG_A[f] > 0 ? w + PLANET_R : PLANET_R - w);
const bIn = (f, w) => (SG_B[f] > 0 ? w + PLANET_R : PLANET_R - w);

export const gridToAxis = (g) => (g / F) * 2 - 1;
export const axisToGrid = (a) => ((a + 1) * 0.5) * F;

/** Unit direction of the cube-surface point at face coords (a, b) in [-1, 1]. */
export function faceDir(f, a, b, out = [0, 0, 0]) {
  const N = FACE_N[f], R = FACE_R[f], U = FACE_U[f];
  const x = N[0] + a * R[0] + b * U[0];
  const y = N[1] + a * R[1] + b * U[1];
  const z = N[2] + a * R[2] + b * U[2];
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** World direction -> {f, a, b}. */
export function dirToFace(x, y, z, out = { f: 0, a: 0, b: 0 }) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f;
  if (ax >= ay && ax >= az) f = x >= 0 ? 0 : 1;
  else if (ay >= az) f = y >= 0 ? 2 : 3;
  else f = z >= 0 ? 4 : 5;
  const N = FACE_N[f], R = FACE_R[f], U = FACE_U[f];
  const n = x * N[0] + y * N[1] + z * N[2];
  out.f = f;
  out.a = (x * R[0] + y * R[1] + z * R[2]) / n;
  out.b = (x * U[0] + y * U[1] + z * U[2]) / n;
  return out;
}

// --- precomputed direction tables (mesher reads these for cross-plant bases) --

export const CORNER_DIR = new Float32Array(FACES * (F + 1) * (F + 1) * 3);
export const CENTER_DIR = new Float32Array(FACES * F * F * 3);

(function buildTables() {
  const tmp = [0, 0, 0];
  for (let f = 0; f < FACES; f++) {
    for (let i = 0; i <= F; i++) {
      const a = gridToAxis(i);
      for (let j = 0; j <= F; j++) {
        faceDir(f, a, gridToAxis(j), tmp);
        const o = ((f * (F + 1) + i) * (F + 1) + j) * 3;
        CORNER_DIR[o] = tmp[0]; CORNER_DIR[o + 1] = tmp[1]; CORNER_DIR[o + 2] = tmp[2];
      }
    }
    for (let i = 0; i < F; i++) {
      const a = gridToAxis(i + 0.5);
      for (let j = 0; j < F; j++) {
        faceDir(f, a, gridToAxis(j + 0.5), tmp);
        const o = ((f * F + i) * F + j) * 3;
        CENTER_DIR[o] = tmp[0]; CENTER_DIR[o + 1] = tmp[1]; CENTER_DIR[o + 2] = tmp[2];
      }
    }
  }
})();

export function centerDir(f, i, j, out = [0, 0, 0]) {
  const o = ((f * F + i) * F + j) * 3;
  out[0] = CENTER_DIR[o]; out[1] = CENTER_DIR[o + 1]; out[2] = CENTER_DIR[o + 2];
  return out;
}

/** World position of a cell corner. */
export function cornerPos(f, i, j, k, out = [0, 0, 0]) {
  const m = R_MIN + k;
  out[0] = out[1] = out[2] = 0;
  out[AX_N[f]] = SG_N[f] * m;
  out[AX_A[f]] = aOut(f, i);
  out[AX_B[f]] = bOut(f, j);
  return out;
}

/** World position of a cell centre. */
export function cellCenterPos(f, i, j, k, out = [0, 0, 0]) {
  const m = R_MIN + k + 0.5;
  out[0] = out[1] = out[2] = 0;
  out[AX_N[f]] = SG_N[f] * m;
  out[AX_A[f]] = aOut(f, i + 0.5);
  out[AX_B[f]] = bOut(f, j + 0.5);
  return out;
}


/**
 * Vertex position of a cell corner, with fractional i/j allowed.
 *
 * The mesher used to build every vertex as `direction * radius`, which is
 * sphere arithmetic: it put the drawn geometry on a sphere while the voxels sat
 * on a cube, so what you saw was never where the blocks were. You could punch
 * through what you could see and collide with what you could not.
 */
export function cubeCorner(f, ci, cj, k, out = [0, 0, 0]) {
  out[0] = out[1] = out[2] = 0;
  out[AX_N[f]] = SG_N[f] * (R_MIN + k);
  out[AX_A[f]] = aOut(f, ci);
  out[AX_B[f]] = bOut(f, cj);
  return out;
}

/** Cell centre, for anything planted in the middle of a cell. */
export function cubeCenter(f, i, j, k, out = [0, 0, 0]) {
  return cellCenterPos(f, i, j, k, out);
}

// --- folding a point onto the cube -------------------------------------------

const _fp = { f: 0, ci: 0, cj: 0, ck: 0 };

/**
 * World point -> face and continuous in-face coordinates. The face is the one
 * whose plane the point is furthest beyond, which is what makes a point that
 * has run off the side of one face land correctly on its neighbour.
 */
function foldPoint(x, y, z, out = _fp) {
  const p = [x, y, z];
  let f = 0, best = -Infinity;
  for (let g = 0; g < FACES; g++) {
    const d = SG_N[g] * p[AX_N[g]] - PLANET_R;
    if (d > best) { best = d; f = g; }
  }
  out.f = f;
  out.ck = SG_N[f] * p[AX_N[f]] - R_MIN;
  out.ci = aIn(f, p[AX_A[f]]);
  out.cj = bIn(f, p[AX_B[f]]);
  return out;
}

// --- cross-face column adjacency ---------------------------------------------

export const COL_NB = new Int32Array(COLUMNS * 4).fill(-1);

/** Face-local index step, folding onto the neighbouring face when it runs off. */
export function patchColumn(f, i, j, di, dj) {
  const ni = i + di, nj = j + dj;
  if (ni >= 0 && ni < F && nj >= 0 && nj < F) return cidx(f, ni, nj);
  const p = [0, 0, 0];
  p[AX_N[f]] = SG_N[f] * PLANET_R;
  p[AX_A[f]] = aOut(f, ni + 0.5);
  p[AX_B[f]] = bOut(f, nj + 0.5);
  const r = foldPoint(p[0], p[1], p[2]);
  const gi = Math.min(F - 1, Math.max(0, Math.floor(r.ci)));
  const gj = Math.min(F - 1, Math.max(0, Math.floor(r.cj)));
  return cidx(r.f, gi, gj);
}

(function buildAdjacency() {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let f = 0; f < FACES; f++) {
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < F; j++) {
        const col = cidx(f, i, j);
        for (let d = 0; d < 4; d++) {
          COL_NB[col * 4 + d] = patchColumn(f, i, j, dirs[d][0], dirs[d][1]);
        }
      }
    }
  }
})();

export const colNeighbor = (col, d) => COL_NB[col * 4 + d];

export function colParts(col, out = { f: 0, i: 0, j: 0 }) {
  const f = (col / (F * F)) | 0;
  const rem = col - f * F * F;
  out.f = f;
  out.i = (rem / F) | 0;
  out.j = rem % F;
  return out;
}

const _cp = { f: 0, i: 0, j: 0 };

/** Walk (di, dj) columns from `col`, crossing faces as needed. */
export function stepColumn(col, di, dj) {
  if (di === 0 && dj === 0) return col;
  colParts(col, _cp);
  return patchColumn(_cp.f, _cp.i, _cp.j, di, dj);
}

// --- continuous cell space ---------------------------------------------------

export function worldToCell(x, y, z, out = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 }) {
  const r = foldPoint(x, y, z, _fp);
  out.f = r.f; out.ci = r.ci; out.cj = r.cj; out.ck = r.ck;
  out.r = R_MIN + r.ck;
  return out;
}

export function cellToWorld(f, ci, cj, ck, out = [0, 0, 0]) {
  out[0] = out[1] = out[2] = 0;
  out[AX_N[f]] = SG_N[f] * (R_MIN + ck);
  out[AX_A[f]] = aOut(f, ci);
  out[AX_B[f]] = bOut(f, cj);
  return out;
}

/**
 * Local frame. On a cube these are constant per face and the cell is exactly
 * one unit across, so the arc lengths are 1.
 */
export function tangentFrame(f, ci, cj, ck, out = {
  ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1,
}) {
  const A = FACE_R[f], B = FACE_U[f], N = FACE_N[f];
  out.ea[0] = A[0]; out.ea[1] = A[1]; out.ea[2] = A[2];
  out.eb[0] = B[0]; out.eb[1] = B[1]; out.eb[2] = B[2];
  out.up[0] = N[0]; out.up[1] = N[1]; out.up[2] = N[2];
  out.arcA = 1; out.arcB = 1;
  return out;
}

/**
 * Bring cell coordinates back in range after a move that crossed a cube edge.
 *
 * The fold is taken at the sea plane rather than at the mover's own height, and
 * that is the whole of it. Asking which face a raised point belongs to answers
 * "the one you are still above": stand seven blocks up and walk two past the
 * edge and you are 7 beyond your own face's plane against 2 beyond the
 * neighbour's, so your own face keeps winning and the in-face coordinate runs
 * off the end of the array. Measured, that was 64% of folds. Projecting to the
 * surface first drops the height out of the comparison, so the only thing left
 * deciding is which side of the edge you are on, which is the question being
 * asked. Height is then re-measured against whichever face won.
 */
export function normalizeCell(c) {
  if (c.ci >= 0 && c.ci < F && c.cj >= 0 && c.cj < F) return c;
  const p = _np;
  p[0] = p[1] = p[2] = 0;
  p[AX_N[c.f]] = SG_N[c.f] * PLANET_R;
  p[AX_A[c.f]] = aOut(c.f, c.ci);
  p[AX_B[c.f]] = bOut(c.f, c.cj);
  const r = foldPoint(p[0], p[1], p[2], _fp);
  const g = r.f;
  // Re-measure against the new face from where the mover ACTUALLY is, not from
  // the flattened probe and not by carrying the old height across.
  //
  // Carrying it was wrong in the way that matters: height on the old face is a
  // distance along the old normal, and on the new face the same number is a
  // distance along an axis at right angles to it. Falling off an edge therefore
  // arrived on the neighbour flung a long way out along the wrong axis - the
  // owner fell past an edge and ended up submerged in the next face's sea with
  // the surface standing on its side, "like I am in a pool but sideways".
  const t = cellToWorld(c.f, c.ci, c.cj, c.ck, _tp);
  const ci = aIn(g, t[AX_A[g]]);
  const cj = bIn(g, t[AX_B[g]]);

  // High above an edge there is nowhere to go. That point is past the corner,
  // outside BOTH faces' footprints, and (column, layer) has no way to say so -
  // a face only spans its own square. Handing it over anyway is what threw the
  // mover a long way out along the new face's tangent.
  //
  // So the edge is a soft wall while you are above the shell and open ground
  // once you are down on it. Terrain is faded flat and dry for the last few
  // columns of every face, so a walk across a seam happens at exactly the
  // height where this is exact, and that is the case that has to be perfect.
  if (c.ck > SEA_K + EDGE_SLACK) {
    c.ci = c.ci <= 0 ? 0 : (c.ci >= F ? F - 1e-4 : c.ci);
    c.cj = c.cj <= 0 ? 0 : (c.cj >= F ? F - 1e-4 : c.cj);
    return c;
  }

  c.f = g;
  c.ci = ci <= 0 ? 0 : (ci >= F ? F - 1e-4 : ci);
  c.cj = cj <= 0 ? 0 : (cj >= F ? F - 1e-4 : cj);
  c.ck = SG_N[g] * t[AX_N[g]] - R_MIN;
  return c;
}
const _np = [0, 0, 0];
const _tp = [0, 0, 0];

/**
 * The layer the shell surface sits on, and how far above it a seam may still be
 * crossed.
 *
 * Height on the old face becomes *tangential* distance on the new one, so a
 * crossing lands (ck - SEA_K) columns outside the neighbour's square and has to
 * be nudged back in. That nudge is the whole budget: 5 keeps it to five blocks
 * at the very worst and covers the border ridge, which stands a couple of
 * blocks proud of the waterline, plus the height of a jump taken from it.
 *
 * Above that the edge is simply a wall. There is nothing dishonest about
 * refusing: a point high over a corner is outside BOTH faces' squares and
 * (column, layer) has no way to say where it is, so the alternative is not a
 * better answer, it is being flung a long way out along the wrong axis - which
 * is what put the owner in the next face's sea with the surface on its side.
 */
const SEA_K = 33;
const EDGE_SLACK = 5;

/** A cell is one unit across everywhere on a cube. */
export const cellArc = () => 1;

// --- (col, k) -> flat Cartesian index ----------------------------------------
//
// Storage is one solid cube, so two faces whose deep columns overlap near an
// edge address the same cell rather than two copies of it. That aliasing is the
// point: an edit through either column is seen through both.

const STRIDE = [SIDE * SIDE, SIDE, 1];

/** Index of layer 0 for each column. */
export const COL_BASE = new Int32Array(COLUMNS);
/** Index delta per layer, per column (sign depends on the face). */
export const COL_STEP = new Int32Array(COLUMNS);

(function buildIndex() {
  const c = [0, 0, 0];
  for (let f = 0; f < FACES; f++) {
    const an = AX_N[f], sg = SG_N[f], aa = AX_A[f], ab = AX_B[f];
    const step = sg * STRIDE[an];
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < F; j++) {
        c[an] = sg > 0 ? R_MIN : -R_MIN - 1;
        c[aa] = Math.floor(aOut(f, i + 0.5));
        c[ab] = Math.floor(bOut(f, j + 0.5));
        const col = cidx(f, i, j);
        COL_BASE[col] = (c[0] + ARR_R) * STRIDE[0]
          + (c[1] + ARR_R) * STRIDE[1] + (c[2] + ARR_R);
        COL_STEP[col] = step;
      }
    }
  }
})();

/**
 * Flat-index delta for stepping one block along a face's A / B axis.
 *
 * Storage is Cartesian, so the physically adjacent block is always one stride
 * away whatever face it belongs to. Stepping to `(neighbourColumn, same k)`
 * instead is only correct in the middle of a face: across a seam the two
 * columns measure k along different normals, so the same k is a different cell
 * entirely, and a mesher culling against it opens holes in the terrain.
 */
export const STEP_A = new Int32Array(FACES);
export const STEP_B = new Int32Array(FACES);

(function buildSteps() {
  const stride = [SIDE * SIDE, SIDE, 1];
  for (let f = 0; f < FACES; f++) {
    STEP_A[f] = SG_A[f] * stride[AX_A[f]];
    STEP_B[f] = SG_B[f] * stride[AX_B[f]];
  }
})();

/** Flat array index for a cell, or -1 when out of the layer range. */
export function cellIndex(col, k) {
  if (k < 0 || k >= D) return -1;
  return COL_BASE[col] + k * COL_STEP[col];
}

/**
 * How far this column is from the middle of its face, in blocks, on whichever
 * of the two in-face axes is further out. A cell is this face's own only while
 * its normal coordinate beats that.
 */
export const COL_EDGE = new Int32Array(COLUMNS);

/**
 * The same two extents, split by how the tie against them must be broken.
 *
 * Ownership used to be one test - the normal coordinate strictly greater than
 * both tangents - and that leaves the cells where two coordinates are EQUAL
 * owned by nobody. Equal coordinates is the definition of a cube edge, so every
 * one of the twelve edges had a diagonal sheet of cells that no face would
 * write, running from the surface down into the rock. Above water it was hidden
 * inside solid ground; below it, the two seas met through the gap. Measured,
 * 660 cells in 200 000 had no owner at all.
 *
 * `foldPoint` already breaks these ties, and the rule is simply first-wins over
 * the axis order, so the lower axis index takes it. Mirroring that here is what
 * makes owner and reader agree: a face must beat a lower-numbered axis outright
 * but only needs to match a higher-numbered one.
 */
export const COL_EDGE_STRICT = new Int32Array(COLUMNS);
export const COL_EDGE_LOOSE = new Int32Array(COLUMNS);

(function buildEdge() {
  for (let f = 0; f < FACES; f++) {
    const an = AX_N[f], aa = AX_A[f], ab = AX_B[f];
    for (let i = 0; i < F; i++) {
      const u = Math.floor(aOut(f, i + 0.5)), du = Math.max(u, -1 - u);
      for (let j = 0; j < F; j++) {
        const v = Math.floor(bOut(f, j + 0.5)), dv = Math.max(v, -1 - v);
        const col = cidx(f, i, j);
        COL_EDGE[col] = du > dv ? du : dv;
        let strict = -1, loose = -1;
        if (aa < an) { if (du > strict) strict = du; } else if (du > loose) loose = du;
        if (ab < an) { if (dv > strict) strict = dv; } else if (dv > loose) loose = dv;
        COL_EDGE_STRICT[col] = strict;
        COL_EDGE_LOOSE[col] = loose;
      }
    }
  }
})();

/**
 * How many columns this one is from the nearest face border. 0 is the last
 * column on the face.
 */
export const colBorderDist = (col) => PLANET_R - 1 - COL_EDGE[col];

/**
 * Index for a WRITE, or -1 when this column does not own the cell.
 *
 * Near a cube edge two faces address the same cells, and a generator that
 * ignores that erases its neighbour: each face lays air above its own surface,
 * and past the edge that air is inside the next face's mountain. Ownership goes
 * to whichever face the cell is actually nearest, which is the same rule the
 * Chebyshev depth uses. A -1 write into a typed array is a no-op, so callers do
 * not have to test.
 *
 * Reads deliberately do NOT go through this: a mesher looking across a seam
 * wants the true contents of the cell, whoever wrote them.
 */
export function cellWrite(col, k) {
  if (k < 0 || k >= D) return -1;
  const vn = R_MIN + k;
  if (vn <= COL_EDGE_STRICT[col]) return -1;
  if (vn < COL_EDGE_LOOSE[col]) return -1;
  return COL_BASE[col] + k * COL_STEP[col];
}

/**
 * The inverse. Aliased cells decode to the Chebyshev-nearest face, which is not
 * necessarily the column they were written through, so this round-trips the
 * cell but not always the column.
 */
export function cellDecode(idx, out = { col: 0, k: 0 }) {
  const z = (idx % SIDE) - ARR_R;
  const t = (idx - (z + ARR_R)) / SIDE;
  const y = (t % SIDE) - ARR_R;
  const x = ((t - (y + ARR_R)) / SIDE) - ARR_R;
  const r = foldPoint(x + 0.5, y + 0.5, z + 0.5, _fp);
  const i = Math.min(F - 1, Math.max(0, Math.floor(r.ci)));
  const j = Math.min(F - 1, Math.max(0, Math.floor(r.cj)));
  out.col = cidx(r.f, i, j);
  out.k = Math.floor(r.ck);
  return out;
}
