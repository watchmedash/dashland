// The dividers, seen from across the map.
//
// The portal blocks themselves are terrain, and terrain streams: chunks load
// within CHUNK_LOAD_DIST (150) and are freed at CHUNK_KEEP_DIST (190). A
// divider four hundred units away is therefore not dim, it **does not exist as
// geometry** - and the map is 1248 across, so most of the time most of the
// eight boundaries are nothing at all. The owner's ask, "make the divider glow
// visible from far", cannot be answered with emission on a tile for that
// reason, however bright the tile is.
//
// So this is a second, much cheaper object that stands in for them at range: a
// curtain of light along each divider run, built once from `Grid.isWall`'s own
// rule, never streamed and never rebuilt.
//
// ### How it stays honest against the real blocks
//
// Two things would give it away. The first is drawing it on top of the portal
// you are standing next to, which reads as z-fighting on a wall - so the
// fragment fades itself out by distance, and is gone well inside the range the
// real blocks start loading at. The second is the fog: the curtain's whole
// purpose is to be seen from further than the fog reaches, so it uses its own
// material with no fog term rather than the voxel one.
//
// ### Cost
//
// One draw call. A run is a straight line of F columns, so one quad covers it,
// and every run is the same size - so it is a single InstancedMesh over a
// 1x1 plane: 4 vertices and 2 triangles of geometry, 144 instances (16 ring
// edges times the 9 wrap copies), 288 triangles drawn. The instance matrices
// are written once at construction and never touched again, which is what pays
// for the wrap: a copy of every run at -W, 0 and +W on both axes means the
// nearest one is always in front of you and nothing has to be re-placed as you
// walk over the seam.

import * as THREE from 'three';
import { W, D, F, SEALED, faceOrigin, NORTH, SOUTH, WEST } from '../world/Grid.js';
import { voxelUniforms } from './VoxelMaterial.js';

/**
 * Where the curtain is invisible, and where it is at full strength.
 *
 * The near end sits just under CHUNK_KEEP_DIST (190), so where the two do
 * overlap - a twenty-unit band - the curtain is at a fifth of its strength and
 * cannot fight the real blocks. Below 170 it is gone entirely. Known and
 * deliberate: on the low quality tier the chunks are freed at about 122, so
 * there is a band between that and 170 where a divider is out of sight
 * altogether. Closing it would mean fading the curtain in over the loaded
 * chunks instead, which is the double-draw this is written to avoid.
 */
export const FADE_NEAR = 170;
export const FADE_FAR = 280;

/**
 * How loud the curtain is, and how much of that it keeps in daylight.
 *
 * BRIGHTNESS was 1.15, which put the sheet at very nearly its own full colour
 * wherever it was drawn - a saturated violet wall standing over the whole
 * horizon and, once UnrealBloom had it, washing out the frame it was drawn
 * over. The effect's job is to say "a boundary is that way", and that is a line
 * on the horizon rather than a light source.
 *
 * DAY_GAIN is the daylight share; at night the curtain runs at 1.0. See the
 * uNight term in FRAG for why the two differ.
 */
export const BRIGHTNESS = 0.55;
export const DAY_GAIN = 0.55;

/** How many wrap copies of each run, per axis. Three: -W, 0, +W. */
const COPIES = 3;

const VERT = /* glsl */`
  varying vec2 vUvL;
  varying vec3 vWorldPos;
  void main() {
    vUvL = uv;
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    vWorldPos = (modelMatrix * wp).xyz;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * wp;
  }
`;

/**
 * The look: a violet line lying along the skyline, thinning out a little way
 * above it, and thinning again with every unit of air or water in front of it.
 *
 * It is deliberately NOT a picture of the swirl. The tile's spiral is a thing
 * you read at arm's length; at four hundred units a run of them is under a
 * pixel per block, so any detail in here is noise. What survives at that range
 * is colour, a vertical gradient and a soft edge, and that is all this draws.
 *
 * It is also deliberately not a shaft of light. Three terms used to make it
 * one - a body reaching to the top of the world, hard vertical streaks 14
 * blocks wide, and no atmosphere at all - and the owner read the result as sun
 * rays coming through the terrain. Each is answered where it is written below.
 */
const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uCam;
  uniform float uNear;
  uniform float uFar;
  uniform float uNight;
  uniform float uFogDensity;
  uniform float uUnderwater;
  varying vec2 vUvL;
  varying vec3 vWorldPos;

  // VoxelMaterial's own numbers, so the curtain thins on the same curve the
  // terrain does rather than on a second one that has to be kept in step:
  // AERIAL_GAIN from the aerial-perspective term, and FOG_FRAG's per-channel
  // water extinction.
  const float AERIAL_GAIN = 7.0;
  const float BRIGHTNESS = ${BRIGHTNESS.toFixed(3)};
  const float DAY_GAIN = ${DAY_GAIN.toFixed(3)};
  // The fraction of the world's haze density the curtain is worth, and the
  // density it thins at when there is no weather to thin it. See the atmosphere
  // block in main().
  const float AERIAL_PUNCH = 0.35;
  const float BASE_HAZE = 0.0051;
  const vec3 WATER_EXT = vec3(0.115, 0.052, 0.035);

  void main() {
    // Up the sheet. Strong at the skyline and gone a little above it.
    //
    // The quad is the full world height (D = 88) and up = 0 is bedrock, so sea
    // level sits at 0.375 and a tall hill at ~0.6. The old ramp only started
    // fading at 0.22 and did not reach zero until the top of the world, which
    // left better than half strength standing over the skyline: that is what
    // made this read as a wall of light rather than as a horizon. It has to
    // reach zero and not merely go dim - additive blending makes a floor a
    // visible straight edge against the sky.
    float up = vUvL.y;
    float body = 1.0 - smoothstep(0.30, 0.72, up);

    // Slow vertical streaks, so the curtain moves without anything having to be
    // rebuilt. Two frequencies drifting at different rates, which is enough to
    // stop the eye locking onto either.
    //
    // Both are much wider and much shallower than they were. At 190 cycles
    // across a 416-block run a streak is 14 blocks wide, which at 350 units is
    // a ~20px bar: a picket fence of bright vertical lines standing off the
    // horizon, and the whole of the owner's "sunrays". What the effect wants
    // from this term is that the sheet not be flat, which 12% of variation on a
    // slow frequency gives it.
    float s1 = sin(vUvL.x * 61.0 + uTime * 0.35);
    float s2 = sin(vUvL.x * 23.0 - uTime * 0.21);
    float streak = 0.88 + 0.12 * (s1 * 0.45 + s2 * 0.55);

    // Distance fade. Under uNear the real portal blocks are streamed in and
    // drawing this as well would fight them.
    float dist = distance(vWorldPos, uCam);
    float near = smoothstep(uNear, uFar, dist);
    if (near <= 0.001) discard;

    // Atmosphere, which this used to ignore entirely.
    //
    // Terrain 350 units out is fogged to within 0.004% of the sky (see
    // AERIAL_GAIN: f = 1 - exp(-(density * gain * dist)^2), which is 0.99996 at
    // clear-weather density) while the curtain came through at full strength.
    // That is the whole of "it is passing through blocks": the light was not
    // in front of the geometry, it was the only thing in the frame the distance
    // had not taken anything away from.
    //
    // This is a transmittance rather than the mix toward haze the opaque
    // surfaces take, because an additive source adds what survives the trip and
    // nothing else - the in-scattered light is already in the sky drawn behind
    // it. AERIAL_PUNCH is the fraction of the world's density the curtain is
    // worth: a bright emitter carries further through haze than a lit surface
    // does, which is why a city is visible on a night the hills under it are
    // not, and at 1.0 this term deletes the object it is correcting.
    //
    // BASE_HAZE is the floor under that, and it is not optional: uFogDensity is
    // *zero* in clear weather - the world has no aerial haze at all on a clear
    // day - so a curtain that thinned only with the weather went straight back
    // to being a wall on exactly the days you can see furthest. Measured at 250
    // units on a clear night, 129 mean against 9.6 in snow. exp(-(0.0051*d)^2)
    // is 0.47 at the near edge of the fade, 0.20 at 250, 0.10 at 300 and 0.016
    // at 400, which is where it stops being something you can see.
    //
    // A max of the two rather than a sum, so thick weather still takes it
    // further down and clear weather does not double up.
    float ad = max(uFogDensity * AERIAL_GAIN * AERIAL_PUNCH, BASE_HAZE) * dist;
    float atten = exp(-ad * ad);

    // Water absorbs, and it absorbs far harder than air. Full extinction, not a
    // fraction of it: FOG_FRAG's green channel is 0.052 per unit, so the near
    // edge of the fade at 170 units is exp(-8.8) and the curtain is simply gone
    // from a dive. It should be. Nothing else in this game is visible through
    // 170 units of water either, and the curtain being the one thing that was
    // is the report this is answering.
    if (uUnderwater > 0.5) atten *= exp(-WATER_EXT.g * dist);

    // Fainter by day, full at night. Daylight is when the curtain is least use
    // as a landmark - there is a sun, a sky gradient and a lit horizon to steer
    // by - and when it costs the most, because it is competing with a bright
    // sky and has to be loud to be seen at all. On Pyre, which is permanently
    // dark and has no minimap, uNight leaves it at full strength.
    float lit = mix(DAY_GAIN, 1.0, uNight);

    vec3 col = mix(vec3(0.52, 0.04, 0.98), vec3(0.92, 0.26, 1.0), up * 0.6 + 0.2);
    gl_FragColor = vec4(col * body * streak * near * atten * lit * BRIGHTNESS, 1.0);
  }
`;

/**
 * The curtains over every divider on the map.
 *
 * Built from the same rule `Grid.isWall` is: the outermost ring of each sealed
 * face, four edges apiece. The two edges where two sealed faces sit back to
 * back get a curtain each, one column apart, and that is left alone rather than
 * de-duplicated - the world really does have two divider columns there, and
 * they read as one slightly stronger boundary, which is true.
 */
export class Dividers {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.material = new THREE.ShaderMaterial({
      // The last three are the *same uniform objects* the voxel material and
      // the sky write, taken by reference rather than copied: the atmosphere
      // the curtain is now attenuated by has to be the atmosphere the terrain
      // beside it is drawn in, and a second copy updated from a second place is
      // how those two drift apart. Nothing outside this file has to push them.
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uNear: { value: FADE_NEAR },
        uFar: { value: FADE_FAR },
        uNight: voxelUniforms.uNight,
        uFogDensity: voxelUniforms.uFogDensity,
        uUnderwater: voxelUniforms.uUnderwater,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    const runs = dividerRuns();
    this.mesh = new THREE.InstancedMesh(geo, this.material, runs.length * COPIES * COPIES);
    this.mesh.frustumCulled = false;      // one object spanning the whole map
    this.mesh.renderOrder = 6;            // after the opaque world, before the UI
    this.mesh.matrixAutoUpdate = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const YAXIS = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (const r of runs) {
      // A plane is born in the XY plane facing +Z. A run along map x needs no
      // turn; one along map y is the same sheet a quarter turn about up.
      q.setFromAxisAngle(YAXIS, r.alongX ? 0 : Math.PI / 2);
      scale.set(F, D, 1);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          pos.set(r.x + a * W, D * 0.5, r.y + b * W);
          m.compose(pos, q, scale);
          this.mesh.setMatrixAt(n++, m);
        }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.count = n;
    scene.add(this.mesh);
  }

  /**
   * One uniform a frame and nothing else. The camera position is needed because
   * the fade is a distance and a ShaderMaterial has no built-in for it that
   * survives instancing.
   */
  update(dt, camera) {
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uCam.value.copy(camera.position);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

/**
 * The centre line of every divider run, in world space.
 *
 * Sixteen of them: the four edges of each sealed face's ring. `x` and `y` are
 * the centre of the run on the map's axes and `alongX` says which way it lies.
 * A ring edge is F columns long and one column thick, and a column's centre is
 * at `+0.5`, which is why the thin axis carries the half and the long one does
 * not - the run spans the whole tile.
 */
export function dividerRuns() {
  const out = [];
  for (const f of SEALED) {
    const o = faceOrigin(f);
    const midLong = F * 0.5;
    for (let dir = 0; dir < 4; dir++) {
      if (dir === NORTH) out.push({ x: o.x + midLong, y: o.y + 0.5, alongX: true });
      else if (dir === SOUTH) out.push({ x: o.x + midLong, y: o.y + F - 0.5, alongX: true });
      else if (dir === WEST) out.push({ x: o.x + 0.5, y: o.y + midLong, alongX: false });
      else out.push({ x: o.x + F - 0.5, y: o.y + midLong, alongX: false });
    }
  }
  return out;
}
