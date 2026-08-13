// DOM layer: main menu, compact HUD, inventory / crafting / smelting screens.

import * as THREE from 'three';
import { BLOCKS, R_CROSS } from '../world/Blocks.js';
import { ITEMS } from '../game/Items.js';
import { Slot, HOTBAR, TOTAL } from '../game/Inventory.js';
import { BRANCHES } from '../game/Skills.js';
import { findRecipe, availableRecipes, craftFromInventory } from '../game/Recipes.js';
import { itemIdOf } from '../game/Items.js';
import {
  COIN_ITEM, buyPriceOf, sellPriceOf, canSell, buyFrom, sellTo, coinsOf, fulfilRequest,
} from '../game/Trade.js';
import * as Character from '../player/Character.js';
import { CharacterPicker, CHARACTER_IDS, characterUrl } from '../player/Character.js';
import { Save } from '../game/Save.js';
import { BIOME_COLORS, R_SEA, F, cidx } from '../world/Constants.js';
import { patchColumn } from '../world/Sphere.js';
import { compassFrame } from '../render/Sky.js';

const BIOME_NAMES = ['Ocean', 'Shore', 'Plains', 'Woodland', 'Taiga', 'Desert', 'Savanna', 'Tundra', 'Snowfield', 'Highlands', 'Meadow', 'Badlands'];

/**
 * Who the fifteen are, if `Character.js` has not said yet.
 *
 * The names belong to the character module and are imported from it through
 * the namespace above rather than as a named binding, because a missing named
 * export is a *build* error in rollup and this file must not be the thing that
 * fails while that one is being written. This table is the fallback, keyed by
 * the same ids, and it is only ever read for an id the module did not name.
 * Delete it once `CHARACTER_NAMES` is landed and complete.
 */
const FALLBACK_NAMES = {
  a: 'Ama', b: 'Bran', c: 'Cass', e: 'Elu', f: 'Fen',
  g: 'Gale', h: 'Hob', i: 'Isa', j: 'Juno', k: 'Kite',
  m: 'Mira', n: 'Nell', p: 'Pike', q: 'Quill', r: 'Rook',
};

/** Whatever this character is called, by whoever is willing to say. */
export function characterName(id) {
  const key = String(id || CHARACTER_IDS[0]);
  return Character.CHARACTER_NAMES?.[key] || FALLBACK_NAMES[key] || key.toUpperCase();
}

/**
 * What a player may bring with them, and the keys the game side turns into
 * stacks.
 *
 * One list, exported, because the alternative is the picker knowing a set of
 * strings and the world builder knowing the same set again. `items` is
 * `[itemName, count]` pairs in `Items.js`'s own naming, so the game side
 * resolves them with `itemIdOf` and never has to agree with this file about
 * anything but a key.
 *
 * The torches are in here rather than granted unconditionally: they were the
 * one fixed thing every new planet started with, and the whole point of the
 * screen is that the player decides instead.
 */
export const LOADOUT_OPTIONS = [
  { key: 'torches', label: 'Torches', items: [['torch', 6]] },
  { key: 'pick', label: 'Pickaxe', items: [['stone_pick', 1]] },
  { key: 'axe', label: 'Axe', items: [['stone_axe', 1]] },
  { key: 'shovel', label: 'Shovel', items: [['stone_shovel', 1]] },
  { key: 'sword', label: 'Sword', items: [['stone_sword', 1]] },
  { key: 'bow', label: 'Bow', items: [['bow', 1], ['arrow', 16]] },
  { key: 'rod', label: 'Rod', items: [['fishing_rod', 1]] },
];

/** How many of the above one player may take. */
export const LOADOUT_MAX = 3;

/**
 * What every new game opens with selected: the torches, every time.
 *
 * They are a real pick and they spend one of the three, which leaves two free
 * and a third press refused. That refusal is the whole reason the tiles have to
 * say "shut" loudly when the row comes back: the way to take a third tool is to
 * press the torches off, and a screen that only dims a little when you reach
 * the limit is a screen that looks broken instead of full.
 *
 * `openCharacterPicker` copies this into `_loadout` on every open rather than
 * only in the constructor, so this really is what a new game starts from and
 * not what the last visit to the picker happened to leave behind.
 */
export const DEFAULT_LOADOUT = ['torches'];

/**
 * Mob damage, and nothing else, for the first three. The game side owns what
 * the keys are worth.
 *
 * Extreme is the one that is not only a multiplier — the animals hunt you, the
 * dark is fuller, and a death ends the run — and it still gets one word here
 * like the other three. The screen has one caption per control and no prose to
 * explain any of it in, which is a rule the player has asked for three times;
 * "Extreme" is a word every player already knows the shape of, and the world is
 * the place to find out the details.
 */
export const DIFFICULTIES = [
  { key: 'easy', label: 'Easy' },
  { key: 'normal', label: 'Normal' },
  { key: 'hard', label: 'Hard' },
  { key: 'extreme', label: 'Extreme' },
];
export const DEFAULT_DIFFICULTY = 'normal';

/**
 * What dying costs, as two buttons in a segmented bar.
 *
 * One control for the bag and the ladder together, because that is the one
 * sentence the player said. The labels name the outcome and stop: "Lose all" is
 * the game as it has always been, "Keep all" is Minecraft's keepInventory with
 * the xp included. No caption underneath saying which is which; the caption
 * above is "On death" and the two words after it are the whole rule.
 */
export const DEATH_RULES = [
  { key: 'lose', label: 'Lose all' },
  { key: 'keep', label: 'Keep all' },
];
export const DEFAULT_ON_DEATH = 'lose';

// Scratch for the pack bearing, which runs once a frame.
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _here = new THREE.Vector3();
const _there = new THREE.Vector3();

// Colours go in as plain `#rrggbb` — pre-encoding them as %23 then running
// encodeURIComponent double-escapes the %, which yields an invalid fill and
// silently renders every pip black.
const pip = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const HEART = (fill, o = 1) => pip(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 21s-7.6-4.8-9.5-9.2C1 8.2 3 4.7 6.6 4.7c2 0 3.5 1.1 4.3 2.3h2.2c.8-1.2 2.3-2.3 4.3-2.3 3.6 0 5.6 3.5 4 7.1C19.6 16.2 12 21 12 21z' fill='${fill}' fill-opacity='${o}' stroke='rgba(0,0,0,.5)' stroke-width='1.3'/></svg>`);
const HEART_FULL = HEART('#e2453f');
const CRUMB = (on) => pip(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 4c4.4 0 7.6 3 7.6 6.6 0 4.4-3.4 7.2-7.6 9.4C7.8 17.8 4.4 15 4.4 10.6 4.4 7 7.6 4 12 4z' fill='${on ? '#e8a83f' : '#2a2118'}' fill-opacity='${on ? 1 : 0.45}' stroke='rgba(0,0,0,.5)' stroke-width='1.3'/></svg>`);
const BUBBLE = (on) => pip(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='8.6' fill='${on ? '#79c8f0' : '#223040'}' stroke='rgba(0,0,0,.45)' stroke-width='1.4'/><circle cx='9' cy='9' r='2.4' fill='rgba(255,255,255,.6)'/></svg>`);
// Stamina had no glyph — it was a bare 2px sliver with nothing to name it.
const STAMINA_ICON = pip(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M13.4 2.2 4.6 13.6h5.3l-1.1 8.2 9-11.6h-5.4l1-8z' fill='#ffcf6b' stroke='rgba(0,0,0,.5)' stroke-width='1.3' stroke-linejoin='round'/></svg>`);

// --- minimap ----------------------------------------------------------------

/**
 * Samples across the map, and the column stride between them.
 *
 * Odd, so the player sits *on* a sample rather than between four of them — a
 * map whose centre pixel is not where you are standing is a map that lies about
 * the one thing it definitely knows.
 *
 * Raised from 81 with the frame going square, and the arithmetic is worth
 * writing down because the two changes are the same change. The canvas is now
 * drawn `MAP_CANVAS_PCT` wider than the window it turns inside, so the window
 * only ever shows `1 / 1.48` of it: at 81 samples the *visible* map would have
 * shrunk from 77 world units across to 52, which is a map of your own feet.
 * 115 columns at a stride of one covers ±57, and a column at sea level is 0.955
 * world units across (`cellArc(282)`), so the frame still shows about 74 units
 * — the same couple of minutes' walk it always did. It also still upscales by
 * under 2x, which is the difference between a map and a blur.
 *
 * Measured, because a per-frame budget was the reason not to use a second
 * camera: one full sample pass was 0.35ms at 81 (60 passes across all six
 * faces, warm), and the field is 2.0x the samples, so call it 0.7ms. That is
 * the entire cost of the feature and it is not paid per frame —
 * see `updateMinimap` — which works out at 5.6ms per second of *sprinting* and
 * nothing at all while you stand still.
 */
const MAP_SAMPLES = 115;
const MAP_STEP = 1;
const MAP_RADIUS = ((MAP_SAMPLES - 1) / 2) * MAP_STEP;

/**
 * How wide the canvas is drawn, as a fraction of the frame it turns inside.
 *
 * The map is a square now, and a square window onto a picture that rotates
 * under it has one hard geometric requirement: the frame's own corners are
 * `sqrt(2)/2` of its width from the centre, so at 45 degrees a canvas drawn at
 * 100% has run out before the corner has. Anything under `sqrt(2)` clips, and
 * it clips as two empty triangles sweeping round the frame as you turn, which
 * is the exact failure a round frame was hiding.
 *
 * 1.48 is that bound plus six points, and the spare is not slack for its own
 * sake: drawn at the exact size the outermost sampled row lands *on* the visible
 * edge, where the bilinear upscale has nothing beyond it to blend with, and a
 * hairline of half-transparent pixels appears along it.
 *
 * The same number is written once in the stylesheet, on `#mm-canvas`, as a
 * percentage of the frame — so shrinking the frame in a media query cannot
 * break the coverage. `mapCoversRotation` is the assertion that ties the two
 * together, and it is checked without a DOM.
 */
export const MAP_CANVAS_PCT = 1.48;

/** Does a canvas `pct` of the frame across still cover it at every angle? */
export const mapCoversRotation = (pct = MAP_CANVAS_PCT) => pct >= Math.SQRT2;

/**
 * Where the north pip sits on a square frame, at angle `at` from the centre.
 *
 * On the old disc this was `cos`/`sin` times a radius and every direction was
 * the same distance out. A square has no single radius: the pip has to ride
 * the inside of the frame, which means projecting the unit direction onto the
 * square by dividing by whichever of `|cos|`/`|sin|` is larger. Due north puts
 * it at the middle of an edge, north-east in a corner, and it slides between
 * the two as the map turns rather than orbiting inside the frame and leaving a
 * visible gap along the edges.
 *
 * @param {number} at radians, 0 along +x, y downward as in image space
 * @param {number} half half the frame's inner width, in px
 * @returns {{x: number, y: number}}
 */
export function northPip(at, half) {
  const c = Math.cos(at);
  const s = Math.sin(at);
  const m = Math.max(Math.abs(c), Math.abs(s));
  if (m < 1e-9) return { x: 0, y: 0 };
  const k = half / m;
  return { x: c * k, y: s * k };
}

/**
 * Shortest gap between two redraws, in ms.
 *
 * The map's content depends on nothing but which column you are standing in —
 * `colHeight` and `colBiome` are worldgen's own tables and no block you place
 * ever changes them — so the redraw trigger is simply "the centre column
 * changed". Sprinting crosses 6.8 columns a second, which would be 6.8 half-
 * millisecond spikes a second; this caps it at eight, and because the map is
 * 115 columns wide a fifth of a second of walking moves the picture by under 1%
 * of its own width.
 */
const MAP_REDRAW_MS = 120;
/**
 * Half the frame's inner width, in px, which is where the north pip rides.
 *
 * Read off the element rather than written down would be one layout read per
 * frame for a box that never moves; the stylesheet's frame is 152px and the
 * pip is inset far enough to keep the glyph inside its own corner ticks.
 */
const MAP_RIM = 62;

/**
 * How much to lift the biome palette for the map.
 *
 * `BIOME_COLORS` are tints the mesher multiplies into an albedo tile, not
 * colours anything was ever meant to be painted with directly — taken raw they
 * come out as a set of muddy midtones with no separation between plains,
 * woodland and meadow. A 1/1.3 gamma pulls them apart without inventing a
 * second palette that would then have to be kept in step with the world's.
 */
const MAP_GAMMA = 1 / 1.3;

/**
 * The two numbers that give the lifted palette its body back, and why there
 * are two of them rather than one.
 *
 * `MAP_GAMMA` above pulls the biome tints apart, and it does it by pushing
 * every one of them upward: a gamma under 1 is a curve that raises midtones
 * and cannot do anything else. Against the old near-black frame that was free,
 * because everything on the map was lighter than the thing around it. The
 * frame is parchment now, and a set of raised midtones inside a light mount is
 * a map you have to look for. Both of these run once per redraw over 13k
 * samples, which is eight times a second at a dead sprint and nothing at all
 * while standing still.
 *
 * `MAP_SAT` pushes each sample away from its own grey. Terrain tints are all
 * within a few points of each other in luminance, so colour is what actually
 * separates a meadow from a beach, and it is the cheapest separation there is.
 *
 * `MAP_CONTRAST` then stretches around `MAP_PIVOT` rather than around 0.5. The
 * pivot sits above the middle deliberately: it is roughly where the lifted
 * palette's midtones land, so the stretch pulls the bulk of the map *down*
 * away from the parchment while leaving snow and beach at the top of the range
 * where they belong.
 */
const MAP_SAT = 1.32;
const MAP_CONTRAST = 1.2;
const MAP_PIVOT = 0.58;

// --- compass ----------------------------------------------------------------

/** Pixels per degree on the strip, and half the visible window. */
const CMP_PX = 3.2;
const CMP_HALF = 160;
/**
 * Where the compass gives up, as |Y × up| — see `compassFrame`, which is where
 * this number's meaning lives.
 *
 * These used to be 19° and 31° of latitude, derived from the reference-axis
 * swap the frame no longer has: 5% of the planet with no bearing and 14%
 * dimmed, and because `WorldGen.climate` bands on |dy| that was exactly the
 * snowfields, where a white horizon makes a bearing worth most. The frame is
 * continuous now, so the only thing left to hide from is the *rate*: |Y × up|
 * is the sine of the angle down from the pole, so walking a great circle past
 * the pole turns the bearing at about 1/polar degrees per radian of travel.
 * Measured on that traverse at sprint speed 6.8:
 *
 *   polar 0.50  (148 blocks out)   0.35°/block     2°/s
 *   polar 0.050 (14 blocks)        4.05°/block    28°/s
 *   polar 0.010 (2.8 blocks)      19.89°/block   135°/s
 *
 * At CMP_PX 3.2 that is 90 px/s against a 320px window at fifteen blocks, and
 * 432 px/s — a window and a third every second — at three. The first is a
 * strip; the second is not. So: lit to 15 blocks of the pole, out by 3, both
 * written as block distances against R_SEA because that is what they were
 * chosen as. 3 blocks is a cap of 0.61° of latitude, 6e-5 of the planet's
 * surface across both poles, against 5% before.
 */
export const POLAR_HIDE = 3 / R_SEA;
export const POLAR_FULL = 15 / R_SEA;

/** Scratch for the navigation HUD, which runs once a frame. */
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _cellF = { i: 0, j: 0 };
const _cellN = { i: 0, j: 0 };

/**
 * The player's heading as a bearing in degrees, 0 due north and 90 due east,
 * plus how much of a frame that bearing came out of.
 *
 * Pulled out of the HUD as a plain function so it can be checked against the
 * sun without a browser: `Sky.setSolarTime` builds the sunrise direction out of
 * the same `east` this reads, so "the sun rises at 090" is a property that can
 * be asserted rather than eyeballed. `east` and `north` are written through for
 * the caller — the minimap's north pip wants the vector, not the angle.
 *
 * @param {THREE.Vector3} up radial, unit
 * @param {THREE.Vector3} forward the player's tangential heading, unit
 */
export function bearingOf(up, forward, east = _east, north = _north) {
  const polar = compassFrame(up, east, north);
  const deg = (Math.atan2(forward.dot(east), forward.dot(north)) * 180 / Math.PI + 360) % 360;
  return { deg, polar };
}

/** How lit the compass is at this distance from the pole, 0..1. */
export const compassLit = (polar) =>
  Math.max(0, Math.min(1, (polar - POLAR_HIDE) / (POLAR_FULL - POLAR_HIDE)));

/**
 * The columns the map samples around (f, i, j), row-major, `dj` outer.
 *
 * THE CONVENTION, and it is the whole of what the map has to get right: on the
 * unrotated image +i runs to the right and **+j runs UP**, i.e. `dj` decreases
 * as the image row index increases. That is not a taste: `Sphere.js` picks its
 * face bases so that R x U = N (outward), so (ea, eb, up) is right handed, and
 * a top-down picture of the ground seen from above is only unmirrored when its
 * screen-right and screen-up axes cross to `up` the same way. Writing +j down
 * the image instead makes the picture a reflection, and no rotation can undo a
 * reflection: it was measured as agreeing with the world at 0 of 12 heading and
 * site combinations, and agreeing at 12 of 12 once the reader mirrored itself
 * back. `updateMinimap` derives its CSS rotation from this same convention, so
 * the two cannot be flipped independently.
 *
 * `patchColumn` rather than a walk with `colNeighbor`, and rather than any
 * arithmetic at all on a column index — the seams are real and index arithmetic
 * across one is a bug this codebase has already paid for. Of the two safe
 * options it is the right one here for the reason its own comment gives: it
 * extends the *centre's* face coordinates outward and resolves them through
 * world space, so a patch this wide stays one continuous sheet, where a walk
 * re-anchors into each new face's axes and peels the far side of the patch off
 * sideways.
 *
 * That is not a hunch, it is the measurement that decided it. Over every face,
 * every edge and all eight cube corners, at this radius: walking loses up to
 * 49% of its 6561 samples to duplicates (worst at a cube corner — half the map
 * would be the same column drawn twice), and this loses 6%. What it costs
 * instead is reach: past a cube edge the centre's extended coordinates and the
 * neighbour's own drift apart, so the far corner of the patch stretches to
 * 1.14x its ideal angle. A map being a seventh generous about distance near a
 * seam is what every flat projection of a sphere does; a map folded back on
 * itself is not a map. It also can never leave the grid — `patchColumn`
 * resolves through `dirToFace`, which by construction lands on a real face.
 */
export function mapColumns(f, i, j, out = new Int32Array(MAP_SAMPLES * MAP_SAMPLES)) {
  const N = MAP_SAMPLES;
  for (let sy = 0; sy < N; sy++) {
    const dj = (MAP_RADIUS - sy) * MAP_STEP;
    for (let sx = 0; sx < N; sx++) {
      out[sy * N + sx] = patchColumn(f, i, j, (sx - MAP_RADIUS) * MAP_STEP, dj);
    }
  }
  return out;
}

const $ = (id) => document.getElementById(id);

/**
 * Seconds of play, as something a player recognises their own world by.
 *
 * Rounded hard on purpose: "3h 20m" is the fact, "3h 22m 41s" is a stopwatch.
 */
function playedFor(seconds) {
  const s = Math.max(0, seconds | 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return 'a few seconds';
}

/**
 * How long ago a slot was written, in the coarsest unit that is still true.
 *
 * A date would be exact and useless: what tells two of your own planets apart
 * is that one is from this afternoon and the other from last month.
 */
function agoText(at) {
  const ms = Date.now() - (at || 0);
  if (!(at > 0) || ms < 0) return 'recently';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export class UI {
  constructor(game) {
    this.game = game;
    this.icons = null;
    this.screen = null;               // null | 'inventory' | 'bench' | 'kiln' | 'shop'
    this.stationPos = null;
    this.kiln = null;                 // active kiln state object
    this.shop = null;                 // the merchant being traded with
    this._nameTimer = null;
    this._critTimer = null;
    this._cursorXY = { x: 0, y: 0 };

    this.el = {
      loader: $('loader'), loadFill: $('load-fill'), loadStatus: $('load-status'),
      menu: $('menu'), mmContinue: $('mm-continue'),
      hud: $('hud'), crosshair: $('crosshair'), hotbar: $('hotbar'), offhand: $('offhand'),
      itemName: $('item-name'), lookAt: $('look-at'),
      vHealth: $('v-health'), vFood: $('v-food'),
      vStamina: $('v-stamina'), vBreath: $('v-breath'),
      clockDial: $('clock-dial'), clockText: $('clock-text'),
      chipWeather: $('chip-weather'), chipBiome: $('chip-biome'), chipSeason: $('chip-season'),
      chipPack: $('chip-pack'), packDist: $('pack-dist'), chipSave: $('chip-save'),
      pzQuit: $('pz-quit'),
      toasts: $('toasts'), debug: $('debug'), hint: $('hint'),
      fishBar: $('fish-bar'),
      screenEl: $('screen'), screenTitle: $('screen-title'), screenTop: $('screen-top'),
      invMain: $('inv-main'), invHot: $('inv-hot'),
      cursor: $('cursor-stack'), tooltip: $('tooltip'),
      recipePanel: $('recipe-panel'),
      recipeList: $('recipe-list'), recipeCount: $('recipe-count'), recipeEmpty: $('recipe-empty'),
      pause: $('pause'), settings: $('settings'), controls: $('controls'), death: $('death'),
      deathCause: $('death-cause'), deathLost: $('death-lost'), dzRespawn: $('dz-respawn'),
      // The two clusters a spectator has no use for: what is left of a body,
      // and what it was carrying. Held by id so `setSpectator` can put them
      // away without a stylesheet rule of its own — `hidden` is the class the
      // whole interface already uses for exactly this.
      vitals: $('vitals'), bottom: $('bottom'),
      slots: $('slots'), slotList: $('slot-list'), slotsTitle: $('slots-title'),
      chargen: $('chargen'), cgCanvas: $('cg-canvas'), cgStatus: $('cg-status'),
      cgWho: $('cg-who'), cgKit: $('cg-kit'), cgKitCount: $('cg-kit-count'),
      cgDiff: $('cg-diff'),
      skills: $('skills'), skPoints: $('sk-points'), skSub: $('sk-sub'),
      skTree: $('sk-tree'),
      confirm: $('confirm'), cfTitle: $('cf-title'), cfBody: $('cf-body'),
      cfYes: $('cf-yes'), cfNo: $('cf-no'),
    };

    /** The New Game answers, until Begin sends them. */
    this._loadout = [...DEFAULT_LOADOUT];
    this._difficulty = DEFAULT_DIFFICULTY;
    this._deathRule = DEFAULT_ON_DEATH;
    /** Resolver of the confirm currently on screen, or null. */
    this._cfResolve = null;
    this._cfKey = (e) => this._confirmKey(e);

    /** Built the first time New Game is pressed, and kept — see `CharacterPicker.close`. */
    this._picker = null;
    this._chosen = null;
    this._cgKey = (e) => this._characterKey(e);
    /** 'continue' or 'new': what clicking a slot row means right now. */
    this._slotMode = 'continue';
    this._slotKey = (e) => { if (e.key === 'Escape') { this.closeSlots(); e.preventDefault(); e.stopPropagation(); } };

    this._buildNavigation();
    this._bind();
    this._buildSlots();
  }

  // --- navigation: the minimap and the compass ------------------------------

  /**
   * Build the minimap, the compass strip, their two settings rows and their
   * line in the Controls sheet.
   *
   * Every other piece of chrome in this game is in `index.html` and this is
   * deliberately not, which wants explaining rather than hiding: this change
   * was scoped to the UI, player and main modules and the markup file belongs
   * to nobody, so putting a hundred lines of `<i>` in it was a merge waiting to
   * happen. Nothing here is dynamic — it is all built once and never rebuilt —
   * so a later pass can lift it into the markup verbatim and delete this
   * method, and it should.
   */
  _buildNavigation() {
    const hud = $('hud');

    // ---- minimap -----------------------------------------------------------
    const map = document.createElement('div');
    map.id = 'minimap';
    map.className = 'hidden';
    const cv = document.createElement('canvas');
    cv.id = 'mm-canvas';
    // The backing store is one pixel per sampled column and the CSS box is
    // `MAP_CANVAS_PCT` of the 152px frame, so the browser's own bilinear filter
    // does the upscale. Drawing at the display size directly would mean either
    // 225 columns of samples (four times the work for detail finer than the
    // terrain has) or nearest-neighbour blocks the size of a fingernail.
    cv.width = MAP_SAMPLES;
    cv.height = MAP_SAMPLES;
    const north = document.createElement('b');
    north.id = 'mm-north';
    north.textContent = 'N';
    const me = document.createElement('i');
    me.id = 'mm-me';
    map.append(cv, north, me);
    hud.appendChild(map);

    this._mmCtx = cv.getContext('2d');
    this._mmImage = this._mmCtx.createImageData(MAP_SAMPLES, MAP_SAMPLES);
    // Reused between passes rather than reallocated: the colour of a sample
    // depends on its neighbours' heights, so the whole field has to be gathered
    // before any of it can be shaded.
    this._mmH = new Float32Array(MAP_SAMPLES * MAP_SAMPLES);
    this._mmB = new Uint8Array(MAP_SAMPLES * MAP_SAMPLES);
    this._mmCols = new Int32Array(MAP_SAMPLES * MAP_SAMPLES);
    /** Centre column of the picture currently on the canvas, or -1 for none. */
    this._mmCol = -1;
    this._mmAt = 0;
    this._mmTurn = null;

    // ---- compass -----------------------------------------------------------
    const cmp = document.createElement('div');
    cmp.id = 'compass';
    cmp.className = 'hidden';
    const win = document.createElement('div');
    win.className = 'cmp-win';
    const track = document.createElement('div');
    track.className = 'cmp-track';
    // Three turns of marks, so the window never runs off either end and the
    // strip never has to jump to rewrap. The window is 100° wide and the
    // translate below keeps the middle turn under it, which leaves 310° of
    // slack on each side — the wrap happens 260° away from anything visible.
    const CARDINAL = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let turn = -1; turn <= 1; turn++) {
      for (let a = 0; a < 360; a += 15) {
        const label = CARDINAL[a];
        const e = document.createElement(label ? 'b' : 'i');
        if (label) e.textContent = label;
        e.className = a % 90 === 0 ? 'card' : label ? 'inter' : 'tick';
        e.style.left = `${(turn * 360 + a + 360) * CMP_PX}px`;
        track.appendChild(e);
      }
    }
    win.appendChild(track);
    const notch = document.createElement('u');
    notch.className = 'cmp-notch';
    // No cap element of any kind. It used to read "Pole" and was then emptied,
    // but an empty one is worse than either: `#compass.polar` in style.css
    // forces opacity to 1 and swaps the strip for it, so a blank parchment
    // plate snapped in at full brightness exactly where the fade was supposed
    // to be finishing. The cap is now three blocks wide (see POLAR_HIDE), so
    // there is nothing left to announce - the strip just fades to nothing.
    cmp.append(win, notch);
    hud.appendChild(cmp);

    this._cmpTrack = track;
    this._cmpTurn = null;

    this.el.minimap = map;
    this.el.mmNorth = north;
    this.el.compass = cmp;

    // The two settings rows and the Controls line these used to build in here
    // now live in `index.html` beside every other setting and binding, which is
    // what the note above asked the next pass to do. They were injected because
    // the change that added them was scoped away from the markup; that reason
    // expired, and a settings screen assembled from two files is a settings
    // screen nobody can read end to end.
  }

  /**
   * The compass strip: where the player is facing, as a bearing.
   *
   * There is no yaw to read here and there could not be — `player.forward` is a
   * world vector living in a tangent plane that is different at every point on
   * the planet, so a "yaw" is only ever an angle against a local basis and says
   * nothing about which way you are walking. The bearing is rebuilt from the
   * sky's own east/north frame instead, which is the same frame the sun's arc
   * is constructed from, so the strip and the sunrise cannot disagree. See
   * `compassFrame`.
   */
  updateCompass(player) {
    const el = this.el.compass;
    if (this.game.settings.compass === false) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');

    const { deg, polar } = bearingOf(player.up, player.forward);
    // Fade rather than cut, so walking into the cap is a compass quietly
    // giving up over the last twelve blocks of approach (about three seconds
    // at a walk) instead of a HUD element blinking out from under you. It is
    // also what keeps the strip from snapping: the bearing is still turning
    // fast in there, and it dims as it speeds up.
    const lit = compassLit(polar);
    el.style.opacity = lit.toFixed(2);
    if (lit <= 0) return;

    // Quantised to a tenth of a degree before the compare. Written every frame
    // it is a style recalc sixty times a second for a strip that has not moved,
    // and standing still still jitters the bearing in the last decimal.
    const turn = Math.round(deg * 10);
    if (turn === this._cmpTurn) return;
    this._cmpTurn = turn;
    this._cmpTrack.style.transform =
      `translateX(${(CMP_HALF - (deg + 360) * CMP_PX).toFixed(1)}px)`;
  }

  /**
   * The minimap.
   *
   * Drawn into a canvas by sampling worldgen's own per-column tables, not by
   * rendering the scene a second time from above. A second camera is a whole
   * extra pass over the terrain every frame on a game already sitting at 56-60
   * fps with a 1.6 GB heap, to show a top-down view of ground the player has
   * mostly not built anything on; this costs half a millisecond and only when
   * you have actually walked somewhere.
   *
   * Heading-up rather than north-up, which is what makes it worth having on a
   * sphere: the map turns with you, and the north the compass is using rides
   * the frame rather than being nailed to the top. So the two agree — they are
   * reading the same frame — without the map being useless in the polar cap
   * where that frame runs out.
   *
   * The rotation is CSS on the canvas element, not a transform on the drawing.
   * The picture is only redrawn when the centre column changes; turning on the
   * spot must therefore cost a `transform` write and nothing else.
   *
   * The frame is square, and that is a geometry problem rather than a
   * `border-radius` one: a square window onto a turning picture shows empty
   * corners unless the picture covers the window's *diagonal*. See
   * `MAP_CANVAS_PCT`, which is where the coverage lives, and `northPip`, which
   * is how a pip rides a square instead of orbiting a circle.
   */
  updateMinimap(planet, player) {
    const el = this.el.minimap;
    const c = player.cell;
    const i = Math.min(F - 1, Math.max(0, Math.floor(c.ci)));
    const j = Math.min(F - 1, Math.max(0, Math.floor(c.cj)));
    const col = cidx(c.f, i, j);
    // colHeight is filled in one go before any voxel arrives, so a zero here
    // means the world has not handed its tables over yet — not sea level.
    const on = this.game.settings.minimap !== false && planet.colHeight[col] > 0;
    el.classList.toggle('hidden', !on);
    // The vitals sit under the map when there is one and in the corner when
    // there is not; #hud carries the flag because the map is display:none and
    // therefore cannot push anything.
    this.el.hud.classList.toggle('no-map', !on);
    if (!on) return;

    const now = performance.now();
    if (col !== this._mmCol && now - this._mmAt >= MAP_REDRAW_MS) {
      this._mmCol = col;
      this._mmAt = now;
      this._paintMinimap(planet, c.f, i, j);
    }

    // Which way is the player facing, in the sample grid's own axes: the grid
    // is (di, dj) offsets, so this is the same question as "what are forward's
    // cell components".
    player.tangentToCell(player.forward, _cellF);
    // The map is a zoomed-out view centred on the player with the direction
    // they are facing at the top, and nothing mirrored: left on the map is
    // their left. That is the entire specification, and both halves of it are
    // this one line plus `mapColumns`.
    //
    // `mapColumns` paints +i to the right and +j UP, so a tangent vector with
    // cell components (i, j) sits at `atan2(j, i)` measured anticlockwise from
    // screen right, like any other picture drawn the right way round. A CSS
    // `rotate` of a positive angle turns the canvas clockwise, which subtracts
    // from that, so putting `forward` at the top (a quarter turn round) is a
    // spin of exactly its own angle minus a quarter turn.
    const face = Math.atan2(_cellF.j, _cellF.i);
    const spin = face - Math.PI / 2;
    const q = Math.round(spin * 500);
    if (q !== this._mmTurn) {
      this._mmTurn = q;
      this._mmCtx.canvas.style.transform = `rotate(${(spin * 180 / Math.PI).toFixed(2)}deg)`;
    }

    // The north pip, on the frame, out of the same call the compass made —
    // which is what guarantees the two cannot end up pointing different ways.
    // `bearingOf` fills `_north` on the way past; the angle it returns is the
    // compass's business, not the map's.
    const lit = compassLit(bearingOf(player.up, player.forward, _east, _north).polar);
    const pipEl = this.el.mmNorth;
    pipEl.style.opacity = lit.toFixed(2);
    if (lit > 0) {
      player.tangentToCell(_north, _cellN);
      // North's angle on the canvas, the same way `face` was read, less the
      // spin the canvas has since been given; then negated, because `northPip`
      // works in image space where y is downward and this does not. Facing
      // north makes `_cellN` and `_cellF` the same vector, so `at` collapses to
      // -PI/2 and the pip sits at the top of the frame, which is the one value
      // of this expression that can be checked by reading it.
      const at = spin - Math.atan2(_cellN.j, _cellN.i);
      const p = northPip(at, MAP_RIM);
      pipEl.style.transform =
        `translate(-50%,-50%) translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
    }
  }

  /**
   * Sample the columns around (f, i, j) and paint them.
   *
   * Two passes because relief shading needs the neighbours' heights, and the
   * neighbours are not known until the whole field has been gathered — see
   * `mapColumns` for why the gather is done the way it is.
   */
  _paintMinimap(planet, f, i, j) {
    const N = MAP_SAMPLES;
    const H = this._mmH;
    const B = this._mmB;
    const heights = planet.colHeight;
    const biomes = planet.colBiome;
    const cols = mapColumns(f, i, j, this._mmCols);

    for (let n = 0; n < cols.length; n++) {
      H[n] = heights[cols[n]];
      B[n] = biomes[cols[n]];
    }

    const d = this._mmImage.data;
    for (let sy = 0; sy < N; sy++) {
      for (let sx = 0; sx < N; sx++) {
        const n = sy * N + sx;
        const h = H[n];
        const bc = BIOME_COLORS[B[n]] || BIOME_COLORS[2];
        let r, g, b;
        if (h < R_SEA) {
          // Under the sea. Deeper is darker, which is the only cue on the map
          // that tells a shallow bay you can wade apart from open ocean.
          const w = bc.water;
          const k = 1 - Math.min(1, (R_SEA - h) / 16) * 0.55;
          r = w[0] * k; g = w[1] * k; b = w[2] * k;
        } else {
          // Relief, from the slope across this sample. The light is fixed to
          // the sample grid rather than to north, so it turns with the map —
          // correct-looking is not the point, legibility is, and a light that
          // stayed put would leave a whole quadrant of the disc unshaded
          // whenever you happened to be facing along it.
          const l = H[n + (sx > 0 ? -1 : 0)];
          const rt = H[n + (sx < N - 1 ? 1 : 0)];
          const u = H[n - (sy > 0 ? N : 0)];
          const dn = H[n + (sy < N - 1 ? N : 0)];
          const slope = (l - rt) + (u - dn);
          const k = Math.max(0.5, Math.min(1.55, 1 + slope * 0.20))
            // A gentle altitude ramp under the relief, so a plateau reads as
            // high ground even where it is flat enough to cast no slope at all.
            * (0.92 + Math.min(1, (h - R_SEA) / 46) * 0.26);
          const gc = bc.grass;
          r = gc[0] * k; g = gc[1] * k; b = gc[2] * k;
        }
        // Lift, then put the body back: see MAP_SAT. The luminance is the
        // usual 30/59/11 rather than a mean, because a mean turns the sea and
        // the grass the same grey and then saturates them both away from it by
        // the same amount, which is the one thing this pass exists to avoid.
        let lr = Math.min(1, r) ** MAP_GAMMA;
        let lg = Math.min(1, g) ** MAP_GAMMA;
        let lb = Math.min(1, b) ** MAP_GAMMA;
        const y = 0.30 * lr + 0.59 * lg + 0.11 * lb;
        lr = (y + (lr - y) * MAP_SAT - MAP_PIVOT) * MAP_CONTRAST + MAP_PIVOT;
        lg = (y + (lg - y) * MAP_SAT - MAP_PIVOT) * MAP_CONTRAST + MAP_PIVOT;
        lb = (y + (lb - y) * MAP_SAT - MAP_PIVOT) * MAP_CONTRAST + MAP_PIVOT;
        const o = n * 4;
        d[o] = Math.max(0, Math.min(255, 255 * lr));
        d[o + 1] = Math.max(0, Math.min(255, 255 * lg));
        d[o + 2] = Math.max(0, Math.min(255, 255 * lb));
        d[o + 3] = 255;
      }
    }
    this._mmCtx.putImageData(this._mmImage, 0, 0);
  }

  // --- wiring ---------------------------------------------------------------

  _bind() {
    const g = this.game;
    // Both menu buttons open the same list of ten. Neither goes anywhere near a
    // world until a slot has been named.
    $('mm-continue').onclick = () => this.openSlots('continue');
    $('mm-new').onclick = () => this.openSlots('new');
    $('mm-settings').onclick = () => this.openSettings();
    $('mm-controls').onclick = () => this.openControls();
    document.querySelector('[data-close-slots]').onclick = () => this.closeSlots();

    // The id first, so today's `beginWorld(id)` is untouched, and the whole
    // choice second. The game side reads the second argument once it is ready
    // to act on the loadout and the difficulty; until then this is the same
    // call it always was.
    $('cg-begin').onclick = () => g.beginWorld(this._chosen, this.newGameChoice());
    $('cg-back').onclick = () => g.abandonNewGame();
    $('cg-prev').onclick = () => this.stepCharacter(-1);
    $('cg-next').onclick = () => this.stepCharacter(1);

    $('pz-resume').onclick = () => g.resume();
    $('pz-settings').onclick = () => this.openSettings();
    $('pz-controls').onclick = () => this.openControls();
    $('pz-save').onclick = () => g.saveGame(true);
    $('pz-quit').onclick = () => g.quitToMenu();

    $('dz-respawn').onclick = () => g.respawn();
    $('dz-quit').onclick = () => g.quitToMenu();

    document.querySelector('[data-close-screen]').onclick = () => g.closeScreen();
    document.querySelector('[data-close-skills]').onclick = () => g.closeSkills();
    // Confirmed, because it is the one button on the screen that takes
    // something away — and unconfirmed it sits one mis-click from a build a
    // player spent an evening on. The points all come back, which is why this
    // is a confirm and not a second screen.
    $('sk-reset').onclick = async () => {
      if (g.skills.spent <= 0) return;
      if (await this.confirm({ title: 'Unlearn everything', yes: 'Unlearn' })) g.resetSkills();
    };

    this.el.cfYes.onclick = () => this._settleConfirm(true);
    this.el.cfNo.onclick = () => this._settleConfirm(false);
    document.querySelector('[data-close-settings]').onclick = () => this.closeSettings();
    document.querySelector('[data-close-controls]').onclick = () => this.closeControls();

    // Clicking the dark outside a sheet closes it, the way the key that opened
    // it does. The overlay IS the backdrop - the sheet is its child - so the
    // test is that the click landed on the overlay itself and not inside the
    // panel, which is what `e.target === e.currentTarget` says. Each screen
    // has its own closer because they are not one state machine: a screen, the
    // skill tree, settings and controls all close differently.
    const backdrop = (sel, close) => {
      const el = document.querySelector(sel);
      if (el) el.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(); });
    };
    backdrop('#screen', () => g.closeScreen());
    backdrop('#skills', () => g.closeSkills());
    backdrop('#settings', () => this.closeSettings());
    backdrop('#controls', () => this.closeControls());
    // Slots was the one screen left off this list, and it is the one that could
    // least afford it. Its Back button is hidden with all the others by the
    // "no Close buttons on the sheets" rule, which is sound while Escape and
    // the backdrop are both there - but a phone has no Escape key, so with no
    // backdrop closer either, tapping New Game by mistake was a one way door
    // out of which the only exit was reloading the page. Measured on a Pixel 8:
    // Settings and Controls both closed on a tap outside, Slots did not.
    backdrop('#slots', () => this.closeSlots());

    const s = g.settings;
    const bind = (id, ev, fn) => { $(id).addEventListener(ev, fn); };
    bind('set-sens', 'input', (e) => { s.sensitivity = +e.target.value; $('sens-val').textContent = (+e.target.value).toFixed(2); g.persistSettings(); });
    bind('set-vol', 'input', (e) => { s.volume = +e.target.value / 100; $('vol-val').textContent = e.target.value; g.audio.setVolumes(s.volume, s.music); g.persistSettings(); });
    bind('set-mus', 'input', (e) => { s.music = +e.target.value / 100; $('mus-val').textContent = e.target.value; g.audio.setVolumes(s.volume, s.music); g.persistSettings(); });
    // No rows for field of view, resolution or day length, and that is a
    // decision rather than an omission. They were added once because the code
    // reads all three, and the owner took them out again: the panel was trimmed
    // on purpose and a slider nobody asked for is another line to scroll past.
    // `setRenderScale` therefore has no caller, which is correct.
    bind('set-post', 'change', (e) => { s.post = e.target.checked; g.postfx.enabled = e.target.checked; g.persistSettings(); });
    bind('set-bob', 'change', (e) => { s.bob = e.target.checked; g.persistSettings(); });
    bind('set-invert', 'change', (e) => { s.invertY = e.target.checked; g.input.invertY = e.target.checked; g.persistSettings(); });
    bind('set-autojump', 'change', (e) => { s.autoJump = e.target.checked; g.player.autoJump = e.target.checked; g.persistSettings(); });
    // Nothing to push anywhere: both are read by `updateMinimap` /
    // `updateCompass` on the next frame, which is also what puts the element
    // back or takes it away.
    bind('set-minimap', 'change', (e) => { s.minimap = e.target.checked; g.persistSettings(); });
    bind('set-compass', 'change', (e) => { s.compass = e.target.checked; g.persistSettings(); });

    window.addEventListener('mousemove', (e) => {
      this._cursorXY = { x: e.clientX, y: e.clientY };
      if (!this.el.cursor.classList.contains('hidden')) {
        this.el.cursor.style.left = `${e.clientX}px`;
        this.el.cursor.style.top = `${e.clientY}px`;
      }
      if (!this.el.tooltip.classList.contains('hidden')) {
        this.el.tooltip.style.left = `${e.clientX}px`;
        this.el.tooltip.style.top = `${e.clientY}px`;
      }
    });
  }

  syncSettings() {
    const s = this.game.settings;
    $('set-sens').value = s.sensitivity; $('sens-val').textContent = s.sensitivity.toFixed(2);
    $('set-vol').value = Math.round(s.volume * 100); $('vol-val').textContent = Math.round(s.volume * 100);
    $('set-mus').value = Math.round(s.music * 100); $('mus-val').textContent = Math.round(s.music * 100);
    $('set-post').checked = s.post;
    $('set-bob').checked = s.bob;
    $('set-invert').checked = s.invertY;
    $('set-autojump').checked = !!s.autoJump;
    $('set-minimap').checked = s.minimap !== false;
    $('set-compass').checked = s.compass !== false;
  }

  // --- the game's own yes/no ------------------------------------------------

  /**
   * Ask, in the game's own voice, and resolve to what was pressed.
   *
   * Every `window.confirm` is gone through here. Three reasons, in order of how
   * much they cost the player: a browser dialog drops pointer lock and hands
   * the mouse back to the desktop, which on a game you play with the cursor
   * hidden reads as a crash; it cannot be styled, so the one moment the game
   * asks before destroying something is the one moment it stops looking like a
   * game; and it blocks the main thread, so the world behind it stops on the
   * frame the dialog opened.
   *
   * The wording rule is the same as everywhere else: `title` names the act and
   * `body` states the facts. Nothing here explains what deleting means.
   *
   * @param {{title: string, body?: string, yes?: string, danger?: boolean}} ask
   * @returns {Promise<boolean>}
   */
  confirm(ask) {
    // A second question raised while one is up cancels the first rather than
    // stacking. Two of these on screen is a state with no correct answer.
    this._settleConfirm(false);
    this.el.cfTitle.textContent = ask.title;
    this.el.cfBody.textContent = ask.body || '';
    this.el.cfBody.classList.toggle('hidden', !ask.body);
    this.el.cfYes.textContent = ask.yes || 'Yes';
    this.el.cfYes.classList.toggle('danger', !!ask.danger);
    this.el.confirm.classList.remove('hidden');
    window.addEventListener('keydown', this._cfKey, true);
    this.el.cfNo.focus();
    return new Promise((resolve) => { this._cfResolve = resolve; });
  }

  // No `confirmOpen` getter. `_escape` in main.js consults `anyModalOpen`,
  // `deathOpen`, `skillsOpen`, `pauseOpen` and `screenOpen` and never asked this
  // one: the dialog takes its own Escape on `_cfKey`, bound above with capture
  // so the key never reaches Input. A getter beside those five read like part of
  // that chain, which is how the two would have drifted apart. Same reasoning
  // retired `slotsOpen` and `characterPickerOpen`.

  _settleConfirm(answer) {
    const resolve = this._cfResolve;
    if (!resolve) return;
    this._cfResolve = null;
    window.removeEventListener('keydown', this._cfKey, true);
    this.el.confirm.classList.add('hidden');
    resolve(answer);
  }

  /**
   * Escape is no, Enter is yes.
   *
   * Captured, like the picker's keys, so neither reaches `Input` — Escape in
   * particular would otherwise both dismiss this and pause the game behind it.
   */
  _confirmKey(e) {
    if (e.key === 'Escape') this._settleConfirm(false);
    else if (e.key === 'Enter') this._settleConfirm(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  // --- loading + menu -------------------------------------------------------

  progress(p, label) {
    this.el.loadFill.style.width = `${Math.round(p * 100)}%`;
    if (label) this.el.loadStatus.textContent = label;
  }

  loaded() {
    this.el.loader.classList.add('done');
    setTimeout(() => this.el.loader.remove(), 650);
  }

  showMenu() {
    this.el.menu.classList.remove('hidden');
    this.closeSlots();
    this.showHud(false);
    // Still just "Continue": what it opens is the list, and the list is where
    // a planet's day, its age and who lives on it belong. All this button has
    // to say is whether there is anything to continue at all.
    this.el.mmContinue.disabled = !Save.hasSave();
  }

  hideMenu() { this.el.menu.classList.add('hidden'); }

  // --- the ten save slots ---------------------------------------------------

  /**
   * The slot list, in one of its two moods.
   *
   * One screen rather than two, because it is the same ten rows either way and
   * the only difference is what a click on one means. Continue can only open a
   * planet that exists; New Game can write to any of them, and to a full one
   * only after saying so out loud.
   *
   * @param {'continue'|'new'} mode
   */
  openSlots(mode) {
    this._slotMode = mode;
    this.el.slotsTitle.textContent = mode === 'new' ? 'New Game' : 'Continue';
    this._paintSlots();
    this.el.slots.classList.remove('hidden');
    window.addEventListener('keydown', this._slotKey, true);
  }

  closeSlots() {
    this.el.slots.classList.add('hidden');
    window.removeEventListener('keydown', this._slotKey, true);
  }

  // No `slotsOpen` getter: `_slotKey` above takes Escape on capture. See the
  // note where `confirmOpen` used to be.

  /**
   * Draw the ten rows.
   *
   * Each filled one carries the four things that make a planet recognisable at
   * a glance and nothing else: who lives on it, what day it is there, how long
   * has been spent on it, and when it was last written. Character, day and
   * saved-when were asked for by name; playtime is in the same breath because
   * `savedAt` alone cannot tell a world you played for an evening from one you
   * looked at once, and the summary has carried it since before slots existed.
   */
  _paintSlots() {
    const list = this.el.slotList;
    const slots = Save.slots();
    const newGame = this._slotMode === 'new';
    list.innerHTML = '';

    slots.forEach((meta, i) => {
      const row = document.createElement('div');
      row.className = `slot-row${meta ? ' filled' : ''}`;

      const open = document.createElement('button');
      open.className = 'slot-open';
      // A slot with nothing in it is not a thing Continue can do.
      open.disabled = !meta && !newGame;
      const num = `Slot ${i + 1}`;
      if (meta) {
        open.innerHTML = `<b>${num}</b>`
          + `<span class="slot-who">${characterName(meta.character)}</span>`
          + `<span class="slot-when">Day ${meta.day || 1}, ${playedFor(meta.playtime)} played</span>`
          // The time, and not the word "Saved" in front of it ten times. The
          // column is 105px wide on a 520px sheet and "Saved 13 months ago"
          // wants 114, so the one row whose age is worth reading was the one
          // that ellipsised - on a 1920px monitor, not only on a phone. What
          // the column holds is already obvious from the two lines beside it,
          // and a label repeated on every row is not a label.
          + `<span class="slot-ago">${agoText(meta.savedAt)}</span>`;
      } else {
        open.innerHTML = `<b>${num}</b><span class="slot-who empty">Empty</span>`;
      }
      open.onclick = () => this._pickSlot(i, meta);
      row.appendChild(open);

      if (meta) {
        const del = document.createElement('button');
        del.className = 'slot-del';
        del.textContent = 'Delete';
        del.onclick = (e) => { e.stopPropagation(); this._deleteSlot(i, meta); };
        row.appendChild(del);
      }
      list.appendChild(row);
    });
  }

  /**
   * A row was clicked.
   *
   * The confirm on a full slot is the whole reason New Game routes through this
   * screen rather than grabbing the first empty one: with ten slots the day
   * comes when they are all full, and at that point starting a new planet is an
   * act that destroys an old one. It has to be said in words, with the slot
   * named, before anything is claimed.
   */
  async _pickSlot(i, meta) {
    if (this._slotMode === 'new') {
      if (meta && !await this.confirm({
        title: `Replace slot ${i + 1}`,
        body: `${characterName(meta.character)}, day ${meta.day || 1}`,
        yes: 'Replace',
        danger: true,
      })) return;
      this.closeSlots();
      // The third argument is sent even when nothing has been picked yet, so
      // there is one shape of call and one default — see `newGameChoice`.
      this.game.newGame(i, this.newGameChoice());
      return;
    }
    if (!meta) return;
    this.closeSlots();
    this.game.continueGame(i);
  }

  async _deleteSlot(i, meta) {
    const ok = await this.confirm({
      title: `Delete slot ${i + 1}`,
      body: `${characterName(meta.character)}, day ${meta.day || 1}`,
      yes: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await Save.erase(i);
    this._paintSlots();
    // The main menu is behind this screen and its Continue button may have
    // just become the last thing pointing at nothing.
    this.el.mmContinue.disabled = !Save.hasSave();
    this.game.audio.ui(320);
  }

  // --- the New Game character picker ----------------------------------------

  /**
   * Put the carousel up. The planet is already generating behind it,
   * so this screen is time the player was going to spend waiting anyway — which
   * is the whole reason it is allowed to exist at all.
   *
   * @param {string} selected who to start on — the body the player is currently
   *   wearing, which on a fresh device is `DEFAULT_CHARACTER` and otherwise is
   *   whoever they last woke up as. Pressing Begin without touching anything is
   *   therefore always a valid, sensible answer.
   */
  openCharacterPicker(selected) {
    if (!this._picker) {
      this._picker = new CharacterPicker(this.el.cgCanvas);
      // One figure, framed square, so the canvas is square too.
      this.el.cgCanvas.style.aspectRatio = '1 / 1';
    }
    this._chosen = CHARACTER_IDS.includes(selected) ? selected : CHARACTER_IDS[0];
    // Every new game opens on the default kit, and this line is the only reason
    // that is true. The picker is not built fresh each time it is opened: the
    // UI object outlives it, so `_loadout` used to carry whatever the last
    // visit left in it. Back out of New Game having picked an axe and a pick,
    // start New Game again, and the screen came up with two of your three
    // already spent by a choice you made for a planet that was never built.
    // Deselect the torches once and every later new game started without them.
    // That is a picker that "sometimes gives you what you picked", and the
    // player is the one who has to work out why.
    this._loadout = [...DEFAULT_LOADOUT];
    // Built here rather than in the constructor: the tiles carry item icons and
    // `setIcons` has not run when the UI is first constructed.
    // No loadout picker. It is not hidden with a class: `_loadout` stays empty
    // so `loadoutStacks` falls through to DEFAULT_START_ITEMS, which is now the
    // torches plus a full set of tools. Removing the row rather than disabling
    // it is the point, since a screen that offers a choice it does not honour is
    // worse than no choice. Its markup and its styling went with it, because a
    // caption with an empty grid under it is a hole where a row used to be;
    // `_buildKit`, `_syncKit`, `_toggleKit` and `_paintKit` are left in place
    // and unreferenced so the feature can come back when the tool economy is
    // settled, and they all no-op while `cg-kit` is absent from the document.
    this._loadout = [];
    this._buildDifficulty();
    this._buildDeathRule();
    this.el.chargen.classList.remove('hidden');
    this.characterPickerReady(false);
    this._syncCharacterName();
    // After the overlay is visible, never before: the canvas has no measurable
    // size while its parent is `display: none`.
    this._picker.open(this._chosen, characterUrl(this._chosen));
    // Capture, so the picker's Escape and arrows never reach `Input`, which
    // listens on the same window and would bank them for the next frame.
    window.addEventListener('keydown', this._cgKey, true);
    $('cg-begin').focus();
  }

  closeCharacterPicker() {
    this.el.chargen.classList.add('hidden');
    this._picker?.close();
    window.removeEventListener('keydown', this._cgKey, true);
  }

  // No `characterPickerOpen` getter: `_cgKey` takes Escape on capture. See the
  // note where `confirmOpen` used to be.

  /** Worldgen's progress, as one word. */
  characterPickerReady(ready) {
    this.el.cgStatus.textContent = ready ? 'Ready' : 'Shaping';
    this.el.cgStatus.classList.toggle('ready', !!ready);
  }

  // --- what you bring, and how hard it hits back ----------------------------

  /**
   * The answers this screen exists to collect, as one object.
   *
   * Sent to `newGame` when the slot is claimed and to `beginWorld` when the
   * player commits, so the game side can read it at whichever of the two points
   * suits it and there is never a call without one. Both are given the same
   * shape and the same defaults; only `beginWorld` is guaranteed to carry the
   * player's actual picks, because the picks are made after `newGame` starts
   * the terrain.
   *
   * `loadout` is a copy. It is held on this object between the two calls and a
   * caller that stashed the array itself would find it changing under them the
   * next time somebody pressed a tile.
   *
   * @returns {{character: string, loadout: string[], difficulty: string,
   *   deathRule: string}}
   */
  newGameChoice() {
    return {
      character: this._chosen || CHARACTER_IDS[0],
      loadout: [...this._loadout],
      difficulty: this._difficulty,
      // Extreme does not ask, so it does not answer with whatever the row was
      // last left on. See `_syncDeathRuleShown`.
      deathRule: this._difficulty === 'extreme' ? DEFAULT_ON_DEATH : this._deathRule,
    };
  }

  /**
   * The tiles.
   *
   * Icon and name, and no line saying what any of them is for: a pickaxe is a
   * pickaxe. The count rides the corner of the tile rather than the label,
   * because "Torches" is the thing and "6" is a detail about it.
   */
  _buildKit() {
    const kit = this.el.cgKit;
    if (!kit) return;
    kit.innerHTML = '';
    // The tiles are painted through `IconFactory.item`, which is the same call
    // the hotbar and the inventory grid make — so a pickaxe on this screen is
    // the pickaxe model, not a flat sprite or a generated cube.
    //
    // Two things make that non-obvious, and both are why the `img` is created
    // unconditionally and kept in a list. First, this screen is up *while*
    // `_loadAssets` runs, so `this.icons` is frequently still null when the
    // tiles are built. Second, a modelled item's icon is painted only once its
    // GLB lands, which is later again — `IconFactory` hands back the drawn art
    // in the meantime and fires its update hook when the real one is ready.
    // `_paintKit` is therefore called from three places: here, from
    // `setIcons`, and from that hook. Whichever arrives last wins, and nothing
    // ever renders an empty tile waiting for it.
    this._kitIcons = [];
    for (const opt of LOADOUT_OPTIONS) {
      const b = document.createElement('button');
      b.className = 'cg-opt';
      b.dataset.key = opt.key;
      const [name, count] = opt.items[0];
      const img = document.createElement('img');
      img.alt = '';
      // A one-pixel transparent GIF, so a tile whose icon has not been painted
      // yet is an empty square rather than a broken-image glyph.
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      b.appendChild(img);
      this._kitIcons.push({ img, id: itemIdOf(name) });
      if (count > 1) {
        const q = document.createElement('span');
        q.className = 'qty';
        q.textContent = count;
        b.appendChild(q);
      }
      b.appendChild(document.createTextNode(opt.label));
      b.onclick = () => this._toggleKit(opt.key);
      kit.appendChild(b);
    }
    this._paintKit();
    this._syncKit();
  }

  /**
   * Point every loadout tile at the current best icon for its item.
   *
   * Idempotent and cheap: the factory caches, and an unchanged data URL is not
   * reassigned, so calling this on every late-icon repaint costs one string
   * compare per tile.
   */
  _paintKit() {
    if (!this.icons || !this._kitIcons) return;
    for (const { img, id } of this._kitIcons) {
      const url = this.icons.item(id);
      if (url && img.src !== url) img.src = url;
    }
  }

  /**
   * Take a tile or put it back.
   *
   * A full loadout refuses a fourth rather than dropping the oldest. Silently
   * swapping one out is the version where a player picks a sword and watches
   * their torches vanish with no way to know why.
   */
  _toggleKit(key) {
    const at = this._loadout.indexOf(key);
    if (at >= 0) this._loadout.splice(at, 1);
    else if (this._loadout.length < LOADOUT_MAX) this._loadout.push(key);
    // Every refusal in this file used to be the confirmation click at a lower
    // pitch, which asks the player to hear an interval to know they were told
    // no. `deny()` is a flat two-tone fall and is unmistakably not a yes.
    else { this.game.audio.deny(); return; }
    this._syncKit();
    this.game.audio.ui(at >= 0 ? 380 : 620);
  }

  _syncKit() {
    const kit = this.el.cgKit;
    if (!kit) return;
    const full = this._loadout.length >= LOADOUT_MAX;
    kit.classList.toggle('full', full);
    for (const b of kit.children) b.classList.toggle('on', this._loadout.includes(b.dataset.key));
    // How much of the choice is left, as a readout. The screen opens on 1/3
    // because the torches are already on, and that number is what makes their
    // being a pick rather than a gift legible before the limit is hit.
    const count = this.el.cgKitCount;
    if (count) {
      count.textContent = `${this._loadout.length}/${LOADOUT_MAX}`;
      count.classList.toggle('full', full);
    }
  }

  /**
   * The four settings, in a dropdown.
   *
   * It was a segmented bar, which was built when there were three of them and
   * could not set "Extreme" in a quarter of the card once there were four. A
   * real `<select>` is the trade: the platform draws the open list, and in
   * return the control is keyboard operable, type-ahead searchable and
   * announced by a screen reader without a line of code here. It also cannot
   * drift from its own value, because there is no second copy of "which one is
   * current" to keep in step — `_syncDifficulty` writes `value` and the browser
   * owns the rest.
   */
  _buildDifficulty() {
    const sel = this.el.cgDiff;
    if (!sel) return;
    sel.innerHTML = '';
    for (const d of DIFFICULTIES) {
      const o = document.createElement('option');
      o.value = d.key;
      o.textContent = d.label;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      this._difficulty = sel.value;
      this._syncDeathRuleShown();
      this.game.audio.ui(560);
    };
    this._syncDifficulty();
  }

  _syncDifficulty() {
    const sel = this.el.cgDiff;
    if (sel) sel.value = this._difficulty;
    this._syncDeathRuleShown();
  }

  /**
   * Extreme has no "on death", so the row goes away rather than greys out.
   *
   * A death on Extreme ends the run: `respawn` routes straight to `_spectate`
   * and there is no path back onto your feet, so neither answer to "what does
   * dying cost" ever comes due — the bag is settled once, on a body nobody
   * will walk to again. A control that cannot change anything is worse than no
   * control, so the whole row leaves and the card closes up behind it.
   *
   * `_deathRule` is left alone while it is hidden. The player's pick survives a
   * detour through Extreme and is theirs again the moment they come back to a
   * difficulty where it means something; `newGameChoice` is what refuses to
   * report a stale answer, and it reports the default instead.
   */
  _syncDeathRuleShown() {
    this._cgDeathRow?.classList.toggle('hidden', this._difficulty === 'extreme');
  }

  /**
   * The same bar again, for what a death costs.
   *
   * The row is built here rather than written into index.html, and that is not a
   * preference: it is the same `.cg-pick` / `.cg-cap` / `.seg` markup the
   * difficulty row already is, cloned once and cached, so it inherits the menu's
   * existing styling exactly and adds no rule to the stylesheet. Idempotent —
   * the picker is opened once per New Game and the row is made on the first of
   * those and reused after.
   *
   * The anchor is the difficulty row, found by `closest`, not by walking up one
   * parent from the control. The select sits in a `.pick-wrap` that carries the
   * drawn chevron, so one `parentElement` lands inside the row rather than on
   * it, and the death rule would have been inserted into the middle of the
   * difficulty control.
   */
  _deathRuleBar() {
    if (this._cgDeath) return this._cgDeath;
    const after = this.el.cgDiff?.closest('.cg-pick');
    if (!after?.parentElement) return null;
    const row = document.createElement('div');
    row.className = 'cg-pick';
    const cap = document.createElement('span');
    cap.className = 'cg-cap';
    cap.textContent = 'On death';
    const bar = document.createElement('div');
    bar.className = 'seg';
    bar.id = 'cg-death';
    row.append(cap, bar);
    after.parentElement.insertBefore(row, after.nextSibling);
    this._cgDeath = bar;
    // The row, not the bar: Extreme hides the caption with it. See
    // `_syncDeathRuleShown`.
    this._cgDeathRow = row;
    return bar;
  }

  _buildDeathRule() {
    const bar = this._deathRuleBar();
    if (!bar) return;
    bar.innerHTML = '';
    for (const d of DEATH_RULES) {
      const b = document.createElement('button');
      b.textContent = d.label;
      b.dataset.key = d.key;
      b.onclick = () => {
        this._deathRule = d.key;
        this._syncDeathRule();
        this.game.audio.ui(560);
      };
      bar.appendChild(b);
    }
    this._syncDeathRule();
    // `_buildDifficulty` runs first and has no row to hide yet, so the opening
    // state is settled here.
    this._syncDeathRuleShown();
  }

  _syncDeathRule() {
    const bar = this._cgDeath;
    if (!bar) return;
    for (const b of bar.children) b.classList.toggle('on', b.dataset.key === this._deathRule);
  }

  /**
   * One step along the carousel, wrapping at both ends.
   *
   * Wrapping rather than stopping: there is no first or last character, only
   * fifteen of them in a ring, and an arrow that goes dead at one end tells the
   * player they have seen everything when the answer is that they have seen
   * everything *this way round*.
   */
  stepCharacter(dir) {
    const n = CHARACTER_IDS.length;
    const at = Math.max(0, CHARACTER_IDS.indexOf(this._chosen));
    // The wrap is a jump, not a slide — see `CharacterPicker.setSelected`.
    const next = (at + dir + n) % n;
    this.chooseCharacter(CHARACTER_IDS[next], Math.abs(next - at) > 1);
  }

  chooseCharacter(id, snap = false) {
    if (id === this._chosen) return;
    this._chosen = id;
    this._picker?.setSelected(id, snap);
    this._syncCharacterName();
    this.game.audio.ui(560);
  }

  /**
   * The name under the figure.
   *
   * The name, and nothing else. There used to be a "2 of 15" beside it, which
   * is a fact about the list rather than about the person: it told a player
   * their position in an array they never asked to be in, and the arrows either
   * side already say there are more.
   */
  _syncCharacterName() {
    this.el.cgWho.textContent = characterName(this._chosen);
  }

  /**
   * Keyboard on the carousel: left and right turn it, Enter starts, Escape
   * backs out.
   *
   * Up and down are the same as left and right rather than nothing at all: the
   * grid this replaced used them for rows, and a key that used to move and now
   * does nothing reads as the screen having frozen.
   *
   * Escape is deliberately not "accept" — the picker is skippable by pressing
   * the button that is already focused, and a key that both dismisses a screen
   * and commits a world would be the one way to start a planet by accident.
   */
  _characterKey(e) {
    // A focused control owns the keys it uses, and this listener is on the
    // window in the capture phase, so it sees them first and would eat them.
    // The difficulty select owns all four arrows and Enter, which is the whole
    // reason it is keyboard operable; a focused button owns Enter, because the
    // browser turns that into a click on that button, which is what the player
    // pressing Enter on "Back" meant.
    const t = e.target;
    if (t instanceof HTMLSelectElement) return;
    if (e.key === 'Enter' && t instanceof HTMLButtonElement) return;
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (step !== undefined) {
      this.stepCharacter(step);
    } else if (e.key === 'Enter') {
      this.game.beginWorld(this._chosen, this.newGameChoice());
    } else if (e.key === 'Escape') {
      this.game.abandonNewGame();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  openSettings() { this.syncSettings(); this.el.settings.classList.remove('hidden'); }
  closeSettings() { this.el.settings.classList.add('hidden'); }
  openControls() { this.el.controls.classList.remove('hidden'); }
  closeControls() { this.el.controls.classList.add('hidden'); }
  get anyModalOpen() {
    return !this.el.settings.classList.contains('hidden') || !this.el.controls.classList.contains('hidden');
  }

  openPause() { this.el.pause.classList.remove('hidden'); }
  closePause() { this.el.pause.classList.add('hidden'); this.closeSettings(); this.closeControls(); }
  get pauseOpen() { return !this.el.pause.classList.contains('hidden'); }

  /**
   * The reason, and one line about what it cost, if anything.
   *
   * `cause` is one or two words: `Fell`, `Drowned`, `Lava`, or the name of
   * whatever killed you. `lost` is empty on almost every death and is a short
   * phrase on the ones that wipe the tree. Nothing here consoles, explains
   * where the pack went, or says what happens next — the pack has a marker on
   * the map and the buttons say what happens next.
   *
   * @param {string} cause
   * @param {string} [lost]
   * @param {boolean} [final] there is no waking up on this world. The screen is
   *   the same screen — same cause, same one line — and the one button that
   *   would have put you back changes to what it will actually do. Nothing is
   *   added to say the run is over: a button that says Spectate where a button
   *   that said Wake Up used to be says it, and this screen has never explained
   *   itself.
   */
  showDeath(cause, lost = '', final = false) {
    this.el.deathCause.textContent = cause;
    this.el.deathLost.textContent = lost;
    this.el.deathLost.classList.toggle('hidden', !lost);
    if (this.el.dzRespawn) this.el.dzRespawn.textContent = final ? 'Spectate' : 'Wake Up';
    this.el.death.classList.remove('hidden');
  }
  hideDeath() { this.el.death.classList.add('hidden'); }
  get deathOpen() { return !this.el.death.classList.contains('hidden'); }

  // Toasts live outside #hud so they can draw over the pause overlay — the
  // "Planet saved" confirmation is raised from the pause screen itself — but
  // they still come and go with the HUD.
  showHud(on) {
    this.el.hud.classList.toggle('hidden', !on);
    this.el.toasts.classList.toggle('hidden', !on);
  }

  /**
   * The HUD a spectator gets: the world, and where in it they are.
   *
   * What goes is everything that is a fact about a body — health, food, air,
   * stamina — and everything that is a fact about carrying things: the hotbar,
   * the offhand, the held item's name and the label under the crosshair. None
   * of them can change again, and a health bar pinned at empty is a worse way
   * of saying "you are dead" than simply not having one.
   *
   * What stays is the status row (clock, weather, season, biome), the compass
   * and the minimap, because those are about the planet rather than the person
   * and exploring is the entire remaining game.
   *
   * The crosshair goes too. It is a sight, there is nothing left to aim, and it
   * is the only element that would still imply the world can be touched.
   */
  setSpectator(on) {
    this.el.vitals?.classList.toggle('hidden', on);
    this.el.bottom?.classList.toggle('hidden', on);
    if (on) this.showCrosshair(false);
  }

  // --- slot rendering -------------------------------------------------------

  setIcons(icons) {
    this.icons = icons;
    // Icons for modelled items are rendered off the game's own renderer, and
    // arrive a beat after the model does — hence the repaint hook.
    // The character picker is usually still on screen when this runs — it is
    // put up before `_loadAssets` finishes on purpose — so its tiles are
    // repainted alongside the inventory both now and on every late arrival.
    icons.attach(this.game.renderer, () => { this.refresh(); this._paintKit(); });
    this.refresh();
    this._paintKit();
  }

  _buildSlots() {
    // hotbar (HUD)
    this.el.hotbar.innerHTML = '';
    this.hudSlots = [];
    for (let i = 0; i < HOTBAR; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = `<span class="num">${i + 1}</span>`;
      d.onclick = () => { this.game.inventory.selected = i; this.refresh(); this.game.input.requestLock(); };
      this.el.hotbar.appendChild(d);
      this.hudSlots.push(d);
    }
    // The offhand cell beside it. Clicking swaps rather than selects, which is
    // the only thing a hotbar click could mean here — you cannot "select" the
    // offhand, there is nothing that would then act on it. It is the mouse's
    // copy of F, so it goes through the same method and gets the same sound.
    this.el.offhand.onclick = () => {
      this.game.swapOffhand();
      this.game.input.requestLock();
    };
    // inventory grids
    this.invSlots = [];
    const mk = (parent, index) => {
      const d = document.createElement('div');
      d.className = 'islot';
      d.dataset.index = index;
      this._wireSlot(d, () => this.game.inventory.slots[index], { index });
      parent.appendChild(d);
      this.invSlots[index] = d;
    };
    this.el.invMain.innerHTML = '';
    this.el.invHot.innerHTML = '';
    for (let i = HOTBAR; i < TOTAL; i++) mk(this.el.invMain, i);
    for (let i = 0; i < HOTBAR; i++) mk(this.el.invHot, i);
  }

  _wireSlot(el, getSlot, opts = {}) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (opts.output) this._takeOutput(e.button === 2 || e.shiftKey);
      // Shift-click moves a whole stack between the hotbar and storage without
      // picking it up — the standard way players bulk-move items.
      else if (e.shiftKey && opts.index !== undefined
               && this.game.inventory.cursor.empty) this._shiftMove(opts.index);
      else if (e.shiftKey && opts.container
               && this.game.inventory.cursor.empty) this._shiftTake(getSlot());
      else this._slotClick(getSlot(), e.button === 2, opts.accepts);
    });
    el.addEventListener('mouseenter', () => this._showTooltip(getSlot()));
    el.addEventListener('mouseleave', () => this._hideTooltip());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _slotClick(slot, right, accepts) {
    const cur = this.game.inventory.cursor;
    const max = (id) => ITEMS[id]?.stack ?? 64;
    // A restricted slot still gives up what it holds — it only refuses to take
    // the wrong thing. Refusing both ways would make a filled restricted slot
    // impossible to empty once you were holding anything else.
    //
    // Nothing passes `accepts` today: the four worn armour slots were its only
    // caller and they are gone. Kept because it is three lines and it is the
    // rule any future slot with a filter has to follow — the offhand's comment
    // explains why *it* deliberately has none.
    if (!cur.empty && accepts && !accepts(cur.item)) {
      this.game.audio.ui(200);
      return;
    }
    if (cur.empty) {
      if (slot.empty) return;
      const take = right ? Math.ceil(slot.count / 2) : slot.count;
      cur.set(slot.item, take, slot.wear);
      slot.count -= take;
      if (slot.count <= 0) slot.clear();
    } else if (slot.empty) {
      const give = right ? 1 : cur.count;
      slot.set(cur.item, give, cur.wear);
      cur.count -= give;
      if (cur.count <= 0) cur.clear();
    } else if (slot.item === cur.item && max(cur.item) > 1) {
      const give = Math.min(right ? 1 : cur.count, max(cur.item) - slot.count);
      slot.count += give; cur.count -= give;
      if (cur.count <= 0) cur.clear();
    } else {
      // swap
      const t = slot.copy();
      slot.set(cur.item, cur.count, cur.wear);
      cur.set(t.item, t.count, t.wear);
    }
    this.game.audio.ui(430);
    this.refresh();
  }

  /**
   * Send a slot's whole stack to the other region — hotbar to storage, storage
   * to hotbar — merging into partial stacks of the same item first, then the
   * first empty slot. Anything that doesn't fit stays put.
   */
  _shiftMove(index) {
    const inv = this.game.inventory;
    const src = inv.slots[index];
    if (src.empty) return;
    // Shift-clicking a helmet used to mean "wear it". There is nowhere to wear
    // it any more, so a piece of armour now shift-moves like anything else you
    // are carrying — which is what it is.
    if (this.crate) this._pour(src, this.crate.slots);
    else {
      const toStorage = index < HOTBAR;
      this._pour(src, inv.slots.slice(toStorage ? HOTBAR : 0, toStorage ? TOTAL : HOTBAR));
    }
    this.game.audio.ui(500);
    inv.changed();
    this.refresh();
  }

  /** Shift-click inside the crate: send the stack back to the player. */
  _shiftTake(slot) {
    if (slot.empty) return;
    this._pour(slot, this.game.inventory.slots);
    this.game.audio.ui(500);
    this.game.inventory.changed();
    this.refresh();
  }

  /**
   * Empty `src` into `dsts`, merging into matching partial stacks before
   * claiming empty ones. Whatever doesn't fit stays where it was.
   */
  _pour(src, dsts) {
    const max = ITEMS[src.item]?.stack ?? 64;
    for (let pass = 0; pass < 2 && src.count > 0; pass++) {
      for (let i = 0; i < dsts.length && src.count > 0; i++) {
        const dst = dsts[i];
        if (dst === src) continue;
        if (pass === 0) {
          if (dst.empty || dst.item !== src.item || dst.wear !== src.wear) continue;
          const give = Math.min(src.count, max - dst.count);
          if (give <= 0) continue;
          dst.count += give; src.count -= give;
        } else {
          if (!dst.empty) continue;
          const give = Math.min(src.count, max);
          dst.set(src.item, give, src.wear);
          src.count -= give;
        }
      }
    }
    if (src.count <= 0) src.clear();
  }

  _takeOutput(all) {
    const g = this.game;
    const size = this.screen === 'bench' ? 3 : 2;
    const rec = findRecipe(g.inventory.craftGrid(size), size, size, this.screen === 'bench');
    if (!rec) return;
    const cur = g.inventory.cursor;
    let made = 0;
    do {
      const r = findRecipe(g.inventory.craftGrid(size), size, size, this.screen === 'bench');
      if (!r || r.out !== rec.out) break;
      if (!cur.empty && (cur.item !== rec.out || cur.count + rec.count > (ITEMS[rec.out]?.stack ?? 64))) break;
      g.inventory.consumeCraft(size);
      if (cur.empty) cur.set(rec.out, rec.count);
      else cur.count += rec.count;
      made++;
    } while (all && made < 64);
    // No xp. A trip to the bench used to pay 3, flat, to stop a shift-click of
    // 64 planks being the best-paying craft in the game; the whole question is
    // moot now that nothing but a kill pays. `crafted` is still counted.
    if (made) { g.audio.craft(); g.stats.crafted += made; }
    this.refresh();
  }

  // No size argument. `big` used to be a third parameter here and the body never
  // read it; all thirteen call sites pass two arguments and there is no `.big`
  // rule in style.css, so it was a knob a reader would think turned something.
  _paint(el, slot) {
    el.innerHTML = el.dataset.num ? `<span class="num">${el.dataset.num}</span>` : '';
    el.classList.toggle('filled', !!slot && !slot.empty);
    if (!slot || slot.empty || !this.icons) return;
    const def = ITEMS[slot.item];
    const img = document.createElement('img');
    img.src = this.icons.item(slot.item);
    img.alt = def?.label || '';
    el.appendChild(img);
    if (slot.count > 1) {
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = slot.count;
      el.appendChild(c);
    }
    const durable = def?.tool ?? def?.armour;
    if (durable && slot.wear > 0) {
      const w = document.createElement('div');
      w.className = 'wear';
      const frac = 1 - slot.wear / durable.durability;
      w.innerHTML = `<i style="width:${Math.max(0, frac) * 100}%;background:${frac > 0.5 ? '#57a844' : frac > 0.2 ? '#d7a83a' : '#cf4630'}"></i>`;
      el.appendChild(w);
    }
  }

  refresh() {
    const inv = this.game.inventory;
    for (let i = 0; i < HOTBAR; i++) {
      const el = this.hudSlots[i];
      el.dataset.num = i + 1;
      this._paint(el, inv.slots[i]);
      el.classList.toggle('active', i === inv.selected);
    }
    // `F` where a hotbar slot has its number — same corner, same type, and it
    // is the same kind of fact: the key that puts this slot in your hand. On a
    // phone there is no F and the corner has to name the gesture instead; the
    // cell's own click handler is what swaps, so a tap is the truth there.
    this.el.offhand.dataset.num = this.game.input?.touch ? 'TAP' : 'F';
    this._paint(this.el.offhand, inv.offhand);
    for (let i = 0; i < TOTAL; i++) {
      const el = this.invSlots[i];
      if (!el) continue;
      delete el.dataset.num;
      this._paint(el, inv.slots[i]);
      el.classList.toggle('sel', i === inv.selected);
    }
    if (this.craftSlots) {
      this.craftSlots.forEach((el, k) => this._paint(el, this.craftMap[k]));
      this._refreshCraftOutput();
    }
    if (this.kilnSlots) this._refreshKiln();
    if (this.crateSlots) this._refreshCrate();
    if (this.offhandEl) this._paint(this.offhandEl, inv.offhand);
    if (this.screen === 'shop') this._refreshShop();
    else if (this.screenOpen) this._refreshRecipes();
    this._paintCursor();
  }

  /** Sidebar listing everything the current materials allow. */
  _refreshRecipes() {
    const list = this.el.recipeList;
    if (!list || !this.icons) return;
    const hasTable = this.screen === 'bench';
    const options = availableRecipes(this.game.inventory, hasTable);

    // An empty badge still paints its background — hide the pill entirely
    // rather than leaving a stray orange sliver next to the heading.
    this.el.recipeCount.textContent = options.length || '';
    this.el.recipeCount.classList.toggle('hidden', options.length === 0);
    this.el.recipeEmpty.classList.toggle('hidden', options.length > 0);
    // Two words, and the second one only when the bench would change the
    // answer. What a workbench is for is not this label's job.
    this.el.recipeEmpty.textContent = hasTable ? 'Nothing yet' : 'Nothing yet, without a bench';

    list.innerHTML = '';
    for (const { recipe, cost } of options) {
      const def = ITEMS[recipe.out];
      const row = document.createElement('div');
      row.className = 'recipe-row';

      const img = document.createElement('img');
      img.src = this.icons.item(recipe.out);
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = def.label;
      const yield_ = document.createElement('span');
      yield_.className = 'ryield';
      yield_.textContent = recipe.count > 1 ? `x${recipe.count}` : '';

      const costEl = document.createElement('span');
      costEl.className = 'rcost';
      for (const c of cost) {
        const chip = document.createElement('i');
        const ci = document.createElement('img');
        ci.src = this.icons.item(c.item);
        chip.append(ci, document.createTextNode(String(c.count)));
        costEl.appendChild(chip);
      }

      row.append(img, name, yield_, costEl);
      row.addEventListener('click', (e) => {
        const times = e.shiftKey ? 64 : 1;
        const made = craftFromInventory(this.game.inventory, recipe, times);
        if (made) {
          this.game.audio.craft();
          this.game.stats.crafted += made;
        } else {
          this.game.audio.deny();
        }
        this.refresh();
      });
      list.appendChild(row);
    }

    // The list is capped well under the sheet's height (see `#recipe-list`), so
    // a long recipe book ends on a row cut in half against a hard edge. The
    // half row is the right affordance - it says there is more - but only once
    // it reads as continuing rather than as clipped, which is the same call
    // `_refreshShop` makes about its two counters and the same `.scrolls` fade.
    // Not a static rule, for the same reason it is not one there: a list that
    // fits would have its last row dimmed for nothing.
    list.classList.toggle('scrolls', list.scrollHeight > list.clientHeight + 1);
  }

  _paintCursor() {
    const cur = this.game.inventory.cursor;
    if (cur.empty || !this.icons) { this.el.cursor.classList.add('hidden'); return; }
    this.el.cursor.classList.remove('hidden');
    this.el.cursor.querySelector('img').src = this.icons.item(cur.item);
    this.el.cursor.querySelector('span').textContent = cur.count > 1 ? cur.count : '';
    this.el.cursor.style.left = `${this._cursorXY.x}px`;
    this.el.cursor.style.top = `${this._cursorXY.y}px`;
  }

  _showTooltip(slot) {
    if (!slot || slot.empty) return this._hideTooltip();
    const def = ITEMS[slot.item];
    let sub = '';
    // A bow is a weapon and has no tier — it is not on the mining ladder and
    // does not become a better bow by being made of iron. Printing "tier 0"
    // beside it invited the question of where tiers 1-5 were.
    if (def.bow) sub = `Weapon, ${def.tool.durability - slot.wear}/${def.tool.durability}`;
    else if (def.tool) sub = `${def.tool.kind === 'sword' ? 'Weapon' : 'Tool'}, tier ${def.tool.tier}, ${def.tool.durability - slot.wear}/${def.tool.durability}`;
    // "Block" is for something that fills a cell. The cross-rendered family —
    // aloe, lavender, golden grass, ferns, coral, a shell, a crystal cluster —
    // are placeable and so they all carry a block id, which is why they were
    // all being called blocks. They are not, and there is no one word that is
    // true of all of them either: "Plant" is right for the flora and wrong for
    // the fungi, the coral and the driftwood. So they get no category line at
    // all. The name and the icon already say what a lavender is.
    else if (def.block !== undefined && BLOCKS[def.block].render !== R_CROSS) sub = 'Block';
    else if (def.food) sub = `Food, ${def.food}`;
    else if (def.fuel) sub = 'Fuel';
    this.el.tooltip.innerHTML = `${def.label}${sub ? `<em>${sub}</em>` : ''}`;
    this.el.tooltip.classList.remove('hidden');
    this.el.tooltip.style.left = `${this._cursorXY.x}px`;
    this.el.tooltip.style.top = `${this._cursorXY.y}px`;
  }

  _hideTooltip() { this.el.tooltip.classList.add('hidden'); }

  // --- screens --------------------------------------------------------------

  /**
   * @param {string} kind 'inventory' | 'bench' | 'kiln' | 'shop'
   * @param {*} state the kiln's state object, or the merchant mob for a shop
   */
  openScreen(kind, state) {
    this.screen = kind;
    this.kiln = kind === 'kiln' ? state || null : null;
    this.crate = kind === 'crate' ? state || null : null;
    this.shop = kind === 'shop' ? state || null : null;
    this.el.screenTitle.textContent =
      kind === 'bench' ? 'Workbench' : kind === 'kiln' ? 'Kiln'
        : kind === 'shop' ? 'Merchant' : kind === 'crate' ? 'Crate' : 'Inventory';
    this.el.screenTop.innerHTML = '';
    this.craftSlots = null; this.craftMap = null; this.kilnSlots = null;
    this.crateSlots = null; this.offhandEl = null;
    this.shopEls = null;

    if (kind === 'kiln') this._buildKilnUI();
    else if (kind === 'crate') this._buildCrateUI();
    else if (kind === 'shop') this._buildShopUI();
    else this._buildCraftUI(kind === 'bench' ? 3 : 2);

    // The craftable sidebar is dead weight while trading — the merchant's two
    // lists want the width more than a recipe book does. A crate has no craft
    // grid either, so the sidebar sat there answering a question the screen
    // cannot ask, with "Nothing yet, without a bench" against a quarter of the
    // panel's width and nothing to spend it on.
    this.el.recipePanel.classList.toggle('hidden', kind === 'shop' || kind === 'crate');
    // With the sidebar gone the crate is the one screen whose content does not
    // fill an 830px sheet, and it sat in the middle of it with the title a hand
    // away to the left. The shop keeps the full width; its two columns want it.
    this.el.screenEl.classList.toggle('snug', kind === 'crate');

    this.el.screenEl.classList.remove('hidden');
    this.refresh();
  }

  closeScreen() {
    this.el.screenEl.classList.add('hidden');
    this.screen = null;
    this.kiln = null;
    this.crate = null;
    this.crateSlots = null;
    this.shop = null;
    this.shopEls = null;
    this.craftSlots = null;
    this.el.recipePanel.classList.remove('hidden');
    this._hideTooltip();
  }

  get screenOpen() { return !this.el.screenEl.classList.contains('hidden'); }

  _buildCraftUI(size) {
    const inv = this.game.inventory;
    const wrap = document.createElement('div');
    wrap.className = 'craft-area';
    const grid = document.createElement('div');
    grid.className = `craft-grid g${size}`;
    this.craftSlots = [];
    this.craftMap = [];
    const indices = size === 2 ? [0, 1, 3, 4] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    indices.forEach((gi, k) => {
      const d = document.createElement('div');
      d.className = 'islot';
      this._wireSlot(d, () => inv.craft[gi]);
      grid.appendChild(d);
      this.craftSlots.push(d);
      this.craftMap.push(inv.craft[gi]);
    });
    // Drawn in CSS, not typed. It was the one glyph on this screen that is not
    // on a keyboard, and its shape depended on whichever font the browser fell
    // back to.
    const arrow = document.createElement('div');
    arrow.className = 'craft-arrow';
    const outWrap = document.createElement('div');
    outWrap.className = 'craft-out';
    this.craftOut = document.createElement('div');
    this.craftOut.className = 'islot';
    this.craftOutSlot = new Slot();
    this._wireSlot(this.craftOut, () => this.craftOutSlot, { output: true });
    outWrap.appendChild(this.craftOut);
    wrap.append(this._buildOffhandUI(), grid, arrow, outWrap);
    this.el.screenTop.appendChild(wrap);
  }

  /**
   * The offhand slot, on the left edge of every inventory screen.
   *
   * It was built as its own column rather than as a fifth cell in the worn
   * armour column, on the grounds that armour was on its way out and an offhand
   * built inside it would have to be rescued out of it. Armour is now out, and
   * this needed no rescuing — the removal was one line in `_buildCraftUI`.
   *
   * No `accepts` filter — see the class of decision in the report. Anything you
   * can carry can go in the left hand, including a pickaxe, because barring an
   * item from a slot that only carries and displays would be a rule with no
   * consequence behind it. It accepts a full stack for the same reason.
   */
  _buildOffhandUI() {
    const col = document.createElement('div');
    col.className = 'offhand-col';
    const d = document.createElement('div');
    d.className = 'islot offhand-slot';
    // Read through `this.game.inventory` rather than the `inv` captured above:
    // the slot object itself is replaced wholesale by `loadOffhand`, so a
    // captured reference would go on editing the previous world's stack.
    this._wireSlot(d, () => this.game.inventory.offhand);
    const cap = document.createElement('span');
    cap.className = 'slot-cap';
    // The key, and nothing at all in its place on a phone. `F` advertised there
    // was a straight lie — there is no key to press — and there is no touch
    // gesture to name in its stead either: swapping is the HUD cell's tap, and
    // the HUD is behind this screen. In here the slot is worked the way every
    // other slot in the bag is worked, by picking things up and putting them
    // down, so the caption has nothing left to say but which slot it is.
    cap.innerHTML = this.game.input.touch ? 'Off' : 'Off <kbd>F</kbd>';
    col.append(d, cap);
    this.offhandEl = d;
    return col;
  }

  _refreshCraftOutput() {
    const size = this.screen === 'bench' ? 3 : 2;
    const rec = findRecipe(this.game.inventory.craftGrid(size), size, size, this.screen === 'bench');
    if (rec) this.craftOutSlot.set(rec.out, rec.count);
    else this.craftOutSlot.clear();
    this._paint(this.craftOut, this.craftOutSlot);
  }

  /**
   * Three rows of nine wired straight to the crate's own slots, so the existing
   * pick-up / split / shift-move plumbing works on them with no special cases.
   */
  _buildCrateUI() {
    const c = this.crate;
    const wrap = document.createElement('div');
    wrap.className = 'crate-area';
    const grid = document.createElement('div');
    grid.className = 'inv-grid crate-grid';
    this.crateSlots = [];
    c.slots.forEach((slot, i) => {
      const d = document.createElement('div');
      d.className = 'islot';
      this._wireSlot(d, () => c.slots[i], { container: true });
      grid.appendChild(d);
      this.crateSlots.push(d);
    });
    wrap.appendChild(grid);
    this.el.screenTop.appendChild(wrap);
  }

  _refreshCrate() {
    if (!this.crate || !this.crateSlots) return;
    for (let i = 0; i < this.crateSlots.length; i++) {
      this._paint(this.crateSlots[i], this.crate.slots[i]);
    }
  }

  _buildKilnUI() {
    const k = this.kiln;
    const wrap = document.createElement('div');
    wrap.className = 'smelt-area';

    const col = (label, slot) => {
      const c = document.createElement('div');
      c.className = 'smelt-col';
      const d = document.createElement('div');
      d.className = 'islot';
      this._wireSlot(d, () => slot);
      const cap = document.createElement('span');
      cap.className = 'smelt-label';
      cap.textContent = label;
      c.append(d, cap);
      return { c, d };
    };
    const inp = col('In', k.input);
    const fuel = col('Fuel', k.fuel);
    const out = col('Out', k.output);

    const mid = document.createElement('div');
    mid.className = 'smelt-col';
    this.kilnFlame = document.createElement('div');
    this.kilnFlame.className = 'flame';
    this.kilnFlame.innerHTML = '<i></i>';
    this.kilnArrow = document.createElement('div');
    this.kilnArrow.className = 'progress-arrow';
    this.kilnArrow.innerHTML = '<i></i>';
    mid.append(this.kilnArrow, this.kilnFlame);

    const left = document.createElement('div');
    left.className = 'smelt-col';
    left.append(inp.c, fuel.c);

    wrap.append(left, mid, out.c);
    this.el.screenTop.appendChild(wrap);
    this.kilnSlots = { input: inp.d, fuel: fuel.d, output: out.d };
  }

  _refreshKiln() {
    const k = this.kiln;
    if (!k) return;
    this._paint(this.kilnSlots.input, k.input);
    this._paint(this.kilnSlots.fuel, k.fuel);
    this._paint(this.kilnSlots.output, k.output);
    this.kilnFlame.querySelector('i').style.setProperty('--burn', `${100 - Math.round((k.burn / Math.max(1, k.burnMax)) * 100)}%`);
    this.kilnArrow.querySelector('i').style.width = `${Math.round((k.progress / Math.max(0.001, k.progressMax)) * 100)}%`;
  }

  // --- shop -----------------------------------------------------------------

  _buildShopUI() {
    const wrap = document.createElement('div');
    wrap.className = 'shop-area';

    const purse = document.createElement('div');
    purse.className = 'shop-purse';
    purse.innerHTML = '<img alt="" /><b></b><span>coins</span>';

    const column = (title, note) => {
      const c = document.createElement('div');
      c.className = 'shop-col';
      const h = document.createElement('h3');
      h.textContent = title;
      const list = document.createElement('div');
      list.className = 'shop-list';
      const empty = document.createElement('p');
      empty.className = 'recipe-empty';
      empty.textContent = note;
      c.append(h, list, empty);
      return { c, list, empty };
    };
    const wares = column('For Sale', 'Nothing');
    const goods = column('Your Goods', 'Nothing');

    // The errand goes above the counter, because it is the reason to have
    // walked over here rather than one more line of stock.
    const errand = document.createElement('div');
    errand.className = 'shop-errand hidden';

    const cols = document.createElement('div');
    cols.className = 'shop-cols';
    cols.append(wares.c, goods.c);
    wrap.append(purse, errand, cols);
    this.el.screenTop.appendChild(wrap);

    this.shopEls = { purse, wares, goods, errand };
  }

  /** The trader's standing request, or nothing if he wants for nothing. */
  _refreshErrand() {
    const g = this.game;
    const el = this.shopEls?.errand;
    const req = this.shop?.request;
    if (!el) return;
    if (!req) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = '';

    const def = ITEMS[req.item];
    const have = g.inventory.count(req.item);
    const ready = !req.done && have >= req.count;

    const img = document.createElement('img');
    img.src = this.icons.item(req.item);
    const text = document.createElement('span');
    text.className = 'errand-text';
    text.innerHTML = req.done
      ? '<b>Thank you</b>'
      : `<b>Wanted</b> ${req.count} x ${def?.label ?? '?'} <em>(you have ${have})</em>`;

    const tag = document.createElement('span');
    tag.className = 'shop-price';
    const coin = document.createElement('img');
    coin.src = this.icons.item(COIN_ITEM);
    tag.append(coin, document.createTextNode(String(req.reward)));

    el.append(img, text, tag);
    el.classList.toggle('ready', ready);
    el.classList.toggle('done', !!req.done);
    if (!ready) return;

    const go = document.createElement('button');
    go.className = 'errand-go';
    go.textContent = 'Hand over';
    go.addEventListener('click', () => {
      if (fulfilRequest(g.inventory, req, this.shop?.purse)) {
        g.audio.pickup();
        g.ui.toast(`Paid ${req.reward} coins`, COIN_ITEM, 2600);
        g.inventory.changed();
        this.refresh();
      }
    });
    el.appendChild(go);
  }

  /**
   * One tradeable line. Deliberately a button rather than a slot: dragging a
   * stack onto a merchant has no obvious price, and every attempt at it needs
   * a confirmation step that a click already is.
   */
  _shopRow(item, price, qty, onClick) {
    const def = ITEMS[item];
    const row = document.createElement('div');
    row.className = 'recipe-row shop-row';

    const img = document.createElement('img');
    img.src = this.icons.item(item);
    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = def?.label ?? '?';
    const have = document.createElement('span');
    have.className = 'ryield';
    have.textContent = `x${qty}`;

    const tag = document.createElement('span');
    tag.className = 'shop-price';
    const coin = document.createElement('img');
    coin.src = this.icons.item(COIN_ITEM);
    tag.append(coin, document.createTextNode(String(price)));

    row.append(img, name, have, tag);
    row.addEventListener('click', (e) => onClick(e.shiftKey ? 10 : 1));
    return row;
  }

  _refreshShop() {
    const g = this.game;
    const mob = this.shop;
    if (!this.shopEls || !this.icons) return;
    const { purse, wares, goods } = this.shopEls;

    purse.querySelector('img').src = this.icons.item(COIN_ITEM);
    purse.querySelector('b').textContent = coinsOf(g.inventory);
    // Show what the trader can still pay. Without it, a sale that stops halfway
    // through a stack looks like a bug rather than a merchant running dry.
    let float = purse.querySelector('.shop-float');
    if (!float) {
      float = document.createElement('em');
      float.className = 'shop-float';
      purse.appendChild(float);
    }
    const left = mob?.purse?.coins ?? 0;
    float.textContent = `trader ${left}`;
    float.classList.toggle('low', left < 40);
    this._refreshErrand();

    const stock = (mob?.stock || []).filter((s) => s.count > 0);
    wares.list.innerHTML = '';
    wares.empty.classList.toggle('hidden', stock.length > 0);
    for (const line of stock) {
      const price = buyPriceOf(line.item);
      wares.list.appendChild(this._shopRow(line.item, price, line.count, (n) => {
        const got = buyFrom(g.inventory, mob.stock, line.item, n);
        if (got) {
          g.audio.pickup();
            this.toast(`Bought ${ITEMS[line.item].label}`, line.item, 1400);
        } else g.audio.deny();
        this.refresh();
      }));
    }

    // Aggregate the pack by item: thirty-one cobblestone across four slots is
    // one decision, not four.
    const owned = new Map();
    for (const s of g.inventory.slots) {
      if (s.empty || !canSell(s.item)) continue;
      owned.set(s.item, (owned.get(s.item) || 0) + s.count);
    }
    goods.list.innerHTML = '';
    goods.empty.classList.toggle('hidden', owned.size > 0);
    for (const [item, qty] of owned) {
      const price = sellPriceOf(item);
      goods.list.appendChild(this._shopRow(item, price, qty, (n) => {
        const before = mob?.purse?.coins ?? 0;
        const sold = sellTo(g.inventory, item, n, mob?.purse);
        if (sold) {
          g.audio.pickup();
          // Any hand that changes counts as a trade — see MARKS.trade. Buying,
          // selling and filling his errand are three ways of doing the one
          // thing the mark is for, which is meeting the merchant at all.
            this.toast(`Sold ${sold} x ${ITEMS[item].label}`, COIN_ITEM, 1400);
          // Say so when the purse is what stopped the sale, or it reads as a bug.
          if (sold < n && mob?.purse && mob.purse.coins < sellPriceOf(item)) {
            this.toast('Out of coin', COIN_ITEM, 2200);
          }
        } else if (mob?.purse && before < sellPriceOf(item)) {
          this.toast('Out of coin', COIN_ITEM, 2200);
          g.audio.deny();
        } else g.audio.deny();
        this.refresh();
      }));
    }

    // Both columns cap at 28vh, which lands mid-row on most screens and slices
    // the fifth line of stock in half against a hard edge. A half row is the
    // right affordance — it says there is more — but only once it reads as
    // continuing rather than as clipped, so fade the lists that actually
    // overflow. `.scrolls` cannot be a static rule: a short list would have its
    // last row dimmed for nothing.
    for (const l of [wares.list, goods.list]) {
      l.classList.toggle('scrolls', l.scrollHeight > l.clientHeight + 1);
    }
  }

  // --- growth ---------------------------------------------------------------

  /**
   * The skill tree, on K.
   *
   * Its own overlay rather than a tab of the inventory screen: that screen is
   * built around slots you drag things between and there is nothing here to
   * drag.
   *
   * One column. It used to be two, with an aside listing every source of XP and
   * every unearned first, and that aside was the screen apologising for the
   * game: a player who can read a table of weights does not have to go and find
   * out what the planet pays for, which is the part that was worth doing. The
   * numbers still exist in `Skills.js`, where a rule belongs, and the tree is
   * now the whole of what K opens.
   *
   * Rebuilt from scratch on every refresh. It is thirty-odd elements, it is
   * only ever repainted when a point is spent or earned, and the alternative is
   * a dozen cached node references that have to be kept in step with a model
   * that already computes the whole answer in one call.
   */
  openSkills() {
    this.el.skills.classList.remove('hidden');
    this.refreshSkills();
  }

  closeSkills() {
    this.el.skills.classList.add('hidden');
    this._hideTooltip();
  }

  get skillsOpen() { return !this.el.skills.classList.contains('hidden'); }

  /** Repaint if it is up, and do nothing at all if it is not. */
  refreshSkills() {
    if (!this.skillsOpen) return;
    const sk = this.game.skills;
    const left = sk.available;

    this.el.skPoints.textContent = left;
    this.el.skPoints.classList.toggle('none', left <= 0);
    // The number, and the word for what it is. It used to carry the spend and
    // the lifetime total beside it, which is two more numbers than the question
    // "can I afford this row" has ever needed.
    this.el.skSub.textContent = left === 1 ? 'point' : 'points';

    const tree = this.el.skTree;
    tree.innerHTML = '';
    tree.appendChild(this._xpBar(sk));
    for (const s of sk.summary()) {
      const row = document.createElement('div');
      // Leaves are indented under their root. The prerequisite is the shape of
      // this tree and a flat list of six would hide it — a player who cannot
      // see that Lungs sits behind Agility reads "Needs Agility 2" as a refusal
      // rather than as a route.
      row.className = `skill-row${BRANCHES[s.key].needs ? ' leaf' : ''}`;
      if (s.level >= s.max) row.classList.add('maxed');

      const head = document.createElement('div');
      head.className = 'skill-head-row';
      const name = document.createElement('span');
      name.className = 'skill-name';
      name.textContent = s.label;
      const pips = document.createElement('span');
      pips.className = 'skill-pips';
      // Drawn as one pip per level rather than as "3/5", so the shape of what
      // is left is legible without reading a number — and so a branch with
      // three levels visibly is a shorter branch than one with five.
      for (let i = 0; i < s.max; i++) {
        const p = document.createElement('i');
        if (i < s.level) p.className = 'on';
        pips.appendChild(p);
      }
      head.append(name, pips);

      const blurb = document.createElement('p');
      blurb.className = 'skill-blurb';
      blurb.textContent = s.blurb;

      const buy = document.createElement('button');
      buy.className = 'skill-buy';
      if (s.blocked) {
        buy.disabled = true;
        // The module's own wording, not this file's. `blockedBy` is where the
        // one decision about how a refusal is phrased lives.
        buy.textContent = s.blocked;
        // "Not enough points" is the one refusal that is about the player's
        // balance rather than about the branch, and it is the one they can do
        // something about — so it still shows the price.
        if (s.blocked === 'Not enough points') buy.textContent = `Learn ${s.cost}`;
        buy.classList.toggle('short', s.blocked === 'Not enough points');
      } else {
        buy.textContent = `Learn ${s.cost}`;
        buy.onclick = () => this.game.buySkill(s.key);
      }

      row.append(head, blurb, buy);
      tree.appendChild(row);
    }
  }

  /**
   * The level bar: what you are, what the next level needs, in xp.
   *
   * This is the fix for the complaint that earning points was confusing, and
   * the confusion had a precise cause worth recording so it is not rebuilt. The
   * screen used to print `Blocks mined  0/22`, in which the 22 was the maximum
   * number of *points* the source could ever pay while the 0 was a count of
   * *blocks* — two different units, one slash, neither labelled. A player read
   * it as "0 of 22 blocks" and then mined a thousand expecting linear pay.
   *
   * There is one number now and it says what it is. The bar fills toward the
   * next level and the shortfall is stated in xp. The line that used to sit
   * beside the level, saying each one costs 5% more than the last, has gone
   * with the aside: the curve is something a player feels, and a menu that
   * announces its own arithmetic is a menu explaining the game to itself.
   */
  _xpBar(sk) {
    const p = sk.xpProgress();
    const box = document.createElement('div');
    box.className = `xp-block${p.maxed ? ' maxed' : ''}`;

    const head = document.createElement('div');
    head.className = 'xp-head';
    // Three words beside the level, and they are the only sentence on this
    // screen about where a number comes from. They earn the space because the
    // answer changed: xp used to come from ore, fish, crafts, the clock and the
    // marks, and a player who mined all evening and saw the bar sit still would
    // have no way to find out why. It is a label, not an explanation — how much
    // a kill is worth is something the planet says by paying you.
    head.innerHTML = `<b>Level ${p.level}</b><em>XP from kills</em>`;

    const bar = document.createElement('div');
    bar.className = 'xp-bar';
    const fill = document.createElement('i');
    fill.style.width = `${(p.frac * 100).toFixed(1)}%`;
    bar.appendChild(fill);

    const foot = document.createElement('div');
    foot.className = 'xp-foot';
    const total = `${p.xp.toLocaleString('en-GB')} xp`;
    foot.innerHTML = p.maxed
      ? `<span>${total}</span><em>Maxed</em>`
      : `<span>${total}</span><em>${p.toNext.toLocaleString('en-GB')} to next</em>`;

    box.append(head, bar, foot);
    return box;
  }

  // --- HUD updates ----------------------------------------------------------

  showItemName(text) {
    this.el.itemName.textContent = text;
    this.el.itemName.classList.add('show');
    clearTimeout(this._nameTimer);
    this._nameTimer = setTimeout(() => this.el.itemName.classList.remove('show'), 1500);
  }

  /**
   * Name whatever the crosshair is on. `null` clears it.
   *
   * Called every frame, so it does the change check itself rather than trusting
   * the caller to: writing `textContent` unconditionally would dirty the layout
   * sixty times a second to set the same string. Aiming at a block is the normal
   * state of play, not an event, which is also why this is styled quieter than
   * the held-item name and fades in a tenth of a second — a label that lags
   * behind the crosshair is describing something you have stopped looking at.
   */
  setLookAt(text) {
    if (text === this._lookAt) return;
    this._lookAt = text;
    if (!text) { this.el.lookAt.classList.remove('show'); return; }
    this.el.lookAt.textContent = text;
    this.el.lookAt.classList.add('show');
  }

  /**
   * Drive one vital bar. `show` false hides the row entirely — breath, food and
   * stamina only earn their space once they are not full.
   * @param {HTMLElement} row
   * @param {number} frac 0..1
   * @param {string} icon CSS background-image for the glyph
   * @param {string} label text beside the bar
   * @param {boolean} show
   */
  _vital(row, frac, icon, label, show) {
    row.classList.toggle('hidden', !show);
    if (!show) return;
    const f = Math.max(0, Math.min(1, frac));
    // Cache the icon: it is a data URI several hundred bytes long, and writing
    // it every frame churns the style recalc for a value that almost never
    // changes.
    const ico = row.querySelector('.v-ico');
    if (ico.dataset.art !== icon) { ico.style.backgroundImage = icon; ico.dataset.art = icon; }
    row.querySelector('.v-track b').style.width = `${f * 100}%`;
    const num = row.querySelector('.v-num');
    if (num.textContent !== label) num.textContent = label;
  }

  updateVitals(health, maxHealth, breath, stamina, energy = 1) {
    const hp = Math.max(0, Math.round(health));
    this._vital(this.el.vHealth, health / maxHealth, HEART_FULL, `${hp}/${maxHealth}`, true);
    this.el.vHealth.classList.toggle('critical', health > 0 && health <= maxHealth * 0.25);

    // Each of these only appears once you have actually spent some, so a healthy
    // player sees one bar rather than a dashboard.
    this._vital(this.el.vFood, energy, CRUMB(true), `${Math.round(energy * 100)}%`,
      energy < 0.995);
    this._vital(this.el.vStamina, stamina, STAMINA_ICON, `${Math.round(stamina * 100)}%`,
      stamina < 0.995);
    this._vital(this.el.vBreath, breath, BUBBLE(true), `${Math.round(breath * 100)}%`,
      breath < 0.999);
  }

  updateStatus(clockFraction, biomeId, weatherLabel, season = null) {
    const mins = Math.round(clockFraction * 1440);
    const h = String(Math.floor(mins / 60) % 24).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    this.el.clockText.textContent = `${h}:${m}`;
    this.el.clockDial.style.transform = `rotate(${clockFraction * 360}deg)`;
    this.el.chipBiome.textContent = BIOME_NAMES[biomeId] ?? '-';
    this.el.chipWeather.textContent = weatherLabel;
    // "Autumn 2" rather than "Autumn": which day of the season is the part a
    // farmer needs, since it says how long is left to bring a field in.
    if (season && this.el.chipSeason) {
      this.el.chipSeason.textContent = `${season.name} ${season.dayOfSeason}`;
    }
    this._paintPackChip();
  }

  /**
   * Show or hide the "not saving" chip.
   *
   * Driven from `Game.saveGame` rather than polled, and it carries the reason
   * as a tooltip: the chip has room for two words, and "QuotaExceededError" is
   * the difference between a player who clears some space and a player who
   * thinks the game is broken.
   *
   * @param {boolean} on
   * @param {string} why one line, shown on hover
   */
  setSaveWarning(on, why = '') {
    const el = this.el.chipSave;
    if (!el) return;
    el.classList.toggle('hidden', !on);
    el.title = on ? why : '';
  }

  /**
   * Relabel Save & Quit after a failed save, so the second press cannot be an
   * accident. A button that has just refused to do what it says must say what
   * it will do instead — "press again" in a toast the player may have looked
   * away from is not enough when the cost is the whole session.
   */
  setQuitConfirm(on) {
    const el = this.el.pzQuit;
    if (!el) return;
    el.textContent = on ? 'Quit WITHOUT Saving' : 'Save & Quit to Menu';
    el.classList.toggle('danger', on);
  }

  /** Distance and bearing back to the pack you dropped when you died. */
  _paintPackChip() {
    const g = this.game;
    const site = g.deathSite;
    const el = this.el.chipPack;
    if (!el) return;
    if (!site) { el.classList.add('hidden'); return; }
    const p = g.player;
    // How far you have to *walk*, not how far it is through the planet. The
    // bearing below was already rebuilt on the sphere; the distance was a
    // straight line, which on a ball of radius ~132 quietly understates the
    // trip — by a tenth for a death over the hill, and by better than a third
    // for one on the far side, where the chord cuts through the core.
    const c = g.planet.center;
    _here.copy(p.position).sub(c);
    _there.copy(site.pos).sub(c);
    const radius = _here.length();
    const cosA = _here.normalize().dot(_there.normalize());
    const d = Math.acos(Math.max(-1, Math.min(1, cosA))) * radius;
    el.classList.remove('hidden');
    this.el.packDist.textContent = `${Math.round(d)}m`;

    // Bearing in the player's own tangent plane — on a sphere a compass has to
    // be rebuilt from the local frame, there is no global north to lean on.
    _dir.copy(site.pos).sub(p.position);
    _dir.addScaledVector(p.up, -_dir.dot(p.up));
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();
    _right.copy(p.forward).cross(p.up).normalize();
    const ang = Math.atan2(_dir.dot(_right), _dir.dot(p.forward));
    el.firstElementChild.style.transform = `rotate(${ang}rad)`;
  }

  /**
   * The same line, said to a device with no keys.
   *
   * A key name in player-facing text is a lie on a phone, and this is the layer
   * that can tell: `<kbd>` is rendered here, the touch flag is on `input`, and
   * the game code that writes the text has no business asking which platform is
   * reading it. So the strings stay written for the keyboard, in one voice, and
   * the translation happens once, at the door.
   *
   * Two rules, and no more, because a general dictionary of key names would
   * quietly rewrite text nobody had checked:
   *
   *   - `<kbd>` runs come out. "<kbd>RMB</kbd> Trade" is "Trade" on a phone,
   *     where there is one button that could possibly mean it.
   *   - "Press K" becomes the gesture that actually opens Growth. The skill
   *     toasts are the reason this exists: they fire on every level, they are
   *     the only thing that ever sends a player to that screen, and on a phone
   *     they named a key that does not exist to open a screen that could not be
   *     reached. See `_tapHoldBtn` for the door they now point at.
   *
   * Both are exact matches against text this repo owns. If a string changes
   * shape the worst case is that the keyboard wording survives to the phone,
   * which is where it started.
   */
  _keyless(text) {
    if (!this.game.input?.touch || !text) return text;
    return String(text)
      .replace(/<kbd>[^<]*<\/kbd>\s*\+?\s*/g, '')
      .replace(/Press K(?: to spend (?:it|them))?\.?/g, 'Hold the bag.')
      .trim();
  }

  toast(rawText, iconItem = 0, ms = 2000) {
    const text = this._keyless(rawText);
    // merge repeats of the same pickup instead of stacking a wall of toasts
    const existing = [...this.el.toasts.children].find((c) => c.dataset.key === text);
    if (existing) {
      clearTimeout(+existing.dataset.timer);
      // Bring it back if it was on its way out.
      //
      // `_dropToast` marks a node `out` and only takes it off the DOM 340ms
      // later, and for that third of a second it is still a child carrying its
      // key - so a second catch of the same fish inside that window merged onto
      // a corpse. The reset timer was doing nothing, the pending removal fired
      // anyway, and the toast the player had just earned vanished. Measured:
      // fire the same text twice across the fade and the stack settles empty.
      //
      // So a merge revives: cancel the removal, drop the class, and let it run
      // its life again from now.
      clearTimeout(+existing.dataset.kill);
      existing.classList.remove('out');
      existing.dataset.timer = setTimeout(() => this._dropToast(existing), ms);
      return;
    }
    const d = document.createElement('div');
    d.className = 'toast';
    d.dataset.key = text;
    if (iconItem && this.icons) {
      const img = document.createElement('img');
      img.src = this.icons.item(iconItem);
      d.appendChild(img);
    }
    d.appendChild(document.createTextNode(text));
    this.el.toasts.appendChild(d);
    d.dataset.timer = setTimeout(() => this._dropToast(d), ms);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  _dropToast(d) {
    d.classList.add('out');
    // Kept so a merge arriving mid-fade can cancel it - see `toast`.
    d.dataset.kill = setTimeout(() => d.remove(), 340);
  }

  setHint(raw) {
    const text = this._keyless(raw);
    if (!text) { this.el.hint.classList.add('hidden'); return; }
    this.el.hint.innerHTML = text;
    this.el.hint.classList.remove('hidden');
  }

  setCrosshairActive(on) { this.el.crosshair.classList.toggle('active', on); }

  /**
   * The fishing fight, once a frame while one is running.
   *
   * Three numbers and a flag, and all four go out as custom properties on one
   * element: the shuttle and the fish are positioned by `calc()` off them, so
   * the whole bar is one style write per frame rather than four element writes.
   * Rounded to three places first and skipped when nothing moved enough to see,
   * for the same reason `setCrosshairDraw` does it — this runs at 60fps over a
   * lit planet.
   *
   * @param {{x:number, half:number, fx:number, p:number, on:boolean}|null} s
   *   shuttle centre, shuttle half-width, fish, progress, all 0..1 in track
   *   widths; null to take the bar down.
   */
  fishFight(s) {
    const el = this.el.fishBar;
    if (!el) return;
    if (!s) {
      if (this._fbKey === null) return;
      this._fbKey = null;
      el.classList.add('hidden');
      // The stack only has to clear this bar, so the bar is what moves it.
      document.body.classList.remove('fighting');
      return;
    }
    const key = `${s.x.toFixed(3)} ${s.fx.toFixed(3)} ${s.p.toFixed(3)} ${s.half.toFixed(3)} ${s.on ? 1 : 0}`;
    if (key === this._fbKey) return;
    if (this._fbKey === null || this._fbKey === undefined) {
      el.classList.remove('hidden');
      document.body.classList.add('fighting');
    }
    this._fbKey = key;
    el.style.setProperty('--fb-x', s.x.toFixed(3));
    el.style.setProperty('--fb-half', s.half.toFixed(3));
    el.style.setProperty('--fb-fish', s.fx.toFixed(3));
    el.style.setProperty('--fb-p', s.p.toFixed(3));
    el.classList.toggle('on', !!s.on);
  }


  /**
   * The bow's charge, as the sight closing in on the shot.
   *
   * Wide and loose at the start of the draw, tight at full — which is the read
   * every game that has ever done this uses, and it is the right one: the sight
   * *is* the accuracy, so the player learns the curve without a number or a bar
   * anywhere on screen. It costs one CSS variable and no new element.
   *
   * The `.drawing` class also kills the 120ms transform transition, which exists
   * so the `.active` pop eases and would otherwise turn a per-frame value into a
   * spring that lags the draw by a tenth of a second.
   *
   * Guarded on a visible change rather than written every frame: this is a style
   * write on the HUD and the draw only moves about a hundredth per frame.
   *
   * @param {number} t 0..1, or 0 for "not drawing"
   */
  setCrosshairDraw(t) {
    const el = this.el.crosshair;
    if (t <= 0) {
      if (this._drawT === 0) return;
      this._drawT = 0;
      el.classList.remove('drawing');
      el.style.removeProperty('--draw-scale');
      return;
    }
    if (this._drawT !== undefined && Math.abs(t - this._drawT) < 0.01) return;
    this._drawT = t;
    el.classList.add('drawing');
    el.style.setProperty('--draw-scale', (2.4 - 1.4 * t).toFixed(3));
  }

  /**
   * A critical hit just landed: flash the sight.
   *
   * Retriggerable, which is the only fiddly part — a CSS animation does not
   * restart because the class went on again while it was already running, so
   * the class comes off, the layout is read back to force the reflow, and it
   * goes on again. Without that, crit-crit-crit at speed animates once.
   *
   * The timer is cleared per call rather than left to pile up, so a fast second
   * crit cannot have the first one's timeout strip its class mid-flash.
   */
  critHit() {
    const el = this.el.crosshair;
    clearTimeout(this._critTimer);
    el.classList.remove('crit');
    void el.offsetWidth;
    el.classList.add('crit');
    this._critTimer = setTimeout(() => el.classList.remove('crit'), 300);
  }

  /**
   * Show the sight only where it tells the truth — first person.
   *
   * Separate from `setCrosshairActive`, which is the highlight state for "there
   * is something in range". One is what the sight is doing; this is whether
   * there is a sight at all.
   */
  showCrosshair(on) { this.el.crosshair.classList.toggle('hidden', !on); }
  setDebug(text) { this.el.debug.textContent = text; }
  toggleDebug() { this.el.debug.classList.toggle('hidden'); }
  get debugOn() { return !this.el.debug.classList.contains('hidden'); }
}
