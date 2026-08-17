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
 * The look: a violet sheet standing from the ground into the sky, brightest at
 * its base and along a few slow vertical streaks.
 *
 * It is deliberately NOT a picture of the swirl. The tile's spiral is a thing
 * you read at arm's length; at four hundred units a run of them is under a
 * pixel per block, so any detail in here is noise. What survives at that range
 * is colour, a vertical gradient and a soft edge, and that is all this draws.
 */
const FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uCam;
  uniform float uNear;
  uniform float uFar;
  varying vec2 vUvL;
  varying vec3 vWorldPos;

  void main() {
    // Up the sheet. Strong from the ground, thinning out toward the top so the
    // curtain does not end on a hard line at the top of the world. It has to
    // reach zero and not merely go dim: additive blending makes a 0.12 floor a
    // visible straight edge against the sky, which is the one thing that would
    // give away that this is a quad and not a shaft of light.
    float up = vUvL.y;
    float body = mix(1.0, 0.0, smoothstep(0.22, 1.0, up));

    // Slow vertical streaks, so the curtain moves without anything having to be
    // rebuilt. Two frequencies drifting at different rates, which is enough to
    // stop the eye locking onto either.
    float s1 = sin(vUvL.x * 190.0 + uTime * 0.35);
    float s2 = sin(vUvL.x * 61.0 - uTime * 0.21);
    float streak = 0.72 + 0.28 * (s1 * 0.45 + s2 * 0.55);

    // Distance fade. Under uNear the real portal blocks are streamed in and
    // drawing this as well would fight them.
    float dist = distance(vWorldPos, uCam);
    float near = smoothstep(uNear, uFar, dist);
    if (near <= 0.001) discard;

    vec3 col = mix(vec3(0.52, 0.04, 0.98), vec3(0.92, 0.26, 1.0), up * 0.6 + 0.2);
    gl_FragColor = vec4(col * body * streak * near * 1.15, 1.0);
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
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uNear: { value: FADE_NEAR },
        uFar: { value: FADE_FAR },
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
