// Asserts the nine-face coordinate model directly. `node src/world/Grid.test.mjs`.
//
// The cube's lesson: a coordinate bug found in stage 7 costs more than stages 1
// to 6 combined, and the fastest way to find one is a file like this rather
// than a game that looks wrong. `Cube.test.mjs` and its 188 assertions are the
// template.

import {
  G, F, W, D, COLUMNS, CELLS, NORTH, SOUTH, WEST, EAST, DIR_STEP,
  SEALED, CROSS, isSealed, START_FACE, WALL_T,
  wrap, colIndex, cellIndex, colDecode, faceAt, localAt, faceOrigin,
  faceStep, isDivider, isWall, portalsOf, allPortals, delta, dist2,
} from './Grid.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);

// --- shape -----------------------------------------------------------------
eq(W, 1248, 'map width');
eq(COLUMNS, 1557504, 'columns');
eq(CELLS, 137060352, 'cells');
ok(CELLS < 147197952, 'the map is smaller than the cube array it replaces');

// --- wrap ------------------------------------------------------------------
eq(wrap(0), 0, 'wrap 0');
eq(wrap(W), 0, 'wrap W');
eq(wrap(-1), W - 1, 'wrap -1');
eq(wrap(-W - 3), W - 3, 'wrap far negative');
eq(wrap(W * 4 + 7), 7, 'wrap far positive');

// --- indexing round trips --------------------------------------------------
{
  const t = { x: 0, y: 0 };
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [W - 1, W - 1], [417, 900], [1247, 3]]) {
    colDecode(colIndex(x, y), t);
    ok(t.x === x && t.y === y, `col round trip ${x},${y} -> ${t.x},${t.y}`);
  }
  // distinct, in range, and contiguous in k
  eq(cellIndex(5, 7, 0) + 3, cellIndex(5, 7, 3), 'layers are contiguous');
  ok(cellIndex(W - 1, W - 1, D - 1) === CELLS - 1, 'last cell is the last index');
  ok(cellIndex(-1, -1, 0) === cellIndex(W - 1, W - 1, 0), 'negative wraps on index');
}

// --- faces -----------------------------------------------------------------
eq(faceAt(0, 0), 1, 'origin is face 1');
eq(faceAt(F, 0), 2, 'east of origin is face 2');
eq(faceAt(2 * F, 0), 3, 'face 3');
eq(faceAt(0, F), 4, 'south of origin is face 4');
eq(faceAt(F, F), 5, 'centre is face 5');
eq(faceAt(2 * F, 2 * F), 9, 'face 9');
eq(faceAt(W - 1, W - 1), 9, 'last column is face 9');
eq(faceAt(-1, -1), 9, 'wrapping back lands on face 9');
{
  // every column belongs to exactly one face, and each face owns F*F of them
  // Step 8 and not 7: the stride has to divide F or the sample itself is
  // lopsided and the test fails on its own arithmetic rather than on the model.
  const count = new Array(10).fill(0);
  for (let x = 0; x < W; x += 8) for (let y = 0; y < W; y += 8) count[faceAt(x, y)]++;
  ok(count[0] === 0, 'no column claims face 0');
  const each = (F / 8) * (F / 8);
  ok(SEALED.concat(CROSS).every((f) => count[f] === each),
    `faces are equal in size (${count.slice(1).join(',')} each want ${each})`);
}
{
  const l = { i: 0, j: 0 };
  localAt(F + 3, 2 * F + 9, l);
  ok(l.i === 3 && l.j === 9, `local of a face-6 column: ${l.i},${l.j}`);
  const o = faceOrigin(5);
  ok(o.x === F && o.y === F, `origin of face 5: ${o.x},${o.y}`);
  for (let f = 1; f <= 9; f++) {
    const q = faceOrigin(f);
    eq(faceAt(q.x, q.y), f, `origin of ${f} is in ${f}`);
  }
}

// --- THE ILLUSTRATION ------------------------------------------------------
// The owner's picture, entry by entry. north, south, west, east.
const TABLE = {
  1: [7, 4, 3, 2],
  2: [8, 5, 1, 3],
  3: [9, 6, 2, 1],
  4: [1, 7, 6, 5],
  5: [2, 8, 4, 6],
  6: [3, 9, 5, 4],
  7: [4, 1, 9, 8],
  8: [5, 2, 7, 9],
  9: [6, 3, 8, 7],
};
for (const f of Object.keys(TABLE).map(Number)) {
  const [n, s, w, e] = TABLE[f];
  eq(faceStep(f, NORTH), n, `${f} north`);
  eq(faceStep(f, SOUTH), s, `${f} south`);
  eq(faceStep(f, WEST), w, `${f} west`);
  eq(faceStep(f, EAST), e, `${f} east`);
}
// the two the owner called out by name
eq(faceStep(1, NORTH), 7, '1 up leads to 7');
eq(faceStep(3, EAST), 1, '3 right leads to 1');

// stepping back returns you
for (let f = 1; f <= 9; f++) {
  eq(faceStep(faceStep(f, NORTH), SOUTH), f, `${f} north then south`);
  eq(faceStep(faceStep(f, EAST), WEST), f, `${f} east then west`);
}
// three steps in one direction is a full turn
for (let f = 1; f <= 9; f++) {
  for (const d of [NORTH, SOUTH, WEST, EAST]) {
    eq(faceStep(faceStep(faceStep(f, d), d), d), f, `${f} three ${d}`);
  }
}

// --- and that the face table agrees with the column maths ------------------
// Walking a column over a tile edge must land in the face the table names.
for (let f = 1; f <= 9; f++) {
  const o = faceOrigin(f);
  const mid = F >> 1;
  eq(faceAt(o.x + mid, o.y - 1), TABLE[f][NORTH], `${f} north by column`);
  eq(faceAt(o.x + mid, o.y + F), TABLE[f][SOUTH], `${f} south by column`);
  eq(faceAt(o.x - 1, o.y + mid), TABLE[f][WEST], `${f} west by column`);
  eq(faceAt(o.x + F, o.y + mid), TABLE[f][EAST], `${f} east by column`);
}

// --- sealed and cross ------------------------------------------------------
ok(SEALED.every(isSealed), 'the corners are sealed');
ok(CROSS.every((f) => !isSealed(f)), 'the cross is not');
eq(SEALED.length + CROSS.length, 9, 'nine faces, no leftovers');
ok(!isSealed(START_FACE), 'the start is not a sealed room');
eq(START_FACE, 5, 'the start is the middle');

// six open joins, twelve dividers
{
  const seen = new Set();
  let open = 0, div = 0;
  for (let f = 1; f <= 9; f++) {
    for (const d of [NORTH, SOUTH, WEST, EAST]) {
      const g = faceStep(f, d);
      const key = f < g ? `${f}-${g}` : `${g}-${f}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isDivider(f, d)) div++; else open++;
    }
  }
  eq(seen.size, 18, 'eighteen joins in all');
  eq(open, 6, 'six open joins');
  eq(div, 12, 'twelve dividers');
}

// the cross is connected, and it loops both ways through the middle
{
  const seenF = new Set([5]);
  const stack = [5];
  while (stack.length) {
    const f = stack.pop();
    for (const d of [NORTH, SOUTH, WEST, EAST]) {
      const g = faceStep(f, d);
      if (isDivider(f, d) || seenF.has(g)) continue;
      seenF.add(g); stack.push(g);
    }
  }
  eq(seenF.size, 5, 'all five cross faces reachable without a divider');
  ok(CROSS.every((f) => seenF.has(f)), 'and they are exactly the cross');
  // 5 -> 2 -> 8 -> 5 and 5 -> 6 -> 4 -> 5
  eq(faceStep(5, NORTH), 2, 'up from the middle');
  eq(faceStep(2, NORTH), 8, 'and up again wraps to the bottom arm');
  eq(faceStep(8, NORTH), 5, 'and home');
  eq(faceStep(5, EAST), 6, 'right from the middle');
  eq(faceStep(6, EAST), 4, 'and right again wraps');
  eq(faceStep(4, EAST), 5, 'and home');
  // no sealed face is reachable from the cross without crossing a divider
  ok(SEALED.every((f) => !seenF.has(f)), 'no corner is reachable from the world');
}

// --- walls -----------------------------------------------------------------
{
  // a cross face has no wall column anywhere in it
  let crossWalls = 0;
  for (const f of CROSS) {
    const o = faceOrigin(f);
    for (let i = 0; i < F; i += 5) {
      if (isWall(o.x + i, o.y)) crossWalls++;
      if (isWall(o.x, o.y + i)) crossWalls++;
      if (isWall(o.x + i, o.y + F - 1)) crossWalls++;
      if (isWall(o.x + F - 1, o.y + i)) crossWalls++;
    }
  }
  eq(crossWalls, 0, 'the connected world contains no wall');

  // a sealed face is ringed, and hollow
  for (const f of SEALED) {
    const o = faceOrigin(f);
    ok(isWall(o.x, o.y), `${f} corner is wall`);
    ok(isWall(o.x + (F >> 1), o.y), `${f} north edge is wall`);
    ok(isWall(o.x + (F >> 1), o.y + F - 1), `${f} south edge is wall`);
    ok(isWall(o.x, o.y + (F >> 1)), `${f} west edge is wall`);
    ok(isWall(o.x + F - 1, o.y + (F >> 1)), `${f} east edge is wall`);
    ok(!isWall(o.x + WALL_T, o.y + WALL_T), `${f} just inside is open`);
    ok(!isWall(o.x + (F >> 1), o.y + (F >> 1)), `${f} middle is open`);
  }

  // you cannot walk from the cross into a sealed face: stepping over any
  // divider lands on a wall column
  for (let f = 1; f <= 9; f++) {
    if (isSealed(f)) continue;
    const o = faceOrigin(f);
    const mid = F >> 1;
    for (const [d, x, y] of [
      [NORTH, o.x + mid, o.y - 1], [SOUTH, o.x + mid, o.y + F],
      [WEST, o.x - 1, o.y + mid], [EAST, o.x + F, o.y + mid],
    ]) {
      if (!isDivider(f, d)) continue;
      ok(isWall(x, y), `stepping ${d} out of cross face ${f} meets a wall`);
    }
  }
}

// --- portals ---------------------------------------------------------------
{
  const all = allPortals();
  eq(all.length, 8, 'eight portals: two into each sealed face');
  for (const f of SEALED) {
    const ps = portalsOf(f);
    eq(ps.length, 2, `${f} has two doors`);
    for (const p of ps) {
      eq(faceAt(p.x, p.y), f, `${f} portal is on its own face`);
      ok(isWall(p.x, p.y), `${f} portal sits in the wall`);
      // it faces a cross face, never another corner
      ok(!isSealed(faceStep(f, p.dir)), `${f} portal faces the world`);
      // and the column just outside really is that cross face
      const [dx, dy] = DIR_STEP[p.dir];
      eq(faceAt(p.x + dx, p.y + dy), faceStep(f, p.dir), `${f} portal leads where it says`);
    }
  }
  eq(portalsOf(5).length, 0, 'the cross has no portals');
}

// --- wrapped distance ------------------------------------------------------
eq(delta(0, 5), 5, 'delta forward');
eq(delta(5, 0), -5, 'delta back');
eq(delta(0, W - 1), -1, 'delta takes the short way round');
eq(delta(W - 1, 0), 1, 'and the other way');
eq(delta(0, W / 2), W / 2, 'delta at exactly half');
ok(Math.abs(delta(0, 700)) <= W / 2, 'delta is never more than half a turn');
eq(dist2(0, 0, 0, 0), 0, 'distance to self');
eq(dist2(1, 1, W - 1, W - 1), 8, 'distance across the wrap is short');
{
  // the far corner of the map is not far at all, which is the whole point
  const d = Math.sqrt(dist2(0, 0, W - 1, 0));
  ok(d === 1, `west edge to east edge is one step, got ${d}`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
