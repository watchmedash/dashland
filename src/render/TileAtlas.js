// Load the pre-baked tile atlases and slice them into texture-array payloads.
// Replaces ~10s of runtime procedural synthesis with three image decodes.

const BASE = 'tiles';

async function loadImage(url, opts) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, opts);
}

/**
 * Read a whole image's RGB back with the colour under alpha == 0 intact.
 *
 * A 2D canvas stores premultiplied, so `getImageData` has nothing to return for
 * a texel whose alpha is zero — the un-premultiply is a division by zero and
 * every browser hands back black. For a cut-out that is harmless, because the
 * RGB there is not meant to be looked at. For the arm map it is destructive:
 * its alpha is not transparency at all, it is the per-texel biome-tint mask
 * (see FRINGE in scripts/bake-textures.mjs), and its RGB is the ambient
 * occlusion, roughness and metalness that those very texels are shaded with.
 * Measured on the baked atlas, 84% of `grass_side` carries mask 0, so the
 * canvas decode was handing the shader texAO = 0 across the whole soil band of
 * the tile — and texAO 0 zeroes `aoTotal`, which deletes every indirect term in
 * VoxelMaterial. That is why the sides of a grass block rendered black in
 * anything but direct sun, on the terrain as much as on a placed one.
 *
 * GL is the way out because it is the one path that never premultiplies, and it
 * takes BOTH halves of that to work: the bitmap has to be decoded with
 * `premultiplyAlpha: 'none'` — the default premultiplies at decode and the
 * colour is gone before GL ever sees it — and then uploaded with
 * UNPACK_PREMULTIPLY_ALPHA off. Blit that through a shader that keeps rgb and
 * writes alpha 1, and read it back. Alpha itself comes from the ordinary canvas
 * decode, where it survives exactly.
 *
 * Returns null if a context cannot be had, and the caller then keeps the canvas
 * RGB — a wrong ambient occlusion on two tiles is a far smaller failure than no
 * atlas at all.
 */
function imageRGBUnpremultiplied(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (!gl) return null;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = compile(gl.VERTEX_SHADER, `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`);
  const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 vUv; out vec4 oCol; uniform sampler2D uTex;
void main() { oCol = vec4(texture(uTex, vUv).rgb, 1.0); }`);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.useProgram(prog);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // readPixels counts rows from the bottom of the framebuffer, and the quad
  // above puts uv.y 0 there, so row 0 of the result is row 0 of the image with
  // UNPACK_FLIP_Y off — the same order the canvas path produces.
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

/** Read a whole image into RGBA bytes. */
function imageToRGBA(bitmap) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/**
 * Push opaque colour outward into the fully transparent region of one tile,
 * so that mipmapping has something other than black to average in.
 *
 * WHY this and not `createImageBitmap(blob, { premultiplyAlpha: 'none' })`:
 * that only preserves whatever RGB the *file* holds under alpha 0, and
 * measured on this atlas the file holds black there. Mean RGB under alpha==0
 * is (0.1, 1.6, 0.1) for tall_grass, (0.0, 0.3, 0.0) for wheat_0, (0.3, 0, 0)
 * for torch: the tile generator draws onto a cleared buffer and libwebp's
 * `exact: true` faithfully keeps that black. Simulating the mip chain and
 * alphaTest 0.42, an unpremultiplied decode moves tall_grass from 39.2% to
 * 37.2% luminance lost at visible texels; the dilate below takes it to 1.3%.
 * So the decode path was never the whole bug, and no amount of readback
 * plumbing fixes it. Dilation is also the portable one: it is plain array
 * work, identical on Chrome, on an Electron/Tauri wrapper, and on mobile
 * GL ES, with no dependency on premultiply flags a driver may ignore.
 *
 * Decode-time only, ~once per session; see the timing log in loadTileAtlas.
 */
function dilateLayer(px, off, size) {
  const n = size * size;
  const filled = new Uint8Array(n);
  let head = 0, tail = 0;
  const q = new Int32Array(n);
  for (let i = 0; i < n; i++) if (px[off + i * 4 + 3] !== 0) { filled[i] = 1; q[tail++] = i; }
  if (tail === 0 || tail === n) return false;   // fully clear, or nothing to fill
  while (head < tail) {
    const i = q[head++];
    const x = i % size, y = (i / size) | 0;
    const si = off + i * 4;
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (filled[j]) continue;
      filled[j] = 1;
      const dj = off + j * 4;
      px[dj] = px[si]; px[dj + 1] = px[si + 1]; px[dj + 2] = px[si + 2];
      q[tail++] = j;
    }
  }
  return true;
}

/**
 * Per LAYER, never across the whole atlas: neighbouring tiles are adjacent in
 * the grid, and bleeding one into the next is the exact artefact this removes.
 */
function dilateLayers(bytes, size, layers) {
  const per = size * size * 4;
  let touched = 0;
  for (let li = 0; li < layers; li++) if (dilateLayer(bytes, li * per, size)) touched++;
  return touched;
}

/** Grid atlas → contiguous per-layer bytes, in layer order. */
function sliceGrid(rgba, atlasW, size, cols, layers) {
  const per = size * size * 4;
  const out = new Uint8Array(per * layers);
  const rowBytes = size * 4;
  for (let li = 0; li < layers; li++) {
    const cx = (li % cols) * size;
    const cy = Math.floor(li / cols) * size;
    for (let y = 0; y < size; y++) {
      const src = ((cy + y) * atlasW + cx) * 4;
      out.set(rgba.subarray(src, src + rowBytes), li * per + y * rowBytes);
    }
  }
  return out;
}

/** Horizontal strip atlas (used by the crack overlay). */
function sliceStrip(rgba, atlasW, size, layers) {
  const per = size * size * 4;
  const out = new Uint8Array(per * layers);
  const rowBytes = size * 4;
  for (let li = 0; li < layers; li++) {
    for (let y = 0; y < size; y++) {
      const src = (y * atlasW + li * size) * 4;
      out.set(rgba.subarray(src, src + rowBytes), li * per + y * rowBytes);
    }
  }
  return out;
}

/**
 * @returns {{tiles:{albedo,normal,arm,size,layers}, crack:{data,size,layers}}}
 */
export async function loadTileAtlas(onProgress = () => {}) {
  const manifest = await fetch(`${BASE}/manifest.json`).then((r) => {
    if (!r.ok) throw new Error('no baked atlas');
    return r.json();
  });
  onProgress(0.1, 'Loading materials');

  const ext = manifest.ext || 'png';
  const names = ['albedo', 'normal', 'arm'];
  const bitmaps = [];
  for (let i = 0; i < names.length; i++) {
    bitmaps.push(await loadImage(`${BASE}/${names[i]}.${ext}`));
    onProgress(0.1 + 0.22 * (i + 1), `Loading ${names[i]}`);
  }
  const crackBmp = await loadImage(`${BASE}/crack.${ext}`);
  onProgress(0.85, 'Unpacking materials');

  const { size, cols, layers } = manifest;
  // The arm map alone is read twice: its alpha off the canvas, where alpha is
  // exact, and its colour off GL, where the colour under a zero mask survives.
  // See imageRGBUnpremultiplied. Albedo and normal stay on the canvas path —
  // albedo's transparent RGB is a cut-out's and is dealt with by the dilate
  // below, and nothing ever writes a transparent texel into the normal map.
  const sheets = bitmaps.map((bmp) => imageToRGBA(bmp));
  const armRaw = await loadImage(`${BASE}/arm.${ext}`, { premultiplyAlpha: 'none' });
  const armExact = imageRGBUnpremultiplied(armRaw);
  armRaw.close?.();
  if (armExact) {
    const a = sheets[2];
    for (let i = 0; i < a.length; i += 4) {
      a[i] = armExact[i]; a[i + 1] = armExact[i + 1]; a[i + 2] = armExact[i + 2];
    }
  }
  const [albedo, normal, arm] = sheets.map((rgba, i) =>
    sliceGrid(rgba, bitmaps[i].width, size, cols, layers));

  // Albedo only. The dilate exists so a cut-out tile's transparent texels carry
  // their neighbours' colour into the mips instead of black. The normal map has
  // no transparent texel at all, and the arm map's alpha is not transparency —
  // it is the per-texel biome-tint mask on the two fringe tiles (see FRINGE in
  // scripts/bake-textures.mjs), which wants its own soft mip edge and must not
  // be dilated. The crack strip is never far enough away for its mips to matter.
  const t0 = performance.now();
  const dilated = dilateLayers(albedo, size, layers);
  if (import.meta.env?.DEV) {
    console.log(`[TileAtlas] edge-extended ${dilated}/${layers} cut-out layers in ${(performance.now() - t0).toFixed(1)}ms`);
  }

  const crack = sliceStrip(imageToRGBA(crackBmp), crackBmp.width,
    manifest.crack.size, manifest.crack.layers);

  for (const b of bitmaps) b.close?.();
  crackBmp.close?.();
  onProgress(1, 'Materials ready');

  return {
    tiles: { albedo, normal, arm, size, layers },
    crack: { data: crack, size: manifest.crack.size, layers: manifest.crack.layers },
  };
}
