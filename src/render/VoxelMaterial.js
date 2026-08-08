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
  // Where the sun is, for the one surface that shows you: water. Everything
  // else takes its key light from the scene's directional light, but a glint
  // needs the direction in the fragment shader.
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  // The sky as something to *see*, not as something to light with. uSkyColor is
  // an ambient fill: desaturated and pulled a third of the way to white so it
  // does not paint shadowed faces blue. Reflecting that in water gives you a
  // white lake under a blue sky. This one keeps the palette's real hue.
  uSkyReflect: { value: new THREE.Color(0.35, 0.52, 0.78) },
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
  } else if (wType > 2.5 && wType < 3.5) {
    // lava: a slow, heavy swell.
    //
    // There was no branch here at all, so lava was the one liquid whose surface
    // never moved a millimetre — perfectly flat, perfectly still and fully
    // opaque, which is a description of a block. It is a liquid and has to read
    // as one. Molten rock is viscous, so this is a longer wavelength at a third
    // of water's speed and half its amplitude: not a ripple, a heave.
    float h = sin(uTime * 0.40 + wp.x * 0.30 + wp.z * 0.23) * 0.6
            + sin(uTime * 0.58 - wp.z * 0.36 + wp.y * 0.18) * 0.4;
    transformed += up * h * 0.042;
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
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyReflect;
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
    // Lava shares the liquid pass but wants none of the water treatment: keep
    // the painted crust and stay opaque. What it does want is to look molten,
    // and the crawl was so slow (a fifth of a texel a second) that it read as
    // static — nearly three times faster is still a viscous ooze but is
    // actually perceptible.
    vec2 lu = vTexUv * 0.85 + vec2(uTime * 0.017, uTime * 0.013);
    vec2 lu2 = vTexUv * 1.4 - vec2(uTime * 0.011, uTime * 0.019);
    vec3 lc = mix(texture(uMap, vec3(lu, vLayer)).rgb, texture(uMap, vec3(lu2, vLayer)).rgb, 0.4);
    // The crust is cooler than the cracks between it, and the tile already says
    // which is which — hot is where red runs far ahead of blue. Beating only
    // that part makes the surface look alive instead of like a painting of
    // lava, and leaves the dark crust alone so the contrast survives.
    float hot = smoothstep(0.30, 0.75, lc.r - lc.b);
    float beat = 0.86 + 0.14 * sin(uTime * 1.25 + vWorld.x * 0.42 + vWorld.z * 0.31);
    diffuseColor.rgb = lc * (1.05 + 0.55 * hot * beat);
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
  // Real water *absorbs* the light coming back off the bed — it multiplies it.
  // Alpha blending can only average, so a pale cyan at low alpha over bright
  // sand lands on a desaturated grey rather than on turquoise, and a shelf a
  // single block deep came out looking like faintly hazy sand with no water in
  // it at all. Compensating means carrying more of the water's own colour in
  // the shallows and making that colour strong enough to survive the average.
  // The shallow end stays see-through — the bed's ripples still read through
  // it, which is the thing worth keeping — it is simply water-coloured now.
  vec3 shallow = vec3(0.13, 0.55, 0.60);
  vec3 deep    = vec3(0.02, 0.16, 0.34);
  float dRamp = smoothstep(0.0, 0.42, wDepth);
  vec3 body = mix(shallow, deep, dRamp);
  diffuseColor.rgb = surf * body * 1.12;
  diffuseColor.a = mix(0.46, 0.90, dRamp);

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
  // Liquid is DoubleSide, so half the quads you ever see are back faces: the
  // surface of a lake from underwater, the underside of a flow running off a
  // ledge. The mesher emits one quad per surface with its normal pointing out
  // of the water, so on those views the shading normal points away from the
  // eye — and the fresnel block after <opaque_fragment> reads a normal pointing
  // away as a perfectly grazing view. cosT clamps to 0, fres goes to 1, and the
  // shaded water is replaced wholesale by 88% flat sky at 0.97 alpha: swimming
  // up to the surface and looking at it showed no water texture at all, just a
  // pale sheet the colour of the sky.
  //
  // NORMAL_FRAG solves the same problem with three's faceDirection, but that
  // reads the triangle's winding, and a liquid top quad is wound from its own
  // cell rather than from the side you happen to be on — measured +1 on
  // fragments whose geometric normal faced away, so the winding cannot be
  // trusted to say which side is being looked at. Ask the view vector instead,
  // which is true whatever the winding. It is a no-op on front faces, so
  // everything seen from above renders exactly as before.
  vec3 gN = normalize(vNormal);
  gN *= dot(gN, uCamPos - vWorld) < 0.0 ? -1.0 : 1.0;
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
  // The ground is lit by the voxel grid and by nothing else.
  //
  // Everything below builds a complete indirect model out of the baked voxel
  // light: sky fill shaped by skylight, ground bounce, block light, and the
  // flame in your hand. Meanwhile the scene also carries an ambient light and
  // a hemisphere fill, which exist for the *entities* — a cow is a loose model
  // and cannot read the voxel grid, so without them it goes black the moment
  // the sun does. Those two were landing on the terrain as well, and a scene
  // light has no idea there is a roof: wall yourself into a stone box at noon
  // and the hemisphere lit the inside of it as brightly as the meadow outside,
  // so a sealed room needed no torch and a cave was never dark. Dropping the
  // accumulated indirect here — after three has finished with it, before the
  // voxel model starts — is the whole fix, and it also stops the sky being
  // counted twice on every lit surface.
  //
  // Direct light is deliberately kept: that is the sun, and it is gated by
  // shadowGate on the voxel skylight further down, which does know about roofs.
  reflectedLight.indirectDiffuse = vec3(0.0);

  float texAO = armSample.r;
  float aoTotal = clamp(vAO * texAO, 0.0, 1.0);
  // Skylight shapes ambient — and where no skylight reaches, it really does go
  // out.
  //
  // This floor has been wrong in both directions. At 0.16 shaded faces sat too
  // far off black and the complaint was "shadows are too dark"; the answer was
  // to raise it to 0.34, and that was treating the wrong patient. vSun is
  // *voxel skylight*, not surface orientation: the shaded side of a boulder is
  // still under the open sky and still has vSun near one, so it was never this
  // term that made it dark. What the raised floor actually did was light the
  // inside of sealed rooms — brick yourself into a box at noon and you could
  // read the cracks in the stone with no light source at all, which quietly
  // deletes the entire point of carrying a torch. (The animals-black-under-
  // trees half of that same report had a different cause again, in Sky: the
  // entity fill was on a layer no camera tested, so it was never a light.)
  //
  // So the floor goes below where it started. Not to zero — a hair of bounce
  // keeps a cave from being a black rectangle you navigate by memory, and lets
  // you make out the shape of a passage a moment before your torch reaches it.
  // Everything past that hair you have to bring yourself.
  float sunAmt = 0.10 + 0.90 * (vSun * (0.45 + 0.55 * vSun));

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

/**
 * Lava is hotter than the light falling on it. Nothing else in the world is.
 *
 * The report was that lava and basalt look alike, and that you learn which is
 * which by standing on one and losing health. That is a legibility problem and
 * the cause is that world lava had **no emissive term at all** — it was a
 * diffuse surface like any rock, lit by the same sun, so a molten lake and a
 * dark volcanic stone with warm seams in it genuinely were the same kind of
 * thing to the renderer. The seams on magma stone even light their
 * surroundings, via voxel block light, which lava's did not.
 *
 * Emissive fixes it in the one way that cannot be mistaken for shading: it is
 * light the surface makes rather than light it receives, so lava stays bright
 * in a cave, at midnight and in its own shadow, where every rock goes dark. And
 * because the post stack blooms above 0.86, the hottest cracks now spill light
 * past their own edges — solid rock, sitting under that threshold, never does.
 *
 * Gated on the texel being *hot* rather than merely bright: red running well
 * ahead of blue is fire, and it leaves the dark crust between the cracks alone
 * so the surface keeps the contrast that makes it read as crusted-over rather
 * than as a flat orange sheet.
 */
const LAVA_EMISSIVE = /* glsl */`
  if (vWave > 2.5) {
    float lavaHot = smoothstep(0.18, 0.62, diffuseColor.r - diffuseColor.b);
    totalEmissiveRadiance += diffuseColor.rgb * (0.42 + 1.35 * lavaHot);
  }
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
    // Water absorbs. Everything down here was being lit as though it were in
    // open air and then tinted blue afterwards, which is why a sand bed two
    // metres down came out brighter than the beach it runs into — a pale cyan
    // haze rather than anything submerged. Take the light down first.
    gl_FragColor.rgb *= 0.58;

    // Caustics before the fog, so they're attenuated by distance like the
    // surface they sit on. Only upward faces catch them.
    vec3 upW = normalize(vWorld - uPlanetCenter);
    float facing = clamp(dot(normalize(vNormal), upW), 0.0, 1.0);
    if (facing > 0.02) {
      vec3 e1 = normalize(cross(upW, abs(upW.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
      vec3 e2 = cross(upW, e1);
      vec2 cp = vec2(dot(vWorld, e1), dot(vWorld, e2));
      float c = caustic(cp * 0.9, uTime * 0.9);
      // At 1.5 this was not a caustic, it was a second sun: white ridges laid
      // over every horizontal face until the bed lost its own colour. Caustics
      // are a *modulation* of the light already arriving, so they have to stay
      // small enough that the surface underneath still reads.
      gl_FragColor.rgb += uWaterTint * c * facing * vSun * 0.42;
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
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + LAVA_EMISSIVE)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHTS_END);

    if (opts.liquid) {
      fs = fs.replace('#include <opaque_fragment>', /* glsl */`
        #include <opaque_fragment>
        if (vWave < 2.5) {
          // What makes water read as water, at distance, is not its own colour
          // — it is that you stop seeing through it and start seeing the sky in
          // it. Straight down, water reflects about 2% and you see the bed. At
          // a grazing angle it reflects nearly everything and becomes a mirror.
          //
          // This was previously a small additive sheen at a fixed 0.22, which
          // brightened the surface without ever replacing what was under it, so
          // a lake seen across its length stayed a pale wash of sand-through-
          // tint all the way to the far shore: flat, and lighter than the sky
          // it should have been reflecting.
          vec3 vDir = normalize(vWorld - uCamPos);
          float cosT = clamp(dot(-vDir, normal), 0.0, 1.0);
          float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

          // The reflected sky, dimmed a little: a real surface is never a
          // perfect mirror and the roughness here stands in for chop.
          vec3 refl = uSkyReflect * 0.88;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, fres * 0.88);

          // Sun glint. The single strongest cue that a surface is liquid, and
          // the thing whose absence made this read as painted-on colour. It
          // rides the wave-perturbed normal, so it breaks into a scattering
          // path across the chop instead of one clean disc. Gated on skylight
          // so it does not shine out of a roofed cave.
          vec3 half3 = normalize(uSunDir - vDir);
          float glint = pow(clamp(dot(normal, half3), 0.0, 1.0), 190.0);
          gl_FragColor.rgb += uSunColor * glint * fres * vSun * 9.0;

          // Opacity follows the same curve: grazing water hides its bed.
          gl_FragColor.a = clamp(mix(gl_FragColor.a, 0.97, fres), 0.0, 0.97);
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
 * Give an *instanced* model the wind a cross billboard gets for free.
 *
 * A plant drawn as a billboard sways because the mesher stamps a wave code into
 * `aux.w` and the `wType == 1` branch of COMMON_VERT_BODY bends it. A modelled
 * flower never goes through that shader at all — it is an `InstancedMesh` of
 * item art — so the day the flowers became models a meadow stopped moving while
 * the grass around it kept rippling. This is that branch again, ported to
 * instances, and the constants are deliberately copied rather than re-tuned:
 * the two frequencies, the 0.6/0.25 mix and the phase vector are what make a
 * modelled flower and the tall grass beside it read as the same gust.
 *
 * ### Where the phase comes from
 *
 * From the *instance's* world position, which is the whole trick. Phase from
 * anything shared — a counter, the uniform time alone — moves every plant in
 * lockstep and a field then reads as one rigid object being waggled. The
 * billboard reads it off `wp`, its own vertex world position; an instance has
 * no such thing in its geometry, because the geometry is one flower reused two
 * hundred times and every copy of it sits at the same local coordinates. The
 * position lives in `instanceMatrix` instead, and its translation column is
 * exactly the per-instance world origin: `mi[3].xyz`. Neighbours are then out
 * of step for free, and stay out of step in the same way every frame.
 *
 * ### Why the displacement is rotated back into local space
 *
 * `<begin_vertex>` runs *before* `<project_vertex>` applies `instanceMatrix`,
 * so `transformed` is still in the model's own space and anything added to it
 * gets rotated and scaled afterwards. Bending along a local axis instead would
 * have been simpler and is wrong: each flower carries a random spin about its
 * own up (see `BlockModels.sync`), so a fixed local axis makes every plant lean
 * a different way and the result is a field of nervous tics rather than wind.
 * The bend is therefore built in world space against the planet tangent, like
 * the billboard's, then carried back through the inverse of the instance's
 * rotation. Scale is uniform, so that inverse is `transpose(rot) / s` — which
 * is `dW * rot / sqrt(s2)` in GLSL, `s2` being any column's squared length.
 *
 * Amplitude is left in the model's own unit-height space rather than divided
 * out to world units: a flower that stands 0.62 of a cell should sway 0.62 of
 * what a full-cell billboard sways, or the short ones thrash.
 *
 * @param {THREE.Material} material patched in place; clone first if it is shared
 * @param {number} loY  geometry-space Y where the stem is rooted — no movement
 * @param {number} hiY  geometry-space Y of the head — full movement
 */
export function applyInstancedSway(material, loY, hiY) {
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(material, shader, renderer);
    // The live uniform objects, not copies: uTime and uWind are already written
    // every frame by the main loop for the terrain's sake, so an instanced
    // flower gusts with the grass at no plumbing cost and with no chance of the
    // two drifting apart.
    shader.uniforms.uTime = voxelUniforms.uTime;
    shader.uniforms.uWind = voxelUniforms.uWind;
    shader.uniforms.uPlanetCenter = voxelUniforms.uPlanetCenter;
    shader.uniforms.uSwayLo = { value: loY };
    shader.uniforms.uSwayHi = { value: hiY };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        uniform float uWind;
        uniform vec3 uPlanetCenter;
        uniform float uSwayLo;
        uniform float uSwayHi;
      `)
      // Guarded, because a material with no instancing has no `instanceMatrix`
      // and this would not compile at all — cheaper to keep the guard than to
      // find that out the day someone reuses this on a plain Mesh.
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          mat4 mi = modelMatrix * instanceMatrix;
          mat3 rot = mat3(mi);
          float s2 = max(1e-8, dot(rot[0], rot[0]));
          vec3 iw = mi[3].xyz;
          vec3 up = normalize(iw - uPlanetCenter);
          vec3 ref = abs(up.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
          vec3 tang = normalize(cross(up, ref));
          float ph = dot(iw, vec3(0.62, 0.41, 0.77));
          float sway = sin(uTime * 1.9 + ph) * 0.6 + sin(uTime * 3.9 + ph * 1.7) * 0.25;
          // Squared, so the bend is a stem bending and not the whole plant
          // sliding sideways: the root is pinned and the head takes it all. The
          // billboard gets this from a per-vertex amount the mesher bakes in;
          // a shared geometry has to derive it, and its own height is the only
          // thing that survives being instanced two hundred times.
          float w = clamp((position.y - uSwayLo) / max(1e-4, uSwayHi - uSwayLo), 0.0, 1.0);
          w *= w;
          vec3 dW = (tang * (sway * 0.13) - up * (abs(sway) * 0.02)) * (w * uWind);
          transformed += (dW * rot) / sqrt(s2);
        }
        #endif
      `);
  };
  material.customProgramCacheKey = () => 'sway|' + prevKey.call(material);
  material.needsUpdate = true;
  return material;
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
        vec4 texelS;
      `)
      // A held or dropped block turns with the year too, or an autumn player
      // carries a piece of summer around in front of them.
      .replace('#include <map_fragment>', /* glsl */`
        texelS = texture(uMap, vec3(vTexUv, vLayer));
        vec4 texel = texelS;
        diffuseColor *= texel;
${SEASON_FRAG}
      `)
      // Emissive that follows the texture instead of flooding the whole cube.
      //
      // A block that gives off light has an albedo that is nearly black with
      // bright seams in it — that contrast *is* the look. In the world it
      // survives because the ambient reaching it is modest. In the hand there
      // is no voxel light at all, just a key and a fill, and those wash the
      // dark rock up to the same tan as the seams: the planet hearth came out
      // looking like sandstone. Raising the material emissive did not help,
      // because emissive is one colour across the whole surface, so it lifted
      // the dark parts by exactly as much and clipped the seams to white.
      //
      // The tile already knows which texels are hot. Gate the emissive on its
      // luminance and only the seams light up, so the contrast comes back
      // instead of being averaged away.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        float hotL = dot(texelS.rgb, vec3(0.2126, 0.7152, 0.0722));
        totalEmissiveRadiance *= smoothstep(0.34, 0.92, hotL);
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
