// Cubesphere geometry: the mapping between world space and (face, i, j, k)
// voxel space, and the cross-face adjacency that makes the six grids behave as
// one continuous surface.
//
// The equi-angular ("tangent-warped") mapping is used so cells are close to
// uniform in size and — crucially — line up exactly 1:1 across cube edges.

import { F, D, R_MIN, FACES, COLUMNS, cidx } from './Constants.js';

// Face bases, chosen so R x U = N (outward).
export const FACE_N = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
export const FACE_R = [
  [0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0],
];
export const FACE_U = [
  [0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0],
];

const QUARTER = Math.PI / 4;

/** grid coordinate (0..F) → cube-face coordinate (-1..1) */
export const gridToAxis = (g) => (g / F) * 2 - 1;
export const axisToGrid = (a) => ((a + 1) * 0.5) * F;

/**
 * Unit direction for a point on face `f` at face coordinates (a, b) ∈ [-1,1].
 * Values slightly outside that range are valid and land on a neighbouring face.
 */
export function faceDir(f, a, b, out = [0, 0, 0]) {
  const ta = Math.tan(a * QUARTER);
  const tb = Math.tan(b * QUARTER);
  const N = FACE_N[f], R = FACE_R[f], U = FACE_U[f];
  let x = N[0] + ta * R[0] + tb * U[0];
  let y = N[1] + ta * R[1] + tb * U[1];
  let z = N[2] + ta * R[2] + tb * U[2];
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** World direction → {f, a, b}. */
export function dirToFace(x, y, z, out = { f: 0, a: 0, b: 0 }) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f;
  if (ax >= ay && ax >= az) f = x >= 0 ? 0 : 1;
  else if (ay >= az) f = y >= 0 ? 2 : 3;
  else f = z >= 0 ? 4 : 5;
  const N = FACE_N[f], R = FACE_R[f], U = FACE_U[f];
  const n = x * N[0] + y * N[1] + z * N[2];
  const r = x * R[0] + y * R[1] + z * R[2];
  const u = x * U[0] + y * U[1] + z * U[2];
  out.f = f;
  out.a = Math.atan(r / n) / QUARTER;
  out.b = Math.atan(u / n) / QUARTER;
  return out;
}

// --- precomputed direction tables -------------------------------------------
// Corner dirs: (F+1)^2 per face. Centre dirs: F^2 per face.

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

export function cornerDir(f, i, j, out = [0, 0, 0]) {
  const o = ((f * (F + 1) + i) * (F + 1) + j) * 3;
  out[0] = CORNER_DIR[o]; out[1] = CORNER_DIR[o + 1]; out[2] = CORNER_DIR[o + 2];
  return out;
}

export function centerDir(f, i, j, out = [0, 0, 0]) {
  const o = ((f * F + i) * F + j) * 3;
  out[0] = CENTER_DIR[o]; out[1] = CENTER_DIR[o + 1]; out[2] = CENTER_DIR[o + 2];
  return out;
}

/** World position of a cell corner. */
export function cornerPos(f, i, j, k, out = [0, 0, 0]) {
  const o = ((f * (F + 1) + i) * (F + 1) + j) * 3;
  const r = R_MIN + k;
  out[0] = CORNER_DIR[o] * r; out[1] = CORNER_DIR[o + 1] * r; out[2] = CORNER_DIR[o + 2] * r;
  return out;
}

/** World position of a cell centre. */
export function cellCenterPos(f, i, j, k, out = [0, 0, 0]) {
  const o = ((f * F + i) * F + j) * 3;
  const r = R_MIN + k + 0.5;
  out[0] = CENTER_DIR[o] * r; out[1] = CENTER_DIR[o + 1] * r; out[2] = CENTER_DIR[o + 2] * r;
  return out;
}

// --- cross-face column adjacency --------------------------------------------
// COL_NB[col * 4 + dir] with dir 0:+i 1:-i 2:+j 3:-j. -1 never occurs; the
// sphere is closed.

export const COL_NB = new Int32Array(COLUMNS * 4).fill(-1);

(function buildAdjacency() {
  const res = { f: 0, a: 0, b: 0 };
  const tmp = [0, 0, 0];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let f = 0; f < FACES; f++) {
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < F; j++) {
        const col = cidx(f, i, j);
        for (let d = 0; d < 4; d++) {
          const ni = i + dirs[d][0], nj = j + dirs[d][1];
          if (ni >= 0 && ni < F && nj >= 0 && nj < F) {
            COL_NB[col * 4 + d] = cidx(f, ni, nj);
            continue;
          }
          // Off the edge: resolve through world space onto the adjacent face.
          faceDir(f, gridToAxis(ni + 0.5), gridToAxis(nj + 0.5), tmp);
          dirToFace(tmp[0], tmp[1], tmp[2], res);
          let gi = Math.floor(axisToGrid(res.a));
          let gj = Math.floor(axisToGrid(res.b));
          gi = Math.min(F - 1, Math.max(0, gi));
          gj = Math.min(F - 1, Math.max(0, gj));
          COL_NB[col * 4 + d] = cidx(res.f, gi, gj);
        }
      }
    }
  }
})();

/** Column neighbour in tangential direction d (0:+i 1:-i 2:+j 3:-j). */
export const colNeighbor = (col, d) => COL_NB[col * 4 + d];

/** column index → { f, i, j } */
export function colParts(col, out = { f: 0, i: 0, j: 0 }) {
  const f = (col / (F * F)) | 0;
  const rem = col - f * F * F;
  out.f = f; out.i = (rem / F) | 0; out.j = rem % F;
  return out;
}

/** Is `n` one of `c`'s four tangential neighbours? */
const touches = (c, n) => COL_NB[c * 4] === n || COL_NB[c * 4 + 1] === n
  || COL_NB[c * 4 + 2] === n || COL_NB[c * 4 + 3] === n;

/**
 * One diagonal cell — the one touching both of the axis neighbours it lies
 * between.
 *
 * In the middle of a face, stepping i-then-j and j-then-i land on the same
 * cell and this is a formality. Across a cube seam the local axes rotate and
 * the two orders part company: measured on the face-2 seam, i-then-j put the
 * (-1,+1) diagonal 0.008° away — a near-duplicate of an axis neighbour — and
 * (-1,-1) at 0.865°, an overshoot, where a true diagonal sits at 0.53°.
 *
 * Being adjacent to both axis neighbours is what makes a cell the corner
 * between them, and it is decidable from the adjacency table, which is exact.
 * At the eight cube corners no cell satisfies it, because only three cells meet
 * there and the fourth diagonal does not exist; either answer is then as close
 * as the geometry allows.
 */
function diagStep(col, si, sj) {
  const a = COL_NB[col * 4 + si], b = COL_NB[col * 4 + sj];
  const viaA = COL_NB[a * 4 + sj], viaB = COL_NB[b * 4 + si];
  if (viaA === viaB) return viaA;
  // A corner cell is distinct from the cell you started in and from both of
  // the neighbours it sits between, and touches both of them. The first of
  // those is not pedantry: on the face-2 seam, stepping -i and then +j lands
  // back on the starting column, so a footprint counted its own centre as a
  // diagonal — and asking only "does it touch b" waves that straight through,
  // because the centre touches b by definition.
  //
  // viaA already touches `a` and viaB already touches `b` by construction, so
  // only the other side of each is worth asking about.
  const okA = viaA !== col && viaA !== a && viaA !== b && touches(viaA, b);
  const okB = viaB !== col && viaB !== a && viaB !== b && touches(viaB, a);
  if (okA !== okB) return okA ? viaA : viaB;
  return viaA;
}

/**
 * Step a full cell address by (di, dj).
 *
 * The diagonal part is walked one cell at a time through diagStep rather than
 * exhausting one axis and then the other. Doing all the i steps first was
 * wrong on the four seams where faces 2 and 3 meet their neighbours: 816
 * columns where a body's nine-sample footprint collapsed to eight, sampling one
 * cell twice and never looking at a real diagonal at all. In the middle of a
 * face this produces exactly what it always did.
 *
 * @returns column index
 */
export function stepColumn(col, di, dj) {
  let c = col;
  const si = di > 0 ? 0 : 1, sj = dj > 0 ? 2 : 3;
  let ni = Math.abs(di), nj = Math.abs(dj);
  while (ni > 0 && nj > 0) { c = diagStep(c, si, sj); ni--; nj--; }
  while (ni-- > 0) c = COL_NB[c * 4 + si];
  while (nj-- > 0) c = COL_NB[c * 4 + sj];
  return c;
}

const _pdir = [0, 0, 0];
const _pres = { f: 0, a: 0, b: 0 };

/**
 * The column at offset (di, dj) from (f, i, j), staying in *that* column's face
 * frame the whole way — the right tool for stamping a shape several columns
 * wide.
 *
 * stepColumn walks the grid, so past a seam it is answering in the destination
 * face's frame and the far side of a wide patch peels off sideways. This
 * extends the centre's own face coordinates past the edge, which faceDir maps
 * onto the neighbouring face through the same tangent warp, and reads the
 * result back with dirToFace. Nothing rotates, so nothing folds.
 *
 * The two agree exactly everywhere a patch stays inside one face. Where they
 * differ, this one is better but not perfect: the centre's extended
 * coordinates and the neighbour's own are different parameterisations of the
 * same sphere and drift apart with distance past the edge. Over the whole
 * planet at a radius of three, walking loses up to 23 of 49 columns to
 * duplicates and this loses 5.
 */
export function patchColumn(f, i, j, di, dj) {
  faceDir(f, gridToAxis(i + di + 0.5), gridToAxis(j + dj + 0.5), _pdir);
  dirToFace(_pdir[0], _pdir[1], _pdir[2], _pres);
  const gi = Math.min(F - 1, Math.max(0, Math.floor(axisToGrid(_pres.a))));
  const gj = Math.min(F - 1, Math.max(0, Math.floor(axisToGrid(_pres.b))));
  return cidx(_pres.f, gi, gj);
}

// --- continuous cell space ---------------------------------------------------

/**
 * World point → continuous cell coordinates.
 * @returns {{f:number, ci:number, cj:number, ck:number, r:number}}
 */
export function worldToCell(x, y, z, out = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 }) {
  const r = Math.hypot(x, y, z) || 1e-6;
  const res = dirToFace(x / r, y / r, z / r, _res);
  out.f = res.f;
  out.ci = axisToGrid(res.a);
  out.cj = axisToGrid(res.b);
  out.ck = r - R_MIN;
  out.r = r;
  return out;
}
const _res = { f: 0, a: 0, b: 0 };

/** Continuous cell coordinates → world point. */
export function cellToWorld(f, ci, cj, ck, out = [0, 0, 0]) {
  faceDir(f, gridToAxis(ci), gridToAxis(cj), out);
  const r = R_MIN + ck;
  out[0] *= r; out[1] *= r; out[2] *= r;
  return out;
}

/**
 * Local tangent frame at continuous cell coordinates.
 * ea: world direction of increasing ci, eb: increasing cj, up: radial.
 * Also returns arc lengths — how many world units one cell step covers.
 */
const _p0 = [0, 0, 0], _p1 = [0, 0, 0], _p2 = [0, 0, 0];
export function tangentFrame(f, ci, cj, ck, out = {
  ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1,
}) {
  const h = 0.25;
  cellToWorld(f, ci, cj, ck, _p0);
  cellToWorld(f, ci + h, cj, ck, _p1);
  cellToWorld(f, ci, cj + h, ck, _p2);
  let ax = _p1[0] - _p0[0], ay = _p1[1] - _p0[1], az = _p1[2] - _p0[2];
  let bx = _p2[0] - _p0[0], by = _p2[1] - _p0[1], bz = _p2[2] - _p0[2];
  const la = Math.hypot(ax, ay, az) || 1e-6;
  const lb = Math.hypot(bx, by, bz) || 1e-6;
  out.arcA = la / h;
  out.arcB = lb / h;
  out.ea[0] = ax / la; out.ea[1] = ay / la; out.ea[2] = az / la;
  out.eb[0] = bx / lb; out.eb[1] = by / lb; out.eb[2] = bz / lb;
  const r = Math.hypot(_p0[0], _p0[1], _p0[2]) || 1e-6;
  out.up[0] = _p0[0] / r; out.up[1] = _p0[1] / r; out.up[2] = _p0[2] / r;
  return out;
}

/**
 * Bring continuous cell coordinates back in range after a move that crossed a
 * cube edge. Mutates and returns the coordinate object.
 */
export function normalizeCell(c) {
  if (c.ci >= 0 && c.ci < F && c.cj >= 0 && c.cj < F) return c;
  const p = cellToWorld(c.f, c.ci, c.cj, c.ck, _p0);
  const r = Math.hypot(p[0], p[1], p[2]) || 1e-6;
  const res = dirToFace(p[0] / r, p[1] / r, p[2] / r, _res);
  c.f = res.f;
  c.ci = axisToGrid(res.a);
  c.cj = axisToGrid(res.b);
  // ck is unchanged: the radius never changes when crossing an edge
  return c;
}

/** Mean world size of one cell at radius r (used for physics scaling). */
export const cellArc = (r) => (r * Math.PI * 0.5) / F;
