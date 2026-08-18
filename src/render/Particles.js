// Block debris, footstep dust, splashes, ambient motes and weather.

import * as THREE from 'three';
import { D, GRAVITY } from '../world/Constants.js';
import { BLOCKS, ID } from '../world/Blocks.js';
// What counts as a roof. The same table the terrain's own skylight is flooded
// with, so a cube of debris and the wall it was chipped off agree - see the
// probe below, and the paragraph on leaves in Lighting.js.
import { SKY_ATTEN } from '../world/Lighting.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _probe = new THREE.Vector3();
// The tangent basis rain rings are scattered over. Two more scratch vectors
// rather than reusing _v, because _rainRipples holds the basis across the whole
// spawn loop and _v is rewritten inside it.
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

const MAX_DEBRIS = 900;
/**
 * How dark its own roof is allowed to make a chip of debris.
 *
 * The same 0.55 `Mobs` and `Drops` floor at, and one number on purpose: a
 * broken block, the cubes that fly off it and the animal watching are three
 * things in one room, and three different floors would be three different
 * rooms.
 */
const SKY_SHADE_MIN = 0.55;

const MAX_BUBBLES = 64;

/**
 * Steam and spray.
 *
 * 96 rather than the bubbles' 64 because these are the only ambient emitter in
 * the game that runs continuously off the world rather than off an event: a hot
 * spring you are standing beside and a waterfall you are looking at are both
 * always going, and a pool that puffs once a second reads as a smoking hole
 * rather than as warm water.
 */
const MAX_STEAM = 128;

/**
 * Expanding rings on the surface of water.
 *
 * 192 because the rain is the load-bearing case and it is a *rate* rather than
 * an event: at the storm cap this spawns RAIN_RIPPLE_RATE a second over a life
 * of RIPPLE_LIFE, i.e. ~48 live rings, and every splash in the game throws
 * three more on top. 192 is four times the steady state, which leaves room for
 * a dive into a downpour without the ring that matters being the one silently
 * dropped.
 */
const MAX_RIPPLES = 192;

/**
 * Rings a second at full storm intensity, before the quality scale.
 *
 * Chosen by what it looks like rather than by a drop count: real rain at 14
 * units of radius is thousands of impacts a second and drawing them is neither
 * affordable nor legible. 54 is the point where the surface reads as *being
 * rained on* — the eye picks up a continuous stipple rather than countable
 * individual events — and going past it stops changing the read and only costs
 * instances.
 */
const RAIN_RIPPLE_RATE = 80;

/** Radius of the disc around the camera that rain rings are scattered over. */
const RAIN_RIPPLE_R = 14;

const RIPPLE_LIFE = 0.9;

/** The plane's own normal, for aiming a ring along a local up. */
const RING_N = new THREE.Vector3(0, 0, 1);

/**
 * Motes in a tornado's whirl.
 *
 * The largest single particle count in the game, at more than twice the rain
 * field's 6000 — and it can afford to be, for the same reason the rain can:
 * there is no pool, no CPU loop and no per-particle state. One draw call, one
 * buffer that is written once at construction and never again, and a vertex
 * shader that resolves each mote's whole life from its seed. The only thing that
 * scales with the count is vertex invocations and fill.
 *
 * Measured: see the report. On the low tier `setQuality` takes 32% of them,
 * which is where the fill stops mattering on an integrated part.
 *
 * 8000 rather than fewer because the funnel is *tall* — TORNADO_H 34 cells — and
 * a count that reads as dense filling three cells of rain reads as a sparse
 * sprinkle spread over thirty-four.
 */
const TORNADO_MOTES = 8000;
/**
 * Radius scale of the funnel: the foot is 0.28 of this and the cloud end 2.58,
 * so 0.84 cells at the ground and 7.7 at the top. The ground figure is the one
 * that matters — it wants to sit inside CORE_R 3 in Tornado.js, so what the
 * player sees touching the ground is narrower than the radius that lifts them,
 * and nobody is ever picked up by something they were standing clear of.
 */
const TORNADO_R = 3.0;
/** Height of the drawn funnel, in cells. Matches FUNNEL_H in Tornado.js. */
const TORNADO_H = 34;

// --- lightning ---------------------------------------------------------------
//
// Lines, not a mesh, and for the reason the tornado's motes give at length:
// `PostFX` runs a GTAO prepass that swaps the material of every `isMesh` for an
// unlit normal stand-in, so a transparent depth-write-off ribbon would be drawn
// into the normal G-buffer as a solid 46-cell slab and paint an AO shadow the
// shape of a bolt across the sky behind it. Points and lines are already on the
// right side of that fence.
//
// Seven strands rather than one, and the count is measured rather than felt
// for. A single polyline is 1px whatever `linewidth` says — the platform simply
// ignores it — and screenshotted at 18 cells that is a hair you have to look
// for, which fails the one job the drawing has. Seven, sharing a foot and
// separating as they climb, read as one bright forked channel: they are drawn
// additively, so where they overlap near the ground the colour blows out to
// white and the channel has a core. Width the hardware will not give has to be
// faked with count.
const BOLT_MAX = 4;
/** Points down one strand, so BOLT_STEPS - 1 segments. */
const BOLT_STEPS = 15;
const BOLT_STRANDS = 7;
/** Cells above the ground the channel comes out of the cloud deck. */
const BOLT_H = 46;
/**
 * Seconds a bolt is on screen.
 *
 * Short, and flickered inside that: a real return stroke is under a millisecond
 * and the after-image is the whole of what a player sees. 0.30 with three
 * flickers is long enough to be seen out of the corner of an eye and far too
 * short to look like a drawn object standing in the world.
 */
const BOLT_LIFE = 0.30;

export class Particles {
  constructor(scene, planet) {
    this.planet = planet;

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

    // --- bubbles and splash droplets ---
    // Bubbles shared the debris cube mesh, so underwater you were watching a
    // stream of tiny boxes rise past your face. They get their own rounded,
    // translucent mesh; block shatter still wants cubes, a bubble never does.
    //
    // Splash droplets are drawn from this same mesh, and that is on purpose --
    // read the steam note below for what a FOURTH mesh has to earn. Steam got
    // one because it needs a per-instance alpha, which three cannot give from a
    // shared material. A droplet needs nothing of the sort: it is one fixed
    // water blue, no fade, the same rounded silhouette as a bubble, at the same
    // 0.03-0.09 size. Every reason bubbles are not cubes is a reason splashes
    // are not either, and the only difference between the two is the physics --
    // a droplet falls and bounces, a bubble rises -- which lives on the pool
    // entry, not on the mesh. So `droplet` picks the mesh and `buoyant` picks
    // the motion, and they are deliberately separate flags.
    //
    // Budget: this cap is now shared. The largest splash is the player entering
    // water at strength 1.2, i.e. 21 droplets, and the steady state of breath
    // bubbles underwater is ~22 (2 every 200ms against a ~2.2s life). 43 of 64
    // in the one case where both are up at once, so 64 still holds and nothing
    // is silently truncated.
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

    // --- ripple rings ---
    this.ripples = this._buildRipples(scene);
    this.ripplePool = [];
    for (let i = 0; i < MAX_RIPPLES; i++) {
      this.ripplePool.push({
        alive: false, pos: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        life: 0, maxLife: RIPPLE_LIFE, radius: 0.4, strength: 1,
      });
    }
    /**
     * Fractional rings owed to the rain, carried between frames.
     *
     * A rate this low against a 16 ms frame is well under one ring per frame,
     * so rounding it per frame would spawn either nothing or one, i.e. the rate
     * would quantise to 0 or 60 a second and nothing in between. Accumulating
     * the remainder is what makes RAIN_RIPPLE_RATE mean what it says.
     */
    this._rainOwed = 0;
    /**
     * 1 on the high tier, 0.45 on low. See `setQuality`.
     */
    this.rippleScale = 1;

    // --- steam ---
    // Its own mesh and its own material, and it cannot borrow either of the
    // other two. Debris is opaque lit cubes; bubbles are small, hard-edged and
    // blue. Steam is the opposite of both: large, soft, and it has to FADE, and
    // a per-instance fade is impossible with a shared material's `opacity` --
    // three has one alpha per material, not per instance. So it carries an
    // instanced alpha attribute and a four-line shader that reads it.
    this.steamMesh = this._buildSteam(scene);

    this.pool = [];
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.pool.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Quaternion(), spin: new THREE.Vector3(), life: 0, maxLife: 1, size: 0.1,
        color: new THREE.Color(), buoyant: false, steam: 0, droplet: false,
        // -1 is "has not asked yet". See `_probeSky`.
        sky: -1,
      });
    }

    // --- ambient motes ---
    this.motes = this._buildMotes(scene);

    // --- weather ---
    this.weather = this._buildWeather(scene);
    this.weatherMode = 'clear';
    this.weatherIntensity = 0;
    this.submerged = false;

    // --- tornado ---
    // Built once at startup rather than on demand, and left in the scene hidden.
    // A tornado forms roughly once every three quarters of an hour; compiling a
    // shader and uploading a 96KB seed buffer on the frame one touches down is a
    // hitch at exactly the moment the player most needs the frame rate. The cost
    // of holding it is one hidden Points, which three skips entirely.
    this.tornadoMotes = this._buildTornadoMotes(scene);
    /** 1 on the high tier, 0.32 on low. See `setQuality`. */
    this.tornadoScale = 1;

    // --- lightning ---
    // Same argument as the funnel above: built once and left hidden, because the
    // storm face strikes every few seconds and a shader compile on the frame one
    // lands is a hitch in the middle of the event it is drawing.
    this.boltMesh = this._buildBolts(scene);
    /** Live bolts, oldest first. At most BOLT_MAX. */
    this.boltList = [];
  }

  /**
   * One additive line soup for every bolt in the air at once.
   *
   * Vertex colours rather than a material colour, because each bolt fades on its
   * own clock and a shared material has one opacity. The colour written per
   * vertex IS the brightness, which is what lets the flicker be a buffer write
   * rather than four materials.
   */
  _buildBolts(scene) {
    const verts = BOLT_MAX * BOLT_STRANDS * (BOLT_STEPS - 1) * 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const l = new THREE.LineSegments(geo, mat);
    l.frustumCulled = false;
    // Above the funnel (13), which is above the rain (12). A bolt is the
    // brightest thing in the frame and nothing in the weather occludes it.
    l.renderOrder = 14;
    l.visible = false;
    scene.add(l);
    return l;
  }

  /**
   * A strike, from the cloud deck down to `pos`.
   *
   * The channel is walked from the ground UP, which is the way it forks: the
   * lateral wander accumulates with height, so the foot is exactly on the cell
   * that was struck and the top is allowed to be tens of cells off to one side.
   * Sited the other way round the foot drifts, and a bolt that visibly lands
   * eight cells from where the damage was is a bolt the player learns to
   * distrust.
   *
   * @param {{x:number,y:number,z:number}} pos world point the strike lands on,
   *   already resolved to the copy of itself nearest the camera.
   */
  bolt(pos) {
    if (this.boltList.length >= BOLT_MAX) this.boltList.shift();
    const pts = [];
    for (let s = 0; s < BOLT_STRANDS; s++) {
      const strand = new Float32Array(BOLT_STEPS * 3);
      let dx = (Math.random() - 0.5) * 0.25, dz = (Math.random() - 0.5) * 0.25;
      for (let i = 0; i < BOLT_STEPS; i++) {
        const t = i / (BOLT_STEPS - 1);
        // Wander grows with height and is shared by the whole bolt only at the
        // foot, so the three strands separate as they climb.
        dx += (Math.random() - 0.5) * 2.2 * t;
        dz += (Math.random() - 0.5) * 2.2 * t;
        strand[i * 3] = pos.x + dx;
        strand[i * 3 + 1] = pos.y + t * BOLT_H;
        strand[i * 3 + 2] = pos.z + dz;
      }
      pts.push(strand);
    }
    this.boltList.push({ pts, age: 0 });
  }

  _updateBolts(dt) {
    for (let i = this.boltList.length - 1; i >= 0; i--) {
      this.boltList[i].age += dt;
      if (this.boltList[i].age >= BOLT_LIFE) this.boltList.splice(i, 1);
    }
    if (!this.boltList.length) {
      this.boltMesh.visible = false;
      this.boltMesh.geometry.setDrawRange(0, 0);
      return;
    }
    const posAttr = this.boltMesh.geometry.attributes.position;
    const colAttr = this.boltMesh.geometry.attributes.color;
    const P = posAttr.array, C = colAttr.array;
    let v = 0;
    for (const b of this.boltList) {
      const t = b.age / BOLT_LIFE;
      // Three flickers over the life, under a falling envelope, so the channel
      // restrikes twice and dies rather than dimming evenly.
      const flick = 0.45 + 0.55 * Math.abs(Math.cos(t * Math.PI * 3));
      const bright = (1 - t * t) * flick * 2.6;
      for (const strand of b.pts) {
        for (let i = 0; i < BOLT_STEPS - 1; i++) {
          for (const j of [i, i + 1]) {
            P[v * 3] = strand[j * 3];
            P[v * 3 + 1] = strand[j * 3 + 1];
            P[v * 3 + 2] = strand[j * 3 + 2];
            // Cold blue-white, blown out at the core by the additive blend.
            C[v * 3] = bright * 0.80;
            C[v * 3 + 1] = bright * 0.88;
            C[v * 3 + 2] = bright;
            v++;
          }
        }
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.boltMesh.geometry.setDrawRange(0, v);
    this.boltMesh.visible = true;
  }

  /**
   * The rings an impact leaves on water.
   *
   * One instanced quad per ring, lying flat on the surface, with the annulus
   * drawn in the fragment shader from a per-instance phase. Drawing the ring in
   * the shader rather than as a ring *mesh* is what makes it affordable: the
   * geometry is two triangles whatever the ring is doing, the expansion is a
   * scalar rather than a vertex rebuild, and the whole system is one draw call.
   *
   * Alpha-blended and not additive, which is the opposite of the choice steam
   * makes and for the opposite reason. Steam is vapour scattering light, so it
   * adds; a ripple crest is not a light source, it is a piece of surface tilted
   * to catch the sky, and what it does is *replace* the water under it with a
   * paler colour. Additive was tried first and blows out to white over a sunlit
   * shallow, which reads as a bleach stain rather than as a wave.
   *
   * `depthWrite` off and `depthTest` on. The liquid material also writes no
   * depth, so a ring cannot z-fight the water it sits on however the swell has
   * moved the surface that frame; the depth test still runs against the opaque
   * seabed, so a ring behind a headland is correctly hidden.
   */
  _buildRipples(scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.ripplePhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES), 1);
    this.rippleStrength = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RIPPLES), 1);
    geo.setAttribute('aPhase', this.ripplePhase);
    geo.setAttribute('aStrength', this.rippleStrength);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xdff2ff) } },
      vertexShader: /* glsl */`
        attribute float aPhase;
        attribute float aStrength;
        varying float vPhase;
        varying float vStrength;
        varying vec2 vRUv;
        void main() {
          vPhase = aPhase;
          vStrength = aStrength;
          vRUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vPhase;
        varying float vStrength;
        varying vec2 vRUv;
        void main() {
          // Distance from the centre of the quad, 0 at the middle and 1 at the
          // edge, so the ring's radius and the phase are the same number.
          float d = length(vRUv - 0.5) * 2.0;
          if (d > 1.0) discard;
          float t = vPhase;
          // The crest thins as it spreads. A ring of constant width reads as a
          // painted circle growing; a real one carries a fixed amount of water
          // round an ever longer circumference and gets finer as it goes.
          float w = 0.02 + 0.20 * (1.0 - 0.55 * t);
          float a = smoothstep(w, 0.0, abs(d - t));
          // One impact throws more than one wave. A second, slower crest at 58%
          // of the leading one is the difference between a hoop and a ripple;
          // at 45% weight it is read as structure rather than counted.
          a = max(a, smoothstep(w * 0.8, 0.0, abs(d - t * 0.58)) * 0.45);
          // Squared fade out, linear fade in. The fade-in matters more than it
          // sounds: at t=0 the ring is a filled dot the width of w, and without
          // it every impact starts life as a visible blob.
          a *= smoothstep(0.0, 0.12, t) * (1.0 - t) * (1.0 - t);
          gl_FragColor = vec4(uColor, a * vStrength);
        }
      `,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_RIPPLES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.count = 0;
    // Above the water (6) and below the bubbles (11): a droplet thrown up by a
    // splash is in the air in front of the ring its own impact made.
    mesh.renderOrder = 10;
    mesh.layers.enable(1);
    scene.add(mesh);
    return mesh;
  }

  /**
   * One expanding ring, centred on `pos` and lying across `up`.
   *
   * `radius` is where the crest ends up, in cells, and is the only thing that
   * separates a raindrop from a diver: the shape, the timing and the fade are
   * the same event at two scales.
   */
  ripple(pos, up, radius = 0.5, strength = 1) {
    for (let i = 0; i < this.ripplePool.length; i++) {
      const r = this.ripplePool[i];
      if (r.alive) continue;
      r.alive = true;
      r.pos.copy(pos);
      r.up.copy(up);
      r.life = 0;
      // Bigger rings run longer, but not proportionally — a wave slows as it
      // spreads, so a ring four times the radius lasts about twice as long.
      r.maxLife = RIPPLE_LIFE * (0.7 + 0.5 * Math.sqrt(radius));
      r.radius = radius;
      r.strength = strength;
      return;
    }
  }

  /**
   * A puff: a low-poly sphere drawn with a soft rim so it does not read as a
   * ball, additive so a cloud of them accumulates into something thicker in the
   * middle, and unlit.
   *
   * Additive is the one choice here worth arguing about. Steam scatters light
   * rather than blocking it, so adding is closer to the physics than blending
   * is, and it fades to nothing on its own -- an alpha-blended white puff over
   * a bright sky has to be faded by alpha AND colour or it leaves a grey ghost.
   * The cost is that steam is weakest against a bright sky, which is the one
   * background a hot spring in the snow rarely has behind it.
   */
  _buildSteam(scene) {
    const geo = new THREE.IcosahedronGeometry(0.5, 1);
    const alpha = new Float32Array(MAX_STEAM);
    geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alpha, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xdff0f4) } },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        varying float vA;
        varying vec3 vN;
        void main() {
          vA = aAlpha;
          // VIEW space, not world. The rim term below is abs(n.z), which is
          // only a silhouette in the camera's frame; in world space it is a
          // band round an arbitrary planetary axis, so a puff faded out in
          // stripes that had nothing to do with where you were standing.
          vN = normalize(mat3(modelViewMatrix * instanceMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vA;
        varying vec3 vN;
        void main() {
          // Soft edge: the rim of the sphere, where the normal turns away from
          // the eye, fades out. Without it every puff is a hard-edged ball and
          // a hot spring looks like it is boiling ping-pong balls.
          // Squared rather than a smoothstep: a step still has a shoulder, and
          // a shoulder on a sphere is a hard-edged disc. Vapour has no edge at
          // all, so the falloff runs the whole way from the centre out.
          float rim = abs(normalize(vN).z);
          gl_FragColor = vec4(uColor, vA * rim * rim);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_STEAM);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.count = 0;
    mesh.renderOrder = 12;
    mesh.layers.enable(1);
    this.steamAlpha = geo.getAttribute('aAlpha');
    scene.add(mesh);
    return mesh;
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
        uWaterY: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uTime; uniform vec3 uCam; uniform vec3 uUp;
        uniform float uIntensity; uniform float uSnow; uniform float uPixelRatio;
        uniform float uWaterY;
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
          // waterline instead. uWaterY is the world Y of the water surface in
          // the camera's own column, 0 when there is none in reach.
          if (uWaterY > 0.0 && p.y < uWaterY) vA = 0.0;
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
        this.pool[i].sky = -1;          // a reused slot asks again
        this.pool[i].buoyant = false;   // only bubbles opt back in
        this.pool[i].steam = 0;         // and only steam opts back into this
        this.pool[i].droplet = false;   // and only splashes into this
        return this.pool[i];
      }
    }
    return null;
  }


  // `hitSpark` stood here and is gone rather than dormant. It threw four chips
  // off the face being mined, out of the same instanced-cube pool as the break
  // burst the player asked to be rid of — so mining still produced exactly the
  // cubes that were removed. The dig call in main.js dropped it and kept the
  // sound; the crack overlay draws the whole dig on the one face being worked,
  // which is more information than a spray of boxes.

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

  /**
   * Crumbs off a mouthful.
   *
   * Eating used to borrow `footDust` with `ID.dirt`, which is four clods of
   * SOIL a quarter of a cell wide, thrown upward at nine bursts a second, from
   * a point level with the eye. Standing still and eating an apple put a fog of
   * dirt around the player's own head - the report was that it looked ugly, and
   * the instrument was simply wrong: it is the emitter for a boot landing on
   * ground, doing duty for a bite.
   *
   * So: two crumbs, a third of the size, in the food's own colour, spawned in a
   * tight cluster and thrown DOWN and outward the way something falling off a
   * mouthful goes. `col` is the item's palette colour, so an apple sheds red
   * and bread sheds brown without a table mapping one to the other.
   */
  /**
   * One block-sized cube falling under its own weight.
   *
   * Gravity blocks used to arrive by teleport - the edit that emptied the old
   * cell and the edit that filled the new one landed on the same frame, so a
   * collapsing dune blinked rather than fell. This is the thing you watch on
   * the way down, and it rides the ordinary particle pool: same integrator,
   * same gravity, so it falls at the rate everything else in the world does.
   *
   * Untextured, like the debris cubes, and tinted with the block's own
   * `particle` colour - which is already the answer to "what does a handful of
   * this look like", so a falling grain and the dust it kicks up match.
   *
   * @param {number} secs how long it has to fall, so it is removed as it lands
   */
  fallingBlock(pos, up, col, secs) {
    const p = this._spawn();
    if (!p) return;
    p.alive = true;
    p.pos.copy(pos);
    p.vel.set(0, 0, 0);
    p.rot.setFromEuler(new THREE.Euler(0, 0, 0));
    p.spin.set(0, 0, 0);
    p.life = 0;
    p.maxLife = secs;
    // A shade under a full cell, so it never z-fights the walls of the shaft it
    // is falling down.
    p.size = 0.94;
    p.color.setRGB(col[0], col[1], col[2]);
  }

  crumbs(pos, up, col) {
    for (let i = 0; i < 2; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(pos).addScaledVector(up, -0.12);
      p.pos.x += (Math.random() - 0.5) * 0.12;
      p.pos.y += (Math.random() - 0.5) * 0.12;
      p.pos.z += (Math.random() - 0.5) * 0.12;
      // Down, not up. Gravity does the rest, so this only has to leave the lip.
      p.vel.copy(up).multiplyScalar(-0.25 - Math.random() * 0.25);
      p.vel.x += (Math.random() - 0.5) * 0.35;
      p.vel.y += (Math.random() - 0.5) * 0.35;
      p.vel.z += (Math.random() - 0.5) * 0.35;
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.30 + Math.random() * 0.25;
      p.size = 0.016 + Math.random() * 0.018;
      p.color.setRGB(col[0], col[1], col[2]);
    }
  }

  /**
   * A cloud of spores, and the one warning a deathcap gives before it doses
   * you.
   *
   * The first cut of this borrowed `crumbs` and it was measured invisible: a
   * crumb is 0.016-0.034 across and lives 0.30-0.55 seconds, because it is a
   * flake off a mouthful and is meant to be nearly nothing. On a screenshot of
   * a player stood in a mushroom it did not read at all, which is fatal for a
   * cue whose entire job is to arrive before the damage.
   *
   * `steam` was the other candidate and could not be used: it carries its fade
   * in `color` as a scalar over an additive white material, so a steam puff is
   * white by construction and there is no green in it. A poison that puffed the
   * same white as the hot spring and the cold snap would also have been the
   * third thing on the planet saying the same thing.
   *
   * So: the crumb's tinted material, at four times the size, three times the
   * life, and drifting *up* and outward rather than falling. Three at a time,
   * because one particle a frame reads as a speck and a cloud is what a
   * mushroom releasing spores looks like.
   */
  spores(pos, up, col, spread = 0.35) {
    for (let i = 0; i < 3; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * spread;
      p.pos.y += (Math.random() - 0.5) * spread;
      p.pos.z += (Math.random() - 0.5) * spread;
      // Up, slowly. Spores hang; they do not fall like crumbs and they do not
      // climb like steam off a spring.
      p.vel.copy(up).multiplyScalar(0.16 + Math.random() * 0.22);
      p.vel.x += (Math.random() - 0.5) * 0.28;
      p.vel.y += (Math.random() - 0.5) * 0.28;
      p.vel.z += (Math.random() - 0.5) * 0.28;
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.9 + Math.random() * 0.7;
      p.size = 0.042 + Math.random() * 0.040;
      p.color.setRGB(col[0], col[1], col[2]);
    }
  }

  splash(pos, up, strength = 1) {
    // The ring goes here rather than at the six call sites, and that is the
    // whole reason it is worth doing: every splash in the game already comes
    // through this function — the player diving in and climbing out, a fish
    // breaking the surface, a fish landing after a fight, a bucket emptied —
    // and all of them get the surface disturbance without a line changing
    // anywhere else.
    //
    // Two rings, not one. A body entering water throws a crest immediately and
    // a second, wider one as the hole it made collapses; the delay is faked by
    // starting the outer one smaller and letting it run to a larger radius,
    // which costs nothing and is most of the read. Scaled by strength so the
    // player at 1.2 makes a metre-and-a-half disturbance and a fish at 0.35
    // makes a dimple.
    this.ripple(pos, up, 0.55 + 1.0 * strength, strength * 0.85);
    this.ripple(pos, up, 0.30 + 0.5 * strength, strength * 0.55);
    for (let i = 0; i < 18 * strength; i++) {
      const p = this._spawn();
      if (!p) return;
      p.alive = true;
      // Rounded, off the bubble mesh. Not buoyant: a thrown droplet still falls
      // and still bounces off the bank, which is the debris branch in `update`.
      p.droplet = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * 0.9; p.pos.y += (Math.random() - 0.5) * 0.9; p.pos.z += (Math.random() - 0.5) * 0.9;
      p.vel.copy(up).multiplyScalar(2.5 + Math.random() * 3 * strength);
      p.vel.x += (Math.random() - 0.5) * 3; p.vel.y += (Math.random() - 0.5) * 3; p.vel.z += (Math.random() - 0.5) * 3;
      p.rot.identity(); p.spin.set(0, 0, 0);
      p.life = 0; p.maxLife = 0.5 + Math.random() * 0.5;
      p.size = 0.035 + Math.random() * 0.05;
      // No `p.color`. That was the per-instance tint the debris mesh reads, and
      // the bubble material carries its own single colour -- writing one here
      // would just be a value nothing looks at.
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
   * A blast: the fireball, and everything the crater used to be.
   *
   * Three populations rather than one, because an explosion is three things
   * arriving at different speeds and a single burst reads as a firework:
   *
   *   debris  the crater, thrown. Tumbling cubes on the ordinary (non-buoyant)
   *           branch, so they arc, bounce and settle — which is the part that
   *           says a hole was just made in the ground rather than a light went
   *           off. Coloured off `dirt`'s particle swatch rather than sampled
   *           per cell: this fires *after* `_applyEdits` has already turned
   *           those cells to air, so there is nothing left to sample, and a
   *           crater is mostly soil in every biome that has one.
   *   embers  the fireball. Buoyant and short, so it rises and is gone inside
   *           half a second — the flash, not a fire.
   *   smoke   the column left behind. Steam particles, which already grow as
   *           they age, but dark: `color` on a steam particle is its peak
   *           opacity, and the material is additive, so "dark smoke" here is
   *           thin white smoke. It is the shape that reads, not the shade.
   *
   * The counts are the largest single ask any emitter in this file makes, and
   * that is deliberate — `_spawn` returns null once the pool is full and every
   * loop below bails on it, so the pool is the budget and this simply spends
   * all of it. An explosion is allowed to be the loudest thing on screen for a
   * second.
   */
  blast(pos, up, strength = 1) {
    const dirt = BLOCKS[ID.dirt]?.particle || [0.36, 0.26, 0.18];
    for (let i = 0; i < 34 * strength; i++) {
      const p = this._spawn();
      if (!p) break;
      p.alive = true;
      p.pos.copy(pos);
      p.pos.x += (Math.random() - 0.5) * 1.2;
      p.pos.y += (Math.random() - 0.5) * 1.2;
      p.pos.z += (Math.random() - 0.5) * 1.2;
      // Up and out, hard. The vertical bias is what makes it a crater and not
      // a shotgun: a burst thrown evenly in every direction puts most of its
      // debris into the ground on the first frame.
      p.vel.copy(up).multiplyScalar(3.5 + Math.random() * 5.5);
      p.vel.x += (Math.random() - 0.5) * 9;
      p.vel.y += (Math.random() - 0.5) * 9;
      p.vel.z += (Math.random() - 0.5) * 9;
      p.rot.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
      p.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
      p.life = 0; p.maxLife = 0.9 + Math.random() * 0.9;
      p.size = 0.06 + Math.random() * 0.11;
      const v = 0.75 + Math.random() * 0.5;
      p.color.setRGB(dirt[0] * v, dirt[1] * v, dirt[2] * v);
    }
    this.embers(pos, up, (16 * strength) | 0, 1.6);
    for (let i = 0; i < 7 * strength; i++) this.steam(pos, up, 1.5, 0);
  }

  /**
   * The fuse. One puff a frame off an arming mob, so the rate is the caller's.
   *
   * Deliberately NOT `embers`: an ember is something already burning coming off
   * a body, and this has to read as pressure building inside one. So it is a
   * single spark thrown outward from the body rather than a plume rising off
   * it, and it gets whiter as `heat` climbs — the same cue a poker gives.
   */
  fuse(pos, up, heat = 0) {
    const p = this._spawn();
    if (!p) return;
    p.alive = true;
    p.buoyant = true;
    p.pos.copy(pos);
    p.pos.x += (Math.random() - 0.5) * 0.7;
    p.pos.y += (Math.random() - 0.5) * 0.7;
    p.pos.z += (Math.random() - 0.5) * 0.7;
    p.vel.copy(up).multiplyScalar(0.8 + Math.random() * 1.4);
    p.vel.x += (Math.random() - 0.5) * 1.6;
    p.vel.y += (Math.random() - 0.5) * 1.6;
    p.vel.z += (Math.random() - 0.5) * 1.6;
    p.rot.identity();
    p.spin.set(0, 0, 0);
    p.life = 0; p.maxLife = 0.25 + Math.random() * 0.3;
    p.size = 0.03 + Math.random() * 0.05 + heat * 0.03;
    p.color.setRGB(1.0, 0.4 + heat * 0.55, 0.1 + heat * 0.7);
  }

  /**
   * Steam off hot water, or spray off falling water.
   *
   * One call is one puff, not a burst: the callers are ambient scanners that
   * run every frame over whatever is nearby, so the rate is theirs to set and
   * the shape of the plume comes from the spread and the lifetime rather than
   * from a count. `heat` 1 is a hot spring -- slow, tall, long-lived, straight
   * up, because still water over hot rock convects and does not blow about.
   * `heat` 0 is the spray at the foot of a waterfall: fast, wide, short-lived
   * and thrown sideways, because that is air being dragged down and pushed out
   * rather than rising of its own accord.
   */
  steam(pos, up, spread = 0.5, heat = 1) {
    const p = this._spawn();
    if (!p) return;
    p.alive = true;
    p.steam = 1;
    p.buoyant = false;
    p.pos.copy(pos);
    p.pos.x += (Math.random() - 0.5) * spread;
    p.pos.y += (Math.random() - 0.5) * spread;
    p.pos.z += (Math.random() - 0.5) * spread;
    const rise = heat > 0.5 ? 0.55 + Math.random() * 0.5 : 1.5 + Math.random() * 1.4;
    p.vel.copy(up).multiplyScalar(rise);
    const drift = heat > 0.5 ? 0.16 : 0.9;
    p.vel.x += (Math.random() - 0.5) * drift;
    p.vel.y += (Math.random() - 0.5) * drift;
    p.vel.z += (Math.random() - 0.5) * drift;
    p.rot.identity();
    p.spin.set(0, 0, 0);
    p.life = 0;
    p.maxLife = heat > 0.5 ? 2.6 + Math.random() * 2.2 : 0.9 + Math.random() * 0.7;
    // The size here is the START size; `update` grows it. A puff that does not
    // expand reads as a cotton ball travelling upward rather than as vapour.
    p.size = (heat > 0.5 ? 0.26 : 0.18) + Math.random() * 0.18;
    // The peak of the fade, carried in `color` so the two callers can differ in
    // density without a second material. 0.30 was the first try and it was
    // nearly invisible in a screenshot: additive white over a lit snowfield has
    // to be much stronger than it looks in isolation before it reads as vapour
    // rather than as a lens artefact.
    p.color.setScalar(heat > 0.5 ? 0.62 : 0.48);
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
   * World Y of the top of the water in the camera's column, or 0 if there is
   * none within the height the rain box covers. Sampled every half unit so a
   * one-unit cell can't be stepped over, and resolved back to the exact top of
   * the cell that hit rather than to the sample point — a half-unit error puts
   * the cut visibly under the surface.
   */
  _waterSurfaceY({ position }) {
    for (let d = 15; d >= -15; d -= 0.5) {
      _probe.copy(position);
      _probe.y += d;
      if (!this.planet.isLiquidWorld(_probe.x, _probe.y, _probe.z)) continue;
      const a = this.planet.cellAt(_probe.x, _probe.y, _probe.z);
      return a ? a.k + 1 : 0;
    }
    return 0;
  }

  /**
   * How much sky is over one particle, asked once in its life.
   *
   * The debris cubes are a MeshStandardMaterial and so are lit by the scene,
   * and the scene's entity fill used to be dimmed by the *player's* sky
   * exposure - which was the only thing keeping a spray of chips off a cave
   * wall from being lit like a spray in a meadow. That term is gone (see
   * `entityFill.intensity` in Sky.js), so the chips answer for themselves.
   *
   * Once, not on a timer. `Mobs` and `Drops` re-probe because a cow walks under
   * a tree and a stack lies on a floor for minutes; a chip lives about a
   * second, thrown from a block that has just been broken, and the roof over it
   * does not change inside that second. One column walk per particle, at the
   * first frame it is drawn, is the whole cost - and it is a walk that gives up
   * after three blockers, so the ones in a cave, which is where this matters,
   * are the cheapest of all.
   *
   * `SKY_ATTEN` and not solidity, for the reason Drops.js sets out at length:
   * leaves are zero in that table, a canopy is a sieve, and reading solidity
   * instead turns everything under a wood into a silhouette.
   */
  _probeSky(p) {
    p.sky = 1;
    const cell = this.planet.cellAt(p.pos.x, p.pos.y, p.pos.z);
    if (!cell) return;
    let blocked = 0;
    for (let k = cell.k + 2; k < D; k++) {
      if (SKY_ATTEN[this.planet.at(cell.col, k)] === 255 && ++blocked >= 3) break;
    }
    p.sky = SKY_SHADE_MIN + (1 - SKY_SHADE_MIN) * (1 - Math.min(3, blocked) / 3);
  }

  update(dt, camera, up, sky) {
    // debris
    let count = 0, bub = 0, stm = 0;
    const g = GRAVITY * 0.72;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; continue; }
      _v.set(0, 1, 0);
      if (p.steam) {
        // Rises, and slows as it cools and spreads. No collision test: vapour
        // goes round a rock, and a puff bouncing off the rim of its own pool is
        // both wrong and the one thing that would make it read as a solid.
        p.vel.addScaledVector(_v, 0.55 * dt);
        p.vel.multiplyScalar(Math.max(0, 1 - 0.9 * dt));
        p.pos.addScaledVector(p.vel, dt);
      } else if (p.buoyant) {
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
      // Steam is the one thing here that GROWS. Everything else is debris and
      // shrinks away; vapour expands as it cools, and the expansion plus the
      // fade is what turns a line of puffs into a plume.
      const sz = p.steam ? p.size * (1 + t * 1.9) : p.size * (1 - t * t * 0.7);
      _s.set(sz, sz, sz);
      _m.compose(p.pos, p.rot, _s);
      if (p.steam) {
        if (stm < MAX_STEAM) {
          this.steamMesh.setMatrixAt(stm, _m);
          // In and out: a puff that appears at full strength reads as a pop.
          // p.color carries the peak, which is how the two callers differ in
          // density without a second material.
          this.steamAlpha.setX(stm, p.color.r * Math.sin(Math.PI * Math.min(1, t)) );
          stm++;
        }
      } else if (p.buoyant || p.droplet) {
        // Two different motions, one mesh. See the note on the mesh itself.
        if (bub < MAX_BUBBLES) { this.bubbleMesh.setMatrixAt(bub, _m); bub++; }
      } else {
        this.debris.setMatrixAt(count, _m);
        if (p.sky < 0) this._probeSky(p);
        // Onto the tint, because that is the only per-instance lever there is:
        // one material lights all of them, so how much of the scene's light a
        // chip in a cave gives back is all this layer can say.
        _c.copy(p.color).multiplyScalar(p.sky);
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
    this.steamMesh.count = stm;
    if (stm > 0) {
      this.steamMesh.instanceMatrix.needsUpdate = true;
      this.steamAlpha.needsUpdate = true;
    }

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
    wu.uWaterY.value = this.weather.visible ? this._waterSurfaceY(camera) : 0;

    // The funnel's clock. Advanced here and not in `tornado()` so the spin never
    // depends on how often the game happens to call that — and stepped only
    // while something is on screen, so a world that has not seen a tornado in an
    // hour is not carrying a float that has drifted past the precision where
    // `sin` stops being smooth.
    if (this.tornadoMotes.visible) {
      this.tornadoMotes.material.uniforms.uTime.value += dt;
    }

    this._rainRipples(dt, camera, up, wu.uWaterY.value);
    this._updateRipples(dt);
    this._updateBolts(dt);
  }

  /**
   * Rain landing on water.
   *
   * The gap this closes is a hole rather than a polish pass: the weather shader
   * kills every drop at the waterline (`uWaterY`, see `_buildWeather`) because
   * a storm carrying on underneath the sea is worse, and nothing was put in its
   * place. So rain over water simply ceased to exist a metre before it arrived,
   * and standing on a beach in a downpour the sea was the one flat, dry, silent
   * surface in the frame.
   *
   * Rides the height the weather shader is already using, so the rings land on
   * exactly the surface the drops are being cut at and the two cannot disagree.
   *
   * Each candidate is tested against the world before it is used. Scattering
   * over a disc assumes the whole disc is water, which is false at every
   * shoreline, and without the test a beach gets rained-on rings on the sand.
   * One block lookup per spawn, at a few dozen a second.
   */
  _rainRipples(dt, camera, up, waterY) {
    if (waterY <= 0 || this.weatherMode !== 'rain' || this.submerged) { this._rainOwed = 0; return; }
    this._rainOwed += dt * RAIN_RIPPLE_RATE * this.weatherIntensity * this.rippleScale;
    let n = Math.floor(this._rainOwed);
    if (n <= 0) return;
    this._rainOwed -= n;
    // A frame that ran long must not be allowed to empty the pool in one go.
    n = Math.min(n, 8);
    // Any vector not parallel to up gives a tangent basis; which one is
    // arbitrary, since the ring positions inside it are random anyway.
    if (Math.abs(up.y) > 0.9) _t1.set(1, 0, 0); else _t1.set(0, 1, 0);
    _t1.cross(up).normalize();
    _t2.copy(up).cross(_t1).normalize();
    const R = RAIN_RIPPLE_R * this.rippleScale;
    for (let i = 0; i < n; i++) {
      // sqrt on the radius, or every ring lands in a knot around the camera.
      const rr = Math.sqrt(Math.random()) * R;
      const th = Math.random() * Math.PI * 2;
      _probe.copy(camera.position)
        .addScaledVector(_t1, Math.cos(th) * rr)
        .addScaledVector(_t2, Math.sin(th) * rr);
      // Back onto the waterline. Half a cell down, so the test lands inside
      // the water cell rather than in the air directly above it.
      _probe.y = waterY - 0.5;
      if (!this.planet.isLiquidWorld(_probe.x, _probe.y, _probe.z)) continue;
      _v.set(0, 1, 0);
      _probe.y = waterY;
      // Sized in CELLS, and deliberately far larger than a raindrop.
      //
      // The first pass used a physical 0.22-0.38, which is about what a drop
      // actually throws, and measured 0.11% of the frame moving against the
      // no-rings arm at full storm with 39 rings live — i.e. correct and
      // invisible. A block is a metre here and the whole world is drawn at that
      // grain, so an impact has to be a fraction OF A BLOCK rather than a
      // fraction of a metre before it survives being drawn twenty cells away.
      // 0.45-0.85 is the point where the sea reads as stippled rather than as
      // occasionally marked.
      this.ripple(_probe, _v, 0.45 + Math.random() * 0.40, 0.75 + Math.random() * 0.25);
    }
  }

  /**
   * The wake a swimmer leaves, one stroke at a time.
   *
   * Placed on the water's own surface rather than at the swimmer, because the
   * body is mostly under it: a ring at `pos` would be drawn a metre down inside
   * the water, seen through the tint, and read as a smudge on the bed. The
   * probe is the same one the rain uses, so a stroke and a raindrop agree about
   * where the surface is.
   *
   * Returns quietly if the column has no water in reach, which is what happens
   * for the frame or two after the swimmer has climbed out but is still being
   * called; there is nothing to ripple and nothing to report.
   *
   * A pair of rings offset a little apart, rather than one centred: a stroke is
   * two arms, and a single concentric ring on top of the swimmer reads as the
   * player emitting a halo instead of pushing water past themselves.
   */
  swimWake(pos, up, forward, strength = 1) {
    const r = this._waterSurfaceY({ position: pos });
    if (r <= 0) return;
    for (const side of [1, -1]) {
      _probe.copy(pos)
        .addScaledVector(forward, -0.25)
        .addScaledVector(_t1.copy(forward).cross(up).normalize(), side * 0.42);
      _probe.y = r;
      this.ripple(_probe, _t2.set(0, 1, 0), 0.75 + 0.35 * strength, 0.5 * strength);
    }
  }

  _updateRipples(dt) {
    let n = 0;
    for (const r of this.ripplePool) {
      if (!r.alive) continue;
      r.life += dt;
      if (r.life >= r.maxLife) { r.alive = false; continue; }
      if (n >= MAX_RIPPLES) continue;
      _q.setFromUnitVectors(RING_N, r.up);
      // The quad is the ring at full extent; the phase inside it does the
      // expanding. Scaling the quad instead would shrink the crest's width
      // along with its radius and the ring would come out as a hard hoop.
      _s.setScalar(r.radius * 2);
      _m.compose(r.pos, _q, _s);
      this.ripples.setMatrixAt(n, _m);
      this.ripplePhase.setX(n, r.life / r.maxLife);
      this.rippleStrength.setX(n, r.strength);
      n++;
    }
    this.ripples.count = n;
    if (n > 0) {
      this.ripples.instanceMatrix.needsUpdate = true;
      this.ripplePhase.needsUpdate = true;
      this.rippleStrength.needsUpdate = true;
    }
  }

  /**
   * The low tier gets fewer, tighter rain rings.
   *
   * Not none: the rings are one draw call of two triangles and the cost that
   * scales is the per-spawn world lookup and the fill, so cutting the rate and
   * the radius together takes most of both while leaving the sea in a storm
   * looking like it is being rained on. See `QUALITY` in main.
   */
  setQuality(low) {
    this.rippleScale = low ? 0.45 : 1;
    // The funnel's debris count. Same shape of argument as the rain rings: the
    // whole whirl is one draw call whatever the count is, so what actually
    // scales is fill and vertex work. See TORNADO_MOTES.
    this.tornadoScale = low ? 0.32 : 1;
  }

  /**
   * Draw a funnel standing on `pos` along `up`.
   *
   * Called every frame while one exists and never otherwise; `tornadoOff` hides
   * both meshes. There is no pool and no per-particle CPU work at all — the
   * whirl is TORNADO_MOTES points whose entire motion is a closed-form function
   * of a per-instance seed and `uTime` in the vertex shader, which is the same
   * discipline the rain field and the ripple rings already use and the reason
   * the largest particle effect in the game is also one of the cheapest.
   *
   * @param {number} strength 0..1 spin-up envelope. Drives both opacity and how
   *   many of the motes are drawn at all, so a funnel dying away visibly thins.
   */
  tornado(pos, up, strength) {
    const u = this.tornadoMotes.material.uniforms;
    u.uBase.value.copy(pos);
    u.uUp.value.copy(up);
    u.uStrength.value = strength;
    u.uCount.value = this.tornadoScale;
    this.tornadoMotes.visible = strength > 0.02;
  }

  /** No funnel. */
  tornadoOff() {
    this.tornadoMotes.visible = false;
    this.tornadoMotes.material.uniforms.uStrength.value = 0;
  }

  /**
   * The whirl: dust, leaves and grit going round.
   *
   * A cloud of points rather than a cone mesh, and the mesh was tried first and
   * removed. `PostFX` runs a GTAO prepass that walks the scene and swaps the
   * material of every `isMesh` for an unlit normal stand-in, hiding only points,
   * lines and sprites — so a transparent, depth-write-off cone would have been
   * drawn into the normal G-buffer as a solid 34-cell object and painted an AO
   * shadow the shape of a tornado onto everything behind it. Points are already
   * on the right side of that fence, which is where the rain field lives too.
   *
   * Every mote's whole life is a closed-form function of its seed and `uTime`.
   * One buffer, written once at construction, one draw call, no CPU work.
   *
   * **`climb` drives both the height and the radius, and that is the one thing
   * here that is not decoration.** The first draft picked the radius from the
   * seed and the height from a separate scrolling term, so a mote's distance
   * from the axis had nothing to do with how far up it was — which is not a
   * funnel, it is a cylinder of unrelated dots, and on screen it read as a light
   * flurry of snow rather than as a tornado. One variable for both is what makes
   * the silhouette a cone.
   *
   * The profile is `0.28 + 2.3 * climb^1.7` against TORNADO_R: a tight rope at
   * the ground, flaring into a skirt at the cloud. The spin rate falls off with
   * height for the same reason — the base visibly outruns the top, which is what
   * separates a vortex from a column of smoke.
   *
   * Colour runs soil-brown at the foot to pale grey at the top, and the alpha
   * runs the other way, so the thing is densest and darkest exactly where it
   * meets the ground and dissolves into the cloud deck at the top.
   */
  _buildTornadoMotes(scene) {
    const N = TORNADO_MOTES;
    const seed = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uBase: { value: new THREE.Vector3() },
        uUp: { value: new THREE.Vector3(0, 1, 0) }, uStrength: { value: 0 },
        uCount: { value: 1 }, uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        uniform float uTime; uniform vec3 uBase; uniform vec3 uUp;
        uniform float uStrength; uniform float uCount; uniform float uPixelRatio;
        varying float vA; varying float vH;
        void main() {
          vec3 ref = abs(uUp.y) > 0.9 ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);
          vec3 t1 = normalize(cross(uUp, ref));
          vec3 t2 = cross(uUp, t1);
          // Where up the funnel this mote is, right now. Squared so the seed
          // range crowds toward the foot, which is where the column is thin and
          // needs the density to stay opaque.
          float climb = fract(aSeed.z * aSeed.z + uTime * 0.11);
          vH = climb;
          float r = ${TORNADO_R.toFixed(1)} * (0.28 + 2.3 * pow(climb, 1.7));
          // The base outruns the top. The 1.2 floor stops the skirt going static.
          float rate = mix(5.2, 1.2, climb);
          float ang = aSeed.x * 6.2831853 + uTime * rate;
          vec3 p = uBase + uUp * (climb * ${TORNADO_H.toFixed(1)})
                 + t1 * (cos(ang) * r) + t2 * (sin(ang) * r);
          // Wobble, so the column is not a perfect lathe.
          p += t1 * sin(uTime * 1.7 + aSeed.y * 20.0) * 0.45;
          p += t2 * cos(uTime * 1.9 + aSeed.x * 20.0) * 0.45;
          // Two gates, and they are different questions. uCount is the quality
          // tier and is a fixed fraction of the field; uStrength is the spin-up
          // envelope, so a funnel forming and dying visibly thins rather than
          // just fading, which is much easier to read at a distance.
          vA = step(aSeed.y, uStrength * uCount);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // Grit at the foot, dust at the top. Sized against the rain field's
          // 3.6-4.6, and larger, because a raindrop is meant to be a speck and
          // this is meant to be a wall you can see across a plain.
          // Floored at 1.7px. Point size falls as 1/distance, so at the 100-odd
          // cells a plain is wide the unfloored value drops under a pixel and
          // the funnel does not merely get small, it disappears — which fails
          // the one job the drawing has, which is to be seen coming. The floor
          // costs nothing (fill at a pixel and a half is free) and holds the
          // column as a visible brown smudge all the way to the horizon.
          gl_PointSize = max(1.7 * uPixelRatio,
            mix(9.0, 4.0, climb) * uPixelRatio * (14.0 / max(1.0, -mv.z)));
        }
      `,
      fragmentShader: /* glsl */`
        varying float vA; varying float vH;
        void main() {
          if (vA < 0.5) discard;
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.10, length(c));
          // Soil at the foot, cloud at the top.
          vec3 col = mix(vec3(0.26, 0.20, 0.14), vec3(0.58, 0.58, 0.62), vH);
          // The top's 0.42 was 0.30 and was raised against the distance shot,
          // not by eye. Seen from 95 cells the ground end is below the horizon
          // and the only part of the funnel above the skyline is the pale upper
          // skirt — so the alpha that decides whether a player spots one coming
          // is this one, and at 0.30 it was a smudge you could miss.
          gl_FragColor = vec4(col, a * mix(0.95, 0.42, vH));
        }
      `,
      transparent: true, depthWrite: false,
    });
    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    // Above the rain (12): a funnel seen through a downpour is in front of it.
    p.renderOrder = 13;
    p.visible = false;
    scene.add(p);
    return p;
  }

  setPixelRatio(r) {
    this.motes.material.uniforms.uPixelRatio.value = r;
    this.weather.material.uniforms.uPixelRatio.value = r;
    this.tornadoMotes.material.uniforms.uPixelRatio.value = r;
  }
}
