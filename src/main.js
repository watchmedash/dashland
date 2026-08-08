// Mojazer — a voxel tiny planet.

import * as THREE from 'three';
import { Planet } from './world/Planet.js';
import { Player, VIEW_FIRST, VIEW_COUNT, VIEW_LABELS } from './player/Player.js';
import { ViewModel } from './player/ViewModel.js';
import { PlayerCharacter, playerModelUrls } from './player/Character.js';
import { Input } from './player/Input.js';
import { Sky } from './render/Sky.js';
import { PostFX } from './render/PostFX.js';
import { Particles } from './render/Particles.js';
import { BlockModels, CAP as BLOCK_MODEL_CAP } from './render/BlockModels.js';
import { createVoxelMaterials, buildTileTextures, buildCrackTexture, voxelUniforms } from './render/VoxelMaterial.js';
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
  ITEMS, computeDrops, miningTime, itemIdOf, harvestHint, ARMOUR_SLOT_ORDER,
} from './game/Items.js';
import { smeltingFor, FUEL } from './game/Recipes.js';
import {
  BLOCKS, ID, IS_SOLID, RENDER_TYPE, R_LIQUID, R_CROSS, IS_TORCH, IS_DIRECTIONAL, IS_AXIS, IS_SLAB,
  IS_STAIR, IS_LADDER, IS_DOOR, IS_SIGN, FACING_DEFAULT,
} from './world/Blocks.js';
import {
  F, D, R_MIN, R_MAX, R_SEA, R_TERRAIN_MAX, COLUMNS, cidx, vidx,
  FACES, CT, CK, CHUNK_T, CHUNK_K, NUM_CHUNKS, chunkIdx,
  CHUNK_LOAD_DIST, CHUNK_KEEP_DIST,
  NUM_REGIONS, REGION_COLS, REGION_VOXELS, GEN_VERSION, regionColumns,
} from './world/Constants.js';
import {
  colParts, cornerPos, colNeighbor, tangentFrame, stepColumn, cellCenterPos,
} from './world/Sphere.js';
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
const WHITE = new THREE.Color(1, 1, 1);
const WHITE_L = [1, 1, 1];
/** Cells the hand-light scan reaches; must cover the brightest block light. */
const HAND_LIGHT_RADIUS = 8;
/**
 * How far a carried flame throws, in cells, and how hard.
 *
 * Deliberately shorter and softer than the light the same torch gives once it
 * is planted in a wall. A carried torch that lit as far as a placed one would
 * make placing them pointless, and the whole shape of mining — light the shaft
 * behind you or lose it — depends on that trade.
 */
const HAND_LIGHT_REACH = 9.5;
const HAND_LIGHT_GAIN = 2.1;

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
const FLAME_PERIOD = 0.14;
/** Seconds of immunity after a guarded hit, so a crowd cannot burst you down. */
const HURT_IMMUNITY = 0.5;

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
 */
const FLOWER_NAMES = ['flower_red', 'flower_blue', 'flower_gold', 'mushroom'];
const FLOWER_KIND = [];
const FLOWER_HEIGHT = 0.62;
for (const n of FLOWER_NAMES) if (ID[n]) FLOWER_KIND[ID[n]] = n;

const DEFAULT_SETTINGS = {
  fov: 75, sensitivity: 1.0, renderScale: 1,
  volume: 0.7, music: 0.35, post: true, bob: true, invertY: false, autoJump: false,
  // Minutes for one full day and night, or 0 to follow the device clock.
  //
  // 0 is the default: the planet keeps your hours, so its evening is your
  // evening. The cost is real and worth stating — a cycle is then 24 real hours
  // long, so a player who only ever plays at noon never meets a husk, never
  // needs a torch, and sees none of the night. The slider is still there for
  // anyone who would rather have a short game cycle.
  dayMinutes: 0,
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
    this.seed = 0;
    this.worldReady = false;
    this.autosaveTimer = 0;
    /** chunk ids that currently have (or have been asked for) a mesh */
    this.liveChunks = new Set();
    this._streamPending = false;
    this._streamTimer = 0;
    this._hurtGuard = 0;

    this._initRenderer();
    this.inventory = new Inventory();
    this.ui = new UI(this);
    this.audio = new Audio();
    this.audio.setVolumes(this.settings.volume, this.settings.music);
    this.input = new Input(this.canvas);
    this.input.invertY = this.settings.invertY;
    this.input.onLockChange = (locked) => {
      if (!locked && this.state === 'playing' && !this.ui.screenOpen) {
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
    this.player.autoJump = !!this.settings.autoJump;
    this.viewModel = new ViewModel((id) => this.drops.createItemMesh(id));
    this.sky = new Sky(this.scene, this.renderer);
    this.particles = new Particles(this.scene, this.planet);
    this.blockModels = new BlockModels(this.scene);
    this.drops = new Drops(this.scene, this.planet, this.materials);
    this.mobs = new Mobs(this.scene, this.planet, this.drops);
    // Creatures speak for themselves — idle calls, pain and death, all anchored
    // in the world so you can hear which direction the herd is in.
    this.mobs.onSound = (kind, mob) => this.audio.mob(mob.type, kind, mob.pos);
    this.mobs.onAttack = (dmg, mob) => this._takeHit(dmg, mob);
    this.mobs.onBurn = (mob) => this.particles.embers(mob.pos, mob.up, 2, 0.55);
    this.drops.onBurn = (pos) => {
      _burnUp.copy(pos).normalize();
      this.particles.embers(pos, _burnUp, 5, 0.7);
    };
    // A merchant is rare enough that missing one because you were facing the
    // other way would be a genuine loss. Say so once, and let the bells do the
    // rest of the work.
    //
    // Measured: over 150 seconds a trader never came within talking range of a
    // player who stayed put — closest 11 cells, median 28 — while ringing 15
    // times. He is found by walking towards the sound, never by waiting, so
    // this line has to be a reason to set off rather than a description of a
    // noise. Naming what he wants does that; it does not say where he is,
    // which is the bell's job.
    this.mobs.onMerchant = (mob) => {
      // Quoted with its count rather than lowercased into a sentence: item
      // labels are singular nouns, and "after ruby" or "after glass" reads
      // wrong however you bend it. A quantity dodges the grammar and tells the
      // player whether they can already fill it.
      const req = mob.request;
      const wants = req && !req.done
        ? ` Someone wants ${req.count} × ${ITEMS[req.item]?.label ?? 'something'}.`
        : '';
      this.ui.toast(`Bells, somewhere close by.${wants}`, itemIdOf('coin'), 5200);
      this.audio.mob(mob.type, 'idle', mob.pos);
    };
    // The player's body. Built after Drops because it borrows the same factory
    // the drops use — what you carry and what you dropped are the same mesh.
    this.character = new PlayerCharacter(this.scene, (id) => this.drops.createItemMesh(id));
    this.viewModel.onPunch = () => this.character.punch();
    /** Which camera the F5 cycle is on. First person is the default and always will be. */
    this.viewMode = VIEW_FIRST;

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
    this.placeCooldown = 0;
    this.useCooldown = 0;
    /** Seconds since the last swing landed, for the attack rhythm. */
    this.attackT = ATTACK_PERIOD;
    this.damageFlash = 0;
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
    this.liveChunks.clear();
    this._streamPending = false;
    this._streamTimer = 0;
    this._welcome = false;
    this.drops.clear();
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

  newGame() {
    this.ui.hideMenu();
    document.body.appendChild(this._makeLoaderShell());
    this.ui.progress(0, 'Igniting the core');
    this._resetWorld();
    this.seed = (Math.random() * 0x7fffffff) | 0;
    this._pendingSave = null;
    this._startWorker();
    this.worldWorker.postMessage({ type: 'init', seed: this.seed });
  }

  async continueGame() {
    const data = await Save.read();
    if (!data) { this.ui.showMenu(null); return; }
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
    this._startWorker();

    // Put the saved regions straight into the mirror rather than waiting for
    // the worker to echo them back. The message below is a structured clone —
    // nothing is transferred — so both sides end up with their own copy for the
    // price of the one the browser was going to make anyway.
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
      <h1>DASH<em>CRAFT</em></h1>
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
        if (this.liveChunks.has(id)) this.planet.applyChunk(msg.f, msg.ci, msg.cj, msg.ck, msg.groups);
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
    if (drop.length) for (const id of drop) this.planet.dropChunk(id);
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
      for (const k of save.kilns || []) {
        this.kilns.set(k.key, {
          input: Slot.fromJSON(k.in), fuel: Slot.fromJSON(k.fu), output: Slot.fromJSON(k.out),
          burn: k.b, burnMax: k.bm, progress: k.p, progressMax: k.pm, col: k.c, k: k.k,
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
    // Everything you carried stays where you fell, and stays there — `keep`
    // exempts it from the despawn clock. What you were *wearing* stays on you:
    // you respawn at a bed that may be a long way from your body, and sending
    // you back for it with nothing on is how a setback becomes a spiral.
    _v1.copy(this.player.position).addScaledVector(this.player.up, 0.6);
    let dropped = 0;
    for (const s of this.inventory.slots) {
      if (s.empty) continue;
      this.drops.spawn(_v1.x, _v1.y, _v1.z, s.item, s.count, s.wear, null, true);
      s.clear();
      dropped++;
    }
    this.deathSite = dropped ? { pos: _v1.clone(), at: this.playtime } : null;
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

  async quitToMenu() {
    await this.saveGame(false);
    this.ui.closePause();
    this.ui.hideDeath();
    this.closeScreen();
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
      player: {
        cell: [c.f, c.ci, c.cj, c.ck],
        forward: this.player.forward.toArray(),
        pitch: this.player.pitch,
        health: this.player.health,
        breath: this.breath,
        energy: this.energy,
      },
      inventory: this.inventory.toJSON(),
      drops: this.drops.toJSON(),
      mobs: this.mobs.toJSON(),
      crops: this.farming.toJSON(),
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

  async saveGame(notify) {
    if (!this.worldReady) return;
    try {
      await Save.write(this._savePayload());
      if (notify) this.ui.toast('Planet saved');
    } catch (err) {
      console.error(err);
      if (notify) this.ui.toast('Could not save');
    }
  }

  // --- edits ----------------------------------------------------------------

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
    // Cheap, and only does anything at all once a hearth exists.
    if (this.hearths.size) this._refreshWards();
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
    this.particles.blockBreak(center, hit.id, b.render === R_CROSS ? 10 : 26);
    this.audio.break_(b.sound, center);
    this.stats.mined++;
    this.player.swing();
    this.viewModel.punch();
    if (heldDef?.tool && b.hardness > 0.15) this.inventory.damageHeld(1);
  }

  _placeBlock(hit) {
    const held = this.inventory.held();
    const def = ITEMS[held.item];
    if (!def || def.block === undefined) return false;
    if (hit.prevCol < 0) return false;
    const id = def.block;
    const col = hit.prevCol, k = hit.prevK;
    if (k < 0 || k >= D) return false;
    const existing = this.planet.at(col, k);
    if (existing !== 0 && RENDER_TYPE[existing] !== R_LIQUID && RENDER_TYPE[existing] !== R_CROSS) return false;
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
      const taken = this.inventory.add(cur.item, cur.count);
      if (taken < cur.count) spill.push({ item: cur.item, count: cur.count - taken });
      cur.clear();
    }
    for (const s of spill) {
      _v1.copy(this.player.position).addScaledVector(this.player.up, 1);
      this.drops.spawn(_v1.x, _v1.y, _v1.z, s.item, s.count);
    }
    this.ui.closeScreen();
    this.ui.refresh();
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
      };
      this.kilns.set(key, s);
    }
    return s;
  }

  _tickKilns(dt) {
    for (const k of this.kilns.values()) {
      const recipe = k.input.empty ? null : smeltingFor(k.input.item);
      const canOutput = recipe && (k.output.empty
        || (k.output.item === recipe.out && k.output.count + recipe.count <= (ITEMS[recipe.out]?.stack ?? 64)));

      if (k.burn > 0) k.burn -= dt;
      if (k.burn <= 0 && recipe && canOutput && !k.fuel.empty && FUEL[k.fuel.item]) {
        k.burnMax = FUEL[k.fuel.item];
        k.burn = k.burnMax;
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
  _cycleView() {
    this.viewMode = (this.viewMode + 1) % VIEW_COUNT;
    this.viewModel.enabled = this.viewMode === VIEW_FIRST;
    if (this.viewMode === VIEW_FIRST) this.character.hide();
    this.ui.toast(VIEW_LABELS[this.viewMode], 0, 1400);
  }

  _frozenUpdate(dt) {
    this.player.updateCamera(this.camera, dt, this.settings.fov, this.settings.bob, this.viewMode);
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST,
      this.inventory.held().item);
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
      else this.openScreen('inventory');
      return;
    }
    if (input.pressed('F3')) ui.toggleDebug();
    // F5, the key every voxel game already uses for this, and the only spare
    // one: Input already swallows the browser's reload on it while the pointer
    // is locked, which is the reason it was in that list before anything used
    // it. Cycles first → behind → facing, and is deliberately allowed while a
    // screen is open — looking at your own character in your inventory is the
    // main thing you would want it for.
    if (input.pressed('F5')) this._cycleView();

    // A container screen takes your hands, not the world. It used to return
    // early here, which froze breath, hunger, health, physics and every animal
    // while crops and kilns carried on — you could stand underwater in your
    // inventory indefinitely and never drown. Minecraft doesn't pause for a
    // chest either. The screen now only suppresses *input*: the body below runs
    // every frame, driven by a neutral input while a screen is up.
    const busy = ui.screenOpen;
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

      if (input.locked && (input.mouseDX || input.mouseDY)) {
        this.player.look(input.mouseDX, input.mouseDY, input.sensitivity * this.settings.sensitivity, input.invertY);
      }
    }
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
      this.breath = Math.max(0, this.breath - dt / 9);
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
    this._safeTick('mobs', () => this.mobs.update(dt, this.player, this.sky));
    // A merchant that has walked out of range, run out of life or been killed
    // takes its shop with it. Without this the screen stays up over a stock
    // list belonging to a mob that no longer exists.
    if (this.ui.screen === 'shop' && !this.mobs.list.includes(this.ui.shop)) {
      this.closeScreen();
      this.ui.toast('The merchant moved on.', itemIdOf('coin'), 2600);
    }
    this.drops.update(dt, this.player, {
      collect: (item, count) => {
        const taken = this.inventory.add(item, count);
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

    this.player.updateCamera(this.camera, dt, this.settings.fov, this.settings.bob, this.viewMode);
    // After the camera, because the body hides itself when the camera has been
    // pulled in on top of it and it needs this frame's distance to know.
    this.character.update(dt, this.player, this.viewMode !== VIEW_FIRST,
      this.inventory.held().item);
    this.viewModel.setHeld(this.inventory.held().item, this.ui.icons);
    this.viewModel.update(dt, this.player, this.sky, this._handLight());
    this._updateHandLight(dt);
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
   * @param {boolean} armoured whether worn armour applies. Blows land on you
   *   through a suit; drowning and starving do not, and a helmet that saved you
   *   from suffocating would be a strange thing to have to explain.
   */
  _takeHit(damage, cause, guarded = true, armoured = true) {
    const p = this.player;
    if (p.health <= 0) return true;
    if (guarded && this._hurtGuard > 0) return false;
    if (guarded) this._hurtGuard = HURT_IMMUNITY;

    if (armoured) {
      const soaked = damage * this.inventory.protection;
      if (soaked > 0) {
        damage -= soaked;
        // Armour wears by what it actually stopped, so a hide cap outside a
        // cave lasts for days and a chestplate that ate a husk night does not.
        const broken = this.inventory.wearArmour(Math.max(1, Math.round(soaked)));
        for (const i of broken) {
          this.ui.toast(`${ARMOUR_SLOT_ORDER[i]} broke`, 0, 2200);
          this.audio.ui(180);
        }
      }
    }

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
        if (this._takeHit(3, 'The lava was not as shallow as it looked.', false)) return;
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
          if (this._takeHit(1, 'You burned.', false)) return;
        }
        if (Math.random() < dt * 12) this.particles.embers(p.eye, p.up, 1, 0.8);
      }
    }
    this.damageFlash = Math.max(this.damageFlash, p.burning > 0 ? 0.14 : 0);
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
    // Every burning cell this scan passes is also somewhere a flame should be
    // seen, and the scan is already here and already cached — collecting them
    // costs a push. Doing it as its own sweep would be a second 2 000-cell walk
    // per frame for the same answer.
    const flames = this._flameCells;
    flames.length = 0;
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
          // Only things that actually burn get a flame. Glowstone and crystal
          // are lit, not alight.
          if (FLAME_BLOCKS.has(id) && flames.length < MAX_FLAMES) {
            flames.push({ col, k, id, byte: this.planet.facingAt(col, k) });
          }
          // Falloff in cells, capped at the scan radius so it always reaches
          // exactly zero at the edge rather than being cut off mid-curve.
          const d2 = di * di + dj * dj + dk * dk;
          const reach = Math.min(emit * 0.55 + 1, RAD);
          const fall = Math.max(0, 1 - Math.sqrt(d2) / reach);
          if (fall <= 0) continue;
          const w = (emit / 15) * fall * fall;
          const lc = bl.lightColor || WHITE_L;
          r = Math.max(r, lc[0] * w); g = Math.max(g, lc[1] * w); b = Math.max(b, lc[2] * w);
        }
      }
    }
    this._hlValue = { r, g, b };
    return this._hlValue;
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
  _syncBlockModels() {
    const bm = this.blockModels;
    bm.prime('torch', itemIdOf('torch'), { height: 0.95, lean: true });
    for (const n of FLOWER_NAMES) bm.prime(n, itemIdOf(n), { height: FLOWER_HEIGHT });

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
      for (let di = -RAD; di <= RAD; di++) {
        for (let dj = -RAD; dj <= RAD; dj++) {
          const col = stepColumn(baseCol, di, dj);
          const d2 = di * di + dj * dj;
          const torchable = d2 <= TORCH_RAD * TORCH_RAD;
          for (let dk = -7; dk <= 7; dk++) {
            const k = ck + dk;
            if (k < 0 || k >= D) continue;
            const id = this.planet.at(col, k);
            const flower = FLOWER_KIND[id];
            // The one test every one of those 71 000 cells pays for. Both
            // lookups are dense arrays indexed by block id, so a cell that is
            // neither costs two loads and a branch.
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
                pos, up, out: null, d2,
                spin: ((col * 37 + k * 101) % 628) / 100,
              });
              continue;
            }

            const byte = this.planet.facingAt(col, k) & 7;
            const e = { pos, up, out: null, d2 };
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
    const held = ITEMS[this.inventory.held().item];
    const block = held?.block ? BLOCKS[held.block] : null;
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
    const want = HAND_LIGHT_REACH * (0.6 + 0.4 * (emit / 15));
    u.uHandLightRadius.value += (want - u.uHandLightRadius.value) * Math.min(1, dt * 8);
    // Just in front of and below the eye, where the hand actually is — lighting
    // from the eye itself flattens everything into a torchlit photograph.
    u.uHandLightPos.value.copy(this.player.eye)
      .addScaledVector(this.player.lookDir, 0.45)
      .addScaledVector(this.player.up, -0.35);
  }

  /** Crosshair prompt when you're looking at an animal. */
  _feedHint(mob) {
    if (!mob) return null;
    if (mob.spec.trader) return `<kbd>RMB</kbd> Trade`;
    if (mob.baby > 0) return 'Calf';
    if (mob.love > 0) return 'Ready to breed';
    const held = this.inventory.held();
    if (!held.empty && this.mobs.canFeed(held.item) && mob.breedCooldown <= 0) {
      return `<kbd>RMB</kbd> Feed`;
    }
    return null;
  }

  _announceHeld() {
    const s = this.inventory.held();
    this.ui.showItemName(s.empty ? '' : ITEMS[s.item].label);
    this.ui.refresh();
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
    if (mobHit && (!hit || mobHit.dist < hit.dist)) {
      this.ui.setCrosshairActive(true);
      this.highlight.visible = false;
      if (input.clicked[0] && input.locked) {
        const held = ITEMS[this.inventory.held().item];
        // Swings have a rhythm. Clicking is edge-triggered with no cooldown, so
        // once blows started knocking husks backwards a player could hold one
        // in the air indefinitely by clicking fast — free, skill-less immunity.
        // A swing landed early still lands, at a fraction of its weight and
        // with no shove behind it, which makes timing worth something without
        // punishing the player for touching the button.
        const charge = Math.min(1, this.attackT / ATTACK_PERIOD);
        const dmg = (held?.damage ?? 1) * (0.3 + 0.7 * charge);
        this.attackT = 0;
        this.player.swing();
        this.viewModel.punch();
        // soft flesh impact at the animal, not a grass footstep at your feet.
        // The species' own hurt/death cry comes from Mobs via onSound.
        this.audio.mobHit(mobHit.mob.pos);
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
        this.mobs.hurt(mobHit.mob, dmg, this.player.position, charge);
        if (held?.tool) this.inventory.damageHeld(1);
      }
      // Right-click offers whatever you're holding. Feeding is how a herd
      // grows, and it's the only reason to keep an animal alive.
      const heldSlot = this.inventory.held();
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
    const needTool = hit ? harvestHint(hit.id, ITEMS[this.inventory.held().item]) : null;
    if (hit && IS_SIGN[hit.id]) {
      // Reading is looking: no key to press and nothing to open, so a row of
      // signs can be read by sweeping across them.
      const text = this.signs.get(hit.col * D + hit.k);
      this.ui.setHint(text ? `“${text}”` : 'A blank sign');
    } else if (hit && (hit.id === ID.bench || hit.id === ID.kiln || hit.id === ID.kiln_lit)) {
      this.ui.setHint(`<kbd>RMB</kbd> ${hit.id === ID.bench ? 'Craft' : 'Smelt'}`);
    } else if (needTool) {
      this.ui.setHint(needTool);
    } else this.ui.setHint(null);

    const m = this.mining;
    const heldDef = ITEMS[this.inventory.held().item];
    if (input.buttons[0] && hit && input.locked) {
      const key = hit.col * D + hit.k;
      if (m.key !== key) { m.key = key; m.progress = 0; }
      const time = miningTime(hit.id, heldDef, this.player.headInWater);
      if (isFinite(time) && hit.id !== ID.core) {
        m.progress += dt / time;
        if (Math.random() < dt * 10) {
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
    const heldSlot = this.inventory.held();
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
   * Fill an empty bucket from a water cell, or pour a full one into the open
   * cell in front of whatever was hit. Water here is a static source block —
   * the world has no flow simulation — so pouring places exactly one cell,
   * which is also what makes this safe to add without liquid physics.
   * @returns {boolean} true if the bucket did something
   */
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

  _useBucket(heldSlot) {
    const empty = heldSlot.item === itemIdOf('bucket');
    // A ray that stops on liquid, which the normal interaction ray does not.
    const wet = this.planet.raycast(
      this.player.eye, this.player.lookDir, this.player.reach, { hitLiquid: true },
    );

    if (empty) {
      if (!wet || wet.id !== ID.water) return false;
      this._applyEdits([{ col: wet.col, k: wet.k, id: 0 }]);
      this.water.sources.delete(this.water.key(wet.col, wet.k));
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
    voxelUniforms.uSkyColor.value.copy(p.zenith).lerp(p.horizon, 0.55).lerp(WHITE, 0.34);
    voxelUniforms.uSkyIntensity.value = (0.34 + p.sunIntensity * 0.72) * (0.5 + w.sun * 0.5);
    voxelUniforms.uBounceColor.value.copy(p.fog).lerp(WHITE, 0.2).multiplyScalar(0.7);
    voxelUniforms.uSunDir.value.copy(this.sky.sunDir);
    voxelUniforms.uSunColor.value.copy(p.sun).multiplyScalar(w.sun);
    // Reflection sky: the palette's own hue, untouched by the whitening that
    // makes uSkyColor usable as ambient fill. Overcast drags it toward the fog
    // colour, so a grey day gives a grey sea.
    voxelUniforms.uSkyReflect.value.copy(p.zenith).lerp(p.horizon, 0.5)
      .lerp(p.fog, 1 - w.sun);
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
