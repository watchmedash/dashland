// First-person viewmodel: the player's hand and whatever it is holding.
// Rendered in its own scene on top of the composited frame so it can never
// clip into geometry.

import * as THREE from 'three';
import { ITEMS } from '../game/Items.js';
import { BLOCKS, RENDER_TYPE, R_CROSS } from '../world/Blocks.js';
import { createItemBlockMaterial } from '../render/VoxelMaterial.js';
import { heldModel, hasModel } from '../render/ItemModels.js';

const _lampColor = new THREE.Color();

// Where the shoulder sits in view space. The hand hangs off the far end of the
// limb, so these are the old hand rest points pushed back down the arm: hand ≈
// shoulder plus the limb vector, which at the rest rotation puts the item at
// about (0.40, -0.40, -0.72). At that depth, with a 70° vertical fov, the
// visible height is ~1.0 units — an item scaled 0.4 fills about a third of the
// screen, which is where a first-person held item should sit.
const REST = new THREE.Vector3(0.48, -0.56, -0.23);
const REST_EMPTY = new THREE.Vector3(0.54, -0.62, -0.15);

// Fist position in arm-local space. The limb is a 0.62-long box running from the
// pivot to z = -0.59, so the fist closes just shy of its end. The counter-
// rotation cancels the arm's rest tilt: an item's own pose is then expressed in
// view space, the way it reads on screen, while still inheriting every bit of
// the arm's swing.
const HAND_LOCAL = new THREE.Vector3(0, 0.01, -0.52);
const ARM_REST_ROT = new THREE.Euler(0.30, 0.16, 0.12);

// --- swing animations -------------------------------------------------------
// Every tool used to play the same forward-and-down jab, so a pickaxe, a sword
// and a bare fist all read as punching. Each kind now gets its own track.
//
// A track is a list of keyframes on a normalised 0..1 swing clock. `p` is a
// position offset from the arm's rest point and `r` an offset from its rest
// rotation, both applied to the SHOULDER (armPivot) — the fist and the held
// item hang off it and must never be posed separately, or they come apart.
// `e` names the easing used to reach the NEXT key.
//
// Amplitudes stay small on purpose: the item sits ~0.52 units out along the
// limb, so a radian at the shoulder throws it half a screen. Anything past
// about 0.65 rad of pitch or yaw walks the tool out of frame.
const EASE = {
  linear: (t) => t,
  in: (t) => t * t,                             // accelerate — a driven stroke
  in3: (t) => t * t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  out3: (t) => 1 - (1 - t) ** 3,                // snappy settle
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
};

const SWINGS = {
  // Overhead: rises and back, then drives head-first down and forward into the
  // block, with a short recoil off the impact before it recovers. Slowest of
  // the set — it should feel like it weighs something.
  pick: {
    rate: 2.7,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.28, p: [0.02, 0.11, 0.10], r: [0.46, 0.04, -0.06], e: 'in' },     // wind up
      { t: 0.55, p: [-0.02, -0.05, -0.22], r: [-0.44, -0.02, 0.10], e: 'out' },// strike
      { t: 0.67, p: [-0.01, -0.01, -0.13], r: [-0.26, -0.01, 0.05], e: 'out3' },// recoil
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Diagonal chop from high-right down across the body. The down-stroke takes
  // barely a fifth of the clock; the rest is the slower haul back up.
  axe: {
    rate: 3.1,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.22, p: [0.09, 0.10, 0.08], r: [0.34, -0.22, -0.30], e: 'in' },
      { t: 0.44, p: [-0.13, -0.06, -0.22], r: [-0.36, 0.28, 0.46], e: 'out' },
      { t: 0.54, p: [-0.10, -0.05, -0.16], r: [-0.27, 0.22, 0.38], e: 'inOut' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // A dig, not a strike: a shallow pull back, then forward and down into the
  // ground, then a scooping lift that rolls the blade up and back.
  shovel: {
    rate: 3.0,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.16, p: [0.00, 0.04, 0.07], r: [0.14, 0.02, -0.04], e: 'in' },
      { t: 0.44, p: [0.00, -0.10, -0.24], r: [-0.32, 0.04, -0.02], e: 'out' },  // bite
      { t: 0.70, p: [-0.02, 0.08, -0.10], r: [0.36, -0.06, 0.16], e: 'inOut' }, // scoop up
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Lateral slash across the view, right to left. Fastest track by a wide
  // margin, and it snaps back rather than drifting.
  sword: {
    rate: 4.6,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'out' },
      { t: 0.16, p: [0.10, 0.06, 0.06], r: [0.14, -0.42, -0.24], e: 'in' },
      { t: 0.40, p: [-0.20, 0.02, -0.14], r: [0.02, 0.66, 0.36], e: 'out3' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
  // Blocks, torches, food, bare hands: the old short jab, which is still the
  // right motion for placing and for a plain punch.
  default: {
    rate: 3.6,
    keys: [
      { t: 0.00, p: [0, 0, 0], r: [0, 0, 0], e: 'inOut' },
      { t: 0.50, p: [0, -0.07, -0.24], r: [-0.44, 0, -0.16], e: 'inOut' },
      { t: 1.00, p: [0, 0, 0], r: [0, 0, 0], e: 'linear' },
    ],
  },
};

/**
 * Sample a swing track at clock position s (0..1) into `outP` / `outR`.
 * @param {{keys:Array}} track
 */
function sampleSwing(track, s, outP, outR) {
  const keys = track.keys;
  let i = 0;
  while (i < keys.length - 2 && s >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b.t - a.t;
  const u = span > 0 ? Math.min(1, Math.max(0, (s - a.t) / span)) : 1;
  const e = (EASE[a.e] || EASE.linear)(u);
  outP.set(
    a.p[0] + (b.p[0] - a.p[0]) * e,
    a.p[1] + (b.p[1] - a.p[1]) * e,
    a.p[2] + (b.p[2] - a.p[2]) * e,
  );
  outR.set(
    a.r[0] + (b.r[0] - a.r[0]) * e,
    a.r[1] + (b.r[1] - a.r[1]) * e,
    a.r[2] + (b.r[2] - a.r[2]) * e,
  );
}

const _swingP = new THREE.Vector3();
const _swingR = new THREE.Vector3();

function makeArmTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const band = (y0, y1, base, jitter) => {
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < S; x++) {
        const col = new THREE.Color(base);
        col.offsetHSL(0, 0, (Math.random() - 0.5) * jitter);
        g.fillStyle = `#${col.getHexString()}`;
        g.fillRect(x, y, 1, 1);
      }
    }
  };
  band(0, 40, '#4c8a92', 0.07);     // sleeve
  band(40, 64, '#e2ae82', 0.05);    // hand
  // cuff
  g.fillStyle = 'rgba(40,70,74,.85)';
  g.fillRect(0, 38, S, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

export class ViewModel {
  constructor(dropsFactory) {
    this.dropsFactory = dropsFactory;
    this._sprintEase = 0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.01, 12);

    this.key = new THREE.DirectionalLight(0xffffff, 1.9);
    this.key.position.set(-0.5, 0.9, 0.6);
    this.fill = new THREE.HemisphereLight(0xbcd6f5, 0x54463a, 1.1);
    this.scene.add(this.key, this.fill);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // --- arm ---
    const armTex = makeArmTexture();
    const armMat = new THREE.MeshStandardMaterial({ map: armTex, roughness: 0.88, metalness: 0 });
    this.armMat = armMat;
    // Pivot sits at the shoulder; the limb extends forward, away from the
    // camera. Kept slim and short — anything nearer than ~0.4 units balloons
    // under perspective and swallows the corner of the screen.
    const armGeo = new THREE.BoxGeometry(0.14, 0.14, 0.62);
    armGeo.translate(0, 0, -0.28);
    this.arm = new THREE.Mesh(armGeo, armMat);
    this.armPivot = new THREE.Group();
    this.armPivot.add(this.arm);
    this.root.add(this.armPivot);

    // --- held item anchor ---
    // A child of the arm, not a sibling of it. As siblings the two were animated
    // independently and their swing terms had opposite signs, so a mining swing
    // drove the fist one way and whatever it held the other — it read as two
    // hands striking out of step. Parented, the item can only move with the limb.
    this.hand = new THREE.Group();
    this.hand.position.copy(HAND_LOCAL);
    // reversed order + negated angles is the exact inverse of the XYZ rest tilt
    this.hand.rotation.set(-ARM_REST_ROT.x, -ARM_REST_ROT.y, -ARM_REST_ROT.z, 'ZYX');
    this.armPivot.add(this.hand);
    this.heldMesh = null;
    this.heldItem = -1;
    this.ownsGeometry = false;

    this.blockMaterial = createItemBlockMaterial();
    // A second copy for blocks that are themselves alight. The viewmodel has
    // no voxel light in it — that is baked into the world mesh — so a block
    // that glows in your hand renders from its raw albedo, and the albedo of a
    // thing that emits light is nearly black with bright cracks in it. Held,
    // the planet hearth came out as dark mud with holes. Only one item is in
    // the hand at a time, so one spare material covers every case.
    this.glowMaterial = createItemBlockMaterial();
    this.spriteCache = new Map();

    this.swing = 1;
    this.swingTrack = SWINGS.default;
    this.bob = 0;
    this.equipT = 1;      // 0 = just swapped, 1 = settled
    this.enabled = true;
    /**
     * Told whenever the arm swings, so the third-person body can swing too.
     *
     * A hook rather than a second call at every site that mines, places, eats,
     * casts or hits: there are eight of them in main, and the ninth one someone
     * adds next month would silently animate one body and not the other. There
     * is exactly one definition of "the player swung", and it is `punch`.
     */
    this.onPunch = null;
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setHeld(itemId, iconFactory) {
    if (itemId === this.heldItem) return;
    this.heldItem = itemId;
    this.equipT = 0;
    // Which swing plays is a property of what's in the fist, so it's resolved
    // on equip rather than looked up every frame. Everything without a tool
    // kind — blocks, torches, food, empty hands — falls back to the jab.
    this.swingTrack = SWINGS[ITEMS[itemId]?.tool?.kind] || SWINGS.default;
    this._clearMesh();
    if (!itemId) return;

    // An id with no definition (a save written by an older build, a renamed
    // item) must not reach the render loop: throwing here kills the rAF chain
    // and the whole game freezes on a black-box frame. Drops guards this the
    // same way — show empty hands and carry on.
    const def = ITEMS[itemId];
    if (!def) { this.heldItem = null; return; }
    // Show authored art whenever there is any, and fall back to a textured cube
    // for the ordinary blocks that have none.
    //
    // This used to ask `RENDER_TYPE[def.block] !== R_CROSS`, which worked only
    // because the torch — the one block with a real model — happened to be the
    // one block drawn as a cross. Giving the torch a proper 3D shape in the
    // world therefore took the model out of the player's hand and replaced it
    // with a cube, a change nobody would think to look for in a mesher commit.
    // Asking whether the model exists cannot come apart that way.
    //
    // There are two questions here and they are not the same one. "Does this
    // have 3D art of its own?" chooses between a model and generated art, and
    // that is what hasModel answers. "Does its generated art have a cube form?"
    // chooses between a cube and a flat sprite — and a cross block (flower,
    // tall grass, sapling) has no cube form at all: Drops builds it as a plane.
    //
    // Asking only the first question meant a flower took the cube path, and the
    // cube path hands the *voxel* material a sprite's plane. That material
    // reads per-vertex layer, tint and tangent attributes that a plane has
    // none of, so it sampled nothing and the flower came out as a black card
    // in the fist.
    const isCube = def.block !== undefined && !hasModel(itemId)
      && RENDER_TYPE[def.block] !== R_CROSS;
    let mesh = null;
    if (isCube) {
      const src = this.dropsFactory(itemId);
      // Light it by its own light if it has any, so a hearth or a lantern in
      // the hand looks like the thing that is lighting the room.
      const emit = BLOCKS[def.block]?.light ?? 0;
      let mat = this.blockMaterial;
      if (emit > 0) {
        const lc = BLOCKS[def.block].lightColor || [1, 1, 1];
        // A glowing block is mostly dark rock with hot seams, and the two need
        // to stay far apart. The key and fill here are strong enough to lift
        // the rock to the same tone as the seams, so hold the albedo down
        // against them — a thing that makes its own light is not also a thing
        // that takes the room's light well.
        this.glowMaterial.color.setScalar(0.52);
        // Now the emissive can be worth having. It rides the tile's own
        // luminance (see the emissivemap override in createItemBlockMaterial),
        // so this lands on the seams and leaves the rock alone; the earlier
        // attempt had to be kept near zero only because it hit both equally.
        const s = 0.30 + (emit / 15) * 0.55;
        this.glowMaterial.emissive.setRGB(lc[0] * s, lc[1] * s, lc[2] * s);
        mat = this.glowMaterial;
      }
      if (src) mesh = new THREE.Mesh(src.geometry, mat);
    } else {
      // Tools, weapons and torches have real 3D art. It loads lazily, so the
      // first equip of a given model still shows the sprite for a frame or two
      // and swaps itself in when the geometry lands — and if the models aren't
      // there at all, the sprite is simply what you keep.
      const model = heldModel(itemId, (m) => this._adoptModel(itemId, m));
      if (model) { this._setMesh(model, false); return; }
    }
    if (!isCube) {
      let mat = this.spriteCache.get(itemId);
      if (!mat) {
        const tex = new THREE.TextureLoader().load(iconFactory.item(itemId));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        mat = new THREE.MeshStandardMaterial({
          map: tex, transparent: true, alphaTest: 0.35,
          side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05,
        });
        this.spriteCache.set(itemId, mat);
      }
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    }
    if (!mesh) return;

    // Both sit a little forward of the fist. The item anchor is at the end of
    // the limb now, so anything centred on it is skewered by the arm box — a
    // flat sprite especially, which came out sliced in half lengthways.
    if (isCube) {
      mesh.scale.setScalar(0.30);
      mesh.rotation.set(0.18, -0.70, 0.05);
      mesh.position.set(0, 0.03, -0.06);
    } else {
      // flat items read best held edge-on, like a card in the fist
      mesh.scale.setScalar(0.36);
      mesh.rotation.set(0, -1.10, 0.46);
      mesh.position.set(0.02, 0.06, -0.11);
    }
    this._setMesh(mesh, !isCube);
  }

  /**
   * @param {THREE.Mesh} mesh
   * @param {boolean} owned true when this view model made the geometry and is
   *   the only thing holding it — sprite planes are per-equip and have to be
   *   released. Block and model geometry is shared out of a cache and must not
   *   be disposed here.
   */
  _setMesh(mesh, owned) {
    this._clearMesh();
    this.hand.add(mesh);
    this.heldMesh = mesh;
    this.ownsGeometry = owned;
  }

  _clearMesh() {
    if (!this.heldMesh) return;
    this.hand.remove(this.heldMesh);
    if (this.ownsGeometry) this.heldMesh.geometry.dispose();
    this.heldMesh = null;
    this.ownsGeometry = false;
  }

  /** Late arrival of a lazily loaded model: only swap if it's still in hand. */
  _adoptModel(itemId, mesh) {
    if (itemId !== this.heldItem) return;
    this._setMesh(mesh, false);
  }

  /** Kick off the mining / placing swing. */
  punch() { this.swing = 0; this.onPunch?.(); }

  /**
   * @param {{r:number,g:number,b:number}} [handLight] local block light at the
   *   player, 0..1 per channel. The view model lives in its own scene, so it
   *   sees none of the world's voxel lighting — without this, whatever you are
   *   holding stays lit by the sky alone and a torch-lit cave leaves your own
   *   hands in the dark.
   */
  update(dt, player, sky, handLight) {
    const holding = this.heldItem > 0;
    const rest = holding ? REST : REST_EMPTY;

    const track = this.swingTrack || SWINGS.default;
    // Per-animation rate: a sword slash finishes in ~230 ms, a pickaxe takes
    // ~385 ms to load up, drop and recover.
    if (this.swing < 1) this.swing = Math.min(1, this.swing + dt * track.rate);
    if (this.equipT < 1) this.equipT = Math.min(1, this.equipT + dt * 5.0);

    // walking bob
    this.bob += dt * player.moveAmount * 1.9;
    const bobAmt = Math.min(1, player.moveAmount / 5) * (player.grounded ? 1 : 0.25);
    const bx = Math.cos(this.bob) * 0.024 * bobAmt;
    const by = Math.abs(Math.sin(this.bob)) * 0.020 * bobAmt;

    // Swing pose, sampled from this item's own track.
    sampleSwing(track, this.swing, _swingP, _swingR);

    // equip dip when the held item changes
    const eq = 1 - this.equipT;
    const equipY = -eq * 0.42;

    const px = rest.x + bx + _swingP.x;
    const py = rest.y + by + _swingP.y + equipY;
    const pz = rest.z + _swingP.z;

    // Shoulder anchor sits low-right, just behind the near plane. Everything —
    // bob, swing, equip dip, sprint — is applied here and nowhere else; the fist
    // and the held item are along for the ride.
    // Sprint pulls the arm back, eased rather than snapped. A hard 0/1 meant
    // any frame that changed its mind about sprinting jumped the hand 5cm and
    // back, and running yourself out of stamina used to change its mind every
    // single frame — the hand shook. The oscillation itself is fixed in Player
    // (you now have to recover before you can sprint again), but a term that
    // teleports the hand on a boolean is worth easing whatever feeds it.
    const sprint = player.sprinting ? 1 : 0;
    this._sprintEase += (sprint - this._sprintEase) * Math.min(1, dt * 9);
    this.armPivot.position.set(px, py, pz - this._sprintEase * 0.05);
    this.armPivot.rotation.set(
      // Rest tilt plus this frame's swing offset. Negative pitch drops the far
      // end of the limb (a strike), positive raises it (a wind-up or a scoop).
      // The tracks keep their pitch inside ±0.6: the fist is half a unit from
      // the pivot, so a radian here throws the item clean out of frame.
      ARM_REST_ROT.x + _swingR.x + eq * 0.55,
      ARM_REST_ROT.y + _swingR.y,
      ARM_REST_ROT.z + _swingR.z,
    );

    if (sky) {
      const p = sky.palette;
      this.key.color.copy(p.sun);
      this.key.intensity = 0.5 + p.sunIntensity * 0.9;
      this.fill.color.copy(p.zenith).lerp(p.horizon, 0.5).lerp(new THREE.Color(1, 1, 1), 0.4);
      this.fill.groundColor.copy(p.fog).multiplyScalar(0.6);
      this.fill.intensity = 0.5 + p.sunIntensity * 0.5;

      // Nearby torches, lanterns and a lit kiln warm the hands. Folded into the
      // fill rather than added as a third light, so it tints the whole item the
      // way a fire in the room would instead of casting a second shadow.
      if (handLight) {
        const l = Math.max(handLight.r, handLight.g, handLight.b);
        if (l > 0.002) {
          _lampColor.setRGB(handLight.r, handLight.g, handLight.b);
          const w = Math.min(1, l * 1.5);
          this.fill.color.lerp(_lampColor, w * 0.8);
          this.fill.groundColor.lerp(_lampColor, w * 0.5);
          this.fill.intensity += l * 1.9;
          this.key.intensity += l * 0.5;
        }
      }
    }
  }

  render(renderer) {
    if (!this.enabled) return;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAuto;
  }
}
