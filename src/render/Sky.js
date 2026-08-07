// Sky dome, sun, moon, stars, aurora and the volumetric-ish cloud shell.
// Palette is art-directed on the CPU from the sun's elevation and handed to the
// dome shader, so every other system can read the same colours.

import * as THREE from 'three';
import { R_MAX } from '../world/Constants.js';
import { makeRng } from '../util/Noise.js';

/**
 * Radius of the shadowed region around the player. The geometric horizon on a
 * planet this size is ~13 units over flat ground, and ~42 for the tallest
 * terrain the generator can raise; 30 covers everything that reads as shadowed
 * on screen while being far tighter than the ±46 box it replaces.
 */
const SHADOW_DIST = 30;
/** Ceiling on that radius: the fixed extent this fitting replaced. */
const SHADOW_DIST_MAX = 46;
/** Extra depth behind the lit region so off-screen casters still reach it. */
const SHADOW_CASTER_MARGIN = 46;

const _sc = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();

const _refX = new THREE.Vector3(1, 0, 0);
const _refY = new THREE.Vector3(0, 1, 0);
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _zenith = new THREE.Vector3();

const SKY_KEYS = [
  // elevation, zenith, horizon, sun, fog, ambient, sunIntensity
  { e: -1.00, zen: 0x03050f, hor: 0x070a18, sun: 0x0a0e1e, fog: 0x070a16, amb: 0x0a1024, si: 0.00 },
  { e: -0.26, zen: 0x06091c, hor: 0x141a34, sun: 0x1c2140, fog: 0x11162c, amb: 0x121a34, si: 0.02 },
  { e: -0.10, zen: 0x1a2350, hor: 0x60406a, sun: 0xb05a48, fog: 0x453050, amb: 0x2a2c48, si: 0.10 },
  { e: -0.02, zen: 0x2c4278, hor: 0xd8764a, sun: 0xff9a4a, fog: 0x8a6a64, amb: 0x4a4258, si: 0.45 },
  { e: 0.06, zen: 0x3f68a8, hor: 0xf2a468, sun: 0xffc27a, fog: 0xbb9a84, amb: 0x6a6270, si: 0.95 },
  { e: 0.20, zen: 0x3d78c8, hor: 0xa8c2e6, sun: 0xfff0d0, fog: 0xc3d3e8, amb: 0x8fa4c0, si: 1.30 },
  { e: 0.55, zen: 0x2f6fd0, hor: 0x9dc4ee, sun: 0xfffaf0, fog: 0xc8dcf2, amb: 0x9db6d4, si: 1.55 },
  { e: 1.00, zen: 0x2662c8, hor: 0x96c0ee, sun: 0xffffff, fog: 0xc4d9f2, amb: 0xa2bada, si: 1.62 },
];

function lerpKeys(e) {
  let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (e >= SKY_KEYS[i].e && e <= SKY_KEYS[i + 1].e) { a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break; }
  }
  const t = a === b ? 0 : THREE.MathUtils.clamp((e - a.e) / (b.e - a.e), 0, 1);
  const mix = (ka, kb) => new THREE.Color(ka).lerp(new THREE.Color(kb), t);
  return {
    zenith: mix(a.zen, b.zen),
    horizon: mix(a.hor, b.hor),
    sun: mix(a.sun, b.sun),
    fog: mix(a.fog, b.fog),
    ambient: mix(a.amb, b.amb),
    sunIntensity: THREE.MathUtils.lerp(a.si, b.si, t),
  };
}

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mvp = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = mvp.xyww;
}
`;

const DOME_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uUp;
uniform float uNight;
uniform float uTime;

// cheap hash noise for band dithering
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float h = dot(d, uUp);
  float t = clamp(h * 0.5 + 0.5, 0.0, 1.0);

  // gradient with a tightened horizon band
  float g = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, g);
  // below the horizon fades toward a deep ground haze
  col = mix(col * 0.55, col, smoothstep(-0.25, 0.02, h));

  float sd = max(dot(d, uSunDir), 0.0);
  // mie forward scattering halo
  col += uSunColor * pow(sd, 8.0) * 0.35;
  col += uSunColor * pow(sd, 900.0) * 6.0;
  // horizon glow near the sun's azimuth
  float horizonGlow = pow(1.0 - abs(h), 6.0) * pow(sd, 2.0);
  col += uSunColor * horizonGlow * 0.5;

  // subtle milky-way band at night
  if (uNight > 0.01) {
    float band = exp(-pow((dot(d, normalize(vec3(0.3, 0.85, -0.42))) ) * 3.4, 2.0));
    col += vec3(0.16, 0.17, 0.26) * band * uNight * 0.5;
  }

  col += (hash(d * 512.0) - 0.5) * 0.006;
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
varying vec3 vNormalW;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uCenter;
uniform vec3 uCamPos;
uniform float uCoverage;
uniform float uOpacity;

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)), dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
                 mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
             mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
                 mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z) * 0.5 + 0.5;
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 dir = normalize(vWorld - uCenter);
  vec3 p = dir * 9.0;
  vec3 drift = vec3(uTime * 0.012, uTime * 0.006, -uTime * 0.009);
  // large-scale weather mask carves open sky between cloud fields
  float mask = smoothstep(0.42, 0.72, fbm(p * 0.34 + drift * 0.35));
  float base = fbm(p + drift);
  float detail = fbm(p * 3.4 - drift * 1.7);
  float d = (base * 0.70 + detail * 0.30) * mask;
  float a = smoothstep(uCoverage, uCoverage + 0.14, d);
  if (a < 0.004) discard;

  // fake lighting: sample the density field toward the sun for self-shadowing
  float lit = fbm(p + normalize(uSunDir) * 0.55 + drift);
  float shade = clamp((d - lit) * 2.2 + 0.62, 0.25, 1.0);
  float rim = pow(clamp(dot(normalize(uSunDir), dir), 0.0, 1.0), 6.0);

  vec3 col = mix(uZenith * 0.85, vec3(1.0), 0.72) * shade;
  col += uSunColor * rim * 0.55;
  col = mix(col, uSunColor, 0.18);

  float distFade = smoothstep(2.0, 40.0, length(vWorld - uCamPos));
  gl_FragColor = vec4(col, a * uOpacity * distFade);
}
`;

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.center = new THREE.Vector3(0, 0, 0);
    this.time = 0.4;               // wall-clock day fraction, for the HUD dial
    this.orbit = 0.4;              // sun's phase around the planet
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.palette = lerpKeys(1);
    this.up = new THREE.Vector3(0, 1, 0);

    // --- dome ---
    this.domeUniforms = {
      uZenith: { value: new THREE.Color(0x2662c8) },
      uHorizon: { value: new THREE.Color(0x96c0ee) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };
    const domeGeo = new THREE.SphereGeometry(1, 48, 32);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    // --- stars ---
    this.stars = this._buildStars();
    scene.add(this.stars);

    // --- sun & moon billboards ---
    this.sunSprite = this._buildDisc(this._sunTexture(), 1);
    this.moonSprite = this._buildDisc(this._moonTexture(), 1);
    scene.add(this.sunSprite, this.moonSprite);

    // --- clouds ---
    this.cloudUniforms = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xffffff) },
      uZenith: { value: new THREE.Color(0x2662c8) },
      uCenter: { value: this.center.clone() },
      uCamPos: { value: new THREE.Vector3() },
      uCoverage: { value: 0.30 },
      uOpacity: { value: 0.88 },
    };
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: this.cloudUniforms,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.clouds = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(R_MAX + 30 + i * 9, 96, 64), cloudMat);
      m.position.copy(this.center);
      m.renderOrder = 20 + i;
      this.clouds.add(m);
    }
    scene.add(this.clouds);

    // --- lights ---
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sunLight.castShadow = true;
    const s = this.sunLight.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.near = 1;
    s.camera.far = 190;
    s.camera.left = -46; s.camera.right = 46; s.camera.top = 46; s.camera.bottom = -46;
    s.bias = -0.0009;
    s.normalBias = 0.045;
    s.radius = 2.2;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x9fb6e8, 0.0);
    scene.add(this.moonLight, this.moonLight.target);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.0);
    scene.add(this.ambient);

    // Entities (player, drops, debris) don't get the voxel shader's skylight
    // term, so they get their own hemisphere fill on layer 1.
    this.entityFill = new THREE.HemisphereLight(0xbcd6f5, 0x6a5a44, 1.0);
    this.entityFill.layers.set(1);
    scene.add(this.entityFill);
  }

  _buildStars() {
    const N = 4200;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const siz = new Float32Array(N);
    const rng = makeRng(4242);
    const palette = [
      [1.0, 0.96, 0.92], [0.86, 0.9, 1.0], [1.0, 0.88, 0.74], [0.78, 0.86, 1.0], [1.0, 1.0, 1.0],
    ];
    for (let i = 0; i < N; i++) {
      let x, y, z, l;
      do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-4);
      l = Math.sqrt(l);
      const R = 900;
      pos[i * 3] = (x / l) * R; pos[i * 3 + 1] = (y / l) * R; pos[i * 3 + 2] = (z / l) * R;
      const c = palette[(rng() * palette.length) | 0];
      const b = 0.35 + rng() * 0.65;
      col[i * 3] = c[0] * b; col[i * 3 + 1] = c[1] * b; col[i * 3 + 2] = c[2] * b;
      siz[i] = (rng() < 0.03 ? 5.5 : 1.4 + rng() * 2.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(siz, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float size;
        varying vec3 vCol;
        varying float vTw;
        uniform float uTime;
        uniform float uPixelRatio;
        void main() {
          vCol = color;
          vTw = 0.7 + 0.3 * sin(uTime * 2.1 + position.x * 0.07 + position.y * 0.05);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w * 0.999999;
          gl_PointSize = size * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        varying float vTw;
        uniform float uOpacity;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.06, d);
          a *= a;
          gl_FragColor = vec4(vCol * vTw, a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = -999;
    pts.frustumCulled = false;
    return pts;
  }

  _sunTexture() {
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0.00, 'rgba(255,255,250,1)');
    grad.addColorStop(0.16, 'rgba(255,248,224,1)');
    grad.addColorStop(0.24, 'rgba(255,226,160,0.85)');
    grad.addColorStop(0.42, 'rgba(255,190,110,0.28)');
    grad.addColorStop(0.70, 'rgba(255,170,90,0.07)');
    grad.addColorStop(1.00, 'rgba(255,160,80,0)');
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _moonTexture() {
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.clearRect(0, 0, S, S);
    // glow
    const glow = g.createRadialGradient(S / 2, S / 2, S * 0.16, S / 2, S / 2, S / 2);
    glow.addColorStop(0, 'rgba(190,206,240,0.45)');
    glow.addColorStop(1, 'rgba(190,206,240,0)');
    g.fillStyle = glow; g.fillRect(0, 0, S, S);
    // disc
    g.save();
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.19, 0, Math.PI * 2); g.clip();
    const disc = g.createRadialGradient(S * 0.44, S * 0.43, 0, S / 2, S / 2, S * 0.2);
    disc.addColorStop(0, '#f4f6ff');
    disc.addColorStop(1, '#c8cfe4');
    g.fillStyle = disc; g.fillRect(0, 0, S, S);
    const rng = makeRng(77);
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2, r = rng() * S * 0.17;
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
      const rad = 2 + rng() * 9;
      g.fillStyle = `rgba(150,158,180,${0.16 + rng() * 0.24})`;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildDisc(tex, scale) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending, fog: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.renderOrder = -998;
    m.frustumCulled = false;
    m.scale.setScalar(scale);
    return m;
  }

  /**
   * Aim the sun's shadow camera at just the region that can actually be seen,
   * instead of a fixed ±46 box centred on the player.
   *
   * The old box was sized for a world far larger than this one: on a planet of
   * radius ~41 the horizon is barely 12 units away, so most of that volume was
   * empty, and everything inside it was drawn into the shadow map whether it
   * could be seen or not.
   *
   * Two details make this safe to shrink:
   *
   * 1. The region is a sphere centred on the *player*, not on the view frustum.
   *    Fitting the frustum is the textbook answer and it is wrong here: a 75°
   *    fov frustum is far wider than it is long, so its bounding sphere came
   *    out at radius 91 — twice the box it was meant to replace, and shadows
   *    got blurrier, not sharper. A player-centred sphere is tighter, and being
   *    independent of where you look it cannot shimmer when you turn.
   * 2. The centre is snapped to whole shadow-map texels. Without this the map
   *    would be re-rasterised on a slightly different sub-texel grid every
   *    frame and every shadow edge would crawl as you walk — the exact shimmer
   *    that makes naive shadow fitting look worse than a fixed box.
   */
  _fitShadow(camera, target) {
    const s = this.sunLight.shadow;
    // Low sun means long shadows: a 10-unit tree throws a 57-unit shadow at 10
    // degrees. Widen the region as the sun drops so those still reach the map,
    // clamped to the old fixed size — so this is never worse than what it
    // replaces at any sun angle, and much tighter for most of the day.
    const sinElev = Math.max(0.18, Math.abs(this.sunDir.dot(this.up)));
    const radius = Math.min(SHADOW_DIST_MAX, SHADOW_DIST / Math.max(sinElev, 0.62));
    _sc.copy(target);

    // --- light-space basis (zAxis points back toward the sun) ---
    _lz.copy(this.sunDir).normalize();
    _lx.set(0, 1, 0);
    if (Math.abs(_lz.y) > 0.94) _lx.set(1, 0, 0);
    _lx.crossVectors(_lx, _lz).normalize();
    _ly.crossVectors(_lz, _lx).normalize();

    // --- snap the centre to the texel grid ---
    const texel = (2 * radius) / s.mapSize.x;
    const px = Math.round(_sc.dot(_lx) / texel) * texel;
    const py = Math.round(_sc.dot(_ly) / texel) * texel;
    const pz = _sc.dot(_lz);
    _sc.copy(_lx).multiplyScalar(px)
      .addScaledVector(_ly, py)
      .addScaledVector(_lz, pz);

    // Pull back far enough that casters between the sun and the region — a
    // hillside or a tree just outside it — still make it into the map.
    const back = radius + SHADOW_CASTER_MARGIN;
    this.sunLight.position.copy(_sc).addScaledVector(_lz, back);
    this.sunLight.target.position.copy(_sc);
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.updateMatrixWorld();

    const cam = s.camera;
    if (cam.right !== radius || cam.far !== back + radius) {
      cam.left = -radius; cam.right = radius;
      cam.top = radius; cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = back + radius;
      cam.updateProjectionMatrix();
    }
  }

  /** @param {THREE.Camera} camera @param {THREE.Vector3} playerUp */
  update(dt, camera, playerUp, focus) {
    // sunDir is set by setSolarTime from the wall clock
    this.up.copy(playerUp);
    const elev = this.sunDir.dot(playerUp);
    const p = lerpKeys(elev);
    this.palette = p;
    this.elevation = elev;

    const night = THREE.MathUtils.clamp(-elev * 3.2 + 0.35, 0, 1);
    this.night = night;

    // dome
    this.domeUniforms.uZenith.value.copy(p.zenith);
    this.domeUniforms.uHorizon.value.copy(p.horizon);
    this.domeUniforms.uSunColor.value.copy(p.sun);
    this.domeUniforms.uSunDir.value.copy(this.sunDir);
    this.domeUniforms.uUp.value.copy(playerUp);
    this.domeUniforms.uNight.value = night;
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(1);

    // stars
    this.stars.material.uniforms.uOpacity.value = night;
    this.stars.material.uniforms.uTime.value += dt;
    this.stars.position.copy(camera.position);
    this.stars.rotation.y += dt * 0.0016;
    this.stars.visible = night > 0.01;

    // sun & moon discs
    const place = (m, dir, size, opacity) => {
      m.position.copy(camera.position).addScaledVector(dir, 700);
      m.lookAt(camera.position);
      m.scale.setScalar(size);
      m.material.opacity = opacity;
      m.visible = opacity > 0.01;
    };
    place(this.sunSprite, this.sunDir, 210, THREE.MathUtils.clamp(elev * 6 + 1.0, 0, 1));
    place(this.moonSprite, this.moonDir, 150, THREE.MathUtils.clamp(-elev * 6 + 1.0, 0, 1) * 0.95);

    // clouds
    this.cloudUniforms.uTime.value += dt;
    this.cloudUniforms.uSunDir.value.copy(this.sunDir);
    this.cloudUniforms.uSunColor.value.copy(p.sun);
    this.cloudUniforms.uZenith.value.copy(p.zenith);
    this.cloudUniforms.uCamPos.value.copy(camera.position);

    // lights
    const target = focus || camera.position;
    this.sunLight.color.copy(p.sun);
    this.sunLight.intensity = p.sunIntensity;
    this.sunLight.visible = p.sunIntensity > 0.01;
    this._fitShadow(camera, target);

    this.moonLight.intensity = night * 0.16;
    this.moonLight.visible = night > 0.02;
    this.moonLight.position.copy(target).addScaledVector(this.moonDir, 90);
    this.moonLight.target.position.copy(target);
    this.moonLight.target.updateMatrixWorld();

    this.ambient.color.copy(p.ambient);
    this.ambient.intensity = 0.16 + night * 0.04;

    this.entityFill.color.copy(p.zenith).lerp(p.horizon, 0.5).lerp(new THREE.Color(1, 1, 1), 0.35);
    this.entityFill.groundColor.copy(p.fog).multiplyScalar(0.5);
    this.entityFill.intensity = 0.45 + p.sunIntensity * 0.55;
  }

  setPixelRatio(r) { this.stars.material.uniforms.uPixelRatio.value = r; }

  /**
   * Drive the sun straight from a wall-clock day fraction.
   *
   * This used to solve for a phase on a single global orbit, but on a sphere
   * that orbit simply cannot reach a given elevation from every location — near
   * the orbital poles the solve clamps or bails out entirely, which is why the
   * sky could be dark at 14:43. Building the sun direction in the player's own
   * tangent frame guarantees the clock matches everywhere: sunrise due east at
   * 06:00, overhead at noon, sunset due west at 18:00.
   *
   * @param {number} dayFraction 0 = midnight, 0.5 = noon
   */
  setSolarTime(up, dayFraction) {
    const f = ((dayFraction % 1) + 1) % 1;
    this.time = f;

    const th = (f - 0.25) * Math.PI * 2;      // 0 at sunrise, π/2 at noon
    // a compass frame that varies smoothly as the player walks
    const ref = Math.abs(up.y) > 0.95 ? _refX : _refY;
    _east.crossVectors(ref, up).normalize();
    _north.crossVectors(up, _east).normalize();
    // tilt the arc off the zenith so the sun tracks across the sky rather than
    // straight overhead
    const tilt = 0.36;
    _zenith.copy(up).multiplyScalar(Math.cos(tilt)).addScaledVector(_north, Math.sin(tilt)).normalize();

    this.sunDir.copy(_east).multiplyScalar(Math.cos(th)).addScaledVector(_zenith, Math.sin(th)).normalize();
    this.moonDir.copy(this.sunDir).negate();
  }

  /** Real local time of day as a 0..1 fraction. */
  static clockFraction(date = new Date()) {
    return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) / 86400;
  }
}
