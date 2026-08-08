// Isometric block icons painted from the generated tile textures, hand-drawn
// vector art for the items that never exist as blocks, and — for anything that
// has real 3D art — an icon rendered from that very model, so what you hold and
// what you see in the grid are the same object.

import * as THREE from 'three';
import { BLOCKS, TILES, R_CROSS, R_LIQUID } from '../world/Blocks.js';
import { ITEMS } from '../game/Items.js';
import { iconModel, hasModel } from '../render/ItemModels.js';

// Rendered at 2x the largest slot so icons stay crisp when scaled down.
const ICON = 96;

// True 2:1 isometric cube laid out inside the icon box. The top rhombus is
// 2 wide : 1 tall, and the side walls are taller than half the rhombus —
// otherwise the cube reads squashed.
const ISO = (() => {
  const pad = 5;
  const w = ICON - pad * 2;              // 86 full width
  const halfW = w / 2;                   // 43
  const rhombusH = halfW;                // 2:1 → 43 total height, 21.5 per half
  const wallH = Math.round(w * 0.52);    // 45
  const cx = ICON / 2;
  const topY = pad;                      // apex of the top face
  const midY = topY + rhombusH / 2;      // left/right corners of the top face
  const botY = topY + rhombusH;          // near corner of the top face
  return {
    top: { ox: pad, oy: midY, ux: halfW, uy: -rhombusH / 2, vx: halfW, vy: rhombusH / 2 },
    left: { ox: pad, oy: midY, ux: halfW, uy: rhombusH / 2, vx: 0, vy: wallH },
    right: { ox: cx, oy: botY, ux: halfW, uy: -rhombusH / 2, vx: 0, vy: wallH },
    apex: [cx, topY], leftC: [pad, midY], rightC: [ICON - pad, midY],
  };
})();

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

    const o = this.out.getContext('2d');
    o.clearRect(0, 0, ICON, ICON);
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = 'high';
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

  /** data-URL icon for a block id. */
  block(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const b = BLOCKS[id];
    const c = document.createElement('canvas');
    c.width = c.height = ICON;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    if (b.render === R_CROSS) {
      g.drawImage(this.tiles[b.side], 6, 6, ICON - 12, ICON - 12);
    } else {
      const S = this.size;
      const face = (tile, ox, oy, ux, uy, vx, vy, shade, alpha = 1) => {
        g.save();
        g.beginPath();
        g.moveTo(ox, oy);
        g.lineTo(ox + ux, oy + uy);
        g.lineTo(ox + ux + vx, oy + uy + vy);
        g.lineTo(ox + vx, oy + vy);
        g.closePath();
        g.clip();
        g.globalAlpha = alpha;
        g.setTransform(ux / S, uy / S, vx / S, vy / S, ox, oy);
        g.drawImage(this.tiles[tile], 0, 0);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        if (shade < 0) { g.fillStyle = `rgba(0,0,0,${-shade})`; g.fillRect(0, 0, ICON, ICON); }
        else if (shade > 0) { g.fillStyle = `rgba(255,255,255,${shade})`; g.fillRect(0, 0, ICON, ICON); }
        g.restore();
      };

      const alpha = b.render === R_LIQUID ? 0.82 : 1;
      const { top, left, right } = ISO;
      face(b.top, top.ox, top.oy, top.ux, top.uy, top.vx, top.vy, 0.12, alpha);
      face(b.side, left.ox, left.oy, left.ux, left.uy, left.vx, left.vy, -0.28, alpha);
      // a directional block shows its front on one visible face, so the icon
      // still reads as a kiln/furnace rather than a blank box
      face(b.directional ? b.front : b.side,
        right.ox, right.oy, right.ux, right.uy, right.vx, right.vy, -0.11, alpha);

      // crisp silhouette highlight along the two top edges
      g.strokeStyle = 'rgba(255,255,255,.18)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(ISO.leftC[0], ISO.leftC[1]);
      g.lineTo(ISO.apex[0], ISO.apex[1]);
      g.lineTo(ISO.rightC[0], ISO.rightC[1]);
      g.stroke();
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
