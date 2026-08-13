// Post-processing stack: ambient occlusion → bloom → tone map → grade → AA.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { createCutoutNormalMaterial, createMappedNormalMaterial } from './VoxelMaterial.js';

/**
 * Where the lens effects sit, and why they are all smaller than they were.
 *
 * These three — vignette, grain, chromatic aberration — are the cheapest way to
 * make a render look processed and the cheapest way to make it look amateur, and
 * the difference is entirely in the amount. They were set at 0.42 / 0.028 /
 * 0.0016, which is *strong*: the old vignette multiplied the screen corners by
 * 0.61 (smoothstep(0.18, 0.92, r2 * 1.6) reaches 0.93 at the corner, times
 * 0.42), so nearly two fifths of the light was taken out of the outer quarter of
 * every frame. On a game whose whole subject is a bright curved horizon that is
 * a filter fighting the picture.
 *
 * Halved, roughly, and they now read as lens rather than as effect. Every one is
 * still here — a perfectly clean frame reads as a tech demo — they are simply
 * back under the threshold where you notice them individually.
 *
 * The corner falls to 0.76 instead of 0.61. Set VIGNETTE back to 0.42 to see
 * exactly what was there before; nothing else in the grade depends on it.
 */
const VIGNETTE = 0.26;
const GRAIN = 0.015;
const ABERRATION = 0.0009;

/**
 * The response curve, which is the part that was missing rather than overdone.
 *
 * The frame arrives here already through ACES (OutputPass) at exposure 1.05.
 * ACES is a sensible default and it does two things to a hand-painted palette
 * that have to be answered: it desaturates as it approaches the shoulder, and it
 * is deliberately neutral, so nothing in the chain ever says what this game's
 * colour is *for*.
 *
 * SATURATION answers the first. It is up from 1.08, but it is no longer flat:
 * HIGHLIGHT_DESAT eases it back toward 1.0 as a pixel approaches white, so the
 * midtones — grass, stone, water, sky — get the lift and a sunlit cloud edge or
 * a lava crack does not go neon on its way to clipping. Net effect on a midtone
 * is +14% saturation; on anything above 0.8 luma it is about +5%.
 *
 * SHADOW_TINT / HIGHLIGHT_TINT answer the second, and are the only opinionated
 * thing in this file: warm light, cool shade. It is the oldest trick in outdoor
 * painting and it is what a sun and a blue sky physically do, so it holds at
 * every hour — at night the whole frame is in the shadow half and gets the cool
 * end, which is also correct. Both are within about 1% of luminance 1 (0.990 and
 * 1.010 against the Rec.709 weights), so this rotates hue and costs no exposure:
 * turning it off by setting both to vec3(1.0) should change the brightness of
 * nothing.
 */
const SATURATION = 1.14;
const CONTRAST = 1.06;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: VIGNETTE },
    uGrain: { value: GRAIN },
    uAberration: { value: ABERRATION },
    uSaturation: { value: SATURATION },
    uContrast: { value: CONTRAST },
    uLift: { value: new THREE.Vector3(0.004, 0.006, 0.012) },
    uDamage: { value: 0 },
    uUnderwater: { value: 0 },
    /**
     * Buried: eye inside a sink block. `xyz` is the colour of the stuff, `w` is
     * how much of the screen it has.
     *
     * The one state in the game where the camera is deliberately inside opaque
     * geometry, so it is the one place a screen tint is doing real work rather
     * than decorating. A cell's faces are culled from the inside and its
     * neighbours' shared faces are culled against it, so with nothing here a
     * player at the bottom of a pool sees a torn view of the level from the
     * wrong side. This is not a mood; it is what stops that being visible.
     */
    uBuried: { value: new THREE.Vector4(0, 0, 0, 0) },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uSaturation, uContrast, uDamage, uUnderwater;
    uniform vec3 uLift;
    uniform vec4 uBuried;
    uniform vec2 uResolution;
    varying vec2 vUv;

    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    const float HIGHLIGHT_DESAT = 0.62;
    const vec3 SHADOW_TINT = vec3(0.965, 0.990, 1.065);
    const vec3 HIGHLIGHT_TINT = vec3(1.045, 1.005, 0.955);

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      if (uUnderwater > 0.5) {
        uv += vec2(sin(uv.y * 24.0 + uTime * 1.6), cos(uv.x * 21.0 + uTime * 1.3)) * 0.0016;
      }

      // radial chromatic aberration
      float ab = uAberration * (0.25 + r2 * 2.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ab).b;

      // grade
      float l = dot(col, LUMA);
      // Saturation, eased off as a pixel approaches white. A flat multiplier
      // pushes anything already near the top of a channel straight into a
      // clipped primary — sunlit cloud edges, the lava crack, the sun disc —
      // and those are exactly the pixels with no headroom to be more colourful
      // in. See SATURATION.
      float satW = 1.0 - HIGHLIGHT_DESAT * smoothstep(0.55, 1.0, l);
      col = mix(vec3(l), col, mix(1.0, uSaturation, satW));
      col = (col - 0.5) * uContrast + 0.5;
      col += uLift * (1.0 - l);

      // Warm light, cool shade. Multiplicative, so it is a hue rotation that
      // leaves black at black and does not lift the toe; both tints sit at
      // luminance ~1 so it costs no exposure. See SHADOW_TINT.
      float tl = clamp(dot(col, LUMA), 0.0, 1.0);
      col *= mix(SHADOW_TINT, HIGHLIGHT_TINT, smoothstep(0.06, 0.72, tl));

      // Buried. Before the vignette rather than after it, so the corners of a
      // packed screen still fall away and the picture keeps a shape — a flat
      // fill edge to edge reads as the renderer having died.
      if (uBuried.w > 0.001) {
        // Strongest at the middle, where the stuff is pressed against the lens,
        // and it never quite reaches 1: a hint of the world stays visible at
        // the rim, which is what tells the player they are looking at something
        // rather than at nothing.
        float pack = uBuried.w * (1.0 - 0.22 * smoothstep(0.02, 0.25, r2));
        col = mix(col, uBuried.rgb, pack);
      }

      // vignette
      float vig = 1.0 - uVignette * smoothstep(0.18, 0.92, r2 * 1.6);
      col *= vig;

      // damage flash
      if (uDamage > 0.001) {
        float edge = smoothstep(0.08, 0.55, r2);
        col = mix(col, vec3(0.62, 0.03, 0.05), edge * uDamage * 0.85);
      }

      // film grain
      float g = hash(uv * uResolution + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.0 - l * 0.6);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostFX {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.ao=true] whether the GTAO pass runs. See `setAO`.
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    const size = renderer.getSize(new THREE.Vector2());

    this.gtao = new GTAOPass(scene, camera, size.x, size.y);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.updateGtaoMaterial({
      radius: 0.9, distanceExponent: 1.6, thickness: 0.6,
      scale: 1.05, samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false,
    });
    this.gtao.blendIntensity = 0.85;
    this._patchGtaoCutout();
    this.composer.addPass(this.gtao);
    this.setAO(opts.ao !== false);

    this.bloom = new UnrealBloomPass(size, 0.42, 0.72, 0.86);
    this.composer.addPass(this.bloom);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // SMAA before the grade, not after it.
    //
    // The order used to be grade → SMAA, which put an edge-detecting blur on top
    // of film grain, chromatic aberration and a vignette. Two things went wrong
    // with that and both are one-way:
    //
    // - SMAA's first pass thresholds the *luma difference* between neighbouring
    //   pixels to decide where an edge is. Grain is a per-pixel luma difference
    //   by construction, so a grained frame is a frame with a false edge
    //   candidate at every pixel: the pass does more work and blends along
    //   gradients that are noise rather than geometry.
    // - Whatever it does blend, it blends the grain away with it. Grain that is
    //   then averaged with its neighbours is grain at a fraction of the amplitude
    //   it was authored at, which is part of why the number was up at 0.028.
    //
    // Running SMAA on the clean tone-mapped image and laying the lens effects
    // over the result costs nothing — it is the same three passes in the same
    // colour space, since both still sit after OutputPass — and the grain lands
    // at the amplitude it says it does.
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uResolution.value.copy(size);
    this.composer.addPass(this.grade);
  }

  /**
   * Turn the ambient-occlusion pass on or off. The single biggest lever in the
   * frame, and the reason the mobile preset exists.
   *
   * GTAOPass does not sample the beauty buffer — it renders **the entire scene a
   * second time** into a depth/normal G-buffer (`_renderOverride` below calls
   * `renderer.render`), so it costs roughly what drawing the world costs, every
   * frame, before any AO arithmetic happens. Measured on an RTX 5060 at a phone
   * viewport (393x852 @ dpr 2), forest, seed 4242, baselines retaken either side:
   *
   *   base        p50 14.4ms   1137 calls   1.37M tris
   *   AO off      p50 10.3ms    784 calls   0.81M tris     -29%
   *   base again  p50 14.7ms   1143 calls   1.37M tris
   *
   * 38% of the frame's draw calls and 43% of its triangles, for one buffer. The
   * frame is CPU-bound on submitting those calls, not on shading them — cutting
   * the pixel count to a quarter (renderScale 0.5) moved p50 by 0.4ms, i.e. not
   * at all — so this is the only lever of its size that exists here.
   *
   * A `Pass.enabled` flag rather than rebuilding the composer without the pass,
   * because a settings row has to be able to flip this mid-session and building
   * a GTAOPass compiles shaders and allocates two screen-sized targets: a hitch
   * every time, in exchange for a few MB while it is switched off. The targets
   * stay allocated and stay sized (`composer.setSize` visits disabled passes),
   * which is what makes turning it back on free.
   */
  setAO(on) {
    this.gtao.enabled = !!on;
  }

  /**
   * Teach the GTAO G-buffer prepass what the real materials know.
   *
   * GTAOPass draws its depth/normal buffer through `scene.overrideMaterial`,
   * which replaces *every* material with one plain MeshNormalMaterial. That
   * material has no alphaTest and no idea about our sampler2DArray, so grass
   * crosses and leaf blocks wrote solid full-quad depth into the AO buffer.
   * The result was a world full of ghostly block-shaped shadow panels, most
   * obvious over grass. `overrideMaterial` is all-or-nothing, so instead of
   * using it we swap each mesh's material for the frame and give the meshes
   * that need one a stand-in that performs the same discard.
   *
   * Three cases, in the order the swap tests them:
   *
   * 1. **Voxel cutout** — chunk geometry (it carries `aux`) whose material has
   *    an alphaTest: grass, flowers, leaves, ladders. `createCutoutNormalMaterial`
   *    repeats the array-texture discard *and* the mesher's wind, so the AO
   *    geometry is where the drawn geometry is.
   * 2. **Mapped cutout** — anything else hole-punched: a dropped item with no 3D
   *    model (two crossed icon cards, alphaTest 0.35, ~0.46 cells across and
   *    spinning) and any glTF MASK material a mob or the player might wear. Same
   *    bug, no `aux` to read, so `createMappedNormalMaterial` samples the source
   *    material's own `map`. One per source material, kept in a WeakMap so the
   *    stand-in dies with the material it stands in for.
   * 3. **Everything else** — the pass's own MeshNormalMaterial. This is already
   *    right for more than it looks: three compiles that material per object
   *    type, so `<project_vertex>` picks up `instanceMatrix` for the modelled
   *    flowers and `<skinning_vertex>` picks up the skeleton for the mobs and the
   *    player character. They land in the G-buffer where they are drawn.
   *
   * ### What is deliberately *not* corrected here
   *
   * **Vertex sway on the instanced flower models.** `applyInstancedSway` bends a
   * modelled flower and the stand-in does not, so its G-buffer silhouette is the
   * rest pose. Measured rather than assumed: the bend is `0.13 * |sway|` in the
   * model's unit-height space with `|sway| <= 0.85`, scaled by the kind's 0.62,
   * and weighted by a squared height ramp — so ~0.07 cells at the very tip of
   * the stem and near zero over most of it, against a GTAO radius of 0.9 cells.
   * Under a twelfth of the sample radius, on an object 0.6 cells tall. Fixing it
   * would need a second sway-patched normal material per swaying kind, carrying
   * the geometry's root and head heights as uniforms — which live in
   * `BlockModels`, not here. The rest pose is also the conservative error: the
   * flower still occludes, roughly where it is, instead of not at all.
   *
   * **The liquid swell**, for the same reason: `up * h * 0.075` peak, and water
   * is a large visible surface, so dropping it out of the G-buffer entirely
   * would change the AO along every shoreline. Wrong by 7cm beats absent.
   */
  _patchGtaoCutout() {
    const cutoutNormal = createCutoutNormalMaterial(0.42);
    this.cutoutNormalMaterial = cutoutNormal;
    /** @type {WeakMap<THREE.Material, THREE.Material>} case 2, built on demand */
    const mappedNormals = new WeakMap();
    const swapped = [];
    const hidden = [];

    // The swap visits every mesh in the scene each frame — several hundred chunk
    // meshes plus ~22 part meshes per animal — so it has to be allocation-free.
    // It used to build `[o.material]` and run a `.some()` closure per mesh per
    // frame; with a herd nearby that was ~1500 throwaway arrays and closures
    // every frame, and it measured at 0.68 ms. Whether a mesh is a cutout is a
    // property of its geometry and material, not of the frame, so the answer is
    // memoised on the mesh and only recomputed when either is swapped out (chunk
    // meshes keep their material and replace their geometry on every remesh).
    let overrideMat = null;

    /** The stand-in this mesh needs, or null for the pass's plain material. */
    const proxyFor = (mat, geo) => {
      // The voxel proxy reads the tile array through the `aux` attribute, so it
      // only stands in for voxel geometry that actually carries one.
      if (geo && geo.attributes.aux !== undefined) {
        if (Array.isArray(mat)) {
          for (let i = 0; i < mat.length; i++) {
            if (mat[i] && mat[i].alphaTest > 0) return cutoutNormal;
          }
          return null;
        }
        return mat.alphaTest > 0 ? cutoutNormal : null;
      }
      // A multi-material mesh would need an array of stand-ins matching its draw
      // groups; nothing cut out in this game is one (the split-group models are
      // tools and ores, all solid), so it is not worth carrying that array.
      if (Array.isArray(mat) || !(mat.alphaTest > 0) || !mat.map) return null;
      let p = mappedNormals.get(mat);
      if (p === undefined) {
        p = createMappedNormalMaterial(mat);
        mappedNormals.set(mat, p);
      }
      return p;
    };

    const swap = (o) => {
      if (!o.isMesh) {
        // Points, lines and sprites, hidden for the prepass rather than stood
        // in for.
        //
        // The material swap only reaches meshes, and this replacement of
        // `_renderOverride` never sets `scene.overrideMaterial` — so everything
        // else drawable rendered into the normal target *with its own material*,
        // painting raw colour over the packed normals. Weather is the loud case:
        // rain and snow are a `Points` field around the camera with
        // `depthWrite: false` and ordinary blending, so a storm smeared thousands
        // of grey dots across the whole G-buffer and the AO read a garbage normal
        // at every one of them. The spark puffs, the stars and the block
        // highlight are the same thing on a smaller scale.
        //
        // Hiding them is correct and not a hole: none of them writes depth in the
        // beauty pass either (the highlight's LineSegments does, but it is a
        // one-pixel wireframe), so what you actually see through a raindrop is the
        // terrain behind it — which is precisely the geometry the G-buffer is now
        // left describing.
        if (o.visible && (o.isPoints || o.isLine || o.isSprite)) {
          o.visible = false;
          hidden.push(o);
        }
        return;
      }
      const mat = o.material;
      if (!mat) return;
      swapped.push(o, mat);
      const geo = o.geometry;
      if (o._gtaoMat !== mat || o._gtaoGeo !== geo) {
        o._gtaoMat = mat;
        o._gtaoGeo = geo;
        o._gtaoProxy = proxyFor(mat, geo);
      }
      o.material = o._gtaoProxy || overrideMat;
    };

    this.gtao._renderOverride = function (renderer, overrideMaterial, renderTarget, clearColor, clearAlpha) {
      overrideMat = overrideMaterial;
      renderer.getClearColor(this._originalClearColor);
      const originalClearAlpha = renderer.getClearAlpha();
      const originalAutoClear = renderer.autoClear;

      renderer.setRenderTarget(renderTarget);
      renderer.autoClear = false;

      clearColor = overrideMaterial.clearColor || clearColor;
      clearAlpha = overrideMaterial.clearAlpha || clearAlpha;

      if (clearColor !== undefined && clearColor !== null) {
        renderer.setClearColor(clearColor);
        renderer.setClearAlpha(clearAlpha || 0.0);
        renderer.clear();
      }

      swapped.length = 0;
      hidden.length = 0;
      this.scene.traverse(swap);

      // This prepass fills a depth/normal G-buffer with unlit materials, none of
      // which sample a shadow map — but `renderer.render` re-renders the sun's
      // shadow map on every call regardless. That was the single most expensive
      // thing in the frame: a second full 2048² shadow pass, ~740 extra draw
      // calls and ~220k extra triangles, for a buffer that cannot read it. The
      // main RenderPass runs before us in the composer chain, so the map is
      // already up to date for this frame. Suppress the redundant rebuild via
      // autoUpdate/needsUpdate rather than `shadowMap.enabled`, which is a
      // program-compile parameter and would trigger a full shader recompile.
      const shadowAuto = renderer.shadowMap.autoUpdate;
      const shadowNeeds = renderer.shadowMap.needsUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;

      try {
        renderer.render(this.scene, this.camera);
      } finally {
        renderer.shadowMap.autoUpdate = shadowAuto;
        renderer.shadowMap.needsUpdate = shadowNeeds;
        for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
        for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
        swapped.length = 0;
        hidden.length = 0;
      }

      renderer.autoClear = originalAutoClear;
      renderer.setClearColor(this._originalClearColor);
      renderer.setClearAlpha(originalClearAlpha);
    };
  }

  /**
   * @param {number} w CSS width
   * @param {number} h CSS height
   *
   * Sizes are handed over in CSS pixels and the composer scales them by its own
   * pixel ratio, exactly like WebGLRenderer.setSize. Two things used to go wrong
   * here and both made the render-scale slider a lie:
   *
   * - the composer's pixel ratio was only ever set once, in the constructor, so
   *   moving the slider resized the canvas but left every offscreen buffer at
   *   the old resolution — the scene still rendered full-size and only the final
   *   blit got cheaper.
   * - `composer.setSize` already forwards the *effective* (ratio-multiplied)
   *   size to every pass; re-calling setSize on GTAO/bloom/SMAA afterwards with
   *   the CSS size overwrote that, so on any HiDPI display those passes ran at
   *   the wrong resolution against full-size buffers.
   */
  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // Floor to match the real drawing buffer. A fractional render scale makes
    // w * pr fractional, and anything deriving a texel size from it would be
    // fractionally off against a buffer WebGL has already truncated.
    this.grade.uniforms.uResolution.value.set(Math.floor(w * pr), Math.floor(h * pr));
  }

  render(dt, state) {
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uDamage.value = state.damage;
    this.grade.uniforms.uUnderwater.value = state.underwater ? 1 : 0;
    // `state.buried` is [r, g, b, amount] or absent. Absent is the case on
    // every frame but the handful a player spends under a pool, so it costs a
    // single compare the rest of the time.
    const bu = this.grade.uniforms.uBuried.value;
    if (state.buried) bu.set(state.buried[0], state.buried[1], state.buried[2], state.buried[3]);
    else bu.w = 0;
    if (state.underwater) {
      this.grade.uniforms.uSaturation.value = 0.86;
      this.grade.uniforms.uLift.value.set(0.0, 0.02, 0.05);
    } else {
      this.grade.uniforms.uSaturation.value = SATURATION;
      this.grade.uniforms.uLift.value.set(0.004, 0.006, 0.012);
    }
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }
}
