// Asserts that the player moves under ONE gravity on a flat wrapped map.
// `node src/player/Player.test.mjs`.
//
// `Grid.test.mjs` is the template and the reason this exists: the game will not
// boot until every stage of the nine-face conversion has landed, so the only
// way to know the body is right is to assert it directly. The planet is a hand
// built fake - a Set of solid cells - because none of what is being checked is
// about terrain.

import * as THREE from 'three';
import {
  W, D, F, wrap, delta, colIndex, cellIndex, isWall, isSealed, faceAt,
  SEALED, DIR_STEP, faceStep, portalsOf,
} from '../world/Grid.js';
import { GRAVITY } from '../world/Constants.js';
import { ID } from '../world/Blocks.js';
import { Player, HEIGHT } from './Player.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const eq = (a, b, what) => ok(a === b, `${what}: got ${a}, want ${b}`);
const near = (a, b, eps, what) => ok(Math.abs(a - b) <= eps,
  `${what}: got ${a}, want ${b} +-${eps}`);

// --- the fake planet -------------------------------------------------------
//
// `at(col, k)` is the only read the solver makes about a block, plus `facingAt`
// for shaped ones and `liquidAt` for wading. A Set of `cellIndex` values is
// enough for every case below, and building it through `cellIndex` means the
// test addresses cells exactly the way the real storage does.

class FakePlanet {
  constructor() {
    this.solid = new Set();
    this.liquid = new Set();
    /** Every column is floored below this layer. -1 for no floor at all. */
    this.floorTop = -1;
    this.walled = false;
  }

  /** Fill layers 0..k-1 of every column, so `floorTop` is the walkable surface. */
  groundTo(k) { this.floorTop = k; return this; }

  /**
   * Put the real dividers in: every `Grid.isWall` column is portal from layer 0
   * to layer D and holds nothing else, which is exactly what `WorldGen.fillWall`
   * builds and what `WorldGen.test.mjs` asserts it builds.
   */
  dividers() { this.walled = true; return this; }

  /** A full-height column of stone at (x, y). */
  pillar(x, y) {
    for (let k = 0; k < D; k++) this.solid.add(cellIndex(x, y, k));
    return this;
  }

  fill(x, y, k, id = ID.stone) {
    if (id === ID.water) this.liquid.add(cellIndex(x, y, k));
    else this.solid.add(cellIndex(x, y, k));
    return this;
  }

  at(col, k) {
    if (k < 0 || k >= D) return 0;
    if (this.walled) {
      const y = col % W;
      if (isWall((col - y) / W, y)) return ID.portal;
    }
    const i = col * D + k;
    if (this.solid.has(i)) return ID.stone;
    if (this.liquid.has(i)) return ID.water;
    return k < this.floorTop ? ID.stone : 0;
  }

  liquidAt(col, k) { return this.at(col, k) === ID.water; }
  facingAt() { return 0; }
  raycast() { return null; }
}

/** Keys held this frame. */
const keys = (...held) => ({ down: (code) => held.includes(code) });
const NONE = keys();

/** A player standing on a floor whose top is at layer `top`. */
function standing(planet, x, z, top) {
  const p = new Player(planet);
  p.setPosition(x, top, z);
  p.grounded = true;
  return p;
}

/** Yaw that makes `forward` the given horizontal unit vector. */
const YAW_EAST = -Math.PI / 2;    // forward = (+1, 0, 0)
const YAW_SOUTH = Math.PI;        // forward = (0, 0, +1)

// --- up, and gravity -------------------------------------------------------
{
  const planet = new FakePlanet();
  const p = new Player(planet);
  p.setPosition(600.5, 40, 600.5);

  eq(p.up.x, 0, 'up x');
  eq(p.up.y, 1, 'up y');
  eq(p.up.z, 0, 'up z');

  // In free air with no steering, gravity is the ONLY thing that changes the
  // velocity, and it changes exactly one component of it.
  const x0 = p.position.x, z0 = p.position.z;
  p.update(1 / 60, NONE);
  eq(p.vel.x, 0, 'gravity does not push on X');
  eq(p.vel.z, 0, 'gravity does not push on Z');
  ok(p.vel.y < 0, 'gravity pulls down');
  near(p.vel.y, -GRAVITY / 60, 1e-9, 'gravity is exactly -GRAVITY per second');
  eq(p.position.x, x0, 'falling does not move you on X');
  eq(p.position.z, z0, 'falling does not move you on Z');
  ok(p.position.y < 40, 'falling moves you down');

  // Up stays up wherever on the map you are: this is the whole conversion.
  for (const [x, z] of [[0.5, 0.5], [W - 0.5, W - 0.5], [416.5, 832.5], [1247.5, 3.5]]) {
    p.setPosition(x, 40, z);
    p.update(1 / 60, NONE);
    ok(p.up.x === 0 && p.up.y === 1 && p.up.z === 0, `up is +Y at ${x},${z}`);
    ok(p.vel.x === 0 && p.vel.z === 0, `no sideways drift at ${x},${z}`);
  }
}

// --- walking off the east edge ---------------------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, W - 4.5, 600.5, 34);
  p.yaw = YAW_EAST;
  p._updateForward();
  near(p.forward.x, 1, 1e-12, 'YAW_EAST faces +X');
  near(p.forward.z, 0, 1e-12, 'YAW_EAST has no Z');

  let travelled = 0, biggest = 0, wrapped = false;
  let prev = p.position.x;
  for (let n = 0; n < 240; n++) {
    p.update(1 / 60, keys('KeyW'));
    const d = delta(prev, p.position.x);
    travelled += d;
    biggest = Math.max(biggest, Math.abs(d));
    if (p.position.x < prev) wrapped = true;
    prev = p.position.x;
  }
  ok(wrapped, 'walking east ran off the edge and came back at x = 0');
  ok(p.position.x >= 0 && p.position.x < W, 'x stayed on the map');
  ok(p.position.x < 20, 'and landed near the west edge');
  ok(travelled > 8, `covered ground going east: ${travelled.toFixed(2)} cells`);
  // Continuity: no single frame may jump. At 4.4 cells/s a frame is 0.073, so
  // anything over half a cell is a teleport rather than a step.
  ok(biggest < 0.5, `no frame teleported, worst step ${biggest.toFixed(4)}`);
  near(p.position.y, 34, 1e-3, 'stayed on the floor across the wrap');
  ok(p.grounded, 'still grounded after wrapping');
  eq(p.cell.x, Math.floor(p.position.x), 'cell.x follows the position');
  eq(p.cell.y, Math.floor(p.position.z), 'cell.y is the map y, i.e. world Z');
}

// --- walking off the south edge --------------------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, 600.5, W - 4.5, 34);
  p.yaw = YAW_SOUTH;
  p._updateForward();
  near(p.forward.z, 1, 1e-12, 'YAW_SOUTH faces +Z');
  near(p.forward.x, 0, 1e-12, 'YAW_SOUTH has no X');

  let travelled = 0, biggest = 0, wrapped = false;
  let prev = p.position.z;
  for (let n = 0; n < 240; n++) {
    p.update(1 / 60, keys('KeyW'));
    const d = delta(prev, p.position.z);
    travelled += d;
    biggest = Math.max(biggest, Math.abs(d));
    if (p.position.z < prev) wrapped = true;
    prev = p.position.z;
  }
  ok(wrapped, 'walking south ran off the edge and came back at y = 0');
  ok(p.position.z >= 0 && p.position.z < W, 'z stayed on the map');
  ok(p.position.z < 20, 'and landed near the north edge');
  ok(travelled > 8, `covered ground going south: ${travelled.toFixed(2)} cells`);
  ok(biggest < 0.5, `no frame teleported, worst step ${biggest.toFixed(4)}`);
  near(p.position.y, 34, 1e-3, 'stayed on the floor across the wrap');
}

// --- a jump comes back to the height it left --------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, 600.5, 600.5, 34);
  const y0 = p.position.y;
  // Settle, so the first frame of the jump is an ordinary standing frame.
  for (let n = 0; n < 10; n++) p.update(1 / 60, NONE);
  near(p.position.y, y0, 1e-3, 'standing still does not sink or rise');
  ok(p.grounded, 'standing on the floor counts as grounded');

  p.update(1 / 60, keys('Space'));
  ok(!p.grounded, 'Space leaves the ground');
  ok(p.vel.y > 0, 'Space pushes up, not down');

  let peak = p.position.y, frames = 0;
  while (!p.grounded && frames < 600) { p.update(1 / 60, NONE); peak = Math.max(peak, p.position.y); frames++; }
  ok(frames < 600, 'the jump ended');
  ok(peak > y0 + 1.2, `the jump cleared a block: ${(peak - y0).toFixed(2)}`);
  near(p.position.y, y0, 1e-3, 'the jump came back to the height it left');
  eq(p.health, 20, 'a jump is not a fall');
  near(p.position.x, 600.5, 1e-9, 'a straight jump does not drift on X');
  near(p.position.z, 600.5, 1e-9, 'a straight jump does not drift on Z');
}

// --- a solid column stops you ----------------------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const WALL = 604;
  planet.pillar(WALL, 600);
  const p = standing(planet, 600.5, 600.5, 34);
  p.yaw = YAW_EAST;
  p._updateForward();
  for (let n = 0; n < 240; n++) p.update(1 / 60, keys('KeyW'));

  ok(p.position.x < WALL, 'stopped before the wall');
  near(p.position.x, WALL - 0.34, 1e-2, 'stopped flush against it, a box half-width short');
  near(p.vel.x, 0, 1e-6, 'and lost the velocity that was carrying you into it');
  near(p.position.y, 34, 1e-3, 'a wall does not lift you');
  eq(p.crouching, false, 'and does not leave you crouched');
}

// The same wall, met across the wrap. A divider stands on face boundaries and
// the map's own outer edge is one; a body walking into it must be stopped by
// ordinary collision and nothing else.
{
  const planet = new FakePlanet().groundTo(34);
  planet.pillar(0, 600);
  const p = standing(planet, W - 3.5, 600.5, 34);
  p.yaw = YAW_EAST;
  p._updateForward();
  for (let n = 0; n < 240; n++) p.update(1 / 60, keys('KeyW'));
  near(p.position.x, W - 0.34, 1e-2, 'stopped by a wall standing at x = 0, from x = W - 1');
  near(p.vel.x, 0, 1e-6, 'velocity lost against the wrapped wall');
}

// --- strafing ---------------------------------------------------------------
//
// Facing east, D goes south. `right` is `forward x up` and there is exactly one
// up, so this is the whole of the steering basis.
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, 600.5, 600.5, 34);
  p.yaw = YAW_EAST;
  p._updateForward();
  for (let n = 0; n < 30; n++) p.update(1 / 60, keys('KeyD'));
  ok(p.position.z > 600.5, 'D while facing east walks you south');
  near(p.position.x, 600.5, 1e-6, 'and not forwards');

  const q = standing(planet, 600.5, 600.5, 34);
  q.yaw = YAW_EAST;
  q._updateForward();
  for (let n = 0; n < 30; n++) q.update(1 / 60, keys('KeyA'));
  ok(q.position.z < 600.5, 'A while facing east walks you north');

  const r = standing(planet, 600.5, 600.5, 34);
  r.yaw = 0;                       // facing -Z
  r._updateForward();
  for (let n = 0; n < 30; n++) r.update(1 / 60, keys('KeyD'));
  ok(r.position.x > 600.5, 'D while facing north walks you east');
}

// --- the feet read their own column, on the right axes ----------------------
//
// One column of water and nothing else, so a solver that had x and y the wrong
// way round would be standing dry in it.
{
  const planet = new FakePlanet().groundTo(30);
  for (let k = 30; k < 36; k++) planet.fill(610, 600, k, ID.water);

  const wet = new Player(planet);
  wet.setPosition(610.5, 32, 600.5);
  wet.update(1 / 60, NONE);
  ok(wet.inWater, 'standing in the water column is standing in water');

  const dry = new Player(planet);
  dry.setPosition(600.5, 32, 610.5);
  dry.update(1 / 60, NONE);
  eq(dry.inWater, false, 'the column with x and y swapped is dry');
  eq(dry.headInWater, false, 'and so is the head above it');
}

// --- spawning ---------------------------------------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = new Player(planet);
  p.spawnAtColumn(colIndex(700, 900), 33);
  near(p.position.x, 700.5, 1e-9, 'spawn lands on the column x');
  near(p.position.z, 900.5, 1e-9, 'and on the column y, which is world Z');
  ok(p.position.y > 33 && p.position.y < 36, 'standing on top of layer 33');
  eq(p.cell.x, 700, 'cell.x');
  eq(p.cell.y, 900, 'cell.y');
  eq(p.fallStart, null, 'arriving somewhere is not falling');
  eq(p.vel.x, 0, 'and carries no momentum on X');
  eq(p.vel.y, 0, 'nor on Y');
  eq(p.vel.z, 0, 'nor on Z');
  // Settle: the spawn must be able to stand where it was put.
  for (let n = 0; n < 30; n++) p.update(1 / 60, NONE);
  ok(p.grounded, 'and it can stand there');
  eq(p.health, 20, 'without being charged for the 0.02 of a block it settled');
}

// --- a blow from across the wrap shoves you the short way --------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, W - 2.5, 600.5, 34);
  // The husk is at x = 1.5, three cells EAST of the player through the seam.
  // Raw subtraction would put it 1245 cells west and shove the player the wrong
  // way round the world.
  p.knockback(1.5, 34, 600.5, 5);
  ok(p.knockX < 0, `a blow from across the wrap shoves you west: ${p.knockX.toFixed(2)}`);
  near(Math.hypot(p.knockX, p.knockZ), 5, 1e-6, 'at the strength it was given');
  eq(delta(p.position.x, 1.5), 4, 'and the attacker really is 4 cells away the short way');
}

// --- falling costs health, and height is world Y ----------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = new Player(planet);
  p.setPosition(600.5, 44, 600.5);
  let frames = 0;
  while (!p.grounded && frames < 600) { p.update(1 / 60, NONE); frames++; }
  ok(p.grounded, 'the fall ended on the floor');
  near(p.position.y, 34, 1e-2, 'and ended at the top of it');
  // Ten blocks, three of them free, one half-heart a block.
  eq(p.health, 13, 'fall damage is measured in world Y, not in a radius');

  // A short drop is free, wherever on the map it happens.
  const q = new Player(planet);
  q.setPosition(2.5, 36, W - 2.5);
  for (let n = 0; n < 600 && !q.grounded; n++) q.update(1 / 60, NONE);
  eq(q.health, 20, 'two blocks is a free fall at the map corner too');
}

// --- swimming ---------------------------------------------------------------
{
  const planet = new FakePlanet().groundTo(30);
  for (let k = 30; k <= 40; k++) for (let x = 598; x <= 603; x++) {
    for (let y = 598; y <= 603; y++) planet.fill(x, y, k, ID.water);
  }
  const p = new Player(planet);
  p.setPosition(600.5, 36, 600.5);
  p.update(1 / 60, NONE);
  ok(p.inWater, 'the feet are in water');
  ok(p.headInWater, 'and so is the head');
  eq(p.inLava, false, 'water is not lava');
  const sank = p.position.y;
  // Buoyancy: water gravity is 22% of dry, so a frame of it falls far less.
  ok(36 - sank < GRAVITY / 3600, 'water breaks the fall');
  for (let n = 0; n < 60; n++) p.update(1 / 60, keys('Space'));
  ok(p.position.y > sank, 'Space swims up');
}

// --- the map is not a sphere ------------------------------------------------
//
// A guard against the bug class this stage exists to delete: nothing may treat
// the position as a direction, so a body on one ordinary face and a body on
// another must behave identically. All four points are on cross faces (2, 4, 5,
// 6), which share a FACE_PHYSICS row - Rime and Pyre differ on purpose, and
// there is a test for that below.
{
  const runs = [];
  for (const [x, z] of [[600.5, 600.5], [100.5, 600.5], [600.5, 100.5], [W - 0.5, 600.5]]) {
    const planet = new FakePlanet().groundTo(34);
    const p = standing(planet, x, z, 34);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 60; n++) p.update(1 / 60, keys('KeyW', 'Space'));
    runs.push([p.position.y, Math.hypot(p.vel.x, p.vel.z)]);
  }
  for (let n = 1; n < runs.length; n++) {
    near(runs[n][0], runs[0][0], 1e-9, `same height wherever you stand (run ${n})`);
    near(runs[n][1], runs[0][1], 1e-9, `same speed wherever you stand (run ${n})`);
  }
}

// --- the camera -------------------------------------------------------------
{
  const planet = new FakePlanet().groundTo(34);
  const p = standing(planet, 600.5, 600.5, 34);
  const cam = new THREE.PerspectiveCamera(75, 1.6, 0.06, 1000);

  p.yaw = YAW_EAST; p.pitch = 0; p._updateForward();
  p.updateCamera(cam, 1 / 60, 75, false);
  near(p.lookDir.x, 1, 1e-9, 'looking east looks +X');
  near(p.lookDir.y, 0, 1e-9, 'and level');
  near(p.eye.y - p.position.y, p.eyeHeight, 1e-9, 'the eye is straight above the feet');
  near(p.eye.x, p.position.x, 1e-9, 'and not beside them');

  p.pitch = 0.5;
  p.updateCamera(cam, 1 / 60, 75, false);
  ok(p.lookDir.y > 0, 'a positive pitch looks up');
  p.pitch = -0.5;
  p.updateCamera(cam, 1 / 60, 75, false);
  ok(p.lookDir.y < 0, 'a negative pitch looks down');

  // The camera is never rolled: with up fixed at +Y its right vector stays
  // level whatever the pitch and wherever on the map the body is.
  for (const [x, z] of [[0.5, 0.5], [600.5, 600.5], [W - 0.5, W - 0.5]]) {
    p.setPosition(x, 34, z);
    for (const pitch of [-1.2, 0, 1.2]) {
      p.pitch = pitch;
      p.updateCamera(cam, 1 / 60, 75, false);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      near(right.y, 0, 1e-9, `camera is level at ${x},${z} pitch ${pitch}`);
    }
  }
}

// --- look ------------------------------------------------------------------
{
  const p = new Player(new FakePlanet());
  p.yaw = 0; p._updateForward();
  near(p.forward.z, -1, 1e-12, 'yaw 0 faces -Z');
  // A quarter turn right, the way the mouse drives it.
  p.look(Math.PI / 2, 0, 1, false);
  near(p.forward.x, 1, 1e-9, 'dragging right turns you east');
  // Pitch clamps and never flips. `dy` is screen down, so with invertY off it
  // lowers the pitch.
  for (let n = 0; n < 200; n++) p.look(0, 1, 1, false);
  ok(p.pitch > -Math.PI / 2 && p.pitch < -1.5, 'pitch clamps above straight down');
  for (let n = 0; n < 400; n++) p.look(0, -1, 1, false);
  ok(p.pitch < Math.PI / 2 && p.pitch > 1.5, 'pitch clamps below straight up');
  p.look(0, 0, 1, false);
  ok(p.pitch < Math.PI / 2, 'and stays clamped');
  // Yaw is kept inside a turn however far you spin.
  for (let n = 0; n < 1000; n++) p.look(1, 0, 1, false);
  ok(p.yaw >= 0 && p.yaw < Math.PI * 2, 'yaw stays inside one turn');
  near(Math.hypot(p.forward.x, p.forward.z), 1, 1e-9, 'forward stays a unit vector');
  eq(p.forward.y, 0, 'and stays horizontal');
}

// --- the cell is the position ----------------------------------------------
{
  const p = new Player(new FakePlanet());
  for (const [x, y, z] of [[0.1, 5.9, 0.1], [W - 0.1, 0.5, W - 0.1], [416.7, 33.5, 832.2]]) {
    p.setPosition(x, y, z);
    eq(p.cell.x, Math.floor(x), `cell.x at ${x}`);
    eq(p.cell.y, Math.floor(z), `cell.y is world Z at ${z}`);
    eq(p.cell.k, Math.floor(y), `cell.k is world Y at ${y}`);
  }
  // Set past the edge and it comes back onto the map rather than off it.
  p.setPosition(W + 3.5, 20, -2.5);
  eq(p.position.x, 3.5, 'a position past the east edge wraps');
  eq(p.position.z, W - 2.5, 'a negative map y wraps');
  eq(p.cell.x, 3, 'and the cell follows');
  eq(p.cell.y, W - 3, 'on both axes');
  eq(colIndex(p.cell.x, p.cell.y), colIndex(3, W - 3), 'to the column Grid names');
}

// --- no radius anywhere -----------------------------------------------------
//
// A source-level assertion, and the cheapest guard there is against the leftover
// that turned up seven times in the cube conversion and an eighth in the
// whirlpool.
{
  const src = await (await import('node:fs/promises')).readFile(
    new URL('./Player.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of [
    'R_MIN', 'PLANET_R', 'viewUp', 'tangentFrame', 'normalizeCell', 'carryYaw',
    // FACE_ROLE is deliberately NOT on this list: it survived the conversion as
    // a face-label table indexed 1..9 by Grid's face number, which is what the
    // per-face physics is supposed to be keyed by. What was deleted is its use
    // as a cube role, and there is no cube role left to name.
    'faceUp', 'faceMayChange', 'dirFromYawPitch', '_crossOffset',
    'sameFaceStep', 'cidx', 'vidx', 'Sphere', 'Cube', '_standOnArrival',
    '_toCellVelocity', '_toWorldVelocity', 'arcA', 'arcB',
  ]) {
    ok(!new RegExp(`\\b${bad}\\b`).test(code), `no ${bad} left in Player.js`);
  }
  ok(!/position\.length\(\)/.test(code), 'the position is never read as a radius');
  ok(!/\.normalize\(\)/.test(code.replace(/this\.lookDir\.normalize\(\)/g, '')),
    'the only normalize left is the look direction');
}

// --- the two dedicated faces keep their physics -----------------------------
//
// Keyed by the face LABEL now, not by a cube role. Rime is face 1 and Pyre is
// face 9, so the labels come straight out of `Grid.faceAt`.
{
  const walkOn = (x, z) => {
    const planet = new FakePlanet().groundTo(34);
    const p = standing(planet, x, z, 34);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 120; n++) p.update(1 / 60, keys('KeyW'));
    return Math.hypot(p.vel.x, p.vel.z);
  };
  const jumpOn = (x, z) => {
    const planet = new FakePlanet().groundTo(34);
    const p = standing(planet, x, z, 34);
    for (let n = 0; n < 5; n++) p.update(1 / 60, NONE);
    p.update(1 / 60, keys('Space'));
    let peak = p.position.y;
    for (let n = 0; n < 600 && !p.grounded; n++) { p.update(1 / 60, NONE); peak = Math.max(peak, p.position.y); }
    return peak - 34;
  };
  const ordinary = walkOn(600.5, 600.5);            // face 5, Solace
  near(ordinary, 4.4, 0.05, 'an ordinary face walks at 4.4');
  near(walkOn(200.5, 200.5), 4.4 / 1.5, 0.05, 'Rime is heavy going');       // 1
  near(walkOn(1000.5, 200.5), 4.4 * 1.25, 0.05, 'Tempest will not let you stand'); // 3
  near(walkOn(200.5, 1000.5), 4.4 / 1.3, 0.05, 'Verdant is undergrowth');   // 7
  near(walkOn(1000.5, 1000.5), 4.4, 0.05, 'Pyre walks at the ordinary rate'); // 9
  const ordJump = jumpOn(600.5, 600.5);
  ok(jumpOn(1000.5, 1000.5) > ordJump * 1.7, 'Pyre jumps about twice as high');
  near(jumpOn(200.5, 200.5), ordJump, 1e-6, 'Rime jumps like anywhere else');
}

// --- the dividers are portals, and you walk through them --------------------
//
// **The divider IS the portal.** Every column of it is a portal block from
// layer 0 to layer D: opaque, so the sealed face stays unseen, and NOT solid,
// so a body walks into it. What has to be true is that the body comes out the
// far side standing on the ground, because the alternative is not "it bumps
// into a wall", it is a fall the whole depth of the world down a column that
// has nothing solid in it.
//
// Face 1 (Rime) is the sealed face at the map origin. Its EAST edge, x = F - 1,
// divides it from face 2, which is cross: one wall column between two open
// ones. Its NORTH edge, y = 0, is back to back with face 7's south edge, so
// that crossing is two wall columns wide. Both are passable - the owner's call
// that every side of a sealed face must let you out.
{
  const EAST = F - 1;               // the divider column between face 1 and 2
  const GROUND = 34;
  const inside = (x, z) => faceAt(Math.floor(x), Math.floor(z));

  /**
   * Walk `key` until the face under the feet changes, or `n` frames.
   *
   * It stops on the crossing rather than running the clock out, so the position
   * it reports is where the portal PUT you and not where you had walked on to
   * afterwards.
   */
  const walk = (x0, z0, yaw, key, n = 400) => {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    const p = standing(planet, x0, z0, GROUND);
    p.yaw = yaw;
    p._updateForward();
    const f0 = p.face;
    for (let i = 0; i < n && p.face === f0; i++) p.update(1 / 60, keys(key));
    return p;
  };

  // The sanity check the rest of this rests on: the divider really is there and
  // really is not solid.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    eq(planet.at(colIndex(EAST, 200), 0), ID.portal, 'a divider column is portal at bedrock');
    eq(planet.at(colIndex(EAST, 200), D - 1), ID.portal, 'and portal at the ceiling');
    eq(planet.at(colIndex(EAST + 1, 200), 60), 0, 'and the cross beside it is open air');
  }

  // Out of the sealed face, into the world.
  {
    const p = walk(EAST - 2.5, 200.5, YAW_EAST, 'KeyW');
    eq(inside(p.position.x, p.position.z), 2, 'walking east out of Rime lands you on face 2');
    ok(!isWall(p.cell.x, p.cell.y), 'and not inside the divider');
    near(p.position.y, GROUND + 0.0001, 0.02, 'standing on the far surface, not falling through it');
    ok(p.grounded, 'and grounded');
    near(p.position.x, EAST + 1.5, 0.6, 'one column beyond the divider, not two');
  }

  // ...and back in again, from the other side. Same divider, opposite entry.
  {
    const p = walk(EAST + 3.5, 200.5, YAW_EAST + Math.PI, 'KeyW');
    eq(inside(p.position.x, p.position.z), 1, 'walking west off face 2 lands you in Rime');
    ok(!isWall(p.cell.x, p.cell.y), 'and not inside the divider');
    near(p.position.y, GROUND + 0.0001, 0.02, 'standing on Rime, not in it');
  }

  // Backwards. The transit must read where you came FROM, not where you are
  // looking: face west, press S, and you still travel east.
  {
    const p = walk(EAST - 2.5, 200.5, YAW_EAST + Math.PI, 'KeyS');
    eq(inside(p.position.x, p.position.z), 2, 'walking in backwards works');
    near(p.yaw, YAW_EAST + Math.PI, 1e-9, 'and your heading is not touched');
  }

  // Falling in. A body that steps off a ledge into a divider has to arrive on
  // the ground, not keep the fall it was already in.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    const p = new Player(planet);
    p.setPosition(EAST - 1.5, GROUND + 20, 200.5);
    p.yaw = YAW_EAST; p._updateForward();
    for (let i = 0; i < 200; i++) p.update(1 / 60, keys('KeyW'));
    eq(inside(p.position.x, p.position.z), 2, 'falling into a divider still puts you through it');
    ok(p.position.y >= GROUND - 0.01, 'and on the ground rather than under it');
  }

  // Swimming in. The far column is a sea: the arrival is the BED, which is what
  // "seat them on the far column's actual surface" means when the surface has
  // water over it, and the body then floats.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    for (let x = EAST + 1; x < EAST + 8; x++) {
      for (let k = GROUND; k < GROUND + 6; k++) planet.fill(x, 200, k, ID.water);
    }
    const p = standing(planet, EAST - 2.5, 200.5, GROUND);
    p.yaw = YAW_EAST; p._updateForward();
    for (let i = 0; i < 200; i++) p.update(1 / 60, keys('KeyW'));
    eq(inside(p.position.x, p.position.z), 2, 'swimming out of Rime works too');
    ok(!isWall(p.cell.x, p.cell.y), 'and does not leave you in the divider');
    ok(p.position.y >= GROUND - 0.01 && p.position.y < D - 1,
      `and puts you on the bed, not through it (y = ${p.position.y.toFixed(2)})`);
  }

  // The far side stands higher than the near side. This is the assertion the
  // two gate cuts before this both failed on, in the other direction: what a
  // player stands on is the top of the actual voxels, so an arrival taken from
  // anything else - the height you walked in at, a height field - buries you in
  // the far face or leaves you falling down its cliff.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    for (let x = EAST + 1; x < EAST + 8; x++) {
      for (let z = 190; z < 215; z++) {
        for (let k = GROUND; k < GROUND + 6; k++) planet.fill(x, z, k);
      }
    }
    const p = standing(planet, EAST - 2.5, 200.5, GROUND);
    p.yaw = YAW_EAST; p._updateForward();
    const f0 = p.face;
    for (let i = 0; i < 400 && p.face === f0; i++) p.update(1 / 60, keys('KeyW'));
    eq(inside(p.position.x, p.position.z), 2, 'you cross onto a face that stands six layers higher');
    near(p.position.y, GROUND + 6.0001, 0.02,
      `and arrive on top of it (y = ${p.position.y.toFixed(2)})`);
    ok(!p._blocked(p.position.x, p.position.z, p.position.y, HEIGHT), 'not inside the rock');

    // ...and the transit itself put them there, not the escape hatch that runs
    // after it. `_escape` would lift a buried box out on the next frame, which
    // is a safety net and not the answer: it would read as being spat upward
    // out of the ground. Asked of `_portalTransit` alone, with nothing after it.
    const q = new Player(planet);
    q.setPosition(EAST - 1 + 0.5, GROUND + 0.0001, 200.5);
    q._sync();
    q.position.x = EAST + 0.5;
    q._sync();
    ok(q._portalTransit(HEIGHT), 'the transit fires');
    near(q.position.y, GROUND + 6.0001, 1e-6, 'and seats the body itself');
  }

  // Momentum survives. You come out of a portal still running.
  {
    const p = walk(EAST - 4.5, 200.5, YAW_EAST, 'KeyW');
    ok(p.vel.x > 1, `you keep your momentum through (vel.x = ${p.vel.x.toFixed(2)})`);
  }

  // The double wall: face 1's north edge is back to back with face 7's south
  // edge, so the step is near interior, wall, wall, far interior. It used to be
  // refused. It carries you now, and it must land you in Verdant's interior -
  // not on the second wall column, which is a shaft with no floor in it.
  {
    const p = walk(200.5, 2.5, YAW_EAST + Math.PI / 2, 'KeyW');   // north is -z
    eq(inside(p.position.x, p.position.z), 7, 'walking north out of Rime lands you in Verdant');
    ok(!isWall(p.cell.x, p.cell.y), 'and not inside either wall column');
    near(p.position.z, W - 1.5, 0.6, 'two columns beyond, not one');
    near(p.position.y, GROUND + 0.0001, 0.02, 'standing on the far surface');
    ok(p.grounded, 'and grounded');
  }

  // ...and back the other way through the same pair.
  {
    const p = walk(200.5, W - 2.5, YAW_EAST - Math.PI / 2, 'KeyW');   // south is +z
    eq(inside(p.position.x, p.position.z), 1, 'and south out of Verdant lands you in Rime');
    ok(!isWall(p.cell.x, p.cell.y), 'and not inside either wall column');
    near(p.position.z, 1.5, 0.6, 'two columns beyond, not one');
    near(p.position.y, GROUND + 0.0001, 0.02, 'standing on the far surface');
  }

  // A double wall reads its near side from the column, not from the traveller,
  // so a body that was PUT inside one - a load, a knockback - still comes out
  // the side it was not on, with no velocity and no history to read.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    const q = new Player(planet);
    q.setPosition(200.5, GROUND + 0.0001, 0.5);   // Rime's north ring, from nowhere
    q.vel.x = 0; q.vel.y = 0; q.vel.z = 0;
    q._freeX = 200.5; q._freeZ = 0.5;             // no near side to read at all
    q._sync();
    ok(q._portalTransit(HEIGHT), 'a body inside a double wall is still let through');
    eq(faceAt(q.cell.x, q.cell.y), 7, 'and out the open side, into Verdant');
    ok(!isWall(q.cell.x, q.cell.y), 'not left in the wall');
  }

  // The corners of a ring. The strict rule refuses them - the ring turns, so
  // the column is walled on both axes - and the owner's report is that a portal
  // which works all the way along a run stops working at its end. It lets you
  // OUT of a sealed face by whichever side is open, and never in: both of a
  // corner's inward neighbours are ring columns, so there is nothing inward to
  // let anyone through to.
  {
    /** Stand at `from`, then step into `to`, and ask the transit alone. */
    const step = (fromX, fromZ, toX, toZ) => {
      const planet = new FakePlanet().groundTo(GROUND).dividers();
      const p = new Player(planet);
      p.setPosition(fromX, GROUND + 0.0001, fromZ);
      p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
      p._sync();
      p.position.x = toX; p.position.z = toZ;
      p._sync();
      p.moved = p._portalTransit(HEIGHT);
      return p;
    };

    // Rime's south-east corner, met on the diagonal from inside. Both ways out
    // are the cross, and either is a correct answer.
    {
      const p = step(F - 2.5, F - 2.5, F - 0.5, F - 0.5);
      ok(p.moved, 'a ring corner lets you through');
      ok(inside(p.position.x, p.position.z) !== 1, 'and out of Rime');
      ok(!isWall(p.cell.x, p.cell.y), 'not left standing in the divider');
      near(p.position.y, GROUND + 0.0001, 0.02, 'standing on the far surface');
    }

    // The same corner from the cross side. There is nowhere to put you - the
    // step inward is the ring turning the corner - so you are pushed back out,
    // and above all you are not dropped inside Rime.
    {
      const p = step(F + 0.5, F - 0.5, F - 0.5, F - 0.5);
      ok(!p.moved, 'and refuses to let you in at one');
      eq(inside(p.position.x, p.position.z), 2, 'you stay on the face you came from');
      ok(!isWall(p.cell.x, p.cell.y), 'and not inside the divider');
    }

    // The corner where four rings meet: no open side at all, from any of them.
    {
      const p = step(1.5, 1.5, 0.5, 0.5);
      ok(!p.moved, 'the corner of the map is not a way through');
      eq(inside(p.position.x, p.position.z), 1, 'and leaves you where you were');
      ok(!isWall(p.cell.x, p.cell.y), 'and not inside the divider');
      ok(p.position.y >= GROUND - 0.01, 'nor drops you down it');
    }

    // Every ring corner in the world, walked into from inside its own face on
    // the diagonal. Twelve of the sixteen open onto the cross; the four at the
    // corners of the map do not.
    {
      let through = 0, blocked = 0, bad = 0;
      for (const f of [1, 3, 7, 9]) {
        const o = { x: ((f - 1) % 3) * F, y: (((f - 1) / 3) | 0) * F };
        for (const [i, j] of [[0, 0], [F - 1, 0], [0, F - 1], [F - 1, F - 1]]) {
          const ix = i === 0 ? 1 : -1, jz = j === 0 ? 1 : -1;
          const p = step(
            o.x + i + ix + 0.5, o.y + j + jz + 0.5,
            o.x + i + 0.5, o.y + j + 0.5,
          );
          if (isWall(p.cell.x, p.cell.y)) bad++;
          else if (p.moved) {
            through++;
            if (isSealed(faceAt(p.cell.x, p.cell.y))) bad++;
          } else {
            blocked++;
            if (faceAt(p.cell.x, p.cell.y) !== f) bad++;
          }
        }
      }
      eq(through, 12, 'twelve ring corners let you out');
      eq(blocked, 4, 'and four have nowhere to send you');
      eq(bad, 0, 'none of them lands you in a wall or in another sealed face');
    }
  }

  // Every crossable divider on the map, from both sides, in one pass. The
  // per-frame walk above proves the mechanism; this proves it holds everywhere,
  // which is what the two gate cuts before this both failed at.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    const p = new Player(planet);
    let bad = 0, done = 0, stuck = 0;
    for (const [wx, wz, ax] of [
      [F - 1, 100, 0], [F - 1, 300, 0],           // face 1 east  <-> face 2
      [2 * F, 100, 0], [2 * F, 380, 0],           // face 3 west  <-> face 2
      [100, F - 1, 1], [300, F - 1, 1],           // face 1 south <-> face 4
      [100, 2 * F, 1], [380, 2 * F, 1],           // face 7 north <-> face 4
    ]) {
      for (const s of [-1, 1]) {
        // Start one column off the divider on the near side, step straight in.
        // The adjacent column's centre, which is where a walking body is on
        // the frame before it steps in.
        const sx = ax === 0 ? wx + s + 0.5 : wx + 0.5;
        const sz = ax === 0 ? wz + 0.5 : wz + s + 0.5;
        p.setPosition(sx, GROUND + 0.0001, sz);
        p.vel.x = 0; p.vel.y = 0; p.vel.z = 0;
        p._sync();
        // Straight into the middle of the divider column, the way a step does.
        p.position.x = ax === 0 ? wx + 0.5 : sx;
        p.position.z = ax === 0 ? sz : wz + 0.5;
        p._sync();
        const moved = p._portalTransit(HEIGHT);
        done++;
        if (!moved) { stuck++; continue; }
        if (isWall(p.cell.x, p.cell.y)) bad++;
        else if (Math.abs(p.position.y - (GROUND + 0.0001)) > 0.02) bad++;
        // Out the far side, which is the side you did NOT come from.
        else if (ax === 0 ? Math.sign(delta(wx, Math.floor(p.position.x))) !== -s
          : Math.sign(delta(wz, Math.floor(p.position.z))) !== -s) bad++;
      }
    }
    eq(done, 16, 'sixteen crossings tried');
    eq(stuck, 0, 'every one of them went through');
    eq(bad, 0, 'and every one landed standing on the far face, one column out');
  }

  // Every sealed-to-sealed join, from both sides. There are four of them - Rime
  // to Verdant, Rime to Tempest, Verdant to Pyre, Tempest to Pyre - and each is
  // two wall columns thick, so the landing is TWO columns beyond the one the
  // body stepped into and never the wall column between.
  {
    const planet = new FakePlanet().groundTo(GROUND).dividers();
    const q = new Player(planet);
    let done = 0, stuck = 0, bad = 0;
    for (const f of SEALED) {
      for (const door of portalsOf(f)) {
        const to = faceStep(f, door.dir);
        if (!isSealed(to)) continue;
        const [dx, dy] = DIR_STEP[door.dir];
        // Stand one column inside `f`, then step into its own ring column.
        q.setPosition(wrap(door.x - dx) + 0.5, GROUND + 0.0001, wrap(door.y - dy) + 0.5);
        q.vel.x = 0; q.vel.y = 0; q.vel.z = 0;
        q._sync();
        q.position.x = wrap(door.x) + 0.5;
        q.position.z = wrap(door.y) + 0.5;
        q._sync();
        const moved = q._portalTransit(HEIGHT);
        done++;
        if (!moved) { stuck++; continue; }
        if (isWall(q.cell.x, q.cell.y)) bad++;
        else if (faceAt(q.cell.x, q.cell.y) !== to) bad++;
        else if (q.cell.x !== wrap(door.x + dx * 2) || q.cell.y !== wrap(door.y + dy * 2)) bad++;
        else if (Math.abs(q.position.y - (GROUND + 0.0001)) > 0.02) bad++;
      }
    }
    eq(done, 8, 'eight sealed-to-sealed crossings tried, four joins both ways');
    eq(stuck, 0, 'every one of them went through');
    eq(bad, 0, 'and landed two columns out, in the other corner, on its ground');
  }
}

// --- sneaking holds the edge ------------------------------------------------
//
// A plateau with nothing beyond it, so "off the edge" is a real void and not a
// step down. `groundTo` cannot build this - it floors every column - so the
// blocks are laid by hand.
//
// The lip: the last solid column is X1, so the surface ends at x = X1 + 1, and
// a body with a 0.34 half-width is still supported until its centre is 0.34
// past that. LIP below is that number, and hanging half off is the point of the
// mechanic rather than a tolerance.
{
  const TOP = 34;                       // top of the plateau
  const X0 = 600, X1 = 610;             // solid columns, inclusive
  const Z0 = 600, Z1 = 610;
  const LIP = X1 + 1 + 0.34;

  const plateau = (x0, x1, z0, z1) => {
    const planet = new FakePlanet();
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) for (let k = 0; k < TOP; k++) planet.fill(x, z, k);
    }
    return planet;
  };
  /** Walk east off the plateau, crouching or not, and report where you got to. */
  const walkEast = (held, frames = 300) => {
    const p = standing(plateau(X0, X1, Z0, Z1), 605.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < frames; n++) p.update(1 / 60, keys('KeyW', ...held));
    return p;
  };

  {
    const p = walkEast(['ControlLeft']);
    ok(p.crouching, 'Ctrl crouches');
    ok(p.position.x > X1 + 1.2, `sneaking still walks you to the lip (x = ${p.position.x.toFixed(3)})`);
    ok(p.position.x <= LIP + 0.05, `and no further (x = ${p.position.x.toFixed(3)}, lip ${LIP})`);
    ok(p.grounded, 'and leaves you standing');
    near(p.position.y, TOP, 1e-3, 'at the height you were walking at');
    eq(p.health, 20, 'unhurt, because you never fell');
  }

  // The same walk without Ctrl. If this one stopped too, the test above would
  // be asserting nothing at all.
  {
    const p = walkEast([]);
    ok(p.position.x > LIP + 1, `walking off the same ledge falls (x = ${p.position.x.toFixed(3)})`);
    ok(p.position.y < TOP - 5, `and ends up far below it (y = ${p.position.y.toFixed(2)})`);
  }

  // Sidling. Facing south with W and A held asks for +z AND +x at once: the x
  // half is off the edge and must be refused, the z half runs along the lip and
  // must not be.
  {
    const p = standing(plateau(X0, X1, Z0, Z1), 605.5, 602.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 300; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    const atLip = p.position.x;
    ok(atLip > X1 + 1.2, 'reached the lip first, hanging off it');

    p.yaw = YAW_SOUTH;
    p._updateForward();
    const z0 = p.position.z;
    for (let n = 0; n < 120; n++) p.update(1 / 60, keys('KeyW', 'KeyA', 'ControlLeft'));
    ok(p.position.z > z0 + 1, `sidling along the ledge still moves you (dz = ${(p.position.z - z0).toFixed(2)})`);
    // The x half of the same input buys at most the sub-step it was already
    // short of the lip by, and never crosses it.
    ok(p.position.x >= atLip && p.position.x <= LIP,
      `while the axis that would drop you stays at the lip (x = ${p.position.x.toFixed(4)})`);
    ok(p.grounded, 'and you are still on the ledge');
  }

  // A jump is not a walk. Crouched at the lip, Space still leaves the ground -
  // and once you are off it the rule is gone, so the jump carries you over.
  {
    const p = standing(plateau(X0, X1, Z0, Z1), 605.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 300; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    const x0 = p.position.x;
    ok(p.grounded, 'crouched and standing at the lip');
    p.update(1 / 60, keys('KeyW', 'ControlLeft', 'Space'));
    ok(!p.grounded, 'a crouched jump still leaves the ground');
    ok(p.vel.y > 0, 'and goes up');
    for (let n = 0; n < 30; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    ok(p.position.x > x0 + 0.3, `and carries you off the ledge (dx = ${(p.position.x - x0).toFixed(2)})`);
  }

  // Airborne over the lip, and low enough that the ground under the feet is
  // still the ground `_surfaceBelow` can see - which is exactly where a rule
  // that forgot to ask whether you are standing would bite. A body in flight
  // crosses the edge.
  {
    const p = new Player(plateau(X0, X1, Z0, Z1));
    p.setPosition(X1 + 1.2, TOP + 0.5, 605.5);
    p.grounded = false;
    p.vel.x = 12;
    p.update(1 / 60, keys('ControlLeft'));
    ok(p.crouching, 'crouched in the air');
    ok(p.position.x > LIP, `and carried straight over the lip (x = ${p.position.x.toFixed(3)})`);
  }

  // Mid-air, crouched, already past the edge: nothing about the fall changes.
  {
    const p = new Player(plateau(X0, X1, Z0, Z1));
    p.setPosition(X1 + 0.5, TOP + 4, 605.5);
    p.yaw = YAW_EAST;
    p._updateForward();
    const x0 = p.position.x;
    for (let n = 0; n < 40; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    ok(p.position.x > x0 + 0.5, `a crouched body in the air still steers over the void (x = ${p.position.x.toFixed(2)})`);
    ok(p.position.y < TOP + 4, 'and is still falling');
  }

  // The rule itself, asked directly, because the one case that matters most is
  // the one a walk cannot stage: a body already over the void. Gravity takes it
  // out of the air within a frame or two, so the freeze it would cause has to
  // be denied at the predicate rather than observed at the position.
  {
    const p = standing(plateau(X0, X1, Z0, Z1), 605.5, 605.5, TOP);
    eq(p._steppingOff(605.5 + 1, 605.5, TOP), false, 'a step across the plateau is not a step off');
    p.setPosition(LIP - 0.02, TOP, 605.5);
    eq(p._steppingOff(LIP + 0.02, 605.5, TOP), true, 'a step past the lip is');
    p.setPosition(X1 + 4.5, TOP, 605.5);
    eq(p._steppingOff(X1 + 5.5, 605.5, TOP), false,
      'but over the void there is no edge left to hold, so nothing is refused');
  }

  // It must not trap you. Put a crouching body over the void with `grounded`
  // set - a shove, a block mined out from under it - and it has to be able to
  // move, because there is no edge left to hold.
  {
    const p = standing(plateau(X0, X1, Z0, Z1), X1 + 4.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    const x0 = p.position.x;
    for (let n = 0; n < 30; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    ok(p.position.x > x0 + 0.2, `already over the void, crouching does not freeze you (dx = ${(p.position.x - x0).toFixed(2)})`);
  }

  // A blow still shoves you off, and the case that needs the exemption by name
  // is the one where you come back DOWN inside the blow: the token pop
  // `knockback` gives you takes you off the ground on its own, so the frames
  // that matter are the ones after you land again with the shove still running.
  {
    const p = standing(plateau(X0, X1, Z0, Z1), 605.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 300; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    const x0 = p.position.x;
    p.knockback(x0 - 2, TOP, 605.5, 6);
    ok(p.knockT > 0, 'the blow is on you');
    // Back on your feet, mid-shove.
    p.grounded = true; p.vel.y = 0;
    p.update(1 / 60, keys('ControlLeft'));
    ok(p.position.x > x0, `a blow shoves a sneaking player off the lip (dx = ${(p.position.x - x0).toFixed(3)})`);
    for (let n = 0; n < 30; n++) p.update(1 / 60, keys('ControlLeft'));
    ok(p.position.y < TOP - 1, `and over the edge you go (y = ${p.position.y.toFixed(2)})`);
  }

  // Swimming is not standing. Water over the lip and over the void beside it:
  // the rule is off, so you swim out over the drop.
  {
    const planet = plateau(X0, X1, Z0, Z1);
    for (let x = X0; x <= X1 + 6; x++) {
      for (let z = Z0; z <= Z1; z++) for (let k = TOP; k < TOP + 3; k++) planet.fill(x, z, k, ID.water);
    }
    const p = standing(planet, 608.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    p.update(1 / 60, NONE);
    ok(p.inWater, 'the feet are in the water on top of the plateau');
    for (let n = 0; n < 300; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    ok(p.position.x > LIP + 0.1, `sneaking does not hold the edge while swimming (x = ${p.position.x.toFixed(2)})`);
  }

  // At the map wrap. The plateau straddles x = 0, so the walk east crosses the
  // seam and the lip it stops at is on the far side of it - which only works if
  // the support test wraps. Raw subtraction fails here and nowhere else.
  {
    const planet = new FakePlanet();
    for (let x = W - 3; x <= W + 3; x++) {
      for (let z = Z0; z <= Z1; z++) for (let k = 0; k < TOP; k++) planet.fill(wrap(x), z, k);
    }
    const p = standing(planet, W - 2.5, 605.5, TOP);
    p.yaw = YAW_EAST;
    p._updateForward();
    for (let n = 0; n < 300; n++) p.update(1 / 60, keys('KeyW', 'ControlLeft'));
    ok(p.position.x > 4.2 && p.position.x <= 3 + 1 + 0.34 + 0.05,
      `sneaking holds the edge across the wrap (x = ${p.position.x.toFixed(3)})`);
    ok(p.grounded, 'still standing at the wrapped lip');
    near(p.position.y, TOP, 1e-3, 'and at the plateau height');
  }
}

// --- a refused crossing must not be a trap ------------------------------------
//
// Transit fires on CONTACT, so the centre is still outside the wall when it
// runs. `_freeX` tested the centre only, so it wrote the touching position down
// as safe; a refused crossing then ejected the body to where it already was, it
// touched again next frame, and refused again - pinned against a divider,
// unable to pass and unable to back away. "I just got stuck inside a portal."
{
  // `_touchingWall` is the whole guard, so assert it directly rather than
  // through a world we would have to build a divider in.
  const p = new Player(new FakePlanet());
  const inWall = (x, z) => p._touchingWall(x, z);
  // Rime's ring: face 1 starts at the map origin, so its west run is x = 0.
  const wx = 0, wz = 200;
  ok(inWall(wx + 0.5, wz + 0.5), 'the middle of a divider column counts as touching');
  ok(inWall(wx + 1.2, wz + 0.5), 'and so does a body a third of a block off it');
  ok(!inWall(wx + 2.5, wz + 0.5), 'two columns clear does not');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
