// Noise that meets itself at the wrap.
//
// The map is `W` columns on x and y and BOTH AXES WRAP, so every field the
// generator samples has to be periodic over W or the terrain does not join up
// with itself and the outer edge of the map is a cliff. NINE-FACES.md section 4
// calls this "the one genuinely new requirement" of the conversion, and it is:
// a sphere is a closed surface, so the cube's fields were periodic for free.
//
// The trick used here is the second of the two the spec names: a lattice noise
// whose period is controlled. This is ordinary gradient (Perlin) noise with an
// integer lattice period per axis, and the lattice index is taken modulo that
// period before it is hashed — so the cell at x and the cell at x + P are
// LITERALLY THE SAME CELL, with the same gradients. Value, first derivative and
// every higher one match at the wrap by construction rather than by tuning, and
// there is nothing to get wrong at the join because there is no join.
//
// The alternative was 4D simplex on a duocylinder, which is exact for the two
// surface axes and no help at all for the volumetric fields (caves, ore, strata)
// — those want x, y AND depth, so periodicity in two of three axes would have
// meant a fifth dimension. One noise family that does both is worth more than
// keeping the cube's simplex.
//
// Pure ES module, no three.js, no DOM: `WorldGen.test.mjs` runs it under node.

import { W, F } from './Grid.js';

/**
 * Arc a column covered on the cube, in the units its noise frequencies were
 * tuned in.
 *
 * Every frequency in WorldGen was written against a UNIT DIRECTION on the
 * sphere, where a face axis spanned pi/2 over F columns. Keeping this factor
 * means `continent` at 1.25 is the same size landmass it was, and not a number
 * that has to be re-guessed. W * UNIT is exactly 3*pi/2.
 */
export const UNIT = (Math.PI / 2) / F;

/**
 * Gain on the raw gradient noise, so its spread matches the simplex it replaces.
 *
 * Every threshold in WorldGen — an ore vein at 0.55, the stratum pockets at
 * 0.52, the cinderlands sunstone at 0.84 — was tuned against `Noise.simplex3`'s
 * distribution, and a noise with a narrower spread would silently empty the
 * tails: the ore would simply stop generating. This repo's simplex is unusually
 * fat, measured over 600 000 samples at sd 0.4262 against this lattice's 0.2699,
 * and 1.58 is that ratio.
 *
 * It is checked against percentiles and not against the sd alone, because what
 * a threshold actually asks is "how much of the world clears this". The two
 * agree closely from the median out to the 99th percentile and part company
 * only past it, where simplex saturates against its own ceiling and a gradient
 * lattice does not. See the calibration block in `WorldGen.test.mjs`.
 */
export const GAIN = 1.58;

/**
 * The largest value the gained noise can return, for the ore pass's early-out
 * bound. Gradient noise on a unit cell cannot exceed sqrt(3)/2 in 3D.
 */
export const MAXA = (Math.sqrt(3) / 2) * GAIN;

const G3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Positive modulo. Lattice indices go negative near the origin. */
const pmod = (a, n) => ((a % n) + n) % n;

/**
 * The lattice period, in cells, for a field sampled at `sc` noise units per
 * column.
 *
 * The period has to be a whole number of lattice cells or the wrap lands
 * mid-cell and the field does not close. So the requested frequency is rounded
 * to the nearest one that does close, and the sample scale is then derived back
 * from that period rather than from the request — `a = P / W` — which is what
 * makes the periodicity exact instead of approximate. The frequency moves by at
 * most half a cell in P, which at the coarsest field in the generator (P = 6) is
 * 8% and at every other one is far less.
 */
export const periodFor = (sc) => Math.max(1, Math.round(W * sc));

export class Periodic {
  constructor(seed = 1337) {
    // A 512-entry permutation, as the simplex it replaces had. The lattice
    // periods are all far under 256, so `perm` never has to be larger than the
    // largest period for the wrap to be exact — it is indexed by an already
    // reduced coordinate.
    let s = (seed | 0) || 0x9e3779b9;
    const rnd = () => {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return (s >>> 0) / 4294967296;
    };
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.pm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.pm12[i] = this.perm[i] % 12;
    }
  }

  /**
   * Gradient noise at (x, y, z) with the lattice wrapping every (px, py, pz).
   *
   * `pz` is a period too, but the z axis of this world does not wrap — it is
   * depth — so callers pass something comfortably larger than the range they
   * use and it never bites.
   */
  grad3(x, y, z, px, py, pz) {
    const { perm, pm12 } = this;
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const x0 = pmod(X, px), x1 = pmod(X + 1, px);
    const y0 = pmod(Y, py), y1 = pmod(Y + 1, py);
    const z0 = pmod(Z, pz), z1 = pmod(Z + 1, pz);

    const g = (xi, yi, zi, dx, dy, dz) => {
      const h = pm12[(xi & 255) + perm[(yi & 255) + perm[zi & 255]]] * 3;
      return G3[h] * dx + G3[h + 1] * dy + G3[h + 2] * dz;
    };

    const n000 = g(x0, y0, z0, fx, fy, fz);
    const n100 = g(x1, y0, z0, fx - 1, fy, fz);
    const n010 = g(x0, y1, z0, fx, fy - 1, fz);
    const n110 = g(x1, y1, z0, fx - 1, fy - 1, fz);
    const n001 = g(x0, y0, z1, fx, fy, fz - 1);
    const n101 = g(x1, y0, z1, fx - 1, fy, fz - 1);
    const n011 = g(x0, y1, z1, fx, fy - 1, fz - 1);
    const n111 = g(x1, y1, z1, fx - 1, fy - 1, fz - 1);

    const a = n000 + u * (n100 - n000);
    const b = n010 + u * (n110 - n010);
    const c = n001 + u * (n101 - n001);
    const d = n011 + u * (n111 - n011);
    const e = a + v * (b - a);
    const f = c + v * (d - c);
    return (e + w * (f - e)) * GAIN;
  }

  /**
   * One octave over the map, at `sc` noise units per column.
   *
   * `zoff` is what the cube's `+ 31.4` offsets were for: a different plane of
   * the same lattice is an independent field, and it costs nothing. Offsets on
   * x or y would work too — a constant translation is still periodic — but a z
   * plane keeps the two map axes reading as the map's own coordinates.
   */
  one(x, y, zoff, sc) {
    const P = periodFor(sc);
    const a = P / W;
    return this.grad3(x * a, y * a, zoff, P, P, 4096);
  }

  /** fbm over the map. Lacunarity is 2 so every octave's period stays whole. */
  fbm(x, y, zoff, sc, octaves = 4, gain = 0.5) {
    const P0 = periodFor(sc);
    const a0 = P0 / W;
    let amp = 1, sum = 0, norm = 0, P = P0, a = a0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.grad3(x * a, y * a, zoff, P, P, 4096);
      norm += amp;
      amp *= gain; P *= 2; a *= 2;
    }
    return sum / norm;
  }

  /** Ridged multifractal, same lattice. Sharp crests for the mountains. */
  ridged(x, y, zoff, sc, octaves = 5, gain = 0.5) {
    const P0 = periodFor(sc);
    const a0 = P0 / W;
    let amp = 1, sum = 0, norm = 0, P = P0, a = a0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.grad3(x * a, y * a, zoff, P, P, 4096));
      sum += amp * n * n;
      norm += amp;
      amp *= gain; P *= 2; a *= 2;
    }
    return sum / norm;
  }

  // --- volumetric ------------------------------------------------------------
  //
  // The fields that want depth as well — the strata, the caves, the ore. These
  // are sampled in BLOCK units rather than in the cube's unit-direction units,
  // because that is what they were: the cube multiplied a direction by the
  // radius first, so `0.13` there meant 0.13 per block and means the same here.
  // x and y wrap, k does not.

  volOne(x, y, k, sc, koff = 0) {
    const P = periodFor(sc);
    const a = P / W;
    return this.grad3(x * a, y * a, k * sc + koff, P, P, 4096);
  }

  volFbm(x, y, k, sc, octaves = 2, gain = 0.5, koff = 0) {
    const P0 = periodFor(sc);
    let amp = 1, sum = 0, norm = 0, P = P0, a = P0 / W, z = sc;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.grad3(x * a, y * a, k * z + koff, P, P, 4096);
      norm += amp;
      amp *= gain; P *= 2; a *= 2; z *= 2;
    }
    return sum / norm;
  }
}

/**
 * Surface frequencies were quoted against a unit direction; this turns one into
 * noise units per column. Written once so no call site has to remember it.
 */
export const surfScale = (s) => s * UNIT;
