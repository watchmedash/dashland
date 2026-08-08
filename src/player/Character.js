// The player's body: a Kenney Blocky Character standing where the player is.
//
// Until now the player had no body at all — a floating fist in `ViewModel` and
// nothing in the world. This is the other half: the thing a third-person camera
// looks at, the thing that casts a shadow on the ground you are standing on.
//
// It deliberately borrows `MobModels` rather than loading the GLB itself. That
// module already owns three things this would otherwise have to duplicate: the
// prototype cache (so a player using `character-l` costs nothing extra beside
// the husks that already use it), the clone/mixer/crossfade plumbing, and —
// the one that is not obvious — `lit()`. Every `character-*.glb` in the pack
// declares `KHR_materials_unlit`, so GLTFLoader builds a MeshBasicMaterial and
// the body would render at full texture brightness at midnight in a cave. That
// is the "zombies are glowing" bug, and MobModels is where the fix lives. The
// coupling is one import of a pure asset module; the alternative is a second
// copy of a comment that already documents a day of debugging.
//
// The rig is NOT skinned, despite looking like it should be. `character-a.glb`
// has zero skins and eight nodes — `root > {leg-left, leg-right, torso >
// {arm-left, arm-right, head}}` — and every clip keys node rotations directly.
// So "find the hand bone" is really "find the node named arm-right", and an
// item goes in the hand by parenting to that node. Nothing here needs
// SkeletonUtils.clone, which is what a skinned rig would have forced.

import * as THREE from 'three';
import * as MobModels from '../game/MobModels.js';
import { hasModel } from '../render/ItemModels.js';
import { HEIGHT as PLAYER_HEIGHT } from './Player.js';

/**
 * Every character the player may be, as the letter in the filename.
 *
 * Three of the eighteen are spoken for and are absent on purpose: `d` is the
 * wandering merchant, `l` and `o` are the husk. Wearing a husk's face would be
 * a joke that stops being funny the first night. This list is what the New Game
 * character picker will iterate — see the note on `characterUrl`.
 */
export const CHARACTER_IDS = [
  'a', 'b', 'c', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n', 'p', 'q', 'r',
];

/** Who you are until anything says otherwise. */
export const DEFAULT_CHARACTER = 'a';

/**
 * The single place a character id becomes a file path.
 *
 * The character is a constructor argument and a runtime setter rather than a
 * constant baked into a URL string, so the picker that is coming later has one
 * thing to call and the save file has one short string to store. Nothing else
 * in the game knows what a character-*.glb is.
 */
export const characterUrl = (id) => `models/characters/character-${id}.glb`;

/**
 * What the loader has to fetch before a body can appear. `prepare` is awaited
 * at world start beside the mob models; a character the player has not chosen
 * is never downloaded.
 */
export const playerModelUrls = (id = DEFAULT_CHARACTER) => [characterUrl(id)];

/** Clip names this rig ships, of the twenty-seven, that we actually drive. */
const CLIP = {
  idle: 'idle',
  walk: 'walk',
  run: 'sprint',
  attack: 'attack-melee-right',
  /** Not played — read, for its one keyframe. See `_readHoldPose`. */
  hold: 'holding-right',
};

/**
 * Where an item sits in the hand, in arm-local model units.
 *
 * Read off the geometry rather than guessed: the arm mesh spans x -0.4..0,
 * y -1..0.1, z ±0.2 in the space of the `arm-right` node, so the limb's centre
 * line is x = -0.2 and its far end — the fist — is y = -1. An item centred a
 * little past that reads as held rather than skewered.
 */
const HAND_LOCAL = new THREE.Vector3(-0.2, -1.02, 0);

/**
 * Longest axis of a held item, in model units. One model unit is
 * PLAYER_HEIGHT / 2.3 ≈ 0.78 cells (2.3 is the rig's rest height), so this is
 * about two thirds of a block — a pickaxe you can see from behind without it
 * becoming the whole silhouette.
 */
const HAND_ITEM_SIZE = 0.9;

/**
 * How much of the holding pose survives the gait.
 *
 * The pack's answer to "carry something" is a separate clip, `holding-right`,
 * that keys only `arm-right` — it is meant to be layered, and three has no
 * layers. Playing it as a second action at weight 1 does not layer it either:
 * the mixer blends actions per node, so walk and holding-right would each get
 * half and the arm would end up half-raised and swinging half as far.
 *
 * The clip is one keyframe, and the arm's rest rotation is identity, so that
 * keyframe *is* the pose. Read it once and slerp the animated arm toward it
 * after the mixer has run: at 0.85 the arm is unmistakably presenting the tool
 * and still carries a trace of the walk cycle, which a hard override kills.
 */
const HOLD_BLEND = 0.85;

/** Seconds an attack swing owns the arm, during which the hold pose lets go. */
const SWING_TIME = 0.42;

/**
 * Below this camera distance the body is not drawn.
 *
 * The third-person camera pulls in to avoid terrain and can end up against the
 * player's own back in a tight corridor. Drawing the model then puts the camera
 * inside the head, which is a black screen with an ear in it — worse than the
 * momentary loss of the body.
 */
const HIDE_DIST = 0.9;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _side = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

export class PlayerCharacter {
  /**
   * @param {THREE.Scene} scene
   * @param {(itemId:number)=>THREE.Object3D|null} itemFactory usually
   *   `Drops.createItemMesh` — the world-space form of an item, already
   *   resolved to a model, a textured cube or a sprite. Reusing it is the whole
   *   reason a held item needs no art of its own: what you carry in your hand
   *   and what you see lying on the ground should be the same object, and this
   *   is the one function that already knows how to build it.
   */
  constructor(scene, itemFactory) {
    this.scene = scene;
    this.itemFactory = itemFactory;
    this.id = DEFAULT_CHARACTER;
    this.url = characterUrl(this.id);

    this.model = null;          // { root, mixer, actions, current }
    this.arm = null;            // the `arm-right` node — the hand
    this.holdQ = null;          // the holding-right pose, or null if absent
    this._holdW = 0;            // eased 0..1
    this.swingT = 0;

    /**
     * Item meshes by id, built once and kept.
     *
     * Not rebuilt per equip: the sprite path in `createItemMesh` allocates a
     * fresh PlaneGeometry every call, and a player flicking through the hotbar
     * does that hundreds of times an hour. Caching sidesteps the disposal
     * question entirely, and the ceiling is the item table — a hundred small
     * meshes sharing geometry and materials with the drops already in the
     * world.
     */
    this._itemCache = new Map();
    /** The one holder that is not cached, because its art had not loaded yet. */
    this._transient = null;
    /**
     * Anchors by hand, keyed rather than a single field because the offhand is
     * coming. `left` is unused today; adding it is a second entry here and a
     * second `setHeld` call, and nothing else.
     */
    this.hands = { right: null, left: null };
    this.heldItem = { right: -1, left: -1 };

    this.visible = false;
  }

  /**
   * Swap the body. Safe to call before the model exists — the next `update`
   * picks it up — but the URL must already be through `MobModels.prepare`.
   */
  setCharacter(id) {
    if (id === this.id) return;
    this.id = id;
    this.url = characterUrl(id);
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model = null;
      this.arm = null;
      this.hands.right = null;
      this.hands.left = null;
      this.heldItem.right = -1;
      this.heldItem.left = -1;
    }
  }

  /** Build the body once its GLB has landed. Silently does nothing until then. */
  _instantiate() {
    if (this.model || !MobModels.isReady(this.url)) return;
    const model = MobModels.instantiate(this.url);
    if (!model) return;

    // Sizes are authored as a height in cells and each rig has its own idea of
    // a unit, so derive the scale from the measured rest pose — the same rule
    // Mobs uses, and the reason a different character is a one-line change.
    const scale = PLAYER_HEIGHT / MobModels.modelHeight(this.url);
    model.root.scale.setScalar(scale);
    // Materials are the prototype's, shared and already lit — no per-instance
    // clone, because unlike a mob the player never flashes red or burns.
    model.root.visible = false;
    this.scene.add(model.root);

    this.model = model;
    this.arm = model.root.getObjectByName('arm-right') || null;
    this.holdQ = this._readHoldPose(model);
    if (this.arm) {
      const anchor = new THREE.Group();
      anchor.position.copy(HAND_LOCAL);
      this.arm.add(anchor);
      this.hands.right = anchor;
    }
    MobModels.play(model, CLIP.idle, 0);
  }

  /**
   * The one keyframe of `holding-right`, as a quaternion, or null.
   *
   * Track names come out of GLTFLoader as `<node>.<property>`, so the arm's is
   * `arm-right.quaternion`. Reading the action's clip rather than reaching into
   * MobModels' private prototype map keeps this to the module's public surface.
   */
  _readHoldPose(model) {
    const clip = model.actions[CLIP.hold]?.getClip();
    const track = clip?.tracks.find((t) => t.name.endsWith('.quaternion'));
    if (!track || track.values.length < 4) return null;
    const v = track.values;
    return new THREE.Quaternion(v[0], v[1], v[2], v[3]);
  }

  /**
   * Kick the melee swing — called from the same place the viewmodel punches.
   *
   * The attack layers over whatever gait is running rather than replacing it,
   * which is why `current` is put back: `playOnce` clears it so that a mob's
   * behaviour state machine re-blends its base clip afterwards, but the base
   * clip here never stopped. Left cleared, the next `update` would call
   * `play(walk)` on an action that is already playing, and `play` resets it —
   * so every swing while walking snapped the feet back to frame zero. The
   * one-shot disables itself when it finishes (`clampWhenFinished` is false),
   * so there is nothing to clean up.
   */
  punch() {
    this.swingT = SWING_TIME;
    if (!this.model) return;
    const base = this.model.current;
    MobModels.playOnce(this.model, CLIP.attack);
    this.model.current = base;
  }

  /**
   * Put an item in a hand.
   *
   * @param {number} itemId 0 or -1 for empty
   * @param {'right'|'left'} which the offhand seam: `left` works the moment
   *   there is an anchor for it.
   */
  setHeld(itemId, which = 'right') {
    const anchor = this.hands[which];
    if (!anchor) return;
    const id = itemId || 0;
    if (id === this.heldItem[which]) return;
    this.heldItem[which] = id;

    // Cached holders are only detached — they are handed out again next equip.
    // A stand-in built while a model was still loading is nobody else's, and
    // its sprite plane is a geometry this class allocated, so it goes.
    for (let i = anchor.children.length - 1; i >= 0; i--) {
      const child = anchor.children[i];
      anchor.remove(child);
      if (child === this._transient) {
        child.traverse((n) => { if (n.isMesh) n.geometry.dispose(); });
        this._transient = null;
      }
    }
    if (!id) return;

    let holder = this._itemCache.get(id);
    if (holder === undefined) {
      holder = this._buildItem(id);
      // An item whose art is still in flight gets the factory's stand-in and is
      // deliberately NOT cached, so the next equip asks again and picks up the
      // real model. Caching it would mean the first torch you ever hold is a
      // flat sprite for the rest of the session. `null` — an id with no
      // definition at all — is cached, because that never resolves.
      if (holder === null || !hasModel(id) || holder.userData.modelled) {
        this._itemCache.set(id, holder);
      } else {
        this._transient = holder;
      }
    }
    if (holder) anchor.add(holder);
  }

  /**
   * Wrap an item's world mesh so it sits in the fist at a sensible size.
   *
   * The wrapper exists because the mesh's own transform is not ours to write:
   * `createItemMesh` hands back a shared or cached object for the modelled and
   * cube paths, and posing it in place would pose it for the drop lying on the
   * ground too.
   */
  _buildItem(itemId) {
    const mesh = this.itemFactory(itemId);
    if (!mesh) return null;

    _box.setFromObject(mesh);
    _box.getSize(_size);
    _box.getCenter(_centre);
    const longest = Math.max(_size.x, _size.y, _size.z) || 1;

    const holder = new THREE.Group();
    // Carried up from the mesh so `setHeld` can tell a real model from the
    // stand-in the factory falls back to. Drops sets it on the model path.
    holder.userData.modelled = !!mesh.userData.modelled;
    // The arm hangs down its own -Y, and the holding pose swings that -Y to
    // world forward. An item built upright along +Y therefore has to be turned
    // over to run *along* the limb rather than back through it.
    holder.rotation.x = Math.PI;
    holder.scale.setScalar(HAND_ITEM_SIZE / longest);
    // Centre the art on the fist. Items are modelled around wherever their
    // author put the origin — a torch from its base, a block from its middle —
    // and an uncentred one hangs off the hand by however far that happens to be.
    mesh.position.sub(_centre);
    holder.add(mesh);
    return holder;
  }

  /**
   * Place, orient and animate the body.
   *
   * @param {number} dt
   * @param {import('./Player.js').Player} player
   * @param {boolean} shown false in first person, where the viewmodel has the
   *   job instead. The model is hidden rather than removed: hidden costs one
   *   flag test in the culler, removing costs a scene-graph edit every time the
   *   camera changes mode.
   * @param {number} heldItem what is in the hotbar's selected slot
   */
  update(dt, player, shown, heldItem) {
    this._instantiate();
    const model = this.model;
    if (!model) return;

    // Too close to draw — see HIDE_DIST. `cameraDist` is 0 in first person, so
    // this covers both cases with one test.
    const show = shown && player.cameraDist > HIDE_DIST;
    model.root.visible = show;
    this.visible = show;
    // A hidden body still needs its clock advanced, or stepping into third
    // person shows a mannequin frozen mid-stride for a frame. It does not need
    // its transform: nothing reads the body's position but the renderer.
    if (!show) { model.mixer.update(dt); return; }

    this.setHeld(heldItem, 'right');

    // --- orientation ---
    // Stand on the local up, face where the player faces. The head is at local
    // +Z (confirmed by the holding pose, which swings the arm from -Y to +Z),
    // so +Z must map to forward; `up × forward` keeps the basis right-handed.
    // This is Mobs' `_animate` rule with the player's own up and forward in
    // place of a mob's, which is what makes a body stand correctly on a sphere.
    _side.crossVectors(player.up, player.forward).normalize();
    _m.makeBasis(_side, player.up, player.forward);
    _q.setFromRotationMatrix(_m);
    // Snapped, not slerped, unlike a mob. A mob's heading is a simulation
    // output and wants smoothing; the player's is the mouse, and a body that
    // lags the camera by a few frames reads as input latency.
    model.root.quaternion.copy(_q);

    // The rig's origin is between the feet, which is exactly where
    // `player.position` is. `stepOffset` is the same smoothing the camera
    // applies over a one-block step-up — without it the body would pop a block
    // while the view eased.
    model.root.position.copy(player.position).addScaledVector(player.up, -player.stepOffset);

    // --- clips ---
    // Driven off the same numbers the physics already publishes: `moveAmount`
    // is tangential speed in cells/s and `sprinting` is the state the stamina
    // gate settled on, so the gait can never disagree with the movement.
    const speed = player.moveAmount;
    let clip = CLIP.idle;
    if (speed > 0.6) clip = player.sprinting ? CLIP.run : CLIP.walk;
    MobModels.play(model, clip, 0.18);

    // Re-time the gait so the feet do not skate. The walk clip reads right at
    // the ordinary 4.4 cells/s and the sprint at 6.8, which are the two speeds
    // in Player.update; the clamp keeps a crouch-walk from crawling and a
    // river's shove from spinning the legs.
    const act = model.actions[clip];
    if (act) {
      const base = clip === CLIP.run ? 6.8 : clip === CLIP.walk ? 4.4 : 0;
      act.setEffectiveTimeScale(base ? THREE.MathUtils.clamp(speed / base, 0.55, 1.8) : 1);
    }

    model.mixer.update(dt);

    // --- the carrying pose, layered by hand ---
    // Strictly after mixer.update: the mixer rewrites arm-right's rotation from
    // the clip every frame, so anything written before it is gone. That is also
    // what keeps this from compounding — each frame slerps from a freshly
    // animated value, not from last frame's result.
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
    const wantHold = this.heldItem.right > 0 && this.swingT <= 0 ? 1 : 0;
    this._holdW += (wantHold - this._holdW) * Math.min(1, dt * 9);
    if (this.arm && this.holdQ && this._holdW > 0.002) {
      this.arm.quaternion.slerp(this.holdQ, this._holdW * HOLD_BLEND);
    }
  }

  /** Menus and the loading screen: no body anywhere near the orbit camera. */
  hide() {
    if (this.model) this.model.root.visible = false;
    this.visible = false;
  }
}
