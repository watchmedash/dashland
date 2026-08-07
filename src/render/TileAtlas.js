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
