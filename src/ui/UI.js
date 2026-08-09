// DOM layer: main menu, compact HUD, inventory / crafting / smelting screens.

import * as THREE from 'three';
import { BLOCKS } from '../world/Blocks.js';
import { ITEMS } from '../game/Items.js';
import { Slot, HOTBAR, TOTAL } from '../game/Inventory.js';
import { BRANCHES, EARNED, MARKS } from '../game/Skills.js';
import { findRecipe, availableRecipes, craftFromInventory } from '../game/Recipes.js';
import {
  COIN_ITEM, buyPriceOf, sellPriceOf, canSell, buyFrom, sellTo, coinsOf, fulfilRequest,
} from '../game/Trade.js';
import {
  CharacterPicker, CHARACTER_IDS, GRID_COLS, GRID_ROWS, characterUrl,
} from '../player/Character.js';
import { BIOME_COLORS, R_SEA, F, cidx } from '../world/Constants.js';
import { patchColumn } from '../world/Sphere.js';
import { compassFrame, POLAR_REF_SWAP } from '../render/Sky.js';

const BIOME_NAMES = ['Ocean', 'Shore', 'Plains', 'Woodland', 'Taiga', 'Desert', 'Savanna', 'Tundra', 'Snowfield', 'Highlands', 'Meadow', 'Badlands'];

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
 * 81 columns at a stride of one covers ±40 columns, and a column at sea level
 * is 0.955 world units across (`cellArc(282)`), so the disc is about 77 units
 * wide: a couple of minutes' walk, big enough to hold a whole lake or the near
 * side of a mountain and small enough that the biome you are standing in is
 * still recognisably a shape rather than a colour. It also upscales to the
 * 148px tile by under 2x, which is the difference between a map and a blur.
 *
 * Measured, because a per-frame budget was the reason not to use a second
 * camera: one full sample pass is 0.35ms (60 passes across all six faces,
 * warm). That is the entire cost of the feature and it is not paid per frame —
 * see `updateMinimap` — which works out at 2.8ms per second of *sprinting* and
 * nothing at all while you stand still.
 */
const MAP_SAMPLES = 81;
const MAP_STEP = 1;
const MAP_RADIUS = ((MAP_SAMPLES - 1) / 2) * MAP_STEP;
/**
 * Shortest gap between two redraws, in ms.
 *
 * The map's content depends on nothing but which column you are standing in —
 * `colHeight` and `colBiome` are worldgen's own tables and no block you place
 * ever changes them — so the redraw trigger is simply "the centre column
 * changed". Sprinting crosses 6.8 columns a second, which would be 6.8 half-
 * millisecond spikes a second; this caps it at eight, and because the map is
 * 81 columns wide a fifth of a second of walking moves the picture by 1% of its
 * own width.
 */
const MAP_REDRAW_MS = 120;
/** Radius of the visible disc, and where the north pip sits on it, in px. */
const MAP_SIZE = 148;
const MAP_RIM = 61;

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

// --- compass ----------------------------------------------------------------

/** Pixels per degree on the strip, and half the visible window. */
const CMP_PX = 3.2;
const CMP_HALF = 160;
/**
 * Where the compass gives up, as |Y × up| — see `compassFrame`, which is where
 * this number's meaning lives.
 *
 * Fully lit down to 31° from the pole and gone by 18°, which is exactly where
 * the sky's own frame swaps its reference axis. That swap is not a rounding
 * detail: standing over ±X and crossing it, east flips a full 180°, so a strip
 * that carried on through it would swing end to end for one step sideways. The
 * honest reading is that a bearing *relative to the pole* does not exist at the
 * pole, so inside the cap there is no strip — only the word.
 *
 * Both ends are derived from POLAR_REF_SWAP rather than written down, so the
 * compass can never end up drawing on the far side of the discontinuity if the
 * sky ever moves it — with the dark end held a further half a percent short of
 * it. That margin is not decoration: `polar` comes back from a hypot of a
 * normalised vector and this constant from a square root of a product, so a
 * threshold sitting exactly on the flip resolved by floating-point luck and
 * measured as still 2.7e-16 lit *at* the discontinuity. Half a percent is a
 * degree of latitude, and it makes "dark before the flip" true by arithmetic
 * rather than by rounding.
 */
export const POLAR_HIDE = Math.sqrt(1 - (POLAR_REF_SWAP * 0.995) ** 2);
export const POLAR_FULL = Math.sqrt(1 - (POLAR_REF_SWAP * 0.9) ** 2);

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
    const dj = (sy - MAP_RADIUS) * MAP_STEP;
    for (let sx = 0; sx < N; sx++) {
      out[sy * N + sx] = patchColumn(f, i, j, (sx - MAP_RADIUS) * MAP_STEP, dj);
    }
  }
  return out;
}

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(game) {
    this.game = game;
    this.icons = null;
    this.screen = null;               // null | 'inventory' | 'bench' | 'kiln' | 'shop'
    this.stationPos = null;
    this.kiln = null;                 // active kiln state object
    this.shop = null;                 // the merchant being traded with
    this._nameTimer = null;
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
      screenEl: $('screen'), screenTitle: $('screen-title'), screenTop: $('screen-top'),
      invMain: $('inv-main'), invHot: $('inv-hot'),
      cursor: $('cursor-stack'), tooltip: $('tooltip'),
      recipePanel: $('recipe-panel'),
      recipeList: $('recipe-list'), recipeCount: $('recipe-count'), recipeEmpty: $('recipe-empty'),
      pause: $('pause'), settings: $('settings'), controls: $('controls'), death: $('death'),
      deathCause: $('death-cause'),
      chargen: $('chargen'), cgCanvas: $('cg-canvas'), cgGrid: $('cg-grid'),
      cgStatus: $('cg-status'),
      skills: $('skills'), skPoints: $('sk-points'), skSub: $('sk-sub'),
      skTree: $('sk-tree'), skEarned: $('sk-earned'), skMarks: $('sk-marks'),
    };

    /** Built the first time New Game is pressed, and kept — see `CharacterPicker.close`. */
    this._picker = null;
    this._chosen = null;
    this._cgKey = (e) => this._characterKey(e);

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
    // 148px, so the browser's own bilinear filter does the upscale. Drawing at
    // 148x148 directly would mean either 148 columns of samples (three times
    // the work for detail finer than the terrain has) or nearest-neighbour
    // blocks the size of a fingernail.
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
    const polar = document.createElement('span');
    polar.className = 'cmp-polar';
    polar.textContent = 'No bearing — the pole is underfoot';
    cmp.append(win, notch, polar);
    hud.appendChild(cmp);

    this._cmpTrack = track;
    this._cmpTurn = null;

    this.el.minimap = map;
    this.el.mmNorth = north;
    this.el.compass = cmp;
    this.el.cmpPolar = polar;

    // ---- the two settings rows ---------------------------------------------
    // Inserted before the credits, which is where the last checkbox ends and
    // the reading matter begins.
    const settings = document.querySelector('#settings .settings');
    const credits = settings?.querySelector('.note.credits');
    const check = (id, text, hint) => {
      const l = document.createElement('label');
      l.className = 'row';
      l.innerHTML = `<input id="${id}" type="checkbox" /> ${text}`
        + (hint ? `<small>${hint}</small>` : '');
      settings.insertBefore(l, credits);
    };
    // Not guarded. `syncSettings` reads both of these by id on every open, so a
    // missing settings panel has to be a throw here rather than two checkboxes
    // that quietly never exist.
    check('set-minimap', 'Minimap', 'The disc top-left. It has no global north — it turns with you.');
    check('set-compass', 'Compass', 'Bearings across the top. North is where the sun says it is.');

    // ---- the Controls sheet ------------------------------------------------
    const grid = document.querySelector('.controls-grid');
    if (grid) {
      const row = document.createElement('div');
      row.innerHTML = '<kbd>C</kbd><span>Hold to zoom in on what you are looking at</span>';
      // After V, which is the other line about what the camera is doing.
      const v = [...grid.children].find((d) => d.querySelector('kbd')?.textContent === 'V');
      grid.insertBefore(row, v ? v.nextSibling : null);
    }
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
    // giving up over about ten seconds of travel instead of a HUD element
    // blinking out from under you.
    const lit = compassLit(polar);
    el.style.opacity = lit.toFixed(2);
    el.classList.toggle('polar', lit <= 0);
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
   * sphere: the map turns with you, and the north the compass is using is
   * marked on the rim rather than nailed to the top. So the two agree — they
   * are reading the same frame — without the map being useless in the polar cap
   * where that frame runs out.
   *
   * The rotation is CSS on the canvas element, not a transform on the drawing.
   * The picture is only redrawn when the centre column changes; turning on the
   * spot must therefore cost a `transform` write and nothing else.
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
    // Image space has y downward, so this angle is clockwise from the +i axis
    // on screen; bringing it to the top of the disc is a quarter turn back.
    const face = Math.atan2(_cellF.j, _cellF.i);
    const spin = -face - Math.PI / 2;
    const q = Math.round(spin * 500);
    if (q !== this._mmTurn) {
      this._mmTurn = q;
      this._mmCtx.canvas.style.transform = `rotate(${(spin * 180 / Math.PI).toFixed(2)}deg)`;
    }

    // The north pip, on the rim, out of the same call the compass made — which
    // is what guarantees the two cannot end up pointing different ways.
    // `bearingOf` fills `_north` on the way past; the angle it returns is the
    // compass's business, not the map's.
    const lit = compassLit(bearingOf(player.up, player.forward, _east, _north).polar);
    const pip = this.el.mmNorth;
    pip.style.opacity = lit.toFixed(2);
    if (lit > 0) {
      player.tangentToCell(_north, _cellN);
      const at = Math.atan2(_cellN.j, _cellN.i) + spin;
      pip.style.transform = `translate(-50%,-50%) translate(${(Math.cos(at) * MAP_RIM).toFixed(1)}px,${(Math.sin(at) * MAP_RIM).toFixed(1)}px)`;
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
        const o = n * 4;
        d[o] = Math.min(255, 255 * r ** MAP_GAMMA);
        d[o + 1] = Math.min(255, 255 * g ** MAP_GAMMA);
        d[o + 2] = Math.min(255, 255 * b ** MAP_GAMMA);
        d[o + 3] = 255;
      }
    }
    this._mmCtx.putImageData(this._mmImage, 0, 0);
  }

  // --- wiring ---------------------------------------------------------------

  _bind() {
    const g = this.game;
    $('mm-continue').onclick = () => g.continueGame();
    $('mm-new').onclick = () => g.newGame();
    $('mm-settings').onclick = () => this.openSettings();
    $('mm-controls').onclick = () => this.openControls();

    $('cg-begin').onclick = () => g.beginWorld(this._chosen);
    $('cg-back').onclick = () => g.abandonNewGame();

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
    $('sk-reset').onclick = () => {
      if (g.skills.spent > 0 && window.confirm('Unlearn every skill and take all your points back?')) {
        g.resetSkills();
      }
    };
    document.querySelector('[data-close-settings]').onclick = () => this.closeSettings();
    document.querySelector('[data-close-controls]').onclick = () => this.closeControls();

    const s = g.settings;
    const bind = (id, ev, fn) => { $(id).addEventListener(ev, fn); };
    bind('set-sens', 'input', (e) => { s.sensitivity = +e.target.value; $('sens-val').textContent = (+e.target.value).toFixed(2); g.persistSettings(); });
    bind('set-vol', 'input', (e) => { s.volume = +e.target.value / 100; $('vol-val').textContent = e.target.value; g.audio.setVolumes(s.volume, s.music); g.persistSettings(); });
    bind('set-mus', 'input', (e) => { s.music = +e.target.value / 100; $('mus-val').textContent = e.target.value; g.audio.setVolumes(s.volume, s.music); g.persistSettings(); });
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

  // --- loading + menu -------------------------------------------------------

  progress(p, label) {
    this.el.loadFill.style.width = `${Math.round(p * 100)}%`;
    if (label) this.el.loadStatus.textContent = label;
  }

  loaded() {
    this.el.loader.classList.add('done');
    setTimeout(() => this.el.loader.remove(), 650);
  }

  showMenu(meta) {
    this.el.menu.classList.remove('hidden');
    this.showHud(false);
    // Just "Continue". The button used to carry the biome, the minutes played
    // and the date of the save, which is a paragraph answering a question
    // nobody asked: there is one save, and pressing this returns you to it.
    // The only part that was ever load-bearing is whether it works at all.
    this.el.mmContinue.disabled = !meta;
  }

  hideMenu() { this.el.menu.classList.add('hidden'); }

  // --- the New Game character picker ----------------------------------------

  /**
   * Put the wall of characters up. The planet is already generating behind it,
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
      this._buildCharacterCells();
    }
    this._chosen = selected;
    this.el.chargen.classList.remove('hidden');
    this.characterPickerReady(false);
    this._syncCharacterCells();
    // After the overlay is visible, never before: the canvas has no measurable
    // size while its parent is `display: none`.
    this._picker.open(selected, characterUrl(selected));
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

  get characterPickerOpen() { return !this.el.chargen.classList.contains('hidden'); }

  /** The line under the wall: worldgen's progress, told as a sentence. */
  characterPickerReady(ready) {
    this.el.cgStatus.textContent = ready ? 'Your planet is ready' : 'Shaping your planet…';
    this.el.cgStatus.classList.toggle('ready', !!ready);
  }

  _buildCharacterCells() {
    const grid = this.el.cgGrid;
    // Both the buttons and the 3D layout come from the same two numbers, so the
    // hit target is always over the figure it belongs to.
    grid.style.gridTemplateColumns = `repeat(${GRID_COLS}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${GRID_ROWS}, 1fr)`;
    this.el.cgCanvas.style.aspectRatio = `${GRID_COLS} / ${GRID_ROWS}`;
    for (const id of CHARACTER_IDS) {
      const b = document.createElement('button');
      b.className = 'cg-cell';
      b.dataset.id = id;
      // There is nothing to read in these cells, so the label is all a screen
      // reader has. The letter is the character's actual name in the pack.
      b.setAttribute('aria-label', `Character ${id.toUpperCase()}`);
      b.onclick = () => this.chooseCharacter(id);
      // Double-click is "this one, go" — the same shortcut a file list gives you.
      b.ondblclick = () => this.game.beginWorld(id);
      grid.appendChild(b);
    }
  }

  chooseCharacter(id) {
    if (id === this._chosen) return;
    this._chosen = id;
    this._picker?.setSelected(id);
    this._syncCharacterCells();
    this.game.audio.ui(560);
  }

  _syncCharacterCells() {
    for (const b of this.el.cgGrid.children) b.classList.toggle('on', b.dataset.id === this._chosen);
  }

  /**
   * Keyboard on the wall: arrows walk it, Enter starts, Escape backs out.
   *
   * Escape is deliberately not "accept" — the picker is skippable by pressing
   * the button that is already focused, and a key that both dismisses a screen
   * and commits a world would be the one way to start a planet by accident.
   */
  _characterKey(e) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -GRID_COLS, ArrowDown: GRID_COLS }[e.key];
    if (step !== undefined) {
      const n = CHARACTER_IDS.indexOf(this._chosen);
      const next = Math.max(0, Math.min(CHARACTER_IDS.length - 1, (n < 0 ? 0 : n) + step));
      this.chooseCharacter(CHARACTER_IDS[next]);
    } else if (e.key === 'Enter') {
      this.game.beginWorld(this._chosen);
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

  showDeath(cause) {
    // Just what killed you. The screen used to add a sentence promising your
    // pack was still where you fell and would wait for you — reassuring the
    // first time and padding every time after, and the death marker already
    // says it on the map without spending a line of the death screen on it.
    this.el.deathCause.textContent = cause;
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

  // --- slot rendering -------------------------------------------------------

  setIcons(icons) {
    this.icons = icons;
    // Icons for modelled items are rendered off the game's own renderer, and
    // arrive a beat after the model does — hence the repaint hook.
    icons.attach(this.game.renderer, () => this.refresh());
    this.refresh();
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
    if (made) { g.audio.pickup(); g.stats.crafted += made; }
    this.refresh();
  }

  _paint(el, slot, big) {
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
    // is the same kind of fact: the key that puts this slot in your hand.
    this.el.offhand.dataset.num = 'F';
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
    this.el.recipeEmpty.textContent = hasTable
      ? 'Gather materials to see what you can make.'
      : 'Gather materials, or stand at a workbench for the bigger recipes.';

    list.innerHTML = '';
    for (const { recipe, cost } of options) {
      const def = ITEMS[recipe.out];
      const row = document.createElement('div');
      row.className = 'recipe-row';
      row.title = `Craft ${def.label}`;

      const img = document.createElement('img');
      img.src = this.icons.item(recipe.out);
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = def.label;
      const yield_ = document.createElement('span');
      yield_.className = 'ryield';
      yield_.textContent = recipe.count > 1 ? `×${recipe.count}` : '';

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
          this.game.audio.pickup();
          this.game.stats.crafted += made;
        } else {
          this.game.audio.ui(240);
        }
        this.refresh();
      });
      list.appendChild(row);
    }
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
    if (def.bow) sub = `Weapon · ${def.tool.durability - slot.wear}/${def.tool.durability}`;
    else if (def.tool) sub = `${def.tool.kind === 'sword' ? 'Weapon' : 'Tool'} · tier ${def.tool.tier} · ${def.tool.durability - slot.wear}/${def.tool.durability}`;
    else if (def.block !== undefined) sub = 'Placeable block';
    else if (def.food) sub = `Food · restores ${def.food}`;
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
        : kind === 'shop' ? 'Wandering Merchant' : kind === 'crate' ? 'Crate' : 'Inventory';
    this.el.screenTop.innerHTML = '';
    this.craftSlots = null; this.craftMap = null; this.kilnSlots = null;
    this.crateSlots = null; this.offhandEl = null;
    this.shopEls = null;

    if (kind === 'kiln') this._buildKilnUI();
    else if (kind === 'crate') this._buildCrateUI();
    else if (kind === 'shop') this._buildShopUI();
    else this._buildCraftUI(kind === 'bench' ? 3 : 2);

    // The craftable sidebar is dead weight while trading — the merchant's two
    // lists want the width more than a recipe book does.
    this.el.recipePanel.classList.toggle('hidden', kind === 'shop');

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
    const arrow = document.createElement('div');
    arrow.className = 'craft-arrow';
    arrow.textContent = '→';
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
    cap.innerHTML = 'Off <kbd>F</kbd>';
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
    const wares = column('For Sale', 'The pack is empty. Try the next one along.');
    const goods = column('Your Goods', 'Nothing to sell — everything you find has a price.');

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
      ? `<b>Thank you.</b> That is exactly what I needed.`
      : `<b>Wanted:</b> ${req.count} × ${def?.label ?? '?'} <em>(you have ${have})</em>`;

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
        g._mark('trade');
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
    have.textContent = `×${qty}`;

    const tag = document.createElement('span');
    tag.className = 'shop-price';
    const coin = document.createElement('img');
    coin.src = this.icons.item(COIN_ITEM);
    tag.append(coin, document.createTextNode(String(price)));

    row.append(img, name, have, tag);
    row.title = 'Click for one, shift-click for ten';
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
    float.textContent = `trader has ${left}`;
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
          g._mark('trade');
          this.toast(`Bought ${ITEMS[line.item].label}`, line.item, 1400);
        } else g.audio.ui(240);
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
          g._mark('trade');
          this.toast(`Sold ${sold} × ${ITEMS[item].label}`, COIN_ITEM, 1400);
          // Say so when the purse is what stopped the sale, or it reads as a bug.
          if (sold < n && mob?.purse && mob.purse.coins < sellPriceOf(item)) {
            this.toast('The merchant is out of coin', COIN_ITEM, 2200);
          }
        } else if (mob?.purse && before < sellPriceOf(item)) {
          this.toast('The merchant is out of coin', COIN_ITEM, 2200);
          g.audio.ui(240);
        } else g.audio.ui(240);
        this.refresh();
      }));
    }
  }

  // --- growth ---------------------------------------------------------------

  /**
   * The skill tree, on K.
   *
   * Its own overlay rather than a tab of the inventory screen, for two reasons.
   * The inventory screen is built around slots you drag things between and
   * there is nothing here to drag; and this is the screen you open to *read*
   * — six branches, six prices and a reason each is or is not available — which
   * wants the whole width rather than the column the worn armour used to have.
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
    // Both halves of the balance, because "8 points" on its own does not say
    // whether the tree has been touched. Spent is the part a player checks
    // before deciding to unlearn everything.
    this.el.skSub.textContent = left === 1
      ? `1 point to spend · ${sk.spent} spent`
      : `${left} points to spend · ${sk.spent} spent`;

    const tree = this.el.skTree;
    tree.innerHTML = '';
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
        if (s.blocked === 'Not enough points') buy.textContent = `Learn · ${s.cost}`;
        buy.classList.toggle('short', s.blocked === 'Not enough points');
      } else {
        buy.textContent = `Learn · ${s.cost}`;
        buy.onclick = () => this.game.buySkill(s.key);
      }

      row.append(head, blurb, buy);
      tree.appendChild(row);
    }

    this._paintEarned();
  }

  /**
   * Where the points came from, and what is still out there.
   *
   * This half of the screen is the answer to the only question a tree with no
   * XP bar invites: "how do I get more?". Every source is shown with the count
   * the game has actually been keeping and the cap it is worth, so a player can
   * see at a glance that mining has another twelve points in it and that fish
   * are close to spent.
   */
  _paintEarned() {
    const g = this.game;
    const sk = g.skills;

    const earned = this.el.skEarned;
    earned.innerHTML = '';
    for (const key in EARNED) {
      const src = EARNED[key];
      const count = key === 'playtime' ? g.playtime : (g.stats?.[key] ?? 0);
      // Points from this source, by the module's own formula. Recomputed here
      // rather than exposed by `observe`, which reports one total on purpose —
      // this is a readout, and a model field per source would be five more
      // things to keep in step for the sake of one panel.
      const n = Math.min(src.cap, Math.floor(Math.sqrt(count / src.per)));
      const row = document.createElement('div');
      row.className = 'earn-row';
      const shown = key === 'playtime'
        ? `${Math.floor(count / 60)}m`
        : String(Math.floor(count));
      row.innerHTML = `<span>${src.label}</span><em>${shown}</em><b>${n}/${src.cap}</b>`;
      earned.appendChild(row);
    }
    if (sk.bonus > 0) {
      const row = document.createElement('div');
      row.className = 'earn-row bonus';
      row.innerHTML = `<span>Armour, converted</span><em>—</em><b>${sk.bonus}</b>`;
      earned.appendChild(row);
    }

    const marks = this.el.skMarks;
    marks.innerHTML = '';
    for (const key in MARKS) {
      const m = MARKS[key];
      const has = sk.marks.has(key);
      const row = document.createElement('div');
      row.className = `mark-row${has ? ' got' : ''}`;
      // The hint is shown whether or not it has been earned. A locked mark that
      // will not say what it wants is a riddle, and this game has no room for
      // one — the marks are a list of things worth doing, not a puzzle.
      row.innerHTML = `<span>${has ? m.label : m.hint}</span><b>${m.points}</b>`;
      marks.appendChild(row);
    }
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
    this.el.chipBiome.textContent = BIOME_NAMES[biomeId] ?? '—';
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

  toast(text, iconItem = 0, ms = 2000) {
    // merge repeats of the same pickup instead of stacking a wall of toasts
    const existing = [...this.el.toasts.children].find((c) => c.dataset.key === text);
    if (existing) {
      clearTimeout(+existing.dataset.timer);
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
    setTimeout(() => d.remove(), 340);
  }

  setHint(text) {
    if (!text) { this.el.hint.classList.add('hidden'); return; }
    this.el.hint.innerHTML = text;
    this.el.hint.classList.remove('hidden');
  }

  setCrosshairActive(on) { this.el.crosshair.classList.toggle('active', on); }

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
