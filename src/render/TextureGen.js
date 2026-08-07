// Procedural PBR tile generator.
// Every block tile is synthesised at load time into three texture arrays:
//   ALBEDO (sRGB + alpha), NORMAL (tangent space), ARM (ao / roughness / metal).
// Pure module — no DOM, no three — so it can run inside a worker.

import { tileableFbm, tileableWorley, makeRng, clamp, lerp, smoothstep } from '../util/Noise.js';
import { TILES } from '../world/Blocks.js';

export const TILE_SIZE = 128;

// --- tiny float-canvas -----------------------------------------------------

class Surf {
  constructor(size) {
    const n = size * size;
    this.size = size;
    this.n = n;
    this.r = new Float32Array(n);
    this.g = new Float32Array(n);
    this.b = new Float32Array(n);
    this.a = new Float32Array(n).fill(1);
    this.h = new Float32Array(n);      // height, 0..1
    this.rough = new Float32Array(n).fill(0.85);
    this.metal = new Float32Array(n);
    this.ao = new Float32Array(n).fill(1);
    this.normalStrength = 1.4;
  }
  fill(col) {
    const [r, g, b] = col;
    this.r.fill(r / 255); this.g.fill(g / 255); this.b.fill(b / 255);
    return this;
  }
  /** per-pixel callback (i, x, y, u, v) */
  each(fn) {
    const s = this.size;
    for (let y = 0, i = 0; y < s; y++) {
      for (let x = 0; x < s; x++, i++) fn(i, x, y, x / s, y / s);
    }
    return this;
  }
}

const px = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function setRGB(s, i, c) { s.r[i] = c[0]; s.g[i] = c[1]; s.b[i] = c[2]; }

// --- shared field helpers --------------------------------------------------

const FIELD_CACHE = new Map();
function fbm(size, cells, oct, seed, gain = 0.5) {
  const key = `f${size}|${cells}|${oct}|${seed}|${gain}`;
  let v = FIELD_CACHE.get(key);
  if (!v) { v = tileableFbm(size, size, cells, oct, seed, gain); FIELD_CACHE.set(key, v); }
  return v;
}
function worley(size, cells, seed, mode) {
  const key = `w${size}|${cells}|${seed}|${mode}`;
  let v = FIELD_CACHE.get(key);
  if (!v) { v = tileableWorley(size, size, cells, seed, mode); FIELD_CACHE.set(key, v); }
  return v;
}

// --- generators ------------------------------------------------------------
// Each returns a Surf. Colours are authored in sRGB 0-255.

const G = {};

G.crate = (s) => {
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const border = Math.min(u, 1 - u, v, 1 - v);
    const frame = smoothstep(0.13, 0.085, border);
    const diag = Math.min(Math.abs(u - v), Math.abs(u - (1 - v)));
    const brace = smoothstep(0.055, 0.032, diag) * (1 - frame);
    const m = Math.max(frame, brace);
    if (m <= 0.004) return;
    setRGB(s, i, mixc(px([74, 50, 28]), px([104, 72, 40]), (x * 7 + y * 3) % 17 / 17));
    s.a[i] = m;
    s.h[i] = 0.95;
    s.ao[i] = 0.92;
    s.rough[i] = 0.84;
  });
  s.normalStrength = 2.0;
  return s;
};
// A bed is drawn as cloth over the plank base rather than as its own material:
// the frame stays timber, which is what makes it read as furniture built from
// the same wood as everything else you have made.
G.bed_top = (s) => {
  clearAlpha(s);
  const weave = fbm(s.size, 30, 3, 1301);
  s.each((i, x, y, u, v) => {
    const border = Math.min(u, 1 - u, v, 1 - v);
    if (border < 0.055) return;                 // leave the frame as bare wood
    const pillow = smoothstep(0.30, 0.24, v);   // one end is the bolster
    const cloth = mixc(px([166, 58, 62]), px([196, 84, 84]), weave[i]);
    setRGB(s, i, pillow > 0.5 ? mixc(px([232, 226, 214]), px([250, 248, 242]), weave[i]) : cloth);
    s.a[i] = 1;
    // The bolster stands proud of the blanket, and a shallow crease runs along
    // its edge so the two read apart even in flat light.
    const crease = smoothstep(0.02, 0.0, Math.abs(v - 0.30));
    s.h[i] = (pillow > 0.5 ? 0.9 : 0.62) - crease * 0.5 + weave[i] * 0.06;
    s.ao[i] = 0.9 - crease * 0.35;
    s.rough[i] = 0.95;
  });
  s.normalStrength = 1.5;
  return s;
};

G.bed_side = (s) => {
  clearAlpha(s);
  const weave = fbm(s.size, 26, 3, 1307);
  s.each((i, x, y, u, v0) => {
    const v = 1 - v0;                            // row 0 is the bottom of a face
    const mattress = smoothstep(0.34, 0.38, v);  // cloth above, frame below
    if (mattress <= 0.004) return;
    setRGB(s, i, mixc(px([150, 50, 54]), px([186, 78, 78]), weave[i]));
    s.a[i] = mattress;
    s.h[i] = 0.7 + weave[i] * 0.1;
    s.ao[i] = 0.86;
    s.rough[i] = 0.95;
  });
  s.normalStrength = 1.3;
  return s;
};

G.ladder = (s) => {
  // Two rails and seven rungs, cut out of the plank base. Everything between
  // them is transparent, so you can see the shaft wall through it and a ladder
  // in a dark mine still reads as a ladder rather than a plank.
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const rail = Math.max(
      smoothstep(0.20, 0.13, Math.abs(u - 0.17)),
      smoothstep(0.20, 0.13, Math.abs(u - 0.83)),
    );
    const rung = smoothstep(0.055, 0.035, Math.abs(((v * 7) % 1) - 0.5) * 0.5)
      * smoothstep(0.90, 0.80, Math.abs(u - 0.5) * 2);
    const m = Math.max(rail, rung);
    if (m <= 0.004) return;
    setRGB(s, i, mixc(px([124, 86, 46]), px([158, 114, 64]), (x * 5 + y * 3) % 13 / 13));
    s.a[i] = m;
    s.h[i] = 0.9;
    s.ao[i] = 0.85;
    s.rough[i] = 0.92;
  });
  s.normalStrength = 1.6;
  return s;
};

// A door leaf: two sunken panels, a rail between them and a ring handle. Drawn
// full-bleed rather than as a cut-out — unlike a ladder you are meant to see a
// solid slab of timber, and the plank base already supplies the grain.
G.door = (s) => {
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const frame = Math.min(u, 1 - u, v, 1 - v);
    const edge = smoothstep(0.10, 0.05, frame);
    // Two recessed panels, split by a rail across the middle.
    const inUpper = v > 0.56 && v < 0.90;
    const inLower = v > 0.10 && v < 0.44;
    const panel = (inUpper || inLower) && u > 0.18 && u < 0.82 ? 1 : 0;
    // The handle sits on the latch side, away from the hinge.
    const hx = u - 0.76, hy = v - 0.5;
    const ring = smoothstep(0.075, 0.055, Math.hypot(hx, hy))
      * smoothstep(0.030, 0.045, Math.hypot(hx, hy));
    const m = Math.max(edge, panel * 0.55, ring);
    if (m <= 0.004) return;
    if (ring > 0.35) {
      setRGB(s, i, px([196, 158, 74]));       // brass
      s.a[i] = ring;
      s.h[i] = 1;
      s.rough[i] = 0.35;
      s.metal[i] = 0.85;
      s.ao[i] = 0.9;
      return;
    }
    setRGB(s, i, px([92, 62, 34]));
    s.a[i] = m;
    // Panels sit *below* the surface, the frame stands proud of it.
    s.h[i] = panel && edge < 0.2 ? 0.12 : 0.92;
    s.ao[i] = panel && edge < 0.2 ? 0.5 : 0.88;
    s.rough[i] = 0.9;
  });
  s.normalStrength = 2.2;
  return s;
};

/** The thin edge of the leaf — plain timber, no panelling. */
G.door_top = (s) => {
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const m = smoothstep(0.10, 0.05, Math.min(v, 1 - v));
    if (m <= 0.004) return;
    setRGB(s, i, px([84, 56, 30]));
    s.a[i] = m;
    s.h[i] = 0.8;
    s.ao[i] = 0.8;
    s.rough[i] = 0.9;
  });
  s.normalStrength = 1.4;
  return s;
};

G.hearth = (s) => {
  // Cooling crust with the fire still in the cracks. The pattern is a couple of
  // octaves of value noise thresholded into plates, so the glow reads as gaps
  // between them rather than as spots painted on.
  const n2 = (x, y) => {
    const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const smooth2 = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(n2(xi, yi), n2(xi + 1, yi), u),
                lerp(n2(xi, yi + 1), n2(xi + 1, yi + 1), u), v);
  };
  s.each((i, x, y, u, v) => {
    // Scale matters more than colour here, and two attempts failed on it: a
    // near-black crust with hairline seams read as mud with holes in it, and
    // widening the seams turned the whole face orange with dark spots — cheese,
    // not rock. Many small plates with thin bright seams between them is what
    // reads as a banked fire at the size a block is actually seen.
    const f = smooth2(u * 11.0, v * 11.0) * 0.6 + smooth2(u * 24.0, v * 24.0) * 0.4;
    const seam = smoothstep(0.30, 0.06, Math.abs(f - 0.5) * 2.0);
    const heat = Math.pow(seam, 1.3);
    // Warm charcoal for the plates, so it is legibly rock even unlit, and a
    // proper ember colour down in the seams.
    const r = 62 + heat * 196, g = 34 + heat * 122, b = 28 + heat * 34;
    setRGB(s, i, px([r, g, b]));
    s.a[i] = 1;
    // The crust stands proud, the fire sits down in the gaps.
    s.h[i] = 0.92 - heat * 0.8;
    s.ao[i] = 1 - heat * 0.3;
    s.rough[i] = 0.9 - heat * 0.35;
  });
  s.normalStrength = 2.0;
  return s;
};

G.torch_stick = (s) => {
  // Charred, resinous wood, uniform across the tile.
  //
  // The old torch tile was a picture of a torch on a transparent field, which
  // is right for two crossed quads and useless for boxes: a shaft box is 0.14
  // of a cell wide, so its faces sample a thin vertical sliver of the tile,
  // and on a picture of a torch that sliver is nearly all empty — every torch
  // in the world alpha-tested itself out of existence. Box geometry wants a
  // *material*, not a portrait.
  s.each((i, x, y, u, v) => {
    const grain = Math.sin(u * 39.0 + Math.sin(v * 4.1) * 0.7) * 0.5 + 0.5;
    const streak = Math.pow(grain, 2.4);
    // Darker toward the top: this end has been in a fire.
    const char = smoothstep(0.55, 1.0, v);
    const r = 96 - streak * 26 - char * 54;
    const g = 66 - streak * 20 - char * 40;
    const b = 38 - streak * 14 - char * 24;
    setRGB(s, i, px([r, g, b]));
    s.a[i] = 1;
    s.h[i] = 0.82 - streak * 0.5;
    s.ao[i] = 0.92 - streak * 0.18;
    s.rough[i] = 0.95;
  });
  s.normalStrength = 1.5;
  return s;
};

G.torch_flame = (s) => {
  // The burning end, seen from above: embers at the centre falling off to ash.
  s.each((i, x, y, u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const heat = Math.pow(Math.max(0, 1 - d), 1.5);
    const flick = 0.85 + Math.sin(u * 30.0 + v * 24.0) * 0.15;
    const r = 60 + heat * 210 * flick;
    const g = 34 + heat * 150 * flick;
    const b = 26 + heat * 44 * flick;
    setRGB(s, i, px([r, g, b]));
    s.a[i] = 1;
    s.h[i] = 0.4 + heat * 0.3;
    s.ao[i] = 1;
    s.rough[i] = 0.75;
  });
  s.normalStrength = 0.8;
  return s;
};

G.fence = (s) => {
  // Split timber: vertical grain and nothing else. A fence is built out of
  // boxes a quarter of a cell across, and the mesher scales the tile to each
  // box, so whatever is here gets cropped to a narrow strip at an offset it
  // cannot predict. Anything with a border or a centred feature would land
  // half-on. Uniform grain crops to more grain wherever it is cut.
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const g = Math.sin(u * 47.1 + Math.sin(v * 3.3) * 0.8) * 0.5 + 0.5;
    const streak = Math.pow(g, 3);
    const m = 0.35 + streak * 0.5;
    setRGB(s, i, px([74 - streak * 18, 52 - streak * 14, 30 - streak * 9]));
    s.a[i] = m;
    // The grain is cut into the timber, so the dark lines sit low.
    s.h[i] = 0.85 - streak * 0.6;
    s.ao[i] = 0.92 - streak * 0.22;
    s.rough[i] = 0.92;
  });
  s.normalStrength = 1.6;
  return s;
};

G.sign = (s) => {
  // A framed board with three ruled lines suggesting writing. Actual letters
  // would be unreadable at this size and wrong for every sign but one, so this
  // says "there are words here" and the hint line says what they are.
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const border = Math.min(u, 1 - u, v, 1 - v);
    const frame = smoothstep(0.09, 0.05, border);
    // Three ruled lines, inset from the frame.
    const inset = u > 0.18 && u < 0.82;
    let rule = 0;
    for (const ly of [0.34, 0.5, 0.66]) {
      rule = Math.max(rule, smoothstep(0.022, 0.012, Math.abs(v - ly)) * (inset ? 1 : 0));
    }
    const m = Math.max(frame, rule * 0.7);
    if (m <= 0.004) return;
    setRGB(s, i, rule > frame ? px([96, 74, 48]) : px([78, 52, 28]));
    s.a[i] = m;
    s.h[i] = rule > frame ? 0.3 : 0.95;
    s.ao[i] = 0.85;
    s.rough[i] = 0.9;
  });
  s.normalStrength = 1.8;
  return s;
};

function ore(s, blobCol, glow, seed, sparkle) {
  // Only the mineral blobs; alpha is the mask and the baker drops them onto the
  // pack's stone so ore blocks match the surrounding rock exactly.
  clearAlpha(s);
  const w = worley(s.size, 8, seed, 'f1');
  const w2 = worley(s.size, 11, seed + 11, 'f1');
  const f = fbm(s.size, 30, 3, seed + 21);
  s.each((i) => {
    const blob = Math.max(smoothstep(0.36, 0.08, w[i]), smoothstep(0.3, 0.06, w2[i]) * 0.8);
    const m = smoothstep(0.3, 0.72, blob + f[i] * 0.22 - 0.1);
    if (m <= 0.004) return;
    const facet = f[i];
    setRGB(s, i, mixc(blobCol[0], blobCol[1], facet));
    s.a[i] = m;
    s.h[i] = 0.35 + facet * 0.65;
    s.rough[i] = sparkle;
    s.metal[i] = glow;
    s.ao[i] = 0.85;
  });
  s.normalStrength = 0.9;
  return s;
}
G.coal_ore = (s) => ore(s, [px([34, 34, 38]), px([70, 70, 76])], 0, 501, 0.72);
// Iron was the only ore whose mineral sat *lighter* than the rock behind it, so
// it was the one that lost out once stone was exposed properly instead of being
// left underexposed — pale flecks on pale rock. Measured against the stone base
// it baked over, the old beige managed an RMS luminance difference of 15.1 with
// the other three ores at 19.5-29.4; a half-way darkening measured *worse*
// (13.4) because it landed on the rock's own value. Going the whole way to rust
// puts iron at 19.3, level with gold.
G.iron_ore = (s) => ore(s, [px([92, 62, 42]), px([146, 108, 78])], 0.45, 511, 0.5);
G.gold_ore = (s) => ore(s, [px([198, 152, 52]), px([252, 214, 116])], 0.8, 521, 0.32);
G.crystal_ore = (s) => ore(s, [px([94, 178, 226]), px([190, 240, 255])], 0.1, 531, 0.14);

// The rest of the seam. Each entry is [dark, light, metalness, seed, roughness]
// — a gem is smooth and non-metallic, a metal is rough and metallic, and the
// seed only has to differ so two ores in the same shaft don't share a blob
// pattern. `deep_*` variants reuse their mineral's colour on purpose: the block
// they are a variant of is the *rock*, not the ore, and the baker drops them on
// slate instead of stone.
const ORE_MINERALS = {
  copper_ore: [[142, 78, 38], [206, 122, 62], 0.55, 541, 0.48],
  silver_ore: [[136, 142, 152], [222, 228, 238], 0.7, 551, 0.3],
  sulfur_ore: [[168, 148, 26], [236, 222, 96], 0.0, 561, 0.62],
  amethyst_ore: [[110, 58, 168], [198, 148, 252], 0.05, 571, 0.16],
  ruby_ore: [[152, 24, 44], [252, 108, 118], 0.05, 581, 0.14],
  sapphire_ore: [[28, 52, 158], [110, 148, 252], 0.05, 591, 0.14],
  emerald_ore: [[22, 122, 58], [120, 240, 150], 0.05, 601, 0.15],
  voidstone_ore: [[62, 26, 110], [162, 108, 244], 0.2, 611, 0.1],
  // Coal on slate, not coal on stone: the shallow mineral is darker than the
  // deep matrix it would sit in, so the vein disappeared. Lifted a stop and a
  // half, which is the only way a black mineral reads against black rock.
  deep_coal_ore: [[58, 58, 66], [124, 124, 136], 0, 621, 0.72],
  deep_copper_ore: [[142, 78, 38], [206, 122, 62], 0.55, 631, 0.48],
  deep_iron_ore: [[92, 62, 42], [146, 108, 78], 0.45, 641, 0.5],
  deep_silver_ore: [[136, 142, 152], [222, 228, 238], 0.7, 651, 0.3],
  deep_gold_ore: [[198, 152, 52], [252, 214, 116], 0.8, 661, 0.32],
  deep_crystal_ore: [[94, 178, 226], [190, 240, 255], 0.1, 671, 0.14],
};
for (const [name, [lo, hi, metal, seed, rough]] of Object.entries(ORE_MINERALS)) {
  G[name] = (s) => ore(s, [px(lo), px(hi)], metal, seed, rough);
}

G.glass = (s) => {
  const f = fbm(s.size, 12, 3, 541);
  s.each((i, x, y, u, v) => {
    const border = Math.min(u, 1 - u, v, 1 - v);
    const frame = smoothstep(0.055, 0.028, border);
    const c = mixc(px([196, 226, 238]), px([232, 246, 252]), f[i]);
    setRGB(s, i, mixc(c, px([176, 200, 210]), frame));
    s.a[i] = lerp(0.16, 0.72, frame);
    s.h[i] = frame * 0.5 + f[i] * 0.1;
    s.rough[i] = 0.05 + frame * 0.2;
    s.ao[i] = 1;
  });
  s.normalStrength = 0.5;
  return s;
};

G.lantern = (s) => {
  const f = fbm(s.size, 20, 3, 591);
  s.each((i, x, y, u, v) => {
    const border = Math.min(u, 1 - u, v, 1 - v);
    const frame = smoothstep(0.16, 0.11, border);
    const bar = smoothstep(0.035, 0.015, Math.abs(u - 0.5)) * (1 - frame);
    const metal = Math.max(frame, bar);
    const glass = mixc(px([255, 226, 150]), px([255, 250, 214]), f[i]);
    const iron = mixc(px([62, 56, 50]), px([104, 96, 86]), f[i]);
    setRGB(s, i, mixc(glass, iron, metal));
    s.h[i] = metal * 0.8 + f[i] * 0.1;
    s.rough[i] = lerp(0.28, 0.6, metal);
    s.metal[i] = metal * 0.85;
    s.ao[i] = 1 - metal * 0.25;
  });
  s.normalStrength = 1.6;
  return s;
};

// --- cross-shaped plants (alpha-cut sprites) -------------------------------

function clearAlpha(s) { s.a.fill(0); s.h.fill(0.5); s.ao.fill(1); s.rough.fill(0.9); s.normalStrength = 0.4; return s; }

function stem(s, x0, y0, x1, y1, w, col, wobble = 0) {
  const size = s.size;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * size * 2);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const wob = Math.sin(t * Math.PI * 2.2) * wobble;
    const cx = (lerp(x0, x1, t) + wob) * size;
    const cy = lerp(y0, y1, t) * size;
    const r = w * size * (1 - t * 0.25);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        if (dx * dx + dy * dy > r * r) continue;
        const i = y * size + x;
        s.a[i] = 1;
        const shade = 0.82 + 0.18 * (1 - Math.abs(dx) / (r + 0.001));
        setRGB(s, i, [col[0] * shade, col[1] * shade, col[2] * shade]);
      }
    }
  }
}

function blob(s, cx, cy, r, col, jitterSeed) {
  const size = s.size;
  const rng = makeRng(jitterSeed);
  const lobes = 5 + Math.floor(rng() * 3);
  const phase = rng() * Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - cx, dy = (y + 0.5) / size - cy;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const rr = r * (0.78 + 0.22 * Math.cos(ang * lobes + phase));
      if (d <= rr) {
        const i = y * size + x;
        s.a[i] = 1;
        const shade = 0.7 + 0.3 * (1 - d / rr);
        setRGB(s, i, [col[0] * shade, col[1] * shade, col[2] * shade]);
        s.h[i] = 0.5 + (1 - d / rr) * 0.5;
      }
    }
  }
}

function flower(s, petal, center, seed) {
  clearAlpha(s);
  const rng = makeRng(seed);
  for (let k = 0; k < 3; k++) {
    const x = 0.28 + k * 0.22 + rng() * 0.05;
    const top = 0.3 + rng() * 0.16;
    stem(s, x, 0.98, x, top + 0.06, 0.016, px([64, 104, 44]), 0.02);
    // leaves
    stem(s, x, 0.72, x + (k % 2 ? 0.1 : -0.1), 0.62, 0.012, px([80, 126, 52]));
    const p = mixc(petal, [1, 1, 1], rng() * 0.2);
    blob(s, x, top, 0.075 + rng() * 0.02, p, seed + k * 17);
    blob(s, x, top, 0.026, center, seed + k * 31);
  }
  return s;
}

G.flower_red = (s) => flower(s, px([204, 46, 58]), px([250, 220, 120]), 701);
G.flower_blue = (s) => flower(s, px([76, 116, 216]), px([240, 240, 250]), 711);
G.flower_gold = (s) => flower(s, px([246, 192, 44]), px([120, 78, 24]), 721);

G.tall_grass = (s) => {
  clearAlpha(s);
  const rng = makeRng(731);
  // many fine blades read as grass; a few fat ones read as seaweed
  for (let k = 0; k < 34; k++) {
    const x = 0.04 + rng() * 0.92;
    const top = 0.30 + rng() * 0.42;
    const bend = (rng() - 0.5) * 0.22;
    const shade = rng();
    const c = mixc(px([62, 104, 38]), px([140, 184, 78]), shade);
    stem(s, x, 1.0, x + bend, top, 0.0045 + rng() * 0.004, c, 0.012);
  }
  return s;
};

G.sapling = (s) => {
  clearAlpha(s);
  stem(s, 0.5, 1.0, 0.5, 0.5, 0.018, px([88, 62, 38]));
  const rng = makeRng(741);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + rng();
    blob(s, 0.5 + Math.cos(a) * 0.16, 0.36 + Math.sin(a) * 0.13, 0.1, mixc(px([54, 100, 36]), px([110, 158, 60]), rng()), 751 + k);
  }
  return s;
};

G.mushroom = (s) => {
  clearAlpha(s);
  const rng = makeRng(761);
  for (let k = 0; k < 3; k++) {
    const x = 0.22 + k * 0.28;
    const top = 0.46 + rng() * 0.2;
    stem(s, x, 0.99, x, top, 0.026, px([224, 214, 198]));
    blob(s, x, top - 0.02, 0.1, mixc(px([146, 96, 196]), px([206, 158, 240]), rng()), 771 + k);
    blob(s, x - 0.03, top - 0.05, 0.022, px([236, 226, 250]), 781 + k);
  }
  return s;
};

function wheat(s, stage, seed) {
  clearAlpha(s);
  const rng = makeRng(seed);
  const h = [0.72, 0.52, 0.34, 0.2][stage];
  const col = [px([104, 150, 66]), px([128, 162, 62]), px([176, 172, 60]), px([214, 178, 62])][stage];
  for (let k = 0; k < 7; k++) {
    const x = 0.1 + k * 0.13 + rng() * 0.03;
    stem(s, x, 1.0, x, h, 0.013, col, 0.01);
    if (stage >= 2) {
      for (let e = 0; e < 4; e++) {
        const y = h + e * 0.055;
        blob(s, x, y, 0.028, mixc(col, px([240, 214, 120]), 0.4 + rng() * 0.3), seed + k * 13 + e);
      }
    }
  }
  return s;
}
G.wheat_0 = (s) => wheat(s, 0, 791);
G.wheat_1 = (s) => wheat(s, 1, 801);
G.wheat_2 = (s) => wheat(s, 2, 811);
G.wheat_3 = (s) => wheat(s, 3, 821);

G.pumpkin_side = (s) => {
  const f = fbm(s.size, 20, 3, 831);
  s.each((i, x, y, u, v) => {
    const rib = Math.abs(Math.sin(u * Math.PI * 4));
    const n = rib * 0.6 + f[i] * 0.4;
    const c = mixc(px([182, 88, 18]), px([244, 148, 38]), n);
    setRGB(s, i, c);
    s.h[i] = n;
    s.rough[i] = 0.62;
    s.ao[i] = 0.55 + rib * 0.45;
  });
  s.normalStrength = 1.9;
  return s;
};
G.pumpkin_top = (s) => {
  const f = fbm(s.size, 16, 3, 841);
  const size = s.size;
  s.each((i, x, y, u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const rib = Math.abs(Math.sin(Math.atan2(v - 0.5, u - 0.5) * 5));
    const stemMask = smoothstep(0.22, 0.12, d);
    let c = mixc(px([176, 84, 18]), px([236, 142, 36]), rib * 0.5 + f[i] * 0.5);
    c = mixc(c, mixc(px([78, 92, 40]), px([124, 138, 62]), f[i]), stemMask);
    setRGB(s, i, c);
    s.h[i] = rib * 0.4 + stemMask * 0.6;
    s.rough[i] = 0.66;
    s.ao[i] = 0.6 + rib * 0.4;
  });
  s.normalStrength = 1.7;
  return s;
};

G.cactus_side = (s) => {
  const f = fbm(s.size, 22, 3, 851);
  s.each((i, x, y, u, v) => {
    const rib = Math.abs(Math.sin(u * Math.PI * 3));
    const n = rib * 0.7 + f[i] * 0.3;
    let c = mixc(px([40, 88, 42]), px([96, 148, 70]), n);
    const spineX = Math.abs(((u * 3) % 1) - 0.5) < 0.06;
    const spineY = ((v * 8) % 1) < 0.12;
    if (spineX && spineY) c = px([232, 228, 190]);
    setRGB(s, i, c);
    s.h[i] = n;
    s.rough[i] = 0.8;
    s.ao[i] = 0.6 + rib * 0.4;
  });
  s.normalStrength = 1.8;
  return s;
};
G.cactus_top = (s) => {
  const f = fbm(s.size, 14, 3, 861);
  s.each((i, x, y, u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const c = mixc(px([56, 106, 50]), px([110, 160, 78]), f[i] * 0.7 + (1 - d) * 0.3);
    setRGB(s, i, c);
    s.h[i] = 1 - d * 0.5;
    s.rough[i] = 0.82;
    s.ao[i] = 0.7 + (1 - d) * 0.3;
  });
  return s;
};

G.bench_top = (s) => {
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const gx = Math.abs(((u * 3) % 1) - 0.5), gy = Math.abs(((v * 3) % 1) - 0.5);
    const groove = smoothstep(0.455, 0.5, Math.max(gx, gy));
    const border = smoothstep(0.06, 0.02, Math.min(u, 1 - u, v, 1 - v));
    const m = Math.max(groove, border);
    if (m <= 0.004) return;
    setRGB(s, i, px([66, 44, 26]));
    s.a[i] = m;
    s.h[i] = 0.04;
    s.ao[i] = 0.42;
    s.rough[i] = 0.9;
  });
  s.normalStrength = 2.0;
  return s;
};

G.bench_side = (s) => {
  clearAlpha(s);
  const f = fbm(s.size, 24, 3, 911);
  s.each((i, x, y, u, v0) => {
    // texture row 0 is the bottom of a side face; the rack belongs up top
    const v = 1 - v0;
    const band = smoothstep(0.18, 0.22, v) * smoothstep(0.44, 0.40, v);
    const peg = band * smoothstep(0.34, 0.42, Math.abs(((u * 4) % 1) - 0.5) * 2 + f[i] * 0.2);
    const rail = Math.min(1, smoothstep(0.015, 0.0, Math.abs(v - 0.2))
      + smoothstep(0.015, 0.0, Math.abs(v - 0.44)));
    const m = Math.max(peg * 0.9, rail);
    if (m <= 0.004) return;
    setRGB(s, i, px([58, 38, 22]));
    s.a[i] = m;
    s.h[i] = 0.85;
    s.ao[i] = 0.6;
    s.rough[i] = 0.88;
  });
  s.normalStrength = 1.8;
  return s;
};
G.kiln_side = (s) => {
  // a flat scorch pass over the base brick
  clearAlpha(s);
  const f = fbm(s.size, 10, 3, 921);
  s.each((i) => {
    setRGB(s, i, px([52, 50, 54]));
    s.a[i] = 0.30 + f[i] * 0.14;
    s.h[i] = 0.5;
    s.ao[i] = 0.9;
    s.rough[i] = 0.95;
  });
  s.normalStrength = 0.0;
  return s;
};
G.kiln_top = (s) => {
  clearAlpha(s);
  s.each((i, x, y, u, v) => {
    const d = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
    const hole = smoothstep(0.62, 0.5, d);
    if (hole <= 0.004) return;
    setRGB(s, i, px([24, 20, 19]));
    s.a[i] = hole;
    s.h[i] = 0.0;
    s.ao[i] = 0.28;
    s.rough[i] = 0.95;
  });
  s.normalStrength = 2.0;
  return s;
};
function kilnFace(s, lit) {
  clearAlpha(s);
  const f = fbm(s.size, 16, 3, 931);
  s.each((i, x, y, u, v0) => {
    const v = 1 - v0;
    const inX = smoothstep(0.2, 0.24, u) * smoothstep(0.8, 0.76, u);
    const inY = smoothstep(0.34, 0.38, v) * smoothstep(0.86, 0.82, v);
    const m = inX * inY;
    if (m <= 0.004) return;
    setRGB(s, i, lit
      ? mixc(px([255, 176, 60]), px([214, 78, 22]), f[i])
      : mixc(px([22, 20, 22]), px([48, 44, 44]), f[i]));
    s.a[i] = m;
    s.h[i] = 0.0;
    s.ao[i] = lit ? 1 : 0.22;
    s.rough[i] = 0.75;
  });
  s.normalStrength = 2.2;
  return s;
}
G.kiln_front = (s) => kilnFace(s, false);
G.kiln_front_lit = (s) => kilnFace(s, true);

G.torch = (s) => {
  clearAlpha(s);
  stem(s, 0.5, 1.0, 0.5, 0.42, 0.05, px([116, 82, 46]));
  blob(s, 0.5, 0.36, 0.085, px([255, 208, 120]), 941);
  blob(s, 0.5, 0.33, 0.055, px([255, 246, 214]), 943);
  s.each((i) => { if (s.a[i] > 0.5 && s.g[i] > 0.6) s.rough[i] = 0.35; });
  return s;
};

// --- assembly --------------------------------------------------------------

function encodeNormal(s, out, off) {
  const size = s.size, h = s.h, k = s.normalStrength;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const tl = h[ym + xm], t = h[ym + x], tr = h[ym + xp];
      const l = h[yc + xm], r = h[yc + xp];
      const bl = h[yp + xm], b = h[yp + x], br = h[yp + xp];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * k, ny = -dy * k, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (off + yc + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
}

/**
 * Build the three texture-array payloads.
 * @param {(p:number, name:string)=>void} onProgress
 */
export function generateTileArrays(onProgress, sizeOverride) {
  const size = sizeOverride || TILE_SIZE;
  const layers = TILES.length;
  const per = size * size * 4;
  const albedo = new Uint8Array(per * layers);
  const normal = new Uint8Array(per * layers);
  const arm = new Uint8Array(per * layers);

  for (let li = 0; li < layers; li++) {
    const name = TILES[li];
    const s = new Surf(size);
    const gen = G[name];
    if (gen) gen(s); else s.fill([255, 0, 255]);

    const off = li * size * size;
    for (let i = 0; i < s.n; i++) {
      const o = (off + i) * 4;
      albedo[o] = clamp(s.r[i], 0, 1) * 255;
      albedo[o + 1] = clamp(s.g[i], 0, 1) * 255;
      albedo[o + 2] = clamp(s.b[i], 0, 1) * 255;
      albedo[o + 3] = clamp(s.a[i], 0, 1) * 255;
      arm[o] = clamp(s.ao[i], 0, 1) * 255;
      arm[o + 1] = clamp(s.rough[i], 0.02, 1) * 255;
      arm[o + 2] = clamp(s.metal[i], 0, 1) * 255;
      arm[o + 3] = 255;
    }
    encodeNormal(s, normal, off);
    if (onProgress) onProgress((li + 1) / layers, name);
  }
  FIELD_CACHE.clear();
  return { albedo, normal, arm, size, layers };
}

// --- utility textures ------------------------------------------------------

/**
 * Block-breaking crack overlay, `stages` frames of progressive fracture.
 *
 * Drawn as tapering line *segments*, not as a blob stamped at every path point
 * — that earlier approach laid down overlapping 2px discs and read as a spray
 * of bullet holes rather than a cracking surface. Each fracture starts wide at
 * its root and thins to a hairline at the tip, and throws off finer branches.
 */
export function generateCrackAtlas(stages = 10, size = 64) {
  const data = new Uint8Array(size * size * 4 * stages);
  const rng = makeRng(9001);

  // --- build the fracture network -------------------------------------------
  // A fracture is a chain of points plus the progress at which it starts to
  // open; branches inherit their parent's timing so the network spreads
  // outward rather than appearing all at once.
  const cracks = [];
  const grow = (x, y, a, len, step, wide, start, depth) => {
    const pts = [[x, y]];
    for (let i = 0; i < len; i++) {
      a += (rng() - 0.5) * 0.55;          // wander, but keep a clear direction
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) break;
      pts.push([x, y]);
      // throw a finer branch off the side
      if (depth < 2 && i > 2 && rng() < 0.16) {
        grow(x, y, a + (rng() < 0.5 ? 1 : -1) * (0.5 + rng() * 0.6),
          Math.max(3, (len - i) * 0.55), step * 0.85, wide * 0.55,
          start + (i / len) * (1 - start) * 0.6, depth + 1);
      }
    }
    if (pts.length > 1) cracks.push({ pts, start, wide });
  };
  // main fractures radiate from a slightly off-centre origin
  const ox = 0.5 + (rng() - 0.5) * 0.1, oy = 0.5 + (rng() - 0.5) * 0.1;
  const arms = 5;
  for (let k = 0; k < arms; k++) {
    const a = (k / arms) * Math.PI * 2 + rng() * 0.7;
    grow(ox, oy, a, 16 + rng() * 8, 0.042, 1.5, rng() * 0.18, 0);
  }
  // a couple of late fractures so the last stages still change
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI * 2;
    grow(ox, oy, a, 12 + rng() * 6, 0.04, 1.1, 0.45 + rng() * 0.25, 1);
  }

  // --- rasterise -------------------------------------------------------------
  /** Anti-aliased segment with a width that tapers from w0 to w1. */
  const seg = (off, x0, y0, x1, y1, w0, w1) => {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const wMax = Math.max(w0, w1);
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - wMax - 1));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + wMax + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - wMax - 1));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + wMax + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let t = len2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t, py = y0 + dy * t;
        const d = Math.hypot(x - px, y - py);
        const w = w0 + (w1 - w0) * t;
        const a = clamp(1 - (d - w * 0.35) / 0.85, 0, 1);
        if (a <= 0) continue;
        const o = (off + y * size + x) * 4;
        const v = Math.max(data[o + 3], a * 232);
        data[o] = 10; data[o + 1] = 10; data[o + 2] = 12; data[o + 3] = v;
      }
    }
  };

  for (let st = 0; st < stages; st++) {
    const prog = (st + 1) / stages;
    const off = st * size * size;
    for (const cr of cracks) {
      if (prog < cr.start) continue;
      const reach = clamp((prog - cr.start) / (1 - cr.start), 0, 1);
      const n = Math.max(2, Math.ceil(cr.pts.length * reach));
      for (let i = 1; i < n && i < cr.pts.length; i++) {
        const [ax, ay] = cr.pts[i - 1];
        const [bx, by] = cr.pts[i];
        // widen as the break progresses, taper toward the tip
        const t0 = (i - 1) / cr.pts.length, t1 = i / cr.pts.length;
        const grow2 = 0.45 + prog * 0.75;
        seg(off, ax * size, ay * size, bx * size, by * size,
          cr.wide * (1 - t0 * 0.75) * grow2,
          cr.wide * (1 - t1 * 0.75) * grow2);
      }
    }
  }
  return { data, size, layers: stages };
}
