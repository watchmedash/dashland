// Voxel surface material: PBR standard shading fed by texture *arrays*, with
// voxel skylight / coloured block light, per-vertex AO, biome tint and wind.

import * as THREE from 'three';
import { F, R_MIN } from '../world/Constants.js';

/**
 * The moving lights' shadow volume: one byte per cell, opaque or not, for a
 * slab of the world around the player.
 *
 * ### Why a volume at all, and why it can be exact
 *
 * Every *placed* light is flood-filled through the voxel grid in Lighting.js and
 * stops dead at an opaque block, so a torch in a wall has never lit the far side
 * of it. The two moving lights — the flame in your hand and the brightest
 * dropped one near you — are plain point lights in the fragment shader with no
 * occlusion at all, so they shone straight through solid rock. This is what the
 * shader marches against to stop that.
 *
 * The obvious objection is that this planet is a cubesphere: cells are addressed
 * (f, i, j, k) and a world-axis-aligned 3D texture does not map to them. The way
 * out is that the equi-angular cube mapping is *exactly* linear in angle. Read
 * dirToFace and axisToGrid together and the whole of the tangential mapping is
 *
 *     ci = F/2 + (2F/PI) * atan(dot(d, R) / dot(d, N))
 *
 * for the face's own N and R. So a shader given one face's basis as three
 * uniforms can recover the continuous cell coordinate of any world point with
 * two atan calls and no approximation whatsoever — and, crucially, that stays
 * true *past the edge of the face*, where it produces exactly the extended
 * coordinates patchColumn uses. Filling the volume on the CPU through
 * patchColumn and reading it back through the formula above are exact inverses:
 * measured over 20 000 random samples spread 24 cells past a cube seam, zero
 * texel mismatches and a worst continuous error of 1.1e-13 cells.
 *
 * That is why this is not the drifting local-tangent-frame approximation it
 * looks like. The only approximation left is that the march interpolates
 * linearly in cell space rather than along the true world-space chord, which
 * follows the ground instead of cutting under it: measured over 13-cell rays,
 * 0.095 cells tangentially and 0.076 cells radially, both far under the half
 * cell that would change which block a sample lands in.
 *
 * ### Size
 *
 * 48 x 48 x 32 = 72 KB, so +-24 cells tangentially and +-16 radially around the
 * player. A torch reaches 13, so the hand light is always covered. A *dropped*
 * torch may sit up to DROP_LIGHT_RANGE (18) away and light things 13 further
 * out; past the volume the march fails open and that light behaves exactly as
 * it did before this existed. Failing open is deliberate — a light that
 * suddenly gains a shadow as you walk toward it is far less noticeable than one
 * that suddenly gains a black hemisphere as you walk away.
 *
 * ### What it costs
 *
 * Refilling the volume is 0.21 ms measured (2 304 patchColumn calls at 0.13 ms
 * and 73 728 block reads at 0.08), and it happens when the player has walked
 * three cells, so a few times a second at a sprint. The march is 8.6 texture
 * fetches per fragment on average across a torch's whole radius in a room with
 * a wall in it, 21 for the worst case of a fully lit 13-cell ray, on a 72 KB
 * texture that lives in cache — against the four mip-mapped array samples and
 * the full standard-material BRDF each of those fragments was already paying.
 * On top of that, two atan calls per fragment for its own position and two more
 * per flame that actually reaches it. Every bit of it is behind uOccActive,
 * which is 0 unless a flame is lit.
 */
export const OCC_NI = 48, OCC_NJ = 48, OCC_NK = 32;
/** Cell indices per radian: the 2F/PI above. Shared so the two cannot drift. */
export const OCC_ANG = 2 * F / Math.PI;

export const occupancyData = new Uint8Array(OCC_NI * OCC_NJ * OCC_NK);
export const occupancyTexture = (() => {
  const t = new THREE.Data3DTexture(occupancyData, OCC_NI, OCC_NJ, OCC_NK);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  // Nearest, and this is the one decision the whole thing turns on — see
  // OCC_BIAS in the shader for what linear filtering costs.
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
})();

export const voxelUniforms = {
  uMap: { value: null },
  uNormalMap: { value: null },
  uArm: { value: null },
  uCrack: { value: null },
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSkyColor: { value: new THREE.Color(0.42, 0.56, 0.78) },
  uSkyIntensity: { value: 1.0 },
  /**
   * How deep the night is: 0 by day, 1 at midnight, on the same night-squared
   * curve everything else nocturnal uses. Two things read it — the scotopic
   * pass at the end of the fragment, and the hemisphere shaping of the sky
   * fill — so it is stored raw and each applies its own strength.
   */
  uNight: { value: 0 },
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
  /**
   * The dome's own horizon and zenith colours, raw, written by `Sky.update`.
   *
   * Both of the sky uniforms above are *levels*: uSkyColor is desaturated so it
   * can serve as an ambient fill, uSkyReflect is a single averaged swatch. These
   * two are the gradient itself, and two things need the gradient rather than an
   * average — aerial perspective, which fades distant terrain into the sky
   * directly behind it, and the water fresnel, which shows you the sky in the
   * direction the surface actually points. See the note in `Sky.update`.
   */
  uSkyHorizon: { value: new THREE.Color(0.30, 0.53, 0.86) },
  uSkyZenith: { value: new THREE.Color(0.02, 0.12, 0.58) },
  // The turning year, applied to the biome tint a vertex already carries. See
  // SEASON_FRAG.
  uSeasonColor: { value: new THREE.Vector3(1, 1, 1) },
  uSeasonStrength: { value: 0 },
  // The only light in the world that moves — whatever the player is holding.
  uHandLightPos: { value: new THREE.Vector3() },
  uHandLightColor: { value: new THREE.Vector3() },
  uHandLightRadius: { value: 0 },
  /**
   * The second moving flame: the brightest light-emitting item lying on the
   * ground near you. Same shape as the hand light and the same shader path —
   * a dropped torch is a torch, and a torch that stops giving light the instant
   * it leaves your fingers is the sort of detail that quietly tells a player
   * the world is a set.
   *
   * One, not many. The grid handles every *placed* light; this exists for the
   * handful of seconds between dropping something and picking it up again, and
   * a second uniform triple is a great deal cheaper than a light manager.
   */
  uDropLightPos: { value: new THREE.Vector3() },
  uDropLightColor: { value: new THREE.Vector3() },
  uDropLightRadius: { value: 0 },
  // --- occlusion for those two, and only those two -----------------------------
  // See the OCC_* block above. uOccN/R/U are the cube-face basis the volume is
  // parameterised in; uOccOrg folds (F/2 - origin) and -(R_MIN + originK) into
  // one add so the shader's cell coordinates come out volume-local and small.
  // uOccActive is 0 whenever neither flame is lit, which is most frames, and
  // gates every atan and every texture fetch below.
  uOccTex: { value: occupancyTexture },
  uOccOrg: { value: new THREE.Vector3() },
  uOccN: { value: new THREE.Vector3(1, 0, 0) },
  uOccR: { value: new THREE.Vector3(0, 0, -1) },
  uOccU: { value: new THREE.Vector3(0, 1, 0) },
  uOccActive: { value: 0 },
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
    // water: gentle radial swell, hanging *below* the brim of its cell.
    //
    // Two things were wrong with this and they had the same symptom — water
    // moving through the blocks it meets.
    //
    // The swell was symmetric, so half the time the surface stood above the top
    // of its own cell. A shoreline is a water cell at level k beside a land
    // cell at k+1, and the surface quad's corner vertex is *shared* with that
    // land column, so the crest drove the sheet 8 cm up the inside of the beach
    // block and the trough pulled it back down again: water climbing and
    // draining off a solid face, in sync with the wave. At the crest it was
    // also exactly level with any block whose top is at the waterline, which is
    // a coplanar pair for the depth test to argue about.
    //
    // And every water vertex moved, not just the surface ones — the bottom edge
    // of a water column's wall was displaced by the same amount as its top, so
    // the whole body of water slid up and down through the seabed rather than
    // rippling on top of it.
    //
    // So: wAmt now says how much of the free surface this vertex is (the mesher
    // works it out per corner; the bed and the interior are 0, and it blends
    // rather than steps, so nothing can tear), and the swell is biased entirely
    // negative. WATER_SINK 0.09 with WATER_SWELL 0.067 over a swell that runs
    // to +-1.05 puts the surface between 2 and 16 cm below the brim: never
    // level with a neighbour's top face, never inside the cell above, and 14 cm
    // of peak-to-peak motion against the 15.8 it had before, so it reads the
    // same. Sitting a little under the brim is also simply what water looks
    // like — the block it fills is never quite full.
    const float WATER_SWELL = 0.067;
    const float WATER_SINK = 0.09;
    float h = sin(uTime * 1.05 + wp.x * 0.62 + wp.z * 0.48) * 0.5
            + sin(uTime * 1.63 - wp.z * 0.71 + wp.y * 0.39) * 0.35
            + sin(uTime * 2.31 + wp.x * 0.29 - wp.y * 0.55) * 0.2;
    transformed += up * (h * WATER_SWELL - WATER_SINK) * wAmt;
  } else if (wType > 2.5 && wType < 3.5) {
    // lava: a slow, heavy swell.
    //
    // There was no branch here at all, so lava was the one liquid whose surface
    // never moved a millimetre — perfectly flat, perfectly still and fully
    // opaque, which is a description of a block. It is a liquid and has to read
    // as one. Molten rock is viscous, so this is a longer wavelength at a third
    // of water's speed and half its amplitude: not a ripple, a heave.
    //
    // Biased below the brim and tapered by wAmt for exactly the reasons water
    // is, at its own scale: a lava lake meets a cliff the same way a lake does.
    const float LAVA_SWELL = 0.036;
    const float LAVA_SINK = 0.05;
    float h = sin(uTime * 0.40 + wp.x * 0.30 + wp.z * 0.23) * 0.6
            + sin(uTime * 0.58 - wp.z * 0.36 + wp.y * 0.18) * 0.4;
    transformed += up * (h * LAVA_SWELL - LAVA_SINK) * wAmt;
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
precision highp sampler3D;
uniform sampler2DArray uMap;
uniform sampler2DArray uNormalMap;
uniform sampler2DArray uArm;
uniform sampler2DArray uCrack;
uniform vec3 uSkyColor;
uniform float uSkyIntensity;
uniform float uNight;
/**
 * How much block light reached this fragment, written in LIGHTS_END and read by
 * NIGHT_SCOTOPIC at the very end. A plain mutable global, which in GLSL is
 * per-invocation and therefore safe; a varying could not carry it because the
 * value is only known after the lighting has run.
 */
float gBlockLum = 0.0;
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
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform float uTime;
uniform vec3 uSeasonColor;
uniform float uSeasonStrength;
uniform vec3 uHandLightPos;
uniform vec3 uHandLightColor;
uniform float uHandLightRadius;
uniform vec3 uDropLightPos;
uniform vec3 uDropLightColor;
uniform float uDropLightRadius;
uniform sampler3D uOccTex;
uniform vec3 uOccOrg;
uniform vec3 uOccN;
uniform vec3 uOccR;
uniform vec3 uOccU;
uniform float uOccActive;

/**
 * Where the block-light highlight starts to roll off, and where it stops.
 *
 * The report was that sand, red sandstone and pine logs go glaring beside a
 * torch while dirt and grass do not, and the first instinct — that it is simply
 * albedo, and therefore physics — is only half right. Measured off the baked
 * atlas (public/tiles/albedo.webp, linearised, alpha-masked), the peak linear
 * channel of each tile is: sand 0.839, red_sandstone 0.740, log_pine 0.553,
 * against dirt 0.272, stone 0.292, grass_top 0.129. Sand's red is 3.1x dirt's.
 *
 * What turns a 3x albedo ratio into a blowout is the *level* the block light
 * runs at. A torch is light 13 of 15, so vBlock peaks at 0.867; times
 * uBlockIntensity 5.0 and RECIPROCAL_PI that is an irradiance factor of 1.33 on
 * the red channel. The whole of noon — direct sun at intensity 1.62 through the
 * Lambert factor, plus the sky fill — comes to about 0.75 on the same channel.
 * A torch one cell away is therefore **1.8x brighter than the midday sun**, and
 * the tiles that show it are exactly the ones with somewhere to go: torch-lit
 * sand measured 244/205/124 on screen against 217/186/142 at noon, and
 * red_sandstone measured 253/152/49 — the red channel fully clipped, so the
 * texture had no detail left in it at all.
 *
 * So the surface is not lying about its albedo; the flame is lying about its
 * output. This is a shoulder on the block-light term alone: below the knee
 * nothing happens at all, above it the radiance rolls off exponentially toward
 * a ceiling. The numbers are chosen so the bright tiles land back at roughly
 * their noon value while a torch stays a torch on everything else — measured,
 * torch-adjacent: sand 244 -> 217, red_sandstone 253 -> 224, log_pine 232 ->
 * 213, against dirt 188 -> 186, stone 190 -> 186, planks 205 -> 198 and
 * grass_top 89 -> 89 (bit-identical; it never reaches the knee).
 *
 * ### Two levers tried and rejected
 *
 * Lowering uBlockIntensity, or HAND_LIGHT_GAIN in main.js, is the obvious knob
 * and is wrong twice over. It dims dirt and stone — which is most of what a
 * cave is made of, and which nobody complained about — and HAND_LIGHT_GAIN is
 * deliberately tied to uBlockIntensity so that a carried torch and a planted
 * one match; breaking that reintroduces the bug that constant was raised to
 * fix. The shoulder needs no change in main.js and leaves that invariant alone.
 *
 * Clamping per channel instead of scaling all three by one ratio was also tried
 * on paper and rejected: it compresses red harder than green, which walks the
 * colour toward white and takes the warmth out of firelight, which is the one
 * thing the fix was not allowed to cost. Scaling by the max channel keeps the
 * hue and the saturation exactly and only moves the value.
 */
const float BLOCK_KNEE = 0.28;
const float BLOCK_CEIL = 0.58;

/**
 * How much brighter the night sky is allowed to be *under open sky*.
 *
 * "Without a light source everything is pitch black except the tree leaves."
 * That is true and the numbers agree: at midnight uSkyIntensity is 0.29 and
 * uSkyColor has been dragged all the way to MOON_FILL, which puts open ground
 * at 0.005 linear on dirt and 0.004 on grass. The ACES toe has a slope of about
 * 0.1 down there, so those land on screen at 0/0/2 and 0/0/0 — literally black
 * — while leaves, at twice the albedo luminance and always facing the sky,
 * scrape 0/2/7 and are the only thing with any shape left.
 *
 * The lever cannot be uSkyIntensity, and that is the whole difficulty: sunAmt
 * has a 0.10 floor under it, deliberately, so that a sealed room at noon and an
 * unlit cave stay dark, and anything multiplied into uSkyIntensity is
 * multiplied into that floor as well. Raise it and you light every cave on the
 * planet. Raising the moon has the same defect for the same reason — a
 * directional with no shadow map goes straight through rock.
 *
 * vSun is the thing that actually knows the difference. It is voxel skylight,
 * so it is 1 on a meadow at midnight and 0 in a cave and 0 in a sealed room,
 * and squaring it means a cave mouth or the ground under a thick canopy gets a
 * fraction rather than the lot. Gating on vSun-squared *with no floor at all*
 * is what lets this be generous outdoors and provably nothing indoors.
 *
 * Measured at midnight on open ground, before -> after: dirt 0/0/2 -> 13/14/21,
 * grass_top 0/0/0 -> 4/9/14, stone 1/4/11 -> 25/30/45, log_pine 4/5/10 ->
 * 33/33/43, leaves_pine 0/2/7 -> 17/24/35. Noon dirt is 139/94/58 for scale, so
 * night is still an order of magnitude down; it is simply no longer zero.
 *
 * Applied to the sky fill and not to the ground bounce, on purpose: bounce is
 * light coming back off a brightly lit floor, and at midnight there is no such
 * floor to bounce off.
 */
const float NIGHT_OPEN_GAIN = 3.0;

/**
 * The same idea by day, for ground the canopy shadows.
 *
 * A forest floor at nine in the morning was dark enough to need a torch. That
 * is not the light field's doing: leaves cost sky light nothing, so a cell five
 * columns into a wood already stores the maximum, exactly like open meadow.
 * What takes the light is the shadow map, which the canopy blocks completely,
 * leaving the fragment standing on the sky fill alone at roughly a ninth of
 * what full sun gives it.
 *
 * 1.2 roughly doubles that shade while moving a sunlit meadow about a tenth,
 * because the meadow's ambient is a ninth of its total and its direct term is
 * untouched. Gated on openSky so it is exactly zero in a cave, in a sealed
 * room and under a slab roof, and faded out by uNight so it cannot brighten
 * dusk.
 *
 * No backticks in this comment, and none anywhere below: this block lives
 * inside a GLSL template literal, so a backtick ends the shader source mid
 * sentence and the file stops parsing as JavaScript.
 */
const float DAY_SHADE_GAIN = 1.2;

// --- moving-light occlusion --------------------------------------------------

const vec3 OCC_DIM = vec3(${OCC_NI}.0, ${OCC_NJ}.0, ${OCC_NK}.0);
const float OCC_ANG = ${OCC_ANG.toFixed(6)};

/**
 * How far off the shaded surface the march starts, in world units, along the
 * surface normal. This is the entire acne treatment and it is exact rather than
 * a tuned fudge.
 *
 * A fragment sits *on* a cell face. The cell behind it is solid by definition —
 * that is why the face was meshed — so a march that starts at the fragment
 * samples solid rock immediately and every lit surface goes black. Stepping
 * 0.66 units along the normal lands 0.66 cells into the cell in *front* of the
 * face, which is empty for the same reason, and nearest sampling then returns a
 * hard zero from it. Not "nearly zero": zero, for every fragment, on every
 * orientation, because the sample is unambiguously inside an empty cell. There
 * is no stripe pattern to be had.
 *
 * ### Why nearest and not linear filtering
 *
 * Linear was tried on paper first and is worse in exactly the place that must
 * not regress. Under linear filtering a solid cell bleeds half a cell into the
 * air above it, and the ray from a patch of ground to a torch *lying on that
 * ground* legitimately runs a fraction of a cell above the floor for its whole
 * length. Working the numbers for a dropped torch (0.25 above the surface) five
 * cells away: the far end of the ray picks up 0.22 of the floor it is skimming,
 * so a torch in the open would draw a dark ring around itself. That is precisely
 * the thing this change was forbidden to cost. Nearest reads that same ray as a
 * sequence of empty cells and returns exactly the light the fragment got before
 * this code existed. The softness linear would have bought is not worth it here
 * anyway: the grid light this is imitating is blocky, so a blocky shadow is the
 * matching look.
 *
 * 0.66 rather than 0.5 because 0.5 lands exactly on a cell *centre*, where the
 * corner guard below has no idea which way the ray came from, and because the
 * whole point is to be unambiguously inside one cell: two thirds of the way in
 * is far enough from both of that cell's boundaries that no accumulated float
 * error in the atan can put the sample back in the block.
 */
const float OCC_BIAS = 0.66;
/**
 * Ray step in cells. A solid cell is one cell thick, so anything under 1.0
 * cannot tunnel through a wall however it is crossed; 0.9 leaves a margin for
 * the sub-tenth-of-a-cell error in interpolating the ray in cell space.
 */
const float OCC_STEP = 0.9;
/**
 * How close to the flame the march stops, in cells.
 *
 * A flame is usually sitting on or against something. Sampling right up to it
 * means the block it rests on shadows everything the flame lights, so a dropped
 * torch would put out the floor it is lying on. Stopping short costs nothing
 * real: an occluder in the last cell and a half before the light is inside the
 * flame.
 */
const float OCC_NEAR = 1.5;
const int OCC_MAX_STEPS = 14;

/**
 * World point, and a small world-space offset from it, in volume-local
 * continuous cell coordinates.
 *
 * The offset is not a second lookup: it is the analytic derivative of the one
 * above it, which is worth having because the normal bias would otherwise cost
 * two more atan calls per fragment. For ci = C + K*atan(a/n) with a = dot(d,R)
 * and n = dot(d,N), and a world displacement e at radius r, the tangential part
 * of the displacement is e minus its radial component and
 *
 *     d(ci) = K * dot(e_perp, n*R - a*N) / (r * (n*n + a*a))
 *
 * which is three dots and a divide. The radial part is just dot(d, e), because
 * one cell is one unit radially everywhere.
 */
void occFrame(vec3 wp, vec3 woff, out vec3 cell, out vec3 dcell) {
  vec3 rel = wp - uPlanetCenter;
  float r = length(rel);
  vec3 d = rel / r;
  float n = dot(d, uOccN);
  float a = dot(d, uOccR);
  float b = dot(d, uOccU);
  cell = vec3(OCC_ANG * atan(a, n) + uOccOrg.x,
              OCC_ANG * atan(b, n) + uOccOrg.y,
              r + uOccOrg.z);
  vec3 ep = woff - d * dot(d, woff);
  dcell = vec3(OCC_ANG * dot(ep, n * uOccR - a * uOccN) / (r * (n * n + a * a)),
               OCC_ANG * dot(ep, n * uOccU - b * uOccN) / (r * (n * n + b * b)),
               dot(d, woff));
}

/**
 * Is this cell opaque? Anything outside the volume reads as empty, so the
 * effect fails open rather than dropping a black slab at the volume's edge.
 * textureLod rather than texture because this is called inside a loop with a
 * break in it, and an implicit derivative in non-uniform control flow is
 * undefined.
 */
float occAt(vec3 c) {
  vec3 uvw = c / OCC_DIM;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 0.0;
  return textureLod(uOccTex, uvw, 0.0).r;
}

/**
 * How much of a flame reaches a fragment: 1 in the open, 0 behind a wall.
 *
 * ### The corner guard
 *
 * A point-sampled march leaks along the join between two diagonally-placed
 * blocks. Take solid cells at (0,1) and (1,0) with air at (0,0) and (1,1): a ray
 * running along that diagonal is inside an empty cell before the corner and
 * inside an empty cell after it, so every sample says "clear" and a bright
 * hairline appears along a seam that is geometrically shut — the opening between
 * two cells that meet at an edge has zero area, so no light passes it at all.
 * Shrinking the step does not fix this. It only makes the hairline thinner,
 * because the ray is never *in* the blocking cells at any point along it.
 *
 * The first attempt was a proximity test — if a sample sits within 0.2 cells of
 * a boundary in two axes, tap across the nearer one — and it was measured and
 * thrown away: on the exact diagonal it closed nothing at all (41 leaking
 * fragments out of 41, unchanged), because whether any sample lands near the
 * corner depends entirely on where the ray happens to start.
 *
 * What works is to stop asking about positions and ask about *cells*. If the
 * cell index moved in more than one axis between two consecutive samples, the
 * ray crossed a cell edge and there is a cell it genuinely passed through that
 * was never sampled. Which one is decidable exactly, and cheaply: compare the
 * parametric distances to the two boundaries and take whichever is crossed
 * first. That is one step of a DDA, done only on the steps that need it.
 *
 * It is deliberately the *correct* cell rather than a conservative pair. Taking
 * both would shadow a cell the ray missed, and false shadow is the same artifact
 * as acne. On the exact diagonal the two crossings are simultaneous, either
 * answer is one of the two blocking cells, and the seam closes whichever way the
 * float comparison falls. Measured: 41 of 41 leaking before, 0 after.
 *
 * The tap is conditional and the loop returns the moment anything is opaque, so
 * a shadowed fragment costs a couple of fetches and only a fully lit one pays
 * for the whole ray.
 *
 * ### Why the two guards at the top are written backwards
 *
 * This function shipped once with a plain "if (reach < OCC_STEP) return 1.0",
 * and that read is a trap. Both guards exist to let a ray that is too short to
 * matter out early — but a comparison against a NaN is *false*, so a NaN ray
 * sails past a less-than test and gets marched. The consequences are not
 * subtle: length() of a bad segment defeats the near-field early-out, the
 * samples land wherever, occAt's own range test is also written with
 * comparisons and also passes NaN through, and the march reports the fragment
 * shadowed. The whole world goes dark, including the ground directly under the
 * player's feet, where occlusion should have been impossible.
 *
 * Negating the sense — return unless the ray is provably worth marching — makes
 * NaN take the early-out with everything else. The same reasoning covers the
 * length test: the fragment is within lrad *world units* of the flame, so the
 * same span in cells cannot exceed that by more than the normal bias and a
 * fraction of a cell of curvature. A longer one is not geometry, it is two ends
 * of a ray disagreeing about where they are, and the only safe answer to that
 * is "lit". Occlusion that quietly stops occluding is a missing shadow;
 * occlusion that fails the other way is an unplayable game.
 */
float occMarch(vec3 fcell, vec3 lcell, float lrad) {
  vec3 seg = lcell - fcell;
  float dist = length(seg);
  if (!(dist <= lrad + 2.0)) return 1.0;
  float reach = dist - OCC_NEAR;
  if (!(reach >= OCC_STEP)) return 1.0;
  vec3 dir = seg / dist;
  int steps = int(min(float(OCC_MAX_STEPS), ceil(reach / OCC_STEP)));
  float ds = reach / float(steps);
  vec3 prev = fcell;
  for (int s = 0; s < OCC_MAX_STEPS; s++) {
    if (s >= steps) break;
    vec3 p = fcell + dir * ((float(s) + 0.5) * ds);
    if (occAt(p) > 0.5) return 0.0;
    vec3 pc = floor(prev);
    vec3 dc = floor(p) - pc;
    if (abs(dc.x) + abs(dc.y) + abs(dc.z) > 1.5) {
      vec3 sv = p - prev;
      vec3 safe = mix(sv, vec3(1.0), lessThan(abs(sv), vec3(1e-6)));
      vec3 tv = mix(vec3(1e9), (pc + max(dc, vec3(0.0)) - prev) / safe,
                    notEqual(dc, vec3(0.0)));
      vec3 first = tv.x <= tv.y && tv.x <= tv.z ? vec3(1.0, 0.0, 0.0)
                 : (tv.y <= tv.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
      vec3 elbow = pc + vec3(0.5) + first * dc;
      if (occAt(elbow) > 0.5) return 0.0;
      if (abs(dc.x) + abs(dc.y) + abs(dc.z) > 2.5) {
        // All three planes crossed in one step, so *two* cells were skipped
        // rather than one. Adding this second tap is what took the march from
        // 1.37% disagreement with an exact DDA to none at all, and it is far
        // cheaper than the alternative of shortening the step: at 0.5 cells the
        // march is exact too, but every ray then costs nearly twice the fetches
        // to buy the same answer. This branch is taken by a handful of steps.
        vec3 rest = tv + first * 1e9;
        vec3 second = rest.x <= rest.y && rest.x <= rest.z ? vec3(1.0, 0.0, 0.0)
                    : (rest.y <= rest.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
        if (occAt(elbow + second * dc) > 0.5) return 0.0;
      }
    }
    prev = p;
  }
  return 1.0;
}

/**
 * One moving flame's contribution. Inverse-square with a linear cutoff at the
 * radius so it reaches zero instead of trailing a wash across the whole chunk,
 * and lambert-shaded off the surface normal so it wraps around geometry rather
 * than flooding it. The 0.22 floor lifts faces turned away out of pure black:
 * a real flame bounces off everything around it.
 *
 * fcell is the fragment in volume-local cell space with the normal bias already
 * applied; it is zero and unused when the volume is not live.
 *
 * ### The flame's own end of the ray is computed here, not handed in
 *
 * It was a uniform at first — the CPU knows the flame's position and can run
 * the same formula in double precision, so converting it there looked like two
 * free atan calls. It is not free, it is the bug that took a torch out of the
 * player's hand: the two ends of one ray were being produced by two different
 * pieces of code, in two languages, from two different sources of truth (the
 * CPU's volume record and the uniforms describing it), and nothing in the
 * shader could tell when they had drifted apart. They only have to disagree by
 * a couple of cells for every march to plough through the ground and report the
 * whole world in shadow.
 *
 * Computing both ends here, with the same function, from the same uniforms, in
 * the same invocation, makes agreement structural rather than something to be
 * maintained. The uniform it replaces is gone, so there is nothing left to go
 * stale. The cost is two atan calls, and only for a fragment that has already
 * passed the radius, distance and wrap tests.
 */
vec3 flameLight(vec3 lpos, vec3 lcol, float lrad, vec3 nrm, vec3 world, vec3 fcell) {
  if (lrad <= 0.0) return vec3(0.0);
  vec3 toL = lpos - world;
  float dist = length(toL);
  if (dist >= lrad) return vec3(0.0);
  float fall = 1.0 - dist / lrad;
  // Wrapped lambert that reaches *zero* on a face turned away from the flame.
  //
  // This was mix(0.22, 1.0, lambert) with lambert clamped at zero, so a surface
  // pointing directly away from the light still collected 22% of it. That is
  // the "I put a torch on the ground, towered up four blocks, and the top of the
  // tower is lit" report: the top face points at the sky, the flame is beneath
  // it, and the floor term lit it through the whole column of stone. Raising the
  // hand light's gain from 2.1 to 5.0 to match a planted torch more than doubled
  // how obvious that was.
  //
  // The floor existed for a real reason — a face at a grazing angle should not
  // snap to black, because a real flame bounces off everything around it — so
  // this keeps a soft shoulder instead of deleting it: the wrap is still lit a
  // little past the terminator (0.11 at exactly edge-on) and falls to nothing
  // by the time the surface has turned properly away.
  float wrap = clamp((dot(nrm, toL / max(dist, 0.001)) + 0.12) / 1.12, 0.0, 1.0);
  if (wrap <= 0.0) return vec3(0.0);
  // The other half of the same report. The wrap above stops a flame lighting a
  // face that is turned away from it; this stops it lighting a face that is
  // turned *toward* it through a wall. Gated on wrap so a fragment the flame
  // could not reach anyway never pays for a march.
  if (uOccActive > 0.5) {
    // The zero offset is the same call the fragment end makes with the normal
    // bias; the dcell half folds away at compile time.
    vec3 lcell, unusedOffset;
    occFrame(lpos, vec3(0.0), lcell, unusedOffset);
    if (occMarch(fcell, lcell, lrad) <= 0.0) return vec3(0.0);
  }
  // Linear, not squared, because that is what the grid does. A placed torch's
  // light is a flood fill that loses one level per cell, so its brightness at
  // distance d is (reach - d) / reach - linear. This term was fall * fall, so a
  // carried torch at half its reach delivered 0.25 where the identical torch in
  // the wall delivered 0.50: "why is torch not as bright when handheld". The
  // reach and the gain were already derived from the placed torch so the two
  // could not drift; the curve between them was the one thing still disagreeing.
  return lcol * (wrap * fall);
}
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
 * How much of the block's biome tint this texel takes, 1 by default.
 *
 * The tint is per BLOCK and a grass block's side face is two materials in one
 * tile: living turf across the top sixth and the same soil as a dirt block under
 * it. Multiplying the whole face by the biome grass colour turned that soil
 * olive (plains: 140/102/70 becomes 77/80/28) while the dirt block against it
 * stayed brown. The mask rides in the arm atlas's alpha, which is otherwise
 * unused and 255 everywhere — so every other tile is unaffected, and unlike the
 * albedo's alpha it is not also the cut-out mask that the held/inventory block
 * renderer alpha-tests against. Written in scripts/bake-textures.mjs.
 */
float tintMask = 1.0;

// --- aerial perspective ------------------------------------------------------
//
/**
 * How much stronger the distance haze is than the density handed in.
 *
 * The fog was, in practice, switched off, and the arithmetic is not close. The
 * curve is f = 1 - exp(-(d * dist)^2) and main sets d = 0.0013 in fair weather.
 * On this planet the visible range is bounded at both ends and both ends are
 * known: standing on flat ground the sea horizon is sqrt(2 * eye * R_SEA) ~ 33
 * units away, the tallest terrain the generator can raise stays visible to ~190,
 * and chunks stop being meshed at CHUNK_LOAD_DIST = 150. At 150 units the old
 * density gives f = 0.037. **Three and a half percent, at the furthest thing on
 * screen.** The far hills were rendered at essentially full contrast and full
 * saturation, the near ground was too, and nothing in the frame said which was
 * which — which is most of why a world with a genuinely curved, genuinely close
 * horizon read as flat.
 *
 * 3.6 puts f at 0.38 at the load distance and 0.03 at 34 units. So the ground
 * you are standing on is untouched (a third of one percent at ten units), the
 * ridge behind the next valley is slightly softened, and the rim of the planet
 * sits a third of the way into the sky it is silhouetted against. Weather still
 * multiplies through it exactly as before: a storm's 1.9 makes that 0.83 at the
 * horizon and 0.11 underfoot-to-mid-distance, which is a fog rather than a hint.
 *
 * Set to 1.0 to get precisely the old picture back; nothing else here depends on
 * it. The whole term is four multiplies and an exp, on a fragment that has
 * already run a full standard-material BRDF.
 */
const float AERIAL_GAIN = 3.6;
/**
 * How far the haze leans off the palette's fog colour toward the sky's own
 * horizon colour.
 *
 * They are not the same thing and the difference is the point. "fog" is
 * art-directed as a *veil* — at noon it is 0xc4d9f2, paler and less saturated
 * than the sky. The colour distant terrain should actually approach is the sky
 * immediately behind it, which is the dome's horizon band, 0x96c0ee. Sitting
 * between them means the far rim of the planet fades into very nearly the exact
 * colour it is silhouetted against, so the ground stops ending at a hard line
 * and starts becoming sky — and at dusk the same term turns the far hills the
 * colour of the sunset instead of a neutral grey-brown.
 */
const float AERIAL_HORIZON_MIX = 0.55;
/**
 * Forward inscatter: the haze goes warm when you look toward the sun.
 *
 * A single tinted veil in every direction is fog; haze that brightens toward the
 * light and stays cool away from it is atmosphere, and it is the whole of why a
 * low sun looks like a low sun. Gated on the *view* direction rather than on the
 * surface, because scattering happens in the air between you and the surface and
 * has nothing to do with which way the surface faces.
 *
 * uSunColor already carries the weather's 'sun' factor, so a storm gets no warm
 * glow, and it is the palette's sun — near black once the sun is properly down —
 * so this fades itself out at night without a second gate. Bounded at
 * AERIAL_SUN_GAIN of the way to that colour, at the exact centre of the sun and
 * nowhere else: pow 4 puts it at half strength 33 degrees off.
 */
const float AERIAL_SUN_POW = 4.0;
const float AERIAL_SUN_GAIN = 0.30;

const vec3 AERIAL_LUMA = vec3(0.2126, 0.7152, 0.0722);

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

/**
 * Signed offset of a world point from a cell centre, measured in cells.
 *
 * This is the same exact inverse of the cubesphere mapping that occFrame uses,
 * with one difference: the face basis is not a uniform, it is derived from the
 * cell centre itself, so it needs nothing from the CPU beyond the centre that
 * uBreakPos already carries. The mapping is
 *
 *     ci = (2F/PI) * atan(dot(d, R), dot(d, N))
 *
 * for that face's own N and R, and it is exact rather than a local tangent
 * approximation. Both points are measured in the *break cell's* frame, which
 * stays valid past a cube seam because the extended face coordinates are what
 * patchColumn uses on the CPU as well. Only the difference of the two angles is
 * ever formed, so nothing depends on the F/2 offset and there is no
 * cancellation against a coordinate that runs to 464.
 *
 * The ratios are scale invariant, so neither vector is normalised. The radial
 * component is a plain difference of lengths, because one cell is exactly one
 * unit radially everywhere.
 *
 * A cell's own geometry lands in [-0.5, 0.5] on every axis, exactly. Every
 * corner of a quad is a grid corner or a grid corner scaled radially, and every
 * interior point of a quad is a positive combination of its corners, which the
 * atan ratio turns into a weighted mean of the corners' own tangents - so a
 * face never leaves the cell it belongs to, and touches the boundary only along
 * the edge it shares with its neighbour.
 */
vec3 cellOffset(vec3 p, vec3 cen) {
  vec3 rel = p - uPlanetCenter;
  vec3 c = cen - uPlanetCenter;
  vec3 m = abs(c);
  vec3 N, R, U;
  if (m.x >= m.y && m.x >= m.z) {
    N = vec3(c.x >= 0.0 ? 1.0 : -1.0, 0.0, 0.0);
    R = vec3(0.0, 0.0, -N.x);
    U = vec3(0.0, 1.0, 0.0);
  } else if (m.y >= m.z) {
    N = vec3(0.0, c.y >= 0.0 ? 1.0 : -1.0, 0.0);
    R = vec3(1.0, 0.0, 0.0);
    U = vec3(0.0, 0.0, -N.y);
  } else {
    N = vec3(0.0, 0.0, c.z >= 0.0 ? 1.0 : -1.0);
    R = vec3(N.z, 0.0, 0.0);
    U = vec3(0.0, 1.0, 0.0);
  }
  float nc = dot(c, N), nr = dot(c, R), nu = dot(c, U);
  float pn = dot(rel, N), pr = dot(rel, R), pu = dot(rel, U);
  return vec3(OCC_ANG * (atan(pr, pn) - atan(nr, nc)),
              OCC_ANG * (atan(pu, pn) - atan(nu, nc)),
              length(rel) - length(c));
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
  vec3 blockTint = mix(vec3(1.0), vTint, tintMask);
  vec3 seasonBase = diffuseColor.rgb * blockTint;
  float living = clamp(length(vec3(1.0) - blockTint) * 4.0, 0.0, 1.0);
  float seasonLum = dot(seasonBase, vec3(0.299, 0.587, 0.114));
  vec3 rehued = mix(seasonBase, seasonLum * uSeasonColor, uSeasonStrength);
  diffuseColor.rgb = mix(seasonBase, rehued, living);
`;

const MAP_FRAG = /* glsl */`
  vec4 texel = texture(uMap, vec3(vTexUv, vLayer));
  diffuseColor *= texel;
  // Solid faces only. A cut-out tile's arm alpha is its own business and the
  // liquid path has no biome tint to mask, so both leave tintMask at 1.
  tintMask = texture(uArm, vec3(vTexUv, vLayer)).a;
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
// The tint attribute carries (depth, shoreline, identity) for liquids rather
// than a biome colour. See WATER_OCEAN in WorldGen for what the identity is and
// why it arrives here in a vertex attribute instead of in a block id.

const LIQUID_MAP_FRAG = /* glsl */`
  float wDepth = vTint.x;
  float wShore = vTint.y;
  /*
   * How mirror-like this water is. Read again by the fresnel block after
   * <opaque_fragment>, which is why it is declared out here rather than inside
   * the branch below: a variable declared in that else goes out of scope at its
   * closing brace and the reflection would not compile.
   *
   * It exists because the sky reflection is the strongest single thing this
   * shader does and it was the same strength on every body of water. That is
   * right for a tarn and wrong for everything murky: peat water and mineral
   * water scatter at the surface instead of reflecting it, and a sheet of
   * falling water has no flat surface to reflect with at all. Without this a
   * marsh seen across its length is a mirror with brown paint behind it, which
   * reads exactly like the sea again.
   */
  float wGloss = 1.0;

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
  /*
   * ---- what kind of water this is ----------------------------------------
   *
   * Everything below this line used to be four constants: one shallow colour,
   * one deep colour, one ramp and one alpha range, for every drop of water on
   * the planet. So the only thing that made a marsh look different from a tarn
   * was how deep it happened to be, which is the same axis the ocean already
   * spends on its own shelf-to-abyss gradient. A wide shallow marsh and a
   * three-block bay were literally the same pixels.
   *
   * Four things per kind, and they are ordered so that the one you notice first
   * is not the hue:
   *
   *   dScale  is CLARITY, and it is in units of the ENCODED depth, not blocks.
   *           The mesher sends min(1, d / 7) (Mesher.js, liquidDepth), so the
   *           whole scale runs out at seven blocks and dScale 0.10 closes up
   *           inside one. What that means, and it cost this a verification
   *           pass to find: on water deeper than seven blocks wDepth is pinned
   *           at 1.0 and EVERY dScale up to 1.0 gives the same saturated ramp.
   *           A measured seven-block tarn came out identical at 0.62 and at
   *           1.00 (patch mean 90,138,201 against 90,138,200). Past seven
   *           blocks dScale cannot make water clear. Only alpha can.
   *   aLo/aHi is the same axis in the blend, and has to move with dScale or the
   *           colour arrives and the bed shows straight through it anyway. It
   *           is also the ONLY lever left on water at the bottom of the depth
   *           scale, which is why the tarn's clarity is spent here.
   *   wGloss  scales the sky reflection and the sun glint.
   *   the two colours come last on purpose.
   *
   * The values are 0..7 exactly as WorldGen writes them. A column with no
   * identity sends 0, which is the ocean, so there is nothing to fall back to.
   */
  int ws = int(vTint.z + 0.5);
  vec3 shallow = vec3(0.13, 0.55, 0.60);
  vec3 deep    = vec3(0.02, 0.16, 0.34);
  float dScale = 0.42;
  float aLo = 0.46, aHi = 0.90;
  float foamK = 1.0;
  float bodyGain = 1.12;

  if (ws == 1) {
    // Pond. Standing lowland water over mud: green rather than blue, and it
    // closes up faster than the sea because there is silt in it.
    //
    // "Green rather than blue" was true of the constants and false of the
    // frame. Shot at noon on a pinned seed, the pond came out at hue 193 --
    // cyan, four degrees off the ocean -- because the body colour is only part
    // of what lands: the surface texture is blue-green, the skylight is blue,
    // and the reflection term adds more of the same. So the blue in the
    // constants had to come down further than "green rather than blue" reads,
    // and the gloss with it, since a pond is not a mirror. Measured hue 193 ->
    // 171 from above and 198 -> 171 from the bank.
    shallow = vec3(0.22, 0.46, 0.24); deep = vec3(0.07, 0.20, 0.08);
    dScale = 0.30; aLo = 0.56; aHi = 0.93; foamK = 0.7; wGloss = 0.55;
  } else if (ws == 2) {
    // Tarn. Snowmelt on bare rock: the clearest water on the planet and the
    // coldest colour. You can see the floor of a five-block tarn, and past
    // that it goes black rather than blue.
    //
    // That was the intent and the frame did not have it. A real tarn on a
    // pinned seed is seven blocks deep, so wDepth sits at 1.0 across almost
    // its whole surface and dScale had nothing left to shape -- the water was
    // a flat opaque sheet at alpha 0.95 with no slate visible anywhere, and
    // was indistinguishable from the plunge basin, whose entire identity is
    // being the tarn WITHOUT the clarity. Raising dScale changed the frame by
    // one RGB unit. Dropping the alpha ceiling is what actually opened it: at
    // aHi 0.68 the submerged ledges and floor read through the water while the
    // deep centre still darkens, and the two kinds separate on sight.
    // aLo 0.20 keeps the shallow rim reading as clear water rather than
    // jumping to deep blue within a block of the shore.
    shallow = vec3(0.11, 0.44, 0.55); deep = vec3(0.01, 0.06, 0.19);
    dScale = 1.00; aLo = 0.20; aHi = 0.68; foamK = 1.0; wGloss = 1.15;
  } else if (ws == 3) {
    // Marsh. Peat-stained, and the one body of water on the planet you cannot
    // see into at all: brown-green, opaque within a block and nearly matte, so
    // it reads as a surface rather than as a volume. No foam, because a marsh
    // has no wave to break and a white rim round it read as a lagoon.
    //
    // The clarity was already right -- measured, this is the most opaque water
    // on the planet, patch contrast 4.9 against 36 for a tarn -- and the hue
    // was not. It came out at hue 168, a green-teal, and swung to 195 seen
    // from the bank rather than from above, which is a body of water with no
    // fixed identity at all. Two causes, both fixed here. The surface texture
    // and the skylight are blue-green, so a constant that merely leans brown
    // arrives green; red has to be run up hard, and the ratios below are what
    // land on olive rather than what look like olive in the source. And a
    // marsh at wGloss 0.45 was still mixing in enough sky to account for the
    // whole swing between the two views. Measured hue 168 -> 77 from above,
    // 195 -> 156 from the bank, and the saturation drop (0.94 -> 0.36) is the
    // "nearly matte" that was being claimed and not delivered.
    shallow = vec3(0.80, 0.20, 0.06); deep = vec3(0.62, 0.12, 0.03);
    dScale = 0.10; aLo = 0.78; aHi = 0.94; foamK = 0.0; wGloss = 0.22;
    bodyGain = 1.30;
  } else if (ws == 4) {
    // Oasis. Clean water over pale sand under a desert sun. The turquoise is
    // not a stylisation, it is what a bright sand bed does to clear water, and
    // it is most of the reason an oasis is worth walking to.
    shallow = vec3(0.22, 0.74, 0.72); deep = vec3(0.03, 0.34, 0.46);
    dScale = 0.55; aLo = 0.34; aHi = 0.88; foamK = 0.8; wGloss = 1.1;
  } else if (ws == 5) {
    // Plunge basin. Deep, cold and full of air off the fall standing in it: a
    // tarn's colour with a tarn's clarity taken back out.
    shallow = vec3(0.16, 0.52, 0.55); deep = vec3(0.02, 0.13, 0.26);
    dScale = 0.34; aLo = 0.46; aHi = 0.93; foamK = 1.35; wGloss = 0.95;
  } else if (ws == 6) {
    // Hot spring. Mineral water is MILKY, and that is the whole read: bright
    // rather than dark, opaque within a block, and barely reflective. Against
    // snow it has to be the warm thing in the frame, so the gain is high enough
    // that the pool stays luminous in shade.
    shallow = vec3(0.46, 0.78, 0.71); deep = vec3(0.26, 0.60, 0.60);
    dScale = 0.16; aLo = 0.84; aHi = 0.96; foamK = 0.35; wGloss = 0.5;
    bodyGain = 1.34;
  } else if (ws == 7) {
    // A waterfall, and the one column of the pool it lands in. Aerated water is
    // white rather than blue and reflects nothing.
    shallow = vec3(0.62, 0.79, 0.85); deep = vec3(0.52, 0.70, 0.80);
    dScale = 0.50; aLo = 0.64; aHi = 0.84; foamK = 3.0; wGloss = 0.30;
    bodyGain = 1.20;
    /*
     * The one thing that actually makes it read as falling rather than as a
     * blue wall: a third sample scrolling hard along +v.
     *
     * On a side quad u runs tangentially and v runs up the column, so adding
     * time to v samples further up the texture every frame and the pattern
     * travels DOWN. Squeezed to 0.45 across so the streaks come out long, and
     * mixed over the two ambling surface layers rather than replacing them,
     * which keeps the top face of the plunge pool off the conveyor belt.
     */
    vec2 uvF = vTexUv * vec2(1.7, 0.45) + vec2(0.0, uTime * 1.35);
    surf = mix(surf, texture(uMap, vec3(uvF, vLayer)).rgb, 0.72);
  }

  float dRamp = smoothstep(0.0, dScale, wDepth);
  vec3 body = mix(shallow, deep, dRamp);
  diffuseColor.rgb = surf * body * bodyGain;
  diffuseColor.a = mix(aLo, aHi, dRamp);

  // Foam where the water actually touches land. Tight and bright: a hard rim
  // is what tells the eye the surface has an edge in the world rather than
  // being cut off, and it hides the geometric join with the shore.
  float ripple = texture(uMap, vec3(vTexUv * 2.6 + vec2(uTime * 0.05, uTime * 0.02), vLayer)).r;
  float ripple2 = texture(uMap, vec3(vTexUv * 5.1 - vec2(uTime * 0.03, uTime * 0.06), vLayer)).r;
  // Keep it to the first block of depth. wShore is only a coarse "some
  // neighbour is land" flag, so pairing it with a wide depth window turned
  // every shallow bay into a white field — the rim has to be narrow in depth
  // to stay a rim.
  // A waterfall is foam everywhere and not only where it meets land, so its
  // edge term ignores the shoreline flag. Everything else keeps the narrow rim,
  // scaled by how much white that kind of water has any business having.
  float edge = ws == 7 ? 1.0 : (wShore * (1.0 - smoothstep(0.0, 0.13, wDepth)));
  float foam = clamp(0.72 * foamK, 0.0, 0.85)
    * smoothstep(0.50, 0.92, edge * (0.42 + ripple * 0.62 + ripple2 * 0.4));
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

/**
 * The Purkinje shift: colour drains out of a scene as it gets dark.
 *
 * This is the answer to "the tree leaves are visible at night like it's
 * morning", and it is not a brightness problem — which is exactly why two
 * passes at the light levels failed to fix it. Measured on a torch-free
 * midnight frame, the canopy came out around (50, 123, 69): *correctly* dim in
 * absolute terms, since the sky ambient at that moment is 0.28, but at full
 * daylight saturation. A saturated green at a tenth of daylight brightness
 * still reads as a green leaf, and a canopy of them reads as a lit one.
 *
 * Two knobs were ruled out by experiment before arriving here. Taking a further
 * 34% off the night sky ambient moved the foliage median by 9%; setting the
 * moon to zero moved it by nothing at all. The level was never the problem.
 * The eye's own answer is that rod vision carries no colour, so a moonlit
 * forest is grey-blue whatever colour it is at noon.
 *
 * **Gated on how dark the pixel already is**, which is the whole reason this
 * does not flatten the game: a torchlit face, a lava sheet or a lit doorway is
 * photopic and keeps every bit of its colour, while the unlit canopy behind it
 * drains. Without that gate, lighting a torch at midnight would light a grey
 * world — worse than the complaint it set out to fix.
 *
 * The residual tint is cool rather than neutral grey. Rods peak toward blue,
 * and a flat greyscale night reads as a black-and-white photograph of a day.
 */
const NIGHT_SCOTOPIC = /* glsl */`
  if (uNight > 0.001) {
    float sLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    // Gated on *what lit it*, not on how bright it came out. Anything a flame
    // reached stays photopic and keeps its colour; anything lit only by the
    // night sky drains. See the note where gBlockLum is written.
    //
    // 0.82 rather than a full drain: taking the last of the colour reads as a
    // monochrome filter rather than as darkness, and a little green left in the
    // grass is what says the grass is still green, you simply cannot quite see
    // it.
    float scoto = uNight * 0.82 * (1.0 - smoothstep(0.02, 0.35, gBlockLum));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(sLum) * vec3(0.74, 0.86, 1.18), scoto);
  }
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
  //
  // The night floor, and the one term in this shader that can tell "outdoors
  // under an open sky" from "inside a sealed room" — see NIGHT_OPEN_GAIN.
  //
  // vSun squared, with no floor beneath it, so the gate is exactly zero
  // wherever the voxel skylight is: uNight is 0 for every sun more than about
  // 6 degrees up, so noon is untouched by construction, and openSky is 0 in a
  // cave and in a sealed room, so those are untouched at every hour. Both have
  // to fail for this to do anything, which is why it can afford to be large.
  float openSky = vSun * vSun;
  float nightLift = 1.0 + uNight * NIGHT_OPEN_GAIN * openSky;
  // And the same trick by day, for the forest floor.
  //
  // "It's daytime but still way too dark especially when trees are dense, I
  // have to actually place torches along the way even though it's morning."
  // Measured, the light field was not the problem: leaves cost sky light
  // nothing, so a cell five columns deep in a wood already stores the full
  // fifteen, exactly like open meadow. There was no value the lighting pass
  // could raise. What darkens it is that the canopy blocks the sun's shadow
  // map, so the fragment loses all of its direct term and is left standing on
  // the sky fill alone, which is about a ninth of what full sun gives it.
  //
  // So lift the fill, gated on openSky exactly as the night lift is. That gate
  // is what keeps it honest: it is zero in a cave, in a sealed room and under
  // a slab roof, so none of them move at all. A sunlit meadow barely moves
  // either, because its ambient is only a ninth of its total, while shade
  // roughly doubles. Deliberately not applied to sunAmt itself, which would
  // light caves.
  float dayLift = 1.0 + DAY_SHADE_GAIN * openSky * (1.0 - uNight);
  vec3 skyTinted = uSkyColor * uSkyIntensity * sunAmt * nightLift * dayLift;
  vec3 skyFill = mix(skyTinted, vec3(dot(skyTinted, vec3(0.2126, 0.7152, 0.0722))), 0.34);
  // ground bounce, strongest on downward-facing surfaces
  vec3 upDir = normalize(vWorld - uPlanetCenter);
  float downFace = clamp(-dot(normal, upDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 bounce = uBounceColor * uSkyIntensity * sunAmt * downFace * 0.6;
  // Hemisphere shaping: sky light lands hardest on upward faces.
  //
  // Deeper at night, and that is an answer to "does every leaf get hit by the
  // moon from all angles?" — no, and it should not look as if it does. By day
  // the sky is a bright dome scattering light from every direction at once, so
  // a shallow 0.62 floor is right: an underside really is nearly as lit as a
  // top. At night almost all of that scattering is gone and what is left
  // arrives from one direction, so an underside should fall away much further.
  // At 0.30 the canopy gets a lit top and a dark belly and reads as shaped
  // rather than as uniformly glowing foliage.
  //
  // Done here rather than by raising the moon, which is the other obvious lever
  // and the wrong one: moonLight is a directional with no shadow map, so
  // every bit of extra intensity leaks straight into caves. This term is gated
  // by sunAmt, which is voxel skylight — it cannot reach anywhere the sky
  // does not.
  float skyFacing = clamp(dot(normal, upDir) * 0.5 + 0.5, 0.0, 1.0);
  skyFill *= mix(mix(0.62, 0.30, uNight), 1.0, skyFacing);

  reflectedLight.indirectDiffuse += diffuseColor.rgb * (skyFill + bounce) * aoTotal * RECIPROCAL_PI;

  // What you are carrying, and what is lying on the floor near you.
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
  //
  // Gathered here, *above* where it used to be added, because the shoulder
  // below has to see the flames and the grid as one light. Rolling them off
  // separately would let a player standing beside a planted torch while holding
  // one collect two sub-knee contributions that sum to a blowout, which is the
  // exact case the shoulder exists for.
  // Where this fragment sits in the occlusion volume, computed once and shared
  // by both flames: two atan calls, and only when there is a flame lit at all.
  // With no torch in the world — which is most of the daylight hours of most
  // frames — uOccActive is 0, this whole block folds away and the shader is
  // bit-identical to what it was.
  vec3 occFragCell = vec3(0.0);
  if (uOccActive > 0.5) {
    vec3 nb;
    occFrame(vWorld, normal * OCC_BIAS, occFragCell, nb);
    occFragCell += nb;
  }
  vec3 moving = flameLight(uHandLightPos, uHandLightColor, uHandLightRadius, normal, vWorld, occFragCell)
              + flameLight(uDropLightPos, uDropLightColor, uDropLightRadius, normal, vWorld, occFragCell);

  // All block light, grid and flames together, with a highlight shoulder on the
  // pair. See BLOCK_KNEE. The AO weighting stays on the grid term only and off
  // the moving one, exactly as before: a flame you are holding is not occluded
  // by the crease it is shining into.
  vec3 blockRad = (diffuseColor.rgb * vBlock * uBlockIntensity * mix(0.65, 1.0, aoTotal)
                 + diffuseColor.rgb * moving) * RECIPROCAL_PI;
  // Scaled by the max channel rather than clamped per channel, so the roll-off
  // moves the value and leaves the hue and saturation of firelight alone.
  float blockPeak = max(blockRad.r, max(blockRad.g, blockRad.b));
  if (blockPeak > BLOCK_KNEE) {
    float over = (blockPeak - BLOCK_KNEE) / (BLOCK_CEIL - BLOCK_KNEE);
    float rolled = BLOCK_KNEE + (BLOCK_CEIL - BLOCK_KNEE) * (1.0 - exp(-over));
    blockRad *= rolled / blockPeak;
  }
  reflectedLight.indirectDiffuse += blockRad;

  // Remember how much of this surface a *flame* is responsible for, for the
  // scotopic pass at the end of the shader. It has to be captured here because
  // this is the only place the two are still separate — by the time anything
  // downstream sees the fragment they are one colour, and a moonlit leaf and a
  // torchlit plank are indistinguishable by brightness alone. That is not a
  // guess: the first version of NIGHT_SCOTOPIC gated on final luminance and
  // left the canopy exactly as green as before, because at midnight a leaf
  // under open sky *is* as bright as ground beside a torch.
  //
  // Deliberately the *pre-shoulder* irradiance, and deliberately not scaled by
  // RECIPROCAL_PI: the thresholds NIGHT_SCOTOPIC gates on (0.02 to 0.35) are
  // calibrated in this raw scale, and both of them sit well below BLOCK_KNEE
  // anyway, so measuring before or after the roll-off makes no difference to
  // any fragment that is near the gate. Leaving it untouched is what keeps this
  // change out of the scotopic pass entirely.
  //
  // Both moving flames count as block light here too, or the ground your own
  // torch is lighting would drain of colour while the identical patch beside a
  // planted torch kept it. Firelight is firelight wherever it is standing.
  gBlockLum = dot(vBlock * uBlockIntensity + moving, vec3(0.2126, 0.7152, 0.0722));
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

/**
 * The mining crack, on the one cell being mined and on nothing else.
 *
 * This used to be a *sphere* around the cell centre — distance < 0.95 — and a
 * sphere of that radius is far larger than a cell. A cell is one unit radially
 * and (r * PI/2) / F across, which is 0.954 units at the waterline, so the
 * nearest point of a neighbour's top face sits 0.69 away and a third of that
 * neighbour's face came out cracked. It failed at the other end too: at the
 * terrain ceiling a cell is 1.18 across and its own corners are 0.97 out, so
 * near the top of a mountain the sphere clipped the corners off the block you
 * were actually hitting.
 *
 * cellOffset answers the question the test was always trying to ask — which
 * cell is this fragment in — exactly, in cell units, and correctly across a
 * cube seam. The bound is a half cell per axis with a hair of slack, and the
 * slack is not for float error: a quad is flat and the cell it bounds is
 * curved, so the middle of a face sags inward by r * (1 - cos(PI/4F)) — 9.8e-4
 * of a cell at the terrain ceiling, measured over every face of a cell at both
 * ends of the radial range. 0.502 clears that with room for the GPU's atan, and
 * costs at most 2 mm of the neighbour's face along the edge the two already
 * share, which is under a pixel from any range you can mine from.
 *
 * The distance guard stays, demoted to what it is good at: rejecting the whole
 * rest of the screen before anything pays for four atan calls. 1.9 clears the
 * largest cell's half diagonal (0.97) with room for a swaying plant, and the
 * outer test is uniform, so a frame in which nothing is being mined costs
 * exactly what it did before.
 *
 * Known and deliberate: a cross plant's billboard is 0.52 units of half width
 * against a 0.477 half cell, and the wind sway moves it further, so the outer
 * sliver of a *swaying* tuft does not take the crack. Those are one-hit blocks
 * whose overlay is on screen for a couple of frames. A door is two cells and
 * only the half you are hitting cracks now, which is what "exactly this cell"
 * means.
 */
const BREAK_FRAG = /* glsl */`
  if (uBreakStage >= 0.0 && distance(vWorld, uBreakPos) < 1.9) {
    vec3 dCell = cellOffset(vWorld, uBreakPos);
    if (all(lessThanEqual(abs(dCell), vec3(0.502)))) {
      vec4 cr = texture(uCrack, vec3(fract(vTexUv), uBreakStage));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, cr.rgb, cr.a * 0.92);
    }
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

  // Aerial perspective. See AERIAL_GAIN for why this is not the fog it replaces.
  vec3 aerialDir = dist > 1e-4 ? (vWorld - uCamPos) / dist : vec3(0.0, 1.0, 0.0);
  vec3 haze = mix(uFogColor, uSkyHorizon, AERIAL_HORIZON_MIX);
  haze = mix(haze, uSunColor,
             AERIAL_SUN_GAIN * pow(max(dot(aerialDir, uSunDir), 0.0), AERIAL_SUN_POW));
  float aerialD = uFogDensity * AERIAL_GAIN;
  float f = 1.0 - exp(-aerialD * aerialD * dist * dist);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, clamp(f, 0.0, 1.0));

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
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHTS_END)
      // Last thing before the frame leaves the material, so it also catches the
      // liquid path's reflection and glint below: a lake has to lose its colour
      // along with the land, or it becomes the one blue thing in a grey night.
      .replace('#include <dithering_fragment>', NIGHT_SCOTOPIC + '\n#include <dithering_fragment>');

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
          //
          // Shaped by where the reflected ray actually points, which is the
          // difference between a lake and a sheet of coloured glass. uSkyReflect
          // is one averaged swatch, so every water fragment on the planet
          // reflected the same colour at every angle — and the angles are not
          // close: look straight down and you are looking at the zenith, look
          // across a lake and you are looking at the horizon, and by day the
          // horizon is nearly four times the luminance of the zenith (measured
          // off the noon palette: 0.50 against 0.13 linear).
          //
          // Only the *level* is taken from the gradient, and only within
          // SKY_SHAPE_MIN..MAX of the swatch. The hue stays uSkyReflect's,
          // because main tunes that with a night floor and an overcast lean that
          // this has no business overriding, and the clamp is what keeps a
          // grazing reflection from running away with the horizon's brightness
          // at dawn. The one visible consequence is the one worth having: water
          // seen across its length brightens toward the sky it meets, so the far
          // shore of a lake and the sea at the rim of the planet stop reading as
          // a flat blue cut-out.
          const float SKY_SHAPE = 0.75;
          const float SKY_SHAPE_MIN = 0.60;
          const float SKY_SHAPE_MAX = 1.70;
          vec3 rDir = reflect(vDir, normal);
          vec3 wUp = normalize(vWorld - uPlanetCenter);
          // The same 0.42 curve the dome shader draws its gradient with, so the
          // sky in the water and the sky above it are the same sky.
          vec3 grad = mix(uSkyHorizon, uSkyZenith,
                          pow(clamp(dot(rDir, wUp), 0.0, 1.0), 0.42));
          float shape = clamp(dot(grad, AERIAL_LUMA)
                              / max(dot(uSkyReflect, AERIAL_LUMA), 1e-4),
                              SKY_SHAPE_MIN, SKY_SHAPE_MAX);
          vec3 refl = uSkyReflect * mix(1.0, shape, SKY_SHAPE) * 0.88;
          // wGloss is what stops every body of water being the same mirror.
          // See where it is set, above <map_fragment>.
          gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, fres * 0.88 * wGloss);

          // Sun glint. The single strongest cue that a surface is liquid, and
          // the thing whose absence made this read as painted-on colour. It
          // rides the wave-perturbed normal, so it breaks into a scattering
          // path across the chop instead of one clean disc. Gated on skylight
          // so it does not shine out of a roofed cave.
          //
          // Two lobes, not one. pow 190 is a mirror: it is the specular of a
          // surface with roughness ~0.1 and it draws the sun as a small hard
          // disc that only ever lands on the handful of wave crests whose normal
          // happens to point exactly right. What is missing from that is the
          // *path* — the broad column of light that runs from a low sun across
          // the water toward the viewer, which is the single most recognisable
          // thing about water at dawn and dusk and is not made of highlights, it
          // is made of the surface being slightly rough over a wide angle.
          //
          // SUN_PATH_POW 22 is roughly roughness 0.3; at a tenth of the tight
          // lobe's weight it is invisible at midday (fresnel is 0.05 looking
          // down at your feet, so the term lands at 0.014) and takes over
          // completely at a grazing angle with a low sun, which is exactly the
          // shot. Gated on vSun with the glint, so neither shines in a cave.
          const float SUN_PATH_POW = 22.0;
          const float SUN_PATH_GAIN = 0.35;
          vec3 half3 = normalize(uSunDir - vDir);
          float ndh = clamp(dot(normal, half3), 0.0, 1.0);
          gl_FragColor.rgb += uSunColor * fres * vSun * wGloss
                            * (pow(ndh, 190.0) * 9.0 + pow(ndh, SUN_PATH_POW) * SUN_PATH_GAIN);

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
 * The same stand-in for cutout art that is *not* voxel geometry.
 *
 * `createCutoutNormalMaterial` above only covers meshes carrying the voxel
 * `aux` attribute, because it reads its alpha out of the tile array by layer.
 * That leaves everything else in the scene that is a hole-punched quad, and the
 * scene has more of those than it looks: a dropped item with no 3D model falls
 * out of the world as two crossed cards wearing its inventory icon (see
 * `game/Drops.js`), and any glTF material authored with alphaMode MASK — which
 * is how a mob or the player character would carry a fringe, a feather or a
 * leaf — arrives as a MeshStandardMaterial with `alphaTest` set. All of those
 * were writing their *whole quad* into the AO G-buffer: exactly the block-shaped
 * shadow panel that the voxel version was written to kill, on a 0.46-cell card
 * that spins, against an AO radius of 0.9 cells.
 *
 * One of these per source material, cached by the caller. `map`'s alpha is the
 * cutout — `alphaMap` is not consulted, because nothing in this project uses one
 * and reading both would cost a second sampler on every fragment of the prepass.
 * The texture is sampled with the raw `uv` attribute rather than through
 * `<uv_vertex>`: MeshNormalMaterial has no map slot at all, so USE_UV is never
 * defined for it and `vUv` does not exist. That also means a source map with a
 * non-identity `repeat`/`offset` would be sampled untransformed; nothing here
 * has one, and a wrong *alpha* lookup only costs a hole in the AO buffer rather
 * than a visible artifact in the frame.
 *
 * @param {THREE.Material} src the material being stood in for
 */
export function createMappedNormalMaterial(src) {
  // glTF's alphaCutoff defaults to 0.5 and GLTFLoader copies it through, so a
  // MASK material always brings its own number; the fallback is only for a
  // material that somehow set `transparent` without one.
  const alphaTest = src.alphaTest > 0 ? src.alphaTest : 0.5;
  const mat = new THREE.MeshNormalMaterial({ side: src.side });
  mat.blending = THREE.NoBlending;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCutMap = { value: src.map };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCutUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCutUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <packing>', /* glsl */`
        #include <packing>
        uniform sampler2D uCutMap;
        varying vec2 vCutUv;
      `)
      .replace('#include <clipping_planes_fragment>', /* glsl */`
        #include <clipping_planes_fragment>
        if (texture2D(uCutMap, vCutUv).a < ${alphaTest.toFixed(3)}) discard;
      `);
  };
  // Keyed on the cutoff because it is baked into the source string above, not
  // passed as a uniform — two materials with different cutoffs are two programs.
  // Everything sharing a cutoff shares one.
  mat.customProgramCacheKey = () => 'mapCutoutNormal|' + alphaTest.toFixed(3);
  return mat;
}

/**
 * Give an *instanced* model the wind — and the voxel block light — a cross
 * billboard gets for free.
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
 * ### The other thing a billboard got for free
 *
 * Block light. A meshed cross carries its cell's coloured block light in the
 * `blockLight` attribute and LIGHTS_END adds it; a modelled flower had no such
 * attribute and no way to fill one, so a flower beside a torch was unlit by it.
 * `Mesher` now ships the sample and `BlockModels` writes it into a per-instance
 * `aBlockLight`, and this is where it is consumed — this function is already
 * the one patch that only ever lands on an instanced clone, so it is the only
 * place the attribute is safe to declare. (Declaring it on the shared WAM
 * material would put it on every stick and ingot in the game, exactly as the
 * sway branch would have.)
 *
 * It is **added**, not multiplied, and it is the only light term here: the sun
 * half of a modelled flower's lighting already works through the scene's
 * shadow map and entity fill (see `BlockModels._fit`) and is untouched by this.
 * Additive is also what makes an instance with no sample — a chunk that has not
 * arrived, a flower planted a frame ago — render as it did before rather than
 * black. `BlockModels.sync` writes zero for those, and zero is a no-op.
 *
 * `uBlockIntensity` is the terrain's own live uniform, not a copy, so a flower
 * and the grass block it stands on answer a torch by the same amount and can
 * never drift apart. The AO factor the terrain applies is dropped: a model has
 * no per-vertex AO to apply it with, and inventing one would be a guess.
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
    shader.uniforms.uBlockIntensity = voxelUniforms.uBlockIntensity;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        uniform float uWind;
        uniform vec3 uPlanetCenter;
        uniform float uSwayLo;
        uniform float uSwayHi;
        varying vec3 vInstBlock;
        #ifdef USE_INSTANCING
        attribute vec3 aBlockLight;
        #endif
      `)
      // Behind the same guard as the sway, and for a second reason as well as
      // the first: a non-instanced draw has no such attribute, and an undeclared
      // one reads as an unspecified default rather than failing loudly. Zero is
      // what we want there, so it is written explicitly.
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        vInstBlock = aBlockLight;
        #else
        vInstBlock = vec3(0.0);
        #endif
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

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uBlockIntensity;
        const float BLOCK_KNEE = 0.28;
        const float BLOCK_CEIL = 0.58;
        varying vec3 vInstBlock;
      `)
      // After three has finished with the light loop, alongside where the
      // terrain's LIGHTS_END adds its own `vBlock` term, and with the same
      // RECIPROCAL_PI Lambert factor — otherwise a torch-lit flower would be pi
      // times brighter than the torch-lit dirt underneath it.
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        // The same highlight shoulder the terrain applies, for the same reason
        // and with the same constants — see BLOCK_KNEE in the voxel material.
        // Without it a flower beside a torch was lit on a different curve from
        // the dirt it is planted in: below the knee they agreed exactly, and
        // above it the flower kept climbing while the ground rolled off, so the
        // brightest thing in a torchlit meadow was the petals. A sun daisy's
        // albedo peaks at 0.291, so this only ever binds on a flower with a
        // flame right beside it, which is precisely the case that looked wrong.
        //
        // Scaled by the max channel, again like the terrain, so only the value
        // moves and firelight keeps its hue.
        vec3 instRad = diffuseColor.rgb * vInstBlock * uBlockIntensity * RECIPROCAL_PI;
        float instPeak = max(instRad.r, max(instRad.g, instRad.b));
        if (instPeak > BLOCK_KNEE) {
          float instOver = (instPeak - BLOCK_KNEE) / (BLOCK_CEIL - BLOCK_KNEE);
          instRad *= (BLOCK_KNEE + (BLOCK_CEIL - BLOCK_KNEE) * (1.0 - exp(-instOver))) / instPeak;
        }
        reflectedLight.indirectDiffuse += instRad;
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
        float tintMask = 1.0;
      `)
      // A held or dropped block turns with the year too, or an autumn player
      // carries a piece of summer around in front of them.
      .replace('#include <map_fragment>', /* glsl */`
        texelS = texture(uMap, vec3(vTexUv, vLayer));
        vec4 texel = texelS;
        diffuseColor *= texel;
        // Same per-texel tint mask the world uses, or the grass block in the
        // hand keeps the olive sides the one in the ground has lost.
        tintMask = texture(uArm, vec3(vTexUv, vLayer)).a;
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
