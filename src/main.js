// Mojazer — a voxel tiny planet.

import * as THREE from 'three';
import { Planet } from './world/Planet.js';
import {
  Player, VIEW_FIRST, VIEW_COUNT, stepZoom, lookScaleFor,
} from './player/Player.js';
import { ViewModel, CAST_RELEASE } from './player/ViewModel.js';
import {
  PlayerCharacter, playerModelUrls, characterUrl, DEFAULT_CHARACTER,
} from './player/Character.js';
import { Input } from './player/Input.js';
import { TouchControls } from './ui/TouchControls.js';
import { Sky, MOON_FILL } from './render/Sky.js';
import { PostFX } from './render/PostFX.js';
import { Particles } from './render/Particles.js';
import { Dividers } from './render/Dividers.js';
import { BlockModels, CAP as BLOCK_MODEL_CAP } from './render/BlockModels.js';
import { SignText } from './render/SignText.js';
import {
  createVoxelMaterials, buildTileTextures, buildCrackTexture, voxelUniforms,
  occupancyTexture, occupancyData, OCC_NI, OCC_NJ, OCC_NK,
} from './render/VoxelMaterial.js';
import { loadTileAtlas } from './render/TileAtlas.js';
import { bobberGeometry } from './render/ItemModels.js';
import { Audio } from './audio/Audio.js';
// The one night curve. `Ambience` owns it because it was the first thing that
// needed to know, and a second definition here would be a second answer to
// "is it dark" that could drift from the crickets and the owls.
import { nightness } from './audio/Ambience.js';
import { UI } from './ui/UI.js';
// The loadout table, read through the namespace rather than as a named import
// on purpose: it is the UI's list and the UI is where it must stay, but a named
// import of an export that does not exist yet is a build error, and this half of
// the feature has to survive the other half not being there. Absent, the start
// kit is empty: a new world starts you with nothing in the bag.
import * as UIModule from './ui/UI.js';
import { IconFactory } from './ui/Icons.js';
import { Inventory, Slot, HOTBAR, useKind } from './game/Inventory.js';
import { Drops } from './game/Drops.js';
import { Weather } from './game/Weather.js';
import { strikeLightning } from './game/Lightning.js';
import { siteTornado } from './game/Tornado.js';
import { Seasons, snowLine } from './game/Seasons.js';
import { Mobs, MOB_MODEL_URLS } from './game/Mobs.js';
import { Endgame } from './game/Endgame.js';
import * as MobModels from './game/MobModels.js';
import { explode } from './game/Explosion.js';
import { Farming, roofsSoil, cropFirstId } from './game/Farming.js';
import { Water, BioWake, LEVEL_MAX } from './game/Water.js';
import { Whirlpools, WHIRL_R, WHIRL_CUE, K_SEA } from './game/Whirlpool.js';
import { Save } from './game/Save.js';
import {
  DEFAULT_DIFFICULTY, normalizeDifficulty, mobDamageScale, normalizeLoadout,
  DEFAULT_ON_DEATH, normalizeDeathRule, keepsOnDeath, skillDeathMode,
  huntsOnSight, endsOnDeath,
} from './game/NewGame.js';
import {
  ITEMS, computeDrops, miningTime, itemIdOf, armourPoints,
  bowShot, bowDrawStep, fishTable, fishHard,
} from './game/Items.js';
import { Arrows } from './game/Arrows.js';
import { Skills, ON_DEATH } from './game/Skills.js';
import {
  offersLeft, refusalFor, accept, newBarterState, forgetVisit,
} from './game/Barter.js';
import { traderIdOf } from './game/Folk.js';
import { Achievements } from './game/Achievements.js';
import { smeltingFor, FUEL } from './game/Recipes.js';
import {
  BLOCKS, ID, IS_SOLID, IS_OPAQUE, RENDER_TYPE, R_LIQUID, R_CROSS, IS_TORCH, DROWNS, IS_DIRECTIONAL, IS_AXIS, IS_SLAB,
  IS_STAIR, IS_LADDER, IS_DOOR, IS_GATE, IS_SIGN, SIGN_WALL, FACING_DEFAULT, NEEDS_ROOM, crowds,
  NEEDS_FLOOR, supports, growsOn, IS_SUBMERGED, IS_REPLACEABLE, HAS_GRAVITY, N_BLOCKS,
} from './world/Blocks.js';
import {
  D, COLUMNS, GRAVITY, GEN_VERSION,
  K_TERRAIN_MAX, CHUNK_LOAD_DIST, CHUNK_KEEP_DIST,
  BIOME, FACE_ROLE, FACE_RIME, FACE_PYRE, FACE_TEMPEST, FACE_VERDANT,
  FACE_PHYSICS, FACE_NAME,
} from './world/Constants.js';
import {
  W, SEA_K, colIndex, faceAt, delta,
} from './world/Grid.js';
import {
  colParts, colNeighbor, stepColumn, cellIdx, cellCorner,
  CHUNK_T, CHUNK_K, CW as CT, CK, NUM_CHUNKS, chunkIdx,
  NUM_REGIONS, REGION_COLS, REGION_VOXELS, regionColumns, regionOfCol,
} from './world/Layout.js';

const _kd = { col: 0, k: 0 };
/** Which face labels a column, 1..9. */
const faceOfCol = (col) => faceAt((col - (col % W)) / W, col % W);

/** Decode a `cellIdx` back into a column and a layer. */
const cellDecode = (idx, out = _kd) => {
  out.k = idx % D;
  out.col = (idx - out.k) / D;
  return out;
};
import { CROSS_LIGHT_ADDR_SHIFT } from './world/Mesher.js';
import { EntityLightField } from './world/EntityLight.js';
import { makeRng } from './util/Noise.js';
// Every world-space distance on this map goes through one of these: X and Z
// wrap, so `distanceTo` is a full turn out half the time.
import { wrapDist, wrapDist2 } from './game/Wrap.js';

/**
 * Shortest signed distance along a wrapped world axis.
 *
 * `Grid.delta` is the integer column version of this. Everything that measures
 * a distance across the map on X or Z has to go through one of the two, because
 * the map joins up and plain subtraction is a full turn out half the time.
 */
const WRAP_HALF = W / 2;
const wrapDelta = (d) => (d > WRAP_HALF ? d - W : d < -WRAP_HALF ? d + W : d);

/**
 * World-space centre of every chunk, built once. The streamer runs a distance
 * test against all 48 672 of them a few times a second; recomputing the centres
 * each time would cost more than the test.
 */
const CHUNK_CENTER = (() => {
  const out = new Float32Array(NUM_CHUNKS * 3);
  for (let cx = 0; cx < CT; cx++) {
    for (let cy = 0; cy < CT; cy++) {
      for (let ck = 0; ck < CK; ck++) {
        const o = chunkIdx(cx, cy, ck) * 3;
        out[o] = cx * CHUNK_T + CHUNK_T / 2;
        out[o + 1] = ck * CHUNK_K + CHUNK_K / 2;
        out[o + 2] = cy * CHUNK_T + CHUNK_T / 2;
      }
    }
  }
  return out;
})();

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
// Up, for the two burn-ember callbacks. A constant, because there is one up.
const _burnUp = new THREE.Vector3(0, 1, 0);
// The cast's own two, kept off the shared scratch above because `_castArc`
// runs a whole flight inside one call and its caller is holding `_v1`.
const _castP = new THREE.Vector3();
const _castV = new THREE.Vector3();
/** Model up for the float, which is a constant and never anything else. */
const _bobY = new THREE.Vector3(0, 1, 0);

/**
 * Is the app being drawn sideways?
 *
 * iOS Safari has no orientation-lock API, so an upright phone gets a CSS
 * rotation instead and the app's box becomes the TRANSPOSE of the window:
 * `100dvh` wide by `100dvw` tall. `renderer.setSize(w, h, false)` does not
 * touch the CSS size, so a drawing buffer taken straight off `innerWidth` is
 * portrait inside a landscape box - a stretched image and a camera aspect that
 * is the reciprocal of the right one.
 *
 * A coarse pointer is in the query on purpose: nothing about this can fire on
 * a desktop, in portrait or otherwise, so `viewSize` there is exactly the two
 * lines it replaced.
 */
const ROTATED = matchMedia('(orientation: portrait) and (pointer: coarse)');

/** The size to draw at, transposed when the app is rotated. */
const viewSize = () => (ROTATED.matches
  ? { w: window.innerHeight, h: window.innerWidth }
  : { w: window.innerWidth, h: window.innerHeight });

/**
 * The four diagonal steps, as (di, dj) pairs for `stepColumn`.
 *
 * `COL_NB` only holds the four edge neighbours, so a rule that cares about all
 * eight cells around a column has to compose two steps for the corners. Shared
 * by both halves of the NEEDS_ROOM rule — `_crowdedAt` refusing a placement and
 * `_crushCrowded` breaking what a placement walled in — so the two can never
 * come to disagree about what "beside" means.
 */
const CORNER_STEPS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * The colour a mouthful of this food sheds, as linear RGB.
 *
 * Items carry a `color` hex for the icon painter, and the crumb emitter wants
 * three floats, so this is the one place the two meet. A food with no colour of
 * its own - the modelled ones, which get their look from the mesh - falls back
 * to a dull crust brown rather than to white, because a white crumb reads as a
 * spark and the one thing these must not look like is fire.
 */
const CRUMB_FALLBACK = [0.60, 0.44, 0.28];
function foodCrumbColor(item) {
  const hex = item?.color;
  if (typeof hex !== 'string' || hex.length !== 7) return CRUMB_FALLBACK;
  const n = parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return CRUMB_FALLBACK;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Three rows of nine, so a crate is worth the eight planks it costs. */
const CRATE_SLOTS = 27;

/** Seconds for a swing to come back up to full weight. */
const ATTACK_PERIOD = 0.62;

/**
 * What a critical hit is worth. Minecraft's number, and it survives this game's
 * ladder for the reasons below.
 *
 * The swords run 4.0 wood / 5.1 stone / 6.6 iron / 8.4 astral (see SWORD_BASE
 * in Items.js), and a bow at full draw does 7.5. A crit lifts those to 6 / 7.7 /
 * 9.9 / 12.6, so an iron sword landed on the way down beats a perfect shot by a
 * third and an astral one by two thirds — which sounds like it buries the bow
 * until you count in time rather than in blows. A full-weight swing needs the
 * whole ATTACK_PERIOD back, and a crit needs it to come back *inside* the
 * falling half of a jump, which is 0.32s of a 0.65s hop at GRAVITY 26 and a
 * jump of 8.4. Perfect jump-crit rhythm is therefore about one 12.6 per 0.65s,
 * against one 8.4 per 0.62s for standing and swinging: ~19 dps against ~13.5, a
 * 40% reward for timing, at three cells of reach, inside the swing of whatever
 * you are hitting. The bow's 7.5 is bought at 1.0s of draw from anywhere on the
 * planet with nothing able to reach back — the bow was never competing on
 * damage per second and does not start now. It also keeps the two mechanics
 * from being the same mechanic: see `bowShot`, a fully drawn bow is already its
 * own crit, which is exactly why arrows do not get this on top (Minecraft makes
 * the same call, and for the same reason).
 */
const CRIT_MULT = 1.5;

/**
 * How fast you must be going down for a blow to count as falling, in layers/s.
 *
 * The same threshold `Player.update` uses to decide a fall has begun, on
 * purpose: one definition of "descending" for the mechanic that pays you and
 * the mechanic that hurts you, so a player cannot be falling far enough to take
 * damage yet not far enough to crit, or the reverse.
 */
const CRIT_FALL_SPEED = -0.2;

/**
 * How much of the swing must be back before a crit is possible.
 *
 * Not 1.0, which one slow frame can miss for reasons the player cannot see —
 * 0.9 is ~60ms of grace on a 0.62s recharge. This is a hard threshold on a
 * quantity that is otherwise a smooth ramp, which is normally the mistake the
 * knockback made (see the note in `_interact`), but the argument is different
 * here: a crit is a discrete *event* with its own burst and its own sound, not
 * a hidden coefficient. There is nothing to be confused by — either the sparks
 * fired or they did not. And without it, holding the button through a long fall
 * would crit on every one of the six swings that fall is worth, at a third of
 * weight each, turning the fanfare into strobe.
 */
const CRIT_CHARGE = 0.9;

/**
 * Does this blow crit, and by how much? Returns 1 (no change) or CRIT_MULT.
 *
 * Exported and pure so the rule can be driven from a test harness, the way
 * `bowShot` is: the interesting part of this mechanic is the state matrix, and
 * `main.js` builds a whole game the moment it is imported, so the alternative
 * is a second copy of the conditions that can drift from the one that ships.
 *
 * The condition is *falling*, not airborne. Gating on `!grounded` alone would
 * make the mechanic "hold jump": you would crit on the way up as well, at which
 * point every player simply never touches the ground and the timing this is
 * supposed to reward stops existing. At the apex of a jump `vel.y` passes
 * through zero and there is deliberately no crit — the top of a hop is not a
 * fall, and a window that opened there would be the same "hold jump" strategy
 * with one extra frame of patience.
 *
 * The exclusions:
 *   grounded   standing still is the baseline the multiplier is measured from
 *   inWater    sinking is not falling; you are also weightless, which is the
 *              whole reason `miningDrag` taxes a swing made adrift. This covers
 *              lava too — `inWater` is true in it — and burning to death while
 *              being denied a crit is the correct amount of sympathy.
 *   onLadder   climbing down is a controlled descent at a fixed 2.75 cells/s
 *              that you can hold indefinitely, which is a free permanent crit
 *              and the ladder equivalent of holding jump.
 * There is nothing to ride in this game, so there is no mount case to exclude;
 * if one ever lands it belongs in this list beside the ladder, for the same
 * reason — a descent you get to hold is not a fall you had to time.
 *
 * @param {object} p the player — reads `grounded`, `inWater`, `onLadder`, `vel.y`
 * @param {number} charge 0..1 swing weight, as `_interact` computes it
 */
export function critMultiplier(p, charge) {
  if (!p || !p.vel) return 1;
  if (p.grounded || p.inWater || p.onLadder) return 1;
  // Written as a positive test so that a NaN velocity — which no code path
  // should produce, but a physics bug might — fails closed to "no crit".
  if (!(p.vel.y <= CRIT_FALL_SPEED)) return 1;
  if (!(charge >= CRIT_CHARGE)) return 1;
  return CRIT_MULT;
}

/**
 * Bar restored per point of nourishment.
 *
 * At 0.09 anything above 11 nourishment overflowed a full bar, which quietly
 * flattened the top half of the pantry: a Hearty Stew (14) restored 126% and a
 * loaf of bread (8) restored 72%, so the entire cooking chain above bread was
 * cosmetic. At 0.06 the ladder is real end to end — berries 18%, bread 48%,
 * stew 84% — and nothing you can cook is wasted on a bar that cannot hold it.
 *
 * Set against the drain, which is 0.0022/s scaled by effort: a bar lasts about
 * 42 minutes standing still, 11 walking and 5 sprinting. One loaf is roughly
 * five minutes of hard travelling.
 */
const FOOD_TO_ENERGY = 0.06;

// Fishing. The wait is the whole point — long enough that you put the mouse
// down and look at the water, short enough that it is not a punishment.
const FISH_WAIT_MIN = 4;
const FISH_WAIT_MAX = 13;
/**
 * Walk this far *from where you cast* and the line comes in.
 *
 * It used to be measured from the player to the float, which quietly made the
 * leash a cast-length limit as well as a wandering-off limit — and one that a
 * cliff broke instantly. Stand six blocks up a headland, cast eight out, and
 * the diagonal is ten: the very first tick of `_tickFishing` cancelled the cast
 * on the frame it was made, which is the "it goes straight back to the rest
 * position" fault. Measured from the casting spot, height costs nothing and the
 * rule says what it always meant: stay near where you cast.
 */
const FISH_LEASH = 9;
/**
 * How far a cast reaches, in cells.
 *
 * This was `player.reach + 3`, and `reach` is 3, so a cast travelled six cells
 * from the eye. Six cells is a shore and nothing else: face an ocean from a
 * pier or a headland and the surface is simply further away than that, the ray
 * ends in open air, and you are told to cast at open water while looking at an
 * ocean. It is also why fishing from height was impossible — the water is down
 * as well as out, and the diagonal ran out first.
 *
 * 28 is a thrown line rather than a poke: it clears a beach shelf, reaches the
 * water from the top of a normal cliff, and is still short enough that you
 * cannot fish a lake from the far side of a valley. It is deliberately not tied
 * to `reach` — reach is how far your arm goes, and this is how far a lead
 * weight goes when you throw it.
 */
/**
 * How far the crosshair will name something, as distinct from how far you can
 * reach it. Mining stops at `player.reach`, which is 3; a label has no such
 * excuse, and stopping it at arm's length meant you could stare at a mountain
 * and be told nothing about it.
 *
 * 48 cells is a little over the 34 unit horizon at eye height and well inside
 * the 132 the tallest terrain stays visible from, so it names the hillside you
 * are looking at without reaching across a whole continent. It is only cast on
 * frames where nothing was found within reach.
 */
const LOOK_RANGE = 48;

const FISH_CAST_RANGE = 28;
/**
 * The throw itself. A cast is a lead weight leaving a rod, not a laser.
 *
 * It used to be a straight `planet.raycast` down the look direction, and the
 * owner found the whole of what is wrong with that in one sentence: you can
 * only cast at water you are literally pointing at, and looking up refuses.
 * A ray has no arc, so the sky is never over water, and the range is a *reach*
 * rather than a distance you can put something at.
 *
 * So the float is thrown. `_castArc` launches it along the look direction and
 * lets it fall, which gives the player the one control a cast has ever had:
 * elevation. Flat and it drops in front of you; up and it carries.
 *
 * The numbers, once, all in cells and seconds:
 *
 *   SPEED 17 with G 0.55 puts a 45-degree cast at v^2/(GRAVITY*G) = 20 cells
 *   and a flat one, thrown from an eye a cell and a half over the water, at
 *   about 7. That spread is the feature: the difference between "at my feet"
 *   and "out there" is where you point, and it is nearly three to one.
 *
 * Gravity is scaled by the same trick and for the same reason `Arrows.ARROW_G`
 * is halved — full 26 against a throwable speed is an arc so steep that the
 * only reachable water is directly below you.
 *
 * FISH_CAST_RANGE stays the cap, now measured straight-line from the rod tip
 * to where the float lands, so a cast aimed at the zenith comes back down
 * beside you rather than reaching the far side of the planet.
 */
const FISH_CAST_SPEED = 17;
/**
 * The wind-up: how long the button has to be held for a cast at full stretch,
 * and how short a flick of it throws.
 *
 * A cast used to leave the rod at one speed however you pressed the button, so
 * the only thing that decided where the float landed was where you were
 * looking - and over a wide lake that meant aiming at the sky to reach the
 * middle of it. Holding the throw is the control that was missing: the aim says
 * WHERE and the hold says HOW FAR.
 *
 * 0.75s to full, which is a touch shorter than the bow's draw, because a cast
 * is a thing you do fifty times an evening and a bow shot is not. The floor is
 * 0.42 rather than something near zero so the shortest throw is a short throw
 * and not a dropped one.
 *
 * Measured off an ordinary sea shore, landing distance by hold: 0.5 -> 11.5
 * cells, 0.75 -> 14.1, full -> 18.0. Below about a third the float came down on
 * the bank and the cast was refused with "Cast at open water" - which is the
 * honest answer to an under-thrown cast rather than a bug, but it does mean a
 * flick from a high or shallow bank can fall short. Range goes as the square of
 * speed, so the low end of the dial is where the distance changes fastest.
 */
const FISH_WINDUP_TIME = 0.75;
const FISH_CAST_MIN = 0.42;
const FISH_CAST_G = 0.55;
/**
 * The longest piece of the arc tested as a single point, in cells.
 *
 * Lifted straight from `Arrows.SUBSTEP` along with the lesson written beside
 * it: a fast projectile crosses several cells in one integration step, and a
 * one-cell sheet of water sitting between two of them is water the cast flies
 * through. Marching a fixed 0.3 of a cell — the step's *length*, not its
 * duration — means the probe cannot skip a block whatever the speed is doing.
 */
const FISH_CAST_STEP = 0.3;
/** How long the weight may stay in the air before the cast is simply a miss. */
const FISH_CAST_TIME = 5;
/** Height of the float above a water cell's centre — half a cell, plus a little. */
const BOBBER_FLOAT = 0.56;

// --- the fight ---------------------------------------------------------------
//
// What used to happen when a fish took the bait was that you clicked inside a
// 1.1s window, which is a reaction test you pass every time after the second
// fish. This is the balance bar instead: a shuttle you drive along a horizontal
// track by holding the button, a fish that runs up and down it, and a catch
// that fills while the two overlap and empties while they do not.
//
// Everything below is one of three levers, and nothing here invents a stat that
// the game did not already have:
//
//   THE ROD widens the shuttle and pulls harder — `tool.tier` and `tool.speed`
//   off the item, so a better rod is a bigger window and a livelier hand rather
//   than a separate difficulty number.
//   THE FISH sets `hard` (0..1), rolled off the *same* number that decides what
//   you caught. A common fish drifts; a treasure roll darts. That the rare
//   thing fights hardest is the only reason it is worth more.
//   THE PLAYER is the hold. The shuttle is under gravity and has weight, so it
//   is a balance rather than a follow: over-hold and you are at the far wall
//   with the fish behind you.
//
// RARITY IS SAID TWICE, on purpose. It used to live entirely in how the fish
// moved, which is only legible once the fight is under way; it now sets the
// width of the shuttle as well, so the first frame of the bar already tells you
// what is on the line. Fast-and-narrow against slow-and-wide is a much bigger
// spread than fast-against-slow was, and it is what pays for a common fish
// being easy without a treasure fight becoming easy with it.
//
// Numbers, once, for a tier-0 rod and a handicapped bot (see FIGHT_HALF): a
// common fish is a 35%-wide shuttle against a drift, lands every time, and is
// over in a second and a half; an odds-and-ends is 31% and also lands, in under
// two; a treasure fight is a 22% shuttle against something twice as quick and
// lands 46% of the time after five and a half seconds. The common one is a
// formality on purpose. The fun is meant to be in the rare one, and that is
// where all the difficulty now is.
/**
 * Half the shuttle's width, in track widths, before the rod and the fish have
 * had their say.
 *
 * Raised from 0.10 after the owner played it and reported a *common* fish as
 * hard, which it was: 0.10 is a shuttle a fifth of the track wide against a
 * fish that could cross the whole of it, and it was that width for every fish
 * in the game regardless of what was on the line. At 0.19 the starting shuttle
 * is 38% of the track before rarity takes its share, which is the difference
 * between a formality and a fight you can lose to a minnow.
 *
 * **The measurement that said 0.10 was fine was taken with a broken
 * instrument.** "A naive good player lands 53 of 60" came from a bot that read
 * the fish's position and answered it on the same frame — no reaction time, no
 * input lag, perfect information. That is not a player, it is an oracle, and it
 * will pass a difficulty nobody can. Re-measured with a 200ms reaction delay and
 * a 100ms decision rate, the *same* fight landed 43% of common fish and 6% of
 * treasure: the frame-perfect run had reported 97% and 24% for those two. Every
 * number in this block is now quoted against the handicapped bot, and any future
 * retune should be too.
 *
 * The width alone was never the whole of it, either — see `FIGHT_ACC`, where the
 * shuttle turned out to be unable to follow a fish leftwards at all.
 */
const FIGHT_HALF = 0.19;
const FIGHT_HALF_PER_TIER = 0.02;
/**
 * How much of the shuttle a maximally rare fish takes away, as a fraction.
 *
 * The second channel the owner asked for. Difficulty used to live entirely in
 * the fish's movement, so a rare fight and a common one were the same size of
 * window and only differed in how fast the target moved — legible in motion,
 * but not at the instant the bar appears. Rarity now narrows the shuttle as
 * well, so the *first frame* of a fight already says what you have hooked.
 *
 * 0.48 against `hard` 0..1. In track widths that is a 35% shuttle for a typical
 * common fish and a 22% one for a treasure roll — a difference you can see
 * without comparing, which is the whole point of putting rarity in this channel
 * as well as in the movement.
 */
const FIGHT_HALF_RARITY = 0.48;
/**
 * Shuttle pull while held, fall while released, and its drag. Track widths.
 *
 * **THE PULL AND THE FALL ARE THE SAME NUMBER, AND THAT IS A FAIRNESS RULE
 * RATHER THAN A TUNING CHOICE.** They were 2.2 and 1.55, which against a drag
 * of 2.7 is a shuttle that climbs at 0.815 track widths a second and sinks at
 * 0.574 — and the fish, at the old speeds, ran at up to 0.687 as a *common*
 * fish and 1.144 as a rare one. So a fish running left was simply faster than
 * the only thing that could follow it left, and no amount of reading the bar
 * could catch one. The owner reported exactly that ("letting go of rmb makes
 * the bar move slowly to the left"), and it is most of why a minnow felt hard.
 *
 * The invariant, which anything retuning these has to preserve:
 *
 *     FIGHT_ACC / FIGHT_DRAG  >=  (FISH_RUN + FISH_RUN_RARITY) / 3.4
 *
 * — the shuttle's terminal speed, in *either* direction, beats the fastest a
 * fish can ever run. At 3.4 against a drag of 2.7 that is 1.26 track widths a
 * second, against a fish maximum of 0.91: a 38% margin, which is what makes
 * "chase it" a thing the player can actually do rather than a thing they can
 * only do rightward.
 *
 * Raising both rather than lowering the pull, because the fight is still a
 * balance and not a follow: with equal forces the shuttle is a weight you are
 * holding up, over-hold and you are at the far wall, and letting go is a real
 * control instead of a slow slide.
 */
const FIGHT_ACC = 3.4;
const FIGHT_GRAV = 3.4;
const FIGHT_DRAG = 2.7;
/**
 * How hard the fish pulls towards its next destination, at `hard` 0 and at 1.
 *
 * Was `2.0 + 2.1 * hard`, which gave a common fish 2.0 — most of the speed of a
 * rare one, for none of the reward, and it is part of why a minnow was a fight.
 * 1.1 is a drift you can sit on top of; 3.1 at the top of the range is something
 * that leaves the shuttle behind if you are not already moving. Both ends are
 * bounded by the fairness rule on `FIGHT_ACC`: whatever goes here, the shuttle
 * has to be able to outrun it in both directions.
 */
const FISH_RUN = 1.1;
const FISH_RUN_RARITY = 2.0;
/**
 * How long a fish holds a destination before picking another, before the roll
 * that scatters it. A common fish commits for about a second and a half; a rare
 * one for a little over a second, which together with the speed above is what
 * reads as darting rather than as merely fast.
 */
const FISH_TURN = 1.5;
const FISH_TURN_RARITY = 0.30;
/** Progress a second, on target and off it, and where the bar starts. */
const FIGHT_GAIN = 0.42;
const FIGHT_DRAIN = 0.30;
const FIGHT_START = 0.35;

/**
 * How far the float has to go before distance starts paying, and where it stops
 * paying, in cells — and how much it is worth at the far end.
 *
 * The owner: *"rarity should also be determined by how far we casted but not
 * all the time like just because we casted near doesn't mean we can't catch
 * rare fish"*. So this is a weight on the roll and emphatically not a gate.
 * `_rollCatch` raises a uniform sample to `1 / (1 + bias)`, which pushes the
 * whole distribution up without ever removing an outcome: at a cast of six
 * cells or less the odds are exactly what they always were (7% treasure), and
 * at a full 24 they are 13.5%. Roughly double at the top of the range, and
 * never zero at the bottom. Deep water adds `FISH_DEEP_BIAS` on the same scale,
 * so the best cast in the game — a long throw into open ocean — is 16.4%.
 */
const FISH_DIST_NEAR = 6;
const FISH_DIST_FAR = 24;
const FISH_DIST_BIAS = 1.0;
/**
 * How many cells of water under the float count as deep, and what deep water is
 * worth on the same scale distance is measured on.
 *
 * `Mobs.DEEP_WATER` is 8 and is where the anglerfish, the blobfish and the
 * goblin shark are allowed to spawn; this is 5, deliberately lower, because
 * that one is about a body having room to swim and this one is about a hole
 * being more than a puddle. A pond you can wade is shallow, a lake bed you
 * cannot see is not, and the eight-cell line would have called almost every
 * inland lake shallow.
 */
const FISH_DEEP = 5;
const FISH_DEEP_BIAS = 0.5;

/**
 * What a cast can produce, and where the species comes from.
 *
 * The report: *"don't we have a bunch of fish models swimming around, why have I
 * only been getting raw fish all the time?"* Every cast used to return the one
 * `fish` item, so the fifteen bodies in the pack were scenery and the rod had
 * nothing to say about where you were standing.
 *
 * **There is no second roll.** `_rollCatch` rolls once, biases that roll on the
 * cast distance and on the depth under the float, and reads it three times: it
 * decides treasure against junk against fish, then, inside the fish band, it
 * indexes the species table for the water the float went into. Rarity, catch
 * odds, price, nourishment and fight difficulty all descend from the one
 * `rarity` number per species in `Items.js` — see the ladder written out there.
 *
 * The tables come from `fishTable(salt, deep)`, and the shape is one prize per
 * kind of water, which is what makes a rod a reason to go somewhere:
 *
 *   fresh        a pond, a lake, a river. Five species, and its rarity is the
 *                piranha.
 *   salt         the sea at any depth. Seven species, and its rarity is the
 *                moorish idol.
 *   salt + deep  eight cells of water under the float. Those seven plus the
 *                abyss three, which no other water can produce at all.
 *
 * Fresh water has no deep table. A lake five cells down is deep enough to bias
 * the *roll* — that is what `FISH_DEEP` is for, and it is a separate and lower
 * threshold from the sea's — but it is not the bottom of the ocean, so no
 * anglerfish comes out of a tarn however hard you throw.
 *
 * **Measured, over 200,000 casts per row** (short cast, no bias; a full 24-cell
 * throw pushes every one of these up the ladder):
 *
 *     fresh                salt shallow            salt deep
 *     tetra        30.5%   clownfish      23.0%    clownfish      21.4%
 *     goldfish     22.1%   yellowtang     16.2%    yellowtang     15.1%
 *     koi          12.7%   butterflyfish  13.6%    butterflyfish  12.7%
 *     betta         9.0%   bluetang        9.3%    bluetang        8.7%
 *     piranha       3.7%   royalgramma     6.6%    royalgramma     6.1%
 *                          puffer          5.5%    puffer          5.1%
 *                          moorishidol     3.9%    moorishidol     3.6%
 *                                                  anglerfish      2.3%
 *                                                  blobfish        1.8%
 *                                                  goblinshark     1.4%
 *
 * The remaining 22% of every column is junk and treasure, unchanged, and none of
 * it fights any more — see `_beginFight`.
 */


// --- winter ice -------------------------------------------------------------
// How much of the year's cold it takes before standing water skins over, and
// how little before it lets go again. The gap between the two is hysteresis: a
// single threshold would sit exactly on the boundary for a whole in-game day
// and flicker a lake between water and ice every pass.
const FREEZE_AT = 0.55;
const THAW_AT = 0.35;
/** Seconds between freeze passes, columns sampled per pass, cells changed. */
const FREEZE_PERIOD = 1.1;
const FREEZE_SCAN = 220;
const FREEZE_BATCH = 14;
/** How far from the player winter is allowed to work, in columns. */
const FREEZE_RADIUS = 24;
/**
 * How close a freezing or thawing cell has to be to be worth a sound. Five
 * metres is about "the water at your feet" and nothing else; see `_iceHeard`.
 */
const ICE_EARSHOT = 5;

// --- seasonal snow cover -----------------------------------------------------
/**
 * Seconds between passes, columns sampled per pass, and cells changed per pass.
 *
 * Sized against the ice sweep beside it rather than picked fresh, because both
 * are the same shape of work and the worker pays the same price for each cell:
 * an edit batch relights a radius of 17 around every seed and remeshes every
 * chunk that moved. Ice does 14 cells per 1.1s; this does 12 per 0.6s, so the
 * two together stay in the bracket one of them used to occupy alone. That is
 * 20 cells a second at the very most, and only while there is anything left to
 * change: once the ground around you agrees with the season, every pass is a
 * scan that finds nothing and emits no batch at all, which is the state it
 * spends most of the year in.
 *
 * A 24-column radius is 2 400 columns, so a full change of state over the whole
 * neighbourhood takes about two minutes of play. That is the feature and not a
 * budget compromise: snow that appeared everywhere at once on the stroke of
 * winter would read as a graphics setting being toggled. It creeps out from
 * wherever you are standing, exactly as the lake ice does.
 */
const SNOW_PERIOD = 0.6;
const SNOW_SCAN = 200;
const SNOW_BATCH = 12;
/** How far from the player the season is allowed to work, in columns. */
const SNOW_RADIUS = 24;
/**
 * Hysteresis, in blocks of altitude, between the freezing line and the thawing
 * one.
 *
 * The same argument as FREEZE_AT/THAW_AT: the line sweeps 9 blocks over a third
 * of a season, so without a dead band the columns sitting exactly on it would
 * be melted by one pass and re-frozen by the next for as long as it took the
 * line to walk past them. A block and a half of band costs a little sharpness
 * at the edge of the snowfield and buys a boundary that only ever moves one way.
 *
 * Applied on the *thaw* side only, and `_tickSeasonSnow` says why at length:
 * centred on the line, it also meant that the coldest day of the year could not
 * reach ground below altitude 1.5, and a shoreline stayed brown all winter.
 */
const SNOW_BAND = 1.5;
/**
 * How many cells the season may be holding an undo for at once.
 *
 * Every seasonal change records what it replaced, and that record is the only
 * thing that makes the effect reversible rather than erosive: without it, grass
 * that freezes over comes back as the dirt underneath and a planet loses its
 * topsoil one year at a time. So the rule is that the season never changes a
 * block it cannot undo, and when this table is full it simply stops changing
 * blocks until a thaw or a freeze hands entries back.
 *
 * 4 000 is a little over one neighbourhood's worth of ground (a 24-column
 * radius holds 2 400 columns, and only the ones that actually cross the line
 * are recorded), and it is 32 KB in the save as a flat pair array. Note that
 * burying plants rather than refusing them - see `buries` - roughly doubled how
 * densely a neighbourhood fills this: on the plains test site the columns that
 * hold a tuft or a flower are about half of them. One neighbourhood still fits
 * inside the cap with room to spare, but a player who winters across several
 * will now reach it sooner, and reaching it means the season simply stops
 * spreading rather than misbehaving. Measure before raising it.
 *
 * The cap is doing two jobs at once and that is on purpose: it bounds the memory, and it
 * bounds the part of the save this feature can grow.
 */
const SNOW_MEMORY = 4000;
/**
 * Ground the season is allowed to bury and to uncover.
 *
 * A whitelist rather than "anything solid", because this pass runs unattended
 * over ground a player may have built on. Planks, brick, farmland and ore are
 * all absent, so a stone path stays a stone path and a field is never quietly
 * turned to snow and back to plain dirt. Ice of every kind is absent too: ice
 * is water's business and `_tickFreeze` already owns it, and snow lying on a
 * glacier has nothing underneath it that a thaw could honestly hand back.
 *
 * `snow_brick` is not here either, and that is the same rule the ice thaw
 * states for itself: what the season put down is the season's to take away. A
 * built wall of snow bricks is not weather.
 */
const IS_SEASON_GROUND = new Uint8Array(N_BLOCKS);
for (const n of ['grass', 'dirt', 'coarse_dirt', 'podzol', 'peat', 'stone',
  'gravel', 'clay', 'mud', 'sand', 'red_sand', 'moss_block']) {
  IS_SEASON_GROUND[ID[n]] = 1;
}
/**
 * Falling sand: seconds between passes, and columns settled per pass.
 *
 * 0.1s is fast enough that a grain mined out from under a dune is gone before
 * you have finished the swing, and slow enough that a big collapse is a visible
 * event rather than a single frame's worth of geometry churn. 256 columns is the
 * ceiling that keeps one pass in the same cost bracket as a water tick — see
 * `_settleGravity`, which explains both numbers at length.
 */
const GRAVITY_TICK = 0.1;
const GRAVITY_PER_TICK = 256;
/**
 * The one basis, and it never turns.
 *
 * Facing 0..3 is +x, -x, +y, -y on the map, so `ea` is world X and `eb` is
 * world Z. There used to be a per-cell `tangentFrame` behind this because
 * gravity turned; it does not any more.
 */
const FLAT_EA = [1, 0, 0];
const FLAT_EB = [0, 0, 1];
const FLAT_UP = [0, 1, 0];
/** Scratch for the steam emitter, which asks for a cell centre twice a tick. */
/** Scratch for `_crossLightAt`, which runs once per modelled instance per frame. */
const _clParts = { x: 0, y: 0 };
/** Scratch for the player body's own block-light probe. */
const _entityL = { r: 0, g: 0, b: 0 };
const WHITE = new THREE.Color(1, 1, 1);
const WHITE_L = [1, 1, 1];

/**
 * What the sky fills the world with once the sun is gone, and what the water
 * reflects while it does.
 *
 * Both are in the working (linear) colour space, so they are written as floats
 * rather than as hex — `new THREE.Color(0x...)` would be decoded from sRGB and
 * these are not sRGB values, they are radiances.
 *
 * `MOON_FILL` is the fix for "the leaves look like it is morning". The palette's
 * own night sky is very nearly black, so the ambient that actually lights the
 * ground after dark was coming almost entirely from the `lerp(WHITE, 0.34)` that
 * follows it — i.e. the night fill was *neutral*, and a neutral fill leaves a
 * green leaf exactly as green as it is at noon, only dimmer. Measured on the
 * shipped grade: a midnight leaf came out (0, 7, 0) on screen, pure daylight
 * hue with no blue in it at all, which is precisely the "morning" read. This
 * replaces that white with a moon blue of nearly the same luminance, so the
 * change is a hue rotation rather than a dimming — the dimming lives in
 * `SKY_NIGHT_DROP`, where it can be tuned separately.
 *
 * MOON_FILL itself lives in Sky.js, because the entity fill has to use the same
 * value — see the note there.
 *
 * `MOON_REFLECT` is the floor under the sky a lake reflects. uSkyReflect keeps
 * the palette's real hue (deliberately — see the uniform's own comment) and the
 * palette's real hue at midnight is 0x03050f, so the fresnel term that makes
 * water read as water was mixing in something indistinguishable from black:
 * across its length a lake stopped being a surface and became a hole in the
 * terrain. A real water surface at night still carries the sky glow, the stars
 * and the moon, none of which the zenith colour accounts for.
 */
//
// Tripled after measuring a real lake rather than modelling one. A dug lake
// seen across its length at midnight came out at (1, 5, 15) against (24, 62,
// 101) for the same water at noon: no longer the hole the report described —
// 83% of the surface carries visible blue — but dark. At 3x it measures
// (4, 8, 18), which is a 58% lift on the surface and still an order of
// magnitude under noon.
//
// Worth writing down for whoever tunes this next: **this is not the lever it
// looks like.** Tripling it moved the surface by 2.8 luminance and did not
// change the fraction of it that reads as pure black at all, because the
// fresnel term only hands the reflection most of the fragment at a grazing
// angle. Anything much brighter has to come from the water body itself, and
// that is the change that risks a lake glowing in a cave.
const MOON_REFLECT = new THREE.Color(0.030, 0.052, 0.100);
/**
 * How much of the sky ambient's night floor to take away, at full night.
 *
 * The floor is 0.34 and this brings it to 0.29 — a sixth.
 *
 * **This is not what makes a night canopy too bright, and neither is the moon.**
 * Measured on rendered frames rather than modelled: a midnight leaf sits around
 * (48, 91, 41) against forest floor at (2, 8, 1). Taking a further 34% off this
 * ambient moved the foliage median by 9%, and setting `moonLight.intensity` to
 * zero outright moved it by nothing at all. Whatever dominates a lit leaf after
 * dark is a third thing, still unidentified — do not spend another pass on
 * these two knobs without first finding it.
 */
const SKY_NIGHT_DROP = 0.05;

/** Cells the hand-light scan reaches; must cover the brightest block light. */
const HAND_LIGHT_RADIUS = 8;
/**
 * How far a carried flame throws, in cells, and how hard.
 *
 * These now match a *placed* torch rather than undercutting it. They were 9.5
 * and 2.1, deliberately dimmer, on the theory that a carried torch as bright as
 * a planted one makes planting pointless and takes the shape out of mining —
 * light the shaft behind you or lose it. That reasoning is sound and it is
 * overruled, because the same flame visibly changing brightness depending on
 * whether it is in your fist or in the wall reads as a bug long before it reads
 * as a rule.
 *
 * Both numbers are derived rather than picked, so they cannot drift: the reach
 * is a torch's own light level (13), which is exactly how many cells its light
 * carries through the grid, and the gain is `uBlockIntensity`, which is the
 * multiplier the terrain applies to that same baked light. Anything that
 * retunes one now retunes the other.
 *
 * What still separates carrying from placing: this is one light and it follows
 * you, so a lit shaft stays lit behind you and a carried one does not. That was
 * always the real difference.
 */
const HAND_LIGHT_REACH = 13.0;
/**
 * How far from the player a dropped flame is looked for, in world units.
 *
 * A little past the reach of the light itself, so one walks into view already
 * lit rather than igniting as you cross a line.
 */
const DROP_LIGHT_RANGE = 18;
const HAND_LIGHT_GAIN = 5.0;
/**
 * How far the player may walk out of the middle of the moving lights' shadow
 * volume before it is rebuilt, in cells. See _updateLightOcclusion.
 */
const OCC_HYST = 3;
/**
 * The occupancy march's step, near-field stop and step cap, in cells.
 *
 * These are the shader's numbers — see OCC_STEP / OCC_NEAR / OCC_MAX_STEPS in
 * VoxelMaterial.js for why each is what it is — and `_occMarch` below is the
 * same algorithm, corner guard and all, so that an animal and the ground it
 * stands on cannot disagree about what a wall is.
 *
 * Copied rather than imported because over there they are lines of GLSL inside
 * a template literal, not exported bindings; exporting them would mean editing
 * the file that owns the terrain half of this feature. If the shader's values
 * ever move, move these with them.
 */
const OCC_STEP = 0.9;
const OCC_MAX_STEPS = 14;
/**
 * How close to the emitter an *entity's* march stops, in cells. The shader's
 * equivalent is OCC_NEAR = 1.5 and this is deliberately not that number.
 *
 * Shipping 1.5 here made the whole feature invisible at exactly the range it
 * was written for, and the arithmetic is worth spelling out because it is not
 * obvious from either end. The marched span is dist - near, sampled at the
 * midpoints of equal steps, so the far end of a ray is examined only out to
 * dist - near - ds/2. For a torch two and a half cells from an animal that is
 * 2.5 - 1.5 - 0.4 = 0.6 cells: the march never leaves the animal's own cell,
 * and a wall at the midpoint is not merely missed, it is unreachable. Measured
 * against a hand-built world, nothing under about three and a half cells could
 * be shadowed at all — and a torch on the other side of a wall from a cow is
 * usually two or three cells away, because that is what a wall is.
 *
 * 1.5 is right for the shader and wrong here for a reason, not by accident.
 * There the light is a *moving flame* — a torch in your fist or one lying on
 * the ground — which sits against whatever surface it rests on, so the last cell
 * and a half of the ray is the floor it is lying on and marching it would put
 * out the ground under the torch. Here the emitter is a block *in the grid*,
 * whose own cell cannot be opaque (a torch is not a wall) and whose support is
 * exactly one cell away. So one cell is not a fudged-down 1.5, it is the
 * precise statement of the same rule: do not let the block a torch is mounted
 * on shadow what the torch lights.
 */
const OCC_ENTITY_NEAR = 1.0;
/**
 * Slots in the entity shadow cache, and it must be a power of two.
 *
 * Direct-mapped on the occupancy cell an entity stands in, so a herd packed
 * into one barn shares one answer and a mob that has not moved recomputes
 * nothing. A collision costs a remarch rather than a wrong answer — the cell
 * index is stored and compared — but they are worth avoiding: at 256 slots a
 * 130-strong herd standing still still remarched ten rays a frame, because the
 * cells a herd occupies are anything but evenly spread once the index is folded
 * to a byte. 1024 measured at zero. It is 12 kB and it must stay a power of two
 * for the mask.
 */
const OCC_VIS_SLOTS = 1024;
/** Scratch for the volume's recentring test; not shared, it is read every frame. */
const _occCell = { cx: 0, cy: 0, ck: 0 };
const _occLocal = new THREE.Vector3();
/**
 * A second one, for the moving flames' own cell coordinates.
 *
 * It cannot share `_occLocal`: `_movingLight` is holding the *entity's* cell
 * coordinates in that one while it converts the flame's, and reusing it put the
 * ray's two ends at the same point, which reports every flame as unoccluded.
 */
const _occFlame = new THREE.Vector3();

/**
 * How long a new planet keeps the husks off, in seconds.
 *
 * Long enough to cut some wood, find your feet and light a spot; short enough
 * that the first night is still a night. Only new worlds get it — see
 * _beginGrace.
 */
const NEW_WORLD_GRACE = 180;

/**
 * The longest a falling block may spend in the air.
 *
 * A grain over a mineshaft can have forty layers of nothing under it, and
 * sqrt(2h/g) on that is over a second and a half of a hole nobody can walk
 * across. Capped, so a long drop lands early rather than leaving the shaft open.
 */
const FALL_MAX_SECONDS = 0.55;
const _fallPos = new THREE.Vector3();

/**
 * The hour the cinderlands are permanently held at.
 *
 * 0.02 rather than 0, so the sky keeps the deep blue a real night has instead
 * of going flat black - the lava is the light source down there and it wants
 * something to read against.
 */
const CINDER_HOUR = 0.02;
/**
 * Torches handed to a player whose brand new planet opens in the dark.
 *
 * Five is enough to light a hole to sit out the first night in and is not
 * enough to light a camp, which is the line the grace timer draws too: the
 * night is survivable, not skipped. See `_beginGrace`.
 */
const NIGHT_START_TORCHES = 5;

/**
 * How deep counts as having reached the core, and how far a placed hearth
 * keeps the dark away.
 *
 * The ward is generous on purpose: it is the reward for the longest journey in
 * the game, and a base that is *actually* safe is worth more than one that is
 * mostly safe. It only holds off spawning — anything already hunting you will
 * still follow you home.
 */
const CORE_REACH_K = 5;
const HEARTH_WARD = 46;

/** (di, dj) toward the wall a torch of each facing is bracketed to. */
const TORCH_WALL_STEP = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Blocks with an actual fire in them, as opposed to blocks that merely glow.
 * Filled after the block table is imported, below.
 */
const FLAME_BLOCKS = new Set();
/** How many flames are animated at once, and how often one throws an ember. */
const MAX_FLAMES = 14;
/**
 * How many nearby emitters the entity light probe keeps.
 *
 * The probe is a linear walk of this list per entity per frame, so it is a
 * direct multiplier on the only per-frame cost this feature has. Twenty-four is
 * far more than a lit room ever holds (a torch every four blocks over a 17x17
 * footprint is nine) and is only ever reached by lava, which comes in sheets —
 * and a sheet of lava is well approximated by the two dozen cells of it nearest
 * to you, which is what the eviction below keeps.
 */
const MAX_ENTITY_EMITTERS = 24;
const FLAME_PERIOD = 0.14;
/**
 * Steam off a hot spring, and spray off a waterfall.
 *
 * Faster than the flames because a plume has to be continuous to read as one:
 * at a flame's seventh of a second the puffs come out as a dotted line. Twelve
 * a second against a two-to-five-second life is about forty in the air at once,
 * comfortably inside Particles' MAX_STEAM.
 */
const STEAM_PERIOD = 0.085;
/** How far the pool scan reaches, in columns, and how many pools it will hold. */
const STEAM_RADIUS = 16;
const MAX_STEAM_CELLS = 28;
/** Seconds of immunity after a guarded hit, so a crowd cannot burst you down. */
const HURT_IMMUNITY = 0.5;

/**
 * Soaking in a hot spring.
 *
 * The pools generate 93-134 to a planet across Mountain, Snow and Tundra and
 * until now they were scenery: a hole with milky water in it. What a spring is
 * *for* has to be something you can feel without being told, because nothing
 * here is allowed to explain itself in the UI — so it is the nourishment bar,
 * which already reveals itself the moment it drops below full and already
 * counts up in percent. You sit in the water, the bar you can see climbs, and
 * then the water turns on you. Nobody has to write "you feel warm".
 *
 * Stamina was the other candidate and it is the wrong meter: it refills on its
 * own in 8.3 seconds standing still (Player.update, +0.12/s), so a spring that
 * restored it faster would be a buff the player cannot perceive, and you cannot
 * sprint while sitting in a pool anyway.
 *
 * Priced against the pantry rather than guessed. A full soak is worth exactly
 * one loaf of bread — 8 nourishment, the same as Grilled Fish or Cooked Meat,
 * the middle rung of the cooking ladder and, per FOOD_TO_ENERGY's own note,
 * "roughly five minutes of hard travelling". That is worth the climb and it is
 * nowhere near the meals above it, so the whole top of the cooking chain keeps
 * its reason to exist. Deriving the rate from the food table instead of typing
 * a number keeps the two in step if FOOD_TO_ENERGY is ever retuned.
 *
 * The bar is what actually caps this, and it caps it hard: nourishment tops out
 * at 1, so a soak is worth 8 only if you arrive at least 48% empty and worth
 * nothing at all if you arrive full. There is no stockpiling a pool the way you
 * stockpile a pantry — it tops you up before you set off and that is its whole
 * yield. Camping one cannot beat eating, because eating is what you do with the
 * bar you already filled.
 *
 * The clock bleeds off at a third speed rather than resetting, the way
 * `burning` lingers: without it you would hop out and straight back in to clear
 * the timer and farm the warmth. At 1/3 a full 28-second soak owes 84 seconds
 * on the bank, capping a camper at 8 nourishment per 112s against a walking
 * drain of 1.5 per minute. Generous, bounded, and it costs you the daylight.
 */
const SOAK_WARM = 28;
const SOAK_ENERGY = (8 * FOOD_TO_ENERGY) / SOAK_WARM;
const SOAK_COOL = 1 / 3;
/** Seconds between the warmth ending and the first sting, and between stings. */
const SOAK_STING = 3;
const SCALD_PERIOD = 3.5;
/** Above this you are wading through, not soaking. `_tickVitals` uses the same
 *  number for "moving", so the game has one definition of it. */
const SOAK_STILL = 0.6;
/**
 * ...and what a spring is on the cinderlands, which is a different thing.
 *
 * Springs generate in two places (SPRING_BIOMES): alpine ones on the ordinary
 * faces, and these. The alpine pool is the arc above - warmth, then steam, then
 * a sting - and it stays exactly that. This one never turns. It restores all
 * three bars and cannot scald.
 *
 * The asymmetry is the point. The cinderlands cost you: stamina burns half
 * again as fast (FACE_PHYSICS), the face is permanently dark, everything on it
 * is made of fire, and now eight of the sixteen bosses stand there. A pool that
 * also punished you for resting would be a fourth tax on the one face that
 * already has three, so this is the face's single piece of mercy and it is not
 * hedged. Reaching one is the price, not sitting in it.
 *
 * Stamina is included here although the note above rules it out for the alpine
 * pool, and that is not a contradiction: there it was imperceptible because
 * stamina refills on its own in 8.3 seconds. Here it drains 1.5x faster and you
 * are usually running from something, so arriving at a pool empty is normal and
 * the refill is felt.
 *
 * Both rates are one bar over SOAK_WARM, derived rather than typed, so a full
 * heal costs the same 28 seconds the alpine pool takes to turn on you.
 */
const BALM_HEAL_SECS = SOAK_WARM;
const BALM_STAMINA = 1 / SOAK_WARM;
/**
 * How fast a spectator drifts, in cells per second, and how fast with Shift.
 *
 * Faster than walking and slower than the chunk streamer, which is the only
 * real constraint on it: `_streamChunks` runs four times a second over a load
 * radius of 150 units, so anything up to about forty cells a second arrives
 * over terrain that exists. Twelve is a comfortable look-around, thirty is
 * crossing the planet to see what is on the other side of it, and neither can
 * outrun the ground.
 */
const SPECTATE_SPEED = 12;
const SPECTATE_FAST = 30;
/** How often a body pressed against a hurting block is charged. See _tickContact. */
const CONTACT_PERIOD = 0.5;

/**
 * The cold, in a drift of powder snow. See `_tickChill`.
 *
 * The fourth clock of this shape and deliberately the same shape as the other
 * three — `burning` counts down, `soakT`/`_scaldT` count up to a threshold and
 * then a period, `_starve` counts up to a period. This is the scald's shape
 * exactly: a clock that accumulates while you are in it, bleeds off while you
 * are not, and charges a point on a fixed cadence past a threshold. Nothing new
 * was invented for it, which is the whole reason it can be described in a line
 * and cleared in `respawn` beside the others.
 *
 * **The numbers are set against the escape, which was measured first.** Getting
 * out of a three-deep drift with nothing in hand is a wade to the side of the
 * hole and a climb up it, measured at 1.3 to 2.6 seconds of burial from the
 * drift floor. CHILL_BITE at 8 means a player who responds at all takes no
 * damage, and it is the ceiling on dithering rather than a toll on the escape.
 * (It was six seconds when the drift floated a still body back to the surface,
 * and most of that six was the float. Snow stopped being buoyant; see
 * SINK_BUOYANT. The clock did not need retuning, because the escape got
 * shorter and this number is a ceiling.)
 *
 * CHILL_SHIVER puts the first visible sign at 4.4 seconds — after the escape
 * would have finished, so a player who acts never sees it, and the player who
 * does see it still has 3.6 seconds of warning before the first point.
 *
 * **It can kill, and the hot spring cannot.** That difference is the argument
 * for both. `_tickSoak` floors health at 1 because a pool looks like a rest
 * spot and a player will genuinely walk away from the keyboard in one. Nobody
 * idles in a drift: you cannot stand still in one without sinking, the block is
 * actively holding you, and the exit is available on every frame. From full
 * health the run is 8 + 19 * 1.2 = 30.8 seconds of unbroken burial, with a
 * white screen, a shiver and a hurt sound for the last twenty-three of them.
 * Nobody reaches the end of that by accident.
 */
const CHILL_BITE = 8;
const CHILL_PERIOD = 1.2;
/** Seconds of accumulated cold shed per second out of the snow. */
const CHILL_THAW = 2.0;
/** Fraction of CHILL_BITE at which the shivering starts. */
const CHILL_SHIVER = 0.55;

/**
 * The poison. See `_tickPoison`, and see `CHILL_BITE` above for the family this
 * belongs to.
 *
 * **The sixth clock of this shape, and it is two halves of shapes that already
 * exist rather than a sixth idea.** `sporeT` is `chillT` exactly — up while you
 * are in the mushroom, down while you are not, a warning band, then it fires.
 * `poisonT` is `burning` exactly — a dose set once, counting down, charging a
 * point on a fixed cadence until it runs out. Nothing was invented for either,
 * which is why the whole thing is cleared in `respawn` on three lines beside the
 * other five.
 *
 * **The pricing, and it is set against the two things a player can already do.**
 *
 * Four points. POISON_DOSE 12 over POISON_PERIOD 3 charges at 3, 6, 9 and 12
 * seconds, so a full dose is 4 of 20 from full health — under the tornado's 6
 * and well under the Cinderling's 9, and that ordering is deliberate: those two
 * are things that come to find you, and this is a thing you either walked into
 * or put in your mouth.
 *
 * A second dose **refreshes and never stacks**. `poisonT` is assigned rather
 * than added and the cadence is not restarted, so eating four pufferfish in
 * eight seconds costs the same four points as eating one. There is no route to
 * a large number here at all, which is the answer to "it must not be able to
 * kill from full health".
 *
 * **And it cannot take the last point.** The same floor `_tickSoak` has, for a
 * stronger reason than the hot spring's: a scald is happening to you now and you
 * can see the pool you are sitting in, but poison is a bill for something you
 * did twelve seconds ago. A player killed by it would be killed by an action
 * they have already stopped taking and very possibly forgotten, with no move
 * available that saves them - which is exactly the "no counterplay" death the
 * brief forbids. So it takes you down to 1 and leaves you there. What it costs
 * is real anyway: four points is a husk and a half, and it is four points you
 * cannot eat back while it is running, because eating during it is what a
 * player reaches for and the bar is still draining underneath.
 *
 * **The cure is time and there is deliberately no cure item.** Milk exists in
 * Minecraft because Minecraft's poison can kill you and its wither will; ours
 * cannot do either. A curative would be an inventory slot carried permanently
 * against a four-point ceiling, a recipe, a shop line and a price - a whole
 * economy of counterplay for a hazard whose real counterplay is one second at a
 * kiln and reading the word "Poisonous" on a tooltip. Twelve seconds is the
 * number instead, and twelve is chosen so that it is *survivable while it is
 * happening*: it is shorter than a husk fight and longer than a sprint out of a
 * patch, so it is an inconvenience you fight through rather than a state you
 * wait out.
 *
 * SPORE_BITE 2.5 is the escape, measured the way CHILL_BITE was. Walking
 * straight through a deathcap at ordinary speed puts a body in contact for
 * about 0.4 seconds and sprinting for half that, so **brushing past one is
 * always free** and there is no route to being poisoned by a mushroom you never
 * stopped at. The puff at 55% of it - 1.4 seconds - is a full second before the
 * dose and is a green cloud coming off the cap at your own feet, so the warning
 * arrives while the only thing needed to act on it is one step.
 */
const POISON_DOSE = 12;
const POISON_PERIOD = 3;
const SPORE_BITE = 2.5;
/** Seconds of accumulated spore shed per second out of the mushroom. */
const SPORE_CLEAR = 2.0;
/** Fraction of SPORE_BITE at which the cap starts smoking. */
const SPORE_PUFF = 0.55;
/**
 * The colour of everything poison, as linear RGB, and it is one colour on
 * purpose: the puff off a deathcap and the puff off a poisoned player are the
 * same green, so a player who has met the mushroom recognises what a bad fish
 * has done to them without being told twice.
 *
 * It is a *pale* yellow-green and not the cap's olive, which was the first try
 * and was measured invisible: the deathcap grows in a forest, the ground under
 * it is dark green grass, and a mid-olive particle over it is the same value
 * and the same hue as the thing it is meant to warn you about. Spores in life
 * are a pale dust and the pale reads, which is the same argument the model's
 * bone-white stalk makes one paragraph away.
 */
const SPORE_COLOR = [0.90, 0.95, 0.44];

for (const n of ['torch', 'lantern', 'kiln_lit']) if (ID[n]) FLAME_BLOCKS.add(ID[n]);

/**
 * The flowers, and how tall each one stands in a cell.
 *
 * A dense array indexed by block id, so the scan below asks `FLOWER_KIND[id]`
 * once per cell instead of consulting a Set — this runs over tens of thousands
 * of cells and every one of them is not a flower.
 *
 * 0.62 of a cell: the models are a clump on a stalk and the block they replace
 * is a full-cell billboard, so anything near 1.0 is waist-high and looks like a
 * shrub. Ankle height on a 1.8-cell player is what the tile always drew.
 *
 * The glowcap joins them: it was excluded when this list was about flowers, and
 * "glowcap is still 2d" is a fair complaint about a mushroom that lights the
 * cave around it and then turns edge-on to you. Its model carries its own glow
 * on the gills — see `glowMatch` in ItemModels.
 *
 * `tall_grass` is a cross block too and stays out deliberately. Grass is a
 * texture more than an object — it is the thing that carpets every meadow, so
 * it is by far the worst candidate for a model, and it is the one whose loss of
 * the wind sway would actually be felt.
 *
 * The reef joins the same table, and it is why the height is now per kind
 * rather than one constant. `BlockModels` scales a model so its **bounding box
 * height** matches this number, and the reef models are not all uprights: a
 * brain coral is authored 1.8x wider than it is tall and a sea grass tuft
 * wider still, so giving either of them the flowers' 0.62 would deliver a
 * boulder a full cell across, growing through its neighbours. Each number below
 * is chosen against that model's own aspect (asserted in its `.wam` checks), so
 * the two files have to move together — widen a model and its height here comes
 * down.
 *
 * Kelp is the exception at 1.0: it is the one block authored as a *tile* rather
 * than as an organism, a single segment of a stalk that stacks, so it has to
 * fill its cell exactly or a run of them is a dashed line. See
 * `art/wam/items/kelp.wam`.
 */
const MODELLED_PLANTS = {
  flower_red: 0.62, flower_blue: 0.62, flower_gold: 0.62, mushroom: 0.62,
  // A seedling stands above the flowers and under the firebloom. Paired with
  // the `sapling` entry in MODELLED_CROSS: neither works without the other.
  sapling: 0.70,
  // Uprights: a little under a cell, so a reef has air above it and does not
  // read as a hedge.
  coral_branch: 0.82, coral_dead: 0.78, coral_fan: 0.86, sea_sponge: 0.80,
  // Squat. These measure wide, so they are given less height to be scaled by.
  coral_brain: 0.52, sea_shell: 0.42, sea_grass: 0.46,
  // The larder and the lamp. Sea lettuce shares the ground layer with sea grass
  // and is given the same low scale so a bed of the two reads as one carpet
  // with two leaf shapes in it; the grapes stand up into the coral band because
  // that is where they grow. The anemone is squat and wide by construction —
  // its crown measures 1.46 times its height — so it gets the least of all
  // three, or it would arrive most of a cell across on the deep floor.
  sea_lettuce: 0.48, sea_grape: 0.72, abyss_anemone: 0.44,
  // The stacking tile. Exactly one cell — see above.
  kelp: 1.0,
  // The land flora, and the same rule applies to all of it: the number is a
  // *bounding box height*, so a model authored wider than it is tall gets a
  // small one. Every `.wam` source here asserts its own aspect and these were
  // set from the aspects the compiler reported, not by eye.
  //
  // Three bands, and they are what makes a biome read as layered rather than as
  // one carpet:
  //
  //   under 0.35   mats you look down at   clover, alpine_aster, driftwood
  //   0.40 - 0.60  ankle-height cover      the rest of the tufts and fungi
  //   0.70 - 0.90  things that break the horizon
  //
  // `firebloom` is the tallest land plant on the planet at 0.90, which is the
  // whole point of it: a badlands has nothing else standing up in it, so the
  // spike has to clear a player's knee from a long way off or the biome has no
  // landmark at all.
  //
  // Three of these were re-set once the models existed and their aspects were
  // measured rather than guessed, which is the check worth repeating for any
  // new one: multiply the number below by the model's own width/height and the
  // answer is how many cells across the plant arrives. The snowbell (1.24 tall
  // for 1.0 wide) came out a third of a cell across and read as a speck, and
  // the lingonberry (1.9 wide for 1.0 tall) came out 0.84 deep and grew through
  // its neighbours. Nothing here should land past about 0.8 of a cell wide.
  thornbrush: 0.54, aloe: 0.44, golden_grass: 0.74, firebloom: 0.90,
  cotton_grass: 0.60, snowbell: 0.50, alpine_aster: 0.30, marram: 0.80,
  lavender: 0.74, clover: 0.32, fern: 0.58, lingonberry: 0.38,
  // Underground. Kept a touch lower than their surface cousins: a cave is a
  // confined space and anything at knee height in a crawlway reads as an
  // obstruction rather than as scenery.
  cave_mushroom: 0.42, shelf_fungus: 0.44, crystal_cluster: 0.50,
  driftwood: 0.34,
  // The wild harvest, in the same three bands as the flora above. The two that
  // break the horizon are the ones meant to be spotted from off: a prickly pear
  // is the desert's landmark at knee height, and a reed bed marks water. The
  // mat-formers stay under 0.35 so a bog or a scree still reads as ground with
  // something growing on it rather than as undergrowth.
  cactusfruit: 0.82, agave: 0.66, swampreed: 0.86, lotus: 0.30,
  stonecrop: 0.34, icecapmoss: 0.26, mireroot: 0.52, truffle: 0.22,
  // The deathcap, and the number is doing a job the rest of this table is not:
  // it has to stand *above* the fern (0.58) it grows in, or the thing a player
  // is meant to see before they walk into it is hidden by the carpet it hides
  // in. 0.72 is the tallest fungus on the planet and still under the firebloom.
  deathcap: 0.72,
  // The farm, and the only entries here where the number carries information
  // rather than just scale: a crop's four stages are four models and the
  // heights are what makes the field *read* as growing. A row that arrives at
  // full size on the first tick has no story, and the player has no way to see
  // from a distance which beds are worth walking to.
  //
  // The four rungs climb from a seedling you have to look down at to a plant at
  // about two thirds of a cell, which is where the wheat billboard already
  // sits, so a mixed field stays one field. The two climbers get their own
  // taller ladder: hops and grapes are vines, and the whole point of a vine is
  // that it stands up past everything around it.
  strawberry_0: 0.22, strawberry_1: 0.38, strawberry_2: 0.52, strawberry_3: 0.62,
  squash_0: 0.22, squash_1: 0.38, squash_2: 0.52, squash_3: 0.62,
  greenbean_0: 0.22, greenbean_1: 0.38, greenbean_2: 0.52, greenbean_3: 0.62,
  snowpea_0: 0.22, snowpea_1: 0.38, snowpea_2: 0.52, snowpea_3: 0.62,
  hops_0: 0.26, hops_1: 0.46, hops_2: 0.68, hops_3: 0.90,
  grape_0: 0.26, grape_1: 0.46, grape_2: 0.66, grape_3: 0.86,
  // The melon gets the mound crops' ladder and not the climbers'. It sprawls:
  // its source asserts `width / height` between 2 and 3.4, so this number is a
  // *bounding box height* being spent on something two and a half times as wide
  // as it is tall, and the climbers' 0.90 would have put a melon most of two
  // cells across the bed. The last rung is 0.66 rather than the mound crops'
  // 0.62 because the ripe model is the only one carrying a fruit and the fruit
  // is the thing worth seeing from the path.
  watermelon_0: 0.22, watermelon_1: 0.38, watermelon_2: 0.52, watermelon_3: 0.66,
};
/**
 * Blocks that keep their cube and get a model standing ON TOP of it.
 *
 * The two lists above are for blocks that ARE a model — a name in
 * `MODELLED_CROSS` stops the mesher emitting anything, and the model is the
 * whole picture. A cooker is not that. It is an ordinary opaque cube, it is
 * solid, you stand on it and you mine it, and none of that should change; what
 * it wants is a pot on the hot plate.
 *
 * So this list is deliberately NOT in `MODELLED_CROSS`. The mesher draws the
 * cube exactly as it draws a kiln, and the scan below adds one instance in the
 * cell ABOVE, which is what puts the pot on the lid of the block rather than
 * inside it. Same value as `MODELLED_PLANTS`: a bounding-box height in cells,
 * so 0.55 is a pot a little over half a cell tall standing on a full block.
 *
 * It is worth having as a list of one rather than as a special case, because
 * the whole reason the cooker is assembled out of tiles the atlas already has
 * (see `kitchen` in Blocks.js) is that new tiles mean a rebake. A model on top
 * is how any future machine gets a face of its own for free.
 */
const MODELLED_TOPPERS = { kitchen: 0.55 };
const TOPPER_KIND = [];
for (const n of Object.keys(MODELLED_TOPPERS)) if (ID[n]) TOPPER_KIND[ID[n]] = n;

/**
 * Blocks that ARE a model: `R_MODEL` in Blocks.js, drawn here and nowhere else.
 *
 * The third of the three lists and the only one about a *solid* block. A
 * modelled cross is a plant standing in an empty cell; a topper is an ornament
 * on a cube the mesher still draws; this is a full, solid, opaque cell whose
 * cube the mesher deliberately does not emit. A name here without an `R_MODEL`
 * in Blocks.js is a block drawn twice, and an `R_MODEL` without a name here is
 * an invisible block you can still walk into — the two go together exactly as
 * `MODELLED_CROSS` and `MODELLED_PLANTS` do.
 *
 * The number is a bounding-box height in cells, same as the other two lists,
 * and for a modelled block it is not a taste decision: the pack normalises the
 * model's longest axis to one, so this height is *also* what decides how wide
 * the thing arrives. The workbench measures 0.3257 x 0.2866 x 0.2957, so 0.880
 * is the height at which its widest axis is exactly one cell. Anything larger
 * grows through the wall beside it.
 *
 * Collision is untouched and stays the full cube it has always been. A bench is
 * something you stand on and build against, and shrinking its box to the
 * model's 0.88 would be a gameplay change nobody asked for; the cost is that
 * standing on one puts you 0.12 of a cell over the top, which is 12 cm.
 */
const MODELLED_BLOCKS = { bench: 0.880 };
const MODEL_KIND = [];
for (const n of Object.keys(MODELLED_BLOCKS)) if (ID[n]) MODEL_KIND[ID[n]] = n;

const FLOWER_NAMES = Object.keys(MODELLED_PLANTS);
const FLOWER_KIND = [];
for (const n of FLOWER_NAMES) if (ID[n]) FLOWER_KIND[ID[n]] = n;

/** Seconds under an open night sky that count as having survived a night. */
const NIGHT_OUTDOORS = 180;

const DEFAULT_SETTINGS = {
  fov: 75, sensitivity: 1.0, renderScale: 1,
  volume: 0.7, music: 0.35, post: true, bob: true, invertY: false, autoJump: false,
  // The two navigation aids, both on.
  //
  // On by default because they are the answer to a problem this planet has and
  // a flat world does not: it is a ball with no landmarks, no skyline and no
  // straight lines, and the fastest way to lose a base you spent an evening on
  // is to walk over one hill. Neither costs a frame — the compass writes one
  // transform and the map redraws only when you have changed column — so
  // neither has to earn its place the way an expensive option does, and a HUD
  // element that starts switched off behind a menu is one most players never
  // learn exists.
  // The minimap is OFF until you turn it on. A map in the corner is the thing
  // that turns a planet you are lost on into a planet you are reading, and this
  // world is meant to be the first. The compass stays: a bearing is what you
  // can work out from the sun, a map is not.
  minimap: false, compass: true,
  // Minutes for one full day and night, or 0 to follow the device clock.
  //
  // 0 is the default: the planet keeps your hours, so its evening is your
  // evening. The cost is real and worth stating — a cycle is then 24 real hours
  // long, so a player who only ever plays at noon never meets a husk, never
  // needs a torch, and sees none of the night. The slider is still there for
  // anyone who would rather have a short game cycle.
  dayMinutes: 0,
  // Which quality tier to render at: 'auto', 'high' or 'low'. See QUALITY.
  //
  // 'auto' means "ask the device", and the device that answers `pointer: coarse`
  // is the one that needs the low tier. A player who picks a tier by hand has
  // said something about their machine that the machine did not say, so the
  // stored answer wins over the probe from then on.
  quality: 'auto',
  // Which camera V last left you in.
  //
  // A setting rather than part of the save, because it is a preference about
  // how you like to look at the game and not a fact about a planet: a player
  // who plays in third person wants third person in the next world too, and
  // storing it per world would ask them to press V again on every New Game.
  view: VIEW_FIRST,
};

/**
 * The two rendering tiers, and the measurements that chose the low one.
 *
 * A phone is not a small desktop. This frame is CPU-bound on *submitting* draw
 * calls — proved twice over on an RTX 5060 at a phone viewport: the engine's own
 * CPU frame total tracks wall-clock p50 to within a few percent, and quartering
 * the pixel count (renderScale 0.5) changed p50 by 0.4ms, which is inside the
 * noise. A mid-range phone CPU is 3-5x slower single-threaded than that desktop,
 * so the ~10-11ms of submission measured here is 30-55ms on a phone before its
 * GPU has drawn anything. Nothing else in the frame is close: 598 chunk uploads
 * cost 18.7ms of main-thread time *in total* (0.03ms each), and there are never
 * more than five THREE.Light objects in the scene, so neither streaming nor
 * lighting is worth a tier.
 *
 * Three levers, all of which reduce draw calls, measured in one browser process
 * in a forest on seed 4242 with a fresh baseline retaken between every one
 * (run-to-run variance across sessions is +/-20%, so only within-process deltas
 * mean anything):
 *
 *   baseline                     p50 14.5ms  1178 calls  1.38M tris
 *   AO off                       p50 10.3ms   784 calls  0.81M tris   -29%
 *   view 110 cells               p50 12.7ms  1011 calls
 *   view  80 cells               p50 11.7ms   847 calls   -19%
 *   view  55 cells               p50 10.7ms   719 calls
 *   renderScale 0.75             p50 14.0ms  (pixels are not the constraint)
 *   AO off + rs 0.7 + view 80    p50  8.1ms   563 calls  0.69M tris   1.8x
 *
 * Then re-measured through this code rather than through the audit's stand-in
 * levers — `setQuality` flipping the real tier — in one process, alternating so
 * that every `low` sample has a `high` sample either side. That bracketing is
 * not ceremony: over a twelve-minute process an *unchanged* `high` went 14.8 ->
 * 21.4 -> 19.8ms while its draw calls barely moved, so a single before/after
 * pair could have been read as anything at all.
 *
 *   high  p50 14.8ms  1068 calls  1.35M tris  cpu 13.6ms  buffer 786x1704
 *   low   p50  9.3ms   663 calls  0.75M tris  cpu  8.1ms  buffer 550x1192
 *   high  p50 21.4ms  1113 calls  1.36M tris  cpu 19.9ms
 *   low   p50 12.8ms   703 calls  0.75M tris  cpu 11.8ms
 *   high  p50 19.8ms  1151 calls  1.36M tris  cpu 18.7ms
 *
 * Draw calls -38%, triangles -45%, CPU per frame -40%, and both `low` samples
 * land ~37% under the mean of the two `high` samples that bracket them. The
 * counts are the trustworthy part and they say the same thing as the clock,
 * which is what a submission-bound frame should do.
 *
 * `low` is that last row. Each part earns its place differently:
 *
 *  - **ao: false** is the whole reason a tier exists. It is 29% on its own, and
 *    it is the only lever that costs picture rather than distance. See
 *    `PostFX.setAO`.
 *  - **loadDist 96** is the 80-cell cut expressed the way the streamer measures
 *    it. The cut in the audit hid *meshes* whose bounding sphere came within 80
 *    units of the camera; `_streamChunks` measures to a chunk's centre, and a
 *    chunk's half-diagonal is ~12.9 units, so 96 is the same horizon and it also
 *    never builds the geometry in the first place — which a phone wants for the
 *    memory as much as for the calls. `keepDist` keeps the stock 190/150
 *    hysteresis ratio rather than a second guessed number.
 *  - **renderScale 0.7** is the cheapest of the three here and the most valuable
 *    there. It bought almost nothing on the desktop measurement above precisely
 *    because that machine is not fill-bound — but a phone's GPU is small, its
 *    memory bandwidth is smaller, and it is the part of this that turns into
 *    battery and heat. Multiplied into the player's own render-scale slider
 *    rather than overwriting it, so the two are independent controls.
 *
 * The horizon cut is the part with a visible price and it is stated plainly:
 * distant terrain ends ~54 units nearer, and the aerial haze at that range is
 * only ~20% (AERIAL_GAIN's curve reaches 0.38 at the desktop load distance), so
 * a far ridge on a clear noon does not fade out, it stops. That is the trade the
 * low tier is: a nearer world you can play, against a far one you cannot.
 *
 * ---
 *
 * `buriedDist` is a second horizon, for chunks that are under the ground rather
 * than on it, and unlike the one above it costs no picture at all. See
 * `_streamChunks` and `Planet.chunkBuried` for what it is and how far it was
 * measured to be safe; the short version is that the surface horizon is 150
 * units because that is how far you can see across a planet, and underground
 * you cannot see 22.
 */
const BURIED_LOAD_DIST = 64;

const QUALITY = {
  high: { ao: true, sea: 1, renderScale: 1, loadDist: CHUNK_LOAD_DIST, keepDist: CHUNK_KEEP_DIST,
    buriedDist: BURIED_LOAD_DIST },
  low: {
    ao: false,
    /**
     * The two short waves of the sea's swell, and the back half of the
     * bioluminescent wake. See uSeaDetail in VoxelMaterial: what a phone loses
     * is the metre-scale chop, not the swell itself, and what it keeps is every
     * part of this that reads at play distance.
     */
    sea: 0,
    renderScale: 0.7,
    loadDist: 96,
    keepDist: Math.round(96 * (CHUNK_KEEP_DIST / CHUNK_LOAD_DIST)),
    /**
     * Scaled with the surface horizon, for the same reason `keepDist` is: one
     * ratio to keep rather than a second guessed number. 41 is still nearly
     * twice the longest sight line ever measured underground.
     */
    buriedDist: Math.round(BURIED_LOAD_DIST * (96 / CHUNK_LOAD_DIST)),
  },
};

/**
 * Which tier this session runs at.
 *
 * The touch probe is `TouchControls.wanted()` and deliberately not a second test
 * of its own: that one is already the game's single answer to "is a fingertip
 * driving this", it is already the thing that decides whether the on-screen
 * controls exist, and it already carries the `?touch=0` / `?touch=1` escape
 * hatch — which now overrides the quality tier too, for free, and is how the
 * mobile preset is measured and photographed on a desktop.
 */
const qualityTier = (settings) => {
  if (settings.quality === 'low' || settings.quality === 'high') return settings.quality;
  return TouchControls.wanted() ? 'low' : 'high';
};

class Game {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...(Save.settings() || {}) };
    /**
     * Resolved before `_initRenderer`, because the pixel ratio and the composer's
     * buffers are both built from it there and neither is free to rebuild later.
     * On a mouse-and-keyboard machine this is `QUALITY.high`, whose every field
     * is the value that was hard-coded before this existed — so desktop runs the
     * same numbers it always ran.
     *
     * `qualityTier` is the resolved name and is what a settings row would tick
     * its box from: `settings.quality` can say 'auto', and a checkbox cannot.
     */
    this.qualityTier = qualityTier(this.settings);
    this.quality = QUALITY[this.qualityTier];
    this.state = 'loading';
    this.clock = new THREE.Clock();
    this.frameTimes = [];
    this.editSeq = 0;
    this.playtime = 0;
    // Position in the day/night cycle, 0..1, with 0 at midnight to match what
    // the wall clock would report. Seeded to mid-morning so a new world opens
    // in daylight rather than dropping you straight into a husk night.
    this.dayT = 8 / 24;
    this.stats = { mined: 0, placed: 0, crafted: 0 };
    /** See `_resetWorld`, which is the copy of these two that runs per planet. */
    this.barter = newBarterState();
    this._lastFace = -1;
    this.kilns = new Map();
    // Crate contents, keyed the same way kilns are. Thirty-six carried slots is
    // nothing against a hundred and seventy block types: without somewhere to
    // put things, building anything large means a constant round trip to a hole
    // in the ground you filled with the overflow.
    this.crates = new Map();
    /** {col, k} of the bed you last used, or null. */
    this.homeSpawn = null;
    /** Where your pack is waiting, while any of it is still out there. */
    this.deathSite = null;
    /** The cast currently in the water, or null. */
    this.fishing = null;
    this.bobber = null;
    /** Whether the float has been swapped for the rod model's own. See `_showBobber`. */
    this.bobberModelled = false;
    /** Sign text, keyed like the kilns and crates. */
    this.signs = new Map();
    /** Bumped whenever the writing changes, so _syncSignText knows to rebuild. */
    this.signSeq = 0;
    /**
     * Cells winter turned to ice, keyed like the rest.
     *
     * This has to be remembered rather than worked out. Ice is a block a player
     * can craft, carry and build with, and worldgen never places any — so
     * "thaw every ice block in spring" would quietly demolish somebody's ice
     * house on the first warm day. Only what winter froze is winter's to melt.
     */
    this.frozen = new Set();
    /**
     * Cells the season has covered in snow or uncovered, keyed like the rest,
     * each holding the block that was there before it did.
     *
     * The same argument as `frozen` and one step further. Ice only has to know
     * *which* cells winter took, because a thaw can only ever give back water;
     * snow has to know what it took as well, because the ground under a
     * snowfield is grass in a meadow, gravel in scree and packed earth in the
     * tundra, and a season that guessed would flatten all three to dirt over a
     * couple of years. Reading the column at the time of the melt is what the
     * melt does when it has no memory of the cell; this is what keeps the round
     * trip exact when it does.
     *
     * Bounded by `SNOW_MEMORY`, which is also the bound on what this feature
     * can add to a save.
     */
    this.seasonSnow = new Map();
    /** Placed hearths, keyed like the rest. See _refreshWards. */
    this.hearths = new Set();
    /** Has the planet already given up its one hearth? */
    this.coreFound = false;
    /** Burning cells near the player, refilled by the hand-light scan. */
    this._flameCells = [];
    /** Hot-spring surface cells near the player. See `_tickSteam`. */
    this._steamCells = [];
    // Nearest waterfall and nearest hot spring, in world space, for the two
    // placed ambient beds. Held as fields rather than returned because
    // `_tickWaterSound` runs at 2Hz and `_updateAudio` reads them every frame.
    this._fallAt = new THREE.Vector3();
    this._springAt = new THREE.Vector3();
    this._fallNear = false;
    this._springNear = false;
    this._fallSize = 1;
    // Handed to `setAmbience` every frame; reused so the mix does not allocate.
    this._fallSrc = { x: 0, y: 0, z: 0, size: 1 };
    this._springSrc = { x: 0, y: 0, z: 0, size: 1 };
    /**
     * The nearest thing that is burning, and the nearest lava, for the two
     * placed fire beds. Filled by `_handLight`, which is already walking every
     * emitting cell within eight of you and is already cached behind the cell
     * you stand in — so this is a comparison per emitter and no new scan.
     *
     * `size` is how much of it there is rather than how close it is; distance
     * is the panner's job. One torch in a corridor and a lava lake are two
     * different sounds, not the same sound at two volumes.
     */
    this._fireAt = new THREE.Vector3();
    this._lavaAt = new THREE.Vector3();
    this._fireNear = false;
    this._lavaNear = false;
    this._fireSrc = { x: 0, y: 0, z: 0, size: 1 };
    this._lavaSrc = { x: 0, y: 0, z: 0, size: 1 };
    /**
     * Every *light-emitting* cell near the player — torches, lanterns, lit
     * kilns, glowstone, crystal, lava — in world space, refilled by the same
     * scan. `_flameCells` above is the subset of these that is actually on fire
     * and wants embers thrown off it; this is the whole set, because a thing
     * does not have to burn to light an animal standing next to it.
     *
     * See `_entityLight` for what reads it. The records are pooled and reused
     * across rescans, so a rescan allocates nothing.
     */
    this._emitters = [];
    this._emitPool = [];
    /**
     * The shared clock the two moving flames flicker on, in seconds.
     *
     * It lives here, and it is advanced by the frame rather than by either
     * flame, because it has two readers and used to have only one writer. It was
     * created lazily inside `_updateHandLight`, *past* that method's "am I
     * holding an emitter" early return, and `_updateDropLight` read it — so
     * until the player had held a light for one frame it was `undefined`, and
     * the drop light's `Math.sin(undefined * 9.7 + 1.9)` was NaN.
     *
     * That is not a wrong flicker, it is a black planet. The NaN goes into
     * uDropLightColor, the shader adds it to `moving`, `moving` goes into
     * blockRad and blockRad into indirectDiffuse, and NaN times anything is
     * still NaN: every terrain fragment on screen resolves to black, in full
     * daylight, whether or not the flame could reach it. The view model is a
     * separate material and kept rendering, which is what made it look like a
     * post-processing fault. Dropping a torch, a lantern, glowstone or a crystal
     * block anywhere in the world blacked out the whole world, and picking up
     * *any* light source cured it permanently for the session — because that
     * first lit hand frame finally assigned the clock a number.
     *
     * Initialising it to 0 here would be enough to stop the NaN. Advancing it in
     * the tick instead is the actual repair: a clock read by two flames should
     * not be owned by one of them, and while it was, a dropped torch lying on
     * the ground with nothing in your hands flickered on a *frozen* phase — the
     * clock only ticked while the hand light was lit. Same bug, quieter symptom.
     */
    this._flameT = 0;
    this.seed = 0;
    /**
     * Which of the ten slots this session belongs to, zero-based, or -1 when
     * there is no world open.
     *
     * Every write goes here and nowhere else — the autosave, the tab-hide
     * write, the one right after worldgen, Save Game and Quit to Menu all go
     * through `saveGame`, which is the single place that names a slot. It is
     * set exactly twice: by `continueGame`, to the slot that was loaded, and by
     * `newGame`, to the slot the player chose to write to.
     */
    this.saveSlot = -1;
    /**
     * How hard this planet is: 'easy', 'normal', 'hard' or 'extreme'.
     *
     * A fact about the world, not about the person, so it is chosen once on the
     * New Game screen, written into the save, and read back on load. For three
     * of the four it scales mob blows and nothing else — not health, not spawn
     * rates, not hunger, not a fall. See `mobDamageMul`.
     *
     * Extreme is the exception and says so out loud: the carnivores hunt you,
     * the dark carries more husks, and a death is the end of the run. Those are
     * *two* predicates in `game/NewGame.js` rather than comparisons written out
     * here — `huntsOnSight` and `endsOnDeath` — so what a tier means is stated
     * once, in the module a harness can load. The dark is not a third: it rides
     * on the same `Mobs.savage` flag `huntsOnSight` sets, which is what chooses
     * MAX_HOSTILE_SAVAGE over MAX_HOSTILE_SURFACE. There was a `crowdedNights`
     * here saying otherwise and nothing imported it.
     *
     * Assigned through `_setDifficulty` and never directly: the mob manager
     * keeps its own copy of the first of those, and the two disagreeing is the
     * one way this can break silently.
     */
    this.difficulty = DEFAULT_DIFFICULTY;
    /** The loadout keys picked for this world, in pick order. */
    this.loadout = [];
    /**
     * What a death costs on this planet: 'lose' or 'keep'.
     *
     * The third New Game answer, and a rule of the world in exactly the sense
     * difficulty is. Never assigned directly — `_setDeathRule` is what keeps
     * `skills.onDeath` agreeing with it, and the two disagreeing is the one way
     * this feature can break silently.
     */
    this.deathRule = DEFAULT_ON_DEATH;
    this.worldReady = false;
    /** The character picker is up and the world behind it must wait. */
    this._choosing = false;
    /** The world finished while it was up, and `_onWorldReady` still owes a run. */
    this._readyHeld = false;
    this.autosaveTimer = 0;
    /**
     * Consecutive failed writes. Zero is the normal state and the only one that
     * clears the chip; see `saveGame`, which reports on the edges rather than
     * on every attempt.
     */
    this.saveFailures = 0;
    /** Quit has already refused once and will go through on the next press. */
    this._quitAnyway = false;
    /** chunk ids that currently have (or have been asked for) a mesh */
    this.liveChunks = new Set();
    /**
     * chunk id -> the baked voxel light of the modelled-cross cells in it, as
     * the mesher packed it. See `Mesher.CROSS_LIGHT_ADDR_SHIFT` for the word,
     * and `_crossLightAt` for how it is read back.
     *
     * This is the only piece of the worker's light field the main thread has,
     * and it exists so a flower beside a torch is lit by it. Chunks with no
     * flowers in them are simply absent — the worker ships `null` for those —
     * so this map is small even with the whole horizon resident.
     */
    this.crossLight = new Map();
    this._streamPending = false;
    this._streamTimer = 0;
    this._hurtGuard = 0;

    /**
     * What you have become, as opposed to what you are carrying.
     *
     * Built before the UI and the player because both read it on their first
     * frame: the skills screen asks it for a summary, and `player.maxHealth` is
     * its answer rather than a constant from the moment the world opens.
     */
    this.skills = new Skills();
    /**
     * What you have done, as opposed to what you have become.
     *
     * Made once and never replaced, but the record inside it is the planet's:
     * it rides in the world payload, `_resetWorld` empties it and the load path
     * fills it. See the head of `Achievements.js`.
     */
    this.achievements = new Achievements();
    /** Seconds until the next `skills.observe`. See `_tickSkills`. */
    this._skillTimer = 0;

    this._initRenderer();
    this.inventory = new Inventory();
    this.ui = new UI(this);
    this.audio = new Audio();
    this.audio.setVolumes(this.settings.volume, this.settings.music);
    this.input = new Input(this.canvas);
    this.input.invertY = this.settings.invertY;
    this.input.onLockChange = (locked) => {
      // `skillsOpen` for the same reason `screenOpen` is here: opening a screen
      // is what dropped the lock, and pausing on top of it would be the game
      // reacting to its own action.
      if (!locked && this.state === 'playing' && !this.ui.screenOpen && !this.ui.skillsOpen) {
        // Esc is also what dropped the pointer lock, and that key press has now
        // been spent on opening this menu. Swallow it, or the global Escape
        // handler would close the pause screen in the very same frame.
        this.input.justPressed.delete('Escape');
        this.pause();
      }
    };
    /**
     * Thumbs, or nothing at all.
     *
     * Built here rather than lazily, because `enableTouch` has to be in effect
     * before the first `requestLock` goes out: a phone that reached the world
     * without it would spend the session logging NotAllowedError and pausing
     * itself every time a screen closed. `null` on a mouse-and-keyboard
     * machine, and every touch path in the game hangs off this one being
     * non-null, so desktop runs exactly the code it ran before.
     */
    this.touch = TouchControls.wanted() ? new TouchControls(this) : null;
    this.inventory.onChange = () => this.ui.refresh();

    this.materials = createVoxelMaterials();
    this.planet = new Planet(this.materials);
    this.scene.add(this.planet.root);

    this.player = new Player(this.planet);
    this.player.skills = this.skills;
    this._applySkills();
    this.player.autoJump = !!this.settings.autoJump;
    this.viewModel = new ViewModel((id) => this.drops.createItemMesh(id));
    this.sky = new Sky(this.scene, this.renderer);
    // The dividers, seen from across the map. The portal blocks are terrain and
    // terrain streams, so a boundary four hundred units off does not exist as
    // geometry at all; this is the curtain of light that stands in for it past
    // the streaming range. One draw call, built once, never rebuilt. See
    // render/Dividers.js.
    this.dividers = new Dividers(this.scene);
    this.particles = new Particles(this.scene, this.planet);
    // `setQuality` also does this, but it only runs when the tier CHANGES, and
    // a session that never opens the settings never calls it. The particles are
    // built long after the tier is resolved, so this is where the starting
    // value has to be handed over.
    this.particles.setQuality(this.qualityTier === 'low');
    voxelUniforms.uSeaDetail.value = this.quality.sea;
    this.blockModels = new BlockModels(this.scene);
    this.signText = new SignText(this.scene);
    this.drops = new Drops(this.scene, this.planet, this.materials);
    // Arrows in flight. Built here, between the drops and the animals, because
    // it needs the planet for its collision and nothing else: the mob list is
    // handed to `update` per frame rather than held, so the projectiles cannot
    // outlive a world reset holding a reference to a dead herd.
    this.arrows = new Arrows(this.scene, this.planet, itemIdOf('arrow'));
    this.arrows.onHit = (mob, _dmg, killed) => {
      this.audio.mobHit(mob.position);
      // An arrow kill has to earn what a sword kill earns, and be worth the
      // same mark. This is the second death path in the game and the melee
      // branch of `_interact` is the other; a bow-only player was earning
      // nothing at all for combat because only that branch awarded either.
      if (!killed) return;
      // The one source of xp in the game, and it is offered unconditionally:
      // `xpForKill` returns 0 for anything that is not a husk or a monster, so
      // the hostile test lives in one place rather than at each of the two
      // death paths where it could drift apart.
      this.skills.xpKill(mob.spec, mob.baby > 0);
      // Counted for the record only. `xpForKill` still decides what a kill is
      // worth, and this pays nothing.
      this.stats.kills = (this.stats.kills ?? 0) + 1;
    };
    // `dig('stone', pos)` stood here, which meant an arrow into a tree sounded
    // like a pickaxe. `pos` is the last position OUTSIDE the block that stopped
    // it, so the probe usually reads air and falls back to the wooden thud of
    // the shaft itself, which is the right answer for a miss into the dirt too.
    this.arrows.onStick = (pos) => {
      const id = this.planet.blockAtWorld(pos.x, pos.y, pos.z);
      this.audio.impact(id ? BLOCKS[id].sound : 'wood', pos, true);
    };
    // An arrow burning up in lava, given the same embers a dropped item gets
    // there — it is the same event and should not read as two different ones.
    this.arrows.onBurn = (pos) => {
      this.particles.embers(pos, _burnUp, 5, 0.7);
    };
    this.mobs = new Mobs(this.scene, this.planet, this.drops);
    // Creatures speak for themselves — idle calls, pain and death, all anchored
    // in the world so you can hear which direction the herd is in.
    this.mobs.onSound = (kind, mob) => this.audio.mob(mob.type, kind, mob.position);
    // Difficulty lives here, on the one wire every mob blow crosses, and not
    // inside `_takeHit`.
    //
    // `_takeHit` is the door for *all* damage — lava, fire, drowning, a fall,
    // a cactus — and the player asked for mobs only, so scaling in there would
    // quietly make hard a harder planet rather than a harder ecology. This is
    // the only call `Mobs.onAttack` makes (see `_resolveHits`), so it is the
    // narrowest point that still catches every species.
    //
    // Before `skills.soak` rather than after, and it does not matter which:
    // tolerance is a proportion of the blow, not a flat subtraction, so
    // soak(dmg * m) and soak(dmg) * m are the same number. Scaling here means
    // hard is 1.5x the damage a player would otherwise have taken whatever
    // their tolerance, instead of hard eating the skill or the skill eating
    // hard.
    this.mobs.onAttack = (dmg, mob) => this._takeHit(dmg * this.mobDamageMul, mob);
    this.mobs.onBurn = (mob) => this.particles.embers(mob.position, mob.up, 2, 0.55);
    // The crater, and the fuse that precedes it. Two wires, and everything they
    // reach is in `game/Explosion.js` — Mobs owns when a thing goes off and
    // knows nothing about blocks; that module owns the hole and knows nothing
    // about mobs. `explode` needs `_applyEdits` and `_takeHit`, so it is handed
    // the game rather than four callbacks.
    this.mobs.onBlast = (mob) => explode(this, mob.position, mob);
    this.mobs.onFuse = (mob, secs, armed) => {
      // Once, on arming: `Audio.fuse` schedules the whole swell on the audio
      // clock, so it must not be re-fired per frame.
      if (armed) this.audio.fuse(mob.position, secs);
      if (secs > 0) this.particles.fuse(mob.position, mob.up, 1 - secs / mob.spec.blast);
    };
    // A torch on the ground has to light the animal standing next to it, and
    // nothing in the scene graph can tell it so — see `_entityLight`. Handed
    // over as a probe rather than as a per-mob light so that Mobs owns *when*
    // to ask (it already walks the herd once a frame) and the world owns the
    // answer.
    this.mobs.blockLightAt = (pos, out) => this._entityLight(pos, out);
    // The same field, for the things lying on the floor. A dropped pickaxe in a
    // torch-lit gallery was as dark as one in an unlit one, which is the second
    // half of the same report; see `Drops._applyLight` for the three different
    // doors a drop takes light through.
    this.drops.blockLightAt = (pos, out) => this._entityLight(pos, out);
    // The stalker is the one mob whose behaviour is a question about what is on
    // screen, so it needs the thing that decides that. Handed over the same way
    // the light probe above is: a reference rather than a parameter, because
    // `update` is called from one place and every other caller of it — the
    // tests, a headless harness — is better off with no camera at all than with
    // a fake one. See the note on `Mobs.camera` for what null means there.
    //
    // Set once. `this.camera` is built in _initRenderer, which runs before this
    // constructor body reaches Mobs, and is never replaced afterwards — only
    // its fov and aspect are rewritten.
    this.mobs.camera = this.camera;
    // Same shape, same reason: Mobs sizes its despawn radius and its crowd
    // budgets off how far this session actually streams, and `qualityTier` is
    // the one answer to that question. Written from here rather than read from
    // there so there is never a second copy of the tier to drift.
    this.mobs.loadDist = this.quality.loadDist;
    this.drops.onBurn = (pos) => {
      this.particles.embers(pos, _burnUp, 5, 0.7);
    };
    // A merchant arrives with a bell and nothing else.
    //
    // There was a toast here — "Bells, somewhere close by", plus what he wanted
    // — and the measurement behind it still stands: over 150 seconds a trader
    // never came within talking range of a player who stayed put, closest 11
    // cells and median 28, while ringing 15 times. He is found by walking
    // towards the sound and never by waiting.
    //
    // But a caption is the game telling you a rare thing has happened, which
    // makes it feel scheduled rather than met. The bell says the same thing and
    // says it from a direction. If merchants now go unmet, the honest fix is to
    // let him walk toward the player rather than to put the caption back.
    this.mobs.onMerchant = (mob) => {
      this.audio.mob(mob.type, 'idle', mob.position);
    };
    /**
     * The end of the game. See the head of `Endgame.js`.
     *
     * Made once and reset per world, like the mob manager it sits on top of: it
     * holds the sixteen bosses and the two faces that have stopped making
     * monsters, and everything it does is a call into `Mobs`. `_newWorld`
     * resets it and `_loadWorld` reads it back.
     */
    this.endgame = new Endgame(this.planet, this.mobs);
    // Two lines of copy for the whole feature, and both are labels rather than
    // explanations. Where they are and what they do is the game's to show.
    this.endgame.onBegin = () => {
      this.ui.toast('The sixteen are awake.', itemIdOf('gold_carrot'), 6000);
      this.audio.ui(320);
    };
    // The mark itself is set by `Achievements.scan` off `endgame.won`, on the
    // same once-a-second sweep every other flag is found by. This is only the
    // moment.
    this.endgame.onWin = () => {
      this.ui.toast('All sixteen down.', itemIdOf('gold_carrot'), 9000);
      this.audio.ui(720);
    };
    // The player's body. Built after Drops because it borrows the same factory
    // the drops use — what you carry and what you dropped are the same mesh.
    this.character = new PlayerCharacter(this.scene, (id) => this.drops.createItemMesh(id));
    this.viewModel.onPunch = (hand) => this.character.punch(hand);
    // First person wears the same character's arms as third person. One hook
    // rather than a call at each of the three `setCharacter` sites (boot, New
    // Game, load) — the fourth site added later would have been the one that
    // forgot, and both classes default to the same character so the
    // early-return on an unchanged id keeps them in step.
    this.character.onCharacter = (id) => {
      this.viewModel.setCharacter(id);
      // ...and so does the stalker, which is the whole of what he is: your own
      // body, in the dark, at a distance. Routed through this hook rather than
      // read out of `this.character` at spawn time so that Mobs never has to
      // know what a PlayerCharacter is — it gets a url, exactly like every
      // other species. The model itself is already loaded: `playerModelUrls`
      // is prepared at each of the three setCharacter sites.
      this.mobs.playerModel = characterUrl(id);
    };
    /**
     * Which camera the F5 cycle is on, restored from the last session.
     *
     * Validated rather than trusted: settings are JSON in localStorage, which
     * anyone can hand-edit, and a stored 7 would put the game in a camera mode
     * that does not exist — `viewModel.enabled` false and no body drawn, which
     * is a black screen with a HUD on it and no obvious way back.
     */
    const savedView = this.settings.view | 0;
    this.viewMode = savedView >= 0 && savedView < VIEW_COUNT ? savedView : VIEW_FIRST;
    this.viewModel.enabled = this.viewMode === VIEW_FIRST;
    // The sight follows the restored camera, not just the keypress — a player
    // who left the game in third person should not be handed a crosshair back
    // for the one frame before they touch V.
    this._syncCrosshair();

    /**
     * Regions the player has changed, as region ids.
     *
     * A region nobody has touched is byte for byte what the generator makes of
     * it from the seed, so it does not have to be stored - it can be made again
     * on load. This set is what separates the two, and it is filled in
     * `_applyEdits`, which every block change in the game passes through.
     *
     * Loaded saves seed it with whatever they carried, because those regions
     * were edited by a past session and are still not what the seed would make.
     */
    this.editedRegions = new Set();
    this.farming = new Farming(this.planet, (edits) => this._applyEdits(edits));
    this.water = new Water(this.planet, (edits) => this._applyEdits(edits));
    /** The glowing trail a swimmer leaves. Fed below, read by the water shader. */
    this.bioWake = new BioWake();
    /**
     * Where the sea goes down a hole. Built here with a seed of 0 and re-seeded
     * by `newGame`/`continueGame`, the same way everything else that depends on
     * which planet this is gets set up: the object outlives a world, the seed
     * does not.
     *
     * It owns no state beyond that seed and writes nothing to a save. See
     * `game/Whirlpool.js` for why a whirlpool is not a block and not generated.
     */
    this.whirlpools = new Whirlpools(this.planet, 0);
    /**
     * Cells that may hold a sand or gravel block with nothing under it, as
     * `col * D + k`. Seeded by every edit, drained on a clock. See
     * `_seedGravity` and `_settleGravity`.
     *
     * Not saved. It is a work list rather than world state — everything in it is
     * re-derivable from the voxels — and saving it would mean a world reloaded
     * mid-collapse finished the collapse, while a world reloaded a second later
     * did not. A dune left hanging by a quit is left hanging by the reload too,
     * and comes down the next time anything touches it, which is the same rule
     * `_dropUnsupported` already lives by for exactly the same reason.
     */
    this.falling = new Set();
    /** Runs of gravity blocks in the air, waiting to land. See _settleGravity. */
    this._settling = [];
    this.fallTimer = 0;
    /** The funnel in flight, or null. Never saved: see the head of Tornado.js. */
    this.tornado = null;
    // A current carries what is in it. Both are built before the sim is, so
    // they take the reference here rather than through their constructors.
    this.player.water = this.water;
    this.drops.water = this.water;
    // Same shape, same reason: the player is built before the animals are, and
    // its box has to stay out of their bodies.
    this.player.mobs = this.mobs;
    this.weather = new Weather();
    // Lightning and thunder are one strike, and until now they were two events
    // that happened to share a frame: `Weather` set the flash and called this,
    // this called `thunder()`, and `thunder()` rolled its OWN idea of how close
    // the strike was. So a flash directly overhead could be answered, in the
    // same millisecond, by a roll that had decided it was miles off — and every
    // strike in the game arrived at zero delay regardless.
    //
    // One roll now decides both. `near` is 0 for a distant strike and 1 for one
    // overhead, and it picks the gap between the flash you saw and the boom you
    // hear as well as the sound itself, so counting the seconds tells you what
    // it always tells you. 6.5s at the far end is about two kilometres at the
    // real speed of sound, which is as long as a game can hold the count before
    // the player has stopped connecting the two.
    //
    // The delay is a bare timer on purpose: a boom that outlives the storm that
    // made it is correct, and one that arrives after the tab is hidden is
    // dropped by `_live()` on its own account, because the context is suspended.
    this.weather.onThunder = () => {
      const near = Math.random();
      const strength = 0.85 + Math.random() * 0.35;
      setTimeout(() => this.audio.thunder(strength, near), (1 - near) * 6500);
    };
    this.seasons = new Seasons();
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, { ao: this.quality.ao });
    this.postfx.enabled = this.settings.post;
    this.postfx.setSize(this.width, this.height);
    this.viewModel.setSize(this.width, this.height);
    // The shadow map is the same on both tiers, deliberately. It looked like the
    // obvious third thing to cut, and it is not: the sun's map is rebuilt once
    // per frame by the beauty pass and the AO prepass was made to reuse it (see
    // `_patchGtaoCutout`), so with AO off there is exactly one shadow pass left
    // and dropping it would cost every contact shadow in the game for a saving
    // the low tier has already taken elsewhere.
    this.renderer.shadowMap.enabled = true;
    this.sky.sunLight.shadow.mapSize.set(2048, 2048);

    this._initHighlight();
    this._bindPlayerEvents();
    this._bindWindow();
    // One pass through the resize path so the sky and particle pixel ratios pick
    // up the saved render scale too, rather than waiting for the first resize.
    this._resize();

    this.mining = { key: null, progress: 0 };
    /**
     * The bow, mid-draw.
     *
     * `t` is the charge in seconds-normalised-to-one and is the only state the
     * mechanic has: everything else — the arm, the body, the sight, the field of
     * view — is a function of it, computed fresh each frame. There is no "am I
     * drawing" flag because `t > 0` is that question, and a second field would
     * be a second thing to keep true.
     *
     * Deliberately not saved. An arrow half-drawn when you quit is not a state
     * worth restoring, and the save format is a compatibility surface.
     */
    // `slot` is the hand that is drawing, remembered from the frame it claimed
    // the button so the release can charge the wear and the recoil to it. Null
    // whenever nothing is drawing. `_aimHit` is the crosshair cell `_interact`
    // last resolved, which `_tickBow` reads because it runs a frame ahead of it.
    this.bow = { t: 0, slot: null, hint: null };
    this._aimHit = null;
    this.placeCooldown = 0;
    this.useCooldown = 0;
    /** Seconds since the last swing landed, for the attack rhythm. */
    this.attackT = ATTACK_PERIOD;
    this.damageFlash = 0;
    /**
     * How much of the screen the stuff you are buried in has, 0..1, and what
     * colour it is. See `_tickSink`.
     */
    this._buried = 0;
    this._buriedColor = [0, 0, 0];
    /** The sink block the feet were in last frame, for the edge. */
    this._wasSink = 0;
    /** Seconds of cold in a drift, bled off slowly once out. See `_tickChill`. */
    this.chillT = 0;
    /** Seconds of poison left to run, and seconds of spores breathed in a
     *  deathcap. Both `_tickPoison`'s, and both cleared in `respawn`. */
    this.poisonT = 0;
    this.sporeT = 0;
    /**
     * The spyglass, on C: 0 is the normal view and 1 is fully narrowed.
     *
     * Hold rather than toggle. Zoom is something you do *to* look at one thing
     * — a shape on a ridge, whether that is a merchant or a husk — and then
     * stop doing; and it is exactly the state you need to be out of instantly
     * when the thing turns out to be hunting you. A toggle would leave the
     * player at 22° of view with something in swinging range and a key press
     * between them and being able to see it.
     */
    this.zoom = 0;
    this.breath = 1;
    this.energy = 1;      // nourishment: gates health regeneration
    this.soakT = 0;       // seconds in a hot spring, bled off slowly once out
    this._balmT = 0;      // change owed toward the next point of a cinderlands heal
    this.eating = 0;      // seconds held on a food item
    this.shelter = 1;     // 0 under cover, 1 in open sky — gates precipitation
    this._hlCol = -1; this._hlK = -1; this._hlSeq = -1;
    this._hlValue = { r: 0, g: 0, b: 0 };

    this._loadAssets();
    // Never let one bad frame end the game. An exception thrown inside the
    // animation callback stops the rAF chain for good: the picture freezes,
    // input dies, and the only clue is a line in the console. Log it once per
    // distinct error and keep drawing — a glitched frame beats a dead tab.
    this._frameErrors = new Set();
    this.renderer.setAnimationLoop(() => {
      try {
        this._frame();
      } catch (err) {
        const key = String(err?.stack ?? err);
        if (!this._frameErrors.has(key)) {
          this._frameErrors.add(key);
          console.error('[frame]', err);
        }
      }
    });
  }

  // --- boot -----------------------------------------------------------------

  _initRenderer() {
    this.canvas = document.getElementById('view');
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false, alpha: false,
    });
    // The saved render scale has to be folded in here, not on the first resize.
    // PostFX reads the renderer's pixel ratio when it builds its buffers, so a
    // player who dropped the scale for performance would otherwise get a
    // full-resolution first session every time they reloaded.
    renderer.setPixelRatio(this._pixelRatio());
    const vs = viewSize();
    renderer.setSize(vs.w, vs.h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.width = vs.w; this.height = vs.h;

    this.scene = new THREE.Scene();
    // Scene fog exists for ONE job: the underwater tint, on everything the
    // voxel shader cannot reach.
    //
    // Terrain and seabed are voxel materials and take their water extinction in
    // FOG_FRAG, per channel, with red going first. Fish, kelp and coral are not
    // voxel geometry at all — a fish is a loaded model and kelp and coral are
    // block models, all of them wearing their own MeshStandardMaterial — and
    // they were getting none of it. That is the whole of "corals and fish keep
    // full saturation and read as pasted on top": they are the objects the
    // water tint could not reach.
    //
    // Established rather than assumed, by forcing this fog red and seeing what
    // turned red: the fish, the kelp and the coral did, and every voxel
    // fragment in the frame did not. Measured on a fish pinned forty cells down
    // the view axis, one world, two frames: 59/84/101 with the fog off, 0/20/33
    // with it on — which is the water it is swimming in.
    //
    // Attached once and left attached, with density 0 in air, rather than
    // hung on and taken off as the player's head crosses the surface. Adding
    // or removing scene.fog flips USE_FOG, which is part of three's program
    // cache key, so toggling it recompiles every material in the scene — and
    // the head crosses the waterline repeatedly on any swim. At density 0 the
    // term is exp(0) exactly, so an air frame is unchanged and pays one varying.
    //
    // FogExp2's curve is 1 - exp(-d²·density²) against the shader's
    // 1 - exp(-ext·d), so the two cannot be matched everywhere; the density is
    // fitted to the green channel at mid range in _updateSharedUniforms. A fish
    // very close in is therefore a little less tinted than the rock behind it,
    // which is a second-order colour error where the first-order one was a
    // fully saturated fish. The exact fix is to give mob materials the real
    // FOG_FRAG, and that needs vWorld and vSun varyings they do not have.
    this.scene.fog = new THREE.FogExp2(0x000000, 0);
    // Far plane is deliberately tight. Nothing depth-tested lives beyond the
    // cloud shell; the sky dome, stars and sun all draw with depthTest off. A
    // huge far plane wrecks depth precision, which shows up as GTAO haze over
    // the sky and softer shadows.
    //
    // There is no outer radius to derive this from any more. What has to fit
    // inside it is the cloud shell and the sky dome, both of which are hung a
    // fixed distance off the camera on a flat map, so the far plane is written
    // down against the same number the horizon is.
    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov, this.width / this.height, 0.06, 1400);
    this.camera.position.set(0, K_TERRAIN_MAX + 10, 0);
    this.scene.add(this.camera);
  }

  _initHighlight() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this.highlight = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x08080d, transparent: true, opacity: 0.38, depthTest: true,
    }));
    this.highlight.frustumCulled = false;
    this.highlight.visible = false;
    this.highlight.renderOrder = 30;
    this.scene.add(this.highlight);
    this._hlCorners = Array.from({ length: 8 }, () => [0, 0, 0]);
  }

  /** Draw the wireframe of a cell. It is a unit cube, so it is eight corners. */
  _showHighlight(col, k) {
    const { x, y } = colParts(col);
    const c = this._hlCorners;
    cellCorner(x, y, k, c[0]);
    cellCorner(x + 1, y, k, c[1]);
    cellCorner(x + 1, y + 1, k, c[2]);
    cellCorner(x, y + 1, k, c[3]);
    cellCorner(x, y, k + 1, c[4]);
    cellCorner(x + 1, y, k + 1, c[5]);
    cellCorner(x + 1, y + 1, k + 1, c[6]);
    cellCorner(x, y + 1, k + 1, c[7]);
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const arr = this.highlight.geometry.attributes.position.array;
    // Nudge out from the cell's own centre so the outline never z-fights. The
    // old version scaled off the world origin, which was a radius.
    const mx = x + 0.5, my = k + 0.5, mz = y + 0.5;
    for (let e = 0; e < 24; e++) {
      const p = c[edges[e]];
      arr[e * 3] = mx + (p[0] - mx) * 1.012;
      arr[e * 3 + 1] = my + (p[1] - my) * 1.012;
      arr[e * 3 + 2] = mz + (p[2] - mz) * 1.012;
    }
    this.highlight.geometry.attributes.position.needsUpdate = true;
    this.highlight.visible = true;
  }

  _bindPlayerEvents() {
    this.player.onStep = (blockId) => {
      const b = BLOCKS[blockId] || BLOCKS[1];
      this.audio.step(b.sound);
      if (blockId) this.particles.footDust(this.player.position, this.player.up, blockId);
    };
    // `sev` is 0..1, `min(1, drop / 8)`, and it was being thrown away: every
    // landing played one unmodified footstep, so dropping eight cells onto
    // stone measured -65.9 A-weighted, the same as ambling across it, while
    // landing in water measured -44.3. Twenty-two dB between two ways of
    // arriving at the ground, and the parameter that should have carried the
    // difference already existed at both ends. 0.8 at the bottom so a hop down
    // a kerb is fractionally under a stride, 2.0 at the top, which measures
    // -60.6 — a 7.1dB span where there was none, and still 4.1dB under the
    // sound of breaking the same stone.
    this.player.onLand = (sev = 0) => {
      const b = BLOCKS[this.player.groundBlock()] || BLOCKS[1];
      this.audio.step(b.sound, undefined, 0.8 + 1.2 * Math.min(1, sev));
    };
    this.player.onHurt = (dmg) => {
      this.damageFlash = Math.min(1, 0.35 + dmg * 0.1);
      this.audio.hurt();
      if (this.player.health <= 0) this._die('Fell');
    };
  }

  _bindWindow() {
    window.addEventListener('resize', () => this._resize());
    // Turning the phone changes which way round the box is without necessarily
    // changing the window, so `resize` alone can leave the buffer transposed.
    ROTATED.addEventListener('change', () => this._resize());
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('beforeunload', () => {
      // The marks ride in that payload now, so this is the only thing that
      // writes them and there is nothing separate left to flush.
      if (this.state === 'playing' || this.state === 'paused') this.saveGame(false);
    });
    // Click the world to get the mouse back. This is the *only* way a pointer
    // lock the browser refused can ever be recovered, which is why it has to
    // name a spectator alongside a player rather than testing for 'playing'.
    //
    // "After dying I can spectate, but when exiting then opening the world
    // again I can spectate except I can't free look, mouse is not working."
    // Both halves of that are this line. `_onWorldReady` asks for the lock from
    // the tail of an async load — the click on Continue is long spent by the
    // time the planet is up — so Chrome refuses it with "A user gesture is
    // required to request Pointer Lock" and the world starts unlocked. A
    // *player* never notices, because the next thing anyone does in a world is
    // click it, and this handler hands the lock straight back. A spectator
    // clicked into the same dead handler: state is 'spectating', the test above
    // was false, nothing was requested, `Input._onMouseMove` kept returning at
    // its first line, and the look was gone for the rest of the session with no
    // other door out of it. The live spectator worked only because it is
    // reached from the death screen's own button, where the gesture is real and
    // the lock `_spectate` asks for is granted.
    //
    // Looking around is the one input a spectator has (see `_update`), so this
    // is not a convenience for them the way it is for a player: it is the whole
    // of the mode.
    this.canvas.addEventListener('click', () => {
      if ((this.state === 'playing' || this.spectating)
        && !this.input.locked && !this.ui.screenOpen) this.input.requestLock();
    });

    // Autoplay policy. The context is created in `_onWorldReady`, which is not
    // a gesture handler: on desktop Chrome the click that started the world has
    // already given the document sticky activation by then, so it comes up
    // running — but that is the browser's rule rather than ours, and iOS has
    // historically not promised it. This could not be measured here (a headless
    // driver reports `userActivation.hasBeenActive` true before any input, so
    // the test cannot tell a granted context from a lucky one), which is
    // exactly why it is worth being defensive about. `resume()` returns
    // immediately unless the context is actually suspended, so this is a
    // property read per event.
    const wake = () => this.audio.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('touchstart', wake, { passive: true });

    // Nothing ever suspended the context, so a backgrounded tab went on playing
    // wind, thunder and the generative pad at a player who had alt-tabbed away
    // — over a game that is frozen, because rAF has stopped. It also leaves the
    // graph running in a tab the browser is trying to throttle, which on a
    // phone is battery.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.ctx?.suspend?.();
        // Which carries the marks with it, now that they are part of the world.
        this._saveOnHide();
      }
      else this.audio.resume();
    });
  }

  /**
   * Write the world when the tab goes away.
   *
   * Three comments in this file already describe a "tab-hide write" as one of
   * the paths through `saveGame`, and there was not one — the only thing that
   * fired on the way out was the `beforeunload` handler, and that one is
   * measured *not to land*: a save is about 6.6 seconds of IndexedDB work on a
   * 10 MB payload, and killing the page 120 ms into one leaves the previous
   * save intact and the new one gone. Which is the right failure, but it means
   * closing the tab costs up to the full ninety seconds since the last
   * autosave.
   *
   * `visibilitychange` is the event that still has a live page behind it, so it
   * is the one that can actually finish. Rate-limited because alt-tabbing twice
   * in a row should not queue two multi-second writes, and because the
   * autosave is on its own ninety-second clock and this only has to cover the
   * gap between them.
   */
  _saveOnHide() {
    if (this.state !== 'playing' && this.state !== 'paused' && this.state !== 'spectating') return;
    const now = performance.now();
    if (this._lastHideSave && now - this._lastHideSave < 15000) return;
    this._lastHideSave = now;
    this.saveGame(false);
  }

  /**
   * Device pixels per CSS pixel, all three factors in one place.
   *
   * The tier's scale multiplies the player's rather than replacing it, so they
   * stay independent: the slider is "how sharp do I want this", the tier is "how
   * much machine is there". On `high` the tier factor is exactly 1, which is why
   * a desktop's drawing buffer is the same size it was before tiers existed.
   */
  _pixelRatio() {
    return Math.min(window.devicePixelRatio, 2) * this.settings.renderScale * this.quality.renderScale;
  }

  _resize() {
    const vs = viewSize();
    this.width = vs.w; this.height = vs.h;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setPixelRatio(this._pixelRatio());
    this.postfx.setSize(this.width, this.height);
    this.viewModel.setSize(this.width, this.height);
    const pr = this.renderer.getPixelRatio();
    this.sky.setPixelRatio(pr);
    this.particles.setPixelRatio(pr);
  }

  setRenderScale() { this._resize(); }

  /**
   * Move to another quality tier, live. The seam a settings row would drive.
   *
   * @param {'auto'|'high'|'low'} [choice] what to store in settings; omitted,
   *   this just re-applies whatever is stored (which is what boot needs after a
   *   load, and what a `?touch=` override needs).
   *
   * Everything here is a value, not a program: the AO pass is a flag on a pass
   * that stays built and stays sized, the render scale is a pixel ratio, and the
   * horizon is two numbers the streamer reads fresh every quarter second. So
   * this costs one composer resize and one streaming pass, and nothing in the
   * scene recompiles. That is a deliberate constraint on what a tier is allowed
   * to contain — the fog is attached at density 0 for exactly the same reason
   * (see `_initRenderer`): anything that flips a shader define recompiles every
   * material in the scene, and a settings row that freezes the game for a second
   * is a settings row nobody touches twice.
   *
   * The streaming pass is forced rather than waited for because the two
   * directions are not symmetric: dropping to `low` evicts the far ring on the
   * next tick anyway, but coming back up to `high` would otherwise leave the
   * player inside a 96-unit bubble until the timer came round.
   */
  setQuality(choice) {
    if (choice) { this.settings.quality = choice; this.persistSettings(); }
    this.qualityTier = qualityTier(this.settings);
    this.quality = QUALITY[this.qualityTier];
    this.postfx?.setAO(this.quality.ao);
    this.particles?.setQuality(this.qualityTier === 'low');
    voxelUniforms.uSeaDetail.value = this.quality.sea;
    if (this.mobs) this.mobs.loadDist = this.quality.loadDist;
    this._resize();
    if (this.state === 'playing' || this.state === 'paused' || this.state === 'spectating') {
      this._streamTimer = 0;
      this._streamChunks();
    }
  }

  persistSettings() { Save.writeSettings(this.settings); }

  async _loadAssets() {
    this.ui.progress(0.02, 'Loading materials');
    // Single source of truth: the pre-baked atlases. If they're missing the
    // right answer is a loud failure, not silently falling back to a different
    // set of textures.
    const tex = await loadTileAtlas((p, label) => this.ui.progress(0.02 + p * 0.9, label));

    const arrays = buildTileTextures(tex.tiles, this.renderer);
    voxelUniforms.uMap.value = arrays.map;
    voxelUniforms.uNormalMap.value = arrays.normalMap;
    voxelUniforms.uArm.value = arrays.arm;
    voxelUniforms.uCrack.value = buildCrackTexture(tex.crack);

    const icons = new IconFactory(tex.tiles.albedo, tex.tiles.size, tex.tiles.layers, tex.tiles.arm);
    this.ui.setIcons(icons);
    this.drops.setIcons(icons);

    // Creature models, up front. `spawn` runs from the frame loop and from world
    // load, so it has to stay synchronous — an animal that appears two frames
    // after the terrain it stands on is worse than a slightly longer load.
    this.ui.progress(0.95, 'Waking the wildlife');
    // The player's own body goes through the same cache as the mobs' — one
    // prototype per file, so a player wearing a face a husk also wears costs
    // nothing extra. Only the chosen character is fetched, not all fifteen.
    //
    // Which one that is comes from the menu summary rather than from the save
    // itself: the summary is a synchronous localStorage read and the save is
    // four megabytes out of IndexedDB, and this has to be decided before either
    // Continue or New Game is pressed. Getting it right means Continue never
    // fetches a body, and getting it wrong costs one 113KB file — so the cheap
    // read is the right one.
    this.character.setCharacter(Save.meta()?.character || DEFAULT_CHARACTER);
    await MobModels.prepare([...MOB_MODEL_URLS, ...playerModelUrls(this.character.id)]);

    this.ui.progress(1, 'Ready');
    this.ui.loaded();
    this.state = 'menu';
    this.ui.showMenu();

    // Then ask IndexedDB whether the menu is telling the truth. Not awaited and
    // deliberately after the menu is up: it opens the database and may read a
    // world, which is not something the first screen should wait on, and the
    // only thing it can do is add rows that were missing. See
    // `Save.repairIndex` for the failure this exists for.
    Save.repairIndex().then((n) => {
      if (n > 0) {
        this.ui.showMenu();
        this.ui.toast(n === 1 ? 'Recovered 1 planet the menu had lost'
          : `Recovered ${n} planets the menu had lost`, 0, 5200);
      }
    }).catch((err) => console.error(err));
  }

  // --- world lifecycle ------------------------------------------------------

  _startWorker() {
    if (this.worldWorker) this.worldWorker.terminate();
    this.worldWorker = new Worker(new URL('./workers/world.worker.js', import.meta.url), { type: 'module' });
    this.worldWorker.onmessage = (e) => {
      try {
        this._onWorldMessage(e.data);
      } catch (err) {
        this._loadFailed(err);
      }
    };
    // The worker's own uncaught exceptions come here rather than nowhere. The
    // mesher throwing on a block id it does not know was silent from the main
    // thread's side: no message ever arrived and the bar simply stopped.
    this.worldWorker.onerror = (e) => { e.preventDefault?.(); this._loadFailed(e.message || e); };
  }

  /**
   * The planet could not be built. Say so, and go back to the menu.
   *
   * This is the backstop for the failure the corruption pass found and the
   * validation in `_saveRefusal` now catches by name: an exception thrown out
   * of a worker message while the loading screen is up left the bar frozen for
   * ever with nothing said, because nothing above this line was listening.
   * Validation is the fix for the two cases we know about; this is the fix for
   * every case we do not.
   *
   * Nothing is written on the way out — the save on disk is exactly what it
   * was, which is the point.
   */
  _loadFailed(err) {
    if (this.state === 'playing' || this.state === 'spectating') { console.error(err); return; }
    if (this._loadAborted) return;
    console.error(err);
    if (this.worldWorker) { this.worldWorker.terminate(); this.worldWorker = null; }
    this._pendingSave = null;
    this._resetWorld();
    // After the reset, which clears it: the flag has to survive until the next
    // load starts, and the next load starts by resetting again.
    this._loadAborted = true;
    this.saveSlot = -1;
    document.getElementById('loader')?.remove();
    this.state = 'menu';
    this.ui.showMenu();
    this.ui.toast('That planet could not be opened. Nothing has been changed', 0, 5200);
  }

  /** What a mob's blow is multiplied by before it reaches the player. */
  get mobDamageMul() { return mobDamageScale(this.difficulty); }

  /**
   * Set the world's difficulty, and everything that follows from it.
   *
   * The single door, for the reason `_setDeathRule` is one: the answer is
   * stored in two places that must never disagree. `this.difficulty` is what
   * the save carries and what `mobDamageMul` reads; `mobs.savage` is what the
   * animals read, and a world loaded from disk that set the first without the
   * second would be an extreme planet whose carnivores had forgotten about it.
   * Four assignment sites became one call.
   */
  _setDifficulty(name) {
    this.difficulty = normalizeDifficulty(name);
    this.mobs.savage = huntsOnSight(this.difficulty);
    // The third thing that follows from it, and it goes through the same door
    // for the same reason. Only the bosses read it; see `bossDifficulty`.
    this.mobs.damageScale = this.mobDamageMul;
  }

  /**
   * Is this a world you do not wake up from?
   *
   * Read at the one moment it matters — the death — rather than stored, so it
   * is always the difficulty this planet actually has.
   */
  get runEnds() { return endsOnDeath(this.difficulty); }

  /**
   * Watching a world you can no longer touch.
   *
   * A state rather than a flag, and that is the whole design of it. "Cannot
   * interact" written as a list of disabled features is a list with a hole in
   * it — someone adds a key next month and the spectator can press it — so it
   * is written the other way round: `_update` already has one gate that says
   * "your hands are elsewhere" for an open inventory (`busy`, which swaps the
   * real input for `Game.NO_INPUT`), and a spectator is permanently in it. The
   * things that reach *into* the player rather than out of them are three, and
   * each is answered at its own single door: damage at `_takeHit`, the mobs at
   * `Mobs.ghost`, and the ground at `_drift`, which is the only movement code
   * a spectator runs and which does nothing but change where the camera is.
   */
  get spectating() { return this.state === 'spectating'; }

  /** Whether this world lets you keep the bag and the ladder through a death. */
  get keepsOnDeath() { return keepsOnDeath(this.deathRule); }

  /**
   * Set the world's death rule, and the skill tree's with it.
   *
   * The single door, because the rule is stored in two places that must never
   * disagree: `this.deathRule` is what the save carries and what `_die` reads
   * for the bag, and `skills.onDeath` is what the tree reads for the ladder. The
   * mapping is `skillDeathMode`, so a losing world still runs under whatever
   * `ON_DEATH` says a losing world is.
   */
  _setDeathRule(rule) {
    this.deathRule = normalizeDeathRule(rule);
    /**
     * ...and the tree is not part of the deal any more.
     *
     * The world's death rule used to decide the ladder as well as the bag, so a
     * losing world took your levels. The owner: "make skills learned permanent
     * like even if you die it stays."
     *
     * `deathRule` still governs the BAG, which is the part a death is supposed
     * to cost - you lose what you were carrying and you can go back for it. What
     * it no longer governs is what you have learned, and the distinction is
     * worth stating: an inventory is a thing that was in your hands, and a skill
     * is a thing that happened to you. `skillDeathMode` and `ON_DEATH` stay in
     * `Skills.js`, unread, because they are the whole harshness mechanic and a
     * future world type may want it back.
     */
    this.skills.onDeath = 'keep';
  }

  _resetWorld() {
    // Both are world state, and both are set again by whichever path is opening
    // a world — `newGame` from the choices, `_placeEntities` from the save. The
    // reset is what stops a planet you quit from lending its difficulty to the
    // next one, on the paths that set neither (`abandonNewGame`).
    this._setDifficulty(DEFAULT_DIFFICULTY);
    /*
     * A new planet starts in the morning, and it had to be said out loud here.
     *
     * `dayT` was written in exactly two places: the constructor, once per page
     * load, and `continueGame`, from the save. Nothing reset it between worlds -
     * so the clock a new planet opened on was whatever time the LAST one
     * happened to be at. Play world A until dusk, quit to the menu, start a
     * brand new world B, and B begins in the dark, with no bed, no torchlight
     * placed, and the monsters that come with a night.
     *
     * It is the same shape as the `editedRegions` leak above: state that
     * belongs to one planet, left lying where the next one picks it up. The
     * difference is that this one is visible in the first second of play, which
     * is presumably why it was reported as "sometimes you spawn at night"
     * rather than as a bug about the menu.
     *
     * 8/24 is the constructor's own value and the intended one: an hour after
     * dawn, with a full day in front of you to find shelter before the first
     * night. Kept as the single literal it already was rather than a named
     * constant, because the constructor is the only other reader.
     */
    this.dayT = 8 / 24;
    // A new world is not somebody else's ending. All three of these belong to
    // the planet being torn down, and a spectator flag left set would open the
    // next one with no hotbar and nothing able to see the player.
    this._deadOnLoad = false;
    // Nor does the next planet inherit the hush the last one was killed under.
    // `_die` turns the ambient bed down and only `respawn` and `_spectate` turn
    // it back up, and quitting to the menu off the death screen goes past both.
    this.audio.setWorldQuiet(false);
    // A failed load is over once the world it failed on is gone; the next
    // attempt has to be able to report its own failure. See `_loadFailed`,
    // which sets this after calling here for exactly that reason.
    this._loadAborted = false;
    this._pausedFrom = 'playing';
    this.mobs.ghost = false;
    this.ui.setSpectator(false);
    // The sight comes back with the hands. `setSpectator` can only take it
    // away, because it is the view mode that decides whether there is one.
    this._syncCrosshair();
    this.loadout = [];
    this._setDeathRule(DEFAULT_ON_DEATH);
    this.planet.clearMeshes();
    // The mirror is reused rather than reallocated — it is 85MB, and two of
    // them alive at once while the old one is collected is a stall you can see.
    this.planet.resetWorld();
    // The moving lights' shadow volume is a snapshot of blocks that no longer
    // exist. Dropping it forces a refill rather than trusting the recentring
    // test, which would happily keep a whole planet's worth of stale rock if
    // you respawned near the cell you left.
    this._occ = null;
    this.liveChunks.clear();
    this.crossLight.clear();
    /*
     * Which regions the player has BUILT in, and it is a fact about one planet.
     *
     * It was not on this list and it had to be, because `_saveBlocks` stores
     * exactly the regions that are both live and in this set — so a set carried
     * over from the last world puts regions the player has never touched into
     * the new world's save, at 24.75 KB each, for ever: `continueGame` seeds the
     * set back from `data.regions` on load, which is right and necessary, and
     * which also means anything that gets in here once never leaves.
     *
     * Measured, both worlds on seed 4242 so their live regions share ids: build
     * in 100 regions of world A, quit to the menu, start a brand new world B and
     * let it write once — B stored 100 regions and 2 475 KB of pure generator
     * output, on a planet nobody had put a single block on. A world that should
     * have been 25 KB was 2.4 MB, and re-opening it would have kept it that way.
     *
     * Nothing needs the old value: every way into a world sets this again
     * afterwards — `continueGame` from the save, and a new planet from an empty
     * set, which is what this now is.
     */
    this.editedRegions.clear();
    // A new world has not failed to save yet. Carrying the count over would
    // leave the chip up on a planet that has never been written, which is both
    // wrong and the fastest way to teach a player to ignore it.
    this.saveFailures = 0;
    this._quitAnyway = false;
    this.ui.setSaveWarning(false);
    this.ui.setQuitConfirm(false);
    this._streamPending = false;
    this._streamTimer = 0;
    this.drops.clear();
    // Arrows are entities in the old world's air. They are not saved and they
    // must not survive the planet under them being replaced — a stuck arrow
    // carries a world position, and the same position in a new world is inside
    // whatever generated there.
    this.arrows.clear();
    this.bow.t = 0;
    // A funnel holds a column index and a world position, both of which mean
    // something else entirely on the next planet. Same reason as the arrows
    // above, and it is never restored on load either — see the save note at the
    // head of Tornado.js.
    this.tornado = null;
    this.particles.tornadoOff();
    // ...and the sky that was making it. `Weather` was built once in the
    // constructor and never touched again, so quitting a storm and starting a
    // new planet opened it under the old one's rain: measured on a fresh seed,
    // `state` storm, `precip` 1, `sun` 0.15, `fog` 1.9, all inherited. Its
    // `tornadoCooldown` came across too, which is worse than cosmetic — it is
    // the field written to guarantee that "a brand new world cannot be met by
    // one in its first storm", and a world entered on a spent cooldown has no
    // such guarantee.
    //
    // Assigned from a fresh instance rather than field by field so the
    // constructor stays the one place a fair sky is described. `onThunder` is a
    // wire from this file and outlives the weather it was hung on.
    Object.assign(this.weather, new Weather(), { onThunder: this.weather.onThunder });
    this.mobs.clear();
    // The flow sim keys everything by cell index, so its sources and levels are
    // meaningless against a different planet — carried over, they marked cells
    // of the new world as springs at random.
    this.water.clear();
    // Cell indices again, and the same reason: a queued grain of the old world
    // is a cell of the new one, and settling it would drop a block out of
    // terrain nobody has touched.
    this.falling.clear();
    this.fallTimer = 0;
    this.farming.clear();
    this.kilns.clear();
    this.crates.clear();
    this.homeSpawn = null;
    this.deathSite = null;
    this.signs.clear();
    this.signSeq++;
    this.frozen.clear();
    this.seasonSnow.clear();
    this.hearths.clear();
    this.coreFound = false;
    // A new planet has its own sixteen, none of them placed and neither face
    // shut. `reset` also re-hands `Mobs` the shutdown set, which the spawner
    // holds a reference to.
    this.endgame.reset();
    // Cleared with the rest of the world state so a new world cannot inherit
    // the last one's sky and greet the player with a squall, or its clock and
    // announce a dawn, on the first frame. Both edges are armed by the first
    // frame that runs, which is what `undefined` means to their readers.
    this._lastSky = undefined;
    this._lastDayT = undefined;
    this.mobs.wards = null;
    this.seasons.fromJSON(0);
    this._pushSeason();
    this.inventory = new Inventory();
    this.inventory.onChange = () => this.ui.refresh();
    this.stats = { mined: 0, placed: 0, crafted: 0 };
    // Verdant's memory, and it is a fresh one per planet. `used` is a count of
    // swaps taken this visit and nothing else - the offers themselves are
    // derived from (seed, traderId), so this is the whole of what a save has to
    // carry. See the head of `Barter.js`.
    this.barter = newBarterState();
    // Which face the player was on last frame, for the one edge that matters:
    // leaving Verdant. -1 rather than undefined so the first frame of a world
    // is a face nobody can have left.
    this._lastFace = -1;
    this.playtime = 0;
    // The marks belong to the planet, so a new one has none of them. `clear`
    // also drops the baseline the counter deltas are measured from, without
    // which the first scan on a fresh world would read `mined` falling from
    // thousands to zero, or a load would read it jumping to thousands, and
    // neither is a thing the player just did. `continueGame` fills the record
    // back in from the save afterwards.
    this.achievements.clear();
    // A new person, not just a new planet. `fromJSON(null)` is the module's own
    // "nothing spent, nothing marked, nothing converted" — the same state a
    // fresh `Skills` is in — and going through it rather than through `reset()`
    // is deliberate: `reset` only unlearns the levels and would carry the marks
    // and the armour conversion of the previous world into this one.
    this.skills.fromJSON(null);
    this.skills.observe(this.stats, this.playtime);
    this._skillTimer = 1;
    // Before the health line below, which is what fills the bar this sets.
    this._applySkills();
    this.player.health = this.player.maxHealth;
    this.breath = 1;
    this.energy = 1;
    this.soakT = 0;
    // The rest of the family `soakT` belongs to. It was the only one of the
    // eight cleared here, and the other seven are all clocks that count damage
    // out over the following seconds — so they crossed planets. Eat a deathcap,
    // quit to the menu, start a new world, and you arrived on a planet that has
    // never had a mushroom on it losing a point every three seconds to one; the
    // burn does the same after a lava death, and the chill after a drift.
    // `respawn` has cleared exactly this list since the same bug was found on
    // the bed, and quitting is the other way a body starts somewhere new.
    this.player.burning = 0;
    this._scaldT = 0;
    this._starve = 0;
    this.chillT = 0;
    this._chillT = 0;
    this._chillSaid = false;
    this.poisonT = 0;
    this._poisonT = 0;
    this.sporeT = 0;
    this._sporeSaid = false;
    this.graceT = 0;
    // Cleared here as well as when it runs out: quitting to the menu mid-grace
    // and loading a save would otherwise leave the flag set on the mob system
    // and switch the night off permanently.
    this.mobs.spawnGrace = false;
    this.worldReady = false;
  }

  /**
   * The few minutes a new planet gives you before the dark takes an interest.
   *
   * Only on a new world, and only ever once — loading a save drops you back
   * into a world you already know, at whatever hour you left it, and handing
   * that player a quiet night would be taking the game away from them.
   */
  _beginGrace() {
    this.graceT = NEW_WORLD_GRACE;
    this.mobs.spawnGrace = true;
    for (const m of [...this.mobs.list]) if (m.spec.hostile) this.mobs._die(m, []);
    /*
     * Five torches, but only if the planet you have just made is already dark.
     *
     * The day clock is synced to the real one by default (`dayMinutes: 0`, so
     * `timeOfDay` returns `Sky.clockFraction`, which is the OS clock), which
     * means the hour a new world opens on is the hour it is where the player is
     * sitting. Start a game after dinner and you arrive at night - on a planet
     * with no bed, nothing built, nothing lit, and, since the starting loadout
     * was removed below, nothing in your hands either.
     *
     * That is a different game from the one the daytime player gets, and not in
     * a way anybody chose: the argument for taking the loadout away is that the
     * first ten minutes are the game and a torch given at spawn answers the
     * first night before it is asked. It is a good argument, and it assumes you
     * can see. The grace timer right above already concedes the same point in
     * the other currency - it holds the monsters off for three minutes - so
     * this is that concession finished, for the half of the day it was missing.
     *
     * Every difficulty, deliberately and at the owner's instruction. Extreme is
     * meant to be harsh about what it costs you to die, not about what time you
     * happened to press New Game.
     *
     * `nightness` rather than a bare hour comparison: it is the same curve the
     * ambience uses to decide when to swap birds for owls, and one answer to
     * "is it dark" is worth more than a number of my own here. Above zero means
     * the sun is down.
     */
    if (nightness(this.timeOfDay()) > 0) {
      const torch = itemIdOf('torch');
      if (torch) {
        this.inventory.add(torch, NIGHT_START_TORCHES);
        this.ui.toast('Night start. Five torches.', torch, 5000);
      }
    }
    // What the player chose to bring, or the six torches if they chose nothing.
    // The stacks come from the UI's own option table, so the button and the bag
    // cannot disagree; an item name that no longer exists is skipped rather than
    // added as air.
    // You start with nothing.
    //
    // The loadout used to put a few stacks in the bag - six torches by default,
    // or whatever the picker chose. It is gone because the first ten minutes
    // are the game: the first tree, the first stone, the first night, and a
    // torch handed over at spawn is the answer to the last of those given away
    // before the question is asked.
    //
    // `loadoutStacks` and the options table stay where they are. They are still
    // the description of what a start COULD hand you, and nothing about them is
    // wrong - they are simply not called any more.
  }

  /**
   * Start a planet, and ask who is going to live on it.
   *
   * The order here is the point. Generation is kicked off *first* and the
   * picker goes up over the loading screen while it runs, so the thirty seconds
   * a player might spend looking at fifteen faces are thirty seconds of the
   * five that worldgen was going to take anyway. Asking first and generating
   * after would have made New Game strictly slower, which is the one thing this
   * screen was not allowed to do.
   *
   * The cost of that is `_onWorldReady` having to wait — see the guard there.
   *
   * @param {number} slot zero-based, already chosen (and confirmed, if it was
   *   holding a planet) on the slot screen. Nothing is written here: the slot
   *   is only claimed, and the world that was in it survives until the first
   *   autosave lands on it.
   * @param {{character?: string, loadout?: string[], difficulty?: string,
   *   deathRule?: string}} [opts] the answers from the New Game screen. Every one of them is optional and
   *   every one of them has a default that is exactly today's behaviour, because
   *   this is called from more than one place. A `character` here means the
   *   screen already asked who you are, so the carousel is skipped; without one
   *   the picker goes up as it always has and `beginWorld` brings the answer
   *   back.
   */
  newGame(slot, opts = {}) {
    this.saveSlot = slot | 0;
    this._setDifficulty(opts.difficulty);
    this.loadout = normalizeLoadout(opts.loadout);
    this._setDeathRule(opts.deathRule);
    this.ui.hideMenu();
    document.body.appendChild(this._makeLoaderShell());
    this.ui.progress(0, 'Igniting the core');
    this._resetWorld();
    // A world you can ask for by name. `opts.seed` is honoured when it is a
    // number and a fresh draw otherwise, so nothing about starting a game from
    // the menu changes.
    //
    // It was unconditionally random, which meant no two runs of anything ever
    // met the same planet. That is fine for a player and ruinous for measuring:
    // a before/after on movement, lighting or crowding cannot be read when the
    // terrain underneath it was redrawn between the two runs, and it silently
    // cost three separate investigations a verdict.
    this.seed = Number.isFinite(opts.seed)
      ? (opts.seed | 0)
      : (Math.random() * 0x7fffffff) | 0;
    // Two planets must not have their whirlpools in the same places. The sites
    // are a pure function of (seed, column), so this is the whole of what makes
    // them a property of this world rather than of the lattice.
    this.whirlpools.reset(this.seed);
    this._pendingSave = null;
    this._startWorker();
    this.worldWorker.postMessage({ type: 'init', seed: this.seed });
    this._choosing = true;
    this._readyHeld = false;
    // Always the picker. This used to skip straight to `beginWorld` when the
    // options carried a character, on the reasoning that a screen collecting
    // all three answers at once would want that door. The screen that got built
    // keeps the carousel and passes its current selection at slot-claim time,
    // so the door was always open and New Game stopped showing the picker at
    // all. Picking who you are is the point of starting a world; the shortcut
    // was speculative and the bug was real.
    this.ui.openCharacterPicker(this.character.id);
  }

  /**
   * Take the choice and go — or, if the planet is not finished, go back to
   * watching the bar, which is where a player who picked instantly would have
   * been the whole time.
   */
  /**
   * @param {{loadout?: string[], difficulty?: string, deathRule?: string}} [opts] the other
   *   answers, for a screen that collects them alongside the face rather than
   *   before it. Only what is passed is taken, so a caller that answered in
   *   `newGame` and a caller that answers here both work and neither wipes the
   *   other.
   */
  beginWorld(id, opts = {}) {
    if (!this._choosing) return;
    this._choosing = false;
    if (opts.difficulty !== undefined) this._setDifficulty(opts.difficulty);
    if (opts.loadout !== undefined) this.loadout = normalizeLoadout(opts.loadout);
    if (opts.deathRule !== undefined) this._setDeathRule(opts.deathRule);
    this.ui.closeCharacterPicker();
    this.character.setCharacter(id || DEFAULT_CHARACTER);
    // Not awaited. A character that is not the one preloaded at boot is a
    // single 113KB file, and `PlayerCharacter` draws nothing until its model
    // lands — so the worst case is a body that appears a moment into a world
    // whose default view is first person anyway. Awaiting it here would put
    // that fetch on the critical path for no visible gain.
    MobModels.prepare(playerModelUrls(this.character.id));
    if (this._readyHeld) { this._readyHeld = false; this._onWorldReady(); }
  }

  /**
   * Back out of a new planet that has already started generating.
   *
   * Nothing is written on this path, so the save on disk is untouched — which
   * matters, because `_placeEntities` may already have run and armed the
   * first-autosave flag by the time the player changes their mind.
   */
  abandonNewGame() {
    if (!this._choosing) return;
    this._choosing = false;
    this._readyHeld = false;
    this._saveOnReady = false;
    this.ui.closeCharacterPicker();
    if (this.worldWorker) { this.worldWorker.terminate(); this.worldWorker = null; }
    this._resetWorld();
    this.saveSlot = -1;
    document.getElementById('loader')?.remove();
    this.state = 'menu';
    this.ui.showMenu();
  }

  /** @param {number} slot zero-based, picked off the slot screen */
  async continueGame(slot) {
    // The read half of the same problem `saveGame` has. An exception here used
    // to escape the click handler as an unhandled rejection, so pressing
    // Continue on an unreadable store did *nothing at all* — no load, no menu
    // change, no message. A button that visibly does nothing is worse than one
    // that reports a failure, because the player's next move is to press it
    // again.
    //
    // Both branches keep the menu entry rather than quietly dropping it. These
    // errors are usually transient — another tab holding the database, private
    // mode, a profile still warming up — and deleting the one visible sign that
    // a planet exists is exactly the wrong response to "I could not read it
    // this time".
    let data = null;
    try {
      data = await Save.read(slot);
    } catch (err) {
      console.error(err);
      this.ui.showMenu();
      this.ui.toast('Could not read your planet. Nothing is lost, try again', 0, 5200);
      return;
    }
    if (!data) {
      // Meta lives in localStorage and the planet lives in IndexedDB, so the
      // two can disagree: a browser that cleared site data of one kind and not
      // the other leaves a menu entry pointing at nothing. Say so, rather than
      // letting a planet appear to vanish between launches.
      const had = !!Save.slot(slot);
      this.ui.showMenu();
      if (had) this.ui.toast('That planet is not in this browser any more', 0, 5200);
      return;
    }
    const refusal = this._saveRefusal(data);
    if (refusal) {
      this.ui.showMenu();
      this.ui.toast(refusal, 0, 5200);
      return;
    }
    this.saveSlot = slot | 0;
    this.ui.hideMenu();
    document.body.appendChild(this._makeLoaderShell());
    this.ui.progress(0, 'Recalling your planet');
    this._resetWorld();
    this.seed = data.seed;
    this.whirlpools.reset(this.seed);
    this._pendingSave = data;
    // Who you were on this planet, set here rather than with the rest of
    // `save.player` in `_placeEntities` — that runs when the first terrain
    // lands, and the point of doing it now is that any fetch it needs overlaps
    // the world load instead of following it. Saves written before the picker
    // existed have no character at all and get the default, which is the body
    // they have been walking around in all along.
    this.character.setCharacter(data.player?.character || DEFAULT_CHARACTER);
    MobModels.prepare(playerModelUrls(this.character.id));
    this._startWorker();

    // Put the saved regions straight into the mirror rather than waiting for
    // the worker to echo them back. The message below is a structured clone —
    // nothing is transferred — so both sides end up with their own copy for the
    // price of the one the browser was going to make anyway.
    // Strictly before any region is seeded, and that ordering is the whole
    // point. `_seedWaterRegion` calls every liquid cell without a level entry a
    // spring, so with the flow map still empty it promoted the lot — a
    // waterfall, a puddle creeping out of a breached lake, every cell of it
    // came back as a full-strength source that can never drain. Saving turned
    // running water into permanent water, and because a source spreads seven
    // cells the moment anything nearby is edited, each save-and-return pushed
    // the flood further out. Restoring the levels first is what lets the seed
    // pass tell worldgen's ocean apart from yesterday's spill.
    //
    // `Water.fromJSON` was written for this and had simply never been called;
    // it already handles a save with no `water` key at all, which is every save
    // written before now — those still take the old behaviour, because there is
    // nothing recorded to tell their standing water from their flowing water.
    this.water.fromJSON(data.water);

    if (data.regions && data.blocks) {
      this.planet.applyRegions(data.regions, data.blocks, (rid) => this._seedWaterRegion(rid));
      // Regions a past session changed are still changed. `_saveBlocks` only
      // stores edited regions, so the set it filters on has to survive a
      // reload - otherwise opening a world and saving it again would drop
      // everything built before this session and hand the player back the
      // generator's version of their own base.
      for (const rid of data.regions) this.editedRegions.add(rid);
    } else if (data.blocks) {
      // A save from before the world went lazy: one flat array, all of it live.
      this.planet.blocks.set(data.blocks);
      this.planet.live.fill(1);
      this.water.seedSources(this.planet);
    }
    for (const [idx, v] of data.facing || []) this.planet.facing.set(idx, v);

    // `facing` is absent in saves written before directional blocks existed;
    // the worker defaults every directional block it finds without an entry.
    this.worldWorker.postMessage({
      type: 'load',
      seed: data.seed,
      regions: data.regions || null,
      data: data.regions ? data.blocks : null,
      blocks: data.regions ? null : data.blocks,
      colBiome: data.colBiome,
      facing: data.facing || null,
    });
  }

  /**
   * Can this save be opened by the world we are currently built for?
   *
   * Two checks, because they fail differently. The geometry stamp catches a
   * save written for a different planet shape and is exact. The array length is
   * the belt: saves written before the stamp existed carry no `geom` at all,
   * and for those the block count is the only evidence there is — it is also
   * the thing that actually breaks, since every index in the file is computed
   * from F and D.
   *
   * Refusing is the kind thing to do. A mismatched save does not throw; it
   * loads, indexes past the end of a short array, reads air, and hands back a
   * planet with holes in it that looks almost right — which is much harder to
   * understand than being told plainly that it cannot be opened.
   *
   * @returns {string|null} null if it fits, otherwise the sentence to show the
   *   player. Two sentences and not one, because "made by an older version" is
   *   a lie when the file is damaged, and a player told the wrong thing goes
   *   looking for the wrong fix.
   */
  _saveRefusal(data) {
    const OLD = 'That planet was made by a different version and cannot be opened';
    const BAD = 'That planet\'s file is damaged and cannot be opened';
    if (!data?.blocks) return BAD;
    if (data.regions) {
      // A partial save. Its block payload is one region per id and everything
      // else comes back out of the generator, so the generator has to be the
      // one that made it — see GEN_VERSION.
      if (data.regions.length * REGION_VOXELS !== data.blocks.length) return BAD;
      /*
       * And every id in that list has to name a region this planet has.
       *
       * The length check above passes for a save whose region *ids* are
       * nonsense, because the payload is still one region long per id. The next
       * thing that happens is `Planet.applyRegions`, which turns an id into an
       * offset into the block mirror and calls `set` — an id past the end
       * throws RangeError "offset is out of bounds", synchronously, inside
       * `continueGame` itself.
       *
       * That is the one load exception this file does not already catch.
       * `_loadFailed` covers everything thrown out of the worker's message
       * handler and says so plainly ("That planet could not be opened. Nothing
       * has been changed"); this one is thrown from the click handler, escapes
       * as an unhandled rejection, and the measured result is the loading bar
       * sitting there for ever with no message at all — the same symptom, and
       * the same complaint, as the missing `player` above.
       *
       * Read with `| 0` because the list is an Int32Array in every save this
       * build writes but is whatever the file says in one that has been damaged.
       */
      for (let n = 0; n < data.regions.length; n++) {
        const rid = data.regions[n] | 0;
        if (rid !== data.regions[n] || rid < 0 || rid >= NUM_REGIONS) return BAD;
      }
      if ((data.gen | 0) !== GEN_VERSION) return OLD;
    } else if (data.blocks.length !== COLUMNS * D) return BAD;
    if (data.colBiome && data.colBiome.length !== COLUMNS) return BAD;
    if (Array.isArray(data.geom)) {
      const [w, d] = data.geom;
      if (w !== W || d !== D) return OLD;
    }
    /*
     * Where the player stood, because the loader dereferences it before there
     * is anything to catch an exception with.
     *
     * `_seatPlayer` reads `save.player.cell[0]` while the loading screen is up
     * and the worker is mid-flight. A save with no `player` — a truncated
     * write, a hand-edited file — threw "Cannot read properties of undefined
     * (reading 'cell')" out of a message handler, and the observed result was
     * the loading bar sitting there for ever with no message at all. Measured:
     * the load never completed and nothing was said.
     */
    const cell = data.player?.cell;
    if (!Array.isArray(cell) || cell.length !== 3 || cell.some((n) => !Number.isFinite(n))) return BAD;
    /*
     * And a block id this build does not have.
     *
     * This is the downgrade case: a world written by a newer build, opened by
     * an older one. The mesher looks up `GROUP[id]` and indexes `groups` with
     * the `undefined` that comes back, so the very first chunk containing one
     * throws inside the worker — and again the player gets a loading bar that
     * never finishes and no explanation. The same thing happens to a save whose
     * bytes have been damaged, which is how this was found.
     *
     * A full scan of the block array, which is the only honest test: an id
     * three regions away is as fatal as one under the player's feet. Measured
     * over a 10 061 568-byte save: 87 ms cold, then 5.5-8.9 ms warm — once, on
     * a path that already spends thirty-nine seconds building the planet.
     *
     * Reported as the version message rather than the damage one, because a
     * block this build has never heard of is overwhelmingly a newer build's
     * world rather than a bit flip — the ids are append-only, so an unknown one
     * is by construction one that was added after this build shipped.
     */
    for (let i = 0; i < data.blocks.length; i++) {
      if (data.blocks[i] >= N_BLOCKS) return OLD;
    }
    return null;
  }

  _makeLoaderShell() {
    let el = document.getElementById('loader');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'loader';
    el.innerHTML = `<div class="loader-inner">
      <div class="planet-mark"><span></span><span></span><span></span></div>
      <h1>MOJA<em>ZER</em></h1>
      <p class="tagline">A tiny planet, entirely yours.</p>
      <div class="bar"><div class="bar-fill" id="load-fill"></div></div>
      <p class="status" id="load-status">Working</p></div>`;
    this.ui.el.loader = el;
    this.ui.el.loadFill = el.querySelector('#load-fill');
    this.ui.el.loadStatus = el.querySelector('#load-status');
    return el;
  }

  _onWorldMessage(msg) {
    switch (msg.type) {
      case 'progress': this.ui.progress(msg.p, msg.label); break;
      case 'world':
        /**
         * The per-column tables, and not a single voxel.
         *
         * The order of the next three steps is forced and it took a couple of
         * goes to get right. The chunks we ask for depend on where the player
         * is; where the player is used to depend on the voxels, because the
         * spawn search read the top block of a few thousand columns; and the
         * voxels now depend on which chunks we ask for. So the player is placed
         * from the height field — which the worker has already chosen a column
         * from — the neighbourhood is built around that, and only once it has
         * arrived is anything asked a question about actual blocks.
         */
        this.planet.setGlobals(msg.colBiome, msg.colHeight);
        for (const rid of msg.live || []) this.planet.live[rid] = 1;
        this._seatPlayer(msg.spawn);
        this._streamChunks(true);
        break;
      case 'regions':
        this.planet.applyRegions(msg.ids, msg.data, (rid) => this._seedWaterRegion(rid));
        break;
      case 'chunk': {
        // A chunk requested just before the player turned away can land after
        // we have already evicted it. Without this it would be re-added with no
        // entry in liveChunks, so nothing would ever free it again.
        const id = chunkIdx(msg.cx, msg.cy, msg.ck);
        if (this.liveChunks.has(id)) {
          this.planet.applyChunk(msg.cx, msg.cy, msg.ck, msg.groups);
          // Must be *replaced*, not merged, and must be deleted when the chunk
          // comes back empty: a remesh is the whole truth about that chunk, so
          // picking the last flower out of it has to leave nothing behind or
          // the next flower planted in the same cell inherits a dead sample.
          if (msg.crossLight) this.crossLight.set(id, msg.crossLight);
          else this.crossLight.delete(id);
        }
        break;
      }
      case 'streamDone': this._streamPending = false; break;
      case 'ready':
        this._streamPending = false;
        // Now, and not before: everything below this line reads real blocks —
        // the spawn refinement, the mob spawner's ground tests, the flow sim's
        // source scan — and the first batch of regions has only just landed.
        this._placeEntities();
        this._onWorldReady();
        break;
    }
  }

  /**
   * Keep meshed geometry to what can be seen. Chunks inside the tier's load
   * distance are requested, chunks past its keep distance are freed; the gap
   * between the two is hysteresis so standing on a boundary doesn't rebuild the
   * same chunk forever. On `high` those are CHUNK_LOAD_DIST / CHUNK_KEEP_DIST.
   *
   * **Buried chunks get their own, much shorter horizon**, and it is the single
   * largest thing this game does about memory. The surface distance is 150 units
   * because that is how far a player can see across a planet; below the ground
   * there is no horizon, there is rock, and rock is opaque. A chunk under the
   * ground of its own footprint (see `Planet.chunkBuried`) is therefore cut at
   * `quality.buriedDist` instead — 64 units on `high`, 41 on `low`.
   *
   * How far you can actually see underground, measured rather than assumed, on
   * seeds 4242, 91733 and 7. From 4 500 buried air cells, 24 rays each, 108 000
   * casts in all: median 1.4 units to the first solid, p99 8.8, and the single
   * longest sight line onto buried geometry anywhere in the three worlds was
   * **21.9 units**. Not one ray in 108 000 reached 32. From the other side —
   * 105 288 rays cast from 4 387 *surface* standing positions, the cave mouths
   * and ravine lips where you would expect to see down into the dark — only 17
   * rays landed on buried geometry at all, and the farthest was 11.8 units. So
   * 64 is about three times the worst case ever observed, and the reason it is
   * 64 rather than 32 is margin, not measurement.
   *
   * What it is worth, measured in one process on seed 4242 with the baseline
   * arm taken either side of the changed one, because a single before/after on
   * this game has been read as anything at all before now. Medians of the two
   * baselines against the changed arm, which came out bit-identical both times:
   *
   *              high                     low
   *   meshes     3 129 -> 2 639  -16%     1 299 -> 1 102  -15%
   *   geometry   377.5 -> 304.2 MB -19%   159.3 -> 130.0 MB -18%
   *   of which CPU copies that never drain
   *              243.7 -> 190.4 MB -22%    77.5 ->  59.9 MB -23%
   *   draw calls   992 ->   850   -14%       538 ->   468   -13%
   *   triangles  999 k -> 880 k   -12%     692 k -> 632 k    -9%
   *
   * Draw calls and triangles are exact integers off `renderer.info` and mean
   * what they say; the frame *times* from the same runs do not, because the
   * headless GPU is a software rasteriser. The geometry figures are byte counts
   * walked off the attributes rather than anything `performance.memory` said.
   *
   * Nothing on screen changes, and that is measured too, not asserted. With the
   * frame loop stopped so that not one tick of the swell or the day clock
   * separates the two arms, the same 32 views — every 45 degrees of yaw at four
   * pitches — were read back off the colour buffer with the leash off and then
   * on. Six runs across both tiers, two seeds and both a surface and a cave
   * viewpoint, evicting 184 to 541 meshes each time: **zero pixels differed**,
   * against a control that shot the same view twice and also differed by zero.
   *
   * The one case this does get wrong, stated plainly: `colHeight` is the
   * *worldgen* surface, so a player who hand-digs a dead-straight tunnel more
   * than 81 units long (the buried keep distance) and then walks back to look
   * down it will find the far end unbuilt. Nothing is lost — the blocks are
   * still in the mirror, the tunnel is still there, and walking back down it
   * builds it again — and eighty-one blocks of perfectly straight digging is not
   * a thing that happens by accident. It is a visual edge, not a correctness
   * one: `dropChunk` frees meshes and nothing else, so physics, raycasting and
   * every scan over blocks read the same world whatever the streamer decides.
   * @param {boolean} initial first batch — the loading screen waits on it
   */
  _streamChunks(initial = false) {
    if (!this.planet.blocks) return;
    // One batch of *new* geometry in flight at a time — queueing more only
    // starves the worker of the edit messages that need to be timely. Eviction
    // is never held back, so memory comes down the moment it can.
    const canAdd = initial || !this._streamPending;
    const eye = this.player.position;
    // Per tier, not per build: the low tier pulls the horizon in to 96 units.
    // Both numbers move together, so the hysteresis gap survives (see QUALITY),
    // and the *mirror* is untouched by either — `dropChunk` frees meshes and
    // nothing else, so physics, raycasting and every scan over blocks read the
    // same world on both tiers. The invariant in `_update` ("never move through
    // ground that has not been built") still holds by a wide margin: 96 units
    // against a player who cannot exceed about ten.
    const load = this.quality.loadDist * this.quality.loadDist;
    const keep = this.quality.keepDist * this.quality.keepDist;
    // The buried pair keeps the surface pair's hysteresis ratio rather than
    // inventing a second one, so a chunk on either boundary thrashes the same
    // amount — which is to say, not at all.
    const bLoad = this.quality.buriedDist * this.quality.buriedDist;
    const bKeep = bLoad * (keep / load);
    const add = [], drop = [];
    const live = this.liveChunks;
    const planet = this.planet;
    for (let id = 0; id < NUM_CHUNKS; id++) {
      const o = id * 3;
      const dx = wrapDelta(CHUNK_CENTER[o] - eye.x);
      const dy = CHUNK_CENTER[o + 1] - eye.y;
      const dz = wrapDelta(CHUNK_CENTER[o + 2] - eye.z);
      const d2 = dx * dx + dy * dy + dz * dz;
      const has = live.has(id);
      // The cheap test first: `chunkBuried` is two loads and a compare, but the
      // distance test rejects the overwhelming majority of 45 414 chunks before
      // it and there is no reason to pay even that for them.
      if (!has) {
        if (d2 <= load && canAdd && (d2 <= bLoad || !planet.chunkBuried(id))) { add.push(id); live.add(id); }
      } else if (d2 > keep || (d2 > bKeep && planet.chunkBuried(id))) {
        drop.push(id); live.delete(id);
      }
    }
    if (drop.length) {
      for (const id of drop) { this.planet.dropChunk(id); this.crossLight.delete(id); }
    }
    if (!add.length && !drop.length && !initial) return;
    this._streamPending = true;
    this.worldWorker.postMessage({ type: 'chunks', add, drop, initial });
  }

  /**
   * Put the player somewhere before there is any world, so the streamer knows
   * which part of it to build.
   *
   * On a new planet the worker has picked a column out of the height field; on
   * a saved one the save says where. Either way the position is only used to
   * choose a neighbourhood — `_spawnPlayer` gets the final say once that
   * neighbourhood is real, and it never moves the player more than a few dozen
   * columns, so the terrain built around this guess is the terrain they end up
   * standing on.
   */
  _seatPlayer(spawnCol) {
    const save = this._pendingSave;
    if (save) {
      const [x, y, k] = save.player.cell;
      this.player.setPosition(x + 0.5, k + 0.05, y + 0.5);
      return;
    }
    const col = spawnCol ?? 0;
    // `colHeight` is a LAYER now, so there is nothing to subtract off it.
    this.player.spawnAtColumn(col, Math.floor(this.planet.colHeight[col]));
  }

  /**
   * Register a newly arrived region's worldgen liquid as spring water.
   *
   * `Water.seedSources` scans the whole block array and clears what it finds
   * first, which was fine when the whole planet existed at once and is exactly
   * wrong now: run it after the second region lands and the first region's
   * ocean stops being a source, which turns it into a stale orphan the flow sim
   * is entitled to drain. So sources are added per region as it arrives, and
   * the pass is never re-run on a lazily built world.
   */
  _seedWaterRegion(rid) {
    const blocks = this.planet.blocks;
    const cols = regionColumns(rid, this._regionCols
      || (this._regionCols = new Int32Array(REGION_COLS)));
    const level = this.water.level;
    const sources = this.water.sources;
    for (let n = 0; n < REGION_COLS; n++) {
      const col = cols[n];
      const base = col * D;
      for (let k = 0; k < D; k++) {
        const i = base + k;
        if (RENDER_TYPE[blocks[i]] !== R_LIQUID || level.has(i)) continue;
        if (this._isFallingCell(col, k)) level.set(i, LEVEL_MAX);
        else sources.add(i);
      }
    }
  }

  /**
   * Is this worldgen liquid cell the middle of a WATERFALL rather than the
   * inside of a lake?
   *
   * It matters because the two want opposite bookkeeping and the difference is
   * a flood. A spring never drains and, once anything wakes it, spreads six
   * columns into any open side it has — which is fine for a lake, whose every
   * cell is walled by construction (see LAKE_FREEBOARD), and catastrophic for a
   * fall, whose whole point is open air beside the water. Flowing water with
   * liquid above AND below it is the one thing the sim treats as the middle of
   * a falling column and refuses to spread at all, so registering a fall that
   * way makes it inert. It also makes it honest: plug the spring at the lip and
   * the fall drains, one layer a tick, exactly as a player would expect.
   *
   * The test is four clauses and each one is load-bearing:
   *
   *   liquid above    the cell is not the head of the fall. The head has rock
   *                   over it, has nothing feeding it, and must stay a spring
   *                   or the whole column drains from the top down. WorldGen
   *                   walls and roofs it so that a spring there is inert.
   *   liquid below    the cell is not the foot. A foot spreads, and that is
   *                   correct: a fall always lands in water that is already
   *                   there, so its lowest cell is still a middle cell.
   *   no liquid beside it, and at least one open side beside it
   *                   this pair is what tells a fall from the inside of the
   *                   ocean next to a cave mouth, which also has water above
   *                   and below and an air neighbour. A fall is one column wide
   *                   by construction and WorldGen puts its candidates on a
   *                   checkerboard so that two can never touch, so nothing that
   *                   is falling has a liquid neighbour and nothing that is a
   *                   lake lacks one.
   *
   * Neighbours outside this region are skipped rather than guessed. They read
   * as air here whether or not they have been built, so counting them would
   * turn the middle of the sea into a waterfall along every region seam;
   * skipping them can only ever withhold the evidence for a fall, and WorldGen
   * refuses to site one whose footprint leaves its region for exactly that
   * reason. The direction of the error is the safe one either way: a fall
   * wrongly called a spring is the only failure that spreads, and it cannot
   * happen without a site that reaches across a boundary.
   */
  _isFallingCell(col, k) {
    if (k < 1 || k + 1 >= D) return false;
    const base = col * D + k;
    if (RENDER_TYPE[this.planet.blocks[base + 1]] !== R_LIQUID) return false;
    if (RENDER_TYPE[this.planet.blocks[base - 1]] !== R_LIQUID) return false;
    const rid = regionOfCol(col);
    let open = 0;
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      if (nb < 0 || regionOfCol(nb) !== rid) continue;
      const id = this.planet.at(nb, k);
      if (RENDER_TYPE[id] === R_LIQUID) return false;
      if (id === 0) open++;
    }
    return open > 0;
  }

  /** Player, inventory and world state — everything that needs real voxels. */
  _placeEntities() {
    const save = this._pendingSave;
    if (save) {
      const [px, py, pk] = save.player.cell;
      this.player.setPosition(px + 0.5, pk + 0.05, py + 0.5);
      this.player.forward.fromArray(save.player.forward);
      this.player.pitch = save.player.pitch;
      this.player.health = save.player.health;
      this.breath = save.player.breath ?? 1;
      this.inventory.fromJSON(save.inventory);
      // Strictly after `fromJSON`, which clears the offhand precisely so that
      // this line is the only thing that can fill it.
      this.inventory.loadOffhand(save.player?.offhand);
      this.drops.fromJSON(save.drops);
      // Strictly after the drops, because `_update` clears this the moment
      // there is no `keep` drop left to point at — restoring it before the
      // pile exists would be a chip that survives exactly one frame. A save
      // written before this field existed has no key and gets no chip, which
      // is the behaviour those saves have had all along.
      const ds = save.player?.deathSite;
      this.deathSite = Array.isArray(ds) && ds.length === 4
        ? { pos: new THREE.Vector3(ds[0], ds[1], ds[2]), at: ds[3] }
        : null;
      this.mobs.fromJSON(save.mobs);
      if (save.crops) this.farming.fromJSON(save.crops); else this.farming.rescan();
      this.energy = save.player.energy ?? 1;
      this.weather.fromJSON(save.weather);
      this.playtime = save.playtime || 0;
      // Time of day is world state, not a setting: quitting at dusk and coming
      // back should still be dusk, or a saved world is a way to skip the night.
      if (save.dayT !== undefined) this.dayT = save.dayT;
      // Same reasoning one scale up: a world saved in autumn comes back in
      // autumn. Worlds saved before seasons existed start at day zero, which is
      // the first day of spring — a fair place to find yourself.
      this.seasons.fromJSON(save.season);
      this._pushSeason();
      this.stats = { ...this.stats, ...(save.stats || {}) };
      /*
       * This planet's marks, and the one place the old shared record is still
       * read.
       *
       * A world saved before the record moved into the payload has no
       * `achievements` key, and for those `legacy()` hands back whatever the
       * browser-wide record held so that a planet in progress keeps what it
       * earned. It is a copy: from the first save onwards this world owns its
       * own, and every other world gets the same one-time copy on its first
       * open and then diverges. A world made after this change never sees it.
       *
       * After `stats` and `playtime`, and it has to be: `fromJSON` drops the
       * baseline the counter deltas are read against, so the first scan after a
       * load is a no-op rather than a jump of nine thousand blocks.
       */
      this.achievements.fromJSON(save.achievements ?? Achievements.legacy());
      // After `stats`, `playtime` and the inventory, and it has to be: the tree
      // counts the first two and converts the armour in the third. See the
      // ordering note on `_loadSkills`. `player.health` was assigned from the
      // save above, so a respec-shrunk bar is clamped here rather than left
      // over its own maximum.
      this._loadSkills(save);
      for (const k of save.kilns || []) {
        this.kilns.set(k.key, {
          input: Slot.fromJSON(k.in), fuel: Slot.fromJSON(k.fu), output: Slot.fromJSON(k.out),
          burn: k.b, burnMax: k.bm, progress: k.p, progressMax: k.pm, col: k.c, k: k.k,
          // Taken from the slot rather than saved, because it is not really new
          // state — it is a restatement of whose progress `p` is, and the input
          // slot already says. Deriving it here rather than defaulting to 0 is
          // what stops a load from being a free swap: the first tick after a
          // load would otherwise adopt whatever was in the slot by then.
          progressItem: Slot.fromJSON(k.in).item,
        });
      }
      for (const c of save.crates || []) {
        this.crates.set(c.key, {
          slots: Array.from({ length: CRATE_SLOTS }, (_, i) => Slot.fromJSON(c.s[i])),
          col: c.c, k: c.k,
        });
      }
      this.homeSpawn = Array.isArray(save.home)
        ? { col: save.home[0], k: save.home[1] }
        : null;
      this.signs = new Map(save.signs || []);
      this.signSeq++;
      this.frozen = new Set(save.frozen || []);
      // Saves written before seasonal snow existed have no table, and a world
      // that loads without one is not wrong - it is a world whose snow is
      // wherever the generator and the last session left it, with the season
      // free to move it from there.
      this.seasonSnow = new Map();
      const skin = save.seasonSnow;
      if (skin) for (let n = 0; n + 1 < skin.length; n += 2) this.seasonSnow.set(skin[n], skin[n + 1]);
      this.hearths = new Set(save.hearths || []);
      this.coreFound = !!save.coreFound;
      // Which bosses are still standing, where, at what health, and which faces
      // have stopped making monsters. Before `_setDifficulty` below only by
      // accident of order: nothing here reads it.
      this.endgame.fromJSON(save.endgame);
      // How much of Verdant's barter you had used up. Defaulted rather than
      // versioned, like `endgame` and `achievements` above: a save written
      // before the face existed comes back with a full set of offers, which is
      // exactly what walking back through the divider would have given it.
      this.barter = save.barter && typeof save.barter === 'object'
        ? { used: { ...(save.barter.used || {}) } }
        : newBarterState();
      // A world started on hard loads as hard. Saves written before this
      // existed carry no field and `normalizeDifficulty` reads them as normal,
      // which is the game they were played under. The loadout is a record of
      // what this planet was started with — it is only spent once, in
      // `_beginGrace`, which a load never reaches.
      this._setDifficulty(save.difficulty);
      this.loadout = normalizeLoadout(save.loadout);
      // Same story: a save written before the question was asked carries no
      // field, and `normalizeDeathRule` reads that as 'lose', which is the game
      // every such planet has been played under.
      this._setDeathRule(save.deathRule);
      // Strictly after the difficulty above, which is what decides whether a
      // dead save is a spectator or an ordinary one. Held rather than acted on
      // because the world is not up yet — there is no HUD to change and no
      // pointer to lock — and `_onWorldReady` is where every other hand-over to
      // the player already happens.
      this._deadOnLoad = !!save.player?.dead && this.runEnds;
      this._refreshWards();
      this._pendingSave = null;
    } else {
      this._spawnPlayer();
      this.mobs.populate(this.player);
      this._beginGrace();
      // Commit the new planet at once. Autosave only fires every 90 seconds, so
      // starting a new game and quitting before then left the *old* world on
      // disk — Continue brought it back and New Game looked like it had done
      // nothing at all.
      //
      // Deferred by a step rather than called here: `saveGame` refuses while
      // `worldReady` is false, and this runs just before it is set. It has been
      // a silent no-op ever since the loading order changed, and it matters
      // more now — a partial save is the seed plus the regions that exist, so
      // never writing one leaves the last planet on disk instead of this one.
      this._saveOnReady = true;
    }
    this.ui.refresh();
  }

  /** The first batch of terrain is up — hand control to the player. */
  _onWorldReady() {
    // The planet beat the player to it. Hold the hand-over — dropping someone
    // into a world while they are still deciding who they are would both throw
    // the picker away unanswered and hand the body to whoever happened to be
    // highlighted. `beginWorld` calls this again.
    if (this._choosing) {
      this._readyHeld = true;
      this.ui.characterPickerReady(true);
      return;
    }
    this.worldReady = true;
    if (this._saveOnReady) { this._saveOnReady = false; this.saveGame(false); }

    const el = document.getElementById('loader');
    if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 650); }

    this.state = 'playing';
    this.ui.showHud(true);
    this.audio.start();
    this.audio.resume();
    this.input.requestLock();
    // ...unless this planet was left dead. No death screen on the way in — the
    // player has already read it once and already chosen — just the world, from
    // where they fell. `_spectate` takes the state from here, which is why this
    // sits after the assignment above rather than instead of it.
    if (this._deadOnLoad) { this._deadOnLoad = false; this._spectate(); }

    // No opening advice. A new planet used to greet the player with "Punch a
    // tree" (and "Plant a torch" if they woke at night); both are gone with the
    // rest of the teaching. The torches are in the bar and the trees are on the
    // hill, and finding that out is the first thing the game is for.
  }

  /**
   * Pick level, open, grassy ground for a good first frame.
   *
   * This used to sample three thousand columns from anywhere on the planet,
   * which it could do because the whole planet was in memory. It cannot now:
   * two thirds of a second of terrain has been built, around the column the
   * worker nominated, and reading `surfaceK` anywhere else would find air and
   * spawn the player inside the sky. So the search is a local one — forty
   * columns either way, comfortably inside the built neighbourhood — and the
   * planet-wide part of the choice has already been made from the height field
   * by `WorldGen.pickSpawn`.
   */
  /**
   * The hour the sky should be drawn at, which is not the same everywhere.
   *
   * The cinderlands never see the sun. It is a face of basalt and lava lit from
   * below, and a bright blue noon over it undid the whole idea of the place -
   * the owner: "can we make it permanent night at magma face". Held a little
   * past midnight rather than exactly on it, so the sky still has the faint
   * colour a night carries rather than being flat black.
   *
   * The cap is deliberately NOT given the same treatment. Eternal day there was
   * tempting and is wrong: the polar face is where the long crossings happen and
   * taking the night away takes the danger with it.
   */
  skyTimeOfDay() {
    return FACE_ROLE[this.player.face] === FACE_PYRE ? CINDER_HOUR : this.timeOfDay();
  }

  _spawnPlayer() {
    const p = this.planet;
    // The player's current column, which is always one that has been built:
    // on a new world `_seatPlayer` has just put them on the generator's chosen
    // spawn, and on a death it is where they fell. Searching outward from there
    // rather than from anywhere on the planet is not only what lazy generation
    // forces — it is also better behaviour, because respawning three thousand
    // columns from everything you own was never what anyone wanted.
    const c = this.player.cell;
    const hint = colIndex(c.x, c.y);
    const REACH = 40;
    let best = -1, bestScore = -1, bestK = 0;
    for (let n = 0; n < 3000; n++) {
      const col = stepColumn(hint,
        ((Math.random() * (REACH * 2 + 1)) | 0) - REACH,
        ((Math.random() * (REACH * 2 + 1)) | 0) - REACH);
      if (!p.liveCol(col)) continue;
      // Never wake up on a different face from the one you died on. The cross
      // is one world and a join inside it is nothing, but a sealed face is a
      // room: being killed on the cinderlands only to reappear in a meadow is
      // the planet deciding your expedition is over.
      if (faceOfCol(col) !== this.player.face) continue;
      const k = p.surfaceK(col);
      if (k < 6 || k >= D - 6) continue;
      const b = p.at(col, k);
      // Ground worth standing on, and the two dedicated faces have none of the
      // old list: the cap is ice and snow, the cinderlands are basalt and ash.
      // Scored below grass, because they are somewhere you are visiting.
      let score = b === ID.grass ? 3 : b === ID.sand ? 1.4
        : (b === ID.snow || b === ID.ice || b === ID.packed_ice) ? 2.2
          : (b === ID.basalt || b === ID.ash_stone || b === ID.magma_stone) ? 2.0 : 0;
      if (!score) continue;
      if (k < SEA_K) continue;
      // headroom
      if (p.solidAt(col, k + 1) || p.solidAt(col, k + 2) || p.solidAt(col, k + 3)) continue;
      // flatness across the four neighbours
      let spread = 0;
      for (let d = 0; d < 4; d++) spread += Math.abs(p.surfaceK(colNeighbor(col, d)) - k);
      score += Math.max(0, 4 - spread);
      if (score > bestScore) { bestScore = score; best = col; bestK = k; }
      if (bestScore > 6.5) break;
    }
    // Nothing scored? Stand on the hint column itself. It came out of the
    // height field as open, dry, level ground, so the worst case is that the
    // top block is podzol rather than grass — never a hole in the planet, which
    // is what falling back to column 0 would have been now that column 0 may
    // not have been built.
    if (best < 0) { best = hint; bestK = Math.max(0, p.surfaceK(hint)); }
    this.player.spawnAtColumn(best, bestK);
    this.player.health = this.player.maxHealth;
    this.sky.setSolarTime(this.player.up, this.skyTimeOfDay());
    this.player.updateCamera(this.camera, 1 / 60, this.settings.fov);
  }

  // --- growth ---------------------------------------------------------------

  /**
   * Push the tree's numbers onto the body that has to obey them.
   *
   * Two of the six branches are read by other systems through `player` rather
   * than through `skills` — the raycasts all take `player.reach`, and the HUD
   * and every heal clamp against `player.maxHealth` — so those two have to be
   * copied across whenever a level changes. The other four are read straight
   * off `skills` at the point of use and need nothing here.
   *
   * `health` is only ever clamped *down*, never topped up: buying a heart
   * should give you room to heal into, not heal you. Losing one — which only a
   * respec can do — must not leave you standing at 24 out of 20.
   */
  _applySkills() {
    const p = this.player;
    p.maxHealth = this.skills.maxHealth;
    p.reach = this.skills.reach;
    if (p.health > p.maxHealth) p.health = p.maxHealth;
  }

  /**
   * Recount the derived points, on a timer rather than per frame.
   *
   * `observe` is five square roots over counters that move a handful of times a
   * second at most, and it reports whether the total actually changed — so once
   * a second is both far cheaper than a frame and quick enough that the toast
   * still lands while you are looking at the block you just broke.
   */
  _tickSkills(dt) {
    this._tickNightOut(dt);
    this._skillTimer -= dt;
    if (this._skillTimer > 0) return;
    this._skillTimer = 1;
    // On the same timer and for the same reason it is on one: walking forty
    // slots and six counters once a second is free, and once a frame is not.
    // Before the early return below, which only concerns the skill tree.
    this.achievements.scan(this);
    if (!this.skills.observe(this.stats, this.playtime)) return;
    // Earning a point is the only progression event in the game and it was
    // announced by a toast and nothing else. `levelUp` is the only fanfare
    // here; this is what it was written for.
    this.audio.levelUp();
    const left = this.skills.available;
    // Announce the balance, not the delta. A player who has banked points and
    // not spent them wants to be reminded that they are sitting there; "+1" on
    // its own says nothing about whether it is worth opening the screen.
    this.ui.toast(left === 1 ? '1 skill point to spend. Press K' : `${left} skill points to spend. Press K`,
      0, 3200);
    this.ui.refreshSkills();
  }

  /**
   * First Light: time spent out under a night sky, and still standing.
   *
   * Counted up to a threshold rather than watched for a sunrise, and that is
   * the only way it can work here. With `dayMinutes` at 0 — the default — the
   * planet follows the device clock and a night is twelve real hours long, so a
   * mark that waited for the moment of dawn would be a mark almost nobody ever
   * got. Three minutes of open sky after dark is the same experience at every
   * cycle length: long enough that stepping outside to shut a door does not
   * count, short enough to fit inside one evening's play.
   *
   * `shelter` is the sky-exposure the weather already computes, so standing in
   * a doorway or under a tree pays at whatever fraction of the sky is over you,
   * and a roof pays nothing. `_die` puts the clock back to zero: a night you
   * did not live through is not a night you survived.
   */
  _tickNightOut(dt) {
    const t = this.timeOfDay();
    if (!(t < 0.25 || t > 0.75)) { this._nightOut = 0; return; }
    if (this.shelter < 0.55) return;
    this._nightOut = (this._nightOut ?? 0) + dt;
  }


  /** Buy one level. Called from the skills screen; returns whether it took. */
  buySkill(key) {
    // `deny()` rather than a low blip: a refusal that is the click at a
    // different pitch is a refusal the player has to already know to listen for.
    if (!this.skills.buy(key)) { this.audio.deny(); return false; }
    this._applySkills();
    this.audio.ui(720);
    this.ui.refreshSkills();
    return true;
  }

  /**
   * Hand every point back. Free, by the module's own argument — the points come
   * from a history that cannot be earned twice, so a fee would be a permanent
   * tax for having chosen before you knew what the branches felt like.
   */
  resetSkills() {
    this.skills.reset();
    // Strictly after the reset: `_applySkills` is what clamps a player who was
    // standing at 30 health down to the 20 they now have room for.
    this._applySkills();
    this.audio.ui(420);
    this.ui.toast('Points refunded', 0, 3200);
    this.ui.refreshSkills();
  }

  /**
   * Load the tree out of a save, and pay for whatever armour was in it.
   *
   * The order in here is the whole of the "do not silently rob the player"
   * requirement, so it is worth stating: the levels come back first, then the
   * armour is converted into points, then `observe` recounts everything the
   * save's own counters have always been worth. All three land before the first
   * frame is drawn, which is what makes the swap arrive as one event — you open
   * a planet, you are told what your set became and what your history is worth,
   * and the screen that spends it is one key away. Deferring any of it by even
   * a frame would give the player a moment of being flatly weaker than they
   * were, which is the one outcome this is not allowed to have.
   */
  _loadSkills(save) {
    this.skills.fromJSON(save?.player?.skills);

    // The worn set, once. `takeLegacyArmour` empties the field as it hands it
    // over and `redeemArmour` refuses a second conversion, so this cannot pay
    // twice — and because the pieces are only destroyed when the conversion
    // actually returns something, it cannot take without paying either.
    const worn = this.inventory.takeLegacyArmour();
    // Spares in the bags count too. A chestplate in a backpack is armour the
    // player earned exactly as much as the one on their chest, and leaving it
    // behind would be converting some of what they owned and quietly turning
    // the rest into an ornament.
    const carried = [...this.inventory.slots, this.inventory.offhand]
      .filter((s) => !s.empty && ITEMS[s.item]?.armour);
    const points = armourPoints(worn) + armourPoints(carried);
    const gained = this.skills.redeemArmour(points);
    if (gained > 0) {
      const pieces = worn.length + carried.reduce((n, s) => n + s.count, 0);
      for (const s of carried) s.clear();
      this.inventory.changed();
      this.ui.toast(
        `Armour is gone. ${pieces} piece${pieces > 1 ? 's' : ''} became ${gained} skill point${gained > 1 ? 's' : ''}. Press K.`,
        0, 9000);
    }

    // Last, and never skipped: this is where a twenty-hour save gets the sixty
    // points its history has been worth all along.
    this.skills.observe(this.stats, this.playtime);
    this._skillTimer = 1;
    this._applySkills();

    // And say so. This is the other half of the promise the conversion makes,
    // and it matters most for the player who owned no armour at all: they lost
    // nothing, so the toast above never fires, and without this they would open
    // a save that is quietly missing a system and be given no reason to press
    // any key at all. `observe` will not announce it either — it has just run,
    // so the total is not going to move again for a while.
    const left = this.skills.available;
    if (left > 0) {
      setTimeout(() => this.ui.toast(
        `${left} skill point${left === 1 ? '' : 's'} waiting. Press K to spend ${left === 1 ? 'it' : 'them'}.`,
        0, 8000), gained > 0 ? 2600 : 600);
    }
  }

  // --- state ----------------------------------------------------------------

  /**
   * Escape always closes the top-most thing, wherever you are: a Settings or
   * Controls sheet first, then the pause screen, then an inventory/station
   * screen, and only then does it pause the game. Death is the one screen it
   * won't dismiss — that needs an actual choice.
   */
  _escape() {
    const ui = this.ui;
    if (ui.anyModalOpen) { ui.closeSettings(); ui.closeControls(); ui.closeAchievements(); return; }
    if (ui.deathOpen) return;
    if (ui.skillsOpen) { this.closeSkills(); return; }
    if (ui.pauseOpen) { this.resume(); return; }
    if (ui.screenOpen) { this.closeScreen(); return; }
    // A spectator reaches the pause menu the same way, and must: it is where
    // the way out of the world is.
    if (this.state === 'playing' || this.state === 'spectating') this.pause();
  }

  /**
   * The pause menu, which a spectator gets on exactly the same terms.
   *
   * It has to: quitting to the menu is the only way out of a world whose run is
   * over, and it lives on that screen. Where it came *from* is remembered
   * rather than assumed, so resuming puts the player back into the state they
   * paused — a spectator who pauses and resumes is still a spectator, and the
   * alternative (`state = 'playing'`) would quietly resurrect them.
   */
  pause() {
    if (this.state !== 'playing' && this.state !== 'spectating') return;
    this._pausedFrom = this.state;
    this.state = 'paused';
    this.ui.openPause();
    this.input.exitLock();
  }

  resume() {
    this.ui.closePause();
    this.state = this._pausedFrom === 'spectating' ? 'spectating' : 'playing';
    this.audio.resume();
    this.input.requestLock();
  }

  _die(cause) {
    // Once, and never again on a world that is already over. Belt and braces
    // behind `_takeHit`'s own refusal, because a death screen appearing over a
    // spectator would be the one way this state could be left by accident.
    if (this.state === 'dead' || this.spectating) return;
    this.state = 'dead';
    // The one event in the game that had no sound at all. `hurt()` fires on the
    // blow that kills, and then the world simply stopped.
    this.audio.death();
    // And then the world stops with them. The ambient bed drives itself off its
    // own timer rather than off `_update`, so without this the dawn chorus goes
    // on singing over the card that says you are dead. Given back by `respawn`
    // and by `_spectate`, which are the only two doors out of this state.
    this.audio.setWorldQuiet(true);
    this.input.exitLock();
    this.closeScreen();
    this.closeSkills();
    // `_interact` owns the hint line and clears it every frame it runs, but it
    // only runs while nothing is `busy` — and a death screen is busy forever.
    // So whatever was on the line at the instant you died ("Needs a Pickaxe",
    // "A bite, click") stayed there under the death screen and through the
    // whole of a spectator run. Cleared here because this is the one place that
    // knows the owner is never going to run again.
    this.ui.setHint(null);
    // Same reasoning for the cast: a float, a line and a balance bar left over
    // a death screen, none of which anything is going to tick again.
    if (this.fishing) this._stopFishing();
    // Everything you carried stays where you fell, and stays there — `keep`
    // exempts it from the despawn clock. What you were *wearing* stays on you:
    // you respawn at a bed that may be a long way from your body, and sending
    // you back for it with nothing on is how a setback becomes a spiral.
    //
    // Unless this planet was started as a keep world, in which case none of it
    // leaves the bag at all and there is no body to walk back to. The whole of
    // the setting's inventory half is this branch: nothing is dropped, so
    // nothing has to be recovered, and `deathSite` stays null so the HUD does
    // not point at a pile that is not there.
    _v1.copy(this.player.position).addScaledVector(this.player.up, 0.6);
    let dropped = 0;
    if (!this.keepsOnDeath) {
      // The offhand goes with the rest. It is carried, not worn — a torch in
      // your left hand is your torch in the same sense the one in your right
      // is, and a slot that quietly kept its contents through a death would be
      // the one place on the character worth stuffing your diamonds into.
      for (const s of [...this.inventory.slots, this.inventory.offhand]) {
        if (s.empty) continue;
        this.drops.spawn(_v1.x, _v1.y, _v1.z, s.item, s.count, s.wear, null, true);
        s.clear();
        dropped++;
      }
    }
    this.deathSite = dropped ? { pos: _v1.clone(), at: this.playtime } : null;
    // See `_tickNightOut`: a night you did not live through does not count.
    this._nightOut = 0;
    this.ui.refresh();
    // The same screen either way, with the button that would have put you back
    // saying what it will actually do. The bag rule above is untouched by this:
    // an extreme keep-world still keeps everything, on a body nobody will walk
    // again, and an extreme lose-world still leaves the pile where you fell —
    // which a spectator can go and look at and not pick up. That is a better
    // ending than making the drop a special case.
    this.ui.showDeath(cause, this._loseSkills(), this.runEnds);
  }

  /**
   * Take the skill tree away, and say what it cost.
   *
   * Every death in the game arrives here — the three `_die` callers are a fall,
   * a drowning, and `_takeHit`, which is itself the single door for blows,
   * lava, fire and cactus. Starving cannot kill (`_tickVitals` floors health at
   * 1), so there is no fourth path to miss.
   *
   * What is taken is entirely `skills.onDeath` — the world's own rule, set by
   * `_setDeathRule` from the New Game answer; this end only reconciles
   * the body, tells the player, and writes it down.
   *
   * @returns {string} a short phrase for the death screen, or '' if nothing
   *   was lost. Not a sentence: the death screen states the cause and then, at
   *   most, the one fact that a wipe is real. It used to return a paragraph.
   */
  _loseSkills() {
    const lost = this.skills.die();
    // Strictly after: `_applySkills` is what takes back the health a wiped
    // vigour branch was paying for, and `respawn` heals to `maxHealth` — so a
    // player who is not clamped here wakes up at 30 out of 20.
    this._applySkills();
    this.ui.refreshSkills();
    // A wipe a reload undoes is not a wipe. Not awaited: the death screen is
    // already up, and the write is the same one the ninety-second autosave does.
    this.saveGame(false);
    if (!lost || !(lost.level > 0 || lost.spent > 0 || lost.xp > 0)) return '';
    if (lost.mode === 'unlearn') return `Skills unlearned, ${lost.spent} points back`;
    if (lost.mode === 'toll') {
      return lost.level > 0
        ? `Lost ${lost.xp} XP and ${lost.level} level${lost.level > 1 ? 's' : ''}`
        : `Lost ${lost.xp} XP`;
    }
    // 'wipe'. The ladder, then the tree, and no line about starting again:
    // the level bar on the Growth screen already reads 0.
    const lvl = lost.level > 0 ? `Level ${lost.level} gone` : 'XP gone';
    return lost.spent > 0 ? `${lvl}, and every skill` : lvl;
  }

  /**
   * The one button on the death screen, and the one door out of `dead`.
   *
   * A world that ends on death routes through here rather than past it, and
   * that is the point: `respawn` is what the button calls, what the harness
   * calls and what any future caller will call, so putting the branch at the
   * top means there is no path that can put an extreme player back on their
   * feet. A second entry point that "also respawns" is how this rule would be
   * lost, and there is now nowhere to add one.
   */
  respawn() {
    if (this.runEnds) { this._spectate(); return; }
    this.ui.hideDeath();
    this.audio.setWorldQuiet(false);
    this.player.health = this.player.maxHealth;
    this.breath = 1;
    // Everything that was still hurting you when you died. "After dying I am
    // still taking damage - when I died from lava, after respawning I am still
    // taking damage": `burning` is a five second clock that relights while you
    // stand in lava, and death did not clear it, so you woke up at your bed
    // already on fire and lost health to a pool you were nowhere near. The
    // scald and starvation clocks are the same shape and would have done the
    // same thing.
    this.player.burning = 0;
    this._scaldT = 0;
    this.soakT = 0;
    this._starve = 0;
    // The cold, which is the fourth clock of that shape and would have done
    // exactly the same thing: freeze to death in a drift and you would wake at
    // your bed still taking a point every 1.2 seconds from snow you were
    // nowhere near.
    this.chillT = 0;
    this._chillT = 0;
    this._chillSaid = false;
    // The poison, which is the sixth clock of that shape and would have done
    // exactly the same thing again: eat a bad fish, die to the husk that was
    // chasing you while you did it, and wake at your bed still losing a point
    // every three seconds to a meal you no longer have. Three lines because it
    // is two clocks and a said-it-once flag, and all three have to go: leaving
    // `sporeT` charged would poison you 0.1 seconds after respawning.
    this.poisonT = 0;
    this._poisonT = 0;
    this.sporeT = 0;
    this._sporeSaid = false;
    // Full, like the health bar beside it. It used to be floored at 0.35,
    // which meant you came back whole but starving and the first thing a death
    // cost you was a meal you had to go and find. The owner: "dying retains
    // hunger which is stupid, we regain full hp but not hunger?" - and there is
    // no argument for the asymmetry. Death is already expensive: it drops your
    // inventory where you fell and puts it a walk away.
    this.energy = 1;
    // Wake up at your bed if you have one and it is still there. Falling back to
    // a fresh random column is only right for a player who has never slept: on a
    // planet of 259,584 columns, being scattered at random after every death
    // means the base you built is gone the first time something goes wrong.
    const home = this.homeSpawn;
    if (home && this.planet.at(home.col, home.k) === ID.bed) {
      this.player.spawnAtColumn(home.col, home.k);
    } else {
      if (home) this.ui.toast('Your bed is gone.', itemIdOf('bed'), 3000);
      this.homeSpawn = null;
      this._spawnPlayer();
    }
    this.state = 'playing';
    this.input.requestLock();
  }

  /**
   * Become a spectator of your own world.
   *
   * Entered from exactly two places, and both of them are the end of a run:
   * `respawn` when the player presses the one button the death screen offers,
   * and `_onWorldReady` when a save that was written dead is opened again. It
   * is idempotent, because a reload that lands in it and a button press that
   * lands in it should produce the same world.
   *
   * What it actually does is small, and that is the argument for it. There is
   * no spectator movement controller, no separate render path and no list of
   * features to switch off:
   *
   *   - the state becomes `spectating`, which `_update` treats as permanently
   *     `busy` — the same gate an open inventory uses, so every action that
   *     already knew how to be unavailable is unavailable, including the ones
   *     added after this was written;
   *   - `mobs.ghost` says there is nobody standing there, so nothing acquires,
   *     swings at, or pushes past the player;
   *   - `_takeHit` returns at its first line, so no damage of any kind can
   *     reach a body that is already at zero;
   *   - the HUD loses the things that describe a body and keeps the things
   *     that describe a planet.
   *
   * Health stays at zero on purpose. It is what the save carries, it is what
   * makes this state recoverable across a reload, and nothing reads it any
   * more: `_tickVitals` does not run, and the one thing that could act on it
   * is `_die`, which refuses to run twice.
   */
  _spectate() {
    if (this.spectating) return;
    this.ui.hideDeath();
    // A spectator is looking at the planet, so the planet gets its sound back.
    // Unconditional rather than paired with `_die`, because the other caller is
    // `_onWorldReady` opening a save that was written dead, which never passed
    // through `_die` at all.
    this.audio.setWorldQuiet(false);
    this.closeScreen();
    this.closeSkills();
    this.state = 'spectating';
    this.mobs.ghost = true;
    this.ui.setSpectator(true);
    // Nothing carried over from the last frame it was alive: no stagger, no
    // held bow, no sprint. It drifts from where it fell.
    this.player.vel.x = 0; this.player.vel.y = 0; this.player.vel.z = 0;
    this.player.knockT = 0;
    this.bow.t = 0;
    this.breath = 1;
    // Respawning in a scalded state would mean the next pool you stepped into
    // burned you on contact, with no warmth first and nothing on screen to say
    // why. Cleared with breath for the same reason breath is cleared.
    this.soakT = 0;
    this.chillT = 0;
    this.poisonT = 0;
    this.sporeT = 0;
    this.ui.refresh();
    this.input.requestLock();
  }

  /**
   * Move the eye, and nothing else.
   *
   * The whole of a spectator's physics, and deliberately not a mode inside
   * `Player.update`: that function is where the collision, the step-up, the
   * ladders, the water, the fall damage and the mob push all live, and a flag
   * threaded through it would be a promise that none of them fires rather than
   * a guarantee. This writes a position. There is nothing else in it to go
   * wrong, and no way to add anything without meaning to.
   *
   * The steering is the player's own: `forward` is whatever `look` has already
   * set, and the wish is a world-space vector added straight to the position.
   * There is no cell space to convert into and back out of any more.
   */
  _drift(dt, input) {
    const p = this.player;
    const fast = input.down('ShiftLeft') || input.down('ShiftRight');
    const speed = fast ? SPECTATE_FAST : SPECTATE_SPEED;
    const iz = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const ix = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const iy = (input.down('Space') ? 1 : 0)
      - ((input.down('ControlLeft') || input.down('ControlRight')) ? 1 : 0);
    const right = _v2.copy(p.forward).cross(p.up).normalize();
    const wish = _v1.set(0, 0, 0).addScaledVector(p.forward, iz).addScaledVector(right, ix);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    wish.y += iy * speed;
    const pos = p.position;
    // The two hard edges of the array. Bedrock is not a wall a spectator is
    // being kept out of - it is the bottom of the array - and the same at the
    // top, where there is no world left to look at.
    p.setPosition(pos.x + wish.x * dt,
      Math.min(D - 1.5, Math.max(1, pos.y + wish.y * dt)),
      pos.z + wish.z * dt);
  }

  /**
   * Use a bed: claim it as the place you wake up.
   *
   * A bed does not skip the night, and deliberately. The planet keeps the
   * player's own clock, so a bed that jumped to dawn would be jumping *their*
   * time of day — you would lie down at nine in the evening and stand up in a
   * morning that is still nine in the evening, with the sky disagreeing with the
   * clock in the corner of the screen for the rest of the session. The night is
   * something to get through with a torch and a door, not something to skip.
   *
   * What it is still for is the thing that actually hurts: dying on a planet of
   * a quarter of a million columns and having no idea where your house was.
   */
  _useBed(col, k) {
    const claimed = !this.homeSpawn || this.homeSpawn.col !== col || this.homeSpawn.k !== k;
    this.homeSpawn = { col, k };
    this.ui.toast(claimed ? 'You will wake up here.' : 'This is already your home.',
      itemIdOf('bed'), 2600);
    this.audio.ui(claimed ? 620 : 420);
  }

  /**
   * "Save & Quit to Menu" — and if it cannot save, it does not quit.
   *
   * It used to await a save whose result it never looked at and then tear the
   * world down regardless, which turns a recoverable disk error into the total
   * loss of a session. Leaving the player in the world instead costs them one
   * more click and keeps everything they did.
   *
   * Refusing outright would be its own trap — a permanently broken store would
   * leave no way out of the game — so a second press inside ten seconds leaves
   * anyway, with the button saying exactly what it will do. That is a decision
   * the player is allowed to make; it is only not one to make *for* them.
   */
  async quitToMenu() {
    const saved = await this.saveGame(false);
    if (!saved && !this._quitAnyway) {
      this._quitAnyway = true;
      setTimeout(() => { this._quitAnyway = false; this.ui.setQuitConfirm(false); }, 10000);
      this.ui.setQuitConfirm(true);
      this.ui.toast('Could not save. Press again to leave anyway');
      return;
    }
    this._quitAnyway = false;
    this.ui.setQuitConfirm(false);
    this.ui.closePause();
    this.ui.hideDeath();
    this.closeScreen();
    this.closeSkills();
    this.ui.showHud(false);
    this.input.exitLock();
    this.state = 'menu';
    this.saveSlot = -1;
    this.ui.showMenu();
  }

  /**
   * What a save of a half-built planet actually contains.
   *
   * Two honest options and this is the second of them. The first — generate the
   * rest of the planet before writing — is a thirty-second freeze on the first
   * autosave, which throws away the entire point of the change and does it
   * ninety seconds after the player starts. So a save stores the regions that
   * exist and the seed, and everything else is rebuilt by the generator on
   * load.
   *
   * That is sound because generation is a pure function of (seed, region): a
   * region has no dependence on the order regions were built in and none on its
   * neighbours' contents, which is a property the rest of this change went to
   * some trouble to establish. It is only sound while the generator does not
   * change, which is what `GEN_VERSION` and `_saveFitsWorld` are for.
   *
   * It also makes a save small. A planet the player has walked one valley of is
   * a couple of hundred regions — about four megabytes against the eighty-five
   * the whole block array cost, every ninety seconds.
   */
  _saveBlocks() {
    // Only what the player changed. A region nobody has touched is byte for
    // byte what the generator makes of it from this seed, so storing it is
    // storing a copy of something the loader can make again for free - and the
    // seed and `gen` stamp at the top of the payload are exactly the promise
    // that it can.
    //
    // Measured on a fresh world after digging six blocks: 399 regions were
    // live and one had been edited, so the block payload goes from 9.64 MB to
    // 0.024 MB. A fully explored planet was heading for 122 MB of blocks;
    // now the ceiling is however much you actually built, not how far you
    // walked. That is the autosave problem: it was taking three to five seconds
    // at eight percent explored against a ninety second interval, and the cost
    // was tracking exploration rather than construction.
    //
    // The regions a *previous* session edited are still edited, so `load`
    // seeds this set from whatever the save carried. Without that, opening and
    // re-saving a world would quietly drop everything built before it.
    const live = [];
    for (let rid = 0; rid < NUM_REGIONS; rid++) {
      if (this.planet.live[rid] && this.editedRegions.has(rid)) live.push(rid);
    }
    const regions = new Int32Array(live);
    const blocks = new Uint8Array(live.length * REGION_VOXELS);
    const tmp = new Int32Array(REGION_COLS);
    for (let n = 0; n < live.length; n++) {
      regionColumns(live[n], tmp);
      let o = n * REGION_VOXELS;
      for (let c = 0; c < REGION_COLS; c++) {
        const base = tmp[c] * D;
        for (let k = 0; k < D; k++) blocks[o + k] = this.planet.blocks[base + k];
        o += D;
      }
    }
    return { regions, blocks };
  }

  /** `seasonSnow` as [cell, blockBefore, cell, blockBefore, ...]. */
  _saveSeasonSnow() {
    const out = new Int32Array(this.seasonSnow.size * 2);
    let n = 0;
    for (const [key, id] of this.seasonSnow) { out[n++] = key; out[n++] = id; }
    return out;
  }

  _savePayload() {
    const c = this.player.cell;
    return {
      // The shape of the planet this save was written for.
      //
      // Everything below indexes into a flat array whose size is W*W*D, and
      // the loader used to take that array on trust. Change the map width or
      // the depth and every index in an old save points somewhere else: the
      // block array is silently the wrong length, reads past its end come back
      // as air, and what you get is not an error but a corrupt planet that
      // looks almost plausible. Stamping the geometry in is what lets the
      // loader say no.
      geom: [W, D],
      gen: GEN_VERSION,
      seed: this.seed,
      ...this._saveBlocks(),
      // No `colBiome`. It is a megabyte and a quarter of pure seed-derived data
      // - the same seed regenerates it exactly - and once the block payload
      // stopped storing unedited regions it was 98 percent of the save: 1,261 KB
      // against 25 KB of blocks.
      //
      // It was kept to guard one case: a save written by a version whose
      // climate thresholds have since moved would come back with the terrain it
      // stored and the tints of a different planet. That is exactly what the
      // `gen` stamp at the top of this payload refuses outright, and moving a
      // climate threshold is a worldgen change that has to bump it. A second,
      // weaker defence against a case the first one rejects is not worth a
      // megabyte on every autosave.
      //
      // The worker already regenerates it when a save does not carry one, and
      // the loader's length check is written to tolerate its absence.
      facing: this.planet.facingPairs(),
      // Everything about the person rather than the planet, in one place.
      //
      // `character` goes in here and not at the top level on purpose: the
      // offhand slot and the skill tree are both coming, and both are facts
      // about the player rather than about the world. Grouped, each of them is
      // one line here and one line in `_placeEntities`; scattered across the
      // root, each is another top-level key for the loader to remember to
      // default. Every field is read with a fallback, so a save written before
      // any of them existed loads unchanged.
      player: {
        cell: [c.x, c.y, c.k],
        forward: this.player.forward.toArray(),
        pitch: this.player.pitch,
        health: this.player.health,
        breath: this.breath,
        energy: this.energy,
        character: this.character.id,
        // The left hand — one of the two things the block above was written
        // in anticipation of. It is a fact about the person, not about their
        // bags: `inventory` is what you are carrying, and the offhand is what
        // you are holding. A save from before this existed has no key at all,
        // and `loadOffhand` turns `undefined` into an empty slot.
        offhand: this.inventory.offhandJSON(),
        /**
         * Whether this run is over.
         *
         * Inside `player` rather than at the top level, unlike `difficulty`:
         * how hard the animals hit is a rule of the planet and has to be true
         * of whoever opens it, while this is the plainest possible fact about
         * the person — they died. It is written on every save because
         * `_loseSkills` writes one the moment you die, so the state is on disk
         * before the player has decided anything.
         *
         * Read back through `endsOnDeath` as well as through this flag, so a
         * save that somehow carries it on a normal world loads as an ordinary
         * living planet rather than trapping the player in a spectator they
         * never agreed to.
         */
        dead: this.spectating || (this.state === 'dead' && this.runEnds),
        /**
         * Where your pack is, while any of it is still out there.
         *
         * The pack itself was already saved — a death drop carries `keep`, so
         * `Drops.toJSON` writes it and the pile is on the ground when you come
         * back. The *chip pointing at it* was not, so quitting after a death
         * and returning left an entire inventory lying somewhere on a planet
         * with nothing to say where. Position is stored rather than the cell,
         * because that is what `_paintPackChip` measures the walk from, and
         * `at` because the chip shows how long ago it happened.
         */
        deathSite: this.deathSite
          ? [...this.deathSite.pos.toArray(), this.deathSite.at] : null,
        // The other thing that block was written in anticipation of. Only what
        // cannot be recomputed goes in — levels, marks, the armour conversion —
        // because the rest is a function of `stats` and `playtime`, which are
        // already in this file. See `Skills.toJSON`.
        skills: this.skills.toJSON(),
      },
      inventory: this.inventory.toJSON(),
      drops: this.drops.toJSON(),
      mobs: this.mobs.toJSON(),
      crops: this.farming.toJSON(),
      // Which cells are flowing. Without it the loader cannot tell running
      // water from standing water and calls all of it spring — see the restore
      // in `_loadWorld`. Sources are derived rather than stored, so this is a
      // couple of hundred numbers on a busy planet and empty on a still one.
      water: this.water.toJSON(),
      weather: this.weather.toJSON(),
      kilns: [...this.kilns].map(([key, k]) => ({
        key, c: k.col, k: k.k, in: k.input.toJSON(), fu: k.fuel.toJSON(), out: k.output.toJSON(),
        b: k.burn, bm: k.burnMax, p: k.progress, pm: k.progressMax,
      })),
      // Empty crates are written too, and have to be: an entry existing at all
      // is what records "this one has been dealt with". Drop the empties and a
      // looted worldgen cache would look untouched again on reload and restock
      // itself every time you quit.
      crates: [...this.crates]
        .map(([key, c]) => ({ key, c: c.col, k: c.k, s: c.slots.map((s) => s.toJSON()) })),
      home: this.homeSpawn ? [this.homeSpawn.col, this.homeSpawn.k] : null,
      signs: [...this.signs],
      frozen: [...this.frozen],
      // Flat pairs in a typed array rather than the array of two-element arrays
      // `frozen` gets away with: this table is up to `SNOW_MEMORY` entries and
      // a structured clone of 4 000 little arrays is both fatter on disk and
      // slower to write than 8 000 int32s. 32 KB at the ceiling, and a save
      // that has never seen a winter carries an empty one.
      seasonSnow: this._saveSeasonSnow(),
      hearths: [...this.hearths],
      coreFound: this.coreFound,
      // Null until the sixty-four are found, and absent altogether in every
      // world written before this existed. `Endgame.fromJSON` reads both as the
      // same thing, which is why no version bump goes with this - the save
      // format's convention here is a defaulted key, not a number.
      endgame: this.endgame.toJSON(),
      // Barter uses, on the same terms. Plain JSON by construction - see
      // `newBarterState` - so there is nothing to serialise.
      barter: this.barter,
      // Top level rather than inside `player`: how hard the animals hit is a
      // rule of this planet, not a fact about the person walking on it, and it
      // has to be true of whoever loads it. `Save.write` copies it into the slot
      // summary so the menu can say so without opening the world.
      difficulty: this.difficulty,
      // What has been done on this planet. Beside `stats` for the same reason
      // and under the same convention as `endgame` above: absent in every world
      // written before the record moved out of localStorage, and defaulted on
      // the way back in, so no version bump goes with it.
      achievements: this.achievements.toJSON(),
      loadout: this.loadout,
      // Beside difficulty and for the same reason: what dying costs is a rule of
      // this planet and has to be true of whoever loads it. Not inside `player`,
      // and not inside `player.skills` — the tree reads it, but it is not the
      // tree's to remember.
      deathRule: this.deathRule,
      playtime: this.playtime,
      dayT: +this.dayT.toFixed(5),
      season: this.seasons.toJSON(),
      stats: this.stats,
      biome: this.planet.colBiome[colIndex(c.x, c.y)] ?? 2,
    };
  }

  /**
   * Write the world, and be honest about it.
   *
   * `notify` used to gate the *failure* message as well as the success one, and
   * every automatic caller passes false — the ninety-second autosave, the write
   * on tab-hide, the one after worldgen, and `quitToMenu`. So a save that could
   * not be written said nothing at all: the planet was gone and the only trace
   * was a line in a console the player does not have open. A quiet success is
   * good manners; a quiet failure is the one thing here that cannot be undone.
   *
   * Success stays quiet unless asked. Failure always speaks, but only on the
   * *edge* — the first failure of a run — because the realistic causes (a full
   * disk, a browser quota, private mode) do not clear up on their own, and a
   * toast every ninety seconds is how a warning becomes wallpaper. The chip is
   * what carries the state after that, and it stays up until a write succeeds.
   *
   * @returns {Promise<boolean>} whether the world is now on disk
   */
  async saveGame(notify) {
    if (!this.worldReady) return false;
    // No slot, no write. Every path into a world sets one, so this is a guard
    // against a future path that forgets rather than a state the game reaches —
    // and the failure it prevents is writing somebody else's planet over.
    if (this.saveSlot < 0) return false;
    try {
      await Save.write(this.saveSlot, this._savePayload());
      if (this.saveFailures > 0) {
        // Say so, and only here. Recovery is worth interrupting for precisely
        // because the failure was: someone who has been playing under a red
        // chip needs to know the work since it is now safe.
        this.saveFailures = 0;
        this.ui.setSaveWarning(false);
        this.ui.toast('Saved again, your world is safe');
      } else if (notify) {
        this.ui.toast('Planet saved');
      }
      return true;
    } catch (err) {
      console.error(err);
      const first = this.saveFailures === 0;
      this.saveFailures++;
      // `err.name` is what distinguishes a full disk from a locked database,
      // and it is the one part of an exception worth putting in front of a
      // player. The chip's tooltip carries it; the toast stays plain English.
      const n = this.saveFailures;
      this.ui.setSaveWarning(true, `${n === 1 ? 'The last save failed' : `The last ${n} saves failed`}`
        + `${err?.name ? ` (${err.name})` : ''}. Your world is only in this tab.`);
      if (first || notify) this.ui.toast('Could not save your world');
      // A save warning the player has to be looking at the chip to notice is a
      // save warning they will miss. `saveFail` is three falling sawtooth
      // barks, unmistakably not a confirmation.
      this.audio.saveFail();
      return false;
    }
  }

  // --- edits ----------------------------------------------------------------

  /**
   * Is any of the four tangential neighbours of this cell something that would
   * crowd out a NEEDS_ROOM block standing in it?
   *
   * Reads the world, not the pending edit list, so callers have to run it at the
   * right moment: `_placeBlock` before it commits, `_crushCrowded` after.
   */
  _crowdedAt(col, k) {
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      if (nb < 0) continue;
      const id = this.planet.at(nb, k);
      if (crowds(id, this.planet.facingAt(nb, k))) return true;
    }
    // ...and the corners. "I can't put cacti in left, right, top and bottom but
    // I can place in right top, left top, left bottom and right bottom" — four
    // of the eight cells touching a cactus were refusing it and four were not,
    // which reads as the rule being broken rather than as the rule being about
    // edges. Two cacti meeting at a corner are still spines against spines.
    //
    // `stepColumn` rather than a second `colNeighbor` pass because there is no
    // diagonal in the four-neighbour table; it composes the two steps and wraps
    // them, which is the whole reason not to add x/y by hand.
    for (const [di, dj] of CORNER_STEPS) {
      const nb = stepColumn(col, di, dj);
      if (nb < 0) continue;
      const id = this.planet.at(nb, k);
      if (crowds(id, this.planet.facingAt(nb, k))) return true;
    }
    return false;
  }

  /**
   * Break any cactus these edits have just walled in.
   *
   * Runs *after* the edits are in the world, so a cactus that lost its room to
   * the very block that was placed sees that block. Only cells beside something
   * newly solid are looked at — the whole check is four `at` calls per edit, and
   * a normal edit is one block.
   *
   * It does not recurse: the removals it makes write air, and air crowds
   * nothing. Worth stating because the obvious next hazard — one cactus falling
   * onto another — would, and this would then need a work list rather than one
   * pass. Nothing calls it on chunk load either, which is what keeps a desert
   * that generated two cacti side by side from quietly demolishing itself the
   * first time you walk into render range. Whether worldgen should be spacing
   * them out at all is a question for WorldGen.
   */
  /**
   * Melt snow and ice that lava has just come to rest against.
   *
   * Lava flows - the same simulation water uses, at three cells to water's six
   * - so it arrives beside a snowfield on its own, and a snowbank sitting flush
   * against it unbothered is the one place the world visibly does not believe
   * its own lava. Everything else already treats it as heat: it refuses a
   * cactus, it kills what walks in, it lights the cave it is in.
   *
   * Water is deliberately NOT a melter and this is the whole of why: a snowbank
   * against a cold lake is what a snow biome looks like, and melting on contact
   * would eat every shoreline in the tundra back from the water. Heat melts
   * snow; cold water sits next to it.
   *
   * Snow goes to air rather than to water, and that is a choice with a reason:
   * water quenches lava (source to obsidian, flow to cobblestone), so melting
   * into water would have a glacier meeting a lava lake convert the whole face
   * of it to stone in a cascade. Steam is the honest picture and it leaves the
   * lava alone. ICE is the exception - ice is frozen water and melts back into
   * water, which then quenches, because that is a pond and not a snowfield.
   *
   * Runs after the edits are in the world, on the same terms as
   * `_crushCrowded`, and only over cells beside something newly lava - four
   * `at` calls per edit, and a normal edit is one block.
   */
  _meltSnow(edits) {
    let melted = null;
    for (const e of edits) {
      if (e.id !== ID.lava) continue;
      for (let d = 0; d < 6; d++) {
        const nb = d < 4 ? colNeighbor(e.col, d) : e.col;
        const k = d < 4 ? e.k : (d === 4 ? e.k + 1 : e.k - 1);
        if (nb < 0 || k < 0 || k >= D) continue;
        const id = this.planet.at(nb, k);
        const to = (id === ID.snow || id === ID.snow_brick) ? 0
          : (id === ID.ice || id === ID.packed_ice || id === ID.blue_ice) ? ID.water : -1;
        if (to < 0) continue;
        (melted ??= []).push({ col: nb, k, id: to });
      }
    }
    if (melted) this._applyEdits(melted);
  }

  _crushCrowded(edits) {
    let doomed = null;
    for (const e of edits) {
      if (!crowds(e.id, e.facing ?? 0)) continue;
      for (let d = 0; d < 8; d++) {
        // The same eight cells `_crowdedAt` refuses a placement into, walked in
        // reverse: four edges then four corners. The two halves of one rule
        // have to agree about what "beside" means, or a corner you may not
        // build into is a corner you may wall up afterwards.
        const nb = d < 4 ? colNeighbor(e.col, d)
          : stepColumn(e.col, CORNER_STEPS[d - 4][0], CORNER_STEPS[d - 4][1]);
        if (nb < 0) continue;
        if (!NEEDS_ROOM[this.planet.at(nb, e.k)]) continue;
        const key = cellIdx(nb, e.k);
        if (!doomed) doomed = new Map();
        doomed.set(key, { col: nb, k: e.k, id: this.planet.at(nb, e.k) });
      }
    }
    if (!doomed) return;
    this._breakWhereItStands(doomed.values());
  }

  /**
   * Break a set of cells the world itself condemned, as one edit batch.
   *
   * An ordinary break, minus the tool: each one drops itself, it makes the
   * noise, and the crack overlay never entered into it. Shared by the two rules
   * that condemn blocks — `_crushCrowded` and `_dropUnsupported` — so that a
   * cactus walled in and a cactus with the sand mined out from under it come
   * apart in exactly the same way.
   *
   * @param {Iterable<{col: number, k: number, id: number}>} cells
   */
  _breakWhereItStands(cells) {
    const removals = [];
    const at = new THREE.Vector3();   // not a shared scratch: we are inside a caller's
    for (const c of cells) {
      this.planet.centerOf(c.col, c.k, at);
      for (const d of computeDrops(c.id, null)) this.drops.spawn(at.x, at.y, at.z, d.item, d.count);
      this.audio.break_(BLOCKS[c.id].sound, at);
      removals.push({ col: c.col, k: c.k, id: 0 });
    }
    if (removals.length) this._applyEdits(removals);
  }

  /**
   * Break any NEEDS_FLOOR block these edits have just left standing on nothing,
   * and everything of the same kind stacked on top of it.
   *
   * Runs *after* the whole batch is in the world, like `_crushCrowded` and for a
   * sharper reason: a batch can remove several cells of one column at once (the
   * harness clears five cells over every column of an arena, water floods a
   * trench, a door is two cells). Reading the world mid-batch would make a stack
   * cut in the middle behave differently depending on which order the edits
   * happened to be listed in. Reading it once at the end, the answer is a
   * function of the world, not of the list.
   *
   * Only the cell directly above each edit can have lost its floor, so this is
   * one `at` call for an ordinary edit and a walk up the column only when there
   * really is a plant sitting on what just changed.
   *
   * ---- why it terminates ----
   *
   * `_crushCrowded` argues that it does not recurse at all — its removals write
   * air, and air crowds nothing. This one *does* recurse, so the argument has to
   * be different, and it is a bounded one rather than a hand-wave:
   *
   *  - This pass only ever writes air, and it only ever condemns a cell that
   *    currently holds a NEEDS_FLOOR block. Nothing here writes a NEEDS_FLOOR
   *    block. So every non-empty pass strictly reduces the number of them in a
   *    finite world: the chain cannot be infinite.
   *  - Tighter than that, the depth is at most one. The batch this pass emits is
   *    a contiguous run of air over one column. Re-entering `_applyEdits` with
   *    it, `_crushCrowded` finds nothing (air crowds nothing) and this pass
   *    finds nothing either: for every removed cell the block above is either
   *    another cell of the same run — now air, and air is not NEEDS_FLOOR — or
   *    the block that ended the run, which was not NEEDS_FLOOR to begin with.
   *  - Composed with crushing, the whole thing bottoms out at depth three. A
   *    crush writes air, which can pull a stack down (depth two), whose removals
   *    are the terminating case above (depth three). That bound holds no matter
   *    how many cacti are involved, because a column's run is taken in one go
   *    rather than a segment at a time.
   *
   * Not called on chunk load or save restore, and cannot be: neither goes
   * through `_applyEdits` — a streamed region arrives at `planet.applyRegions`
   * and a save writes `planet.blocks` directly. That is what keeps a generated
   * stack from demolishing itself the first time it comes into range.
   */
  _dropUnsupported(edits) {
    let doomed = null;
    for (const e of edits) {
      const over = this.planet.at(e.col, e.k + 1);
      if (!NEEDS_FLOOR[over]) continue;
      const floor = this.planet.at(e.col, e.k);
      // Two different questions, and this pass only ever asked the first.
      //
      // `supports` is structural: is there a floor at all, and is it the right
      // shape to stand on. `growsOn` is botanical: is it the right *kind* of
      // floor for this particular plant. The second was checked when a player
      // planted (`_place`) and when the generator scattered, and nowhere in
      // between - so nothing re-asked it when the floor itself changed under a
      // plant that was already standing.
      //
      // Reported as: "the moment snow block disappeared and replaced the icecap
      // moss stayed on the replacement block". Icecap moss takes `snow`,
      // `gravel` and `stone` and is refused by `dirt` and `grass`, so a drift
      // is somewhere it may legitimately root - and summer turning that drift
      // into the dirt underneath it left the moss standing on ground its own
      // rule forbids. Any block swapped under any plant did the same; the thaw
      // is only the one nobody had to do by hand.
      //
      // Asked of cross plants alone. `growsOn` answers true for everything with
      // no soil set, so the guard is not needed for correctness, but a rule
      // about what grows where has no business being consulted about a torch.
      const rooted = RENDER_TYPE[over] !== R_CROSS || growsOn(over, floor);
      if (rooted && supports(floor, this.planet.facingAt(e.col, e.k))) continue;
      // The floor is gone, so the whole run resting on it goes: the second
      // segment is held up by nothing but the first. The run ends at the first
      // block that is not NEEDS_FLOOR, which is a block with its own rules about
      // what holds it up (today: none).
      for (let k = e.k + 1; k < D && NEEDS_FLOOR[this.planet.at(e.col, k)]; k++) {
        if (!doomed) doomed = new Map();
        doomed.set(cellIdx(e.col, k), { col: e.col, k, id: this.planet.at(e.col, k) });
      }
    }
    if (!doomed) return;
    this._breakWhereItStands(doomed.values());
  }

  /**
   * Farmland that has just been built over goes back to being dirt.
   *
   * The other half of "a dirt can only be turned to farmland if no block is
   * above it", and the honest reading of it: a rule that only applied at the
   * moment of tilling would be a rule you get around by tilling first and
   * building afterwards, and the field would sit under a stone floor for ever.
   * Reverting is also the cheapest thing to explain — the block you put there is
   * the block that did it, and you can see the soil change under it.
   *
   * **The crop is not destroyed here, and does not need to be.** Roofing
   * farmland means putting a block in the cell the crop occupies, and that cell
   * was a plant: `_placeBlock` replaces it and drops its seeds first, exactly as
   * if you had punched it. A crop is never quietly deleted by this pass, and
   * what the player loses is one wheat's worth of growth they chose to build on.
   * The other direction — a block one cell higher, over a crop that still stands
   * on good farmland — is not a revert at all; the crop simply stops growing.
   * See `Farming.update`.
   *
   * Runs after the batch is in the world for the same reason as `_crushCrowded`,
   * and re-enters `_applyEdits` with its own edits. That terminates at depth
   * one: it writes dirt into the farmland cell, and the only cell it then looks
   * at is the one below *that*, which cannot be farmland — nothing grows under
   * soil.
   *
   * Deliberately not called on chunk load or save restore: neither goes through
   * here (see `_dropUnsupported`), so a field you built a roof over in an older
   * build stays farmland until something near it changes. The growth pause in
   * `Farming.update` is what covers that case.
   */
  _uncoverFarmland(edits) {
    let reverts = null;
    for (const e of edits) {
      // The world, not `e.id`: by now it is the same answer, and the world is
      // the one that stays right if an edit is ever rewritten on the way in.
      if (!roofsSoil(this.planet.at(e.col, e.k))) continue;
      const k = e.k - 1;
      if (k < 0) continue;
      const soil = this.planet.at(e.col, k);
      if (soil !== ID.farmland && soil !== ID.farmland_wet) continue;
      if (!reverts) reverts = new Map();
      reverts.set(cellIdx(e.col, k), { col: e.col, k, id: ID.dirt });
    }
    if (reverts) this._applyEdits([...reverts.values()]);
  }

  _applyEdits(edits) {
    for (const e of edits) {
      // The region this touched is no longer what the generator would make of
      // it. Every block change in the game comes through here, so this is the
      // one place that can know it - and it is the difference between a save
      // that stores the whole world and one that stores the part of it you
      // made. See `_saveBlocks`.
      this.editedRegions.add(regionOfCol(e.col));
      // any change can open a path for water or cut one off
      this.water?.onEdit(e.col, e.k);
      this.planet.setAt(e.col, e.k, e.id);
      // Resolve the facing here so the worker's mirror is told exactly what to
      // store. An edit that carries no facing but writes a directional block
      // (the kiln ⇄ lit-kiln swap) inherits whatever the cell already had.
      const fac = this.planet.applyFacing(e.col, e.k, e.id, e.facing);
      if (fac >= 0) e.facing = fac; else delete e.facing;
      if (e.id === ID.hearth) this.hearths.add(cellIdx(e.col, e.k));
    }
    this.worldWorker.postMessage({ type: 'edit', edits, id: ++this.editSeq });
    // The shadow volume is a copy of what is opaque around the player, and this
    // is the only place a block changes under it. See `_patchOcclusion`.
    this._patchOcclusion(edits);
    // Cheap, and only does anything at all once a hearth exists.
    if (this.hearths.size) this._refreshWards();
    // Last, and as its own edit batch: the block that did the crowding has to be
    // in the world and posted to the worker before the cactus beside it comes
    // down, or the two changes race in the mesher over the same chunk.
    this._crushCrowded(edits);
    this._meltSnow(edits);
    // Then whatever those edits left standing on nothing. After crushing rather
    // than before, so that a segment crushed out of the middle of a stack takes
    // the rest of the column with it — the crush re-enters here with its own
    // removals, and the column comes down on that pass. By the time this line
    // runs for the original batch those cells are already air, so nothing is
    // dropped twice.
    this._dropUnsupported(edits);
    // Then any field these edits have just roofed over.
    this._uncoverFarmland(edits);
    // And finally the sand. Queued rather than done here: see `_seedGravity`.
    this._seedGravity(edits);
  }

  /**
   * Note which cells these edits may have left a sand or gravel block hanging
   * over, for `_settleGravity` to deal with on its own clock.
   *
   * Queued and not settled on the spot, and the reason is a cliff. `_applyEdits`
   * is re-entrant — crushing and unsupported-plant removal both call back into
   * it — and settling here would mean one pick swing at the foot of a dune
   * recursing through every grain above and beside it inside a single call,
   * emitting an edit batch per cell and posting each one to the meshing worker
   * separately. The queue is what turns that into "as much as fits in a tick,
   * as one batch".
   *
   * Two cells per edit can be affected and no others: the cell *above* it, which
   * may have just lost its floor, and the edited cell itself, for a grain you
   * placed in mid-air. A gravity block further up is reached on the next pass,
   * because moving a column re-seeds from its own edits.
   */
  _seedGravity(edits) {
    for (const e of edits) {
      if (HAS_GRAVITY[this.planet.at(e.col, e.k + 1)]) this.falling.add(cellIdx(e.col, e.k + 1));
      if (HAS_GRAVITY[e.id]) this.falling.add(cellIdx(e.col, e.k));
    }
  }

  /**
   * Can a falling block pass through what is in this cell?
   *
   * Air, and a plant, which it flattens on the way past — deliberately the same
   * answer water gives, because a tuft of grass that stops a landslide and a
   * tuft of grass that dams a river are one complaint. `IS_REPLACEABLE` covers
   * every cross plant there is, so the sixteen new ones are in without being
   * named.
   *
   * It is the *whole* set, including the reef, where `Water._canEnter` exempts
   * the submerged plants. The exemption there is specific and does not
   * generalise: coral must survive the sea it grows in, which is a statement
   * about water and not about everything that could ever land on it. A rockfall
   * is not the sea. In practice this never fires — a gravity block will not
   * enter liquid at all (below), and every submerged plant is under some — so
   * the choice costs nothing either way and the narrower rule is the one that
   * can be stated in a sentence.
   *
   * **Liquid is not in here, and that is a decision rather than an oversight.**
   * Minecraft's sand sinks through water; ours lands on it. Sinking would mean
   * a gravity block overwriting a liquid cell, and this sim keeps a *side table*
   * about liquid cells — `Water.sources` — that is keyed by cell and would still
   * be marked long after the sand arrived. Clear that cell later and the water
   * that flowed back in would be read as a spring, which is the one failure mode
   * this whole file is arranged to prevent: a source that was never meant to
   * exist does not drain and floods the planet. Landing on the water is a
   * cosmetic loss; the other is the world.
   */
  _fallsThrough(col, k) {
    const id = this.planet.at(col, k);
    return id === 0 || IS_REPLACEABLE[id] === 1;
  }

  /**
   * Sand falls.
   *
   * `gravity` has been declared on sand, gravel and red sand since the block
   * table was first written and nothing has ever read it, so mining under a dune
   * left the dune hanging — the reported "blocks not being affected by gravity
   * like sand, gravel and among other things".
   *
   * ---- the whole column, in one move ----
   *
   * A block does not fall one cell per tick, and it must not: a column settled a
   * cell at a time is a column that is briefly *broken apart*, with gaps between
   * grains that the player can see and walk into, and every intermediate state
   * is an edit batch and a remesh of the same chunk. So a settle finds where the
   * bottom grain lands, takes the whole contiguous run of gravity blocks stacked
   * on it, and rewrites the run at its destination in a single batch: clears
   * first, writes second, which is safe because the destination of the run is
   * strictly below where it started and the clears therefore cover every cell a
   * write could land in.
   *
   * ---- it cannot fall out of the world ----
   *
   * `dest > 0` in the scan. Layer 0 is the innermost shell of the planet and
   * there is nothing under it; a grain that reached it would be written to k=-1,
   * which `Planet.setAt` silently discards — the block would simply cease to
   * exist. The guard stops the scan *at* layer 0, so the worst case is a grain
   * resting on the floor of the world.
   *
   * ---- the budget ----
   *
   * `GRAVITY_PER_TICK` columns per tick at `GRAVITY_TICK` seconds, so **256
   * column-settles every 0.1s**, whatever the size of the collapse. A settle is
   * one downward scan bounded by D (99) plus its own edits, so a full tick is
   * about twenty-five thousand array reads and one batch posted to the worker —
   * the same order as a water tick, which is budgeted at 900 cells. A cliff of
   * ten thousand columns comes down over four seconds instead of stalling a
   * frame, and it comes down from the bottom outward because the queue is
   * drained in insertion order.
   *
   * Anything left over stays queued. Nothing is ever dropped from the queue: a
   * grain silently declining to fall is the bug this method exists to remove,
   * and it would be indistinguishable from it.
   */
  /**
   * Land whatever has finished falling.
   *
   * Kept as a flat list with a clock on each entry rather than a queue keyed by
   * time: a run is a handful of blocks at most and they all land together, so
   * the sort a priority queue would buy is a sort of one thing.
   *
   * The placement goes through `_applyEdits` like every other block change, so
   * lighting, meshing and the gravity queue all hear about it the ordinary way -
   * including the case where the ground moved while the block was in the air
   * and it now has further to go.
   */
  _tickSettling(dt) {
    if (this._settling.length === 0) return;
    const edits = [];
    for (let n = this._settling.length - 1; n >= 0; n--) {
      const e = this._settling[n];
      e.t -= dt;
      if (e.t > 0) continue;
      this._settling.splice(n, 1);
      // Only into air. Anything that arrived in the meantime - a block placed,
      // water flowed in - keeps the cell, and the grain is simply gone.
      if (this.planet.at(e.col, e.k) === 0) edits.push({ col: e.col, k: e.k, id: e.id });
    }
    if (edits.length) this._applyEdits(edits);
  }

  _settleGravity() {
    if (this.falling.size === 0) return;
    const edits = [];
    let budget = GRAVITY_PER_TICK;
    for (const key of this.falling) {
      if (budget-- <= 0) break;
      this.falling.delete(key);
      cellDecode(key, _kd);
      const col = _kd.col, k = _kd.k;
      const id = this.planet.at(col, k);
      // The queue is a list of suspicions, not of facts: the cell may have been
      // mined, replaced or already settled by an earlier entry in this very
      // pass.
      if (!HAS_GRAVITY[id]) continue;

      let dest = k;
      while (dest > 0 && this._fallsThrough(col, dest - 1)) dest--;
      if (dest === k) continue;

      // Everything of the same nature stacked directly on top comes with it —
      // the run ends at the first cell that is not a gravity block, which is a
      // block with its own rules about what holds it up.
      let top = k;
      while (top + 1 < D && HAS_GRAVITY[this.planet.at(col, top + 1)]) top++;

      const run = [];
      for (let s = k; s <= top; s++) run.push(this.planet.at(col, s));
      for (let s = k; s <= top; s++) edits.push({ col, k: s, id: 0 });

      /**
       * The run leaves now and arrives later, which is the whole of the
       * falling animation.
       *
       * Both edits used to land on the same frame, so a collapsing dune
       * blinked from one place to another - the owner: "sand has no falling
       * animation it just blinks". Emptying the old cells immediately and
       * filling the new ones after the fall gives the eye something to follow,
       * and a cube per block is drawn down the shaft in between.
       *
       * The gap is real: the blocks genuinely do not exist while they fall, so
       * you can walk under a collapse. That is what a falling block is.
       */
      const drop = k - dest;
      const secs = Math.min(FALL_MAX_SECONDS, Math.sqrt(2 * drop / GRAVITY));
      for (let n = 0; n < run.length; n++) {
        this.planet.centerOf(col, k + n, _fallPos);
        this.particles.fallingBlock(_fallPos, this.player.up, BLOCKS[run[n]].particle, secs);
        this._settling.push({ col, k: dest + n, id: run[n], t: secs });
      }
    }
    // One batch for the whole tick. `_applyEdits` re-seeds the queue from these
    // edits, so whatever the move exposed — a grain above the run, a plant that
    // lost its floor — is picked up on the next pass rather than recursed into
    // now.
    if (edits.length) this._applyEdits(edits);
  }

  /**
   * Facing for a directional block placed at (col, k): the front turns to meet
   * the player. Resolved on the world axes, which is the only frame there is.
   * @returns {number} 0:+x 1:-x 2:+y 3:-y, on the map
   */
  /**
   * Axis for a log from the face it was placed against: 0 upright, 1 along
   * world X, 2 along world Z. A log laid against a wall should lie down, showing its cut ends
   * on the two faces the trunk runs through — placing one sideways and getting
   * an upright block is the thing that reads as the game ignoring you.
   *
   * Crouching overrides the face and lays the log along the way you are facing.
   *
   * The face rule on its own is correct and is the one Minecraft uses, but on a
   * planet it is close to unusable: you are almost always standing on flat
   * ground clicking the *top* of something, which is the one face that means
   * upright. The reported symptom was "the log always points up and I can't
   * make it face sideways", and that is exactly right — with nothing tall
   * nearby there is no vertical face to click, so you have to build a pillar
   * just to lay one log down. Holding crouch is the standard modifier for
   * "I mean this literally", it costs no new binding, and it leaves the face
   * rule intact for everyone already using it.
   */
  _axisFromFace(hit, col, k) {
    if (this.player.crouching) {
      const d = this.player.lookDir;
      return Math.abs(d.x) >= Math.abs(d.z) ? 1 : 2;
    }
    // The face normal is the step from the block hit to the cell being filled.
    if (hit.col === col) return 0;                 // stacked above or below
    const a = this.planet.centerOf(col, k, _v2);
    const b = this.planet.centerOf(hit.col, hit.k, _v3);
    const da = Math.abs(wrapDelta(a.x - b.x));
    const db = Math.abs(wrapDelta(a.z - b.z));
    const up = Math.abs(a.y - b.y);
    if (up >= da && up >= db) return 0;
    return da >= db ? 1 : 2;
  }

  /**
   * Which half of its cell a slab should fill: 0 lower, 1 upper.
   *
   * Placing onto the underside of something wants the upper half, placing onto
   * a top face wants the lower half, and placing against a wall is decided by
   * which half of that face was clicked — the same rule Minecraft uses, and the
   * only one that lets you build a run of steps without turning around.
   */
  /**
   * Which half of `col,k` a slab placement should fill: 1 upper, 0 lower.
   *
   * `aim` forces the aim-point test below. The stacked shortcut answers "was
   * the block I hit above the cell I am filling?", which is right when those
   * are two different cells and meaningless when they are the same one - and
   * the merge asks about the hit's OWN cell, so it read `hit.k > hit.k`, false
   * every time. That pinned `adding` to 0, so a second slab could never differ
   * from a lower slab already there and the merge never fired: the slab went
   * into the cell above and left the half-block gap the owner reported. It
   * fired only on an upper slab, which is the rarer half of the case.
   */
  _slabHalf(hit, col, k, aim = false) {
    if (!aim && hit.col === col) return hit.k > k ? 1 : 0;   // stacked: fill the near half
    // Side placement: compare the aim point with the cell's mid-height.
    return (hit.point ?? this.player.eye).y > k + 0.5 ? 1 : 0;
  }

  /**
   * A stair's packed orientation: bits 0-1 the direction its low side faces,
   * bit 2 set when it hangs from a ceiling.
   *
   * The low side points *away* from the player, so walking forward and placing
   * builds a flight going up ahead of you rather than a wall of risers facing
   * back. Upside-down follows the same rule slabs use — which half of the face
   * you clicked.
   */
  _stairOrient(hit, col, k) {
    // The low side faces the player. "Stairs isn't behaving like in minecraft,
    // placing them is confusing": it used to face *away*, so the tall riser
    // landed against you and the first thing you built was a wall you could not
    // step onto - you had to walk round your own staircase to use it.
    //
    // Minecraft puts the low step on the side you placed from, which is what
    // makes "stand still, place, walk forward" build a flight you ascend. The
    // whole of the fix is dropping the flip that was here.
    return this._facingToward(col, k) | (this._slabHalf(hit, col, k) ? 4 : 0);
  }

  /**
   * Open the little writing panel for a sign, and store whatever comes back.
   *
   * Pointer lock has to go while the field has focus — typing "w" into a locked
   * canvas walks you forward instead — so this runs as a modal like the pause
   * screen, and restores the lock on the way out.
   */
  _writeSign(col, k) {
    const key = cellIdx(col, k);
    const el = document.getElementById('sign-write');
    const input = document.getElementById('sign-line');
    if (!el || !input) return;
    this.state = 'paused';
    this.input.exitLock();
    el.classList.remove('hidden');
    input.value = this.signs.get(key) ?? '';
    setTimeout(() => { input.focus(); input.select(); }, 30);

    const finish = (save) => {
      el.classList.add('hidden');
      document.getElementById('sign-ok').onclick = null;
      document.getElementById('sign-cancel').onclick = null;
      input.onkeydown = null;
      if (save) {
        const text = input.value.trim().slice(0, 48);
        if (text) this.signs.set(key, text);
        else this.signs.delete(key);
        this.signSeq++;
        this.audio.ui(620);
      }
      this.state = 'playing';
      this.input.requestLock();
    };
    document.getElementById('sign-ok').onclick = () => finish(true);
    document.getElementById('sign-cancel').onclick = () => finish(false);
    input.onkeydown = (e) => {
      e.stopPropagation();
      // Enter breaks a line, because the field is four lines and the break is
      // part of what is being written. Ctrl+Enter carves, so the keyboard can
      // still finish without reaching for the button.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      // ...and refuse a fifth line. The field shows four and does not scroll,
      // and the board carves four, so a fifth would be typed where the player
      // cannot see it and then not appear on the sign either.
      else if (e.key === 'Enter' && input.value.split('\n').length >= 4) e.preventDefault();
      if (e.key === 'Escape') finish(false);
    };
  }

  /**
   * The cells of the swinging thing you clicked: two for a door, one for a
   * gate. A gate is one cell tall, so it is its own only half — which is the
   * whole of the difference and is why the swing below is shared rather than
   * copied.
   * **Paired from the foot of the run, not from the cell below.** "Is there a
   * door under me, so I must be a top half" is only true while doors do not
   * touch, and nothing stops them: a door is not `NEEDS_FLOOR`, so the only
   * placement rule it has is that the cell above is air, and the cell above a
   * door's top half always is. Stack two in a doorway — doors at k=10..11 and
   * k=12..13 — and the old test read the *lower* half of the upper door as an
   * upper half, pairing one cell of each door:
   *
   *     click k=10  ->  [10, 11]   the lower door, right
   *     click k=11  ->  [10, 11]   the lower door, right
   *     click k=12  ->  [11, 12]   half of each, WRONG
   *     click k=13  ->  [12, 13]   half of each, WRONG
   *
   * Which mints doors and eats blocks. Break at k=12 and the game takes down 11
   * and 12 and hands back one door, leaving orphans at 10 and 13; breaking the
   * orphan at 10 pairs [10, 11] and pays a second door, and breaking the orphan
   * at 13 sees no door beneath it, claims [13, 14], and clears whatever was
   * standing at 14 with no drop at all. Two doors in, three doors out, and the
   * block above them gone. `_toggleDoor` swings the same mispaired cells, so a
   * stack of two also opened as two staggered halves.
   *
   * Walking down to the foot of the contiguous run and pairing off it is exact
   * for any number of stacked doors, because every door in a run is two cells
   * and the run therefore alternates bottom, top, bottom, top from its base.
   *
   * @returns {number[]|null} the k values, low first
   */
  _doorHalves(col, k) {
    const id = this.planet.at(col, k);
    if (IS_GATE[id]) return [k];
    if (!IS_DOOR[id]) return null;
    let base = k;
    while (base > 0 && IS_DOOR[this.planet.at(col, base - 1)]) base--;
    const bottom = k - ((k - base) & 1);
    // The lone half is a world already broken — a save from before this, or a
    // crater through a doorway. Answering with the one cell that is really a
    // door beats claiming a neighbour that is not.
    return bottom + 1 < D && IS_DOOR[this.planet.at(col, bottom + 1)]
      ? [bottom, bottom + 1] : [bottom];
  }

  /** Swing a door or a gate, and refuse if you are standing in it. */
  _toggleDoor(col, k) {
    const halves = this._doorHalves(col, k);
    if (!halves) return;
    const id = this.planet.at(col, halves[0]);
    const byte = this.planet.facingAt(col, halves[0]);
    const next = byte ^ 4;
    // Closing a door onto yourself would leave the leaf inside your own box and
    // the escape solve would shove you through the wall.
    if (!((next >> 2) & 1)) {
      for (const kk of halves) if (this._intersectsPlayer(col, kk)) return;
    }
    this._applyEdits(halves.map((kk) => ({ col, k: kk, id, facing: next })));
    // Bit 2 of the facing byte is the leaf's state, and it is the one the guard
    // above already reads to decide whether this swing could trap you. Both
    // halves of a door used to be `place('wood')`, so the one block in the game
    // with two states was the one block whose state you could not hear.
    this.audio.door(!!((next >> 2) & 1), this.planet.centerOf(col, halves[0], _v1));
    this.player.swing();
    this.viewModel.punch();
  }

  /**
   * Which wall a ladder hangs on: the one you clicked.
   *
   * A ladder is directional, but not in the way everything else is — the others
   * turn to face the player, and a ladder has to fix itself to the surface the
   * placement ray landed on, or it ends up floating in the middle of the shaft
   * with its back to the rock.
   */
  _ladderFacing(hit, col, k) {
    if (hit.col === col) return this._facingToward(col, k) ^ 1;   // no wall: face outward
    // Facing 0..3 is +x, -x, +y, -y on the map, which is TORCH_WALL_STEP's
    // order. `wrapDelta` because the two cells may be a whole map apart in
    // plain subtraction and one step apart in fact.
    const a = this.planet.centerOf(hit.col, hit.k, _v2);
    const b = this.planet.centerOf(col, k, _v3);
    const da = wrapDelta(a.x - b.x), db = wrapDelta(a.z - b.z);
    if (Math.abs(da) >= Math.abs(db)) return da > 0 ? 0 : 1;
    return db > 0 ? 2 : 3;
  }

  /**
   * Which way a torch goes in: 0 stood on the ground, 1 + facing bracketed to
   * that wall. See R_TORCH.
   *
   * Clicking the top of a block stands one up; clicking the side of one hangs
   * it there, which is the whole point — a shaft you are digging has walls long
   * before it has a floor worth standing a torch on.
   */
  _torchFacing(hit, col, k) {
    if (hit.col === col) return 0;              // hit the floor below: stand it up
    return 1 + (this._ladderFacing(hit, col, k) & 3);
  }

  /**
   * A sign's byte: which way the writing faces, and whether it hangs on a wall.
   *
   * Same shape as `_torchFacing` and for the same reason - the face you
   * clicked is the whole of the intent. Click the side of a block and the sign
   * is nailed to it, reading away from it. Click the ground, or anything else,
   * and it stands on its post facing you, which is what every sign did before
   * walls were an option.
   */
  _signFacing(hit, col, k) {
    if (!hit || hit.col === col) return this._facingToward(col, k) & 3;
    // `_ladderFacing` points AT the wall; a sign reads away from the one it is
    // nailed to, so the writing is the opposite of the ladder's answer.
    return ((this._ladderFacing(hit, col, k) & 3) ^ 1) | SIGN_WALL;
  }

  /**
   * Is there anything for a sign in this cell, with this byte, to hold on to?
   *
   * `stepColumn` wraps, so the wall a sign is nailed to is found the same way
   * at the far edge of the map as anywhere else.
   */
  _signSupported(col, k, byte) {
    if (!(byte & SIGN_WALL)) return this.planet.solidAt(col, k - 1);
    // The wall is behind the writing, so step the opposite way to the facing.
    const wall = stepColumn(col, ...TORCH_WALL_STEP[((byte & 3) ^ 1) & 3]);
    return this.planet.solidAt(wall, k);
  }

  /** Is there anything for a torch in this cell, facing this way, to hold on to? */
  _torchSupported(col, k, byte) {
    if (byte === 0) return this.planet.solidAt(col, k - 1);
    const wall = stepColumn(col, ...TORCH_WALL_STEP[(byte - 1) & 3]);
    return this.planet.solidAt(wall, k);
  }

  _facingToward(col, k) {
    // block -> player, flattened onto the ground plane
    const b = this.planet.centerOf(col, k, _v2);
    const da = wrapDelta(this.player.eye.x - b.x);
    const db = wrapDelta(this.player.eye.z - b.z);
    if (Math.abs(da) < 1e-6 && Math.abs(db) < 1e-6) return FACING_DEFAULT;
    if (Math.abs(da) >= Math.abs(db)) return da >= 0 ? 0 : 1;
    return db >= 0 ? 2 : 3;
  }

  /**
   * Hand back whatever a cell was holding, and forget it ever held it.
   *
   * Three blocks in the game own state that is not in the block array — a kiln's
   * three slots, a crate's twenty-seven, a sign's line of text — and all three
   * live in maps keyed by cell. `_applyEdits` is the one door every block change
   * comes through, and it knows nothing about those maps: emptying them was
   * written inline in `_breakBlock`, which is only one of the ways a cell can
   * stop being a crate.
   *
   * The other way shipped with the cinderling. `Explosion.explode` builds its
   * crater and calls `_applyEdits` straight, so a blast through a storeroom
   * turned every crate in it to air with the contents still in the map: the
   * items were gone from the world, gone from the ground, and still on disk,
   * because `_savePayload` writes `crates` by key and the key no longer had a
   * crate over it. Place a new crate on the same cell later and `_place` finds
   * the entry already there, leaves it alone, and the old contents are back.
   * So: eaten, then duplicated. A kiln mid-smelt lost its ore, its fuel and its
   * ingots the same way.
   *
   * Extracted rather than copied so the blast and the pick can never drift.
   *
   * @param {number} col
   * @param {number} k
   * @param {number} id what is standing there now
   * @param {THREE.Vector3} center where to put what comes out
   */
  _emptyContainer(col, k, id, center) {
    const key = cellIdx(col, k);
    const kiln = this.kilns.get(key);
    if (kiln) {
      for (const s of [kiln.input, kiln.fuel, kiln.output]) {
        if (!s.empty) this.drops.spawn(center.x, center.y, center.z, s.item, s.count, s.wear);
      }
      this.kilns.delete(key);
      if (this.ui.screen === 'kiln' && this.ui.kiln === kiln) this.closeScreen();
    }

    if (IS_SIGN[id]) { this.signs.delete(key); this.signSeq++; }

    // `_crateAt`, not `.get` — a worldgen cache you break without opening still
    // has to hand over its contents.
    const crate = id === ID.crate ? this._crateAt(col, k) : null;
    if (crate) {
      // Everything comes back out. Silently eating a full crate of ore because
      // you mis-clicked would be the single worst thing this game could do.
      for (const s of crate.slots) {
        if (!s.empty) this.drops.spawn(center.x, center.y, center.z, s.item, s.count, s.wear);
      }
      this.crates.delete(key);
      if (this.ui.screen === 'crate' && this.ui.crate === crate) this.closeScreen();
    }
  }

  _breakBlock(hit) {
    const b = BLOCKS[hit.id];
    if (b.hardness < 0 || hit.id === ID.core) return;
    // `held()` — the main hand, always, however empty it is.
    //
    // This used to be `active()`, which hands the job to the offhand when the
    // main hand is empty, and that is the one place the fall-through rule does
    // not belong. Minecraft's left button is the main hand's and nothing else's:
    // an empty right fist punches wood at fist speed with a pickaxe in the left,
    // and the pickaxe neither speeds the dig, nor changes the drop, nor takes
    // the wear. Anything else makes the left hand a second toolbelt you never
    // asked for — park a diamond pick there, clear the hotbar slot, and you were
    // mining with it by accident. The three answers a break needs (the timer,
    // the drop table, the durability) all come off this one line and its two
    // siblings in `_interact`, so they cannot disagree about which hand dug.
    const heldDef = ITEMS[this.inventory.held().item];
    const center = this.planet.centerOf(hit.col, hit.k, new THREE.Vector3());

    const edits = [{ col: hit.col, k: hit.k, id: 0 }];

    // A door is one object in two cells: break either half and the whole thing
    // comes down, or you are left with half a door hanging in the wall.
    if (IS_DOOR[hit.id]) {
      const halves = this._doorHalves(hit.col, hit.k);
      if (halves) for (const kk of halves) {
        if (kk !== hit.k) edits.push({ col: hit.col, k: kk, id: 0 });
      }
    }

    // whatever was resting on top falls with it
    const above = this.planet.at(hit.col, hit.k + 1);
    if (RENDER_TYPE[above] === R_CROSS) {
      edits.push({ col: hit.col, k: hit.k + 1, id: 0 });
      const ac = this.planet.centerOf(hit.col, hit.k + 1, _v2);
      for (const d of computeDrops(above, heldDef)) this.drops.spawn(ac.x, ac.y, ac.z, d.item, d.count);
    }

    for (const d of computeDrops(hit.id, heldDef)) {
      this.drops.spawn(center.x, center.y, center.z, d.item, d.count);
    }

    this._emptyContainer(hit.col, hit.k, hit.id, center);

    this._applyEdits(edits);
    // No burst of little cubes here any more. The crack overlay already draws
    // the whole break — it grows across the face for the entire dig and the
    // block vanishing is its last frame — so the particles were a second
    // announcement of a thing the player had just watched happen, and they were
    // the noisier of the two.
    //
    // `Particles.blockBreak` went with the call: it had no other caller, and an
    // unreachable method reads as a live one to everybody who meets it later.
    // Footsteps, embers and bubbles have their own methods and are untouched.
    this.audio.break_(b.sound, center);
    this.stats.mined++;
    // The seam, not the drop. A deep coal seam and an ordinary one both give
    // coal, so the eighteen ores would collapse to twelve if this counted what
    // came out. See `ORE_BLOCKS`.
    this.achievements.mined(hit.id);
    // The first offence on Verdant: mining anything that is not wood, in sight
    // of one of the fourteen. Only the ones who saw it turn - `witnessMine`
    // owns both halves of that, and it answers 0 off `Folk.isTaboo` for a
    // trunk or a leaf, so this line is unconditional here rather than being a
    // face test the wrong way round. Placed with the other tallies because
    // this is the same moment they are: `hit.id` is what was there, before the
    // cell became air.
    this.mobs.witnessMine(hit.id, this.player);
    // `this.skills.xpMine(b)` stood here and paid by ore tier. Mining pays no xp
    // at all now: the ladder is fed by kills alone, and the counter above is the
    // only record breaking a block leaves. See the head of `Skills.js`.
    // Ripe wheat only. Breaking a green shoot is losing a crop, not harvesting
    // one, and marking it would teach exactly the wrong lesson about farming.
    this.player.swing();
    // `'right'` explicitly: `ViewModel.actingHand` derives the arm from what is
    // in the two fists — right unless it is empty and the left is not — which is
    // `active()`'s rule, and mining no longer follows it. Without this an empty
    // main hand and a torch in the left would swing the *left* arm to break a
    // block the left hand had nothing to do with.
    this.viewModel.punch('right');
    if (heldDef?.tool && b.hardness > 0.15) this.inventory.damageHeld(1, this.inventory.held());
  }

  /**
   * @param hit the cell under the crosshair
   * @param {Slot} [held] the hand doing it. The right-button chain resolves this
   *   once (see `_hasUse`) and passes it in, so a torch placed out of the
   *   offhand while the main hand holds a pickaxe comes off the torch.
   */
  _placeBlock(hit, held = this.inventory.held()) {
    const def = ITEMS[held.item];
    if (!def || def.block === undefined) return false;
    const id = def.block;
    // Nothing is fixed to a cactus.
    //
    // It is spines on every side, which is the whole of its NEEDS_ROOM rule,
    // and a torch bracketed to one is the same picture that rule already
    // refuses from the other direction - the cactus would simply come apart the
    // moment the torch landed beside it. Better to decline the click than to
    // take the plant down as the answer.
    //
    // Refused at the SUPPORT rather than at the destination, because the two
    // are different cells and it is the surface being built against that is the
    // problem: a torch on its side, a sign, a ladder, a block stood on its
    // crown. Another cactus is the one thing allowed, because a cactus grows
    // out of its own lower segments and that is how a tall one exists at all.
    if (this.planet.at(hit.col, hit.k) === ID.cactus && id !== ID.cactus) {
      return false;
    }
    // Where the block goes. Normally the cell the ray was in just before it hit
    // something — you build *against* a face — but a cell holding a plant is not
    // a face to build against, it is a cell to build *in*. See IS_REPLACEABLE.
    //
    // This is the whole of "grass won't let me put a block where it's standing".
    // The old line refused nothing and that is why the report is confusing: the
    // placement *succeeded*, just not where you aimed. Standing on a meadow and
    // clicking the tuft in front of you, the ray stops in the tuft, so the cell
    // before it is the air beside your own head — the block landed floating at
    // eye height, or, when that cell was your own, `_intersectsPlayer` ate the
    // click and nothing happened at all. Either way the tuft was still there and
    // the block was not where you put it. Aiming at a plant now fills the
    // plant's own cell and the plant is gone, which is Minecraft's rule and the
    // one every player already has in their hands.
    const replacing = IS_REPLACEABLE[hit.id] === 1;
    if (!replacing && hit.prevCol < 0) return false;
    // Two slabs of one stone make the stone. "Slabs can't be placed above each
    // other to form a plank like in minecraft - placing one above another just
    // leaves a wide slab height space between them": the second slab went into
    // the next cell up, because that is where the ray was before it hit, so you
    // got two half blocks with a half block of air between them and no way to
    // make a solid course out of a stack of slabs.
    //
    // A slab is named `slab_<base>` where the base is its own full block, so
    // the merge needs no table: it is the aimed cell, the same material, and
    // the half you clicked being the empty one. Only then, and the cell becomes
    // the full block rather than a second slab going somewhere else.
    if (IS_SLAB[id] && !replacing) {
      const there = this.planet.at(hit.col, hit.k);
      if (IS_SLAB[there] && there === id) {
        const full = ID[BLOCKS[id].name.slice(5)];
        const filled = this.planet.facingAt(hit.col, hit.k) & 1;   // 1 upper, 0 lower
        // : ask which half was AIMED at, not the stacked shortcut, which
        // is degenerate when the hit cell and the target cell are the same.
        const adding = this._slabHalf(hit, hit.col, hit.k, true);
        if (full && adding !== filled) {
          this._applyEdits([{ col: hit.col, k: hit.k, id: full }]);
          this.audio.place(BLOCKS[full].sound,
            this.planet.centerOf(hit.col, hit.k, new THREE.Vector3()));
          held.count--;
          if (held.count <= 0) held.clear();
          this.inventory.changed();
          this.player.swing();
          this.viewModel.punch(this._handOf(held));
          return true;
        }
      }
    }
    const col = replacing ? hit.col : hit.prevCol;
    const k = replacing ? hit.k : hit.prevK;
    if (k < 0 || k >= D) return false;
    const existing = this.planet.at(col, k);
    if (existing !== 0 && RENDER_TYPE[existing] !== R_LIQUID && RENDER_TYPE[existing] !== R_CROSS) return false;
    // A liquid cell counts as free space above — which is right for a wall, and
    // is how you dam a river — but not for a flame or a stem. See `DROWNS`.
    if (DROWNS[id] && RENDER_TYPE[existing] === R_LIQUID) {
      return false;
    }
    // ...and the reef, which is the same rule pointing the other way: coral,
    // kelp, sea grass, sponges and clams may *only* go into water.
    //
    // The second half of it is not fussiness, it is the ocean's surface. A
    // column's topmost water cell is the one that owns the quad you see the sea
    // as, and a plant standing in that cell replaces the water — so the sea
    // gets a one-block hole in it that you can look down through from the
    // shore. Requiring water overhead costs the player nothing (a reef belongs
    // under the surface anyway) and makes the hole unreachable. Worldgen is
    // asked for the same discipline; see the note above IS_SUBMERGED.
    if (IS_SUBMERGED[id]) {
      if (RENDER_TYPE[existing] !== R_LIQUID) {
        return false;
      }
      if (RENDER_TYPE[this.planet.at(col, k + 1)] !== R_LIQUID) {
        return false;
      }
    }
    if (IS_SOLID[id] && this._intersectsPlayer(col, k)) return false;
    if (RENDER_TYPE[id] === R_CROSS && !this.planet.solidAt(col, k - 1)) return false;
    // A torch needs something to stand on or hang from, and which of those it
    // is depends on the face you clicked.
    let torchByte = 0;
    if (IS_TORCH[id]) {
      torchByte = this._torchFacing(hit, col, k);
      if (!this._torchSupported(col, k, torchByte)) {
        // Fall back to standing it up if the wall it was aimed at is not there,
        // rather than silently eating the click.
        torchByte = 0;
        if (!this._torchSupported(col, k, 0)) {
          return false;
        }
      }
    }

    // A sign hangs on the wall you clicked or stands on its post, and it falls
    // back the same way a torch does rather than eating the click: aim at a
    // wall that is not there and you get the post sign, and only if there is
    // no ground either does the placement refuse.
    let signByte = 0;
    if (IS_SIGN[id]) {
      signByte = this._signFacing(hit, col, k);
      if (!this._signSupported(col, k, signByte)) {
        signByte = this._facingToward(col, k) & 3;
        if (!this._signSupported(col, k, signByte)) return false;
      }
    }

    // A cactus will not stand beside anything. Refusing the placement is the
    // half of the rule the player can see coming; the other half — a wall built
    // up against one already in the ground — is in `_applyEdits`, because that
    // is the funnel every block change goes through and a rule enforced in only
    // one of the two places is a rule with a trivial workaround.
    if (NEEDS_ROOM[id] && this._crowdedAt(col, k)) {
      return false;
    }

    // And it will not stand on nothing. Same two-halves shape as the rule above:
    // placement refuses it here, and `_dropUnsupported` breaks one whose floor
    // is taken away later. Without this half you can hang a cactus in mid-air by
    // placing it against the side of a block, and the only rule that would ever
    // look at it again is the one that fires when a *neighbouring* cell changes
    // — so it would stay there for good. Refusing is better than letting it land
    // and immediately fall: a placement that undoes itself reads as a dropped
    // input rather than as a rule.
    if (NEEDS_FLOOR[id] && !supports(this.planet.at(col, k - 1), this.planet.facingAt(col, k - 1))) {
      return false;
    }

    // ...and it will not grow in the wrong ground. The rule above is structural
    // — is there a surface here — and it admits gravel, bare stone, glass and
    // the top of a fence, which is exactly how the world came to have tall
    // grass growing in scree. `growsOn` is the botanical half, and it lives in
    // `Blocks.js` precisely so that this and `WorldGen`'s placement passes read
    // the same table: a rule the generator obeys and the player can plant
    // straight past is not a rule, it is a suggestion with a workaround.
    //
    // `growsOn` returns true for anything with no soil set, so this line is
    // inert for every block that is not a plant.
    if (!growsOn(id, this.planet.at(col, k - 1))) {
      return false;
    }

    // A door is two cells tall, so it needs the headroom before anything else.
    if (IS_DOOR[id]) {
      if (k + 1 >= D || this.planet.at(col, k + 1) !== 0) {
        return false;
      }
      if (this._intersectsPlayer(col, k + 1)) return false;
    }

    // The plant that was standing here comes apart, and it hands over whatever
    // it would have given you if you had punched it — a sapling, some seeds, an
    // amethyst off a crystal cluster. Building over a lingonberry patch should
    // not be a quieter way of destroying it than walking up and hitting it, and
    // "I lost the berries because I put a fence post there" is exactly the kind
    // of silent loss this codebase already refuses for a crate.
    if (existing !== 0 && IS_REPLACEABLE[existing]) {
      const at = this.planet.centerOf(col, k, new THREE.Vector3());
      for (const d of computeDrops(existing, null)) this.drops.spawn(at.x, at.y, at.z, d.item, d.count);
      this.audio.break_(BLOCKS[existing].sound, at);
    }

    const edit = { col, k, id };
    if (IS_TORCH[id]) edit.facing = torchByte;
    else if (IS_LADDER[id]) edit.facing = this._ladderFacing(hit, col, k);
    else if (IS_SIGN[id]) edit.facing = signByte;
    else if (IS_DOOR[id]) edit.facing = this._facingToward(col, k) & 3;
    else if (IS_DIRECTIONAL[id]) edit.facing = this._facingToward(col, k);
    else if (IS_AXIS[id]) edit.facing = this._axisFromFace(hit, col, k);
    else if (IS_SLAB[id]) edit.facing = this._slabHalf(hit, col, k);
    else if (IS_STAIR[id]) edit.facing = this._stairOrient(hit, col, k);
    // Both halves carry the same byte, so whichever one you later click or
    // break can answer for the whole door without looking for its other half
    // first.
    this._applyEdits(IS_DOOR[id]
      ? [edit, { col, k: k + 1, id, facing: edit.facing }]
      : [edit]);
    // Register a placed crate as empty straight away. An absent entry is the
    // marker for "worldgen put this here", so a crate you set down yourself
    // would otherwise fill itself with treasure the first time you opened it.
    if (id === ID.crate) {
      const key = cellIdx(col, k);
      if (!this.crates.has(key)) {
        this.crates.set(key, {
          slots: Array.from({ length: CRATE_SLOTS }, () => new Slot()), col, k,
        });
      }
    }
    this.inventory.consumeHeld(1, held);
    this.audio.place(BLOCKS[id].sound, this.planet.centerOf(col, k, _v1));
    // Over the top of the tap, not instead of it: the tap is the stick meeting
    // stone and the flame is the reason you did it. Light is the resource the
    // night in this game is actually about, which is what makes this the one
    // placement out of two hundred worth confirming by ear. `_v1` is safe to
    // hand over twice — `_dest` reads x/y/z straight into the panner.
    if (IS_TORCH[id]) this.audio.torchLight(_v1);
    this.stats.placed++;
    this.player.swing();
    // The arm that put it down — the left one when the torch came out of the
    // offhand, which is the whole point of being able to place from there.
    this.viewModel.punch(this._handOf(held));
    return true;
  }

  _intersectsPlayer(col, k) {
    const c = this.planet.centerOf(col, k, _v1);
    for (const h of [0.28, 0.9, 1.55]) {
      _v2.copy(this.player.position).addScaledVector(this.player.up, h);
      if (wrapDist2(_v2, c) < 0.78 * 0.78) return true;
    }
    return false;
  }

  // --- screens --------------------------------------------------------------

  openScreen(kind, state) {
    this.ui.openScreen(kind, state);
    this.input.exitLock();
    this.audio.ui(560);
  }

  /**
   * Leaving a face, and the only edge in the game that has consequences.
   *
   * **Verdant forgets you.** Both halves of it, on one event and in one place,
   * because section 8 states them as one sentence and the player has to be able
   * to learn them as one: the taboo lifts and the barter counter resets. Two
   * separately-shaped memories on the same face would be a rule that has to be
   * explained, and neither `Barter.forgetVisit` nor `Mobs.calmFolk` is allowed
   * to be called anywhere else.
   *
   * The divider IS the portal, so "leaving" is a single frame in which
   * `player.face` changes, and there is no other way off a sealed face.
   *
   * In the simulation and not in `_updateHud`, where `player.face` is otherwise
   * read: this changes the world rather than reporting on it.
   */
  _faceWatch() {
    const face = this.player.face;
    if (face === this._lastFace) return;
    const left = this._lastFace;
    this._lastFace = face;
    if (FACE_ROLE[left] !== FACE_VERDANT) return;
    this.mobs.calmFolk();
    forgetVisit(this.barter);
  }

  /**
   * What one of the fourteen will swap with you, and whether they will.
   *
   * The three functions below are the entire creature-side surface of the
   * barter panel and they are deliberately the whole of it: `Barter.js` owns
   * the goods, the fairness and the limit, this owns who is asking and whether
   * they are angry, and the UI owns the drawing. Nothing here touches the DOM.
   *
   * An angry one does not trade. That is checked here rather than inside
   * `Barter.js` because anger is a fact about a body on a face and the barter
   * model has no bodies in it.
   *
   * @returns {Array|null} the offers, each with `left` uses remaining, or null
   *   if this mob will not talk at all.
   */
  barterOffers(mob) {
    if (!this.mobs.canBarter(mob)) return null;
    return offersLeft(this.barter, this.seed, traderIdOf(mob.spec.folkId));
  }

  /** Why one line is greyed out, as a short player-safe phrase, or null. */
  barterRefusal(mob, index) {
    if (!this.mobs.canBarter(mob)) return mob?.spec.folk ? 'not now' : 'not a trade';
    return refusalFor(this.inventory, this.barter, this.seed,
      traderIdOf(mob.spec.folkId), index);
  }

  /**
   * A stand-in for the barter panel, and nothing more.
   *
   * It reads the model through the three methods above and says the first
   * available line out loud. It exists so the whole feature can be seen working
   * in a running game before the panel is built, and it is meant to be deleted
   * by whoever builds it.
   */
  _barterPeek(mob) {
    const offers = this.barterOffers(mob);
    if (!offers) { this.ui.toast('Not now', 0, 1400); return; }
    for (let i = 0; i < offers.length; i++) {
      const o = offers[i];
      if (o.left <= 0) continue;
      const give = `${o.give.count} ${ITEMS[o.give.item]?.label ?? '?'}`;
      const take = `${o.take.count} ${ITEMS[o.take.item]?.label ?? '?'}`;
      const no = this.barterRefusal(mob, i);
      this.ui.toast(no ? `${give} for ${take}: ${no}` : `${give} for ${take}`,
        o.take.item, 2600);
      return;
    }
    this.ui.toast('Done trading', 0, 1400);
  }

  /** Take one swap. False if it could not happen; see `barterRefusal`. */
  barterAccept(mob, index) {
    if (this.barterRefusal(mob, index)) return false;
    const ok = accept(this.inventory, this.barter, this.seed,
      traderIdOf(mob.spec.folkId), index);
    if (ok) this.audio.ui(720);
    return ok;
  }

  closeScreen() {
    if (!this.ui.screenOpen) return;
    const spill = this.inventory.clearCraft();
    const cur = this.inventory.cursor;
    if (!cur.empty) {
      // Same wear rule as everywhere else: picking a tool up onto the cursor and
      // pressing Escape used to put it back repaired.
      const taken = this.inventory.add(cur.item, cur.count, cur.wear);
      if (taken < cur.count) spill.push({ item: cur.item, count: cur.count - taken, wear: cur.wear });
      cur.clear();
    }
    for (const s of spill) {
      _v1.copy(this.player.position).addScaledVector(this.player.up, 1);
      this.drops.spawn(_v1.x, _v1.y, _v1.z, s.item, s.count, s.wear || 0);
    }
    this.ui.closeScreen();
    this.ui.refresh();
    if (this.state === 'playing') this.input.requestLock();
  }

  /**
   * The growth screen. Same shape as `openScreen` — free the cursor, make a
   * noise — but it is not a container, so it does not go through the inventory
   * screen's machinery and nothing in it can be dragged or dropped.
   */
  openSkills() {
    this.ui.openSkills();
    this.input.exitLock();
    this.audio.ui(560);
  }

  closeSkills() {
    if (!this.ui.skillsOpen) return;
    this.ui.closeSkills();
    if (this.state === 'playing') this.input.requestLock();
  }

  /**
   * Twenty-seven slots, created lazily so an untouched crate costs nothing.
   *
   * A crate with no entry yet is one the player has never touched, which — since
   * placing one registers it empty — means worldgen put it there. Those get
   * rolled loot on first contact. Doing it here rather than at generation time
   * is what makes container loot possible at all: structures are built in the
   * worker, which has no way to reach this map.
   */
  _crateAt(col, k) {
    const key = cellIdx(col, k);
    let c = this.crates.get(key);
    if (!c) {
      c = { slots: Array.from({ length: CRATE_SLOTS }, () => new Slot()), col, k };
      this._fillCache(c);
      this.crates.set(key, c);
    }
    return c;
  }

  /**
   * Stock a worldgen crate. Deterministic in the world seed and the crate's own
   * position, so the same cache always holds the same haul however you come at
   * it — and re-rolling it by reloading is not a thing you can do.
   *
   * Depth is the whole difficulty curve here: a crate in a surface ruin is a
   * handful of supplies, one at the bottom of a dungeon is worth the descent.
   */
  _fillCache(c) {
    const below = Math.max(0, SEA_K - c.k);   // layers under sea level
    const rng = makeRng(((this.seed ^ (c.col * 2654435761)) + c.k * 40503) | 0);
    const deep = below > 8;
    const mid = below > 2;

    const COMMON = ['bread', 'coal', 'stick', 'oak_planks', 'torch', 'seeds', 'apple', 'hide', 'flint'];
    const GOOD = ['iron_ingot', 'copper_ingot', 'gold_ingot', 'amethyst', 'bucket', 'coin'];
    const RICH = ['crystal', 'emerald', 'ruby', 'sapphire', 'void_shard', 'glowstone', 'coin'];

    const rolls = 2 + Math.floor(rng() * (deep ? 4 : mid ? 3 : 2));
    for (let n = 0; n < rolls; n++) {
      const table = deep && rng() < 0.45 ? RICH : (mid || deep) && rng() < 0.5 ? GOOD : COMMON;
      const name = table[(rng() * table.length) | 0];
      const id = itemIdOf(name);
      if (!id) continue;
      const rich = table === RICH;
      const count = rich ? 1 + Math.floor(rng() * 3)
        : table === GOOD ? 2 + Math.floor(rng() * 5)
          : 3 + Math.floor(rng() * 9);
      const max = ITEMS[id]?.stack ?? 64;
      // Merge onto a matching stack first — two separate piles of eleven planks
      // in the same crate reads as a bug, not as loot.
      const same = c.slots.find((s) => s.item === id && s.count < max);
      if (same) same.count = Math.min(max, same.count + count);
      else {
        const slot = c.slots.find((s, i) => s.empty && i >= ((rng() * CRATE_SLOTS) | 0))
          || c.slots.find((s) => s.empty);
        if (slot) slot.set(id, Math.min(count, max));
      }
    }
  }

  _kilnAt(col, k) {
    const key = cellIdx(col, k);
    let s = this.kilns.get(key);
    if (!s) {
      s = {
        input: new Slot(), fuel: new Slot(), output: new Slot(),
        burn: 0, burnMax: 1, progress: 0, progressMax: 1, col, k,
        // Which item the banked progress belongs to — see `_tickKilns`.
        progressItem: 0,
      };
      this.kilns.set(key, s);
    }
    return s;
  }

  _tickKilns(dt) {
    for (const k of this.kilns.values()) {
      const recipe = k.input.empty ? null : smeltingFor(k.input.item);

      // Progress belongs to the item that earned it, not to the kiln.
      //
      // Without this it belonged to the kiln, and the kiln did not care what
      // was cooking: bank eight seconds on an iron ore, swap the ore for an
      // egg, and the very next frame handed over a cooked egg, because 8 is
      // more than the egg's 4. One slow smelt you never finish buys one fast
      // smelt for free, over and over. Emptying the slot still only *decays*
      // the progress below — that is a deliberate grace for taking something
      // out and putting it straight back — but changing what is in there
      // starts the clock again.
      if (!k.input.empty && k.progressItem !== k.input.item) {
        k.progress = 0;
        k.progressItem = k.input.item;
      }
      const canOutput = recipe && (k.output.empty
        || (k.output.item === recipe.out && k.output.count + recipe.count <= (ITEMS[recipe.out]?.stack ?? 64)));

      if (k.burn > 0) k.burn -= dt;
      if (k.burn <= 0 && recipe && canOutput && !k.fuel.empty && FUEL[k.fuel.item]) {
        k.burnMax = FUEL[k.fuel.item];
        k.burn = k.burnMax;
        // A kiln taking light is the closest thing the game has to an event for
        // "you have started smelting", and it is the right one: it fires when
        // fuel, ore and a free output all line up, which is the whole lesson.
        k.fuel.count--;
        if (k.fuel.count <= 0) k.fuel.clear();
      }

      if (k.burn > 0 && recipe && canOutput) {
        k.progressMax = recipe.time;
        k.progress += dt;
        if (k.progress >= recipe.time) {
          k.progress = 0;
          k.input.count--;
          if (k.input.count <= 0) k.input.clear();
          if (k.output.empty) k.output.set(recipe.out, recipe.count);
          else k.output.count += recipe.count;
          // At the kiln, not at the player: this is the one event you are meant
          // to be able to walk away from and still hear finish.
          this.audio.smelt(this.planet.centerOf(k.col, k.k, _v1));
        }
      } else {
        k.progress = Math.max(0, k.progress - dt * 0.6);
      }

      const want = k.burn > 0 ? ID.kiln_lit : ID.kiln;
      const cur = this.planet.at(k.col, k.k);
      if ((cur === ID.kiln || cur === ID.kiln_lit) && cur !== want) {
        this._applyEdits([{ col: k.col, k: k.k, id: want }]);
        // Here rather than beside `_mark('forge')` above, and the difference is
        // the whole design of it: the branch up there fires once per *stick*, so
        // a kiln burning through a stack of nine would light nine times. The
        // block state changes exactly twice a run — it takes light, and it goes
        // dark — which is the number of times a player wants to be told.
        //
        // Going dark is the half that fixes a real hole: loading a kiln,
        // walking off to mine and never learning it ran out of coal two minutes
        // in. Positional, at the kiln, for exactly that reason.
        this.audio.kiln(want === ID.kiln_lit, this.planet.centerOf(k.col, k.k, _v1));
      }
    }
    if (this.ui.screen === 'kiln') this.ui.refresh();
  }

  // --- per-frame ------------------------------------------------------------

  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    // Escape is handled outside the play loop so it means the same thing in
    // every state — including paused, where `_update` never runs.
    if (this.input.pressed('Escape')) this._escape();

    // A spectator's world keeps running, and runs through the same function:
    // the crops grow, the water flows, the animals live their night. That is
    // the whole of what is left to do with the planet, and a second update path
    // for it would be a second place to forget to tick something.
    if (this.state === 'playing' || this.state === 'spectating') this._update(dt);
    else if (this.state === 'menu' || this.state === 'loading') this._idleUpdate(dt);
    else this._frozenUpdate(dt);

    voxelUniforms.uTime.value += dt;
    this.dividers.update(dt, this.camera);
    // Seat every chunk on the copy of itself nearest the eye, so terrain at
    // x = 0 seen from x = 1247 is drawn one unit away rather than 1247. The map
    // wraps and the vertices do not, so without this there is a hole in the
    // ground at each of the two wrap lines. `setView` writes only when a mesh's
    // offset actually changes, and is a no-op away from a seam.
    this.planet.setView(this.camera.position.x, this.camera.position.z);
    this.postfx.render(dt, {
      damage: this.damageFlash,
      underwater: this.player.headInWater,
      // Under a pool. The colour is the block's own `particle` colour, which is
      // already the answer to "what does a handful of this look like" and is
      // what the crumbs and the foot dust are tinted with — so being buried in
      // it and kicking it up match without a second number to keep in step.
      buried: this._buried > 0.002 ? [...this._buriedColor, this._buried] : null,
    });
    // No hands. `viewModel.enabled` is already false for a spectator — see the
    // gate in `_syncViewModel` — and this is the second half of the same thing:
    // nothing of the body is drawn over a world it cannot touch.
    if (this.state === 'playing' || this.state === 'paused') this.viewModel.render(this.renderer);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    // After the update and before the flags are cleared: the layer's visibility
    // is a function of the state this frame just settled on, and anything it
    // releases on the way out has to be released before the next frame reads it.
    this.touch?.sync();
    this.input.endFrame();
  }

  _idleUpdate(dt) {
    // The menu's orbit camera flies right past where the body is standing.
    this.character.hide();
    const t = performance.now() * 0.00005;
    // A slow turn on the spot, high over the middle of the map. There is no
    // planet to orbit any more, so the camera is a bearing rather than a radius.
    const r = K_TERRAIN_MAX + 34;
    this.camera.position.set(W * 0.5, r, W * 0.5);
    this.camera.lookAt(W * 0.5 + Math.cos(t) * 100, r - 28, W * 0.5 + Math.sin(t) * 100);
    if (this.camera.fov !== 44) { this.camera.fov = 44; this.camera.updateProjectionMatrix(); }
    const up = _v1.set(0, 1, 0);
    this.sky.setSolarTime(up, this.timeOfDay());
    this.sky.update(dt, this.camera, up, this.camera.position);
    this.particles.update(dt, this.camera, up, this.sky);
    this._updateSharedUniforms();
  }

  /**
   * Stand-in for the real input while a container screen is up: the world keeps
   * simulating, but the player holds still instead of sprinting off because a
   * movement key happened to be down when the screen opened.
   */
  static NO_INPUT = { down: () => false };

  /**
   * ...and the same idea for the one thing that reaches the player without
   * going through a key at all. `Drops` asks whether there is room before it
   * flies an item at you; a spectator has nowhere to put anything, so it is
   * answered honestly rather than by not running the drops at all.
   */
  static NO_POCKETS = { collect: () => 0, hasRoom: () => false };

  /**
   * Step the camera round the player. The viewmodel and the body are opposite
   * sides of one switch — exactly one of them is ever drawn, so first person
   * keeps the finished hand and third person never shows a fist floating in
   * front of your own face.
   */
  /**
   * Whether there are hands on the screen: first person, and not down the
   * glass.
   *
   * A pickaxe filling a third of the frame is drawn by the view model's own
   * camera at a fixed 70°, so it does *not* narrow with the world — hold C and
   * the hand stays exactly the size it was while everything behind it grows
   * four-fold, which reads as the pickaxe suddenly being enormous. Lowering it
   * is what a spyglass does anyway.
   *
   * The threshold is early on purpose. There is no fade available here — the
   * arms are either rendered or they are not — so the cut is put at the very
   * start of the ramp, where the fov is already moving and there is something
   * else to look at. Coming back it is the last thing to return.
   */
  _syncViewModel() {
    this.viewModel.enabled = this.viewMode === VIEW_FIRST && this.zoom < 0.1
      && !this.spectating;
  }

  /**
   * Whether there is a sight at all, in one place.
   *
   * Three call sites used to write the same expression and a fourth condition
   * has now joined it, so it is a method rather than a fourth copy. The rule
   * reads as one sentence: the sight is honest in first person, never for a
   * spectator, and not while a line is in the water — a cast is aimed by the
   * throw and the float is out there being the thing you are looking at, so a
   * dot pinned to the middle of the screen is pointing at nothing.
   */
  _syncCrosshair() {
    this.ui.showCrosshair(
      this.viewMode === VIEW_FIRST && !this.spectating && !this.fishing,
    );
  }

  _cycleView() {
    this.viewMode = (this.viewMode + 1) % VIEW_COUNT;
    this._syncViewModel();
    if (this.viewMode === VIEW_FIRST) this.character.hide();
    // No toast. The screen has just changed camera — you can see which view you
    // are in, and a caption naming it is the game telling you what you are
    // looking at. It was there when the modes were new; it earns nothing now.
    //
    // The crosshair goes with it. Third person aims from a camera that is not
    // where your hands are, so a dot in the middle of the screen is pointing at
    // something you cannot necessarily reach — the sight is honest only in
    // first person.
    // ...and never for a spectator, in any view. `setSpectator` takes the sight
    // away on the grounds that it is the last element implying the world can be
    // touched, but V is handled above the `busy` gate and so still runs while
    // spectating: two presses put the crosshair straight back on a player who
    // cannot reach anything. Answered here rather than in `showCrosshair`
    // because this is where the view's own rule is decided.
    this._syncCrosshair();
    // Written on the keypress rather than at shutdown: a browser tab is closed,
    // not quit, and there is no reliable moment later to catch.
    this.settings.view = this.viewMode;
    this.persistSettings();
  }

  /** The pause screen's Camera button, which is V for a hand with no keyboard.
   *  It cannot go through the key: V is read inside `_update`, and `_update` is
   *  the one thing that does not run while the game is paused. */
  cycleView() { this._cycleView(); }

  _frozenUpdate(dt) {
    // Two things have to be let go of here, and for the same reason: losing the
    // pointer lock clears the key set, so `_update` never sees the key released.
    //
    // The glass. Pause while zoomed and you came back still zoomed, with no key
    // held to explain it.
    this.zoom = stepZoom(this.zoom, false, dt);
    this._syncViewModel();
    // And the draw. `_tickBow` is not running, so a draw that was live when the
    // game stopped would sit charged behind the menu, with the arm, the body and
    // the sight frozen mid-pull. Dropped rather than held: a pause is not a
    // hold, and there is nothing to fire at.
    if (this.bow?.t) {
      this.bow.t = 0;
      this.viewModel.setDraw(0);
      this.character.setDraw(0);
      this.ui.setCrosshairDraw(0);
    }
    this.player.updateCamera(this.camera, dt, this.settings.fov, this.settings.bob,
      this.viewMode, this.zoom);
    // No body behind the pause menu either, for a world that has ended — the
    // same rule as in `_update`, and the pause screen is exactly where a
    // spectator spends the moment before quitting.
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST && !this.spectating
      && this._pausedFrom !== 'spectating',
      this.inventory.held().item, this.inventory.offhand.item);
    this.sky.setSolarTime(this.player.up, this.skyTimeOfDay());
    this.sky.update(dt, this.camera, this.player.up, this.player.position);
    this._updateSharedUniforms();
  }

  _update(dt) {
    const input = this.input;
    const ui = this.ui;
    /**
     * Watching rather than playing, and the one word the rest of this function
     * reads to know it.
     *
     * Every use of it below is either "your hands are elsewhere" — which is
     * what `busy` already meant and what every action in here was already
     * written to respect — or one of the three things that are not driven by a
     * key at all: the vitals that a body has, the pickup radius that a body
     * has, and the collision a body has. There is no fourth kind, because
     * everything else in this function reads `act` and `act` is `NO_INPUT`.
     */
    const ghost = this.spectating;
    this.playtime += dt;
    this._tickClock(dt);

    // The two overlays, which are inventories of a body that no longer has one.
    // Gated here rather than inside `openScreen` because these two are the only
    // keys handled above the `busy` gate — everything below it is covered by
    // `act` — and the point of the gate is that there is one of it.
    if (ghost && (input.pressed('KeyE') || input.pressed('KeyK'))) return;

    if (input.pressed('KeyE')) {
      if (ui.screenOpen) this.closeScreen();
      else {
        // One overlay at a time. E from the growth screen means "I want my
        // bags", not "put my bags on top of this".
        this.closeSkills();
        this.openScreen('inventory');
      }
      return;
    }
    // K for the tree. The letters were nearly all spoken for — E, Q and F are
    // taken, I and C are the two every player would guess and both are one
    // finger away from a key that already does something — and K is what the
    // genre uses for a character sheet. Like E it toggles, so the key that
    // opened it closes it without reaching for Escape.
    if (input.pressed('KeyK')) {
      if (ui.skillsOpen) this.closeSkills();
      else if (!ui.screenOpen) this.openSkills();
      return;
    }
    if (input.pressed('F3')) ui.toggleDebug();
    // V. It was F5 — the key the other voxel game uses — but that is a function
    // key you reach for, and this is a thing you flick between constantly.
    // Cycles first → behind → facing, and is deliberately allowed while a
    // screen is open: looking at your own character in your inventory is the
    // main reason to want it there.
    if (input.pressed('KeyV')) this._cycleView();
    // M for the map. It writes the same setting the Settings row writes, and
    // persists it the same way, so the key and the box cannot disagree. Guarded
    // on focus because `Input` listens on the window: typing a word with an m
    // in it would otherwise flash the map. (The sign panel pauses the game, so
    // it never reaches here at all.)
    if (input.pressed('KeyM') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
      this.settings.minimap = this.settings.minimap === false;
      this.persistSettings();
      ui.syncSettings();
    }

    // A container screen takes your hands, not the world. It used to return
    // early here, which froze breath, hunger, health, physics and every animal
    // while crops and kilns carried on — you could stand underwater in your
    // inventory indefinitely and never drown. Minecraft doesn't pause for a
    // chest either. The screen now only suppresses *input*: the body below runs
    // every frame, driven by a neutral input while a screen is up.
    // The skills screen takes your hands on exactly the same terms a container
    // does: the world keeps running behind it, but nothing you type reaches the
    // player. It has to be in this gate rather than relying on the pointer lock
    // — `Input` listens on the window, so W and the number keys still arrive
    // while the cursor is free, and browsing a skill tree would otherwise walk
    // you into a lake.
    //
    // And a spectator is permanently in that gate, which is the whole of how
    // "cannot interact" is made true. It is not a list of features that have
    // been switched off — a list is where one path gets missed, and the path
    // that gets missed is always the one added next — it is the same one door
    // every action in this function was already written to come through. The
    // hotbar, the wheel, the drop key, the offhand swap, mining, placing,
    // attacking, using, opening a crate, talking to the merchant, drawing the
    // bow: none of them is named below, and none of them can fire, because
    // every one of them reads `act` and `act` is a stub that answers false to
    // every key. Anything added to this function tomorrow inherits that for
    // free, provided it does what everything here already does and asks `act`.
    const busy = ui.screenOpen || ui.skillsOpen || ghost;
    const act = busy ? Game.NO_INPUT : input;

    // Looking around is not interacting with anything, so it is the one thing a
    // spectator keeps. Gated on the two overlays by name rather than on `busy`,
    // which used to be the same test and is not any more.
    const handsFree = !ui.screenOpen && !ui.skillsOpen;
    if (handsFree && input.locked && (input.mouseDX || input.mouseDY)) {
      const scale = lookScaleFor(this.camera.fov, this.settings.fov);
      this.player.look(input.mouseDX, input.mouseDY,
        input.sensitivity * this.settings.sensitivity * scale, input.invertY);
    }

    if (!busy) {
      for (let i = 1; i <= HOTBAR; i++) {
        if (input.pressed(`Digit${i}`)) { this.inventory.selected = i - 1; this._announceHeld(); }
      }
      if (input.wheel) {
        // A single frame can swallow a whole flick of the wheel, so wrap properly
        // instead of assuming one step: `(sel + wheel + 9) % 9` goes negative past
        // ten notches, and a negative index leaves `held()` undefined.
        const n = HOTBAR;
        this.inventory.selected = (((this.inventory.selected + input.wheel) % n) + n) % n;
        this._announceHeld();
      }
      if (input.pressed('KeyQ')) this._dropHeld();
      // F, which is where every player's hand already goes for this. It was
      // free: E, Q, F3 and F5 are the only letters and function keys spoken
      // for, and F is not one of the codes Input has to swallow a browser
      // default for while the pointer is locked.
      if (input.pressed('KeyF')) this.swapOffhand();
      // (The look is above, outside this gate: it is the one input a spectator
      // keeps. It is scaled down by however far in the camera actually is, so
      // the same movement of the hand slides the picture by the same fraction
      // of the screen at any zoom — read off `camera.fov` rather than off
      // `this.zoom` so it tracks the transition rather than jumping at the ends
      // of it, which is one frame behind, invisible, and correct for the sprint
      // kick for free.)
    }

    // The spyglass. First person only: narrowing the fov with the camera three
    // and a half cells behind your own shoulders fills the screen with your own
    // back, and there is no aim point out there to narrow *onto*. Held through
    // `act`, so a key still down when the inventory opens does not leave you
    // zoomed inside a menu.
    this.zoom = stepZoom(this.zoom, act.down('KeyC') && this.viewMode === VIEW_FIRST, dt);
    this._syncViewModel();
    /**
     * The invariant, enforced rather than hoped for: the player never moves
     * through ground that has not been built.
     *
     * It is already held by a wide margin — the streamer asks for every chunk
     * within CHUNK_LOAD_DIST, a hundred and fifty units, four times a second,
     * and a region is a few milliseconds of work in a worker that is otherwise
     * idle. Nothing walks or swims at forty units a second. What this is really
     * for is teleports: waking at a bed on the far side of the planet arrives
     * somewhere that may genuinely not exist yet, and the alternative to
     * standing still for two frames is falling through the world.
     *
     * Holding position is the right stop-gap rather than treating unbuilt
     * ground as solid: solid would let you stand on nothing and then sink into
     * it when the real terrain landed a block lower.
     */
    const pc = this.player.cell;
    const onBuiltGround = this.planet
      .liveCol(colIndex(pc.x, pc.y));
    if (!onBuiltGround) {
      this._streamPending = false;
      this._streamTimer = 0;
      this.player.vel.x = 0; this.player.vel.y = 0; this.player.vel.z = 0;
    }
    const wasInWater = this.player.inWater;
    // How fast the body was going down on the frame before it got wet. Read
    // here rather than after the physics because `Player.update` is where the
    // water brake is applied: by the time the flag flips, `vel.y` has already
    // been clamped to the -5 sink rate and every entry in the game looks the
    // same speed. Negative is downward; a wade across a shoreline is ~0.
    const entryVK = this.player.vel.y;
    // Captured with it, for the gasp on the way back up. Both edges existed in
    // the physics and neither had ever been listened for: only the entry
    // splash was wired, so a dive in was loud and the way out was silent.
    const wasHeadUnder = this.player.headInWater;
    // The fork, and the only one a spectator takes in this whole function.
    //
    // `Player.update` is where the collision, the step-up, the ladders, the
    // swimming, the fall damage and the push out of animals all live. A
    // spectator runs none of it: `_drift` moves the camera and returns, so the
    // absence of collision is a property of which function ran rather than of a
    // flag threaded through the one that has all the physics in it. It also
    // means the body's water flags stay false, so the splash, the bubbles and
    // the breath below are all simply never true.
    // Strictly before the physics: `whirlPull` is integrated inside the swim
    // branch, so setting it afterwards would be a frame of lag on a force that
    // is fighting a held key. See `_tickWhirl`.
    this._safeTick('whirl', () => this._tickWhirl(dt));
    if (ghost) this._drift(dt, input);
    else if (onBuiltGround) this.player.update(dt, act);
    if (this.player.inWater && !wasInWater) {
      // Scaled by how hard you hit it. `splash` has taken a scale since it was
      // written and this call did not pass one, so wading into ankle-deep water
      // at walking pace fired the identical sound as a twenty-cell dive: the
      // loudest thing the player can make on demand, un-panned, straight down
      // the middle, at will. Measured A-weighted through the shipped chain that
      // was -44.3 flat: 21.6dB over the footstep it interrupted and within
      // 4.4dB of breaking a metal block, for stepping off a bank. A wade now
      // measures -59.6 and a dive still measures -44.3.
      //
      // 16 cells/s is the reference rather than the -58 terminal clamp because
      // the interesting range is the one players are in constantly — a wade, a
      // step off a bank, a jump off a three-cell ledge — and mapping across
      // terminal velocity would put every one of those inside the bottom
      // eighth of the curve and leave the fix doing nothing. Anything faster is
      // already a dive and is already at full scale. The 0.30 floor is a floor
      // and not zero: something did enter the water, and silence there reads as
      // a missing sound rather than as a gentle one.
      const impact = Math.max(0, -entryVK);
      const scale = 0.30 + 0.70 * Math.min(1, impact / 16);
      this.particles.splash(this.player.position, this.player.up, 1.2);
      this.audio.splash(null, scale);
    } else if (!this.player.inWater && wasInWater) {
      // Climbing out. Smaller than going in, because a body leaving water
      // displaces less of it than a body arriving at speed — and 0.55 stopped
      // being smaller the moment a wade in became 0.30, which would have made
      // stepping out of a puddle 8.1dB louder than stepping into it. At 0.28 it
      // measures -60.4 against the wade's -59.6.
      this.audio.splash(null, 0.28);
    }
    // Head breaking the surface. `surface()` is the splash plus the breath, and
    // the breath is the half of it that only makes sense on this edge.
    if (wasHeadUnder && !this.player.headInWater) this.audio.surface();
    // Strokes. `onStep` is gated on `grounded`, so swimming had no sound of any
    // kind — you crossed a lake in silence. On its own timer rather than the
    // stride counter for the same reason: there is no ground to step on.
    if (this.player.inWater && !ghost) {
      this._swimT = (this._swimT ?? 0) - dt;
      if (this._swimT <= 0 && this.player.moveAmount > 0.8) {
        this._swimT = 0.72 + Math.random() * 0.35;
        this.audio.swim();
        // The stroke you can hear is now also a stroke you can see. Same timer,
        // so the wake and the sound are the same event rather than two rates
        // that drift apart.
        this.particles.swimWake(this.player.position, this.player.up, this.player.forward);
      }
    }
    if (this.player.headInWater && Math.random() < dt * 5) {
      this.particles.bubbles(this.player.eye, this.player.up, 2);
    }
    // The bioluminescent wake. Ticked every frame whether or not the player is
    // wet, because the trail has to keep fading after they climb out -- gating
    // the whole call on `inWater` froze four glowing blobs on the surface at
    // the point of exit. On the low tier the last two slots are held at zero,
    // so a phone draws a shorter trail out of the same shader rather than a
    // second one.
    this.bioWake.update(dt, this.player.position, this.player.moveAmount,
      this.player.inWater && !ghost, voxelUniforms.uBioWake.value);
    if (this.qualityTier === 'low') {
      voxelUniforms.uBioWake.value[2].w = 0;
      voxelUniforms.uBioWake.value[3].w = 0;
    }

    // --- everything below here is a fact about a body ----------------------
    //
    // Air, fire, spines. They are the three sources of damage that are not a
    // key press and not a mob, so they are the three the input gate does not
    // reach — and a spectator has no lungs to run out of, nothing to catch
    // alight and nothing to lean on a cactus. `_takeHit` refuses each of them
    // on its own account whatever happens here, which is what makes this a
    // tidiness rather than the guarantee; the guarantee is one line and it is
    // there.
    //
    // It also matters that the *flags* they read are stale for a spectator:
    // `headInWater` and `inLava` are written by `Player.update`, which no
    // longer runs, so a player who drowned would otherwise go on drowning
    // forever against a breath meter nobody can see.
    if (ghost) {
      this.breath = 1;
      this._drownTimer = 0;
      this.player.burning = 0;
      this.soakT = 0;
      // A spectator's `headInSink` is stale for the same reason `headInWater`
      // is — `Player.update` no longer runs — so a player who died at the
      // bottom of a pool would watch their own world through a screen full of
      // sand for ever.
      this._buried = 0;
      this._wasSink = 0;
      this.chillT = 0;
      this._chillSaid = false;
      // And the poison, for the same reason: `contactPoison` is written by
      // `Player.update`'s box scan, which no longer runs, so a spectator who
      // died in a patch of deathcaps would go on breathing spores for ever.
      this.poisonT = 0;
      this.sporeT = 0;
      this._sporeSaid = false;
    } else if (this.player.headInWater) {
      // Nine seconds of air, stretched by the lungs branch — 27 at lungs 4.
      // The bar is still 0..1, so what the skill changes is how long it takes
      // to empty, not how much of it there is; a HUD that showed "180% breath"
      // would be describing the tree rather than the dive.
      this.breath = Math.max(0, this.breath - dt / (9 * this.skills.breathScale));
      if (this.breath <= 0) {
        this._drownTimer = (this._drownTimer || 0) + dt;
        if (this._drownTimer > 0.7) {
          this._drownTimer = 0;
          this.player.health = Math.max(0, this.player.health - 1);
          this.damageFlash = 0.5;
          this.audio.hurt();
          if (this.player.health <= 0) this._die('Drowned');
        }
      }
    } else {
      this.breath = Math.min(1, this.breath + dt / 3);
      this._drownTimer = 0;
    }

    if (!ghost) {
      this._tickFire(dt);
      this._tickContact(dt);
      this._tickSoak(dt);
      this._tickSink(dt);
      this._tickChill(dt);
      // After `_tickContact`, which is not an ordering that matters but is the
      // honest one: `contactHurt` is what writes `player.contactPoison`, and
      // both of them read it on the frame it was written.
      this._tickPoison(dt);
    }

    // Four times a second is plenty: a sprint covers about 2 units in that time
    // and the load and keep radii are 28 apart.
    this._streamTimer -= dt;
    if (this._streamTimer <= 0) { this._streamTimer = 0.25; this._streamChunks(); }

    // Ticked out here rather than inside _interact, which is skipped while a
    // screen is open: a swing should come back up to weight while you are in
    // your inventory, not sit frozen at whatever it was when you opened it.
    this.attackT = Math.min(ATTACK_PERIOD, this.attackT + dt);

    // `_interact` is what names the thing under the crosshair, so with a screen
    // up the label has to be cleared here — otherwise it freezes on whatever
    // you happened to be looking at when you opened your inventory and sits
    // there behind it.
    // Before `_interact`, and unconditionally — see `_tickBow`. It has to run
    // with a screen open, because that is one of the ways a draw is cancelled.
    this._safeTick('bow', () => this._tickBow(dt, input, busy));

    if (!busy) this._interact(dt, input);
    else this.ui.setLookAt(null);
    // Each of these is isolated. The whole frame is already wrapped in a catch
    // so a throw cannot kill the render loop, but that catch aborts everything
    // *after* the throw as well — one bad kiln state silently stopped farming,
    // water, mobs and vitals, and the only symptom was that the world quietly
    // held still. Losing one subsystem for a frame is a glitch; losing the rest
    // of the tick with it is indistinguishable from a freeze.
    // The marker goes when there is nothing left of the pack to fetch, whether
    // you picked it up, it burned, or something else got there first.
    if (this.deathSite && !this.drops.list.some((d) => d.keep)) this.deathSite = null;

    this._safeTick('kilns', () => this._tickKilns(dt));
    this._safeTick('farming', () => this.farming.update(dt, this.seasons.growth));
    this._safeTick('water', () => this.water.update(dt));
    // After the water, so a grain that lands in a channel the flow just opened
    // is settled against the world the flow left behind rather than the one it
    // started the tick with.
    this._safeTick('settling', () => this._tickSettling(dt));
    this._safeTick('gravity', () => {
      this.fallTimer -= dt;
      if (this.fallTimer > 0) return;
      this.fallTimer = GRAVITY_TICK;
      this._settleGravity();
      // Landing is per frame rather than on the gravity tick's own clock: a
      // block in the air has to arrive when it arrives, not on the next
      // multiple of GRAVITY_PERIOD.
    });
    this._safeTick('freeze', () => this._tickFreeze(dt));
    this._safeTick('snowcover', () => this._tickSeasonSnow(dt));
    // Hunger, healing and stamina, all three of which are about a body.
    if (!ghost) this._safeTick('vitals', () => this._tickVitals(dt));
    this._safeTick('grace', () => this._tickGrace(dt));
    // The two that reach into the player without waiting to be asked, and the
    // reason the input gate above is necessary but not sufficient: `_tickCore`
    // watches for the player *touching* the core and puts a hearth in their bag
    // for it, and `_tickSkills` pays XP for being alive and marks firsts. Both
    // run every frame off the player's position, so both would fire for someone
    // drifting through a world they are only meant to be looking at. A hearth
    // is the one item in the game you cannot get any other way, and a spectator
    // who flew down and collected it would have taken something out of a run
    // that is over.
    if (!ghost) {
      this._safeTick('core', () => this._tickCore(dt));
      this._safeTick('skills', () => this._tickSkills(dt));
    }
    // How old this world is, in seconds played. Mobs derives the hostile health
    // multiplier from it at spawn — see `worldHardening` — so it has to be
    // current before the spawner inside `update` runs, and it is pushed rather
    // than stored anywhere else so there is only ever one copy of the number.
    this._faceWatch();
    this.mobs.playtime = this.playtime;
    // Which body you took, so Verdant can put the other fourteen on the ground.
    // Pushed here rather than off `onCharacter` for the reason the line above
    // is pushed: that hook early-returns on an unchanged id, so a world started
    // on the default character would never have fired it and the village would
    // have been one short with the player's own twin standing in it.
    this.mobs.playerCharacter = this.character.id;
    this._safeTick('mobs', () => this.mobs.update(dt, this.player, this.sky));
    // Before the door is checked and after the herd has moved: the reconcile
    // wants this frame's despawns, so a boss the ring has just dropped hands its
    // health back before anything can ask for it again.
    if (!ghost) this._safeTick('endgame', () => this._tickEndgame(dt));
    // After the animals have moved, so a shot lands where the body is drawn
    // this frame rather than where it was drawn last one. The mob list is handed
    // over per call rather than held; see the constructor.
    // The one definition of "picked up", shared by arrows and drops.
    //
    // A recovered arrow goes into the bag through exactly the door an item on
    // the ground uses, so it stacks the same way, answers a full bag the same
    // way, and makes the same sound. Hoisted rather than written twice because
    // two definitions of collecting is how one of them ends up subtly different.
    // A spectator collects nothing, which is the same object drops already use.
    const bag = ghost ? Game.NO_POCKETS : {
      collect: (item, count, wear) => {
        // Picking something up is silent and says nothing.
        //
        // It used to make a noise and raise a toast naming the item. Both were
        // per *item*, so walking through a wood or felling one tree buried the
        // corner of the screen in a column of labels and fired a burst of
        // chimes — for something the player can already see land in the hotbar.
        // The toast stack is for things that happen once and matter: a save, a
        // skill point, the merchant leaving.
        return this.inventory.add(item, count, wear);
      },
      hasRoom: (item) => this.inventory.hasRoom(item),
    };
    this._safeTick('arrows', () => this.arrows.update(dt, this.mobs, this.player, bag));
    // A merchant that has walked out of range, run out of life or been killed
    // takes its shop with it. Without this the screen stays up over a stock
    // list belonging to a mob that no longer exists.
    if (this.ui.screen === 'shop' && !this.mobs.list.includes(this.ui.shop)) {
      this.closeScreen();
      this.ui.toast('The merchant moved on.', itemIdOf('coin'), 2600);
    }
    // The merchant stands still while you are buying from him.
    //
    // He kept wandering with the shop screen up, so the stock list belonged to
    // someone strolling off behind you - and the check above would eventually
    // close the screen mid-purchase because he had walked out of range. A
    // shopkeeper who leaves during the transaction is not a shopkeeper.
    //
    // Held as a flag on the mob rather than as a test inside the mob loop: the
    // loop runs over every animal on the planet and has no business knowing
    // what a UI screen is, and this way exactly one body is ever marked.
    const shopMob = this.ui.screen === 'shop' ? this.ui.shop : null;
    if (this._tradingMob !== shopMob) {
      if (this._tradingMob) this._tradingMob.trading = false;
      if (shopMob) shopMob.trading = true;
      this._tradingMob = shopMob;
    }
    // Drops still fall, still settle, still burn and still expire, because that
    // is the world carrying on. What a spectator cannot do is pick one up, and
    // the way to say so is to hand `Drops` a bag with no room in it rather than
    // to skip the tick — skipping would freeze every item on the planet
    // mid-air, including the pile the player's own body left.
    // `bag` is built above, beside the arrows tick, and carries the `wear`
    // argument Drops has always passed.
    this.drops.update(dt, this.player, bag);

    const c = this.player.cell;
    const biomeId = this.planet.colBiome[colIndex(c.x, c.y)] ?? 2;
    const altitude = this.player.position.y - SEA_K;
    // Tempest overrides the weather cycle the way Pyre overrides the day
    // cycle: pinned to storm while you are on it, and the sky you had is
    // handed back when you leave.
    this.weather.update(dt, biomeId, altitude, this.seasons.cold,
      FACE_ROLE[this.player.face] === FACE_TEMPEST);
    // A funnel, if the sky wants one and the ground will take one. Weather owns
    // the odds and Tornado.js owns everything else — see the head of that file
    // for why, and for the whole design. Six lines here is the entire footprint
    // in main.
    if (this.tornado) {
      if (!this.tornado.update(dt)) { this.tornado = null; this.particles.tornadoOff(); }
    } else if (this.weather.wantsTornado(dt)) this._spawnTornado();
    // The leading edge of a rain band. `precip` eases toward its target at
    // dt*0.14, so the bed already fades in over about seven seconds — what it
    // has never had is a FRONT, and the first a player knew of a storm was
    // being wet. A gust ahead of the rain is the whole of the warning weather
    // gives in life and it is enough time to get under something.
    //
    // Rain and storm arriving only. Clear, fair and overcast are silent
    // transitions on purpose: a sound for a state change the player can neither
    // act on nor be harmed by is clutter, and so is a sound for rain stopping,
    // which is a fade that is already audibly happening.
    if (this.weather.state !== this._lastSky) {
      const was = this._lastSky;
      this._lastSky = this.weather.state;
      // `was` is undefined on the first frame and after a load, which is what
      // stops a world that was saved in a storm announcing one on the loading
      // screen for weather that has been falling for an hour.
      if (was !== undefined && this.weather.state === 'rain') this.audio.squall(0.6);
      else if (was !== undefined && this.weather.state === 'storm') this.audio.squall(1);
    }
    // Precipitation spawns in a box around the camera with no notion of the
    // world, so without this it rains just as hard inside a cave or under a
    // roof as it does in the open. Fade it out by how much sky is overhead,
    // eased so stepping under a tree dims the rain rather than cutting it.
    this.shelter += (this._skyExposure() - this.shelter) * Math.min(1, dt * 3.5);
    // After `shelter`, deliberately: a strike is aimed with THIS frame's sky
    // exposure, so stepping under three layers of rock stops being a target
    // on the frame you do it rather than on the next one.
    if (this.weather.wantsStrike(dt)) strikeLightning(this);
    this.particles.setWeather(this.weather.type, this.weather.precip * this.shelter, this.player.headInWater);

    // A drawn bow pulls the view in by a sixth. Not a scope — a sixth of 75° is
    // 12°, which is a lean rather than a zoom — but it is enough that the world
    // creeps forward as the shot charges, which is the cheapest possible way to
    // make the charge legible without drawing anything. It rides the same
    // `bow.t` everything else does, so it can never disagree with the sight.
    //
    // It scales the *base* fov and the glass narrows from there, so drawing
    // while zoomed composes instead of one overriding the other. That is also
    // why the bow term belongs here and not inside `stepZoom`: the two are
    // separate holds on separate keys and either can start first.
    this.player.updateCamera(this.camera, dt, this.settings.fov * (1 - 0.16 * this.bow.t),
      this.settings.bob, this.viewMode, this.zoom);
    // After the camera, because the body hides itself when the camera has been
    // pulled in on top of it and it needs this frame's distance to know.
    //
    // While drawing, the left hand holds the arrow — passed as the offhand item
    // rather than plumbed through a new path, because the offhand is already
    // "the thing in the body's left fist" and the draw pose has already put that
    // fist at the string. Nothing in Character knows a bow exists.
    // No body either, in any view. The figure is still standing where it fell —
    // or rather, it is not: it would follow the camera about, which is a
    // corpse flying over its own world. Third person stays available because
    // the camera offset is a nicer way to look at terrain, it simply has
    // nothing in front of it.
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST && !ghost,
      this.inventory.held().item,
      this.bow.t > 0 ? itemIdOf('arrow') : this.inventory.offhand.item);
    // The body is an entity like any other and takes its torchlight the same
    // way the mobs do — probed at chest height rather than at the feet, so a
    // wall torch lights you as it lights the husk standing beside you.
    this.character.setBlockLight(this._entityLight(
      _v1.copy(this.player.position).addScaledVector(this.player.up, 0.9), _entityL));
    this.viewModel.setHeld(this.inventory.held().item, this.ui.icons);
    this.viewModel.setOffhand(this.inventory.offhand.item, this.ui.icons);
    this.viewModel.update(dt, this.player, this.sky, this._handLight());
    // The flicker clock both moving flames read, advanced once, here, before
    // either of them looks at it. See the field's own note for what happened
    // while `_updateHandLight` owned it.
    this._flameT += dt;
    this._updateHandLight(dt);
    this._updateDropLight(dt);
    // After both, because it converts the positions those two just wrote.
    this._safeTick('lightOcclusion', () => this._updateLightOcclusion());
    this._safeTick('flames', () => this._tickFlames(dt));
    this._safeTick('steam', () => this._tickSteam(dt));
    this._safeTick('blockModels', () => this._syncBlockModels());
    this._safeTick('signText', () => this._syncSignText());
    this.sky.setSolarTime(this.player.up, this.skyTimeOfDay());
    // `shelter` doubles as the entity fill's occlusion — animals cannot read
    // the voxel light, so a roof over the player is the best signal the sky has
    // that the thing it is lighting is indoors.
    this.sky.update(dt, this.camera, this.player.up, this.player.position, this.shelter);
    this.particles.update(dt, this.camera, this.player.up, this.sky);
    this._updateSharedUniforms();
    this._updateAudio(biomeId);
    this._updateHud();

    this.autosaveTimer += dt;
    if (this.autosaveTimer > 90) { this.autosaveTimer = 0; this.saveGame(false); }
  }

  /**
   * One damage entry point, so every source flashes, sounds and kills the same
   * way. Returns true if it was fatal.
   *
   * `guarded` damage respects a short immunity window after the last hit. Every
   * blow that can arrive in a crowd must be guarded: seven husks is the hostile
   * cap, they all converge on the same spot, and at 3 half-hearts each a single
   * synchronised swing round is 21 against a 20-point bar — an instant death
   * with nothing the player could have done. Environmental damage opts out; it
   * already paces itself on its own timer and cannot gang up.
   */
  /**
   * @param {string} kind what sort of damage this is, for the tolerance branch.
   *   'blow', 'fire' and 'lava' are reduced; 'drown' and anything unrecognised
   *   are not. This used to be an `armoured` boolean and the rule is unchanged
   *   — you cannot toughen your way out of not breathing — but a string is what
   *   `Skills.soak` wants, and it means a damage source added tomorrow has to
   *   opt in by name instead of inheriting a 45% discount by defaulting to true.
   */
  /**
   * Site a funnel now, if the ground nearby will take one.
   *
   * A method rather than four lines inline because the harness has to be able to
   * ask for one on demand — a mechanic that appears once every three quarters of
   * an hour is otherwise untestable, and the alternative is a test that edits the
   * odds and therefore never measures the shipped ones.
   *
   * The cooldown is re-armed only once siting has actually succeeded. Siting
   * fails over ocean, forest and mountain, and a refused roll that still burned
   * seven minutes of cooldown would be a bug nobody could ever see happening.
   *
   * @returns {boolean} whether one formed
   */
  _spawnTornado() {
    if (this.tornado) return false;
    const t = siteTornado(this);
    if (!t) return false;
    this.tornado = t;
    this.weather.armedTornado();
    // The existing weather-front gust, unchanged — the same sound a storm's
    // arrival already makes, which is the point: the player has heard it before
    // and knows it means the sky has changed its mind.
    this.audio.squall(1);
    this.ui.toast('Tornado');
    return true;
  }

  _takeHit(damage, cause, guarded = true, kind = 'blow') {
    const p = this.player;
    // There is nothing there to hit. This is the single door every blow, every
    // burn, every drowning and every fall in the game already comes through —
    // its own comment two paragraphs down says so and lists them — which is why
    // "a spectator cannot be hurt" is one line rather than a rule repeated at
    // each source. `Mobs.ghost` stops the swings ever being thrown; this is
    // what makes it true of the environment as well, and of whatever the next
    // damage source turns out to be.
    if (this.spectating) return false;
    if (p.health <= 0) return true;
    if (guarded && this._hurtGuard > 0) return false;
    if (guarded) this._hurtGuard = HURT_IMMUNITY;

    // Nothing wears out and nothing breaks: the reduction is a fact about the
    // player now, not about four items with a durability bar.
    damage = this.skills.soak(damage, kind);

    // `cause` is the mob for a blow and a string for everything else, so this
    // shoves you away from a husk but not away from drowning.
    if (cause && cause.position) p.knockback(cause.position.x, cause.position.y, cause.position.z);

    p.health = Math.max(0, p.health - damage);
    this.damageFlash = Math.min(1, 0.32 + damage * 0.1);
    this.audio.hurt();
    if (p.health <= 0) {
      // Name the thing that killed you, and only name it. A death you cannot
      // attribute is a death you cannot learn from, and a death narrated back
      // at you in a full sentence is one you stop reading by the third time.
      this._die(typeof cause === 'string' ? cause : this._killedBy(cause));
      return true;
    }
    return false;
  }

  /**
   * How the death screen says who did it: the creature's own label, and
   * nothing round it.
   *
   * `cause` is whatever was passed to `hurt` — a mob for a blow. The fallback
   * covers a killer with no label to read, which is not a case that exists
   * today but is one bad refactor away.
   */
  _killedBy(cause) {
    return cause?.spec?.label || 'Killed';
  }

  /**
   * Lava, and staying alight after climbing out of it.
   *
   * Lava was previously inert: it generated in the mantle and in deep caverns,
   * it lit the cave and shimmered in the shader, and touching it did nothing at
   * all. That is a worse surprise than having no hazard, because the world
   * visibly promises danger it does not deliver.
   */
  _tickFire(dt) {
    const p = this.player;
    this._hurtGuard = Math.max(0, this._hurtGuard - dt);
    if (p.inLava) {
      p.burning = 5.0;                    // relights for as long as you stand in it
      this._lavaTimer = (this._lavaTimer || 0) + dt;
      if (this._lavaTimer > 0.45) {
        this._lavaTimer = 0;
        if (this._takeHit(3, 'Lava', false, 'lava')) return;
      }
      this.particles.embers(p.eye, p.up, 3, 1.1);
    } else if (p.burning > 0) {
      // Water puts you out at once; otherwise it burns down on its own. So
      // does a drift of powder snow — the same fact from the other end of the
      // thermometer, and Minecraft's rule for the same block.
      if (p.inWater || p.inSink === ID.powder_snow) p.burning = 0;
      else {
        p.burning = Math.max(0, p.burning - dt);
        this._burnTimer = (this._burnTimer || 0) + dt;
        if (this._burnTimer > 0.9) {
          this._burnTimer = 0;
          if (this._takeHit(1, 'Burned', false, 'fire')) return;
        }
        if (Math.random() < dt * 12) this.particles.embers(p.eye, p.up, 1, 0.8);
      }
    }
    this.damageFlash = Math.max(this.damageFlash, p.burning > 0 ? 0.14 : 0);
  }

  /**
   * Going under, and being under: the seen and heard half of a sink block.
   *
   * The physics is entirely in `Player.update` and there is deliberately no
   * damage here at all — see `SINK` in Blocks.js, and the note on the block
   * itself for why quicksand traps rather than kills. What this owns is the
   * three things a player needs in order to understand what just happened to
   * them, and all three are cues rather than rules:
   *
   *   - **the sound of the ground going.** One shot on the edge, in the block's
   *     own material, and `Audio.sink` is built as the inverse of a footstep so
   *     that it is unmistakably the sand you were walking on. Once per entry,
   *     not per frame: a body bobbing at the surface of a pool crosses the edge
   *     several times a second and a per-frame sound would be a buzz.
   *   - **the stuff itself, kicked up.** `footDust` takes a block id and is
   *     already tinted from that block's own `particle` colour, which is the
   *     same colour the screen goes below. One number, three consumers.
   *   - **the screen, when the eye goes under.** Eased rather than snapped, at
   *     a rate that reaches most of the way in about a quarter of a second —
   *     fast enough to be the same event as the sound, slow enough that bobbing
   *     at the surface pulses rather than strobes.
   *
   * There is no clock in here and nothing accumulates, so there is nothing for
   * `respawn` to clear: leaving the pool is leaving the pool. The one field
   * that outlives a frame is `_buried`, and it is driven straight off the
   * player's current state, so a body that stops being in a pool for any reason
   * — including dying in one — fades out on its own.
   */
  _tickSink(dt) {
    const p = this.player;
    const id = p.inSink;
    if (id && id !== this._wasSink) {
      this.audio.sink(BLOCKS[id].sound, p.position);
      this.particles.footDust(p.position, p.up, id);
    }
    this._wasSink = id;

    // Held over the frames the feet are momentarily above the pool and the head
    // is not, which is every frame of bobbing at the surface. Reading the
    // colour off `inSink` alone would flicker it to grey on those frames.
    if (id) this._buriedColor = BLOCKS[id].particle;
    // 0.9 -> 1. Nine tenths of an overlay is a tenth of a window, and what you
    // could see through it was the inside of the planet with its ore in place:
    // "sinking in quicksand makes us see through the planet which might reveal
    // ore placements". Being buried means seeing the stuff you are buried in,
    // which is what the block's own particle colour already is. Powder snow
    // rides the same path, being a sink block, so it is covered too.
    //
    // INSTANT in, eased out, and the asymmetry is the whole fix.
    //
    // This was already once reported and once fixed, by taking the cover from
    // 0.9 to a full 1. That closed the steady state and left the transition,
    // which is what came back as "sinking on quicksand can let see through the
    // world briefly": an exponential approach at 16/s is only 0.23 after one
    // frame and needs about a fifth of a second to cover the screen, and a
    // fifth of a second of looking through the planet at the ore is a fifth of
    // a second too many. There is nothing to ease IN to - your head is either
    // under or it is not - so the ramp bought nothing and cost exactly the bug.
    // Easing OUT still matters, because that one is a reveal and wants to feel
    // like surfacing.
    const wantBuried = p.headInSink ? 1 : 0;
    if (wantBuried > this._buried) this._buried = 1;
    else this._buried += (wantBuried - this._buried) * Math.min(1, 9 * dt);
  }

  /**
   * The whirlpool: the drag it puts on a body, and the broken water and the
   * churn that say it is there.
   *
   * Runs BEFORE `Player.update` rather than after it, and that ordering is the
   * only subtle thing in here. `whirlPull` is read inside the swim branch and
   * integrated there along with buoyancy and the swim key, so writing it
   * afterwards would apply this frame's drag to next frame's position — a
   * frame of lag on a force that is fighting a held key, which is exactly the
   * kind of thing that reads as the controls being unreliable.
   *
   * **The cue reaches nearly four times further than the drag does**, which is
   * the whole of the legibility argument for a hazard that is made of nothing.
   * Quicksand has a colour and powder snow has a label; this has neither, so
   * what it gets instead is a patch of sea that is visibly and audibly not
   * behaving like sea, from WHIRL_CUE columns away — seven seconds of swimming
   * before the funnel can touch you. The ripples are thrown on the water's own
   * layer rather than at the player, so it is a place that is doing something
   * rather than something happening to you, and they get denser toward the eye
   * because that is where the falloff says the danger is.
   *
   * Nothing here damages anything. The only way a whirlpool kills is by holding
   * you under until the breath meter runs out, which is `_update`'s existing
   * drowning path and needs nothing added to it — and it takes a player who
   * does nothing at all for nine seconds, with the meter on screen.
   */
  _tickWhirl(dt) {
    const p = this.player;
    p.whirlPull = 0;
    p.whirlX = 0; p.whirlZ = 0; p.whirlSpin = 0;
    this._whirlDrag ||= { i: 0, j: 0, spin: 0 };
    if (this.spectating) { this._whirlT = 0; return; }
    const c = p.cell;
    const col = colIndex(c.x, c.y);

    // The drag. Gated on being in water and not on being near one, because
    // `pullAt` is already the narrower test and asking it twice would be two
    // places that have to agree about where the funnel is.
    if (p.inWater && !p.inLava) {
      p.whirlPull = this.whirlpools.pullAt(col, c.k);
      const d = this.whirlpools.dragAt(col, c.k, this._whirlDrag);
      p.whirlX = d.i; p.whirlZ = d.j; p.whirlSpin = d.spin;
    }

    const eye = this.whirlpools.centreWithin(col, WHIRL_CUE);
    if (eye < 0) { this._whirlT = 0; return; }

    // Broken water, on the sea's own layer over the funnel.
    //
    // The first version of this was ripples at radius 0.5 to 1.8, eight a
    // second, and the screenshot is why it is not that any more: from thirteen
    // columns off it read as four faint rings on a flat blue sheet, which is
    // indistinguishable from a light shower and therefore not a warning at all.
    // What it takes to be visible at the range the drag has to be avoided from
    // is rings two to five cells across at three times the rate, plus actual
    // white water — `splash` throws droplets that catch the light and are the
    // only thing here you can see against a bright sea from a distance.
    this._whirlT = (this._whirlT || 0) - dt;
    if (this._whirlT <= 0) {
      this._whirlT = 0.04;
      // sqrt of a uniform draw would spread these evenly over the disc; the
      // draw is deliberately left un-rooted so they crowd the middle, which is
      // where the pull is strongest and where the eye should be drawn.
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * WHIRL_R;
      const at = stepColumn(eye, Math.round(Math.cos(a) * rr), Math.round(Math.sin(a) * rr));
      const pos = this.planet.centerOf(at, K_SEA, _v1);
      // Up, and nothing else. Water lies flat everywhere now.
      _v2.set(0, 1, 0);
      this.particles.ripple(pos, _v2, 2.0 + Math.random() * 3.0, 1);
      // A quarter of the rings get spray with them. Any more and the general
      // particle pool is a fountain that starves the dig crumbs and the embers;
      // this is about five a second, which is a steady boil rather than a
      // firework.
      if (Math.random() < 0.22) this.particles.splash(pos, _v2, 0.7 + Math.random() * 0.5);
    }

    // The churn, on its own slower timer and at a strength that is how far into
    // the funnel the listener is — so swimming towards one gets louder rather
    // than more frequent, which is what a large thing sounds like.
    this._whirlSndT = (this._whirlSndT || 0) - dt;
    if (this._whirlSndT <= 0) {
      this._whirlSndT = 1.9 + Math.random() * 0.6;
      const eyePos = this.planet.centerOf(eye, K_SEA, _v1);
      const d = wrapDist(eyePos, p.position);
      this.audio.churn(eyePos, Math.max(0.15, 1 - d / (WHIRL_CUE + WHIRL_R)));
    }
  }

  /**
   * The cold, and it is the only thing powder snow does that quicksand does
   * not.
   *
   * Built to the hot spring's shape on purpose rather than as a fourth idea:
   * a clock up while you are in it, a clock down while you are not, a warning
   * band, then a point on a fixed cadence. See the CHILL_* block for the
   * pricing and for why this one is allowed to kill when the scald is not.
   *
   * `kind` is 'freeze', which no skill soaks — deliberately, and for the reason
   * `_tickSoak` gives about heat: a tolerance branch shaving this to nothing is
   * the one route by which a late-game player could live in a drift, and the
   * ceiling on the whole block is that you cannot stay. Difficulty is untouched
   * for the same reason every other environmental source is: `mobDamageMul` is
   * applied at the mob callsite, so easy through extreme scale mobs and only
   * mobs.
   *
   * The warning is breath in cold air, which is the same emitter the hot spring
   * uses for steam and is put on the player rather than out on the snow for the
   * same reason it is there: the news is about your body, not about the
   * weather. It arrives at 4.4 seconds, comfortably inside the six an unequipped
   * escape from the floor of a drift takes, so it is never the case that the
   * cue and the damage arrive together.
   */
  _tickChill(dt) {
    const p = this.player;
    if (p.inSink !== ID.powder_snow) {
      this.chillT = Math.max(0, this.chillT - dt * CHILL_THAW);
      this._chillT = 0;
      // Armed again only once the cold has actually gone, not the moment the
      // feet leave the drift: hopping out and back in must not re-fire it.
      if (this.chillT <= 0) this._chillSaid = false;
      return;
    }
    this.chillT += dt;
    if (this.chillT < CHILL_BITE * CHILL_SHIVER) return;
    // Once, on crossing into the warning band, not per frame. `Audio.ice` is
    // the freezing half of a sound the game already has and it is the right
    // one: this is water in your clothes going hard.
    if (!this._chillSaid) { this._chillSaid = true; this.audio.ice(true, p.position); }
    if (Math.random() < dt * 5) this.particles.steam(p.eye, p.up, 0.3, 0.5);
    if (this.chillT < CHILL_BITE) return;

    this._chillT = (this._chillT || 0) + dt;
    if (this._chillT < CHILL_PERIOD) return;
    this._chillT = 0;
    this._takeHit(1, 'Frozen', false, 'freeze');
  }

  /**
   * The poison: a mushroom you stood in, a bean you did not cook, or a fish you
   * did not know.
   *
   * Two halves and both of them are borrowed. The first is `_tickChill`'s: a
   * clock up while the body is against a deathcap, down while it is not, a
   * warning band, then it fires once and rearms. The second is `burning`'s: a
   * dose that counts down and charges a point on a fixed cadence. See the
   * POISON_* block for every number and for why the last point is safe.
   *
   * `kind` is 'poison', which no skill soaks. That is the same decision
   * `_tickSoak` and `_tickChill` made and the same reason: the ceiling on this
   * whole feature is four points, and a tolerance branch shaving four points is
   * a tolerance branch deleting the feature. Difficulty is untouched too -
   * `mobDamageMul` is applied at the mob callsite, so easy through extreme scale
   * mobs and only mobs, exactly as they do for the cold and the scald.
   */
  _tickPoison(dt) {
    const p = this.player;

    // --- the spores, which is `_tickChill` with a mushroom instead of snow ---
    if (p.contactPoison) {
      this.sporeT += dt;
      if (this.sporeT >= SPORE_BITE * SPORE_PUFF) {
        // Once on crossing into the band, not per frame. `sink` is the soft low
        // burst a body going into quicksand makes and it is the right one
        // second time round: something giving way underfoot and letting go of
        // what was inside it.
        if (!this._sporeSaid) { this._sporeSaid = true; this.audio.sink('grass', p.position); }
        // Off the cap rather than off the head: this half of the cue is news
        // about the mushroom you are standing in, and it has to be visible when
        // you look DOWN at the thing your feet are in. `position` is the body's
        // foot, which is where the caps are.
        if (Math.random() < dt * 9) this.particles.spores(p.position, p.up, SPORE_COLOR, 0.7);
      }
      if (this.sporeT >= SPORE_BITE) {
        // Rearmed rather than left charged, so standing in a patch doses you
        // every 2.5 seconds rather than every frame after the first.
        this.sporeT = 0;
        this._sporeSaid = false;
        this.poison();
      }
    } else {
      this.sporeT = Math.max(0, this.sporeT - dt * SPORE_CLEAR);
      // Armed again only once the spores have actually cleared, not the moment
      // the feet leave the cap: stepping out and back in must not re-fire the
      // warning, which is the rule `_tickChill` writes down for the cold.
      if (this.sporeT <= 0) this._sporeSaid = false;
    }

    // --- the dose, which is `burning` with a different cadence ---------------
    if (this.poisonT <= 0) return;
    this.poisonT = Math.max(0, this.poisonT - dt);
    // A thin trickle of the same green around the body for the whole twelve
    // seconds, so the state is visible and not only the four frames it charges.
    //
    // **At the foot and not at the eye**, which the hot spring's steam can
    // afford and this cannot. Steam is an additive white sprite that fades; a
    // spore is an opaque tinted quad, and one 0.09 across spawned inside the
    // near plane fills a third of the screen with a flat green wedge. Measured
    // on a screenshot, which is the only way that was ever going to be found.
    // The foot is a metre and a half away and is where the player looks when
    // they look at their own feet, which is what a poisoned player does.
    if (Math.random() < dt * 2.5) this.particles.spores(p.position, p.up, SPORE_COLOR, 0.45);

    this._poisonT = (this._poisonT || 0) + dt;
    if (this._poisonT < POISON_PERIOD) return;
    this._poisonT = 0;
    // Never fatal. See the POISON_* block: the floor is tested rather than
    // clamped inside `_takeHit` for the reason the scald tests it, so the flash
    // and the hurt sound still fire on every tick above it.
    if (p.health <= 1) return;
    this._takeHit(1, 'Poisoned', false, 'poison');
  }

  /**
   * Take a dose. The one door into the poison, the way `_takeHit` is the one
   * door into damage.
   *
   * Both sources come through here — the mushroom above and `_tickEating` — so
   * "a dose refreshes and never stacks" is one line in one place rather than a
   * rule two callers are trusted to keep.
   */
  poison() {
    const p = this.player;
    if (this.spectating || p.health <= 0) return;
    // Assigned, not added. Twelve seconds from now, however many doses landed.
    const fresh = this.poisonT <= 0;
    this.poisonT = POISON_DOSE;
    // The cadence carries on across a second dose rather than restarting, so a
    // player cannot be charged an extra point for eating twice quickly - and
    // cannot dodge one by doing so either.
    if (!fresh) return;
    this._poisonT = 0;
    this.ui.toast('Poisoned', itemIdOf('deathcap'), 2600);
  }

  /**
   * Blocks that hurt to lean on. One today: the cactus.
   *
   * `guarded` is false, for the same reason lava's and fire's are. The immunity
   * window exists so a crowd of husks cannot land seven simultaneous blows on a
   * 20-point bar; a cactus is one block that cannot move, cannot gang up, and is
   * already paced by the timer below. Guarding it would also have meant a hit
   * from a husk buying you a free second inside the spines, which is backwards.
   *
   * CONTACT_PERIOD is the cadence and the block table holds only the number, so
   * a second hurting block does not get to invent its own rhythm — but it does
   * mean a fire, when there is one, burns at the same 2Hz. That is the trade and
   * it is the right way round: one predictable tempo the player learns once.
   *
   * 1 point every half second, against 20 health and a husk's 3, makes ten full
   * seconds of unbroken contact fatal. That is deliberately survivable — you
   * walk into a cactus by accident, in a biome you were crossing rather than
   * fighting in, and the punishment should be "back off and you keep about
   * everything", not a death. It is also exactly Minecraft's number, which is
   * worth matching for a block this recognisable.
   *
   * `kind` is 'blow' — spines are a physical injury and tolerance should read
   * against them the same way it reads against a husk's swing.
   */
  _tickContact(dt) {
    const hurt = this.player.contactHurt();
    if (hurt <= 0) { this._contactTimer = 0; return; }
    // A countdown reset to zero the moment contact ends, so the first frame you
    // touch one charges immediately and brushing past still costs you a point.
    // Accumulating upward instead would make a glancing touch free or expensive
    // depending on where in the cycle it happened to land, which is the sort of
    // rule a player reads as the game being inconsistent.
    this._contactTimer = (this._contactTimer || 0) - dt;
    if (this._contactTimer > 0) return;
    this._contactTimer = CONTACT_PERIOD;
    this._takeHit(hurt, 'Cactus', false, 'blow');
  }

  /**
   * A hot spring feeds you while you sit in it and scalds you if you stay.
   *
   * The shape is deliberately the arc of one visit rather than a toggle: the
   * bar climbs for 28 seconds, the water starts steaming around your head, and
   * three seconds after that it stings. A player who is watching leaves at the
   * steam and never takes a point of damage, which is the whole tutorial and it
   * is taught by the pool. See the SOAK_* block for the pricing.
   *
   * No skill soaks 'scald' — it is deliberately not one of Skills' SOAKED kinds
   * ('blow', 'fall', 'fire', 'lava'). Heat tolerance shaving this to nothing is
   * the one route by which a late-game player could sit in a pool indefinitely
   * and never cook again, and the ceiling on the whole feature is that you
   * cannot stay. Difficulty is untouched for the same reason the other
   * environment sources are: `mobDamageMul` is applied at the mob callsite, so
   * easy/normal/hard/extreme scale mobs and only mobs.
   */
  _tickSoak(dt) {
    const p = this.player;
    if (!p.inSpring) {
      this.soakT = Math.max(0, this.soakT - dt * SOAK_COOL);
      this._scaldT = 0;
      this._balmT = 0;
      return;
    }
    this.soakT += dt;

    // The cinderlands pool. All three bars, no clock, no sting. See BALM_HEAL.
    if (FACE_ROLE[p.face] === FACE_PYRE) {
      this._scaldT = 0;
      if (p.moveAmount <= SOAK_STILL) {
        this.energy = Math.min(1, this.energy + dt * SOAK_ENERGY);
        p.stamina = Math.min(1, p.stamina + dt * BALM_STAMINA);
        // A point at a time, like `_tickVitals` — health is a whole number
        // everywhere else, and a fractional one would show up in the bar and in
        // every `health <= 1` test.
        this._balmT += dt;
        const per = BALM_HEAL_SECS / p.maxHealth;
        while (this._balmT >= per && p.health < p.maxHealth) {
          this._balmT -= per;
          p.health += 1;
        }
        if (p.health >= p.maxHealth) this._balmT = 0;
      }
      return;
    }

    if (this.soakT < SOAK_WARM) {
      // Only while you are actually still. Swimming a pool on the way somewhere
      // is not a soak, and gating the *gain* rather than the clock means you
      // cannot wade in circles to dodge the scald either.
      if (p.moveAmount <= SOAK_STILL) {
        this.energy = Math.min(1, this.energy + dt * SOAK_ENERGY);
      }
      return;
    }

    // Past the warmth. Steam right on the player rather than out on the water,
    // so the cue is unmistakably about you and not about the pool. Four a
    // second, not more: `_tickSteam` already runs about eighty of Particles'
    // 128 steam instances when you are stood over a pool, and four against a
    // 2.6-4.8s life is fifteen more — which leaves the waterfall spray the
    // headroom that comment says it needs.
    if (Math.random() < dt * 4) this.particles.steam(p.eye, p.up, 0.35, 1);
    if (this.soakT < SOAK_WARM + SOAK_STING) return;

    this._scaldT = (this._scaldT || 0) + dt;
    if (this._scaldT < SCALD_PERIOD) return;
    this._scaldT = 0;
    // Never fatal, the way starvation is not, and for a reason lava does not
    // share: a hot spring *looks* like a rest spot. Lava is obviously lethal
    // and nobody idles in it, but a pool is somewhere a player will genuinely
    // step away from the keyboard, and on Extreme a death ends the run
    // outright. So it takes you down and leaves you there.
    //
    // The floor is tested rather than clamped inside `_takeHit`, so the last
    // point of health simply costs nothing: the flash and the sound still fire
    // on every sting above it, which is what teaches you to get out.
    if (this.player.health <= 1) return;
    this._takeHit(1, 'Scalded', false, 'scald');
  }

  /**
   * Run one subsystem's tick without letting it take the others down with it.
   *
   * Reported once per subsystem rather than once per frame: a broken tick
   * throws sixty times a second, and a console with thousands of identical
   * lines hides the first one, which is the only one that matters.
   */
  _safeTick(name, fn) {
    try {
      fn();
    } catch (err) {
      if (!this._tickErrors) this._tickErrors = new Set();
      if (!this._tickErrors.has(name)) {
        this._tickErrors.add(name);
        console.error(`[tick:${name}]`, err);
      }
    }
  }

  /**
   * Where the planet is in its day, 0..1 with 0 at midnight.
   *
   * One source for every consumer — sky, husk burning, husk spawning and the
   * HUD clock — so they can never disagree about whether it is night.
   */
  timeOfDay() {
    return this.settings.dayMinutes > 0 ? this.dayT : Sky.clockFraction();
  }

  /**
   * Advance the game clock, and the year with it.
   *
   * In clock-synced mode the time of day comes from the OS and `dayT` is not
   * used — but the *year* still has to turn, so it advances on wall-clock time
   * instead: one real day is one planet day. Returning early here left the
   * season frozen at whatever it was when the world loaded, which is the same
   * bug as counting only waking hours, just with a different cause.
   */
  /**
   * The bottom of the planet, the first time you get there.
   *
   * Thirty layers down through basalt, obsidian and the odd pocket of lava, and
   * what was waiting was a block you cannot break and no acknowledgement that
   * you had arrived. The planet gives you a hearth instead: the only one there
   * will ever be, and the reason to have dug.
   */
  /**
   * The endgame: the door, and the bodies.
   *
   * Two jobs on two clocks. The reconcile runs every frame because it is
   * chasing the despawn ring, which moves at whatever pace the player walks.
   * The door is asked once a second, on the same reasoning `Achievements.scan`
   * takes to the same question: counting a stack means walking forty slots, and
   * a thing that can happen once in a world's life has no business in the frame
   * budget.
   */
  _tickEndgame(dt) {
    this.endgame.update(this.player);
    this._endgameT = (this._endgameT ?? 0) - dt;
    if (this._endgameT > 0) return;
    this._endgameT = 1;
    this.endgame.check(this.inventory);
  }

  _tickCore(dt) {
    if (this.coreFound) return;
    this._coreT = (this._coreT ?? 0) - dt;
    if (this._coreT > 0) return;
    this._coreT = 0.4;
    const c = this.player.cell;
    if (c.k > CORE_REACH_K) return;
    // Actually next to it, not merely deep — the core tops out at layer 2 and
    // the last few layers of basalt are not the same achievement.
    const col = colIndex(c.x, c.y);
    let touching = false;
    for (let di = -1; di <= 1 && !touching; di++) {
      for (let dj = -1; dj <= 1 && !touching; dj++) {
        const cc = stepColumn(col, di, dj);
        for (let k = Math.max(0, c.k - 2); k <= c.k + 1; k++) {
          if (this.planet.at(cc, k) === ID.core) { touching = true; break; }
        }
      }
    }
    if (!touching) return;
    this.coreFound = true;
    this.inventory.add(itemIdOf('hearth'), 1);
    // The hearth's icon rides this toast and the item lands in the bar; a
    // second line spelling out that it keeps the night away is the game
    // playing itself. Let them plant it and find out.
    this.ui.toast('The core is warm to the touch.', itemIdOf('hearth'), 5000);
    this.audio.ui(880);
  }

  /**
   * Where the hearths are, for the spawner to keep away from.
   *
   * The set is maintained by edits, and every entry is checked against the
   * world before it is used — a cell can stop being a hearth by being mined,
   * burned or built over, and a ward that outlives its hearth would switch the
   * night off around an empty patch of ground for the rest of the game.
   */
  _refreshWards() {
    const out = [];
    for (const key of [...this.hearths]) {
      cellDecode(key, _kd);
      const col = _kd.col, k = _kd.k;
      if (this.planet.at(col, k) !== ID.hearth) { this.hearths.delete(key); continue; }
      out.push(this.planet.centerOf(col, k, new THREE.Vector3()));
    }
    this.mobs.wards = out;
    this.mobs.wardRadius = HEARTH_WARD;
  }

  _tickGrace(dt) {
    if (!(this.graceT > 0)) return;
    this.graceT -= dt;
    if (this.graceT > 0) return;
    this.graceT = 0;
    this.mobs.spawnGrace = false;
    // Say so. A player who has been quietly protected should learn that it has
    // stopped from a warning, not from dying.
    const t = this.timeOfDay();
    if (t < 0.25 || t > 0.75) {
      this.ui.toast('Something is moving in the dark.', itemIdOf('torch'), 4200);
    }
  }

  _tickClock(dt) {
    const mins = this.settings.dayMinutes;
    const days = mins > 0 ? dt / (mins * 60) : dt / 86400;
    if (mins > 0) this.dayT = (this.dayT + days) % 1;
    this.seasons.advance(days);
    this._pushSeason();
    this._tickSunTurn();
  }

  /**
   * Say the day has turned.
   *
   * Day and night are not decoration here — the husks burn off at dawn, the
   * spawner opens at dusk, the stalker walks, and `_tickNightOut` is counting
   * the minutes you spend outside under it. All of that was announced by the
   * colour of the sky and nothing else, which is no announcement at all to a
   * player who is forty blocks down a shaft.
   *
   * **At 0.25 and 0.75, which is not sunrise.** `Ambience.nightness` ramps over
   * 0.20-0.30 and 0.78-0.90, and the sky shader has its own idea again — but
   * the husk burn, the spawn grace and the outdoors-at-night mark all test
   * `t < 0.25 || t > 0.75`, so that is where the game's night actually begins
   * and ends. A cue for a dusk the rules disagreed with would be worse than no
   * cue, because a player would learn to trust it and then be caught out.
   *
   * The small-step guard is what keeps it honest across everything that moves
   * this clock other than time passing: loading a save, starting a world, or
   * sleeping through to morning all jump `dayT` by more than a frame's worth,
   * and none of them is a sunset the player watched arrive. In clock-synced
   * mode — the default, where a day is a real day — a frame moves the clock by
   * about 2e-7, so the threshold has four orders of magnitude of room.
   */
  _tickSunTurn() {
    const t = this.timeOfDay();
    const was = this._lastDayT;
    this._lastDayT = t;
    if (was === undefined) return;
    const step = t - was;
    if (step <= 0 || step > 0.02) return;
    if (was < 0.25 && t >= 0.25) this.audio.sunTurn(false);
    else if (was < 0.75 && t >= 0.75) this.audio.sunTurn(true);
  }

  /**
   * Freeze standing water in winter, and let it go in spring.
   *
   * Only the top of a body of water freezes, and only where it can see the sky:
   * a lake gets a lid you can walk out onto, an underground pool does not, and
   * what is under the lid stays water. The work is spread a few cells to a pass
   * so a lake ices over visibly from wherever you are standing rather than
   * appearing solid between two frames — and so a hundred cells of edits never
   * land on the mesher at once.
   */
  _tickFreeze(dt) {
    this._freezeT = (this._freezeT ?? 0) - dt;
    if (this._freezeT > 0) return;
    this._freezeT = FREEZE_PERIOD;
    const cold = this.seasons.cold;
    if (cold >= FREEZE_AT) this._freezeSome();
    else if (cold <= THAW_AT && this.frozen.size) this._thawSome();
  }

  /**
   * The highest *water* cell in this column with open air above it, or -1.
   *
   * The scan starts *below* the reported surface, not above it: surfaceK counts
   * the top of a lake as the surface, so beginning at surfaceK + 1 starts in the
   * air over the water and never sees the water at all.
   *
   * **Water specifically, not R_LIQUID, and the difference was winter melting
   * the planet's lava.** Lava is a liquid by render class and worldgen lava is
   * registered as a spring exactly as an ocean is, so the old test handed
   * `_freezeSome` the top of every open lava pool and it iced them over. That
   * alone would be odd; what made it destructive is that the thaw can only give
   * back one thing. Measured on a 7x7x2 lava pool, one winter and one spring:
   * 49 lava cells became ice, the ice came back as *water*, and that water
   * quenched the 49 lava cells underneath — a 98-cell pool ending as 49 water
   * and 49 obsidian, with the obsidian free and the lava gone. Volcano craters
   * and surface vents are open lava with air above them, so this was reachable
   * by standing near one for a season.
   *
   * The rule is the one `_freezeSome` already states for flow: the pass can
   * only ever hand back standing water, so it must only ever take standing
   * water.
   */
  _openWaterK(col) {
    const k0 = Math.max(1, this.planet.surfaceK(col) - 2);
    for (let k = k0; k < Math.min(D - 1, k0 + 10); k++) {
      if (this.planet.at(col, k) !== ID.water) continue;
      if (this.planet.at(col, k + 1) === 0) return k;
    }
    return -1;
  }

  _freezeSome() {
    const c = this.player.cell;
    const base = colIndex(c.x, c.y);
    const edits = [];
    for (let n = 0; n < FREEZE_SCAN && edits.length < FREEZE_BATCH; n++) {
      // Sampled rather than swept: a full disc is 2 000 columns a pass, and the
      // point is a lake that creeps over, not one that snaps.
      const di = Math.round((Math.random() * 2 - 1) * FREEZE_RADIUS);
      const dj = Math.round((Math.random() * 2 - 1) * FREEZE_RADIUS);
      const col = stepColumn(base, di, dj);
      const k = this._openWaterK(col);
      if (k < 0) continue;
      const key = cellIdx(col, k);
      if (this.frozen.has(key)) continue;
      // Only standing water freezes. A spring has no level entry; anything with
      // one is a flow, and a running stream icing over is both wrong and the
      // thing that would make the thaw below dishonest — it can only give back
      // standing water, so it must only ever take standing water.
      if (!this.water.sources.has(key)) continue;
      // A hot spring does not ice over, and that is the whole claim the feature
      // makes: 122 of the 179 sites are in Mountain and the rest are in Snow and
      // Tundra, so without this every one of them spends winter under a lid and
      // the one warm thing on the planet is indistinguishable from a puddle.
      // Told by the tuff floor the spring pass lays under its own pool, which is
      // the same three-block test the steam emitter uses -- see `_tickSteam`.
      if (this.planet.at(col, k - 1) === ID.tuff || this.planet.at(col, k - 2) === ID.tuff) continue;
      this.frozen.add(key);
      edits.push({ col, k, id: ID.ice });
    }
    if (edits.length) { this._applyEdits(edits); this._iceHeard(edits, true); }
  }

  /**
   * One crackle for a freeze or thaw pass, and only if it happened next to you.
   *
   * The sweep edits up to fourteen cells every 1.1 seconds across a 24-cell
   * radius, nearly all of them out of sight — a voice per cell would be
   * fourteen a second for the whole of winter, which is the single easiest way
   * to make this feature hateful. What is worth hearing is not "the world is
   * freezing", which is weather and which the season already says, but "the
   * water beside YOU just became something you can stand on", which is a fact
   * about the next step you take. So: nearest edit only, one per pass, and
   * nothing at all beyond `ICE_EARSHOT`.
   *
   * Positional even though it is gated on being close, because within those few
   * metres it still matters which side of you the lake is on.
   */
  _iceHeard(edits, freeze) {
    let best = null, bestD = ICE_EARSHOT * ICE_EARSHOT;
    for (const e of edits) {
      const d = wrapDist2(this.planet.centerOf(e.col, e.k, _v2), this.player.position);
      if (d < bestD) { bestD = d; best = _v1.copy(_v2); }
    }
    if (best) this.audio.ice(freeze, best);
  }

  _thawSome() {
    const edits = [];
    for (const key of this.frozen) {
      if (edits.length >= FREEZE_BATCH) break;
      this.frozen.delete(key);
      cellDecode(key, _kd);
      const col = _kd.col, k = _kd.k;
      // Mined out, built over, or already melted by other means — winter has no
      // claim on it any more either way.
      if (this.planet.at(col, k) !== ID.ice) continue;
      // Melts back into the lake it came from — as a spring, which is what it
      // was before it froze.
      //
      // Without this it came back as an *orphan*: water carrying neither a
      // source mark nor a flow level, which the sim is entitled to sweep away,
      // and does. Inside one session it happened to survive, because freezing
      // never removed the mark and nothing put it back; the mark is only lost
      // across a save, since a cell saved as ice is not liquid and so is not
      // seeded on load. So a world saved in winter came back in spring and
      // deleted its own lake surface, one thawed cell at a time — the cells
      // beside open water refilled as *flowing* water, and the ones without a
      // neighbour to feed them simply went. Measured: an orphan in a sealed
      // pocket is gone after a single tick.
      this.water.addSource(col, k);
      edits.push({ col, k, id: ID.water });
    }
    if (edits.length) { this._applyEdits(edits); this._iceHeard(edits, false); }
  }

  /**
   * The ground under the snowline goes white, and the ground above it comes
   * back. The seasons' other half.
   *
   * Everything else the season touched was a modifier on something that was
   * already moving: the tint of a leaf, the speed of a crop, whether falling
   * water lands as rain or as snow. The snow *blocks* were terrain, laid once
   * by the generator and permanent for ever after, so the snowline in
   * `Weather` slid up and down a mountain that never changed colour. This is
   * the part that makes the year mean something on the ground.
   *
   * Three rules, and each of them is a bound rather than a preference:
   *
   *  - **Near the player only** (`SNOW_RADIUS`), sampled rather than swept,
   *    exactly as the lake ice is. A sweep of the planet is not a bigger
   *    version of this feature, it is a different one: it would take every
   *    region on the map out of "the generator can make this again" and into
   *    the save.
   *  - **Twelve cells a pass**, so a season turning costs the same as a lake
   *    freezing over and never lands a hundred edits on the mesher at once.
   *  - **Nothing it cannot undo.** See `seasonSnow`. A pass that runs out of
   *    memory stops rather than making a change it cannot take back.
   *
   * ---- why this does not go through `_applyEdits` ----
   *
   * `_applyEdits` marks the region edited, which is what puts a region into the
   * save, and that is right for every block a *player* changes: the generator
   * cannot make it again. It is wrong for this one. A snow veneer is a function
   * of terrain the seed already describes and of a season the save already
   * stores, so both ends of it can be worked out again from a save that says
   * nothing about it — and it moves over the whole neighbourhood twice a year,
   * so marking it would put every region the player has ever *stood in* into
   * the save and undo the fix that took a save from 11.3 MB to 25 KB.
   *
   * So `_applySeasonEdits` writes the block, tells the worker, and patches the
   * occlusion volume, and stops there. What a reload actually looks like:
   * unedited regions come back the way the generator makes them — snowy — and
   * this pass restates the season over them within a couple of minutes of
   * standing there, from the memory that *is* saved. Regions the player has
   * built in are stored with whatever cover they had at the moment of the save,
   * which is also right, and the memory undoes it exactly when the year turns.
   *
   * ---- and why it does not flicker ----
   *
   * A region is generated once per session and never again: the worker's
   * `ensureRegions` skips anything with `hasDecor` set, and the main thread's
   * mirror is a full-planet array that eviction does not touch — only chunk
   * *meshes* are evicted, and a mesh is rebuilt from the mirror. So walking
   * away from a melted hillside and coming back cannot regenerate its snow. The
   * one place the generator gets to answer again is a fresh load of the world,
   * which is the paragraph above.
   */
  _tickSeasonSnow(dt) {
    this._snowT = (this._snowT ?? 0) - dt;
    if (this._snowT > 0) return;
    this._snowT = SNOW_PERIOD;
    // Which way the season is working, on the ice pass's thresholds and for the
    // ice pass's reason - a shared pair of numbers rather than a second set,
    // because "cold enough that winter acts" is one question and the lake
    // beside the hill had better not answer it differently from the hill.
    //
    // The direction has to be the season's rather than the altitude's, and that
    // is worth being plain about, because it was written the other way first
    // and measured: with both branches live at once, a *summer* pass covers
    // every ridge above its own line, so high ground gains snow in July, keeps
    // it, and the drift and gravel the generator textured the cap with are gone
    // for good. Snow is added while the year is cold and taken away while it is
    // warm; nothing above the summer line is ever uncovered, which is what a
    // permanent snowline is, and nothing below it stays white through a summer.
    const chill = this.seasons.cold;
    const freezing = chill >= FREEZE_AT;
    const thawing = chill <= THAW_AT;
    if (!freezing && !thawing) return;
    // The same snowline the sky uses, one number for the whole planet and one
    // read for the whole pass. Each column is then asked about the altitude of
    // its own ground rather than about the player's.
    const line = snowLine(chill);
    const c = this.player.cell;
    const base = colIndex(c.x, c.y);
    const edits = [];
    /**
     * Cells this pass has already decided about, and it is not an optimisation.
     *
     * The sampling is random over a 2 400-column disc, so 200 draws collide with
     * themselves a dozen times a pass, and the batch is not written into the
     * world until the end - which means the second draw on a column reads the
     * block from *before* the first draw and the memory from *after* it. That
     * combination is the one state this pass must never be in: a thaw that has
     * just restored the grass it took, and deleted its note saying so, is read
     * by the duplicate as a snow cell nobody remembers, and it is uncovered a
     * second time down to the subsoil. Measured over one forced year on seed
     * 4242: 23 of about 800 thawed columns came back as the block *under* the
     * one they started as - 16 of coarse dirt turned to peat, and the rest of
     * grass, gravel and stone turned to dirt.
     *
     * `_crushCrowded` keys its condemned cells by cell index for the same
     * reason. One pass, one decision per cell.
     */
    const seen = new Set();
    for (let n = 0; n < SNOW_SCAN && edits.length < SNOW_BATCH; n++) {
      const di = Math.round((Math.random() * 2 - 1) * SNOW_RADIUS);
      const dj = Math.round((Math.random() * 2 - 1) * SNOW_RADIUS);
      const col = stepColumn(base, di, dj);
      if (col < 0 || !this.planet.liveCol(col)) continue;
      // The cap is frozen, permanently and by definition - it is a snowfield,
      // not a place that happens to be cold this month. The season has no
      // memory of worldgen's own snow, so a thaw there had to guess what was
      // underneath and guessed dirt, which quietly turned the ice cap brown a
      // patch at a time. The owner: "snow blocks shouldn't change to dirt
      // blocks on snow face". Nothing seasonal touches that face at all.
      // The cinderlands are the same rule from the other end: it is the fire
      // face and worldgen puts no snow on it at all, but 1 629 of its columns
      // wear the stone and gravel of a steep ridge, which IS_SEASON_GROUND
      // accepts - so winter was whitening the ash fields. Neither dedicated
      // face has a season. Measured in a forced winter standing on a cinder
      // ridge, seed 4242: 67 cells went white over 200 passes, and 0 with this
      // clause; a temperate face still snows 751 in the same run.
      const role = FACE_ROLE[faceOfCol(col)];
      if (role === FACE_RIME || role === FACE_PYRE) continue;
      const k = this._seasonGroundK(col);
      if (k < 0) continue;
      const cur = this.planet.at(col, k);
      const isSnow = cur === ID.snow;
      /**
       * A tuft of grass or a flower standing on the ground gets **buried**.
       *
       * This is the line that decided what winter looks like, and the first
       * version of it - refuse any column whose top cell is not ground - made
       * the season unshippable. Meadow grass carries scattered tufts and
       * flowers at roughly every other column, so a refusal here snows the
       * columns between the plants and nothing else: winter arrived as a
       * literal chessboard of white and brown, and it was not a half-finished
       * sweep, it was the finished state. Measured on seed 4242, forced winter,
       * 1 139 open columns in the pass's own radius: coverage climbed for 65
       * seconds, stopped at 25.7%, and was still 25.7% two minutes later.
       *
       * Of the three things snow could do to an occupied column:
       *
       *  - **Bury it** - snow goes in the *plant's* cell and the plant is what
       *    the undo table remembers. Chosen. A cell holds one block id, so this
       *    is the only option that gets a whole meadow under one unbroken
       *    surface, which is what a snowfall is; and the plant comes back
       *    exactly, because the thaw already restores whatever it recorded.
       *  - **Snow the ground and leave the plant standing.** Rejected: it puts
       *    a summer-green tuft on top of every snow block on the planet, and it
       *    is the one variant that writes a solid block *under* an occupied
       *    cell, which is the assumption `_applySeasonEdits` is built on.
       *  - **Snow around it.** That is the chessboard, named as a feature.
       *
       * `IS_REPLACEABLE` is the predicate rather than a list of plant names,
       * for the reason it gives itself: it is derived from the render class, so
       * the sixteenth tuft of ground cover somebody adds is buried by winter on
       * the day it is added. The cell below still has to be ground this pass
       * owns, which keeps the rule off a crop (farmland is not season ground,
       * so a winter field keeps its rows) and off the lower half of anything
       * two cells tall (a stacked plant's own segment is not ground either).
       */
      const buries = !isSnow && !IS_SEASON_GROUND[cur] && IS_REPLACEABLE[cur]
        && IS_SEASON_GROUND[this.planet.at(col, k - 1)];
      if (!isSnow && !buries && !IS_SEASON_GROUND[cur]) continue;
      const key = cellIdx(col, k);
      if (seen.has(key)) continue;
      seen.add(key);
      const was = this.seasonSnow.get(key);
      // Altitude is the GROUND's, not the cell being written. A buried plant
      // sits one cell up, and asking the snowline about *that* cell would let a
      // column with a daisy on it cross the line one block of altitude before
      // its bare neighbour - a chessboard again, one contour ring wide, along
      // the edge of every snowfield. `was` names the buried plant, so the same
      // correction is available on the way back out.
      const onPlant = buries || (isSnow && was !== undefined && IS_REPLACEABLE[was]);
      const alt = (onPlant ? k - 1 : k) - SEA_K;
      if (freezing && !isSnow && alt > line) {
        // Cold enough for this column, and it is not white yet. Either we took
        // the snow off it and are putting it back, or this is ground - or a
        // plant standing on ground - that has never been under snow, and we
        // have to remember what it is.
        //
        // The threshold is the bare snowline here and `line - SNOW_BAND` on the
        // thaw, rather than the band being centred on the line, and that is the
        // second half of the chessboard fix. Centred, the deepest winter the
        // year has - `cold` = 1, so `snowLine` = 0 - could still only reach
        // ground above altitude 1.5, and every shore, meadow and valley floor
        // under that stayed brown through a winter that had snowed the hillside
        // behind it. The band is a *gap between two thresholds* and it does its
        // job wherever it is put: a column that freezes at line L needs the line
        // to climb past L + 1.5 before it thaws, which is the same 1.5 blocks of
        // hysteresis it always had. It is belt and braces even so, because
        // freezing only runs at `cold` >= 0.55 and thawing only at <= 0.35, and
        // that alone keeps the two lines 1.8 blocks apart.
        //
        // What it does not change is the permanent snowline, which is the thaw's
        // to set and is still `snowLine(0) - SNOW_BAND` = 7.5: everything winter
        // lays between 0 and 7.5 comes off again in summer, and only the caps
        // above that keep it.
        if (was === ID.snow) this.seasonSnow.delete(key);
        else if (this.seasonSnow.size < SNOW_MEMORY) this.seasonSnow.set(key, cur);
        else continue;
        edits.push({ col, k, id: ID.snow });
      } else if (thawing && isSnow && alt < line - SNOW_BAND) {
        let to = was;
        if (to !== undefined && to !== ID.snow) {
          this.seasonSnow.delete(key);
        } else {
          // Snow the generator laid. What is under it is what a thaw uncovers,
          // read off the column rather than assumed: dirt under a snowfield,
          // gravel under a drift, stone on a ridge. If what is under it is not
          // ground this pass is allowed to expose - packed ice, most often,
          // which is a glacier and not a snowfall - it stays where it is.
          to = this.planet.at(col, k - 1);
          if (!IS_SEASON_GROUND[to]) continue;
          if (this.seasonSnow.size >= SNOW_MEMORY) continue;
          this.seasonSnow.set(key, ID.snow);
        }
        edits.push({ col, k, id: to });
      }
    }
    if (edits.length) this._applySeasonEdits(edits);
  }

  /**
   * The top of the ground in a column, with open air over it, or -1.
   *
   * Not `Planet.surfaceK`, and the difference matters twice over. That one
   * scans the whole 99-layer column from the top down, which is 200 columns'
   * worth of scanning per pass here for an answer the height field already
   * knows; and it reports the top of whatever is *standing* on the ground, so
   * under a tree it hands back the canopy and under a lake it hands back the
   * bed with ten feet of water over it.
   *
   * A short window around `colHeight` answers both. Starting three layers above
   * the generated height and giving up seven below it, the first non-air cell
   * found is the top of the column and everything above it inside the window is
   * air by construction - which is the sky test as well, for free: a cave
   * floor, a cellar and the soil under somebody's floorboards are all far
   * enough from the height field that the window never reaches them. Snow does
   * not fall through a roof and it does not settle between the roots of a tree.
   *
   * What it hands back is the top *cell*, which is not always ground: a trunk
   * or a flower standing on the ground is found before the ground is. The
   * caller decides what that means, and it decides differently for the two -
   * see `buries` in `_tickSeasonSnow`, where a flower is buried and a trunk
   * refuses the column. This function used to make that call itself by
   * returning -1 for anything it did not like the look of, and the chessboard
   * winter is what that cost.
   */
  _seasonGroundK(col) {
    const top = Math.min(D - 2, Math.floor(this.planet.colHeight[col]) + 3);
    const low = Math.max(1, top - 7);
    for (let k = top; k >= low; k--) {
      if (this.planet.at(col, k) === 0) continue;
      return k < top ? k : -1;
    }
    return -1;
  }

  /**
   * Write a seasonal batch into the world without claiming the player made it.
   *
   * The three things every edit has to do - the mirror, the worker's copy, and
   * the occlusion volume the shader marches - and none of the four cascades
   * `_applyEdits` runs afterwards, because none of them can fire here. Nothing
   * in this batch crowds a cactus: snow, soil and the tufts a thaw hands back
   * are ordinary blocks and `NEEDS_ROOM` names none of them - a cactus is a
   * cube and so is never one of the plants winter buries. Nothing loses its
   * floor: the cell above is air, which `_seasonGroundK` has already
   * established, so there is nothing standing on what we overwrite, and a plant
   * put back by a thaw is put back on the ground it was growing in. Nothing is
   * roofed over: the cell above is still air afterwards.
   * Nothing falls: a swap in place changes no support, and the block that was
   * there was holding up whatever is above it just as well. And no lava is
   * involved, so `_meltSnow` - which is the other, unrelated rule about snow
   * disappearing - has nothing to say either.
   *
   * `editedRegions` is the deliberate omission. See `_tickSeasonSnow`.
   */
  _applySeasonEdits(edits) {
    for (const e of edits) {
      // A block change can still open or close a path for water, and the flow
      // sim is cheap to tell.
      this.water?.onEdit(e.col, e.k);
      this.planet.setAt(e.col, e.k, e.id);
      // Neither snow nor any ground in `IS_SEASON_GROUND` is directional, so
      // this only ever clears a stale entry - which is exactly what it is for.
      this.planet.applyFacing(e.col, e.k, e.id);
    }
    this.worldWorker.postMessage({ type: 'edit', edits, id: ++this.editSeq });
    this._patchOcclusion(edits);
  }

  /** Hand the current season to the shader that colours the world. */
  _pushSeason() {
    const s = this.seasons;
    voxelUniforms.uSeasonColor.value.set(s.color[0], s.color[1], s.color[2]);
    voxelUniforms.uSeasonStrength.value = s.strength;
    /**
     * Snow on the canopy, which `LEAF_SNOW_FRAG` draws and `_tickSeasonSnow`
     * structurally cannot reach — see that comment for the measurement and for
     * why this is a colour rather than a block.
     *
     * It rides `cold` over the same window the ground pass runs in, and that is
     * the whole of the agreement between them: the wood whitens while the
     * ground beneath it is freezing and is gone by the time the ground has
     * thawed. FREEZE_AT is where the ground pass starts laying snow and THAW_AT
     * is where it starts taking it off, so a canopy is never white over ground
     * that is being uncovered, and never bare over ground that is being covered.
     *
     * Deliberately NOT altitude-gated, and it was the first thing tried. The
     * ground pass asks whether a column's own altitude is over the snowline; a
     * shader knows only the *leaf's* altitude, which is five to twelve blocks
     * higher than the ground it grew from, so a sea-level wood in high summer
     * has canopy cells above the summer line of 9 and the whole forest would
     * come out white in July. The season is the one signal that means the same
     * thing at both heights.
     */
    const chill = s.cold;
    voxelUniforms.uSnowCap.value = Math.max(0,
      Math.min(1, (chill - THAW_AT) / (FREEZE_AT - THAW_AT)));
  }

  /** Nourishment drains with effort and slowly heals you while it lasts. */
  _tickVitals(dt) {
    const p = this.player;
    const working = p.sprinting ? 1.6 : (p.moveAmount > 0.6 ? 0.7 : 0.18);
    this.energy = Math.max(0, this.energy - dt * 0.0022 * working);
    // Movement reads nourishment off the Player rather than the Game, so the
    // gait scale can live beside the gait constants. Mirrored here and only
    // here: eating and a hot spring soak both write `this.energy` from
    // elsewhere, and this runs every frame, so one assignment covers all of
    // them with at most a frame of lag. Without it `Player.energy` sits at its
    // default of 1 for ever and the whole taper is dead code.
    p.energy = this.energy;

    if (this.energy > 0.55 && p.health < p.maxHealth) {
      this._regen = (this._regen || 0) + dt;
      if (this._regen > 4.5) {
        this._regen = 0;
        p.health = Math.min(p.maxHealth, p.health + 1);
        this.energy = Math.max(0, this.energy - 0.02);
      }
    } else this._regen = 0;

    // running on empty hurts, slowly
    if (this.energy <= 0) {
      this._starve = (this._starve || 0) + dt;
      if (this._starve > 8) {
        this._starve = 0;
        p.health = Math.max(1, p.health - 1);
        this.damageFlash = 0.35;
      }
    } else this._starve = 0;
  }

  /**
   * Rough block light reaching the player, for lighting the held item.
   *
   * The authoritative light field lives in the world worker and is never sent
   * to the main thread — it's a million cells and would have to be re-shipped
   * on every block edit. For one point of light on one hand, a short scan of
   * the emitters nearby is both cheaper and accurate enough: it's a handful of
   * cells, and anything further than a few blocks contributes almost nothing.
   */
  _handLight() {
    const c = this.player.cell;
    const ck = c.k;
    const baseCol = colIndex(c.x, c.y);

    // Nothing about this changes until you cross into another cell or the world
    // is edited, and the scan is ~2000 cell reads — by far the most expensive
    // thing in the update loop if left to run every frame. Cache on both.
    if (this._hlCol === baseCol && this._hlK === ck && this._hlSeq === this.editSeq) {
      return this._hlValue;
    }
    this._hlCol = baseCol; this._hlK = ck; this._hlSeq = this.editSeq;

    let r = 0, g = 0, b = 0;
    // Lava is an emitter, so the scan below already walks over every cell of it
    // within a few blocks of you — which makes this the one place in the game
    // that knows you have found some without casting a single extra ray. It
    // only runs when the cache misses, i.e. when you move a cell or edit the
    // world, and `_mark` is idempotent, so the cost of asking is a comparison.
    let sawLava = false;
    // Every burning cell this scan passes is also somewhere a flame should be
    // seen, and the scan is already here and already cached — collecting them
    // costs a push. Doing it as its own sweep would be a second 2 000-cell walk
    // per frame for the same answer.
    const flames = this._flameCells;
    flames.length = 0;
    // Same argument as the flames, one step further: this scan is the only
    // thing in the game that already knows where the nearby lights are, and
    // entities need that too — see `_entityLight`. Collecting them costs a
    // push and a `centerOf` on a cache miss.
    const emitters = this._emitters;
    emitters.length = 0;
    // And one step further again, for the two placed fire beds. Same argument
    // as the flames: this loop already visits every burning and every molten
    // cell in range and already knows how far away each one is, so the nearest
    // of each costs a comparison. `n` is the count, which is the difference
    // between a torch and a bonfire, and between a spill and a lake.
    let fireN = 0, fireD2 = Infinity, fireCol = 0, fireK = 0;
    let lavaN = 0, lavaD2 = Infinity, lavaCol = 0, lavaK = 0;
    // The scan has to reach at least as far as the brightest light carries, or
    // the contribution clips at the boundary instead of fading — walking away
    // from a torch would step the hand light from 0.21 straight to 0.
    const RAD = HAND_LIGHT_RADIUS;
    for (let di = -RAD; di <= RAD; di++) {
      for (let dj = -RAD; dj <= RAD; dj++) {
        const col = stepColumn(baseCol, di, dj);
        for (let dk = -3; dk <= 4; dk++) {
          const k = ck + dk;
          if (k < 0 || k >= D) continue;
          const id = this.planet.at(col, k);
          const bl = BLOCKS[id];
          const emit = bl?.light;
          if (!emit) continue;
          if (id === ID.lava) sawLava = true;
          // Only things that actually burn get a flame. Glowstone and crystal
          // are lit, not alight.
          if (FLAME_BLOCKS.has(id) && flames.length < MAX_FLAMES) {
            flames.push({ col, k, id, byte: this.planet.facingAt(col, k) });
          }
          // Falloff in cells, capped at the scan radius so it always reaches
          // exactly zero at the edge rather than being cut off mid-curve.
          const d2 = di * di + dj * dj + dk * dk;
          if (FLAME_BLOCKS.has(id)) {
            fireN++;
            if (d2 < fireD2) { fireD2 = d2; fireCol = col; fireK = k; }
          } else if (id === ID.lava) {
            lavaN++;
            if (d2 < lavaD2) { lavaD2 = d2; lavaCol = col; lavaK = k; }
          }
          const reach = Math.min(emit * 0.55 + 1, RAD);
          const lc = bl.lightColor || WHITE_L;

          // The same emitter, kept in world space for anything that is not the
          // player. Full when a lava sheet is in range, and then the *farthest*
          // record is the one that goes: the scan walks in row order, so an
          // untouched list would keep one corner of the sheet and drop the cells
          // you are standing next to. Only ever runs on a cache miss.
          //
          // Recorded *before* the falloff test below, and that ordering is the
          // point: a torch eight cells away throws nothing on you and is still
          // the only thing lighting the deer standing next to it. The player's
          // own answer may drop an emitter for being out of its reach; the
          // list must not, because the list is asked about other places.
          let slot = emitters.length;
          if (slot >= MAX_ENTITY_EMITTERS) {
            // Full: displace the farthest record, or nothing if this cell is
            // farther than all of them.
            slot = -1;
            let worstD2 = d2;
            for (let n = 0; n < emitters.length; n++) {
              if (emitters[n].d2 > worstD2) { worstD2 = emitters[n].d2; slot = n; }
            }
          } else {
            emitters.push(this._emitPool[slot]
              || (this._emitPool[slot] = { pos: new THREE.Vector3(), r: 0, g: 0, b: 0, reach: 1, d2: 0 }));
          }
          if (slot >= 0) {
            const rec = emitters[slot];
            this.planet.centerOf(col, k, rec.pos);
            const s = emit / 15;
            rec.r = lc[0] * s; rec.g = lc[1] * s; rec.b = lc[2] * s;
            rec.reach = reach;
            rec.d2 = d2;
          }

          const fall = Math.max(0, 1 - Math.sqrt(d2) / reach);
          if (fall <= 0) continue;
          const w = (emit / 15) * fall * fall;
          r = Math.max(r, lc[0] * w); g = Math.max(g, lc[1] * w); b = Math.max(b, lc[2] * w);
        }
      }
    }
    // "Find lava underground" - so the player has to actually be underground,
    // and not merely standing on ground that happens to have some under it.
    //
    // `sawLava` is set by the emitter scan above, which sweeps a box three
    // layers below the feet to four above and does not care whether anything in
    // it is visible. Spawning on a column with a lava pocket under it therefore
    // awarded the mark - 200 xp - on the first frame of a new world, for
    // finding nothing. Reported as "I just spawned in a new world and I got
    // 200exp for some reason".
    //
    // The depth test is the mark's own wording made true: you are under the
    // surface of the column you are standing in, by more than the scan reaches
    // down, so the lava it found is lava you have gone to.
    if (sawLava) {
      const c = this.player.cell;
      const surf = this.planet.surfaceK(colIndex(c.x, c.y));
    }

    // A single torch on a wall is a small, close, quiet thing and six of them
    // round a camp is a fire; one cell of spilled lava trickles and the surface
    // of a lake roars. Both curves start well above zero because the nearest
    // one is the one you are standing next to either way.
    this._fireNear = fireN > 0;
    this._lavaNear = lavaN > 0;
    if (fireN) {
      this.planet.centerOf(fireCol, fireK, this._fireAt);
      this._fireSrc.size = Math.min(1, 0.55 + fireN / 9);
    }
    if (lavaN) {
      this.planet.centerOf(lavaCol, lavaK, this._lavaAt);
      this._lavaSrc.size = Math.min(1, 0.40 + lavaN / 16);
    }

    this._hlValue = { r, g, b };
    return this._hlValue;
  }

  /**
   * Block light reaching an *entity*, in the units its emissive wants.
   *
   * ### Read this first: there are two answers in here, and the second is a
   * fallback
   *
   * The answer that ships is the local light field — a flood fill over the
   * volume around the player, in the same units and by the same tables as the
   * world worker's, so an animal and the ground it is standing on are lit out
   * of fields that agree. See `EntityLight.js` for what it is, what it costs
   * and the measurements that made it necessary.
   *
   * Everything below the field's early return is the probe that was here
   * before: a walk over the emitters within eight columns of the *player*, with
   * a shadow ray per emitter. It is kept, unchanged, for the case the field
   * cannot answer — no volume yet, or a body standing outside the box. Failing
   * to it rather than to black is the whole contract, and the rest of this note
   * is about it rather than about the field.
   *
   * What the field fixed, in one line: an animal two cells from a torch, in a
   * sealed room, with the player seventeen columns down it, rendered at 36/255
   * against a floor at 120 — the same 35 it rendered at seventeen cells from
   * the torch on a floor at 3.8. It could not see a torch the player was not
   * beside, and it could not bend around a corner.
   *
   * ### Why entities needed one at all
   *
   * Every light in this world except the one in your hand is baked into the
   * voxel grid, and an animal is not a chunk. Terrain reads its torchlight out
   * of `blockLight`; a cow, a husk, the merchant, the player's own body and a
   * dropped model have no such attribute and no way to fill one, so a torch
   * planted at their feet did *nothing* to them. That is why a mob at night
   * looked black next to ground the same torch had lit to orange, and it is the
   * half of the report that no amount of tuning the sky fill could have fixed.
   *
   * ### Why a scan and not the flower route
   *
   * Instanced flowers get their block light from a per-instance attribute the
   * mesher ships in the chunk payload (see `applyInstancedSway`). That works
   * because a flower is static and chunk-resident: its cell is known at mesh
   * time and never moves. A mob moves continuously and belongs to no chunk, so
   * it would need the sample re-fetched every frame anyway — and `crossLight`
   * only covers cells that *contain* a cross, which is not where mobs stand. So
   * the attribute route buys nothing here and the emitter scan buys everything:
   * it is already running, already cached, and answers for an arbitrary point.
   *
   * ### What it costs
   *
   * Nothing on a miss — `_handLight` is cached on the player's cell and
   * `editSeq`, exactly as before — and one pass over at most
   * MAX_ENTITY_EMITTERS records per entity per frame otherwise, which for a
   * full herd is a few hundred distance tests. The early return means the
   * common case (no light source anywhere near you) is a single length check.
   *
   * ### What it cannot see
   *
   * The scan is centred on the *player* and reaches HAND_LIGHT_RADIUS, so a mob
   * lit by a torch twenty cells away gets nothing. That is the right trade: no
   * block light carries further than the scan does, so the only thing missed is
   * a torch that is near the mob and far from you — i.e. one you are looking at
   * from across a valley, at which range the mob is a few pixels.
   *
   * ### Walls
   *
   * It used to say here that it did not know about them, and that matching the
   * baked field would cost "a raycast per emitter per entity per frame". That
   * was true when it was written and is not any more: the moving flames' shadow
   * volume (`_rebuildOcclusion`) is a 48x48x32 byte array of opaque/not sitting
   * on this thread, refreshed as the player walks, and the raycast in question
   * is at most fourteen indexed reads into it. So the ray is now cast — see
   * `_occMarch` — and a torch on your side of a wall no longer lights the deer
   * on the far side of it while lighting none of the ground around it.
   *
   * What kept the cost down, in the order it matters:
   *
   *  - The combine is a `max`, so candidates are walked brightest-first and the
   *    loop stops the moment the best a remaining one could add is under what
   *    every channel already has. A lava sheet is two dozen emitters of one
   *    colour and settles after the first march rather than twenty-four.
   *  - An emitter already out of its own reach never gets marched, exactly as
   *    before; the distance test is still the first thing that runs.
   *  - Every answer is cached on the *cell* the entity stands in, not on the
   *    entity, and thrown away when the emitter list or the volume changes. A
   *    still herd in a lit barn marches once for the lot of them and then costs
   *    a masked bit test each per frame. Caching per entity was the first
   *    thought and this probe is handed a bare position with no identity behind
   *    it, so there was nothing to key on — and cells are the better key
   *    anyway, since two animals shoulder to shoulder genuinely have the same
   *    answer.
   *
   * ### Where an animal and the ground under it can still disagree
   *
   * They agree about what a wall is — same volume, same step, same corner
   * guard. A differential test against an exact DDA over 144 316 random rays in
   * random volumes finds this march exact in both directions: no false shadow
   * and no leak. What they do not share is the *field*:
   *
   *  - A planted torch lights terrain out of the baked light grid in the world
   *    worker, which is a flood fill and therefore bends around corners; this is
   *    a straight line. Round a corner from a torch the floor is dimly lit and
   *    the mob standing on it is dark. Straight is the more defensible half of
   *    that pair, and the flood fill is a million cells that never come to this
   *    thread, so it is not a difference that can be closed here.
   *  - The terrain's march runs only for the two *moving* flames. For those the
   *    two answers are the same test off two different origins — the ground's
   *    starts at the fragment plus OCC_BIAS along its normal, this one at the
   *    centre of the entity's cell — so at the edge of a shadow the animal can
   *    be up to a cell out of step with the floor it is on.
   *  - Leaves and water are not in the volume (a flame should shine through a
   *    canopy) but do dim the baked grid, so under a tree the ground is darker
   *    than the deer.
   *  - The two stop short of the light by different amounts and for different
   *    reasons — OCC_ENTITY_NEAR against the shader's OCC_NEAR, see the
   *    constant — so an occluder in the half cell between them shadows an
   *    animal and not the floor.
   *
   * Measured on the worst herd the scan can produce — 130 mobs all standing
   * inside the reach of all 24 emitters, which is a full spawn cap packed into
   * one lava cavern — the whole probe costs 0.093 ms a frame with the cache
   * warm and 0.110 ms on a frame where every answer is recomputed from scratch
   * (214 marches). The same herd cost 0.048 ms before occlusion existed, so the
   * walls are worth about 0.06 ms a frame at the very top end and nothing
   * measurable in a field with one torch in it.
   *
   * ### The two things that made this do nothing at all when first written
   *
   * Recorded because neither is visible from the march, and staring at the
   * march is what one does when no shadow appears. It was correct the whole
   * time and answering about the wrong world. First, the volume was not
   * refilled when a block changed, so a wall built between a torch and an animal
   * was not in it — see `_patchOcclusion`. Second, the near-field stop was the
   * shader's 1.5 cells, which at the two-to-three-cell range a wall actually
   * has leaves no marchable span at all — see OCC_ENTITY_NEAR. Both are now
   * covered by a harness that builds a world, places a torch, walls it off and
   * probes without moving the player.
   *
   * @param {THREE.Vector3} pos world point to sample
   * @param {{r:number,g:number,b:number}} out written in place and returned
   */
  _entityLight(pos, out) {
    out.r = 0; out.g = 0; out.b = 0;
    // The gain the terrain applies to its own block light, read live off the
    // uniform rather than copied — a torch-lit mob and the torch-lit dirt under
    // it answer by the same amount and can never drift apart. RECIPROCAL_PI
    // because the terrain's term carries the same Lambert factor; without it a
    // lit mob would come out pi times brighter than the ground it stands on.
    const gain = voxelUniforms.uBlockIntensity.value / Math.PI;

    // The field, if it covers this point. It answers in the terrain's own
    // `blockLight` units — level over fifteen, per channel — so the only thing
    // between it and a mob's emissive is the same gain the terrain applies.
    const field = this._entityField();
    if (field) {
      const l = this._worldToOccCell(pos, _occLocal);
      if (field.sample(l.x, l.y, l.z, out, occupancyData)) {
        out.r *= gain; out.g *= gain; out.b *= gain;
        // ...and the two flames that are not in the grid at all.
        this._movingLight(pos, l, out);
        return out;
      }
    }

    // --- fallback: the player-centred emitter probe -------------------------
    // Cached; this is what keeps the emitter list in step with the world.
    this._handLight();
    const emitters = this._emitters;
    if (!emitters.length) return out;

    // --- who is in range at all, brightest first ---
    const ord = this._emitOrder || (this._emitOrder = new Int32Array(MAX_ENTITY_EMITTERS));
    const wt = this._emitW || (this._emitW = new Float64Array(MAX_ENTITY_EMITTERS));
    const key = this._emitKey || (this._emitKey = new Float64Array(MAX_ENTITY_EMITTERS));
    let n = 0;
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      const d = wrapDist(pos, e.pos);
      if (d >= e.reach) continue;
      // Same curve as the hand light's, in world units rather than cells, and
      // a cell is exactly one unit now.
      // Linear for the same reason `flameLight` is: the terrain's own block
      // light loses one level per cell, so a squared curve here made a mob
      // several times darker than the ground it stands on. "Why is a lion
      // walking near a lava showing black model, I have to get very close
      // before it shows color" - at half a lava pool's reach the ground under
      // the lion was lit 0.50 and the lion 0.25.
      const fall = 1 - d / e.reach;
      const w = fall * gain;
      const k = Math.max(e.r, e.g, e.b) * w;
      if (!(k > 0)) continue;
      wt[i] = w; key[i] = k;
      // Insertion sort into `ord`, descending. At most MAX_ENTITY_EMITTERS
      // items and usually two or three, so this is cheaper than it looks and it
      // is what makes the early break below worth anything.
      let s = n++;
      while (s > 0 && key[ord[s - 1]] < k) { ord[s] = ord[s - 1]; s--; }
      ord[s] = i;
    }
    if (!n) return out;

    // Null when there is no usable volume or this point is outside it: then
    // nothing below marches and the answer is exactly the unoccluded one.
    const ctx = this._entityOcc(pos);

    for (let s = 0; s < n; s++) {
      const i = ord[s];
      // Descending, and the combine is a max: once the brightest channel a
      // candidate could contribute is under what every channel already holds,
      // no candidate after it can change the answer either.
      if (key[i] <= out.r && key[i] <= out.g && key[i] <= out.b) break;
      const e = emitters[i], w = wt[i];
      const er = e.r * w, eg = e.g * w, eb = e.b * w;
      // Same test per channel, for the case a dimmer emitter of another colour
      // still cannot lift anything. Skipping here skips the march too.
      if (er <= out.r && eg <= out.g && eb <= out.b) continue;
      if (ctx && !this._occVisible(ctx, i, e.reach)) continue;
      // Max rather than sum, again matching `_handLight`: two torches in a room
      // are not twice the lamp, and a lava sheet summed over two dozen cells
      // would render anything near it pure white.
      if (er > out.r) out.r = er;
      if (eg > out.g) out.g = eg;
      if (eb > out.b) out.b = eb;
    }
    return out;
  }

  /**
   * The torch in your fist, and the one lying on the floor, on a body.
   *
   * ### Why they are here and not in the field
   *
   * Everything else that lights an entity comes out of `EntityLight`, which is
   * a flood over a grid: it is rebuilt when the player drifts three cells or a
   * block changes, and it holds fifteen discrete levels. A carried flame moves
   * every frame and sits between cells, so it cannot go into that grid without
   * reflooding it sixty times a second. It is an extra term at the sample site
   * instead, which is exactly what the shader does with the same two lights on
   * the terrain side: the grid and the flames are added there too.
   *
   * ### The units, which are the whole job
   *
   * The shader's moving term is `lcol * wrap * fall`, added to the grid's
   * `vBlock * uBlockIntensity`, and the pair is multiplied by RECIPROCAL_PI.
   * `_entityLight` hands back the grid half already scaled by
   * `uBlockIntensity / PI`, so the matching moving half is `lcol * fall / PI` —
   * the same uniform, the same linear falloff, the same divisor. Nothing here
   * is a tuned constant; move the flame's gain or reach and this follows on its
   * own, which is the property that keeps a torch-lit cow and the torch-lit
   * floor under it from drifting apart.
   *
   * `wrap` is deliberately dropped. It is the shader's lambert term and a body
   * has no single normal to take one against — the emissive it ends up in is
   * flat over the whole model, exactly as the grid term is.
   *
   * ### Max, not sum, and that is a call
   *
   * The terrain *adds* the flames to the grid and then rolls the pair off
   * through BLOCK_KNEE. There is no such shoulder on a body, and the rest of
   * this probe has always combined lights with a max — "two torches in a room
   * are not twice the lamp" — so a max is what a body gets. The visible
   * consequence is that walking into an already torch-lit room carrying a torch
   * does not brighten the animals in it further. The alternative is to add and
   * clamp, and it would need a shoulder of its own to avoid blowing a white cow
   * out at arm's length.
   *
   * ### Walls
   *
   * Marched, through the same occupancy volume and the same `_occMarch` as
   * everything else, so a carried torch does not light a deer through the wall
   * you are standing against. Not cached, and it cannot be: the cache in
   * `_entityOcc` is keyed on the emitter list, which changes only when the
   * world does, and this light moves with your head. One march per body per
   * frame while a flame is lit, which is the cost the old probe paid for every
   * emitter in range.
   */
  _movingLight(pos, l, out) {
    const u = voxelUniforms;
    let ctx = null;
    for (let i = 0; i < 2; i++) {
      const rad = i ? u.uDropLightRadius.value : u.uHandLightRadius.value;
      if (rad <= 0.01) continue;
      const lp = i ? u.uDropLightPos.value : u.uHandLightPos.value;
      const d = wrapDist(pos, lp);
      if (d >= rad) continue;
      const col = i ? u.uDropLightColor.value : u.uHandLightColor.value;
      const fall = (1 - d / rad) / Math.PI;
      const r = col.x * fall, g = col.y * fall, b = col.z * fall;
      // Nothing to add on any channel, so nothing to march for either.
      if (r <= out.r && g <= out.g && b <= out.b) continue;
      if (!ctx) {
        ctx = this._flameCtx || (this._flameCtx = { slot: 0, cx: 0, cy: 0, cz: 0 });
        // The centre of the cell the body stands in, which is where every other
        // entity ray starts, so a flame and a planted torch cast the same
        // shadow off the same point. See `_entityOcc` for why it is quantised.
        ctx.cx = Math.floor(l.x) + 0.5;
        ctx.cy = Math.floor(l.y) + 0.5;
        ctx.cz = Math.floor(l.z) + 0.5;
      }
      const fc = this._worldToOccCell(lp, _occFlame);
      if (!this._occMarch(ctx, fc.x, fc.y, fc.z, rad)) continue;
      if (r > out.r) out.r = r;
      if (g > out.g) out.g = g;
      if (b > out.b) out.b = b;
    }
    return out;
  }

  /**
   * The local block light field, flooded if it has gone stale, or null if there
   * is no volume to flood.
   *
   * Lazy on purpose, and lazy at exactly one grain: the flood runs on the first
   * sample taken after the volume moved or a block changed, and not at all on a
   * frame where nothing samples it. A planet with no mobs in view, no drops on
   * the ground and the body hidden in first person pays for the volume (which
   * the shader wants anyway) and nothing else.
   *
   * `_lfDirty` is set by the only two things that can change the answer:
   * `_rebuildOcclusion`, which moves the box, and `_patchOcclusion`, which
   * carries an edit into it. A streamed region arriving at
   * `planet.applyRegions` is missed, exactly as the occupancy volume misses it
   * and for the same reason — that terrain is a long way from the player and
   * the box is recentred before they reach it.
   *
   * Measured on the shipped volume, 48x48x32, seed 4242, headless d3d11:
   *
   *   nothing burning nearby        0.077 ms
   *   one torch                     0.080 ms
   *   nine torches, a lit room      0.183 ms
   *   121 glowstone, a lit cavern   0.349 ms
   *
   * It fires on a recentre — about every 0.6 s at a run, since the volume moves
   * only when the player drifts OCC_HYST cells out of the middle — and on an
   * edit, so a mining session pays it a few times a second and a walk pays it
   * twice. The sample itself is 0.13 us, so a full spawn cap of 130 animals
   * plus a floor of drops costs about 0.02 ms a frame between them. The probe
   * this replaces cost 0.093 ms a frame for the animals alone.
   */
  _entityField() {
    const o = this._occ;
    if (!o || !o.ready || !this._occIds) return null;
    const f = this._lightField
      || (this._lightField = new EntityLightField(OCC_NI, OCC_NJ, OCC_NK));
    if (this._lfDirty) {
      this._lfDirty = false;
      f.build(this._occIds, occupancyData);
    }
    return f;
  }

  /**
   * Set up the shadow test for one entity, or return null to leave it lit.
   *
   * ### Failing open is the whole contract
   *
   * The volume covers a bounded box around the player and an entity can stand
   * outside it — up a mountain, across a valley, or simply before the first
   * build has run. Every one of those returns null here and the caller then
   * behaves exactly as it did before occlusion existed. That direction is not
   * arbitrary: a mob lit through a wall is a wrong pixel, a mob that goes black
   * because it wandered out of an invisible box is a broken game, and the box
   * moves, so the second one would strobe.
   *
   * The bounds test is written positively (`>= 0 && < N`) so a NaN coordinate —
   * which is what a stale volume on the far side of the planet produces — takes
   * the null branch with everything else rather than sailing through a
   * negated one.
   *
   * ### The sampling point, and why it is quantised
   *
   * The probe is handed one position per entity: `mob.position + up * height/2` for
   * an animal, chest height for the player's own body (see the call sites). Mid
   * body is the right end of the ray. Feet sit in the cell the ground occupies
   * and a wall torch is bracketed a block up, so marching from there shadows
   * animals standing in the open; the head clears low walls the body is plainly
   * behind and lights a mob on the wrong side of a fence.
   *
   * The ray then starts from the *centre of the cell* that point falls in,
   * which is both what makes the cache shareable and, on its own merits, the
   * steadier answer: an animal grazing on the spot cannot flicker, because
   * nothing about its sub-cell position is read. Lighting changes when it
   * crosses a cell boundary, which is the same granularity the terrain's own
   * shadow has.
   */
  _entityOcc(pos) {
    const o = this._occ;
    if (!o || !o.ready) return null;
    const l = this._worldToOccCell(pos, _occLocal);
    const ix = Math.floor(l.x), iy = Math.floor(l.y), iz = Math.floor(l.z);
    if (!(ix >= 0 && ix < OCC_NI && iy >= 0 && iy < OCC_NJ && iz >= 0 && iz < OCC_NK)) return null;

    const c = this._occVis || (this._occVis = {
      col: -1, k: -1, seq: -1, gen: -1,
      keys: new Int32Array(OCC_VIS_SLOTS).fill(-1),
      known: new Int32Array(OCC_VIS_SLOTS),
      vis: new Int32Array(OCC_VIS_SLOTS),
      // Where each emitter is in the volume's cell space. Every entity marches
      // to the same two dozen points, so converting them once per generation
      // instead of once per entity is two atan calls saved per test — the
      // single biggest saving in here after the early break.
      ecell: new Float64Array(MAX_ENTITY_EMITTERS * 3),
      eok: new Uint8Array(MAX_ENTITY_EMITTERS),
      ctx: { slot: 0, cx: 0, cy: 0, cz: 0 },
    });

    // The emitter list is rebuilt only when the hand-light scan misses, so its
    // cache key *is* the list's identity; the volume's own counter covers a
    // recentre. Any of the four moving means every stored answer is about a
    // world that no longer exists.
    if (c.col !== this._hlCol || c.k !== this._hlK || c.seq !== this._hlSeq || c.gen !== o.gen) {
      c.col = this._hlCol; c.k = this._hlK; c.seq = this._hlSeq; c.gen = o.gen;
      c.keys.fill(-1);
      const em = this._emitters;
      for (let i = 0; i < em.length; i++) {
        const e = this._worldToOccCell(em[i].pos, _occLocal);
        c.ecell[i * 3] = e.x; c.ecell[i * 3 + 1] = e.y; c.ecell[i * 3 + 2] = e.z;
        // An emitter the volume does not cover fails open like everything else.
        // In practice this never fires — the scan only reaches eight cells from
        // the player and the volume reaches twenty-four — but a stale volume
        // after a teleport is exactly the case that must not throw a shadow.
        c.eok[i] = (e.x >= 0 && e.x < OCC_NI && e.y >= 0 && e.y < OCC_NJ
          && e.z >= 0 && e.z < OCC_NK) ? 1 : 0;
      }
    }

    const cell = ix + iy * OCC_NI + iz * OCC_NI * OCC_NJ;
    const slot = cell & (OCC_VIS_SLOTS - 1);
    if (c.keys[slot] !== cell) { c.keys[slot] = cell; c.known[slot] = 0; c.vis[slot] = 0; }
    const ctx = c.ctx;
    ctx.slot = slot; ctx.cx = ix + 0.5; ctx.cy = iy + 0.5; ctx.cz = iz + 0.5;
    return ctx;
  }

  /** Memoised `_occMarch`: one bit per emitter per cached cell. */
  _occVisible(ctx, i, reach) {
    const c = this._occVis;
    if (!c.eok[i]) return true;
    const bit = 1 << i;
    const slot = ctx.slot;
    if (c.known[slot] & bit) return (c.vis[slot] & bit) !== 0;
    const lit = this._occMarch(ctx, c.ecell[i * 3], c.ecell[i * 3 + 1], c.ecell[i * 3 + 2], reach);
    c.known[slot] |= bit;
    if (lit) c.vis[slot] |= bit;
    return lit;
  }

  /**
   * Is there a wall between a cell centre and an emitter? The CPU twin of
   * `occMarch` in VoxelMaterial.js, and deliberately line for line the same:
   * same step, same near-field stop, same step cap, same DDA corner guard with
   * the second tap when a step crosses three planes at once, and the same
   * guards written backwards so a NaN ray reports *lit* rather than being
   * marched into a black world. Read the comments over there for why each of
   * those is what it is; they are not restated here because two copies of a
   * rationale drift and one of them is the shader's.
   *
   * Three things differ, all of them because this end of the ray is an entity
   * and not a fragment, and each one was a measured hole before it was a
   * difference:
   *
   *  - It starts at a cell centre with no normal bias. The shader needs OCC_BIAS
   *    because a fragment sits on the face of a cell that is solid by
   *    definition; an entity is already standing in air.
   *  - It stops OCC_ENTITY_NEAR from the emitter rather than OCC_NEAR. See that
   *    constant: 1.5 made short rays unshadowable and short rays are the entire
   *    case.
   *  - It takes one extra sample, at the far end of the span exactly. The
   *    shader's last midpoint leaves ds/2 of the ray — up to 0.45 cells —
   *    unexamined, which on a two-cell ray is a quarter of it. Over there that
   *    tail is next to the flame and covered by OCC_NEAR anyway; here it is
   *    where the wall is. It is also the whole of the residual disagreement
   *    this port had with an exact DDA, so closing it makes the entity march
   *    the stricter of the two.
   *

   * Everything is in volume-local cell space, so this is arithmetic and byte
   * reads with no world-space geometry in it at all.
   */
  _occMarch(ctx, lx, ly, lz, reach) {
    const sx = lx - ctx.cx, sy = ly - ctx.cy, sz = lz - ctx.cz;
    const dist = Math.hypot(sx, sy, sz);
    if (!(dist <= reach + 2)) return true;
    const span = dist - OCC_ENTITY_NEAR;
    if (!(span >= 0.5)) return true;
    const dx = sx / dist, dy = sy / dist, dz = sz / dist;
    const steps = Math.min(OCC_MAX_STEPS, Math.ceil(span / OCC_STEP));
    const ds = span / steps;
    let px = ctx.cx, py = ctx.cy, pz = ctx.cz;
    // steps + 1 samples: the midpoints, then the end of the span itself.
    for (let s = 0; s <= steps; s++) {
      const t = Math.min((s + 0.5) * ds, span);
      const x = ctx.cx + dx * t, y = ctx.cy + dy * t, z = ctx.cz + dz * t;
      if (this._occSolid(x, y, z)) return false;
      const pcx = Math.floor(px), pcy = Math.floor(py), pcz = Math.floor(pz);
      const dcx = Math.floor(x) - pcx, dcy = Math.floor(y) - pcy, dcz = Math.floor(z) - pcz;
      const moved = Math.abs(dcx) + Math.abs(dcy) + Math.abs(dcz);
      if (moved > 1) {
        const vx = x - px, vy = y - py, vz = z - pz;
        const tx = dcx ? (pcx + (dcx > 0 ? 1 : 0) - px) / (Math.abs(vx) < 1e-6 ? 1 : vx) : 1e9;
        const ty = dcy ? (pcy + (dcy > 0 ? 1 : 0) - py) / (Math.abs(vy) < 1e-6 ? 1 : vy) : 1e9;
        const tz = dcz ? (pcz + (dcz > 0 ? 1 : 0) - pz) / (Math.abs(vz) < 1e-6 ? 1 : vz) : 1e9;
        const fx = tx <= ty && tx <= tz ? 1 : 0;
        const fy = fx ? 0 : (ty <= tz ? 1 : 0);
        const fz = fx || fy ? 0 : 1;
        let ex = pcx + 0.5 + fx * dcx, ey = pcy + 0.5 + fy * dcy, ez = pcz + 0.5 + fz * dcz;
        if (this._occSolid(ex, ey, ez)) return false;
        if (moved > 2) {
          const rx = tx + fx * 1e9, ry = ty + fy * 1e9, rz = tz + fz * 1e9;
          const gx = rx <= ry && rx <= rz ? 1 : 0;
          const gy = gx ? 0 : (ry <= rz ? 1 : 0);
          const gz = gx || gy ? 0 : 1;
          ex += gx * dcx; ey += gy * dcy; ez += gz * dcz;
          if (this._occSolid(ex, ey, ez)) return false;
        }
      }
      px = x; py = y; pz = z;
    }
    return true;
  }

  /**
   * One occupancy sample. Anything outside the volume reads as empty, which is
   * the same answer `occAt` gives in the shader and the same direction of
   * failure as everything else here: a ray that leaves the box comes out lit.
   */
  _occSolid(x, y, z) {
    // Math.floor, not a bitwise truncation: `-0.5 | 0` is 0, which would put a
    // sample half a cell outside the box back inside it and let the edge of the
    // volume cast a shadow. And the test is positive, so a NaN falls out here
    // as empty rather than indexing the array with one and reading undefined.
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (!(ix >= 0 && ix < OCC_NI && iy >= 0 && iy < OCC_NJ && iz >= 0 && iz < OCC_NK)) return false;
    return occupancyData[(iz * OCC_NJ + iy) * OCC_NI + ix] !== 0;
  }

  /**
   * Embers off everything burning nearby.
   *
   * A torch that emits light but sits perfectly still reads as a lamp. This is
   * what makes it read as a fire, and it costs one particle every seventh of a
   * second per flame — the cells themselves were already found by the hand-light
   * scan, which is cached on the player's cell and the edit counter, so walking
   * around does not re-walk them every frame.
   */
  _tickFlames(dt) {
    const flames = this._flameCells;
    if (!flames.length) return;
    this._flameEmitT = (this._flameEmitT ?? 0) - dt;
    if (this._flameEmitT > 0) return;
    this._flameEmitT = FLAME_PERIOD;
    // One flame per tick, round-robin, so twelve torches in a room cost exactly
    // what one does.
    this._flameNext = ((this._flameNext ?? 0) + 1) % flames.length;
    const f = flames[this._flameNext];
    this._flameHead(f, _v1);
    _v2.set(0, 1, 0);
    this.particles.embers(_v1, _v2, 1, 0.10);
  }

  /**
   * Steam off the hot springs, and spray off the waterfalls.
   *
   * Two emitters in one tick because they are the same shape of problem — find
   * the cells nearby, throw one puff at one of them per tick, round-robin — and
   * they want opposite particles, which `Particles.steam` takes as its `heat`
   * argument.
   *
   * ---- finding a hot spring ------------------------------------------------
   *
   * By what is UNDER the water, not by asking the generator. A spring pool is
   * the only water in the world with tuff beneath it: the four lake beds are
   * mud, peat, clay, sand, gravel, slate and basalt, the seabed is sand and
   * gravel, and the spring pass lays its own tuff floor precisely so the pool
   * cannot drain into whatever was there. Two layers down as well as one,
   * because the middle of the pool is two deep over its floor while the shelf
   * round it is one -- see SPRING_RI in WorldGen.
   *
   * That keeps the whole test on the main thread's own block array. The
   * alternative was to ship the per-column water identity across from the
   * worker, which is 1.3 MB of transfer and a second copy to keep in step, to
   * answer a question three block reads already answer.
   *
   * The scan is strided by two and that is not a saving, it is the design: a
   * pool is five to seven columns across, so a lattice of every other column
   * cannot step over one, and it turns a 33x33 sweep into a 17x17. Cached on
   * the player's column, layer and the edit counter, exactly like the hand
   * light, so walking about does not re-walk it every frame.
   *
   * ---- finding a waterfall -------------------------------------------------
   *
   * Off `water.level`, which is already the exact answer. That map holds every
   * cell of flowing water in the world and nothing else -- the falls put
   * themselves in it when their region is seeded (see `_isFallingCell`), and a
   * player's own spill lands in it too, which is why a bucket poured off a
   * ledge throws spray as well. It is a few hundred entries at most, so it is
   * walked rather than scanned.
   */
  _tickSteam(dt) {
    this._steamT = (this._steamT ?? 0) - dt;
    if (this._steamT > 0) return;
    this._steamT = STEAM_PERIOD;
    const c = this.player.cell;
    const ck = c.k;
    const baseCol = colIndex(c.x, c.y);

    const cells = this._steamCells;
    if (this._stCol !== baseCol || this._stK !== ck || this._stSeq !== this.editSeq) {
      this._stCol = baseCol; this._stK = ck; this._stSeq = this.editSeq;
      cells.length = 0;
      const p = this.planet;
      for (let di = -STEAM_RADIUS; di <= STEAM_RADIUS && cells.length < MAX_STEAM_CELLS; di += 2) {
        for (let dj = -STEAM_RADIUS; dj <= STEAM_RADIUS && cells.length < MAX_STEAM_CELLS; dj += 2) {
          const col = stepColumn(baseCol, di, dj);
          // Wide in k, and it has to be: a pool sits in a terrace cut into the
          // ground, so standing on the rim above it already puts its surface
          // six layers under your feet, and a window of -4 found nothing from
          // anywhere you would actually be standing to look at one.
          for (let dk = -9; dk <= 5; dk++) {
            const k = ck + dk;
            if (k < 2 || k + 1 >= D) continue;
            if (p.at(col, k) !== ID.water || p.at(col, k + 1) !== 0) continue;
            if (p.at(col, k - 1) !== ID.tuff && p.at(col, k - 2) !== ID.tuff) continue;
            cells.push({ col, k });
            break;
          }
        }
      }
    }

    // Two cells a tick, not one. A pool is twenty-odd columns of surface and the
    // emitter is round-robin, so at one a tick each column only steams every two
    // seconds -- which came out of the first screenshots as a couple of stray
    // wisps rather than as a pool that is visibly warm. Two against a
    // three-to-five-second life is about eighty puffs standing over a spring,
    // which is inside Particles' MAX_STEAM with room for a waterfall as well.
    for (let e = 0; e < 2 && cells.length; e++) {
      this._steamNext = ((this._steamNext ?? 0) + 1) % cells.length;
      const h = cells[this._steamNext];
      _v2.set(0, 1, 0);
      this.planet.centerOf(h.col, h.k, _v1);
      _v1.addScaledVector(_v2, 0.55);
      this.particles.steam(_v1, _v2, 0.9, 1);
    }

    // Spray. One cell of falling water per tick, and only if it is near enough
    // to be worth drawing -- the level map is planet-wide, so the distance test
    // is what keeps a waterfall on the far side of the world out of your face.
    const lv = this.water.level;
    if (lv.size) {
      const n = (this._sprayNext ?? 0) % lv.size;
      this._sprayNext = n + 1;
      let i = 0;
      for (const key of lv.keys()) {
        if (i++ !== n) continue;
        cellDecode(key, _kd);
        this.planet.centerOf(_kd.col, _kd.k, _v1);
        if (wrapDist2(_v1, this.player.position) > 900) break;
        _v2.set(0, 1, 0);
        this.particles.steam(_v1, _v2, 0.8, 0);
        break;
      }
    }

    this._tickWaterSound(dt);
  }

  /**
   * Where the nearest waterfall and the nearest hot spring are, for the two
   * placed ambient beds in `Ambience`.
   *
   * Both were completely silent until this pass, which on a planet where a fall
   * is visible from most of a biome is the most obvious hole in the mix there
   * is: you could stand under forty metres of falling water and hear wind.
   *
   * Twice a second, not every frame. The answer only changes as fast as a body
   * can walk, and the pass is cheap: measured at 4us with the map empty, 12us
   * at 500 flowing cells and 53us at 2000 -- so even a player who has flooded a
   * valley pays 107us a SECOND for this, against the 36us a FRAME the whole
   * audio system already cost.
   */
  _tickWaterSound(dt) {
    this._wsT = (this._wsT ?? 0) - dt;
    if (this._wsT > 0) return;
    this._wsT = 0.5;
    const P = this.player.position;

    // Springs come free: `_steamCells` above is already the nearby pools.
    let sd = Infinity;
    for (let i = 0; i < this._steamCells.length; i++) {
      const h = this._steamCells[i];
      this.planet.centerOf(h.col, h.k, _v1);
      const d = wrapDist2(_v1, P);
      if (d < sd) { sd = d; this._springAt.copy(_v1); }
    }
    // 26m and 56m are the placed panners' own maxDistance. Past those the
    // linear distance law is already exactly zero, so holding a target beyond
    // them buys nothing but a position ramp.
    this._springNear = sd < 26 * 26;

    // Falls off the flow map, which is exactly the set of cells that are
    // falling. `n` is how much water is in earshot, and it is the difference
    // between a cataract and a bucket someone tipped over a ledge -- every
    // player spill lands in this same map.
    let fd = Infinity, n = 0;
    for (const key of this.water.level.keys()) {
      cellDecode(key, _kd);
      this.planet.centerOf(_kd.col, _kd.k, _v1);
      const d = wrapDist2(_v1, P);
      if (d > 56 * 56) continue;
      n++;
      if (d < fd) { fd = d; this._fallAt.copy(_v1); }
    }
    this._fallNear = n > 0;
    this._fallSize = Math.min(1, 0.28 + n / 8);
  }

  /**
   * Put a real torch, and a real flower, where every nearby one of those is.
   *
   * The voxel form of a torch is a thin post with a slightly wider post on top,
   * and the tile meant to be its flame is a picture of a whole torch — brown,
   * stick and all — so a planted torch read as a plain rod from every angle
   * you could actually stand at. The art for a torch already exists and is
   * already in your hand. This is the same object, in the ground.
   *
   * Flowers had the same complaint and a worse version of it. Two crossed
   * quads is a fine grass blade — grass has no shape of its own to lose — but a
   * bloom is exactly the thing whose silhouette *is* the object, and from
   * directly above, which is where the player looks at ankle height, a cross is
   * a plus sign. `Mesher.emitCross` no longer emits them; this is what stands
   * in its place.
   *
   * Scanned rather than tracked. A registry would have to survive saves,
   * chunk eviction and every path that writes a block; a scan bounded to what
   * is near you cannot go stale, and only reruns when you cross a cell or edit
   * the world — the same cache the hand light uses, for the same reason.
   *
   * ### How far this reaches, and why that number
   *
   * A torch is hand-placed and sparse, so one appearing at the rim is a thing
   * you might catch; a *meadow* appearing at the rim is unmissable, and unlike
   * the torch there is no billboard left behind to cover the gap. The bound
   * that matters is therefore legibility rather than a horizon: the map is
   * flat and level ground runs to the draw distance, so 34 cells is where a
   * flower is a few pixels wide and behind aerial fog. What is lost past it is
   * flowers 60+ cells out that were never legible anyway.
   *
   * That costs 69 x 69 x 15 = 71 000 array reads per rescan, about three times
   * the old torch scan, and `planet.at` is a flat typed-array index. Torches
   * keep their own 20 — widening theirs was not asked for and every extra cell
   * is instances that have to be matrix-written every rescan.
   */
  /**
   * The baked voxel light at one modelled-cross cell, or -1 if we do not have
   * it, as the mesher's packed word.
   *
   * -1 is a real and common answer, not an error: the chunk may not have been
   * meshed yet, may have been evicted while its flowers are still inside the
   * model scan (the model radius is 34 cells, the keep radius is larger, but a
   * newly entered region is meshed over several frames), or the flower may have
   * been planted this instant and the remesh not yet come back. Every caller has
   * to have an answer for that; see `BlockModels.sync`, where -1 means "add no
   * block light", which is exactly the picture we had before this existed.
   *
   * Binary search, because the mesher emits in ascending address order (i, then
   * j, then k — the same odometer the address is built from) and a densely
   * planted chunk can hold hundreds of entries. A meadow chunk holds ten.
   */
  _crossLightAt(col, k) {
    const p = colParts(col, _clParts);
    const arr = this.crossLight.get(chunkIdx(
      (p.x / CHUNK_T) | 0, (p.y / CHUNK_T) | 0, (k / CHUNK_K) | 0));
    if (!arr) return -1;
    const addr = ((p.x % CHUNK_T) * CHUNK_T + (p.y % CHUNK_T)) * CHUNK_K + (k % CHUNK_K);
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = arr[mid] >>> CROSS_LIGHT_ADDR_SHIFT;
      if (a === addr) return arr[mid];
      if (a < addr) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /**
   * The writing on every sign near enough to read, as one mesh.
   *
   * Driven off the `signs` map rather than off a scan of the world, which is
   * what makes it affordable: the map holds only signs that have been written
   * on, so this is a walk of a handful of entries and not 71 000 array reads.
   * A base with two hundred signs in it is two hundred `centerOf` calls behind
   * the same cache the block models use.
   */
  _syncSignText() {
    if (!this.signText) return;
    const c = this.player.cell;
    const ck = c.k;
    const baseCol = colIndex(c.x, c.y);
    if (this._stCol === baseCol && this._stK === ck
      && this._stSeq === this.editSeq && this._stSigns === this.signSeq) return;
    this._stCol = baseCol; this._stK = ck;
    this._stSeq = this.editSeq; this._stSigns = this.signSeq;

    // Past this the letters are a smudge a pixel high, and the hint line is
    // how you read a sign at range — that has not changed and is still the
    // reason you can read one across a valley.
    const RANGE = 26;
    const list = [];
    for (const [key, text] of this.signs) {
      if (!text) continue;
      cellDecode(key, _kd);
      const col = _kd.col, k = _kd.k;
      if (!IS_SIGN[this.planet.at(col, k)]) continue;
      const pos = this.planet.centerOf(col, k, new THREE.Vector3());
      if (wrapDist2(pos, this.player.position) > RANGE * RANGE) continue;
      // The board is nailed to the world axes and never turns, so the basis
      // SignText wants is the same three vectors for every sign on the planet.
      list.push({
        pos, ea: FLAT_EA, eb: FLAT_EB, up: FLAT_UP, arcA: 1, arcB: 1,
        dir: this.planet.facingAt(col, k) & 7, text,
      });
    }
    this.signText.sync(list);
  }

  _syncBlockModels() {
    const bm = this.blockModels;
    bm.prime('torch', itemIdOf('torch'), { height: 0.95, lean: true });
    for (const n of FLOWER_NAMES) bm.prime(n, itemIdOf(n), { height: MODELLED_PLANTS[n] });
    for (const n in MODELLED_TOPPERS) bm.prime(n, itemIdOf(n), { height: MODELLED_TOPPERS[n] });
    // `lit` and `shadow`, and neither is true of anything else primed here. A
    // modelled block is a solid cube's worth of object standing where a cube
    // used to stand: it has to answer a torch (see `applyInstancedBlockLight`)
    // and it has to put a shadow on the ground, or it is the one thing in a
    // sunlit clearing with nothing under it.
    for (const n in MODELLED_BLOCKS) {
      bm.prime(n, itemIdOf(n), { height: MODELLED_BLOCKS[n], lit: true, shadow: true });
    }

    const c = this.player.cell;
    const ck = c.k;
    const baseCol = colIndex(c.x, c.y);
    const lists = this._modelLists || (this._modelLists = { torch: [] });
    for (const n of FLOWER_NAMES) lists[n] = lists[n] || [];
    for (const n in MODELLED_TOPPERS) lists[n] = lists[n] || [];
    for (const n in MODELLED_BLOCKS) lists[n] = lists[n] || [];

    if (this._tmCol !== baseCol || this._tmK !== ck || this._tmSeq !== this.editSeq) {
      this._tmCol = baseCol; this._tmK = ck; this._tmSeq = this.editSeq;
      for (const key in lists) lists[key].length = 0;
      const RAD = 34;
      const TORCH_RAD = 20;
      // How far above and below to look for torches. Wider than the flower
      // window below, which takes the scan from 15 radial layers to 37 — 2.5x
      // the cells, measured at 1.35 ms. It is cached behind the cell the player
      // stands in and `editSeq`, so it runs a couple of times a second while
      // walking, not per frame.
      const TORCH_DK = 18;
      for (let di = -RAD; di <= RAD; di++) {
        for (let dj = -RAD; dj <= RAD; dj++) {
          const col = stepColumn(baseCol, di, dj);
          const d2 = di * di + dj * dj;
          const torchable = d2 <= TORCH_RAD * TORCH_RAD;
          for (let dk = -TORCH_DK; dk <= TORCH_DK; dk++) {
            const k = ck + dk;
            if (k < 0 || k >= D) continue;
            const id = this.planet.at(col, k);
            // Flowers keep the tight radial window they always had — they are
            // scenery, and scenery a storey above you is not missed.
            //
            // A torch is not scenery. It is the thing you are looking for in a
            // cave, and ±7 layers meant one went out of sight while its light
            // stayed on the wall: stand on a cliff eight layers above the torch
            // you just placed, or look up the shaft you climbed down, and there
            // is a lit wall with nothing lighting it.
            const nearK = dk >= -7 && dk <= 7;
            const flower = nearK ? FLOWER_KIND[id] : 0;
            const topper = nearK ? TOPPER_KIND[id] : 0;
            const modelled = nearK ? MODEL_KIND[id] : 0;
            if (!flower && !topper && !modelled && !(torchable && IS_TORCH[id])) continue;
            const pos = this.planet.centerOf(col, k, new THREE.Vector3());
            const up = new THREE.Vector3(0, 1, 0);

            if (modelled) {
              // Its own cell, and no spin. A flower is scenery and a grid of
              // identical stamps is the one way a model can look worse than the
              // billboard it replaced; a workbench is furniture, and furniture
              // turned to a random angle in a room the player squared off is
              // the same fault the other way round.
              lists[modelled].push({ pos, up, out: null, d2, col, k, light: -1 });
              continue;
            }

            if (topper) {
              // The cell above, which is where a pot on a stove is. No spin:
              // the block is directional and a pot turned to a different angle
              // from the fire door underneath it would read as two objects.
              lists[topper].push({
                pos: this.planet.centerOf(col, k + 1, new THREE.Vector3()),
                up, out: null, d2, col, k, light: -1,
              });
              continue;
            }

            if (flower) {
              // A turn derived from the cell, not from a counter or `Math.random`:
              // it has to be the same every rescan or the whole meadow twitches
              // each time you cross a cell line. Without it a hillside of these
              // is a grid of identical stamps, which is the one way a model can
              // look worse than the billboard it replaced.
              lists[flower].push({
                pos, up, out: null, d2, col, k, light: -1,
                spin: ((col * 37 + k * 101) % 628) / 100,
              });
              continue;
            }

            const byte = this.planet.facingAt(col, k) & 7;
            const e = { pos, up, out: null, d2, col, k, light: -1 };
            if (byte !== 0) {
              // The step is on the map, so it is (x, z) in world space and the
              // torch leans back out of the wall along it.
              const [wi, wj] = TORCH_WALL_STEP[(byte - 1) & 3];
              e.out = new THREE.Vector3(-wi, 0, -wj);
            }
            lists.torch.push(e);
          }
        }
      }
      // `BlockModels` truncates a list that overruns its instance cap, and the
      // scan walks in row order — so an untouched list would lose one whole
      // side of the player rather than the far edge all round. Ordering by
      // distance first makes the cap mean "the nearest N", which is the only
      // reading of it that degrades gracefully. Only pays when it overruns,
      // which for generated flora it never does (~190 across three kinds).
      for (const key in lists) {
        if (lists[key].length > BLOCK_MODEL_CAP) lists[key].sort((a, b) => a.d2 - b.d2);
      }
    }

    // Light is refreshed every frame, *outside* the cache above, and that is
    // deliberate — it is the whole reason placing a torch changes the flowers
    // beside it.
    //
    // The obvious thing was to fold it into the cached scan, since `editSeq`
    // already invalidates that on every edit. It does not work: `editSeq` is
    // bumped when the edit is *posted* to the worker, so the rescan runs a
    // frame or two before the relit chunk comes back, reads the old light and
    // then caches it until the player next crosses a cell. A torch would light
    // its neighbours only after you walked away and returned.
    //
    // The next thought was to invalidate the scan when a `chunk` message lands.
    // That is correct and far too expensive: the scan is 71 000 array reads and
    // the streamer lands hundreds of chunks in a burst, so entering a new
    // region would run it hundreds of times in a few frames.
    //
    // So the two are separated by what they cost. Positions come from the scan
    // and are cached; light is one binary search per instance — about 190 of
    // them across all kinds, over arrays of a dozen words — and is simply
    // redone. That is cheap enough to not need to be right about *when* it
    // changed, which is the kind of correctness that does not rot.
    for (const key in lists) {
      const list = lists[key];
      for (let n = 0; n < list.length; n++) list[n].light = this._crossLightAt(list[n].col, list[n].k);
    }
    bm.sync(lists);
  }

  /** Where the fire actually is in a burning cell, in world space. */
  _flameHead(f, out) {
    this.planet.centerOf(f.col, f.k, out);
    if (!IS_TORCH[f.id]) return out;
    // A floor torch burns just above its own centre; a wall torch burns out
    // over the cell, at the far end of the bracket.
    const byte = f.byte & 7;
    if (byte === 0) { out.y += 0.22; return out; }
    const [di, dj] = TORCH_WALL_STEP[(byte - 1) & 3];
    out.x -= di * 0.16;
    out.y += 0.28;
    out.z -= dj * 0.16;
    return out;
  }

  /**
   * Push the light the player is *carrying* into the world shader.
   *
   * Held separately from _handLight above, which asks how bright the player's
   * surroundings are so the viewmodel can be lit to match. This is the opposite
   * direction: the thing in your hand lighting everything else.
   */
  _updateHandLight(dt) {
    // Both hands, and the brighter wins.
    //
    // This is the one thing the offhand does on its own, and it is not "using"
    // the item: the torch is drawn burning in the left fist in both first and
    // third person, so a torch that lit the cave from the right hand and went
    // dark in the left would not read as a rule, it would read as a bug. Max
    // rather than sum because there is exactly one hand light in the shader and
    // two torches are not twice the lamp.
    const lightOf = (slot) => {
      const def = ITEMS[slot.item];
      return def?.block ? BLOCKS[def.block] : null;
    };
    const a = lightOf(this.inventory.held());
    const b = lightOf(this.inventory.offhand);
    const block = (b?.light ?? 0) > (a?.light ?? 0) ? b : a;
    const emit = block?.light ?? 0;
    const u = voxelUniforms;
    if (!emit) {
      // Ease out rather than cut, or putting a torch away snaps the whole cave
      // to black in one frame.
      u.uHandLightRadius.value = Math.max(0, u.uHandLightRadius.value - dt * 26);
      if (u.uHandLightRadius.value <= 0.01) u.uHandLightColor.value.set(0, 0, 0);
      return;
    }
    // A flame is never still. The wobble is small and slow enough to read as a
    // flame rather than as a framerate problem. The clock is `this._flameT`,
    // advanced by the tick — it is not advanced here, because the drop light
    // reads it too and this method returns early whenever the hands are empty.
    const flicker = 0.92 + Math.sin(this._flameT * 11.3) * 0.05 + Math.sin(this._flameT * 4.1) * 0.03;
    const lc = block.lightColor || WHITE_L;
    const strength = (emit / 15) * HAND_LIGHT_GAIN * flicker;
    u.uHandLightColor.value.set(lc[0] * strength, lc[1] * strength, lc[2] * strength);
    // The block's own light level in cells, which is what the grid gives a
    // planted one. The old form scaled this by 0.6..1.0 as a second dimming on
    // top of the strength; a torch now reaches its 13 cells in the hand exactly
    // as it does in the wall.
    const want = HAND_LIGHT_REACH * (emit / 13);
    u.uHandLightRadius.value += (want - u.uHandLightRadius.value) * Math.min(1, dt * 8);
    // Just in front of and below the eye, where the hand actually is — lighting
    // from the eye itself flattens everything into a torchlit photograph.
    u.uHandLightPos.value.copy(this.player.eye)
      .addScaledVector(this.player.lookDir, 0.45)
      .addScaledVector(this.player.up, -0.35);
    // ...unless the hand is inside a wall, which happens the moment you put
    // your face against one. That was harmless while the flame lit through
    // rock; now that it is occluded, a light stuck in a block is shadowed by
    // that block and the whole cave goes out for as long as you lean on it. The
    // eye is never inside solid geometry, so it is the safe fallback.
    const hp = u.uHandLightPos.value;
    if (this.planet.blocks) {
      const a = this.planet.cellAt(hp.x, hp.y, hp.z);
      if (a && IS_OPAQUE[this.planet.at(a.col, a.k)]) hp.copy(this.player.eye);
    }
  }

  /**
   * The brightest burning thing lying on the ground near you.
   *
   * A torch that goes dark the instant it leaves your fingers, and lights up
   * again the instant you pick it up, is the sort of detail that quietly tells
   * a player the world is a set. Dropping one should light where it lands —
   * and it is genuinely useful: a torch tossed down a shaft you are digging
   * lights the bottom while both hands are busy.
   *
   * **One flame, the brightest, nearest-wins on a tie.** The alternative is a
   * light manager, and this exists to cover the seconds between dropping
   * something and picking it up again; every *placed* light in the world is
   * already baked into the grid, far more cheaply than any of this. A pile of
   * ten dropped torches lighting as one torch is the right failure: they are
   * within a metre of each other, so summing them would only blow out the
   * ground they are lying on.
   *
   * Scanned every frame rather than cached, because a drop moves — it is thrown,
   * it falls, it slides down a slope, and a light that lagged its own object by
   * a cell would look like the flame had come loose. The list is bounded and the
   * test is a distance compare against a radius, so this is a few dozen
   * comparisons.
   */
  _updateDropLight(dt) {
    const u = voxelUniforms;
    let best = null, bestEmit = 0, bestD2 = Infinity;
    for (const d of this.drops.list) {
      const def = ITEMS[d.item];
      const bl = def?.block !== undefined ? BLOCKS[def.block] : null;
      const emit = bl?.light ?? 0;
      if (!emit) continue;
      const d2 = wrapDist2(d.pos, this.player.position);
      if (d2 > DROP_LIGHT_RANGE * DROP_LIGHT_RANGE) continue;
      if (emit > bestEmit || (emit === bestEmit && d2 < bestD2)) {
        best = { drop: d, block: bl }; bestEmit = emit; bestD2 = d2;
      }
    }
    if (!best) {
      // Eased out rather than cut, for the same reason the hand light is: a
      // torch picked up should not snap the cave to black in one frame.
      u.uDropLightRadius.value = Math.max(0, u.uDropLightRadius.value - dt * 26);
      if (u.uDropLightRadius.value <= 0.01) u.uDropLightColor.value.set(0, 0, 0);
      return;
    }
    // The same flicker the hand light uses, on its own phase so two flames in
    // one room do not pulse in lockstep, which reads as a framerate problem.
    const flicker = 0.92 + Math.sin(this._flameT * 9.7 + 1.9) * 0.05
      + Math.sin(this._flameT * 3.4 + 0.7) * 0.03;
    const lc = best.block.lightColor || WHITE_L;
    const strength = (bestEmit / 15) * HAND_LIGHT_GAIN * flicker;
    u.uDropLightColor.value.set(lc[0] * strength, lc[1] * strength, lc[2] * strength);
    const want = HAND_LIGHT_REACH * (bestEmit / 13);
    u.uDropLightRadius.value += (want - u.uDropLightRadius.value) * Math.min(1, dt * 8);
    // A little above the item, which sits on the ground: a light exactly at
    // floor level lights the floor and nothing else.
    u.uDropLightPos.value.copy(best.drop.pos);
    u.uDropLightPos.value.y += 0.25;
  }

  /**
   * Keep the two moving flames' shadow volume under the player.
   *
   * Keeping it is *all* this does. The shader works out both ends of every
   * shadow ray itself, from the world-space light positions it already has, so
   * nothing here feeds it a coordinate — see flameLight for why that division
   * of labour is the only safe one.
   *
   * See the OCC_* block in VoxelMaterial.js for what the volume is. This is the
   * cheap half: 2 304 columns resolved through `colIndex` - which wraps, and is
   * the whole of the mapping now - and then 73 728 byte reads down them.
   *
   * ### When it rebuilds
   *
   * Only when the player walks OCC_HYST cells out of the middle. Rebuilding on
   * every integer cell crossing was the first
   * thought and it is needlessly often: a cell is 0.98 units and a sprinting
   * player crosses several a second, while the volume reaches 24 cells and the
   * furthest thing that can read it is 13 away. Three cells of slack costs three
   * cells of margin out of eleven spare and cuts the rebuild rate by about six.
   *
   * It used to be skipped entirely while neither flame is lit. That is no
   * longer the condition, because the volume is no longer the moving flames'
   * alone: `_entityLight` marches the same bytes to decide whether a planted
   * torch reaches an animal, and a planted torch does not care what is in the
   * player's hand. Leaving the old test in place gave the exactly wrong
   * behaviour — mobs were correctly shadowed only while you happened to be
   * carrying a light, and lit through walls the rest of the time.
   *
   * So it is now kept up to date while either flame is lit *or* the hand-light
   * scan found any emitter at all, which is the only condition under which
   * `_entityLight` can shadow anything. A torchless daytime frame still finds
   * no emitters and still pays nothing at either end. What the shader is told,
   * though, is unchanged: uOccActive stays tied to the flames alone, so nothing
   * about the terrain path moves.
   *
   * ### What it does not cover
   *
   * It used to say here that an edited block waited for the next recentre. It
   * no longer waits: `_patchOcclusion` writes the texel as the edit lands, which
   * costs a scan of the column table rather than a rebuild. That was tolerable
   * while only the shader read this and stopped being tolerable when
   * `_entityLight` did — see that method for what the lag actually looked like.
   *
   * What is still missed is a block that changes *without* going through
   * `_applyEdits`: a streamed region arriving at `planet.applyRegions`, or a
   * save writing `planet.blocks` directly. Both of those bring in terrain the
   * player is nowhere near, so the volume is recentred long before it matters.
   */
  _updateLightOcclusion() {
    const u = voxelUniforms;
    const blocks = this.planet.blocks;
    const flames = u.uHandLightRadius.value > 0.01 || u.uDropLightRadius.value > 0.01;
    // It used to skip out here unless a flame was lit or the hand-light scan
    // had found an emitter within eight columns of the player. Both of those
    // are the wrong question now that the volume also carries the entity light
    // field: that field's whole purpose is to see a torch the player is *not*
    // standing next to, and the old gate meant the volume — and therefore the
    // field — did not exist at all until the player walked within eight columns
    // of one. An animal at the far end of a lit gallery would have been dark
    // for exactly the same reason as before, through a different door.
    //
    // What that costs is a rebuild the player may not use: 0.40 ms, and only
    // when they drift OCC_HYST cells out of the middle, which at a run is about
    // once every 0.6 s. The flood itself is still not paid for here — see
    // `_entityField`, which runs it only when something asks.
    if (!blocks) {
      u.uOccActive.value = 0;
      return;
    }
    const p = this.player.position;
    if (!this._occ) {
      this._occ = { x: 0, y: 0, k: 0, gen: 0, ready: false, cols: new Int32Array(OCC_NI * OCC_NJ) };
      const c = this.planet.cellOf(p.x, p.y, p.z, _occCell);
      this._rebuildOcclusion(c.cx, c.cy, c.ck);
    } else {
      // Asked in the volume's own frame rather than in the player's. The map
      // wraps, so `_worldToOccCell` takes the short way round on both axes.
      const l = this._worldToOccCell(p, _occLocal);
      if (Math.abs(l.x - OCC_NI * 0.5) > OCC_HYST
        || Math.abs(l.y - OCC_NJ * 0.5) > OCC_HYST
        || Math.abs(l.z - OCC_NK * 0.5) > OCC_HYST) {
        const c = this.planet.cellOf(p.x, p.y, p.z, _occCell);
        this._rebuildOcclusion(c.cx, c.cy, c.ck);
      }
    }
    // Never on the strength of a build that did not finish: uOccActive is the
    // shader's promise that the uniforms and the texture describe a real place.
    // Gated on `flames` as well, so keeping the volume live for the entities
    // cannot switch on a march for a light that is not burning.
    u.uOccActive.value = (flames && this._occ.ready) ? 1 : 0;
  }

  /**
   * Refill the occupancy volume centred on continuous cell coordinates `c`.
   *
   * Nothing observable changes until the very last block. The origin is worked
   * out into locals, the texels are filled, and only then are `this._occ`, the
   * texture and the uniforms published together — because a half-applied
   * rebuild is a volume whose contents, whose recorded origin and whose
   * uniforms describe three different places, and the shader has no way to
   * notice. Assigning the origin into `this._occ` up front and letting the fill
   * follow was how this was first written, and it is one thrown exception away
   * from exactly that state.
   */
  _rebuildOcclusion(cx, cy, ck) {
    const o = this._occ;
    const ox = Math.round(cx) - (OCC_NI >> 1);
    const oy = Math.round(cy) - (OCC_NJ >> 1);
    // k is deliberately *not* clamped into the world. A slab that always sits
    // exactly under the player is what makes the shader's origin arithmetic one
    // subtraction; the two rows below cost less than the clamping would.
    const ok = Math.round(ck) - (OCC_NK >> 1);

    // Columns first, because they depend only on (x, y): 2 304 of these instead
    // of one per texel, which is a 32x saving on the only expensive part.
    // `colIndex` wraps, so a volume that straddles the far edge of the map is
    // the same volume as any other.
    const cols = o.cols;
    for (let jj = 0; jj < OCC_NJ; jj++) {
      const row = jj * OCC_NI;
      for (let ii = 0; ii < OCC_NI; ii++) cols[row + ii] = colIndex(ox + ii, oy + jj);
    }

    // Opaque exactly as the light grid means it — ATTEN 255 is IS_OPAQUE — so a
    // moving flame and a planted one agree about what a wall is. Leaves and
    // water dim the grid rather than stopping it and are left out of the volume
    // for the same reason: a flame should shine through a canopy.
    const blocks = this.planet.blocks;
    const data = occupancyData;
    // The same cells, kept as block ids rather than as one opacity bit, for the
    // entity light field to flood over. It rides this loop because this loop is
    // already reading every id in the volume to decide the bit; a second sweep
    // for the same bytes would be 73 728 reads for nothing. See EntityLight.js.
    const ids = this._occIds || (this._occIds = new Uint8Array(OCC_NI * OCC_NJ * OCC_NK));
    const plane = OCC_NI * OCC_NJ;
    let idx = 0;
    for (let kk = 0; kk < OCC_NK; kk++) {
      const k = ok + kk;
      // Below layer 0 is the unbreakable core and above the shell is sky.
      // Neither has a block id; the occupancy byte is what the flood reads for
      // solidity, so leaving these as air is correct rather than lax.
      if (k < 0) { data.fill(255, idx, idx + plane); ids.fill(0, idx, idx + plane); idx += plane; continue; }
      if (k >= D) { data.fill(0, idx, idx + plane); ids.fill(0, idx, idx + plane); idx += plane; continue; }
      for (let n = 0; n < plane; n++) {
        const id = blocks[cols[n] * D + k];
        ids[idx] = id;
        data[idx++] = IS_OPAQUE[id] ? 255 : 0;
      }
    }

    // --- commit ---
    // `gen` is part of the commit for the same reason the rest of it is: it is
    // what tells `_entityLight`'s cache that every shadow answer it is holding
    // was computed against a volume that has since moved.
    o.x = ox; o.y = oy; o.k = ok; o.gen++; o.ready = true;
    // The light field is not flooded here. It is flooded on demand, at most
    // once a frame, by the first entity that asks — see `_entityField`. A
    // recentre that lands on a frame where nothing is going to sample the field
    // (no mobs, no drops, the body off screen) should not pay for one.
    this._lfDirty = true;
    occupancyTexture.needsUpdate = true;
    const u = voxelUniforms;
    // Minus the world position of the volume's low corner, so a world point
    // plus this is a volume-local cell coordinate. The face basis is gone.
    //
    // TODO(NINE-FACES): VoxelMaterial's `occFrame` reads `cell = wp + uOccOrg`
    // straight, which makes its second axis world Y. This volume's second axis
    // is map y (world Z) and its third is the layer - the order EntityLight
    // floods in and the order `_entityOcc` indexes, and the layer has to be the
    // axis ATTEN_V is charged on. That shader wants `vec3(wp.x, wp.z, wp.y) +
    // uOccOrg`, with OCC_NJ and OCC_NK swapped so the footprint is square and
    // the volume is 32 layers tall. Reported rather than changed: not this
    // stage's file.
    u.uOccOrg.value.set(-ox, -oy, -ok);
  }

  /**
   * Carry an edit into the occupancy volume, one cell at a time.
   *
   * ### Why this exists now and did not before
   *
   * The volume used to be refilled only when the player drifted out of the
   * middle of it, and an edit was allowed to sit unrepresented until then. That
   * was defensible while the only thing reading it was the shader's march for
   * the two moving flames: you had walled yourself in, you were standing next to
   * the wall, and it went dark a few steps later.
   *
   * It is not defensible now that `_entityLight` reads the same bytes, and it
   * was the larger half of why nothing was shadowed in the running game.
   * Building a wall between a torch and an animal changed `planet.blocks` and
   * changed nothing the march could see, so the animal stayed lit — for as long
   * as the player stood still, which is exactly what a player does while
   * checking whether a wall works. A test that placed a torch, built a wall and
   * probed without walking measured *no change whatsoever*, and no amount of
   * staring at the march explains that, because the march was reading a volume
   * in which the wall did not exist.
   *
   * ### Why a patch and not a rebuild
   *
   * Refilling on every edit was rejected once and stays rejected, for the same
   * reason as before: an edit already costs a relight and a remesh, and a third
   * full pass over the neighbourhood (2 304 patchColumn calls and 73 728 byte
   * reads) to change one byte is absurd. What was wrong was the conclusion drawn
   * from that — the choice is not "rebuild or lag", it is one texel.
   *
   * The column lookup is a linear scan of the 2 304 already resolved by the last
   * rebuild. A col→index map would be O(1) per edit and is the wrong trade: it
   * would have to be built on every *recentre*, which happens far more often
   * than an edit. The scan is a couple of microseconds.
   *
   * This also retires the shader's own lag, so a wall now shadows a carried
   * torch on the frame it is placed rather than three cells later.
   */
  _patchOcclusion(edits) {
    const o = this._occ;
    if (!o || !o.ready) return;
    // Measured: 2.0 us per cell patched, against 0.26 ms for a whole rebuild.
    // The scan wins by a hundredfold for the batches this actually sees (a door
    // is two cells, a slab pair two, a falling stack a handful), and loses for a
    // batch of hundreds, which nothing produces today but something might. Cross
    // over to a rebuild well before it can — at the *same* origin, so this stays
    // a refresh and never becomes a recentre.
    if (edits.length > 64) {
      this._rebuildOcclusion(
        o.x + (OCC_NI >> 1), o.y + (OCC_NJ >> 1), o.k + (OCC_NK >> 1));
      return;
    }
    const cols = o.cols;
    const ids = this._occIds;
    const plane = OCC_NI * OCC_NJ;
    let touched = false;
    for (const e of edits) {
      const kk = e.k - o.k;
      if (kk < 0 || kk >= OCC_NK) continue;
      const solid = IS_OPAQUE[e.id] ? 255 : 0;
      const base = kk * plane;
      for (let n = 0; n < plane; n++) {
        if (cols[n] === e.col) {
          occupancyData[base + n] = solid;
          // The id as well as the bit, or planting a torch would change what
          // the volume thinks is solid and not what it thinks is alight, and
          // the entity field would flood a room with no torch in it.
          if (ids) ids[base + n] = e.id;
          touched = true;
        }
      }
    }
    if (!touched) return;
    this._lfDirty = true;
    occupancyTexture.needsUpdate = true;
    // Every cached entity shadow answer was computed against the old contents.
    // `_handLight` would drop them anyway on the editSeq change, but the volume
    // owning its own invalidation is what keeps that true if it ever stops.
    o.gen++;
  }

  /**
   * A world point in the volume's local cell space — the exact inverse of the
   * fill above, and the same two lines the shader runs.
   *
   * Used for one thing only: asking how far the player has drifted from the
   * middle. It used to convert the flames' positions for the shader as well,
   * and that is precisely what it must not do — see flameLight. Being wrong
   * here costs a mistimed rebuild; being wrong there put the lights out.
   */
  _worldToOccCell(pos, out) {
    const o = this._occ;
    // Measured from the middle of the volume rather than off its corner, so
    // `delta` can take the short way round a map that wraps: an origin near the
    // far edge and a point just over it are one step apart, not a whole map.
    return out.set(
      OCC_NI * 0.5 + delta(o.x + OCC_NI * 0.5, pos.x),
      OCC_NJ * 0.5 + delta(o.y + OCC_NJ * 0.5, pos.z),
      pos.y - o.k);
  }

  /** Crosshair prompt when you're looking at an animal. */
  _feedHint(mob) {
    if (!mob) return null;
    if (mob.spec.trader) return `<kbd>RMB</kbd> Trade`;
    if (mob.baby > 0) return 'Calf';
    if (mob.love > 0) return 'Ready to breed';
    // The hand that would actually feed it, so the prompt and the click agree.
    const held = this.inventory.actingSlot((s) => this.mobs.canFeed(s.item));
    if (!held.empty && this.mobs.canFeed(held.item) && mob.breedCooldown <= 0) {
      return `<kbd>RMB</kbd> Feed`;
    }
    return null;
  }

  /**
   * Crosshair prompt for the environment's tax on the swing, or null on dry
   * land. The multiplier is printed rather than described because the whole
   * point is that the player can check it against what they are watching: a
   * vague "this is slow" is the same information a stuttering timer gives.
   *
   * `+toFixed(1)` prints 9 and 1.9 rather than 9.0 and 1.9 — the round numbers
   * are the common cases and a trailing zero reads like a measurement.
   */
  _dragHint() {
    const p = this.player;
    const drag = p.miningDrag;
    if (drag < 1.05) return null;
    const where = p.headInWater
      ? (p.grounded ? 'Under water' : 'Under water, adrift')
      : 'Adrift';
    return `${where}, ${+drag.toFixed(1)}x slower`;
  }

  _announceHeld() {
    const s = this.inventory.held();
    this.ui.showItemName(s.empty ? '' : ITEMS[s.item].label);
    this.ui.refresh();
  }

  /**
   * F: trade hands.
   *
   * Announced through `_announceHeld` like a hotbar key, and for the same
   * reason — what changed is what you are holding, and the item name over the
   * bar is where the player already looks to see it.
   */
  swapOffhand() {
    this.inventory.swapOffhand();
    this.audio.ui(520);
    this._announceHeld();
  }

  /**
   * Which arm the view model should move for something done with `slot`.
   *
   * `ViewModel.punch()` and `recoil()` default to `actingHand()`, which reads
   * the rule off the two fists — the right arm whenever the right fist holds
   * anything. That was `Inventory.active()`'s rule and it is now nobody's: the
   * left button is the main hand's however empty it is, and the right button
   * falls through on whether the item has a *use*, not on whether the fist is
   * full. So both of those questions are now answered here, from the slot the
   * action was actually charged to, and passed in.
   *
   * Compared by identity against the offhand slot rather than by contents,
   * because the two hands very often hold the same thing — two stacks of torches
   * is the ordinary case — and a contents test would light up the wrong arm for
   * exactly the player who is paying attention to both.
   *
   * @param {Slot} slot the hand that acted
   * @returns {'left'|'right'}
   */
  _handOf(slot) {
    return slot === this.inventory.offhand ? 'left' : 'right';
  }

  /**
   * The seedling block a held item sows, or 0 if the item is not a seed.
   *
   * Derived from the item's *name* rather than from a table, because a table
   * would be a third list of the same seven crops — after `CROP_FAMILIES` and
   * the blocks themselves — and the one that nobody would remember to add to.
   * The naming rule is the contract: `<crop>_seeds` sows `<crop>_0`, and bare
   * `seeds` is wheat's, which is the only irregular entry and is the one the
   * game shipped with.
   *
   * `cropFirstId` returns undefined for a name with no such block, so a seed
   * item added without its four blocks resolves to 0 and refuses to plant
   * rather than writing a garbage id into the world.
   */
  _seedlingOf(itemId) {
    if (!itemId) return 0;
    const name = ITEMS[itemId]?.name;
    if (name === 'seeds') return cropFirstId('wheat') ?? 0;
    if (!name?.endsWith('_seeds')) return 0;
    return cropFirstId(name.slice(0, -'_seeds'.length)) ?? 0;
  }

  _dropHeld() {
    const s = this.inventory.held();
    if (s.empty) return;
    const p = _v1.copy(this.player.eye).addScaledVector(this.player.lookDir, 0.8);
    const impulse = _v2.copy(this.player.lookDir).multiplyScalar(4.5);
    this.drops.spawn(p.x, p.y, p.z, s.item, 1, s.wear, impulse);
    s.count--;
    if (s.count <= 0) s.clear();
    this.inventory.changed();
  }

  /**
   * Hold to draw, release to loose.
   *
   * Ticked from `_update` and *not* from `_interact`, and that placement is the
   * design. `_interact` is skipped whenever a screen is open, so a draw ticked
   * inside it would freeze at whatever charge it had when you opened your
   * inventory and fire that charge whenever you closed it again. Out here, the
   * one branch that matters — "the button is no longer down and I had a draw" —
   * runs on every frame of the game, including the frame you alt-tabbed, opened
   * a crate or lost pointer lock.
   *
   * What happens on that branch depends on *why* the button is no longer down:
   *
   *  - released while you could still shoot        → the shot goes
   *  - a screen opened, lock was lost, the bow left your hand, the arrows ran
   *    out                                          → the draw is dropped
   *
   * The second case spends nothing. It has to: losing pointer lock clears
   * `input.buttons` wholesale (see `Input._onLockChange`), so a build that fired
   * on any release would put an arrow into the ceiling every time the player
   * tabbed away mid-aim.
   *
   * **Below the minimum draw nothing happens at all** — no arrow leaves the bow
   * and none is taken out of the quiver. A short press is a mis-click far more
   * often than it is a deliberate weak shot, and the alternative (a feeble arrow
   * and a lost one from the stack) punishes the mistake twice. The floor is
   * `bow.min` in Items.js, a quarter of the draw.
   *
   * @param {boolean} busy true when a screen is up
   */
  _tickBow(dt, input, busy) {
    const b = this.bow;
    // Which hand is drawing, resolved by the same rule the rest of the right
    // button uses — not `active()`, which only reaches the offhand when the main
    // hand is *empty*. A bow in the left hand and a pickaxe in the right is the
    // ordinary way to carry one: the pickaxe claims no right-click, so the bow
    // draws, exactly as it does in Minecraft.
    //
    // `_aimHit` is last frame's crosshair cell, cached by `_interact`, because
    // this runs a step ahead of the raycast and must not cast a second one — two
    // rays in a frame is two answers about what you are looking at. One frame of
    // lag is invisible here and only matters at all for a shovel, whose claim is
    // the only aim-dependent thing that can talk a bow out of the click.
    const slot = this.inventory.actingSlot((s) => this._hasUse(s, this._aimHit));
    const def = ITEMS[slot.item];
    // Remembered for the release, which happens on some later frame and must
    // charge the wear to the hand that actually drew rather than re-deriving it
    // against whatever the player is looking at by then.
    b.slot = def?.bow ? slot : null;
    const arrowId = itemIdOf(def?.ammo || '');
    // Everything that has to be true to go on drawing. Read once and used for
    // both the charge and the release, so the two can never disagree about
    // whether this was a shot or a cancellation.
    const armed = !!def?.bow && !busy && input.locked
      // `countWithOffhand`, not `count`: arrows held in the left hand are
      // ammunition you deliberately put there, and `count` walks `slots` alone
      // — so a full quiver in the offhand read as "Out of arrows".
      && (arrowId ? this.inventory.countWithOffhand(arrowId) > 0 : false);

    // The state machine itself is in Items.js, as a pure function, because it is
    // the only part of this with a wrong answer that nobody would see — see
    // `bowDrawStep`. This module cannot be imported by a test (it builds a game
    // on import), so the branch that decides "shot or cancellation" is kept
    // somewhere that can be.
    const next = bowDrawStep(b.t, {
      armed, down: input.buttons[2], dt, drawTime: def?.bow?.draw ?? 1,
    });
    const wasDrawn = b.t;
    b.t = next.t;
    if (next.fire) this._loose(def, arrowId, next.fire);
    // The creak, which climbs with the draw so holding at full sounds like
    // holding at full. Every quarter of the pull rather than every frame, and
    // only while the charge is rising: a bow drawing in silence gave the player
    // no way to hear how hard the shot was going to be, which is the one thing
    // the whole charge mechanic is about.
    if (b.t > wasDrawn && Math.floor(b.t / 0.25) > Math.floor(wasDrawn / 0.25)) {
      this.audio.bowDraw(b.t);
    }

    // Told every frame, including the frames it is zero: these are poses, not
    // events, and a listener that is only updated while drawing is a listener
    // that stays drawn after the shot.
    // The drawing fist, not a guess: `b.slot` is the slot this draw was charged
    // to a dozen lines up, so the bow, the arrow on its string and the arm that
    // retreats under it are all the same hand. `_handOf` of a null slot would be
    // `'right'` anyway (nothing is the offhand), but the draw is over on those
    // frames and there is nothing to place.
    this.viewModel.setDraw(b.t, arrowId, b.slot ? this._handOf(b.slot) : 'right');
    this.character.setDraw(b.t);
    this.ui.setCrosshairDraw(this.viewMode === VIEW_FIRST ? b.t : 0);

    // A drawn bow with no arrows says so rather than doing nothing, which is
    // otherwise indistinguishable from a broken button.
    //
    // Recorded rather than pushed straight at the UI: `_interact` owns the hint
    // line and clears it every frame it runs, so a message written from here
    // would be overwritten on the frames the player is looking at a block and
    // would stick forever on the frames they are not. It is read back out in the
    // bow branch of `_interact`, which is the one place that both runs at the
    // right time and knows nothing else wants the line.
    // Asked of whichever fist has a bow in it, not of `def` — because `def` is
    // the hand that *claimed* the click, and a bow with an empty quiver claims
    // nothing. That is the entire state this message exists for, so reading it
    // off the acting hand meant a pickaxe or a torch in the other hand silently
    // swallowed the explanation and the player was back to a dead button. The
    // main hand wins the tie for the same reason it wins everywhere else.
    const main = this.inventory.held();
    const bowSlot = ITEMS[main.item]?.bow ? main
      : ITEMS[this.inventory.offhand.item]?.bow ? this.inventory.offhand : null;
    const bowDef = bowSlot ? ITEMS[bowSlot.item] : null;
    const dry = bowDef
      && !(itemIdOf(bowDef.ammo || '')
        && this.inventory.countWithOffhand(itemIdOf(bowDef.ammo || '')) > 0);
    this.bow.hint = dry && input.buttons[2] && !busy && input.locked
      ? 'Out of arrows' : null;

    // And say it out loud, once per press.
    //
    // Edge-triggered on the hint rather than on the button, because the hint is
    // the state this is for and it is already the one thing here that knows
    // which fist the bow is in. Firing on `buttons[2]` every frame would be
    // sixty a second; firing on `clicked[2]` would miss the case a player
    // actually hits, which is holding the button down waiting for a draw that
    // never starts.
    //
    // Not `deny()`. A refusal shared with menu purchases and locked skills
    // teaches the player one thing — that something was refused — when the
    // useful thing to learn is that the quiver is empty. `dryFire` is the nock
    // finding nothing, in the hands rather than in the interface.
    const wasDry = this._bowDry;
    this._bowDry = !!this.bow.hint;
    if (this._bowDry && !wasDry) this.audio.dryFire();
  }

  /**
   * Let one go.
   *
   * @param {object} def the bow's item definition
   * @param {number} arrowId the ammunition item
   * @param {number} t draw fraction
   */
  _loose(def, arrowId, t) {
    // One function decides whether the shot happens and how hard, so there is
    // no window in which an arrow has been spent on a shot that was refused.
    const shot = bowShot(def, t);
    if (!shot) return;
    // Offhand first, then the bag — the same source `_tickBow` counted, so
    // "armed" and "an arrow was actually spent" can never disagree.
    if (this.inventory.removeWithOffhand(arrowId, 1) < 1) return;
    this.inventory.changed();

    // Out of the eye, along the look, pushed clear of the player's own body —
    // the first sub-step of the flight is a solidity probe and starting it
    // inside your own head would land the arrow at your feet.
    const from = _v1.copy(this.player.eye).addScaledVector(this.player.lookDir, 0.6);
    this.arrows.spawn(from, this.player.lookDir, shot.speed, shot.damage, shot.power);

    // The recoil, not a swing. See `ViewModel.recoil`: `punch` would also fire
    // the body's melee clip, and the body is already coming out of the draw.
    //
    // The arm that drew is the arm that kicks. `recoil()`'s default is
    // `actingHand()`, which is `active()`'s rule read off the fists — right
    // whenever the right fist holds anything — so an offhand bow fired while a
    // pickaxe was in the main hand kicked the pickaxe.
    const shooter = this.bow.slot ?? this.inventory.held();
    this.viewModel.recoil(this._handOf(shooter));
    // A bow wears by the shot, like every other tool wears by the stroke — and
    // the bow that was drawn is the bow that wears. The default here is
    // `active()`, which with an offhand bow and a pickaxe in the main hand
    // charged the shot to the pickaxe.
    if (def.tool) this.inventory.damageHeld(1, shooter);
    // Was `ui(240 + 140 * power)` — a menu blip on the game's loudest verb.
    // `bowRelease` is the string and the shaft, both scaled by the same draw.
    this.audio.bowRelease(shot.power);
  }

  /**
   * Does the item in this hand have anything to do with the right button, aimed
   * at this cell?
   *
   * The whole of the fall-through rule. `Inventory.actingSlot` asks it of the
   * main hand first and only reaches the offhand when the answer is no, so this
   * is the list of things that stop a torch in the left hand from going down.
   *
   * **Precedence, top to bottom.** Nothing below a line that claims is ever
   * consulted:
   *
   *  1. The *block* you are aiming at, before either hand: a bench, a kiln, a
   *     crate, a bed, a door, a sign. Those are answers the world gives, and
   *     they are why you can open a chest with a full pickaxe hand. Not decided
   *     here — see the top of the right-button chain in `_interact`.
   *  2. The main hand, if this returns true for it.
   *  3. The offhand, if this returns true for it.
   *  4. Neither: the main hand, doing nothing.
   *
   * **What claims unconditionally**, because the item is the action and the cell
   * has no say in it: anything that places a block, food, a bucket full or
   * empty, a fishing rod, a bow. Two blocks, one in each hand, is the case this
   * settles most often: the right hand wins, always, and the left is not a
   * second chance at a placement the right hand refused.
   *
   * **What claims only against the right cell**: the shovel, which tills, and
   * seeds, which sow. These are the point of the exercise — a shovel and a torch
   * has to till dirt and light a wall, and it can, because the shovel only
   * speaks up when there is soil under the crosshair.
   *
   * Note which test the shovel uses: `canTill`, the soil test, and **not**
   * `tillable`, which also wants an open sky. A shovel aimed at dirt with a
   * block over it claims the click and is refused out loud. The alternative —
   * treating roofed dirt as "no action" — would place the offhand torch instead,
   * and a click that does something you did not ask for is worse than a click
   * that tells you why it did nothing.
   *
   * **What never claims**: an empty hand, a pickaxe, an axe, a sword, and every
   * other plain material. That is the set a torch can be used over.
   *
   * @param {Slot} slot
   * @param {object|null} hit the cell under the crosshair, if any
   */
  _hasUse(slot, hit) {
    if (slot.empty) return false;
    switch (useKind(slot.item)) {
      case 'any': return true;
      case 'soil': return !!hit && this.farming.canTill(hit.id);
      case 'seed': return !!hit && this.farming.canPlant(hit.col, hit.k);
      // The same source `_tickBow` counts and `_loose` spends, so "the bow
      // claimed the click" and "the bow can actually draw" cannot disagree.
      case 'bow': {
        const ammo = itemIdOf(ITEMS[slot.item]?.ammo || '');
        return !!ammo && this.inventory.countWithOffhand(ammo) > 0;
      }
      default: return false;
    }
  }

  _interact(dt, input) {
    const hit = this.planet.raycast(
      this.player.eye, this.player.lookDir, this.player.reach,
    );
    // Handed to `_tickBow`, which runs before this method and needs the same
    // answer to decide whether a shovel in the main hand has talked the offhand
    // bow out of the click. See the note there about why it does not cast again.
    this._aimHit = hit;

    // a creature in front of the block takes the hit instead
    const mobHit = this.mobs.raycast(this.player.eye, this.player.lookDir, this.player.reach);

    // Name whatever is under the crosshair.
    //
    // Done here rather than with its own raycast because the answer already
    // exists: this is the one place that knows both what you are aiming at and
    // which of the two won. A second cast would be the same work twice and
    // could disagree with the highlight box on the frame they straddle a face.
    // The creature takes precedence for the same reason it takes the hit.
    // ...and when there is nothing within arm's length, say what you are
    // looking at anyway. "Breaking/mining have max reach but the crosshair
    // shouldn't - show a toast of what we are looking at from far distance, not
    // just what's near."
    //
    // The note above still holds and is why this is an `else` rather than a
    // replacement: inside reach the answer comes from the cast that already
    // happened, so the name and the highlight box can never disagree. The far
    // cast only runs on frames where the near one found nothing, which is
    // exactly when there is no highlight to disagree with, and it stops at the
    // first thing it meets so a wall still hides what is behind it.
    // `mob.label` before `mob.spec.label`, because one species now has more
    // than one name: the husk is painted by the biome it was found in and calls
    // itself a Frost Husk on a snowfield and a Moss Husk in a wood. Only those
    // set the per-mob field; everything else leaves it null and reads its
    // species name exactly as before. See HUSK_KIND in game/Mobs.js.
    let named = mobHit && (!hit || mobHit.dist < hit.dist)
      ? (mobHit.mob.label ?? mobHit.mob.spec.label ?? null)
      : (hit ? (BLOCKS[this.planet.at(hit.col, hit.k)]?.label ?? null) : null);
    if (!named) {
      const far = this.planet.raycast(this.player.eye, this.player.lookDir, LOOK_RANGE);
      const farMob = this.mobs.raycast(this.player.eye, this.player.lookDir, LOOK_RANGE);
      named = farMob && (!far || farMob.dist < far.dist)
        ? (farMob.mob.label ?? farMob.mob.spec.label ?? null)
        : (far ? (BLOCKS[this.planet.at(far.col, far.k)]?.label ?? null) : null);
    }
    this.ui.setLookAt(named);

    // The hand the *right* button is speaking to, for the whole of this method.
    //
    // Hoisted above the creature branch rather than left down by the block
    // placement, because the creature branch is the other half of the same
    // question: whether a bow is drawing decides whether the right button is
    // available to feed a cow, and whether the offhand holds the wheat decides
    // what the cow is offered. Two resolutions of "which hand" in one frame is
    // two chances to disagree.
    //
    // `actingSlot` and not `active()`: the offhand acts when the main hand has
    // nothing to do with the cell under the crosshair, which is what makes a
    // torch in the left hand placeable while a shovel is in the right. The left
    // button is emphatically *not* resolved this way — see `_breakBlock`.
    const heldSlot = this.inventory.actingSlot((s) => this._hasUse(s, hit));
    const heldItem = ITEMS[heldSlot.item];
    // A bow that is actually drawing, in whichever hand is drawing it. The right
    // button belongs to it, so nothing else may answer that button this frame —
    // but the left button is untouched, because in Minecraft a bow is still a
    // (feeble) club and, more to the point, a pickaxe in the main hand must not
    // stop being a weapon just because there is a bow in the left.
    const drawing = !!heldItem?.bow;
    if (mobHit && (!hit || mobHit.dist < hit.dist)) {
      this.ui.setCrosshairActive(true);
      this.highlight.visible = false;
      if (input.clicked[0] && input.locked) {
        // The main hand, always — a sword in the left hand does not swing, for
        // the same reason a pickaxe there does not mine. See `_breakBlock`.
        const held = ITEMS[this.inventory.held().item];
        // Swings have a rhythm. Clicking is edge-triggered with no cooldown, so
        // once blows started knocking husks backwards a player could hold one
        // in the air indefinitely by clicking fast — free, skill-less immunity.
        // A swing landed early still lands, at a fraction of its weight and
        // with no shove behind it, which makes timing worth something without
        // punishing the player for touching the button.
        const charge = Math.min(1, this.attackT / ATTACK_PERIOD);
        // The one place the crit is applied, so it cannot be applied twice: the
        // multiplier goes into `dmg` and nothing downstream of `hurt` knows a
        // crit happened. It multiplies the *charged* number rather than the
        // weapon's base, which is why it needs no separate rule about hurried
        // swings — see CRIT_CHARGE, which will not let one crit anyway.
        const crit = critMultiplier(this.player, charge);
        const dmg = (held?.damage ?? 1) * (0.3 + 0.7 * charge) * crit;
        this.attackT = 0;
        this.player.swing();
        this.viewModel.punch('right');   // the attacking arm, see `_breakBlock`
        // soft flesh impact at the animal, not a grass footstep at your feet.
        // The species' own hurt/death cry comes from Mobs via onSound.
        //
        // A crit lands the same thump harder and puts a bright tick on top of
        // it. Half the point of this feature is that it can be *perceived* — a
        // 50% damage change that looks and sounds identical to a normal hit is
        // indistinguishable from no feature at all, which is precisely the
        // report that asked for it ("jumping and hitting has same damage same
        // as just hitting"). Three channels, none of them a new asset: the
        // heavier flesh impact, a short bright tick over it, and the spark
        // burst below. `ui()` is the existing blip voice — high and short here,
        // so it reads as the edge going in rather than as a menu.
        this.audio.mobHit(mobHit.mob.position, crit > 1 ? 1.5 : 1);
        if (crit > 1) {
          // Two channels, and deliberately no particles.
          //
          // A crit first shipped with a burst of shards, which came out of the
          // block-break debris pool — the same instanced cubes that were taken
          // off the mining path at the player's request, because the crack
          // overlay already told that story. Putting them back on a different
          // event put them back in the game, and they were recognised on sight.
          // Shrinking them below the size a cube resolves at was the obvious
          // save; dropping them is the better one. The sound is heard wherever
          // you are looking and the sight is where the eye already is, so a
          // third announcement was never carrying its own weight.
          //
          // The one thing lost is that the crosshair is hidden in the
          // third-person views, so there a crit is audible only. That is a fair
          // trade for never showing a cube again, and the thump is already
          // pitched differently from an ordinary hit.
          // Was `ui(1480)` — the menu square, dry and centred on the head, for
          // the best moment in the game. `impact('metal')` is the same idea
          // done with the right instrument and, unlike the blip, it comes from
          // the animal, so it lines up with the thump above instead of sitting
          // beside it.
          this.audio.impact('metal', mobHit.mob.position);
          this.ui.critHit();
        }
        // Shove scales with the swing, rather than switching on at 85%.
        //
        // The damage above is already a smooth 0.3..1 ramp on the same charge;
        // the knock was the one part of a blow that was a step function, so
        // every swing under the threshold — which is most swings — landed with
        // literally zero shove, and the animals read as bolted to the ground.
        //
        // Raw `charge` and not a pre-floored ramp: `hurt` applies its own floor
        // so that a connecting blow always moves what it hits, and flooring it
        // twice would quietly halve what timing is worth.
        // `hurt` returns true when that blow was the last one. Gated on
        // `hostile` rather than on the husk's name so that whatever else comes
        // out of the dark next patch counts for the same mark — and so that
        // clubbing a cow never does.
        const killed = this.mobs.hurt(mobHit.mob, dmg, this.player.position, charge);
        // Priced from the creature's own health and damage rather than from a
        // per-species table, so anything added later prices itself. Hostiles
        // only: a cow is worth beef and hide and no xp whatever, and neither is
        // a calf of anything. See `xpForKill`.
        if (killed) {
          this.skills.xpKill(mobHit.mob.spec, mobHit.mob.baby > 0);
          this.stats.kills = (this.stats.kills ?? 0) + 1;
        }
        if (held?.tool) this.inventory.damageHeld(1, this.inventory.held());
      }
      // Right-click offers whatever you're holding. Feeding is how a herd
      // grows, and it's the only reason to keep an animal alive.
      //
      // Same fall-through as the block path, with the creature's own test in
      // place of `_hasUse`: a pickaxe is not food, so wheat in the left hand is
      // what the cow is offered. `feed` is asked again below because it also
      // refuses a cow on cooldown, and that refusal must not silently eat the
      // stack.
      const feedSlot = this.inventory.actingSlot((s) => this.mobs.canFeed(s.item));
      // `!drawing`: the right button is the bow's while it is being drawn, and
      // an animal wandering across the aim must not eat the shot — nor a stack
      // of wheat. This is the whole of what the old `bowHeld` gate on this
      // branch was for; the left button is no longer caught by it.
      if (!drawing && input.clicked[2] && input.locked && this.useCooldown === 0) {
        this.useCooldown = 0.3;
        // The merchant answers the same button, empty-handed or not — it is the
        // one creature you interact with rather than feed.
        if (mobHit.mob.spec.trader) {
          this.openScreen('shop', mobHit.mob);
        } else if (mobHit.mob.spec.folk) {
          // PLACEHOLDER, and the only thing in this feature that is one. The
          // barter panel lives in `src/ui/`, which another hand owns; this is
          // the call site it replaces, and `barterOffers`/`barterRefusal`/
          // `barterAccept` above are the whole of what it needs. Until then a
          // toast is enough to see the model working in a running game.
          this._barterPeek(mobHit.mob);
        } else if (!feedSlot.empty && this.mobs.feed(mobHit.mob, feedSlot.item)) {
          this.inventory.consumeHeld(1, feedSlot);
          this.player.swing();
          this.viewModel.punch(this._handOf(feedSlot));
          this.ui.toast(mobHit.mob.baby > 0 ? 'Fed the calf' : 'Ready to breed',
            feedSlot.item, 1300);
        }
      }
      // The bow's own refusal outranks the feed prompt: a player holding the
      // button on an empty quiver is asking why nothing happened, and "Feed" is
      // not the answer. Everywhere else this message is joined in below.
      this.ui.setHint(null);
      this.placeCooldown = Math.max(0, this.placeCooldown - dt);
      this.useCooldown = Math.max(0, this.useCooldown - dt);
      voxelUniforms.uBreakStage.value = -1;
      this.mining.key = null;
      this.mining.progress = 0;
      /**
       * ...and you can still eat with a creature in front of you.
       *
       * This branch returned unconditionally, and the eating branch is below
       * it, so a creature nearer than the block under the crosshair made food
       * impossible to eat. Reported as "I was holding a berry and I tried
       * eating it but nothing happened" - on a face with animals wandering
       * over it, which is most of them, that is most of the time.
       *
       * Feeding still wins the button, and keeps winning it, because it is
       * edge triggered and this is not: a click offers the animal a berry, and
       * only a hold with nothing left to offer becomes a meal. `FEEDS` is a
       * set of items rather than a fact about the creature, so the test is
       * "could this feed anything", which is the same question the branch
       * above already asked.
       */
      if (input.buttons[2] && input.locked && !drawing
        && heldItem?.food && !this.mobs.canFeed(heldSlot.item)) {
        this._tickEating(dt, heldSlot, heldItem);
      } else if (!this.mobs.canFeed(heldSlot.item)) this.eating = 0;
      return;
    }
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);
    this.useCooldown = Math.max(0, this.useCooldown - dt);

    if (hit) {
      this._showHighlight(hit.col, hit.k);
      this.ui.setCrosshairActive(true);
    } else {
      this.highlight.visible = false;
      this.ui.setCrosshairActive(false);
      // Swung at nothing. Sound only, and no cooldown of its own: `clicked` is
      // edge-triggered so this is one whoosh per press, and the voice budget's
      // `step` cap holds the ceiling. A miss used to be indistinguishable from
      // never having pressed the button, which is exactly what a whoosh is for.
      if (input.clicked[0] && input.locked) this.audio.swing();
    }

    // An over-tier block still shatters and drops nothing. Silently losing six
    // No "Needs a Pickaxe". It was here to stop a slow dig reading as a broken
    // game, and it bought that at the price of teaching the tool rules out
    // loud, which is the one thing this game is not supposed to do: a stone
    // that only a pickaxe pays out for is something to work out by swinging an
    // axe at one, not something to be told at the crosshair. The dig being slow
    // and the block yielding nothing already say it, in the language the game
    // is played in. `harvestHint` is left in `Items.js` and simply not called.
    //
    // One chain, one winner. Setting a hint anywhere above this ran into the
    // unconditional clear at the end of it and lasted exactly zero frames.
    const needTool = null;
    // (`heldSlot`/`heldItem` — the hand the right button is speaking to — are
    // resolved once at the top of this method, above the creature branch.)
    // Soil with something built over it, said while you are *aiming*.
    //
    // The till is edge-triggered, so a refusal written from inside the click
    // branch would live for one frame and be seen by nobody. Up here it is
    // re-set every frame the crosshair is on covered soil, which is also when
    // the player is deciding what to do about it.
    const tillHint = null;
    // Same argument as the line above it, for the other invisible tax. A player
    // who dives onto a lake bed and finds sand taking two thirds of a second a
    // block has no way to tell a rule from a broken timer, so the rule says so
    // itself, with the multiplier in it — and it says so while you are *aiming*
    // rather than only once you have already spent the breath.
    //
    // Gated on a breakable block so it is not a permanent caption on swimming;
    // water's own hardness is -1, so looking at the lake says nothing.
    const dragHint = null;
    if (hit && IS_SIGN[hit.id]) {
      // Reading is looking: no key to press and nothing to open, so a row of
      // signs can be read by sweeping across them.
      const text = this.signs.get(cellIdx(hit.col, hit.k));
      // The hint is one line, so the board's own line breaks become spaces
      // rather than vanishing into a run-on: "WEST GATE\nkeep out" reads as
      // "WEST GATE keep out" and not as "WEST GATEkeep out".
      this.ui.setHint(text ? `"${text.replace(/\s*\n\s*/g, ' ')}"` : 'A blank sign');
    } else if (hit && (hit.id === ID.bench || hit.id === ID.kiln || hit.id === ID.kiln_lit
                       || hit.id === ID.kitchen)) {
      this.ui.setHint(null);
    } else if (needTool || dragHint || tillHint) {
      // Both can be true — a wrong tool on a wet seam is the worst case in the
      // game and the one most likely to be read as broken — so neither hides
      // the other.
      //
      // `bow.hint` is in the list because the bow's own branch below is no
      // longer guaranteed to run: an empty quiver hands the click to the
      // offhand, and "Out of arrows" is exactly the message that must survive
      // that — it is the reason the player is about to be placing a torch with
      // a bow in their hand.
      this.ui.setHint([needTool, dragHint, tillHint].filter(Boolean).join(', '));
    } else this.ui.setHint(null);

    const m = this.mining;
    // The dig timer's tool, and the third of the three lines that must agree
    // about which hand is mining — see `_breakBlock` for why it is the main one.
    const heldDef = ITEMS[this.inventory.held().item];
    if (input.buttons[0] && hit && input.locked) {
      const key = cellIdx(hit.col, hit.k);
      if (m.key !== key) { m.key = key; m.progress = 0; }
      // The hands branch is a multiplier on the finished timer rather than a
      // term inside `miningTime`: that function is shared with the worker's
      // idea of hardness and with the tool ladder, and a skill reaching into it
      // would make a block's break time depend on who was asking.
      // `miningTime` is asked for the dry-land number and the environment is
      // applied out here, for the same reason the skill multiplier is: that
      // function is the shared idea of hardness and the tool ladder, and a
      // block's break time should not depend on who is standing in front of
      // it. `Player.miningDrag` carries the whole water/adrift rule — including
      // the water constant `miningTime` would otherwise apply itself, which is
      // why `submerged` is passed false here rather than left to double up.
      const drag = this.player.miningDrag;
      const time = miningTime(hit.id, heldDef, false)
        * drag * this.skills.miningScale;
      if (isFinite(time) && hit.id !== ID.core) {
        m.progress += dt / time;
        // Sparks and the dig sound thin out with the swing rate rather than
        // ticking on at ten a second while the arm moves at three — the same
        // √drag Player.js uses, so the three channels stay in step.
        // Sound only. `hitSpark` threw chips off the face on the way in, and
        // those chips come out of the same instanced-cube pool as the break
        // burst that was removed at the player's request, so mining still
        // produced exactly the cubes they had asked to be rid of. The crack
        // overlay already draws the whole dig and it lands on the one face
        // being worked, which is more information than a spray of boxes.
        if (Math.random() < dt * 10 / Math.sqrt(drag)) {
          this.audio.dig(BLOCKS[hit.id].sound, hit.point);
        }
        if (this.player.swingT >= 1) { this.player.swing(); this.viewModel.punch('right'); }
        if (m.progress >= 1) {
          this._breakBlock(hit);
          m.progress = 0; m.key = null;
        }
      }
    } else {
      m.key = null;
      m.progress = Math.max(0, m.progress - dt * 3.5);
    }

    const stage = m.progress > 0.001 && m.key !== null ? Math.min(9, Math.floor(m.progress * 10)) : -1;
    voxelUniforms.uBreakStage.value = stage;
    if (stage >= 0 && hit) {
      this.planet.centerOf(hit.col, hit.k, voxelUniforms.uBreakPos.value);
    }

    // Everything below is the right button, and for a bow that is the draw,
    // which `_tickBow` already owns. This sits here rather than at the top of
    // the method so the mining block above still runs: a bow swings at exactly
    // bare-hand speed, and a pick block refuses to drop for anything that is
    // not a pickaxe, so a fist and a bow are refused by the same line. The old
    // early return cited a flat wrong-tool multiplier that no longer exists.
    //
    // `heldItem`, the hand the right button resolved to at the top of this
    // method, and not "is there a bow anywhere on me". A bow with an empty
    // quiver no longer claims (see `useKind`), so the acting hand is the
    // offhand, and returning here on a bow that is doing nothing was what made
    // "holding torch in left hand can still not place it" true. It is also the
    // line that lets a bow be drawn *from the offhand*: a pickaxe claims
    // nothing, so `heldItem` is the left hand's bow, and `_tickBow` — which
    // resolves the hand exactly the same way — is charging it.
    if (heldItem?.bow) { this.eating = 0; this.ui.setHint(null); return; }

    // --- eating: hold RMB on any food ---
    //
    // With one exception, which the sea plants introduced and which had to be
    // handled or they could not have existed: **food that is also a block**.
    //
    // Kelp, sea lettuce and sea grapes are all three at once — a block in the
    // world, an item in the bag, and a meal — and this branch used to `return`
    // before the placement attempt at the very bottom of the method. So the
    // moment an item declared `food`, it became impossible to put down: sea
    // lettuce would have been unplaceable, and so would kelp, which has been
    // placeable since the reef shipped. That is a regression you would only
    // find by trying to plant one.
    //
    // The rule is "place it if you can, eat it if you cannot", which is decided
    // *after* the placement attempt rather than guessed at before it — see the
    // tail of this method. It also happens to read exactly right for seaweed:
    // `IS_SUBMERGED` means these only go down under water, so holding the
    // button while you swim plants a bed and holding it on dry land eats the
    // plant, and neither needed a new control.
    // `heldSlot`/`heldItem` are the acting hand, resolved with the aim above.
    const edibleBlock = !!(heldItem?.food && heldItem.block !== undefined);
    if (!edibleBlock) {
      if (heldItem?.food && input.buttons[2] && input.locked) {
        this._tickEating(dt, heldSlot, heldItem);
        return;
      }
      this.eating = 0;
    }

    // --- bucket: scoop or pour ------------------------------------------
    // Handled before the `hit` gate below, because filling needs a ray that
    // *stops* on liquid — the ordinary interaction ray passes straight through
    // water, so a lake never registers as something you can click.
    if (input.clicked[2] && input.locked && this.useCooldown === 0
        && (heldSlot.item === itemIdOf('bucket') || heldItem?.carries)) {
      this.useCooldown = 0.28;
      if (this._useBucket(heldSlot)) return;
    }

    // --- fishing: cast, wait, fight -------------------------------------
    if (heldItem?.tool?.kind === 'rod') {
      // Once the fight is on, the button is the control and not a click any
      // more: a press that reeled in mid-fight would throw the fish away on the
      // first thing the player instinctively does, which is grab the button.
      // Hold to wind up, let go to throw - but only when there is no line out.
      // With a cast on the water the button is still the single click that
      // reels in, because holding it to bring a fish back would mean the
      // instinctive grab at the button during a fight was also a wind-up.
      if (!this.fishing?.fight) {
        const down = !!input.buttons[2] && input.locked;
        if (!this.fishing) {
          if (down) {
            this.castCharge = Math.min(1, (this.castCharge ?? 0) + dt / FISH_WINDUP_TIME);
          } else if (this.castCharge > 0) {
            const power = this.castCharge;
            this.castCharge = 0;
            if (this.useCooldown === 0) {
              this.useCooldown = 0.3;
              this._rodClick(power);
            }
          }
        } else if (input.clicked[2] && this.useCooldown === 0) {
          this.useCooldown = 0.3;
          this._rodClick();
        }
      }
      // The arm shows the hold. Every frame rather than on the two edges,
      // because the charge is a continuous value and the pose eases toward it.
      this.viewModel.setCastCharge(this.castCharge ?? 0,
        this.inventory.actingSlot((s2) => ITEMS[s2.item]?.tool?.kind === 'rod')
          === this.inventory.offhand ? 'left' : 'right');
      this._tickFishing(dt);
      if (this.fishing) {          // holding the line: nothing else to do
        // Nothing is said during the fight. The bar is the instruction.
        //
        // It is its own plate under the compass now rather than the hint line
        // at the bottom of the screen. The hint line is where the game answers
        // "what would this click do", which is a thing you read once and stop
        // reading; a cast is up for the best part of a minute and belongs with
        // the clock and the bearing, at a size you can see without looking for
        // it. One word, and it stays one word.
        // Not while the float is still in the air: "Waiting" over a throw that
        // has not landed is the plate answering a question nobody asked yet.
        return;
      }
    } else {
      // Put the rod away mid-wind-up and the charge goes with it, or it would
      // still be sitting there next time one is drawn and throw a full-strength
      // cast off a button you never held.
      this.castCharge = 0;
      this.viewModel.setCastCharge(0);
      if (this.fishing) this._stopFishing();
    }

    if (input.clicked[2] && hit && input.locked && this.useCooldown === 0) {
      this.useCooldown = 0.22;
      /**
       * Sneak means "I meant the block, not the thing".
       *
       * Right-clicking a bench, a kiln or a crate opened it, always, so there
       * was no way to build against one: every attempt to stack a block on your
       * workbench opened the workbench instead. Crouching suppresses the open
       * so the placement below runs, which is the convention every player of
       * this genre already has.
       *
       * Gated on actually HOLDING something placeable, and that is deliberate
       * rather than a copy of the convention. Sneak is a LATCH on touch - one
       * tap and it stays on - so a player who left it latched and walked up to
       * a chest would find the chest simply refusing to open, with no way to
       * work out why. Suppressing only when the click has somewhere else to go
       * keeps the rule invisible until it is useful.
       */
      const meansBlock = this.player.crouching
        && ITEMS[heldSlot.item]?.block !== undefined;
      if (!meansBlock) {
        if (hit.id === ID.bench) { this.openScreen('bench'); return; }
      // The cooker. It carries no state object, unlike the kiln and the crate:
      // it works out of `inventory.craft` exactly as the workbench does, so
      // there is nothing to look up here and nothing to save, and closing the
      // screen already spills whatever is left in the grid onto the floor.
        if (hit.id === ID.kitchen) { this.openScreen('kitchen'); return; }
        if (hit.id === ID.kiln || hit.id === ID.kiln_lit) {
          this.openScreen('kiln', this._kilnAt(hit.col, hit.k));
          return;
        }
        if (hit.id === ID.crate) {
          this.openScreen('crate', this._crateAt(hit.col, hit.k));
          return;
        }
        if (hit.id === ID.bed) { this._useBed(hit.col, hit.k); return; }
        if (IS_DOOR[hit.id] || IS_GATE[hit.id]) { this._toggleDoor(hit.col, hit.k); return; }
        if (IS_SIGN[hit.id]) { this._writeSign(hit.col, hit.k); return; }
      }
      // --- till soil with a shovel ---
      //
      // Soil under a block is refused rather than tilled, and the click still
      // ends here: the shovel claimed it (see `_hasUse`), so this returns either
      // way and the hint is the whole of the answer. Nothing is spent on a
      // refusal — no wear, no sound, no swing.
      if (heldItem?.tool?.kind === 'shovel' && this.farming.canTill(hit.id)) {
        // The refusal already says so on the hint line — see `tillHint`.
        if (!this.farming.till(hit.col, hit.k)) return;
        this.audio.place('soil');
        this.player.swing();
        this.viewModel.punch(this._handOf(heldSlot));
        this.inventory.damageHeld(1, heldSlot);
        return;
      }
      // --- sow seeds on farmland ---
      //
      // Every seed in the game plants through this one line. `_seedlingOf` maps
      // the held item to the block that goes in the ground, so a seventh crop
      // is a seed item and four blocks and nothing here.
      const seedling = this._seedlingOf(heldSlot.item);
      if (seedling !== 0 && this.farming.plant(hit.col, hit.k, seedling)) {
        this.inventory.consumeHeld(1, heldSlot);
        this.audio.place('grass');
        this.player.swing();
        this.viewModel.punch(this._handOf(heldSlot));
        this.ui.toast('Planted', heldSlot.item, 1200);
        return;
      }
    }
    let placed = false;
    if (input.buttons[2] && hit && this.placeCooldown === 0 && input.locked) {
      placed = this._placeBlock(hit, heldSlot);
      this.placeCooldown = placed ? 0.2 : 0.12;
    }

    // The other half of the edible-block rule (see the eating note above).
    //
    // A successful placement arms a short timer rather than simply zeroing the
    // chew, because placement is rate-limited to five a second and `placed` is
    // therefore false on most frames of a press that is very much planting. The
    // timer has to outlive one `placeCooldown` and nothing more: at 0.35 a
    // player laying a kelp bed never starts to eat, and a player holding the
    // button somewhere the block will not go waits a third of a second before
    // the meal begins — which they will not notice, because eating takes 1.3.
    if (edibleBlock) {
      this._plantHold = Math.max(0, (this._plantHold || 0) - dt);
      if (placed) this._plantHold = 0.35;
      if (placed || this._plantHold > 0 || !input.buttons[2] || !input.locked) this.eating = 0;
      else this._tickEating(dt, heldSlot, heldItem);
    }
  }

  /**
   * One frame of chewing. Extracted from `_interact` so that the two cases that
   * reach it — ordinary food up front, and a food you could also have placed
   * after the placement attempt has declined — run the same code rather than
   * two copies that drift.
   */
  _tickEating(dt, heldSlot, heldItem) {
    // One chew sequence per meal, fired on the first frame of it. The old
    // `step('grass')` at nine a second was a footstep standing in for a bite,
    // and it was the wrong instrument at the wrong rate; `eat()` is four
    // irregular wet grains and a swallow, sized to the 1.3s the meal takes.
    // Nothing to gain, so nothing is eaten.
    //
    // The meal was going down whatever state you were in: at a full bar the
    // energy line clamps to 1 and the health line to maxHealth, so the food
    // left the bag and bought nothing at all. That is a silent loss of an item
    // the player deliberately spent, which is worse than the click doing
    // nothing. Both are checked because food does both jobs - a full stomach
    // with a hurt player is still a meal worth eating.
    if (this.energy >= 1 && this.player.health >= this.player.maxHealth) {
      this.eating = 0;
      this.ui.setHint('Not hungry');
      return;
    }
    if (this.eating === 0) this.audio.eat();
    this.eating += dt;
    // Crumbs in the food's own colour, not `footDust(ID.dirt)` - see `crumbs`.
    if (Math.random() < dt * 7) {
      this.particles.crumbs(this.player.eye, this.player.up, foodCrumbColor(heldItem));
    }
    if (this.eating < 1.3) return;
    this.eating = 0;
    this.energy = Math.min(1, this.energy + heldItem.food * FOOD_TO_ENERGY);
    this.player.health = Math.min(this.player.maxHealth,
      this.player.health + Math.ceil(heldItem.food * 0.35));
    this.inventory.consumeHeld(1, heldSlot);
    this.audio.pickup();
    this.ui.toast(`Ate ${heldItem.label}`, heldSlot.item, 1400);
    // The bill, and it arrives *after* the food has been paid out rather than
    // instead of it. Raw green beans and a raw pufferfish still feed and still
    // heal - a poisoned meal is a meal - and then cost four points over the next
    // twelve seconds, which is a net loss on both and is meant to be. Cooking
    // either one removes the flag by removing the item: `greenbean` smelts to
    // `cooked_greenbean` and every fish smelts to `cooked_fish`, and neither
    // output carries `poison`. See the POISON_* block.
    if (heldItem.poison) this.poison();
  }

  /**
   * One click of the rod: cast if the line is out of the water, strike if it
   * is in, and reel in empty-handed if you struck too early or too late.
   */
  /**
   * Throw the weight and answer where it went in.
   *
   * A ballistic march, deliberately shaped like `Arrows.step` rather than
   * beside it: local up is the outward radial at the weight's *own* position
   * and is recomputed every step, so a cast on the far side of the planet arcs
   * the same way as one at the spawn. What it does not borrow is the scene
   * graph — nothing here spawns, draws or persists anything, which is what
   * lets a test call it with two vectors and read the answer.
   *
   * The march is by length and not by time (see `FISH_CAST_STEP`) and every
   * probe asks three questions in the order they can end the throw: water ends
   * it successfully, anything solid or molten ends it as a miss, and the range
   * cap ends it as a miss. Water is tested first on purpose — the surface of a
   * lake is the cell above its bed, and asking "solid?" first at a grazing
   * entry angle would call a shallow shelf a bank.
   *
   * **`path` is what the player watches.** The march has always known the whole
   * flight — the shape and the clock both — and used to throw all of it away and
   * return one cell, which is why the float appeared on the water on the frame
   * of the click. Handed an array, it writes the flight into it as flat
   * `x, y, z, t` quadruples, and `_tickFishing` flies the float along them. The
   * curve you see is then the curve that was integrated, not a second one drawn
   * to look like it, and there is no way for the two to disagree about where it
   * lands.
   *
   * @param {THREE.Vector3} from where the weight leaves the rod
   * @param {THREE.Vector3} dir unit aim direction
   * @param {number[]} [path] filled with x, y, z, t per step when given
   * @returns {{col:number, k:number}|null} the water cell it entered, or null
   */
  _castArc(from, dir, path, power = 1) {
    if (path) path.length = 0;
    const p = _castP.copy(from);
    // Power scales the launch speed, so the wind-up buys distance along the arc
    // the aim already chose rather than flattening it. Range is roughly the
    // square of speed under gravity, so the 0.42 floor still throws about a
    // fifth of the full distance - short, not useless.
    const v = _castV.copy(dir).normalize()
      .multiplyScalar(FISH_CAST_SPEED * (FISH_CAST_MIN + (1 - FISH_CAST_MIN) * power));
    const g = GRAVITY * FISH_CAST_G;
    for (let t = 0; t < FISH_CAST_TIME;) {
      const speed = v.length();
      if (speed < 1e-4) return null;
      // One step is always FISH_CAST_STEP long, so `dt` is what that costs at
      // the speed the weight happens to be doing. At the top of a lobbed arc
      // that is a slow, fine step and near the ground a fast one, which is the
      // right way round: the top is where the shape is and the bottom is where
      // the cells are big compared to the error.
      const dt = FISH_CAST_STEP / speed;
      t += dt;
      p.addScaledVector(v, dt);
      v.y -= g * dt;
      if (path) path.push(p.x, p.y, p.z, t);

      if (p.distanceTo(from) > FISH_CAST_RANGE) return null;
      const cell = this.planet.cellAt(p.x, p.y, p.z);
      if (!cell) return null;
      const id = this.planet.at(cell.col, cell.k);
      if (id === ID.water) return cell;
      if (id === ID.lava || IS_SOLID[id]) return null;
    }
    return null;
  }

  /**
   * Is this water cell part of a hot spring?
   *
   * **The same three block reads `Player.inSpring` makes, and deliberately not
   * a second predicate.** A spring pool is the only water on the planet with
   * tuff under it — the lake beds are mud, peat, clay, sand, gravel, slate and
   * basalt, and the seabed is sand and gravel — so this identifies a pool
   * without the worker having to ship the per-column water style to the main
   * thread. Two reads down because a pool is two deep in the middle and one on
   * the shelf; one read up because the other water that rests on tuff is a deep
   * aquifer lens inside the granite band, and a spring is built exactly two
   * deep, so air within two of the surface excludes it.
   *
   * If that rule ever changes it changes in `Player.js` first and this has to
   * follow, which is why the reasoning is restated here rather than referred to.
   */
  _isSpring(col, k) {
    const p = this.planet;
    return (p.at(col, k - 1) === ID.tuff || p.at(col, k - 2) === ID.tuff)
      && p.at(col, k + 2) === 0;
  }

  _rodClick(power = 1) {
    if (!this.fishing) {
      // Thrown from the rod's tip and not from the eye. Half a cell out along
      // the aim is enough that the first probe is never inside the block the
      // player is standing in or the wall they are leaning on, which a cast
      // launched from the eye reads as a bank every time you fish over a lip.
      // Its own vector and not the shared scratch: it is still needed after the
      // arc has run, to measure how far the throw went.
      const tip = this.player.eye.clone()
        .addScaledVector(this.player.lookDir, 0.5);
      const path = [];
      const wet = this._castArc(tip, this.player.lookDir, path, power);
      if (!wet) {
        this.ui.setHint('Cast at open water');
        return;
      }
      // The arc can enter a body through a side face — off a low pier, or into
      // the step at the edge of a shelf — and land a cell or two under the
      // surface, which put the float inside the water instead of on it. Climb
      // the column to the last water cell so a cast always floats.
      let k = wet.k;
      while (k + 1 < D && this.planet.at(wet.col, k + 1) === ID.water) k++;
      // A hot spring is for soaking in, not for fishing out of.
      if (this._isSpring(wet.col, k)) {
        this.ui.setHint('Too hot to fish');
        return;
      }
      const c = this.planet.centerOf(wet.col, k, new THREE.Vector3());
      // How deep the water under the float is, in cells. One of the two axes
      // the catch is weighted on — see `_rollCatch`.
      let depth = 1;
      while (depth < FISH_DEEP && this.planet.at(wet.col, k - depth) === ID.water) depth++;
      this.fishing = {
        col: wet.col, k, pos: c,
        // What kind of water this is, decided once at the cast rather than
        // re-derived when something bites: the pond can freeze, drain or be
        // built over in the minute a line is out, and the catch should be the
        // one you threw into.
        deep: depth >= FISH_DEEP,
        // Salt if this is the SEA, and the altitude test alone was not that.
        //
        // It read "surface at or below sea level", on the stated claim that
        // lakes are carved into terrain above R_SEA. That claim is false:
        // measured over 193 lake-water columns near one shore, 33 of them -
        // 17.1% - sit at radius 281 against R_SEA 282 and were being fished as
        // ocean. Which is how a clownfish came out of a pond.
        //
        // The biome is what actually knows. An OCEAN column is sea however deep
        // it happens to be, and a BEACH column below the waterline is the sea's
        // own edge - while a pond lying in plains or forest a layer under sea
        // level is fresh water whatever its altitude says.
        salt: this.planet.colBiome[wet.col] === BIOME.OCEAN
          || (this.planet.colBiome[wet.col] === BIOME.BEACH && k < SEA_K),
        // How far the throw actually went, straight-line from the rod tip to
        // the float. Read off the arc rather than off the aim, because those
        // are different numbers the moment the shore is not flat — and it is
        // the throw the player is being rewarded for. Weights the loot roll
        // when something finally bites; see `_rollCatch`.
        dist: wrapDist(c, tip),
        // Where you were standing when you cast. The leash is measured from
        // here, not from the float — see FISH_LEASH.
        from: this.player.position.clone(),
        wait: FISH_WAIT_MIN + Math.random() * (FISH_WAIT_MAX - FISH_WAIT_MIN),
        bob: 0,
        // The hand with the rod in it, found the same way `_landCatch` finds it
        // for the wear — cast left-handed and the left arm casts. Kept on the
        // cast because the lean is turned on at the release and not here.
        hand: this._handOf(this.inventory.actingSlot(
          (s) => ITEMS[s.item]?.tool?.kind === 'rod')),
        // The throw, in flight. `t` starts negative: that is the arm's wind-up,
        // over which nothing is on screen but the rod, and it is `CAST_RELEASE`
        // long — the moment `SWINGS.rod` finishes its flick. From zero the float
        // is out and flying the arc that was integrated above, and at `dur` it
        // touches the water and the wait begins.
        //
        // The path's last point is the cell the march entered; the float belongs
        // on `c`, which is that column climbed to the surface. Overwriting the
        // last quadruple rather than appending one keeps the flight's clock
        // honest — the correction is under a cell and the arc already spent the
        // time getting there.
        cast: {
          path, t: -CAST_RELEASE, dur: path[path.length - 1] ?? 0, out: false,
        },
      };
      path[path.length - 4] = c.x;
      path[path.length - 3] = c.y;
      path[path.length - 2] = c.z;
      this.player.swing();
      this.viewModel.punch(this.fishing.hand);
      this._syncCrosshair();
      return;
    }
    // Line is out and nothing is on it yet, so this click is reeling in early.
    // A click during the fight never arrives here: the caller hands the button
    // to the bar the moment a fish is on, because grabbing the button is the
    // first thing anyone does when the bar appears.
    this.ui.toast('Too soon.', itemIdOf('fishing_rod'), 1400);
    // The line comes back with nothing on it, and that is the same event as
    // losing one, so it is the same sound.
    this.audio.lineLost(this.fishing.pos);
    this._stopFishing();
  }

  /**
   * What is on the end of the line, decided the moment it bites rather than the
   * moment it lands.
   *
   * It has to be decided early now, because the fight's difficulty *is* the
   * rarity: the roll that says "treasure" is the same roll that says "this one
   * runs". Rolling at landing time, as it used to, would mean every fish fought
   * identically and the reward was a lottery played after the skill.
   *
   * `hard` is 0..1 and is the only thing `_tickFight` reads.
   *
   * **Distance weights the roll, it does not gate it.** `dist` is how far the
   * float actually travelled — measured off the arc in `_rodClick`, not off the
   * aim — and it becomes an exponent on a uniform sample rather than a
   * threshold anywhere. Every outcome stays reachable from every cast: a lazy
   * flick into the shallows can still turn up an emerald, it is simply about
   * half as likely to as a throw across the bay. See `FISH_DIST_BIAS`.
   *
   * **Only a fish fights**, and that is decided here rather than anywhere else:
   * the returned `fight` flag is what `_beginFight` gates the balance bar on.
   * The owner: *"minigame triggered for kelp, minigame should only run on
   * fishes, there's no reason for kelp and other things to fight back"*. A stick
   * on the end of a line is a stick; a pearl struggling is nonsense. Both come
   * up the moment they are hooked, and `hard` on those rolls is 0 because there
   * is nothing left for it to describe. If a free pearl reads as too cheap, the
   * lever is the 0.93 below — make it rarer, not stroppier.
   *
   * @param {number} [dist] cells from the rod to where the float went in
   */
  _rollCatch(dist = 0, water = {}) {
    const reach = Math.min(1, Math.max(0,
      (dist - FISH_DIST_NEAR) / (FISH_DIST_FAR - FISH_DIST_NEAR)));
    const bias = FISH_DIST_BIAS * reach + (water.deep ? FISH_DEEP_BIAS : 0);
    const roll = Math.random() ** (1 / (1 + bias));
    if (roll > 0.93) {
      // What the *water* has in it, not one table for the whole planet. A pearl
      // out of a mountain tarn was the kind of thing that reads as the loot
      // table being a list rather than a place.
      // Weighted by repetition, and the pearl is the one entry that appears
      // once. It was listed TWICE in a table of four, which made the rarest
      // thing in the sea the COMMONEST thing in the treasure band: measured
      // over 20,000 casts, 6.92% of everything landed in deep salt water at
      // range was a pearl, one in every fourteen throws. A pearl you pull up
      // twice an evening is a bead.
      //
      // Ten entries rather than four so the odds can say something finer than
      // quarters, which is what forced the duplicate in the first place.
      const salt = ['pearl',
        'amethyst', 'amethyst', 'amethyst',
        'emerald', 'emerald', 'emerald',
        'coin', 'coin', 'coin'];
      const fresh = ['amethyst', 'amethyst', 'amethyst',
        'emerald', 'emerald',
        'coin', 'coin', 'coin', 'coin', 'coin'];
      const pool = water.salt ? salt : fresh;
      const name = pool[(Math.random() * pool.length) | 0];
      return {
        id: itemIdOf(name), count: name === 'coin' ? 3 + ((Math.random() * 6) | 0) : 1,
        hard: 0, fight: false,
      };
    }
    if (roll > 0.78) {
      const name = (water.salt
        ? ['kelp', 'coral_branch', 'coral_fan', 'flint']
        : ['stick', 'seeds', 'clay'])[(Math.random() * (water.salt ? 4 : 3)) | 0];
      return { id: itemIdOf(name), count: 1, hard: 0, fight: false };
    }
    // A fish, and now it is a species. `t` is where in the fish band the same
    // roll landed, and the table is sorted commonest first — so a long throw
    // into deep water reaches the rare end of it for exactly the reason it
    // reaches the treasure band above. The bias is already in `roll`; nothing
    // here rolls again.
    const t = roll / 0.78;
    const table = fishTable(!!water.salt, !!water.deep,
      FACE_ROLE[this.player.face] === FACE_TEMPEST);
    // `upTo` is cumulative and its last entry is 1, so the fallback is only
    // there for a `t` that floating point has nudged past the end.
    const pick = table.find((f) => t <= f.upTo) ?? table[table.length - 1];
    return {
      id: itemIdOf(pick.name),
      count: 1,
      // Off the species, not off the roll. How hard a fish fights is a fact
      // about the fish, and this is the fourth thing its one `rarity` decides.
      hard: fishHard(pick.rarity),
      fight: true,
    };
  }

  /**
   * Something is on. Set up the balance bar, if what is on it can pull.
   *
   * **The bar is fish-only.** Reported: *"minigame triggered for kelp, minigame
   * should only run on fishes, there's no reason for kelp and other things to
   * fight back"* — and there is not. A frond of kelp, a stick, a lump of clay, a
   * branch of coral and a pearl all used to run the full balance minigame and
   * could all be *lost*, which is a thing to lose to seaweed. They land the
   * moment they are hooked now. There is no second roll behind that: `fight` is
   * decided by the one roll in `_rollCatch`, at bite time, beside the item it
   * describes.
   *
   * The splash still happens either way — something came out of the water — and
   * it is smaller for the things that did not struggle.
   *
   * The shuttle starts under the fish and at rest, so the first quarter second
   * is contact rather than a scramble — the bar has to be readable before it is
   * hard. The fish starts mid-track and running.
   */
  _beginFight(f) {
    const c = this._rollCatch(f.dist ?? 0, f);
    f.catch = c;
    this.audio.splash(f.pos);
    this.particles.splash(f.pos, this.player.up, c.fight ? 0.7 : 0.45);
    // Hooked something that cannot pull: it is simply yours. `_landCatch` reads
    // `f.catch`, so the roll above is the roll that lands and nothing is rolled
    // twice. This ends the cast, which is why the caller re-checks `this.fishing`.
    if (!c.fight) { this._landCatch(); return; }
    const rod = ITEMS[this.inventory.actingSlot(
      (s) => ITEMS[s.item]?.tool?.kind === 'rod')?.item]?.tool ?? { tier: 0, speed: 1 };
    // The rod widens the window and the fish narrows it. Multiplied rather than
    // added so a better rod is still worth the same *proportion* against a
    // treasure fight as against a minnow — a flat subtraction would have taken
    // the whole of a tier-1 bonus off the hardest fish and left the upgrade
    // meaningless exactly where it is wanted.
    const half = (FIGHT_HALF + FIGHT_HALF_PER_TIER * (rod.tier ?? 0))
      * (1 - FIGHT_HALF_RARITY * c.hard);
    f.fight = {
      hard: c.hard,
      half,
      // Both halves of the shuttle scale with the rod, so the pull-equals-fall
      // invariant on `FIGHT_ACC` survives a rod that is quicker than a stick.
      // Scaling only the pull would hand a better rod a *worse* fall relative
      // to its climb, which is the exact asymmetry those constants exist to
      // remove.
      pull: FIGHT_ACC * (rod.speed ?? 1),
      fall: FIGHT_GRAV * (rod.speed ?? 1),
      x: 0.5, v: 0,               // the shuttle
      fx: 0.5, fv: 0, to: 0.5, t: 0, // the fish
      p: FIGHT_START,
      on: true,
      wasOn: true,
    };
    this._showFightFish(c.id);
  }

  /**
   * Put the species you actually hooked on the bar.
   *
   * The runner in the groove was a CSS lozenge with a triangle for a tail — one
   * anonymous fish for all fifteen, at the one moment the game knows exactly
   * which one is on the line. `_rollCatch` has already decided the species by
   * the time the bar goes up (it has to: the fight's difficulty *is* the
   * rarity), so the bar can simply be told.
   *
   * The picture is the item's **own inventory icon**, painted from its own
   * model by `Icons.item` — the same image the toolbar will show when it lands,
   * cached after the first paint and free every time after. Nothing new is
   * drawn for the bar, which is the point: the thing fighting you and the thing
   * you win are visibly one object.
   *
   * Written as a custom property on the bar rather than through `UI`, and
   * `document.getElementById` rather than `this.ui.el`: this is the one game
   * event the HUD has no method for, and inventing a private reach into `UI`'s
   * element table would be worse than one honest query. It belongs in
   * `UI.fishFight` as a second argument and should move there.
   *
   * Called every frame of the fight and not once at the start, because
   * `Icons.item` is synchronous over an asynchronous thing: a species whose
   * model has not been painted yet answers with its drawn sprite and paints the
   * real one a beat later. Guarded on the URL, so the frames after that are a
   * map lookup and a string compare.
   *
   * @param {number} [id] the item on the line, or nothing to clear it
   */
  _showFightFish(id) {
    const el = document.getElementById('fish-bar');
    if (!el) return;
    // `mark` and not `item`: the inventory icon is built for parchment and the
    // groove is dark timber, so the same picture comes out a smudge there. It
    // falls back to the plain icon for the moment before the model has been
    // painted twice, which is one frame of a fight that lasts seconds.
    const url = id ? (this.ui.icons?.mark(id) || this.ui.icons?.item(id)) : null;
    if (url === this._fbFishUrl) return;
    this._fbFishUrl = url;
    el.style.setProperty('--fb-img', url ? `url("${url}")` : 'none');
  }

  /**
   * One frame of the fight.
   *
   * The shuttle is a weight on a spring you do not have: holding the button is
   * the only upward force, and letting go is the only downward one, so keeping
   * it anywhere but the two ends is a continuous act. That is the whole game,
   * and it is why the bar needs no caption.
   */
  _tickFight(dt, f) {
    const g = f.fight;
    const held = !!(this.input.buttons[2] && this.input.locked);
    this._showFightFish(f.catch?.id);

    // --- the shuttle ---
    g.v += (held ? g.pull : -(g.fall ?? FIGHT_GRAV)) * dt;
    g.v -= g.v * FIGHT_DRAG * dt;
    g.x += g.v * dt;
    if (g.x < g.half) { g.x = g.half; g.v = Math.max(0, g.v); }
    if (g.x > 1 - g.half) { g.x = 1 - g.half; g.v = Math.min(0, g.v); }

    // --- the fish ---
    // A run is picked, not steered: a new destination every so often and an
    // acceleration towards it. A rare fish picks more often and pulls harder,
    // which reads as darting rather than as merely faster.
    g.t -= dt;
    if (g.t <= 0) {
      g.t = (FISH_TURN - FISH_TURN_RARITY * g.hard) * (0.55 + Math.random() * 0.9);
      g.to = Math.random();
    }
    g.fv += Math.sign(g.to - g.fx) * (FISH_RUN + FISH_RUN_RARITY * g.hard) * dt;
    g.fv -= g.fv * 3.4 * dt;
    g.fx += g.fv * dt;
    if (g.fx < 0.03) { g.fx = 0.03; g.fv = Math.abs(g.fv) * 0.4; g.to = Math.random(); }
    if (g.fx > 0.97) { g.fx = 0.97; g.fv = -Math.abs(g.fv) * 0.4; g.to = Math.random(); }

    // --- contact ---
    g.on = Math.abs(g.fx - g.x) <= g.half;
    g.p += (g.on ? FIGHT_GAIN : -FIGHT_DRAIN * (1 + 0.35 * g.hard)) * dt;
    if (g.on && !g.wasOn) this.audio.nibble(f.pos);   // regained it
    g.wasOn = g.on;

    if (g.p >= 1) { this._landCatch(); return; }
    if (g.p <= 0) {
      this.ui.toast('It got away.', itemIdOf('fishing_rod'), 1600);
      this.audio.lineLost(f.pos);
      // Losing costs the attempt and one point off the rod, the same as landing
      // one. Nothing else: the punishment for a bad fight is the minute you
      // spent on it.
      this.inventory.damageHeld(1, this.inventory.actingSlot(
        (s) => ITEMS[s.item]?.tool?.kind === 'rod'));
      this._stopFishing();
      return;
    }
    this.ui.fishFight(g);
  }

  _tickFishing(dt) {
    const f = this.fishing;
    if (!f) return;
    // Wander off and the line comes in on its own, rather than fishing a lake
    // you are no longer standing beside.
    if (wrapDist(this.player.position, f.from ?? f.pos) > FISH_LEASH) {
      this._stopFishing(); return;
    }

    // The water can leave while the line is out. Only the cast was ever checked
    // for water, which was survivable when water could not move; a starved flow
    // drains itself now, and a bucket empties a cell outright. Without this the
    // float went on bobbing over open air and the strike landed a fish out of a
    // dry hole. Worth saying out loud, unlike the leash above — walking away
    // explains itself, a pond draining behind you does not.
    if (this.planet.at(f.col, f.k) !== ID.water) {
      this.ui.toast('The water is gone.', itemIdOf('fishing_rod'), 1600);
      this._stopFishing();
      return;
    }

    // Still in the air. Nothing about the cast has begun yet: the wait does not
    // run down, nothing can bite, and the float is somewhere between the rod
    // and the water rather than on it.
    if (f.cast && !this._tickCast(f, dt)) return;

    if (f.fight) {
      this._tickFight(dt, f);
      // The fight can end the cast from inside — landed, lost, or the line came
      // in — and everything below this point wants a float that still exists.
      if (!this.fishing) return;
      this._bobFloat(f, dt);
      return;
    }
    f.wait -= dt;
    f.nibbleT = Math.max(0, (f.nibbleT ?? 0) - dt);
    if (f.wait <= 0) {
      this._beginFight(f);
      // A catch that does not fight lands inside that call and ends the cast, so
      // `f` is a dead float from here on — bobbing it would put the marker back
      // on the water after `_stopFishing` took it off.
      if (!this.fishing) return;
    } else if (Math.random() < dt * 0.7) {
      // the odd nibble, so the wait is not a blank stare
      this.particles.bubbles(f.pos, this.player.up, 1);
      // Throttled hard and separately from the particles. The bubbles are
      // welcome at 0.7 a second because they are in the corner of your eye;
      // a voice at that rate is a metronome, and the fishing wait is up to a
      // minute long. One every two-and-a-half seconds at the most is a pond
      // with something in it rather than a clock.
      if (f.nibbleT === 0) {
        f.nibbleT = 2.5 + Math.random() * 1.8;
        this.audio.nibble(f.pos);
      }
    }
    this._bobFloat(f, dt);
  }

  /**
   * The float on the water, and the line that goes to it.
   *
   * Pulled under while a fish is on: the dip is the world's half of the balance
   * bar, so a player watching the water rather than the HUD still sees the
   * fight happening.
   */
  _bobFloat(f, dt) {
    f.bob += dt;
    if (!this.bobber) return;
    // `centerOf` is the middle of the cell, and the water's surface is half a
    // cell above that — offsetting from the centre left the float sunk inside
    // the block, where it rendered as nothing at all.
    _v1.copy(f.pos).addScaledVector(this.player.up,
      BOBBER_FLOAT + Math.sin(f.bob * (f.fight ? 9 : 2.2)) * (f.fight ? 0.09 : 0.05)
      - (f.fight ? 0.2 : 0));
    this.bobber.position.copy(_v1);
    this.bobber.visible = true;
    this._updateFishLine(_v1);
  }

  /**
   * The line from the rod to the float.
   *
   * Without it the cast reads as a red ball someone left on the water: the rod
   * is in your hand, the float is ten feet out, and nothing says the two are
   * connected.
   *
   * The near end is the rod's actual tip. That was not askable when this was
   * written — the rod lives in the view model's own scene, on its own camera —
   * so it used to be a hand-measured offset off the world camera, and the owner
   * saw exactly what that is: a string starting three quarters of a unit away
   * from the end of the rod, in mid air, and starting from the wrong side of
   * the screen whenever the rod was in the left hand.
   *
   * `ViewModel.tipAnchorWorld` answers it properly now, fov correction and all
   * — the view model draws at a fixed 70 degrees and the world does not, so the
   * two only agree once that ratio is applied. It returns null when there is
   * genuinely nothing to ask (third person, or the frame or two before the
   * model lands), and only then does the old constant stand in.
   */
  _updateFishLine(bobberPos) {
    if (!this.fishLine) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this.fishLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xe8e4d8, transparent: true, opacity: 0.5,
      }));
      this.fishLine.frustumCulled = false;
      this.fishLine.renderOrder = 6;
      this.scene.add(this.fishLine);
    }
    const cam = this.camera;
    // The same hand resolution the cast used, so a left-handed cast hangs its
    // line off the left hand.
    const rodItem = this.inventory.actingSlot(
      (s) => ITEMS[s.item]?.tool?.kind === 'rod')?.item;
    if (!(rodItem && this.viewModel.tipAnchorWorld(rodItem, cam, _v2))) {
      _v2.set(0.30, -0.24, -0.55).applyQuaternion(cam.quaternion).add(cam.position);
    }
    const arr = this.fishLine.geometry.attributes.position.array;
    arr[0] = _v2.x; arr[1] = _v2.y; arr[2] = _v2.z;
    arr[3] = bobberPos.x; arr[4] = bobberPos.y; arr[5] = bobberPos.z;
    this.fishLine.geometry.attributes.position.needsUpdate = true;
    this.fishLine.visible = true;
  }

  _landCatch() {
    const f = this.fishing;
    if (!f) return;
    // Rolled when it bit, because the fight you just won was that roll's own
    // difficulty. `_rollCatch` here is the fallback for a landing that somehow
    // never fought.
    const { id, count } = f.catch ?? this._rollCatch(f.dist ?? 0, f);
    const taken = this.inventory.add(id, count);
    if (taken < count) {
      _v1.copy(this.player.position).addScaledVector(this.player.up, 0.8);
      this.drops.spawn(_v1.x, _v1.y, _v1.z, id, count - taken);
    }
    this.ui.toast(`Caught ${ITEMS[id]?.label}`, id, 2000);
    this.audio.pickup();
    this.stats.fished = (this.stats.fished ?? 0) + 1;
    // No xp. A fish used to pay 8, which is a coal seam for standing still, and
    // the rod is now paid in food and in the fish itself. Kills only.
    // The rod that was cast is the rod that wears, wherever it is being held.
    // `active()` would have charged the catch to a pickaxe in the main hand
    // while the left hand did the fishing.
    this.inventory.damageHeld(1, this.inventory.actingSlot(
      (s) => ITEMS[s.item]?.tool?.kind === 'rod'));
    this._stopFishing();
  }

  /**
   * The float on the water, which is the float on the rod.
   *
   * Reported: *"make the bobber match the one in rod model"*. It was a red
   * sphere, and the rod in the same fist carries a modelled two-tone bobber —
   * the part the item's whole silhouette is built around. So the geometry is cut
   * out of the rod (see `bobberGeometry`) rather than approximated, and the
   * thing you throw is the thing you were holding.
   *
   * The sphere stays as the stand-in, for exactly the frame or two before the
   * rod's model lands and for good if `public/models/` is missing — the same
   * bargain every other model in the game makes with its sprite art. When the
   * real one arrives the mesh is swapped underneath, because a cast in flight
   * must not blink.
   *
   * `MeshBasicMaterial` and not a lit one, as before: this is a marker as much
   * as an object, it is often thirty cells away over water that is already
   * bright, and the pale-over-red banding is the read. Lighting it would make it
   * a dark speck at dusk, which is when people fish.
   */
  _showBobber(pos) {
    if (!this.bobber) {
      this.bobber = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xd94f3d }));
      this.bobber.renderOrder = 6;
      this.scene.add(this.bobber);
    }
    // Asked once and not once a frame: this runs every frame of every flight,
    // and an unresolved model would otherwise hang a fresh `.then` off the same
    // load ten times a second for as long as the line is out.
    if (!this.bobberModelled && !this._bobberAsked) {
      this._bobberAsked = true;
      const take = (geo) => {
        // Once. `worldModel` either answers now or calls back later and never
        // both, but the geometry being disposed here is the shared one — a
        // second pass through would throw the float away for good.
        if (this.bobberModelled) return;
        this.bobberModelled = true;
        this.bobber.geometry.dispose();
        this.bobber.geometry = geo;
        this.bobber.material = new THREE.MeshBasicMaterial({ vertexColors: true });
        // `bobberGeometry` normalises the float to one unit on its longest axis,
        // so this is the float's size in cells and the only place it is stated.
        // 0.22 against the sphere's 0.18 diameter: the banding needs the extra
        // to read at all, and it is still under a quarter of a block.
        this.bobber.scale.setScalar(0.22);
      };
      const geo = bobberGeometry(itemIdOf('fishing_rod'), take);
      if (geo) take(geo);
    }
    // Stand it up. The extracted float is authored pale over red about a
    // waterline, which is the whole of why it reads as a bobber and not as a
    // berry — and it only reads that way if its own +Y is the local up. Left
    // unrotated it inherits the world axes, and on a planet that is a different
    // direction at every lake: the first frame of this showed the waterline
    // running corner to corner.
    this.bobber.quaternion.setFromUnitVectors(_bobY, this.player.up);
    _v1.copy(pos).addScaledVector(this.player.up, BOBBER_FLOAT);
    this.bobber.position.copy(_v1);
    this.bobber.visible = true;
  }

  /**
   * One frame of the throw, from the click to the splash.
   *
   * The owner's report was that the cast was *"just straight throw and sudden
   * cast"*, and it was two separate faults wearing one sentence. The arm did not
   * move (`SWINGS.rod` is the other half of the fix) and the float did not
   * travel: `_castArc` integrated the whole flight and returned only the cell it
   * ended in, so the marker appeared on the water on the frame of the click,
   * thirty cells away, having crossed the gap in no time at all.
   *
   * So the arc is flown. `f.cast.path` is that same integration written down —
   * the shape and its clock — and the float is read out of it by time, which
   * means what you watch is by construction the curve that decided where the
   * line went in. Interpolated between marched steps rather than snapped to
   * them: the march is by length (`FISH_CAST_STEP`), so its steps are 20ms apart
   * at the top of a lob and 5ms apart near the water, and snapping would stutter
   * exactly where the arc is prettiest.
   *
   * Three phases, and the negative clock is the first of them:
   *
   *   t < 0        the wind-up. `CAST_RELEASE` long, nothing on screen but the
   *                rod coming back. No float, no line — the line especially,
   *                because a string running to a bobber that has not left yet is
   *                the teleport this exists to remove.
   *   0 <= t < dur in the air. The lean goes on at t = 0, so the rod settles into
   *                holding a line at the moment there is one to hold.
   *   t >= dur     the water. Splash, sound, `cast` deleted, and the wait starts
   *                from here rather than from the click — the flight is not part
   *                of the four-to-thirteen seconds you are being asked to wait.
   *
   * @returns {boolean} true once the float is on the water and the rest of the
   *   cast may run
   */
  _tickCast(f, dt) {
    const c = f.cast;
    const was = c.t;
    c.t += dt;
    if (c.t < 0) {
      // Between the click and the flick. `_stopFishing` is what normally hides
      // these, and it has not run: this is a cast that exists but has not left.
      if (this.bobber) this.bobber.visible = false;
      if (this.fishLine) this.fishLine.visible = false;
      return false;
    }
    if (was < 0) {
      // The rod leans out over the water for as long as the line is in it, and
      // the sight goes away for the same span. Both are "there is a cast out",
      // said once here and undone once in `_stopFishing`.
      this.viewModel.setCast(true, f.hand);
      this._syncCrosshair();
    }
    if (c.t < c.dur) {
      const p = c.path;
      // Walk forward from where the last frame left off. The path is monotone in
      // time and this runs every frame of a flight, so the scan is a step or two
      // rather than a search.
      let i = c.i ?? 0;
      while (i + 7 < p.length && p[i + 7] < c.t) i += 4;
      c.i = i;
      const t0 = p[i + 3], t1 = p[i + 7];
      const u = t1 > t0 ? Math.min(1, Math.max(0, (c.t - t0) / (t1 - t0))) : 0;
      _v1.set(
        p[i] + (p[i + 4] - p[i]) * u,
        p[i + 1] + (p[i + 5] - p[i + 1]) * u,
        p[i + 2] + (p[i + 6] - p[i + 2]) * u,
      );
      this._showBobber(_v1);
      // `_showBobber` floats it half a cell up, which is right for something
      // resting on water and wrong for something in the air.
      this.bobber.position.copy(_v1);
      this._updateFishLine(_v1);
      return false;
    }
    f.cast = null;
    this._showBobber(f.pos);
    this.audio.splash(f.pos);
    this.particles.splash(f.pos, this.player.up, 0.35);
    return true;
  }

  _stopFishing() {
    this.fishing = null;
    this._showFightFish(null);
    if (this.bobber) this.bobber.visible = false;
    if (this.fishLine) this.fishLine.visible = false;
    this.ui.fishFight(null);
    this.viewModel.setCast(false);
    this._syncCrosshair();
    this.ui.setHint('');
  }

  /**
   * Fill an empty bucket from a spring, or pour a full one into the open cell
   * in front of whatever was hit.
   *
   * The docstring that used to sit here — detached from this function, above
   * `_rodClick` — said water was a static block and the world had no flow
   * simulation. That stopped being true when `Water.js` arrived, and it was the
   * reasoning behind letting any water cell fill a bucket, which is the bug
   * fixed below.
   *
   * **Both liquids, one branch.** The lava bucket is not a second copy of this
   * method and must not become one: the source rule below is the only thing
   * standing between a bucket and an unlimited supply of a liquid that never
   * drains, and a second copy of it is a second chance to get it wrong. Which
   * liquid is in hand is read off `carries` on the item def; everything else
   * here — the source test, the spring on pour, the empty-cell target — is
   * shared verbatim, and `Water` already keys `sources` by cell rather than by
   * liquid, so a lava source and a lake source are the same kind of thing to it.
   *
   * @returns {boolean} true if the bucket did something
   */
  _useBucket(heldSlot) {
    const empty = heldSlot.item === itemIdOf('bucket');
    // Which liquid a full pail holds, and which one an empty pail is allowed to
    // take. `carries` names it; the two ids are the only liquids in the game.
    const CARRIED = { water: ID.water, lava: ID.lava };
    const FILLED = { water: 'water_bucket', lava: 'lava_bucket' };
    // A ray that stops on liquid, which the normal interaction ray does not.
    const wet = this.planet.raycast(
      this.player.eye, this.player.lookDir, this.player.reach,
      { hitLiquid: true },
    );

    if (empty) {
      if (!wet) return false;
      const kind = wet.id === ID.water ? 'water' : wet.id === ID.lava ? 'lava' : null;
      if (!kind) return false;
      const key = this.water.key(wet.col, wet.k);
      // Only a spring fills a bucket. Flowing water shares the block id with
      // standing water — the difference is the level, not the block — so this
      // used to accept the far end of a trickle and hand back a full bucket.
      // Since pouring makes a permanent spring, that turned one bucket into
      // unlimited springs: pour, let it run six cells, scoop the trickle, and
      // you are up one source with the original still running. Water that never
      // drains and can be multiplied is a planet under water.
      //
      // Lava is the same rule and it matters more, not less: a lava spring
      // nobody poured is a fire with no end, and it can be minted next to
      // anything you would rather not set alight. One test, both liquids.
      if (!this.water.sources.has(key)) {
        return false;
      }
      this._applyEdits([{ col: wet.col, k: wet.k, id: 0 }]);
      this.water.sources.delete(key);
      // Belt and braces: a source has no level entry, so this normally does
      // nothing. It matters if one is ever left behind, because a stale level
      // on a dry cell reads as flowing water to everything that asks.
      this.water.level.delete(key);
      this.water.onEdit(wet.col, wet.k);
      this._swapInHand(heldSlot, itemIdOf(FILLED[kind]));
      // `kind` is the thing being scooped, and it is not always water. A splash
      // is a bright slap and a run of RISING bubbles, which is what an ear uses
      // to tell water from anything else, so a pail of lava sounded like a pail
      // of pond — on the one liquid where the sound is the warning.
      if (kind === 'lava') this.audio.lavaDip(); else this.audio.splash();
      this.player.swing();
      this.viewModel.punch(this._handOf(heldSlot));
      return true;
    }

    // Pouring: take the empty cell the ray entered through, so water lands in
    // front of a wall rather than replacing it.
    const pouring = CARRIED[ITEMS[heldSlot.item]?.carries];
    if (pouring === undefined) return false;
    const target = wet && wet.prevCol >= 0 ? { col: wet.prevCol, k: wet.prevK } : null;
    if (!target) return false;
    // Air, or something the liquid would destroy anyway. It used to be air
    // alone, and the mismatch was visible in a single tuft of grass: the flow
    // sim washes every non-submerged cross plant and every torch out of its way
    // (`Water._washes`, the same `DROWNS` flag), so a stream ran straight
    // through a daisy while the bucket that started the stream refused to be
    // emptied onto one. Pouring is not gentler than flowing. Nothing is
    // dropped, for the same reason washing drops nothing.
    const standing = this.planet.at(target.col, target.k);
    if (standing !== 0 && !DROWNS[standing]) return false;
    // Pouring at your own feet is allowed on purpose. It's what you'd expect,
    // it's how you break a fall or make a climb, and it can't strand you: the
    // source is a single static cell you can scoop straight back up.
    //
    // That last clause is the whole safety argument for the lava pail too, and
    // it survives: a poured lava source is one cell, it is marked a spring the
    // same way, and the same empty bucket picks it straight back up. What it
    // does in the meantime is the player's problem, which is the point of it.
    this._applyEdits([{ col: target.col, k: target.k, id: pouring }]);
    // Poured water is a spring, not a puddle: it feeds a flow and never drains.
    this.water.addSource(target.col, target.k);
    this._swapInHand(heldSlot, itemIdOf('bucket'));
    // Same rule pouring as scooping: `pouring` is the block going in the ground.
    if (pouring === ID.lava) this.audio.lavaDip(); else this.audio.splash();
    this.player.swing();
    this.viewModel.punch(this._handOf(heldSlot));
    return true;
  }

  /**
   * Spend one from `slot` and hand back `itemId` — into the same hand if that
   * hand is now free, into the bags if it is not.
   *
   * The bucket, both ways round. It used to be `consumeHeld` followed by a bare
   * `add`, and `add` only ever walks `slots`: scoop a spring with the pail in
   * your left hand and the full bucket appeared in your *hotbar*, leaving the
   * offhand empty. Doing it twice left you holding nothing and hunting through
   * the bag for two pails. Minecraft puts the swapped item back where it came
   * from, and the reason is the one that matters here — you are mid-job, the
   * next click is the pour, and the thing you need has to still be in the hand
   * you are clicking with.
   *
   * The fallback is not dead code: a stack of buckets in the offhand spends one
   * and leaves the rest, so the hand is not free and the filled one has to go
   * somewhere. `add` returning short is the last case, and it drops on the floor
   * rather than evaporating.
   */
  _swapInHand(slot, itemId) {
    const wear = slot.wear;
    this.inventory.consumeHeld(1, slot);
    if (slot.empty) slot.set(itemId, 1, ITEMS[itemId]?.tool ? wear : 0);
    else if (this.inventory.add(itemId, 1) < 1) {
      _v1.copy(this.player.eye).addScaledVector(this.player.lookDir, 0.6);
      this.drops.spawn(_v1.x, _v1.y, _v1.z, itemId, 1);
    }
    this.inventory.changed();
  }

  /**
   * How exposed to the sky the player is, 0 (fully covered) to 1 (open air).
   * Counts solid cells in the player's own column above their head; a couple of
   * blocks of leaf canopy should still let some rain through, a rock ceiling
   * should not.
   */
  _skyExposure() {
    const c = this.player.cell;
    const col = colIndex(c.x, c.y);
    let blocked = 0;
    for (let k = c.k + 2; k < D; k++) {
      if (this.planet.solidAt(col, k)) { blocked++; if (blocked >= 3) return 0; }
    }
    return 1 - blocked / 3;
  }

  _updateSharedUniforms() {
    const p = this.sky.palette;
    const w = this.weather;
    // Everything below that is night-only is weighted by `night` *squared*, and
    // that is the whole guarantee that this is a night pass and not a re-grade
    // of the game. `night` is already zero for any sun more than about 6°
    // above the horizon, so squaring it costs nothing at the deep end — it is
    // exactly 1 at midnight — while pushing the shoulder out far enough that
    // the last of daylight is untouched. Measured across the sky curve: with
    // the sun 11° up every channel of every surface is bit-identical to what
    // it was, at 3° the change is under 1%, and it only reaches a fifth once
    // the sun is genuinely below the horizon.
    const night = this.sky.night ?? 0;
    const n2 = night * night;
    voxelUniforms.uSkyColor.value.copy(p.zenith).lerp(p.horizon, 0.55).lerp(WHITE, 0.34)
      .lerp(MOON_FILL, n2);
    // The trailing weather term has been challenged and it stands. **Do not
    // invert it**, and this is written down here because the argument for
    // inverting it is a good one and will be made again.
    //
    // The argument: a cloud deck is a large diffuse source, so as the direct
    // beam dies the *skylight* should rise, not fall; scaling it down means a
    // cloudy day is dimmed twice rather than dimmed and flattened.
    //
    // The first half is true and is already what happens. This term scales
    // *absolute* skylight, not skylight's share of the total, and the share
    // rises on its own because the sun falls faster: sky fill against direct is
    // 0.82 / 1.51 clear, 0.58 / 0.58 overcast, 0.49 / 0.24 in a storm — 35%,
    // 50%, 67%. The thing the report asked for is in the numbers already.
    //
    // The second half does not survive being rendered. Emulated in one run at
    // one site by multiplying this by (1 - 0.5·sun) / (0.5 + 0.5·sun):
    //
    //   grass, clear noon    81.2  ->  70.7   (a 13% regression on a clear day,
    //                                          because 0.5+0.5·0.94 is 0.97 and
    //                                          1-0.5·0.94 is 0.53)
    //   grass, storm noon    40.1  ->  57.0   (storm ground goes from -51% of a
    //                                          clear day to -30%, undoing most
    //                                          of the shipped weather ladder)
    //   shaded stone, storm  77.9  -> 102.8   (against 104.8 for the same face
    //                                          on a CLEAR day: a storm and a
    //                                          clear noon light a rock face
    //                                          identically)
    //
    // A renormalised variant (1.5 - 0.5·sun, so clear stays exactly 1) fixes
    // the first line and makes the other two worse, because the whole of the
    // change then lands on bad weather. Overcast at 0.36 and storm at 0.15 in
    // Weather.js were solved against this expression; they are freshly measured
    // and they are correct as they stand.
    voxelUniforms.uSkyIntensity.value =
      (0.34 - SKY_NIGHT_DROP * n2 + p.sunIntensity * 0.72) * (0.5 + w.sun * 0.5);
    // How deep the night is, raw. The scotopic drain and the hemisphere shaping
    // both read it and each applies its own strength, so there is one curve for
    // "it is night" and no second opinion about it. `night²` is what makes the
    // day untouched by construction rather than by tuning.
    voxelUniforms.uNight.value = n2;
    voxelUniforms.uBounceColor.value.copy(p.fog).lerp(WHITE, 0.2).multiplyScalar(0.7);
    voxelUniforms.uSunDir.value.copy(this.sky.sunDir);
    voxelUniforms.uSunColor.value.copy(p.sun).multiplyScalar(w.sun);
    // Reflection sky: the palette's own hue, untouched by the whitening that
    // makes uSkyColor usable as ambient fill. Overcast drags it toward the fog
    // colour, so a grey day gives a grey sea.
    //
    // With a floor under it after dark. The palette's night zenith is 0x03050f
    // and the fresnel term replaces up to 88% of a grazing water fragment with
    // it, so a lake seen across its length was very nearly pure black — a hole
    // cut in the terrain rather than a surface. This lifts it to a dim blue
    // that reads as water and stays far below the same lake at noon (which
    // measures around (0, 67, 127) on screen against roughly (0, 0, 30) here).
    // It is a *reflection*, not an emissive: water under a roof reflects the
    // cave ceiling and this never reaches it, because the fresnel mix is
    // multiplied by nothing that a cave changes — which is a genuine limitation
    // and the reason the lift is small enough to pass for scattered moonlight
    // if you do see it underground.
    voxelUniforms.uSkyReflect.value.copy(p.zenith).lerp(p.horizon, 0.5)
      .lerp(p.fog, 1 - w.sun)
      .lerp(MOON_REFLECT, n2);
    voxelUniforms.uFogColor.value.copy(p.fog);
    // Weather, then the ground you are standing on. See FACE_PHYSICS.fog: the
    // cap is a whiteout because a snowfield is one, and the cinderlands are
    // hazy with heat without being blinding.
    const faceFog = (FACE_PHYSICS[FACE_ROLE[this.player.face]] || FACE_PHYSICS[0]).fog;
    voxelUniforms.uFogDensity.value = this.player.headInWater
      ? 0 : 0.0013 * Math.min(1.9, w.fog) * faceFog;
    voxelUniforms.uCamPos.value.copy(this.camera.position);
    voxelUniforms.uUnderwater.value = this.player.headInWater ? 1 : 0;
    if (this.player.headInWater) {
      // tie the murk to the sky so night dives are properly dark
      const lit = 0.25 + p.sunIntensity * 0.5;
      voxelUniforms.uWaterFog.value.setRGB(0.03 * lit, 0.17 * lit, 0.26 * lit);
      voxelUniforms.uWaterTint.value.setRGB(0.30 * lit, 0.66 * lit, 0.72 * lit);
      // The same murk, for everything the voxel shader never sees. See the note
      // where scene.fog is created.
      //
      // The shader scales the in-scatter by the fragment's own vSun; a scene fog
      // gets one colour for the whole frame, so it uses the player's depth
      // instead, worked out the same way the light field does it — water is
      // SKY_ATTEN 1 per cell out of MAX_LIGHT 15, so fifteen cells of water is
      // where daylight runs out. That puts a fish beside you in the same murk
      // you are standing in, which is the case that matters; a fish at a very
      // different depth from the camera is wrong by the difference, and there is
      // no second colour to give it.
      const depth = Math.max(0, SEA_K - this.player.position.y);
      const murkLit = 0.16 + 0.84 * Math.max(0, 1 - depth / 15);
      this.scene.fog.color.copy(voxelUniforms.uWaterFog.value).multiplyScalar(murkLit);
      // Fitted to the shader's green channel at 22 cells: 1 - exp(-0.052·22) is
      // 0.681, and 1 - exp(-(22·d)²) matches it at d = 0.0486. Green because it
      // is the middle of the three and the one the eye reads brightness from.
      this.scene.fog.density = 0.0486;
    } else {
      // Exactly zero, so exp(0) leaves an air frame bit-identical. The fog stays
      // attached; see scene.fog's own note for why it is not detached here.
      this.scene.fog.density = 0;
    }
    voxelUniforms.uWind.value = w.wind;
    // Item drops with no 3D art fall out of the world as two crossed cards
    // wearing an inventory icon, and those cards are MeshBasicMaterial — they
    // ignore every light in the scene and draw their texture at full brightness
    // always. That was already wrong at midnight and this pass would have made
    // it glaring, because everything around them is now darker: a dropped
    // feather would have been the brightest thing in a moonlit field. There is
    // no light to dim, so the albedo is dimmed instead. Squared night again, so
    // by day the multiplier is exactly one and the card is untouched.
    this.drops.setSkyLevel(1 - 0.84 * n2);

    this.sky.cloudUniforms.uCoverage.value = w.coverage;
    this.sky.cloudUniforms.uOpacity.value = w.opacity;
    this.sky.sunLight.intensity = p.sunIntensity * w.sun;
    if (w.lightning > 0.5) this.sky.sunLight.intensity += 2.4 * w.lightning;
  }

  _updateAudio(biomeId) {
    // Listener rides the camera. `player.up` is +Y everywhere now, and is read
    // through the body rather than written out so there is one up in the file.
    const cam = this.camera;
    cam.getWorldDirection(_v1);
    _v2.copy(this.player.up);
    this.audio.setListener(
      cam.position.x, cam.position.y, cam.position.z,
      _v1.x, _v1.y, _v1.z,
      _v2.x, _v2.y, _v2.z,
    );

    const alt = this.player.position.y - SEA_K;
    // How high and exposed you are, which is what the wind answers to. This is
    // NOT openness: it used to be both, and `cave: 1 - alt/8` meant that
    // standing in open daylight two metres above sea level armed the
    // underground rumble at 0.75 (measured) and choked the birds, the surf and
    // every insect to a quarter through Ambience's shared `out` term. Every
    // beach and every lakeside on the planet sounded like a cave.
    const high = THREE.MathUtils.clamp(alt / 8, 0, 1);
    // `shelter` is this frame's sky exposure, already computed for the rain
    // particles: three solid blocks overhead and it is zero. That is what being
    // underground actually is.
    const roof = 1 - this.shelter;

    if (this._fallNear) {
      this._fallSrc.x = this._fallAt.x; this._fallSrc.y = this._fallAt.y;
      this._fallSrc.z = this._fallAt.z; this._fallSrc.size = this._fallSize;
    }
    if (this._springNear) {
      this._springSrc.x = this._springAt.x; this._springSrc.y = this._springAt.y;
      this._springSrc.z = this._springAt.z;
    }
    // `_handLight` is the producer and it runs earlier in the same frame, so
    // these are this frame's answer. It caches behind the cell the player is in
    // and `editSeq`, which is also exactly when the answer can change.
    if (this._fireNear) {
      this._fireSrc.x = this._fireAt.x; this._fireSrc.y = this._fireAt.y;
      this._fireSrc.z = this._fireAt.z;
    }
    if (this._lavaNear) {
      this._lavaSrc.x = this._lavaAt.x; this._lavaSrc.y = this._lavaAt.y;
      this._lavaSrc.z = this._lavaAt.z;
    }

    this.audio.setAmbience({
      wind: (0.3 + high * 0.7) * (0.6 + this.weather.wind * 0.5),
      water: this._nearLiquid() * 0.6 + this.weather.precip * 0.8,
      cave: roof,
      openness: this.shelter,
      underwater: this.player.headInWater ? 1 : 0,
      // None of the rest was ever passed, so most of Ambience was dead code.
      // Measured before this line existed: `_state.rain` stayed 0 through a
      // downpour at precip 0.9, so BOTH rain beds had never once sounded;
      // `_state.time` stayed pinned at 0.35, so crickets and owls had never
      // played and birds sang at midnight; `_state.biome` stayed 2, so eleven
      // of the twelve rows of BIOME_AIR were unreachable.
      biome: biomeId,
      time: this.timeOfDay(),
      rain: this.weather.precip,
      depth: Math.max(0, -alt),
      fall: this._fallNear ? this._fallSrc : null,
      spring: this._springNear ? this._springSrc : null,
      fire: this._fireNear ? this._fireSrc : null,
      lava: this._lavaNear ? this._lavaSrc : null,
    });
  }

  _nearLiquid() {
    const c = this.player.cell;
    const col = colIndex(c.x, c.y);
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      for (let dk = -1; dk <= 1; dk++) if (this.planet.liquidAt(nb, c.k + dk)) n++;
    }
    return Math.min(1, n / 6);
  }

  _updateHud() {
    this.ui.updateVitals(this.player.health, this.player.maxHealth, this.breath, this.player.stamina, this.energy);
    const face = this.player.face;
    // Where you have been, for the Nine Lands mark. Grounded only: falling past
    // a face on the way down is not having been there.
    if (this.player.grounded) this.achievements.stoodOn(face);
    this.ui.updateStatus(this.timeOfDay(), FACE_NAME[face],
      FACE_ROLE[face] !== FACE_PYRE, this.player.cell);
    // Both read the planet's own tables and the player's tangent frame, and
    // neither writes anything back — so they go here with the rest of the
    // readouts rather than into the simulation above.
    this.ui.updateCompass(this.player);
    this.ui.updateMinimap(this.planet, this.player);

    if (this.ui.debugOn) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const info = this.renderer.info;
      const c = this.player.cell;
      this.ui.setDebug(
        `${(1 / avg).toFixed(0)} fps   ${(avg * 1000).toFixed(1)} ms\n` +
        `face ${this.player.face}  x ${c.x}  y ${c.y}  k ${c.k}\n` +
        `alt  ${(this.player.position.y - SEA_K).toFixed(1)}\n` +
        `draw ${info.render.calls}   tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
        `chunks ${this.planet.meshes.size}   drops ${this.drops.list.length}\n` +
        `sun ${this.sky.elevation?.toFixed(2)}   ${this.weather.state} ${(this.weather.precip * 100) | 0}%\n` +
        `grnd ${this.player.grounded ? 'y' : 'n'}  water ${this.player.inWater ? 'y' : 'n'}  ${(this.playtime / 60) | 0}m`,
      );
    }
  }
}

window.game = new Game();
