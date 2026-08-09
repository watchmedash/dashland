// Dropped item entities: they fall under spherical gravity, bob, spin, merge
// with nearby stacks, and drift into the player once they're close.

import * as THREE from 'three';
import { GRAVITY, BIOME_COLORS } from '../world/Constants.js';
import { tangentFrame } from '../world/Sphere.js';
import { TILE_TOP, TILE_SIDE, TILE_BOTTOM, TILE_FRONT, TINT_ID, RENDER_TYPE, R_CROSS, ID } from '../world/Blocks.js';
import { ITEMS } from './Items.js';
import { hasModel, worldModel } from '../render/ItemModels.js';

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
   * Deliberately not routed through the block light the mobs get: a drop is
   * 0.46 of a cell and spins, and the machinery would cost a probe per drop per
   * frame against 260 of them for a few pixels. The consequence is honest and
   * visible — a stack of sticks lying beside a torch stays as dark as the field
   * — and is written down here rather than fixed.
   *
   * @param {number} level 1 leaves the card exactly as it renders today
   */
  setSkyLevel(level) {
    if (this._skyLevel === level) return;
    this._skyLevel = level;
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
      const m = new THREE.Mesh(getBlockGeo(def.block), this.materials.opaque);
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
      drop.mesh = model;
    });
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

      if (!d.keep && d.age > 300) { this.group.remove(d.mesh); this.list.splice(i, 1); }
    }
  }

  clear() {
    for (const d of this.list) this.group.remove(d.mesh);
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
 * A unit cube carrying the same attributes the chunk mesher emits, so dropped
 * blocks shade identically to the world.
 */
function getBlockGeo(blockId) {
  let g = blockGeos.get(blockId);
  if (g) return g;
  const pos = [], nrm = [], tan = [], uv = [], aux = [], blk = [], tint = [], idxs = [];
  const faces = [
    { n: [0, 1, 0], layer: TILE_TOP[blockId], c: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
    { n: [0, -1, 0], layer: TILE_BOTTOM[blockId], c: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
    // directional blocks wear their front on +z so a tumbling drop still reads
    { n: [0, 0, 1], layer: TILE_FRONT[blockId], c: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
    { n: [0, 0, -1], layer: TILE_SIDE[blockId], c: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
    { n: [1, 0, 0], layer: TILE_SIDE[blockId], c: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
    { n: [-1, 0, 0], layer: TILE_SIDE[blockId], c: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  ];
  let v = 0;
  for (const f of faces) {
    const uvc = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const t = [f.c[1][0] - f.c[0][0], f.c[1][1] - f.c[0][1], f.c[1][2] - f.c[0][2]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    for (let i = 0; i < 4; i++) {
      pos.push(...f.c[i]);
      nrm.push(...f.n);
      tan.push(t[0] / tl, t[1] / tl, t[2] / tl);
      uv.push(...uvc[i]);
      aux.push(f.layer, 1, 1, 0);
      blk.push(0.15, 0.15, 0.15);
      tint.push(...dropTint(blockId));
    }
    idxs.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
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
