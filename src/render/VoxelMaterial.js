// Voxel surface material: PBR standard shading fed by texture *arrays*, with
// voxel skylight / coloured block light, per-vertex AO, biome tint and wind.

import * as THREE from 'three';

export const voxelUniforms = {
  uMap: { value: null },
  uNormalMap: { value: null },
  uArm: { value: null },
  uCrack: { value: null },
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSkyColor: { value: new THREE.Color(0.42, 0.56, 0.78) },
  uSkyIntensity: { value: 1.0 },
  uBounceColor: { value: new THREE.Color(0.36, 0.30, 0.22) },
  uBlockIntensity: { value: 5.0 },
  uNormalScale: { value: 0.55 },
  uPlanetCenter: { value: new THREE.Vector3(0, 0, 0) },
  uBreakPos: { value: new THREE.Vector3(-999, -999, -999) },
  uBreakStage: { value: -1 },
  uFogColor: { value: new THREE.Color(0.6, 0.72, 0.9) },
  uFogDensity: { value: 0.0 },
  uCamPos: { value: new THREE.Vector3() },
  uUnderwater: { value: 0 },
  uWaterFog: { value: new THREE.Color(0.045, 0.20, 0.29) },
  uWaterTint: { value: new THREE.Color(0.34, 0.72, 0.78) },
  // The turning year, applied to the biome tint a vertex already carries. See
  // SEASON_FRAG.
  uSeasonColor: { value: new THREE.Vector3(1, 1, 1) },
  uSeasonStrength: { value: 0 },
  // The only light in the world that moves — whatever the player is holding.
  uHandLightPos: { value: new THREE.Vector3() },
  uHandLightColor: { value: new THREE.Vector3() },
  uHandLightRadius: { value: 0 },
};

const COMMON_VERT_HEAD = /* glsl */`
attribute vec4 aux;
attribute vec3 blockLight;
attribute vec3 tint;
attribute vec3 atangent;
varying vec3 vTangent;
varying float vLayer;
varying float vAO;
varying float vSun;
varying vec3 vBlock;
varying vec3 vTint;
varying vec2 vTexUv;
varying vec3 vWorld;
varying float vWave;
uniform float uTime;
uniform float uWind;
uniform vec3 uPlanetCenter;
`;

const COMMON_VERT_BODY = /* glsl */`
  vLayer = aux.x;
  vAO = aux.y;
  vSun = aux.z;
  vBlock = blockLight;
  vTint = tint;
  vTexUv = uv;
  vTangent = atangent;
  vWave = floor(aux.w);

  float wType = floor(aux.w);
  float wAmt = fract(aux.w);
  // Chunk meshes are authored in world space (identity model matrix), but
  // dropped items carry a real transform. Deriving vWorld from the local
  // position put them at the origin, which fogged them to black and broke the
  // sky-facing term. Go through the model matrix so both cases are correct.
  vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 up = normalize(wp - uPlanetCenter);

  if (wType > 0.5 && wType < 1.5) {
    // grass / flowers: bend along a tangent, phase-offset per position
    vec3 ref = abs(up.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tang = normalize(cross(up, ref));
    float ph = dot(wp, vec3(0.62, 0.41, 0.77));
    float sway = sin(uTime * 1.9 + ph) * 0.6 + sin(uTime * 3.9 + ph * 1.7) * 0.25;
    transformed += tang * sway * 0.13 * wAmt * uWind;
    transformed -= up * abs(sway) * 0.02 * wAmt * uWind;
  } else if (wType > 1.5 && wType < 2.5) {
    // water: gentle radial swell
    float h = sin(uTime * 1.05 + wp.x * 0.62 + wp.z * 0.48) * 0.5
            + sin(uTime * 1.63 - wp.z * 0.71 + wp.y * 0.39) * 0.35
            + sin(uTime * 2.31 + wp.x * 0.29 - wp.y * 0.55) * 0.2;
    transformed += up * h * 0.075;
  } else if (wType > 3.5) {
    // leaves: subtle whole-canopy sway
    float ph = dot(wp, vec3(0.33, 0.51, 0.27));
    vec3 ref = abs(up.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 tang = normalize(cross(up, ref));
    transformed += tang * sin(uTime * 1.35 + ph) * 0.045 * uWind;
  }
  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const COMMON_FRAG_HEAD = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uMap;
uniform sampler2DArray uNormalMap;
uniform sampler2DArray uArm;
uniform sampler2DArray uCrack;
uniform vec3 uSkyColor;
uniform float uSkyIntensity;
uniform vec3 uBounceColor;
uniform float uBlockIntensity;
uniform float uNormalScale;
uniform vec3 uBreakPos;
uniform float uBreakStage;
uniform vec3 uPlanetCenter;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCamPos;
uniform float uUnderwater;
uniform vec3 uWaterFog;
uniform vec3 uWaterTint;
uniform float uTime;
uniform vec3 uSeasonColor;
uniform float uSeasonStrength;
uniform vec3 uHandLightPos;
uniform vec3 uHandLightColor;
uniform float uHandLightRadius;
varying float vLayer;
varying float vAO;
varying float vSun;
varying vec3 vBlock;
varying vec3 vTint;
varying vec2 vTexUv;
varying vec3 vWorld;
varying vec3 vTangent;
varying float vWave;
vec3 armSample;

/**
 * Cheap dancing-light pattern. Three interfering sine fields, thresholded so
 * the bright ridges read as the sharp caustic lines you get under a wavy
 * surface rather than a soft blur.
 */
float caustic(vec2 p, float t) {
  float a = sin(p.x * 2.9 + t * 1.30) + sin(p.y * 2.5 - t * 1.10)
          + sin((p.x + p.y) * 2.1 + t * 0.90);
  float b = sin(p.x * 4.1 - t * 0.80) + sin(p.y * 3.7 + t * 1.40);
  float v = abs(a * 0.333) * abs(b * 0.5);
  return pow(1.0 - clamp(v, 0.0, 1.0), 5.0);
}
`;

/**
 * The season, applied to the living world.
 *
 * Only living things turn: `tint` is exactly (1,1,1) for every block the mesher
 * does not tint, and no biome colour comes within a mile of white — the
 * brightest channel in the whole table is 0.84 — so how far the tint sits from
 * white is a reliable "is this grass or leaves" and needs no extra attribute.
 *
 * The season *replaces* the hue rather than multiplying it. A leaf's colour is
 * its texture times its biome tint, and the texture is already green; no
 * multiplier turns that gold, it only makes a brighter green. So this takes the
 * luminance of the colour it was about to draw and re-hues that. All the
 * texture detail and every bit of shading live in the luminance, so they come
 * through untouched — only the colour changes. uSeasonColor arrives normalised
 * to luminance 1, which is what keeps a re-hued surface exactly as bright as
 * the one it replaced.
 */
const SEASON_FRAG = /* glsl */`
  vec3 seasonBase = diffuseColor.rgb * vTint;
  float living = clamp(length(vec3(1.0) - vTint) * 4.0, 0.0, 1.0);
  float seasonLum = dot(seasonBase, vec3(0.299, 0.587, 0.114));
  vec3 rehued = mix(seasonBase, seasonLum * uSeasonColor, uSeasonStrength);
  diffuseColor.rgb = mix(seasonBase, rehued, living);
`;

const MAP_FRAG = /* glsl */`
  vec4 texel = texture(uMap, vec3(vTexUv, vLayer));
  diffuseColor *= texel;
${SEASON_FRAG}

  // Per-voxel tone jitter: identical blocks stop reading as tiled wallpaper.
  vec3 cell = floor(vWorld - normalize(vNormal) * 0.5) + 0.5;
  float vh = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float vh2 = fract(sin(dot(cell, vec3(93.9898, 27.345, 61.117))) * 24634.6345);
  diffuseColor.rgb *= 0.93 + vh * 0.14;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.04, 1.0, 0.95), vh2 - 0.5);
`;

// Cutout foliage needs its alpha sampled sharper than its colour. Mipmapping
// averages the holes away with distance — a leaf tile that is 32% holes
// averages to ~0.68 alpha, sails past the 0.42 cutoff, and the whole block
// turns solid. Distant canopies then read as pale rectangular slabs. Shrinking
// the gradients biases the alpha lookup toward a sharper mip so the holes
// survive much further out.
const CUTOUT_MAP_FRAG = /* glsl */`
  vec4 texel = texture(uMap, vec3(vTexUv, vLayer));
  float aSharp = textureGrad(uMap, vec3(vTexUv, vLayer),
                             dFdx(vTexUv) * 0.3, dFdy(vTexUv) * 0.3).a;
  diffuseColor *= texel;
  diffuseColor.a = min(diffuseColor.a, aSharp);
${SEASON_FRAG}

  vec3 cell = floor(vWorld - normalize(vNormal) * 0.5) + 0.5;
  float vh = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  diffuseColor.rgb *= 0.93 + vh * 0.14;
`;

// --- liquid-only variants ---------------------------------------------------
// `tint` carries (depth, shoreline, -) for liquids rather than a biome colour.

const LIQUID_MAP_FRAG = /* glsl */`
  float wDepth = vTint.x;
  float wShore = vTint.y;

  if (vWave > 2.5) {
    // lava shares the liquid pass but wants none of the water treatment: keep
    // the painted crust, crawl it slowly, stay opaque
    vec2 lu = vTexUv * 0.85 + vec2(uTime * 0.006, uTime * 0.0045);
    vec2 lu2 = vTexUv * 1.4 - vec2(uTime * 0.004, uTime * 0.007);
    vec3 lc = mix(texture(uMap, vec3(lu, vLayer)).rgb, texture(uMap, vec3(lu2, vLayer)).rgb, 0.4);
    diffuseColor.rgb = lc * 1.2;
    diffuseColor.a = 1.0;
  } else {

  // two layers of the surface texture scrolling against each other read as
  // moving water far better than a single animated sample
  vec2 uvA = vTexUv * 1.25 + vec2(uTime * 0.020, uTime * 0.016);
  vec2 uvB = vTexUv * 0.65 - vec2(uTime * 0.012, uTime * 0.025);
  vec3 texA = texture(uMap, vec3(uvA, vLayer)).rgb;
  vec3 texB = texture(uMap, vec3(uvB, vLayer)).rgb;
  vec3 surf = mix(texA, texB, 0.5);

  // Water reads as water mainly because you can see the bottom through it and
  // that view fades with depth. The old curve was tuned the other way: a light
  // shallow tint at 1.55 gain, opaque enough to hide the sand, so a lake was a
  // flat pale sheet laid over the terrain — a sheet of paper with a hard edge.
  // Shallows are now nearly clear and only faintly tinted; depth is what brings
  // in colour and opacity.
  vec3 shallow = vec3(0.30, 0.68, 0.72);
  vec3 deep    = vec3(0.02, 0.16, 0.34);
  float dRamp = smoothstep(0.0, 0.42, wDepth);
  vec3 body = mix(shallow, deep, dRamp);
  diffuseColor.rgb = surf * body * 1.12;
  diffuseColor.a = mix(0.20, 0.90, dRamp);

  // Foam where the water actually touches land. Tight and bright: a hard rim
  // is what tells the eye the surface has an edge in the world rather than
  // being cut off, and it hides the geometric join with the shore.
  float ripple = texture(uMap, vec3(vTexUv * 2.6 + vec2(uTime * 0.05, uTime * 0.02), vLayer)).r;
  float ripple2 = texture(uMap, vec3(vTexUv * 5.1 - vec2(uTime * 0.03, uTime * 0.06), vLayer)).r;
  // Keep it to the first block of depth. wShore is only a coarse "some
  // neighbour is land" flag, so pairing it with a wide depth window turned
  // every shallow bay into a white field — the rim has to be narrow in depth
  // to stay a rim.
  float edge = wShore * (1.0 - smoothstep(0.0, 0.13, wDepth));
  float foam = 0.72 * smoothstep(0.50, 0.92, edge * (0.42 + ripple * 0.62 + ripple2 * 0.4));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.99, 1.0), foam);
  diffuseColor.a = clamp(max(diffuseColor.a, foam * 0.9), 0.0, 0.94);
  }
`;

const LIQUID_NORMAL_FRAG = /* glsl */`
  vec3 gN = normalize(vNormal);
  vec3 Tv = normalize(vTangent - gN * dot(gN, vTangent));
  vec3 Bv = cross(gN, Tv);
  vec3 nA = texture(uNormalMap, vec3(vTexUv * 1.25 + vec2(uTime * 0.020, uTime * 0.016), vLayer)).xyz * 2.0 - 1.0;
  vec3 nB = texture(uNormalMap, vec3(vTexUv * 0.65 - vec2(uTime * 0.012, uTime * 0.025), vLayer)).xyz * 2.0 - 1.0;
  vec3 nT = normalize(nA + nB);
  nT.xy *= 0.85;
  normal = normalize(Tv * nT.x + Bv * nT.y + gN * nT.z);
`;

const NORMAL_FRAG = /* glsl */`
  vec3 nrmTex = texture(uNormalMap, vec3(vTexUv, vLayer)).xyz * 2.0 - 1.0;
  nrmTex.xy *= uNormalScale;
  // Rebuilding the basis from the raw varying threw away three's back-face
  // flip, so the far wall of a double-sided cutout block (leaf cubes, plant
  // crosses) was lit as if it faced away from the viewer and read as a dark
  // hollow interior. faceDirection is declared by <normal_fragment_begin>.
  vec3 gN = normalize(vNormal) * faceDirection;
  vec3 Tv = normalize(vTangent - gN * dot(gN, vTangent));
  vec3 Bv = cross(gN, Tv);
  normal = normalize(Tv * nrmTex.x + Bv * nrmTex.y + gN * nrmTex.z);
`;

const ROUGH_FRAG = /* glsl */`
  armSample = texture(uArm, vec3(vTexUv, vLayer)).rgb;
  float roughnessFactor = roughness * armSample.g;
`;

const METAL_FRAG = /* glsl */`
  float metalnessFactor = metalness * armSample.b;
`;

const LIGHTS_END = /* glsl */`
  float texAO = armSample.r;
  float aoTotal = clamp(vAO * texAO, 0.0, 1.0);
  // Skylight shapes ambient, but never all the way to black — deep shade still
  // catches bounced light.
  float sunAmt = 0.16 + 0.84 * (vSun * (0.45 + 0.55 * vSun));

  // Sky dome fill, occluded by voxel skylight. Irradiance goes through the
  // same 1/PI Lambert factor as direct light, otherwise ambient overwhelms the
  // sun and cast shadows disappear.
  //
  // The dome colour arrives around 0.44 saturation, which is fine as *sky* but
  // far too strong as the only light reaching a shaded face. On a neutral block
  // there is no albedo hue to fight it, so shadow sides were rendering as flat
  // blue cards — measured 0.73 saturation on shaded stone. Pulling the fill a
  // third of the way to its own luminance keeps the cool cast that sells
  // daylight shadow while letting the material's own colour show through.
  // (Brightness is preserved: this is a saturation trim, not a dimming, and the
  // RECIPROCAL_PI division below is unchanged.)
  vec3 skyTinted = uSkyColor * uSkyIntensity * sunAmt;
  vec3 skyFill = mix(skyTinted, vec3(dot(skyTinted, vec3(0.2126, 0.7152, 0.0722))), 0.34);
  // ground bounce, strongest on downward-facing surfaces
  vec3 upDir = normalize(vWorld - uPlanetCenter);
  float downFace = clamp(-dot(normal, upDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 bounce = uBounceColor * uSkyIntensity * sunAmt * downFace * 0.6;
  // hemisphere shaping: sky light lands hardest on upward faces
  float skyFacing = clamp(dot(normal, upDir) * 0.5 + 0.5, 0.0, 1.0);
  skyFill *= mix(0.62, 1.0, skyFacing);

  reflectedLight.indirectDiffuse += diffuseColor.rgb * (skyFill + bounce) * aoTotal * RECIPROCAL_PI;
  reflectedLight.indirectDiffuse += diffuseColor.rgb * vBlock * uBlockIntensity * mix(0.65, 1.0, aoTotal) * RECIPROCAL_PI;

  // What you are carrying.
  //
  // Every other light in this world is baked into the voxel grid, which is
  // wonderfully cheap and cannot follow anything: a torch lit the cave it was
  // planted in and a torch in your hand lit nothing at all, so the only way to
  // see underground was to keep planting them. This is the one moving light,
  // and it is worth the two uniforms — walking into the dark holding a flame
  // and having the dark answer is most of what a torch is for.
  //
  // Inverse-square with a linear cutoff at the radius, so it reaches zero
  // instead of trailing a faint wash across the whole chunk, and lambert-shaded
  // off the surface normal so it wraps around geometry rather than flooding it.
  if (uHandLightRadius > 0.0) {
    vec3 toHand = uHandLightPos - vWorld;
    float dist = length(toHand);
    if (dist < uHandLightRadius) {
      float fall = 1.0 - dist / uHandLightRadius;
      float lambert = clamp(dot(normal, toHand / max(dist, 0.001)), 0.0, 1.0);
      // A little ambient term so faces turned away are lifted out of pure black
      // rather than vanishing; a real flame bounces off everything around it.
      float shaped = mix(0.22, 1.0, lambert) * fall * fall;
      reflectedLight.indirectDiffuse += diffuseColor.rgb * uHandLightColor * shaped * RECIPROCAL_PI;
    }
  }
  reflectedLight.indirectSpecular *= aoTotal;

  float shadowGate = smoothstep(0.0, 0.30, vSun);
  reflectedLight.directDiffuse *= shadowGate * mix(0.78, 1.0, aoTotal);
  reflectedLight.directSpecular *= shadowGate;
`;

const BREAK_FRAG = /* glsl */`
  if (uBreakStage >= 0.0 && distance(vWorld, uBreakPos) < 0.95) {
    vec4 cr = texture(uCrack, vec3(fract(vTexUv), uBreakStage));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, cr.rgb, cr.a * 0.92);
  }
`;

/** Distance + underwater fog applied in world space. */
const FOG_FRAG = /* glsl */`
  float dist = length(vWorld - uCamPos);

  if (uUnderwater > 0.5) {
    // Caustics before the fog, so they're attenuated by distance like the
    // surface they sit on. Only upward faces catch them.
    vec3 upW = normalize(vWorld - uPlanetCenter);
    float facing = clamp(dot(normalize(vNormal), upW), 0.0, 1.0);
    if (facing > 0.02) {
      vec3 e1 = normalize(cross(upW, abs(upW.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
      vec3 e2 = cross(upW, e1);
      vec2 cp = vec2(dot(vWorld, e1), dot(vWorld, e2));
      float c = caustic(cp * 0.9, uTime * 0.9);
      // only where daylight actually reaches
      gl_FragColor.rgb += uWaterTint * c * facing * vSun * 1.5;
    }
  }

  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(f, 0.0, 1.0));

  if (uUnderwater > 0.5) {
    // thick, wavelength-shifted extinction: red falls off fastest
    vec3 ext = vec3(0.115, 0.052, 0.035);
    vec3 uf = vec3(1.0) - exp(-ext * dist);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uWaterFog, clamp(uf, 0.0, 0.96));
  }
`;

function patch(material, opts = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, voxelUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON_VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + COMMON_VERT_BODY);

    let fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON_FRAG_HEAD)
      .replace('#include <map_fragment>', opts.liquid ? LIQUID_MAP_FRAG : (opts.cutout ? CUTOUT_MAP_FRAG : MAP_FRAG))
      .replace('#include <normal_fragment_maps>', opts.liquid ? LIQUID_NORMAL_FRAG : NORMAL_FRAG)
      .replace('#include <roughnessmap_fragment>', ROUGH_FRAG)
      .replace('#include <metalnessmap_fragment>', METAL_FRAG)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHTS_END);

    if (opts.liquid) {
      fs = fs.replace('#include <opaque_fragment>', /* glsl */`
        #include <opaque_fragment>
        if (vWave < 2.5) {
          vec3 vDir = normalize(vWorld - uCamPos);
          // Grazing-angle fresnel used to drive this to pure white, which read
          // as pale panels floating over the sea. Keep the sheen subtle.
          float fres = pow(1.0 - clamp(dot(-vDir, normal), 0.0, 1.0), 5.0);
          vec3 sheen = mix(uSkyColor, vec3(1.0), 0.25) * min(uSkyIntensity, 1.2);
          gl_FragColor.rgb += sheen * fres * 0.22;
          gl_FragColor.a = clamp(mix(gl_FragColor.a, 0.94, fres * 0.5), 0.0, 0.95);
        }
      `);
    }

    fs = fs.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n' + (opts.noCrack ? '' : BREAK_FRAG) + FOG_FRAG);

    shader.fragmentShader = fs;
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'voxel' + (opts.liquid ? 'L' : '') + (opts.cutout ? 'C' : '');
  return material;
}

export function createVoxelMaterials() {
  const base = () => new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1.0, metalness: 0.0, vertexColors: false,
  });

  const opaque = patch(base());
  opaque.name = 'voxel-opaque';

  const cutout = patch(base(), { cutout: true });
  cutout.name = 'voxel-cutout';
  cutout.transparent = false;
  cutout.alphaTest = 0.42;
  cutout.side = THREE.DoubleSide;

  const transparent = patch(base());
  transparent.name = 'voxel-transparent';
  transparent.transparent = true;
  transparent.depthWrite = true;
  transparent.side = THREE.DoubleSide;

  const liquid = patch(base(), { liquid: true, noCrack: true });
  liquid.name = 'voxel-liquid';
  liquid.transparent = true;
  liquid.depthWrite = false;
  liquid.side = THREE.DoubleSide;
  liquid.roughness = 0.08;
  liquid.metalness = 0.0;

  return { opaque, cutout, transparent, liquid, uniforms: voxelUniforms };
}

/**
 * Depth/normal stand-in for cutout foliage, used by the GTAO G-buffer prepass.
 *
 * GTAOPass renders its own depth+normal buffer with `scene.overrideMaterial`
 * set to a plain MeshNormalMaterial. That material knows nothing about our
 * array-texture cutout, so every grass cross and leaf block wrote a *solid*
 * quad into the AO buffer — and each sprite came back as a block-shaped patch
 * of occlusion hanging in the air. That is the "transparent block" artifact,
 * and it was worst over grass because tall grass is nothing but crossed quads
 * standing in the open.
 *
 * This repeats the cutout discard (including the sharpened alpha lookup) and
 * the wind displacement, so the AO geometry matches what is actually drawn.
 */
export function createCutoutNormalMaterial(alphaTest = 0.42) {
  const mat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  mat.blending = THREE.NoBlending;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, voxelUniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON_VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + COMMON_VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <packing>', /* glsl */`
        #include <packing>
        precision highp sampler2DArray;
        uniform sampler2DArray uMap;
        varying float vLayer;
        varying vec2 vTexUv;
      `)
      .replace('#include <clipping_planes_fragment>', /* glsl */`
        #include <clipping_planes_fragment>
        {
          float aFlat = texture(uMap, vec3(vTexUv, vLayer)).a;
          float aSharp = textureGrad(uMap, vec3(vTexUv, vLayer),
                                     dFdx(vTexUv) * 0.3, dFdy(vTexUv) * 0.3).a;
          if (min(aFlat, aSharp) < ${alphaTest.toFixed(3)}) discard;
        }
      `);
  };
  mat.customProgramCacheKey = () => 'voxelCutoutNormal';
  return mat;
}

/**
 * Stripped-down voxel material for objects rendered outside world space — the
 * first-person viewmodel. Same texture arrays, no fog and no voxel skylight.
 */
export function createItemBlockMaterial() {
  // alphaTest, so the held and inventory copies of a cut-out block have their
  // holes. Every ordinary block tile is fully opaque and unaffected by it; a
  // ladder is mostly holes and without this came out as a solid orange brick
  // with rungs painted on, in the hand and in the hotbar both.
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.0, alphaTest: 0.4 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMap = voxelUniforms.uMap;
    shader.uniforms.uNormalMap = voxelUniforms.uNormalMap;
    shader.uniforms.uArm = voxelUniforms.uArm;
    shader.uniforms.uSeasonColor = voxelUniforms.uSeasonColor;
    shader.uniforms.uSeasonStrength = voxelUniforms.uSeasonStrength;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute vec4 aux;
        attribute vec3 tint;
        attribute vec3 atangent;
        varying float vLayer;
        varying vec3 vTint;
        varying vec2 vTexUv;
        varying vec3 vTangent;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vLayer = aux.x; vTint = tint; vTexUv = uv; vTangent = atangent;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uMap;
        uniform sampler2DArray uNormalMap;
        uniform sampler2DArray uArm;
        varying float vLayer;
        varying vec3 vTint;
        varying vec2 vTexUv;
        varying vec3 vTangent;
        uniform vec3 uSeasonColor;
        uniform float uSeasonStrength;
        vec3 armS;
      `)
      // A held or dropped block turns with the year too, or an autumn player
      // carries a piece of summer around in front of them.
      .replace('#include <map_fragment>', /* glsl */`
        vec4 texel = texture(uMap, vec3(vTexUv, vLayer));
        diffuseColor *= texel;
${SEASON_FRAG}
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        vec3 nT = texture(uNormalMap, vec3(vTexUv, vLayer)).xyz * 2.0 - 1.0;
        nT.xy *= 0.6;
        vec3 gN = normalize(vNormal);
        vec3 Tv = normalize(vTangent - gN * dot(gN, vTangent));
        normal = normalize(Tv * nT.x + cross(gN, Tv) * nT.y + gN * nT.z);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        armS = texture(uArm, vec3(vTexUv, vLayer)).rgb;
        float roughnessFactor = roughness * armS.g;
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        float metalnessFactor = metalness * armS.b;
      `);
  };
  mat.customProgramCacheKey = () => 'itemblock';
  return mat;
}

/** Build the three DataArrayTextures from worker output. */
export function buildTileTextures(payload, renderer) {
  const { albedo, normal, arm, size, layers } = payload;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, layers);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(8, maxAniso);
    t.needsUpdate = true;
    return t;
  };

  return {
    map: mk(albedo, true),
    normalMap: mk(normal, false),
    arm: mk(arm, false),
  };
}

export function buildCrackTexture(payload) {
  const { data, size, layers } = payload;
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
