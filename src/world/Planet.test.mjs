// Asserts storage, the raycast and the mesher against the flat map directly.
// `node src/world/Planet.test.mjs`.
//
// `Grid.test.mjs` is the template and the reason this exists: the cube's lesson
// was that a coordinate bug found in stage 7 costs more than stages 1 to 6
// combined, and the fastest way to find one is a file like this rather than a
// game that looks wrong. The game cannot even boot during the conversion, so
// this is the only thing standing between a wrong sign and stage 7.
//
// Planet.js imports three.js, which node loads happily, but nothing here needs a
// renderer or a DOM: `raycast` marches `blocks` and returns plain numbers, and
// `centerOf` writes into a Vector3. The mesher half is pure.

import { W, D, wrap, colIndex, faceAt, worldOf, cellOf, delta } from './Grid.js';
import {
  CHUNK_T, CHUNK_K, CW, CK, NUM_CHUNKS, NUM_REGIONS, REGION_COLS, REGION_VOXELS,
  chunkIdx, chunkDecode, regionOfCol, regionOfChunk, regionColumns, stepColumn,
  cellIdx, colParts, contCell, cellCorner, nearOffset, nearWorld,
} from './Layout.js';
import { Planet } from './Planet.js';
import { meshChunk } from './Mesher.js';
import { BLOCKS, RENDER_TYPE, R_LIQUID } from './Blocks.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);
const near = (a, b, what, tol = 1e-9) => ok(Math.abs(a - b) <= tol, `${what}: got ${a}, want ${b}`);

const ID = (name) => {
  const i = BLOCKS.findIndex((b) => b.name === name);
  if (i < 0) throw new Error(`no block ${name}`);
  return i;
};
const STONE = ID('stone');
const WATER = ID('water');
const GRASS_TUFT = BLOCKS.findIndex((b) => b.name === 'tall_grass');

// --- layout ----------------------------------------------------------------
eq(CW, 78, 'chunks per map axis');
eq(CK, 8, 'chunks up');
eq(CW * CHUNK_T, W, 'chunk columns tile the map exactly');
eq(CK * CHUNK_K, D, 'chunk layers tile the depth exactly');
eq(NUM_CHUNKS, 78 * 78 * 8, 'chunk count');
eq(NUM_REGIONS, 78 * 78, 'region count');
eq(REGION_VOXELS, REGION_COLS * D, 'a region is its columns at full depth');

// --- index round trips -----------------------------------------------------
{
  // storage: col * D + k, and a column's layers are contiguous
  eq(cellIdx(0, 0), 0, 'first cell');
  eq(cellIdx(5, 3) - cellIdx(5, 2), 1, 'layers are contiguous');
  eq(cellIdx(6, 0) - cellIdx(5, 0), D, 'columns are D apart');
  eq(cellIdx(0, -1), -1, 'below the world has no index');
  eq(cellIdx(0, D), -1, 'above the world has no index');

  const p = { x: 0, y: 0 };
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [W - 1, W - 1], [417, 900], [1247, 3]]) {
    colParts(colIndex(x, y), p);
    ok(p.x === x && p.y === y, `col parts round trip ${x},${y}`);
  }

  // chunks
  const c = { cx: 0, cy: 0, ck: 0 };
  for (const [cx, cy, ck] of [[0, 0, 0], [1, 2, 3], [77, 77, 7], [40, 0, 4]]) {
    chunkDecode(chunkIdx(cx, cy, ck), c);
    ok(c.cx === cx && c.cy === cy && c.ck === ck,
      `chunk round trip ${cx},${cy},${ck} -> ${c.cx},${c.cy},${c.ck}`);
  }
  eq(chunkIdx(-1, 0, 0), chunkIdx(CW - 1, 0, 0), 'chunk x wraps');
  eq(chunkIdx(0, CW, 0), chunkIdx(0, 0, 0), 'chunk y wraps');
  eq(NUM_CHUNKS - 1, chunkIdx(CW - 1, CW - 1, CK - 1), 'the last chunk is the last id');

  // regions
  for (const rid of [0, 1, CW, 4000, NUM_REGIONS - 1]) {
    const cols = regionColumns(rid);
    eq(cols.length, REGION_COLS, `region ${rid} column count`);
    ok(cols.every((col) => regionOfCol(col) === rid), `region ${rid} owns its columns`);
    // sixteen contiguous runs of sixteen - the region wire format relies on it
    let runs = 0;
    for (let n = 1; n < cols.length; n++) if (cols[n] !== cols[n - 1] + 1) runs++;
    eq(runs, CHUNK_T - 1, `region ${rid} is ${CHUNK_T} contiguous runs`);
  }
  eq(regionOfChunk(chunkIdx(3, 4, 5)), regionOfCol(colIndex(3 * CHUNK_T, 4 * CHUNK_T)),
    'a chunk names its own region');
}

// --- neighbours wrap, including at the map edge ----------------------------
{
  const p = { x: 0, y: 0 };
  colParts(stepColumn(colIndex(0, 0), -1, 0), p);
  ok(p.x === W - 1 && p.y === 0, `west of (0,0) is (${p.x},${p.y})`);
  colParts(stepColumn(colIndex(0, 0), 0, -1), p);
  ok(p.x === 0 && p.y === W - 1, `north of (0,0) is (${p.x},${p.y})`);
  colParts(stepColumn(colIndex(W - 1, W - 1), 1, 1), p);
  ok(p.x === 0 && p.y === 0, `southeast of the far corner is (${p.x},${p.y})`);
  // a long step is one piece of arithmetic and lands where it says
  colParts(stepColumn(colIndex(10, 10), W + 5, -W - 3), p);
  ok(p.x === 15 && p.y === 7, `a step longer than the map lands at (${p.x},${p.y})`);
  // and stepping there and back returns you, from every column tested
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, W - 1], [623, 88], [416, 416]]) {
    const col = colIndex(x, y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      eq(stepColumn(stepColumn(col, dx, dy), -dx, -dy), col, `step back at ${x},${y}`);
    }
  }
}

// --- world space ------------------------------------------------------------
{
  const planet = new Planet({});
  const v = planet.centerOf(colIndex(7, 9), 4);
  ok(v.x === 7.5 && v.y === 4.5 && v.z === 9.5, `centre of (7,9,4) is ${v.x},${v.y},${v.z}`);
  // and it agrees with Grid, which is the authority
  const g = worldOf(7, 9, 4);
  ok(v.x === g.x && v.y === g.y && v.z === g.z, 'centerOf agrees with Grid.worldOf');
  // cellCorner is worldOf minus the half, on every axis
  const c = cellCorner(7, 9, 4);
  ok(c[0] === g.x - 0.5 && c[1] === g.y - 0.5 && c[2] === g.z - 0.5,
    'cellCorner is half a unit below the centre');

  // the centre of a cell resolves back to that cell, everywhere, including the
  // far corner of the map
  for (const [x, y, k] of [[0, 0, 0], [W - 1, W - 1, D - 1], [416, 832, 40]]) {
    const w = worldOf(x, y, k);
    const back = cellOf(w.x, w.y, w.z);
    ok(back.x === x && back.y === y && back.k === k,
      `centre of ${x},${y},${k} resolves back to ${back.x},${back.y},${back.k}`);
  }

  // continuous cell coordinates keep the fraction and wrap the two map axes
  const cc = contCell(-0.25, 3.5, W + 0.75);
  near(cc.cx, W - 0.25, 'contCell wraps x and keeps the fraction');
  near(cc.cy, 0.75, 'contCell wraps y');
  near(cc.ck, 3.5, 'contCell does not wrap k');
}

// --- the mirror -------------------------------------------------------------
{
  const planet = new Planet({});
  planet.setAt(colIndex(3, 4), 5, STONE);
  eq(planet.at(colIndex(3, 4), 5), STONE, 'setAt then at');
  eq(planet.blockAtWorld(3.5, 5.5, 4.5), STONE, 'blockAtWorld hits the same cell');
  ok(planet.isSolidWorld(3.9, 5.1, 4.9), 'and it is solid');
  // out of the world vertically, and only vertically
  eq(planet.cellAt(3.5, -1, 4.5), null, 'below the world is off-world');
  eq(planet.cellAt(3.5, D, 4.5), null, 'above the world is off-world');
  ok(planet.cellAt(-1e6, 5, 1e6) !== null, 'no horizontal position is off-world');
  // wrapping: a world x of -0.5 is the last column
  const a = planet.cellAt(-0.5, 5.5, 4.5);
  ok(a.x === W - 1 && a.y === 4, `x = -0.5 is column ${a.x}`);
  planet.setAt(colIndex(W - 1, 4), 5, STONE);
  eq(planet.blockAtWorld(-0.5, 5.5, 4.5), STONE, 'and reading through the wrap finds it');

  // surfaceK is ground, not the water over it
  const col = colIndex(20, 20);
  planet.setAt(col, 10, STONE);
  planet.setAt(col, 11, WATER);
  eq(planet.surfaceK(col), 10, 'surfaceK is the bed, not the surface');
  ok(RENDER_TYPE[planet.at(col, planet.surfaceK(col) + 1)] === R_LIQUID,
    'and the water is one layer over it');
}

// --- the raycast ------------------------------------------------------------
const V3 = (x, y, z) => ({ x, y, z });

/** A planet with one solid cell in it, and a ray fired at it. */
function castAt(setup, origin, dir, maxDist = 8, opts = {}) {
  const planet = new Planet({});
  setup(planet);
  return planet.raycast(origin, dir, maxDist, opts);
}

{
  // a hit straight down onto a floor block
  const hit = castAt((p) => p.setAt(colIndex(10, 10), 5, STONE),
    V3(10.5, 9, 10.5), V3(0, -1, 0));
  ok(hit !== null, 'a ray fired down at a block hits it');
  eq(hit.id, STONE, 'and reports the block');
  eq(hit.col, colIndex(10, 10), 'and the column');
  eq(hit.k, 5, 'and the layer');
  near(hit.dist, 3, 'and the distance to the top face');
  ok(hit.normal.x === 0 && hit.normal.y === 1 && hit.normal.z === 0,
    `and the up normal, got ${hit.normal.x},${hit.normal.y},${hit.normal.z}`);
  eq(hit.prevK, 6, 'and the cell above it, to place against');
  eq(hit.prevCol, colIndex(10, 10), 'in the same column');
  near(hit.point.y, 6, 'and the hit point is on the face');
}
{
  // a miss: nothing in the way
  eq(castAt(() => {}, V3(10.5, 9, 10.5), V3(0, -1, 0)), null, 'an empty world is a miss');
  // a miss: the block is out of range
  eq(castAt((p) => p.setAt(colIndex(10, 10), 5, STONE), V3(10.5, 20, 10.5), V3(0, -1, 0), 4),
    null, 'a block past maxDist is a miss');
  // a miss: the ray leaves through the top of the world and never comes back
  eq(castAt((p) => p.setAt(colIndex(10, 10), 5, STONE), V3(10.5, 6.5, 10.5), V3(0, 1, 0), 40),
    null, 'a ray fired at the sky escapes upward');
  // ...but one that STARTS outside the layer range and comes back in must not
  // give up on the way. This is the camera above build height looking down, and
  // stopping at the first out-of-range cell is the easy way to lose it.
  const down = castAt((p) => p.setAt(colIndex(10, 10), 5, STONE),
    V3(10.5, D + 6, 10.5), V3(0, -1, 0), 120);
  ok(down !== null && down.k === 5, 'a ray from above the world marches down into it');
  ok(down && down.prevK === 6, 'and still knows the cell to place against');
  const up = castAt((p) => p.setAt(colIndex(10, 10), 5, STONE),
    V3(10.5, -6, 10.5), V3(0, 1, 0), 40);
  ok(up !== null && up.k === 5, 'and one from below marches up into it');
}
{
  // every one of the six faces, hit head on, reports its own normal
  const cases = [
    [V3(5.5, 5.5, 2.0), V3(0, 0, 1), [0, 0, -1], 'north face'],
    [V3(5.5, 5.5, 9.0), V3(0, 0, -1), [0, 0, 1], 'south face'],
    [V3(2.0, 5.5, 5.5), V3(1, 0, 0), [-1, 0, 0], 'west face'],
    [V3(9.0, 5.5, 5.5), V3(-1, 0, 0), [1, 0, 0], 'east face'],
    [V3(5.5, 9.0, 5.5), V3(0, -1, 0), [0, 1, 0], 'top face'],
    [V3(5.5, 2.0, 5.5), V3(0, 1, 0), [0, -1, 0], 'bottom face'],
  ];
  for (const [o, d, n, what] of cases) {
    const hit = castAt((p) => p.setAt(colIndex(5, 5), 5, STONE), o, d);
    ok(hit !== null, `${what}: hit`);
    if (!hit) continue;
    ok(hit.normal.x === n[0] && hit.normal.y === n[1] && hit.normal.z === n[2],
      `${what}: normal ${hit.normal.x},${hit.normal.y},${hit.normal.z} want ${n}`);
    // the previous cell is always the one on the other side of that face
    const q = colParts(hit.prevCol);
    ok(q.x === 5 + n[0] && q.y === 5 + n[2] && hit.prevK === 5 + n[1],
      `${what}: prev cell is across the face, got ${q.x},${q.y},${hit.prevK}`);
  }
}
{
  // ACROSS THE WRAP. A ray fired west from x = 0.5 leaves the map and must come
  // back on the far side and hit a block at x = W - 1.
  const hit = castAt((p) => p.setAt(colIndex(W - 1, 10), 5, STONE),
    V3(0.5, 5.5, 10.5), V3(-1, 0, 0), 4);
  ok(hit !== null, 'a ray fired off the west edge hits a block on the east edge');
  if (hit) {
    eq(hit.col, colIndex(W - 1, 10), 'and it is the right column');
    ok(hit.normal.x === 1 && hit.normal.y === 0 && hit.normal.z === 0,
      `and the east normal, got ${hit.normal.x},${hit.normal.y},${hit.normal.z}`);
    near(hit.dist, 0.5, 'and the distance is half a block, not the width of the map');
  }
  // the same on the other axis
  const h2 = castAt((p) => p.setAt(colIndex(10, W - 1), 5, STONE),
    V3(10.5, 5.5, 0.5), V3(0, 0, -1), 4);
  ok(h2 !== null && h2.col === colIndex(10, W - 1), 'and the same off the north edge');
}
{
  // A ray at the seam behaves EXACTLY as one mid-map. Same relative geometry,
  // measured against the same ray fired a long way from any edge.
  const build = (x0) => (p) => {
    // a floor of three blocks running east, and a wall standing on the last
    for (let n = 0; n < 3; n++) p.setAt(colIndex(x0 + n, 200), 5, STONE);
    p.setAt(colIndex(x0 + 3, 200), 6, STONE);
  };
  const shoot = (x0) => {
    const planet = new Planet({});
    build(x0)(planet);
    return planet.raycast(V3(wrap(x0) + 0.5, 6.5, 200.5), V3(1, 0, 0), 8);
  };
  const mid = shoot(600);
  const seam = shoot(W - 2);      // the run straddles the join
  ok(mid !== null && seam !== null, 'both rays hit');
  if (mid && seam) {
    near(seam.dist, mid.dist, 'seam and mid-map hits are the same distance');
    eq(seam.k, mid.k, 'the same layer');
    ok(seam.normal.x === mid.normal.x && seam.normal.y === mid.normal.y
      && seam.normal.z === mid.normal.z, 'and the same normal');
    const a = colParts(mid.col), b = colParts(seam.col);
    eq(wrap(b.x - (W - 2)), wrap(a.x - 600), 'and the same column, relative to the start');
  }
}
{
  // The ray cannot escape the map horizontally however far it is fired. Twice
  // round and it is still finding blocks.
  const planet = new Planet({});
  for (let x = 0; x < W; x++) planet.setAt(colIndex(x, 300), 5, STONE);
  const hit = planet.raycast(V3(0.5, 5.5, 300.5), V3(1, 0, 0), 3 * W);
  ok(hit !== null, 'a ray fired three times round the map still hits');
  // and a diagonal one, which crosses both seams
  const h2 = planet.raycast(V3(0.5, 5.5, 300.5), V3(0.7071, 0, 0.7071), 4);
  ok(h2 === null || h2.k === 5, 'a diagonal ray stays in the world');
}
{
  // A liquid is passed through unless asked for.
  const set = (p) => { p.setAt(colIndex(30, 30), 5, WATER); };
  eq(castAt(set, V3(30.5, 9, 30.5), V3(0, -1, 0)), null, 'water is not hit by default');
  const wet = castAt(set, V3(30.5, 9, 30.5), V3(0, -1, 0), 8, { hitLiquid: true });
  ok(wet !== null && wet.id === WATER, 'and is hit when asked for');
}
{
  // A ray that starts inside a block reports it, with no entry face to name.
  const hit = castAt((p) => p.setAt(colIndex(40, 40), 5, STONE),
    V3(40.5, 5.5, 40.5), V3(0, 0, 1));
  ok(hit !== null && hit.dist === 0, 'a ray starting inside a block hits at zero');
  ok(hit && hit.prevCol === -1, 'and has no cell to place against');
}
if (GRASS_TUFT > 0) {
  // A cross plant is not a full cell. Its two quads stand on the middle of each
  // map axis, so a ray down the middle of the cell crosses both and a ray down
  // the corner of it crosses neither.
  //
  // Both rays are vertical on purpose: a ray running along one axis crosses the
  // OTHER quad's plane wherever it enters, so it would be hit whatever its
  // offset, and that is correct rather than a bug. Only a ray parallel to the
  // planes can miss them. The atlas has not decoded here, so `plantMask` is null
  // and the forgiving fallback shape is what is being asserted.
  const set = (p) => { p.setAt(colIndex(50, 50), 5, GRASS_TUFT); };
  const through = castAt(set, V3(50.5, 8, 50.5), V3(0, -1, 0), 6);
  ok(through !== null, 'a cross plant aimed at its middle is hit');
  const past = castAt(set, V3(50.02, 8, 50.02), V3(0, -1, 0), 6);
  ok(past === null, 'and one aimed at the corner of its cell is not');
  // ...and a ray along an axis does cross the standing quad, at any offset
  const along = castAt(set, V3(50.02, 5.5, 48), V3(0, 0, 1), 6);
  ok(along !== null, 'a ray along one axis meets the quad that spans it');
}

// --- the mesher -------------------------------------------------------------
const N_LIGHT = W * W * D;
function emptyLight() {
  return {
    sun: new Uint8Array(N_LIGHT).fill(15),
    r: new Uint8Array(N_LIGHT), g: new Uint8Array(N_LIGHT), b: new Uint8Array(N_LIGHT),
  };
}
const _light = emptyLight();
const _biome = new Uint8Array(W * W);

function mesh(blocks, cx, cy, ck) {
  return meshChunk(blocks, _biome, null, _light, new Map(), cx, cy, ck);
}
const newBlocks = () => new Uint8Array(W * W * D);
const quadsOf = (res) => (res.groups[0] ? res.groups[0].position.length / 12 : 0);

{
  const blocks = newBlocks();
  blocks[colIndex(5, 7) * D + 3] = STONE;
  const res = mesh(blocks, 0, 0, 0);
  eq(quadsOf(res), 6, 'an isolated block is six quads');

  // the six normals are the six outward axis directions, each exactly once
  const g = res.groups[0];
  const seen = new Map();
  for (let i = 0; i < g.normal.length; i += 3) {
    const key = `${g.normal[i]},${g.normal[i + 1]},${g.normal[i + 2]}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  eq(seen.size, 6, 'six distinct normals');
  for (const key of ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']) {
    eq(seen.get(key), 4, `normal ${key} on exactly one quad`);
  }

  // every vertex is on the cell the block is in, and nowhere else. A cube that
  // put its geometry a unit off its voxel is what "you could punch through what
  // you could see" was.
  let inside = true;
  for (let i = 0; i < g.position.length; i += 3) {
    if (g.position[i] < 5 || g.position[i] > 6) inside = false;
    if (g.position[i + 1] < 3 || g.position[i + 1] > 4) inside = false;
    if (g.position[i + 2] < 7 || g.position[i + 2] > 8) inside = false;
  }
  ok(inside, 'every vertex is on the cell the block occupies');

  // and the winding agrees with the normal it declares: for each quad, the
  // cross product of its own edges must point the way the attribute says.
  let wound = true;
  for (let q = 0; q < g.position.length / 12; q++) {
    const o = q * 12;
    const ax = g.position[o + 3] - g.position[o], ay = g.position[o + 4] - g.position[o + 1],
      az = g.position[o + 5] - g.position[o + 2];
    const bx = g.position[o + 9] - g.position[o], by = g.position[o + 10] - g.position[o + 1],
      bz = g.position[o + 11] - g.position[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (Math.abs(nx / l - g.normal[o]) > 1e-6
      || Math.abs(ny / l - g.normal[o + 1]) > 1e-6
      || Math.abs(nz / l - g.normal[o + 2]) > 1e-6) wound = false;
  }
  ok(wound, 'every quad is wound so its own edges give the normal it declares');
}
{
  // CULL NOTHING AT THE MAP EDGE. A block at x = 0 has a neighbour at x = W - 1,
  // and if the edge read as empty the world would be ringed in a wall of faces.
  const blocks = newBlocks();
  blocks[colIndex(0, 0) * D + 3] = STONE;
  eq(quadsOf(mesh(blocks, 0, 0, 0)), 6, 'a lone block at the origin is six quads');

  blocks[colIndex(W - 1, 0) * D + 3] = STONE;
  eq(quadsOf(mesh(blocks, 0, 0, 0)), 5, 'a neighbour across the west wrap culls a face');
  eq(quadsOf(mesh(blocks, CW - 1, 0, 0)), 5, 'and culls one on the far chunk too');

  blocks[colIndex(0, W - 1) * D + 3] = STONE;
  eq(quadsOf(mesh(blocks, 0, 0, 0)), 4, 'and a neighbour across the north wrap culls another');
}
{
  // Two blocks side by side inside a chunk share a face, which neither draws.
  const blocks = newBlocks();
  blocks[colIndex(4, 4) * D + 3] = STONE;
  blocks[colIndex(5, 4) * D + 3] = STONE;
  eq(quadsOf(mesh(blocks, 0, 0, 0)), 10, 'two adjacent blocks are ten quads');
  // and across a CHUNK boundary the face is still culled, from both sides
  const b2 = newBlocks();
  b2[colIndex(CHUNK_T - 1, 4) * D + 3] = STONE;
  b2[colIndex(CHUNK_T, 4) * D + 3] = STONE;
  eq(quadsOf(mesh(b2, 0, 0, 0)), 5, 'the chunk on one side of a boundary draws five');
  eq(quadsOf(mesh(b2, 1, 0, 0)), 5, 'and the chunk on the other side draws five');
}
{
  // A chunk only meshes its own cells, on all three axes.
  const blocks = newBlocks();
  blocks[colIndex(CHUNK_T + 2, 2) * D + 3] = STONE;
  eq(quadsOf(mesh(blocks, 0, 0, 0)), 0, 'a block in the next chunk is not meshed here');
  eq(quadsOf(mesh(blocks, 1, 0, 0)), 6, 'and is meshed there');
  const b2 = newBlocks();
  b2[colIndex(2, 2) * D + CHUNK_K] = STONE;
  eq(quadsOf(mesh(b2, 0, 0, 0)), 0, 'a block a layer chunk up is not meshed here');
  eq(quadsOf(mesh(b2, 0, 0, 1)), 6, 'and is meshed there');
}
{
  // Meshing the seam is the same work as meshing mid-map: the same arrangement
  // of blocks, translated onto the join, produces the same number of quads and
  // the same set of normals.
  const shape = [[0, 0, 3], [1, 0, 3], [0, 1, 3], [0, 0, 4]];
  const build = (x0, y0) => {
    const b = newBlocks();
    for (const [dx, dy, k] of shape) b[colIndex(x0 + dx, y0 + dy) * D + k] = STONE;
    return b;
  };
  // mid-map, at the low corner of a chunk, and the same at the map's last chunk
  const a = mesh(build(16 * 20, 16 * 20), 20, 20, 0);
  const s = mesh(build(W - 1, W - 1), CW - 1, CW - 1, 0);
  // the seam version straddles four chunks, so count all of them
  let seamQuads = 0;
  for (const [cx, cy] of [[CW - 1, CW - 1], [0, CW - 1], [CW - 1, 0], [0, 0]]) {
    seamQuads += quadsOf(mesh(build(W - 1, W - 1), cx, cy, 0));
  }
  eq(seamQuads, quadsOf(a), 'the same shape on the seam is the same number of quads');
  ok(s !== null, 'and the seam chunk meshes');
}

// --- drawing across the wrap ------------------------------------------------
{
  // nearOffset is always a multiple of W, is zero within half a map, and picks
  // the same copy Grid.delta does - the two must never disagree.
  for (const [view, v] of [[0, 0], [10, 20], [0, W - 1], [W - 1, 0], [600, 100],
    [1247, 3], [0, W / 2], [0, -W / 2], [500, 1200]]) {
    const off = nearOffset(view, v);
    eq(off % W, 0, `nearOffset(${view},${v}) is a multiple of W`);
    eq(v + off - view, delta(view, v), `nearOffset agrees with Grid.delta at ${view},${v}`);
    ok(Math.abs(v + off - view) <= W / 2, `and lands within half a map at ${view},${v}`);
  }
  eq(nearOffset(10, 20), 0, 'a nearby column does not move');
  eq(nearOffset(600, 700), 0, 'nor does one a hundred away');
  eq(nearOffset(W - 1, 3), W, 'a column across the seam is pulled a map east');
  eq(nearOffset(3, W - 1), -W, 'and one the other way a map west');
  near(nearWorld(1247, 3), 1251, 'so x = 3 is drawn four units east of x = 1247');
}
{
  // viewOf is a no-op except across a seam, and never moves y.
  const planet = new Planet({});
  planet.setView(1247.5, 10.5);
  const a = planet.viewOf(3.5, 40.5, 10.5);
  ok(a.x === 1251.5 && a.y === 40.5 && a.z === 10.5,
    `viewOf across the seam gives ${a.x},${a.y},${a.z}`);
  const b = planet.viewOf(1246.5, 40.5, 10.5);
  ok(b.x === 1246.5 && b.z === 10.5, 'and leaves a nearby position alone');
  // and the cell-centre spelling of it agrees with centerOf plus the offset
  const col = colIndex(3, 10);
  const c = planet.viewCenterOf(col, 40);
  const abs = planet.centerOf(col, 40);
  ok(c.x === abs.x + W && c.y === abs.y && c.z === abs.z,
    'viewCenterOf is centerOf on the copy nearest the viewer');
}
{
  // The real bug: standing at the east edge, the chunk at cx = 0 must be DRAWN
  // just east of the viewer rather than a map width west.
  const blocks = newBlocks();
  blocks[colIndex(2, 2) * D + 3] = STONE;
  const payload = mesh(blocks, 0, 0, 0);

  const planet = new Planet({
    opaque: null, cutout: null, transparent: null, liquid: null,
  });
  planet.setView(W - 1.5, 2.5);
  planet.applyChunk(0, 0, 0, payload.groups);
  const meshes = [...planet.meshes.values()];
  ok(meshes.length > 0, 'the chunk produced a mesh');
  const m = meshes[0];
  eq(m.position.x, W, 'a chunk at x = 0 seen from x = W - 1.5 is drawn a map east');
  eq(m.position.z, 0, 'and is not moved on z, where it is already nearest');
  // the block itself is at absolute x 2..3, so it is drawn at 1250..1251, which
  // is three and a half units east of the viewer rather than 1245 west
  const drawnX = 2 + m.position.x;
  near(drawnX - (W - 1.5), 3.5, 'and the block lands three and a half units east');

  // Walk back over the seam and it must re-seat itself.
  planet.setView(1.5, 2.5);
  eq(m.position.x, 0, 'walking back over the seam re-seats the chunk');
  ok(m.matrix.elements[12] === 0, 'and the transform was rebuilt, not just the position');

  // ...and out again.
  planet.setView(W - 1.5, 2.5);
  eq(m.position.x, W, 're-seats again on the way out');
  eq(m.matrix.elements[12], W, 'and the transform followed');
}
{
  // No resident chunk is ever drawn more than half a map away, from anywhere.
  // That is the property the hole in the ground was the absence of.
  const blocks = newBlocks();
  blocks[colIndex(2, 2) * D + 3] = STONE;
  const payload = mesh(blocks, 0, 0, 0);
  const planet = new Planet({ opaque: null, cutout: null, transparent: null, liquid: null });
  planet.applyChunk(0, 0, 0, payload.groups);
  const m = [...planet.meshes.values()][0];
  let worst = 0;
  for (let vx = 0; vx < W; vx += 37) {
    for (let vz = 0; vz < W; vz += 173) {
      planet.setView(vx + 0.5, vz + 0.5);
      const dx = (CHUNK_T * 0.5 + m.position.x) - (vx + 0.5);
      const dz = (CHUNK_T * 0.5 + m.position.z) - (vz + 0.5);
      worst = Math.max(worst, Math.abs(dx), Math.abs(dz));
    }
  }
  ok(worst <= W / 2, `the chunk is never drawn further than half a map away, worst ${worst}`);
}

// --- chunkBuried ------------------------------------------------------------
{
  const planet = new Planet({});
  const h = new Float32Array(W * W).fill(60);
  planet.setGlobals(new Uint8Array(W * W), h);
  const rid = regionOfCol(colIndex(0, 0));
  // ck 0 spans layers 0..10, top face at 11, floor 60: 11 < 60 - 11, buried
  ok(planet.chunkBuried(rid * CK + 0), 'a chunk far under the ground is buried');
  // ck 5 spans 55..65, top face 66: 66 < 49 is false
  ok(!planet.chunkBuried(rid * CK + 5), 'a chunk at the surface is not');
  ok(!planet.chunkBuried(rid * CK + 7), 'nor is one above it');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
