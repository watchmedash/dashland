// Load the pre-baked tile atlases and slice them into texture-array payloads.
// Replaces ~10s of runtime procedural synthesis with three image decodes.

const BASE = 'tiles';

async function loadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob);
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
  const [albedo, normal, arm] = bitmaps.map((bmp) =>
    sliceGrid(imageToRGBA(bmp), bmp.width, size, cols, layers));

  // Albedo only. Measured on this atlas: normal and arm carry no alpha==0
  // texel at all (0 of 10.2M each), so a dilate there is a pure cost, and the
  // crack strip is never far enough away for its mips to matter.
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
