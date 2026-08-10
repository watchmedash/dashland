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
 * url -> { scene, clips, height, radius }. `scene` is a *prototype*: it is never
 * added to the world, only cloned, so geometry and materials stay shared across
 * every instance of that species — one upload for a whole herd. The flip side is
 * that nothing may ever dispose them; releasing a mob only detaches it.
 */
const protos = new Map();

/** True once `url` is loaded and `instantiate` will succeed. */
export const isReady = (url) => protos.has(url);

const unlitFixed = new WeakMap();

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
function lit(mat) {
  if (!mat || !mat.isMeshBasicMaterial) return mat;
  const done = unlitFixed.get(mat);
  if (done) return done;
  const m = new THREE.MeshStandardMaterial({
    map: mat.map,
    color: mat.color,
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
      n.material = Array.isArray(n.material) ? n.material.map(lit) : lit(n.material);
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
      height: size.y || 1,
      radius: Math.max(size.x, size.z) * 0.5 || 0.5,
      // The exports put their origin at the feet; this is what would put a
      // model back on the ground if one ever did not.
      footOffset: -box.min.y,
    });
  }));
}

/** Clip names a model actually ships, for choosing fallbacks. */
export const clipNames = (url) => (protos.get(url)?.clips || []).map((c) => c.name);

/** Rest-pose height in model units, before the per-species scale. */
export const modelHeight = (url) => protos.get(url)?.height ?? 1;
export const modelRadius = (url) => protos.get(url)?.radius ?? 0.5;
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
