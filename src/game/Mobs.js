// Wildlife, and the one thing on the planet that wants you dead. Mobs live in
// cubesphere cell space like the player, so they walk upright anywhere on the
// surface.
//
// Presentation is entirely GLB: each species is a Kenney model carrying its own
// animation clips, and this file picks which clip to play. It used to build
// every animal out of boxes and swing four leg pivots by hand — a good gait,
// but each new species meant a new build function, and the models come with
// better motion than the code did.
//
// Motion is continuous: heading is steered at a limited turn rate, speed is
// accelerated toward a target, and step-ups are visually smoothed so animals
// never pop between cell heights. See the notes in update() for the teleport
// bugs this replaced.

import * as THREE from 'three';
import { F, D, GRAVITY, R_SEA, R_MIN, BIOME, cidx } from '../world/Constants.js';
import {
  cellToWorld, tangentFrame, normalizeCell, colParts, colNeighbor, stepColumn,
} from '../world/Sphere.js';
import {
  ID, IS_SHAPED, IS_LEAF, IS_SOLID, collisionBoxes, LIGHT_EMIT, RENDER_TYPE, R_LIQUID,
  isPassable,
} from '../world/Blocks.js';
import { itemIdOf } from './Items.js';
import { rollStock, rollRequest } from './Trade.js';
import { makeRng, clamp, lerp } from '../util/Noise.js';
import * as MobModels from './MobModels.js';

const MAX_MOBS = 26;
// Hostiles are capped well below the herd: a night should be tense, not a
// siege. The cap is per habitat rather than global, and deliberately so — a
// single shared budget let one habitat starve the other, and a combined ceiling
// would bring that straight back. The two populations are never in the same
// place anyway, which is the whole reason they need separate budgets.
const MAX_HOSTILE_SURFACE = 5;
const MAX_HOSTILE_CAVE = 3;
/**
 * How far a placed light keeps husks out, in columns and layers. Eight columns
 * is a little short of a torch's actual glow, deliberately: a corridor you have
 * lit should be safe, but a single torch at a cave mouth should not sterilise
 * the chamber behind it.
 */
const LIGHT_GUARD = 7;
const LIGHT_GUARD_K = 3;

// The cave search has its own geometry. Underground, cover comes from rock
// rather than distance, so it looks close and accepts close — a husk around the
// next bend is the whole point of a cave.
const CAVE_WALK_MIN = 6;
const CAVE_WALK_SPAN = 18;
const CAVE_MIN_DIST = 10;

/** How long a blocked hunter commits to one way round an obstacle, and how far
 * off its target bearing it leans while doing so. */
const WALL_SLIDE_TIME = 1.4;
const WALL_SLIDE_TURN = 1.15;

/**
 * Headings a stuck hunter tries, as turns either side of the bearing to its
 * target. Ordered outward so the straightest workable line wins, and stopping
 * short of a right angle on purpose — a mob that will turn 135 degrees to
 * approach walks backwards away from you, which reads as broken rather than
 * clever.
 */
const PROBE_ANGLES = [0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.55, -1.55];

// --- pathfinding -------------------------------------------------------------
/** Seconds between route searches for one hunting mob. */
const PATH_PERIOD = 0.9;
/** How long a route may be followed after the player has moved off its end. */
const PATH_MAX_AGE = 2.2;
/** Columns expanded before a search gives up, and the longest route it returns. */
const PATH_BUDGET = 2600;
const PATH_MAX_STEPS = 70;
/** How far a body will step down without thinking of it as a fall. */
const PATH_MAX_DROP = 3;
/** How many waypoints ahead a mob steers. See _pathBearing. */
const PATH_LOOKAHEAD = 3;
const _pp = { f: 0, i: 0, j: 0 };
const _wp = { f: 0, i: 0, j: 0 };

/**
 * A binary min-heap keyed on score.
 *
 * A* wants the cheapest open node and nothing else, and a linear scan over an
 * open set that reaches into the hundreds is most of the search. Small enough
 * to keep here rather than pull in a dependency for.
 */
class Heap {
  constructor() { this.items = []; this.score = []; }
  get size() { return this.items.length; }
  push(item, score) {
    let n = this.items.length;
    this.items.push(item); this.score.push(score);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.score[p] <= this.score[n]) break;
      this._swap(p, n); n = p;
    }
  }
  pop() {
    const top = this.items[0], last = this.items.length - 1;
    this.items[0] = this.items[last]; this.score[0] = this.score[last];
    this.items.pop(); this.score.pop();
    let n = 0;
    for (;;) {
      const l = n * 2 + 1, r = l + 1;
      let m = n;
      if (l < this.items.length && this.score[l] < this.score[m]) m = l;
      if (r < this.items.length && this.score[r] < this.score[m]) m = r;
      if (m === n) break;
      this._swap(m, n); n = m;
    }
    return top;
  }
  _swap(a, b) {
    const i = this.items[a]; this.items[a] = this.items[b]; this.items[b] = i;
    const s = this.score[a]; this.score[a] = this.score[b]; this.score[b] = s;
  }
}
/** How far past its own body a probe looks. */
const PROBE_AHEAD = 0.9;

/** Seconds of chasing without closing any ground before a husk gives up. */
const HUNT_STALL = 9;
/** And how long it then ignores the player, so it doesn't re-latch instantly. */
const HUNT_COOLDOWN = 14;
/** Seconds a husk survives in direct sun once it catches. */
const BURN_SECONDS = 3.4;
const SPAWN_RADIUS = 46;      // cells of random walk when hunting for a spot
const SPAWN_MIN_DIST = 20;    // world units — never pop in under the player's nose
const DESPAWN_RADIUS = 110;   // world units — generous, so nothing blinks out on screen

// --- vocalisation pacing ----------------------------------------------------
// Each animal keeps its own jittered clock, seeded at random on spawn, so a
// herd that spawned in the same frame never calls in unison. On top of that the
// manager holds a global cooldown, so 16 animals whose clocks happen to line up
// still produce one call, not sixteen.
const VOX_MIN = 6;            // seconds between one animal's own calls
const VOX_MAX = 14;
const VOX_NEAR = 14;          // world units — always audible, even behind you
const VOX_RANGE = 42;         // beyond this, silent regardless of facing
const VOX_FACING = 0.25;      // cos of the half-angle counted as "on screen"

// The merchant's bell is a beacon, not a vocalisation: it has to carry across
// open ground so "walk towards the sound" is a real way to find one.
// Knockback. Short and sharp: long enough to break contact and reset the
// exchange, short enough that a husk is on you again before you have finished
// congratulating yourself.
const KNOCK_TIME = 0.34;        // seconds of push
const KNOCK_HOSTILE = 7.0;      // cells per second at full strength
const KNOCK_WILDLIFE = 3.4;

const BELL_RANGE = 120;
const BELL_MIN = 4.5;
const BELL_MAX = 8;

const TAU = Math.PI * 2;

// Dedicated scratch. Each one has a single owner in a given scope; this file
// has had aliasing bugs before, so never borrow one across a helper call.
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _axis = new THREE.Vector3();
/** Player collision radius, matching HALF_W in Player.js. */
const PLAYER_RADIUS = 0.34;

const _seam = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _rpos = new THREE.Vector3();
const _vox = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = [0, 0, 0];
const _probe = { f: 0, ci: 0, cj: 0, ck: 0 };

const wrapAngle = (a) => {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
};

// --- species ----------------------------------------------------------------
// Every mob is a Kenney GLB with its animation already authored: eight clips
// per animal, keyed on named nodes rather than a skeleton. Sizes are given as a
// target height in cells and the per-model scale is derived from the measured
// rest pose, so a species can be swapped for a different model without
// re-tuning numbers by hand.

const PET = (n) => `models/pets/animal-${n}.glb`;
const CHAR = (n) => `models/characters/character-${n}.glb`;

/** Clip names shipped by the Cube Pets rig. */
const PET_CLIPS = { idle: 'idle', walk: 'walk', run: 'run', graze: 'eat' };
/** Clip names shipped by the Blocky Characters rig — no eat, but it can fight. */
const CHAR_CLIPS = {
  idle: 'idle', walk: 'walk', run: 'sprint', graze: 'idle',
  attack: 'attack-melee-right', die: 'die',
};

/**
 * One animal. Only what differs is written out; everything else takes a sane
 * default, which is what keeps a 22-species table readable.
 *   h    target height in cells      shy  0 never flees .. 1 bolts on sight
 *   hp   health                      spd  cells/second at a walk
 */
const pet = (file, o) => ({
  label: o.label,
  urls: [PET(file)],
  clips: PET_CLIPS,
  height: o.h,
  health: o.hp,
  speed: o.spd,
  skittish: o.shy,
  turn: o.turn ?? 3.5,
  accel: o.accel ?? 7,
  drops: o.drops ?? [],
  grazeChance: o.graze ?? 0.5,
  idleMin: o.idleMin ?? 2,
  idleMax: o.idleMax ?? 5,
  ...(o.hops ? { hops: true, hopImpulse: o.hopImpulse ?? 3.8 } : null),
  ...(o.cold ? { cold: true } : null),
  ...(o.aquatic ? { aquatic: true } : null),
});

const HIDE_MEAT = [['hide', 1, 1], ['meat', 1, 1]];

const SPECIES = {
  // --- large grazers ---
  cow: pet('cow', {
    label: 'Cow', h: 1.30, hp: 10, spd: 0.85, shy: 0.35, turn: 2.0, accel: 4.5,
    graze: 0.6, idleMin: 3, idleMax: 7, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  deer: pet('deer', {
    label: 'Deer', h: 1.40, hp: 10, spd: 1.25, shy: 0.9, turn: 3.0, accel: 6.0,
    idleMin: 2.5, idleMax: 6, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  elephant: pet('elephant', {
    label: 'Elephant', h: 2.60, hp: 20, spd: 0.75, shy: 0.2, turn: 1.6, accel: 3.5,
    graze: 0.6, idleMin: 3, idleMax: 8, drops: [['hide', 2, 3], ['meat', 2, 3]],
  }),
  giraffe: pet('giraffe', {
    label: 'Giraffe', h: 3.10, hp: 14, spd: 1.0, shy: 0.5, turn: 1.8, accel: 4.0,
    graze: 0.55, idleMin: 3, idleMax: 7, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  panda: pet('panda', {
    label: 'Panda', h: 1.20, hp: 14, spd: 0.7, shy: 0.3, turn: 2.2, accel: 4.0,
    graze: 0.7, idleMin: 3, idleMax: 8, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  polar: pet('polar', {
    label: 'Polar Bear', h: 1.55, hp: 16, spd: 1.0, shy: 0.3, turn: 2.4, accel: 5.0,
    graze: 0.35, drops: [['hide', 2, 3], ['meat', 1, 2]], cold: true,
  }),

  // --- big cats: no teeth yet, but they read as dangerous ---
  lion: pet('lion', {
    label: 'Lion', h: 1.15, hp: 14, spd: 1.4, shy: 0.25, turn: 3.4, accel: 8.0,
    graze: 0.3, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),
  tiger: pet('tiger', {
    label: 'Tiger', h: 1.20, hp: 14, spd: 1.5, shy: 0.25, turn: 3.6, accel: 8.5,
    graze: 0.3, drops: [['hide', 1, 2], ['meat', 1, 2]],
  }),

  // --- middling ---
  dog: pet('dog', {
    label: 'Dog', h: 0.66, hp: 8, spd: 1.5, shy: 0.4, turn: 4.5, accel: 9.0,
    graze: 0.35, idleMin: 1.2, idleMax: 3.5, drops: HIDE_MEAT,
  }),
  fox: pet('fox', {
    label: 'Fox', h: 0.68, hp: 6, spd: 1.5, shy: 0.8, turn: 4.5, accel: 8.0,
    graze: 0.3, idleMin: 1.5, idleMax: 4, drops: HIDE_MEAT,
  }),
  cat: pet('cat', {
    label: 'Cat', h: 0.55, hp: 6, spd: 1.6, shy: 0.9, turn: 5.5, accel: 10.0,
    graze: 0.3, idleMin: 1.2, idleMax: 4, drops: [['hide', 1, 1]],
  }),
  koala: pet('koala', {
    label: 'Koala', h: 0.66, hp: 6, spd: 0.7, shy: 0.5, turn: 2.4, accel: 4.0,
    graze: 0.65, idleMin: 3, idleMax: 8, drops: [['hide', 1, 1]],
  }),
  monkey: pet('monkey', {
    label: 'Monkey', h: 0.72, hp: 6, spd: 1.5, shy: 0.8, turn: 5.0, accel: 9.0,
    graze: 0.35, idleMin: 1, idleMax: 3, drops: [['hide', 1, 1]], hops: true, hopImpulse: 3.6,
  }),
  beaver: pet('beaver', {
    label: 'Beaver', h: 0.6, hp: 6, spd: 1.1, shy: 0.7, turn: 4.0, accel: 7.0,
    graze: 0.45, drops: HIDE_MEAT,
  }),
  penguin: pet('penguin', {
    label: 'Penguin', h: 0.62, hp: 6, spd: 0.9, shy: 0.6, turn: 3.2, accel: 5.5,
    drops: [['meat', 1, 1], ['feather', 1, 2]], cold: true,
  }),

  // --- small and skittish ---
  bunny: pet('bunny', {
    label: 'Bunny', h: 0.52, hp: 4, spd: 1.7, shy: 1.0, turn: 5.0, accel: 9.0,
    graze: 0.35, idleMin: 1, idleMax: 3, drops: HIDE_MEAT, hops: true, hopImpulse: 4.2,
  }),
  chick: pet('chick', {
    label: 'Chick', h: 0.5, hp: 4, spd: 1.15, shy: 0.85, turn: 6.0, accel: 11.0,
    graze: 0.7, idleMin: 0.8, idleMax: 2.4, drops: [['feather', 1, 2], ['meat', 1, 1]],
  }),
  parrot: pet('parrot', {
    label: 'Parrot', h: 0.5, hp: 4, spd: 1.35, shy: 1.0, turn: 6.5, accel: 12.0,
    graze: 0.4, idleMin: 0.8, idleMax: 2.6, drops: [['feather', 1, 3]],
    hops: true, hopImpulse: 3.4,
  }),
  bee: pet('bee', {
    label: 'Bee', h: 0.42, hp: 3, spd: 1.8, shy: 1.0, turn: 7.0, accel: 14.0,
    graze: 0.5, idleMin: 0.6, idleMax: 1.8, hops: true, hopImpulse: 3.0,
  }),
  crab: pet('crab', {
    label: 'Crab', h: 0.45, hp: 5, spd: 1.0, shy: 0.7, turn: 5.0, accel: 8.0,
    graze: 0.4, drops: [['meat', 1, 1]],
  }),
  caterpillar: pet('caterpillar', {
    label: 'Caterpillar', h: 0.4, hp: 3, spd: 0.5, shy: 0.6, turn: 2.5, accel: 4.0,
    graze: 0.8, idleMin: 2, idleMax: 6,
  }),
  fish: pet('fish', {
    label: 'Fish', h: 0.5, hp: 4, spd: 1.4, shy: 0.9, turn: 4.5, accel: 8.0,
    graze: 0.3, idleMin: 1, idleMax: 3, drops: [['meat', 1, 1]], aquatic: true,
  }),

  // --- the one thing that wants you dead ---
  husk: {
    label: 'Husk', urls: [CHAR('l'), CHAR('o')], clips: CHAR_CLIPS, height: 1.72,
    health: 14, speed: 1.30, skittish: 0, turn: 3.2, accel: 6.0,
    // Cinder is the whole reason to be outside after dark; roughly every other
    // husk carries one, so a good night funds part of a cinder tool.
    drops: [['flint', 0, 1], ['coal', 0, 1], ['cinder', 0, 1]],
    grazeChance: 0, idleMin: 1.5, idleMax: 3.5,
    // --- what makes it a threat ---
    hostile: true,
    damage: 3,            // half-hearts per blow
    reach: 1.25,          // cells between body centres to land one
    swing: 1.15,          // seconds between blows
    // Must exceed SPAWN_MIN_DIST, or a husk can never notice the player it
    // spawned for. At 16 against a spawn ring starting at 20, every one of them
    // arrived already out of range and wandered off: a player could stand in
    // the open through a whole night with the full cap of seven around them and
    // take no damage at all. Night had threat on paper and none in play.
    aggroRange: 34,       // cells it will notice you from
    burns: true,          // direct daylight sets it alight
  },

  // --- the one thing on the planet that will talk to you ---
  merchant: {
    label: 'Wandering Merchant', urls: [CHAR('d')],
    // The Blocky Characters rig again, but the emote stands in for grazing:
    // an animal chewing and a trader waving are the same slot in the state
    // machine, and it is the only clip that reads as "person" at distance.
    clips: { ...CHAR_CLIPS, graze: 'emote-yes' },
    height: 1.72,
    // Not a fight anyone should win by accident. It is also the only mob a
    // player has a reason to keep alive, so it is built to survive a stray
    // swing rather than to be farmed.
    health: 60, speed: 0.95, skittish: 0, turn: 2.6, accel: 5.0,
    drops: [['coin', 2, 6]],
    // Short pauses and a long walk phase: it should always be going somewhere,
    // because a merchant standing still is a shop, and this is a chance meeting.
    grazeChance: 0.2, idleMin: 0.6, idleMax: 1.8,
    trader: true,       // carries stock, opens the shop, never flees
    lamp: true,         // a warm point of light, so you can spot one at dusk
  },
};

export const SPECIES_TYPES = Object.keys(SPECIES);

// --- husbandry ---------------------------------------------------------------

/** Anything a grazer will take from your hand. */
const FEEDS = new Set(['wheat', 'seeds', 'apple'].map(itemIdOf).filter(Boolean));
/** Centre + 8 perimeter samples, as unit offsets scaled by the body radius. */
const D8 = Math.SQRT1_2;
const FOOT_OFF = [
  0, 0,  1, 0,  -1, 0,  0, 1,  0, -1,
  D8, D8,  D8, -D8,  -D8, D8,  -D8, -D8,
];

const LOVE_SECONDS = 22;      // how long a fed animal stays willing
const BREED_RANGE = 4.5;      // how close a willing pair must be
/** How far a willing animal will walk to reach another. Comfortably past the
 *  spread you get from luring two of them to roughly the same field. */
const COURT_RANGE = 26;
const BREED_COOLDOWN = 90;    // rest between litters, so a herd can't runaway
const BABY_SECONDS = 210;     // calf → adult

/**
 * Horizontal half-extents of a built model, in cells, along its own axes.
 *
 * A single radius cannot describe these animals: a woolly is drawn 0.70 long
 * but only ~0.30 wide, so a circle either has to be too fat to fit through a
 * one-block gap or too small to keep the snout out of the wall — which is
 * exactly how a body ends up sunk into the block it stands against. Measuring
 * length and width separately lets the footprint be the shape the animal
 * actually is. Margins absorb the walk cycle, which swings limbs past the
 * rest pose.
 */
function modelExtents(root, scale) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty() || !Number.isFinite(box.min.x)) return { halfW: 0.3, halfL: 0.3, tall: 1 };
  return {
    halfW: Math.min(0.47, Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) + 0.03),
    halfL: Math.min(0.80, Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) + 0.03),
    // Cells of headroom needed, from the drawn height rather than a guess — a
    // browser's neck reaches well past what its body dimensions suggest, and
    // guessing left its head free to pass through leaves.
    tall: Math.max(1, Math.ceil(box.max.y - 0.001)),
  };
}

/** Advance a calf's growth clock. Scale is applied by _animate, which owns it. */
function mobGrow(mob, dt) {
  if (mob.baby <= 0) return;
  mob.baby = Math.max(0, mob.baby - dt);
}

/**
 * How big this animal is right now, 0.52 newborn to 1 grown.
 *
 * This must be folded into _animate rather than written to the model directly:
 * _animate reassigns root.scale every frame for the hurt flash, so anything
 * that sets scale outside it is silently overwritten on the next tick.
 */
function growthScale(mob) {
  if (mob.baby <= 0) return 1;
  const t = 1 - mob.baby / BABY_SECONDS;
  return 0.52 + 0.48 * t * t;
}
/**
 * Weighted draw for ordinary wildlife. Common animals appear more than once;
 * the cold-weather and aquatic species are picked by ground instead, so they
 * are absent here.
 */
/**
 * Who lives where.
 *
 * One flat table used to serve the whole planet, with a single exception for
 * penguins on ice — so a lion, a giraffe, a panda and a koala all turned up in
 * the same temperate meadow. On a world you can walk around in four minutes
 * that does not read as variety, it reads as a zoo with the fences taken out,
 * and it flattens biomes that the terrain generator went to some trouble to
 * make distinct.
 *
 * Weighted by repetition, which keeps the table legible: three cows to one dog
 * is three entries to one. Anything not listed falls back to COMMON, so a new
 * biome cannot spawn an empty world.
 */
/** Biome id → name, so the table above can be keyed by something readable. */
const BIOME_NAME = [];
for (const [name, id] of Object.entries(BIOME)) BIOME_NAME[id] = name;

const COMMON = ['bunny', 'bunny', 'bee', 'caterpillar', 'fox'];
const SPAWN_BY_BIOME = {
  SNOW: ['penguin', 'penguin', 'polar', 'fox', 'deer'],
  TUNDRA: ['deer', 'deer', 'fox', 'fox', 'bunny', 'polar'],
  MOUNTAIN: ['deer', 'fox', 'bunny', 'bee', 'tiger'],
  // Sparse on purpose: an empty-feeling desert is the point of a desert.
  DESERT: ['lion', 'crab', 'caterpillar', 'bee'],
  BADLANDS: ['lion', 'tiger', 'caterpillar'],
  SAVANNA: ['giraffe', 'giraffe', 'elephant', 'lion', 'tiger', 'deer'],
  FOREST: ['deer', 'deer', 'fox', 'bunny', 'bunny', 'panda', 'koala', 'monkey',
    'parrot', 'bee', 'caterpillar'],
  PINE_FOREST: ['deer', 'deer', 'fox', 'fox', 'bunny', 'beaver', 'bee'],
  MEADOW: ['cow', 'cow', 'cow', 'bunny', 'bunny', 'chick', 'chick', 'dog', 'cat',
    'bee', 'bee', 'deer'],
  PLAINS: ['cow', 'cow', 'bunny', 'bunny', 'chick', 'chick', 'chick', 'dog',
    'cat', 'deer', 'fox', 'bee'],
  OCEAN: ['crab', 'crab', 'beaver'],
  BEACH: ['crab', 'crab', 'crab', 'bunny', 'bee'],
};

// --- the merchant's own spawn path -------------------------------------------
// Kept out of the biome tables on purpose. Everything else is population: top the
// world up towards a headcount and pick a species by weight. A merchant is an
// event — at most one alive, a long wait between them, and a life span, so the
// one you met is gone by the time you come back for it and the next turns up
// wherever you happen to be standing.
const MERCHANT_FIRST = 120;      // seconds of grace after a world starts
const MERCHANT_COOLDOWN = 300;   // seconds between one leaving and the next
const MERCHANT_CHANCE = 0.18;    // per spawn tick (6s) once the wait is over
const MERCHANT_LIFE = 420;       // seconds before it moves on for good
/** Coins one trader can pay out before it has nothing left to buy with. */
const MERCHANT_PURSE_MIN = 140;
const MERCHANT_PURSE_MAX = 460;

/** Every model the species table can ask for, for the one-time preload. */
export const MOB_MODEL_URLS = Object.values(SPECIES).flatMap((s) => s.urls);

// --- the manager ------------------------------------------------------------

export class Mobs {
  constructor(scene, planet, drops) {
    this.planet = planet;
    this.drops = drops;
    this.group = new THREE.Group();
    this.group.name = 'mobs';
    scene.add(this.group);
    this.list = [];
    this.spawnTimer = 4;
    /** Seconds before a merchant may appear. Reset every time one leaves. */
    this.merchantT = MERCHANT_FIRST;
    /** (mob) => void — a merchant has just arrived, for a nudge to the player. */
    this.onMerchant = null;
    this.onHurtSound = null;
    /** (kind, mob) => void — 'idle' | 'hurt' | 'death'. Wired to Audio.mob(). */
    this.onSound = null;
    /** (damage, mob) => void — a hostile landed a blow on the player. */
    this.onAttack = null;
    /** (mob) => void — a hostile is alight, for smoke and embers. */
    this.onBurn = null;
    /** Swings in flight, so the hit lands on contact rather than on the decision. */
    this._pendingHits = [];
    /** sun elevation at the player, refreshed each update */
    this.daylight = 1;
    this.voxCooldown = 0;
    /** The merchant's bell runs on its own clock, clear of the herd limiter. */
    this.bellT = 0;
    this.voxCount = 0;          // diagnostics: calls actually emitted
    this.voxSuppressed = 0;     // diagnostics: calls dropped by the rate limit
    this._nextId = 1;
  }

  clear() {
    for (const m of this.list) this._release(m);
    this.list.length = 0;
    this.merchantT = MERCHANT_FIRST;
  }

  /** The live merchant, or null. There is never more than one. */
  merchant() {
    for (const m of this.list) if (m.spec.trader) return m;
    return null;
  }

  /** Drop a merchant and start the wait for the next one. */
  _retireMerchant(mob, index) {
    this.merchantT = MERCHANT_COOLDOWN;
    this._release(mob);
    this.list.splice(index, 1);
  }

  _release(mob) {
    this.group.remove(mob.model.root);
    mob.model.mixer.stopAllAction();
    mob.model.mixer.uncacheRoot(mob.model.root);
    // Geometry and the texture are shared with the rest of the species — a
    // clone only borrows them, so disposing either would blank the whole herd.
    // The material clones made for the damage tint are this mob's own.
    for (const m of mob.model.owned) m.dispose();
  }

  // --- spawning -------------------------------------------------------------

  /** Column index for possibly out-of-range continuous cell coords, cross-face safe. */
  _colOf(f, ci, cj) {
    _probe.f = f; _probe.ci = ci; _probe.cj = cj; _probe.ck = 0;
    if (ci < 0 || ci >= F || cj < 0 || cj >= F) normalizeCell(_probe);
    const i = Math.min(F - 1, Math.max(0, Math.floor(_probe.ci)));
    const j = Math.min(F - 1, Math.max(0, Math.floor(_probe.cj)));
    return cidx(_probe.f, i, j);
  }

  /**
   * Walk `steps` columns away from `nearCol` and return where you end up.
   *
   * Direction is held and only occasionally turned, which matters more than it
   * sounds. Redrawing the direction every step is a *diffusive* walk: its
   * displacement grows with the square root of the step count, so 40 steps only
   * gets about six columns from where it started. Every spawn search in this
   * file used to do that, and every one of them also required the result to be
   * at least SPAWN_MIN_DIST (20 units) from the player — a bar the walk almost
   * never cleared. Measured over 300 walks: median displacement 4.8 units, and
   * not one reached 20. Wildlife top-up, both husk paths and the fish were all
   * silently dead; only populate() worked, and only because it skips the
   * distance test entirely.
   *
   * Holding a heading covers ground linearly. Same measurement, median 28.
   */
  _walkOut(nearCol, steps) {
    let col = nearCol;
    let dir = (Math.random() * 4) | 0;
    for (let s = 0; s < steps; s++) {
      // Veer square, never reverse: colNeighbor's 0/1 are the two ways along i
      // and 2/3 the two along j, so turning means swapping which pair the
      // direction is drawn from. Adding one would just walk back.
      if (Math.random() < 0.06) {
        dir = dir < 2 ? 2 + ((Math.random() * 2) | 0) : ((Math.random() * 2) | 0);
      }
      col = colNeighbor(col, dir);
    }
    return col;
  }

  /** Grass column with headroom, or null. */
  _findSpawnColumn(nearCol, radius, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 40; tries++) {
      // Without a player to keep clear of this is world start, and a herd
      // scattered over fifty columns reads as an empty planet — stay close.
      const steps = playerPos
        ? 24 + Math.floor(Math.random() * radius)
        : 6 + Math.floor(Math.random() * 20);
      const col = this._walkOut(nearCol, steps);
      const k = p.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      const surf = p.at(col, k);
      if (surf !== ID.grass && surf !== ID.sand && surf !== ID.snow) continue;
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;
      // a sandy seabed passes every test above, so reject anything submerged
      if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
      // A hearth keeps the surface around it clear too, not just the caves.
      if (this._warded(col, k)) continue;
      if (playerPos) {
        // don't materialise inside the player's view, and don't drop one just
        // outside the despawn ring where it would be culled again next second
        const { f, i, j } = colParts(col);
        cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
        const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
        if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      }
      return { col, k };
    }
    return null;
  }

  spawn(type, col, k, seed) {
    const spec = SPECIES[type];
    if (!spec || this.list.length >= MAX_MOBS) return null;
    const { f, i, j } = colParts(col);

    const s = (seed === undefined || seed === null) ? ((Math.random() * 0x7fffffff) | 0) : (seed | 0);
    const rng = makeRng(s || 1);
    const variant = Math.floor(rng() * spec.urls.length) % spec.urls.length;
    const sizeJitter = 0.90 + rng() * 0.20;        // stable per individual

    const url = spec.urls[variant];
    const model = MobModels.instantiate(url);
    // The model may not have loaded — a failed fetch, or a spawn racing world
    // start. Refusing here is right: an invisible mob that still collides and
    // bites is worse than one that never appears.
    if (!model) return null;

    // Sizes are authored as a target height in cells, and each rig has its own
    // idea of a unit, so the scale is derived from the measured rest pose.
    const scale = (spec.height / MobModels.modelHeight(url)) * sizeJitter;
    model.root.scale.setScalar(scale);

    // Materials stay exactly as the loader made them, shared across the whole
    // species. Pain is shown by the scale pop in _animate instead of by tinting
    // emissive: that needed a per-mob material clone, and every variation on
    // touching these materials ended with the animal rendering flat white.
    //
    // The flash is back, but through `color` rather than anything on the map.
    // The white bug was the *texture* being written to — assigning colorSpace,
    // filters or needsUpdate forces a re-upload from an ImageBitmap that has
    // already been consumed. A cloned material with its own `color` shares the
    // same map object untouched, so it is safe.
    model.owned = [];
    model.root.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const cloned = Array.isArray(n.material)
        ? n.material.map((m) => m.clone())
        : n.material.clone();
      n.material = cloned;
      for (const m of (Array.isArray(cloned) ? cloned : [cloned])) model.owned.push(m);
      // (No layer juggling here. Putting a mesh on layer 1 to "reach" the
      // entity fill was tried and does nothing: three tests a light's layers
      // against the camera, not against each object, so object layers cannot
      // select lights at all. The fill is a plain scene light now — see Sky.)
    });
    this.group.add(model.root);

    const mob = {
      id: this._nextId++, type, spec, model, seed: s, variant,
      scale, sizeJitter,
      cell: { f, ci: i + 0.5, cj: j + 0.5, ck: k + 1.02 },
      vel: { i: 0, j: 0, k: 0 },
      pos: new THREE.Vector3(),
      prevPos: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      heading: rng() * TAU,
      want: 0,
      state: 'idle',
      stateT: spec.idleMin + rng() * (spec.idleMax - spec.idleMin),
      health: spec.health,
      grounded: false,
      stride: rng() * TAU,      // walk-cycle phase, advanced by distance
      idleT: rng() * 100,       // personal clock for bob / sway
      voxT: 2 + rng() * (VOX_MAX - 1),   // personal, jittered call clock
      blinkT: 1 + rng() * 4,
      blink: 0,
      graze: 0,
      speedNow: 0,
      hurtT: 0,
      knockA: 0, knockB: 0, knockT: 0,   // decaying shove from the last blow
      bestDist: Infinity,  // closest it has got while hunting, for the stall test
      stallT: 0,
      slideT: 0, slideDir: 1,   // which way it is currently going round a wall
      huntCooldown: 0,
      fromCave: false,     // which spawn budget it belongs to
      swingT: 0,           // hostiles: cooldown left before the next blow
      burnT: 0,            // hostiles: seconds alight in daylight
      dying: 0,            // seconds left of the death animation
      target: null,        // 'player' once a hostile has noticed you
      // Collision footprint in cells, measured from the built model rather than
      // guessed from the spec, and kept as a length and a width rather than one
      // radius — see modelExtents.
      ...modelExtents(model.root, scale),
      get radius() { return Math.max(this.halfW, this.halfL); },
      love: 0,             // seconds left willing to breed
      breedCooldown: 0,    // rest before breeding again
      baby: 0,             // seconds left as a calf; 0 means fully grown
      placed: false,
      frame: { ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1 },
    };
    mob.want = mob.heading;
    if (spec.trader) {
      // Stock is rolled per individual, never per species, so two merchants a
      // world apart are carrying different things.
      mob.stock = rollStock(rng);
      mob.life = MERCHANT_LIFE;
      // A float, not a treasury. Without a cap the merchant is an infinite coin
      // faucet and any renewable block becomes a money printer — cobblestone
      // regrows as fast as you can swing at it. Rolled per individual, so which
      // trader you meet decides how much you can offload.
      mob.purse = { coins: MERCHANT_PURSE_MIN
        + Math.floor(rng() * (MERCHANT_PURSE_MAX - MERCHANT_PURSE_MIN + 1)) };
      // One standing request per trader, rolled with him. Meeting a second
      // trader is how you get a second errand, which is what keeps them worth
      // walking towards after you have bought everything you need.
      mob.request = rollRequest(rng);
    }
    if (spec.lamp) {
      // The only warm light on the planet that walks. Positioned in model units
      // — the root's scale is rewritten every frame by _animate, so anything
      // measured in cells here would be scaled twice.
      const lamp = new THREE.PointLight(0xffcf8a, 2.4, 8, 2);
      lamp.position.set(0, MobModels.modelHeight(url) * 1.15, 0);
      model.root.add(lamp);
    }
    this.list.push(mob);
    this._sync(mob);
    mob.prevPos.copy(mob.pos);
    this._animate(mob, 0, null);   // place the model now; never render at the origin
    return mob;
  }

  /**
   * Which animal belongs on this ground. Only the cold-weather rule is applied
   * — a penguin on a savanna is the one mismatch obvious enough to matter, and
   * a full biome table would be a lot of bookkeeping for little gain.
   */
  _pickWildlife(col, k) {
    // The biome, not the block underfoot. Asking the block was enough while the
    // only rule was "penguins on ice", and gets steadily wronger as the rules
    // get more specific: a patch of sand inside a forest is a riverbank, not a
    // desert, and the biome field already knows that.
    const list = SPAWN_BY_BIOME[BIOME_NAME[this.planet.colBiome[col]]] || COMMON;
    return list[(Math.random() * list.length) | 0];
  }

  /**
   * @param {boolean|undefined} cave count only cave-born (true) or only
   *   surface-born (false) hostiles; omit for the total.
   */
  _countHostile(cave) {
    let n = 0;
    for (const m of this.list) {
      if (!m.spec.hostile) continue;
      if (cave !== undefined && !!m.fromCave !== cave) continue;
      n++;
    }
    return n;
  }

  /**
   * A roofed, unlit pocket to put a husk in — a cave, a ravine, the inside of a
   * badly-lit build. Sky exposure is judged by looking straight up through the
   * column: the real light field lives in the meshing worker and is never sent
   * back, so this is the honest approximation available on this side.
   */
  _findDarkColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 26; tries++) {
      // A cave husk only has to be out of sight, and underground that is what
      // rock is for — the surface ring is far too wide down here. Searching
      // 18-40 columns out and then refusing anything within 20 units meant
      // hunting for a *second* cave beyond the one the player was standing in,
      // and caves are not that common: a player 24 blocks down saw not one husk
      // in 45 seconds. A tunnel bending away ten blocks on is out of sight.
      const col = this._walkOut(nearCol, CAVE_WALK_MIN
        + Math.floor(Math.random() * CAVE_WALK_SPAN));
      const surf = p.surfaceK(col);
      if (surf < 4) continue;

      // Scan the column for a pocket rather than probing one random layer.
      // Rock is most of what is down there — a uniform probe landed inside
      // solid stone 856 times in 900, so this search used to fail on terrain
      // long before it ever got as far as the distance test. Walking the column
      // finds the cave if the column has one, which is the actual question.
      const top = Math.min(surf - 2, D - 3);
      const pockets = [];
      for (let k = 2; k <= top; k++) {
        if (!p.solidAt(col, k)) continue;                              // needs a floor
        if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;  // and headroom
        if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
        pockets.push(k);
      }
      if (!pockets.length) continue;

      // Choose among the *roofed* pockets, rather than choosing one at random
      // and then testing it. A column often holds both a cave and the open
      // ground above it; picking blind meant landing on the surface pocket and
      // throwing the whole column away. That rejected a valid cave in 32% of
      // all tries — more than any other cause except columns with no pocket at
      // all — and left cave husks spawning at a rate of about one per 400s.
      let k = -1, seen = 0;
      for (let n = 0; n < pockets.length; n++) {
        if (!this._roofed(col, pockets[n] + 1)) continue;
        seen++;
        if (Math.random() < 1 / seen) k = pockets[n];   // reservoir sample
      }
      if (k < 0) continue;
      const { f, i, j } = colParts(col);
      cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
      const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
      if (d < CAVE_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      // Light keeps them out. This is checked last because it is the most
      // expensive test and the cheap ones reject most candidates first.
      if (this._litNear(col, k + 1)) continue;
      if (this._warded(col, k)) continue;
      return { col, k };
    }
    return null;
  }

  /**
   * A blocked hunter looks for a way through: a fan of headings either side of
   * the bearing to its target, tested a body-length ahead, best angle wins.
   *
   * This is deliberately not pathfinding. A* over a quarter of a million
   * columns is a subsystem, and the movement code in this file has a long
   * history of being broken by clever additions. A whisker fan is local, costs
   * a handful of footprint tests only on the frames a hunter is actually stuck,
   * and is enough for the case that matters: rounding a corner and finding the
   * gap in a wall. It cannot solve a maze, and is not meant to.
   *
   * @returns {number|null} a heading to steer to, or null if every way is barred
   */
  _probeAround(mob, c, here, fr, player, aim) {
    let toTarget = aim;
    if (toTarget === undefined) {
      _rel.copy(player.position).sub(mob.pos);
      const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
      const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
      toTarget = Math.atan2(rb, ra);
    }
    const reach = mob.halfL * 2 + PROBE_AHEAD;

    let best = null, bestTurn = Infinity;
    for (let n = 0; n < PROBE_ANGLES.length; n++) {
      const turn = PROBE_ANGLES[n];
      if (Math.abs(turn) >= bestTurn) continue;      // already have a straighter one
      const h = wrapAngle(toTarget + turn);
      const ni = c.ci + Math.cos(h) * reach;
      const nj = c.cj + Math.sin(h) * reach;
      if (this._footprintCost(c.f, ni, nj, here, mob, h) !== 0) continue;
      best = h;
      bestTurn = Math.abs(turn);
    }
    return best;
  }

  /**
   * Is anything burning near this cell?
   *
   * Two comments in this file already claimed torches were "what makes a torch
   * worth carrying", and the spawn search did not read light at all: a mine lit
   * end to end kept producing husks exactly as fast as a black one, so a torch
   * bought you visibility and nothing else. The real light field is built in the
   * meshing worker and never sent back, so this walks the blocks instead and
   * asks the only question that matters — has the player put a light here.
   *
   * Every column, not every other one. Sampling in steps of two looks like a
   * fair approximation and is not: it is a parity filter, so a torch at an odd
   * offset is invisible from an even-offset candidate however close it is.
   * Measured, a torch five columns from the pocket it was meant to protect read
   * as no torch at all. This runs only on candidates that have already passed
   * every cheaper test, so the full scan costs nothing worth saving.
   */
  /**
   * Is this spot inside the light of a hearth?
   *
   * Only *spawning* is refused. A husk already following you walks right into
   * the ward and swings — a safe base means one that nothing appears inside,
   * not one with an invisible wall around it.
   */
  _warded(col, k) {
    const wards = this.wards;
    if (!wards || !wards.length) return false;
    const { f, i, j } = colParts(col, _wp);
    cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
    const r = this.wardRadius || 0;
    for (let n = 0; n < wards.length; n++) {
      const w = wards[n];
      if (Math.hypot(_p[0] - w.x, _p[1] - w.y, _p[2] - w.z) < r) return true;
    }
    return false;
  }

  _litNear(col, k) {
    const p = this.planet;
    for (let dk = -LIGHT_GUARD_K; dk <= LIGHT_GUARD_K; dk++) {
      const kk = k + dk;
      if (kk < 1 || kk >= D - 1) continue;
      for (let di = -LIGHT_GUARD; di <= LIGHT_GUARD; di++) {
        for (let dj = -LIGHT_GUARD; dj <= LIGHT_GUARD; dj++) {
          const id = p.at(stepColumn(col, di, dj), kk);
          // Lava is excluded on purpose. It emits light 15, and the mantle is
          // full of it — counting it sterilised the entire cave layer: 200 of
          // the 201 candidates that got this far were rejected for lava glow
          // and nothing spawned underground at all. It is also the wrong rule
          // for the player: the mechanic they are taught is "light your mine
          // and it stays yours", and a lava lake making a cavern safe is
          // neither intuitive nor something they chose. Husks by the lava is a
          // better cave than husks nowhere.
          if (LIGHT_EMIT[id] > 0 && RENDER_TYPE[id] !== R_LIQUID) return true;
        }
      }
    }
    return false;
  }

  /**
   * Open ground for a merchant to walk in from: out of sight, but not so far
   * it is culled again on the next tick. Deliberately further out than ordinary
   * wildlife — you should come across a merchant, not have one appear beside you.
   */
  _findMerchantColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 24; tries++) {
      const col = this._walkOut(nearCol, 45 + Math.floor(Math.random() * 36));
      const k = p.surfaceK(col);
      if (k < 0 || k > D - 6) continue;
      const surf = p.at(col, k);
      if (surf !== ID.grass && surf !== ID.sand && surf !== ID.snow) continue;
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2)) continue;
      if (p.liquidAt(col, k + 1) || p.liquidAt(col, k + 2)) continue;
      const { f, i, j } = colParts(col);
      cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
      const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
      if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 30) continue;
      return { col, k };
    }
    return null;
  }

  /** Layer of the water surface at or above k — where a fish must stop rising. */
  _waterTop(col, k) {
    let top = k;
    while (top + 1 < D && this.planet.liquidAt(col, top + 1)) top++;
    return top;
  }

  /** Open water at least three deep, for the fish. */
  _findWaterColumn(nearCol, playerPos) {
    const p = this.planet;
    for (let tries = 0; tries < 30; tries++) {
      const col = this._walkOut(nearCol, 24 + Math.floor(Math.random() * SPAWN_RADIUS));
      let bed = -1;
      for (let k = D - 1; k > 1; k--) if (p.solidAt(col, k)) { bed = k; break; }
      if (bed < 1) continue;
      let depth = 0;
      while (bed + 1 + depth < D && p.liquidAt(col, bed + 1 + depth)) depth++;
      if (depth < 3) continue;
      const k = bed + Math.floor(depth * 0.4);
      if (playerPos) {
        const { f, i, j } = colParts(col);
        cellToWorld(f, i + 0.5, j + 0.5, k + 1, _p);
        const d = Math.hypot(_p[0] - playerPos.x, _p[1] - playerPos.y, _p[2] - playerPos.z);
        if (d < SPAWN_MIN_DIST || d > DESPAWN_RADIUS - 25) continue;
      }
      return { col, k };
    }
    return null;
  }

  /** Is anything solid between (col, k) and the sky? */
  /**
   * Is this cell under a real roof — stone, planks, anything but foliage?
   *
   * Leaves used to count, and they are `solid` to the physics, so a forest floor
   * read exactly like a cave. Two rules then compounded: husks spawn in roofed
   * unlit pockets, and daylight only burns a husk the sky can see. Under a
   * canopy both were true at noon, so woodland was a permanent husk factory in
   * broad daylight and the sun could not clear it. Near one spawn, 2,483 of
   * 2,612 forest-floor columns qualified as cave.
   *
   * Foliage is dappled shade, not shelter. Anything the player builds still
   * counts, so a roofed hut is as dark as it looks.
   */
  _roofed(col, k) {
    for (let kk = k + 1; kk < D; kk++) {
      const id = this.planet.at(col, kk);
      if (!id || IS_LEAF[id]) continue;
      if (IS_SOLID[id]) return true;
    }
    return false;
  }

  /** Seed the world around the player at world start. */
  populate(player, count = 16) {
    const c = player.cell;
    const startCol = cidx(c.f, Math.floor(c.ci), Math.floor(c.cj));
    for (let n = 0; n < count; n++) {
      const spot = this._findSpawnColumn(startCol, SPAWN_RADIUS, null);
      if (spot) this.spawn(this._pickWildlife(spot.col, spot.k), spot.col, spot.k);
    }
  }

  // --- simulation -----------------------------------------------------------

  _sync(mob) {
    const c = mob.cell;
    cellToWorld(c.f, c.ci, c.cj, c.ck, _p);
    mob.pos.set(_p[0], _p[1], _p[2]);
    tangentFrame(c.f, c.ci, c.cj, c.ck, mob.frame);
    mob.up.set(mob.frame.up[0], mob.frame.up[1], mob.frame.up[2]);
  }

  /** Highest solid layer at or below `fromK` in `col`. */
  /**
   * Can the animal stand at (ci, cj) with its whole body, given it is currently
   * standing on layer `hereK`?
   *
   * Testing the centre column alone — which is what this used to do — stops the
   * animal's *centre* at the wall face and leaves the rest of it buried: a
   * woolly ended up 0.29 cells inside solid stone and stayed there. Sampling
   * the footprint's extremes keeps the body out of the wall.
   */
  _footprintCost(f, ci, cj, hereK, mob, hdg) {
    const p = this.planet;
    let cost = 0;
    // Nine samples over the animal's own oriented footprint: centre, the four
    // corners and the four edge midpoints. Sampling only the axis-aligned
    // extremes left the diagonals unguarded and the widest animal clipped
    // walls it met at an angle.
    const cw = Math.cos(hdg), sw = Math.sin(hdg);
    const hw = mob.halfW, hl = mob.halfL, tall = mob.tall;
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * hw;      // across the body
      const ll = FOOT_OFF[n * 2 + 1] * hl;  // along the body
      const oi = cw * ll - sw * lw;
      const oj = sw * ll + cw * lw;
      const col = this._colOf(f, ci + oi, cj + oj);
      const gk = this._groundK(col, hereK + 1);
      // Any rise at all blocks. Letting a one-block step count as walkable is
      // what forced the height to be corrected after the fact — instantly, or
      // the body ended up inside the step. Making it an obstacle means the only
      // way up is the hop below, so the climb is always an arc.
      if (gk < 0 || gk > hereK || hereK - gk > 4) { cost++; continue; }
      // Land animals treat water as a wall. _groundK only reports solid ground,
      // so a lake bed read as ordinary walkable terrain and a chicken would
      // stroll in and keep walking along the bottom. A fish has the opposite
      // rule: water is the only place it will go.
      const wet = p.liquidAt(col, gk + 1);
      if (mob.spec.aquatic ? !wet : wet) { cost++; continue; }
      // Headroom. _groundK scans *downward* from just above the animal's feet,
      // so it reports the BOTTOM block of a wall and every wall — however tall
      // — came back as a harmless one-block step. That is what let animals
      // climb into solid stone. Standing somewhere means fitting there too.
      //
      // A ladder or an open door is `solid` but not an obstacle, and the player
      // already walks through both. Leaving them out here made a door pointless
      // — measured, the footprint cost of a doorway was 9 whether the door was
      // open or shut, so a hut with the door standing wide open was exactly as
      // safe as a sealed one and there was never a reason to close it.
      for (let h = 1; h <= tall; h++) {
        const above = p.at(col, gk + h);
        if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) {
          cost++;
          break;
        }
      }
    }
    return cost;
  }

  /**
   * Highest ground under the animal's whole footprint.
   *
   * Standing height came from the centre column alone, so an animal whose
   * leading edge had already crossed onto a step kept its old height until the
   * centre caught up — and for those frames its body was inside the riser.
   * That was the last of the sinking: every stray vertex measured was in the
   * same layer as the animal's feet, i.e. the face of the step ahead of it.
   */
  /** Is the way forward a single step the animal could stand on top of? */
  _stepAhead(mob, ci, cj, hereK) {
    const p = this.planet;
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * mob.halfW;
      const ll = FOOT_OFF[n * 2 + 1] * mob.halfL;
      const col = this._colOf(mob.cell.f, ci + (cw * ll - sw * lw), cj + (sw * ll + cw * lw));
      const gk = this._groundK(col, hereK + 1);
      if (gk !== hereK + 1) continue;              // not a one-block rise
      // ...unless the block is taller than its own cell. A fence stands 1.5,
      // and without this an animal read the top of it as an ordinary step and
      // hopped the paddock wall it was meant to be kept behind.
      if (this._topOf(col, gk) > 1) continue;
      let clear = true;
      for (let h = 1; h <= mob.tall && clear; h++) if (p.solidAt(col, gk + h)) clear = false;
      if (clear) return true;                      // somewhere up there to land
    }
    return false;
  }

  /**
   * Height of the highest surface under the animal's footprint, as a real
   * height rather than a layer index.
   *
   * This used to return the layer and every caller added one for the top. Slabs
   * and stairs broke that: their tops are at k + 0.5, so an animal on a step
   * either hovered half a block above it or stood with its feet inside. Asking
   * the block where its top is costs one lookup and works for any shape.
   *
   * @returns {number} surface height, or -1 if there is no ground below
   */
  _groundUnder(mob, f, ci, cj, fromK) {
    const cw = Math.cos(mob.heading), sw = Math.sin(mob.heading);
    let best = -1;
    for (let n = 0; n < 9; n++) {
      const lw = FOOT_OFF[n * 2] * mob.halfW;
      const ll = FOOT_OFF[n * 2 + 1] * mob.halfL;
      const col = this._colOf(f, ci + (cw * ll - sw * lw), cj + (sw * ll + cw * lw));
      const gk = this._groundK(col, fromK);
      if (gk < 0) continue;
      const surf = gk + this._topOf(col, gk);
      if (surf > best) best = surf;
    }
    return best;
  }

  /** How far above its own floor the block at (col, k) reaches, 0..1. */
  _topOf(col, k) {
    const id = this.planet.at(col, k);
    if (!IS_SHAPED[id]) return 1;
    const boxes = collisionBoxes(id, this.planet.facingAt(col, k));
    let top = 0;
    for (let b = 0; b < boxes.length; b++) if (boxes[b][5] > top) top = boxes[b][5];
    return top;
  }

  /**
   * Highest solid layer at or below `fromK`, ignoring things you can walk
   * through. An open door and a ladder are `solid` but are not floors — counted
   * as ground they read as a one-block step up in the middle of a doorway, and
   * the footprint test refuses the move for a *different* reason than the
   * headroom check does. Both have to agree or the door still cannot be walked
   * through.
   */
  _groundK(col, fromK) {
    const p = this.planet;
    for (let k = Math.min(D - 1, fromK); k >= 0; k--) {
      if (!p.solidAt(col, k)) continue;
      if (isPassable(p.at(col, k), p.facingAt(col, k))) continue;
      // Foliage is not a floor. Leaves are `solid` — you can stand on a canopy,
      // and the player is welcome to — but for anything deciding where to
      // *walk*, a canopy is a surface reachable by a one-block hop from the
      // branch beside it, and husks were quietly climbing trees and spending
      // the night standing on top of them.
      if (IS_LEAF[p.at(col, k)]) continue;
      return k;
    }
    return -1;
  }

  /**
   * Should this animal be heard right now? Near animals always are; far ones
   * only when they are roughly in front of the player, so a flock chattering
   * behind a hill stays quiet. The global cooldown is the herd limiter.
   */
  _tryVocalise(mob, dist, player) {
    if (!this.onSound) return;

    // The merchant is meant to be found by ear, and every rule below was
    // written for herd noise: a shared one-call-per-second budget it has to win
    // against sixteen animals, silence past 42 units, and past 14 a test that
    // you already be looking at it. Together those make the bell audible almost
    // only when you had already found him. He rings on his own clock, at his
    // own range, and never competes with the paddock.
    if (mob.spec.trader) {
      if (dist > BELL_RANGE) return;
      if (this.bellT > 0) return;
      this.bellT = BELL_MIN + Math.random() * (BELL_MAX - BELL_MIN);
      this.voxCount++;
      this.onSound('idle', mob);
      return;
    }

    if (dist > VOX_RANGE) return;
    if (this.voxCooldown > 0) { this.voxSuppressed++; return; }
    if (dist > VOX_NEAR) {
      const look = player.lookDir;
      if (!look) return;
      _vox.copy(mob.pos).sub(player.eye || player.position);
      if (_vox.lengthSq() < 1e-6) return;
      if (_vox.normalize().dot(look) < VOX_FACING) return;
    }
    // One call per ~0.8-1.8s across the whole world, whatever the herd size.
    // 16 animals on a 6-14s clock ask ~1.6 times a second between them, so this
    // is the difference between a paddock and a wall of noise.
    this.voxCooldown = 0.8 + Math.random();
    this.voxCount++;
    this.onSound('idle', mob);
  }

  /**
   * Keep bodies out of each other. Nothing did this before: the player could
   * stand exactly inside an animal, and a whole herd could pile onto a single
   * point — which is a large part of why they felt hollow even once they
   * stopped walking through terrain.
   *
   * A soft positional push rather than a hard stop, resolved in the tangent
   * plane. Hard collision between wandering animals gets them wedged; a nudge
   * proportional to how deep they overlap settles the herd apart on its own.
   */
  _separate(dt, player) {
    const list = this.list;
    const k = Math.min(1, dt * 9);
    for (let a = 0; a < list.length; a++) {
      const m = list[a];
      // --- against the player ---
      _rel.copy(m.pos).sub(player.position);
      const up = m.up;
      // flatten into the animal's tangent plane so nobody gets shoved skyward
      _rel.addScaledVector(up, -_rel.dot(up));
      const want = m.radius + PLAYER_RADIUS;
      let d = _rel.length();
      if (d < want) {
        if (d < 1e-4) { _rel.set(up.z, up.x, up.y).cross(up).normalize(); d = 1e-4; }
        else _rel.multiplyScalar(1 / d);
        // the animal yields; the player is not shoved around by livestock
        this._nudge(m, _rel, (want - d) * k);
      }
      // --- against each other ---
      for (let b = a + 1; b < list.length; b++) {
        const o = list[b];
        _rel.copy(m.pos).sub(o.pos);
        _rel.addScaledVector(up, -_rel.dot(up));
        const w2 = m.radius + o.radius;
        let d2 = _rel.length();
        if (d2 >= w2) continue;
        if (d2 < 1e-4) {
          _rel.set(Math.cos(m.id * 2.4), 0, Math.sin(m.id * 2.4));
          _rel.addScaledVector(up, -_rel.dot(up)).normalize();
          d2 = 1e-4;
        } else _rel.multiplyScalar(1 / d2);
        const push = (w2 - d2) * k * 0.5;
        this._nudge(m, _rel, push);
        this._nudge(o, _rel, -push);
      }
    }
  }

  /** Shift a mob by `amount` along a world-space tangent direction. */
  _nudge(mob, dir, amount) {
    const fr = mob.frame;
    const di = (dir.x * fr.ea[0] + dir.y * fr.ea[1] + dir.z * fr.ea[2]) / fr.arcA;
    const dj = (dir.x * fr.eb[0] + dir.y * fr.eb[1] + dir.z * fr.eb[2]) / fr.arcB;
    const here = this._groundUnder(mob, mob.cell.f, mob.cell.ci, mob.cell.cj,
      Math.floor(mob.cell.ck + 0.02));
    const ni = mob.cell.ci + di * amount;
    const nj = mob.cell.cj + dj * amount;
    // never let a shove put an animal somewhere it could not have walked
    const cost = this._footprintCost(mob.cell.f, mob.cell.ci, mob.cell.cj, here, mob, mob.heading);
    const ok = (c2) => c2 === 0 || c2 < cost;
    if (ok(this._footprintCost(mob.cell.f, ni, mob.cell.cj, here, mob, mob.heading))) mob.cell.ci = ni;
    if (ok(this._footprintCost(mob.cell.f, mob.cell.ci, nj, here, mob, mob.heading))) mob.cell.cj = nj;
  }

  /** Does open sky reach this mob? Cheap column probe — see _findDarkColumn. */
  _skyLit(mob) {
    const col = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    return !this._roofed(col, Math.floor(mob.cell.ck));
  }

  /**
   * Hostile decision-making. Sets the desired heading and state, and swings
   * when close enough; the caller does the actual moving.
   *
   * @returns {boolean} true if it is hunting, so the wander logic stands down
   */
  _hunt(mob, dt, dist, player, fr) {
    const spec = mob.spec;
    // Aggro is straight-line, with no notion of whether the player can actually
    // be reached — through a cavern roof, they are ten cells away. A husk that
    // has been chasing for nine seconds without closing any ground is chasing
    // something on the other side of the rock, and standing there aggroed
    // forever is both eerie in the wrong way and a waste of a hostile slot.
    if (mob.huntCooldown > 0) {
      mob.huntCooldown -= dt;
      mob.target = null;
      return false;
    }
    // Losing interest at a longer range than it gains it stops a husk on the
    // edge of the aggro ring flickering between hunting and milling about.
    if (dist < spec.aggroRange) {
      if (mob.target !== 'player') { mob.bestDist = dist; mob.stallT = 0; }
      mob.target = 'player';
    } else if (dist > spec.aggroRange * 1.6) mob.target = null;
    if (!mob.target) return false;

    // Only count the stall while it is still trying to *travel*. A husk stood
    // in your face swinging cannot improve its best distance either, and would
    // otherwise decide it was stuck and wander off mid-fight — the exact
    // opposite of what this is for.
    const closing = dist > spec.reach + mob.radius;
    // Walking a route counts as progress even though it is not closing the
    // straight-line gap — and often precisely because it is not. Getting out of
    // a three-sided pen means walking away from the player for eight or nine
    // cells, which is exactly what "nine seconds without getting any closer"
    // was written to catch. The two rules are individually sensible and
    // together they mean a husk gives up at the furthest point of every detour
    // it takes: measured on a pen, neither pathing nor not-pathing ever reached
    // the player, because the hunt was called off mid-way round. Consuming
    // waypoints is the honest measure of progress while a route exists.
    if (mob.onPath && mob.pathI > (mob.stallPathI ?? -1)) {
      mob.stallPathI = mob.pathI;
      mob.stallT = 0;
    }
    if (dist < mob.bestDist - 0.4) { mob.bestDist = dist; mob.stallT = 0; }
    else if (closing) {
      mob.stallT += dt;
      if (mob.stallT > HUNT_STALL) {
        mob.target = null;
        mob.huntCooldown = HUNT_COOLDOWN;
        mob.stallT = 0;
        mob.bestDist = Infinity;
        return false;
      }
    } else {
      mob.stallT = 0;
    }

    // Face the player, in the husk's own tangent frame so it stays correct
    // across a cube seam.
    _rel.copy(player.position).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = Math.atan2(rb, ra);

    // ...unless there is something in the way, in which case walk the route
    // rather than the bearing. The whisker probe further down can lean around a
    // boulder but has no idea a wall has a door in it twelve cells to the left;
    // it turns toward whichever whisker is clear and, against a long obstacle,
    // slides along it forever. A path knows about the door.
    const via = this._pathBearing(mob, dt, player, fr);
    if (via !== null) mob.want = via;

    // Close the distance, then stop and swing. Walking into the player would
    // shove them around — _separate already pushes bodies apart.
    const reach = spec.reach + mob.radius;
    if (dist > reach) {
      mob.state = 'chase';
    } else {
      mob.state = 'idle';
      if (mob.swingT <= 0) {
        mob.swingT = spec.swing;
        MobModels.playOnce(mob.model, spec.clips.attack, 1.35);
        if (this.onSound) this.onSound('hurt', mob);
        // The hit lands on the swing, not on the decision to swing, so there is
        // a moment to back out of range.
        this._pendingHits.push({ mob, at: 0.28, dmg: spec.damage });
      }
    }
    mob.stateT = 0.5;
    return true;
  }

  // --- pathfinding ----------------------------------------------------------

  /**
   * Bearing to the next waypoint of a route to the player, or null to just walk
   * at them.
   *
   * The route is recomputed on a timer rather than every frame, and only while
   * something is actually hunting — at most a handful of hostiles exist at once
   * and each search is bounded, so the whole system costs a few hundred
   * microseconds a second. Between searches the mob walks its existing path,
   * which is what stops it dithering when the player moves a step.
   */
  _pathBearing(mob, dt, player, fr) {
    const goal = this._colOf(player.cell.f, player.cell.ci, player.cell.cj);
    mob.pathT = (mob.pathT ?? 0) - dt;
    const stale = mob.pathGoal !== goal && mob.pathT <= 0;
    if (!mob.path || stale || mob.pathT <= -PATH_MAX_AGE) {
      mob.pathT = PATH_PERIOD;
      mob.pathGoal = goal;
      mob.path = this._findPath(mob, goal);
      mob.pathI = 0;
      // A fresh route restarts the progress clock, or the stall test would
      // compare waypoint indices from two different paths.
      mob.stallPathI = -1;
    }
    const path = mob.path;
    mob.onPath = false;
    if (!path || mob.pathI >= path.length) return null;

    // Advance through waypoints we have already reached — after a jump or a
    // shove a mob can skip one, and steering back to it walks it backwards.
    const c = mob.cell;
    const here = this._colOf(c.f, c.ci, c.cj);
    for (let n = mob.pathI; n < Math.min(path.length, mob.pathI + 3); n++) {
      if (path[n] === here) mob.pathI = n + 1;
    }
    if (mob.pathI >= path.length) return null;

    // Aim several waypoints ahead, not at the next one. Waypoints are adjacent
    // columns, so steering at the very next one means steering at a point about
    // one body-length away: the mob overshoots it, turns back, overshoots
    // again, and crawls along the route oscillating — slowly enough that the
    // stall detector decides it is stuck and calls the hunt off. Looking
    // further down the path gives it a heading worth committing to, and the
    // corners still get taken because the waypoints are consumed in order.
    const aimAt = Math.min(mob.pathI + PATH_LOOKAHEAD, path.length - 1);
    const p = colParts(path[aimAt], _pp);
    cellToWorld(p.f, p.i + 0.5, p.j + 0.5, c.ck, _p);
    _rel.set(_p[0] - mob.pos.x, _p[1] - mob.pos.y, _p[2] - mob.pos.z);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    if (Math.abs(ra) < 1e-5 && Math.abs(rb) < 1e-5) return null;
    mob.onPath = true;
    return Math.atan2(rb, ra);
  }

  /**
   * A* over columns, from the mob to the player.
   *
   * Bounded three ways: a radius, a node budget, and a step limit. A husk that
   * cannot find a way through inside that budget gets null and falls back to
   * walking at the player and leaning around whatever it bumps into, which is
   * what it always did — so the worst case is the old behaviour rather than a
   * frame spike.
   *
   * @returns {number[]|null} columns from the first step to the goal
   */
  _findPath(mob, goal) {
    const start = this._colOf(mob.cell.f, mob.cell.ci, mob.cell.cj);
    if (start === goal) return null;
    const startK = this._groundK(start, Math.floor(mob.cell.ck) + 1);
    if (startK < 0) return null;

    const gScore = new Map([[start, 0]]);
    const kAt = new Map([[start, startK]]);
    const came = new Map();
    const open = new Heap();
    open.push(start, this._colDist(start, goal));
    let expanded = 0;

    while (open.size && expanded < PATH_BUDGET) {
      const cur = open.pop();
      if (cur === goal) return this._unwind(came, cur);
      expanded++;
      const g0 = gScore.get(cur);
      if (g0 >= PATH_MAX_STEPS) continue;
      const k0 = kAt.get(cur);
      for (let d = 0; d < 4; d++) {
        const nb = colNeighbor(cur, d);
        if (nb < 0) continue;
        const k1 = this._stepTo(nb, k0, mob);
        if (k1 < 0) continue;
        const g1 = g0 + 1;
        if (gScore.has(nb) && gScore.get(nb) <= g1) continue;
        gScore.set(nb, g1);
        kAt.set(nb, k1);
        came.set(nb, cur);
        open.push(nb, g1 + this._colDist(nb, goal));
      }
    }
    return null;
  }

  /**
   * Can a body standing on layer `fromK` walk into this column, and onto what?
   * @returns {number} the layer it would stand on, or -1 if it cannot go there
   */
  _stepTo(col, fromK, mob) {
    const p = this.planet;
    const gk = this._groundK(col, fromK + 1);
    if (gk < 0) return -1;
    if (gk - fromK > 1) return -1;                 // too big a step up
    if (fromK - gk > PATH_MAX_DROP) return -1;     // too far to fall
    if (mob.spec.aquatic ? !p.liquidAt(col, gk + 1) : p.liquidAt(col, gk + 1)) return -1;
    for (let h = 1; h <= mob.tall; h++) {
      const above = p.at(col, gk + h);
      if (IS_SOLID[above] && !isPassable(above, p.facingAt(col, gk + h))) return -1;
    }
    return gk;
  }

  /** Straight-line distance between two column centres, in world units. */
  _colDist(a, b) {
    const pa = colParts(a, _pp);
    cellToWorld(pa.f, pa.i + 0.5, pa.j + 0.5, R_SEA - R_MIN, _p);
    const ax = _p[0], ay = _p[1], az = _p[2];
    const pb = colParts(b, _pp);
    cellToWorld(pb.f, pb.i + 0.5, pb.j + 0.5, R_SEA - R_MIN, _p);
    return Math.hypot(ax - _p[0], ay - _p[1], az - _p[2]);
  }

  _unwind(came, end) {
    const out = [];
    let cur = end;
    while (came.has(cur)) { out.push(cur); cur = came.get(cur); }
    out.reverse();
    return out.length ? out : null;
  }

  /**
   * A fed animal walks to the nearest other fed animal of its kind.
   *
   * `_tickBreeding` only ever *checked* whether two willing animals were within
   * BREED_RANGE; nothing moved them together, so a pair had to already be
   * within 4.5 cells when you fed them. Measured: two cows ten cells apart
   * closed to 9.7 over the whole 22-second window and never paired. Feeding
   * worked and breeding did not, unless the animals happened to be touching.
   *
   * @returns {boolean} true if it is walking to a mate, so wandering stands down
   */
  _court(mob, fr) {
    if (mob.love <= 0 || mob.baby > 0 || mob.breedCooldown > 0) return false;
    let best = null, bestD = COURT_RANGE * COURT_RANGE;
    for (const o of this.list) {
      if (o === mob || o.type !== mob.type) continue;
      if (o.love <= 0 || o.baby > 0 || o.breedCooldown > 0) continue;
      const d = mob.pos.distanceToSquared(o.pos);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return false;
    // Close enough for _tickBreeding to pair them this frame; stop and let it.
    if (bestD <= BREED_RANGE * BREED_RANGE) { mob.state = 'idle'; mob.stateT = 0.4; return true; }

    _rel.copy(best.pos).sub(mob.pos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    mob.want = Math.atan2(rb, ra);
    mob.state = 'chase';
    mob.stateT = 0.5;
    return true;
  }

  /** Resolve attack swings whose contact frame has arrived. */
  _resolveHits(dt, player) {
    for (let n = this._pendingHits.length - 1; n >= 0; n--) {
      const h = this._pendingHits[n];
      h.at -= dt;
      if (h.at > 0) continue;
      this._pendingHits.splice(n, 1);
      // The mob may have died or been knocked away between swing and contact.
      if (h.mob.health <= 0 || h.mob.dying > 0) continue;
      const reach = h.mob.spec.reach + h.mob.radius + 0.35;
      if (h.mob.pos.distanceTo(player.position) > reach) continue;
      if (this.onAttack) this.onAttack(h.dmg, h.mob);
    }
  }

  /**
   * Kill a mob: spill its drops, then either play the death clip or remove it
   * at once. `drops` can be overridden — a calf leaves nothing behind.
   */
  _die(mob, drops = mob.spec.drops) {
    const dieClip = mob.spec.clips.die;
    // Killing the merchant costs you the merchant. The body is removed by one
    // of two paths below, so the wait is started here where both pass through.
    if (mob.spec.trader) this.merchantT = MERCHANT_COOLDOWN;
    for (const [name, min, max] of drops) {
      const id = itemIdOf(name);
      if (!id) continue;
      const count = min + Math.floor(Math.random() * (max - min + 1));
      // Lift the drop along the mob's own up, not world +Y. On a sphere those
      // only agree at the north pole; everywhere else `+0.3` in Y was a sideways
      // nudge, and at the equator it pushed loot straight into the hillside.
      if (count > 0) {
        this.drops.spawn(
          mob.pos.x + mob.up.x * 0.3,
          mob.pos.y + mob.up.y * 0.3,
          mob.pos.z + mob.up.z * 0.3,
          id, count,
        );
      }
    }
    if (this.onSound) this.onSound('death', mob);
    if (dieClip && mob.model.actions[dieClip]) {
      // Leave the body long enough to read as a death rather than a despawn.
      mob.health = 0;
      mob.dying = 1.1;
      mob.speedNow = 0;
      return;
    }
    const idx = this.list.indexOf(mob);
    if (idx >= 0) { this._release(mob); this.list.splice(idx, 1); }
  }

  update(dt, player, sky) {
    this.voxCooldown = Math.max(0, this.voxCooldown - dt);
    this.bellT = Math.max(0, this.bellT - dt);
    this.merchantT = Math.max(0, this.merchantT - dt);
    this._resolveHits(dt, player);
    this._tickBreeding(dt);

    // Is the sun up where the player is standing? On a planet this is local,
    // not global — the far side is in night at the same moment.
    this.daylight = sky ? sky.sunDir.dot(player.up) : 1;
    const night = this.daylight < 0.02;

    // top up the population near the player
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 6;
      const playerCol = this._colOf(player.cell.f, player.cell.ci, player.cell.cj);
      if (this.list.length < MAX_MOBS * 0.7) {
        const spot = this._findSpawnColumn(playerCol, SPAWN_RADIUS, player.position);
        if (spot) this.spawn(this._pickWildlife(spot.col, spot.k), spot.col, spot.k);
      }
      // Fish come from the water, not the shore, so they get their own search.
      if (this.list.length < MAX_MOBS * 0.85 && Math.random() < 0.4) {
        const wet = this._findWaterColumn(playerCol, player.position);
        if (wet) this.spawn('fish', wet.col, wet.k);
      }
      // Husks come out of the dark: after sunset in the open, and at any hour
      // underground. That is what makes a cave dangerous rather than just dim,
      // and what makes a torch worth carrying.
      // Surface and cave husks draw on separate budgets. Sharing one was a slow
      // poison: cave husks spawn at any hour and, sealed in a cavern under your
      // feet, count as "nearby" on straight-line distance while never being
      // able to reach you. After twenty minutes of play six of the seven slots
      // were held by husks in a dungeon the player had never entered, so night
      // on the surface spawned nothing and a player could stand in the open
      // until dawn untouched. Measured: seven hostiles alive, six aggroed, none
      // of them within thirty seconds' walk of anything.
      // A brand-new world holds them off for a few minutes. The planet keeps
      // the player's own clock now, so starting a new game after dark is
      // ordinary rather than exceptional — and measured, that opening was
      // unplayable: first hit two seconds in, dead inside a minute, seven
      // hostiles already up, against someone with an empty inventory who has
      // not yet found the mouse. Night is meant to be the pressure that makes
      // torches and walls matter, not a loading screen you die on.
      if (night && !this.spawnGrace && this._countHostile(false) < MAX_HOSTILE_SURFACE) {
        const spot = this._findSpawnColumn(playerCol, SPAWN_RADIUS, player.position);
        if (spot) { const m = this.spawn('husk', spot.col, spot.k); if (m) m.fromCave = false; }
      }
      if (!this.spawnGrace && this._countHostile(true) < MAX_HOSTILE_CAVE) {
        const spot = this._findDarkColumn(playerCol, player.position);
        if (spot) { const m = this.spawn('husk', spot.col, spot.k); if (m) m.fromCave = true; }
      }
      // The merchant. Same surface search as the wildlife — it has to arrive on
      // ground it can walk on — but gated on its own clock rather than on the
      // headcount, so it is never crowded out by a full paddock.
      if (this.merchantT <= 0 && !this.merchant() && Math.random() < MERCHANT_CHANCE) {
        const spot = this._findMerchantColumn(playerCol, player.position);
        const mob = spot ? this.spawn('merchant', spot.col, spot.k) : null;
        if (mob) this.onMerchant?.(mob);
      }
    }

    for (let n = this.list.length - 1; n >= 0; n--) {
      const mob = this.list[n];
      const c = mob.cell, spec = mob.spec, fr = mob.frame;

      const dist = mob.pos.distanceTo(player.position);
      if (dist > DESPAWN_RADIUS) {
        if (spec.trader) this._retireMerchant(mob, n);
        else { this._release(mob); this.list.splice(n, 1); }
        continue;
      }

      // A merchant has somewhere else to be. Letting one linger indefinitely
      // would turn a chance meeting into a shop you could pin to a landmark.
      if (spec.trader) {
        mob.life -= dt;
        if (mob.life <= 0) { this._retireMerchant(mob, n); continue; }
      }

      mob.hurtT = Math.max(0, mob.hurtT - dt);
      mob.slideT = Math.max(0, mob.slideT - dt);
      mob.stateT -= dt;
      mob.idleT += dt;
      mob.swingT = Math.max(0, mob.swingT - dt);

      // A husk killed by the sun plays out its death before it is removed.
      if (mob.dying > 0) {
        mob.dying -= dt;
        mob.speedNow = 0;
        this._animate(mob, dt, sky);
        if (mob.dying <= 0) { this._release(mob); this.list.splice(n, 1); }
        continue;
      }

      // --- daylight burns the undead ---
      if (spec.burns && this.daylight > 0.06 && this._skyLit(mob)) {
        mob.burnT += dt;
        if (mob.burnT > 0.35 && this.onBurn) this.onBurn(mob);
        if (mob.burnT > BURN_SECONDS) {
          // Note the missing second argument: passing `null` here made `drops`
          // null rather than defaulting, the for-of threw, and the frame's
          // try/catch swallowed it — so husks burned for ninety seconds and
          // never died.
          this._die(mob);
          continue;
        }
      } else if (mob.burnT > 0) {
        mob.burnT = Math.max(0, mob.burnT - dt * 2);
      }

      // idle vocalisation on the animal's own jittered clock. The clock always
      // resets, whether or not the call was actually allowed through, so a mob
      // that was out of earshot doesn't fire the instant you walk up to it.
      mob.voxT -= dt;
      if (mob.voxT <= 0) {
        // A bell you hear once every fourteen seconds is not something you can
        // navigate by; the merchant keeps a much tighter clock than the herd.
        mob.voxT = spec.trader
          ? BELL_MIN + Math.random() * (BELL_MAX - BELL_MIN)
          : VOX_MIN + Math.random() * (VOX_MAX - VOX_MIN);
        this._tryVocalise(mob, dist, player);
      }

      // A hostile only decides *where it wants to go* differently; everything
      // below — steering, the footprint test, hopping a step, the seam handling
      // — is the same hard-won movement code the animals use.
      const hunting = spec.hostile && this._hunt(mob, dt, dist, player, fr);
      // Courtship steers the same way hunting does, and for the same reason:
      // wandering will not reliably bring two animals together inside the love
      // window. Fleeing still wins — a spooked animal has other priorities.
      const courting = !hunting && this._court(mob, fr);

      // --- behaviour: pick a *desired* heading, never assign the real one ---
      const wasFleeing = mob.state === 'flee';
      if (!hunting && !courting && mob.stateT <= 0) {
        if (wasFleeing) {
          mob.state = 'idle';
          mob.stateT = 1 + Math.random() * 2;
        } else if (mob.state === 'walk') {
          mob.state = Math.random() < spec.grazeChance ? 'graze' : 'idle';
          mob.stateT = spec.idleMin + Math.random() * (spec.idleMax - spec.idleMin);
        } else {
          mob.state = 'walk';
          mob.stateT = 2 + Math.random() * 4;
          // steer by a bounded turn from the current heading rather than
          // jumping to an arbitrary one — that snap read as a teleport
          mob.want = wrapAngle(mob.heading + (Math.random() - 0.5) * 2.6);
        }
      }
      if (!hunting && !wasFleeing && dist < 3.4 * spec.skittish && spec.skittish > 0.5) {
        mob.state = 'flee';
        mob.stateT = 1.6 + Math.random();
        _rel.copy(mob.pos).sub(player.position);
        const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
        const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
        mob.want = Math.atan2(rb, ra);
      }

      const fleeing = mob.state === 'flee';
      const chasing = mob.state === 'chase';
      const moving = mob.state === 'walk' || fleeing || chasing;
      const targetSpeed = moving ? spec.speed * (fleeing ? 2.0 : 1) : 0;

      // --- steering: limited turn rate, smooth acceleration -----------------
      const turn = spec.turn * (fleeing ? 1.6 : chasing ? 1.35 : 1) * dt;
      const dh = wrapAngle(mob.want - mob.heading);
      mob.heading = wrapAngle(mob.heading + clamp(dh, -turn, turn));

      const kAcc = 1 - Math.exp(-spec.accel * dt);   // frame-rate independent
      mob.speedNow += (targetSpeed - mob.speedNow) * kAcc;
      if (mob.speedNow < 0.005) mob.speedNow = 0;

      // --- integrate in cell space ------------------------------------------
      const ch = Math.cos(mob.heading), sh = Math.sin(mob.heading);
      mob.vel.i = ch * mob.speedNow / fr.arcA;
      mob.vel.j = sh * mob.speedNow / fr.arcB;

      // Knockback rides on top of steering rather than replacing it, so a husk
      // is shoved back while still facing you and closes again the moment it
      // lands. Steering alone could never express this: horizontal velocity is
      // rebuilt from heading every frame, so a blow had nowhere to go and two
      // husks could stand inside your hitbox trading damage until one of you
      // fell over. This is the beat that makes a fight a fight.
      if (mob.knockT > 0) {
        const decay = mob.knockT / KNOCK_TIME;
        mob.vel.i += mob.knockA * decay / fr.arcA;
        mob.vel.j += mob.knockB * decay / fr.arcB;
        mob.knockT = Math.max(0, mob.knockT - dt);
      }

      // A fish is neutrally buoyant while it is in water, and drops like
      // anything else the moment it is not — so one flung onto the bank flaps
      // its way back down rather than hovering over the grass. Without this it
      // would sink and walk the lake bed, which is the one thing worse than
      // having no fish at all.
      const swimming = spec.aquatic
        && this.planet.liquidAt(this._colOf(c.f, c.ci, c.cj), Math.floor(c.ck));
      mob.swimming = swimming;
      if (swimming) {
        // gentle rise and fall on its own clock, and it never leaves the water
        const ceilK = this._waterTop(this._colOf(c.f, c.ci, c.cj), Math.floor(c.ck));
        const want = Math.sin(mob.idleT * 0.6 + mob.seed) * 0.45;
        mob.vel.k += (want - mob.vel.k) * Math.min(1, dt * 3);
        if (c.ck > ceilK - 0.6) mob.vel.k = Math.min(mob.vel.k, -0.2);
      } else {
        mob.vel.k -= GRAVITY * dt;
      }

      const ni = c.ci + mob.vel.i * dt;
      const nj = c.cj + mob.vel.j * dt;

      // Cross-face-safe column lookups. The old code did cidx(c.f, floor(ci),
      // floor(cj)) with the indices merely clamped, so at a cube seam it probed
      // a column on the WRONG face; the ground snap below then teleported the
      // animal to that column's height.
      // The block directly under the feet — NOT the highest ground under the
      // footprint. _groundUnder takes the max, which is right for deciding how
      // high to stand (it keeps the body out of a step's riser) but wrong for
      // deciding whether a move is legal: the moment the animal's nose reached
      // over a step it counted as already standing on it, so the step stopped
      // reading as a rise and the hop never fired.
      const here = Math.floor(c.ck + 0.02) - 1;
      // Resolve the axes separately so a blocked animal slides along the wall
      // instead of stopping dead and pirouetting in place.
      // An animal that spawned in a tree, or was walled in by a player, already
      // fails the footprint test where it stands. Gating on the destination
      // alone would freeze it there forever — 13 of 16 of a wild herd, as it
      // turned out. If it is already overlapping, let it walk out.
      // Compare overlap rather than demanding the destination be perfect. A
      // binary "am I clear?" gate has two failure modes and this avoids both:
      // an animal that spawned inside a tree would be frozen forever, while
      // one merely *touching* a wall would count as stuck and be waved through
      // it. Moving is allowed whenever it does not make the overlap worse.
      // A move is allowed only if the destination is fully clear, or if it
      // *strictly* reduces the overlap. Merely "no worse" was not enough: an
      // animal already touching a wall could swap one blocked sample for
      // another and slide onward into the stone at no cost, which is what kept
      // bodies sunk into blocks. Strict improvement still lets one that spawned
      // inside a tree walk itself free.
      const costHere = this._footprintCost(c.f, c.ci, c.cj, here, mob, mob.heading);
      const ok = (cost) => cost === 0 || cost < costHere;
      const fromCi = c.ci, fromCj = c.cj;
      const okI = ok(this._footprintCost(c.f, ni, c.cj, here, mob, mob.heading));
      const okJ = ok(this._footprintCost(c.f, c.ci, nj, here, mob, mob.heading));
      if (okI) c.ci = ni;
      if (okJ) c.cj = nj;
      // Hop when the way *forward* is barred, not only when both axes are.
      // Gating on "moved nowhere" meant an animal still sliding along the wall
      // on its other axis never jumped — it just shuffled sideways forever
      // against the step it was trying to climb.
      const moved = okI || okJ;
      const blockedAhead = !okI || !okJ;
      if (blockedAhead && mob.speedNow > 0.02) {
        if (mob.grounded && this._stepAhead(mob, ni, nj, here)) {
          // A step it could stand on: push off and let gravity do the rest.
          // The move stays refused until the animal is genuinely above the
          // step, at which point the footprint clears on its own and it walks
          // on in mid-air. Real arc, and the body is never inside the block.
          mob.vel.k = Math.sqrt(2 * GRAVITY * 1.30);
          mob.grounded = false;
        } else if (!moved) {
          // veer, don't spin: nudge the desired heading and let the turn-rate
          // limiter rotate the model there over several frames
          //
          // A hunter veers a fixed way and keeps its speed, so it slides along
          // whatever it walked into instead of milling in front of it. Facing
          // straight at a wall leaves no lateral velocity to slide with — a
          // husk pressed against a hut simply stopped there, which meant it
          // could never find the doorway and an open door was as safe as a shut
          // one. It commits to a side for a while rather than re-rolling every
          // frame, because a direction chosen afresh sixty times a second
          // averages out to standing still.
          if (mob.target === 'player') {
            // Before committing to a side, look for a way through. Sliding
            // finds a gap only by luck; probing a fan of headings finds the
            // doorway on the frame it comes into view, which is the difference
            // between a door that matters and one that does not.
            //
            // The probe deliberately still aims at the *player*, not at the
            // route's next waypoint, even while a route is being followed.
            // Aiming it at the waypoint sounds obviously right — local
            // avoidance serving the route rather than arguing with it — and
            // measured worse across the board: the long-wall case went from
            // reaching the player in 5.5s to never reaching them at all. When a
            // body is pressed against a wall its next waypoint is usually
            // straight through that wall, so every whisker reads as blocked,
            // the probe returns null, and the mob falls through to a wall-slide
            // in a random direction that no longer has anything to do with
            // where the player is. Aiming at the player keeps the slide biased
            // toward the goal, which is what actually finds gaps.
            const probed = this._probeAround(mob, c, here, fr, player);
            if (probed !== null) {
              mob.want = probed;
              mob.slideT = 0;              // a way through beats going round
            } else {
              if (mob.slideT <= 0) {
                mob.slideT = WALL_SLIDE_TIME;
                mob.slideDir = Math.random() < 0.5 ? -1 : 1;
              }
              mob.want = wrapAngle(mob.want + mob.slideDir * WALL_SLIDE_TURN);
            }
            mob.speedNow *= 0.9;
          } else {
            mob.want = wrapAngle(mob.heading + (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 0.9));
            mob.speedNow *= 0.35;
          }
        }
      }

      const prevCk = c.ck;
      c.ck += mob.vel.k * dt;
      const col = this._colOf(c.f, c.ci, c.cj);

      // Ceiling. There was none at all, so an animal under an overhang pushed
      // its head into the block above and nothing ever stopped it rising.
      if (mob.vel.k > 0) {
        const headK = Math.floor(c.ck + mob.tall);
        if (this.planet.solidAt(col, headK)) {
          c.ck = Math.min(c.ck, headK - mob.tall);
          mob.vel.k = 0;
        }
      }

      // Floor. The scan starts from where the animal *was*, not from a cell
      // above where it now is: starting high let it discover the block above
      // its head — a tree trunk, say — and "land" on top of it, then repeat
      // the next frame. That is what walked animals up trunks to the canopy,
      // a block per frame. The lift is also capped at one block, so a genuine
      // step up still works but nothing can escalate.
      // `floor` is a real height now, not a layer index — see _groundUnder.
      const floor = this._groundUnder(mob, c.f, c.ci, c.cj, Math.floor(prevCk + 0.02));

      // A swimmer never snaps to the lake bed — that ground clamp is exactly
      // what would make a fish walk along the bottom.
      if (swimming) {
        if (floor >= 0 && c.ck < floor) { c.ck = floor; mob.vel.k = Math.max(0, mob.vel.k); }
        mob.grounded = false;
      } else if (floor >= 0 && c.ck < floor && floor - c.ck <= 1.05) {
        // Climb a step by raising the real position at a bounded rate, not by
        // snapping it and then *drawing the animal lower* to hide the pop. That
        // is what the old stepLag did, and it rendered the body up to 2.5 cells
        // below where it actually was — i.e. buried in the block it had just
        // climbed. Collision was right; the visible animal was inside terrain.
        // Keeping drawn and physical positions identical is the whole fix.
        // Resolve the height in the same frame as the horizontal move, and
        // draw the animal exactly where it is. Both of the alternatives put the
        // body inside geometry: the old stepLag drew it *below* its position —
        // buried in the block it had just climbed — and easing the real height
        // upward leaves it half-inside the step for as long as the ease lasts,
        // because the horizontal move onto the step has already happened. A
        // one-block pop is brief and honest; a body inside a block is not.
        c.ck = floor;
        mob.vel.k = 0;
        // hoppers bounce along instead of gliding
        if (spec.hops && moving && Math.random() < dt * 2.6) mob.vel.k = spec.hopImpulse;
        mob.grounded = true;
      } else {
        mob.grounded = false;
      }
      if (c.ck < 1) { c.ck = 1; mob.vel.k = 0; }

      // Carry the heading through a cube seam in world space, exactly as the
      // player does with its velocity — otherwise the tangent basis flips and
      // the animal whips round on the spot.
      if (c.ci < 0 || c.ci >= F || c.cj < 0 || c.cj >= F) {
        _seam.set(
          fr.ea[0] * ch + fr.eb[0] * sh,
          fr.ea[1] * ch + fr.eb[1] * sh,
          fr.ea[2] * ch + fr.eb[2] * sh,
        );
        normalizeCell(c);
        this._sync(mob);
        const na = _seam.x * fr.ea[0] + _seam.y * fr.ea[1] + _seam.z * fr.ea[2];
        const nb = _seam.x * fr.eb[0] + _seam.y * fr.eb[1] + _seam.z * fr.eb[2];
        const nh = Math.atan2(nb, na);
        mob.want = wrapAngle(mob.want + wrapAngle(nh - mob.heading));
        mob.heading = nh;
      } else {
        this._sync(mob);
      }

      this._animate(mob, dt, sky);
    }

    // Bodies last: shove anything overlapping apart, then re-place the models
    // so the nudge shows this frame rather than the next.
    this._separate(dt, player);
    for (const mob of this.list) this._sync(mob);
  }

  // --- presentation ---------------------------------------------------------

  _animate(mob, dt, sky) {
    const spec = mob.spec, fr = mob.frame, model = mob.model;

    mob.prevPos.copy(mob.pos);

    // --- orientation ---
    // Face the direction of travel, standing on the local up. The head sits at
    // local +Z, so +Z must map to forward — mapping it to -forward walks the
    // animal backwards.
    _fwd.set(0, 0, 0);
    _axis.fromArray(fr.ea); _fwd.addScaledVector(_axis, Math.cos(mob.heading));
    _axis.fromArray(fr.eb); _fwd.addScaledVector(_axis, Math.sin(mob.heading));
    if (_fwd.lengthSq() < 1e-6) _fwd.fromArray(fr.ea);
    _fwd.normalize();
    // up x fwd keeps the basis right-handed with +Z = forward
    _side.crossVectors(mob.up, _fwd).normalize();
    _m.makeBasis(_side, mob.up, _fwd);
    _q.setFromRotationMatrix(_m);

    const root = model.root;
    if (!mob.placed) { root.quaternion.copy(_q); mob.placed = true; }
    else root.quaternion.slerp(_q, 1 - Math.exp(-16 * dt));

    _rpos.copy(mob.pos);
    root.position.copy(_rpos);
    root.scale.setScalar(mob.scale * growthScale(mob) * (mob.hurtT > 0 ? 1.09 : 1));

    // --- animation ---
    // The clips carry the whole performance — gait, idle sway, the eating dip.
    // Choosing one is all that is left, and the mixer crossfades between them.
    let clip = spec.clips.idle;
    if (mob.dying > 0) clip = spec.clips.die || spec.clips.idle;
    else if (mob.speedNow > spec.speed * 1.25) clip = spec.clips.run;
    else if (mob.speedNow > 0.06) clip = spec.clips.walk;
    else if (mob.state === 'graze') clip = spec.clips.graze;
    MobModels.play(model, clip, mob.placedClip ? 0.2 : 0, mob.dying > 0);
    mob.placedClip = true;

    // Play the walk faster the quicker it moves, so feet do not skate. The
    // clips are authored at roughly one unit per second.
    const walking = clip === spec.clips.walk || clip === spec.clips.run;
    const act = model.actions[clip];
    if (act && walking) {
      const base = clip === spec.clips.run ? spec.speed * 2 : spec.speed;
      act.setEffectiveTimeScale(clamp(mob.speedNow / Math.max(0.15, base), 0.45, 2.2));
    } else if (act) {
      act.setEffectiveTimeScale(1);
    }
    model.mixer.update(dt);

    // --- damage and fire tint ---
    // Multiplied into the texture rather than added on top of it, so a struck
    // animal reddens instead of glowing. `owned` is this mob's own material
    // clones; the map inside them is shared and never written to.
    let tr = 1, tg = 1, tb = 1;
    if (mob.hurtT > 0) { tr = 1; tg = 0.34; tb = 0.30; }
    else if (mob.burnT > 0) {
      // pulse while alight, so a burning husk reads at a distance
      const beat = 0.65 + Math.abs(Math.sin(mob.idleT * 9)) * 0.35;
      tr = 1; tg = 0.55 * beat; tb = 0.22 * beat;
    }
    if (mob.tintR !== tr || mob.tintG !== tg || mob.tintB !== tb) {
      mob.tintR = tr; mob.tintG = tg; mob.tintB = tb;
      for (const m of model.owned) if (m.color) m.color.setRGB(tr, tg, tb);
    }
  }

  // --- interaction ----------------------------------------------------------

  /** Closest mob along a ray, within maxDist. */
  raycast(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const mob of this.list) {
      // Aim at the body, sized from the measured footprint. This used to derive
      // both from `scale`, which was ~1 for every hand-built species but is now
      // a model-specific conversion factor — a husk's is not a cow's.
      const r = mob.radius + 0.20;
      _ray.copy(mob.pos).addScaledVector(mob.up, mob.spec.height * 0.5).sub(origin);
      const t = _ray.dot(dir);
      if (t < 0 || t > bestT) continue;
      const perp = _ray.addScaledVector(dir, -t).length();
      if (perp > r) continue;
      best = mob; bestT = t;
    }
    return best ? { mob: best, dist: bestT } : null;
  }

  /**
   * Offer food to an animal. A fed adult goes looking for a mate; two willing
   * animals of the same species that find each other produce a calf.
   * @returns {boolean} true if the animal accepted the food
   */
  /** Is this something an animal will eat? Used for the crosshair prompt. */
  canFeed(itemId) { return FEEDS.has(itemId); }

  feed(mob, itemId) {
    if (!mob || mob.health <= 0) return false;
    if (!FEEDS.has(itemId)) return false;
    if (mob.baby > 0) {
      // Feeding a calf just brings it up faster — it can't breed yet.
      mob.baby = Math.max(0, mob.baby - BABY_SECONDS * 0.28);
      mob.love = 0;
      if (this.onSound) this.onSound('idle', mob);
      return true;
    }
    if (mob.love > 0 || mob.breedCooldown > 0) return false;
    mob.love = LOVE_SECONDS;
    mob.state = 'idle';
    mob.stateT = 0.5;
    if (this.onSound) this.onSound('idle', mob);
    return true;
  }

  /** Willing pairs of the same species that have found each other. */
  _tickBreeding(dt) {
    const list = this.list;
    for (let a = 0; a < list.length; a++) {
      const m = list[a];
      if (m.baby > 0) {
        mobGrow(m, dt);
        continue;
      }
      if (m.breedCooldown > 0) m.breedCooldown -= dt;
      if (m.love <= 0) continue;
      m.love -= dt;
      if (m.love <= 0) continue;

      for (let b = a + 1; b < list.length; b++) {
        const o = list[b];
        if (o.type !== m.type || o.love <= 0 || o.baby > 0 || o.breedCooldown > 0) continue;
        if (m.pos.distanceToSquared(o.pos) > BREED_RANGE * BREED_RANGE) continue;
        // pair off: both spend their affection and rest before breeding again
        m.love = 0; o.love = 0;
        m.breedCooldown = BREED_COOLDOWN;
        o.breedCooldown = BREED_COOLDOWN;
        const calf = this.spawn(m.type, this._colOf(m.cell.f, m.cell.ci, m.cell.cj),
          Math.floor(m.cell.ck));
        if (calf) {
          calf.baby = BABY_SECONDS;
          calf.breedCooldown = BABY_SECONDS + BREED_COOLDOWN;
          mobGrow(calf, 0);
          if (this.onSound) this.onSound('idle', calf);
        }
        break;
      }
    }
  }

  /** @param {number} knock 0..1 — how much of the shove this blow carries. */
  hurt(mob, damage, fromPos, knock = 1) {
    if (mob.dying > 0) return false;
    mob.health -= damage;
    mob.hurtT = 0.25;
    const fr = mob.frame;
    _rel.copy(mob.pos).sub(fromPos);
    const ra = _rel.x * fr.ea[0] + _rel.y * fr.ea[1] + _rel.z * fr.ea[2];
    const rb = _rel.x * fr.eb[0] + _rel.y * fr.eb[1] + _rel.z * fr.eb[2];
    // Shove it away from whoever swung. `ra`/`rb` are already the offset in the
    // mob's own tangent frame, so normalising them gives the push direction on
    // the curved surface without any further trigonometry.
    const rl = Math.hypot(ra, rb) || 1;
    const push = (mob.spec.hostile ? KNOCK_HOSTILE
      : mob.spec.trader ? KNOCK_HOSTILE * 0.5 : KNOCK_WILDLIFE) * knock;
    if (push > 0) {
      mob.knockA = (ra / rl) * push;
      mob.knockB = (rb / rl) * push;
      mob.knockT = KNOCK_TIME;
    }

    if (mob.spec.hostile) {
      // Hitting a husk makes it angry, not skittish: it takes the knock but
      // keeps coming, and it now knows exactly where you are.
      mob.target = 'player';
      mob.vel.k = 1.4;
    } else if (mob.spec.trader) {
      // It has seen worse. Bolting would also strand its stock somewhere you
      // cannot follow, and there is only ever one.
      mob.vel.k = 1.2;
    } else {
      mob.state = 'flee';
      mob.stateT = 2.5;
      mob.want = Math.atan2(rb, ra);      // bolt away from whatever hit it
      mob.speedNow = mob.spec.speed * 1.4;
      mob.vel.k = 3.0;
    }
    // Pain and death are never rate-limited — they are always the player's
    // own doing, and there is at most one per swing.
    if (this.onSound) this.onSound(mob.health <= 0 ? 'death' : 'hurt', mob);

    if (mob.health <= 0) {
      // A calf isn't worth anything — killing one should feel like a waste,
      // not a shortcut past the grow-up timer.
      this._die(mob, mob.baby > 0 ? [] : mob.spec.drops);
      return true;
    }
    return false;
  }

  toJSON() {
    return {
      // The merchant's wait has to outlive a session, or quitting and reloading
      // is a way to skip it.
      cooldown: +this.merchantT.toFixed(1),
      mobs: this.list.map((m) => {
        const d = {
          t: m.type, c: [m.cell.f, m.cell.ci, m.cell.cj, m.cell.ck], h: m.health, s: m.seed,
          b: +m.baby.toFixed(1), l: +m.love.toFixed(1), d: +m.breedCooldown.toFixed(1),
        };
        // A trader's stock and remaining life are state, not decoration.
        // Re-rolling them on load would make quit-and-reload the cheapest way
        // to shop: reload until the wares are the ones you wanted, and buy the
        // same limited line as many times as you like.
        if (m.spec.trader) {
          d.st = m.stock.map((s) => [s.item, s.count]);
          d.lf = +m.life.toFixed(1);
          d.pu = m.purse.coins;
          // A filled request must stay filled, or reloading pays you twice.
          if (m.request) d.rq = [m.request.item, m.request.count, m.request.reward,
            m.request.done ? 1 : 0];
        }
        return d;
      }),
    };
  }

  fromJSON(data) {
    this.clear();
    // Saves written before the merchant existed are a bare array of mobs.
    const arr = Array.isArray(data) ? data : (data?.mobs || []);
    this.merchantT = Array.isArray(data)
      ? MERCHANT_FIRST
      : (data?.cooldown ?? MERCHANT_FIRST);
    for (const d of arr) {
      if (!SPECIES[d.t]) continue;
      const col = cidx(d.c[0], Math.floor(d.c[1]), Math.floor(d.c[2]));
      const mob = this.spawn(d.t, col, Math.floor(d.c[3]) - 1, d.s);
      if (mob) {
        mob.cell.ci = d.c[1]; mob.cell.cj = d.c[2]; mob.cell.ck = d.c[3];
        mob.health = d.h;
        // A calf must come back a calf, at the size it had grown to.
        mob.baby = d.b ?? 0;
        mob.love = d.l ?? 0;
        mob.breedCooldown = d.d ?? 0;
        if (mob.spec.trader) {
          if (d.st) mob.stock = d.st.map(([item, count]) => ({ item, count }));
          if (d.lf !== undefined) mob.life = d.lf;
          // A spent purse must stay spent, or reloading refills the trader and
          // the cap means nothing.
          if (d.pu !== undefined) mob.purse.coins = d.pu;
          mob.request = d.rq
            ? { item: d.rq[0], count: d.rq[1], reward: d.rq[2], done: !!d.rq[3] }
            : null;
        }
        mobGrow(mob, 0);
        this._sync(mob);
        mob.prevPos.copy(mob.pos);
      }
    }
  }
}
