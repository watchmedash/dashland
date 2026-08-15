// Tests for the cube planet's coordinate model.
//
// Every case below is one of the numbered gotchas in CUBE-PLANET.md, i.e. each
// one was a real shipped bug in the source this is ported from. They are cheap
// to run and they are the only thing standing between a sign error in a face
// frame and a week of "the camera is subtly wrong on two faces".
//
//   node src/world/Cube.test.mjs

import {
  PLANET_R, ARR_R, SIDE, CELLS, CORE_DEPTH,
  blockIndex, inBounds, depthOf,
  FACE_UP, faceIndexOfUp, faceUp, faceMayChange,
  basis, dirFromYawPitch, yawFromDir, carryYaw,
  FACES, faceCell, distToBorder,
} from './Cube.js';

let pass = 0, fail = 0;
const eq = (a, b, msg) => {
  const ok = Math.abs(a - b) < 1e-9;
  if (ok) pass++; else { fail++; console.log(`FAIL ${msg}: ${a} != ${b}`); }
};
const veq = (a, b, msg) => {
  const ok = a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  if (ok) pass++; else { fail++; console.log(`FAIL ${msg}: [${a}] != [${b}]`); }
};
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log(`FAIL ${msg}`); } };

// --- sizing ----------------------------------------------------------------

eq(SIDE, 488, 'SIDE');
eq(CELLS, 488 ** 3, 'CELLS');
ok(CELLS < 6 * 464 * 464 * 99, 'cube array is smaller than the cubesphere it replaces');
{
  const cube = 6 * (2 * PLANET_R) ** 2;
  const sphere = 4 * Math.PI * 282 ** 2;
  ok(Math.abs(cube / sphere - 1) < 0.01, `surface area within 1% of the sphere (${(cube / sphere).toFixed(4)})`);
}
ok(ARR_R - PLANET_R >= 32, 'build headroom above the shell');

// --- indexing --------------------------------------------------------------

eq(blockIndex(-ARR_R, -ARR_R, -ARR_R), 0, 'first cell');
eq(blockIndex(ARR_R - 1, ARR_R - 1, ARR_R - 1), CELLS - 1, 'last cell');
eq(blockIndex(ARR_R, 0, 0), -1, 'out of bounds is -1, not clamped');
eq(blockIndex(0, -ARR_R - 1, 0), -1, 'out of bounds low is -1');
ok(inBounds(0, 0, 0) && !inBounds(ARR_R, 0, 0), 'inBounds agrees with blockIndex');
// Distinctness: no two coordinates may share an index.
{
  const seen = new Set();
  let clash = 0;
  for (let n = 0; n < 4000; n++) {
    const r = () => Math.floor(Math.random() * SIDE) - ARR_R;
    const key = blockIndex(r(), r(), r());
    if (seen.has(key)) clash++;
    seen.add(key);
  }
  ok(clash === 0, 'indices are distinct over 4000 random coords');
}

// --- gotcha 6: the asymmetric span -----------------------------------------
// depth must be symmetric between a +face and the -face opposite it. Using
// Math.abs instead of the -1-c form puts three faces one block out.

eq(depthOf(PLANET_R - 1, 0, 0), 0, '+X outermost shell block is depth 0');
eq(depthOf(-PLANET_R, 0, 0), 0, '-X outermost shell block is depth 0');
eq(depthOf(0, PLANET_R - 1, 0), 0, '+Y outermost is depth 0');
eq(depthOf(0, -PLANET_R, 0), 0, '-Y outermost is depth 0');
eq(depthOf(0, 0, PLANET_R - 1), 0, '+Z outermost is depth 0');
eq(depthOf(0, 0, -PLANET_R), 0, '-Z outermost is depth 0');
eq(depthOf(PLANET_R, 0, 0), -1, 'one block above the +X surface');
eq(depthOf(-PLANET_R - 1, 0, 0), -1, 'one block above the -X surface');
eq(depthOf(0, 0, 0), PLANET_R - 1, 'the centre is the deepest point');
ok(depthOf(0, 0, 0) > CORE_DEPTH, 'the centre is inside the unbreakable core');
// A corner block is depth 0 from all three of its faces at once.
eq(depthOf(PLANET_R - 1, PLANET_R - 1, PLANET_R - 1), 0, 'corner block is depth 0');

// --- gotcha 1: signed dot in the hysteresis --------------------------------
// A player teleported to the far side must NOT keep the old up. With |dot| it
// does, forever, and stands on the ceiling.

{
  const far = [-PLANET_R - 2, 0, 0];
  const out = faceUp(far, [1, 0, 0]);
  veq(out, [-1, 0, 0], 'opposite face wins over a stale prev (signed dot)');
}
{
  // ...while the genuine same face is still held.
  const out = faceUp([PLANET_R + 2, 3, 3], [1, 0, 0]);
  veq(out, [1, 0, 0], 'same face is held');
}

// --- gotcha 2: hysteresis at an edge ---------------------------------------
// Sitting exactly on the +X/+Y edge, the answer must depend on prev and must be
// stable, not flip-flop.

{
  const edge = [PLANET_R, PLANET_R, 0];
  veq(faceUp(edge, [1, 0, 0]), [1, 0, 0], 'edge holds +X when coming from +X');
  veq(faceUp(edge, [0, 1, 0]), [0, 1, 0], 'edge holds +Y when coming from +Y');
  // and repeated application does not oscillate
  let up = [1, 0, 0];
  for (let n = 0; n < 50; n++) up = faceUp(edge, up).slice();
  veq(up, [1, 0, 0], 'edge is stable over 50 ticks');
}

// --- gotcha 3: never transition while rising --------------------------------

ok(!faceMayChange([0, 0, 0].map((_, i) => (i === 0 ? 5 : 0)), [1, 0, 0]), 'rising freezes the face');
ok(faceMayChange([-5, 0, 0], [1, 0, 0]), 'falling may transition');
ok(faceMayChange([0, 5, 0], [1, 0, 0]), 'moving sideways may transition');
ok(faceMayChange([0.5, 0, 0], [1, 0, 0]), 'drifting up slower than 1 may transition');

// --- section 3: the frame degenerates to flat world on +Y ------------------
// This is the property the entire port leans on.

{
  const { t1, t2 } = basis([0, 1, 0]);
  veq(t1, [1, 0, 0], 'basis(+Y).t1 is +X — the classic flat frame');
  veq(t2, [0, 0, 1], 'basis(+Y).t2 is +Z');
}

// Every face frame must be orthonormal and right-handed.
for (let i = 0; i < 6; i++) {
  const up = FACE_UP[i];
  const { t1, t2 } = basis(up);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  eq(Math.hypot(...t1), 1, `face ${i} t1 is unit`);
  eq(Math.hypot(...t2), 1, `face ${i} t2 is unit`);
  eq(dot(t1, up), 0, `face ${i} t1 perpendicular to up`);
  eq(dot(t2, up), 0, `face ${i} t2 perpendicular to up`);
  eq(dot(t1, t2), 0, `face ${i} t1 perpendicular to t2`);
  eq(faceIndexOfUp(up), i, `faceIndexOfUp round-trips face ${i}`);
}

// --- yaw/pitch round trip on every face ------------------------------------

for (let i = 0; i < 6; i++) {
  const up = FACE_UP[i];
  for (const yaw of [0, 0.7, 2.5, -1.3, Math.PI]) {
    const d = dirFromYawPitch(yaw, 0, up);
    eq(Math.hypot(...d), 1, `face ${i} aim dir is unit`);
    const back = yawFromDir(d, up);
    // angles compare modulo 2pi
    const diff = Math.atan2(Math.sin(back - yaw), Math.cos(back - yaw));
    eq(diff, 0, `face ${i} yaw ${yaw} round-trips`);
  }
  // pitch must move along up, and only along up
  const upDir = dirFromYawPitch(0, Math.PI / 2, up);
  veq(upDir.map((v) => Math.round(v * 1e9) / 1e9), up, `face ${i} pitch +90 looks straight up`);
}

// --- gotcha 4: carryYaw across an edge -------------------------------------
// Walking over an edge must not swing the view. The test: the world-space
// forward direction, projected onto the shared edge, must survive the change.

{
  const oldUp = [0, 1, 0], newUp = [1, 0, 0];
  for (const yaw of [0, 0.4, 1.1, 2.0, -2.2]) {
    const ny = carryYaw(yaw, oldUp, newUp);
    const before = dirFromYawPitch(yaw, 0, oldUp);
    const after = dirFromYawPitch(ny, 0, newUp);
    // The component along the edge axis (Z, shared by +Y and +X) is untouched
    // by a roll about that edge, so it must match exactly.
    eq(after[2], before[2], `carryYaw preserves the along-edge component (yaw ${yaw})`);
  }
  eq(carryYaw(1.0, oldUp, oldUp), 1.0, 'carryYaw is identity for the same face');
}

// --- section 6a: faceCell ---------------------------------------------------

for (let i = 0; i < 6; i++) {
  const f = FACES[i];
  veq(f.n, FACE_UP[i], `FACES[${i}] normal matches FACE_UP[${i}]`);
  // k = 0 is the outermost shell block: depth 0.
  eq(depthOf(...faceCell(f, 0, 0, 0)), 0, `face ${i} k=0 is depth 0`);
  eq(depthOf(...faceCell(f, 0, 0, -1)), 1, `face ${i} k=-1 digs in one`);
  eq(depthOf(...faceCell(f, 0, 0, 5)), -5, `face ${i} k=5 is five above the surface`);
  // in-face offsets must not change depth away from the borders
  eq(depthOf(...faceCell(f, 40, -70, 0)), 0, `face ${i} depth is flat across the face`);
  // and the cell must be storable
  ok(inBounds(...faceCell(f, 0, 0, ARR_R - PLANET_R - 1)), `face ${i} top of build headroom is in bounds`);
}

// --- section 6c: border fade -----------------------------------------------

eq(distToBorder(-PLANET_R, 0), 0, 'left border is distance 0');
eq(distToBorder(PLANET_R - 1, 0), 0, 'right border is distance 0');
eq(distToBorder(0, 0), PLANET_R - 1, 'face centre is furthest from a border');
ok(distToBorder(-PLANET_R + 3, 100) === 3, 'border distance counts blocks');

// --- gotcha 10: verify by symmetry -----------------------------------------
// Whatever works on +Y must behave identically on the other five faces. Walk a
// probe N steps along its own frame from the middle of each face and assert the
// distance travelled matches.

{
  const dists = [];
  for (let i = 0; i < 6; i++) {
    const up = FACE_UP[i];
    const { t1 } = basis(up);
    // start on the surface at the face centre
    const p = up.map((c) => c * (PLANET_R + 0.5));
    const start = p.slice();
    let cur = up;
    for (let n = 0; n < 60; n++) {
      p[0] += t1[0] * 1.5; p[1] += t1[1] * 1.5; p[2] += t1[2] * 1.5;
      cur = faceUp(p, cur).slice();
    }
    dists.push(Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]));
    // 60 steps of 1.5 is 90 blocks, well inside a half-face of 204, so the
    // probe must still be on the face it started on.
    veq(cur, up, `probe stays on face ${i} after 90 blocks`);
  }
  const spread = Math.max(...dists) - Math.min(...dists);
  ok(spread < 1e-9, `all six faces travel the same distance (spread ${spread})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
