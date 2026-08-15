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
export const FACE_R = [
  [0, 1, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0],
];
export const FACE_U = [
  [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0],
];

/** Which world axis each face's normal / A / B lies on, and its sign. */
const AX_N = [0, 0, 1, 1, 2, 2];
const SG_N = [1, -1, 1, -1, 1, -1];
const AX_A = [1, 1, 0, 0, 0, 0];
const AX_B = [2, 2, 2, 2, 1, 1];

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
  out[AX_A[f]] = i - PLANET_R;
  out[AX_B[f]] = j - PLANET_R;
  return out;
}

/** World position of a cell centre. */
export function cellCenterPos(f, i, j, k, out = [0, 0, 0]) {
  const m = R_MIN + k + 0.5;
  out[0] = out[1] = out[2] = 0;
  out[AX_N[f]] = SG_N[f] * m;
  out[AX_A[f]] = i - PLANET_R + 0.5;
  out[AX_B[f]] = j - PLANET_R + 0.5;
  return out;
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
  out.ci = p[AX_A[f]] + PLANET_R;
  out.cj = p[AX_B[f]] + PLANET_R;
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
  p[AX_A[f]] = ni - PLANET_R + 0.5;
  p[AX_B[f]] = nj - PLANET_R + 0.5;
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
  out[AX_A[f]] = ci - PLANET_R;
  out[AX_B[f]] = cj - PLANET_R;
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

/** Bring cell coordinates back in range after a move that crossed a cube edge. */
export function normalizeCell(c) {
  if (c.ci >= 0 && c.ci < F && c.cj >= 0 && c.cj < F) return c;
  const p = cellToWorld(c.f, c.ci, c.cj, c.ck, _np);
  const r = foldPoint(p[0], p[1], p[2], _fp);
  c.f = r.f; c.ci = r.ci; c.cj = r.cj; c.ck = r.ck;
  return c;
}
const _np = [0, 0, 0];

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
        c[aa] = i - PLANET_R;
        c[ab] = j - PLANET_R;
        const col = cidx(f, i, j);
        COL_BASE[col] = (c[0] + ARR_R) * STRIDE[0]
          + (c[1] + ARR_R) * STRIDE[1] + (c[2] + ARR_R);
        COL_STEP[col] = step;
      }
    }
  }
})();

/** Flat array index for a cell, or -1 when out of the layer range. */
export function cellIndex(col, k) {
  if (k < 0 || k >= D) return -1;
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
