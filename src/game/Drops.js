// Dropped item entities: they fall under spherical gravity, bob, spin, merge
// with nearby stacks, and drift into the player once they're close.

import * as THREE from 'three';
import { GRAVITY, BIOME_COLORS } from '../world/Constants.js';
import { tangentFrame } from '../world/Sphere.js';
import { TILE_TOP, TILE_SIDE, TILE_BOTTOM, TILE_FRONT, TINT_ID, RENDER_TYPE, R_CROSS, ID, blockBoxes, IS_OPAQUE, TILES, TILE_INDEX } from '../world/Blocks.js';

/**
 * Layers that must never take a biome tint, and the white that stands in.
 *
 * The same one-entry table the mesher keeps (`UNTINTED_LAYER` there): the dirt
 * tile is soil wherever it appears, including on the underside of a grass
 * block, and tinting it green is what made a grass block's soil disagree with
 * the dirt block beside it.
 */
const UNTINTED_LAYER = new Uint8Array(TILES.length);
for (const t of ['dirt']) UNTINTED_LAYER[TILE_INDEX[t]] = 1;
const WHITE_TINT = [1, 1, 1];
import { ITEMS } from './Items.js';
import { hasModel, worldModel } from '../render/ItemModels.js';
// The terrain's own live block-light gain, so a dropped cobble and the cobble
// wall behind it answer by the same number. Read through the uniform rather
// than copied for the reason `_entityLight` gives: a copy can drift.
import { voxelUniforms } from '../render/VoxelMaterial.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** The axis every model in `ItemModels` is authored upright along. */
const _Y = new THREE.Vector3(0, 1, 0);
const _spin = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _hover = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _flow = new THREE.Vector3();
const _frame = { ea: [0, 0, 0], eb: [0, 0, 0], up: [0, 0, 0], arcA: 1, arcB: 1 };
const _lit = new THREE.Vector3();
const _bl = { r: 0, g: 0, b: 0 };

const MAX = 260;
const PICKUP_RADIUS = 1.85;      // start drifting toward the player
const COLLECT_RADIUS = 0.55;
const MERGE_RADIUS = 0.7;
/**
 * How hard a current carries a drop, in world units/s².
 *
 * Water damps a drop at 3.4/s, so this settles at about 2.6 units/s — a little
 * faster than a walk, which is what a thing with no weight to it should look
 * like on a stream. Resting on the bed, friction of 8/s holds it to 1.1 and it
 * creeps instead. Both are well under the 5-22/s the pick-up magnet pulls at,
 * so a drop caught in a river still comes to you when you get near it.
 */
const FLOW_PUSH = 9;
/**
 * Seconds a drop survives in lava before it is gone.
 *
 * Short on purpose: this is a beat, not a grace period. Long enough that the
 * embers land and the eye follows the thing down, short enough that nobody
 * tries to fish it back out — and it cannot be fished out anyway, because the
 * pick-up magnet is refused for the whole of it.
 */
const BURN_TIME = 0.45;

export class Drops {
  constructor(scene, planet, materials) {
    this.planet = planet;
    this.center = new THREE.Vector3(0, 0, 0);
    this.list = [];

    // Blocks render as tiny textured cubes reusing the voxel material; flat
    // items render as camera-facing sprites.
    this.cubeGeo = new THREE.BufferGeometry();
    this.group = new THREE.Group();
    this.group.name = 'drops';
    scene.add(this.group);
    this.materials = materials;
    this.spriteCache = new Map();
    /** Last value handed to setSkyLevel; 1 is "as the texture was authored". */
    this._skyLevel = 1;
    /**
     * Bumped whenever the sky level moves, so a drop that is already showing
     * the right block light still re-applies. The change guard below keys on
     * both, or a card would hold dawn's brightness through to dusk.
     */
    this._skyGen = 0;
    /**
     * Where a dropped thing is, in the world's own block light. Supplied by
     * main exactly as `Mobs.blockLightAt` is, and for the same reason — the
     * field lives on that thread and this module has no business knowing how it
     * is computed. Null is a legal value and means "no block light at all",
     * which is the picture this class drew before any of it existed.
     * @type {null | ((pos: THREE.Vector3, out: {r:number,g:number,b:number}) => {r:number,g:number,b:number})}
     */
    this.blockLightAt = null;
    /**
     * Spare per-drop geometries, keyed by the shared one they were cut from.
     *
     * A block drop is drawn with the voxel material, which takes its light out
     * of a per-vertex `blockLight` attribute, so a drop that wants its own
     * light needs its own attribute and therefore its own geometry — the
     * cached one in `getBlockGeo` is shared by every drop of that block and by
     * the copy in your fist. Everything except that one attribute is shared
     * with it, so a private geometry is a few hundred bytes and one small
     * vertex buffer.
     *
     * They are pooled rather than disposed because they cannot be disposed:
     * `geometry.dispose()` frees the buffers of every attribute it holds, and
     * all but one of these are the shared original's. A mining session
     * otherwise leaks one small buffer per block picked up.
     */
    this._geoPool = new Map();
    this.iconFactory = null;
    /**
     * The flow simulation, if there is one. Optional: drops predate it and a
     * world without one should still have them fall and float correctly.
     * @type {import('./Water.js').Water|null}
     */
    this.water = null;
  }

  setIcons(icons) { this.iconFactory = icons; }

  /**
   * How lit the world is, 0..1, so the sprite drops can pretend to care.
   *
   * A drop with 3D art is a MeshStandardMaterial and takes the scene's lights
   * like any other entity. A drop without any is two crossed cards wearing an
   * inventory icon, and those are MeshBasicMaterial: unlit by construction,
   * drawn at full texture brightness at noon, at midnight and at the bottom of
   * a cave alike. Nobody noticed while the night was bright; darkening the
   * night would have left a dropped feather glowing in a black field.
   *
   * There is no light to turn down, so this turns down the albedo instead —
   * which is not physics, but is indistinguishable from it on a flat card with
   * no normal to shade. One `Color.setScalar` per *item type* that has ever been
   * dropped, not per drop, because the materials are cached and shared.
   *
   * It used to say here that block light was deliberately skipped, on the
   * grounds that a drop is 0.46 of a cell and the machinery would cost a probe
   * per drop per frame against 260 of them. The premise was right about the old
   * machinery — a march per emitter per drop — and is not right about the field
   * that replaced it: a sample is one trilinear read, 0.13 us, so a floor
   * covered in litter is under 0.04 ms between the lot of them. See
   * `_applyLight`, and `EntityLight.js` for what it is sampling.
   *
   * What is left here is the sky half, unchanged. The cached material is still
   * painted, because it is the template every drop's own copy is cut from and
   * because the held and planted forms still use it directly.
   *
   * @param {number} level 1 leaves the card exactly as it renders today
   */
  setSkyLevel(level) {
    if (this._skyLevel === level) return;
    this._skyLevel = level;
    this._skyGen++;
    for (const mat of this.spriteCache.values()) mat.color.setScalar(level);
  }

  /** Public builder so the player model can hold the same meshes. */
  createItemMesh(itemId) { return this._mesh(itemId); }

  _mesh(itemId) {
    const def = ITEMS[itemId];
    if (!def) return null;
    // Anything with a model of its own falls out of the world as that model.
    // A torch on the ground was a little cube with torch tiles on its faces,
    // which is the one thing a torch is not. Held, planted and dropped are now
    // the same object.
    if (hasModel(itemId)) {
      const m = worldModel(itemId);
      if (m) { m.userData.modelled = true; return m; }
      // Not loaded yet — the sprite below stands in, and the next drop picks
      // up the model. Never block, never throw: this runs inside a break.
    }
    // Cross-shaped blocks (flowers, grass, saplings) have no cube form — built
    // as a cube their transparent pixels render as a black box.
    if (def.block !== undefined && RENDER_TYPE[def.block] !== R_CROSS) {
      // Opaque unless the block's own tile has holes in it. A ladder is a
      // frame: its tile is mostly alpha, and drawn with the opaque material
      // those texels are not cut away, so the rungs fill in and the sides read
      // as see-through depending on which face you catch - "ladder model still
      // transparent angles both in hand, in toolbar and when placed". Glass and
      // leaves are the same shape of problem, held and dropped opaque and hard
      // clipped rather than blended.
      //
      // `cutout` is the material the world already draws these with: alphaTest
      // 0.42 and double sided, so a one-cell-thick frame reads from both faces
      // instead of vanishing when its front face is the one turned away.
      const holes = !IS_OPAQUE[def.block];
      const m = new THREE.Mesh(getBlockGeo(def.block),
        holes ? this.materials.cutout : this.materials.opaque);
      m.castShadow = false;
      m.receiveShadow = false;
      return m;
    }
    let mat = this.spriteCache.get(itemId);
    if (!mat) {
      const tex = new THREE.TextureLoader().load(this.iconFactory.item(itemId));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide });
      // Born at whatever time of day it is: setSkyLevel only walks the cache it
      // can see, so the first bone dropped at midnight would otherwise be the
      // one card in the game rendering at full brightness until dawn.
      mat.color.setScalar(this._skyLevel);
      this.spriteCache.set(itemId, mat);
    }
    // Two crossed cards, not one.
    //
    // Everything without a model of its own — a sapling, an amethyst, the hide
    // off a husk — fell out of the world as a single flat quad, and a drop
    // spins on the spot, so once a second it turned edge-on and vanished into
    // a line. That is the moment it reads as a cut-out rather than a thing.
    // Crossing a second card through it costs one extra quad and there is
    // always something facing you. It is the same trick the world already uses
    // for flowers and grass, which is why a dropped sapling now matches the
    // sapling it came from.
    const g = new THREE.Group();
    const a = new THREE.Mesh(getPlaneGeo(), mat);
    const b = new THREE.Mesh(getPlaneGeo(), mat);
    b.rotation.y = Math.PI / 2;
    g.add(a, b);
    return g;
  }

  /**
   * @param {boolean} keep true for what you were carrying when you died. Those
   *   never time out: respawning at a bed can leave your body a long way off,
   *   and losing everything you owned to a five-minute clock you could not have
   *   beaten is not a difficulty setting, it is a lost afternoon.
   */
  spawn(x, y, z, itemId, count, wear = 0, impulse = null, keep = false) {
    if (!itemId || count <= 0) return;
    // merge into an existing nearby stack of the same item
    for (const d of this.list) {
      // `d.burn` is deliberately part of the test: a pile that is already on
      // fire is not a pile you can add to. Without it a stack broken on the lip
      // of a lava lake would merge into the doomed one beside it and go up with
      // it, which is the game taking something the lava never touched.
      if (d.item === itemId && !d.collected && d.wear === wear && d.burn === undefined) {
        if (d.pos.distanceToSquared(_v.set(x, y, z)) < MERGE_RADIUS * MERGE_RADIUS) {
          const max = ITEMS[itemId]?.stack ?? 64;
          if (d.count + count <= max) {
            d.count += count;
            d.keep = d.keep || keep;
            // The pile is as old as its newest item, not its oldest. Leaving
            // the clock alone meant merging into a five-minute-old heap put the
            // thing you just mined one second from despawning — you watched
            // thirty stone and the one you added vanish together. It also let a
            // merged drop skip the anti-repickup delay below, since that is
            // measured on the same `age`.
            d.age = 0;
            return;
          }
        }
      }
    }
    // Before the eviction, not after: this can fail for an unknown item id, and
    // failing after the splice meant a legitimate drop had already been taken
    // out of the world to make room for one that never arrived.
    const mesh = this._mesh(itemId);
    if (!mesh) return;
    if (this.list.length >= MAX) {
      // Evict ordinary litter before anything from a death — otherwise a busy
      // mining session quietly pushes your body's contents out of the world.
      let victim = this.list.findIndex((d) => !d.keep);
      if (victim < 0) victim = 0;
      const old = this.list.splice(victim, 1)[0];
      this.group.remove(old.mesh);
      this._releaseLight(old);
    }
    mesh.layers.enable(1);
    this.group.add(mesh);
    const pos = new THREE.Vector3(x, y, z);
    const up = _v.copy(pos).sub(this.center).normalize();
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 1.7, (Math.random() - 0.5) * 1.7, (Math.random() - 0.5) * 1.7,
    ).addScaledVector(up, 2.1 + Math.random());
    if (impulse) vel.add(impulse);
    const drop = {
      item: itemId, count, wear, pos, vel, mesh, keep,
      age: 0, spin: Math.random() * 6.28, collected: false, grounded: false, magnet: 0,
    };
    this.list.push(drop);
    // Its own materials and its own light attribute, so two stacks of the same
    // stone lying at opposite ends of a gallery are not one object wearing one
    // brightness. See `_attachLight`.
    this._attachLight(drop);
    if (!mesh.userData.modelled) this._upgrade(drop);
  }

  /**
   * Swap a stand-in sprite for the real model once it finishes loading.
   *
   * Models load over the network, so the *first* hide off the first deer — the
   * first of anything, before anyone has held one — spawned while its GLTF was
   * still in flight and got the flat card instead. Every later one looked
   * right, which is exactly the shape of the bug that was reported: the first
   * drop is 2D and nothing after it is. Waiting for the load is not an option
   * (this runs inside a break, from the frame loop) so the drop takes the card
   * and trades up when the model lands.
   */
  _upgrade(drop) {
    if (!hasModel(drop.item)) return;
    worldModel(drop.item, (model) => {
      // It may have been picked up, burned or evicted in the meantime.
      if (drop.collected || !this.list.includes(drop)) return;
      model.userData.modelled = true;
      model.layers.enable(1);
      this.group.remove(drop.mesh);
      this.group.add(model);
      // The card's private materials and geometry go back before the model's
      // are cut, or trading up would leak one of each per drop that ever stood
      // in for a model still in flight.
      this._releaseLight(drop);
      drop.mesh = model;
      this._attachLight(drop);
    });
  }

  /**
   * Give a drop the private materials and geometry it needs to be lit on its
   * own, and record where to write the answer.
   *
   * Three kinds of thing come out of `_mesh` and each takes light by a
   * different door, which is why this is a traversal and not a line:
   *
   *  - A **block** is the voxel material with a per-vertex `blockLight`
   *    attribute, exactly as a wall of the same block is, and that attribute
   *    lives on a geometry cached per block id. It gets a private copy that
   *    shares every other attribute with the original, so the light is the only
   *    thing that is not shared.
   *  - A **card** is a MeshBasicMaterial, unlit by construction, so there is no
   *    light to raise and the albedo is raised instead. Same trick
   *    `setSkyLevel` already plays, one drop at a time.
   *  - A **model** is MeshStandardMaterial and takes the scene's lights, so it
   *    takes block light as emissive, exactly as a mob does.
   *
   * A model's materials are shared with the template every copy is cloned
   * from, so they have to be cloned here or lighting one dropped torch would
   * light every torch in the world, held and planted included.
   * `Material.clone` does not carry `onBeforeCompile` or
   * `customProgramCacheKey`, and two of the item models depend on both (see
   * the glow shaders in `ItemModels.js`), so those are carried across by hand.
   * Whatever emissive the material was authored with is kept as a floor rather
   * than overwritten, for the reason `Mobs` spells out at length: `emissive` is
   * one slot, and the second thing to assume it owns it puts out the first.
   */
  _attachLight(drop) {
    const parts = [];
    const seen = new Map();
    // One material per slot, and a mesh may legitimately have several: an item
    // model built from a multi-material geometry hands back an array here, and
    // calling `clone` on the array is what turned this into a thrown exception
    // inside `requestMesh`'s promise — which that function's catch reads as "the
    // model file is missing", marks the key as permanently failed, and drops
    // every copy of that item in the game back to sprite art. A crash in here
    // must not be able to delete a model, so the shape is handled rather than
    // assumed.
    const own = (src) => {
      let m = seen.get(src);
      if (m) return m;
      m = src.clone();
      m.onBeforeCompile = src.onBeforeCompile;
      m.customProgramCacheKey = src.customProgramCacheKey;
      seen.set(src, m);
      if (m.isMeshBasicMaterial) parts.push({ card: m });
      else parts.push({ lit: m, base: m.emissive ? m.emissive.clone() : null });
      return m;
    };
    drop.mesh.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const shared = this.materials
        && (o.material === this.materials.opaque || o.material === this.materials.cutout);
      if (shared) {
        const g = this._takeGeo(o.geometry);
        if (!g) return;
        o.geometry = g;
        const attr = g.getAttribute('blockLight');
        if (attr) parts.push({ attr });
        return;
      }
      if (Array.isArray(o.material)) o.material = o.material.map(own);
      else if (typeof o.material.clone === 'function') o.material = own(o.material);
    });
    drop.lit = parts;
    // -1 is "nothing has been written yet", which no quantised key can be, so
    // the first update always paints.
    drop.litKey = -1;
  }

  /** Hand a drop's private geometries back to the pool. Materials are let go. */
  _releaseLight(drop) {
    if (!drop || !drop.lit) return;
    for (const p of drop.lit) {
      if (!p.attr) continue;
      const g = p.attr.__geo;
      if (!g) continue;
      const free = this._geoPool.get(g.userData.litSrc);
      if (free) free.push(g);
    }
    drop.lit = null;
  }

  /**
   * A geometry that is the given one in every respect but its block light.
   *
   * Attributes are handed over by reference, which is not a shortcut: two
   * geometries sharing a BufferAttribute share one buffer on the card, so the
   * whole cost of a private copy is the one small float array below.
   */
  _takeGeo(src) {
    if (!src || !src.getAttribute || !src.getAttribute('blockLight')) return null;
    let free = this._geoPool.get(src);
    if (!free) { free = []; this._geoPool.set(src, free); }
    const spare = free.pop();
    if (spare) return spare;
    const g = new THREE.BufferGeometry();
    if (src.index) g.setIndex(src.index);
    for (const name of Object.keys(src.attributes)) {
      if (name === 'blockLight') continue;
      g.setAttribute(name, src.attributes[name]);
    }
    const n = src.getAttribute('blockLight').count;
    const attr = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    // The back reference is what lets `_releaseLight` find the geometry from
    // the attribute it recorded, without a second field on every part.
    attr.__geo = g;
    g.setAttribute('blockLight', attr);
    g.userData.litSrc = src;
    // Computed from the shared attributes, which are the same ones, so this is
    // the original's sphere and not a fresh guess at it.
    g.boundingSphere = src.boundingSphere;
    g.boundingBox = src.boundingBox;
    return g;
  }

  /**
   * Paint this frame's light onto one drop.
   *
   * Quantised to sixty-fourths and guarded on the result, so a stack lying
   * still in an unlit corner costs one comparison and a spinning one beside a
   * torch repaints only when it has actually crossed a step. The guard matters:
   * a card is a `Color.setRGB` and a block is a whole vertex buffer re-upload,
   * and there can be 260 of them.
   */
  _applyLight(d) {
    if (!d.lit) return;
    let r = 0, g = 0, b = 0;
    if (this.blockLightAt) {
      // A little above the middle of the item, which hovers over the ground:
      // sampling at the drop's own position puts it in the cell the floor
      // occupies whenever the bob is at its low point.
      // Its own scratch and nothing else's: `update` is holding the local up in
      // `_v` while this runs, and borrowing it here flung the drop a fifth of a
      // planet radius the last time that vector was shared.
      _lit.copy(d.pos).sub(this.center).normalize().multiplyScalar(0.25).add(d.pos);
      const l = this.blockLightAt(_lit, _bl);
      r = l.r; g = l.g; b = l.b;
    }
    const key = ((Math.min(255, r * 64) | 0) << 16) | ((Math.min(255, g * 64) | 0) << 8)
      | (Math.min(255, b * 64) | 0) | (this._skyGen % 64) * 0x1000000;
    if (d.litKey === key) return;
    d.litKey = key;
    // Back into the terrain's own units for the vertex attribute: the shader
    // multiplies by the same gain this was multiplied by on the way out, so a
    // dropped cobble ends up carrying exactly the level the wall behind it
    // carries.
    const gain = voxelUniforms.uBlockIntensity.value / Math.PI;
    const inv = gain > 1e-6 ? 1 / gain : 0;
    const sky = this._skyLevel;
    for (const p of d.lit) {
      if (p.attr) {
        const a = p.attr.array;
        for (let i = 0; i < a.length; i += 3) { a[i] = r * inv; a[i + 1] = g * inv; a[i + 2] = b * inv; }
        p.attr.needsUpdate = true;
      } else if (p.card) {
        // Added to the sky term rather than replacing it, and for the same
        // reason `BlockModels` gives: the neutral value of an added term is
        // zero, so a missing answer draws the card exactly as it was drawn
        // before any of this existed. A multiplied one would draw it black.
        p.card.color.setRGB(sky + r, sky + g, sky + b);
      } else if (p.lit) {
        const e = p.base;
        p.lit.emissive.setRGB(
          e ? Math.max(e.r, r) : r, e ? Math.max(e.g, g) : g, e ? Math.max(e.b, b) : b);
      }
    }
  }

  /**
   * Add one frame of the local current to a drop's velocity.
   *
   * Water.flowAt answers in the cell's own (i, j) axes, and a drop lives in
   * world space, so the answer has to be read through that cell's tangent
   * frame — the same route the mobs take to turn a heading into a step. Doing
   * it any other way across a cube seam means the six faces disagree about
   * which way "+i" points and a river changes direction as it crosses one.
   *
   * arcA/arcB are how many world units a cell step covers, and they differ
   * across a face, so they belong here: without them a flow diagonal to the
   * grid comes out skewed off the channel.
   */
  _flowPush(d, cell, dt) {
    const fl = this.water.flowAt(cell.col, cell.k);
    if (!fl) return;
    tangentFrame(cell.f, cell.i + 0.5, cell.j + 0.5, cell.k + 0.5, _frame);
    const a = fl.i * _frame.arcA, b = fl.j * _frame.arcB;
    _flow.set(
      _frame.ea[0] * a + _frame.eb[0] * b,
      _frame.ea[1] * a + _frame.eb[1] * b,
      _frame.ea[2] * a + _frame.eb[2] * b,
    );
    const len = _flow.length();
    if (len > 1e-6) _flow.multiplyScalar(1 / len);
    // Unlike the player, a drop *does* take the radial part. It is the only
    // thing that gets a drop over the lip of a waterfall: buoyancy is holding
    // it at the surface, and the surface at the lip is the top of the fall.
    //
    // Component-wise, and it has to be: `tangentFrame` hands back `up` as a
    // plain three-element array, not a Vector3, so `addScaledVector(_frame.up)`
    // multiplied `undefined` and quietly turned the drop's position into NaN —
    // which only bit in cells the water is *falling* through, since `fl.k` is
    // zero everywhere else and the line never ran. The ea/eb reads above were
    // already indexed by hand for the same reason.
    if (fl.k) {
      _flow.x += _frame.up[0] * fl.k;
      _flow.y += _frame.up[1] * fl.k;
      _flow.z += _frame.up[2] * fl.k;
    }
    d.vel.addScaledVector(_flow, FLOW_PUSH * fl.s * dt);
  }

  update(dt, player, { collect, hasRoom }) {
    const g = GRAVITY * 0.85;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.age += dt;
      d.spin += dt * 1.7;

      const up = _v.copy(d.pos).sub(this.center).normalize();

      if (d.magnet > 0) {
        // drifting into the player
        const to = _s.copy(player.eye).addScaledVector(player.up, -0.55).sub(d.pos);
        const dist = to.length();
        d.magnet = Math.min(1, d.magnet + dt * 4.5);
        d.pos.addScaledVector(to.normalize(), Math.min(dist, dt * (5 + 22 * d.magnet)));
        if (dist < COLLECT_RADIUS || d.magnet >= 1) {
          const taken = collect(d.item, d.count, d.wear);
          if (taken > 0) {
            d.count -= taken;
            if (d.count <= 0) {
              this.group.remove(d.mesh);
              this._releaseLight(d);
              this.list.splice(i, 1);
              continue;
            }
          }
          d.magnet = 0;
        }
      } else {
        // The cell address, not just the block id: the flow lookup below needs
        // the column to ask about and the face frame to read its answer in.
        const cell = this.planet.cellAt(d.pos.x, d.pos.y, d.pos.z);
        const here = cell ? this.planet.at(cell.col, cell.k) : 0;

        // Lava eats what falls into it. Without this a stack of logs sits
        // glowing in a lava lake indefinitely, and swimming out to grab it is
        // the safest way to loot a cavern — and worse, the buoyancy below only
        // ever asked about water, so a drop in lava sank to the floor of the
        // lake and stayed there, safe, forever.
        //
        // It burns over BURN_TIME rather than blinking out. A silent vanish
        // reads as the game losing your things; a couple of frames of embers
        // over the spot reads as the lava taking them, and it is long enough
        // that a player watching a chest's worth of loot go in can see what
        // happened. `onBurn` fires once, on the frame it catches, so the
        // particle burst is not re-emitted every tick of the fuse.
        //
        // Nothing is dropped and nothing is picked up while it burns: the
        // magnet trigger at the foot of this branch is gated on the same flag,
        // or a player standing beside the lake would hoover a burning stack out
        // of the fire and the whole rule would be a suggestion.
        if (here === ID.lava && d.burn === undefined) {
          d.burn = BURN_TIME;
          this.onBurn?.(d.pos);
        }
        if (d.burn !== undefined) {
          d.burn -= dt;
          if (d.burn <= 0) {
            this.group.remove(d.mesh);
            this._releaseLight(d);
            this.list.splice(i, 1);
            continue;
          }
        }

        if (this.planet.isSolidWorld(d.pos.x, d.pos.y, d.pos.z)) {
          // Already interred — a falling sand column landed on it, or someone
          // built over it. Bouncing off `next` can never help here because the
          // drop is *inside* the obstacle, so it used to freeze in the rock
          // until it timed out. Climb toward open sky instead.
          d.pos.addScaledVector(up, dt * 4);
          d.vel.set(0, 0, 0);
          d.grounded = false;
        } else {
          const inWater = here === ID.water;
          // Buoyancy, not just drag: a drop that sinks to the bed of a lake is
          // effectively gone, since you have to find it by touch.
          d.vel.addScaledVector(up, (inWater ? 1.1 : -g) * dt);
          // Carried by the current. A drop sitting perfectly still in a stream
          // it is visibly *in* is the most obviously broken thing about water,
          // more so than the player, because you are looking straight at it.
          if (inWater && this.water) this._flowPush(d, cell, dt);
          d.vel.multiplyScalar(Math.max(0, 1 - (d.grounded ? 8 : inWater ? 3.4 : 0.3) * dt));
          const next = _s.copy(d.pos).addScaledVector(d.vel, dt);
          if (this.planet.isSolidWorld(next.x, next.y, next.z)) {
            d.vel.multiplyScalar(-0.18);
            d.grounded = true;
          } else {
            d.pos.copy(next);
            d.grounded = false;
          }
        }
        if (d.burn === undefined && d.age > 0.45 && hasRoom(d.item)) {
          if (d.pos.distanceTo(player.position) < PICKUP_RADIUS) d.magnet = 0.01;
        }
      }

      // What the torch three cells away is doing to it. After the movement, so
      // it is sampled where the thing has actually ended up this frame.
      this._applyLight(d);

      // Render transform: hover + spin around the local up.
      // `up` aliases _v, so build the position in its own temp — writing to _v
      // here used to clobber `up`, which flung the drop ~20% further from the
      // planet centre and left setFromAxisAngle with a non-unit axis (whose
      // non-unit quaternion then scaled the mesh up).
      const bob = Math.sin(d.age * 2.4 + d.spin) * 0.07;
      _hover.copy(d.pos).addScaledVector(up, 0.18 + bob);
      // Stand it up first, then spin it.
      //
      // This used to be `setFromAxisAngle(up, spin)` alone, which is a rotation
      // *about* the local up and therefore leaves every component along it
      // exactly where it was: a model authored upright along +Y kept its +Y on
      // **world** +Y wherever on the planet it landed. On a flat world that is
      // invisible. On this one the error is precisely the angle between world +Y
      // and the local up, so a dropped shovel is upright at the north pole,
      // lying on its side at the equator and standing on its handle at the
      // south. Reported as "the shovel is upside down", and it was — but on the
      // ground, and it was every modelled drop in the game and not that pose.
      //
      // `BlockModels.sync` has always done this correctly for planted models
      // (the same swing-to-up followed by a spin about the model's own axis);
      // this is that, and nothing else about the transform changes. A cube or a
      // sprite card has no up to get wrong and is only helped by standing square
      // to the ground it is lying on.
      _q.setFromUnitVectors(_Y, up);
      _spin.setFromAxisAngle(_Y, d.spin);
      _q.multiply(_spin);
      const bid = ITEMS[d.item]?.block;
      const isCube = bid !== undefined && RENDER_TYPE[bid] !== R_CROSS;
      // A model is authored at its own size and only needs bringing down to
      // pick-up scale; a cube is a unit cube and a sprite is a unit quad.
      const scale = d.mesh.userData.modelled ? 0.34 : (isCube ? 0.30 : 0.46);
      const pop = Math.min(1, d.age * 5);
      _s.setScalar(scale * pop * (1 - d.magnet * 0.5));
      _m.compose(_hover, _q, _s);
      d.mesh.matrix.copy(_m);
      d.mesh.matrixAutoUpdate = false;
      d.mesh.matrixWorldNeedsUpdate = true;

      if (!d.keep && d.age > 300) {
        this.group.remove(d.mesh); this._releaseLight(d); this.list.splice(i, 1);
      }
    }
  }

  clear() {
    for (const d of this.list) { this.group.remove(d.mesh); this._releaseLight(d); }
    this.list.length = 0;
  }

  toJSON() {
    return this.list.map((d) => ({
      p: d.pos.toArray(), i: d.item, c: d.count, w: d.wear, k: d.keep ? 1 : 0,
      // How long it has been lying there. Without it every load handed the
      // whole planet's litter a fresh five minutes, so anyone who saved more
      // often than that never saw a drop despawn at all.
      a: Math.round(d.age),
    }));
  }

  fromJSON(arr) {
    this.clear();
    for (const d of arr || []) {
      const before = this.list.length;
      this.spawn(d.p[0], d.p[1], d.p[2], d.i, d.c, d.w, null, !!d.k);
      // `spawn` throws what it creates into the air, which is right for an item
      // that has just been dropped and wrong for one that was already lying
      // still when the game was saved. Loading used to toss every drop on the
      // planet upward with a random sideways kick — enough to walk a death pack
      // off the ledge it was saved on and into whatever was below.
      //
      // Guarded on the list actually growing, because `spawn` merges instead of
      // pushing when two saved drops are close enough, and the fixup would
      // otherwise land on somebody else's drop.
      if (this.list.length > before) {
        const made = this.list[this.list.length - 1];
        made.vel.set(0, 0, 0);
        made.grounded = true;
        made.age = d.a || 0;
      }
    }
  }
}

// --- geometry caches --------------------------------------------------------

const blockGeos = new Map();
let planeGeo = null;

function getPlaneGeo() {
  if (!planeGeo) planeGeo = new THREE.PlaneGeometry(1, 1);
  return planeGeo;
}

/**
 * The block, in its own shape, carrying the same attributes the chunk mesher
 * emits so a dropped or held block shades identically to the world.
 *
 * **It used to be a cube for everything**, and that is the whole of the bug the
 * owner reported as "while holding it it looks like a block, same goes for
 * other models at hand looking like blocks like the door, sign, ladder etc".
 * Forty items were affected: eighteen slabs, eighteen stairs, the ladder, the
 * door, the sign and the fence. A ladder in the fist was a solid box with rungs
 * painted on all six faces.
 *
 * The shape is not described again here. `blockBoxes` in `world/Blocks.js` is
 * already the one description of it - its own note says "collision, the mesher
 * and the ground scan all read this, so a new shape is described once here
 * rather than three times in three files" - and it is a pure function of
 * (id, byte, links) with no chunk in it. This is the fourth reader.
 *
 * What is *not* shared with the mesher is the box-to-quads step, and that is
 * structural rather than an oversight: `emitBox` and `emit` are closures inside
 * `meshChunk`, and every corner they place goes through `cornerLerp`, which
 * indexes the planet's face and absolute grid position and scales by the
 * radius. A held item has no face, no cell and no radius, and wants a flat unit
 * cell. Hoisting them out would put a per-quad indirect call on the hottest
 * loop in the game, in a worker, to save the forty lines below. See the note in
 * the report for the exact extraction if that trade ever looks worth making.
 *
 * `byte` and `links` are the pose the item is drawn in rather than the pose it
 * will be placed in: a slab low, a stair with its low side on +i, a door shut,
 * a fence reaching both ways along i so it reads as a run of fence and not as a
 * lone post.
 */
function getBlockGeo(blockId) {
  let g = blockGeos.get(blockId);
  if (g) return g;
  const pos = [], nrm = [], tan = [], uv = [], aux = [], blk = [], tint = [], idxs = [];
  const tintv = dropTint(blockId);
  const boxes = blockBoxes(blockId, 0, 0b0011);
  let v = 0;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    // Cell coordinates are (i, j, k) with k the radial axis. Held and dropped,
    // the radial axis is up, so k becomes local Y.
    const x0 = b[0] - 0.5, x1 = b[3] - 0.5;
    const z0 = b[1] - 0.5, z1 = b[4] - 0.5;
    const y0 = b[2] - 0.5, y1 = b[5] - 0.5;
    // A box may ask for its cap tile on every one of its faces — the 7th
    // element, which `emitBox` in the mesher already honours. This is the
    // fourth reader of `blockBoxes` and it has to honour the whole description,
    // not the first six numbers of it: without this a ladder's stiles wear the
    // cut-out ladder tile on three of their six faces in the fist while the
    // same stiles are solid planking on the wall, and a torch head burns on its
    // top only when it is held and on every side when it is placed.
    const cap = b[6] ? TILE_TOP[blockId] : -1;
    const top = cap >= 0 ? cap : TILE_TOP[blockId];
    const bot = cap >= 0 ? cap : TILE_BOTTOM[blockId];
    const front = cap >= 0 ? cap : TILE_FRONT[blockId];
    const side = cap >= 0 ? cap : TILE_SIDE[blockId];
    const faces = [
      { n: [0, 1, 0], layer: top, u: x1 - x0, v: z1 - z0,
        c: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
      { n: [0, -1, 0], layer: bot, u: x1 - x0, v: z1 - z0,
        c: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
      // directional blocks wear their front on +z so a tumbling drop still reads
      { n: [0, 0, 1], layer: front, u: x1 - x0, v: y1 - y0,
        c: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
      { n: [0, 0, -1], layer: side, u: x1 - x0, v: y1 - y0,
        c: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
      { n: [1, 0, 0], layer: side, u: z1 - z0, v: y1 - y0,
        c: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
      { n: [-1, 0, 0], layer: side, u: z1 - z0, v: y1 - y0,
        c: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    ];
    for (const f of faces) {
      // The mesher runs the tile 0..extent across a partial box rather than
      // 0..1, so a slab's side shows half a tile instead of a whole one
      // squashed into half the height. Same rule here or a stack of slabs in
      // the world and one in your fist are different bricks.
      const uvc = [[0, 0], [f.u, 0], [f.u, f.v], [0, f.v]];
      const t = [f.c[1][0] - f.c[0][0], f.c[1][1] - f.c[0][1], f.c[1][2] - f.c[0][2]];
      const tl = Math.hypot(t[0], t[1], t[2]) || 1;
      for (let i = 0; i < 4; i++) {
        pos.push(...f.c[i]);
        for (let a = 0; a < 3; a++) {
          if (f.c[i][a] < lo[a]) lo[a] = f.c[i][a];
          if (f.c[i][a] > hi[a]) hi[a] = f.c[i][a];
        }
        nrm.push(...f.n);
        tan.push(t[0] / tl, t[1] / tl, t[2] / tl);
        uv.push(...uvc[i]);
        aux.push(f.layer, 1, 1, 0);
        blk.push(0.15, 0.15, 0.15);
        // Per face, not per block. A grass block's bottom is the dirt tile, and
        // painting it with the grass tint made a dropped or held grass block's
        // underside olive while the dirt block beside it stayed brown - the same
        // fault that was fixed for the world faces and left here, because this
        // pushed one tint for every face of the cube.
        tint.push(...(UNTINTED_LAYER[f.layer] ? WHITE_TINT : tintv));
      }
      idxs.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  }
  // Centred on its own material and not on its cell. A full cube is unchanged
  // by this - its box is the cell - and everything else is what the fist closes
  // on: measured through the same fist-to-surface probe as the authored models,
  // every shape in this table has its own bounding-box centre inside or on its
  // material, so this is contact for all of them.
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, cz = (lo[2] + hi[2]) / 2;
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= cx; pos[i + 1] -= cy; pos[i + 2] -= cz; }

  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('atangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aux', new THREE.Float32BufferAttribute(aux, 4));
  g.setAttribute('blockLight', new THREE.Float32BufferAttribute(blk, 3));
  g.setAttribute('tint', new THREE.Float32BufferAttribute(tint, 3));
  g.setIndex(idxs);
  blockGeos.set(blockId, g);
  return g;
}

/**
 * Dropped blocks use the temperate palette — biome context is gone by then, and
 * the inventory icon picks the same one for the same reason (see `tintRGB` in
 * `ui/Icons.js`), so a moss block on the ground, in your fist and in the toolbar
 * are one colour.
 *
 * Which palette entry is not a shortcut: this handled tints 1 and 2 and lumped
 * the other two in with foliage, so a dropped mossy stone and a dropped pine
 * canopy came out plain leaf-green — a shade no wall of either is. The four
 * branches below are `tintOf` in `world/Mesher.js` term for term; that is the
 * function this has to agree with, because it is the one the world draws with.
 */
function dropTint(blockId) {
  const t = TINT_ID[blockId];
  if (!t) return [1, 1, 1];
  const c = BIOME_COLORS[2];
  if (t === 1) return c.grass;
  if (t === 2) return c.foliage;
  if (t === 3) { const f = c.foliage; return [f[0] * 0.90, f[1] * 0.98, f[2] * 0.93]; }
  return [c.foliage[0] * 0.9, c.foliage[1] * 1.0, c.foliage[2] * 0.85];
}
