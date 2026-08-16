// Animated GLB models for the animals and the hostile.
//
// The mobs used to be built out of boxes in code, with a hand-written animator
// swinging four leg pivots. That produced a decent gait, but every species had
// to be described limb by limb and adding one meant writing a new build
// function. These models arrive with their animation already authored — eight
// clips each, keyed on named nodes rather than a skeleton — so the job here is
// to load each one once, hand out cheap clones, and drive a mixer.
//
// Assets: Kenney "Cube Pets" and "Blocky Characters", both CC0.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();

/**
 * url -> { scene, clips, height, footOffset }. `scene` is a *prototype*: it is never
 * added to the world, only cloned, so geometry and materials stay shared across
 * every instance of that species — one upload for a whole herd. The flip side is
 * that nothing may ever dispose them; releasing a mob only detaches it.
 */
const protos = new Map();

/** True once `url` is loaded and `instantiate` will succeed. */
export const isReady = (url) => protos.has(url);

/**
 * A species whose body is a box, registered as a prototype like any other.
 *
 * A slime is a cube. Borrowing the pack's mushroom for one was a bad call - it
 * is a mushroom, and no tint makes it not be. This costs one geometry and one
 * material for the whole species, needs no file, and goes through exactly the
 * same instantiate/scale/tint path as a loaded model, so nothing downstream has
 * to know the difference.
 *
 * No clips, which `play` already tolerates: it looks up the action by name and
 * returns when there is none. The bounce is done in `Mobs._animate` by scaling
 * the root, which is the right place for it anyway - a squash that answers to
 * the body's own vertical speed cannot be a baked clip.
 *
 * `height` is 1 so the spawn scale, `spec.height / modelHeight`, comes out as
 * the authored height in cells directly.
 */
export function registerCube(url, { color = 0xffffff, opacity = 0.86 } = {}) {
  if (protos.has(url)) return;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  // Origin at the foot, like every rig in the packs, so the seating code and
  // the scale-from-height both mean what they say.
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.35, metalness: 0.0,
    transparent: opacity < 1, opacity,
    emissive: new THREE.Color(color), emissiveIntensity: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const scene = new THREE.Group();
  scene.add(mesh);
  protos.set(url, { scene, clips: [], height: 1, footOffset: 0, skinned: false });
}

const unlitFixed = new WeakMap();

/**
 * How much brighter the monster pack has to be drawn to sit where the animals
 * do.
 *
 * Measured on the texels the models actually use — a palette sheet is mostly
 * empty, so a whole-image average is not the albedo of anything — by sampling
 * each pack's own UVs:
 *
 *   pets      mean luma 141  (p50 140, p95 227)
 *   monsters  mean luma  59  (p50  50, p95 126)
 *
 * That gap is not lighting, it is paint. The monster pack is authored *unlit*,
 * i.e. meant to be shown at face value with no diffuse term at all, so
 * rebuilding it as a lit material (see `lit`) multiplies an already dark albedo
 * by an irradiance below one and the thing reads as a silhouette in broad
 * daylight. 141/59 is what closes it, and it is applied as one number for the
 * whole pack rather than per species so that the artist's own spread survives:
 * the skull stays the brightest of them and the alien the darkest.
 *
 * The Blocky Characters pack — the husk, the stalker, the merchant — is the
 * same unlit case and gets the same treatment against its own number. It starts
 * a good deal brighter than the monsters, so it needs much less:
 *
 *   characters  mean luma  99  (the four that ship: a, d, l and o)
 *
 * Measured over the shipped four rather than all eighteen, because the other
 * fourteen are never loaded and averaging them in would price the lift against
 * models nobody sees.
 */
const MONSTER_GAIN = 141 / 59;
const CHARACTER_GAIN = 141 / 99;

/** The packs that need it, by url. The animals and the fish are already lit. */
const gainFor = (url) => (url.includes('/monsters/') ? MONSTER_GAIN
  : url.includes('/characters/') ? CHARACTER_GAIN : 1);

/**
 * Give a model back its shadows.
 *
 * The Blocky Characters exports — the husk and the wandering merchant, every
 * `character-*.glb` — declare `KHR_materials_unlit`, and GLTFLoader honours
 * that by building a `MeshBasicMaterial`. An unlit material ignores every light
 * in the scene and draws its texture at full brightness always, which is why
 * those two stayed exactly as bright at midnight in a cave as at noon while the
 * animals (plain PBR materials, from the Cube Pets pack) darkened correctly.
 * That is the "zombies are glowing" bug, and it was never an emissive: it was
 * the absence of lighting entirely.
 *
 * Rebuilding as a standard material rather than editing in place, and reusing
 * the `map` object *untouched*, is the same rule the damage tint follows: these
 * textures come from an ImageBitmap that has already been consumed, so writing
 * any property that forces a re-upload renders the mob flat white. Reading one
 * across to a new material does not.
 */
function lit(mat, gain = 1) {
  if (!mat || !mat.isMeshBasicMaterial) return mat;
  // Keyed on the source material alone, which stays correct while `gainFor`
  // answers by url: one GLB's materials are its own, so a material is never
  // asked for at two different gains.
  const done = unlitFixed.get(mat);
  if (done) return done;
  const m = new THREE.MeshStandardMaterial({
    map: mat.map,
    // Above 1 for the monsters, and that is the whole of MONSTER_GAIN: a
    // multiply into the material colour, which is the same safe operation the
    // damage tint and `spec.shade` already perform on these clones. The map
    // itself is untouched and nothing is re-uploaded — see the warning in
    // `prepare` about what happens when it is.
    color: mat.color.clone().multiplyScalar(gain),
    // Matches the Cube Pets materials, so a husk and a cow sit in the same
    // light rather than one looking waxier than the other.
    roughness: 0.92,
    metalness: 0,
    side: mat.side,
    transparent: mat.transparent,
    alphaTest: mat.alphaTest,
    vertexColors: mat.vertexColors,
  });
  m.name = mat.name;
  unlitFixed.set(mat, m);
  return m;
}

/**
 * Load and measure every model in `urls`. Called once at world start so that
 * `spawn` can stay synchronous — it runs from the frame loop and from world
 * load, and making it async would have animals appear a beat after everything
 * that depends on them.
 *
 * A model that fails to load is simply absent from `protos`; the caller checks
 * `isReady` and skips that species rather than crashing the spawn loop.
 */
export async function prepare(urls) {
  await Promise.all([...new Set(urls)].map(async (url) => {
    if (protos.has(url)) return;
    let gltf;
    try {
      gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    } catch (e) {
      console.warn('[MobModels]', url, 'failed to load', e);
      return;
    }
    // Deliberately minimal. GLTFLoader already sets the base-colour texture to
    // sRGB and picks sane filtering; every extra adjustment tried here — point
    // filtering for the palette atlas, forcing roughness, clamping metalness —
    // ended with the animals rendering flat white, while the untouched loader
    // output rendered correctly. Shadow flags and `lit` (which builds a new
    // material rather than editing this one) are the only safe things here.
    gltf.scene.traverse((n) => {
      if (!n.isMesh) return;
      n.castShadow = true;
      n.receiveShadow = true;
      const gain = gainFor(url);
      n.material = Array.isArray(n.material)
        ? n.material.map((m) => lit(m, gain))
        : lit(n.material, gain);
    });

    // Measure the rest pose. Clips move the parts around, but the rest pose is
    // what the collision footprint should be sized from — an animal is not
    // wider because its leg happens to be forward on this frame.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    // Whether this model has bones, which decides how it is cloned. Measured
    // here once rather than walked per spawn.
    let skinned = false;
    gltf.scene.traverse((n) => { if (n.isSkinnedMesh) skinned = true; });

    protos.set(url, {
      scene: gltf.scene,
      skinned,
      clips: gltf.animations || [],
      // No radius here. Mobs.js sizes its footprint from `modelExtents`, which
      // measures the *oriented* half-width and half-length off the same rest
      // pose; one number off the bounding box was never used by anything.
      height: size.y || 1,
      // How far the body hangs below its own origin. Measured 2026-08-11
      // across every model in play: the eleven `animal-*.glb` are all exactly
      // 0, so the land rig really is origin-at-the-feet, but all fifteen
      // `fish-*.glb` are 0.90 to 1.73 - their origin sits near mid-body, which
      // is the natural pivot for something that swims rather than stands.
      //
      // Nothing applies this. That is fine for the animals, where it is zero,
      // and it is deliberate-by-accident for the fish: a swimmer centred on
      // its position is what you want. It is recorded rather than used so the
      // next reader does not take "the exports put their origin at the feet"
      // on trust - it was written here, and it is only true of the land rig.
      // See `footOffset` in `render/BlockModels.js` for the same assumption
      // made about block models, where it was false and was costing us.
      footOffset: -box.min.y,
    });
  }));
}

/** Rest-pose height in model units, before the per-species scale. */
export const modelHeight = (url) => protos.get(url)?.height ?? 1;
export const footOffset = (url) => protos.get(url)?.footOffset ?? 0;

/**
 * A fresh, independently animatable copy.
 * @returns {{root: THREE.Group, mixer: THREE.AnimationMixer,
 *            actions: Object<string, THREE.AnimationAction>, current: string|null}|null}
 */
export function instantiate(url) {
  const proto = protos.get(url);
  if (!proto) return null;
  // `Object3D.clone` is wrong for a skinned mesh: it copies the mesh but leaves
  // it bound to the *prototype's* skeleton, so every instance is driven by one
  // set of bones and a whole shoal swims in lockstep — or, once the prototype
  // itself is never animated, does not swim at all. `SkeletonUtils.clone`
  // rebuilds the bone hierarchy and rebinds. It costs more than a plain clone,
  // so it is used only where it is needed.
  //
  // The animal pack is not skinned — it is eight nodes with clips keying their
  // rotations — which is why this never came up until the fish arrived.
  const root = proto.skinned ? cloneSkinned(proto.scene) : proto.scene.clone(true);
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const clip of proto.clips) actions[clip.name] = mixer.clipAction(clip);
  return { root, mixer, actions, current: null };
}

/**
 * Free the one GPU resource a clone genuinely owns: its skeletons.
 *
 * `SkeletonUtils.clone` rebuilds the bone hierarchy per instance, so every
 * skinned clone gets `Skeleton`s of its own, and three allocates each of those
 * a bone `DataTexture` lazily on its first render (`Skeleton.computeBoneTexture`
 * out of `setProgram`). Nothing ever freed them: a fish rig carries about five
 * SkinnedMeshes with a skeleton each, so every fish that spawned and despawned
 * left ~5 GL textures behind for the life of the context.
 *
 * Measured before this existed, four rounds of spawn-25-fish-then-release-all:
 * `renderer.info.memory.textures` went 107 -> 215 -> 326 -> 427 -> 558 and never
 * once fell, with 486 of those textures orphaned — no skeleton reachable from
 * any scene still referenced them. That was the whole of the unbounded growth
 * the audit measured while travelling (91 -> 973 over seven minutes); the
 * earlier "mobs are clean" control had forced-spawned one of the fourteen
 * *unskinned* species, which allocates no bone texture at all and so plateaus.
 *
 * Geometry and materials are deliberately NOT touched here — those belong to
 * the prototype and are shared with the whole species. Disposing is safe even
 * if the root is drawn again: three rebuilds a missing bone texture on the next
 * render.
 *
 * @param {THREE.Object3D} root the clone's root, as handed out by `instantiate`
 */
export function releaseSkeletons(root) {
  if (!root) return;
  const seen = new Set();
  root.traverse((n) => {
    if (!n.isSkinnedMesh || !n.skeleton || seen.has(n.skeleton)) return;
    seen.add(n.skeleton);
    n.skeleton.dispose();
  });
}

/**
 * Crossfade to one clip. Re-requesting the clip already playing is a no-op, so
 * this is safe to call every frame straight from the behaviour state machine.
 *
 * @param {{actions: Object, current: string|null}} model
 * @param {string} name
 * @param {number} fade seconds
 * @param {boolean} once play once and hold the last frame — death, and attacks
 */
export function play(model, name, fade = 0.22, once = false) {
  const next = model.actions[name];
  if (!next || model.current === name) return;
  const prev = model.current ? model.actions[model.current] : null;

  next.reset();
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setEffectiveWeight(1);
  next.play();
  if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
  model.current = name;
}

/**
 * Fire a one-shot clip and come back to whatever was playing. Used for the
 * attack swing, which must not leave the mob frozen mid-lunge.
 */
export function playOnce(model, name, timeScale = 1) {
  const act = model.actions[name];
  if (!act) return 0;
  act.reset();
  act.setLoop(THREE.LoopOnce, 1);
  act.clampWhenFinished = false;
  act.setEffectiveTimeScale(timeScale);
  act.setEffectiveWeight(1);
  act.enabled = true;
  act.play();
  model.current = null;   // force the next play() to re-blend
  return act.getClip().duration / timeScale;
}
