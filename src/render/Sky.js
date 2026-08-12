// Sky dome, sun, moon, stars, aurora and the volumetric-ish cloud shell.
// Palette is art-directed on the CPU from the sun's elevation and handed to the
// dome shader, so every other system can read the same colours.

import * as THREE from 'three';
import { R_MAX } from '../world/Constants.js';
import { makeRng } from '../util/Noise.js';
import { voxelUniforms } from './VoxelMaterial.js';

/**
 * Radius of the shadowed region around the player. The geometric horizon on a
 * planet this size is ~13 units over flat ground, and ~42 for the tallest
 * terrain the generator can raise; 30 covers everything that reads as shadowed
 * on screen while being far tighter than the ±46 box it replaces.
 */
// How far out the moon billboard is anchored. It has to stay inside the
// camera's far plane or it is clipped and never drawn — which is exactly what
// used to happen when this was 700 against a far plane of 420.
//
// Both ends of that constraint now move with the planet, so this does too: the
// far plane is 3.2x the outer radius, and anchoring the moon at 2.75x keeps it
// comfortably inside while staying far enough out to read as sky rather than as
// an object hanging over the terrain.
const DISC_DIST = Math.round(R_MAX * 2.75);

const SHADOW_DIST = 30;
/** Ceiling on that radius: the fixed extent this fitting replaced. */
const SHADOW_DIST_MAX = 46;
/** Extra depth behind the lit region so off-screen casters still reach it. */
const SHADOW_CASTER_MARGIN = 46;

const _sc = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _lz = new THREE.Vector3();

const _white = new THREE.Color(1, 1, 1);

/**
 * The colour of a clear night, as light rather than as sky.
 *
 * Exported because two systems have to agree on it exactly: the entity fill
 * below, and the terrain's own sky ambient in `main._updateSharedUniforms`.
 * They light different halves of the same picture and a night that was blue on
 * the animals and neutral on the grass would be worse than either.
 *
 * In the working (linear) space, so it is written as floats — a hex literal
 * would be decoded from sRGB, and this is a radiance, not a swatch. Its
 * luminance is ~0.33, deliberately close to the ~0.34 white it displaces: it is
 * a hue rotation first and a dimming second. See MOON_FILL's fuller note in
 * main.js for what it fixes.
 */
export const MOON_FILL = new THREE.Color(0.22, 0.32, 0.80);

// Only used at the axis itself, where any direction is as good as any other.
const _refX = new THREE.Vector3(1, 0, 0);
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _zenith = new THREE.Vector3();

/**
 * How degenerate the frame has to be before an arbitrary one is substituted, as
 * |Y × up|.
 *
 * This is not a latitude anyone stands at: 1e-9 of |Y × up| is 2.8e-7 blocks
 * from the axis at R_SEA 282, i.e. the pole column itself and nothing else. It
 * exists so `east` is never the zero vector — `solarDirection` multiplies it,
 * and a zero sun direction is a NaN horizon, not a dark one. Everywhere a
 * player can actually be, the frame below is the single continuous one.
 */
export const POLAR_EPS = 1e-9;

/**
 * The local compass frame standing at `up`: which way is east, which way is
 * north. Writes into the two vectors given and returns how much of a frame it
 * is (see below).
 *
 * This is the planet's *only* definition of north, and it is not decoration —
 * `setSolarTime` builds the sun's entire arc out of the `east` this hands back,
 * so the sun rises due east and sets due west by construction rather than by
 * agreement. Anything that wants to show a bearing has to come through here.
 * Two copies of these three lines is precisely how a compass ends up pointing
 * somewhere the sky contradicts, and on a planet with no landmarks the sun is
 * the only thing a player can check it against.
 *
 * North is the world +Y axis dropped into the tangent plane. That axis is not
 * arbitrary either: `WorldGen.climate` bands temperature on `Math.abs(dy)` and
 * nothing else, so the snowfields genuinely are at ±Y and "north is where it
 * gets cold" is true on this planet.
 *
 * The reference axis is Y and only Y, at every latitude. It used to swap to X
 * inside the polar cap to keep the cross product away from zero, and that swap
 * was the whole reason the compass had a dead zone: at the swap latitude,
 * standing over ±X, east flipped a full 180° for one step sideways, measured
 * here as a 180.000° jump between adjacent samples 0.02° of latitude apart, so
 * the strip had to be dark for 19° of latitude either side of it and dimmed to
 * 31° — about 5% of the planet blind and 14% murky, all of it snowfield. Y × up
 * alone is smooth everywhere except *at* the axis, where the only defence
 * needed is POLAR_EPS above. Walked over 1500 great circles at a block per
 * sample, the worst step between neighbours is 3.4° anywhere the compass is
 * fully lit and 6.8° anywhere it is drawn at all, against 180.000° before.
 *
 * @returns {number} |Y × up| — the sine of the angle down from the pole. 1 at
 *   the equator, 0 at either pole. It is a measure of how much of an answer
 *   this is: at 0 there is no north to point at, and approaching zero the
 *   bearing stays continuous but turns faster and faster for a fixed walking
 *   speed (it goes as 1/this — meridians converging). So a caller drawing a
 *   bearing still reads this, not to dodge a discontinuity that no longer
 *   exists, but to stop drawing a strip that has begun to skate. See
 *   POLAR_HIDE in UI.js for where that lands: 3 blocks from the pole.
 */
export function compassFrame(up, east, north) {
  const polar = Math.hypot(up.x, up.z);
  // Y × up in closed form. Below POLAR_EPS there is no direction to give, so
  // any orthonormal pair will do; the returned 0 tells the caller not to draw.
  if (polar > POLAR_EPS) east.set(up.z, 0, -up.x).divideScalar(polar);
  else east.crossVectors(_refX, up).normalize();
  north.crossVectors(up, east).normalize();
  return polar;
}

/**
 * How far the sun's daily arc is tilted off the local zenith, in radians.
 *
 * Zero would send it straight through the point overhead, which is a sun with no
 * arc at all: it would rise due east, pass exactly through the zenith and set due
 * west, and noon would have no direction. 0.36 (~20.6°) leans the whole circle
 * toward north so the sun crosses the southern sky, tops out at an elevation of
 * cos(0.36) = 0.936 rather than 1, and — the part that matters on screen — casts
 * a shadow at noon that points somewhere.
 */
const SOLAR_TILT = 0.36;

/**
 * The sun's world direction, for a player standing at `up`, at `dayFraction`.
 *
 * Split out of `setSolarTime` and exported so it can be checked without a WebGL
 * context or a `Sky` instance (which needs a canvas for the moon texture). It is
 * pure: same inputs, same output, no state touched.
 *
 * @param {THREE.Vector3} up  the player's radial up, need not be unit length
 * @param {number} dayFraction 0 = midnight, 0.25 = sunrise, 0.5 = noon
 * @param {THREE.Vector3} out written and returned
 */
export function solarDirection(up, dayFraction, out) {
  const f = ((dayFraction % 1) + 1) % 1;
  const th = (f - 0.25) * Math.PI * 2;      // 0 at sunrise, π/2 at noon
  // a compass frame that varies smoothly as the player walks
  compassFrame(up, _east, _north);
  _zenith.copy(up).normalize().multiplyScalar(Math.cos(SOLAR_TILT))
    .addScaledVector(_north, Math.sin(SOLAR_TILT)).normalize();
  return out.copy(_east).multiplyScalar(Math.cos(th))
    .addScaledVector(_zenith, Math.sin(th)).normalize();
}

// Exported for the offline palette checks (monotonicity, gamut) — nothing in
// the game reads either of these from outside this file.
export const SKY_KEYS = [
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

export function lerpKeys(e) {
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

  // How far *below* the tangent plane the sky still reaches.
  //
  // On a planet this small the horizon is not at eye level: it dips by
  // acos(R / (R + eye)) ~ sqrt(2 * eye / R) radians, which at R_SEA 282 and an
  // eye 1.7 units up is 0.11 — and further still looking down from a hilltop.
  // Everything above h = -HORIZON_DIP is therefore sky you can genuinely see,
  // and it is the single most looked-at band in the game: the curved rim the
  // whole planet reads as.
  //
  // The darkening this replaces started at h = 0.02 and was down to 0.70 of the
  // sky colour by h = -0.12, so it painted a dull grey band across exactly that
  // rim — a ground haze applied to a part of the dome the ground never covers.
  // Pushed below the dip it only affects the deep underside of the dome, which
  // is behind the planet and only ever seen through a hole in the terrain.
  const float HORIZON_DIP = 0.16;
  col = mix(col * 0.62, col, smoothstep(-0.55, -HORIZON_DIP, h));

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
// The light falling on the deck, as radiance rather than as a swatch. See
// CLOUD_ALBEDO below for why these three exist at all.
uniform vec3 uSunLight;   // sun colour * sun intensity, unattenuated by weather
uniform vec3 uSkyLight;   // the sky's own fill on a cloud
uniform vec3 uMoonLight;  // what is left of it after dark

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
  // Large-scale weather mask, carving open sky between cloud fields — and it
  // has to widen with the weather. Held at a fixed threshold it zeroed most of
  // the sky whatever the forecast said, so uCoverage could only thin the clouds
  // inside fields that were already there: an overcast sky came out around four
  // fifths blue with a few wisps in it, and a storm looked much the same. The
  // labels promised weather the sky never delivered.
  //
  // Note uCoverage runs backwards — it is really clearness, high on a clear
  // day — so this flips it first.
  float cloudy = clamp(1.0 - uCoverage, 0.0, 1.0);
  float m0 = mix(0.62, 0.08, cloudy);
  float mask = smoothstep(m0, m0 + 0.30, fbm(p * 0.34 + drift * 0.35));
  float base = fbm(p + drift);
  float detail = fbm(p * 3.4 - drift * 1.7);
  float d = (base * 0.70 + detail * 0.30) * mask;
  float a = smoothstep(uCoverage, uCoverage + 0.14, d);
  if (a < 0.004) discard;

  // fake lighting: sample the density field toward the sun for self-shadowing
  float lit = fbm(p + normalize(uSunDir) * 0.55 + drift);
  float shade = clamp((d - lit) * 2.2 + 0.62, 0.25, 1.0);
  float rim = pow(clamp(dot(normalize(uSunDir), dir), 0.0, 1.0), 6.0);

  // --- how thick the deck is ------------------------------------------------
  //
  // Fair-weather cumulus are a thin scatter you can see daylight past; an
  // overcast deck is a kilometre of water and its *underside* — the only side a
  // player ever sees — is dark because almost nothing gets through it. That is
  // the one physical fact this whole block is built on, and it is why bad
  // weather can make the sky darker than a clear one instead of brighter.
  //
  // Read off uCoverage because that is the only weather signal this shader is
  // given (main publishes uCoverage/uOpacity and nothing else). The window is
  // 0.52..0.99 of cloudy rather than the 0.35..0.95 it replaces, because the
  // old one landed overcast at 0.91 and storm at 1.00: a 9% difference at the
  // very top of the ACES shoulder, i.e. none. The two weathers used to come out
  // pixel-identical in the sky and the recon measured them so, 212.8 against
  // 212.1 luma.
  //
  // The new window is placed against the five states' coverages (0.62 clear,
  // 0.40 fair, 0.16 overcast, 0.08 rain, 0.02 storm — see STATES in Weather.js)
  // so that: clear and fair land at 0.00 and 0.08, i.e. the fair-weather cumulus
  // that were already right are left alone; and overcast/rain/storm land at
  // 0.83/0.94/1.00, which through the gates below come out at 148/108/70 luma
  // against a clear noon sky's 158. That is a readable ladder where there was
  // one flat beige value, and every rung of it is at or below the clear sky
  // instead of above it.
  float thick = smoothstep(0.52, 0.99, cloudy);

  // --- albedo x illumination ------------------------------------------------
  //
  // This used to be mix(uZenith * 0.85, vec3(1.0), 0.72) * shade * bright,
  // then washed 18% toward uSunColor, and every one of those terms was a colour
  // rather than a light:
  //
  //  - the hard-coded vec3(1.0) at 72% weight is a daylight white that no hour
  //    of the day could turn off, so the deck sat near 0.7 linear at MIDNIGHT
  //    and measured luma 126 against a night sky at 0.5. Clouds lit from above
  //    by a sun that is not there.
  //  - nothing in it was multiplied by the sun's intensity, so an overcast noon
  //    tone-mapped to luma 213 against a clear blue sky's 156. Switching cloud
  //    cover ON made the sky brighter.
  //  - the flat 18% lerp toward uSunColor was the sepia. It is a constant warm
  //    wash added irrespective of density, so it lifted the shaded parts hardest
  //    and turned the whole thing beige — and at altitude, where the deck fills
  //    the frame, into a brown-grey smear with no contrast left in it.
  //
  // A cloud is a near-white diffuser. So: pick one albedo and multiply it by
  // what is actually shining on it. Then every hour, every weather and the
  // dawn ramp come out of the palette for free, and there is no term left that
  // can glow on its own.
  // 0.46 rather than the ~0.9 a real cloud reflects, because uSunLight carries
  // the palette's sunIntensity (1.62 at noon) which is a *terrain* light level,
  // tuned against terrain albedos around 0.3. Solved for rather than picked: it
  // is the value at which a fair-weather noon cumulus lands back on the 165 luma
  // it measured before this rewrite, which is the look the recon checked and
  // passed. Everything else in this block is then free to be physical.
  const float CLOUD_ALBEDO = 0.46;
  // Direct sun goes first as the deck thickens — a beam is extinguished long
  // before the diffuse sky is.
  vec3 illum = uSunLight * shade * mix(1.0, 0.03, thick);
  // ...and the sky fill is what is left, plus the moon so a night deck is a dim
  // silhouette rather than a hole. Both are trimmed under a thick deck for the
  // same reason.
  illum += (uSkyLight * 0.55 + uMoonLight) * mix(1.0, 0.26, thick);
  // A consequence worth stating rather than papering over: an OVERCAST midnight
  // now measures luma 0.1 in the sky — the deck is thick, the moon is above it
  // and the stars are behind it, so there is nothing left. That is the right
  // answer and it is in keeping with this game's clear night sky, which the
  // recon measured at 0.5. It was tried as a bug and the fix rejected: giving
  // the moon a gentler gate than the sky fill (0.45 against 0.26) moved the deck
  // from 1.5 to 2.4 of 255, which is more code for a difference no one can see,
  // and lifting the moon term enough to matter (x6.4) would have taken the CLEAR
  // night clouds with it — the exact defect this block was written to fix.
  vec3 col = illum * CLOUD_ALBEDO;
  // Silver lining. Sun-driven, so unlike the old flat wash it is gone at night
  // and gone under a storm.
  col += uSunLight * rim * 0.30 * (1.0 - thick);

  float distFade = smoothstep(2.0, 40.0, length(vWorld - uCamPos));
  gl_FragColor = vec4(col, a * uOpacity * distFade);
}
`;

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene;
    this.center = new THREE.Vector3(0, 0, 0);
    // The day fraction `setSolarTime` was last given. `orbit`, a second copy of
    // it labelled "sun's phase around the planet", used to sit beside it and was
    // deleted: it was set once here and never written or read again, so it named
    // a second notion of solar time that did not exist. There is one, and
    // `solarDirection` takes it as an argument.
    this.time = 0.4;
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

    // --- moon billboard ---
    // The sun is drawn by the dome shader (the pow(sd, 900.0) term), so it
    // needs no billboard; there used to be one here and it was clipped away
    // unseen every frame. The moon has no analytic counterpart, so this is the
    // only moon there is.
    this.moonSprite = this._buildDisc(this._moonTexture(), 1);
    scene.add(this.moonSprite);

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
      uSunLight: { value: new THREE.Color(1, 1, 1) },
      uSkyLight: { value: new THREE.Color(0, 0, 0) },
      uMoonLight: { value: new THREE.Color(0, 0, 0) },
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

    // Entities — animals, drops, debris — get no skylight, because skylight in
    // this world is baked into the chunk vertices and an animal is not a chunk.
    // Without a fill of their own they are lit by the sun and a flat ambient
    // and nothing else, so the moment the sun is off them they fall to that
    // ambient alone: an animal walking under a tree turned into a black cut-out
    // while the grass it was standing on stayed bright.
    //
    // This used to be a hemisphere light on layer 1, which looks like it says
    // "light entities, not terrain" and does not. three tests a light's layers
    // against the CAMERA, not against each object — object layers cannot select
    // lights at all. The camera sits on layer 0, so this light was excluded
    // from every render ever made and lit precisely nothing. Two rounds of
    // tuning its intensity, and a change putting mobs on layer 1 to "reach"
    // it, were all adjusting a light that was switched off.
    //
    // So it lights everything now. Terrain barely notices — it already carries
    // its own baked sky term and is dominated by it — while the entities that
    // had nothing finally have a sky over them. See _fillEntities for the
    // brightness, which has to stay low at night or a husk in the dark becomes
    // the brightest thing on screen.
    this.entityFill = new THREE.HemisphereLight(0xbcd6f5, 0x6a5a44, 1.0);
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
      // Stars have to be *tested* against the world even though they never
      // write depth. The vertex shader already pins them to the far plane so
      // they lose to everything, but with the test off that did nothing: a
      // transparent object draws after the whole opaque pass, so 4200 additive
      // points were painted straight over the terrain. At night the ground was
      // full of white specks that slid around as you turned — stars, indoors.
      // The sky dome writes no depth and does not test either, so turning this
      // on costs nothing above the horizon.
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = -999;
    pts.frustumCulled = false;
    return pts;
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
      // Same reasoning as the stars: additive and transparent means these draw
      // after the opaque pass, so without a depth test the sun burns through
      // whatever is between you and it. They sit 700 out, well inside the far
      // plane, so testing does not clip them out of the sky.
      map: tex, transparent: true, depthWrite: false, depthTest: true,
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
  /**
   * @param {number} shelter 0 with a roof overhead, 1 under open sky. Only the
   *   entity fill uses it — see below for why a light needs to know.
   */
  update(dt, camera, playerUp, focus, shelter = 1) {
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

    // The dome's own two colours, handed to the voxel material unmodified.
    //
    // `main._updateSharedUniforms` already publishes derivatives of these — a
    // whitened `uSkyColor` to light shaded faces with, a hue-preserving
    // `uSkyReflect` for water — but both are *levels*, art-directed for one job
    // each, and neither can answer "what colour is the sky in this direction".
    // Aerial perspective and a reflected sky both need the raw pair, because
    // what they are imitating is literally the dome above: distant terrain fades
    // into the sky behind it, and a lake shows you the sky over it.
    //
    // Published from here rather than from main because this is the only place
    // that holds the palette *before* anyone has an opinion about it, so the
    // three surfaces cannot drift. Deliberately different uniform names from
    // everything main writes, so the two never race — main runs after this every
    // frame and touches a disjoint set.
    voxelUniforms.uSkyHorizon.value.copy(p.horizon);
    voxelUniforms.uSkyZenith.value.copy(p.zenith);

    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(1);

    // stars
    this.stars.material.uniforms.uOpacity.value = night;
    this.stars.material.uniforms.uTime.value += dt;
    this.stars.position.copy(camera.position);
    this.stars.rotation.y += dt * 0.0016;
    this.stars.visible = night > 0.01;

    // Sun & moon discs.
    //
    // These sat 700 out against a 420 far plane, so every frame they were
    // built, oriented, scaled and then clipped away without ever drawing a
    // pixel. The sun went unnoticed because the dome shader paints its own
    // disc analytically; the moon had no such stand-in, so the night sky
    // simply never had one. Anchor them inside the frustum and scale by the
    // same factor, which leaves their angular size exactly as tuned.
    const place = (m, dir, size, opacity) => {
      m.position.copy(camera.position).addScaledVector(dir, DISC_DIST);
      m.lookAt(camera.position);
      m.scale.setScalar(size * (DISC_DIST / 700));
      m.material.opacity = opacity;
      m.visible = opacity > 0.01;
    };
    place(this.moonSprite, this.moonDir, 150, THREE.MathUtils.clamp(-elev * 6 + 1.0, 0, 1) * 0.95);

    // clouds
    this.cloudUniforms.uTime.value += dt;
    this.cloudUniforms.uSunDir.value.copy(this.sunDir);
    this.cloudUniforms.uSunColor.value.copy(p.sun);
    this.cloudUniforms.uZenith.value.copy(p.zenith);
    this.cloudUniforms.uCamPos.value.copy(camera.position);

    // The light on the deck, published as radiance so CLOUD_FRAG can do albedo
    // x illumination instead of art-directing a colour. See the long note there.
    //
    // Deliberately NOT attenuated by the weather's `sun` the way main attenuates
    // the terrain's: that factor is "how much sun gets through the cloud", and
    // the cloud is the thing doing the blocking. It stands in full sunlight on
    // top and the shader darkens its underside itself, from uCoverage.
    this.cloudUniforms.uSunLight.value.copy(p.sun).multiplyScalar(p.sunIntensity);
    // Not p.ambient alone. That key is the *ground's* fill — a dull grey-purple
    // 0x6a6270 at sunrise — while the thing actually shining on the underside of
    // a dawn cloud is the horizon itself, 0xf2a468, which is three times the
    // luminance and the whole reason a sunrise cloud goes salmon instead of
    // brown. With ambient alone the first dawn shot after this rewrite had a
    // brown smudge sitting in an otherwise good pink sky.
    //
    // Half way there, because the two keys are within 8% of each other at
    // noon and at night (0xa2bada against 0x96c0ee, 0x0a1024 against 0x070a18),
    // so this is arithmetically almost a no-op at both ends and only bites
    // across the dawn/dusk band where the palette pulls them apart. That is
    // deliberate: the ramp was checked and passed, and this must not restyle it.
    this.cloudUniforms.uSkyLight.value.copy(p.ambient).lerp(p.horizon, 0.50);
    // Enough moon to keep a night deck as a readable silhouette against the
    // stars and no more. The palette's night ambient alone is ~0.003 linear,
    // which is black on screen — correct for a moonless sky and wrong for this
    // one, which has a moon in it (see moonLight below). Squared night so it is
    // exactly zero all day rather than a small constant nobody notices.
    this.cloudUniforms.uMoonLight.value.copy(MOON_FILL)
      .multiplyScalar(night * night * 0.030);

    // lights
    const target = focus || camera.position;
    this.sunLight.color.copy(p.sun);
    this.sunLight.intensity = p.sunIntensity;
    this.sunLight.visible = p.sunIntensity > 0.01;
    this._fitShadow(camera, target);

    // The moon, trimmed from 0.16.
    //
    // This is a directional with no shadow map, and it is the *only* scene
    // light the terrain still listens to (the voxel material throws away all
    // indirect — see LIGHTS_END — so ambient and the entity fill never reach
    // the ground). That made it the single biggest contributor to night
    // terrain, ahead of the baked skylight, and unlike the skylight it is not
    // gated by anything the world knows: it is what leaked into every cave and
    // lit the animals in them. It stays, because a clear night should have a
    // direction and hills should have a moonlit side; it is simply no longer
    // most of the night.
    //
    // Not shelter-dimmed the way the entity fill below is. That was tried and
    // is wrong for this light: shelter is the *player's* roof, and dimming a
    // directional by it would darken the whole moonlit valley the moment you
    // stepped under a tree. Terrain is protected instead by the shadowGate on
    // voxel skylight, which knows about the roof over each fragment; what is
    // left over is entities in caves, and that is what the trim is for.
    this.moonLight.intensity = night * 0.13;
    this.moonLight.visible = night > 0.02;
    this.moonLight.position.copy(target).addScaledVector(this.moonDir, 90);
    this.moonLight.target.position.copy(target);
    this.moonLight.target.updateMatrixWorld();

    this.ambient.color.copy(p.ambient);
    this.ambient.intensity = 0.16 + night * 0.04;

    // The same moon blue the terrain's sky fill takes after dark, for the same
    // reason and by the same weight — see MOON_FILL in main.js. If the two
    // disagreed a cow would be lit by a different night than the field it is
    // standing in, which is the whole failure this pass is about, only in
    // colour instead of in level.
    const n2 = night * night;
    this.entityFill.color.copy(p.zenith).lerp(p.horizon, 0.5).lerp(_white, 0.35)
      .lerp(MOON_FILL, n2);
    this.entityFill.groundColor.copy(p.fog).multiplyScalar(0.5);
    // Mobs are lit by scene lights; the terrain is lit by its own baked voxel
    // light. That is fine by day, when both are bright, and wrong after dark:
    // this fill used to bottom out at 0.45 while the world around it went to
    // near black, so a husk at midnight was the brightest thing on screen and
    // read as *glowing*. At night it drops to a rim of skylight, which leaves a
    // silhouette — which is what a thing in the dark should be.
    //
    // And it has to know about roofs, because a scene light does not.
    //
    // Terrain reads its light out of the voxel grid, so it goes properly dark
    // indoors; entities cannot, so a cow in a sealed room stayed as bright as
    // the meadow outside and read as pasted on. There is no way to occlude a
    // hemisphere light, so this borrows the player's own sky exposure — the
    // same probe that decides whether rain reaches you — and dims the fill
    // under a roof. It is the player's roof and not the animal's, which is
    // wrong for the one shot where you stand in a dark room and look out of a
    // window at a lit field; that is a cheap price for every cave and hut in
    // the game being dark, and no per-mob light would be.
    //
    // It dims rather than switching off. Cutting entities loose from the sky
    // entirely is how they became black cut-outs under trees in the first
    // place, and a thick canopy reads as "roofed" to that same probe.
    //
    // The night floor was 0.07 and is now 0.17, added through the squared night
    // weight so that by day the expression is *arithmetically unchanged* — at
    // noon night is 0 and this is the same 0.07 constant it always was.
    //
    // 0.07 was the answer to a real problem (a husk at midnight glowing as the
    // brightest thing on screen) and it overshot in the other direction: with
    // the terrain still carrying its baked skylight, the ground under an animal
    // was several times brighter than the animal, so the animal read as a hole.
    //
    // 0.17 is not eyeballed. It was solved for by running both halves of the
    // picture — this hemisphere plus the moon and ambient on one side, the
    // voxel material's sky fill plus the moon on the other — through the
    // shipped ACES pass, exposure and grade, and looking for the floor at which
    // a midnight husk lands on the same screen value as the stone and grass
    // around it. Below 0.17 it is a silhouette with nothing in it; above, it
    // starts glowing again, which is the bug this constant was born to fix.
    // The `shelter` term stays, and that is a decision rather than an oversight
    // now that every mob carries its own sky exposure (see `SKY_PROBE_PERIOD` in
    // Mobs.js). The obvious tidy-up is to delete it, on the grounds that a body
    // dimmed by its own roof and by the player's is dimmed twice - but this
    // light is not only on mobs. Drops and debris have no probe of their own, so
    // this term is the only thing that darkens a dropped pickaxe in a cave, and
    // removing it would trade a mob fault for an item one.
    //
    // What it costs, stated: outdoors nothing at all, because at shelter 1 the
    // multiplier is exactly 1.0, so the night floor solved above is untouched
    // and this is the case the player is in almost all of the time. Indoors, an
    // animal under its own roof while the player is under theirs is darker than
    // either fact alone would make it, and an animal in open sunlight while the
    // player stands in a cave is dimmer than it should be. Both are pre-existing
    // and both are the rarer arrangement.
    //
    // The honest fix is to give drops the same per-body probe and then delete
    // this term, not to delete it now.
    this.entityFill.intensity =
      (0.07 + 0.10 * n2 + p.sunIntensity * 0.93) * (0.25 + 0.75 * shelter);
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
    this.time = ((dayFraction % 1) + 1) % 1;
    solarDirection(up, this.time, this.sunDir);
    this.moonDir.copy(this.sunDir).negate();
  }

  /** Real local time of day as a 0..1 fraction. */
  static clockFraction(date = new Date()) {
    return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) / 86400;
  }
}
