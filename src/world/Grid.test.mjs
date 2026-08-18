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
  faceStep, isDivider, isWall, portalsOf, allPortals, portalAxis, portalHop, wallExit, delta, dist2,
  SEA_K, worldOf, cellOf,
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
  eq(all.length, 16, 'sixteen portals: every side of every sealed face');
  for (const f of SEALED) {
    const ps = portalsOf(f);
    eq(ps.length, 4, `${f} has four doors`);
    const dirs = new Set(ps.map((p) => p.dir));
    eq(dirs.size, 4, `${f} has one on each side`);
    for (const p of ps) {
      eq(faceAt(p.x, p.y), f, `${f} portal is on its own face`);
      ok(isWall(p.x, p.y), `${f} portal sits in the wall`);
      // and the column just outside really is the face it says it leads to
      const [dx, dy] = DIR_STEP[p.dir];
      eq(faceAt(p.x + dx, p.y + dy), faceStep(f, p.dir), `${f} portal leads where it says`);
      // a door onto another corner is a double wall: the column beyond is the
      // other face's ring, and the one beyond that is its interior
      if (isSealed(faceStep(f, p.dir))) {
        ok(isWall(p.x + dx, p.y + dy), `${f} corner-to-corner door is walled twice`);
        ok(!isWall(p.x + dx * 2, p.y + dy * 2), `and open on the third column`);
      }
    }
  }
  eq(portalsOf(5).length, 0, 'the cross has no portals');
}

// --- the way through, run by run and corner by corner ----------------------
//
// `portalAxis` reads a straight run from the column alone. A ring corner is
// walled on both axes and cannot be read that way, so `wallExit` answers the
// one-sided question instead - and what makes that safe is asserted here rather
// than only argued in the comment: a corner's open sides are all outward.
{
  const o1 = faceOrigin(1);           // Rime, at the map origin
  ok(portalAxis(o1.x + F - 1, o1.y + 200) !== null, 'the east run is a way through');
  eq(portalAxis(o1.x + 200, o1.y), null, 'the sealed-to-sealed north run is not');
  eq(portalAxis(o1.x + F - 1, o1.y + F - 1), null, 'and nor is a ring corner, read alone');

  // Every ring corner in the world. Twelve of the sixteen have a way out and
  // four - where four rings meet at a corner of the map - have none.
  let out = 0, none = 0, inward = 0;
  for (const f of SEALED) {
    const o = faceOrigin(f);
    for (const [i, j] of [[0, 0], [F - 1, 0], [0, F - 1], [F - 1, F - 1]]) {
      const x = o.x + i, y = o.y + j;
      eq(portalAxis(x, y), null, `face ${f} corner (${i},${j}) is refused by the strict rule`);
      let n = 0;
      for (const [dx, dy] of DIR_STEP) {
        if (!wallExit(x, y, dx, dy)) continue;
        n++;
        if (isSealed(faceAt(x + dx, y + dy))) inward++;
      }
      if (n > 0) out++; else none++;
    }
  }
  eq(out, 12, 'twelve ring corners have a way out');
  eq(none, 4, 'and the four where four rings meet have none');
  eq(inward, 0, 'no corner ever leads into a sealed face');

  // The sealed-to-sealed runs are not a ONE-column step, so `wallExit` says no
  // to them from either side. That is not the same as being impassable: it is
  // what makes them `portalHop`'s business rather than the corner rule's, and
  // it is also what keeps a corner from ever leading inward.
  for (let j = 1; j < F - 1; j += 97) {
    ok(!wallExit(o1.x + 200, o1.y, 0, -1), 'one step north out of Rime is still ring');
    ok(!wallExit(o1.x, o1.y + j, -1, 0), 'and one step west is too');
  }
}

// --- the double wall -------------------------------------------------------
//
// Where two sealed faces touch, their rings sit back to back and the step is
// three columns wide: near interior, wall, wall, far interior. The owner's call
// is that all four sides of a sealed face are passable, so `portalHop` reads
// that shape where `portalAxis` cannot.
{
  const o1 = faceOrigin(1);                      // Rime at the map origin
  const north = portalHop(o1.x + 200, o1.y);     // against Verdant's south ring
  ok(north && north.axis === 1 && north.span === 2, 'Rime opens north on a double wall');
  eq(north.near, 1, 'and its only open side is Rime, at y + 1');
  const back = portalHop(o1.x + 200, wrap(o1.y - 1));   // the other half of the pair
  ok(back && back.span === 2, 'Verdant opens south through the same pair');
  eq(back.near, -1, 'from its own side');

  const west = portalHop(o1.x, o1.y + 200);      // against Tempest's east ring
  ok(west && west.axis === 0 && west.span === 2, 'and west on one too');

  // A straight run is unchanged, and still a single-column step.
  const east = portalHop(o1.x + F - 1, o1.y + 200);
  ok(east && east.axis === 0 && east.span === 1, 'a sealed-to-cross run is span one');
  eq(portalHop(o1.x + 200, o1.y + 200), null, 'and open ground is not a way through');

  // Every wall column in the world, and where the step it reports lands.
  let span1 = 0, span2 = 0, refused = 0, bad = 0, corners = 0;
  for (const f of SEALED) {
    const o = faceOrigin(f);
    for (let i = 0; i < F; i++) {
      for (let j = 0; j < F; j++) {
        const x = o.x + i, y = o.y + j;
        if (!isWall(x, y)) continue;
        const isCorner = (i === 0 || i === F - 1) && (j === 0 || j === F - 1);
        const h = portalHop(x, y);
        if (h === null) { refused++; if (isCorner) corners++; continue; }
        if (isCorner) bad++;                     // a corner is never read alone
        if (h.span === 1) { span1++; continue; }
        span2++;
        // Near side open, the column between walled, far side open ground in
        // the other sealed face.
        const nx = x + h.dx * h.near, ny = y + h.dy * h.near;
        const mx = x - h.dx * h.near, my = y - h.dy * h.near;
        const fx = x - h.dx * h.near * 2, fy = y - h.dy * h.near * 2;
        if (isWall(nx, ny) || !isWall(mx, my) || isWall(fx, fy)) bad++;
        else if (faceAt(nx, ny) !== f) bad++;
        else if (!isSealed(faceAt(fx, fy))) bad++;
        else if (faceAt(fx, fy) === f) bad++;
      }
    }
  }
  eq(span1, 4 * 2 * (F - 2), 'every sealed-to-cross column is a single-column step');
  eq(span2, 4 * 2 * (F - 2), 'and every sealed-to-sealed one is a double');
  eq(refused, 16, 'only the sixteen ring corners are refused');
  eq(corners, 16, 'and all sixteen of them are');
  eq(bad, 0, 'every double wall lands in the interior of the face on the other side');

  // The topology this buys: from any sealed face you can now reach the other
  // three without coming back out to the cross.
  const reach = (f) => {
    const seen = new Set([f]), queue = [f];
    while (queue.length) {
      const g = queue.pop();
      for (let d = 0; d < 4; d++) {
        const n = faceStep(g, d);
        if (!isSealed(n) || seen.has(n)) continue;
        seen.add(n); queue.push(n);
      }
    }
    return seen;
  };
  for (const f of SEALED) eq(reach(f).size, 4, `${f} reaches all four corners without the cross`);
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

// --- world space -----------------------------------------------------------
{
  const w = worldOf(10, 20, 30);
  ok(w.x === 10.5 && w.y === 30.5 && w.z === 20.5,
    `map (10,20,k30) is world (${w.x},${w.y},${w.z}); map y must become world Z and k world Y`);
  const c = cellOf(w.x, w.y, w.z);
  ok(c.x === 10 && c.y === 20 && c.k === 30, `world round trip: ${c.x},${c.y},${c.k}`);
  // up is +Y and nothing else
  const above = cellOf(w.x, w.y + 1, w.z);
  ok(above.k === 31 && above.x === 10 && above.y === 20, 'one metre up is one layer up');
  // horizontal wraps, vertical does not
  const off = cellOf(-0.5, 5.5, -0.5);
  ok(off.x === W - 1 && off.y === W - 1, 'world position west of the origin wraps');
  eq(cellOf(0.5, -3.5, 0.5).k, -4, 'below the world stays negative rather than wrapping');
  // every corner of a cell resolves to that cell
  for (const dx of [0.01, 0.99]) for (const dy of [0.01, 0.99]) for (const dk of [0.01, 0.99]) {
    const q = cellOf(7 + dx, 3 + dk, 9 + dy);
    ok(q.x === 7 && q.y === 9 && q.k === 3, `corner ${dx},${dy},${dk} stays in its cell`);
  }
  eq(SEA_K, 33, 'sea level layer');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
