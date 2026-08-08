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

/**
 * Make the burning end of a model glow, and leave the rest of it alone.
 *
 * The first version bolted a flame quad on and lifted the whole mesh with a
 * flat emissive so it would not be black at night. Both were wrong. The flat
 * lift raised the texture's darks along with its lights, which is exactly what
 * flattening a texture means — the shaft stopped reading as carved wood and
 * started reading as a plain shape, and the model looked untextured when in
 * fact it was the emissive drowning it. And a torch does not need a separate
 * fire: its head *is* the fire. Ramp the glow in over the top of the model and
 * the same mesh does both jobs.
 *
 * The shaft still gets a whisper of lift, because nothing in the world scene
 * shines on these — the voxel light is baked into chunk vertices and a model is
 * not a chunk — so with none at all it goes black the moment the sun leaves.
 */
function glowTop(material, loY, hiY) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowLo = { value: loY };
    shader.uniforms.uGlowHi = { value: hiY };
    shader.uniforms.uGlowColor = { value: new THREE.Vector3(1.30, 0.54, 0.15) };
    shader.uniforms.uBodyLift = { value: new THREE.Vector3(0.13, 0.10, 0.07) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLocalY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocalY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLocalY;
        uniform float uGlowLo;
        uniform float uGlowHi;
        uniform vec3 uGlowColor;
        uniform vec3 uBodyLift;`)
      .replace('#include <emissivemap_fragment>', `
        float gT = smoothstep(uGlowLo, uGlowHi, vLocalY);
        // Multiplied by the texel, not added over it, so the head keeps the
        // shape the art gave it instead of becoming a bright blob.
        totalEmissiveRadiance += uBodyLift * diffuseColor.rgb
          + uGlowColor * gT * (0.35 + 0.65 * diffuseColor.r);`);
  };
  material.customProgramCacheKey = () => 'glowtop';
  material.needsUpdate = true;
  return material;
}

export class BlockModels {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'block-models';
    scene.add(this.group);

    this.template = null;      // the torch, once it has loaded
    this.pool = [];
    this.used = 0;
    this.scale = 1;
    this.glowMat = null;
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
      // The burning end is the top of the model. Ramp the glow across the last
      // fifth of it, which on this art is the wrapped head and nothing else.
      this.glowLo = bb.min.y + h * 0.78;
      this.glowHi = bb.min.y + h * 0.94;
    };
    const m = worldModel(torchItemId, take);
    if (m) take(m);
  }

  _material() {
    if (this.glowMat) return this.glowMat;
    // One material for every torch in the world: same texture, same glow, and
    // three-hundred of them still compile one program.
    const src = this.template.material;
    const m = src.clone();
    m.toneMapped = true;
    this.glowMat = glowTop(m, this.glowLo, this.glowHi);
    return this.glowMat;
  }

  _grow() {
    const root = new THREE.Group();
    const body = new THREE.Mesh(this.template.geometry, this._material());
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
