// Isometric block icons painted from the generated tile textures, hand-drawn
// vector art for the items that never exist as blocks, and — for anything that
// has real 3D art — an icon rendered from that very model, so what you hold and
// what you see in the grid are the same object.

import * as THREE from 'three';
import {
  BLOCKS, TINT_ID, R_CROSS, R_LIQUID, R_SLAB, R_STAIR,
  R_LADDER, R_DOOR, R_SIGN, R_FENCE,
} from '../world/Blocks.js';
import { BIOME_COLORS } from '../world/Constants.js';
import { ITEMS } from '../game/Items.js';
import { iconModel, hasModel } from '../render/ItemModels.js';

// Rendered at 2x the largest slot so icons stay crisp when scaled down.
const ICON = 96;

// True 2:1 isometric projection of the block's own cell, laid out inside the
// icon box. The top rhombus is 2 wide : 1 tall, and the side walls are taller
// than half the rhombus — otherwise the cube reads squashed.
//
// `P` is the whole of it: a point of the unit cell (x, y, z all 0..1) to a
// point on the canvas. The three faces a viewer standing at (-x, +y, +z) can
// see are the top (y = y1), the west wall (x = x0) and the south wall (z = z1),
// and every shape below is built out of boxes drawn through exactly those.
// Deriving the faces from one projection rather than writing three bases out by
// hand is what makes a slab, a stair and a fence post cost a rectangle each.
const PAD = 5;
const CELL_W = ICON - PAD * 2;           // 86 full width
const HALF_W = CELL_W / 2;               // 43
const RHOMB_H = HALF_W;                  // 2:1 → 43 total height, 21.5 per half
const WALL_H = Math.round(CELL_W * 0.52);// 45
const MID_Y = PAD + RHOMB_H / 2;         // left/right corners of the top face

/** Unit-cell point (x right-and-back, y up, z right-and-front) to canvas. */
function P(x, y, z) {
  return [PAD + (x + z) * HALF_W, MID_Y + (z - x) * (RHOMB_H / 2) + (1 - y) * WALL_H];
}

/**
 * How much of its own cell each world shape actually fills, as boxes in that
 * same unit space, listed back to front.
 *
 * This is the whole reason a slab, a stair and a full block stopped being the
 * same picture. `stair_stone`, `slab_stone` and `smooth_stone` share one set of
 * tiles, so painted as three full cubes they were byte-identical in the
 * toolbar: three different things you could place, one icon between them. The
 * boxes are the block's real silhouette, so now they read apart at a glance and
 * each one reads as the thing that will appear when you place it.
 *
 * Back to front matters and is checked, not assumed: the viewer is at
 * (-x, +y, +z), so a box is behind another when it sits at larger x, smaller z
 * or greater height over the same footprint. Coplanar faces never fight, which
 * is why a stair's two boxes can share the x = 0 wall without seaming.
 */
export const SHAPES = {
  // The tread, then the riser standing on the back half of it.
  [R_STAIR]: [
    { x0: 0, x1: 1, y0: 0, y1: 0.5, z0: 0, z1: 1 },
    { x0: 0, x1: 1, y0: 0.5, y1: 1, z0: 0, z1: 0.5 },
  ],
  [R_SLAB]: [{ x0: 0, x1: 1, y0: 0, y1: 0.5, z0: 0, z1: 1 }],
  // A section of fence rather than one post: two posts with the rails run
  // between them is what says "fence" at 46px, where a single post is a stick.
  // The rails are narrower in x than the posts, so the near post's west wall is
  // in front of them and drawing it last is correct.
  [R_FENCE]: [
    { x0: 0.38, x1: 0.62, y0: 0, y1: 1, z0: 0.06, z1: 0.28 },
    { x0: 0.44, x1: 0.56, y0: 0.30, y1: 0.44, z0: 0.06, z1: 0.94 },
    { x0: 0.44, x1: 0.56, y0: 0.66, y1: 0.80, z0: 0.06, z1: 0.94 },
    { x0: 0.38, x1: 0.62, y0: 0, y1: 1, z0: 0.72, z1: 0.94 },
  ],
};

/**
 * Shapes that are a *picture of themselves* on one tile, and are therefore
 * drawn flat rather than wrapped round a box.
 *
 * A cross block has no cube form at all — built as one its transparent pixels
 * read as a black cage. The ladder, the door and the sign are the same case
 * arrived at from the other direction: each has its own cut-out tile that draws
 * the whole object (see `G.ladder`/`G.door`/`G.sign` in `render/TextureGen.js`,
 * and the note in `scripts/bake-textures.mjs` about the ladder keeping its own
 * alpha), so pasting that tile on three faces of a cube gave a box with a
 * ladder's holes punched through it. Flat, they are the thing.
 *
 * The fence is deliberately *not* here: its tile is uniform vertical grain with
 * no object on it, authored that way because the mesher crops it to a quarter
 * of a cell, so flat it is a plank swatch. It gets real posts above instead.
 */
export const FLAT_TILE = new Set([R_CROSS, R_LADDER, R_DOOR, R_SIGN]);

// --- the biome tint, in the grid ---------------------------------------------
//
// The bug this whole file was audited for. A tintable block is stored once and
// coloured at draw time: the mesher writes `tintOf(id, biome)` into a vertex
// attribute and the voxel shader multiplies it into the albedo texel, so what
// is on the wall is the tile times a colour. The tile *by itself* is the
// uncoloured plate — mossy stone's is grey rock with grey blotches, grass's top
// is a pale straw — and this painter drew exactly that. So a Mossy Stone in the
// world was green, a Mossy Stone in your fist was green (a dropped cube carries
// the same attribute, see `dropTint` in `game/Drops.js`) and a Mossy Stone in
// the toolbar was a grey cobble. Nine blocks were wrong, not one.
//
// Which biome's colour, for a thing that is in a bag rather than in a place?
// The temperate one, index 2, which is the same answer `Drops` already gives
// for the same reason: an item has left the world and there is no biome to ask.
// That is what puts the icon and the held cube on the same colour.
const ICON_BIOME = 2;

/**
 * The multiplier for one `TINT_ID`, matching `tintOf` in `world/Mesher.js` term
 * for term — including the two the drop path still rounds off. Moss is foliage
 * pushed warm and dark and pine needles are foliage pushed cool and dark; treat
 * either as plain foliage and mossy stone comes out a leaf green that no wall
 * in the game is.
 */
export function tintRGB(t) {
  if (!t) return null;
  const c = BIOME_COLORS[ICON_BIOME];
  if (t === 1) return c.grass;
  if (t === 2) return c.foliage;
  if (t === 3) { const f = c.foliage; return [f[0] * 0.90, f[1] * 0.98, f[2] * 0.93]; }
  return [c.foliage[0] * 0.9, c.foliage[1] * 1.0, c.foliage[2] * 0.85];
}

// The shader multiplies in the linear working space — the atlas is an sRGB
// texture, so three decodes it, multiplies, and the framebuffer encodes it
// back. Canvas has no such notion: a `multiply` composite here would multiply
// the *encoded* bytes and land somewhere noticeably darker and flatter than the
// wall it is meant to match. So the round trip is done by hand, once per
// (tile, tint) pair, and the result is cached.
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSRGB = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = toLinear(i / 255);

// --- icons painted from the 3D models ---------------------------------------

// Supersample factor. There is no MSAA here on purpose: a multisampled render
// target has to be resolved before its pixels can be read back, and the extra
// framebuffer buys nothing that drawing 3x down into the icon canvas doesn't
// already give — the downscale is the antialiasing, and it costs one blit.
const SS = 3;

// How much of the icon box the model's silhouette fills. The hand-drawn art is
// authored on a 64 grid and spans roughly 10..54, so ~0.7 of the box with the
// long diagonal running further; matching that is what stops a modelled pickaxe
// from looking a size larger than the drawn shovel beside it.
const FILL = 0.74;
/**
 * The eight offsets the model icons' outline is stamped at, in icon pixels.
 *
 * Two, not one: at one pixel the halo is swallowed by the model's own
 * antialiased edge when the supersampled render is scaled down, and the icon
 * looks exactly as it did. The diagonals are pulled in to 1.5 so the corners do
 * not read as a square frame around round objects.
 *
 * `FILL` at 0.74 leaves ~12% of the icon empty on each side, so nothing here
 * pushes a silhouette off its own canvas.
 */
const HALO = [
  [-2, 0], [2, 0], [0, -2], [0, 2],
  [-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5],
];

/**
 * Paints one item model into an icon-sized data URL.
 *
 * Uses the game's own renderer — a second WebGL context would mean a second
 * copy of every texture and geometry, and browsers cap how many contexts a page
 * may hold. It borrows the renderer for the length of one draw: bind an
 * offscreen target, render, read the pixels back, put everything as it was. The
 * game is never mid-frame when this happens, because it only ever runs from a
 * UI refresh or a model's load callback.
 */
class ModelIconPainter {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    // Roughly the view model's rig, toned down: render targets skip the
    // renderer's ACES pass, so the same intensities that read right in the hand
    // come out blown and chalky here.
    //
    // The fill's ground colour is the part that matters. The view model's is a
    // dark earth brown, which is right for something lit by a world; here it
    // dragged every downward-facing surface to charcoal, and since a pickaxe
    // shows the underside of its head that made the wood, stone and iron tiers
    // three shades of the same dark wedge. A near-neutral ground lets the tier
    // colour survive on the shadow side, which is the whole point of the icon.
    const key = new THREE.DirectionalLight(0xfff4e2, 1.15);
    key.position.set(-0.35, 0.85, 1.0);
    const rim = new THREE.DirectionalLight(0xbcd6f5, 0.35);
    rim.position.set(0.8, 0.1, -0.7);
    const fill = new THREE.HemisphereLight(0xf0f6ff, 0x9aa0aa, 1.1);
    this.scene.add(key, rim, fill);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    const N = ICON * SS;
    this.target = new THREE.WebGLRenderTarget(N, N, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      // Ask for the sRGB encode on write; without it the readback is linear and
      // every icon comes out washed out next to the drawn ones.
      colorSpace: THREE.SRGBColorSpace,
    });
    this.pixels = new Uint8Array(N * N * 4);

    this.big = document.createElement('canvas');
    this.big.width = this.big.height = N;
    this.out = document.createElement('canvas');
    this.out.width = this.out.height = ICON;
    /** Scratch for the outline pass; see the end of `paint`. */
    this.halo = document.createElement('canvas');
    this.halo.width = this.halo.height = ICON;

    this._box = new THREE.Box3();
    this._v = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._clear = new THREE.Color();
  }

  /**
   * @param {THREE.Mesh} mesh already rotated into its icon pose
   * @returns {string} data URL
   */
  paint(mesh) {
    const r = this.renderer;
    const N = ICON * SS;

    this.scene.add(mesh);
    mesh.updateMatrixWorld(true);
    this._box.setFromObject(mesh);
    const size = this._box.getSize(this._v);
    const c = this._box.getCenter(this._c);

    // Square frustum around the silhouette: the icon box is square, so fitting
    // the larger of width and height keeps a long tool inside it and leaves a
    // stubby apple centred rather than stretched.
    const half = Math.max(size.x, size.y, 1e-4) / 2 / FILL;
    const cam = this.camera;
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    const depth = size.z + 1;
    cam.near = 0.01; cam.far = depth * 2 + 2;
    cam.position.set(c.x, c.y, c.z + depth);
    cam.updateProjectionMatrix();

    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this._clear);
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.render(this.scene, cam);
    r.readRenderTargetPixels(this.target, 0, 0, N, N, this.pixels);
    r.setRenderTarget(prevTarget);
    r.setClearColor(this._clear, prevAlpha);
    this.scene.remove(mesh);

    // readPixels hands back rows bottom-up; the canvas wants them top-down.
    const g = this.big.getContext('2d');
    const img = g.createImageData(N, N);
    const src = this.pixels, dst = img.data, row = N * 4;
    for (let y = 0; y < N; y++) {
      dst.set(src.subarray((N - 1 - y) * row, (N - y) * row), y * row);
    }
    g.putImageData(img, 0, 0);

    // A dark halo around the silhouette, and the one thing in this class that is
    // about the panel rather than the model.
    //
    // Every hand-drawn icon in this file is stroked with `outline()` at
    // rgba(18,14,12,.62) before it is filled; the painted ones had nothing, and
    // got away with it while the inventory was dark. It is parchment now, and a
    // pale model against pale ground is a shape with no boundary — the bone end
    // of a drumstick, a silver ingot, a pearl, the light half of a bucket. The
    // model itself cannot fix this: no amount of lighting saves a light object
    // on a light field, because the problem is the edge and not the value.
    //
    // So the modelled icons take the drawn ones' outline, in the drawn ones'
    // colour, which is also the answer to the goal stated at the top of this
    // file — that a grid of modelled and drawn icons should scan as one set.
    // Eight offsets rather than a stroked path because what has to be outlined
    // is an alpha silhouette, not a shape anyone has the outline of; at this
    // radius on a 96px icon it lands near a pixel wide in the 46px slot, which
    // is what the drawn stroke lands at too.
    const hg = this.halo.getContext('2d');
    hg.clearRect(0, 0, ICON, ICON);
    hg.globalCompositeOperation = 'source-over';
    hg.drawImage(this.big, 0, 0, ICON, ICON);
    // Recolour what was just drawn without touching its coverage: `source-in`
    // keeps the destination's alpha and takes the source's colour, so this is
    // the model's exact silhouette in the outline colour.
    hg.globalCompositeOperation = 'source-in';
    hg.fillStyle = 'rgba(18,14,12,.62)';
    hg.fillRect(0, 0, ICON, ICON);
    hg.globalCompositeOperation = 'source-over';

    const o = this.out.getContext('2d');
    o.clearRect(0, 0, ICON, ICON);
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = 'high';
    for (const [dx, dy] of HALO) o.drawImage(this.halo, dx, dy);
    o.drawImage(this.big, 0, 0, ICON, ICON);
    return this.out.toDataURL();
  }

  dispose() {
    this.target.dispose();
  }
}

export class IconFactory {
  constructor(albedo, size, layers) {
    this.size = size;
    this.tiles = [];
    for (let i = 0; i < layers; i++) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      img.data.set(albedo.subarray(i * size * size * 4, (i + 1) * size * size * 4));
      g.putImageData(img, 0, 0);
      this.tiles.push(c);
    }
    this.cache = new Map();
    /** "layer|tintId" -> a copy of that tile with the biome tint multiplied in. */
    this.tinted = new Map();
    this.painter = null;
    this.onUpdate = null;
    this.modelIcons = new Map();   // item id -> data URL painted from the model
    this.asked = new Set();        // item ids already handed to the painter
    this._queued = false;
  }

  /**
   * Hand over the renderer, which is what turns model icons on.
   *
   * Optional by design: with no renderer — or no `public/models/` — every item
   * simply keeps its drawn art, which is also what is on screen for the frame
   * or two before a model finishes loading.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {() => void} [onUpdate] called (once per frame at most) when a late
   *   icon lands and whatever is showing the old one should repaint.
   */
  attach(renderer, onUpdate) {
    if (renderer && !this.painter) this.painter = new ModelIconPainter(renderer);
    this.onUpdate = onUpdate || null;
  }

  /**
   * One tile of the baked atlas, with this block's biome tint multiplied in.
   *
   * Returns null when the block names no tile at all, which is not a defect: a
   * modelled cross block — the twenty-seven corals, weeds and fungi authored in
   * WAM — never added a tile to `TILES`, so its `top`/`side` are `undefined`.
   * That used to reach `drawImage(undefined)` and throw, on the first paint of
   * every one of them, because `item()` falls through to here for the frame or
   * two before the model lands. See `_swatch` for what is drawn instead.
   */
  _tile(layer, tintId) {
    const base = layer === undefined || layer === null ? undefined : this.tiles[layer];
    if (!base) return null;
    const rgb = tintRGB(tintId);
    if (!rgb) return base;
    const key = `${layer}|${tintId}`;
    let out = this.tinted.get(key);
    if (out) return out;
    const S = this.size;
    out = document.createElement('canvas');
    out.width = out.height = S;
    const g = out.getContext('2d', { willReadFrequently: true });
    g.drawImage(base, 0, 0);
    const img = g.getImageData(0, 0, S, S);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      d[i] = Math.round(toSRGB(SRGB_TO_LINEAR[d[i]] * rgb[0]) * 255);
      d[i + 1] = Math.round(toSRGB(SRGB_TO_LINEAR[d[i + 1]] * rgb[1]) * 255);
      d[i + 2] = Math.round(toSRGB(SRGB_TO_LINEAR[d[i + 2]] * rgb[2]) * 255);
    }
    g.putImageData(img, 0, 0);
    this.tinted.set(key, out);
    return out;
  }

  /**
   * Stand-in for a block with no tile: a soft lozenge in its own break-particle
   * colour, which is the one colour every block in the registry carries.
   *
   * Only ever seen for a moment. These are exactly the blocks whose real icon is
   * rendered from a model, and `item()` asks the model first on every call, so
   * this holds the slot until the mesh arrives instead of leaving a live slot
   * looking empty — and it is what shows for good if `public/models/` is gone.
   */
  _swatch(g, b) {
    const [r, gg, bl] = b.particle;
    const hex = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    g.fillStyle = `rgb(${hex(r)},${hex(gg)},${hex(bl)})`;
    g.beginPath();
    g.ellipse(ICON / 2, ICON / 2, ICON * 0.28, ICON * 0.3, 0, 0, 7);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.22)';
    g.beginPath();
    g.ellipse(ICON * 0.41, ICON * 0.38, ICON * 0.12, ICON * 0.09, -0.5, 0, 7);
    g.fill();
  }

  /** data-URL icon for a block id. */
  block(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const b = BLOCKS[id];
    const t = TINT_ID[id];
    const c = document.createElement('canvas');
    c.width = c.height = ICON;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    if (FLAT_TILE.has(b.render)) {
      const tile = this._tile(b.side, t);
      if (tile) g.drawImage(tile, 6, 6, ICON - 12, ICON - 12);
      else this._swatch(g, b);
    } else {
      const S = this.size;
      const alpha = b.render === R_LIQUID ? 0.82 : 1;
      // A directional block shows its front on one visible face, so the icon
      // still reads as a kiln/furnace rather than a blank box. The front goes
      // on the south wall, which is the one facing the viewer.
      const topTile = this._tile(b.top, t);
      const sideTile = this._tile(b.side, t);
      const frontTile = this._tile(b.directional ? b.front : b.side, t);
      if (!topTile || !sideTile) {
        this._swatch(g, b);
      } else {
        /**
         * One face of one box: clipped to the part of the face the box actually
         * occupies, but textured as if the face spanned the whole cell. That is
         * the difference between a slab whose side shows the *bottom half* of
         * its tile and a slab whose side shows the whole tile squashed — and
         * the second one does not match the wall it came off.
         */
        const face = (tile, quad, ox, oy, ax, ay, bx, by, shade) => {
          g.save();
          g.beginPath();
          g.moveTo(quad[0][0], quad[0][1]);
          for (let i = 1; i < 4; i++) g.lineTo(quad[i][0], quad[i][1]);
          g.closePath();
          g.clip();
          g.globalAlpha = alpha;
          g.setTransform(ax / S, ay / S, bx / S, by / S, ox, oy);
          g.drawImage(tile, 0, 0);
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalAlpha = 1;
          if (shade < 0) { g.fillStyle = `rgba(0,0,0,${-shade})`; g.fillRect(0, 0, ICON, ICON); }
          else if (shade > 0) { g.fillStyle = `rgba(255,255,255,${shade})`; g.fillRect(0, 0, ICON, ICON); }
          g.restore();
        };

        const boxes = SHAPES[b.render] ?? [{ x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 }];
        for (const k of boxes) {
          const { x0, x1, y0, y1, z0, z1 } = k;
          // top (y = y1)
          let o = P(0, y1, 0), a = P(1, y1, 0), v = P(0, y1, 1);
          face(topTile, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)],
            o[0], o[1], a[0] - o[0], a[1] - o[1], v[0] - o[0], v[1] - o[1], 0.12);
          // west wall (x = x0)
          o = P(x0, 1, 0); a = P(x0, 1, 1); v = P(x0, 0, 0);
          face(sideTile, [P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), P(x0, y0, z0)],
            o[0], o[1], a[0] - o[0], a[1] - o[1], v[0] - o[0], v[1] - o[1], -0.28);
          // south wall (z = z1)
          o = P(0, 1, z1); a = P(1, 1, z1); v = P(0, 0, z1);
          face(frontTile ?? sideTile,
            [P(x0, y1, z1), P(x1, y1, z1), P(x1, y0, z1), P(x0, y0, z1)],
            o[0], o[1], a[0] - o[0], a[1] - o[1], v[0] - o[0], v[1] - o[1], -0.11);
        }

        // Crisp silhouette highlight along the two top edges of the topmost box.
        const cap = boxes.reduce((m, k) => (k.y1 > m.y1 ? k : m), boxes[0]);
        const e0 = P(cap.x0, cap.y1, cap.z0);
        const e1 = P(cap.x1, cap.y1, cap.z0);
        const e2 = P(cap.x1, cap.y1, cap.z1);
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(e0[0], e0[1]);
        g.lineTo(e1[0], e1[1]);
        g.lineTo(e2[0], e2[1]);
        g.stroke();
      }
    }

    const url = c.toDataURL();
    this.cache.set(id, url);
    return url;
  }

  /**
   * data-URL icon for an item id: rendered from its 3D model where there is
   * one, otherwise block-backed or drawn.
   *
   * Stays synchronous. A model that hasn't loaded yet returns the drawn icon
   * and starts the load; when it lands the icon is painted, cached and
   * `onUpdate` fires, and the UI's own re-render picks it up — the same late
   * swap the view model does when a tool arrives after it was equipped.
   */
  item(id) {
    const def = ITEMS[id];
    if (!def) return '';
    // A block with a model of its own is drawn as that model, not as a cube.
    //
    // This used to go the other way, and the torch was the case that decided
    // it: the model was an unlit stick, indistinguishable from the stick item
    // at 46px, while the block tile at least carried a flame. Both halves of
    // that have since stopped being true — the model's head glows now, and the
    // "flame" tile turned out to be a picture of a whole torch — so the cube
    // was winning on a comparison that no longer holds. A torch in the hotbar
    // should be the thing you are about to plant.
    const modelled = this._modelIcon(id);
    if (modelled) return modelled;
    if (def.block !== undefined) return this.block(def.block);
    const key = `i${id}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const c = document.createElement('canvas');
    c.width = c.height = ICON;
    const g = c.getContext('2d');
    // the item art is authored on a 64-unit grid
    g.scale(ICON / 64, ICON / 64);
    (ART[def.art] || ART.lump)(g, def);
    const url = c.toDataURL();
    this.cache.set(key, url);
    return url;
  }

  /** Painted icon for an item's model, or null if there isn't one (yet). */
  _modelIcon(id) {
    const have = this.modelIcons.get(id);
    if (have) return have;
    if (!this.painter || !hasModel(id)) return null;
    if (this.asked.has(id)) return null;    // in flight; the drawn art stands in
    this.asked.add(id);
    const mesh = iconModel(id, (m) => this._paint(id, m));
    return mesh ? this._paint(id, mesh) : null;
  }

  _paint(id, mesh) {
    if (this.modelIcons.has(id)) return this.modelIcons.get(id);
    let url = null;
    try {
      url = this.painter.paint(mesh);
    } catch (err) {
      // A lost context, a driver that refuses the readback — none of it is
      // worth a broken inventory. Fall back to the drawn art for good.
      console.warn('[Icons] model icon failed, using drawn art', err);
      return null;
    }
    this.modelIcons.set(id, url);
    this._notify();
    return url;
  }

  /** One repaint per frame however many icons landed in it. */
  _notify() {
    if (this._queued || !this.onUpdate) return;
    this._queued = true;
    requestAnimationFrame(() => {
      this._queued = false;
      if (this.onUpdate) this.onUpdate();
    });
  }
}

// --- item art ---------------------------------------------------------------

function shade(g, x0, y0, x1, y1, a, b) {
  const grad = g.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, a); grad.addColorStop(1, b);
  return grad;
}

function outline(g, path, w = 2.4) {
  g.save();
  g.strokeStyle = 'rgba(18,14,12,.62)';
  g.lineWidth = w;
  g.lineJoin = 'round';
  g.stroke(path);
  g.restore();
}

function poly(pts) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

const ART = {
  stick(g) {
    // tapered branch with a couple of knots rather than a flat parallelogram
    const p = new Path2D();
    p.moveTo(40, 8); p.lineTo(47, 14);
    p.quadraticCurveTo(34, 32, 25, 55);
    p.lineTo(16, 51);
    p.quadraticCurveTo(27, 28, 40, 8);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 18, 10, 46, 54, '#c8a06a', '#6f4d29');
    g.fill(p);
    g.save(); g.clip(p);
    g.strokeStyle = 'rgba(255,255,255,.20)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(38, 13); g.quadraticCurveTo(28, 32, 21, 51); g.stroke();
    g.fillStyle = 'rgba(70,45,20,.45)';
    g.beginPath(); g.ellipse(33, 26, 3.4, 2.2, -0.9, 0, 7); g.fill();
    g.beginPath(); g.ellipse(26, 42, 2.6, 1.8, -0.9, 0, 7); g.fill();
    g.restore();
  },

  lump(g, d) {
    // faceted nugget: a hard silhouette plus two interior facets so it reads as
    // a chunk of ore rather than a flat blob
    const p = poly([[19, 24], [28, 13], [43, 15], [50, 27], [45, 44], [31, 51], [18, 41]]);
    outline(g, p);
    g.fillStyle = shade(g, 20, 14, 48, 50, d.shine || '#666', d.color || '#333');
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(255,255,255,.30)';
    g.fill(poly([[19, 24], [28, 13], [36, 20], [26, 33]]));
    g.fillStyle = 'rgba(255,255,255,.15)';
    g.fill(poly([[36, 20], [43, 15], [50, 27], [40, 30]]));
    g.fillStyle = 'rgba(0,0,0,.26)';
    g.fill(poly([[26, 33], [40, 30], [45, 44], [31, 51]]));
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(20, 25); g.lineTo(28, 14); g.lineTo(42, 16); g.stroke();
  },

  ingot(g, d) {
    const p = poly([[16, 36], [24, 24], [46, 24], [54, 36], [46, 46], [24, 46]]);
    outline(g, p);
    g.fillStyle = shade(g, 20, 24, 50, 46, d.shine, d.color);
    g.fill(p);
    const top = poly([[24, 24], [46, 24], [50, 30], [20, 30]]);
    g.fillStyle = 'rgba(255,255,255,.34)'; g.fill(top);
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(20, 40, 30, 6);
  },

  /** A tapered pail with a handle; `d.fill` floods it to the brim. */
  bucket(g, d) {
    // handle first, so the rim overlaps its ends
    g.strokeStyle = d.shine || '#dfe3ea';
    g.lineWidth = 3; g.lineJoin = 'round';
    g.beginPath(); g.arc(32, 26, 13, Math.PI, 0); g.stroke();

    const body = poly([[17, 22], [47, 22], [43, 52], [21, 52]]);
    outline(g, body);
    g.fillStyle = shade(g, 18, 20, 46, 52, d.shine, d.color);
    g.fill(body);
    g.fillStyle = 'rgba(0,0,0,.16)'; g.fillRect(31, 27, 2, 25);

    // Contents go on *top* of the body — filling first and then painting the
    // opaque pail over it made a full bucket byte-identical to an empty one.
    if (d.fill) {
      const water = poly([[20, 27], [44, 27], [41, 49], [23, 49]]);
      g.fillStyle = shade(g, 20, 25, 44, 49, '#7fd0f2', d.fill);
      g.fill(water);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillRect(22, 27, 20, 3);
    }
    // rim band last, so the waterline sits behind the lip
    g.fillStyle = 'rgba(255,255,255,.30)'; g.fillRect(17, 22, 30, 5);
  },

  /**
   * A struck coin. Without this the currency fell through to `lump` and read
   * as a gold nugget — indistinguishable at 46px from raw gold, which is the
   * one thing a price tag must never be confused with.
   */
  coin(g, d) {
    const face = new Path2D();
    face.ellipse(32, 32, 21, 21, 0, 0, 7);
    // rim shadow first, offset down, so the disc reads as having thickness
    const edge = new Path2D();
    edge.ellipse(32, 35, 21, 21, 0, 0, 7);
    g.fillStyle = 'rgba(120, 82, 16, .85)';
    g.fill(edge);
    outline(g, face);
    g.fillStyle = shade(g, 14, 12, 50, 52, d.shine || '#ffe58a', d.color || '#d9a52b');
    g.fill(face);

    // inner ring
    g.strokeStyle = 'rgba(120, 82, 16, .5)'; g.lineWidth = 1.6;
    g.beginPath(); g.arc(32, 32, 15.5, 0, 7); g.stroke();

    // the planet this world runs on, stamped in relief
    g.save();
    g.clip(face);
    g.fillStyle = 'rgba(122, 84, 18, .55)';
    g.beginPath(); g.arc(32, 32, 8, 0, 7); g.fill();
    g.fillStyle = d.shine || '#ffe58a';
    g.beginPath(); g.arc(31, 31, 7, 0, 7); g.fill();
    g.strokeStyle = 'rgba(122, 84, 18, .6)'; g.lineWidth = 2.2;
    g.beginPath(); g.ellipse(32, 32, 13, 4.2, -0.42, 0, 7); g.stroke();
    // specular sweep across the top-left
    g.fillStyle = 'rgba(255, 255, 255, .35)';
    g.beginPath(); g.ellipse(24, 22, 10, 4.4, -0.7, 0, 7); g.fill();
    g.restore();
  },

  crystal(g, d) {
    const p = poly([[32, 8], [48, 26], [40, 54], [24, 54], [16, 26]]);
    outline(g, p);
    g.fillStyle = shade(g, 20, 10, 44, 52, d.shine, d.color);
    g.fill(p);
    g.fillStyle = 'rgba(255,255,255,.42)';
    g.fill(poly([[32, 8], [40, 26], [32, 54], [26, 26]]));
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.fill(poly([[32, 10], [36, 25], [32, 34], [29, 25]]));
  },

  wheat(g) {
    // three stalks bound at the base, each with paired grains and an awn
    for (const dx of [-10, 0, 10]) {
      g.strokeStyle = '#7d6c2e'; g.lineWidth = 3.2; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(32 + dx * 0.25, 58);
      g.quadraticCurveTo(32 + dx * 0.8, 36, 32 + dx * 1.35, 13);
      g.stroke();
      g.strokeStyle = 'rgba(226,206,120,.55)'; g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(32 + dx * 0.25, 56);
      g.quadraticCurveTo(32 + dx * 0.8, 36, 32 + dx * 1.35, 15);
      g.stroke();
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const y = 15 + i * 7.5;
        const x = 32 + dx * (1.35 - t * 0.5);
        for (const side of [-1, 1]) {
          const p = new Path2D();
          p.ellipse(x + side * 4.2, y, 4.6, 2.7, side * 0.6, 0, 7);
          outline(g, p, 1.4);
          g.fillStyle = shade(g, x - 5, y - 3, x + 5, y + 3,
            i % 2 ? '#f6dc84' : '#e6c258', '#b48f2e');
          g.fill(p);
        }
      }
      g.strokeStyle = 'rgba(200,180,110,.7)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(32 + dx * 1.35, 14); g.lineTo(32 + dx * 1.5, 5); g.stroke();
    }
    g.strokeStyle = '#8a6a3a'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(24, 50); g.lineTo(40, 50); g.stroke();
  },

  seeds(g) {
    // a little heap of teardrop seeds, each with a highlight and a dark tip
    const spots = [
      [22, 40, 0.5], [32, 44, -0.2], [42, 39, -0.7],
      [27, 30, 0.9], [38, 29, -1.0], [32, 20, 0.1],
    ];
    for (const [x, y, rot] of spots) {
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      const p = new Path2D();
      p.moveTo(0, -9);
      p.bezierCurveTo(6, -5, 6, 6, 0, 9);
      p.bezierCurveTo(-6, 6, -6, -5, 0, -9);
      outline(g, p, 2);
      g.fillStyle = shade(g, -6, -9, 6, 9, '#d8dc94', '#7d8a3c');
      g.fill(p);
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.beginPath(); g.ellipse(-1.6, -3, 1.8, 3.4, 0.2, 0, 7); g.fill();
      g.fillStyle = 'rgba(60,66,24,.5)';
      g.beginPath(); g.ellipse(0.6, 6.4, 2.2, 1.8, 0, 0, 7); g.fill();
      g.restore();
    }
  },

  apple(g) {
    const p = new Path2D();
    p.moveTo(32, 22);
    p.bezierCurveTo(46, 12, 56, 28, 48, 44);
    p.bezierCurveTo(42, 55, 22, 55, 16, 44);
    p.bezierCurveTo(8, 28, 18, 12, 32, 22);
    outline(g, p);
    g.fillStyle = shade(g, 18, 16, 48, 50, '#e8524a', '#a4211f');
    g.fill(p);
    g.fillStyle = 'rgba(255,255,255,.4)';
    g.beginPath(); g.ellipse(25, 28, 6, 8, -0.6, 0, 7); g.fill();
    g.strokeStyle = '#5c3f22'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(33, 20); g.lineTo(35, 10); g.stroke();
    g.fillStyle = '#4e8c39';
    g.beginPath(); g.ellipse(43, 12, 8, 4.4, -0.5, 0, 7); g.fill();
  },

  bread(g) {
    const p = new Path2D();
    p.moveTo(12, 40);
    p.bezierCurveTo(10, 22, 26, 16, 34, 18);
    p.bezierCurveTo(48, 20, 56, 30, 52, 42);
    p.bezierCurveTo(46, 50, 20, 50, 12, 40);
    outline(g, p);
    g.fillStyle = shade(g, 14, 18, 50, 48, '#e0a656', '#a56b2c');
    g.fill(p);
    g.strokeStyle = 'rgba(90,52,20,.55)'; g.lineWidth = 2.4; g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      g.beginPath(); g.moveTo(22 + i * 10, 24); g.lineTo(18 + i * 10, 34); g.stroke();
    }
  },

  roast(g) {
    const p = new Path2D();
    p.ellipse(32, 36, 20, 15, 0, 0, 7);
    outline(g, p);
    g.fillStyle = shade(g, 14, 22, 50, 50, '#f0a24a', '#a8541a');
    g.fill(p);
    g.fillStyle = 'rgba(255,255,255,.26)';
    g.beginPath(); g.ellipse(26, 30, 7, 4, -0.4, 0, 7); g.fill();
    g.strokeStyle = 'rgba(120,58,16,.6)'; g.lineWidth = 2;
    for (let i = -1; i <= 1; i++) {
      g.beginPath(); g.moveTo(32 + i * 10, 24); g.lineTo(32 + i * 12, 48); g.stroke();
    }
  },

  pick(g, d) {
    ART._handle(g);
    const p = new Path2D();
    p.moveTo(10, 24); p.quadraticCurveTo(32, 8, 54, 24);
    p.quadraticCurveTo(32, 18, 10, 32);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 10, 10, 54, 30, d.edge, d.color);
    g.fill(p);
  },

  axe(g, d) {
    ART._handle(g);
    const p = new Path2D();
    p.moveTo(30, 12); p.quadraticCurveTo(52, 14, 50, 32);
    p.quadraticCurveTo(44, 40, 30, 34);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 30, 12, 52, 36, d.edge, d.color);
    g.fill(p);
  },

  shovel(g, d) {
    ART._handle(g);
    const p = new Path2D();
    p.moveTo(24, 12); p.lineTo(44, 12); p.lineTo(42, 30);
    p.quadraticCurveTo(34, 38, 26, 30);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 24, 12, 44, 34, d.edge, d.color);
    g.fill(p);
  },

  sword(g, d) {
    // hilt
    g.strokeStyle = '#5a3d22'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(20, 52); g.lineTo(27, 45); g.stroke();
    g.strokeStyle = '#8a6a3a'; g.lineWidth = 6;
    g.beginPath(); g.moveTo(17, 40); g.lineTo(31, 54); g.stroke();
    const p = poly([[27, 44], [46, 12], [54, 20], [34, 50]]);
    outline(g, p);
    g.fillStyle = shade(g, 27, 44, 54, 12, d.color, d.edge);
    g.fill(p);
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(31, 44); g.lineTo(48, 17); g.stroke();
  },

  // --- armour ---------------------------------------------------------------
  // Four flat silhouettes that read at 46px, which is the whole design brief:
  // in a slot that size a rendered 3/4 view of a helmet is a grey smudge. Each
  // takes the tier colour and edge like the tools do, so the same five metals
  // are recognisable across weapons and armour without any new art.

  helm(g, d) {
    const p = new Path2D();
    p.moveTo(16, 40);
    p.quadraticCurveTo(16, 14, 35, 14);
    p.quadraticCurveTo(54, 14, 54, 40);
    p.lineTo(54, 52); p.lineTo(45, 52); p.lineTo(45, 40);
    p.lineTo(25, 40); p.lineTo(25, 52); p.lineTo(16, 52);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 16, 14, 54, 52, d.edge, d.color);
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(255,255,255,.28)';
    g.beginPath(); g.ellipse(28, 24, 9, 7, -0.5, 0, 7); g.fill();
    g.fillStyle = 'rgba(0,0,0,.22)';
    g.fillRect(16, 36, 38, 5);
    g.restore();
  },

  chest(g, d) {
    const p = new Path2D();
    p.moveTo(18, 20); p.lineTo(27, 15); p.lineTo(43, 15); p.lineTo(52, 20);
    p.lineTo(56, 34); p.lineTo(48, 34); p.lineTo(48, 54);
    p.lineTo(22, 54); p.lineTo(22, 34); p.lineTo(14, 34);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 14, 15, 56, 54, d.edge, d.color);
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(255,255,255,.26)';
    g.fill(poly([[27, 15], [43, 15], [39, 26], [31, 26]]));
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(35, 26); g.lineTo(35, 54); g.stroke();
    g.beginPath(); g.moveTo(22, 42); g.lineTo(48, 42); g.stroke();
    g.restore();
  },

  legs(g, d) {
    const p = new Path2D();
    p.moveTo(19, 14); p.lineTo(51, 14); p.lineTo(51, 30);
    p.lineTo(45, 56); p.lineTo(37, 56); p.lineTo(35, 34);
    p.lineTo(33, 56); p.lineTo(25, 56); p.lineTo(19, 30);
    p.closePath();
    outline(g, p);
    g.fillStyle = shade(g, 19, 14, 51, 56, d.edge, d.color);
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(255,255,255,.24)';
    g.fillRect(19, 14, 32, 7);
    g.fillStyle = 'rgba(0,0,0,.2)';
    g.fillRect(19, 28, 32, 4);
    g.restore();
  },

  boots(g, d) {
    const boot = (x) => {
      const p = new Path2D();
      p.moveTo(x, 20); p.lineTo(x + 13, 20); p.lineTo(x + 13, 40);
      p.lineTo(x + 18, 40); p.lineTo(x + 18, 50); p.lineTo(x, 50);
      p.closePath();
      return p;
    };
    for (const x of [10, 36]) {
      const p = boot(x);
      outline(g, p);
      g.fillStyle = shade(g, x, 20, x + 18, 50, d.edge, d.color);
      g.fill(p);
      g.save(); g.clip(p);
      g.fillStyle = 'rgba(255,255,255,.24)';
      g.fillRect(x, 20, 13, 6);
      g.fillStyle = 'rgba(0,0,0,.26)';
      g.fillRect(x, 45, 18, 5);
      g.restore();
    }
  },

  rod(g, d) {
    // A tapered pole corner to corner, a line hanging from the tip, and a float
    // on the end. The line is what makes it read as a rod rather than a stick —
    // at 46px the pole alone is indistinguishable from a plank.
    const pole = new Path2D();
    pole.moveTo(11, 54); pole.lineTo(15, 50);
    pole.quadraticCurveTo(34, 30, 50, 12);
    pole.lineTo(53, 15);
    pole.quadraticCurveTo(37, 33, 18, 55);
    pole.closePath();
    outline(g, pole);
    g.fillStyle = shade(g, 11, 54, 53, 12, d.shine || '#c9a86a', d.color || '#8a6a3a');
    g.fill(pole);

    // whipping at the grip
    g.strokeStyle = 'rgba(60,40,20,.55)'; g.lineWidth = 1.4;
    for (const t of [0.06, 0.12, 0.18]) {
      const x = 13 + (51 - 13) * t, y = 52 - (52 - 13) * t;
      g.beginPath(); g.moveTo(x - 2, y - 1); g.lineTo(x + 2, y + 3); g.stroke();
    }

    // line and float
    g.strokeStyle = 'rgba(250,250,255,.75)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(51, 13);
    g.quadraticCurveTo(56, 28, 46, 40);
    g.stroke();
    g.beginPath(); g.arc(45, 43, 3.6, 0, 7);
    g.fillStyle = '#d94f3d'; g.fill();
    g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.arc(45, 41.4, 3.6, Math.PI, 0);
    g.fillStyle = '#f2f2f2'; g.fill();
  },

  hide(g) {
    // a folded pelt: irregular edge, soft interior, stitched seam
    const p = new Path2D();
    p.moveTo(14, 22); p.quadraticCurveTo(20, 10, 32, 14);
    p.quadraticCurveTo(45, 9, 51, 22);
    p.quadraticCurveTo(56, 36, 44, 48);
    p.quadraticCurveTo(32, 57, 20, 47);
    p.quadraticCurveTo(9, 36, 14, 22);
    outline(g, p);
    g.fillStyle = shade(g, 12, 12, 52, 52, '#c8a882', '#8a6b4c');
    g.fill(p);
    g.save(); g.clip(p);
    g.fillStyle = 'rgba(255,255,255,.22)';
    g.beginPath(); g.ellipse(26, 26, 10, 7, -0.4, 0, 7); g.fill();
    g.strokeStyle = 'rgba(92,66,42,.5)'; g.lineWidth = 1.4;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(20, 40); g.quadraticCurveTo(32, 46, 46, 36); g.stroke();
    g.setLineDash([]);
    g.restore();
  },

  feather(g) {
    // quill plus a vane split by a central rachis
    g.strokeStyle = '#d8d2c4'; g.lineWidth = 2.6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(44, 10); g.quadraticCurveTo(30, 34, 20, 56); g.stroke();
    for (const side of [-1, 1]) {
      const p = new Path2D();
      p.moveTo(44, 11);
      p.quadraticCurveTo(38 + side * 12, 22, 30 + side * 9, 36);
      p.quadraticCurveTo(26 + side * 4, 46, 21, 54);
      p.quadraticCurveTo(28, 34, 44, 11);
      outline(g, p, 1.8);
      g.fillStyle = shade(g, 20, 12, 46, 52,
        side < 0 ? '#fbfaf6' : '#e6e1d4', side < 0 ? '#cfc8b6' : '#b4ab98');
      g.fill(p);
    }
    g.strokeStyle = 'rgba(120,112,96,.55)'; g.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const x = 44 - t * 22, y = 12 + t * 40;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - 7 + t * 2, y + 5); g.stroke();
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 7 - t * 2, y + 5); g.stroke();
    }
  },

  meat(g, d) {
    // Drumstick, read from the bottom-left up: a knuckled bone, then the meat
    // wrapped around its top half. The bone used to be a 7px stub buried under
    // the meat, which left the icon reading as a lollipop rather than a joint.
    const cooked = d && d.cooked;

    const bone = new Path2D();
    bone.moveTo(17, 55); bone.lineTo(38, 30);
    bone.lineTo(43, 34); bone.lineTo(22, 59);
    bone.closePath();
    outline(g, bone, 2);
    g.fillStyle = shade(g, 16, 56, 42, 30, '#f6f0e2', '#c9bfa8');
    g.fill(bone);
    // knuckle
    for (const [x, y, r] of [[16, 53, 6], [22, 58, 5.2]]) {
      const k = new Path2D();
      k.arc(x, y, r, 0, 7);
      outline(g, k, 2);
      g.fillStyle = shade(g, x - r, y - r, x + r, y + r, '#fbf6ea', '#cdc3ac');
      g.fill(k);
    }

    const p = new Path2D();
    p.moveTo(31, 40);
    p.bezierCurveTo(22, 30, 26, 13, 40, 11);
    p.bezierCurveTo(54, 9, 60, 24, 52, 36);
    p.bezierCurveTo(46, 45, 36, 47, 31, 40);
    outline(g, p);
    g.fillStyle = shade(g, 26, 11, 58, 44,
      cooked ? '#cf8a48' : '#e58a80', cooked ? '#8a4f22' : '#a03c39');
    g.fill(p);

    g.save(); g.clip(p);
    // sheen along the upper-left shoulder
    g.fillStyle = 'rgba(255,255,255,.30)';
    g.beginPath(); g.ellipse(37, 21, 9, 5.2, -0.6, 0, 7); g.fill();
    // shadow where the meat meets the bone
    g.fillStyle = 'rgba(60,20,18,.22)';
    g.beginPath(); g.ellipse(35, 41, 11, 6, -0.7, 0, 7); g.fill();
    if (cooked) {
      g.strokeStyle = 'rgba(70,36,12,.42)'; g.lineWidth = 2.2; g.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(30 + i * 7, 20 + i * 5);
        g.lineTo(41 + i * 7, 28 + i * 5);
        g.stroke();
      }
    }
    g.restore();
  },

  _handle(g) {
    g.strokeStyle = '#6b4a26'; g.lineWidth = 7; g.lineCap = 'round';
    g.beginPath(); g.moveTo(32, 20); g.lineTo(24, 54); g.stroke();
    g.strokeStyle = '#a1774a'; g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(32, 21); g.lineTo(24, 53); g.stroke();
  },
};
