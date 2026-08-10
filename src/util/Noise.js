// Deterministic noise toolkit — simplex 3D, fbm, ridged, worley, value noise.
// Pure ES module, safe in workers.
//
// 3D and not 2D: see the note above `simplex3`. The skew constants below are
// only the 3D pair now, because F2/G2 had no reader once the 2D path went.

const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** xorshift32 PRNG — small, fast, deterministic. */
export function makeRng(seed) {
  let s = seed | 0 || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return (s >>> 0) / 4294967296;
  };
}

// A one-argument `hash1` stood here and had no caller anywhere in `src/` or
// `scripts/`. Everything that hashes on this planet hashes a cell, and a cell is
// three coordinates, so `hash3` below is the only shape that was ever wanted.
export function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class Noise {
  constructor(seed = 1337) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  // --- there is no 2D noise here, and there never was a caller for one --------
  //
  // `simplex2` and the `fbm2` that wrapped it stood here, and between them they
  // had exactly one reference in the whole repo: `fbm2` calling `simplex2`. The
  // reason is structural rather than accidental. This is a sphere, sampled in
  // world space, so every field on it is asked for at an (x, y, z) on the shell:
  // all 21 worldgen calls go to `fbm3`, all 16 to `simplex3`, all 3 to
  // `ridged3`. The flat 2D fields that do exist are the texture ones, and those
  // have to tile, which simplex cannot do -- they go through
  // `tileableValueNoise`/`tileableFbm`/`tileableWorley` below instead.
  //
  // So a 2D simplex on this planet is not a primitive waiting for a use. It is
  // a shape the geometry does not ask for.
  simplex3(xin, yin, zin) {
    const { perm, permMod12 } = this;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const gi0 = permMod12[ii + perm[jj + perm[kk]]] * 3;
    const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
    const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
    const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0 + GRAD3[gi0 + 2] * z0); }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1 + GRAD3[gi1 + 2] * z1); }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2 + GRAD3[gi2 + 2] * z2); }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 >= 0) { t3 *= t3; n3 = t3 * t3 * (GRAD3[gi3] * x3 + GRAD3[gi3 + 1] * y3 + GRAD3[gi3 + 2] * z3); }
    return 32 * (n0 + n1 + n2 + n3);
  }

  fbm3(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal — sharp mountain crests. */
  ridged3(x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.simplex3(x * freq, y * freq, z * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }
}

/** Tileable 2D value noise on a WxH torus — used for seamless block textures. */
export function tileableValueNoise(w, h, cells, seed) {
  const rng = makeRng(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(w * h);
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cells;
    const y0 = Math.floor(fy) % cells, y1 = (y0 + 1) % cells;
    const ty = smooth(fy - Math.floor(fy));
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cells;
      const x0 = Math.floor(fx) % cells, x1 = (x0 + 1) % cells;
      const tx = smooth(fx - Math.floor(fx));
      const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
      const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
      out[y * w + x] = (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
  }
  return out;
}

/** Tileable fbm built from stacked tileable value noise. */
export function tileableFbm(w, h, baseCells, octaves, seed, gain = 0.5) {
  const out = new Float32Array(w * h);
  let amp = 1, norm = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const layer = tileableValueNoise(w, h, cells, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    norm += amp;
    amp *= gain;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Tileable Worley (cellular) noise. Returns F1 distance normalised to ~[0,1]. */
export function tileableWorley(w, h, cells, seed, mode = 'f1') {
  const rng = makeRng(seed);
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) { px[i] = rng(); py[i] = rng(); }
  const out = new Float32Array(w * h);
  const cs = 1 / cells;
  for (let y = 0; y < h; y++) {
    const uy = y / h;
    const cy = Math.floor(uy * cells);
    for (let x = 0; x < w; x++) {
      const ux = x / w;
      const cx = Math.floor(ux * cells);
      let f1 = 10, f2 = 10;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = (cx + dx + cells) % cells;
          const gy = (cy + dy + cells) % cells;
          const i = gy * cells + gx;
          let fx = (Math.floor((cx + dx)) + px[i]) * cs;
          let fy = (Math.floor((cy + dy)) + py[i]) * cs;
          const ddx = fx - ux, ddy = fy - uy;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
      }
      out[y * w + x] = mode === 'f2f1' ? Math.min(1, (f2 - f1) * cells) : Math.min(1, f1 * cells * 1.4);
    }
  }
  return out;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
