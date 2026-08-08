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
const TORCH_HEIGHT = 0.78;
/** How far a wall torch leans out from the face it is bracketed to. */
const WALL_LEAN = 0.55;

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3();
const _out = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _lean = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

/**
 * A flame that reads as fire from any angle without being a particle system.
 *
 * Two crossed quads rather than a camera-facing sprite: a sprite the size of a
 * torch head swivels visibly as you walk past it, which is exactly the tell
 * that gives away a billboard, and at this scale the cross costs nothing.
 */
function flameTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S * 0.62, 0, S / 2, S * 0.55, S * 0.5);
  grad.addColorStop(0.00, 'rgba(255,246,214,1)');
  grad.addColorStop(0.22, 'rgba(255,206,110,0.96)');
  grad.addColorStop(0.48, 'rgba(255,140,44,0.70)');
  grad.addColorStop(0.78, 'rgba(214,70,18,0.22)');
  grad.addColorStop(1.00, 'rgba(160,40,10,0)');
  // A teardrop, not a disc: wide at the base, drawn up to a point.
  g.save();
  g.translate(S / 2, S / 2);
  g.scale(0.62, 1.0);
  g.translate(-S / 2, -S / 2);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(S / 2, S * 0.58, S * 0.42, S * 0.46, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class BlockModels {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'block-models';
    scene.add(this.group);

    this.template = null;      // the torch, once it has loaded
    this.pool = [];            // { root, flame }
    this.used = 0;
    this.time = 0;

    this.flameGeo = null;
    this.flameMat = new THREE.MeshBasicMaterial({
      map: flameTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
  }

  /** Ask for the torch art. Safe to call every frame; loads once. */
  prime(torchItemId) {
    if (this.template || this._asked) return;
    this._asked = true;
    const take = (mesh) => {
      this.template = mesh;
      // Models arrive normalised to the height their held pose wants — half a
      // unit for a torch — so scaling straight by TORCH_HEIGHT made a stubby
      // half-size one. Measure what we were given and scale to the height we
      // actually want in cells.
      const bb = new THREE.Box3().setFromObject(mesh);
      const h = Math.max(1e-3, bb.max.y - bb.min.y);
      this.scale = TORCH_HEIGHT / h;
      this.footY = bb.min.y;
    };
    const m = worldModel(torchItemId, take);
    if (m) take(m);
  }

  _grow() {
    if (!this.flameGeo) {
      const a = new THREE.PlaneGeometry(1, 1);
      const b = new THREE.PlaneGeometry(1, 1);
      b.rotateY(Math.PI / 2);
      this.flameGeo = THREE.BufferGeometryUtils
        ? THREE.BufferGeometryUtils.mergeGeometries([a, b])
        : a;                                   // one quad is still better than none
      if (this.flameGeo === a) this._flameB = b;
    }
    const root = new THREE.Group();
    const body = this.template.clone();
    // The world has no fill light in it the way the view model does, so a
    // standard material at night is simply black — the first version of this
    // put four torch-shaped holes in the dark. A torch is a light source, so
    // it is the one object with an honest reason to carry its own brightness:
    // warm emissive, strongest at the head, and it reads at midnight and at
    // noon without being lit by anything.
    body.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = o.material.clone();
      if (o.material.emissive) {
        o.material.emissive.setRGB(0.30, 0.17, 0.07);
        o.material.emissiveIntensity = 1;
      }
      o.material.toneMapped = true;
    });
    root.add(body);
    const flame = new THREE.Mesh(this.flameGeo, this.flameMat);
    if (this._flameB) flame.add(new THREE.Mesh(this._flameB, this.flameMat));
    flame.renderOrder = 5;
    root.add(flame);
    this.group.add(root);
    const entry = { root, body, flame };
    this.pool.push(entry);
    return entry;
  }

  /**
   * Place one model per entry and hide the rest.
   *
   * @param {Array<{pos:THREE.Vector3, up:THREE.Vector3, out:THREE.Vector3|null,
   *                head:THREE.Vector3}>} list
   */
  sync(list, dt) {
    this.time += dt;
    if (!this.template) { this._hideFrom(0); return; }
    let n = 0;
    for (const t of list) {
      const e = this.pool[n] || this._grow();
      n++;
      e.root.visible = true;

      // Stand it along the surface normal, then lean it away from its wall.
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

      // Sit the foot on the floor of the cell, or against the wall face.
      _pos.copy(t.pos);
      if (t.out) _pos.addScaledVector(_out, 0.18).addScaledVector(_up, -0.10);
      else _pos.addScaledVector(_up, -0.44);
      e.root.position.copy(_pos);
      e.root.scale.setScalar(this.scale || 1);

      // The fire sits where the light says it does, so the glow, the embers and
      // the picture all agree.
      e.flame.parent.worldToLocal(_pos.copy(t.head));
      e.flame.position.copy(_pos);
      const flick = 0.86 + 0.14 * Math.sin(this.time * 11 + t.seed)
        + 0.06 * Math.sin(this.time * 23.3 + t.seed * 2.1);
      // In model space, so it has to undo the root's scale to end up the size
      // we mean in cells.
      const fs = 1 / (this.scale || 1);
      e.flame.scale.set(0.30 * flick * fs, 0.42 * flick * fs, 0.30 * flick * fs);
      e.flame.quaternion.copy(_q).invert();
    }
    this.used = n;
    this._hideFrom(n);
  }

  _hideFrom(n) {
    for (let i = n; i < this.pool.length; i++) this.pool[i].root.visible = false;
  }
}
