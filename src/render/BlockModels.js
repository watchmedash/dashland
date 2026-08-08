// Blocks that are better as a model than as a stack of boxes.
//
// Most of this world is cubes and should stay cubes — that is the look. But a
// torch is not a cube and never was: as voxels it is a 0.14-wide post with a
// slightly wider post on top, and no arrangement of tiles turns that into a
// burning brand. The art already exists, is already loaded, and is already in
// the player's hand. This puts the same object in the world.
//
// Only what is near the player is instanced, because that is the only place a
// torch is big enough on screen to be worth a draw call, and because the list
// comes from a scan that is bounded anyway. Everything else keeps its voxel
// lighting and its voxel collision — this layer is *only* the picture.

import * as THREE from 'three';
import { worldModel } from './ItemModels.js';

/** How tall a planted torch stands, as a fraction of a cell. */
const TORCH_HEIGHT = 0.95;
/** How far a wall torch leans out from the face it is bracketed to. */
const WALL_LEAN = 0.55;

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3();
const _out = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _lean = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

export class BlockModels {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'block-models';
    scene.add(this.group);

    this.template = null;      // the torch, once it has loaded
    this.pool = [];
    this.used = 0;
    this.scale = 1;
  }

  /** Ask for the torch art. Safe to call every frame; loads once. */
  prime(torchItemId) {
    if (this.template || this._asked) return;
    this._asked = true;
    const take = (mesh) => {
      this.template = mesh;
      // Models arrive normalised to whatever height their held pose wants, so
      // scaling straight by a target in cells only works if that happens to be
      // one. Measure what we were given.
      const bb = new THREE.Box3().setFromObject(mesh);
      const h = Math.max(1e-3, bb.max.y - bb.min.y);
      this.scale = TORCH_HEIGHT / h;
    };
    const m = worldModel(torchItemId, take);
    if (m) take(m);
  }

  _grow() {
    const root = new THREE.Group();
    // The template's material already glows at the head — `ItemModels` builds
    // it that way for every torch there is, so the one in your hand, the one in
    // the toolbar and the three hundred on these walls are literally the same
    // material and compile one program between them.
    const body = new THREE.Mesh(this.template.geometry, this.template.material);
    root.add(body);
    this.group.add(root);
    const entry = { root, body };
    this.pool.push(entry);
    return entry;
  }

  /**
   * Place one model per entry and hide the rest.
   *
   * @param {Array<{pos:THREE.Vector3, up:THREE.Vector3, out:THREE.Vector3|null}>} list
   */
  sync(list, dt) {
    if (!this.template) { this._hideFrom(0); return; }
    let n = 0;
    for (const t of list) {
      const e = this.pool[n] || this._grow();
      n++;
      e.root.visible = true;

      _up.copy(t.up).normalize();
      _lean.copy(_up);
      if (t.out) {
        _out.copy(t.out).normalize();
        _lean.addScaledVector(_out, WALL_LEAN).normalize();
      }
      _axis.crossVectors(_Y, _lean);
      const s = _axis.length();
      if (s < 1e-6) _q.identity();
      else _q.setFromAxisAngle(_axis.multiplyScalar(1 / s), Math.acos(
        Math.max(-1, Math.min(1, _Y.dot(_lean)))));
      e.root.quaternion.copy(_q);

      // Where the foot goes.
      //
      // A floor torch stands on the floor of its own cell, so drop half a cell
      // from the centre. A wall torch is held against the face it is bracketed
      // to: its foot belongs *at* that face, half a cell back from the centre
      // along the wall direction, not out in the middle of the cell. Getting
      // this wrong is what left one floating with its head off-centre over the
      // neighbouring block instead of leaning out of the wall it is fixed to.
      _pos.copy(t.pos).addScaledVector(_up, -0.5);
      if (t.out) _pos.addScaledVector(_out, -0.42).addScaledVector(_up, 0.16);
      e.root.position.copy(_pos);
      e.root.scale.setScalar(this.scale || 1);
    }
    this.used = n;
    this._hideFrom(n);
  }

  _hideFrom(n) {
    for (let i = n; i < this.pool.length; i++) this.pool[i].root.visible = false;
  }
}
