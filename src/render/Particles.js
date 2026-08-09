// Block debris, footstep dust, splashes, ambient motes and weather.

import * as THREE from 'three';
import { GRAVITY, R_MIN } from '../world/Constants.js';
import { BLOCKS } from '../world/Blocks.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _probe = new THREE.Vector3();

const MAX_DEBRIS = 900;

const MAX_BUBBLES = 64;

export class Particles {
  constructor(scene, planet) {
    this.planet = planet;
    this.center = new THREE.Vector3(0, 0, 0);

    // --- debris cubes ---
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0, vertexColors: false });
    this.debris = new THREE.InstancedMesh(geo, mat, MAX_DEBRIS);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.castShadow = false;
    this.debris.receiveShadow = true;
    this.debris.count = 0;
    this.debris.layers.enable(1);
    scene.add(this.debris);
    this.debrisColors = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DEBRIS * 3), 3);
    this.debris.instanceColor = this.debrisColors;

    // --- bubbles ---
    // Bubbles shared the debris cube mesh, so underwater you were watching a
    // stream of tiny boxes rise past your face. They get their own rounded,
    // translucent mesh; block shatter still wants cubes, a bubble never does.
    const bubGeo = new THREE.IcosahedronGeometry(0.5, 1);
    const bubMat = new THREE.MeshStandardMaterial({
      color: 0xbfe8ff, roughness: 0.12, metalness: 0.0,
      transparent: true, opacity: 0.5, depthWrite: false,
      emissive: 0x2a4a5c, emissiveIntensity: 0.4,
    });
    this.bubbleMesh = new THREE.InstancedMesh(bubGeo, bubMat, MAX_BUBBLES);
    this.bubbleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bubbleMesh.frustumCulled = false;
    this.bubbleMesh.castShadow = false;
    this.bubbleMesh.receiveShadow = false;
    this.bubbleMesh.count = 0;
    this.bubbleMesh.renderOrder = 11;
    this.bubbleMesh.layers.enable(1);
    scene.add(this.bubbleMesh);

    this.pool = [];
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.pool.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Quaternion(), spin: new THREE.Vector3(), life: 0, maxLife: 1, size: 0.1,
        color: new THREE.Color(), buoyant: false,
      });
    }

    // --- ambient motes ---
    this.motes = this._buildMotes(scene);

    // --- weather ---
    this.weather = this._buildWeather(scene);
    this.weatherMode = 'clear';
    this.weatherIntensity = 0;
    this.submerged = false;
  }

  _buildMotes(scene) {
    const N = 900;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
        uUp: { value: new THREE.Vector3(0, 1, 0) }, uOpacity: { value: 0.5 },
        uColor: { value: new THREE.Color(0xffe6a8) }, uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uUp; uniform float uPixelRatio;
        varying float vA;
        void main() {
          vec3 ref = abs(uUp.y) > 0.9 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
          vec3 t1 = normalize(cross(uUp, ref));
          vec3 t2 = cross(uUp, t1);
          float R = 15.0;
          // independent drift per axis, wrapped into a box that follows the camera
          float dx = fract(aSeed.x + uTime * 0.006 + sin(uTime * 0.21 + aSeed.z * 31.0) * 0.01) - 0.5;
          float dy = fract(aSeed.y + uTime * 0.004 + cos(uTime * 0.17 + aSeed.x * 27.0) * 0.01) - 0.5;
          float dz = fract(aSeed.z + uTime * 0.0035) - 0.5;
          vec3 p = uCam
            + t1 * dx * 2.0 * R
            + t2 * dy * 2.0 * R
            + uUp * (dz * 15.0 + sin(uTime * 0.5 + aSeed.x * 40.0) * 0.5);
          vA = 0.30 + 0.70 * (0.5 + 0.5 * sin(uTime * 1.7 + aSeed.y * 19.0));
          // Fade out the ones drifting above eye level. Motes are additive, so
          // against open sky they add white to bright blue and read as stars at
          // noon — which is exactly what they looked like. Below the horizon
          // there is nearly always terrain behind them, which is where lit dust
          // belongs anyway: it settles, it does not hover overhead.
          vA *= smoothstep(0.10, -0.08, dz);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (2.0 + aSeed.z * 2.4) * uPixelRatio * (12.0 / max(1.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(uColor, a * a * vA * uOpacity);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 10;
    scene.add(p);
    return p;
  }

  _buildWeather(scene) {
    const N = 6000;
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() },
        uUp: { value: new THREE.Vector3(0, 1, 0) }, uIntensity: { value: 0 },
        uSnow: { value: 0 }, uPixelRatio: { value: 1 }, uColor: { value: new THREE.Color(0xbcd2e8) },
        uWaterR: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uUp;
        uniform float uIntensity; uniform float uSnow; uniform float uPixelRatio;
        uniform float uWaterR;
        varying float vA;
        void main() {
          vec3 ref = abs(uUp.y) > 0.9 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
          vec3 t1 = normalize(cross(uUp, ref));
          vec3 t2 = cross(uUp, t1);
          float R = 16.0;
          float speed = mix(24.0, 3.2, uSnow);
          float span = 26.0;
          float fall = mod(aSeed.z * span + uTime * speed * (0.7 + aSeed.x * 0.5), span);
          vec3 p = uCam
            + t1 * ((aSeed.x - 0.5) * 2.0 * R)
            + t2 * ((aSeed.y - 0.5) * 2.0 * R)
            + uUp * (span * 0.55 - fall);
          if (uSnow > 0.5) {
            p += t1 * sin(uTime * 0.9 + aSeed.x * 30.0) * 0.9;
            p += t2 * cos(uTime * 1.1 + aSeed.y * 30.0) * 0.9;
          }
          vA = step(aSeed.z, uIntensity);
          // Precipitation has no collision at all — it is a box of points
          // sliding down past the camera, and every drop keeps going straight
          // through the terrain under it. Below opaque ground nobody can tell;
          // the sea is transparent, so over water you could watch the whole
          // storm carry on falling under the surface. Kill each drop at the
          // waterline instead. uWaterR is the radius of the water surface in
          // the camera's own column (0 when there is none in reach), which on
          // a sphere is all a horizontal surface is.
          if (uWaterR > 0.0 && length(p) < uWaterR) vA = 0.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Rain used to be drawn at 1.6px scaled by distance, which is about
          // two pixels at ten units: at full storm intensity, with all six
          // thousand drops showing, the ground-level view read as a few specks
          // of dust while the sky was black with cloud. The density was never
          // the problem — each drop was simply too small to see. The fragment
          // below already squeezes them into vertical streaks, so the extra
          // size becomes length rather than blobs.
          gl_PointSize = mix(3.6, 4.6, uSnow) * uPixelRatio * (14.0 / max(1.0, -mv.z));
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uSnow; uniform vec3 uColor; varying float vA;
        void main() {
          if (vA < 0.5) discard;
          vec2 c = gl_PointCoord - 0.5;
          // Thinner across than it is long, so the bigger point above reads as
          // a falling streak rather than a ball. Snow stays round.
          float d = length(vec2(c.x * mix(3.4, 1.0, uSnow), c.y));
          float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(uColor, a * mix(0.72, 0.9, uSnow));
        }
      `,
      transparent: true, depthWrite: false,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = 12;
    p.visible = false;
    scene.add(p);
    return p;
  }

  _spawn() {
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].alive) {
        this.pool[i].buoyant = false;   // only bubbles opt back in
        return this.pool[i];
      }
    }
    return null;
  }


  hitSpark(point, normal, blockId) {
    const col = BLOCKS[blockId]?.particle || [0.6, 0.6, 0.6];
    for (let i = 0; i < 4; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(point).addScaledVector(normal, 0.06);
      p.pos.x += (Math.random() - 0.5) * 0.5; p.pos.y += (Math.random() - 0.5) * 0.5; p.pos.z += (Math.random() - 0.5) * 0.5;
      p.vel.copy(normal).multiplyScalar(1.6 + Math.random() * 1.4);
      p.vel.x += (Math.random() - 0.5) * 2; p.vel.y += (Math.random() - 0.5) * 2; p.vel.z += (Math.random() - 0.5) * 2;
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      p.life = 0; p.maxLife = 0.4 + Math.random() * 0.4;
      p.size = 0.04 + Math.random() * 0.05;
      p.color.setRGB(col[0], col[1], col[2]);
    }
  }

  footDust(pos, up, blockId) {
    const col = BLOCKS[blockId]?.particle || [0.6, 0.6, 0.6];
    for (let i = 0; i < 4; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(pos).addScaledVector(up, 0.05);
      p.pos.x += (Math.random() - 0.5) * 0.5; p.pos.y += (Math.random() - 0.5) * 0.5; p.pos.z += (Math.random() - 0.5) * 0.5;
      p.vel.copy(up).multiplyScalar(0.6 + Math.random() * 0.7);
      p.vel.x += (Math.random() - 0.5) * 0.9; p.vel.y += (Math.random() - 0.5) * 0.9; p.vel.z += (Math.random() - 0.5) * 0.9;
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.45 + Math.random() * 0.35;
      p.size = 0.05 + Math.random() * 0.06;
      p.color.setRGB(col[0] * 1.1, col[1] * 1.1, col[2] * 1.1);
    }
  }

  splash(pos, up, strength = 1) {
    for (let i = 0; i < 18 * strength; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * 0.9; p.pos.y += (Math.random() - 0.5) * 0.9; p.pos.z += (Math.random() - 0.5) * 0.9;
      p.vel.copy(up).multiplyScalar(2.5 + Math.random() * 3 * strength);
      p.vel.x += (Math.random() - 0.5) * 3; p.vel.y += (Math.random() - 0.5) * 3; p.vel.z += (Math.random() - 0.5) * 3;
      p.rot.identity(); p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.5 + Math.random() * 0.5;
      p.size = 0.035 + Math.random() * 0.05;
      p.color.setRGB(0.42, 0.68, 0.9);
    }
  }

  /**
   * Embers rising off something burning — a husk caught in the sunrise, or the
   * player standing in lava.
   */
  embers(pos, up, count = 3, spread = 0.5) {
    for (let i = 0; i < count; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.buoyant = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * spread;
      p.pos.y += (Math.random() - 0.5) * spread;
      p.pos.z += (Math.random() - 0.5) * spread;
      p.vel.copy(up).multiplyScalar(1.4 + Math.random() * 1.6);
      p.vel.x += (Math.random() - 0.5) * 0.5;
      p.vel.z += (Math.random() - 0.5) * 0.5;
      p.rot.identity();
      p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.5 + Math.random() * 0.6;
      p.size = 0.03 + Math.random() * 0.045;
      p.color.setRGB(1.0, 0.45 + Math.random() * 0.35, 0.12);
    }
  }

  /**
   * The burst behind a critical hit: a short, sharp shell of bright shards
   * thrown off whatever you just landed on.
   *
   * Deliberately not a recoloured `hitSpark`. That one is *block* debris — it
   * takes the block's own particle colour, sprays along a surface normal and
   * lives up to 0.8s, so a crit dressed in it would read as "you chipped
   * something" and would be a different colour on every creature. A crit is not
   * a material event; it is a hit that went in harder, so the shards are always
   * the same warm white, always thrown outward in every direction from the body
   * rather than off a face, and are gone inside a third of a second. Short is
   * the point: the burst has to be legible in the same instant as the thump and
   * then get out of the way of the fight.
   *
   * Costs nothing new — it is the existing debris pool, twelve of nine hundred
   * slots, and `_spawn` returning null when the pool is full is already handled
   * the way every other emitter here handles it: the burst is simply smaller.
   *
   * @param {THREE.Vector3} pos centre of the burst — the creature's chest
   * @param {THREE.Vector3} up local up, for the lift that keeps the shards from
   *   spraying into the ground
   */
  critSpark(pos, up, count = 12) {
    for (let i = 0; i < count; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * 0.3;
      p.pos.y += (Math.random() - 0.5) * 0.3;
      p.pos.z += (Math.random() - 0.5) * 0.3;
      // An even spray in every direction, normalised so the speed is the speed
      // and not an artefact of which corner of the cube the vector landed in.
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      const sp = 3.4 + Math.random() * 2.6;
      p.vel.set(dx / len * sp, dy / len * sp, dz / len * sp);
      p.vel.addScaledVector(up, 1.8);
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22);
      p.life = 0; p.maxLife = 0.24 + Math.random() * 0.16;
      p.size = 0.022 + Math.random() * 0.03;
      p.color.setRGB(1.0, 0.88 + Math.random() * 0.1, 0.58 + Math.random() * 0.14);
    }
  }

  /** A few bubbles rising past the player's face while submerged. */
  bubbles(pos, up, count = 3) {
    for (let i = 0; i < count; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.buoyant = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * 1.6;
      p.pos.y += (Math.random() - 0.5) * 1.6;
      p.pos.z += (Math.random() - 0.5) * 1.6;
      p.vel.copy(up).multiplyScalar(0.6 + Math.random() * 0.9);
      p.vel.x += (Math.random() - 0.5) * 0.4;
      p.vel.z += (Math.random() - 0.5) * 0.4;
      p.rot.identity();
      p.spin.set(0, 0, 0);
      p.life = 0;
      p.maxLife = 1.4 + Math.random() * 1.6;
      p.size = 0.025 + Math.random() * 0.045;
      p.color.setRGB(0.72, 0.92, 1.0);
    }
  }

  /**
   * @param {boolean} submerged the player's own `headInWater` — the same flag
   *   that drives the underwater tint and the breath meter. Weather does not
   *   get to decide this for itself; one source of truth or the rain and the
   *   blue screen disagree at the waterline.
   */
  setWeather(mode, intensity, submerged = false) {
    this.weatherMode = mode;
    this.weatherIntensity = intensity;
    this.submerged = submerged;
  }

  /**
   * Radius of the top of the water in the camera's column, or 0 if there is
   * none within the height the rain box covers. Sampled every half unit so a
   * one-unit cell can't be stepped over, and resolved back to the exact top of
   * the cell that hit rather than to the sample point — a half-unit error puts
   * the cut visibly under the surface.
   */
  _waterSurfaceRadius(camera, up) {
    for (let d = 15; d >= -15; d -= 0.5) {
      _probe.copy(camera.position).addScaledVector(up, d);
      if (!this.planet.isLiquidWorld(_probe.x, _probe.y, _probe.z)) continue;
      const a = this.planet.cellAt(_probe.x, _probe.y, _probe.z);
      return a ? R_MIN + a.k + 1 : 0;
    }
    return 0;
  }

  update(dt, camera, up, sky) {
    // debris
    let count = 0, bub = 0;
    const g = GRAVITY * 0.72;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; continue; }
      _v.copy(p.pos).sub(this.center).normalize();
      if (p.buoyant) {
        // bubbles rise and are heavily damped by the water
        p.vel.addScaledVector(_v, 3.4 * dt);
        p.vel.multiplyScalar(Math.max(0, 1 - 2.4 * dt));
      } else {
        p.vel.addScaledVector(_v, -g * dt);
        p.vel.multiplyScalar(Math.max(0, 1 - 0.6 * dt));
      }
      const next = _v.copy(p.pos).addScaledVector(p.vel, dt);
      if (!p.buoyant && this.planet.isSolidWorld(next.x, next.y, next.z)) {
        p.vel.multiplyScalar(-0.24);
        p.vel.x *= 0.6; p.vel.z *= 0.6;
      } else {
        p.pos.copy(next);
      }
      if (p.spin.lengthSq() > 0) {
        _q.setFromEuler(new THREE.Euler(p.spin.x * dt, p.spin.y * dt, p.spin.z * dt));
        p.rot.multiply(_q);
      }
      const t = p.life / p.maxLife;
      const sz = p.size * (1 - t * t * 0.7);
      _s.set(sz, sz, sz);
      _m.compose(p.pos, p.rot, _s);
      if (p.buoyant) {
        if (bub < MAX_BUBBLES) { this.bubbleMesh.setMatrixAt(bub, _m); bub++; }
      } else {
        this.debris.setMatrixAt(count, _m);
        _c.copy(p.color);
        this.debrisColors.setXYZ(count, _c.r, _c.g, _c.b);
        count++;
      }
    }
    this.debris.count = count;
    if (count > 0) {
      this.debris.instanceMatrix.needsUpdate = true;
      this.debrisColors.needsUpdate = true;
    }
    this.bubbleMesh.count = bub;
    if (bub > 0) this.bubbleMesh.instanceMatrix.needsUpdate = true;

    // motes: sunlit dust by day, fireflies at night
    const mu = this.motes.material.uniforms;
    mu.uTime.value += dt;
    mu.uCam.value.copy(camera.position);
    mu.uUp.value.copy(up);
    const night = sky?.night ?? 0;
    // Motes are lit dust: they are visible because sunlight is catching them,
    // so after dark there is nothing to catch and they go out entirely.
    //
    // They used to get *brighter* at night (0.55 against 0.30) and drift toward
    // white, in a box that follows the camera — a star field glued to your
    // head. Dimming them to 0.13 was not enough either: additive white on a
    // near-black night still reads as specks, and against unlit ground there is
    // nothing for dust to be lit *by*. Fireflies, if they are ever wanted, want
    // to be their own thing — few, warm, and near the ground — rather than
    // daylight dust with the brightness turned down.
    mu.uOpacity.value = THREE.MathUtils.lerp(0.30, 0.0, night) * (1 - this.weatherIntensity * 0.8);
    mu.uColor.value.setRGB(1.0, 0.90, 0.66);

    // weather
    const wu = this.weather.material.uniforms;
    wu.uTime.value += dt;
    wu.uCam.value.copy(camera.position);
    wu.uUp.value.copy(up);
    wu.uIntensity.value = this.weatherIntensity;
    wu.uSnow.value = this.weatherMode === 'snow' ? 1 : 0;
    wu.uColor.value.setRGB(
      this.weatherMode === 'snow' ? 1.0 : 0.68,
      this.weatherMode === 'snow' ? 1.0 : 0.78,
      this.weatherMode === 'snow' ? 1.0 : 0.92,
    );
    // Head under the surface: no rain at all. Streaks falling past your face
    // while you are submerged is the worse half of the bug — cutting them at
    // the waterline alone still leaves the whole box drawn in front of you
    // whenever the camera sits below it.
    this.weather.visible = this.weatherIntensity > 0.01 && !this.submerged;
    // The probe costs ~60 block lookups, so only pay for it while something is
    // actually falling and visible.
    wu.uWaterR.value = this.weather.visible ? this._waterSurfaceRadius(camera, up) : 0;
  }

  setPixelRatio(r) {
    this.motes.material.uniforms.uPixelRatio.value = r;
    this.weather.material.uniforms.uPixelRatio.value = r;
  }
}
