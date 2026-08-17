// Asserts the fourteen on Verdant. `node src/game/Folk.test.mjs`.
//
// Written in the style of `Systems.test.mjs` and for the same reason: the parts
// of this feature that can be wrong are all *rules* - who witnessed what, what
// a tree does to a sight line, what a kill pays - and a rule is far cheaper to
// assert directly than to look for in a running game. What it is hunting is one
// class of bug above all: **anger that is a radius rather than a witness list**,
// which looks identical from a few metres away and is the whole mechanic.
//
// Every mob below is a fake body carrying only the fields the code under test
// reads, for the reason `Systems.test.mjs` gives: `Mobs.spawn` refuses a body
// whose GLB has not loaded, so nothing here can obtain a real one.
//
// Mutation-checked: sixteen deliberate breakages, sixteen caught. The list is
// at the foot of the file, and so is the one equivalent mutation that was
// tried and discarded rather than counted.

import { register } from 'node:module';

// The same stub `Systems.test.mjs` uses, and for the same reason: `Mobs.js`
// reads exactly one thing out of `Lighting.js` and that file does not load
// headless.
const STUB = 'export const SKY_ATTEN = new Uint8Array(256).fill(255);';
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.endsWith('/Lighting.js')) {
      return { url: 'data:text/javascript,${encodeURIComponent(STUB)}', shortCircuit: true };
    }
    return next(spec, ctx);
  }
`));

const THREE = await import('three');
const { W, D, wrap, faceOrigin, faceAt } = await import('../world/Grid.js');
const { FACE_ROLE, FACE_VERDANT } = await import('../world/Constants.js');
const { BLOCKS, ID } = await import('../world/Blocks.js');
const { Mobs, specOf } = await import('./Mobs.js');
const { xpForKill } = await import('./Skills.js');
const { itemIdOf } = await import('./Items.js');
const {
  FOLK_SIGHT, FOLK_JOIN, FOLK_PERIOD, FOLK_ARMS, FOLK_CONE,
  folkRoster, folkType, folkIdOf, traderIdOf, isTaboo, screensSight,
} = await import('./Folk.js');
const {
  newBarterState, offersLeft, forgetVisit, accept,
} = await import('./Barter.js');
const { CHARACTER_IDS } = await import('../player/Character.js');

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);

const idOf = (name) => {
  const i = BLOCKS.findIndex((b) => b.name === name);
  if (i < 0) throw new Error(`no block "${name}"`);
  return i;
};

// --- Folk.js on its own -----------------------------------------------------
{
  eq(CHARACTER_IDS.length, 15, 'the picker offers fifteen');
  for (const chosen of CHARACTER_IDS) {
    const r = folkRoster(chosen);
    eq(r.length, 14, `${chosen} leaves fourteen others`);
    ok(!r.includes(chosen), 'and you are not one of them');
    eq(new Set(r).size, 14, 'all distinct');
  }
  // Which fourteen genuinely depends on who you chose, rather than being a
  // fixed list with one swapped out.
  ok(folkRoster('a').includes('b') && !folkRoster('b').includes('b'),
    'the roster follows the choice');

  for (const id of CHARACTER_IDS) {
    ok(!!FOLK_ARMS[id], `${id} carries something`);
    ok(!!itemIdOf(FOLK_ARMS[id]), `...and "${FOLK_ARMS[id]}" is a real item`);
    const def = itemIdOf(FOLK_ARMS[id]);
    ok(!!specOf(folkType(id)), `${id} has a species row`);
    ok(def > 0, 'and an item id');
  }
  eq(folkIdOf(folkType('q')), 'q', 'type and id round-trip');
  eq(folkIdOf('husk'), null, 'and nothing else is one of them');
  // A stable, distinct barter key per person. Same key twice would put two of
  // them on one shelf and halve the trades on the face.
  eq(new Set(CHARACTER_IDS.map(traderIdOf)).size, 15, 'fifteen distinct trader keys');
  eq(FOLK_CONE, null, 'witnessing is a full circle plus a sight line, not a cone');
}

// --- the taboo --------------------------------------------------------------
{
  // Wood is fair game. All three trunks, all six windfalls, all three canopies.
  for (const name of ['log_oak', 'log_birch', 'log_pine',
    'log_oak_i', 'log_oak_j', 'log_pine_i',
    'leaves_oak', 'leaves_birch', 'leaves_pine']) {
    ok(!isTaboo(idOf(name)), `mining ${name} is not an offence`);
    ok(!screensSight(idOf(name)), `...and ${name} does not screen a witness`);
  }
  // Everything else is not. Their own ground first, then the things a player
  // actually comes to a jungle for.
  for (const name of ['stone', 'dirt', 'grass', 'sand', 'coal_ore', 'iron_ore',
    'oak_planks', 'cobblestone']) {
    ok(isTaboo(idOf(name)), `mining ${name} IS an offence`);
  }
  eq(isTaboo(0), false, 'air is not an offence');
  eq(screensSight(0), false, 'and air screens nothing');
  eq(screensSight(ID.water), false, 'nor does water');
  // A cross plant is not solid, so it was never going to screen anything - but
  // this is the line that would have to be right if `screensSight` were ever
  // rewritten off `opaque` instead.
  ok(!screensSight(idOf('tall_grass')), 'nor tall grass');
  ok(screensSight(idOf('stone')), 'stone does');
  ok(screensSight(idOf('glass')), '...and so does glass, as every other sight test has it');
}

// --- a planet made of a block function --------------------------------------
//
// Enough for the sight marches and nothing else: ground below `gk`, and
// whatever `put` has been told to stand in a column above it.

const GK = 34;
function fakePlanet() {
  const extra = new Map();       // `${x},${y},${k}` -> block id
  const at = (x, y, k) => {
    if (k < 0 || k >= D) return 0;
    const hit = extra.get(`${wrap(x)},${wrap(y)},${k}`);
    if (hit !== undefined) return hit;
    return k <= GK ? ID.stone : 0;
  };
  return {
    /** Stand `id` in the column at (x, y) from layer k0 up to k1 inclusive. */
    put(x, y, k0, k1, id) {
      for (let k = k0; k <= k1; k++) extra.set(`${wrap(x)},${wrap(y)},${k}`, id);
    },
    blockAtWorld: (wx, wy, wz) => at(Math.floor(wx), Math.floor(wz), Math.floor(wy)),
    isSolidWorld(wx, wy, wz) {
      const b = BLOCKS[at(Math.floor(wx), Math.floor(wz), Math.floor(wy))];
      return !!(b && b.solid);
    },
    at: (col, k) => at((col - (col % W)) / W, col % W, k),
    solidAt: () => false,
    liquidAt: () => false,
    surfaceK: () => GK,
    facingAt: () => 0,
    colBiome: new Uint8Array(1),
    colHeight: null,
    centerOf: (col, k, out) => { out.x = 0; out.y = k + 0.5; out.z = 0; return out; },
  };
}

const mobsOn = (planet) => new Mobs({ add() {} }, planet, { spawn() {} });

/** A body of one of the fourteen, at map (x, y), standing on GK. */
function fakeFolk(mobs, id, x, y) {
  const spec = specOf(folkType(id));
  const model = { root: new THREE.Object3D(), owned: [], actions: {},
    mixer: { stopAllAction() {}, uncacheRoot() {} } };
  const mob = {
    id: x * 1000 + y, type: folkType(id), spec, model,
    position: { x: x + 0.5, y: GK + 1.5, z: y + 0.5 },
    up: { x: 0, y: 1, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    cell: { x: x + 0.5, y: y + 0.5, k: GK + 1 },
    health: spec.health, dying: 0, baby: 0, grown: 1, baseHeight: spec.height,
    radius: 0.4, tall: spec.height, sizeJitter: 1,
    angry: false, target: null, sighted: false, sightT: 0,
    state: 'idle', stateT: 0, bestDist: Infinity, stallT: 0,
    huntCooldown: 0, onPath: false, hurtT: 0, swingT: 0, knockT: 0,
    released: false, leapCool: 0, grounded: true,
  };
  mobs.list.push(mob);
  return mob;
}

/** A player standing at map (x, y). */
const fakePlayer = (x, y) => ({
  position: { x: x + 0.5, y: GK + 1.5, z: y + 0.5 },
  up: { x: 0, y: 1, z: 0 },
  face: 7,
  cell: { x: x + 0.5, y: y + 0.5, k: GK + 1 },
});

// --- trees do not block sight; walls do -------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  // Two people six cells apart, with the canopy of one tree between them.
  const a = fakeFolk(mobs, 'b', 100, 100);
  const b = fakeFolk(mobs, 'c', 106, 100);
  for (let dx = 102; dx <= 103; dx++) planet.put(dx, 100, GK + 1, GK + 6, idOf('log_oak'));
  ok(mobs._witnessClear(a, b.position, b.up, b.spec.height),
    'a trunk does not stop one of them witnessing');
  // ...and the ordinary sight test, which every other mob uses, DOES stop
  // there. Without this the leaf-transparent variant could be doing nothing at
  // all and every test above it would still pass.
  ok(!mobs._blowClear(a, b.position, b.up, b.spec.height, 0.85, 0.4),
    'while the ordinary sight test is blocked by the same trunk');

  // Swap the trunk for leaves: same answer, because both are wood.
  for (let dx = 102; dx <= 103; dx++) planet.put(dx, 100, GK + 1, GK + 6, idOf('leaves_oak'));
  ok(mobs._witnessClear(a, b.position, b.up, b.spec.height), 'nor does a canopy');

  // Now a wall of stone in the same place.
  for (let dx = 102; dx <= 103; dx++) planet.put(dx, 100, GK + 1, GK + 6, idOf('stone'));
  ok(!mobs._witnessClear(a, b.position, b.up, b.spec.height), 'a stone wall does');
  for (let dx = 102; dx <= 103; dx++) planet.put(dx, 100, GK + 1, GK + 6, idOf('oak_planks'));
  ok(!mobs._witnessClear(a, b.position, b.up, b.spec.height),
    '...and so does one the player built out of planks');
  // Open ground, as the control.
  for (let dx = 102; dx <= 103; dx++) planet.put(dx, 100, GK + 1, GK + 6, 0);
  ok(mobs._witnessClear(a, b.position, b.up, b.spec.height), 'and nothing at all is clear');
}

// --- only the witnesses turn ------------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(200, 200);
  const near = fakeFolk(mobs, 'b', 206, 200);          // in the open
  const treed = fakeFolk(mobs, 'c', 214, 200);         // behind a tree
  const walled = fakeFolk(mobs, 'e', 194, 200);        // behind a wall
  const far = fakeFolk(mobs, 'f', 200 + FOLK_SIGHT + 6, 200);
  for (let dx = 208; dx <= 210; dx++) planet.put(dx, 200, GK + 1, GK + 8, idOf('leaves_oak'));
  for (let dx = 196; dx <= 198; dx++) planet.put(dx, 200, GK + 1, GK + 8, idOf('stone'));

  eq(mobs.witnessMine(idOf('log_oak'), player), 0, 'chopping a trunk offends nobody');
  eq(mobs.witnessMine(idOf('leaves_oak'), player), 0, 'nor does taking leaves');
  eq(near.angry, false, 'so the one standing right there is still a neighbour');

  const turned = mobs.witnessMine(idOf('stone'), player);
  eq(turned, 2, 'breaking stone turns the two who could see it');
  eq(near.angry, true, 'the one in the open saw it');
  eq(treed.angry, true, 'so did the one behind a tree');
  eq(walled.angry, false, 'the one behind a wall did not');
  eq(far.angry, false, 'nor did the one out of range');
  // Idempotent: a second swing does not re-turn anybody who is already angry.
  eq(mobs.witnessMine(idOf('dirt'), player), 0, 'and nobody turns twice');

  // An angry one is committed rather than merely cross: it has the player and
  // it has the sighting, which is the acquire-by-sight/commit-blind rule.
  eq(near.target, 'player', 'a witness has decided on you');
  eq(near.sighted, true, '...and does not need to re-acquire from behind a rock');
}

// --- ...and a neutral one never decides on its own --------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(300, 300);
  const mob = fakeFolk(mobs, 'b', 304, 300);
  const spec = mob.spec;
  ok(4 < spec.aggroRange, 'the body is well inside its own aggro ring');
  eq(mobs._hunt(mob, 0.1, 4, player), false, 'and does not hunt you for standing there');
  eq(mob.target, null, 'it has not acquired you');
  // The flags that would have paid for the kill.
  ok(!spec.hostile, 'not hostile');
  ok(!spec.monster, 'not a monster');
  eq(spec.folk, true, 'it is one of the fourteen');
}

// --- a kill pays nothing ----------------------------------------------------
{
  const planet = fakePlanet();
  let spilled = 0;
  const mobs = new Mobs({ add() {} }, planet, { spawn() { spilled++; } });
  const mob = fakeFolk(mobs, 'b', 400, 400);
  eq(mob.spec.drops.length, 0, 'nothing is on the drop table');
  eq(xpForKill(mob.spec), 0, 'and a kill is worth no XP');
  eq(xpForKill(mob.spec, true), 0, '...at any age');
  // A husk, for contrast, is worth something - so the zero above is a property
  // of this species rather than of `xpForKill` being broken.
  ok(xpForKill(specOf('husk')) > 0, 'while a husk pays');

  const killed = mobs.hurt(mob, 999, { x: 399, y: GK + 1.5, z: 400 }, 1);
  eq(killed, true, 'it can be killed');
  eq(spilled, 0, 'and leaves nothing on the ground, not even the tool');
  eq(mobs.list.includes(mob), false, 'the body is gone');
}

// --- hitting one is the second offence --------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const victim = fakeFolk(mobs, 'b', 500, 500);
  const seen = fakeFolk(mobs, 'c', 505, 500);
  const walled = fakeFolk(mobs, 'e', 495, 500);
  const far = fakeFolk(mobs, 'f', 500 + FOLK_SIGHT + 5, 500);
  for (let dx = 497; dx <= 498; dx++) planet.put(dx, 500, GK + 1, GK + 8, idOf('stone'));

  mobs.hurt(victim, 3, { x: 501.5, y: GK + 1.5, z: 500.5 }, 1);
  eq(victim.angry, true, 'the one you hit knows');
  eq(victim.target, 'player', '...and comes for you rather than bolting');
  eq(victim.state, 'chase', 'it does not flee like an animal');
  eq(seen.angry, true, 'so does the one who watched');
  eq(walled.angry, false, 'the one behind a wall did not see it');
  eq(far.angry, false, 'nor did the one out of range');
}

// --- anger spreads by witness, not by radius --------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  // A line of four, each within FOLK_JOIN of the next and only of the next.
  const step = FOLK_JOIN - 2;
  const a = fakeFolk(mobs, 'b', 600, 600);
  const b = fakeFolk(mobs, 'c', 600 + step, 600);
  const c = fakeFolk(mobs, 'e', 600 + step * 2, 600);
  const d = fakeFolk(mobs, 'f', 600 + step * 3, 600);
  ok(step * 2 > FOLK_JOIN, 'the second in the line is out of the first\'s reach');

  mobs._folkAnger(a);
  eq(b.angry, false, 'anger does not arrive before a pass runs');
  mobs._folkSpread(FOLK_PERIOD);
  eq(b.angry, true, 'a neutral who sees one chasing you joins');
  eq(c.angry, false, '...and only the neighbour, not the whole line');
  mobs._folkSpread(FOLK_PERIOD);
  eq(c.angry, true, 'the next pass takes the next one');
  mobs._folkSpread(FOLK_PERIOD);
  eq(d.angry, true, 'and so on down the line');
  // Which is the point: it travels WITH the bodies. A radius centred on the
  // offence would have taken `d` at once or never, and `d` is 42 cells from
  // where `a` was angered.
  ok((step * 3) > FOLK_SIGHT, 'the far end was never in sight of the offence');
}

// --- ...and it is a chase that recruits, not a mood -------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const cross = fakeFolk(mobs, 'b', 700, 700);
  const near = fakeFolk(mobs, 'c', 704, 700);
  mobs._folkAnger(cross);
  // He has lost you: `_hunt`'s stall gave up and dropped the target. Still
  // angry, standing about, and recruiting nobody.
  cross.target = null;
  mobs._folkSpread(FOLK_PERIOD);
  eq(near.angry, false, 'an angry one who is not chasing recruits nobody');
  cross.target = 'player';
  mobs._folkSpread(FOLK_PERIOD);
  eq(near.angry, true, '...and does the moment it is chasing again');
}

// --- a wall stops the spread too --------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const chaser = fakeFolk(mobs, 'b', 800, 800);
  const behind = fakeFolk(mobs, 'c', 806, 800);
  const treed = fakeFolk(mobs, 'e', 800, 806);
  for (let dx = 802; dx <= 803; dx++) planet.put(dx, 800, GK + 1, GK + 8, idOf('stone'));
  for (let dy = 802; dy <= 803; dy++) planet.put(800, dy, GK + 1, GK + 8, idOf('log_oak'));
  mobs._folkAnger(chaser);
  mobs._folkSpread(FOLK_PERIOD);
  eq(behind.angry, false, 'a wall stops the chase being seen');
  eq(treed.angry, true, 'a trunk does not');
}

// --- the clock --------------------------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const a = fakeFolk(mobs, 'b', 900, 900);
  const b = fakeFolk(mobs, 'c', 904, 900);
  // The first call after a world starts always runs - the clock begins at zero
  // - so it is spent here, with nobody angry, to leave a primed clock behind.
  eq(mobs._folkSpread(0), 0, 'a pass with nobody angry recruits nobody');
  mobs._folkAnger(a);
  eq(mobs._folkSpread(FOLK_PERIOD * 0.4), 0, 'the pass is on a clock');
  eq(b.angry, false, '...and nobody joins between ticks');
  eq(mobs._folkSpread(FOLK_PERIOD * 0.7), 1, 'and fires once the clock comes round');
}

// --- leaving the face is one rule, not two ----------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1000, 1000);
  const a = fakeFolk(mobs, 'b', 1004, 1000);
  const b = fakeFolk(mobs, 'c', 1008, 1000);
  mobs.witnessMine(idOf('stone'), player);
  eq(a.angry && b.angry, true, 'both saw it');
  ok(!mobs.canBarter(a), 'and an angry one does not trade');

  const state = newBarterState();
  const seed = 4242;
  const key = traderIdOf('b');
  const before = offersLeft(state, seed, key);
  ok(before.length > 0, 'a neighbour has offers');
  // Spend one, with an inventory that has whatever it asks for.
  const inv = {
    _n: new Map(),
    count(id) { return this._n.get(id) ?? 0; },
    roomFor() { return true; },
    remove(id, n) { this._n.set(id, this.count(id) - n); return n; },
    add(id, n) { this._n.set(id, this.count(id) + n); },
    changed() {},
  };
  inv.add(before[0].give.item, before[0].give.count);
  eq(accept(inv, state, seed, key, 0), true, 'and one can be taken');
  ok(offersLeft(state, seed, key)[0].left < before[0].left, 'which spends a use');

  // Now leave. One event, both memories.
  eq(mobs.calmFolk(), 2, 'both are calmed');
  eq(a.angry, false, 'anger does not survive the face');
  eq(a.target, null, '...and neither does the chase');
  ok(mobs.canBarter(a), 'so they will trade again');
  forgetVisit(state);
  eq(offersLeft(state, seed, key)[0].left, before[0].left, 'and the counter is back to full');
  eq(mobs.calmFolk(), 0, 'calming twice calms nobody');
}

// --- they only live on Verdant ----------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  mobs.playerCharacter = 'a';
  const o = faceOrigin(7);
  eq(FACE_ROLE[faceAt(o.x + 8, o.y + 8)], FACE_VERDANT, 'face 7 is Verdant');
  // Face 5 is the middle of the cross, and nobody is placed there.
  const off = fakePlayer(faceOrigin(5).x + 20, faceOrigin(5).y + 20);
  off.face = faceAt(off.cell.x, off.cell.y);
  eq(mobs._folkTopUp(off, 0), 0, 'nobody is placed off Verdant');
  // ...nor before main has said which body the player took, or the village
  // would contain the player's own twin.
  const on = fakePlayer(o.x + 20, o.y + 20);
  on.face = 7;
  mobs.playerCharacter = null;
  eq(mobs._folkTopUp(on, 0), 0, 'nor before the roster is known');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// --- mutation log -----------------------------------------------------------
//
//  1  `screensSight` -> `IS_SOLID[id] === 1`            caught (trees block)
//  2  `SEE_THROUGH` set for every block                 caught (walls stop nothing)
//  3  `TABOO` set for every block                       caught (wood offends)
//  4  `screensSight` drops its `IS_SOLID` term          caught (air screens)
//  5  `witnessMine` drops the `_witnessClearPlayer` test caught (walled turns)
//  6  `witnessMine` drops the FOLK_SIGHT test           caught (far turns)
//  7  `witnessMine` drops the `isTaboo` gate            caught (wood offends)
//  8  `witnessHit` drops the victim                     caught
//  9  `witnessHit` measures sight to the player         caught (walled turns)
// 10  `_folkSpread` drops `target === 'player'`         caught
// 11  `_folkSpread` drops the `_witnessClear` test      caught (wall)
// 12  `_folkSpread` drops the FOLK_JOIN test            caught (whole line at once)
// 13  `_folkSpread` recruits off the live list          caught (whole line at once)
// 14  `_hunt`'s `acquires` gains `spec.folk` unguarded  caught (neutral hunts)
// 15  `calmFolk` clears `angry` but not `target`        caught
// 16  the `folk` row gains `monster: true`              caught (XP paid)
//
// Discarded rather than counted: dropping the `blockId > 0` guard in `isTaboo`,
// and starting the `TABOO` loop at 0 instead of 1. Both are equivalent
// mutations - air is block 0 and each of those two lines alone is enough to
// keep it out - so neither can be caught by any test, and counting a pair of
// belt-and-braces guards as two escapes would be counting the wrong thing.
