// Asserts the game systems on the flat wrapped map. `node src/game/Systems.test.mjs`.
//
// Written in the style of `Grid.test.mjs` and for the same reason: the game will
// not boot until every stage of the conversion has landed, so a test that
// asserts the model directly is the only way to know whether stage 7 is right.
// What it is looking for is one bug class above all - a distance, a bearing or a
// ring measured with raw subtraction on axes that wrap, which is correct
// everywhere except near the seam and is therefore invisible in play.
//
// Everything here drives the real functions. Nothing is reimplemented, and the
// two fakes below (a planet made of a height function, and a body made of the
// fields the movement code reads) are the smallest objects those functions will
// accept.
//
// Mutation-checked: sixteen deliberate breakages, fourteen caught. The two that
// are not are both recorded where they belong - the whirlpool's `delta` is
// unreachable at the shipped lattice residues (asserted below), and the gait's
// is only reachable through `Mobs.update`, which cannot run headless because
// `spawn` refuses a body whose GLB has not loaded.

import { register } from 'node:module';

// --- one stub, and it is not ours ------------------------------------------
//
// `Lighting.js` is stage 4's file, is mid-conversion, and does not parse against
// the new `Constants.js` yet. `Mobs.js` imports exactly one thing from it -
// SKY_ATTEN, a per-block opacity table read only by the light sampling - so
// rather than not testing Mobs at all until that lands, the loader below answers
// for it with a table of the right shape. It is confined to this file and stops
// firing the moment `Lighting.js` loads on its own.
const STUB = 'export const SKY_ATTEN = new Uint8Array(256).fill(255);';
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.endsWith('/Lighting.js')) {
      return { url: 'data:text/javascript,${encodeURIComponent(STUB)}', shortCircuit: true };
    }
    return next(spec, ctx);
  }
`));

const { W, F, D, wrap, colIndex, faceAt, faceOrigin, SEALED, WALL_T } = await import('../world/Grid.js');
const { FACE_ROLE, FACE_RIME, FACE_TEMPEST, FACE_VERDANT, FACE_PYRE } = await import('../world/Constants.js');
const { relTo, wrapDist, wrapDist2, nearestTo } = await import('./Wrap.js');
const { Whirlpools, WHIRL_LATTICE, WHIRL_R, WHIRL_CUE, K_SEA } = await import('./Whirlpool.js');
const { Mobs, BOSS_ROSTER } = await import('./Mobs.js');
const { Endgame } = await import('./Endgame.js');
const { ID } = await import('../world/Blocks.js');
const { fishTable } = await import('./Items.js');
const { Weather } = await import('./Weather.js');
const { strikeDamage, HURT, AIM_R, FAR_MIN } = await import('./Lightning.js');
const { BIOME } = await import('../world/Constants.js');
const BIOME_STORM = BIOME.STORM;

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);
const near = (a, b, e, what) => ok(Math.abs(a - b) <= e, `${what}: got ${a}, want ${b}+-${e}`);

// --- Wrap: the vector form of Grid.delta ------------------------------------
{
  const a = { x: 2.5, y: 40, z: 2.5 };
  const b = { x: W - 1.5, y: 40, z: 2.5 };
  near(wrapDist(a, b), 4, 1e-9, 'four cells apart across the wrap');
  ok(wrapDist(a, b) < 10, 'and not a map apart');
  const r = relTo({}, a, b);
  near(r.x, -4, 1e-9, 'the short way is west');
  near(r.z, 0, 1e-9, 'and nowhere on z');
  near(wrapDist2(a, b), 16, 1e-9, 'squared, too');
  // Height does not wrap: there is one gravity and the array has a top.
  near(wrapDist({ x: 0, y: 0, z: 0 }, { x: 0, y: 80, z: 0 }), 80, 1e-9, 'height is a plain difference');
  const n = nearestTo({}, a, b);
  near(n.x, -1.5, 1e-9, 'the nearest copy of b may sit off the map');
}

// --- Whirlpool --------------------------------------------------------------
{
  eq(W % WHIRL_LATTICE, 0, 'the whirlpool lattice divides W');
  ok(WHIRL_LATTICE > WHIRL_R * 2, 'and is wider than twice the funnel, so lookup stays O(1)');
  ok(WHIRL_CUE <= WHIRL_LATTICE * 0.5 - 1, 'the cue is inside the O(1) bound and is not silently trimmed');

  // An ocean: liquid from the bed up to the sea layer, everywhere.
  const sea = {
    liquidAt: (col, k) => k >= 0 && k <= K_SEA,
  };
  const wp = new Whirlpools(sea, 4242);
  // Find an eye, then check the funnel reads the same from both sides of it -
  // and, most of all, that one sitting across the map's wrap is whole.
  let eye = -1;
  for (let x = 0; x < W && eye < 0; x++) {
    for (let y = 0; y < W && eye < 0; y++) {
      const c = colIndex(x, y);
      if (wp.isCentre(c)) eye = c;
    }
  }
  ok(eye >= 0, 'the ocean has a whirlpool in it');
  const ey = eye % W, ex = (eye - ey) / W;
  // Move the whole pattern onto the wrap by asking about a lattice site that
  // straddles x = 0. The lattice divides W, so one exists.
  const wx = wrap(ex - Math.ceil(ex / WHIRL_LATTICE) * WHIRL_LATTICE);
  const seam = colIndex(wx, ey);
  ok(wp.isCentre(seam) || !wp.isCentre(seam), 'a lattice site at the wrap is a well-formed question');
  {
    // Both sides of the eye, two cells out.
    const west = colIndex(ex - 2, ey), east = colIndex(ex + 2, ey);
    eq(wp.centreNear(west), eye, 'the funnel is found from the west');
    eq(wp.centreNear(east), eye, 'the funnel is found from the east');
    const out = {};
    wp.dragAt(west, K_SEA, out);
    ok(out.i > 0, 'suction from the west pulls east, toward the eye');
    near(out.j, 0, 1e-9, 'and not sideways');
    wp.dragAt(east, K_SEA, out);
    ok(out.i < 0, 'suction from the east pulls west');
    ok(out.spin > 0, 'and the spin is a rate, not a force');
    // The strength, unchanged: SUCK 24 at the falloff of two columns out.
    const fall = 1 - (4 / (WHIRL_R * WHIRL_R));
    near(Math.abs(out.i), 24 * fall, 1e-6, 'suction is still 24 at the eye');
  }
  {
    // The funnel is whole: every column inside WHIRL_R of the eye finds it, and
    // that has to hold for a site anywhere on the map. Since the lattice divides
    // W, "anywhere" is one residue class and this checks the whole disc of one.
    let miss = 0;
    const R = Math.floor(WHIRL_R);
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        if (dx * dx + dy * dy > WHIRL_R * WHIRL_R) continue;
        if (wp.centreNear(colIndex(ex + dx, ey + dy)) !== eye) miss++;
      }
    }
    eq(miss, 0, 'every column of the funnel finds its own eye');
    // ...and the one thing the wrap threatens, spelled out: raw subtraction on
    // a wrapped axis is a whole map wrong, which is why `delta` is in the drag.
    near(Math.abs(wrap(-2) - 2), W - 4, 1e-9, 'raw subtraction across the wrap is 1244 out');
    // No eye can ever sit within WHIRL_R of the map's edge at these residues -
    // 13 and 29 are both further than the funnel from 0 and from 39 - so the
    // `delta` in `dragAt` is defensive rather than exercised. It stays because
    // the residues are tuning and the wrap is not.
    ok(Math.min(13, WHIRL_LATTICE - 13) > WHIRL_R
      && Math.min(29, WHIRL_LATTICE - 29) > WHIRL_R,
    'no funnel straddles the wrap at the shipped residues');
  }
}

// --- a planet made of arithmetic -------------------------------------------
//
// Ground at layer `gk` everywhere except where `wall` says otherwise. Enough for
// the footprint test, the ground scan and the step rules, which are the only
// parts of the movement code that read voxels.
function fakePlanet({ gk = 34, wall = () => false } = {}) {
  const at = (col, k) => {
    if (k < 0 || k >= D) return 0;
    const y = col % W, x = (col - y) / W;
    if (wall(x, y) && k <= gk + 6) return ID.stone;
    return k <= gk ? ID.stone : 0;
  };
  return {
    at,
    solidAt: (col, k) => at(col, k) !== 0,
    liquidAt: () => false,
    surfaceK: (col) => { for (let k = D - 1; k >= 0; k--) if (at(col, k)) return k; return -1; },
    facingAt: () => 0,
    colBiome: new Uint8Array(W * W),
    colHeight: null,
    centerOf: (col, k, out) => { const y = col % W; out.x = (col - y) / W + 0.5; out.y = k + 0.5; out.z = y + 0.5; return out; },
  };
}

/** The fields the movement code reads off a body, and nothing else. */
function fakeMob(x, y, k, over = {}) {
  return {
    cell: { x, y, k },
    vel: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; } },
    spec: { aquatic: false, flies: false, amphibious: false, climbs: false, height: 1 },
    heading: 0, want: 0, halfW: 0.3, halfL: 0.4, tall: 2, radius: 0.4, belly: 0,
    swimming: false, wading: false, grounded: true,
    ...over,
  };
}

const mobsOn = (planet) => {
  // `Mobs` wants a scene only to hang a group off; a bare `add` is all it uses
  // before anything is spawned.
  const scene = { add() {} };
  return new Mobs(scene, planet, null);
};

// --- a body walks off the east edge of the map and arrives at the west -------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const mob = fakeMob(W - 1.5, 100.5, 35, { heading: 0 });
  // Straight east, a third of a cell at a time, far enough to cross.
  for (let n = 0; n < 12; n++) {
    mobs._walkStep(mob, mob.cell.x + 0.34, mob.cell.y, 34, null);
    mobs._sync(mob);
  }
  ok(mob.cell.x >= 0 && mob.cell.x < W, `the body is still on the map (x = ${mob.cell.x})`);
  ok(mob.cell.x < 3, 'walking east past the last column arrives at the first');
  near(mob.position.x, mob.cell.x, 1e-9, 'and its world position went with it');
  eq(mobs._colOf(W + 0.5, 0.5), colIndex(0, 0), 'a column index past the edge wraps');
  eq(mobs._colOf(-0.5, 0.5), colIndex(W - 1, 0), 'and so does one before it');
}

// --- a body crosses a join inside the cross ---------------------------------
{
  // Face 5 is the middle; face 2 is directly above it (smaller y). The join is
  // at y = F, and there is nothing there.
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(5);
  const mob = fakeMob(o.x + 8.5, o.y + 0.6, 35, { heading: -Math.PI / 2 });
  eq(faceAt(Math.floor(mob.cell.x), Math.floor(mob.cell.y)), 5, 'it starts on Meadowlands');
  for (let n = 0; n < 8; n++) {
    mobs._walkStep(mob, mob.cell.x, mob.cell.y - 0.34, 34, null);
    mobs._sync(mob);
  }
  eq(faceAt(Math.floor(mob.cell.x), Math.floor(mob.cell.y)), 2,
    'it walked out of face 5 and into face 2, which is one world with it');
}

// --- ...and is stopped by a divider -----------------------------------------
{
  // The real wall: the outermost ring of every sealed face, which is what
  // `Grid.isWall` describes and what the world builds. A body walking at it is
  // refused by the ordinary footprint test and by nothing else - there is no
  // face-bound rule left in the file.
  const { isWall } = await import('../world/Grid.js');
  const planet = fakePlanet({ wall: isWall });
  const mobs = mobsOn(planet);
  // Inside face 1 (Rime), two cells in from its south edge, walking south at
  // the cross.
  const o = faceOrigin(1);
  const startY = o.y + F - WALL_T - 2.5;
  const mob = fakeMob(o.x + 200.5, startY, 35, { heading: Math.PI / 2 });
  eq(faceAt(Math.floor(mob.cell.x), Math.floor(mob.cell.y)), 1, 'it starts inside Rime');
  for (let n = 0; n < 40; n++) {
    mobs._walkStep(mob, mob.cell.x, mob.cell.y + 0.34, 34, null);
    mobs._sync(mob);
  }
  eq(faceAt(Math.floor(mob.cell.x), Math.floor(mob.cell.y)), 1, 'and it is still inside Rime');
  ok(mob.cell.y < o.y + F - WALL_T, 'stopped short of the divider by collision alone');
}

// --- ...and the two axes are not interchangeable -----------------------------
{
  // The wall test above blocks a body on map y. This one blocks it on map x, so
  // that a footprint test which measured the wrong axis would be caught rather
  // than agreeing with itself: a body walking east into a north-south wall must
  // stop, and one walking north beside the same wall must not.
  const X0 = 700;
  const planet = fakePlanet({ wall: (x) => x === X0 });
  const mobs = mobsOn(planet);
  const east = fakeMob(X0 - 2.5, 300.5, 35, { heading: 0 });
  for (let n = 0; n < 30; n++) {
    mobs._walkStep(east, east.cell.x + 0.34, east.cell.y, 34, null);
    mobs._sync(east);
  }
  // Its front, not its origin: `halfL` of the body has to stay out of the wall
  // column, and it is the front that a footprint test measuring the wrong axis
  // would put inside it.
  ok(east.cell.x + east.halfL < X0,
    `a body walking east keeps its nose out of the wall (x = ${east.cell.x.toFixed(2)})`);
  const north = fakeMob(X0 - 2.5, 300.5, 35, { heading: -Math.PI / 2 });
  for (let n = 0; n < 30; n++) {
    mobs._walkStep(north, north.cell.x, north.cell.y - 0.34, 34, null);
    mobs._sync(north);
  }
  ok(north.cell.y < 292, 'and one walking along it is not stopped at all');
}

// --- ...and a divider is a portal, which is NOT solid, and still stops it -----
{
  // The real block, not a stand-in for one. A divider column is `portal` from
  // layer 0 to layer D, and `portal` is deliberately not solid so a player can
  // walk into it. Everything in `_footprintCost` that refuses an obstacle reads
  // solidity, so without the named test at the top of `_colCost` a mob walks
  // through a divider as if it were open air - and a sealed face's population
  // stops being its own.
  //
  // Asserted by driving the same walk twice over two planets that differ in
  // nothing but the block the divider is made of, so a footprint test that had
  // quietly gone back to reading solidity would show up as the two disagreeing.
  // A FLIER, and that is the case worth testing rather than a chicken. A walker
  // is already refused by accident: a divider column has no solid block in it at
  // any layer, so `_groundK` reports no ground and the cost is 1 before the
  // divider is ever named. A flier skips every one of those rules - it is judged
  // on "is there rock where my body is", and a portal is not rock - so it is the
  // one body that flies straight through a divider if nothing says otherwise.
  // Mutation-checked: deleting the portal test in `_colCost` fails this.
  const flyAt = (planet) => {
    const mobs = mobsOn(planet);
    const o = faceOrigin(1);
    const mob = fakeMob(o.x + 200.5, o.y + F - WALL_T - 2.5, 44, {
      heading: Math.PI / 2, grounded: false,
      spec: { aquatic: false, flies: true, amphibious: false, climbs: false, height: 1, hover: 8 },
    });
    for (let n = 0; n < 40; n++) {
      mobs._walkStep(mob, mob.cell.x, mob.cell.y + 0.34, 43, null);
      mobs._sync(mob);
    }
    return mob;
  };
  const { isWall } = await import('../world/Grid.js');
  // Ground everywhere, and the divider columns holding portal at every layer,
  // which is what `WorldGen.fillWall` builds.
  const portalPlanet = {
    ...fakePlanet(),
    at(col, k) {
      if (k < 0 || k >= D) return 0;
      const y = col % W;
      if (isWall((col - y) / W, y)) return ID.portal;
      return k <= 34 ? ID.stone : 0;
    },
  };
  portalPlanet.solidAt = (col, k) => portalPlanet.at(col, k) !== 0;
  portalPlanet.surfaceK = (col) => {
    for (let k = D - 1; k >= 0; k--) if (portalPlanet.at(col, k)) return k;
    return -1;
  };
  const { IS_SOLID } = await import('../world/Blocks.js');
  ok(!IS_SOLID[ID.portal], 'the portal really is not solid, so this test can fail');
  const mob = flyAt(portalPlanet);
  eq(faceAt(Math.floor(mob.cell.x), Math.floor(mob.cell.y)), 1, 'a flier does not cross a portal');
  const o1 = faceOrigin(1);
  ok(mob.cell.y < o1.y + F - WALL_T, 'and stops short of the divider, as a walker does at a solid one');
}

// --- distances, rings and headings all take the short way --------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const a = colIndex(2, 500), b = colIndex(W - 2, 500);
  near(mobs._colDist(a, b), 4, 1e-9, 'the A* heuristic takes the short way round the wrap');
  near(mobs._colDist(a, a), 0, 1e-9, 'and is zero at home');
  // The despawn ring, which is the same question asked of two bodies.
  const p1 = { x: 1.5, y: 40, z: 10.5 }, p2 = { x: W - 1.5, y: 40, z: 10.5 };
  near(wrapDist(p1, p2), 3, 1e-9, 'a mob three cells away over the seam is three cells away');
  // A walk of a known length arrives at that length.
  for (const units of [20, 60, 120]) {
    const from = colIndex(3, 3);
    let worst = 0;
    for (let t = 0; t < 200; t++) {
      const got = mobs._walkTo(from, units);
      const gy = got % W, gx = (got - gy) / W;
      const d = Math.sqrt(((gx - 3 + W / 2) % W - W / 2) ** 2 + ((gy - 3 + W / 2) % W - W / 2) ** 2);
      worst = Math.max(worst, Math.abs(d - units));
    }
    ok(worst <= 1.5, `a walk of ${units} arrives within 1.5 of it, worst ${worst.toFixed(2)}`);
  }
}

// --- face-keyed behaviour points at the nine faces --------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const mid = (face) => { const o = faceOrigin(face); return colIndex(o.x + F / 2, o.y + F / 2); };
  ok(mobs._isPolarColumn(mid(1)), 'Rime is polar ground');
  for (const f of [2, 3, 4, 5, 6, 7, 8, 9]) ok(!mobs._isPolarColumn(mid(f)), `face ${f} is not`);
  ok(mobs._monsterCap(mid(5)) < mobs._monsterCap(mid(9)), 'a sealed face carries more monsters than the cross');
  eq(mobs._monsterFar(mid(9)) < mobs._monsterFar(mid(5)), true, 'and Pyre spawns them closer in');
  mobs.hostileShut = new Set([9]);
  ok(!mobs._hostileHere(mid(9)), 'a shut face makes nothing hostile');
  ok(mobs._hostileHere(mid(5)), 'and its neighbours are unaffected');
}

// --- water runs the way the map does ----------------------------------------
{
  // `colNeighbor`'s direction order changed with the move - it is Grid's north,
  // south, west, east now, where the cube's was +i, -i, +j, -j - so a flow table
  // left as it was would push every river ninety degrees off its channel. The
  // test is a single-cell drop on one axis at a time.
  const { Water, LEVEL_MAX } = await import('./Water.js');
  const planet = fakePlanet();
  // A flooded shelf: water in the layer above the ground, nothing below it to
  // fall into, so the answer is entirely the sideways gradient.
  const wet = new Set();
  const water = new Water({
    at: (col, k) => (wet.has(col * D + k) ? ID.water : planet.at(col, k)),
    solidAt: (col, k) => planet.solidAt(col, k),
    liquidAt: (col, k) => wet.has(col * D + k),
    facingAt: () => 0,
  }, () => {});
  const K = 35;
  const here = colIndex(600, 600);
  const put = (col, lvl) => { wet.add(col * D + K); water.level.set(water.key(col, K), lvl); };
  put(here, 4);
  // Only the east neighbour is lower, so the flow is east: +x, which is `i`.
  put(colIndex(601, 600), 1);
  put(colIndex(599, 600), 4);
  put(colIndex(600, 601), 4);
  put(colIndex(600, 599), 4);
  {
    const fl = water.flowAt(here, K);
    ok(!!fl, 'a cell with a downhill neighbour is flowing');
    near(fl.i, 1, 1e-9, 'downhill on +x reads as +i');
    near(fl.j, 0, 1e-9, 'and nothing on j');
  }
  // ...and the same drop on the other axis reads as j, not as i.
  put(colIndex(601, 600), 4);
  put(colIndex(600, 601), 1);
  {
    const fl = water.flowAt(here, K);
    near(fl.j, 1, 1e-9, 'downhill on +y reads as +j');
    near(fl.i, 0, 1e-9, 'and nothing on i');
    ok(fl.s > 0 && fl.s <= 1, 'strength is off the depth, in 0..1');
  }
  eq(LEVEL_MAX, 7, 'a full source is still seven');
}

// --- the bosses -------------------------------------------------------------
{
  eq(BOSS_ROSTER.length, 16, 'there are sixteen bosses');
  const byFace = new Map();
  for (const b of BOSS_ROSTER) byFace.set(b.face, (byFace.get(b.face) || 0) + 1);
  eq(byFace.size, 4, 'over four faces');
  for (const role of [FACE_RIME, FACE_TEMPEST, FACE_VERDANT, FACE_PYRE]) {
    eq(byFace.get(role), 4, `four on role ${role}`);
  }
  // ...and every one of those roles is a sealed face.
  for (const role of byFace.keys()) {
    const f = FACE_ROLE.indexOf(role);
    ok(SEALED.includes(f), `role ${role} is face ${f}, which is sealed`);
  }
  // The Deepmaw is the one in the water and must not be on the ice.
  const deep = BOSS_ROSTER.find((b) => b.aquatic);
  ok(!!deep, 'one boss is aquatic');
  ok(deep.face !== FACE_RIME && deep.face !== FACE_PYRE, 'and it is not on Rime or Pyre');

  // Placement: on the right face, off the wall, and spread.
  const planet = fakePlanet();
  planet.colHeight = new Float32Array(W * W).fill(K_SEA + 6);
  // A sea for the Deepmaw, over half of Tempest and no more: the face it lives
  // on has to carry three walkers as well, which is a real requirement of the
  // generator and not only of this fake.
  {
    const o = faceOrigin(FACE_ROLE.indexOf(FACE_TEMPEST));
    for (let x = o.x; x < o.x + F; x++) {
      for (let y = o.y; y < o.y + (F >> 1); y++) planet.colHeight[colIndex(x, y)] = K_SEA - 12;
    }
  }
  const mobs = mobsOn(planet);
  const end = new Endgame(planet, mobs);
  ok(end.begin(), 'the endgame places the sixteen');
  eq(end.shut.size, 4, 'and shuts four faces');
  for (const f of end.shut) ok(SEALED.includes(f), `shut face ${f} is a sealed one`);

  // Placement is random, so it is asked twenty times and judged on the worst
  // answer: a rule that holds by luck on one draw is not a rule.
  let placed = 0, runs = 0, offFace = 0, tooNearWall = 0, tooClose = 0;
  let worstMargin = Infinity, worstGap = Infinity;
  for (let t = 0; t < 20; t++) {
    end.reset();
    end.begin();
    runs++;
    const byFace = new Map();
    for (const r of end.roster) {
      if (r.col < 0) continue;
      placed++;
      const y = r.col % W, x = (r.col - y) / W;
      const want = FACE_ROLE.indexOf(r.face);
      if (faceAt(x, y) !== want) offFace++;
      const o = faceOrigin(want);
      const margin = Math.min(x - o.x, F - 1 - (x - o.x), y - o.y, F - 1 - (y - o.y));
      worstMargin = Math.min(worstMargin, margin);
      if (margin < WALL_T) tooNearWall++;
      const list = byFace.get(want) || [];
      for (const [ox, oy] of list) {
        const gap = Math.hypot(ox - x, oy - y);
        worstGap = Math.min(worstGap, gap);
        if (gap < 60) tooClose++;
      }
      list.push([x, y]);
      byFace.set(want, list);
    }
  }
  eq(placed, 16 * runs, 'every boss has an address on every draw');
  eq(offFace, 0, 'and every one of them is on its own face');
  eq(tooNearWall, 0, `none of them is inside a divider (worst margin ${worstMargin})`);
  ok(worstMargin >= 12, `and none is against one either (worst margin ${worstMargin})`);
  eq(tooClose, 0, `no two on a face are inside BOSS_SPREAD (worst gap ${worstGap.toFixed(1)})`);

  // The ring a boss materialises inside is measured on a map that wraps: a
  // player three cells away over the seam is three cells away, and a raw
  // difference would leave that boss permanently just out of reach.
  {
    const rec = { col: colIndex(2, 500) };
    planet.colHeight[rec.col] = 40;
    const p1 = { position: { x: W - 1.5, y: 40, z: 500.5 } };
    near(end._distance(rec, p1), 4, 1e-9, 'a boss over the wrap is four cells away');
    const p2 = { position: { x: 2.5, y: 40, z: 500.5 } };
    near(end._distance(rec, p2), 0, 1e-9, 'and none at all when you are on it');
  }
}

// --- fishing: the storm face's odds -----------------------------------------
//
// Pure arithmetic over the shipped ladder, so the numbers the design was argued
// with are the numbers the game deals. The band cuts are `fishFood`'s own rungs
// (r < 0.25, r < 0.58, the rest), which is what "common, uncommon, rare" means
// everywhere else in Items.js.
{
  const share = (table, lo, hi) => table
    .filter((f) => f.rarity >= lo && f.rarity < hi)
    .reduce((a, f) => a + f.p, 0);
  // `upTo` is cumulative; the per-species share is the step it takes.
  const spread = (t) => t.map((f, i) => ({ ...f, p: f.upTo - (i ? t[i - 1].upTo : 0) }));
  const fresh = spread(fishTable(false, false));
  const salt = spread(fishTable(true, false));
  const deep = spread(fishTable(true, true));
  const storm = spread(fishTable(false, false, true));

  eq(fresh.length, 5, 'fresh water holds five species');
  eq(salt.length, 7, 'shallow salt holds seven');
  eq(deep.length, 10, 'deep salt holds ten');
  eq(storm.length, 15, 'and the storm holds all fifteen, whatever the water reads as');
  // The flag overrides the water rather than joining it: Tempest has one kind.
  eq(fishTable(true, true, true).length, 15, 'salt and deep make no difference on Tempest');

  for (const [name, t] of [['fresh', fresh], ['salt', salt], ['deep', deep], ['storm', storm]]) {
    near(t[t.length - 1].upTo, 1, 1e-12, `${name} table sums to one`);
    let sorted = true;
    for (let i = 1; i < t.length; i++) if (t[i].p > t[i - 1].p) sorted = false;
    ok(sorted, `${name} table is commonest first`);
  }

  const rare = (t) => share(t, 0.58, 2);
  near(rare(fresh), 0.048, 0.001, 'rare band in fresh water');
  near(rare(salt), 0.050, 0.001, 'rare band in shallow salt');
  near(rare(deep), 0.115, 0.001, 'rare band in deep salt');
  near(rare(storm), 0.238, 0.001, 'rare band on Tempest');
  ok(rare(storm) > rare(deep) * 2, 'the storm doubles the best rare band anywhere else');
  near(share(storm, 0, 0.25), 0.429, 0.001, 'common band on Tempest');
  near(share(storm, 0.25, 0.58), 0.332, 0.001, 'uncommon band on Tempest');

  const of = (t, n) => t.find((f) => f.name === n)?.p ?? 0;
  near(of(deep, 'goblinshark'), 0.0172, 0.0002, 'goblin shark off a deep cast');
  near(of(storm, 'goblinshark'), 0.0409, 0.0002, 'goblin shark on Tempest');
  ok(of(storm, 'goblinshark') > of(deep, 'goblinshark') * 2.3, 'and it is 2.4x likelier there');
  // No other water moved. The storm is a third argument, not a rebalance.
  near(of(deep, 'clownfish'), 0.274, 0.001, 'the deep table is untouched');
  near(of(fresh, 'tetra'), 0.305 / 0.78, 0.002, 'and so is the fresh one');
}

// --- the storm face: a sky that does not pass -------------------------------
{
  const w = new Weather();
  // Two in-game hours of the ordinary cycle, so the sky has certainly changed
  // its mind at least once before the face takes it over.
  for (let i = 0; i < 7200; i++) w.update(1, 2, 0, 0);
  const before = w.state;
  ok(!w.tempest, 'the ordinary world is not the storm face');

  for (let i = 0; i < 3600; i++) w.update(1, BIOME_STORM, 0, 0, true);
  eq(w.state, 'storm', 'an hour on Tempest is an hour of storm');
  ok(w.precip > 0.99, 'and the rain is fully in');
  ok(!w.cold, 'and it is rain, not snow');
  // Deep winter is a whole-planet clause and a sealed face does not have a
  // season: the permanent storm must not become a permanent blizzard.
  for (let i = 0; i < 600; i++) w.update(1, BIOME_STORM, 0, 1, true);
  eq(w.state, 'storm', 'midwinter does not end it');
  eq(w.cold, false, 'and does not freeze it');
  eq(w.type, 'rain', 'and it still falls as rain');

  // Stepping back out gives back the sky that was interrupted.
  w.update(1, 2, 0, 0);
  eq(w.state, before, 'leaving hands back the weather you left');

  // The roll is the storm face's alone: an ordinary storm keeps the flash and
  // the thunder it always had and nothing lands out of it.
  let off = 0;
  w.state = 'storm';
  for (let i = 0; i < 2000; i++) if (w.wantsStrike(1)) off++;
  eq(off, 0, 'no bolt lands off Tempest, storm or not');
  let on = 0;
  for (let i = 0; i < 20000; i++) { w.update(1, BIOME_STORM, 0, 0, true); if (w.wantsStrike(1)) on++; }
  near(on / 20000, 0.30, 0.03, 'and one every 3.3 seconds on it');
}

// --- the strike ladder ------------------------------------------------------
{
  eq(strikeDamage(0), 7, 'a direct hit is a third of the bar');
  eq(strikeDamage(1.5), 7, 'and the band is inclusive');
  eq(strikeDamage(1.51), 4, 'just outside it is four');
  eq(strikeDamage(4), 4, 'and four to the second band');
  eq(strikeDamage(4.01), 2, 'two beyond that');
  eq(strikeDamage(7), 2, 'out to seven cells');
  eq(strikeDamage(7.01), 0, 'and nothing past it');
  eq(strikeDamage(FAR_MIN), 0, 'so a distant bolt can never reach, at any range');

  // Monotonic, and every band is survivable on its own against a 20-point bar.
  let last = 99;
  for (let d = 0; d <= 10; d += 0.25) {
    ok(strikeDamage(d) <= last, `damage never rises with distance (at ${d})`);
    last = strikeDamage(d);
  }
  ok(HURT[0][1] < 20 / 2, 'no single bolt takes half the bar');

  // The expected cost of one aimed strike, integrated over the disc it is
  // sited in rather than guessed. This is the number the whole balance section
  // in Lightning.js is argued from, so it is asserted rather than described.
  let sum = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) sum += strikeDamage(AIM_R * Math.sqrt((i + 0.5) / N));
  near(sum / N, 3.08, 0.02, 'an aimed strike costs 3.1 in expectation');
  // Against 1 point regenerated every 4.5s, and one aimed strike every 8.3s in
  // the open: a net drain, but a slow one.
  const perMin = (sum / N) * (60 / 8.3);
  ok(perMin > 60 / 4.5, 'standing in the open outpaces the regeneration');
  ok(perMin < 40, 'and does not kill a full bar inside a minute');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
