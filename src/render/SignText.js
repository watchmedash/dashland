import * as THREE from 'three';

/**
 * The writing on a sign, cut into the board in the world.
 *
 * `Blocks.js` used to say this could not be afforded, and it was right about
 * the thing it was costing: "a canvas texture per sign costs a draw call and a
 * megabyte each, and a hundred signs round the back of a base would be a
 * hundred of both". Both halves of that follow from one sign owning one
 * texture. Neither survives giving every sign in the world the SAME texture.
 *
 * So the glyphs are drawn once, into one 512x192 atlas of the 95 printable
 * ASCII characters (~96 KB of GPU memory, for any number of signs), and a sign
 * is quads with UVs into it. Every sign near the player goes into a single
 * merged geometry with a single material: one draw call for the lot, whether
 * that is one sign or a hundred.
 *
 * ### Why it reads as carved rather than printed
 *
 * The atlas bakes two passes per glyph — a pale highlight offset down-right,
 * then dark ink on top at the origin. That is the shading a groove has in
 * light from above, and it is why the material is left white and untinted:
 * tinting would multiply both passes by the same colour and flatten the two
 * back into one. The scene lights it like any other model, so writing goes dark
 * at dusk with the board it is cut into.
 */

const GLYPH0 = 32;               // space
const GLYPH1 = 126;              // ~
const COLS = 16;
const ROWS = 6;                  // 16 * 6 = 96 cells for 95 glyphs
const CELL = 32;                 // px per glyph cell in the atlas

/** 48 characters is the sign's own limit, and 12 x 4 is exactly 48. */
const LINE_CHARS = 12;
const LINES = 4;

/**
 * The board, in cell-local units, from `blockBoxes`: it spans 0.06..0.94 across
 * and 0.52..0.98 up. Text is inset from that so the writing is not flush with
 * the edge of the plank.
 */
const BOARD_W = 0.88 * 0.94;
const BOARD_H = 0.46 * 0.86;
const BOARD_MID_K = 0.75;        // centre of the board's height, cell-local
const SIGN_THICK = 0.13;
/** How wide a drawn glyph is against its height, for fitting text to a board. */
const GLYPH_ASPECT = 0.62;
/** Clear of the board face, or the writing z-fights with the plank. */
const LIFT = 0.014;

const _n = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _o = new THREE.Vector3();

/**
 * Wrap to at most LINES lines of at most LINE_CHARS.
 *
 * A newline the player typed is obeyed, and word wrap fills in around it. Both
 * are needed: someone writing an address wants their own breaks, and someone
 * typing a sentence does not want to count characters. Splitting on `\s+`
 * alone treated a deliberate break as an ordinary space and silently reflowed
 * four short lines into two long ones.
 */
function wrap(text) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    if (out.length >= LINES) break;
    // An empty line the player typed is a blank line on the board, not nothing.
    if (!para.trim()) { if (out.length && out.length < LINES) out.push(''); continue; }
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      if (out.length >= LINES) break;
      if (!line) line = word.slice(0, LINE_CHARS);
      else if (line.length + 1 + word.length <= LINE_CHARS) line += ` ${word}`;
      else { out.push(line); line = word.slice(0, LINE_CHARS); }
      // A single word longer than a line is cut rather than hyphenated: the
      // limit is 48 characters, so this is someone typing one long token, and
      // half of it on the next line reads as a bug rather than as a wrap.
    }
    if (line && out.length < LINES) out.push(line);
  }
  // A trailing blank line is a line the board would carve as nothing; drop it
  // so the block of text still centres on what was actually written.
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export class SignText {
  constructor(scene) {
    this.scene = scene;
    this.material = new THREE.MeshLambertMaterial({
      map: buildAtlas(),
      transparent: true,
      alphaTest: 0.35,
      // The quads sit a hair off the board and face the same way it does, so
      // they never need to be written to depth to sort against each other.
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._cap = 0;
  }

  /**
   * @param {Array<{pos: THREE.Vector3, ea: number[], eb: number[],
   *   up: number[], arcA: number, arcB: number, dir: number, text: string}>}
   *   list one entry per sign with writing on it, near the player
   */
  sync(list) {
    let quads = 0;
    const wrapped = [];
    for (const s of list) {
      const lines = wrap(s.text);
      let n = 0;
      for (const l of lines) for (const ch of l) if (ch !== ' ') n++;
      if (n) { wrapped.push({ s, lines }); quads += n; }
    }
    // Empty the draw range as well as hiding the mesh. `visible` alone left
    // the last frame's letters in the buffer at the last frame's positions,
    // so anything that turned the mesh back on — a scene traversal, a future
    // caller — would draw the writing of a sign that has been broken.
    if (!quads) {
      this.mesh.visible = false;
      this.geometry.setDrawRange(0, 0);
      return;
    }

    if (quads > this._cap) this._grow(quads);
    const pos = this.geometry.getAttribute('position');
    const uv = this.geometry.getAttribute('uv');
    const nrm = this.geometry.getAttribute('normal');

    let q = 0;
    for (const { s, lines } of wrapped) {
      // The board's outward normal, and the two axes of the writing on it.
      // `dir` is the facing byte's low bits: 0 +i, 1 -i, 2 +j, 3 -j.
      const ea = s.ea, eb = s.eb, up = s.up;
      const alongI = s.dir < 2;
      const sgn = (s.dir & 1) ? -1 : 1;
      if (alongI) _n.set(ea[0], ea[1], ea[2]).multiplyScalar(sgn);
      else _n.set(eb[0], eb[1], eb[2]).multiplyScalar(sgn);
      _up.set(up[0], up[1], up[2]);
      // A viewer looking along -n with `up` up has their right at up x n. Get
      // this backwards and every sign in the world is written in mirror.
      _right.crossVectors(_up, _n);

      // Centre of the writing, in world units: out of the cell centre to the
      // board's front face, then up to the middle of the board.
      const face = 0.5 + sgn * (SIGN_THICK / 2 + LIFT);
      const outward = (face - 0.5) * (alongI ? s.arcA : s.arcB) * sgn;
      _o.copy(s.pos)
        .addScaledVector(_n, outward)
        .addScaledVector(_up, BOARD_MID_K - 0.5);

      // Letters are sized to the writing, not to the 12x4 worst case: a sign
      // that says GATE says it in letters four times the height of one
      // carrying all 48 characters, which is how a real board is painted and
      // the difference between legible at eight cells and a smudge.
      const boardW = BOARD_W * (alongI ? s.arcB : s.arcA);
      let longest = 0;
      for (const l of lines) longest = Math.max(longest, l.length);
      const perW = boardW / Math.max(longest, 1);
      // Divided by the LINE PITCH, not by the glyph height: lines are set
      // 1.16 apart, so `BOARD_H / lines.length` is the space each line gets
      // for its letters and leaves no room for the leading between them. A
      // three-line sign overran the plank by 4% and its top line was cut off
      // against the board's edge.
      const perH = BOARD_H / (lines.length * 1.16);
      // A drawn glyph is about 0.62 as wide as it is tall, so width is the
      // binding constraint on a long line and height on a short one. Take
      // whichever runs out first.
      const h = Math.min(perW / GLYPH_ASPECT, perH) * 0.9;
      const cw = h * GLYPH_ASPECT;
      const lh = h * 1.16;
      // Top line first, and the block of lines centred on the board however
      // many there are, so one word sits in the middle rather than up under
      // the top edge.
      const y0 = (lines.length - 1) * 0.5 * lh;

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const x0 = -(line.length - 1) * 0.5 * cw;
        for (let ci = 0; ci < line.length; ci++) {
          const code = line.charCodeAt(ci);
          if (code === 32) continue;
          const g = (code < GLYPH0 || code > GLYPH1) ? 0 : code - GLYPH0;
          const gx = (g % COLS) / COLS, gy = Math.floor(g / COLS) / ROWS;
          const cx = x0 + ci * cw, cy = y0 - li * lh;
          const hw = cw * 0.5, hh = h * 0.5;

          const base = q * 4;
          for (let v = 0; v < 4; v++) {
            const sx = (v === 1 || v === 2) ? 1 : -1;
            const sy = (v >= 2) ? 1 : -1;
            pos.setXYZ(base + v,
              _o.x + _right.x * (cx + hw * sx) + _up.x * (cy + hh * sy),
              _o.y + _right.y * (cx + hw * sx) + _up.y * (cy + hh * sy),
              _o.z + _right.z * (cx + hw * sx) + _up.z * (cy + hh * sy));
            nrm.setXYZ(base + v, _n.x, _n.y, _n.z);
            // V runs down the atlas because `flipY` is off — see buildAtlas.
            // The top of a letter in the world is the top of its cell on the
            // canvas, which is the SMALLER v.
            uv.setXY(base + v,
              gx + (sx > 0 ? 1 : 0) / COLS,
              gy + (sy > 0 ? 0 : 1) / ROWS);
          }
          q++;
        }
      }
    }

    this.geometry.setDrawRange(0, q * 6);
    pos.needsUpdate = true; uv.needsUpdate = true; nrm.needsUpdate = true;
    this.mesh.visible = q > 0;
  }

  /** Reallocate for `quads`, with room to spare so this is not per-frame. */
  _grow(quads) {
    const cap = Math.max(64, 1 << (32 - Math.clz32(quads - 1)));
    this._cap = cap;
    this.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 12), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cap * 12), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cap * 8), 2));
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const b = i * 4;
      idx[i * 6] = b; idx[i * 6 + 1] = b + 1; idx[i * 6 + 2] = b + 2;
      idx[i * 6 + 3] = b; idx[i * 6 + 4] = b + 2; idx[i * 6 + 5] = b + 3;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geometry = g;
    this.mesh.geometry = g;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}

/** The one atlas every sign on the planet reads its letters out of. */
function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = COLS * CELL; cv.height = ROWS * CELL;
  const x = cv.getContext('2d');
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.font = `700 ${Math.round(CELL * 0.74)}px "Trebuchet MS", "Segoe UI", sans-serif`;
  for (let g = 0; g <= GLYPH1 - GLYPH0; g++) {
    const ch = String.fromCharCode(GLYPH0 + g);
    if (ch === ' ') continue;
    const cx = (g % COLS) * CELL + CELL / 2;
    const cy = Math.floor(g / COLS) * CELL + CELL / 2;
    // Light below-right first, dark ink over it: a groove lit from above.
    x.fillStyle = 'rgba(214, 186, 140, .85)';
    x.fillText(ch, cx + 1.4, cy + 1.4);
    x.fillStyle = 'rgba(38, 24, 12, .95)';
    x.fillText(ch, cx, cy);
  }
  const tex = new THREE.CanvasTexture(cv);
  // The atlas is laid out top-down, row 0 at the top of the canvas, and the
  // UVs above are written to match. A CanvasTexture flips Y by default, which
  // both inverts the row index and stands every letter on its head.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}
