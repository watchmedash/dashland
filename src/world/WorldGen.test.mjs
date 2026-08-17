// Asserts the nine-face GENERATOR directly. `node src/world/WorldGen.test.mjs`.
//
// `Grid.test.mjs` asserts the coordinate model; this asserts what is built on
// it, and it exists for the same reason: a generation bug found in stage 7
// costs more than stages 1 to 6 combined, and the game cannot boot until the
// other stages land, so a file like this is the only place the work can be
// checked at all.
//
// Four things, in the order they would break the world:
//
//   1. THE NOISE IS PERIODIC over W on both axes, in value and in slope. This
//      is the one genuinely new requirement of the flat map (NINE-FACES.md
//      section 4) and it is checked first because everything else is built on
//      it: get it wrong and the map's outer edge is a cliff.
//   2. THE DIVIDERS are exactly where `Grid.isWall` says and nowhere else, for
//      the full depth as well as the full height.
//   3. THE FOUR SEALED FACES produce the ground they are supposed to.
//   4. THE CROSS HAS NO DISCONTINUITY AT A JOIN, measured rather than asserted:
//      the distribution of neighbour height steps across a tile boundary is
//      compared against the same distribution mid-tile.

import { WorldGen } from './WorldGen.js';
import { Periodic, surfScale, periodFor, GAIN, UNIT } from './Periodic.js';
import { Noise } from '../util/Noise.js';
import {
  W, D, F, G, faceOrigin, faceAt, isWall, SEALED, CROSS, wrap, portalAxis,
} from './Grid.js';
import {
  CELLS, BIOME, FACE_ROLE, GEN_VERSION, SEA_K, K_TERRAIN_MAX,
  regionOfCol, regionColumns,
} from './Constants.js';
import { BLOCKS, ID } from './Blocks.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);
const near = (a, b, tol, what) =>
  ok(Math.abs(a - b) <= tol, `${what}: got ${a}, want ${b} +- ${tol}`);

const SEED = 4242;
/** A fixed stream, so the sample points are the same on every run. */
let _rs = 0x2f6e2b1;
const rnd = () => {
  _rs ^= _rs << 13; _rs |= 0; _rs ^= _rs >>> 17; _rs ^= _rs << 5; _rs |= 0;
  return (_rs >>> 0) / 4294967296;
};

// ===========================================================================
// 1. THE NOISE MEETS ITSELF AT THE WRAP
// ===========================================================================
//
// A value match with a slope mismatch still reads as a crease, so both are
// checked. Both come out EXACT rather than close, and that is the property the
// lattice was chosen for: the cell at x and the cell at x + P are the same
// cell, so there is nothing at the wrap to be approximately equal.

{
  const p = new Periodic(11);
  const SCALES = [0.9, 1.25, 1.9, 3.1, 3.2, 4.3, 5.5, 8, 9, 14, 16, 34, 46, 110, 130];
  let worstV = 0, worstD = 0, worstR = 0, worstVol = 0;
  const EPS = 1e-3;
  for (let n = 0; n < 400; n++) {
    const t = rnd() * W, sc = surfScale(SCALES[n % SCALES.length]);
    // value, both axes
    worstV = Math.max(worstV,
      Math.abs(p.fbm(0, t, 0, sc, 4) - p.fbm(W, t, 0, sc, 4)),
      Math.abs(p.fbm(t, 0, 0, sc, 4) - p.fbm(t, W, 0, sc, 4)),
      Math.abs(p.one(0, t, 3.3, sc) - p.one(W, t, 3.3, sc)),
      Math.abs(p.one(t, 0, 3.3, sc) - p.one(t, W, 3.3, sc)));
    // ridged, which has its own octave loop and could have its own bug
    worstR = Math.max(worstR,
      Math.abs(p.ridged(0, t, 0, sc, 4) - p.ridged(W, t, 0, sc, 4)),
      Math.abs(p.ridged(t, 0, 0, sc, 4) - p.ridged(t, W, 0, sc, 4)));
    // slope, both axes, by central difference either side of the join
    const dx0 = p.fbm(EPS, t, 0, sc, 4) - p.fbm(-EPS, t, 0, sc, 4);
    const dx1 = p.fbm(W + EPS, t, 0, sc, 4) - p.fbm(W - EPS, t, 0, sc, 4);
    const dy0 = p.fbm(t, EPS, 0, sc, 4) - p.fbm(t, -EPS, 0, sc, 4);
    const dy1 = p.fbm(t, W + EPS, 0, sc, 4) - p.fbm(t, W - EPS, 0, sc, 4);
    worstD = Math.max(worstD, Math.abs(dx0 - dx1), Math.abs(dy0 - dy1));
    // and the volumetric fields, which wrap on x and y and not on k
    const k = (rnd() * D) | 0;
    worstVol = Math.max(worstVol,
      Math.abs(p.volOne(0, t, k, 0.13, 3.7) - p.volOne(W, t, k, 0.13, 3.7)),
      Math.abs(p.volFbm(t, 0, k, 0.045, 2) - p.volFbm(t, W, k, 0.045, 2)));
  }
  eq(worstV, 0, 'fbm and one are exactly periodic on both axes');
  eq(worstR, 0, 'ridged is exactly periodic on both axes');
  eq(worstVol, 0, 'the volumetric fields are exactly periodic on x and y');
  ok(worstD < 1e-12, `slope matches at the wrap (worst ${worstD})`);

  // ...and the periods really are whole numbers of lattice cells, which is the
  // mechanism the exactness comes from rather than a coincidence of it.
  for (const sc of SCALES) {
    const Pn = periodFor(surfScale(sc));
    eq(Pn, Math.round(Pn), `period for scale ${sc} is a whole number`);
    ok(Pn >= 1, `period for scale ${sc} is at least one cell`);
  }
  // The lattice must not be so coarse that the whole map is one cell.
  ok(periodFor(surfScale(1.25)) >= 4, 'the coarsest field still has cells in it');

  // A field that is NOT periodic would fail the above, so prove the test can
  // fail: plain simplex on the same coordinates does not close.
  const sx = new Noise(11);
  let simplexGap = 0;
  for (let n = 0; n < 50; n++) {
    const t = rnd() * W;
    simplexGap = Math.max(simplexGap,
      Math.abs(sx.simplex3(0, t * UNIT, 0) - sx.simplex3(W * UNIT, t * UNIT, 0)));
  }
  ok(simplexGap > 0.05, `a non-periodic field visibly fails the same test (${simplexGap.toFixed(3)})`);
}

// --- the lattice has the spread the thresholds were tuned against ------------
//
// Every threshold in WorldGen — an ore vein at 0.55, the stratum pockets at
// 0.52, Pyre's sunstone at 0.84 — was set against `Noise.simplex3`'s
// distribution. A noise with a narrower spread empties the tails and the ore
// silently stops generating, which is a bug no periodicity test would catch.
{
  const p = new Periodic(7), n = new Noise(7);
  const N = 120000;
  const over = (arr, t) => arr.filter((v) => v > t).length / N;
  const A = [], B = [];
  for (let i = 0; i < N; i++) {
    const a = rnd() * 400, b = rnd() * 400, c = rnd() * 400;
    A.push(p.grad3(a, b, c, 997, 997, 997));
    B.push(n.simplex3(a, b, c));
  }
  for (const t of [0.30, 0.52, 0.55, 0.62, 0.84]) {
    const la = over(A, t), si = over(B, t);
    ok(Math.abs(la - si) < 0.02,
      `the lattice puts the same share of the world over ${t} (${(la * 100).toFixed(1)}% vs ${(si * 100).toFixed(1)}%)`);
  }
  ok(GAIN > 1.2 && GAIN < 2, 'the calibration gain is in the range the measurement gives');
}

// ===========================================================================
// The world itself. One build, shared by everything below.
// ===========================================================================
const gen = new WorldGen(SEED);
const t0 = Date.now();
const out = gen.generateGlobal(() => {});
const buildMs = Date.now() - t0;
const { colHeight, colBiome } = out;
const H = (x, y) => colHeight[wrap(x) * W + wrap(y)];

eq(GEN_VERSION, 10, 'the save stamp moved for this conversion');
eq(colHeight.length, W * W, 'one height per column of one map');

// ===========================================================================
// 2. THE DIVIDERS
// ===========================================================================
//
// `Grid.isWall` is the authority and this asserts the generator agrees with it
// in both directions: every wall column is walled to the full depth AND the
// full height, and no column of the connected cross is ever wall.

{
  const blocks = new Uint8Array(CELLS);
  let wallCols = 0, crossCols = 0, notWall = 0, crossWall = 0;
  // Two counters, not one. These shared a variable, so the cross check below
  // inherited the wall check's count and could never have failed on its own.
  let wallBad = 0, crossBad = 0, notFull = 0;

  // Every wall column of every sealed face, on a stride that still visits all
  // four sides of all four rings.
  for (const f of SEALED) {
    const o = faceOrigin(f);
    for (let i = 0; i < F; i += 7) {
      for (const [x, y] of [
        [o.x + i, o.y], [o.x + i, o.y + F - 1],
        [o.x, o.y + i], [o.x + F - 1, o.y + i],
      ]) {
        if (!isWall(x, y)) { notWall++; continue; }
        wallCols++;
        const col = wrap(x) * W + wrap(y);
        gen.terrainColumn(blocks, col);
        // Portal from layer 0 to layer D and NOTHING else in it. This is the
        // assertion the two gate cuts before it both failed on, in both cases
        // because the height a divider was built to was taken from `colHeight`
        // and the ground a player stands on is whatever the surface pass laid
        // on top of that. There is no height to get wrong now, and this is what
        // says so: not "tall enough", but "all of it".
        let depth = 0;
        while (depth < D && blocks[col * D + depth] === ID.portal) depth++;
        if (depth !== D) notFull++;
        for (let k = 0; k < D; k++) if (blocks[col * D + k] !== ID.portal) wallBad++;
      }
    }
  }
  ok(wallCols > 200, `the sample really visited the dividers (${wallCols} columns)`);
  eq(notWall, 0, 'every column of a sealed face perimeter is a divider column');
  eq(notFull, 0, 'every divider column is portal from layer 0 to layer D');
  eq(wallBad, 0, 'and holds nothing else at any layer - no rock, no air, no water');

  // The other direction: nothing inside the cross is ever a divider, and
  // nothing inside the cross ever generates a portal block.
  for (const f of CROSS) {
    const o = faceOrigin(f);
    for (let i = 0; i < F; i += 23) {
      for (let j = 0; j < F; j += 23) {
        const x = o.x + i, y = o.y + j;
        crossCols++;
        if (isWall(x, y)) { crossWall++; continue; }
        const col = x * W + y;
        gen.terrainColumn(blocks, col);
        for (let k = 0; k < D; k++) if (blocks[col * D + k] === ID.portal) crossBad++;
      }
    }
  }
  ok(crossCols > 1500, `the cross sample is real (${crossCols} columns)`);
  eq(crossWall, 0, 'no column of the connected world is a divider');
  eq(crossBad, 0, 'and no column of the connected world contains a portal block');

  // The divider is unbreakable and cannot be obtained, which is what makes it
  // unplaceable: a block that never enters an inventory cannot come out of one.
  const eb = BLOCKS[ID.portal];
  ok(eb.hardness < 0, 'the portal is unbreakable');
  eq(eb.drop, null, 'the portal drops nothing, so it can never be placed');
  // The pair the whole feature rests on, asserted rather than assumed: a body
  // can enter it, and you cannot see the far face through it.
  ok(!eb.solid, 'the portal is not solid, so a body can enter it');
  ok(eb.opaque, 'and it is opaque, so the sealed face stays unseen');
  ok(eb.light > 0, 'and it lights itself');

  // Which way through, from `Grid.portalAxis`. A sealed-to-cross edge is
  // passable on exactly one axis; a corner and a sealed-to-sealed run are not
  // passable at all.
  {
    const o1 = faceOrigin(1);
    const east = portalAxis(o1.x + F - 1, o1.y + 200);   // face 1 against face 2
    ok(east && east.axis === 0, 'the divider between Rime and Aurora is crossed on x');
    const north = portalAxis(o1.x + 200, o1.y);          // face 1 against face 7
    eq(north, null, 'and the one between Rime and Verdant is not crossed at all');
    eq(portalAxis(o1.x, o1.y), null, 'nor is a corner of the ring');
    eq(portalAxis(o1.x + 200, o1.y + 200), null, 'and open ground is not a divider');
  }

  // The height field agrees, so every pass that tests altitude or ground
  // refuses a wall column without having to know walls exist.
  const o1 = faceOrigin(1);
  eq(H(o1.x, o1.y + 200), K_TERRAIN_MAX, 'a wall column stands at the ceiling');
  ok(!gen.submerged[wrap(o1.x) * W + wrap(o1.y + 200)], 'and holds no water');
}

// ===========================================================================
// 3. THE FOUR SEALED FACES
// ===========================================================================
//
// Each corner is one biome end to end, and each lays the ground it is supposed
// to. The surface is read out of real voxels rather than off the tables,
// because what a player stands on is what `fillColumn` wrote.

{
  const blocks = new Uint8Array(CELLS);
  const surfaceOf = (x, y) => {
    const col = wrap(x) * W + wrap(y);
    gen.terrainColumn(blocks, col);
    for (let k = D - 1; k >= 0; k--) {
      const b = blocks[col * D + k];
      if (b !== ID.air && b !== ID.water && b !== ID.lava && b !== ID.ice) return b;
    }
    return ID.air;
  };
  /** A wide sample well inside one face, avoiding the wall ring. */
  const sample = (f, fn) => {
    const o = faceOrigin(f);
    const t = new Map();
    for (let i = 12; i < F - 12; i += 29) {
      for (let j = 12; j < F - 12; j += 29) {
        const v = fn(o.x + i, o.y + j);
        t.set(v, (t.get(v) || 0) + 1);
      }
    }
    return t;
  };
  const share = (t, ids) => {
    let n = 0, tot = 0;
    for (const [k, v] of t) { tot += v; if (ids.includes(k)) n += v; }
    return n / tot;
  };

  // --- the biome map: one biome per corner, no exceptions --------------------
  // Rime keeps a sea, and it is the cube cap's own sea: `biomeAt` settles ocean
  // by altitude before it looks at the face, so a frozen coast is OCEAN with ice
  // laid over it. That is ported rather than inherited by accident, and the ice
  // is asserted separately below.
  const wantBiome = {
    1: [BIOME.SNOW, BIOME.TUNDRA, BIOME.BEACH, BIOME.MOUNTAIN, BIOME.OCEAN],
    3: [BIOME.STORM], 7: [BIOME.JUNGLE], 9: [BIOME.CINDER],
  };
  for (const f of SEALED) {
    const t = sample(f, (x, y) => colBiome[wrap(x) * W + wrap(y)]);
    ok(share(t, wantBiome[f]) === 1,
      `face ${f} is only its own biome (${[...t.keys()].join(',')})`);
  }
  // Tempest and Verdant are exactly one biome each, which the cube had no
  // equivalent of and which is what "a sealed room is a place, not a climate
  // map" means.
  eq(sample(3, (x, y) => colBiome[wrap(x) * W + wrap(y)]).size, 1, 'Tempest is one biome');
  eq(sample(7, (x, y) => colBiome[wrap(x) * W + wrap(y)]).size, 1, 'Verdant is one biome');

  // --- and the ground each one lays -----------------------------------------
  // Rime: snow and packed ice, with the cap's bare tundra soil under the drift.
  const r1 = sample(1, surfaceOf);
  ok(share(r1, [ID.snow, ID.packed_ice, ID.ice]) > 0.55,
    `Rime is a snowfield (${(share(r1, [ID.snow, ID.packed_ice, ID.ice]) * 100) | 0}%)`);
  ok(share(r1, [ID.grass, ID.podzol]) === 0, 'and nothing on Rime is turf');

  // Tempest: scoured rock, gravel and standing mud. No turf, no sand.
  const r3 = sample(3, surfaceOf);
  ok(share(r3, [ID.gravel, ID.andesite, ID.stone, ID.mud, ID.peat]) > 0.9,
    `Tempest is scoured ground (${(share(r3, [ID.gravel, ID.andesite, ID.stone, ID.mud, ID.peat]) * 100) | 0}%)`);
  ok(share(r3, [ID.grass, ID.sand, ID.snow]) === 0, 'and nothing on Tempest is turf, sand or snow');

  // Verdant: jungle floor. Never bare, never sand, and never under the sea.
  const r7 = sample(7, surfaceOf);
  ok(share(r7, [ID.grass, ID.moss_block, ID.coarse_dirt]) > 0.9,
    `Verdant is jungle floor (${(share(r7, [ID.grass, ID.moss_block, ID.coarse_dirt]) * 100) | 0}%)`);
  ok(share(r7, [ID.sand, ID.snow, ID.basalt]) === 0, 'and nothing on Verdant is sand, snow or basalt');

  // Pyre: basalt, ash and magma stone, with the sunstone outcrops that are the
  // only reason the face is walkable, and the surface ore that is the only
  // reason to go. Both landed recently on the cube and both are carried over.
  const r9 = sample(9, surfaceOf);
  ok(share(r9, [ID.basalt, ID.ash_stone, ID.magma_stone]) > 0.7,
    `Pyre is volcanic rock (${(share(r9, [ID.basalt, ID.ash_stone, ID.magma_stone]) * 100) | 0}%)`);
  ok(share(r9, [ID.grass, ID.snow, ID.sand]) === 0, 'and nothing on Pyre is turf, snow or sand');
  ok(share(r9, [ID.glowstone]) > 0, 'Pyre keeps its sunstone outcrops');
  ok(share(r9, [ID.iron_ore, ID.sulfur_ore, ID.silver_ore, ID.gold_ore, ID.crystal_ore]) > 0,
    'and the cinderlands surface ore that is the reason to go there');

  // Lava, not water, in Pyre's basins; and ice over Rime's.
  // Above the ground only. Below it every face on the map has aquifer water in
  // the limestone band, which is the crust doing its job and says nothing about
  // what is standing in the basins.
  const lavaAt = (f) => {
    const o = faceOrigin(f);
    let lava = 0, water = 0, ice = 0;
    for (let i = 12; i < F - 12; i += 13) {
      for (let j = 12; j < F - 12; j += 13) {
        const col = wrap(o.x + i) * W + wrap(o.y + j);
        if (!gen.submerged[col]) continue;
        gen.terrainColumn(blocks, col);
        for (let k = gen.groundKOf(col) + 1; k < D; k++) {
          const b = blocks[col * D + k];
          if (b === ID.lava) lava++; else if (b === ID.water) water++; else if (b === ID.ice) ice++;
        }
      }
    }
    return { lava, water, ice };
  };
  const p9 = lavaAt(9);
  ok(p9.lava > 0 && p9.water === 0, `Pyre's basins hold lava and no water (${JSON.stringify(p9)})`);
  const p1 = lavaAt(1);
  ok(p1.ice > 0, `Rime's sea is capped with ice (${JSON.stringify(p1)})`);

  /**
   * How much of each face is under water, which is what `_faceShape` is for.
   *
   * Verdant is a jungle and a jungle is land: it is lifted 2.5 layers clear of
   * the waterline so what is left is pools rather than a lagoon. Tempest is the
   * opposite claim — its low ground is deliberately NOT lifted, so the standing
   * water is part of the face. Both are asserted, because a face that came out
   * half sea would be the single most visible way this could be wrong and
   * nothing else here would notice.
   */
  const wetShare = (f) => {
    const o = faceOrigin(f);
    let n = 0, tot = 0;
    for (let i = 12; i < F - 12; i += 7) {
      for (let j = 12; j < F - 12; j += 7) {
        tot++;
        if (gen.submerged[wrap(o.x + i) * W + wrap(o.y + j)]) n++;
      }
    }
    return n / tot;
  };
  const w7 = wetShare(7), w3 = wetShare(3);
  console.log(`  under water: Verdant ${(w7 * 100).toFixed(1)}%  Tempest ${(w3 * 100).toFixed(1)}%`);
  ok(w7 < 0.06, `Verdant is land, not a lagoon (${(w7 * 100).toFixed(1)}% wet)`);
  ok(w3 > 0.10, `Tempest keeps its standing water (${(w3 * 100).toFixed(1)}% wet)`);

  // Verdant grows a canopy, which is the thing that makes it a jungle rather
  // than a green field. Counted over one whole face-interior sample.
  // One real region, with the DECOR_MARGIN dilation `decorateRegion` is
  // specified against — it clips every write to the region it was handed, so a
  // patch that is not exactly a region counts almost nothing.
  const o7 = faceOrigin(7);
  const inner = [...regionColumns(regionOfCol((o7.x + 200) * W + (o7.y + 200)))];
  const marg = [];
  {
    const seen = new Map();
    const q = [...inner];
    for (const c of inner) seen.set(c, 0);
    for (let i = 0; i < q.length; i++) {
      const c = q[i], d = seen.get(c);
      if (d >= 6) continue;
      const yy = c % W, xx = (c - yy) / W;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nn = wrap(xx + dx) * W + wrap(yy + dy);
        if (!seen.has(nn)) { seen.set(nn, d + 1); q.push(nn); }
      }
    }
    for (const c of q) { gen.terrainColumn(blocks, c); marg.push(c); }
  }
  gen.decorateRegion(blocks, inner, marg);
  let leaves = 0, trunks = 0;
  for (const c of inner) {
    for (let k = 0; k < D; k++) {
      const b = blocks[c * D + k];
      if (b === ID.leaves_oak) leaves++; else if (b === ID.log_oak) trunks++;
    }
  }
  ok(trunks > 0, `Verdant grows trees (${trunks} trunk cells in a region)`);
  ok(leaves / inner.length > 3.0,
    `and is under canopy (${(leaves / inner.length).toFixed(1)} leaf cells per column)`);
}

// ===========================================================================
// 4. THE CROSS IS ONE WORLD
// ===========================================================================
//
// The claim is that the generator does NOTHING at a join, so this measures
// rather than asserts it: the distribution of neighbour height steps taken
// across a tile boundary is compared against the same distribution taken
// mid-tile. If any border machinery survived — a fade, a lift, a flat shelf, a
// slope limiter — the two would part company immediately, because every one of
// those was a change to exactly these numbers.

{
  const stats = (steps) => {
    steps.sort((a, b) => a - b);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    return { mean, p50: steps[steps.length >> 1], p95: steps[(steps.length * 0.95) | 0], max: steps[steps.length - 1], n: steps.length };
  };
  /** |h(x,y) - h(x+1,y)| for every y in the band, at one x. */
  const stepsAtX = (x, y0, y1) => {
    const s = [];
    for (let y = y0; y < y1; y++) s.push(Math.abs(H(x, y) - H(x + 1, y)));
    return s;
  };
  const stepsAtY = (y, x0, x1) => {
    const s = [];
    for (let x = x0; x < x1; x++) s.push(Math.abs(H(x, y) - H(x, y + 1)));
    return s;
  };

  // The four open joins of the cross, two of them through the wrap.
  const joinX = [];
  const joinY = [];
  // 4 | 5 and 5 | 6, inside the map
  joinX.push(...stepsAtX(F - 1, F, 2 * F));
  joinX.push(...stepsAtX(2 * F - 1, F, 2 * F));
  // 6 | 4, across the wrap: x = W-1 -> 0
  joinX.push(...stepsAtX(W - 1, F, 2 * F));
  // 2 | 5 and 5 | 8, inside the map
  joinY.push(...stepsAtY(F - 1, F, 2 * F));
  joinY.push(...stepsAtY(2 * F - 1, F, 2 * F));
  // 8 | 2, across the wrap: y = W-1 -> 0
  joinY.push(...stepsAtY(W - 1, F, 2 * F));

  // ...and the same count of samples taken well inside a tile.
  const midX = [], midY = [];
  for (const dx of [97, 199, 311]) midX.push(...stepsAtX(F + dx, F, 2 * F));
  for (const dy of [97, 199, 311]) midY.push(...stepsAtY(F + dy, F, 2 * F));

  const jx = stats(joinX), mx = stats(midX);
  const jy = stats(joinY), my = stats(midY);
  eq(jx.n, mx.n, 'the two x samples are the same size');
  eq(jy.n, my.n, 'the two y samples are the same size');

  console.log(`  join x  mean ${jx.mean.toFixed(3)} p95 ${jx.p95.toFixed(2)} max ${jx.max.toFixed(2)}`);
  console.log(`  mid  x  mean ${mx.mean.toFixed(3)} p95 ${mx.p95.toFixed(2)} max ${mx.max.toFixed(2)}`);
  console.log(`  join y  mean ${jy.mean.toFixed(3)} p95 ${jy.p95.toFixed(2)} max ${jy.max.toFixed(2)}`);
  console.log(`  mid  y  mean ${my.mean.toFixed(3)} p95 ${my.p95.toFixed(2)} max ${my.max.toFixed(2)}`);

  /**
   * The strong form, and the one that is actually evidence.
   *
   * Comparing a join against three arbitrary mid-tile lines is weak, because
   * two bands of terrain a few hundred columns apart differ from each other
   * anyway — a band that happens to cross a mountain range has a larger mean
   * step than one that crosses a plain, and no seam is involved. So the whole
   * DISTRIBUTION of per-line mean steps is built, over every line in the cross,
   * and the join lines are asked to fall inside it. A join that had any
   * machinery on it would be an outlier by construction: BORDER_FLAT drove the
   * mean to zero, BORDER_FADE and the lift drove it up, and either lands
   * outside the 5th-to-95th percentile of ordinary terrain immediately.
   */
  const lineMeans = [];
  for (let x = F; x < 2 * F - 1; x += 3) {
    const st = stepsAtX(x, F, 2 * F);
    lineMeans.push(st.reduce((a, b) => a + b, 0) / st.length);
  }
  lineMeans.sort((a, b) => a - b);
  const lo = lineMeans[(lineMeans.length * 0.05) | 0];
  const hi = lineMeans[(lineMeans.length * 0.95) | 0];
  console.log(`  ordinary lines: ${lineMeans.length} of them, 5th-95th mean step ${lo.toFixed(3)} to ${hi.toFixed(3)}`);
  for (const [x, name] of [[F - 1, '4 | 5'], [2 * F - 1, '5 | 6'], [W - 1, '6 | 4, through the wrap']]) {
    const st = stepsAtX(x, F, 2 * F);
    const m = st.reduce((a, b) => a + b, 0) / st.length;
    ok(m >= lo && m <= hi,
      `the join ${name} is an ordinary line of terrain (mean step ${m.toFixed(3)}, band ${lo.toFixed(3)}..${hi.toFixed(3)})`);
  }
  // The same on the other axis, including the join that IS the wrap.
  const lineMeansY = [];
  for (let y = F; y < 2 * F - 1; y += 3) {
    const st = stepsAtY(y, F, 2 * F);
    lineMeansY.push(st.reduce((a, b) => a + b, 0) / st.length);
  }
  lineMeansY.sort((a, b) => a - b);
  const loY = lineMeansY[(lineMeansY.length * 0.05) | 0];
  const hiY = lineMeansY[(lineMeansY.length * 0.95) | 0];
  for (const [y, name] of [[F - 1, '2 | 5'], [2 * F - 1, '5 | 8'], [W - 1, '8 | 2, through the wrap']]) {
    const st = stepsAtY(y, F, 2 * F);
    const m = st.reduce((a, b) => a + b, 0) / st.length;
    ok(m >= loY && m <= hiY,
      `the join ${name} is an ordinary line of terrain (mean step ${m.toFixed(3)}, band ${loY.toFixed(3)}..${hiY.toFixed(3)})`);
  }

  // The looser aggregate check as well, so a regression that moved every join
  // at once — which the percentile test would absorb — still shows.
  near(jx.mean, mx.mean, 0.35 + mx.mean * 0.5, 'x steps at a join match steps mid-tile (mean)');
  near(jy.mean, my.mean, 0.35 + my.mean * 0.5, 'y steps at a join match steps mid-tile (mean)');
  near(jx.p95, mx.p95, 0.8 + mx.p95 * 0.5, 'x steps at a join match steps mid-tile (p95)');
  near(jy.p95, my.p95, 0.8 + my.p95 * 0.5, 'y steps at a join match steps mid-tile (p95)');
  // Neither is degenerate: a join that is perfectly flat is a shelf, and a
  // shelf is exactly what was deleted.
  ok(jx.mean > 0.02 && jy.mean > 0.02, 'a join is not a flat shelf');
  // And the map really does meet itself: the wrap column pairs are ordinary.
  ok(stats(stepsAtX(W - 1, F, 2 * F)).max < 40, 'the wrap is not a cliff');
  ok(stats(stepsAtY(W - 1, F, 2 * F)).max < 40, 'the wrap is not a cliff on y either');
}

// --- the cross is one field in biome and climate too -------------------------
{
  // A biome that straddles a join, with nothing special done about it, is the
  // whole of "biomes and climate are continuous across the cross". Counted:
  // how often the two columns either side of a join disagree, against how often
  // two columns mid-tile disagree.
  const disagree = (x, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) {
      if (colBiome[wrap(x) * W + y] !== colBiome[wrap(x + 1) * W + y]) n++;
    }
    return n / (y1 - y0);
  };
  const j = (disagree(F - 1, F, 2 * F) + disagree(2 * F - 1, F, 2 * F) + disagree(W - 1, F, 2 * F)) / 3;
  const m = (disagree(F + 97, F, 2 * F) + disagree(F + 199, F, 2 * F) + disagree(F + 311, F, 2 * F)) / 3;
  console.log(`  biome disagreement: join ${(j * 100).toFixed(1)}%  mid-tile ${(m * 100).toFixed(1)}%`);
  near(j, m, 0.06 + m, 'a biome crosses a join as readily as it crosses anything');
}

// --- and the sealed faces are NOT continuous with anything -------------------
{
  // The mirror of the test above. Across a divider the two sides have nothing
  // to do with each other, which the wall makes true by construction rather
  // than by the generator agreeing to it.
  for (const f of SEALED) {
    const o = faceOrigin(f);
    ok(isWall(o.x + (F >> 1), o.y), `face ${f} is closed on the north`);
    ok(isWall(o.x + (F >> 1), o.y + F - 1), `face ${f} is closed on the south`);
    ok(isWall(o.x, o.y + (F >> 1)), `face ${f} is closed on the west`);
    ok(isWall(o.x + F - 1, o.y + (F >> 1)), `face ${f} is closed on the east`);
  }
}

// ===========================================================================
// The lattices, and the trap the wrap sets for them
// ===========================================================================
//
// Anything on a lattice — hot springs, lakes, fallen logs, reefs, stands — has
// to have a period that divides W, or the pattern breaks where the map meets
// itself and two candidates end up a step apart across the wrap. 1248 is
// 2^5 * 3 * 13, so 8 and 26 both divide it and 2 does as well, which is what
// the cactus parity needs.
{
  for (const [n, name] of [[8, 'springs, logs, reefs and stands'], [26, 'lakes'], [2, 'the cactus parity']]) {
    eq(W % n, 0, `the ${name} lattice (${n}) divides W`);
  }
  eq(W, 1248, 'and W is what everything above assumes');
  eq(W % F, 0, 'a tile is a whole number of columns');
  eq(G, 3, 'three tiles per axis');
}

// ===========================================================================
// The world is playable: spawn, sea, and the roof
// ===========================================================================
{
  const y = out.spawn % W, x = (out.spawn - y) / W;
  const f = faceAt(x, y);
  ok(!SEALED.includes(f), `you wake up in the connected world, not in a sealed room (face ${f})`);
  eq(FACE_ROLE[f], 0, 'and on an ordinary face');
  ok(!isWall(x, y), 'and not inside a divider');
  const h = colHeight[out.spawn];
  ok(h > SEA_K && h < K_TERRAIN_MAX, `on dry ground under the roof (${h.toFixed(1)})`);

  // The clamp must not be biting: a clamp that bites is a plateau where a peak
  // should be. Wall columns are deliberately at the ceiling, so they are out.
  let atRoof = 0, atFloor = 0, wet = 0, n = 0;
  for (let i = 0; i < colHeight.length; i += 11) {
    const yy = i % W, xx = (i - yy) / W;
    if (isWall(xx, yy)) continue;
    n++;
    if (colHeight[i] >= K_TERRAIN_MAX - 0.01) atRoof++;
    if (colHeight[i] <= 6.01) atFloor++;
    if (gen.submerged[i]) wet++;
  }
  ok(atRoof / n < 0.001, `the terrain ceiling is not a plateau (${((atRoof / n) * 100).toFixed(3)}%)`);
  eq(atFloor, 0, 'and nothing is pinned at the floor');
  ok(wet / n > 0.10 && wet / n < 0.50, `there is a sea and it is not the whole world (${((wet / n) * 100).toFixed(1)}%)`);
  ok(gen.lakeCounts.total > 20, `there are inland lakes (${gen.lakeCounts.total})`);
  ok(gen.volcanoCount > 0, `and volcanic fields (${gen.volcanoCount})`);
}

// ===========================================================================
// A region is the same region whichever order it was built in
// ===========================================================================
//
// The invariant the whole lazy scheme rests on, and the one the cube kept
// losing: a decoration pass that reads what is standing in a cell is really
// asking whether the region next door has been decorated yet, and the answer
// depends on which way the player walked in. Nine regions are built forwards
// and then backwards and the bytes are compared.
//
// It is checked here because the port touched almost every one of those passes
// — the lattices, the `patchCol` arithmetic, the neighbour walk — and a
// coordinate that came out subtly asymmetric would show up exactly like this.
{
  const dilate = (cols) => {
    const seen = new Map(); const q = [...cols];
    for (const c of cols) seen.set(c, 0);
    for (let i = 0; i < q.length; i++) {
      const c = q[i], d = seen.get(c);
      if (d >= 6) continue;
      const yy = c % W, xx = (c - yy) / W;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nn = wrap(xx + dx) * W + wrap(yy + dy);
        if (!seen.has(nn)) { seen.set(nn, d + 1); q.push(nn); }
      }
    }
    return q;
  };
  const build = (order) => {
    const b = new Uint8Array(CELLS);
    const built = new Set();
    for (const seed of order) {
      const cols = [...regionColumns(regionOfCol(seed))];
      const m = dilate(cols);
      for (const c of m) if (!built.has(c)) { built.add(c); gen.terrainColumn(b, c); }
      gen.decorateRegion(b, cols, m);
    }
    return b;
  };
  const o5 = faceOrigin(5);
  const seeds = [];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) seeds.push((o5.x + 180 + a * 16) * W + (o5.y + 180 + b * 16));
  const A = build(seeds), B = build([...seeds].reverse());
  let diff = 0, cells = 0;
  for (const seed of seeds) {
    for (const c of regionColumns(regionOfCol(seed))) {
      for (let k = 0; k < D; k++) { cells++; if (A[c * D + k] !== B[c * D + k]) diff++; }
    }
  }
  ok(cells > 100000, `the order test really built nine regions (${cells} cells)`);
  eq(diff, 0, 'a region comes out the same whichever order its neighbours were built in');
}

console.log(`built in ${(buildMs / 1000).toFixed(1)}s`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
