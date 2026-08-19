// Blocks that are better as a model than as a stack of boxes.
//
// Most of this world is cubes and should stay cubes — that is the look. But a
// torch is not a cube and never was: as voxels it is a 0.14-wide post with a
// slightly wider post on top, and no arrangement of tiles turns that into a
// burning brand. The art already exists, is already loaded, and is already in
// the player's hand. This puts the same object in the world.
//
// Only what is near the player is instanced, because that is the only place one
// of these is big enough on screen to be worth drawing, and because the list
// comes from a scan that is bounded anyway. Everything else keeps its voxel
// lighting and its voxel collision — this layer is *only* the picture.
//
// --- why this stopped being the torch's private helper -----------------------
//
// It held one `template` and one pool of `Group`s, one per torch, and that was
// right for torches: there are as many of them as the player bothered to plant.
// Flowers are generated, not placed. `WorldGen.floraAt` puts one on roughly
// four percent of grass columns, so a meadow inside the scan radius is a
// hundred-odd of them and a tended garden is whatever the player felt like.
// A `Mesh` each is a draw call each.
//
// So every kind is an `InstancedMesh` instead: one draw call per *kind*,
// whether it is showing four torches or two hundred and fifty-six flowers, and
// the per-instance cost is a matrix write. The torch went the same way — there
// is nothing a torch's own `Mesh` was doing that an instance matrix is not, and
// two placement paths for one idea is how the second one rots.
//
// The instance ceiling is per kind and it is a real ceiling: past it the
// furthest entries in the list are simply dropped. See `CAP`.
//
// --- what a model gives up, and what is bought back here ---------------------
//
// A meshed block gets two things from the chunk it lives in that a loose model
// does not: the wind, stamped into the vertex data as a wave code, and the
// baked voxel light, stamped in as skylight and coloured block light. Turning
// the flowers into models cost both, and a meadow of statues lit as though the
// roof over it were not there is a worse picture than the billboards were.
//
// The wind comes back in full: `applyInstancedSway` is the mesher's own sway
// branch ported to instances, phased off the instance matrix so neighbours are
// out of step. See `_skin`.
//
// The light comes back in two halves, from two different places, and it is
// worth being clear about which is which because they do not overlap.
//
// The *sun* half is the scene's: the sun's shadow map, which knows there is a
// roof, plus the entity fill, which does not. `receiveShadow` is therefore on,
// and it is why a flower under a roof at noon is not in direct sunlight. That
// used to be the whole of the answer, because `Sky` dimmed the fill by the
// *player's* sky exposure and so darkened every entity in the world at once.
// It no longer does, and the third half below is what replaced it.
//
// The *skylight* half is the mesher's, and it is the same word: four bits per
// cell saying how much sky reaches it, which scale the scene's indirect light
// and nothing else (`crossSky`, and `aSkyShade` in VoxelMaterial). The sun is
// left out of it deliberately — the shadow map has already answered for the
// sun, and taking it twice would black out a flower under a plank.
//
// The *block light* half used to be written off here as unreachable, on the
// grounds that the light field lives in the world worker and the main thread
// holds `blocks` and nothing else, so there was no cell to sample when the
// instance list is built. The premise was true and the conclusion was wrong.
// The sample does not have to be taken on the main thread — it only has to
// *arrive* there. `Mesher.meshChunk` already reads the light at exactly these
// cells, at exactly the moment it decides not to mesh them (see MODELLED_CROSS
// there), and used to throw it away. It now keeps it: four bytes per modelled
// cross cell, shipped with the chunk geometry as a transferable, kept per chunk
// by `main.js` and looked up per instance in `sync` below.
//
// So a flower beside a torch is lit by it. The two halves add rather than
// replace — block light is a term on top of whatever the scene already did —
// which is also what makes a missing sample safe. See `sync`.

import * as THREE from 'three';
import { worldModel } from './ItemModels.js';
import { applyInstancedSway, applyInstancedBlockLight, applyInstancedCrack } from './VoxelMaterial.js';
import { ITEMS } from '../game/Items.js';
import { BLOCKS, R_CROSS, setPlantBox } from '../world/Blocks.js';
import { crossLightRGB, crossSky } from '../world/Mesher.js';
import { SKY_SHADE_MIN } from '../world/Lighting.js';

/**
 * Instances per kind, hard.
 *
 * Torches are placed by hand, one at a time, and 128 of them inside a 24-cell
 * scan is already a lit fortress. Flowers arrive by the meadow: at the flora
 * generator's densest, four percent of ~2400 columns in radius is about a
 * hundred, but nothing stops a player from planting a solid carpet, and the
 * failure mode of an unbounded pool is that the frame the carpet enters the
 * radius is the frame the game allocates ten thousand matrices.
 *
 * 256 at ~380 triangles is under a hundred thousand triangles for the whole
 * flower layer, in three draw calls — less than one chunk of terrain. It is the
 * allocation, not the triangles, that this number is protecting.
 */
export const CAP = 256;

/** How far a wall torch leans out from the face it is bracketed to. */
const WALL_LEAN = 0.55;

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3();
const _out = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _lean = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _Y = new THREE.Vector3(0, 1, 0);
const _rgb = [0, 0, 0];

export class BlockModels {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'block-models';
    scene.add(this.group);

    /** @type {Map<string, object>} kind key -> its art, its mesh and its size */
    this.kinds = new Map();
  }

  /**
   * Ask for one kind's art. Safe to call every frame; loads once.
   *
   * @param {string} key      what `sync` will call this kind
   * @param {number} itemId   the item whose model to borrow
   * @param {{height:number, lean?:boolean, lit?:boolean, shadow?:boolean}} opts
   *   `height` is how tall the thing stands as a fraction of a cell; `lean`
   *   marks kinds that can be bracketed to a wall and want the tilt that goes
   *   with it; `lit` asks for per-instance block light on a kind that does not
   *   sway; `shadow` lets the kind cast into the sun's shadow map.
   */
  prime(key, itemId, opts) {
    let k = this.kinds.get(key);
    if (!k) {
      k = {
        height: opts.height, lean: !!opts.lean, shadow: !!opts.shadow,
        // Which kinds sway is read off the block, not passed in: a kind that is
        // a cross block is a plant, and plants are exactly what the mesher's
        // wave table already marks as swaying (`WAVE[i] = 1` for `R_CROSS`).
        // Deriving it keeps the two in step — a plant modelled tomorrow gets
        // the wind without anyone remembering to ask for it — and a torch,
        // which is `R_TORCH` and is a stick driven into a wall, stays still.
        sway: !!(BLOCKS[ITEMS[itemId]?.block]?.render === R_CROSS),
        template: null, material: null,
        mesh: null, cap: 0, scale: 1, asked: false,
      };
      // Every swaying kind is lit, because the sway patch carries the light
      // patch with it and a plant beside a torch has always wanted it. A kind
      // that does not sway has to ask, and `lit` is the whole of the difference
      // between a torch (an emitter, which must not sample its own cell) and a
      // workbench (a box in a cave, which must). See `_skin`.
      k.lit = k.sway || !!opts.lit;
      this.kinds.set(key, k);
    }
    if (k.template || k.asked) return;
    k.asked = true;
    const take = (mesh) => {
      k.template = mesh;
      // Models arrive normalised to whatever height their held pose wants, so
      // scaling straight by a target in cells only works if that happens to be
      // one. Measure what we were given.
      const bb = new THREE.Box3().setFromObject(mesh);
      k.scale = k.height / Math.max(1e-3, bb.max.y - bb.min.y);
      // How far the model's lowest point sits BELOW its own origin, in cells.
      // The exporter centres a model about its origin, so this is negative for
      // every model in the game and the placement below has to add it back or
      // the thing is planted rather than stood on the ground. See the note
      // there for what that cost.
      k.foot = bb.min.y * k.scale;
      // Tell the picker how big this plant actually is.
      //
      // The crosshair used to be given the whole cell for a modelled plant,
      // which is 8x the footprint of a clover and claims the empty air above
      // and around every one of them. Nowhere else in the game knows the
      // answer: the height comes from `MODELLED_PLANTS` in main.js and the
      // width from the `.gltf`, and those two only meet here, in the three
      // lines above that scale the model to stand in its cell. Published from
      // the same `bb` and the same `k.scale` that place it, so the shape the
      // picker uses cannot drift from the shape that is drawn — re-author a
      // model or move its height and this follows with no second edit.
      //
      // Radius over the footprint DIAGONAL and not its wider side, because
      // every instance is spun to its own yaw (`t.spin`) and the diagonal is
      // the only radius that contains the model at all of them. The inscribed
      // one was measured too: it takes a crimson bloom's claim from 1.85x its
      // drawn area to 1.33x, but 5% of the flower you can see stops being
      // pickable with it, and an unpickable flower is a worse bug than a fat
      // one. No `foot` term, because the placement below stands the model on
      // the cell floor (`-0.5 - k.foot`), so it occupies 0 to `k.height`.
      if (k.sway) {
        const bid = ITEMS[itemId]?.block;
        const dx = bb.max.x - bb.min.x, dz = bb.max.z - bb.min.z;
        if (bid) setPlantBox(bid, 0.5 * Math.hypot(dx, dz) * k.scale, k.height);
      }
      k.material = this._skin(k, bb);
    };
    const m = worldModel(itemId, take);
    if (m) take(m);
  }

  /**
   * Place every kind's models and hide whatever is left over.
   *
   * ### The block light, and what happens when there isn't any
   *
   * `t.light` is the mesher's packed word for the cell this instance stands in,
   * or -1 when the main thread does not have one — the chunk has not been meshed
   * yet, or has been evicted, or the flower was planted this instant and the
   * remesh has not come back. That case is not rare and it has to be safe.
   *
   * It is safe because the term is *additive*. The instance is already lit by
   * the scene — sun, shadow map, ambient, entity fill — and this adds the voxel
   * block light on top of that, so -1 means "add nothing" and the result is
   * exactly the picture this layer drew before any of this existed: a flower
   * lit like every other loose model in the game. Bright, never black.
   *
   * That is the reason the shipped light is block light *only* and the reason
   * it is added rather than multiplied. A multiplicative light term is the
   * natural way to write this and it fails the wrong way round: its neutral
   * value is 1 rather than 0, so anyone who forgot the fallback, or any frame
   * where the lookup loses a race with the mesher, renders a black flower — and
   * a black flower is far more visible than an unlit one. There is no value of
   * this attribute that can darken an instance.
   *
   * @param {Object<string, Array<{pos:THREE.Vector3, up:THREE.Vector3,
   *   out:THREE.Vector3|null, spin?:number, light?:number}>>} lists one array
   *   per kind key
   */
  /**
   * Which cell the player is breaking, or -1. Set by main every frame.
   *
   * The crack used to find its instance by comparing world positions in the
   * shader, and that is a measurement where an identity will do: this layer
   * BUILDS the instance list and knows the cell each entry came from. A flag
   * per instance cannot bleed onto a neighbour, cannot drift with a swaying
   * vertex, and does not care where the model's origin sits inside its cell.
   */
  setBreaking(col, k) { this._brkCol = col; this._brkK = k; }

  sync(lists) {
    for (const [key, k] of this.kinds) {
      const list = lists[key];
      if (!k.template || !list || !list.length) { if (k.mesh) k.mesh.count = 0; continue; }
      const n = Math.min(list.length, CAP);
      const mesh = this._fit(k, n);
      const lit = mesh.geometry.getAttribute('aBlockLight');
      const shade = mesh.geometry.getAttribute('aSkyShade');
      const crack = mesh.geometry.getAttribute('aCrack');

      for (let i = 0; i < n; i++) {
        const t = list[i];
        if (lit) {
          const w = t.light ?? -1;
          if (w < 0) { _rgb[0] = 0; _rgb[1] = 0; _rgb[2] = 0; }
          else crossLightRGB(w, _rgb);
          lit.setXYZ(i, _rgb[0], _rgb[1], _rgb[2]);
          // The same word's skylight nibble, as a shade rather than a factor -
          // see `_fit` for why zero is the neutral value and `crossSky` for why
          // this stopped being double counting.
          if (shade) shade.setX(i, w < 0 ? 0
            : (1 - SKY_SHADE_MIN) * (1 - crossSky(w)));
        }
        // 1 on the one instance being mined, 0 on every other.
        if (crack) crack.setX(i, (t.col === this._brkCol && t.k === this._brkK) ? 1 : 0);
        _up.copy(t.up).normalize();
        _lean.copy(_up);
        if (k.lean && t.out) {
          _out.copy(t.out).normalize();
          _lean.addScaledVector(_out, WALL_LEAN).normalize();
        }
        // Stand the model's own +Y along the lean. Shortest arc, so a model on
        // the far side of the planet is not spun through the long way round.
        _axis.crossVectors(_Y, _lean);
        const s = _axis.length();
        if (s < 1e-6) _q.identity();
        else _q.setFromAxisAngle(_axis.multiplyScalar(1 / s), Math.acos(
          Math.max(-1, Math.min(1, _Y.dot(_lean)))));
        // ...then turn it about that axis. Multiplied on the right so the spin
        // is about the model's *own* up and not the world's: on a sphere those
        // are the same thing only at one pole.
        if (t.spin) {
          _spin.setFromAxisAngle(_Y, t.spin);
          _q.multiply(_spin);
        }

        // Where the foot goes.
        //
        // A floor-standing model stands on the floor of its own cell, so drop
        // half a cell from the centre. A wall torch is held against the face it
        // is bracketed to: its foot belongs *at* that face, half a cell back
        // from the centre along the wall direction, not out in the middle of
        // the cell. Getting this wrong is what left one floating with its head
        // off-centre over the neighbouring block instead of leaning out of the
        // wall it is fixed to.
        // `-k.foot` is what makes "stands on the floor" true. Dropping half a
        // cell puts the model's ORIGIN on the floor, and the exporter centres a
        // model about its origin, so every one of the 33 was buried by half its
        // own height: sea sponge by 0.32 of a cell, the torch by 0.228, the
        // smallest of them by 0.10. It went unnoticed for as long as it did
        // because an upright plant loses only its roots to it and still reads
        // as a plant. Driftwood is the one model whose mass is all at the
        // bottom — a limb lying on sand with one fork rising — so burying its
        // lowest 0.15 took the limb and left the tip of the fork standing in
        // the grass. That is the whole of "why is the driftwood standing".
        _pos.copy(t.pos).addScaledVector(_up, -0.5 - (k.foot || 0));
        if (k.lean && t.out) _pos.addScaledVector(_out, -0.42).addScaledVector(_up, 0.16);

        _m.compose(_pos, _q, _scale.setScalar(k.scale));
        mesh.setMatrixAt(i, _m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (lit) lit.needsUpdate = true;
      if (crack) crack.needsUpdate = true;
      if (shade) shade.needsUpdate = true;
    }
  }

  /**
   * The material this kind's instances draw with.
   *
   * For anything that does not sway this is the template's own, untouched, and
   * that is the point of routing through `ItemModels`: the torch in your hand,
   * the one in the toolbar and the three hundred on these walls are literally
   * the same material and compile one program between them.
   *
   * A swaying kind cannot have that. The wind is a vertex-shader patch, and the
   * material the flowers arrive with is the shared WAM one — every stick, ingot
   * and gemstone in the game draws with it. Patching it in place would put a
   * gust through the coal in your fist. So a swaying kind takes a clone, and
   * pays one extra material per kind for it. Not one extra *program* per kind:
   * the clones differ only in two uniforms, so they share a cache key and the
   * whole swaying set compiles once between them.
   *
   * Per kind rather than one clone shared by all three flowers, because the
   * sway needs the geometry's own root and head heights as uniforms and a
   * uniform belongs to a material. The three are near enough identical today
   * that sharing would look right; it would stop looking right the first time a
   * modelled plant is a different shape, and finding that out from a stem that
   * bends from halfway up is not worth saving two programs.
   *
   * Draw calls are untouched either way: still one per kind.
   */
  _skin(k, bb) {
    // Every kind is cloned now, where it used to be only the swaying and the
    // lit ones. The crack is why: a modelled block that shares its pack's
    // material cannot be given a shader, and a block you cannot see breaking is
    // a block you cannot tell you are breaking — which was true of every flower,
    // every crop, the whole reef, the flora, the workbench and the torch.
    //
    // The extra cost is one THREE.Material per kind, not one shader program per
    // kind: `customProgramCacheKey` on each of these three patches is a constant
    // string, so every kind with the same combination compiles once and the
    // rest reuse it.
    const clone = (m) => {
      const out = m.clone();
      // `Material.copy()` carries colours, maps and flags and NOT
      // `onBeforeCompile` or `customProgramCacheKey` — they are plain fields on
      // the instance and three's copy list simply does not mention them. So a
      // clone comes back with the default no-op hook and any shader the source
      // material was carrying is gone, silently, with nothing to catch it.
      //
      // That is what turned the torch black. It is the one thing in the world
      // whose material has a shader of its own (`glowTop` in ItemModels, which
      // is what puts the flame on the head), and it is neither swaying nor lit,
      // so until the crack went in it was the one kind that kept the SHARED
      // material and never hit this path. Cloning every kind for the crack sent
      // it through, the flame's emissive went with the hook, and what was left
      // was an unlit stick with a dark lump on top.
      //
      // Carried across explicitly, before the patches below layer onto it —
      // each of those chains through `prevCompile`, so a hook that is missing
      // here is a hook that is missing from the whole chain.
      out.onBeforeCompile = m.onBeforeCompile;
      out.customProgramCacheKey = m.customProgramCacheKey;
      if (k.sway) applyInstancedSway(out, bb.min.y, bb.max.y);
      else if (k.lit) applyInstancedBlockLight(out);
      // Last, so it wraps whatever the two above installed — and so the world
      // position it reads is the SWAYED one, or a crack would sit still on a
      // plant bending away from underneath it.
      return applyInstancedCrack(out);
    };
    // A tinted pack model carries two materials, one per draw group. Flowers
    // are single-material WAM art and take the first branch, but a modelled
    // plant out of a split pack would silently lose its sway without this.
    return Array.isArray(k.template.material)
      ? k.template.material.map(clone)
      : clone(k.template.material);
  }

  /**
   * The kind's mesh, grown if `n` will not fit.
   *
   * Capacity doubles rather than tracking the count, because the count moves
   * every time the player crosses a cell and reallocating a GPU buffer on that
   * cadence is exactly the stall this whole layer is meant to avoid.
   */
  _fit(k, n) {
    if (k.mesh && k.cap >= n) return k.mesh;
    const cap = Math.min(CAP, Math.max(16, 1 << (32 - Math.clz32(Math.max(1, n - 1)))));
    if (k.mesh) {
      this.group.remove(k.mesh);
      k.mesh.dispose();          // the instance buffers only — geometry is shared
    }
    // The geometry is the template's own, untouched; the material is too unless
    // this kind sways. See `_skin`.
    const mesh = new THREE.InstancedMesh(k.template.geometry, k.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Per-instance block light, for the kinds that asked for it — every swaying
    // one, plus any other kind primed with `lit`.
    //
    // It used to be "exactly the swaying ones", on the grounds that a
    // non-swaying kind keeps its pack's *shared* material and the shader that
    // reads this attribute cannot go there. That premise is intact and the
    // conclusion no longer follows: `_skin` clones for a lit kind too, and pays
    // the same one-material-per-kind the flowers pay. What was really being
    // said is that the only non-swaying kind at the time was the torch — and a
    // torch still gets no block light, deliberately, because it is an emitter.
    // Its own cell reads 15/15/15 or near it, and a torch lit by its own light
    // is a white lozenge with the flame texture washed clean off it. The one
    // thing in the world that should not sample its own cell is the thing that
    // filled that cell.
    //
    // A modelled block is the opposite case in every respect: it is not an
    // emitter, its own cell is opaque and holds no light at all (the mesher
    // samples its brightest neighbour instead), and it is a box you stack in a
    // cave. Unlit, it is the exact objection that turned down the supplied
    // crate. So it asks, and gets it.
    //
    // The attribute lives on the geometry, which is the template's and is
    // shared with the held and dropped copies of the same model. That is safe:
    // a program that does not declare `aBlockLight` never binds it, and only
    // the cloned material declares it.
    if (k.lit) {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      attr.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aBlockLight', attr);
    }
    {
      // Every kind gets this one, not just the lit ones: anything you can
      // see, you can break.
      const brk = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      brk.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aCrack', brk);
      // And the roof, in the same shape and with the same neutral value: how
      // much of the scene's indirect light to take away, zero being none.
      const shade = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      shade.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('aSkyShade', shade);
    }
    // The only piece of the baked voxel light a loose model can still be given.
    //
    // A meshed block carries its chunk's skylight and block light in its vertex
    // data. An instance has neither, so it is lit by the scene — sun, moon,
    // ambient and the entity fill — and a scene light has no idea there is a
    // roof. That is how a flower in a cave came to be lit like a meadow.
    //
    // The sun is the loud half of that, and the sun alone *does* know about
    // roofs, because it casts a shadow map and the terrain writes into it. So
    // receiving is on: a flower under stone at noon is now in shadow, which
    // leaves it on the ambient and the entity fill. Those are what `aSkyShade`
    // is for — the fill used to be dimmed by the player's own sky exposure,
    // which answered for every entity in the world at once, and each of them
    // now answers for itself.
    //
    // Casting stays off. The shadow camera spans ~92 cells across a 2048 map,
    // so a flower is about ten texels and its cast shadow is a grey smudge on
    // the grass; and two hundred and fifty of them is a second pass over every
    // instance for that smudge. (Layers are not an option for splitting this —
    // three tests a light's layers against the camera, not per object. The full
    // story is in `Sky.js`, above `entityFill`.)
    mesh.receiveShadow = true;
    // Casting is off for the flora, and the reason is above: a flower is about
    // ten texels on a 2048 map spanning ~92 cells, so its cast shadow is a grey
    // smudge and two hundred and fifty of them is a second pass for that smudge.
    //
    // A modelled *block* is the case that changes the arithmetic, and it opts
    // in. It is a whole cell across — twenty-odd texels, a real shadow — and it
    // replaces a cube that was casting one out of the terrain mesh. Off, a
    // workbench in the open is a bench with no shadow standing beside blocks
    // that all have one, which is more conspicuous than any smudge.
    mesh.castShadow = !!k.shadow;
    // One bounding sphere for instances spread over forty cells is a sphere
    // containing the player, so culling it can only ever be wrong — and three.js
    // computes that sphere from the matrices as they were when it last looked.
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    k.mesh = mesh;
    k.cap = cap;
    return mesh;
  }
}
