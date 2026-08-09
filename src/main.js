// Mojazer — a voxel tiny planet.

import * as THREE from 'three';
import { Planet } from './world/Planet.js';
import {
  Player, VIEW_FIRST, VIEW_COUNT, stepZoom, lookScaleFor,
} from './player/Player.js';
import { ViewModel } from './player/ViewModel.js';
import {
  PlayerCharacter, playerModelUrls, characterUrl, DEFAULT_CHARACTER,
} from './player/Character.js';
import { Input } from './player/Input.js';
import { Sky, MOON_FILL } from './render/Sky.js';
import { PostFX } from './render/PostFX.js';
import { Particles } from './render/Particles.js';
import { BlockModels, CAP as BLOCK_MODEL_CAP } from './render/BlockModels.js';
import {
  createVoxelMaterials, buildTileTextures, buildCrackTexture, voxelUniforms,
  occupancyTexture, occupancyData, OCC_NI, OCC_NJ, OCC_NK, OCC_ANG,
} from './render/VoxelMaterial.js';
import { loadTileAtlas } from './render/TileAtlas.js';
import { Audio } from './audio/Audio.js';
import { UI } from './ui/UI.js';
import { IconFactory } from './ui/Icons.js';
import { Inventory, Slot, HOTBAR } from './game/Inventory.js';
import { Drops } from './game/Drops.js';
import { Weather } from './game/Weather.js';
import { Seasons } from './game/Seasons.js';
import { Mobs, MOB_MODEL_URLS } from './game/Mobs.js';
import * as MobModels from './game/MobModels.js';
import { Farming } from './game/Farming.js';
import { Water } from './game/Water.js';
import { Save } from './game/Save.js';
import {
  ITEMS, computeDrops, miningTime, itemIdOf, harvestHint, armourPoints,
  bowShot, bowDrawStep,
} from './game/Items.js';
import { Arrows } from './game/Arrows.js';
import { Skills, MARKS } from './game/Skills.js';
import { smeltingFor, FUEL } from './game/Recipes.js';
import {
  BLOCKS, ID, IS_SOLID, IS_OPAQUE, RENDER_TYPE, R_LIQUID, R_CROSS, IS_TORCH, DROWNS, IS_DIRECTIONAL, IS_AXIS, IS_SLAB,
  IS_STAIR, IS_LADDER, IS_DOOR, IS_SIGN, FACING_DEFAULT, NEEDS_ROOM, crowds,
  NEEDS_FLOOR, supports, IS_SUBMERGED,
} from './world/Blocks.js';
import {
  F, D, R_MIN, R_MAX, R_SEA, R_TERRAIN_MAX, COLUMNS, cidx, vidx,
  FACES, CT, CK, CHUNK_T, CHUNK_K, NUM_CHUNKS, chunkIdx,
  CHUNK_LOAD_DIST, CHUNK_KEEP_DIST,
  NUM_REGIONS, REGION_COLS, REGION_VOXELS, GEN_VERSION, regionColumns,
} from './world/Constants.js';
import {
  colParts, cornerPos, colNeighbor, tangentFrame, stepColumn, cellCenterPos,
  patchColumn, FACE_N, FACE_R, FACE_U,
} from './world/Sphere.js';
import { CROSS_LIGHT_ADDR_SHIFT } from './world/Mesher.js';
import { makeRng } from './util/Noise.js';

/**
 * World-space centre of every chunk, built once. The streamer runs a distance
 * test against all 30 276 of them a few times a second; recomputing the centres
 * each time would cost more than the test.
 */
const CHUNK_CENTER = (() => {
  const out = new Float32Array(NUM_CHUNKS * 3);
  const p = [0, 0, 0];
  for (let f = 0; f < FACES; f++) {
    for (let ci = 0; ci < CT; ci++) {
      for (let cj = 0; cj < CT; cj++) {
        for (let ck = 0; ck < CK; ck++) {
          cellCenterPos(f, ci * CHUNK_T + CHUNK_T / 2, cj * CHUNK_T + CHUNK_T / 2,
            ck * CHUNK_K + CHUNK_K / 2, p);
          const o = chunkIdx(f, ci, cj, ck) * 3;
          out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2];
        }
      }
    }
  }
  return out;
})();

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
// Owned by the drop-burn callback alone: it fires from inside Drops.update,
// where the shared scratch vectors above may be mid-use by the caller.
const _burnUp = new THREE.Vector3();

/** Three rows of nine, so a crate is worth the eight planks it costs. */
const CRATE_SLOTS = 27;

/** Seconds for a swing to come back up to full weight. */
const ATTACK_PERIOD = 0.62;

/**
 * What a critical hit is worth. Minecraft's number, and it survives this game's
 * ladder for the reasons below.
 *
 * The swords run 4.5 wood / 6 stone / 7.5 iron / 9 astral, and a bow at full
 * draw does 8.5. A crit lifts those to 6.75 / 9 / 11.25 / 13.5, so an iron
 * sword landed on the way down beats a perfect shot by a third and an astral
 * one by a bit under two thirds — which sounds like it buries the bow until you
 * count in time rather than in blows. A full-weight swing needs the whole
 * ATTACK_PERIOD back, and a crit needs it to come back *inside* the falling
 * half of a jump, which is 0.32s of a 0.65s hop at GRAVITY 26 and a jump of
 * 8.4. Perfect jump-crit rhythm is therefore about one 13.5 per 0.65s, against
 * one 9 per 0.62s for standing and swinging: ~21 dps against ~14.5, a 40%
 * reward for timing, at three cells of reach, inside the swing of whatever you
 * are hitting. The bow's 8.5 is bought at 1.0s of draw from anywhere on the
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
 * supposed to reward stops existing. At the apex of a jump `vel.k` passes
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
 * @param {object} p the player — reads `grounded`, `inWater`, `onLadder`, `vel.k`
 * @param {number} charge 0..1 swing weight, as `_interact` computes it
 */
export function critMultiplier(p, charge) {
  if (!p || !p.vel) return 1;
  if (p.grounded || p.inWater || p.onLadder) return 1;
  // Written as a positive test so that a NaN velocity — which no code path
  // should produce, but a physics bug might — fails closed to "no crit".
  if (!(p.vel.k <= CRIT_FALL_SPEED)) return 1;
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
/** How long the fish is on before it shakes the hook. Generous but not free. */
const FISH_BITE_WINDOW = 1.1;
/** Walk this far from your own float and the line comes in. */
const FISH_LEASH = 9;
/** Height of the float above a water cell's centre — half a cell, plus a little. */
const BOBBER_FLOAT = 0.56;


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
const _frame = { ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1 };
/** Scratch for `_crossLightAt`, which runs once per modelled instance per frame. */
const _clParts = { f: 0, i: 0, j: 0 };
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
const _occCell = { f: 0, ci: 0, cj: 0, ck: 0, r: 0 };
const _occLocal = new THREE.Vector3();

/**
 * How long a new planet keeps the husks off, in seconds.
 *
 * Long enough to cut some wood, find your feet and light a spot; short enough
 * that the first night is still a night. Only new worlds get it — see
 * _beginGrace.
 */
const NEW_WORLD_GRACE = 180;

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
/** Seconds of immunity after a guarded hit, so a crowd cannot burst you down. */
const HURT_IMMUNITY = 0.5;
/** How often a body pressed against a hurting block is charged. See _tickContact. */
const CONTACT_PERIOD = 0.5;

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
  // Uprights: a little under a cell, so a reef has air above it and does not
  // read as a hedge.
  coral_branch: 0.82, coral_dead: 0.78, coral_fan: 0.86, sea_sponge: 0.80,
  // Squat. These measure wide, so they are given less height to be scaled by.
  coral_brain: 0.52, sea_shell: 0.42, sea_grass: 0.46,
  // The stacking tile. Exactly one cell — see above.
  kelp: 1.0,
};
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
  minimap: true, compass: true,
  // Minutes for one full day and night, or 0 to follow the device clock.
  //
  // 0 is the default: the planet keeps your hours, so its evening is your
  // evening. The cost is real and worth stating — a cycle is then 24 real hours
  // long, so a player who only ever plays at noon never meets a husk, never
  // needs a torch, and sees none of the night. The slider is still there for
  // anyone who would rather have a short game cycle.
  dayMinutes: 0,
  // Which camera V last left you in.
  //
  // A setting rather than part of the save, because it is a preference about
  // how you like to look at the game and not a fact about a planet: a player
  // who plays in third person wants third person in the next world too, and
  // storing it per world would ask them to press V again on every New Game.
  view: VIEW_FIRST,
};

class Game {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS, ...(Save.settings() || {}) };
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
    /** Sign text, keyed like the kilns and crates. */
    this.signs = new Map();
    /**
     * Cells winter turned to ice, keyed like the rest.
     *
     * This has to be remembered rather than worked out. Ice is a block a player
     * can craft, carry and build with, and worldgen never places any — so
     * "thaw every ice block in spring" would quietly demolish somebody's ice
     * house on the first warm day. Only what winter froze is winter's to melt.
     */
    this.frozen = new Set();
    /** Placed hearths, keyed like the rest. See _refreshWards. */
    this.hearths = new Set();
    /** Has the planet already given up its one hearth? */
    this.coreFound = false;
    /** Burning cells near the player, refilled by the hand-light scan. */
    this._flameCells = [];
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
    this.seed = 0;
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
    this.particles = new Particles(this.scene, this.planet);
    this.blockModels = new BlockModels(this.scene);
    this.drops = new Drops(this.scene, this.planet, this.materials);
    // Arrows in flight. Built here, between the drops and the animals, because
    // it needs the planet for its collision and nothing else: the mob list is
    // handed to `update` per frame rather than held, so the projectiles cannot
    // outlive a world reset holding a reference to a dead herd.
    this.arrows = new Arrows(this.scene, this.planet, itemIdOf('arrow'));
    this.arrows.onHit = (mob) => this.audio.mobHit(mob.pos);
    this.arrows.onStick = (pos) => this.audio.dig('stone', pos);
    this.mobs = new Mobs(this.scene, this.planet, this.drops);
    // Creatures speak for themselves — idle calls, pain and death, all anchored
    // in the world so you can hear which direction the herd is in.
    this.mobs.onSound = (kind, mob) => this.audio.mob(mob.type, kind, mob.pos);
    this.mobs.onAttack = (dmg, mob) => this._takeHit(dmg, mob);
    this.mobs.onBurn = (mob) => this.particles.embers(mob.pos, mob.up, 2, 0.55);
    // A torch on the ground has to light the animal standing next to it, and
    // nothing in the scene graph can tell it so — see `_entityLight`. Handed
    // over as a probe rather than as a per-mob light so that Mobs owns *when*
    // to ask (it already walks the herd once a frame) and the world owns the
    // answer.
    this.mobs.blockLightAt = (pos, out) => this._entityLight(pos, out);
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
    this.drops.onBurn = (pos) => {
      _burnUp.copy(pos).normalize();
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
      this.audio.mob(mob.type, 'idle', mob.pos);
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
    this.ui.showCrosshair(this.viewMode === VIEW_FIRST);

    this.farming = new Farming(this.planet, (edits) => this._applyEdits(edits));
    this.water = new Water(this.planet, (edits) => this._applyEdits(edits));
    // A current carries what is in it. Both are built before the sim is, so
    // they take the reference here rather than through their constructors.
    this.player.water = this.water;
    this.drops.water = this.water;
    // Same shape, same reason: the player is built before the animals are, and
    // its box has to stay out of their bodies.
    this.player.mobs = this.mobs;
    this.weather = new Weather();
    this.weather.onThunder = () => this.audio.thunder(0.85 + Math.random() * 0.35);
    this.seasons = new Seasons();
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);
    this.postfx.enabled = this.settings.post;
    this.postfx.setSize(this.width, this.height);
    this.viewModel.setSize(this.width, this.height);
    // One fixed rendering configuration. Performance is tuned with the render
    // scale slider instead of preset tiers.
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
    this.bow = { t: 0 };
    this.placeCooldown = 0;
    this.useCooldown = 0;
    /** Seconds since the last swing landed, for the attack rhythm. */
    this.attackT = ATTACK_PERIOD;
    this.damageFlash = 0;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.settings.renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.width = window.innerWidth; this.height = window.innerHeight;

    this.scene = new THREE.Scene();
    // Far plane is deliberately tight. Nothing depth-tested lives beyond the
    // cloud shell; the sky dome, stars and sun all draw with depthTest off. A
    // huge far plane wrecks depth precision, which shows up as GTAO haze over
    // the sky and softer shadows.
    //
    // Derived from the planet rather than written down, because it was a bare
    // 420 tuned against a sea-level radius of 130 and there is nothing in the
    // number to say so. 3.2x the outer radius keeps the same generous margin
    // over the cloud shell that 420 had, and moves when the planet does.
    this.camera = new THREE.PerspectiveCamera(
      this.settings.fov, this.width / this.height, 0.06, Math.round(R_MAX * 3.2));
    this.camera.position.set(0, R_TERRAIN_MAX + 10, 0);
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

  /** Draw the wireframe of a curved cell. */
  _showHighlight(col, k) {
    const { f, i, j } = colParts(col);
    const c = this._hlCorners;
    cornerPos(f, i, j, k, c[0]);
    cornerPos(f, i + 1, j, k, c[1]);
    cornerPos(f, i + 1, j + 1, k, c[2]);
    cornerPos(f, i, j + 1, k, c[3]);
    cornerPos(f, i, j, k + 1, c[4]);
    cornerPos(f, i + 1, j, k + 1, c[5]);
    cornerPos(f, i + 1, j + 1, k + 1, c[6]);
    cornerPos(f, i, j + 1, k + 1, c[7]);
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    const arr = this.highlight.geometry.attributes.position.array;
    // nudge outward a hair so the outline never z-fights
    for (let e = 0; e < 24; e++) {
      const p = c[edges[e]];
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      const s = (l + 0.006) / l;
      arr[e * 3] = p[0] * s; arr[e * 3 + 1] = p[1] * s; arr[e * 3 + 2] = p[2] * s;
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
    this.player.onLand = () => {
      const b = BLOCKS[this.player.groundBlock()] || BLOCKS[1];
      this.audio.step(b.sound);
    };
    this.player.onHurt = (dmg) => {
      this.damageFlash = Math.min(1, 0.35 + dmg * 0.1);
      this.audio.hurt();
      if (this.player.health <= 0) this._die('The fall was further than it looked.');
    };
  }

  _bindWindow() {
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('beforeunload', () => {
      if (this.state === 'playing' || this.state === 'paused') this.saveGame(false);
    });
    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked && !this.ui.screenOpen) this.input.requestLock();
    });
  }

  _resize() {
    this.width = window.innerWidth; this.height = window.innerHeight;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.settings.renderScale);
    this.postfx.setSize(this.width, this.height);
    this.viewModel.setSize(this.width, this.height);
    const pr = this.renderer.getPixelRatio();
    this.sky.setPixelRatio(pr);
    this.particles.setPixelRatio(pr);
  }

  setRenderScale() { this._resize(); }

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

    const icons = new IconFactory(tex.tiles.albedo, tex.tiles.size, tex.tiles.layers);
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
    this.ui.showMenu(Save.meta());
  }

  // --- world lifecycle ------------------------------------------------------

  _startWorker() {
    if (this.worldWorker) this.worldWorker.terminate();
    this.worldWorker = new Worker(new URL('./workers/world.worker.js', import.meta.url), { type: 'module' });
    this.worldWorker.onmessage = (e) => this._onWorldMessage(e.data);
  }

  _resetWorld() {
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
    // A new world has not failed to save yet. Carrying the count over would
    // leave the chip up on a planet that has never been written, which is both
    // wrong and the fastest way to teach a player to ignore it.
    this.saveFailures = 0;
    this._quitAnyway = false;
    this.ui.setSaveWarning(false);
    this.ui.setQuitConfirm(false);
    this._streamPending = false;
    this._streamTimer = 0;
    this._welcome = false;
    this.drops.clear();
    // Arrows are entities in the old world's air. They are not saved and they
    // must not survive the planet under them being replaced — a stuck arrow
    // carries a world position, and the same position in a new world is inside
    // whatever generated there.
    this.arrows.clear();
    this.bow.t = 0;
    this.mobs.clear();
    // The flow sim keys everything by cell index, so its sources and levels are
    // meaningless against a different planet — carried over, they marked cells
    // of the new world as springs at random.
    this.water.clear();
    this.farming.clear();
    this.kilns.clear();
    this.crates.clear();
    this.homeSpawn = null;
    this.deathSite = null;
    this.signs.clear();
    this.frozen.clear();
    this.hearths.clear();
    this.coreFound = false;
    this.mobs.wards = null;
    this.seasons.fromJSON(0);
    this._pushSeason();
    this.inventory = new Inventory();
    this.inventory.onChange = () => this.ui.refresh();
    this.stats = { mined: 0, placed: 0, crafted: 0 };
    this.playtime = 0;
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
    // Enough to light a camp with, which is the thing you actually want in the
    // first five minutes and cannot make without finding coal first.
    this.inventory.add(itemIdOf('torch'), 6);
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
   */
  newGame() {
    this.ui.hideMenu();
    document.body.appendChild(this._makeLoaderShell());
    this.ui.progress(0, 'Igniting the core');
    this._resetWorld();
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this._pendingSave = null;
    this._startWorker();
    this.worldWorker.postMessage({ type: 'init', seed: this.seed });
    this._choosing = true;
    this._readyHeld = false;
    this.ui.openCharacterPicker(this.character.id);
  }

  /**
   * Take the choice and go — or, if the planet is not finished, go back to
   * watching the bar, which is where a player who picked instantly would have
   * been the whole time.
   */
  beginWorld(id) {
    if (!this._choosing) return;
    this._choosing = false;
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
    document.getElementById('loader')?.remove();
    this.state = 'menu';
    this.ui.showMenu(Save.meta());
  }

  async continueGame() {
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
      data = await Save.read();
    } catch (err) {
      console.error(err);
      this.ui.showMenu(Save.meta());
      this.ui.toast('Could not read your planet — nothing is lost, try again', 0, 5200);
      return;
    }
    if (!data) {
      // Meta lives in localStorage and the planet lives in IndexedDB, so the
      // two can disagree: a browser that cleared site data of one kind and not
      // the other leaves a menu entry pointing at nothing. Say so, rather than
      // letting a planet appear to vanish between launches.
      const meta = Save.meta();
      this.ui.showMenu(meta);
      if (meta) this.ui.toast('That planet is not in this browser any more', 0, 5200);
      return;
    }
    if (!this._saveFitsWorld(data)) {
      this.ui.showMenu(Save.meta());
      this.ui.toast('That planet was made by an older version and cannot be opened', 0, 5200);
      return;
    }
    this.ui.hideMenu();
    document.body.appendChild(this._makeLoaderShell());
    this.ui.progress(0, 'Recalling your planet');
    this._resetWorld();
    this.seed = data.seed;
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
   */
  _saveFitsWorld(data) {
    if (!data?.blocks) return false;
    if (data.regions) {
      // A partial save. Its block payload is one region per id and everything
      // else comes back out of the generator, so the generator has to be the
      // one that made it — see GEN_VERSION.
      if (data.regions.length * REGION_VOXELS !== data.blocks.length) return false;
      if ((data.gen | 0) !== GEN_VERSION) return false;
    } else if (data.blocks.length !== COLUMNS * D) return false;
    if (data.colBiome && data.colBiome.length !== COLUMNS) return false;
    if (Array.isArray(data.geom)) {
      const [f, d, rmin] = data.geom;
      if (f !== F || d !== D || rmin !== R_MIN) return false;
    }
    return true;
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
      <p class="status" id="load-status">Working…</p></div>`;
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
        const id = chunkIdx(msg.f, msg.ci, msg.cj, msg.ck);
        if (this.liveChunks.has(id)) {
          this.planet.applyChunk(msg.f, msg.ci, msg.cj, msg.ck, msg.groups);
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
   * Keep meshed geometry to what can be seen. Chunks inside CHUNK_LOAD_DIST are
   * requested, chunks past CHUNK_KEEP_DIST are freed; the gap between the two is
   * hysteresis so standing on a boundary doesn't rebuild the same chunk forever.
   * @param {boolean} initial first batch — the loading screen waits on it
   */
  _streamChunks(initial = false) {
    if (!this.planet.blocks) return;
    // One batch of *new* geometry in flight at a time — queueing more only
    // starves the worker of the edit messages that need to be timely. Eviction
    // is never held back, so memory comes down the moment it can.
    const canAdd = initial || !this._streamPending;
    const eye = this.player.position;
    const load = CHUNK_LOAD_DIST * CHUNK_LOAD_DIST;
    const keep = CHUNK_KEEP_DIST * CHUNK_KEEP_DIST;
    const add = [], drop = [];
    const live = this.liveChunks;
    for (let id = 0; id < NUM_CHUNKS; id++) {
      const o = id * 3;
      const dx = CHUNK_CENTER[o] - eye.x;
      const dy = CHUNK_CENTER[o + 1] - eye.y;
      const dz = CHUNK_CENTER[o + 2] - eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const has = live.has(id);
      if (!has && d2 <= load) { if (canAdd) { add.push(id); live.add(id); } }
      else if (has && d2 > keep) { drop.push(id); live.delete(id); }
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
      this.player.cell.f = save.player.cell[0];
      this.player.cell.ci = save.player.cell[1];
      this.player.cell.cj = save.player.cell[2];
      this.player.cell.ck = save.player.cell[3];
      this.player._sync();
      return;
    }
    const col = spawnCol ?? 0;
    this.player.spawnAtColumn(col, Math.floor(this.planet.colHeight[col] - R_MIN - 0.5));
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
      const base = cols[n] * D;
      for (let k = 0; k < D; k++) {
        const i = base + k;
        if (RENDER_TYPE[blocks[i]] === R_LIQUID && !level.has(i)) sources.add(i);
      }
    }
  }

  /** Player, inventory and world state — everything that needs real voxels. */
  _placeEntities() {
    const save = this._pendingSave;
    if (save) {
      this.player.cell.f = save.player.cell[0];
      this.player.cell.ci = save.player.cell[1];
      this.player.cell.cj = save.player.cell[2];
      this.player.cell.ck = save.player.cell[3];
      this.player._sync();
      this.player.forward.fromArray(save.player.forward);
      this.player.pitch = save.player.pitch;
      this.player.health = save.player.health;
      this.breath = save.player.breath ?? 1;
      this.inventory.fromJSON(save.inventory);
      // Strictly after `fromJSON`, which clears the offhand precisely so that
      // this line is the only thing that can fill it.
      this.inventory.loadOffhand(save.player?.offhand);
      this.drops.fromJSON(save.drops);
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
      this.frozen = new Set(save.frozen || []);
      this.hearths = new Set(save.hearths || []);
      this.coreFound = !!save.coreFound;
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
      this._welcome = true;
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

    if (this._welcome) {
      this._welcome = false;
      // Waking at midnight is now an ordinary way to start, so the opening
      // advice has to know which one happened. "Punch a tree to begin" is fine
      // at noon and useless in the dark to someone who has not been told they
      // are holding six torches.
      const t = this.timeOfDay();
      const dark = t < 0.25 || t > 0.75;
      this.ui.toast('You wake on a small, quiet world.', 0, 4200);
      setTimeout(() => {
        if (dark) {
          this.ui.toast('Night already. Plant a torch — light keeps the dark out.',
            itemIdOf('torch'), 5200);
          setTimeout(() => this.ui.toast('Punch a tree while it lasts.',
            itemIdOf('log_oak'), 5000), 5600);
        } else {
          this.ui.toast('Punch a tree to begin.', itemIdOf('log_oak'), 5000);
        }
      }, 4600);
    }
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
  _spawnPlayer() {
    const p = this.planet;
    // The player's current column, which is always one that has been built:
    // on a new world `_seatPlayer` has just put them on the generator's chosen
    // spawn, and on a death it is where they fell. Searching outward from there
    // rather than from anywhere on the planet is not only what lazy generation
    // forces — it is also better behaviour, because respawning three thousand
    // columns from everything you own was never what anyone wanted.
    const c = this.player.cell;
    const hint = cidx(c.f, Math.floor(c.ci), Math.floor(c.cj));
    const REACH = 40;
    let best = -1, bestScore = -1, bestK = 0;
    for (let n = 0; n < 3000; n++) {
      const col = stepColumn(hint,
        ((Math.random() * (REACH * 2 + 1)) | 0) - REACH,
        ((Math.random() * (REACH * 2 + 1)) | 0) - REACH);
      if (!p.liveCol(col)) continue;
      const k = p.surfaceK(col);
      if (k < 6 || k >= D - 6) continue;
      const b = p.at(col, k);
      let score = b === ID.grass ? 3 : b === ID.sand ? 1.4 : 0;
      if (!score) continue;
      if (R_MIN + k + 1 < R_SEA + 1) continue;
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
    this.sky.setSolarTime(this.player.up, this.timeOfDay());
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
    if (!this.skills.observe(this.stats, this.playtime)) return;
    const left = this.skills.available;
    // Announce the balance, not the delta. A player who has banked points and
    // not spent them wants to be reminded that they are sitting there; "+1" on
    // its own says nothing about whether it is worth opening the screen.
    this.ui.toast(left === 1 ? '1 skill point to spend — K' : `${left} skill points to spend — K`,
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
    if (this._nightOut >= NIGHT_OUTDOORS) this._mark('dawn');
  }

  /**
   * Award a mark, and say so. Idempotent — `Skills.mark` swallows repeats — so
   * callers are free to fire from inside a hot path.
   */
  _mark(key) {
    if (!this.skills.mark(key)) return;
    const m = MARKS[key];
    this.ui.toast(`${m.label} — ${m.points} skill point${m.points > 1 ? 's' : ''}`, 0, 4000);
    this.audio.ui(760);
    this.ui.refreshSkills();
  }

  /** Buy one level. Called from the skills screen; returns whether it took. */
  buySkill(key) {
    if (!this.skills.buy(key)) { this.audio.ui(220); return false; }
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
    this.ui.toast('Everything unlearned. Your points are back.', 0, 3200);
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
        `Armour is gone. ${pieces} piece${pieces > 1 ? 's' : ''} became ${gained} skill point${gained > 1 ? 's' : ''} — press K.`,
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
        `${left} skill point${left === 1 ? '' : 's'} waiting — press K to spend ${left === 1 ? 'it' : 'them'}.`,
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
    if (ui.anyModalOpen) { ui.closeSettings(); ui.closeControls(); return; }
    if (ui.deathOpen) return;
    if (ui.skillsOpen) { this.closeSkills(); return; }
    if (ui.pauseOpen) { this.resume(); return; }
    if (ui.screenOpen) { this.closeScreen(); return; }
    if (this.state === 'playing') this.pause();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.ui.openPause();
    this.input.exitLock();
  }

  resume() {
    this.ui.closePause();
    this.state = 'playing';
    this.audio.resume();
    this.input.requestLock();
  }

  _die(cause) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.input.exitLock();
    this.closeScreen();
    this.closeSkills();
    // Everything you carried stays where you fell, and stays there — `keep`
    // exempts it from the despawn clock. What you were *wearing* stays on you:
    // you respawn at a bed that may be a long way from your body, and sending
    // you back for it with nothing on is how a setback becomes a spiral.
    _v1.copy(this.player.position).addScaledVector(this.player.up, 0.6);
    let dropped = 0;
    // The offhand goes with the rest. It is carried, not worn — a torch in your
    // left hand is your torch in the same sense the one in your right is, and a
    // slot that quietly kept its contents through a death would be the one
    // place on the character worth stuffing your diamonds into.
    for (const s of [...this.inventory.slots, this.inventory.offhand]) {
      if (s.empty) continue;
      this.drops.spawn(_v1.x, _v1.y, _v1.z, s.item, s.count, s.wear, null, true);
      s.clear();
      dropped++;
    }
    this.deathSite = dropped ? { pos: _v1.clone(), at: this.playtime } : null;
    // See `_tickNightOut`: a night you did not live through does not count.
    this._nightOut = 0;
    this.ui.refresh();
    this.ui.showDeath(cause);
  }

  respawn() {
    this.ui.hideDeath();
    this.player.health = this.player.maxHealth;
    this.breath = 1;
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
      this.ui.toast('Could not save — press again to leave anyway');
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
    this.ui.showMenu(Save.meta());
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
    const live = [];
    for (let rid = 0; rid < NUM_REGIONS; rid++) if (this.planet.live[rid]) live.push(rid);
    const regions = new Int32Array(live);
    const blocks = new Uint8Array(live.length * REGION_VOXELS);
    const tmp = new Int32Array(REGION_COLS);
    for (let n = 0; n < live.length; n++) {
      regionColumns(live[n], tmp);
      let o = n * REGION_VOXELS;
      for (let row = 0; row < CHUNK_T; row++) {
        const base = tmp[row * CHUNK_T] * D;
        blocks.set(this.planet.blocks.subarray(base, base + CHUNK_T * D), o);
        o += CHUNK_T * D;
      }
    }
    return { regions, blocks };
  }

  _savePayload() {
    const c = this.player.cell;
    return {
      // The shape of the planet this save was written for.
      //
      // Everything below indexes into a flat array whose size is F*F*6*D, and
      // the loader used to take that array on trust. Change the face resolution
      // or the shell depth and every index in an old save points somewhere
      // else: the block array is silently the wrong length, reads past its end
      // come back as air, and what you get is not an error but a corrupt planet
      // that looks almost plausible. Stamping the geometry in is what lets the
      // loader say no.
      geom: [F, D, R_MIN],
      gen: GEN_VERSION,
      seed: this.seed,
      ...this._saveBlocks(),
      colBiome: this.planet.colBiome.slice(),
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
        cell: [c.f, c.ci, c.cj, c.ck],
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
      hearths: [...this.hearths],
      coreFound: this.coreFound,
      playtime: this.playtime,
      dayT: +this.dayT.toFixed(5),
      season: this.seasons.toJSON(),
      stats: this.stats,
      biome: this.planet.colBiome[cidx(c.f, Math.floor(c.ci), Math.floor(c.cj))] ?? 2,
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
    try {
      await Save.write(this._savePayload());
      if (this.saveFailures > 0) {
        // Say so, and only here. Recovery is worth interrupting for precisely
        // because the failure was: someone who has been playing under a red
        // chip needs to know the work since it is now safe.
        this.saveFailures = 0;
        this.ui.setSaveWarning(false);
        this.ui.toast('Saved again — your world is safe');
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
  _crushCrowded(edits) {
    let doomed = null;
    for (const e of edits) {
      if (!crowds(e.id, e.facing ?? 0)) continue;
      for (let d = 0; d < 4; d++) {
        const nb = colNeighbor(e.col, d);
        if (nb < 0) continue;
        if (!NEEDS_ROOM[this.planet.at(nb, e.k)]) continue;
        const key = nb * D + e.k;
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
      if (!NEEDS_FLOOR[this.planet.at(e.col, e.k + 1)]) continue;
      if (supports(this.planet.at(e.col, e.k), this.planet.facingAt(e.col, e.k))) continue;
      // The floor is gone, so the whole run resting on it goes: the second
      // segment is held up by nothing but the first. The run ends at the first
      // block that is not NEEDS_FLOOR, which is a block with its own rules about
      // what holds it up (today: none).
      for (let k = e.k + 1; k < D && NEEDS_FLOOR[this.planet.at(e.col, k)]; k++) {
        if (!doomed) doomed = new Map();
        doomed.set(e.col * D + k, { col: e.col, k, id: this.planet.at(e.col, k) });
      }
    }
    if (!doomed) return;
    this._breakWhereItStands(doomed.values());
  }

  _applyEdits(edits) {
    for (const e of edits) {
      // any change can open a path for water or cut one off
      this.water?.onEdit(e.col, e.k);
      this.planet.setAt(e.col, e.k, e.id);
      // Resolve the facing here so the worker's mirror is told exactly what to
      // store. An edit that carries no facing but writes a directional block
      // (the kiln ⇄ lit-kiln swap) inherits whatever the cell already had.
      const fac = this.planet.applyFacing(e.col, e.k, e.id, e.facing);
      if (fac >= 0) e.facing = fac; else delete e.facing;
      if (e.id === ID.hearth) this.hearths.add(e.col * D + e.k);
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
    // Then whatever those edits left standing on nothing. After crushing rather
    // than before, so that a segment crushed out of the middle of a stack takes
    // the rest of the column with it — the crush re-enters here with its own
    // removals, and the column comes down on that pass. By the time this line
    // runs for the original batch those cells are already air, so nothing is
    // dropped twice.
    this._dropUnsupported(edits);
  }

  /**
   * Facing for a directional block placed at (col, k): the front turns to meet
   * the player. Resolved in the cell's own tangent frame, so it stays correct
   * across cube-face seams where the player's frame and the block's differ.
   * @returns {number} 0:+i 1:-i 2:+j 3:-j
   */
  /**
   * Axis for a log from the face it was placed against: 0 upright, 1 along i,
   * 2 along j. A log laid against a wall should lie down, showing its cut ends
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
      const p = colParts(col);
      tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
      const d = this.player.lookDir;
      const a = Math.abs(d.x * _frame.ea[0] + d.y * _frame.ea[1] + d.z * _frame.ea[2]);
      const b = Math.abs(d.x * _frame.eb[0] + d.y * _frame.eb[1] + d.z * _frame.eb[2]);
      return a >= b ? 1 : 2;
    }
    // The face normal is the step from the block hit to the cell being filled.
    if (hit.col === col) return 0;                 // stacked above or below
    const p = colParts(col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
    _v1.copy(this.planet.centerOf(col, k, _v2))
      .sub(this.planet.centerOf(hit.col, hit.k, _v3));
    const da = Math.abs(_v1.x * _frame.ea[0] + _v1.y * _frame.ea[1] + _v1.z * _frame.ea[2]);
    const db = Math.abs(_v1.x * _frame.eb[0] + _v1.y * _frame.eb[1] + _v1.z * _frame.eb[2]);
    const up = Math.abs(_v1.x * _frame.up[0] + _v1.y * _frame.up[1] + _v1.z * _frame.up[2]);
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
  _slabHalf(hit, col, k) {
    if (hit.col === col) return hit.k > k ? 1 : 0;   // stacked: fill the near half
    // Side placement: compare the aim point with the cell's mid-height.
    const p = colParts(col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
    _v1.copy(hit.point ?? this.player.eye).sub(this.planet.centerOf(col, k, _v2));
    const up = _v1.x * _frame.up[0] + _v1.y * _frame.up[1] + _v1.z * _frame.up[2];
    return up > 0 ? 1 : 0;
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
    // `_facingToward` gives the direction back toward the player; the step has
    // to fall the other way, so the low side is the opposite of that.
    const toward = this._facingToward(col, k);
    const away = toward ^ 1;      // 0<->1 and 2<->3 are the opposing pairs
    return away | (this._slabHalf(hit, col, k) ? 4 : 0);
  }

  /**
   * Open the little writing panel for a sign, and store whatever comes back.
   *
   * Pointer lock has to go while the field has focus — typing "w" into a locked
   * canvas walks you forward instead — so this runs as a modal like the pause
   * screen, and restores the lock on the way out.
   */
  _writeSign(col, k) {
    const key = col * D + k;
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
        this.audio.ui(620);
      }
      this.state = 'playing';
      this.input.requestLock();
    };
    document.getElementById('sign-ok').onclick = () => finish(true);
    document.getElementById('sign-cancel').onclick = () => finish(false);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
  }

  /**
   * The two cells of the door you clicked, whichever half that was.
   * @returns {number[]|null} [lowK, highK]
   */
  _doorHalves(col, k) {
    if (!IS_DOOR[this.planet.at(col, k)]) return null;
    const below = IS_DOOR[this.planet.at(col, k - 1)];
    return below ? [k - 1, k] : [k, k + 1];
  }

  /** Swing a door, both halves together, and refuse if you are standing in it. */
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
    this.audio.place('wood', this.planet.centerOf(col, halves[0], _v1));
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
    const p = colParts(col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
    _v1.copy(this.planet.centerOf(hit.col, hit.k, _v2))
      .sub(this.planet.centerOf(col, k, _v3));
    const da = _v1.x * _frame.ea[0] + _v1.y * _frame.ea[1] + _v1.z * _frame.ea[2];
    const db = _v1.x * _frame.eb[0] + _v1.y * _frame.eb[1] + _v1.z * _frame.eb[2];
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

  /** Is there anything for a torch in this cell, facing this way, to hold on to? */
  _torchSupported(col, k, byte) {
    if (byte === 0) return this.planet.solidAt(col, k - 1);
    const wall = stepColumn(col, ...TORCH_WALL_STEP[(byte - 1) & 3]);
    return this.planet.solidAt(wall, k);
  }

  _facingToward(col, k) {
    const p = colParts(col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
    // block → player, flattened onto the tangent plane
    _v1.copy(this.player.eye).sub(this.planet.centerOf(col, k, _v2));
    const da = _v1.x * _frame.ea[0] + _v1.y * _frame.ea[1] + _v1.z * _frame.ea[2];
    const db = _v1.x * _frame.eb[0] + _v1.y * _frame.eb[1] + _v1.z * _frame.eb[2];
    if (Math.abs(da) < 1e-6 && Math.abs(db) < 1e-6) return FACING_DEFAULT;
    if (Math.abs(da) >= Math.abs(db)) return da >= 0 ? 0 : 1;
    return db >= 0 ? 2 : 3;
  }

  _breakBlock(hit) {
    const b = BLOCKS[hit.id];
    if (b.hardness < 0 || hit.id === ID.core) return;
    const heldDef = ITEMS[this.inventory.active().item];
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

    const key = hit.col * D + hit.k;
    const kiln = this.kilns.get(key);
    if (kiln) {
      for (const s of [kiln.input, kiln.fuel, kiln.output]) {
        if (!s.empty) this.drops.spawn(center.x, center.y, center.z, s.item, s.count, s.wear);
      }
      this.kilns.delete(key);
      if (this.ui.screen === 'kiln' && this.ui.kiln === kiln) this.closeScreen();
    }

    // `_crateAt`, not `.get` — a worldgen cache you break without opening still
    // has to hand over its contents.
    if (IS_SIGN[hit.id]) this.signs.delete(key);

    const crate = hit.id === ID.crate ? this._crateAt(hit.col, hit.k) : null;
    if (crate) {
      // Everything comes back out. Silently eating a full crate of ore because
      // you mis-clicked would be the single worst thing this game could do.
      for (const s of crate.slots) {
        if (!s.empty) this.drops.spawn(center.x, center.y, center.z, s.item, s.count, s.wear);
      }
      this.crates.delete(key);
      if (this.ui.screen === 'crate' && this.ui.crate === crate) this.closeScreen();
    }

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
    // Ripe wheat only. Breaking a green shoot is losing a crop, not harvesting
    // one, and marking it would teach exactly the wrong lesson about farming.
    if (hit.id === ID.wheat_3) this._mark('harvest');
    this.player.swing();
    this.viewModel.punch();
    if (heldDef?.tool && b.hardness > 0.15) this.inventory.damageHeld(1);
  }

  _placeBlock(hit) {
    const held = this.inventory.active();
    const def = ITEMS[held.item];
    if (!def || def.block === undefined) return false;
    if (hit.prevCol < 0) return false;
    const id = def.block;
    const col = hit.prevCol, k = hit.prevK;
    if (k < 0 || k >= D) return false;
    const existing = this.planet.at(col, k);
    if (existing !== 0 && RENDER_TYPE[existing] !== R_LIQUID && RENDER_TYPE[existing] !== R_CROSS) return false;
    // A liquid cell counts as free space above — which is right for a wall, and
    // is how you dam a river — but not for a flame or a stem. See `DROWNS`.
    if (DROWNS[id] && RENDER_TYPE[existing] === R_LIQUID) {
      this.ui.setHint(IS_TORCH[id] ? 'It would go out' : 'It would wash away');
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
        this.ui.setHint('It only grows under water');
        return false;
      }
      if (RENDER_TYPE[this.planet.at(col, k + 1)] !== R_LIQUID) {
        this.ui.setHint('It needs deeper water');
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
          this.ui.setHint('Nothing to fix a torch to');
          return false;
        }
      }
    }

    // A cactus will not stand beside anything. Refusing the placement is the
    // half of the rule the player can see coming; the other half — a wall built
    // up against one already in the ground — is in `_applyEdits`, because that
    // is the funnel every block change goes through and a rule enforced in only
    // one of the two places is a rule with a trivial workaround.
    if (NEEDS_ROOM[id] && this._crowdedAt(col, k)) {
      this.ui.setHint('No room for a ' + BLOCKS[id].label.toLowerCase());
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
      this.ui.setHint('Nothing for a ' + BLOCKS[id].label.toLowerCase() + ' to grow on');
      return false;
    }

    // A door is two cells tall, so it needs the headroom before anything else.
    if (IS_DOOR[id]) {
      if (k + 1 >= D || this.planet.at(col, k + 1) !== 0) {
        this.ui.setHint('No room for a door');
        return false;
      }
      if (this._intersectsPlayer(col, k + 1)) return false;
    }

    const edit = { col, k, id };
    if (IS_TORCH[id]) edit.facing = torchByte;
    else if (IS_LADDER[id]) edit.facing = this._ladderFacing(hit, col, k);
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
      const key = col * D + k;
      if (!this.crates.has(key)) {
        this.crates.set(key, {
          slots: Array.from({ length: CRATE_SLOTS }, () => new Slot()), col, k,
        });
      }
    }
    this.inventory.consumeHeld(1);
    this.audio.place(BLOCKS[id].sound, this.planet.centerOf(col, k, _v1));
    this.stats.placed++;
    this.player.swing();
    this.viewModel.punch();
    return true;
  }

  _intersectsPlayer(col, k) {
    const c = this.planet.centerOf(col, k, _v1);
    for (const h of [0.28, 0.9, 1.55]) {
      _v2.copy(this.player.position).addScaledVector(this.player.up, h);
      if (_v2.distanceToSquared(c) < 0.78 * 0.78) return true;
    }
    return false;
  }

  // --- screens --------------------------------------------------------------

  openScreen(kind, state) {
    this.ui.openScreen(kind, state);
    this.input.exitLock();
    this.audio.ui(560);
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
    const key = col * D + k;
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
    const below = Math.max(0, Math.round(R_SEA - R_MIN) - c.k);   // layers under sea level
    const rng = makeRng(((this.seed ^ (c.col * 2654435761)) + c.k * 40503) | 0);
    const deep = below > 8;
    const mid = below > 2;

    const COMMON = ['bread', 'coal', 'stick', 'planks', 'torch', 'seeds', 'apple', 'hide', 'flint'];
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
    const key = col * D + k;
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
        this._mark('forge');
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
        }
      } else {
        k.progress = Math.max(0, k.progress - dt * 0.6);
      }

      const want = k.burn > 0 ? ID.kiln_lit : ID.kiln;
      const cur = this.planet.at(k.col, k.k);
      if ((cur === ID.kiln || cur === ID.kiln_lit) && cur !== want) {
        this._applyEdits([{ col: k.col, k: k.k, id: want }]);
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

    if (this.state === 'playing') this._update(dt);
    else if (this.state === 'menu' || this.state === 'loading') this._idleUpdate(dt);
    else this._frozenUpdate(dt);

    voxelUniforms.uTime.value += dt;
    this.postfx.render(dt, { damage: this.damageFlash, underwater: this.player.headInWater });
    if (this.state === 'playing' || this.state === 'paused') this.viewModel.render(this.renderer);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
    this.input.endFrame();
  }

  _idleUpdate(dt) {
    // The menu's orbit camera flies right past where the body is standing.
    this.character.hide();
    const t = performance.now() * 0.00005;
    const r = R_TERRAIN_MAX + 34;
    this.camera.position.set(Math.cos(t) * r, Math.sin(t * 0.53) * r * 0.38, Math.sin(t) * r);
    this.camera.lookAt(0, 0, 0);
    if (this.camera.fov !== 44) { this.camera.fov = 44; this.camera.updateProjectionMatrix(); }
    const up = _v1.copy(this.camera.position).normalize();
    this.sky.setSolarTime(up, this.timeOfDay());
    this.sky.update(dt, this.camera, up, this.planet.center);
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
    this.viewModel.enabled = this.viewMode === VIEW_FIRST && this.zoom < 0.1;
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
    this.ui.showCrosshair(this.viewMode === VIEW_FIRST);
    // Written on the keypress rather than at shutdown: a browser tab is closed,
    // not quit, and there is no reliable moment later to catch.
    this.settings.view = this.viewMode;
    this.persistSettings();
  }

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
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST,
      this.inventory.held().item, this.inventory.offhand.item);
    this.sky.setSolarTime(this.player.up, this.timeOfDay());
    this.sky.update(dt, this.camera, this.player.up, this.player.position);
    this._updateSharedUniforms();
  }

  _update(dt) {
    const input = this.input;
    const ui = this.ui;
    this.playtime += dt;
    this._tickClock(dt);

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
    const busy = ui.screenOpen || ui.skillsOpen;
    const act = busy ? Game.NO_INPUT : input;

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

      if (input.locked && (input.mouseDX || input.mouseDY)) {
        // Scaled down by however far in the camera actually is, so the same
        // movement of the hand slides the picture by the same fraction of the
        // screen at any zoom. Read off `camera.fov` rather than off `this.zoom`
        // so it tracks the transition rather than jumping at the ends of it —
        // that is one frame behind, which is invisible, and it is also correct
        // for the sprint kick for free.
        const scale = lookScaleFor(this.camera.fov, this.settings.fov);
        this.player.look(input.mouseDX, input.mouseDY,
          input.sensitivity * this.settings.sensitivity * scale, input.invertY);
      }
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
      .liveCol(cidx(pc.f, Math.floor(pc.ci), Math.floor(pc.cj)));
    if (!onBuiltGround) {
      this._streamPending = false;
      this._streamTimer = 0;
      this.player.vel.i = 0; this.player.vel.j = 0; this.player.vel.k = 0;
    }
    const wasInWater = this.player.inWater;
    if (onBuiltGround) this.player.update(dt, act);
    if (this.player.inWater && !wasInWater) {
      this.particles.splash(this.player.position, this.player.up, 1.2);
      this.audio.splash();
    }
    if (this.player.headInWater && Math.random() < dt * 5) {
      this.particles.bubbles(this.player.eye, this.player.up, 2);
    }

    if (this.player.headInWater) {
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
          if (this.player.health <= 0) this._die('The water was deeper than it looked.');
        }
      }
    } else {
      this.breath = Math.min(1, this.breath + dt / 3);
      this._drownTimer = 0;
    }

    this._tickFire(dt);
    this._tickContact(dt);

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
    this._safeTick('freeze', () => this._tickFreeze(dt));
    this._safeTick('vitals', () => this._tickVitals(dt));
    this._safeTick('grace', () => this._tickGrace(dt));
    this._safeTick('core', () => this._tickCore(dt));
    this._safeTick('skills', () => this._tickSkills(dt));
    this._safeTick('mobs', () => this.mobs.update(dt, this.player, this.sky));
    // After the animals have moved, so a shot lands where the body is drawn
    // this frame rather than where it was drawn last one. The mob list is handed
    // over per call rather than held; see the constructor.
    this._safeTick('arrows', () => this.arrows.update(dt, this.mobs));
    // A merchant that has walked out of range, run out of life or been killed
    // takes its shop with it. Without this the screen stays up over a stock
    // list belonging to a mob that no longer exists.
    if (this.ui.screen === 'shop' && !this.mobs.list.includes(this.ui.shop)) {
      this.closeScreen();
      this.ui.toast('The merchant moved on.', itemIdOf('coin'), 2600);
    }
    this.drops.update(dt, this.player, {
      // `wear` is the third argument Drops has always passed and this callback
      // used to ignore — see `Inventory.add`.
      collect: (item, count, wear) => {
        const taken = this.inventory.add(item, count, wear);
        if (taken > 0) {
          this.audio.pickup();
          this.ui.toast(ITEMS[item].label, item, 1500);
        }
        return taken;
      },
      hasRoom: (item) => this.inventory.hasRoom(item),
    });

    const c = this.player.cell;
    const biomeId = this.planet.colBiome[cidx(c.f, Math.min(F - 1, Math.floor(c.ci)), Math.min(F - 1, Math.floor(c.cj)))] ?? 2;
    const altitude = this.player.position.length() - R_SEA;
    this.weather.update(dt, biomeId, altitude, this.seasons.cold);
    // Precipitation spawns in a box around the camera with no notion of the
    // world, so without this it rains just as hard inside a cave or under a
    // roof as it does in the open. Fade it out by how much sky is overhead,
    // eased so stepping under a tree dims the rain rather than cutting it.
    this.shelter += (this._skyExposure() - this.shelter) * Math.min(1, dt * 3.5);
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
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST,
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
    this._updateHandLight(dt);
    this._updateDropLight(dt);
    // After both, because it converts the positions those two just wrote.
    this._safeTick('lightOcclusion', () => this._updateLightOcclusion());
    this._safeTick('flames', () => this._tickFlames(dt));
    this._safeTick('blockModels', () => this._syncBlockModels());
    this.sky.setSolarTime(this.player.up, this.timeOfDay());
    // `shelter` doubles as the entity fill's occlusion — animals cannot read
    // the voxel light, so a roof over the player is the best signal the sky has
    // that the thing it is lighting is indoors.
    this.sky.update(dt, this.camera, this.player.up, this.player.position, this.shelter);
    this.particles.update(dt, this.camera, this.player.up, this.sky);
    this._updateSharedUniforms();
    this._updateAudio();
    this._updateHud(biomeId);

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
  _takeHit(damage, cause, guarded = true, kind = 'blow') {
    const p = this.player;
    if (p.health <= 0) return true;
    if (guarded && this._hurtGuard > 0) return false;
    if (guarded) this._hurtGuard = HURT_IMMUNITY;

    // Nothing wears out and nothing breaks: the reduction is a fact about the
    // player now, not about four items with a durability bar.
    damage = this.skills.soak(damage, kind);

    // `cause` is the mob for a blow and a string for everything else, so this
    // shoves you away from a husk but not away from drowning.
    if (cause && cause.pos) p.knockback(cause.pos.x, cause.pos.y, cause.pos.z);

    p.health = Math.max(0, p.health - damage);
    this.damageFlash = Math.min(1, 0.32 + damage * 0.1);
    this.audio.hurt();
    if (p.health <= 0) {
      // Name the thing that killed you. "Something in the dark got you" was
      // written when the only thing that could was a husk at night; a tiger
      // mauling you at noon deserves to be told plainly, and a death you cannot
      // attribute is a death you cannot learn from.
      this._die(typeof cause === 'string' ? cause : this._killedBy(cause));
      return true;
    }
    return false;
  }

  /**
   * How the death screen says who did it.
   *
   * `cause` is whatever was passed to `hurt` — a mob for a blow. Falls back to
   * the old line only when the killer has no label to read, which is not a case
   * that exists today but is one bad refactor away.
   */
  _killedBy(cause) {
    const label = cause?.spec?.label;
    if (!label) return 'Something in the dark got you.';
    const article = /^[aeiou]/i.test(label) ? 'An' : 'A';
    return `${article} ${label.toLowerCase()} got you.`;
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
        if (this._takeHit(3, 'The lava was not as shallow as it looked.', false, 'lava')) return;
      }
      this.particles.embers(p.eye, p.up, 3, 1.1);
    } else if (p.burning > 0) {
      // Water puts you out at once; otherwise it burns down on its own.
      if (p.inWater) p.burning = 0;
      else {
        p.burning = Math.max(0, p.burning - dt);
        this._burnTimer = (this._burnTimer || 0) + dt;
        if (this._burnTimer > 0.9) {
          this._burnTimer = 0;
          if (this._takeHit(1, 'You burned.', false, 'fire')) return;
        }
        if (Math.random() < dt * 12) this.particles.embers(p.eye, p.up, 1, 0.8);
      }
    }
    this.damageFlash = Math.max(this.damageFlash, p.burning > 0 ? 0.14 : 0);
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
    this._takeHit(hurt, 'The desert was sharper than it looked.', false, 'blow');
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
  _tickCore(dt) {
    if (this.coreFound) return;
    this._coreT = (this._coreT ?? 0) - dt;
    if (this._coreT > 0) return;
    this._coreT = 0.4;
    const c = this.player.cell;
    if (c.ck > CORE_REACH_K) return;
    // Actually next to it, not merely deep — the core tops out at layer 2 and
    // the last few layers of basalt are not the same achievement.
    const col = cidx(c.f, Math.min(F - 1, Math.floor(c.ci)), Math.min(F - 1, Math.floor(c.cj)));
    let touching = false;
    for (let di = -1; di <= 1 && !touching; di++) {
      for (let dj = -1; dj <= 1 && !touching; dj++) {
        const cc = stepColumn(col, di, dj);
        for (let k = Math.max(0, Math.floor(c.ck) - 2); k <= Math.floor(c.ck) + 1; k++) {
          if (this.planet.at(cc, k) === ID.core) { touching = true; break; }
        }
      }
    }
    if (!touching) return;
    this.coreFound = true;
    this._mark('core');
    this.inventory.add(itemIdOf('hearth'), 1);
    this.ui.toast('The core is warm to the touch.', itemIdOf('hearth'), 5000);
    setTimeout(() => this.ui.toast('It gives you a hearth. Nothing that walks at night will come near it.',
      itemIdOf('hearth'), 6000), 5200);
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
      const k = key % D, col = (key - k) / D;
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
   * The highest liquid cell in this column with open air above it, or -1.
   *
   * The scan starts *below* the reported surface, not above it: surfaceK counts
   * the top of a lake as the surface, so beginning at surfaceK + 1 starts in the
   * air over the water and never sees the water at all.
   */
  _openWaterK(col) {
    const k0 = Math.max(1, this.planet.surfaceK(col) - 2);
    for (let k = k0; k < Math.min(D - 1, k0 + 10); k++) {
      if (RENDER_TYPE[this.planet.at(col, k)] !== R_LIQUID) continue;
      if (this.planet.at(col, k + 1) === 0) return k;
    }
    return -1;
  }

  _freezeSome() {
    const c = this.player.cell;
    const base = cidx(c.f, Math.min(F - 1, Math.floor(c.ci)), Math.min(F - 1, Math.floor(c.cj)));
    const edits = [];
    for (let n = 0; n < FREEZE_SCAN && edits.length < FREEZE_BATCH; n++) {
      // Sampled rather than swept: a full disc is 2 000 columns a pass, and the
      // point is a lake that creeps over, not one that snaps.
      const di = Math.round((Math.random() * 2 - 1) * FREEZE_RADIUS);
      const dj = Math.round((Math.random() * 2 - 1) * FREEZE_RADIUS);
      const col = stepColumn(base, di, dj);
      const k = this._openWaterK(col);
      if (k < 0) continue;
      const key = col * D + k;
      if (this.frozen.has(key)) continue;
      // Only standing water freezes. A spring has no level entry; anything with
      // one is a flow, and a running stream icing over is both wrong and the
      // thing that would make the thaw below dishonest — it can only give back
      // standing water, so it must only ever take standing water.
      if (!this.water.sources.has(key)) continue;
      this.frozen.add(key);
      edits.push({ col, k, id: ID.ice });
    }
    if (edits.length) this._applyEdits(edits);
  }

  _thawSome() {
    const edits = [];
    for (const key of this.frozen) {
      if (edits.length >= FREEZE_BATCH) break;
      this.frozen.delete(key);
      const k = key % D, col = (key - k) / D;
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
    if (edits.length) this._applyEdits(edits);
  }

  /** Hand the current season to the shader that colours the world. */
  _pushSeason() {
    const s = this.seasons;
    voxelUniforms.uSeasonColor.value.set(s.color[0], s.color[1], s.color[2]);
    voxelUniforms.uSeasonStrength.value = s.strength;
  }

  /** Nourishment drains with effort and slowly heals you while it lasts. */
  _tickVitals(dt) {
    const p = this.player;
    const working = p.sprinting ? 1.6 : (p.moveAmount > 0.6 ? 0.7 : 0.18);
    this.energy = Math.max(0, this.energy - dt * 0.0022 * working);

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
    const ci = Math.floor(c.ci), cj = Math.floor(c.cj), ck = Math.floor(c.ck);
    const baseCol = cidx(c.f, Math.min(F - 1, Math.max(0, ci)), Math.min(F - 1, Math.max(0, cj)));

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
    if (sawLava) this._mark('abyss');
    this._hlValue = { r, g, b };
    return this._hlValue;
  }

  /**
   * Block light reaching an *entity*, in the units its emissive wants.
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
    // Cached; this is what keeps the emitter list in step with the world.
    this._handLight();
    const emitters = this._emitters;
    if (!emitters.length) return out;
    // The gain the terrain applies to its own block light, read live off the
    // uniform rather than copied — a torch-lit mob and the torch-lit dirt under
    // it answer by the same amount and can never drift apart. RECIPROCAL_PI
    // because the terrain's term carries the same Lambert factor; without it a
    // lit mob would come out pi times brighter than the ground it stands on.
    const gain = voxelUniforms.uBlockIntensity.value / Math.PI;

    // --- who is in range at all, brightest first ---
    const ord = this._emitOrder || (this._emitOrder = new Int32Array(MAX_ENTITY_EMITTERS));
    const wt = this._emitW || (this._emitW = new Float64Array(MAX_ENTITY_EMITTERS));
    const key = this._emitKey || (this._emitKey = new Float64Array(MAX_ENTITY_EMITTERS));
    let n = 0;
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      const d = pos.distanceTo(e.pos);
      if (d >= e.reach) continue;
      // Same curve as the hand light's, in world units rather than cells — the
      // two differ by the cell's arc length, which on this planet is within a
      // few percent of one.
      const fall = 1 - d / e.reach;
      const w = fall * fall * gain;
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
   * The probe is handed one position per entity: `mob.pos + up * height/2` for
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
    const p = colParts(f.col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, f.k + 0.5, _frame);
    _v2.set(_frame.up[0], _frame.up[1], _frame.up[2]);
    this.particles.embers(_v1, _v2, 1, 0.10);
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
   * that matters is therefore the horizon, not legibility: on a planet of
   * R_SEA 290 the flat ground falls away about 34 cells from an eye two blocks
   * up (`sqrt(2*R*h)`, the same arithmetic `CHUNK_LOAD_DIST` is derived from),
   * so a 34-cell scan covers every flower on level ground the player can see at
   * all. What is lost past it is flowers on high terrain 60+ cells out, at
   * seven pixels and behind aerial fog.
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
      p.f, (p.i / CHUNK_T) | 0, (p.j / CHUNK_T) | 0, (k / CHUNK_K) | 0));
    if (!arr) return -1;
    const addr = ((p.i % CHUNK_T) * CHUNK_T + (p.j % CHUNK_T)) * CHUNK_K + (k % CHUNK_K);
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const a = arr[mid] >>> CROSS_LIGHT_ADDR_SHIFT;
      if (a === addr) return arr[mid];
      if (a < addr) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  _syncBlockModels() {
    const bm = this.blockModels;
    bm.prime('torch', itemIdOf('torch'), { height: 0.95, lean: true });
    for (const n of FLOWER_NAMES) bm.prime(n, itemIdOf(n), { height: MODELLED_PLANTS[n] });

    const c = this.player.cell;
    const ci = Math.floor(c.ci), cj = Math.floor(c.cj), ck = Math.floor(c.ck);
    const baseCol = cidx(c.f, Math.min(F - 1, Math.max(0, ci)), Math.min(F - 1, Math.max(0, cj)));
    const lists = this._modelLists || (this._modelLists = { torch: [] });
    for (const n of FLOWER_NAMES) lists[n] = lists[n] || [];

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
            if (!flower && !(torchable && IS_TORCH[id])) continue;
            const p = colParts(col);
            tangentFrame(p.f, p.i + 0.5, p.j + 0.5, k + 0.5, _frame);
            const pos = this.planet.centerOf(col, k, new THREE.Vector3());
            const up = new THREE.Vector3(_frame.up[0], _frame.up[1], _frame.up[2]);

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
              const [wi, wj] = TORCH_WALL_STEP[(byte - 1) & 3];
              const ea = _frame.ea, eb = _frame.eb;
              e.out = new THREE.Vector3(
                -(ea[0] * wi + eb[0] * wj), -(ea[1] * wi + eb[1] * wj),
                -(ea[2] * wi + eb[2] * wj));
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
    const p = colParts(f.col);
    tangentFrame(p.f, p.i + 0.5, p.j + 0.5, f.k + 0.5, _frame);
    if (!IS_TORCH[f.id]) return out;
    // A floor torch burns just above its own centre; a wall torch burns out
    // over the cell, at the far end of the bracket.
    const byte = f.byte & 7;
    if (byte === 0) return out.addScaledVector(
      _v3.set(_frame.up[0], _frame.up[1], _frame.up[2]), 0.22);
    const [di, dj] = TORCH_WALL_STEP[(byte - 1) & 3];
    const ea = _frame.ea, eb = _frame.eb;
    out.x += -(ea[0] * di + eb[0] * dj) * 0.16 + _frame.up[0] * 0.28;
    out.y += -(ea[1] * di + eb[1] * dj) * 0.16 + _frame.up[1] * 0.28;
    out.z += -(ea[2] * di + eb[2] * dj) * 0.16 + _frame.up[2] * 0.28;
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
    // flame rather than as a framerate problem.
    this._flameT = (this._flameT ?? 0) + dt;
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
      if (a && IS_OPAQUE[this.planet.blocks[a.col * D + a.k]]) hp.copy(this.player.eye);
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
      const d2 = d.pos.distanceToSquared(this.player.position);
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
    u.uDropLightPos.value.copy(best.drop.pos).addScaledVector(
      _v1.copy(best.drop.pos).sub(this.planet.center).normalize(), 0.25);
  }

  /**
   * Keep the two moving flames' shadow volume under the player.
   *
   * Keeping it is *all* this does. The shader works out both ends of every
   * shadow ray itself, from the world-space light positions it already has, so
   * nothing here feeds it a coordinate — see flameLight for why that division
   * of labour is the only safe one.
   *
   * See the OCC_* block in VoxelMaterial.js for what the volume is and why a
   * cubesphere can have an exact one. This is the cheap half: 2 304 columns
   * resolved through patchColumn — which is the same extended-face mapping the
   * shader inverts — and then 73 728 byte reads down them.
   *
   * ### When it rebuilds
   *
   * Only when the player walks OCC_HYST cells out of the middle, or steps onto
   * another cube face. Rebuilding on every integer cell crossing was the first
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
    // `_emitters` is refilled by the hand-light scan, which has already run this
    // frame (the view model asks for it), so this reads the current world.
    if (!blocks || (!flames && this._emitters.length === 0)) {
      u.uOccActive.value = 0;
      return;
    }
    const p = this.player.position;
    if (!this._occ) {
      this._occ = { f: 0, i: 0, j: 0, k: 0, gen: 0, ready: false, cols: new Int32Array(OCC_NI * OCC_NJ) };
      this._rebuildOcclusion(this.planet.cellOf(p.x, p.y, p.z, _occCell));
    } else {
      // Asked in the volume's *own* frame rather than in the player's, and that
      // is what makes cube seams a non-event here. patchColumn extends a face's
      // coordinates correctly a long way past its edge, so a volume built on one
      // face stays exactly valid while the player walks onto the next — and
      // testing the player's face index instead would rebuild every few frames
      // for as long as they walked along a seam, for no gain at all.
      const l = this._worldToOccCell(p, _occLocal);
      if (Math.abs(l.x - OCC_NI * 0.5) > OCC_HYST
        || Math.abs(l.y - OCC_NJ * 0.5) > OCC_HYST
        || Math.abs(l.z - OCC_NK * 0.5) > OCC_HYST) {
        this._rebuildOcclusion(this.planet.cellOf(p.x, p.y, p.z, _occCell));
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
  _rebuildOcclusion(c) {
    const o = this._occ;
    const f = c.f;
    const oi = Math.round(c.ci) - (OCC_NI >> 1);
    const oj = Math.round(c.cj) - (OCC_NJ >> 1);
    // k is deliberately *not* clamped into the world. A slab that always sits
    // exactly under the player is what makes the shader's origin arithmetic one
    // subtraction; the two rows below cost less than the clamping would.
    const ok = Math.round(c.ck) - (OCC_NK >> 1);

    // Columns first, because they depend only on (i, j): 2 304 of these instead
    // of one per texel, which is a 32x saving on the only expensive part.
    const cols = o.cols;
    for (let jj = 0; jj < OCC_NJ; jj++) {
      const row = jj * OCC_NI;
      for (let ii = 0; ii < OCC_NI; ii++) cols[row + ii] = patchColumn(f, oi + ii, oj + jj, 0, 0);
    }

    // Opaque exactly as the light grid means it — ATTEN 255 is IS_OPAQUE — so a
    // moving flame and a planted one agree about what a wall is. Leaves and
    // water dim the grid rather than stopping it and are left out of the volume
    // for the same reason: a flame should shine through a canopy.
    const blocks = this.planet.blocks;
    const data = occupancyData;
    const plane = OCC_NI * OCC_NJ;
    let idx = 0;
    for (let kk = 0; kk < OCC_NK; kk++) {
      const k = ok + kk;
      // Below layer 0 is the unbreakable core and above the shell is sky.
      if (k < 0) { data.fill(255, idx, idx + plane); idx += plane; continue; }
      if (k >= D) { data.fill(0, idx, idx + plane); idx += plane; continue; }
      for (let n = 0; n < plane; n++) data[idx++] = IS_OPAQUE[blocks[cols[n] * D + k]] ? 255 : 0;
    }

    // --- commit ---
    // `gen` is part of the commit for the same reason the rest of it is: it is
    // what tells `_entityLight`'s cache that every shadow answer it is holding
    // was computed against a volume that has since moved.
    o.f = f; o.i = oi; o.j = oj; o.k = ok; o.gen++; o.ready = true;
    occupancyTexture.needsUpdate = true;
    const u = voxelUniforms;
    u.uOccN.value.fromArray(FACE_N[f]);
    u.uOccR.value.fromArray(FACE_R[f]);
    u.uOccU.value.fromArray(FACE_U[f]);
    u.uOccOrg.value.set(F * 0.5 - oi, F * 0.5 - oj, -(R_MIN + ok));
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
   * than an edit, and a column can legitimately appear twice in the table near a
   * cube corner, where a map would silently keep one of them. The scan is a
   * couple of microseconds and patches every copy.
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
      this._rebuildOcclusion({
        f: o.f, ci: o.i + (OCC_NI >> 1), cj: o.j + (OCC_NJ >> 1), ck: o.k + (OCC_NK >> 1),
      });
      return;
    }
    const cols = o.cols;
    const plane = OCC_NI * OCC_NJ;
    let touched = false;
    for (const e of edits) {
      const kk = e.k - o.k;
      if (kk < 0 || kk >= OCC_NK) continue;
      const solid = IS_OPAQUE[e.id] ? 255 : 0;
      const base = kk * plane;
      for (let n = 0; n < plane; n++) {
        if (cols[n] === e.col) { occupancyData[base + n] = solid; touched = true; }
      }
    }
    if (!touched) return;
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
    const pc = this.planet.center;
    const x = pos.x - pc.x, y = pos.y - pc.y, z = pos.z - pc.z;
    const r = Math.hypot(x, y, z) || 1e-6;
    const N = FACE_N[o.f], R = FACE_R[o.f], U = FACE_U[o.f];
    const dn = (x * N[0] + y * N[1] + z * N[2]) / r;
    const da = (x * R[0] + y * R[1] + z * R[2]) / r;
    const db = (x * U[0] + y * U[1] + z * U[2]) / r;
    return out.set(
      OCC_ANG * Math.atan2(da, dn) + (F * 0.5 - o.i),
      OCC_ANG * Math.atan2(db, dn) + (F * 0.5 - o.j),
      r - (R_MIN + o.k));
  }

  /** Crosshair prompt when you're looking at an animal. */
  _feedHint(mob) {
    if (!mob) return null;
    if (mob.spec.trader) return `<kbd>RMB</kbd> Trade`;
    if (mob.baby > 0) return 'Calf';
    if (mob.love > 0) return 'Ready to breed';
    const held = this.inventory.active();
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
    return `${where} — ${+drag.toFixed(1)}× slower`;
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
    // `active()` and not `held()`: the offhand is the hand that acts when the
    // main hand is empty, and a bow parked there has to be drawable and has to
    // spend its own durability. Everything downstream — `damageHeld`,
    // `ViewModel.actingHand` — already follows the same rule.
    const def = ITEMS[this.inventory.active().item];
    const arrowId = itemIdOf(def?.ammo || '');
    // Everything that has to be true to go on drawing. Read once and used for
    // both the charge and the release, so the two can never disagree about
    // whether this was a shot or a cancellation.
    const armed = !!def?.bow && !busy && input.locked
      && (arrowId ? this.inventory.count(arrowId) > 0 : false);

    // The state machine itself is in Items.js, as a pure function, because it is
    // the only part of this with a wrong answer that nobody would see — see
    // `bowDrawStep`. This module cannot be imported by a test (it builds a game
    // on import), so the branch that decides "shot or cancellation" is kept
    // somewhere that can be.
    const next = bowDrawStep(b.t, {
      armed, down: input.buttons[2], dt, drawTime: def?.bow?.draw ?? 1,
    });
    b.t = next.t;
    if (next.fire) this._loose(def, arrowId, next.fire);

    // Told every frame, including the frames it is zero: these are poses, not
    // events, and a listener that is only updated while drawing is a listener
    // that stays drawn after the shot.
    this.viewModel.setDraw(b.t, arrowId);
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
    this.bow.hint = def?.bow && !armed && arrowId && input.buttons[2] && !busy && input.locked
      ? 'Out of arrows' : null;
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
    if (this.inventory.remove(arrowId, 1) < 1) return;
    this.inventory.changed();

    // Out of the eye, along the look, pushed clear of the player's own body —
    // the first sub-step of the flight is a solidity probe and starting it
    // inside your own head would land the arrow at your feet.
    const from = _v1.copy(this.player.eye).addScaledVector(this.player.lookDir, 0.6);
    this.arrows.spawn(from, this.player.lookDir, shot.speed, shot.damage, shot.power);

    // The recoil, not a swing. See `ViewModel.recoil`: `punch` would also fire
    // the body's melee clip, and the body is already coming out of the draw.
    this.viewModel.recoil();
    // A bow wears by the shot, like every other tool wears by the stroke.
    if (def.tool) this.inventory.damageHeld(1);
    this.audio.ui(240 + 140 * shot.power);
  }

  _interact(dt, input) {
    const hit = this.planet.raycast(this.player.eye, this.player.lookDir, this.player.reach);

    // a creature in front of the block takes the hit instead
    const mobHit = this.mobs.raycast(this.player.eye, this.player.lookDir, this.player.reach);

    // Name whatever is under the crosshair.
    //
    // Done here rather than with its own raycast because the answer already
    // exists: this is the one place that knows both what you are aiming at and
    // which of the two won. A second cast would be the same work twice and
    // could disagree with the highlight box on the frame they straddle a face.
    // The creature takes precedence for the same reason it takes the hit.
    this.ui.setLookAt(mobHit && (!hit || mobHit.dist < hit.dist)
      ? (mobHit.mob.spec.label ?? null)
      : (hit ? (BLOCKS[this.planet.at(hit.col, hit.k)]?.label ?? null) : null));

    // A bow takes the whole of both buttons and answers none of the questions
    // below it.
    //
    // The right button is the draw — `_tickBow` already has it — and letting the
    // chain below see it too meant aiming at a bench opened the crafting screen
    // and aiming at farmland tilled it, both on the frame the player pressed to
    // shoot. The left button is a melee swing with a longbow, which is not a
    // thing, and mining with one is worse: `miningTime` gives any tool that is
    // not the block's own a flat 1.15, so a bow was quietly a universal pickaxe
    // that broke nothing and dropped nothing.
    //
    // The highlight box and the crosshair state are set above and below this on
    // purpose — you can still see what you are aiming at.
    if (ITEMS[this.inventory.active().item]?.bow) {
      this.ui.setCrosshairActive(!!mobHit || !!hit);
      this.highlight.visible = false;
      this.placeCooldown = Math.max(0, this.placeCooldown - dt);
      this.useCooldown = Math.max(0, this.useCooldown - dt);
      voxelUniforms.uBreakStage.value = -1;
      this.mining.key = null;
      this.mining.progress = 0;
      this.eating = 0;
      this.ui.setHint(this.bow.hint || null);
      return;
    }
    if (mobHit && (!hit || mobHit.dist < hit.dist)) {
      this.ui.setCrosshairActive(true);
      this.highlight.visible = false;
      if (input.clicked[0] && input.locked) {
        const held = ITEMS[this.inventory.active().item];
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
        this.viewModel.punch();
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
        this.audio.mobHit(mobHit.mob.pos, crit > 1 ? 1.5 : 1);
        if (crit > 1) {
          this.audio.ui(1480);
          // At the chest rather than at the feet: `mob.pos` is the base of the
          // body, and a burst down there is half swallowed by the ground. Sized
          // off the grown height the same way `knockMass` is, so a burst on a
          // calf is not floating above its head.
          const m = mobHit.mob;
          const h = m.baseHeight ? m.baseHeight * m.grown : m.spec.height;
          _v1.copy(m.pos).addScaledVector(this.player.up, h * 0.55);
          this.particles.critSpark(_v1, this.player.up);
          // And on the sight, which is where the eye already is in first person.
          // It is not redundant with the sparks: the two carry each other,
          // because the crosshair is hidden entirely in the third-person views
          // and the burst can land behind your own shoulder in them.
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
        if (killed && mobHit.mob.spec.hostile) this._mark('slayer');
        if (held?.tool) this.inventory.damageHeld(1);
      }
      // Right-click offers whatever you're holding. Feeding is how a herd
      // grows, and it's the only reason to keep an animal alive.
      const heldSlot = this.inventory.active();
      if (input.clicked[2] && input.locked && this.useCooldown === 0) {
        this.useCooldown = 0.3;
        // The merchant answers the same button, empty-handed or not — it is the
        // one creature you interact with rather than feed.
        if (mobHit.mob.spec.trader) {
          this.openScreen('shop', mobHit.mob);
        } else if (!heldSlot.empty && this.mobs.feed(mobHit.mob, heldSlot.item)) {
          this.inventory.consumeHeld(1);
          this.player.swing();
          this.viewModel.punch();
          this.ui.toast(mobHit.mob.baby > 0 ? 'Fed the calf' : 'Ready to breed',
            heldSlot.item, 1300);
        }
      }
      this.ui.setHint(this._feedHint(mobHit.mob));
      this.placeCooldown = Math.max(0, this.placeCooldown - dt);
      this.useCooldown = Math.max(0, this.useCooldown - dt);
      voxelUniforms.uBreakStage.value = -1;
      this.mining.key = null;
      this.mining.progress = 0;
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
    }

    // An over-tier block still shatters and drops nothing. Silently losing six
    // seconds to an iron vein reads as a broken game, so name the tool needed.
    // One chain, one winner. Setting a hint anywhere above this ran into the
    // unconditional clear at the end of it and lasted exactly zero frames.
    const needTool = hit ? harvestHint(hit.id, ITEMS[this.inventory.active().item]) : null;
    // Same argument as the line above it, for the other invisible tax. A player
    // who dives onto a lake bed and finds sand taking two thirds of a second a
    // block has no way to tell a rule from a broken timer, so the rule says so
    // itself, with the multiplier in it — and it says so while you are *aiming*
    // rather than only once you have already spent the breath.
    //
    // Gated on a breakable block so it is not a permanent caption on swimming;
    // water's own hardness is -1, so looking at the lake says nothing.
    const dragHint = hit && BLOCKS[hit.id]?.hardness >= 0 ? this._dragHint() : null;
    if (hit && IS_SIGN[hit.id]) {
      // Reading is looking: no key to press and nothing to open, so a row of
      // signs can be read by sweeping across them.
      const text = this.signs.get(hit.col * D + hit.k);
      this.ui.setHint(text ? `“${text}”` : 'A blank sign');
    } else if (hit && (hit.id === ID.bench || hit.id === ID.kiln || hit.id === ID.kiln_lit)) {
      this.ui.setHint(`<kbd>RMB</kbd> ${hit.id === ID.bench ? 'Craft' : 'Smelt'}`);
    } else if (needTool || dragHint) {
      // Both can be true — a wrong tool on a wet seam is the worst case in the
      // game and the one most likely to be read as broken — so neither hides
      // the other.
      this.ui.setHint([needTool, dragHint].filter(Boolean).join(' · '));
    } else this.ui.setHint(null);

    const m = this.mining;
    const heldDef = ITEMS[this.inventory.active().item];
    if (input.buttons[0] && hit && input.locked) {
      const key = hit.col * D + hit.k;
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
        if (Math.random() < dt * 10 / Math.sqrt(drag)) {
          this.particles.hitSpark(hit.point, hit.normal, hit.id);
          this.audio.dig(BLOCKS[hit.id].sound, hit.point);
        }
        if (this.player.swingT >= 1) { this.player.swing(); this.viewModel.punch(); }
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

    // --- eating: hold RMB on any food ---
    const heldSlot = this.inventory.active();
    const heldItem = ITEMS[heldSlot.item];
    if (heldItem?.food && input.buttons[2] && input.locked) {
      this.eating += dt;
      if (Math.random() < dt * 9) {
        this.audio.step('grass');
        this.particles.footDust(this.player.eye, this.player.up, ID.dirt);
      }
      if (this.eating >= 1.3) {
        this.eating = 0;
        this.energy = Math.min(1, this.energy + heldItem.food * FOOD_TO_ENERGY);
        this.player.health = Math.min(this.player.maxHealth, this.player.health + Math.ceil(heldItem.food * 0.35));
        this.inventory.consumeHeld(1);
        this.audio.pickup();
        this.ui.toast(`Ate ${heldItem.label}`, heldSlot.item, 1400);
      }
      return;
    }
    this.eating = 0;

    // --- bucket: scoop or pour ------------------------------------------
    // Handled before the `hit` gate below, because filling needs a ray that
    // *stops* on liquid — the ordinary interaction ray passes straight through
    // water, so a lake never registers as something you can click.
    if (input.clicked[2] && input.locked && this.useCooldown === 0
        && (heldSlot.item === itemIdOf('bucket') || heldSlot.item === itemIdOf('water_bucket'))) {
      this.useCooldown = 0.28;
      if (this._useBucket(heldSlot)) return;
    }

    // --- fishing: cast, wait, strike ------------------------------------
    if (heldItem?.tool?.kind === 'rod') {
      if (input.clicked[2] && input.locked && this.useCooldown === 0) {
        this.useCooldown = 0.3;
        this._rodClick();
      }
      this._tickFishing(dt);
      if (this.fishing) {          // holding the line: nothing else to do
        this.ui.setHint(this.fishing.bite > 0 ? 'A bite! Click.' : 'Waiting…');
        return;
      }
    } else if (this.fishing) {
      this._stopFishing();
    }

    if (input.clicked[2] && hit && input.locked && this.useCooldown === 0) {
      this.useCooldown = 0.22;
      if (hit.id === ID.bench) { this.openScreen('bench'); return; }
      if (hit.id === ID.kiln || hit.id === ID.kiln_lit) {
        this.openScreen('kiln', this._kilnAt(hit.col, hit.k));
        return;
      }
      if (hit.id === ID.crate) {
        this.openScreen('crate', this._crateAt(hit.col, hit.k));
        return;
      }
      if (hit.id === ID.bed) { this._useBed(hit.col, hit.k); return; }
      if (IS_DOOR[hit.id]) { this._toggleDoor(hit.col, hit.k); return; }
      if (IS_SIGN[hit.id]) { this._writeSign(hit.col, hit.k); return; }
      // --- till soil with a shovel ---
      if (heldItem?.tool?.kind === 'shovel' && this.farming.canTill(hit.id)) {
        this.farming.till(hit.col, hit.k);
        this.audio.place('soil');
        this.player.swing();
        this.viewModel.punch();
        this.inventory.damageHeld(1);
        return;
      }
      // --- sow seeds on farmland ---
      if (heldSlot.item === itemIdOf('seeds') && this.farming.plant(hit.col, hit.k)) {
        this.inventory.consumeHeld(1);
        this.audio.place('grass');
        this.player.swing();
        this.viewModel.punch();
        this.ui.toast('Planted', heldSlot.item, 1200);
        return;
      }
    }
    if (input.buttons[2] && hit && this.placeCooldown === 0 && input.locked) {
      this.placeCooldown = this._placeBlock(hit) ? 0.2 : 0.12;
    }
  }

  /**
   * One click of the rod: cast if the line is out of the water, strike if it
   * is in, and reel in empty-handed if you struck too early or too late.
   */
  _rodClick() {
    if (!this.fishing) {
      const wet = this.planet.raycast(
        this.player.eye, this.player.lookDir, this.player.reach + 3, { hitLiquid: true },
      );
      if (!wet || this.planet.at(wet.col, wet.k) !== ID.water) {
        this.ui.setHint('Cast at open water');
        return;
      }
      const c = this.planet.centerOf(wet.col, wet.k, new THREE.Vector3());
      this.fishing = {
        col: wet.col, k: wet.k, pos: c,
        wait: FISH_WAIT_MIN + Math.random() * (FISH_WAIT_MAX - FISH_WAIT_MIN),
        bite: 0, bob: 0,
      };
      this._showBobber(c);
      this.audio.splash(c);
      this.player.swing();
      this.viewModel.punch();
      return;
    }
    // Line is out. Striking during the bite window lands it.
    if (this.fishing.bite > 0) this._landCatch();
    else {
      this.ui.toast('Too soon.', itemIdOf('fishing_rod'), 1400);
      this._stopFishing();
    }
  }

  _tickFishing(dt) {
    const f = this.fishing;
    if (!f) return;
    // Wander off and the line comes in on its own, rather than fishing a lake
    // you are no longer standing beside.
    if (this.player.position.distanceTo(f.pos) > FISH_LEASH) { this._stopFishing(); return; }

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

    if (f.bite > 0) {
      f.bite -= dt;
      if (f.bite <= 0) {
        this.ui.toast('It got away.', itemIdOf('fishing_rod'), 1600);
        this._stopFishing();
      }
      return;
    }
    f.wait -= dt;
    if (f.wait <= 0) {
      f.bite = FISH_BITE_WINDOW;
      this.audio.splash(f.pos);
      this.particles.splash(f.pos, this.player.up, 0.7);
    } else if (Math.random() < dt * 0.7) {
      // the odd nibble, so the wait is not a blank stare
      this.particles.bubbles(f.pos, this.player.up, 1);
    }
    f.bob += dt;
    if (this.bobber) {
      // `centerOf` is the middle of the cell, and the water's surface is half a
      // cell above that — offsetting from the centre left the float sunk inside
      // the block, where it rendered as nothing at all.
      _v1.copy(f.pos).addScaledVector(this.player.up,
        BOBBER_FLOAT + Math.sin(f.bob * 2.2) * 0.05 - (f.bite > 0 ? 0.22 : 0));
      this.bobber.position.copy(_v1);
      this.bobber.visible = true;
      this._updateFishLine(_v1);
    }
  }

  /**
   * The line from the rod to the float.
   *
   * Without it the cast reads as a red ball someone left on the water: the rod
   * is in your hand, the float is ten feet out, and nothing says the two are
   * connected. The catch is that the rod lives in the view model's own scene
   * and has no position in the world at all, so there is nothing to anchor to.
   * Hanging the near end off the camera by the same offsets the rod is drawn at
   * puts it where the tip *looks*, which is all the eye is asking for.
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
    _v2.set(0.30, -0.24, -0.55).applyQuaternion(cam.quaternion).add(cam.position);
    const arr = this.fishLine.geometry.attributes.position.array;
    arr[0] = _v2.x; arr[1] = _v2.y; arr[2] = _v2.z;
    arr[3] = bobberPos.x; arr[4] = bobberPos.y; arr[5] = bobberPos.z;
    this.fishLine.geometry.attributes.position.needsUpdate = true;
    this.fishLine.visible = true;
  }

  _landCatch() {
    const f = this.fishing;
    if (!f) return;
    const roll = Math.random();
    let name = 'fish';
    if (roll > 0.93) name = ['amethyst', 'coin', 'coin', 'emerald'][(Math.random() * 4) | 0];
    else if (roll > 0.78) name = ['stick', 'seeds', 'clay'][(Math.random() * 3) | 0];
    const id = itemIdOf(name);
    const count = name === 'coin' ? 3 + ((Math.random() * 6) | 0) : 1;
    const taken = this.inventory.add(id, count);
    if (taken < count) {
      _v1.copy(this.player.position).addScaledVector(this.player.up, 0.8);
      this.drops.spawn(_v1.x, _v1.y, _v1.z, id, count - taken);
    }
    this.ui.toast(`Caught ${ITEMS[id]?.label}`, id, 2000);
    this.audio.pickup();
    this.stats.fished = (this.stats.fished ?? 0) + 1;
    this.inventory.damageHeld(1);
    this._stopFishing();
  }

  _showBobber(pos) {
    if (!this.bobber) {
      const geo = new THREE.SphereGeometry(0.09, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0xd94f3d });
      this.bobber = new THREE.Mesh(geo, mat);
      this.bobber.renderOrder = 6;
      this.scene.add(this.bobber);
    }
    _v1.copy(pos).addScaledVector(this.player.up, BOBBER_FLOAT);
    this.bobber.position.copy(_v1);
    this.bobber.visible = true;
  }

  _stopFishing() {
    this.fishing = null;
    if (this.bobber) this.bobber.visible = false;
    if (this.fishLine) this.fishLine.visible = false;
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
   * @returns {boolean} true if the bucket did something
   */
  _useBucket(heldSlot) {
    const empty = heldSlot.item === itemIdOf('bucket');
    // A ray that stops on liquid, which the normal interaction ray does not.
    const wet = this.planet.raycast(
      this.player.eye, this.player.lookDir, this.player.reach, { hitLiquid: true },
    );

    if (empty) {
      if (!wet || wet.id !== ID.water) return false;
      const key = this.water.key(wet.col, wet.k);
      // Only a spring fills a bucket. Flowing water shares the block id with
      // standing water — the difference is the level, not the block — so this
      // used to accept the far end of a trickle and hand back a full bucket.
      // Since pouring makes a permanent spring, that turned one bucket into
      // unlimited springs: pour, let it run six cells, scoop the trickle, and
      // you are up one source with the original still running. Water that never
      // drains and can be multiplied is a planet under water.
      if (!this.water.sources.has(key)) {
        this.ui.setHint('Too shallow to scoop');
        return false;
      }
      this._applyEdits([{ col: wet.col, k: wet.k, id: 0 }]);
      this.water.sources.delete(key);
      // Belt and braces: a source has no level entry, so this normally does
      // nothing. It matters if one is ever left behind, because a stale level
      // on a dry cell reads as flowing water to everything that asks.
      this.water.level.delete(key);
      this.water.onEdit(wet.col, wet.k);
      this.inventory.consumeHeld(1);
      this.inventory.add(itemIdOf('water_bucket'), 1);
      this.inventory.changed();
      this.audio.splash();
      this.player.swing();
      this.viewModel.punch();
      return true;
    }

    // Pouring: take the empty cell the ray entered through, so water lands in
    // front of a wall rather than replacing it.
    const target = wet && wet.prevCol >= 0 ? { col: wet.prevCol, k: wet.prevK } : null;
    if (!target) return false;
    if (this.planet.at(target.col, target.k) !== 0) return false;
    // Pouring at your own feet is allowed on purpose. It's what you'd expect,
    // it's how you break a fall or make a climb, and it can't strand you: the
    // source is a single static cell you can scoop straight back up.
    this._applyEdits([{ col: target.col, k: target.k, id: ID.water }]);
    // Poured water is a spring, not a puddle: it feeds a flow and never drains.
    this.water.addSource(target.col, target.k);
    this.inventory.consumeHeld(1);
    this.inventory.add(itemIdOf('bucket'), 1);
    this.inventory.changed();
    this.audio.splash();
    this.player.swing();
    this.viewModel.punch();
    return true;
  }

  /**
   * How exposed to the sky the player is, 0 (fully covered) to 1 (open air).
   * Counts solid cells in the player's own column above their head; a couple of
   * blocks of leaf canopy should still let some rain through, a rock ceiling
   * should not.
   */
  _skyExposure() {
    const c = this.player.cell;
    const col = cidx(c.f, Math.min(F - 1, Math.max(0, Math.floor(c.ci))),
      Math.min(F - 1, Math.max(0, Math.floor(c.cj))));
    let blocked = 0;
    for (let k = Math.floor(c.ck) + 2; k < D; k++) {
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
    voxelUniforms.uFogDensity.value = this.player.headInWater ? 0 : 0.0013 * Math.min(1.9, w.fog);
    voxelUniforms.uCamPos.value.copy(this.camera.position);
    voxelUniforms.uUnderwater.value = this.player.headInWater ? 1 : 0;
    if (this.player.headInWater) {
      // tie the murk to the sky so night dives are properly dark
      const lit = 0.25 + p.sunIntensity * 0.5;
      voxelUniforms.uWaterFog.value.setRGB(0.03 * lit, 0.17 * lit, 0.26 * lit);
      voxelUniforms.uWaterTint.value.setRGB(0.30 * lit, 0.66 * lit, 0.72 * lit);
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

  _updateAudio() {
    // Listener rides the camera. On a sphere the up vector is the player's own
    // local up — feeding world +Y here would swing the stereo image as you walk
    // round the planet.
    const cam = this.camera;
    cam.getWorldDirection(_v1);
    _v2.copy(this.player.up);
    this.audio.setListener(
      cam.position.x, cam.position.y, cam.position.z,
      _v1.x, _v1.y, _v1.z,
      _v2.x, _v2.y, _v2.z,
    );

    const alt = Math.max(0, this.player.position.length() - R_SEA);
    const openness = THREE.MathUtils.clamp(alt / 8, 0, 1);
    this.audio.setAmbience({
      wind: (0.3 + openness * 0.7) * (0.6 + this.weather.wind * 0.5),
      water: this._nearLiquid() * 0.6 + this.weather.precip * 0.8,
      cave: 1 - openness,
      underwater: this.player.headInWater ? 1 : 0,
    });
  }

  _nearLiquid() {
    const c = this.player.cell;
    const col = cidx(c.f, Math.min(F - 1, Math.floor(c.ci)), Math.min(F - 1, Math.floor(c.cj)));
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const nb = colNeighbor(col, d);
      for (let dk = -1; dk <= 1; dk++) if (this.planet.liquidAt(nb, Math.floor(c.ck) + dk)) n++;
    }
    return Math.min(1, n / 6);
  }

  _updateHud(biomeId) {
    this.ui.updateVitals(this.player.health, this.player.maxHealth, this.breath, this.player.stamina, this.energy);
    this.ui.updateStatus(this.timeOfDay(), biomeId, this.weather.label, this.seasons);
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
        `face ${c.f}  i ${c.ci.toFixed(2)}  j ${c.cj.toFixed(2)}  k ${c.ck.toFixed(2)}\n` +
        `alt  ${(this.player.position.length() - R_SEA).toFixed(1)}\n` +
        `draw ${info.render.calls}   tris ${(info.render.triangles / 1000).toFixed(0)}k\n` +
        `chunks ${this.planet.meshes.size}   drops ${this.drops.list.length}\n` +
        `sun ${this.sky.elevation?.toFixed(2)}   ${this.weather.state} ${(this.weather.precip * 100) | 0}%\n` +
        `grnd ${this.player.grounded ? 'y' : 'n'}  water ${this.player.inWater ? 'y' : 'n'}  ${(this.playtime / 60) | 0}m`,
      );
    }
  }
}

window.game = new Game();
