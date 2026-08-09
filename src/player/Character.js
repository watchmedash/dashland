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
import { hasModel, heldModel } from '../render/ItemModels.js';
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

/**
 * What each of them is called.
 *
 * "Character A" is not a person, it is a filename with a capital letter on it,
 * and a picker that offers fifteen of those is asking the player to choose
 * between rows of a table. These are the same fifteen bodies with names on.
 *
 * Three rules, and each of them is a constraint the picker imposes rather than
 * a preference:
 *
 *  - **Short.** The name renders in a caption under the figure, in a card that
 *    is as wide as one character is tall. Six letters fits at the size the
 *    caption is set; nine wraps or shrinks, and a wrapping caption moves the
 *    figure. The longest here is `Halvard`, at seven.
 *  - **Plain ASCII, no punctuation.** These strings pass through markup, a save
 *    file and a URL-shaped id lookup, and a name with an apostrophe in it is a
 *    name that eventually appears as `O&#39;Neil`. Accents were the other
 *    temptation and are the same class of bug one layer down.
 *  - **Fifteen origins, not one family.** The pack's faces are visibly from
 *    everywhere; naming them Ann, Ben, Carl down the alphabet would flatten
 *    that into one village of siblings. No two share a first letter either,
 *    which is what lets a player who has met one of them find them again.
 *
 * Keyed by id and not an array, so that the order of `CHARACTER_IDS` can change
 * without silently renaming everyone. Consumers should fall back to the id: a
 * missing entry is a caption reading `q`, not a crash.
 *
 * Five of these were assigned blind and were wrong. The first pass named the
 * ids without looking at the models, and b, h, j, k and q are visibly men
 * wearing women's names, which the player noticed immediately. They are Bram,
 * Soren, Milo, Dario and Lasse now. The atlases are unwrapped skins and are not
 * legible enough to settle this from the files, so anyone changing a name here
 * should look at the figure in the character picker first rather than reasoning
 * from the texture.
 */
export const CHARACTER_NAMES = {
  a: 'Rowan',
  b: 'Bram',
  c: 'Tomas',
  e: 'Ines',
  f: 'Nadia',
  g: 'Kofi',
  h: 'Soren',
  i: 'Yusuf',
  j: 'Milo',
  k: 'Dario',
  m: 'Otto',
  n: 'Amara',
  p: 'Halvard',
  q: 'Lasse',
  r: 'Emeka',
};

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
 * Where a character's skin lives, which is not inside its model.
 *
 * Every `character-*.glb` references `Textures/texture-<id>.png` rather than
 * embedding it, and that one fact is what the picker is built on — see
 * `CharacterPicker`. Nothing else needs this; the GLB's own loader resolves the
 * reference on its own.
 */
export const characterTextureUrl = (id) => `models/characters/Textures/texture-${id}.png`;

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
  /**
   * One per hand: the pack ships `attack-melee-left` as well, and now that an
   * empty main hand lets the offhand mine and place, a left-handed swing is a
   * thing the body has to be able to do. Both clips key every node — legs,
   * torso, head and *both* arms — so this is a whole-body strike either way;
   * what differs is which arm leads.
   */
  attack: { right: 'attack-melee-right', left: 'attack-melee-left' },
  /**
   * Not played — read, for their one keyframe each. See `_readHoldPose`.
   *
   * `holding-both` is in the pack too and is not used: it keys both arms in one
   * clip, which would only help if both hands always held or always did not.
   * They don't — the right arm drops its pose for every swing while the left
   * keeps hold — so the two one-armed clips are the ones that compose.
   */
  hold: { right: 'holding-right', left: 'holding-left' },
};

/**
 * The twenty-seven, enumerated from the files rather than remembered.
 *
 * Every one of the eighteen `character-*.glb` ships the same list — checked,
 * because the whole of the picker's one-model-fifteen-skins trick rests on it —
 * and it is worth having written down, since two thirds of it was invisible
 * from this file and so was being treated as if it did not exist:
 *
 *   static  idle  walk  sprint  sit  drive  die  pick-up
 *   emote-yes  emote-no
 *   holding-{right,left,both}  holding-{right,left,both}-shoot
 *   attack-melee-{right,left}  attack-kick-{right,left}
 *   interact-{right,left}
 *   wheelchair-sit  wheelchair-move-{forward,back,left,right}
 *
 * Of those, the five wheelchair clips and `drive` are vehicle poses with no
 * vehicle in this game, `static` is the rest pose, and `sit`/`die` leave the
 * standing silhouette in ways the note on `POSE` already covers. What is left
 * unused and *usable* is the gesture set below.
 *
 * Which is a fact about the pack and not about any one file, so nothing here
 * assumes a given character has any of them: every play goes through
 * `_gesture`, which asks that model's own `actions` first.
 */

/**
 * Small things a body does when nobody is asking it to do anything.
 *
 * All four key `torso`, `head` and the arms and **not the legs** — that is the
 * selection rule, not a coincidence of taste. A one-shot that keys the legs
 * would leave them wherever its last frame put them, because `idle` does not
 * key legs and the mixer does not clear what it does not key; that is the exact
 * bug `_clearPose` documents. Legs are in the pose tables and so `_clearPose`
 * would in fact catch it, but a fidget that needs the safety net to look right
 * is one that will look wrong the day the net moves.
 *
 * `pick-up` reads as checking a pocket, `interact-*` as reaching out and
 * thinking better of it, and the two emotes as a nod and a shake at nobody.
 * None of them travel, so a body that fidgets is still standing exactly where
 * the collision box says it is.
 */
const FIDGETS = ['emote-yes', 'emote-no', 'pick-up', 'interact-right', 'interact-left'];

/**
 * Seconds of genuinely doing nothing before the body fidgets, and between
 * fidgets after that.
 *
 * Long, deliberately. A gesture every three seconds is a nervous tic and reads
 * as a bug; the point is that a player who parks the character to read a
 * crafting grid looks up and finds a person rather than a statue. The range is
 * jittered per fire so it never settles into a rhythm.
 */
const FIDGET_MIN = 9;
const FIDGET_MAX = 19;

/** The two hands, in the order everything here iterates them. */
const HANDS = ['right', 'left'];

/** The rig node behind each hand. */
const ARM_NODE = { right: 'arm-right', left: 'arm-left' };

/**
 * Where an item sits in the hand, in arm-local model units.
 *
 * Read off the geometry rather than guessed: the arm mesh spans x -0.4..0,
 * y -1..0.1, z ±0.2 in the space of the `arm-right` node, so the limb's centre
 * line is x = -0.2 and its far end — the fist — is y = -1. An item centred a
 * little past that reads as held rather than skewered.
 *
 * The left is not the same vector. `arm-left`'s mesh spans x 0..0.4 in its own
 * node space — the pack mirrors the geometry rather than mirroring the node —
 * so its centre line is x = +0.2. Reusing the right hand's offset put the
 * offhand item outside the limb, floating a fifth of a unit off the knuckles,
 * which reads as a bug rather than as a torch.
 */
const HAND_LOCAL = {
  right: new THREE.Vector3(-0.2, -1.02, 0),
  left: new THREE.Vector3(0.2, -1.02, 0),
};

/**
 * Longest axis of a held item, in model units.
 *
 * The holder hangs off the arm node, inside the root's fit scale, so this is
 * not a length in cells: one model unit is PLAYER_HEIGHT / 2.7 = 0.67 cells,
 * 2.7 being the rig's measured rest height — the same number the picker reads
 * off its own clone. 0.9 model units is therefore **0.6 cells**, a bit over
 * half a block: a pickaxe you can see from behind without it becoming the whole
 * silhouette.
 *
 * This comment said 2.3 until it was checked against `modelHeight`, which put
 * the stated size 15% above the drawn one. Nothing moved on screen — the divisor
 * was only ever in the prose, never in the arithmetic — but a constant whose
 * comment misreports its own scale is one nobody can tune without measuring
 * first, which is the whole point of writing the scale down.
 */
const HAND_ITEM_SIZE = 0.9;

/**
 * Model units per unit of a first-person pose's `height`.
 *
 * An authored pose sizes an item for the view model's camera, where a pickaxe
 * is 0.46 and an apple 0.24 — the ratio between them is the part worth keeping,
 * since it is what stops a held apple reading as a beach ball. Only the overall
 * scale has to change for a camera standing behind the body instead of inside
 * it, so this is one factor applied to all of them, pinned to the pickaxe: at
 * 0.46 it lands on HAND_ITEM_SIZE, the length the generic path was tuned to.
 */
const HELD_POSE_SCALE = HAND_ITEM_SIZE / 0.46;

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
 * Falling, swimming and sneaking, as poses rather than clips.
 *
 * The pack ships 27 clips and not one of them is any of these. There is no
 * crouch, no jump, no fall and no swim; `sit` and `drive` are the only clips
 * that leave the standing silhouette and both are vehicle poses, legs folded
 * dead ahead at exactly -π/2. Playing `sit` for a crouch was tried first and is
 * unmistakably a man sitting on an invisible chair.
 *
 * So these are authored here, in the rig's own units, and layered after the
 * mixer exactly the way the carrying pose is. Three facts make that cheap:
 * the rig is eight nodes, every clip keys rotation only, and the rest rotation
 * of every node is identity — so a pose is just a handful of Euler angles and
 * the blend weight is a slerp from whatever the gait produced.
 *
 * **Sign, read off the file rather than guessed:** `holding-right` is a single
 * keyframe of `arm-right` at x = -1.571, and that pose points the arm forward.
 * Negative x swings a limb *forward*, positive swings it back. `die` flings both
 * arms to -2.279, which is forward and over the head — the value the falling
 * pose is built around, since a body in the air and a body giving up have the
 * same arms.
 *
 * **And that rule inverts for the torso and the head.** It is a fact about the
 * geometry, not about the convention: an arm and a leg hang *down* their node's
 * -Y, so an x rotation carries them forward; the torso and the head stand *up*
 * along +Y, so the identical rotation carries them back. The first crouch here
 * used the limb sign throughout and produced a figure arching *backwards* while
 * its legs bent forward — which in a still photograph, from behind, looks
 * enough like a crouch to pass. It was caught by measuring the head: 0.4 of a
 * cell behind the feet when a sneak should put it in front.
 *
 * Z is the splay. The limbs hang parallel to the body and a fall that only
 * rotates in x reads as a diagram; a tenth of a radian outward on each side is
 * the difference between falling and being a plank.
 */
const POSE = {
  /**
   * Airborne: arms up and out, legs trailing and parted, torso arched back.
   *
   * Deliberately not symmetric — the left leg leads. A symmetric pose plus the
   * gait underneath averages out to the same thing on both sides and reads as a
   * mannequin dropped down a well.
   */
  air: {
    // Negative arches the chest back and lifts the chin — see the sign note.
    torso: [-0.16, 0, 0],
    head: [0.18, 0, 0],
    'arm-right': [-2.25, 0, 0.30],
    'arm-left': [-2.25, 0, -0.30],
    'leg-right': [0.34, 0, 0.10],
    'leg-left': [-0.22, 0, -0.10],
  },

  /**
   * Swimming: the limbs only. The part that sells it — the body going
   * horizontal — is a rotation of the whole model, not of any node, and lives in
   * `_swim` below, because no amount of shoulder angle makes an upright body
   * look like it is swimming.
   */
  swim: {
    torso: [-0.10, 0, 0],
    // Chin up. The body is face-down and the head is a separate node, so
    // without this the character swims looking at the seabed.
    head: [0.55, 0, 0],
    'arm-right': [-1.15, 0, 0.34],
    'arm-left': [-1.15, 0, -0.34],
    'leg-right': [0.30, 0, 0.12],
    'leg-left': [0.30, 0, -0.12],
  },

  /**
   * Sneaking: torso down over the knees, head up to keep looking ahead, arms
   * tucked behind, legs bent under.
   *
   * The rig has no knee, so a crouch cannot be built the way a skinned one is.
   * What it has is a hip: rotating both legs forward swings the feet out in
   * front and leaves the hips where they were, so on its own that is a bigger
   * sitting pose. It works only paired with `CROUCH_SINK`, which drops the body
   * by roughly what the bent legs would have taken out of it — together they
   * read as a squat, and neither does alone.
   */
  crouch: {
    // Positive folds the chest down over the knees; the head takes most of it
    // back so a sneaking player is still looking where they are going.
    torso: [0.52, 0, 0],
    head: [-0.40, 0, 0],
    'arm-right': [0.30, 0, 0.16],
    'arm-left': [0.30, 0, -0.16],
    'leg-right': [-0.34, 0, 0.10],
    'leg-left': [-0.34, 0, -0.10],
  },

  /**
   * Drawing a bow. The one pose in this table that is not chosen by `wantPose`.
   *
   * It is here rather than in a table of its own precisely so that it costs
   * nothing to add: `POSE_Q` compiles it, `_instantiate` resolves its node names,
   * `_poseAll` picks its nodes up and so `_clearPose` returns them to rest when
   * the weight goes. The only thing it needs that the other three do not is its
   * own weight — `_drawW` rather than `_poseW` — because a player can perfectly
   * well be drawing a bow while airborne or crouching, and the mutual exclusion
   * `_poseW` enforces is exactly wrong for it.
   *
   * Built on the sign rule stated above: negative X carries a limb forward. The
   * bow arm goes out in front and a little across the chest; the string arm
   * comes up to the same height and splays *out* (negative Z on the left, the
   * same direction `air` and `swim` use to part the limbs), which is the elbow
   * of a drawn bow seen from behind. The torso takes a quarter turn toward the
   * bow side so the shoulders line up with the shot instead of squaring off with
   * the camera, and the head takes it back so the archer is still looking where
   * the crosshair is.
   */
  draw: {
    // Strengthened alongside the first-person gesture, and for the same
    // complaint: at a quarter turn of torso and a bow arm 5° short of level the
    // silhouette from behind was a figure standing with its arms slightly out,
    // which is not a draw. Every number here moved in the direction it already
    // pointed rather than in a new one.
    //
    //  - torso 0.34 -> 0.42: the shoulders line up with the shot properly.
    //  - head -0.30 -> -0.38: taken straight back off the torso, so the archer
    //    still looks exactly where the crosshair is. This is the torso's number
    //    negated to within a rounding and should stay that way.
    //  - bow arm -1.48 -> -1.62: past level, which is what "locked out along the
    //    shot" looks like from behind, and its splay 0.26 -> 0.14 brings it in
    //    toward the aim line instead of holding the bow out at arm's width.
    //  - string arm -1.12 -> -1.06 with its splay -0.78 -> -0.98: the hand comes
    //    *back* toward the face (less forward) while the elbow goes further out.
    //    The rig has no elbow, so those two shoulder terms together are the only
    //    way the bent arm of a drawn bow can exist at all, and widening the
    //    splay is what puts a visible triangle between the two arms.
    torso: [0, 0.42, 0],
    head: [0, -0.38, 0],
    'arm-right': [-1.62, 0, 0.14],
    'arm-left': [-1.06, 0, -0.98],
  },
};

/**
 * How far the body drops when sneaking, in cells.
 *
 * The collision box loses 0.35 and the eye 0.30, and matching either exactly is
 * wrong: the feet are modelled where they stand, so the whole 0.35 puts them a
 * third of a block into the floor. The legs' hip bend accounts for some of the
 * lost height on its own; this covers the visible remainder without burying the
 * boots.
 */
const CROUCH_SINK = 0.16;

/** How fast a pose fades in and out, in weight per second. */
const POSE_RATE = 5.5;

/** How fast the bow draw's weight chases its target. See `_drawW`. */
const DRAW_RATE = 14;

/**
 * How far forward the body tips when swimming, in radians, and how fast the
 * legs kick.
 *
 * The tip scales with how hard you are actually swimming: treading water is
 * nearly upright, crawling is near flat. A fixed value makes someone bobbing in
 * place look like they are drowning face-down.
 */
/**
 * What separates a fall from a hop: still in the air after a jump would have
 * landed, or coming down faster than a jump can.
 *
 * Both numbers are derived from the jump rather than picked. Player.js leaves
 * the ground at 8.4 cells/s against a gravity of 26, which is an apex at 0.32s,
 * an airtime of 0.65s, and a landing at exactly -8.4. So a threshold anywhere
 * under those fires on *every* jump — the first draft used 0.34s and -5.0 and
 * would have thrown the arms overhead each time the player cleared a fence,
 * which is precisely what this gate exists to prevent.
 *
 * Above them, the speed clause is what actually fires when you walk off a
 * ledge: 9 cells/s is 0.35s and about a block and a half of falling, well
 * before the timer, and stepping off a cliff is the case where a body that
 * keeps strolling looks broken. The timer only catches the rarer one — a long
 * hang with little vertical speed, such as sliding out over a drop.
 */
const AIR_DELAY = 0.72;
const AIR_SPEED = 9.0;

const SWIM_PITCH_MIN = 0.22;
const SWIM_PITCH_MAX = 1.20;
const KICK_RATE = 3.4;
const KICK_SWING = 0.30;

/**
 * Below this camera distance the body is not drawn.
 *
 * The third-person camera pulls in to avoid terrain and can end up against the
 * player's own back in a tight corridor. Drawing the model then puts the camera
 * inside the head, which is a black screen with an ear in it — worse than the
 * momentary loss of the body.
 */
const HIDE_DIST = 0.9;

/**
 * `POSE`, compiled once to quaternions.
 *
 * Euler is what a human can edit and quaternion is what a slerp needs, and the
 * conversion is the same three trig calls every frame for every node otherwise.
 * Node names are resolved to nodes per instance, not here — the table outlives
 * any one character and the picker builds and throws away fifteen of them.
 */
const POSE_Q = {};
for (const [name, nodes] of Object.entries(POSE)) {
  POSE_Q[name] = Object.entries(nodes).map(([node, [x, y, z]]) => [
    node, new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)),
  ]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _pivot = new THREE.Vector3();
/** Scratch for `_clearPose`, reused so a per-frame reset allocates nothing. */
const _keyed = new Set();
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
    this.arms = { right: null, left: null };    // the `arm-*` nodes
    this.holdQ = { right: null, left: null };   // holding-* poses, null if absent
    this._holdW = { right: 0, left: 0 };        // eased 0..1, per arm
    this.swingT = 0;
    /** Which arm is mid-strike, and so is not holding its carrying pose. */
    this.swingHand = 'right';

    /**
     * The idle fidget: the action currently running, and the countdown to the
     * next one. See `_maybeFidget`.
     *
     * Held as the action rather than as a name so it can be faded out the
     * instant the player does something — a gesture that has to finish before
     * the body will walk is worse than no gesture at all.
     */
    this._fidget = null;
    this._fidgetT = FIDGET_MIN;

    /**
     * Told whenever the body changes character, so first person can wear the
     * same arms.
     *
     * A hook rather than a second call beside each of the three places that
     * choose a character (new game, load, the save's own metadata): those three
     * agree today and a fourth would be one more chance for the hands and the
     * body to be different people. There is one definition of "who the player
     * is" and it is `setCharacter`.
     * @type {?(id:string)=>void}
     */
    this.onCharacter = null;

    /**
     * The layered pose: which one, how strongly, and the kick's phase.
     *
     * One weight rather than one per pose. The three are mutually exclusive —
     * you cannot sneak while airborne — so a switch eases the old one out
     * through zero before the new one comes in, and passing through the neutral
     * standing pose on the way is not a compromise but the truth: the frame
     * between crouching and airborne is the frame you pushed off the ground.
     */
    this.pose = null;
    this._poseW = 0;
    /**
     * The bow draw's own weight, and its target.
     *
     * Eased rather than written straight through, and only one of the two
     * directions is the reason: the rise is already a ramp — `main.js` hands
     * over a charge clock that takes a second to fill — but the fall is a single
     * frame, because letting go of the button is instantaneous. Snapping four
     * node rotations back to the gait in one frame is a visible pop from behind.
     * At `DRAW_RATE` the arms come down in about a tenth of a second, which
     * reads as the release it is.
     */
    this._drawW = 0;
    this._drawTarget = 0;
    this._kick = 0;
    this._airT = 0;
    /** Resolved per instance, since the model arrives long after construction. */
    this._poseNodes = null;
    this._poseAll = null;
    this._actions = null;
    this._clipKeys = null;
    this._legs = { left: null, right: null };

    /**
     * Item meshes by id, built once and kept — one cache per hand.
     *
     * Per hand rather than one shared map, because a cached holder is a single
     * Object3D and an Object3D has one parent: putting the cached torch in the
     * left hand while the right already held it would *move* it there, and the
     * right hand would go empty without anything having been told. Two torches,
     * one in each hand, is an ordinary thing to want. Splitting the cache costs
     * at most one extra small mesh per item the offhand has ever held, and it
     * keeps the disposal rule below — a transient belongs to exactly one hand —
     * true by construction.
     *
     * Not rebuilt per equip: the sprite path in `createItemMesh` allocates a
     * fresh PlaneGeometry every call, and a player flicking through the hotbar
     * does that hundreds of times an hour. Caching sidesteps the disposal
     * question entirely, and the ceiling is the item table — a hundred small
     * meshes sharing geometry and materials with the drops already in the
     * world.
     */
    this._itemCache = { right: new Map(), left: new Map() };
    /**
     * The holder in each hand that is not cached, because its art had not
     * loaded yet. Per hand, and it has to be: one field was enough while there
     * was one hand, but a stand-in in the left hand would have overwritten the
     * right's and the right's geometry would then never be released — or worse,
     * the left's would be disposed while the right was still drawing it.
     */
    this._transient = { right: null, left: null };
    /** Anchors by hand: an empty Group parented into each `arm-*` node. */
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
    this.onCharacter?.(id);
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model = null;
      // Nodes of a body that is no longer in the scene. Left behind, the pose
      // would go on writing rotations into a discarded rig every frame — no
      // visible symptom, which is exactly why it would have survived.
      this._poseNodes = null;
      this._poseAll = null;
      this._actions = null;
      // An action belonging to a mixer that is about to be collected. Kept, it
      // would be faded out on behalf of a body nobody can see.
      this._fidget = null;
      for (const h of HANDS) {
        this.arms[h] = null;
        this.hands[h] = null;
        this.holdQ[h] = null;
        this._holdW[h] = 0;
        // The anchors went with the old body, so the new one's are empty and
        // must not be told they already hold what the last one did.
        this.heldItem[h] = -1;
        this._transient[h] = null;
      }
    }
  }

  /**
   * The block light falling on the body, as the terrain's emissive units.
   *
   * Third person only in practice — in first person the body is hidden and the
   * viewmodel has its own rig, which already warms to nearby flame through
   * `handLight` — but it is written unconditionally because the shadow the body
   * casts is drawn either way, and because a mode switch must not need a frame
   * to catch up.
   *
   * @param {{r:number,g:number,b:number}} l
   */
  setBlockLight(l) {
    const m0 = this.model;
    if (!m0 || !m0.owned) return;
    const prev = this._blockL;
    // The same 1/255 deadband the mobs use: standing still in the dark should
    // not write a uniform on every part of the body every frame.
    if (Math.abs(l.r - prev.r) < 0.004 && Math.abs(l.g - prev.g) < 0.004
      && Math.abs(l.b - prev.b) < 0.004) return;
    prev.r = l.r; prev.g = l.g; prev.b = l.b;
    for (const m of m0.owned) if (m.emissive) m.emissive.setRGB(l.r, l.g, l.b);
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
    // Materials are cloned per body, which they did not used to be.
    //
    // The old note here said the player never flashes red or burns and so needs
    // nothing of its own. It now needs one thing: block light. The body is an
    // entity — it reads no voxel light — so a torch at the player's feet lit
    // the ground and left the player on it black, exactly as it did the mobs.
    // The fix is `emissive * emissiveMap`, and an emissive written on the
    // prototype would be written on the shared material every husk and merchant
    // is cloned from. Cloning is the same rule Mobs follows, for the same
    // reason, and `map` is carried across untouched — writing to that texture
    // is what renders these models flat white.
    model.owned = [];
    model.root.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const cloned = Array.isArray(n.material)
        ? n.material.map((m) => m.clone())
        : n.material.clone();
      n.material = cloned;
      for (const m of (Array.isArray(cloned) ? cloned : [cloned])) {
        model.owned.push(m);
        if (m.map && m.emissive) { m.emissiveMap = m.map; m.needsUpdate = true; }
      }
    });
    this._blockL = { r: -1, g: -1, b: -1 };
    model.root.visible = false;
    this.scene.add(model.root);

    this.model = model;
    for (const h of HANDS) {
      const arm = model.root.getObjectByName(ARM_NODE[h]) || null;
      this.arms[h] = arm;
      this.holdQ[h] = this._readHoldPose(model, CLIP.hold[h]);
      if (!arm) continue;
      const anchor = new THREE.Group();
      anchor.position.copy(HAND_LOCAL[h]);
      arm.add(anchor);
      this.hands[h] = anchor;
    }

    // Resolve the pose tables' node names once. `getObjectByName` walks the
    // subtree, and doing that for six nodes across three tables every frame is
    // a tree search per limb per pose for names that cannot change.
    this._poseNodes = {};
    this._legs = {
      left: model.root.getObjectByName('leg-left') || null,
      right: model.root.getObjectByName('leg-right') || null,
    };
    for (const [name, entries] of Object.entries(POSE_Q)) {
      this._poseNodes[name] = entries
        .map(([node, q]) => [model.root.getObjectByName(node), q])
        .filter(([n]) => n);
    }

    // Every node any pose writes to, and which clip keys which node. Both exist
    // for `_clearPose` — see the comment there. Read off the clips themselves
    // rather than hard-coded, because "does `idle` key the legs?" is a fact
    // about the pack, and a list of node names copied into this file is a fact
    // about what the pack looked like the day it was copied.
    const all = new Map();
    for (const entries of Object.values(this._poseNodes)) {
      for (const [node] of entries) all.set(node.name, node);
    }
    this._poseAll = [...all.values()];
    this._clipKeys = {};
    this._actions = Object.entries(model.actions);
    for (const [name, action] of this._actions) {
      this._clipKeys[name] = new Set(
        action.getClip().tracks
          .filter((t) => t.name.endsWith('.quaternion'))
          .map((t) => t.name.slice(0, -'.quaternion'.length)),
      );
    }

    MobModels.play(model, CLIP.idle, 0);
  }

  /**
   * The one keyframe of a `holding-*` clip, as a quaternion, or null.
   *
   * Track names come out of GLTFLoader as `<node>.<property>`, so the arm's is
   * `arm-right.quaternion`. Each of these clips keys exactly one arm, which is
   * why finding the first quaternion track is enough — the clip name has
   * already picked the node. Reading the action's clip rather than reaching
   * into MobModels' private prototype map keeps this to the module's public
   * surface.
   *
   * The two poses are the same quaternion in this pack, so one read would do
   * today. It is done twice anyway: they are the same by coincidence of how the
   * pack was authored, not by any rule, and a pack that raised one arm higher
   * than the other would otherwise put the offhand item somewhere no comment
   * would explain.
   */
  _readHoldPose(model, name) {
    const clip = model.actions[name]?.getClip();
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
   *
   * @param {'right'|'left'} [hand] which arm struck. The view model works this
   *   out from what is in the two fists and passes it through `onPunch`; the
   *   default keeps every other caller — and any that forgets — on the old
   *   right-handed swing.
   */
  punch(hand = 'right') {
    this.swingHand = CLIP.attack[hand] ? hand : 'right';
    this.swingT = SWING_TIME;
    if (!this.model) return;
    // A fidget and a swing key the same three nodes, and two one-shots at
    // weight 1 are averaged by the mixer rather than stacked — so a punch
    // thrown mid-nod would be a half-hearted punch, which is a bug in the one
    // animation the player is looking at when it matters.
    this._stopFidget();
    const base = this.model.current;
    MobModels.playOnce(this.model, CLIP.attack[this.swingHand]);
    this.model.current = base;
  }

  /**
   * How far this body is drawing a bow, 0..1. Cheap enough to call every frame
   * from a game that is not drawing one — it writes a number.
   */
  setDraw(t) { this._drawTarget = Math.max(0, Math.min(1, t)); }

  /**
   * Play any one of the pack's clips once, over whatever gait is running.
   *
   * The public form of what `punch` does privately, and it exists so that the
   * twenty-odd clips this file does not drive are one call away rather than one
   * rewrite away: `character.gesture('pick-up')` when something goes in the
   * pack, `'emote-yes'` and `'emote-no'` for an accepted or refused trade,
   * `'interact-right'` at a chest or a door. Nothing calls it yet; that is the
   * point of it being here.
   *
   * Two things it is careful about, both of which a caller would otherwise get
   * wrong. `model.current` is put back, for the reason spelled out on `punch`:
   * `playOnce` clears it and the next frame's `play(walk)` would then reset the
   * gait to frame zero. And the clip is looked up in *this* model's actions, so
   * a character file that happens not to ship it is a no-op rather than a
   * throw.
   *
   * @param {string} name a clip name from the pack
   * @returns {number} the clip's duration in seconds, or 0 if it did not play
   */
  gesture(name) {
    const model = this.model;
    if (!model || !model.actions[name]) return 0;
    this._stopFidget();
    const base = model.current;
    const d = MobModels.playOnce(model, name);
    model.current = base;
    // So the body does not fidget on top of a gesture it was just given, and
    // does not immediately follow one with another.
    this._fidgetT = Math.max(this._fidgetT, d + 2);
    return d;
  }

  /** The body checks what it just picked up. See `gesture`. */
  pickUp() { return this.gesture('pick-up'); }

  /** A nod or a shake of the head. See `gesture`. */
  emote(yes = true) { return this.gesture(yes ? 'emote-yes' : 'emote-no'); }

  /**
   * Reach out and touch something — a chest, a door, a workbench.
   * @param {'right'|'left'} [hand]
   */
  interact(hand = 'right') { return this.gesture(`interact-${hand === 'left' ? 'left' : 'right'}`); }

  /**
   * Idle life: a small gesture when the body has genuinely been doing nothing.
   *
   * The gate is deliberately the whole of the player's state and not just
   * "speed is zero", because every one of these clauses is a way for a fidget
   * to look like a glitch rather than like a person:
   *
   *  - **Empty hands.** The carrying pose slerps the arms 85% of the way to
   *    `holding-*` after the mixer has run, so a nod performed while holding a
   *    torch is a nod with 15% of its arm motion left in it — a twitch. The
   *    fidgets are arm gestures; without hands free they are not worth playing.
   *  - **On the ground, not posed, not drawing, not swinging.** `air`, `swim`,
   *    `crouch` and `draw` are all layered *after* the mixer and would simply
   *    win, so the clip would run invisibly and the timer would be spent on
   *    nothing.
   *  - **Standing still.** 0.05 rather than 0, because a player leaning on a
   *    wall accumulates a whisper of tangential speed that never reaches the
   *    0.6 the gait cares about.
   *
   * Failing the gate rearms rather than pauses: the countdown restarts, so the
   * first fidget after a fight is a full interval away rather than instant.
   */
  _maybeFidget(dt, player) {
    const model = this.model;
    if (!model) return;

    const idle = player.grounded && !player.inWater && !this.pose
      && this._poseW < 0.02 && this._drawW < 0.02 && this.swingT <= 0
      && player.moveAmount < 0.05
      && this.heldItem.right <= 0 && this.heldItem.left <= 0;

    if (!idle) {
      this._stopFidget();
      this._fidgetT = FIDGET_MIN + Math.random() * (FIDGET_MAX - FIDGET_MIN);
      return;
    }
    if (this._fidget && !this._fidget.isRunning()) this._fidget = null;
    if (this._fidget) return;

    this._fidgetT -= dt;
    if (this._fidgetT > 0) return;
    this._fidgetT = FIDGET_MIN + Math.random() * (FIDGET_MAX - FIDGET_MIN);

    // This model's own clips, not the pack's — `d`, `l` and `o` are excluded
    // from the picker for being someone else, but nothing stops a save naming
    // one, and a character file with a short clip list must fidget less rather
    // than throw.
    const have = FIDGETS.filter((n) => model.actions[n]);
    if (!have.length) return;
    const name = have[(Math.random() * have.length) | 0];
    const base = model.current;
    MobModels.playOnce(model, name);
    model.current = base;
    this._fidget = model.actions[name];
  }

  /**
   * Let go of a fidget mid-gesture, without a pop.
   *
   * Faded rather than stopped. `stop()` removes the action's contribution
   * between one frame and the next, and since these clips key the torso and the
   * head — which `idle` also keys, at a different value — the body would snap.
   * A tenth of a second is under the reaction time of the input that
   * interrupted it.
   */
  _stopFidget() {
    if (!this._fidget) return;
    if (this._fidget.isRunning()) this._fidget.fadeOut(0.1);
    this._fidget = null;
  }

  /**
   * Put an item in a hand.
   *
   * @param {number} itemId 0 or -1 for empty
   * @param {'right'|'left'} which `right` is the selected hotbar slot, `left`
   *   the offhand.
   */
  setHeld(itemId, which = 'right') {
    const anchor = this.hands[which];
    if (!anchor) return;
    const id = itemId || 0;
    if (id === this.heldItem[which]) return;
    this.heldItem[which] = id;

    // Detached, never disposed.
    //
    // This used to dispose the geometry of a transient holder, on the grounds
    // that "its sprite plane is a geometry this class allocated". It is not:
    // the holder comes from the drop factory, whose sprite path returns a
    // module-level `PlaneGeometry` singleton and whose cube path returns an
    // entry from a per-block cache. Both are shared with every drop lying on
    // the ground.
    //
    // And the branch was exactly inverted with respect to the risk. A holder is
    // transient precisely when the item *has* a model that has not finished
    // loading — so the factory fell back to the shared sprite or the shared
    // cube. Disposing it deleted the buffer every bone, hide, sapling and
    // amethyst in the world draws from, and the cache goes on handing out the
    // dead object, so it never recovers: hold a pickaxe before its GLB lands,
    // press 2, and every sprite drop for the rest of the session renders from
    // freed memory.
    //
    // Nothing here is ours to free. `ViewModel` is the one that allocates its
    // own plane, and it tracks that with an `owns` flag precisely so it can.
    for (let i = anchor.children.length - 1; i >= 0; i--) {
      const child = anchor.children[i];
      anchor.remove(child);
      if (child === this._transient[which]) this._transient[which] = null;
    }
    if (!id) return;

    const cache = this._itemCache[which];
    let holder = cache.get(id);
    if (holder === undefined) {
      holder = this._buildItem(id, which);
      // An item whose art is still in flight gets the factory's stand-in and is
      // deliberately NOT cached, so the next equip asks again and picks up the
      // real model. Caching it would mean the first torch you ever hold is a
      // flat sprite for the rest of the session. `null` — an id with no
      // definition at all — is cached, because that never resolves.
      //
      // `_adoptPosed` normally gets there first, swapping the model in as soon
      // as it lands without waiting for an equip at all. This is still what
      // makes that safe rather than redundant: a stand-in that is never cached
      // cannot outlive the load however the two race.
      if (holder === null || !hasModel(id) || holder.userData.modelled) {
        cache.set(id, holder);
      } else {
        this._transient[which] = holder;
      }
    }
    if (holder) anchor.add(holder);
  }

  /**
   * The same item, in the same grip, as the first-person view gives it — or
   * null for anything without authored art.
   *
   * The generic path below builds a held item out of the *world* mesh: it
   * centres the art on its own bounding box and turns it end over end. That is
   * the right thing for a cube of dirt and wrong for everything that was
   * modelled, because `ItemModels` already carries a hand-authored pose per
   * item — a rotation chosen so the tool reads as gripped, and a `grip`
   * fraction that moves the geometry's origin to the point where the fist
   * actually closes on it. First person uses all of that. Third person used
   * none of it, so a pickaxe you were holding correctly at the shaft in first
   * person was held by the middle of its own bounding box, at a rotation
   * nothing chose, the moment the camera pulled back. Every modelled item was
   * wrong in the same way, which is why it read as "third person holds things
   * wrong" rather than as one bad tool.
   *
   * `heldModel` hands back a clone with that pose baked into its transform, so
   * the work here is only to carry it across two differences between the views:
   *
   * - **Frame.** A view-model pose is expressed in view space, where the camera
   *   looks down -Z and `ViewModel`'s hand group has cancelled the arm's rest
   *   tilt — so the authored rotation is read straight off the screen. Here the
   *   item hangs off the `arm-*` node, whose limb runs down its own -Y (the same
   *   fact the generic path's half turn is about) and which the `holding-*` clip
   *   swings to the body's forward, +Z.
   *
   *   A quarter turn about X takes -Z to -Y and so lines the long axis up, but
   *   it pins only two axes: the roll about the limb is still free, and getting
   *   it wrong is a pickaxe held with its head facing backwards rather than an
   *   obviously broken transform. It has to be pinned by the observer, not by
   *   the limb. **The camera and the body do not face the same way**: the body
   *   is built with its forward at +Z and a three camera looks down -Z, so a
   *   direction on screen becomes a direction on the body by flipping *both*
   *   horizontal axes — Ry(π) — which is why `holder` takes the same two turns
   *   `ViewModel._tryArms` gives the arm it lifts out of this very rig.
   *
   *   The quarter turn alone was 180° out about the limb axis, measured against
   *   both chains built out of the real constants: every item came out rolled
   *   half a turn, +Y off by 112° for the pickaxe, 174° for the apple. With
   *   Rx(π/2)Ry(π) the item's own axes land on the first-person ones to within
   *   floating point, for every pose in the table and for either hand.
   * - **Position.** `pose.pos` is deliberately dropped. It nudges an item clear
   *   of the arm *in the first-person frame* — screen framing, not grip — and
   *   carrying it over would push the item off the fist here. With the origin
   *   already at the grip and the anchor already at the hand, zero is correct.
   *
   * Scale keeps the relative sizing the pose table encodes, rather than fitting
   * every item to one length the way the generic path does: an apple is meant
   * to be smaller in the hand than a pickaxe, and normalising both to the same
   * longest axis is what makes a held apple look like a beach ball.
   */
  _buildPosedItem(itemId, onReady) {
    const posed = heldModel(itemId, onReady ? (m) => onReady(this._wearPose(m)) : null);
    return posed ? this._wearPose(posed) : null;
  }

  /**
   * The holder around one posed clone — the whole of the frame change.
   *
   * Both hands take it unmirrored, which is the answer to a question worth
   * writing down because `HAND_LOCAL` *is* mirrored a few lines up. That offset
   * is mirrored because the pack mirrors the arm *geometry* while leaving the
   * node alone, so the two limbs' centre lines sit either side of their own
   * origins. The node's axes are not mirrored, `holding-left` is the same
   * quaternion as `holding-right`, and `ViewModel` puts an offhand item at the
   * pose's rotation exactly as it does a main-hand one. So the two hands want
   * the same roll, and giving the left one a mirrored turn would be the offhand
   * holding its torch upside down. Measured, not assumed: both hands land on
   * the first-person orientation to within floating point.
   */
  _wearPose(posed) {
    posed.position.set(0, 0, 0);

    const holder = new THREE.Group();
    holder.userData.modelled = true;
    // XYZ order: Rx then Ry. See `_buildPosedItem` for what each turn is for.
    holder.rotation.set(Math.PI / 2, Math.PI, 0);
    holder.scale.setScalar(HELD_POSE_SCALE);
    holder.add(posed);
    return holder;
  }

  /**
   * A model that finished loading after the item was already in the fist.
   *
   * `heldModel` answers null until the GLB lands, so the first time a player
   * ever equips a pickaxe the posed path cannot run and the generic path hands
   * back the drop factory's sprite. `setHeld` deliberately does not cache that
   * stand-in, so a *re-equip* picks up the real model — but on its own that
   * means the first pickaxe you ever hold stays a flat card until you press a
   * hotbar key twice, which is a second or two of the exact bug this file is
   * fixing. `ViewModel` has always swapped itself in through `_adoptModel`;
   * this is the same handshake for the body.
   *
   * The hand is captured with the request rather than looked up, for the reason
   * `ViewModel._adoptModel` gives: between asking and answering the same item
   * may have moved to the other fist, and `heldItem` alone cannot tell.
   *
   * Nothing is disposed here — the stand-in's geometry is the drop factory's
   * shared sprite plane, and freeing it takes every drop in the world with it.
   * See the long note in `setHeld`; detaching is the whole of the release.
   */
  _adoptPosed(which, itemId, holder) {
    const cache = this._itemCache[which];
    // Already resolved by an earlier equip's callback — this one is a duplicate
    // request from a second equip made while the same load was still in flight.
    if (cache.has(itemId)) return;
    cache.set(itemId, holder);
    // Cached either way, but only swapped in if that hand is still holding it.
    if (this.heldItem[which] !== itemId) return;
    const anchor = this.hands[which];
    if (!anchor) return;
    const stale = this._transient[which];
    if (stale) { anchor.remove(stale); this._transient[which] = null; }
    anchor.add(holder);
  }

  /**
   * Wrap an item's world mesh so it sits in the fist at a sensible size.
   *
   * The wrapper exists because the mesh's own transform is not ours to write:
   * `createItemMesh` hands back a shared or cached object for the modelled and
   * cube paths, and posing it in place would pose it for the drop lying on the
   * ground too.
   */
  _buildItem(itemId, which) {
    // An item with authored art is posed the way the first-person view poses
    // it. See `_buildPosedItem` for why this is not the generic path. The
    // callback is what makes the *first* equip of an item catch up on its own
    // once the GLB lands, rather than waiting for the player to re-equip it.
    const posed = this._buildPosedItem(itemId, (h) => this._adoptPosed(which, itemId, h));
    if (posed) return posed;

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
   * @param {number} offhandItem what is in the offhand slot, 0 for empty
   */
  update(dt, player, shown, heldItem, offhandItem = 0) {
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
    this.setHeld(offhandItem, 'left');

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

    // --- which pose, and how much of it ---
    // Read off state the physics already publishes, so the body cannot claim to
    // be doing something the collision box is not. Order is a priority: a
    // swimmer is not airborne even though both feet are off the ground, and
    // holding crouch under water swims rather than sneaks.
    const swimming = player.inWater && !player.grounded;
    this._airT = player.grounded || swimming ? 0 : this._airT + dt;
    // A hop is not a fall. Every jump leaves the ground, and posing on that
    // alone throws the arms overhead each time the player clears a fence —
    // ridiculous at the rate people jump in this game. It takes either real
    // airtime or real downward speed, which between them mean "this is not
    // going to end in a step".
    const falling = this._airT > AIR_DELAY || player.vel.k < -AIR_SPEED;
    const wantPose = swimming ? 'swim'
      : !player.grounded && falling ? 'air'
      : player.crouching ? 'crouch'
      : null;
    if (wantPose !== this.pose) {
      // Fade the old one out first and only then adopt the new name, so the two
      // never mix. Mixing them would need a weight each and a rule for what a
      // half-crouched half-falling body is, for a transition that lasts under a
      // fifth of a second.
      this._poseW = Math.max(0, this._poseW - dt * POSE_RATE);
      if (this._poseW <= 0.001) this.pose = wantPose;
    } else if (this.pose) {
      this._poseW = Math.min(1, this._poseW + dt * POSE_RATE);
    }

    // The rig's origin is between the feet, which is exactly where
    // `player.position` is. `stepOffset` is the same smoothing the camera
    // applies over a one-block step-up — without it the body would pop a block
    // while the view eased.
    model.root.position.copy(player.position).addScaledVector(player.up, -player.stepOffset);
    if (this.pose === 'crouch') {
      model.root.position.addScaledVector(player.up, -CROUCH_SINK * this._poseW);
    } else if (this.pose === 'swim') {
      this._swim(player);
    }

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

    // After the gait has been chosen and before the mixer runs, so a fidget
    // started this frame is drawn this frame, and so `current` is already the
    // gait's name when `_maybeFidget` saves and restores it.
    this._maybeFidget(dt, player);

    model.mixer.update(dt);

    // --- the carrying pose, layered by hand ---
    // Strictly after mixer.update: the mixer rewrites the arms' rotations from
    // the clip every frame, so anything written before it is gone. That is also
    // what keeps this from compounding — each frame slerps from a freshly
    // animated value, not from last frame's result.
    //
    // Both arms, and only the arm that struck lets go of what it is carrying.
    // The other keeps its hold pose right through the swing — the attack clips
    // key both arms, so without that it would be the mixer's counter-swing that
    // decided where the offhand torch went, which is a wind-up nobody asked the
    // left arm to perform.
    // --- falling, swimming, sneaking ---
    // Before the carrying pose, not after, and that order is the whole design:
    // the hold slerp runs at 0.85 and so leaves a trace of whatever it found,
    // which means a swimmer holding a torch reaches with that arm and paddles
    // with the empty one, from one rule rather than from a table of exceptions.
    this._clearPose();
    if (this._poseW > 0.002 && this.pose && this._poseNodes) {
      const w = this._poseW;
      for (const [node, q] of this._poseNodes[this.pose]) node.quaternion.slerp(q, w);
      if (this.pose === 'swim') {
        // The kick, added on top of the posed legs. Advanced only while
        // swimming, so surfacing and diving again resumes mid-stroke rather
        // than snapping to the phase the clock happens to be at.
        this._kick += dt * KICK_RATE;
        const s = Math.sin(this._kick) * KICK_SWING * w;
        if (this._legs.left) this._legs.left.rotateX(s);
        if (this._legs.right) this._legs.right.rotateX(-s);
      }
    }

    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
    for (const h of HANDS) {
      const swinging = h === this.swingHand && this.swingT > 0;
      const want = this.heldItem[h] > 0 && !swinging ? 1 : 0;
      this._holdW[h] += (want - this._holdW[h]) * Math.min(1, dt * 9);
      const arm = this.arms[h];
      const q = this.holdQ[h];
      if (arm && q && this._holdW[h] > 0.002) {
        arm.quaternion.slerp(q, this._holdW[h] * HOLD_BLEND);
      }
    }

    // --- the bow draw ---
    // Last, and after the carrying pose rather than before it, because a bow is
    // the one thing where the carry is *wrong*: `holding-right` presents an
    // object out in front of the chest, and an archer's bow arm is locked out
    // straight along the shot. Layering the draw over it at full weight is what
    // overrides that, and the two arms move as one gesture because both are in
    // the same table.
    //
    // The item in each hand rides along for free: the anchors are children of
    // the `arm-*` nodes, so posing the nodes carries the bow and the arrow with
    // them. Nothing here knows what is being held.
    this._drawW += (this._drawTarget - this._drawW) * Math.min(1, dt * DRAW_RATE);
    if (this._drawW > 0.002 && this._poseNodes?.draw) {
      for (const [node, q] of this._poseNodes.draw) node.quaternion.slerp(q, this._drawW);
    }
  }

  /**
   * Undo a pose on any node the running clips will not overwrite themselves.
   *
   * **The mixer does not clear what it does not key.** `idle` has four tracks —
   * torso, both arms, head — and no legs, because a standing figure's legs do
   * not move. So a pose that bent the legs and then faded to nothing left them
   * bent *permanently*: weight 0, `pose` null, and both legs still sitting at
   * the crouch's -0.34 until the player happened to walk, at which point `walk`
   * — which does key legs — quietly fixed it.
   *
   * That is why it survived a screenshot. Standing and crouching looked
   * identical in a still, and both looked plausible; only measuring the node
   * rotations with the pose provably off showed the legs had never come back.
   *
   * The rule is therefore: a pose owns a node only for as long as something
   * else will take it back. Every frame, any pose-owned node that no *running*
   * action keys is returned to its rest rotation — identity for this rig, for
   * every node, which is also what makes `holding-right`'s single keyframe
   * usable as an absolute pose. Running actions rather than just the current
   * one, because a crossfade has two, and forcing identity through a walk→idle
   * fade would fight the very clip that is on its way to fixing the legs.
   */
  _clearPose() {
    if (!this._poseAll) return;
    // Gathered once per frame rather than per node: the pack has 27 actions and
    // asking each of them about each of six nodes is 162 questions a frame to
    // answer one, and `Object.entries` would allocate on every one of them.
    const keyed = _keyed;
    keyed.clear();
    for (const [name, action] of this._actions) {
      if (!action.isRunning() || action.getEffectiveWeight() <= 0.001) continue;
      const set = this._clipKeys[name];
      if (set) for (const n of set) keyed.add(n);
    }
    for (const node of this._poseAll) {
      if (!keyed.has(node.name)) node.quaternion.identity();
    }
  }

  /**
   * Tip the whole body face-down, about its own middle.
   *
   * The limbs are posed by the table; this is the rotation no node can do,
   * because every node of this rig hangs off a `root` whose job is to stand the
   * body up. Pitching is therefore done to the model's own transform, after the
   * basis has been written.
   *
   * **About its middle, not its feet.** Rotating in place — the one-line version
   * — pivots at the origin between the boots, which is where `player.position`
   * is, and 70° of that swings the head a metre forward and straight through
   * whatever is in front, while the feet stay pinned at a point no swimmer's
   * feet are. Keeping the mid-height fixed instead costs one vector: the point
   * `up * h/2` moves to `R * (up * h/2)` under the pitch, so translating back by
   * the difference nails it in place and the body rotates about its own waist.
   *
   * The pitch itself scales with tangential speed, and `_poseW` scales the whole
   * thing so entering and leaving the water tips rather than snaps.
   */
  _swim(player) {
    const drive = THREE.MathUtils.clamp(player.moveAmount / 4.4, 0, 1);
    const pitch = (SWIM_PITCH_MIN + (SWIM_PITCH_MAX - SWIM_PITCH_MIN) * drive) * this._poseW;
    if (pitch < 0.002) return;

    // About the side axis — the body's own left-right — which the orientation
    // block has already worked out and normalised for the basis.
    _qp.setFromAxisAngle(_side, pitch);
    this.model.root.quaternion.premultiply(_qp);

    _pivot.copy(player.up).multiplyScalar(PLAYER_HEIGHT * 0.5);
    this.model.root.position.add(_pivot).sub(_pivot.applyQuaternion(_qp));
  }

  /** Menus and the loading screen: no body anywhere near the orbit camera. */
  hide() {
    if (this.model) this.model.root.visible = false;
    this.visible = false;
  }
}

// ---------------------------------------------------------------------------
// The New Game picker's preview
// ---------------------------------------------------------------------------

/**
 * How far apart the figures stand on the strip, in frustum units.
 *
 * The frustum is one unit wide (see `_init`), so anything at a whole multiple
 * of this is entirely off screen: at any moment exactly one character is
 * visible and the other fourteen are waiting in the wings. That is what makes
 * the carousel a *translation* of one strip rather than a rebuild — the slide
 * from one face to the next is the same lerp that used to grow the selected
 * cell, and nothing has to be created or destroyed to move between them.
 */
const SPACING = 1.25;

/** How fast the strip chases the chosen character, in fraction per second. */
const SLIDE_RATE = 11;

/**
 * A figure's height as a fraction of the frame.
 *
 * Not the whole frame, and it cannot be. This rig carries its head as a child
 * of `torso`, hanging two model units above the torso's pivot and occupying the
 * top thirty per cent of the body — and every clip, `idle` included, animates
 * that pivot's rotation. So a tilt of a few degrees swings the top of the head
 * further than any margin measured off the rest pose would predict, and the
 * grid this replaced was decapitating its top row at 0.72 for exactly that
 * reason. One at a time affords more room than a five by three wall did, but
 * the headroom still has to be real.
 */
const PREVIEW_HEIGHT = 0.66;

/**
 * The rig, by name, for the preview's rest-restore. See `_rest`.
 *
 * `root` is in the list and the other six are limbs, which is the whole reason
 * the list exists rather than being the pose tables' node set: the attack and
 * kick clips key `root.translation`, and in the game that is harmless because
 * `update` writes the body's position from the player every frame. Nothing
 * writes it here. A picker figure that threw one punch would stand a few
 * centimetres off its mark for the rest of the session.
 */
const PREVIEW_NODES = ['root', 'torso', 'head', 'arm-left', 'arm-right', 'leg-left', 'leg-right'];

/**
 * One signature gesture each, so that arriving at a character shows you
 * something about them.
 *
 * This is the answer to "they are all doing the same thing", and they were: the
 * picker played `idle` on fifteen copies of one body and the only difference
 * between two cells was the texture. The pack ships twenty-seven clips and
 * nine of them are gestures a standing person can perform, so each character
 * gets one and no two neighbours share it — the sequence matters, because the
 * carousel is walked left and right and two adjacent nods read as the arrow not
 * having worked.
 *
 * The kicks and the melee swings are in here deliberately, and they are the
 * ones that make this cost anything: they key the legs and `root.translation`,
 * neither of which `idle` keys, so neither comes back on its own when the
 * one-shot ends. `_rest` is what makes them safe, and it is written as a
 * general rule rather than as a special case for these four so that changing an
 * entry in this table stays a one-word edit.
 */
const PREVIEW_GESTURE = {
  a: 'emote-yes',
  b: 'interact-right',
  c: 'attack-kick-right',
  e: 'emote-no',
  f: 'pick-up',
  g: 'interact-left',
  h: 'attack-melee-right',
  i: 'emote-yes',
  j: 'interact-right',
  k: 'attack-kick-left',
  m: 'emote-no',
  n: 'pick-up',
  p: 'interact-left',
  q: 'attack-melee-left',
  r: 'emote-yes',
};

/**
 * How each of them stands, layered over `idle` the way the carrying pose is
 * layered over the gait.
 *
 * A gesture every few seconds fixes the moment you arrive at a character; this
 * fixes the other four seconds. Fifteen figures playing one idle clip have one
 * silhouette between them, and silhouette is most of what tells two blocky
 * people apart at this size — so this is a handful of Euler angles each,
 * slerped toward at `STANCE_BLEND` after the mixer has run, which leaves the
 * idle breathing underneath rather than replacing it.
 *
 * Angles follow the sign rule stated at length on `POSE`, and it is the rule
 * that makes these readable rather than a table of magic numbers: **negative X
 * carries an arm or a leg forward and positive carries it back, and that
 * inverts for the torso and the head**, which stand up their own +Y — so
 * positive X folds a chest down and lifts nothing. Z is splay, outward being
 * positive on the right and negative on the left. Y is a turn.
 *
 * Kept small. Everything here is under 0.6 radians and most of it under 0.3,
 * because the failure mode is not subtlety — it is fifteen people in fifteen
 * yoga positions, which is a lineup of mannequins by a different route.
 */
const STANCE = {
  /** Rowan: at ease, hands a little behind, chin up. */
  a: { torso: [-0.05, 0, 0], 'arm-right': [0.16, 0, 0.10], 'arm-left': [0.16, 0, -0.10] },
  /** Mira: head cocked, weight on the right leg. */
  b: { head: [0, 0, 0.14], torso: [0, 0, 0.05], 'leg-right': [0, 0, 0.10], 'leg-left': [0, 0, -0.03] },
  /** Tomas: broad, arms and feet out. */
  c: {
    'arm-right': [0, 0, 0.26], 'arm-left': [0, 0, -0.26],
    'leg-right': [0, 0, 0.12], 'leg-left': [0, 0, -0.12],
  },
  /** Ines: hands held together in front. */
  e: { 'arm-right': [-0.22, 0, -0.06], 'arm-left': [-0.22, 0, 0.06] },
  /** Nadia: looking off to one side. */
  f: { head: [0, 0.42, 0], torso: [0, 0.10, 0] },
  /** Kofi: right arm half raised, mid-thought or mid-wave. */
  g: { 'arm-right': [-0.45, 0, 0.18], 'arm-left': [0.08, 0, -0.06] },
  /** Sanne: slouched, head up anyway. */
  h: {
    torso: [0.14, 0, 0], head: [-0.12, 0, 0],
    'arm-right': [0.20, 0, 0.06], 'arm-left': [0.20, 0, -0.06],
  },
  /** Yusuf: bolt upright, arms in. */
  i: { torso: [-0.12, 0, 0], head: [0.06, 0, 0], 'arm-right': [0, 0, 0.03], 'arm-left': [0, 0, -0.03] },
  /** Bela: hands on hips, as near as a rig with no elbow gets. */
  j: { 'arm-right': [0.30, 0, 0.34], 'arm-left': [0.30, 0, -0.34] },
  /** Priya: head cocked the other way, one foot forward. */
  k: { head: [0, 0, -0.13], 'leg-right': [-0.14, 0, 0.05], 'leg-left': [0.06, 0, -0.05] },
  /** Otto: heavy, leaning back, planted wide. */
  m: {
    torso: [-0.14, 0, 0], head: [0.10, 0, 0],
    'arm-right': [0, 0, 0.20], 'arm-left': [0, 0, -0.20],
    'leg-right': [0, 0, 0.16], 'leg-left': [0, 0, -0.16],
  },
  /** Amara: turned away a quarter, left arm across. */
  n: { torso: [0, -0.22, 0], head: [0, 0.16, 0], 'arm-left': [-0.30, 0, 0.16] },
  /** Halvard: arms up and folded across the chest. */
  p: { 'arm-right': [-0.55, 0, -0.10], 'arm-left': [-0.55, 0, 0.10] },
  /** Lucia: turned the other quarter, looking down and away. */
  q: { torso: [0, 0.26, 0], head: [0, -0.18, 0.08] },
  /** Emeka: right shoulder forward, left foot back. */
  r: { 'arm-right': [-0.34, 0, 0.06], 'arm-left': [0.18, 0, -0.06], 'leg-left': [0.16, 0, 0] },
};

/**
 * `STANCE`, compiled to quaternions once — the same trade `POSE_Q` makes, for
 * the same reason, and it matters more here: fifteen figures times a handful of
 * nodes is a hundred-odd Euler conversions a frame otherwise.
 */
const STANCE_Q = {};
for (const [id, nodes] of Object.entries(STANCE)) {
  STANCE_Q[id] = Object.entries(nodes).map(([node, [x, y, z]]) => [
    node, new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)),
  ]);
}

/**
 * How much of the stance survives the idle clip.
 *
 * The same shape of number as `HOLD_BLEND` and for the same reason: at 1 the
 * stance is a photograph and the figure stops breathing, which on a screen
 * showing one large character is immediately a still image. At 0.62 the
 * silhouette is unmistakably that person's and the chest and head still move.
 */
const STANCE_BLEND = 0.62;

/** How fast the stance yields to a gesture and comes back after, per second. */
const STANCE_RATE = 6;

/** Seconds after arriving at a character before they do their thing. */
const GESTURE_FIRST = 0.55;

/** And between repeats, while they stay selected. */
const GESTURE_EVERY = 4.2;

/** Scratch for `_rest`: node names keyed by a running action, this frame. */
const _rotKeyed = new Set();
const _posKeyed = new Set();

/**
 * Which node each clip writes a rotation to, and which a translation.
 *
 * Read off the clips rather than listed here, for the reason `_clipKeys` gives
 * in the body above: "does `emote-yes` key the legs?" is a fact about the pack,
 * and the same question written down in this file is a fact about what the pack
 * looked like the day someone wrote it down. GLTFLoader names a track
 * `<node>.<property>`, so the split is on the suffix.
 *
 * @param {Object<string, THREE.AnimationAction>} actions
 */
function trackKeys(actions) {
  const keys = {};
  for (const [name, action] of Object.entries(actions)) {
    const rot = new Set();
    const pos = new Set();
    for (const t of action.getClip().tracks) {
      const dot = t.name.lastIndexOf('.');
      if (dot < 0) continue;
      const node = t.name.slice(0, dot);
      const prop = t.name.slice(dot + 1);
      if (prop === 'quaternion') rot.add(node);
      else if (prop === 'position') pos.add(node);
    }
    keys[name] = { rot, pos };
  }
  return keys;
}

/**
 * Skins, kept for the session. Not disposed with the rest of the picker: they
 * are a quarter of a megabyte in total and a player who backs out of New Game
 * and comes straight back should not watch fifteen grey mannequins fill in
 * twice.
 */
const _skins = new Map();
const _texLoader = new THREE.TextureLoader();

/**
 * The character carousel shown when a new planet is started.
 *
 * One figure at a time, with the other fourteen standing off screen on the same
 * strip. It was a five by three wall until a player said it should be "a
 * carousel like 1 character at a time then navigational arrows to select", and
 * they were right for a reason worth recording: fifteen figures at a fifth of
 * the width each are fifteen thumbnails of people who differ only in face, hair
 * and clothing, which is to say fifteen identical silhouettes. Shown alone, one
 * is big enough to actually be a choice.
 *
 * The choice is only meaningful if you can see it — these fifteen differ in
 * face, hair and clothing and in nothing else, so a list of names would be a
 * list of names. Three ways to show them were on the table:
 *
 *  - Fifteen GLBs, one per cell. Honest, and 1.7MB fetched at the exact moment
 *    the player has asked to start playing. Rejected on that alone.
 *  - Thumbnails baked at build time. Free at runtime, but it adds a build step
 *    and a folder of images that silently go stale the day the pack changes.
 *  - One model, fifteen skins — what this is.
 *
 * The third works because of an accident of the pack that is worth stating
 * plainly, since it is load-bearing: every `character-*.glb` is byte-for-byte
 * the same geometry and the same twenty-seven clips, and differs only in which
 * PNG it points at. So the picker clones the one model the game already loaded
 * at boot and assigns each cell that character's texture. Fifteen live, moving
 * figures for fifteen small PNGs and no extra model bytes at all.
 *
 * The risk that buys: if the pack ever ships a character with different
 * geometry, the preview would quietly show the wrong body while the game showed
 * the right one. That is a real hazard and the reason it is written down here —
 * the fix, if it ever happens, is to fetch each cell's own GLB.
 */
export class CharacterPicker {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    /** @type {{id:string, model:object, holder:THREE.Group, mat:THREE.Material}[]} */
    this.figures = [];
    /** The strip every figure hangs off. Sliding this is the whole carousel. */
    this.track = null;
    /**
     * Clip name -> which nodes it drives, shared by all fifteen figures because
     * all fifteen are clones of one URL. Built on the first figure. See `_rest`.
     */
    this._keys = null;
    this.selected = DEFAULT_CHARACTER;
    /** Where the strip is, and where it is heading, in frustum units. */
    this._x = 0;
    this._targetX = 0;
    this._raf = 0;
    this._last = 0;
    this._w = 0;
    this._h = 0;
  }

  /**
   * Show the carousel. `baseUrl` is a character whose GLB is already through
   * `MobModels.prepare` — normally the one the player is currently wearing,
   * which the boot loader has fetched.
   */
  open(selected, baseUrl) {
    if (!this.renderer) this._init();
    if (!this.figures.length) this._build(baseUrl);
    // Snapped, not slid: reopening the picker on the character you last chose
    // should not begin with a scroll past everyone in between.
    this.setSelected(selected, true);
    this._last = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  /**
   * Stop drawing. Deliberately keeps the renderer, the scene and the figures.
   *
   * Disposing the renderer is the obvious thing and it is a trap: a canvas
   * hands out exactly one WebGL context in its lifetime, so a second
   * `WebGLRenderer` built on this same canvas would be handed the first one
   * back — and if the first was torn down properly, a dead one. Reopening the
   * picker would then draw nothing. An idle context on a 15-cell canvas is a
   * couple of megabytes; that is the cheaper mistake.
   */
  close() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.renderer?.renderLists.dispose();
  }

  /**
   * Choose a character, and aim the strip at them.
   *
   * @param {string} id
   * @param {boolean} [snap] put the strip there this instant rather than
   *   sliding. Used on open, and on a wrap: stepping left off the first
   *   character lands on the fifteenth, and *sliding* there would scroll past
   *   all thirteen in between, which reads as the arrow having gone the wrong
   *   way. Wrapping is a jump, so it looks like one.
   */
  setSelected(id, snap = false) {
    this.selected = id;
    // Arm the new arrival's gesture. Only the selected figure's clock runs — see
    // `_loop` — so this is what makes stepping onto a character show you what
    // they do, rather than making you wait out whatever was left of a timer
    // from the last time you passed through.
    for (const fig of this.figures) if (fig.id === id && !fig.act) fig.next = GESTURE_FIRST;
    const n = CHARACTER_IDS.indexOf(id);
    if (n >= 0) this._targetX = -n * SPACING;
    if (snap) {
      this._x = this._targetX;
      if (this.track) this.track.position.x = this._x;
    }
  }

  _init() {
    // `alpha` so the card's own background shows through — the stage behind the
    // canvas is a lit panel, and these characters are mostly dark hair and dark
    // clothing.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    // Orthographic, and one unit square. Under perspective a figure sliding in
    // from the side would lean away from the middle and only stand up straight
    // once it arrived, which is a distortion nobody asked the arrows for. A
    // square frustum on a square canvas also means one frustum unit is one
    // canvas width, which is what `SPACING` is stated in.
    this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 20);
    this.camera.position.z = 8;
    // Every figure hangs off this, so the slide is one transform per frame
    // rather than fifteen.
    this.track = new THREE.Group();
    this.scene.add(this.track);

    // Lifted wholesale from `Icons.js`, which paints item thumbnails through a
    // renderer with no ACES pass on it — exactly the situation here. Its comment
    // is the reason not to reach for the view model's brighter rig instead:
    // without the tone-mapping pass those intensities come out blown and
    // chalky, which on a character reads as a face with no features on it.
    const key = new THREE.DirectionalLight(0xfff4e2, 1.15);
    key.position.set(-0.35, 0.85, 1.0);
    const rim = new THREE.DirectionalLight(0xbcd6f5, 0.35);
    rim.position.set(0.8, 0.1, -0.7);
    const fill = new THREE.HemisphereLight(0xf0f6ff, 0x9aa0aa, 1.1);
    this.scene.add(key, rim, fill);
  }

  _build(baseUrl) {
    // Any loaded character will do as the body — see the class comment. The
    // fallback matters on the path where a save's character failed to fetch:
    // better a wall of the wrong-but-present body than an empty picker.
    const url = MobModels.isReady(baseUrl)
      ? baseUrl
      : CHARACTER_IDS.map(characterUrl).find((u) => MobModels.isReady(u));
    if (!url) return;

    CHARACTER_IDS.forEach((id, n) => {
      const model = MobModels.instantiate(url);
      if (!model) return;

      // The prototype's own material, read before it is replaced. Cloning it
      // rather than writing a fresh MeshStandardMaterial here is not tidiness:
      // it carries `lit()`'s roughness and metalness, the side and alpha flags
      // the export asked for, and — through its `map` — the sampler settings
      // that `_skin` copies. Every one of those is a question GLTFLoader has
      // already answered correctly for this exact file.
      let template = null;
      model.root.traverse((o) => { if (o.isMesh && !template) template = o.material; });

      const mat = template
        ? template.clone()
        : new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
      // Grey until the skin lands. The tempting placeholder — leaving the
      // prototype's texture on — would show fifteen copies of one character's
      // clothes for the first second, which is a picker actively lying about
      // the choice.
      mat.map = null;
      mat.color.setHex(0x39405a);
      model.root.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; } });

      // Fit measured off this clone rather than taken from
      // `MobModels.modelHeight`. Same number today — 2.7 — but this also yields
      // the box's *centre*, and centring on it is what keeps the head off the
      // top of the frustum once `idle` starts swinging the torso.
      _box.setFromObject(model.root);
      _box.getSize(_size);
      _box.getCenter(_centre);
      const scale = PREVIEW_HEIGHT / (_size.y || 1);
      model.root.scale.setScalar(scale);
      model.root.position.copy(_centre).multiplyScalar(-scale);

      // One per station along the strip. The figure is centred on its holder,
      // so the spin happens about its own middle wherever the strip has slid
      // to.
      const holder = new THREE.Group();
      holder.position.set(n * SPACING, 0, 0);
      holder.add(model.root);
      this.track.add(holder);

      // Which node each clip writes to, built once and shared by all fifteen —
      // every figure is a clone of the same URL, so the answer cannot differ
      // between them, and asking twenty-seven clips about their tracks fifteen
      // times would be the picker's most expensive moment for no new
      // information.
      if (!this._keys) this._keys = trackKeys(model.actions);

      // The rest pose, captured before a single clip has touched the rig. This
      // is what `_rest` puts back, and it has to be read here rather than
      // assumed to be identity: identity happens to be right for the rotations
      // in this pack, but `root` sits at a translation of its own and a figure
      // restored to zero would sink into the floor of the frame.
      const rest = [];
      for (const name of PREVIEW_NODES) {
        const node = model.root.getObjectByName(name);
        if (node) rest.push([node, node.position.clone(), node.quaternion.clone()]);
      }

      // Both tables degrade to nothing rather than to a wrong answer: a
      // character with no stance simply stands, one whose gesture clip is
      // absent from its own file simply does not gesture.
      const gestureName = model.actions[PREVIEW_GESTURE[id]] ? PREVIEW_GESTURE[id] : null;

      const fig = {
        id, model, holder, mat,
        ref: template?.map || null,
        // What the colour goes back to once the map lands — white for these,
        // but read off the export rather than assumed.
        tint: template ? template.color.clone() : new THREE.Color(0xffffff),
        rest,
        /** The stance, with its node names already resolved on this clone. */
        stance: (STANCE_Q[id] || [])
          .map(([node, q]) => [model.root.getObjectByName(node), q])
          .filter(([n2]) => n2),
        stanceW: 0,
        gesture: gestureName,
        /** The gesture action while it runs, and the countdown to the next. */
        act: null,
        next: GESTURE_FIRST,
        /**
         * The only actions this figure can ever have running. `_rest` asks each
         * of them whether it is contributing, and asking two is the difference
         * between thirty questions a frame and four hundred.
         */
        live: [model.actions[CLIP.idle], gestureName && model.actions[gestureName]]
          .filter(Boolean)
          .map((a) => [a, a.getClip().name]),
      };
      this.figures.push(fig);
      MobModels.play(model, CLIP.idle, 0);
      // Offset each one into the clip so the wall breathes rather than pulsing
      // in unison, which reads as fifteen copies of one person. The rates are
      // spread too — five of them, cycled — because two figures at the same
      // speed drift back into step every time the phase offset comes round.
      model.actions[CLIP.idle]?.setEffectiveTimeScale(0.86 + (n % 5) * 0.07);
      model.mixer.update(n * 0.37);
      this._skin(fig);
    });
  }

  _skin(fig) {
    const url = characterTextureUrl(fig.id);
    const cached = _skins.get(url);
    if (cached) { this._apply(fig, cached); return; }
    _texLoader.load(url, (tex) => {
      this._configure(tex, fig.ref);
      _skins.set(url, tex);
      this._apply(fig, tex);
    }, undefined, () => { /* one missing skin leaves one grey figure, not a broken picker */ });
  }

  /**
   * Make a hand-loaded PNG sample exactly the way the loader's own copy does.
   *
   * This is the bug that made the first version of the picker useless, and it
   * did not look like a texture bug: every figure came out as flat blocks of
   * colour with no face, which reads as fifteen characters standing with their
   * backs turned. They were facing front the whole time. The head's UVs run to
   * v = 1.37 — this pack addresses its atlas by letting the coordinates leave
   * the unit square — and glTF's default wrap is REPEAT, which GLTFLoader
   * applies. `TextureLoader` defaults to clamp instead, so every coordinate
   * past 1 collapsed onto the atlas's last row and each quad was painted in one
   * smeared edge pixel.
   *
   * Hence copying the settings off the loader's texture rather than listing
   * them here: the next property this pack depends on comes across for free,
   * and there is no second opinion to drift out of date. The literals are only
   * the fallback for a prototype with no map at all.
   */
  _configure(tex, ref) {
    if (ref) {
      tex.flipY = ref.flipY;
      tex.wrapS = ref.wrapS;
      tex.wrapT = ref.wrapT;
      tex.magFilter = ref.magFilter;
      tex.minFilter = ref.minFilter;
      tex.generateMipmaps = ref.generateMipmaps;
      tex.colorSpace = ref.colorSpace;
      return;
    }
    tex.flipY = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
  }

  _apply(fig, tex) {
    if (fig.mat.map === tex) return;
    fig.mat.map = tex;
    fig.mat.color.copy(fig.tint);
    // The map arriving where there was none changes the shader program, so this
    // is a recompile and not just a uniform write.
    fig.mat.needsUpdate = true;
  }

  /**
   * Put back every part of the rig no running clip is driving.
   *
   * The preview's version of `_clearPose`, and it exists for the same reason
   * stated at length there: **the mixer does not clear what it does not key.**
   * `idle` keys the torso, the head and the two arms and nothing else, so a
   * gesture that moved the legs or the root leaves them exactly where its last
   * frame put them, forever — a figure that kicks once stands with one leg out
   * for the rest of the session, and a figure that swings once stands a few
   * centimetres off its mark. Neither is visible as a bug; both read as "that
   * character is standing oddly", which is indistinguishable from the stance
   * table doing its job.
   *
   * Two differences from the body's version, both forced by this being a
   * preview rather than a player:
   *
   *  - **Translation as well as rotation.** In the game `update` writes the
   *    body's position from the player every frame, so a clip's root motion is
   *    overwritten before it can be seen. Here nothing writes it.
   *  - **The captured rest, not identity.** Identity is right for every
   *    rotation in this pack, which is what lets `_clearPose` hard-code it —
   *    but `root` carries a translation, and zeroing that drops the figure.
   *
   * Running actions rather than the selected clip, and by weight, so that a
   * gesture fading out is still allowed to own its nodes on the way down.
   */
  _rest(fig) {
    const keys = this._keys;
    if (!keys) return;
    _rotKeyed.clear();
    _posKeyed.clear();
    for (const [action, name] of fig.live) {
      if (!action.isRunning() || action.getEffectiveWeight() <= 0.001) continue;
      const k = keys[name];
      if (!k) continue;
      for (const n of k.rot) _rotKeyed.add(n);
      for (const n of k.pos) _posKeyed.add(n);
    }
    for (const [node, pos, quat] of fig.rest) {
      if (!_rotKeyed.has(node.name)) node.quaternion.copy(quat);
      if (!_posKeyed.has(node.name)) node.position.copy(pos);
    }
  }

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    // Zero while the overlay is still `display: none` — a renderer sized to
    // 0×0 there stays 0×0 forever, which is why this is checked every frame
    // rather than once on open.
    if (!w || !h || (w === this._w && h === this._h)) return;
    this._w = w;
    this._h = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
  }

  _loop = () => {
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this._resize();

    // The slide. One number, eased, and the whole strip follows it.
    this._x += (this._targetX - this._x) * Math.min(1, dt * SLIDE_RATE);
    if (Math.abs(this._targetX - this._x) < 1e-4) this._x = this._targetX;
    this.track.position.x = this._x;

    for (const fig of this.figures) {
      fig.model.mixer.update(dt);
      const on = fig.id === this.selected;

      // Strictly after the mixer and in this order: put back what no clip is
      // driving, then lay the stance over what the clip did drive. Reversed,
      // the restore would wipe the stance off every node `idle` leaves alone —
      // which is every leg, which is half of what tells these fifteen apart.
      this._rest(fig);
      const busy = !!(fig.act && fig.act.isRunning() && fig.act.getEffectiveWeight() > 0.01);
      // The stance steps aside for the gesture rather than being blended
      // through it. A nod performed from a slouch is a slouching nod, which is
      // charming; a punch thrown from folded arms is a punch that never
      // extends, which is broken. One rule, applied to both.
      fig.stanceW += ((busy ? 0 : 1) - fig.stanceW) * Math.min(1, dt * STANCE_RATE);
      if (fig.stanceW > 0.004) {
        const w = fig.stanceW * STANCE_BLEND;
        for (const [node, q] of fig.stance) node.quaternion.slerp(q, w);
      }

      // Only the character you are looking at gestures. The other fourteen are
      // a whole screen width off the frustum, so a kick out there is a kick
      // nobody sees, and the clocks would all be running at once.
      if (fig.act && !fig.act.isRunning()) fig.act = null;
      if (on && fig.gesture && !fig.act) {
        fig.next -= dt;
        if (fig.next <= 0) {
          fig.next = GESTURE_EVERY;
          MobModels.playOnce(fig.model, fig.gesture);
          // `playOnce` clears `current` so a caller's state machine re-blends;
          // this one has no state machine and `idle` never stopped, so putting
          // it back keeps a later `play(idle)` a no-op instead of a reset to
          // frame zero.
          fig.model.current = CLIP.idle;
          fig.act = fig.model.actions[fig.gesture];
        }
      }
      // The chosen one turns, because half of what distinguishes these is the
      // back of the coat and the hair. The others ease back to facing you —
      // wrapped into ±π first, or a figure that had spun three times would take
      // three times as long to come back round. That still matters with only
      // one on screen: the character you arrive at must be facing you when it
      // gets there, not mid-turn from the last time you looked at it.
      let r = fig.holder.rotation.y;
      if (on) {
        r += dt * 0.8;
      } else {
        r = ((r + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        r *= Math.max(0, 1 - dt * 6);
      }
      fig.holder.rotation.y = r;
    }
    this.renderer.render(this.scene, this.camera);
  };
}
