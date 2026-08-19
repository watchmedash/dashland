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
// Mutation-checked: thirty-five deliberate breakages, thirty-five caught. The
// list is at the foot of the file, and so is the one equivalent mutation that
// was tried and discarded rather than counted.
//
// The second half of the file is the night - `VerdantNight.js` and the swap in
// `Mobs.js` - and it hunts one class of bug the way the first half hunts
// "anger is a radius": **a body seen to leave**. Every retreat here is an
// unobserved one, and the two ways that quietly stops being true are a sight
// test that always answers yes and a body that can never satisfy it.


// The same stub `Systems.test.mjs` uses, and for the same reason: `Mobs.js`
// reads exactly one thing out of `Lighting.js` and that file does not load
// headless.
// The `Lighting.js` stub that used to stand here is gone.
//
// It answered for that module with a one-export shim, because `Lighting.js`
// did not load headless when these tests were written, and it said so: "it
// stops firing the moment Lighting.js loads on its own". That moment has
// passed - the module imports cleanly on its own now - and the shim had turned
// from a workaround into a trap: it exported only SKY_ATTEN, so the day `Mobs.js`
// started reading SKY_SHADE_MIN out of the same file (the fix for models glowing
// in dark caves), the test failed to LINK and reported the real module as
// missing an export it plainly has.
//
// A stub that lists what the code under test may import is a stub that has to be
// edited every time that changes, and its failure mode is a lie about the module
// it stands in for. The real one loads; it can answer for itself.

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
const {
  VERDANT_HUSKS, VERDANT_CINDER, VERDANT_NIGHT_CAP, VERDANT_NIGHT_SPECIES,
  VERDANT_HIDE, VERDANT_PER_TICK, VERDANT_LINGER, VERDANT_NIGHT_NEAR,
  VERDANT_NIGHT_FAR, VERDANT_GROUND, verdantNightDraw,
} = await import('./VerdantNight.js');
const {
  VERDANT_DAY_HUSKS, VERDANT_DAY_CINDER, SHADE_SPAN, SHADE_STEP, SHADE_RING,
  SHADE_MIN, SHADE_PERIOD, FOLK_FLOOR, FOLK_REGEN, folkPrey, leafAbove,
} = await import('./VerdantDay.js');
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

const mobsOn = (planet) => new Mobs({ add() {}, remove() {} }, planet, { spawn() {} });

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

// --- the night: what it is made of ------------------------------------------
//
// `VerdantNight.js` on its own, the way the head of this file asserts `Folk.js`
// on its own. Everything here is a number with an argument behind it, and the
// argument is the thing worth pinning: a night whose roster drifted to nine
// exploders is a different game from the one section 8 describes.
{
  eq(VERDANT_HUSKS, folkRoster('a').length, 'one husk for every person who left');
  eq(VERDANT_NIGHT_CAP, VERDANT_HUSKS + VERDANT_CINDER, 'and the cap is the two of them');
  eq(VERDANT_NIGHT_CAP, 21, 'twenty-one bodies');
  // MAX_MONSTERS_HOSTILE_FACE, which this file cannot import. The number is
  // written out rather than skipped because it is the whole justification for
  // twenty-one: a sealed face has already been played at twenty-four.
  ok(VERDANT_NIGHT_CAP < 24, '...under the ceiling a sealed face already carries');
  ok(VERDANT_HUSKS > 8, 'and above an ordinary night, which carries eight husks');
  ok(VERDANT_HUSKS >= 14, '...at a savage night\'s fourteen on every difficulty');
  // STALKER_VANISH, likewise not importable. If VERDANT_HIDE ever slipped to or
  // below it, `_unobserved`'s "too close counts as unobserved" branch would
  // reopen and a neighbour could blink out at arm's length.
  ok(VERDANT_HIDE > 24, 'the hide floor is outside the stalker vanish ring');
  // Inside a husk's 34-cell aggro ring, and that is the measured decision
  // rather than an oversight - see the note on the constant. Outside
  // SPAWN_MIN_DIST, which is the floor every other spawner in the game keeps.
  ok(VERDANT_NIGHT_NEAR > 20, 'the night arrives no nearer than any other spawn');
  ok(VERDANT_NIGHT_NEAR < 34, '...and inside a husk\'s aggro ring, so it comes for you');
  ok(VERDANT_NIGHT_FAR > VERDANT_NIGHT_NEAR * 2, 'on a ring with real width to it');

  // The draw, run out to a full night.
  let husks = 0, cinders = 0, run = 0, worstRun = 0;
  const order = [];
  for (let n = 0; n < VERDANT_NIGHT_CAP; n++) {
    const type = verdantNightDraw(husks, cinders);
    order.push(type);
    ok(VERDANT_NIGHT_SPECIES.includes(type), `${type} is on the night's roster`);
    if (type === 'cinderling') { cinders++; run++; } else { husks++; run = 0; }
    worstRun = Math.max(worstRun, run);
  }
  eq(husks, VERDANT_HUSKS, 'a full night is fourteen husks');
  eq(cinders, VERDANT_CINDER, '...and seven cinderlings');
  eq(order[0], 'husk', 'the first thing out of the dark is the common one');
  eq(verdantNightDraw(husks, cinders), null, 'and the night is then full');
  eq(worstRun, 1, 'no two exploders arrive back to back');
  // The two ends, so the draw cannot answer a species that is already at quota.
  eq(verdantNightDraw(VERDANT_HUSKS, 0), 'cinderling', 'a full husk quota draws the other');
  eq(verdantNightDraw(0, VERDANT_CINDER), 'husk', '...and the other way round');

  // The roster is husks and cinderlings, and they are the two the ask names.
  eq(VERDANT_NIGHT_SPECIES.length, 2, 'two species and no more');
  ok(specOf('husk').hostile, 'the husk is the night\'s baseline');
  ok(specOf('cinderling').blast > 0, '...and the cinderling is the one with a fuse');
  ok(!specOf('cinderling').damage, 'which does not hit you, it goes off');

  // The jungle floor is three blocks and the night has to stand on all three.
  for (const name of ['grass', 'moss_block', 'coarse_dirt']) {
    ok(VERDANT_GROUND.has(idOf(name)), `the night stands on ${name}`);
  }
  ok(!VERDANT_GROUND.has(idOf('leaves_oak')), 'and never on the canopy');
  ok(!VERDANT_GROUND.has(ID.water), 'nor on water');
}

// --- the floor under the canopy ---------------------------------------------
//
// The trap this face sets for every spawn search written against it. Asserted
// here rather than taken on trust, because the failure is silent: the search
// simply never returns a column and the face reads as empty.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const col = 100 * W + 100;
  // A crown three layers thick with clear air under it, which is what a jungle
  // column actually looks like: `surfaceK` answers the top of the leaves.
  planet.put(100, 100, GK + 4, GK + 6, idOf('leaves_oak'));
  planet.surfaceK = () => GK + 6;
  eq(planet.at(col, planet.surfaceK(col)), idOf('leaves_oak'),
    'surfaceK on this face answers the canopy');
  eq(mobs._floorUnderCanopy(col), GK, '...and the floor is what is under it');
  // A trunk standing on the floor, so the descent is through wood as well as
  // through air.
  planet.put(100, 100, GK + 1, GK + 3, idOf('log_oak'));
  eq(mobs._floorUnderCanopy(col), GK, 'a trunk is not the floor either');
  // ...and one column of the fifth that carries nothing at all.
  eq(mobs._floorUnderCanopy(101 * W + 101), GK, 'an open column answers the same');
}

/** A husk-shaped body of the night, at map (x, y). */
// `night` false makes the same body a DAY placement. The helper was written
// for the night and hardwired its mark, so the day test - which reuses it -
// was labelling its own five husks as night bodies and then asserting there
// were none.
function fakeNight(mobs, type, x, y, night = true) {
  const spec = specOf(type);
  const model = { root: new THREE.Object3D(), owned: [], actions: {},
    mixer: { stopAllAction() {}, uncacheRoot() {} } };
  const mob = {
    id: x * 1000 + y, type, spec, model,
    verdantNight: night, verdantDay: !night,
    position: { x: x + 0.5, y: GK + 1.5, z: y + 0.5 },
    up: { x: 0, y: 1, z: 0 },
    cell: { x: x + 0.5, y: y + 0.5, k: GK + 1 },
    health: spec.health, dying: 0, released: false,
  };
  mobs.list.push(mob);
  return mob;
}

// --- the fourteen go, from the far side in ----------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1100, 1100);
  // Fourteen of them, spread out along a line at 30, 34, 38 ... cells.
  const village = folkRoster('a').map((id, n) =>
    fakeFolk(mobs, id, 1100 + VERDANT_HIDE + 4 + n * 4, 1100));
  eq(village.length, 14, 'a full village');

  eq(mobs._verdantSendOff(player, 0), VERDANT_PER_TICK, 'three leave on the first tick');
  ok(!mobs.list.includes(village[13]), 'and the furthest one goes first');
  ok(!mobs.list.includes(village[12]) && !mobs.list.includes(village[11]),
    '...then the next two');
  ok(mobs.list.includes(village[0]), 'while the nearest is still standing there');
  // Four more ticks empties it. Fourteen at three a tick is five ticks, which
  // at SPAWN_PERIOD is about ten seconds of nightfall.
  for (let t = 0; t < 4; t++) mobs._verdantSendOff(player, 0);
  eq(mobs.list.filter((m) => m.spec.folk).length, 0, 'the village is empty');
  eq(mobs._verdantSendOff(player, 0), 0, 'and an empty village sends nobody off');
}

// --- ...and nothing goes while you are looking at it ------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1200, 1200);
  const watched = fakeFolk(mobs, 'b', 1200 + 40, 1200);
  const husk = fakeNight(mobs, 'husk', 1200 + 44, 1200);

  // A real camera, at the player, looking straight down +x at both of them.
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 400);
  cam.position.set(player.position.x, player.position.y + 0.6, player.position.z);
  cam.lookAt(watched.position.x, watched.position.y, watched.position.z);
  const aim = () => {
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  };
  aim();
  mobs.camera = cam;
  ok(mobs._inView(watched, 1.0), 'the camera is genuinely looking at him');
  eq(mobs._verdantSendOff(player, 0), 0, 'and nobody leaves in the player\'s view');
  eq(mobs._verdantDawnCull(player, 0), 0, '...nor does the night in it');

  // Turn round. Same bodies, same distances, and now they go.
  cam.lookAt(player.position.x - 10, player.position.y, player.position.z);
  aim();
  ok(!mobs._inView(watched, 1.0), 'now the camera is turned away');
  eq(mobs._verdantSendOff(player, 0), 1, 'the one behind you leaves');
  eq(mobs._verdantDawnCull(player, 0), 1, '...and so does the husk');
  ok(mobs.list.length === 0, 'both gone');
}

// --- ...and a body that can never be unobserved still goes ------------------
//
// The hole the linger clock closes, and it is not the player staring: it is one
// of them CHASING you, glued inside its own reach and therefore inside
// VERDANT_HIDE forever. Without a clock that body is on the face at noon.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1300, 1300);
  const chaser = fakeFolk(mobs, 'b', 1301, 1300);
  mobs._folkAnger(chaser);
  ok(1 < VERDANT_HIDE, 'the chaser is inside the hide floor');
  eq(mobs._verdantSendOff(player, VERDANT_LINGER * 0.5), 0, 'so the far-end pass never takes him');
  ok(mobs.list.includes(chaser), 'and he is still there mid-night');
  eq(mobs._verdantSendOff(player, VERDANT_LINGER * 0.6), 1, 'the clock takes him');
  eq(mobs.list.length, 0, 'and the face is clear');
}

// --- the morning ------------------------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1400, 1400);

  // A night in progress: the roster standing, the village gone.
  for (let n = 0; n < 6; n++) fakeNight(mobs, n % 3 === 2 ? 'cinderling' : 'husk',
    1400 + VERDANT_HIDE + 4 + n * 4, 1400);
  eq(mobs.list.length, 6, 'six of the night are up');
  // Dawn takes them three at a tick, exactly as the dusk took the village.
  eq(mobs._verdantDawnCull(player, 0), VERDANT_PER_TICK, 'three go with the light');
  mobs._verdantDawnCull(player, 0);
  eq(mobs.list.length, 0, 'and the night is over');

  // The barter counter, which is the second caller of `forgetVisit`. Wired the
  // way main wires it: Mobs knows the morning happened, `Barter.js` knows what
  // a visit is, and neither knows the other.
  const state = newBarterState();
  const seed = 4242;
  const key = traderIdOf('b');
  const before = offersLeft(state, seed, key);
  const inv = {
    _n: new Map(),
    count(id) { return this._n.get(id) ?? 0; },
    roomFor() { return true; },
    remove(id, n) { this._n.set(id, this.count(id) - n); return n; },
    add(id, n) { this._n.set(id, this.count(id) + n); },
    changed() {},
  };
  inv.add(before[0].give.item, before[0].give.count);
  eq(accept(inv, state, seed, key, 0), true, 'a swap is taken during the day');
  ok(offersLeft(state, seed, key)[0].left < before[0].left, 'which spends a use');

  let dawns = 0;
  mobs.onFolkDawn = () => { dawns++; forgetVisit(state); };
  mobs._verdantDawn();
  eq(dawns, 1, 'the morning fires once');
  eq(offersLeft(state, seed, key)[0].left, before[0].left,
    'and their stock is fresh again');
}

// --- a grudge never crosses a night -----------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1500, 1500);
  const a = fakeFolk(mobs, 'b', 1500 + 8, 1500);
  const b = fakeFolk(mobs, 'c', 1500 + 14, 1500);
  eq(mobs.witnessMine(idOf('stone'), player), 2, 'two of them saw you mining');
  ok(a.angry && b.angry, 'and both are hostile');

  // The night takes the bodies, so there is nothing left to hold a grudge.
  // Both are chasing you and therefore inside VERDANT_HIDE, so it is the linger
  // clock that takes them - which is the case that matters here.
  mobs._verdantSendOff(player, VERDANT_LINGER + 1);
  eq(mobs.list.filter((m) => m.spec.folk).length, 0, 'the angry ones left with the rest');
  // ...and the morning states it outright, for anything that somehow survived.
  const straggler = fakeFolk(mobs, 'e', 1500 + 4, 1500);
  mobs._folkAnger(straggler);
  mobs._verdantDawn();
  eq(straggler.angry, false, 'anger does not survive a night');
  eq(straggler.target, null, '...and neither does the chase');
  ok(mobs.canBarter(straggler), 'so the morning trades with you');
}

// --- the two populations never overlap --------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1600, 1600);
  const person = fakeFolk(mobs, 'b', 1600 + 40, 1600);
  const husk = fakeNight(mobs, 'husk', 1600 + 44, 1600);
  // The dusk takes people and the dawn takes the night, and neither takes the
  // other. A predicate that read `spec.hostile` or `spec.monster` would have
  // taken the husk on both.
  eq(mobs._verdantDawnCull(player, 0), 1, 'the dawn cull takes the night body');
  ok(mobs.list.includes(person), 'and leaves the person standing');
  eq(mobs._verdantSendOff(player, 0), 1, 'the send-off takes the person');
  eq(mobs.list.length, 0, 'and that is both of them');
}

// --- a night body is never written down -------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  fakeNight(mobs, 'husk', 1700, 1700);
  const written = mobs.toJSON().mobs;
  eq(written.length, 0, 'the save holds nothing the morning is going to take');
}

// --- and nobody is topped up into a night -----------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  mobs.playerCharacter = 'a';
  const o = faceOrigin(7);
  const on = fakePlayer(o.x + 20, o.y + 20);
  on.face = 7;
  // Counted at the search rather than at the spawn: `spawn` refuses a body
  // whose GLB has not loaded, so headless every top-up "places" nobody whether
  // or not it tried, and an assertion on the return value alone would pass with
  // the stand-down deleted.
  let searches = 0;
  mobs._findFolkColumn = () => { searches++; return null; };
  mobs.verdantNight = true;
  eq(mobs._folkTopUp(on, 0), 0, 'the village does not refill behind the retreat');
  eq(searches, 0, '...and does not so much as look for ground');
  mobs.verdantNight = false;
  mobs._folkTopUp(on, 0);
  ok(searches > 0, 'while by day it looks');
}

// --- the night stands on the floor, not on the canopy -----------------------
//
// The one search this feature adds, against the trap the face sets. A version
// written on `surfaceK` finds nothing at all here and the face reads as empty,
// which is exactly how Verdant came to have no wildlife.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(7);
  // Jungle floor everywhere, under a canopy everywhere.
  planet.at = (col, k) => (k === GK ? idOf('moss_block')
    : (k < GK ? idOf('stone') : (k >= GK + 4 && k <= GK + 6 ? idOf('leaves_oak') : 0)));
  planet.surfaceK = () => GK + 6;
  const near = fakePlayer(o.x + 60, o.y + 60);
  const spot = mobs._findVerdantColumn(
    mobs._colOf(near.cell.x, near.cell.y), near.position, 7);
  ok(!!spot, 'the night finds ground on Verdant');
  eq(spot.k, GK, '...under the canopy rather than on top of it');

  // ...and never off it. Run from twenty cells inside the edge, where a random
  // walk out to VERDANT_NIGHT_FAR steps over the seam most of the time - which
  // is the whole reason the search tests the face at all. Every column above is
  // standable here, so an unguarded walk answers with one.
  const edge = fakePlayer(o.x + 20, o.y + 20);
  const edgeCol = mobs._colOf(edge.cell.x, edge.cell.y);
  let off = 0, found = 0;
  for (let n = 0; n < 200; n++) {
    const s = mobs._findVerdantColumn(edgeCol, edge.position, 7);
    if (!s) continue;
    found++;
    if (faceAt(Math.floor(s.col / W), s.col % W) !== 7) off++;
  }
  ok(found > 0, 'the search answers near the seam');
  eq(off, 0, 'and never with a column on another face');
}

// --- a body never arrives in shot -------------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1800, 1800);
  // `spawn` refuses a body whose GLB has not loaded, so the placement is stood
  // in for and only the sight half is under test.
  mobs.spawn = (type) => fakeNight(mobs, type, 1840, 1800);
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 400);
  cam.position.set(player.position.x, player.position.y + 0.6, player.position.z);
  const aim = (tx, tz) => {
    cam.lookAt(tx, player.position.y, tz);
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  };
  mobs.camera = cam;
  aim(1840.5, 1800.5);
  eq(mobs._placeUnseen('husk', 0, GK), null, 'a body that lands in shot is taken back');
  eq(mobs.list.length, 0, '...and is not left on the list');
  aim(1700, 1800.5);
  ok(!!mobs._placeUnseen('husk', 0, GK), 'and one behind you stays');
  eq(mobs.list.length, 1, 'on the list');
}

// --- the day: what stands in the shade --------------------------------------
//
// `VerdantDay.js` on its own, the way the two blocks above assert `Folk.js` and
// `VerdantNight.js` on their own. The one number that carries a design decision
// is the headcount, and the thing worth pinning about it is not its value but
// its *relations*: a day that drifted up to the night's twenty-one would be a
// second night, which is precisely what the ask says it is not.
{
  eq(VERDANT_DAY_HUSKS, 5, 'five husks stand in the shade at noon');
  ok(VERDANT_DAY_HUSKS < VERDANT_NIGHT_CAP, '...fewer than the night carries');
  ok(VERDANT_DAY_HUSKS < VERDANT_HUSKS, '...fewer even than the night\'s husks alone');
  // MAX_HOSTILE_SURFACE, which this file cannot import. Written out because it
  // is the whole justification: noon on the worst face in the game is still
  // under midnight on the best one.
  ok(VERDANT_DAY_HUSKS < 8, 'and under an ordinary night\'s husk budget anywhere else');
  ok(VERDANT_DAY_HUSKS * 2 < folkRoster('a').length,
    'the fourteen comfortably outnumber them');
  eq(VERDANT_DAY_CINDER, 0, 'and nothing with a fuse cratering the canopy by day');

  // The shade rule's own shape. Three of five is a majority and not an edge.
  ok(SHADE_MIN > SHADE_RING.length / 2 / 2, 'shade is a majority of the samples');
  eq(SHADE_RING.length / 2, 5, 'five of them: the column and four cardinals');
  eq(SHADE_RING[0], 0, 'the centre first');
  eq(SHADE_RING[1], 0, '...and it is the centre');
  ok(SHADE_MIN < SHADE_RING.length / 2, 'but not every one, or nothing qualifies');
  ok(SHADE_STEP >= 1, 'and the samples are genuinely spread');
  ok(SHADE_SPAN > 6, 'a canopy sits well clear of the floor');

  // What one of the fourteen will go for, off the species table rather than off
  // a name. The husk and nothing else.
  ok(folkPrey(specOf('husk')), 'a resident goes for a husk');
  ok(!folkPrey(specOf('drowned')), 'and not for the drowned, which is hostile and wet');
  ok(!folkPrey(specOf('cinderling')), 'nor for a cinderling, which the ask does not name');
  ok(!folkPrey(specOf(folkType('b'))), 'nor for a neighbour');
  ok(!folkPrey(specOf('merchant')), 'nor for the merchant');
  ok(!folkPrey(specOf('stalker')), 'nor for him');
  ok(!folkPrey(null), 'and a body with no spec is nothing');
  // Every hostile land species is fair game, and there is exactly one.
  const hostiles = ['husk', 'drowned'].filter((t) => folkPrey(specOf(t)));
  eq(hostiles.length, 1, 'exactly one species is on the list');

  ok(FOLK_FLOOR >= 1, 'a husk can never take a resident to zero');
  ok(FOLK_REGEN > 0, 'and a resident mends between fights');
  // Slow enough to be no defence against the player: a wood sword is 4.
  ok(FOLK_REGEN < 1, '...far slower than any sword');
}

// --- the canopy is dark, and the light solver still says it is not ----------
//
// The wrinkle this whole feature is built around, asserted as a *disagreement*
// rather than taken on trust. If `_shaded` ever collapsed into `!_skyLit` the
// two tests below would agree and the husks would burn at noon; if `SKY_ATTEN`
// or `_roofed` ever started counting leaves, every forest on the planet becomes
// a husk factory again and this catches that too.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const col = 100 * W + 100;
  const canopy = (x, y) => planet.put(x, y, GK + 5, GK + 7, idOf('leaves_oak'));
  // A crown over the column and over all four of its neighbours: full jungle.
  canopy(100, 100);
  canopy(100 + SHADE_STEP, 100); canopy(100 - SHADE_STEP, 100);
  canopy(100, 100 + SHADE_STEP); canopy(100, 100 - SHADE_STEP);
  ok(mobs._shaded(col, GK), 'a jungle column is in shade');
  ok(!mobs._roofed(col, GK), '...while the light solver says it is under open sky');

  // One leaf and nothing else is a twig, not a canopy. This is the failure the
  // five-sample spread exists to stop: a husk in an open clearing, in full sun,
  // under the outermost frond of a tree that is not over it.
  const bare = fakePlanet();
  const lone = mobsOn(bare);
  bare.put(200, 200, GK + 5, GK + 7, idOf('leaves_oak'));
  // `_shaded` memoises per tick and this block grows the canopy between calls,
  // which is the one thing the memo cannot serve - the game only ever plants a
  // tree between ticks, never inside one. Ask the uncached form so the rule is
  // what is under test rather than the cache.
  ok(!lone._shadedRaw(200 * W + 200, GK), 'one leaf overhead is not shade');
  bare.put(200 + SHADE_STEP, 200, GK + 5, GK + 7, idOf('leaves_oak'));
  ok(!lone._shadedRaw(200 * W + 200, GK), 'nor are two');
  bare.put(200 - SHADE_STEP, 200, GK + 5, GK + 7, idOf('leaves_oak'));
  ok(lone._shadedRaw(200 * W + 200, GK), 'three of five is');

  // Open ground is not shade, and neither is a roof of anything but foliage -
  // a hut is `_roofed`'s business and always has been.
  ok(!lone._shaded(300 * W + 300, GK), 'open ground is not shade');
  const built = fakePlanet();
  const hut = mobsOn(built);
  for (let dx = -SHADE_STEP; dx <= SHADE_STEP; dx++) {
    for (let dy = -SHADE_STEP; dy <= SHADE_STEP; dy++) {
      built.put(400 + dx, 400 + dy, GK + 3, GK + 3, idOf('oak_planks'));
    }
  }
  ok(!hut._shaded(400 * W + 400, GK), 'a plank roof is shelter, not shade');
  ok(hut._roofed(400 * W + 400, GK), '...and the light solver calls that one a roof');

  // Height. A canopy far enough up is sky, not shade, or the rule would be
  // satisfied by a leaf at the top of the world.
  const high = fakePlanet();
  const tall = mobsOn(high);
  for (const [dx, dy] of [[0, 0], [SHADE_STEP, 0], [-SHADE_STEP, 0]]) {
    high.put(500 + dx, 500 + dy, GK + SHADE_SPAN + 2, GK + SHADE_SPAN + 4, idOf('leaves_oak'));
  }
  ok(!tall._shaded(500 * W + 500, GK), 'a canopy out of reach overhead is not shade');
}

// --- ...and the daylight burn obeys the same rule ---------------------------
//
// The one-line consequence, and the reason it is a body test rather than a
// column test: a husk walks. `_shadedNow` is what the burn asks, it is cached
// on a clock, and the clock has to notice when the body has moved.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  for (const [dx, dy] of [[0, 0], [SHADE_STEP, 0], [-SHADE_STEP, 0]]) {
    planet.put(600 + dx, 600 + dy, GK + 5, GK + 7, idOf('leaves_oak'));
  }
  const husk = fakeNight(mobs, 'husk', 600, 600);
  ok(specOf('husk').burns, 'daylight burns a husk');
  ok(mobs._skyLit(husk), '...and the sky reaches this one, as far as lighting knows');
  ok(mobs._shadedNow(husk, 0), 'while the face says it is under the jungle');
  // Cached: moving without letting the clock run answers the stale value.
  husk.cell.x = 900.5; husk.cell.y = 900.5;
  ok(mobs._shadedNow(husk, 0.01), 'the answer is held for a moment');
  ok(!mobs._shadedNow(husk, SHADE_PERIOD), '...and a step into the clearing is noticed');
  // ...and `_skyLit` still says yes, which is the whole point of the feature
  // rather than a contradiction. Leaves are deliberately NOT a roof to the
  // light solver (`SKY_ATTEN`), so lighting sees open sky under a canopy and
  // always did; `_shadedNow` is the second opinion that exists BECAUSE of that.
  // The two must disagree under the trees and agree in the open, and asserting
  // `_skyLit` false here asserted the opposite of the thing being built.
  ok(mobs._skyLit(husk), 'and lighting says open sky in both places, as it must');
}

// --- five, under cover, and only by day -------------------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(7);
  // Jungle floor everywhere, and a canopy over every column: the whole face
  // qualifies, so anything the search refuses it refuses on a rule.
  planet.at = (col, k) => (k === GK ? idOf('moss_block')
    : (k < GK ? idOf('stone') : (k >= GK + 4 && k <= GK + 6 ? idOf('leaves_oak') : 0)));
  planet.surfaceK = () => GK + 6;
  const player = fakePlayer(o.x + 60, o.y + 60);
  const col = mobs._colOf(player.cell.x, player.cell.y);
  const spot = mobs._findVerdantColumn(col, player.position, 7, true);
  ok(!!spot, 'the day finds shaded ground on Verdant');
  eq(spot.k, GK, '...under the canopy rather than on top of it');

  // Now take the canopy away and leave everything else exactly as it was. The
  // night still finds ground here; the day must not.
  planet.at = (c, k) => (k === GK ? idOf('moss_block') : (k < GK ? idOf('stone') : 0));
  planet.surfaceK = () => GK;
  ok(!!mobs._findVerdantColumn(col, player.position, 7, false),
    'the night stands on open jungle floor');
  eq(mobs._findVerdantColumn(col, player.position, 7, true), null,
    'and the day refuses every column of it');
}

// --- the day's headcount ----------------------------------------------------
//
// `spawn` refuses a body whose GLB has not loaded, so the placement is stood in
// for exactly as the night's test does it: what is under test is the budget and
// the stand-down, not three.js.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(7);
  const player = fakePlayer(o.x + 60, o.y + 60);
  const col = mobs._colOf(player.cell.x, player.cell.y);
  let searches = 0;
  mobs._findVerdantColumn = (...a) => { searches++; return { col: 0, k: GK, shaded: a[3] }; };
  let placed = 0;
  mobs._placeUnseen = (type) => fakeNight(mobs, type, 700 + (placed++), 700, false);

  // Everything the day places is a husk, it goes up VERDANT_PER_TICK a tick,
  // and it stops at five.
  let total = 0;
  for (let t = 0; t < 6; t++) total += mobs._verdantDayTick(player, col);
  eq(total, VERDANT_DAY_HUSKS, 'the day fills to five and no further');
  eq(mobs._verdantDayTick(player, col), 0, 'and a full day places nobody');
  const day = mobs.list.filter((m) => m.verdantDay);
  eq(day.length, VERDANT_DAY_HUSKS, 'five bodies carry the day\'s mark');
  ok(day.every((m) => m.type === 'husk'), 'and every one of them is a husk');
  eq(mobs.list.filter((m) => m.verdantNight).length, 0, 'none of them is a night body');
  // ...and the search it ran was the shaded one. Without this the budget could
  // be right and the husks standing in open sun.
  ok(searches > 0, 'the day looked for ground');
}

// --- nothing is placed into the tail of a night -----------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(7);
  const player = fakePlayer(o.x + 60, o.y + 60);
  const col = mobs._colOf(player.cell.x, player.cell.y);
  let searches = 0;
  mobs._findVerdantColumn = () => { searches++; return { col: 0, k: GK }; };
  mobs._placeUnseen = (type) => fakeNight(mobs, type, 800, 800);
  // One husk of the night still standing, mid-dawn-cull.
  fakeNight(mobs, 'husk', 810, 800);
  eq(mobs._verdantDayTick(player, col), 0, 'the day waits for the night to leave');
  eq(searches, 0, '...and does not so much as look for ground');
}

// --- dusk promotes the day rather than replacing it -------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const o = faceOrigin(7);
  const player = fakePlayer(o.x + 60, o.y + 60);
  const col = mobs._colOf(player.cell.x, player.cell.y);
  const standing = [];
  for (let n = 0; n < VERDANT_DAY_HUSKS; n++) {
    const m = fakeNight(mobs, 'husk', 900 + n * 4, 900);
    m.verdantNight = false;
    m.verdantDay = true;
    standing.push(m);
  }
  mobs._findVerdantColumn = () => null;      // the night places nothing new
  mobs._verdantNightTick(player, col, 0);
  ok(standing.every((m) => mobs.list.includes(m)), 'no body is exchanged at dusk');
  ok(standing.every((m) => m.verdantNight && !m.verdantDay),
    '...they are simply the first five of the night');
  // Which means the dawn takes them, and nothing outlives the morning.
  const far = fakePlayer(0, 0);
  for (let t = 0; t < 3; t++) mobs._verdantDawnCull(far, 0);
  eq(mobs.list.length, 0, 'and the morning has them all');
}

// --- the dawn cull leaves the day's husks alone -----------------------------
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1000, 1000);
  const dayHusk = fakeNight(mobs, 'husk', 1000 + VERDANT_HIDE + 10, 1000);
  dayHusk.verdantNight = false;
  dayHusk.verdantDay = true;
  const nightHusk = fakeNight(mobs, 'husk', 1000 + VERDANT_HIDE + 14, 1000);
  eq(mobs._verdantDawnCull(player, 0), 1, 'the cull takes the night body');
  ok(!mobs.list.includes(nightHusk), 'and it is the night\'s');
  ok(mobs.list.includes(dayHusk), 'while the day\'s stands in the shade');
  // ...nor is it written down, for the reason a night body is not.
  eq(mobs.toJSON().mobs.length, 0, 'and no save holds one');
}

/** A body of any species at map (x, y), with everything a fight reads. */
function fakeBody(mobs, type, x, y) {
  const spec = specOf(type);
  const model = { root: new THREE.Object3D(), owned: [], actions: {},
    mixer: { stopAllAction() {}, uncacheRoot() {} } };
  const mob = {
    id: x * 1000 + y, type, spec, model,
    position: { x: x + 0.5, y: GK + 1.5, z: y + 0.5 },
    up: { x: 0, y: 1, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    cell: { x: x + 0.5, y: y + 0.5, k: GK + 1 },
    health: spec.health, dying: 0, baby: 0, love: 0, grown: 1,
    baseHeight: spec.height, radius: 0.4, tall: spec.height, sizeJitter: 1,
    angry: false, target: null, sighted: false, sightT: 0, taken: false,
    state: 'idle', stateT: 0, want: 0, speedNow: 0, heading: 0,
    prey: null, preyT: 0, preyChase: 0, biteT: 0, hungerT: 0, kills: 0,
    climbTo: null, perchT: 0, lungeT: 0,
    huntCooldown: 0, onPath: false, hurtT: 0, swingT: 0, knockT: 0,
    released: false, leapCool: 0, grounded: true, burnT: 0,
  };
  mobs.list.push(mob);
  return mob;
}

// --- the fourteen are hostile to husks, and to nothing else -----------------
//
// Routed through `_findPrey`, which is the door the sixteen bosses already come
// through - see `_bossPrey`. What is asserted here is the *choice*: a village
// that picked its own neighbours, or a fish, or the merchant, would be a
// faction system rather than one extra question at that door.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const person = fakeBody(mobs, folkType('b'), 1200, 1200);
  const neighbour = fakeBody(mobs, folkType('c'), 1202, 1200);
  const husk = fakeBody(mobs, 'husk', 1204, 1200);
  const cinder = fakeBody(mobs, 'cinderling', 1203, 1200);
  eq(mobs._findPrey(person), husk, 'a resident picks the husk out of the clearing');
  ok(mobs._findPrey(person) !== neighbour, 'and never a neighbour');
  ok(mobs._findPrey(person) !== cinder, 'and never the one with the fuse');
  // ...and a husk does not pick anybody. It has no prey list and is not a boss,
  // so the hunt it does is the player hunt and nothing else.
  eq(mobs._findPrey(husk), null, 'a husk hunts nothing but the player');
  eq(mobs._findPrey(cinder), null, 'and nor does a cinderling');
  // A neutral resident is what does the hunting. Anger is about the player and
  // has nothing to do with this: if it did, a peaceful village would ignore the
  // husks standing in it.
  eq(person.angry, false, 'the resident is not angry with anybody');

  // The merchant is not on the list either, which is `_bossPrey`'s own rule
  // arriving at the same answer by a different route.
  const trader = fakeBody(mobs, 'merchant', 1206, 1200);
  ok(mobs._findPrey(person) !== trader, 'and never the merchant');

  // Out of range is out of range. PREY_RANGE is 20 and not importable here.
  const far = fakeBody(mobs, 'husk', 1200 + 40, 1200);
  mobs.list.splice(mobs.list.indexOf(husk), 1);
  eq(mobs._findPrey(person), null, 'a husk on the far side of the face is nobody\'s problem');
  ok(!!far, 'and the far body was genuinely on the list');
}

// --- a husk always loses ----------------------------------------------------
//
// **Not a stat argument.** The stats are strictly better - 24 health against 21
// and a health-scaled bite that puts a husk down in two - but strictly better
// is not always: two husks on one resident, or one husk on a resident the
// player has already opened up, and the margin is gone. The guarantee is
// FOLK_FLOOR, and what follows is the simulation that says so.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const folkSpec = specOf(folkType('b'));
  const huskSpec = specOf('husk');

  // The stats, for the record, because they are the reason the floor is almost
  // never reached rather than the reason the outcome is certain.
  ok(folkSpec.health > huskSpec.health, 'a resident is tougher than a husk');
  eq(folkSpec.drops.length, 0, 'and carries nothing');

  // (a) The floor itself, hammered. Any resident health, any husk blow.
  const person = fakeBody(mobs, folkType('b'), 1300, 1300);
  const husk = fakeBody(mobs, 'husk', 1301, 1300);
  let floored = 0, dead = 0;
  for (let n = 0; n < 20000; n++) {
    person.health = 1 + Math.random() * (folkSpec.health - 1);
    // Every blow this game could ever swing at one, including ones no husk has.
    husk.spec = { ...huskSpec, damage: [1, 3, 6, 21, 999][n % 5] };
    mobs._folkRiposte(person, husk);
    if (person.health <= 0) dead++;
    if (person.health <= 1) floored++;
  }
  eq(dead, 0, '20,000 husk blows and not one of them kills a resident');
  ok(floored > 0, '...and they do get one to the brink, so the floor is live');
  husk.spec = huskSpec;

  // (b) Whole fights, driven through `_stalk` - the same chase a lion runs.
  let fights = 0, huskWins = 0, folkWins = 0, unresolved = 0, bites = 0;
  let worstHealth = folkSpec.health;
  // 300 rather than 2000. Each fight builds a fresh planet and a fresh Mobs,
  // so this loop was four minutes of wall clock on its own - long enough that
  // the suite reads as hung, and a suite nobody will wait for is a suite nobody
  // runs. 300 fights against a claim of "never" still fails loudly the moment a
  // husk can win: the riposte block above already proves the floor over 20,000
  // blows, and this block is here for the chase around it.
  for (let n = 0; n < 300; n++) {
    const arena = mobsOn(fakePlanet());
    const p = fakeBody(arena, folkType('b'), 1400, 1400);
    // A resident anywhere from untouched to one hit off death - which is the
    // case a stat margin cannot cover, because the player put it there.
    p.health = 1 + Math.floor(Math.random() * folkSpec.health);
    worstHealth = Math.min(worstHealth, p.health);
    const h = fakeBody(arena, 'husk', 1400, 1400);
    // Toe to toe, so every tick is a bite rather than a chase.
    h.position.x = p.position.x + 0.5;
    fights++;
    let ticks = 0;
    while (h.health > 0 && p.health > 0 && ticks < 4000) {
      // The bite cooldowns are ticked by `update`, not by `_stalk` - the
      // comment at the head of `_stalk` says so - and `update` cannot run here
      // (it wants a sky, a camera and a real planet). Without this the first
      // bite lands, `biteT` never comes down again, and the fight spins out its
      // four thousand ticks with both bodies standing: the failure this test
      // was written to catch, arriving as a false negative instead.
      p.biteT = Math.max(0, p.biteT - 0.05);
      arena._stalk(p, 0.05);
      ticks++;
    }
    if (p.health <= 0) huskWins++;
    else if (h.health <= 0) folkWins++;
    else unresolved++;
    bites += p.kills;
  }
  eq(fights, 300, 'three hundred whole fights');
  eq(huskWins, 0, 'and a husk won none of them');
  eq(unresolved, 0, 'every one of them ended');
  eq(folkWins, 300, '...with the resident standing');
  eq(bites, 300, 'one kill apiece, so the fights were real rather than skipped');
  eq(worstHealth, 1, 'including residents that started one hit from death');
}

// --- ...and gets nothing for it ---------------------------------------------
//
// Predation's own empty-drop path, which the boss work already put here: the
// `spoils` flag decides whether a body a mob killed leaves anything, and it is
// set from `spec.boss`. A resident is not a boss, so this is a test that the
// rule was left alone rather than a test of new code - which is the point.
{
  const planet = fakePlanet();
  let spilled = 0;
  const mobs = new Mobs({ add() {}, remove() {} }, planet,
    { spawn() { spilled++; } });
  const p = fakeBody(mobs, folkType('b'), 1500, 1500);
  const h = fakeBody(mobs, 'husk', 1500, 1500);
  h.position.x = p.position.x + 0.5;
  // The bite cooldown is ticked by `update`, which cannot run headless, so
  // without bringing it down here the first bite lands and this spins for ever.
  // It is the same trap as the fight loop above, and it is why this suite hung.
  let guard = 0;
  while (h.health > 0 && guard++ < 4000) { p.biteT = Math.max(0, p.biteT - 0.05); mobs._stalk(p, 0.05); }
  ok(guard < 4000, 'the resident finished the husk rather than spinning');
  eq(h.taken, true, 'the husk is collected');
  eq(h.spoils, false, 'and its spoils are refused');
  // The call site, copied exactly from `update`'s collection pass.
  mobs._die(h, h.spoils ? h.spec.drops : []);
  eq(spilled, 0, 'a husk a resident killed leaves nothing on the ground');

  // ...while one the player kills drops normally. The husk's table is three
  // 0-to-1 lines, so this is run enough times that "nothing ever" would show.
  let byPlayer = 0;
  for (let n = 0; n < 200; n++) {
    const solo = new Mobs({ add() {}, remove() {} }, planet,
      { spawn() { byPlayer++; } });
    const victim = fakeBody(solo, 'husk', 1550, 1550);
    solo.hurt(victim, 999, { x: 1549, y: GK + 1.5, z: 1550 }, 1);
  }
  ok(byPlayer > 0, 'while one the player killed drops what a husk drops');
  ok(specOf('husk').drops.length > 0, '...off a table that is genuinely not empty');
}

// --- and the village is still a village -------------------------------------
//
// The sanity the ask asks for in as many words: the fourteen must not get so
// busy hunting that they stop bartering or stop noticing the player. Both are
// true by construction rather than by care - the hunt is `_stalk`, which the
// update loop already runs *behind* `_hunt`, and witnessing is a shared pass on
// its own clock that reads neither - and both are cheap to pin.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  const player = fakePlayer(1900, 1900);
  const person = fakeBody(mobs, folkType('b'), 1904, 1900);
  const husk = fakeBody(mobs, 'husk', 1906, 1900);
  // Mid-hunt: it has picked the husk and is chasing it.
  person.prey = mobs._findPrey(person);
  eq(person.prey, husk, 'the resident is after a husk');
  ok(mobs.canBarter(person), '...and will still trade with you');
  // ...and still witnesses. `witnessMine` is the offence and it does not read
  // state, prey or heading anywhere.
  eq(mobs.witnessMine(idOf('stone'), player), 1, 'a resident mid-chase still sees you mine');
  eq(person.angry, true, 'and turns');
  ok(!mobs.canBarter(person), 'at which point the trading stops, as it always did');

  // An angry resident drops the husk, because the player outranks it: the
  // update loop runs `_hunt` first and `_stalk` only when it returns false.
  // Asserted at the source rather than through the loop - a `_hunt` that
  // answers true is a resident that never reaches `_stalk` this frame.
  eq(mobs._hunt(person, 0.1, 4, player), true, 'an angry one comes for you instead');
}

// --- what it costs ----------------------------------------------------------
//
// The night's work measured +0.13 ms and this is the same measurement. Two
// things were added to the tick and both are on clocks: the prey search, which
// is one pass over the list per resident per PREY_PERIOD, and the shade scan,
// which is at most five short column reads per spawn candidate.
{
  const planet = fakePlanet();
  const mobs = mobsOn(planet);
  // A full face: fourteen people, five husks, and the shade over all of it.
  folkRoster('a').forEach((id, n) => fakeBody(mobs, folkType(id), 2000 + n * 2, 2000));
  for (let n = 0; n < VERDANT_DAY_HUSKS; n++) fakeBody(mobs, 'husk', 2000 + n * 3, 2004);
  const village = mobs.list.filter((m) => m.spec.folk);
  eq(village.length, 14, 'fourteen residents on the list');

  // 250, not 4000. This block measures rather than asserts, and at 4000 it was
  // 56,000 prey passes and 40,000 shade scans - minutes of wall clock, which is
  // what made the whole suite read as hung. A per-call cost is just as visible
  // at 250, and a timing number is guidance either way: nothing here fails on it.
  const N = 250;
  let t0 = process.hrtime.bigint();
  for (let n = 0; n < N; n++) for (const m of village) mobs._findPrey(m);
  const preyMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

  for (const [dx, dy] of [[0, 0], [SHADE_STEP, 0], [-SHADE_STEP, 0]]) {
    planet.put(2100 + dx, 2100 + dy, GK + 5, GK + 7, idOf('leaves_oak'));
  }
  const shadeCol = 2100 * W + 2100;
  t0 = process.hrtime.bigint();
  // `_shadedRaw`: the memo would make this measure a Map lookup.
  for (let n = 0; n < N * 10; n++) mobs._shadedRaw(shadeCol, GK);
  const shadeMs = Number(process.hrtime.bigint() - t0) / 1e6 / (N * 10);

  // A full prey pass for the whole village happens at most once per
  // PREY_PERIOD (1.6 s), and the spawn search runs VERDANT_TRIES (60) shade
  // scans at most once per SPAWN_PERIOD (2 s).
  //
  // The 60 are not 60 distinct scans, though: `_shaded` memoises per tick, and
  // the search walks a lattice that keeps landing on columns it has already
  // asked about. Measured over a real search the memo answers roughly two in
  // three, so the honest worst case for the raw work is a third of them. The
  // raw cost is what is measured above, deliberately - a benchmark that timed
  // the cache would be measuring a Map lookup and would report a number this
  // face could never actually achieve.
  const perSecond = preyMs / 1.6 + shadeMs * 20 / 2;
  console.log(`  verdant day: prey pass ${preyMs.toFixed(4)} ms/village-pass, `
    + `shade ${(shadeMs * 1000).toFixed(2)} us/scan, ${perSecond.toFixed(4)} ms/s of play`);
  ok(perSecond < 0.13, 'the day costs less per second than the night\'s measured +0.13 ms');
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
// ...and nineteen more for the night, nineteen caught:
//
// 17  `_folkTopUp` drops the night stand-down             caught (it searches)
// 18  `_verdantRetire` drops the VERDANT_HIDE floor       caught (chaser)
// 19  `_verdantRetire` drops `_unobserved`                caught (in view)
// 20  `_verdantRetire` takes the nearest                  caught
// 21  `_verdantRetire` drops the linger clock             caught (chaser)
// 22  `_verdantRetire` takes everyone at once             caught (stagger)
// 23  `FOLK_BODY` matches every body                      caught (husk taken)
// 24  `NIGHT_BODY` reads `spec.hostile` instead           caught (person taken)
// 25  `toJSON` writes a night body                        caught
// 26  `_verdantDawn` drops `calmFolk`                     caught
// 27  `_verdantDawn` drops `onFolkDawn`                   caught (barter)
// 28  `_floorUnderCanopy` drops its `IS_SOLID` term       caught (mid-air)
// 29  `_findVerdantColumn` uses `surfaceK`                caught (no ground)
// 30  `_placeUnseen` drops the frame test                 caught
// 31  `_findVerdantColumn` drops the face test            caught (off-face)
// 32  `verdantNightDraw`'s comparison is reversed         caught (order)
// 33  VERDANT_CINDER raised to 14                         caught (mix)
// 34  VERDANT_HIDE lowered under STALKER_VANISH           caught
// 35  VERDANT_GROUND is grass and sand only               caught
//
// Discarded rather than counted: dropping the `blockId > 0` guard in `isTaboo`,
// and starting the `TABOO` loop at 0 instead of 1. Both are equivalent
// mutations - air is block 0 and each of those two lines alone is enough to
// keep it out - so neither can be caught by any test, and counting a pair of
// belt-and-braces guards as two escapes would be counting the wrong thing.
