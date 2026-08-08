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
// Flowers are generated, not placed. `WorldGen.placeFlora` puts one on roughly
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

import * as THREE from 'three';
import { worldModel } from './ItemModels.js';

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
   * @param {{height:number, lean?:boolean}} opts `height` is how tall the thing
   *   stands as a fraction of a cell; `lean` marks kinds that can be bracketed
   *   to a wall and want the tilt that goes with it.
   */
  prime(key, itemId, opts) {
    let k = this.kinds.get(key);
    if (!k) {
      k = {
        height: opts.height, lean: !!opts.lean,
        template: null, mesh: null, cap: 0, scale: 1, asked: false,
      };
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
    };
    const m = worldModel(itemId, take);
    if (m) take(m);
  }

  /**
   * Place every kind's models and hide whatever is left over.
   *
   * @param {Object<string, Array<{pos:THREE.Vector3, up:THREE.Vector3,
   *   out:THREE.Vector3|null, spin?:number}>>} lists one array per kind key
   */
  sync(lists) {
    for (const [key, k] of this.kinds) {
      const list = lists[key];
      if (!k.template || !list || !list.length) { if (k.mesh) k.mesh.count = 0; continue; }
      const n = Math.min(list.length, CAP);
      const mesh = this._fit(k, n);

      for (let i = 0; i < n; i++) {
        const t = list[i];
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
        _pos.copy(t.pos).addScaledVector(_up, -0.5);
        if (k.lean && t.out) _pos.addScaledVector(_out, -0.42).addScaledVector(_up, 0.16);

        _m.compose(_pos, _q, _scale.setScalar(k.scale));
        mesh.setMatrixAt(i, _m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
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
    // The geometry and the material are the template's own, untouched. That is
    // the point of routing through `ItemModels`: the torch in your hand, the one
    // in the toolbar and the three hundred on these walls are literally the same
    // material and compile one program between them.
    const mesh = new THREE.InstancedMesh(k.template.geometry, k.template.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
