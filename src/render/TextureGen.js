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
  // Two rails and four rungs, cut out of the plank base. Everything between
  // them is transparent, so you can see the shaft wall through it and a ladder
  // in a dark mine still reads as a ladder rather than a plank.
  //
  // The proportions were the whole of "the ladder is made poorly". The rails
  // were 0.26 of the tile wide each — over half the block was solid timber —
  // and the rungs were 0.02 tall in the 0.48 left between them, so at arm's
  // length it read as a plank with a zip down the middle. A real ladder is
  // mostly the hole: rails a tenth of the width, rungs thick enough to be the
  // thing you look at, and four to a block rather than seven, because seven
  // rungs to a 1.8-cell body is a grating, not something you climb.
  //
  // The rungs are stepped in from the rails on purpose (0.13 against 0.10):
  // set flush they merge into one silhouette and the ladder loses its ribs.
  clearAlpha(s);
  const RAIL_C = 0.10;          // rail centre in from each edge
  const RAIL_W = 0.055;         // half-width of a rail
  const RUNGS = 4;
  s.each((i, x, y, u, v) => {
    const rail = Math.max(
      smoothstep(RAIL_W + 0.02, RAIL_W, Math.abs(u - RAIL_C)),
      smoothstep(RAIL_W + 0.02, RAIL_W, Math.abs(u - (1 - RAIL_C))),
    );
    // One rung per 1/RUNGS of the tile, centred in its band so a stack of
    // ladder blocks keeps the spacing even across the join.
    // 0.13 is how far the rung is inset from the EDGE of the tile, so as a
    // half-width about the centre it is 0.5 - 0.13. Written as 0.13 it made a
    // rung spanning u 0.37 to 0.63 against rails whose inner edges are at
    // 0.155 and 0.845 — a fifth of the tile of clear air at each end, so the
    // rungs joined nothing and hung in the middle of the hole. Ending at 0.13
    // puts the tip just inside the rail's inner edge: they meet, and the rail
    // still reads as one unbroken length of timber over the joint.
    const rung = smoothstep(0.10, 0.075, Math.abs(((v * RUNGS) % 1) - 0.5))
      * smoothstep(0.5 - 0.11, 0.5 - 0.13, Math.abs(u - 0.5));
    const m = Math.max(rail, rung);
    if (m <= 0.004) return;
    // Rungs a shade lighter than the rails, so the ribs read even head-on where
    // there is no grazing light to pick out the relief.
    const grain = (x * 5 + y * 3) % 13 / 13;
    const base = rung > rail
      ? mixc(px([146, 104, 58]), px([178, 132, 78]), grain)
      : mixc(px([112, 76, 40]), px([142, 100, 56]), grain);
    setRGB(s, i, base);
    s.a[i] = m;
    s.h[i] = rung > rail ? 1.0 : 0.82;
    s.ao[i] = rung > rail ? 0.95 : 0.8;
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
// (13.4) because it landed on the rock's own value.
//
// The answer that pass reached — take iron all the way down to rust — bought its
// contrast with the wrong currency. At [92,62,42]/[146,108,78] the flecks
// measured 121,95,76 on the baked sheet: a dark chocolate brown, the same value
// and nearly the same hue as wet soil, so the ore read as dirt caught in the
// rock rather than as metal, and it sat one small hue step from copper on the
// same wall. Contrast against the rock is necessary and it is not sufficient —
// an ore also has to look like the thing it is.
//
// Iron is therefore a warm pale metal with a dark core, and takes its legibility
// from the SPREAD between the two ends rather than from where the pair of them
// sits: the light end is well above stone's 136 and the dark end well below it,
// so each fleck carries its own contrast and does not depend on landing on a
// lighter or darker patch of wall. Hue stays warm-neutral, which is what keeps
// it apart from silver's cool white on one side and copper's orange on the
// other.
//
// The spread has to be this wide. A first attempt at the pale metal used
// [106,84,70]/[216,192,166] and measured a mean fleck of 154,135,120 against
// stone's 141,135,134 — a fifteen-count difference in red and none anywhere
// else, which is the old beige failure again with a different set of numbers.
// The blob's shading comes from one smooth noise field, so widening the ends
// does not sprinkle the tile with noise; it gives every nugget a shadow side and
// a lit side, which is what a lump of metal in rock looks like and what no
// single mid-tone can imitate.
G.iron_ore = (s) => ore(s, [px([104, 66, 40]), px([210, 160, 112])], 0.45, 511, 0.5);
// Gold and sulfur were the same tile at a glance. Both are yellow minerals in
// pale grey rock and their flecks measured 201,171,104 and 185,171,87 — sixteen
// counts apart in red and nothing else, which is not a difference you can see
// across a shaft. Sulfur is the one that is right, so gold is the one that
// moves: widening its red-minus-green gap from 30 to 56 turns it amber against
// sulfur's lemon, and the two now read as different metals rather than as one
// ore lit twice.
G.gold_ore = (s) => ore(s, [px([206, 146, 24]), px([255, 208, 86])], 0.8, 521, 0.32);
G.crystal_ore = (s) => ore(s, [px([94, 178, 226]), px([190, 240, 255])], 0.1, 531, 0.14);

// The rest of the seam. Each entry is [dark, light, metalness, seed, roughness]
// — a gem is smooth and non-metallic, a metal is rough and metallic, and the
// seed only has to differ so two ores in the same shaft don't share a blob
// pattern. `deep_*` variants reuse their mineral's colour on purpose: the block
// they are a variant of is the *rock*, not the ore, and the baker drops them on
// slate instead of stone.
const ORE_MINERALS = {
  // Copper has now been reported three times and each pass moved it by less
  // than the report was asking for, so the history is worth keeping short: it
  // was too pale, then it was darkened until the flecks read as holes ("it has
  // blacks on them, only little part is orange"), then both ends were lifted a
  // little and it came back as "the copper is not total orange". Coverage was
  // never the problem — every ore is the same blob field with a different seed
  // and all of them mask about 12% of the tile — and neither is contrast, which
  // the darkening pass already bought.
  //
  // What was left is CHROMA. Measured on the baked flecks the last version came
  // out 181,120,74: red twice the blue, which sounds orange written down and is
  // terracotta to look at, because the green sits two thirds of the way to the
  // red and the blue never drops far enough to get out of the way. An orange the
  // eye calls orange is a narrow thing — red near the top of the range, green a
  // little under half of it, blue almost gone — and the way to get there is not
  // to brighten the mineral, it is to pull the green down and the blue out.
  //
  // These two are that colour, and they are deliberately the most saturated
  // entry in the table: copper is the one ore on the sheet whose whole identity
  // is its hue, and the sulfur beside it shows what a mineral looks like when it
  // is allowed to be a colour rather than a tinted rock. Both ends stay above
  // stone's luminance of 136 so the flecks still separate at distance, which is
  // what the darkening pass was protecting and is the thing not to give back.
  copper_ore: [[204, 92, 16], [255, 156, 48], 0.55, 541, 0.48],
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
  // Deep copper used to carry a lighter palette of its own, because the shallow
  // ore was at the time darker than the slate it would have sat in and the vein
  // would have vanished the way deep coal's did. That reason is gone now the
  // shallow mineral is a bright orange, and a copper vein that changes colour
  // with depth is a copper vein you have to learn twice, so the two share one
  // palette again.
  deep_copper_ore: [[204, 92, 16], [255, 156, 48], 0.55, 631, 0.48],
  deep_iron_ore: [[104, 66, 40], [210, 160, 112], 0.45, 641, 0.5],
  deep_silver_ore: [[136, 142, 152], [222, 228, 238], 0.7, 651, 0.3],
  deep_gold_ore: [[206, 146, 24], [255, 208, 86], 0.8, 661, 0.32],
  deep_crystal_ore: [[94, 178, 226], [190, 240, 255], 0.1, 671, 0.14],
};
for (const [name, [lo, hi, metal, seed, rough]] of Object.entries(ORE_MINERALS)) {
  G[name] = (s) => ore(s, [px(lo), px(hi)], metal, seed, rough);
}

/**
 * Moss growing over a masonry base — written as a DECAL, so the rock it grows
 * on is literally the parent block's own tile (see DECALS in bake-textures.mjs).
 *
 * Both mossy blocks used to be baked from mossy source materials in the pack:
 * moss_stone from Wall_with_plants/1 and mossy_stone_brick from Stone Wall/5.
 * That is the wrong shape for these two, and it failed twice over.
 *
 * They came out at 73,76,67 and 75,72,68 — half the luminance of the blocks
 * they are a variant OF (cobblestone 131,124,114, stone_brick 153,134,128) and
 * within three counts of each other on every channel, so a mossy cobble and a
 * mossy brick were the same near-black square. The pack has no lit mossy
 * masonry, and exposure alone could not fix it: both sources are ALSO rubble
 * walls, so no amount of brightening was going to make one of them read as cut
 * brick. Stone Wall/5 in particular is a rubble wall despite living in the
 * brick folder — that is the whole reason the two tiles shared a look.
 *
 * As a decal the rock is free and correct by construction: mossy cobble is
 * cobblestone with moss on it, mossy brick is stone_brick with moss on it, and
 * they can never drift from their parents again. What separates them is then
 * exactly what separates them in life — the masonry underneath, plus how much
 * moss it holds. Rubble traps water in its gaps and carries broad sheets of it;
 * a cut face sheds, so brick keeps small scattered colonies and most of the
 * stone still shows.
 *
 * The threshold is a quantile of the patch field rather than a fixed value, for
 * the same reason `leaves_pine` uses one: coverage then survives the 128px
 * runtime tile and the 256px baked tile being different rasterisations of the
 * same noise.
 */
function moss(s, { seed, coverage, cells, dark, lite }) {
  clearAlpha(s);
  const patch = fbm(s.size, cells, 4, seed);
  const fuzz = fbm(s.size, 34, 3, seed + 7);
  const sorted = Float32Array.from(patch).sort();
  const cut = sorted[Math.floor(sorted.length * (1 - coverage))];
  const span = Math.max(1e-4, sorted[sorted.length - 1] - cut);
  s.each((i) => {
    // Feathered over the top fifth of the patch's own range. A hard cut gives
    // moss a coastline — a smooth closed curve with stone on one side of it,
    // which reads as spilled paint; real moss fades out into the stone at its
    // margins and that fade is most of what makes it read as growth.
    const m = smoothstep(0, 0.22, (patch[i] - cut) / span);
    if (m <= 0.004) return;
    setRGB(s, i, mixc(px(dark), px(lite), fuzz[i] * 0.72 + m * 0.28));
    s.a[i] = m;
    s.h[i] = 0.58 + fuzz[i] * 0.34;     // moss stands proud of the stone
    s.ao[i] = 0.88 - m * 0.12;
    s.rough[i] = 0.97;                  // nothing about moss is shiny
  });
  s.normalStrength = 1.1;
  return s;
}
// Broad wet sheets in the gaps of the rubble. The green is the saturated one of
// the pair: this is the block that has to read as MOSSY at a glance, since its
// parent cobblestone is otherwise the commonest grey in the game.
G.moss_stone = (s) => moss(s, {
  seed: 1901, coverage: 0.62, cells: 5,
  dark: [44, 74, 32], lite: [112, 152, 70],
});
// Small dry colonies on a shedding face, in a paler grey-green — closer to
// lichen than to moss, which is what actually grows on cut stone. `cells` is
// what carries that: at 8 the patches are half the width of the rubble's, so
// the brick courses stay the pattern you read first and the moss is scattered
// over them rather than sheeting across them.
//
// Coverage was 0.30 on the reasoning that a cut face sheds and should keep most
// of its stone. Baked, that landed the tile at 142,132,117 — twenty-one counts
// under stone_brick and with LESS green in it than red, which is not a mossy
// block, it is a slightly dirty one. The base matters: stone_brick is a pale
// warm 153,134,128, so a third of a grey-green over it still averages out warm.
// A mossy variant has to be legible as mossy from across a room, and the way to
// keep it apart from moss_stone is the pale palette and the small patch scale,
// not starving it of coverage.
G.mossy_stone_brick = (s) => moss(s, {
  seed: 1913, coverage: 0.48, cells: 8,
  dark: [58, 80, 42], lite: [122, 146, 84],
});

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

/**
 * One needle: a short tapered stroke that WRAPS at the tile edge, with a lit
 * spine down one side.
 *
 * Wrapping is the whole reason this exists rather than reusing `stem`. A canopy
 * is a repeating field of small marks, so any mark clipped at the border shows
 * up as a seam on every leaf block in the world; `stem` clamps and would leave
 * a bald 2px frame around all four edges of the tile.
 *
 * `depth` is a painter's-order stand-in for occlusion: a needle only writes
 * where it is in front of what is already there, so a spray laid down late
 * sits on top of the ones under it instead of averaging into them, and the
 * height it leaves behind is what the normal map is built from.
 */
function needle(s, x0, y0, x1, y1, w, col, depth, lit) {
  const size = s.size;
  const len = Math.hypot(x1 - x0, y1 - y0) * size;
  const steps = Math.max(2, Math.ceil(len * 1.6));
  // Unit normal of the stroke, so the lit side can be picked by the SIGN of the
  // cross-track offset. A symmetric profile reads as a wire; asymmetric reads as
  // a round needle catching light from one direction.
  const nx = -(y1 - y0) / (Math.hypot(x1 - x0, y1 - y0) || 1e-6);
  const ny = (x1 - x0) / (Math.hypot(x1 - x0, y1 - y0) || 1e-6);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const cx = lerp(x0, x1, t) * size;
    const cy = lerp(y0, y1, t) * size;
    // taper: fattest a third of the way along, drawn to a point at the tip
    const r = w * size * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.35) * Math.PI));
    const ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const x = ((Math.round(cx + dx) % size) + size) % size;
        const y = ((Math.round(cy + dy) % size) + size) % size;
        const i = y * size + x;
        const z = depth + (1 - t) * 0.012;
        if (s.a[i] > 0.5 && s.h[i] >= z) continue;
        // cross-track position, +1 on the lit flank and -1 on the shaded one
        const side = (dx * nx + dy * ny) / (r + 0.001);
        const shade = 0.80 + 0.30 * lit + 0.18 * side - 0.10 * (d2 / (r * r + 0.001));
        setRGB(s, i, [col[0] * shade, col[1] * shade, col[2] * shade]);
        s.a[i] = 1;
        s.h[i] = z;
        s.ao[i] = 0.80 + 0.20 * depth;
        s.rough[i] = 0.90;
      }
    }
  }
}

/**
 * A conifer sprig: a woody rachis with needles fanned off both sides, swept
 * toward the tip and shortening as they go.
 *
 * The sweep angle is what separates a conifer from a bottle brush. Needles at a
 * right angle to the twig read as a pipe cleaner, so they leave the rachis at
 * roughly 50-70 degrees and the fan tightens along the last third.
 */
function sprig(s, cx, cy, ang, len, rng, palette, depth) {
  const [dark, mid, litc, twig] = palette;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  // Thinner than the needles it carries, and unlit. The first version drew the
  // rachis at 0.0055 against the needles' 0.0042 and gave it a lit flank, so
  // the twigs read as a brown web laid OVER the foliage rather than as the
  // thing the foliage hangs off. A conifer sprig is needles with a twig you can
  // just make out, not the reverse.
  needle(s, cx, cy, cx + dx * len, cy + dy * len, 0.0034, twig, depth - 0.02, 0);
  const pairs = 5 + Math.floor(rng() * 4);
  for (let k = 0; k < pairs; k++) {
    const t = 0.10 + 0.86 * (k / (pairs - 1));
    const bx = cx + dx * len * t, by = cy + dy * len * t;
    // needles shorten toward the tip, which is what gives a sprig its taper
    const nl = len * (0.62 - 0.34 * t) * (0.8 + rng() * 0.45);
    for (const sgn of [-1, 1]) {
      const sweep = ang + sgn * (0.85 + rng() * 0.42) * (1 - t * 0.35);
      const lit = rng();
      const c = lit > 0.62 ? mixc(mid, litc, (lit - 0.62) / 0.38) : mixc(dark, mid, lit / 0.62);
      needle(s, bx, by, bx + Math.cos(sweep) * nl, by + Math.sin(sweep) * nl,
        0.0042 + rng() * 0.0016, c, depth + 0.004 * k, lit);
    }
  }
}

// dark / mid / lit needle, and the twig they hang off
const PINE_PALETTE = [
  px([40, 66, 62]), px([66, 100, 88]), px([112, 150, 126]), px([44, 40, 33]),
];

/**
 * Pine canopy — actual needles.
 *
 * This tile used to be baked from the Lynocs pack's Bush_Hedge/2, which is a
 * BROADLEAF shrub: round leaves on brown twigs, near enough the same plant as
 * the oak and birch tiles beside it (atlas means pine 91,124,99 / oak
 * 103,137,77 / birch 124,169,130). Every conifer in the game was therefore
 * wearing broadleaf leaves, and the "trees in snow look green" complaint got
 * chased twice through the biome tint tables before anyone exported the tile
 * and looked at it. No tint can make a shrub read as a conifer, and the pack
 * has no needle texture anywhere in it, so this one is drawn.
 *
 * The colour is deliberately only MODERATELY darker than the broadleaf tiles.
 * The biome foliage colour is a MULTIPLIER on this albedo, and the snow row is
 * [0.52, 0.58, 0.62] before the t===3 needle trim in Mesher.js — pre-darkening
 * the tile to what a conifer "should" be is exactly how a previous attempt
 * turned snow-biome trees black (see the comment on tintOf). What carries the
 * read is the needle SHAPE plus a blue bias, not exposure. Measured off the
 * baked atlas: 80,117,104 against oak's 103,137,77 and birch's 124,169,130.
 * That is luminance 108 against 126 and 157, and blue-minus-red +23 where oak
 * is -27 — no broadleaf tile in the pack has more blue in it than red, so a
 * conifer and a broadleaf can never be confused even before a tint is applied.
 */
G.leaves_pine = (s) => {
  const size = s.size;
  // Deep interior first. A canopy face is mostly self-shadow with needles
  // catching light on top of it; starting from the needle colour instead gives
  // a flat green card.
  const back = fbm(size, 6, 4, 1811);
  const gaps = fbm(size, 4, 3, 1823);
  s.h.fill(0.18); s.ao.fill(0.74); s.rough.fill(0.95); s.normalStrength = 1.1;
  s.a.fill(1);
  s.each((i) => setRGB(s, i, mixc(px([26, 42, 41]), px([44, 64, 58]), back[i])));

  const rng = makeRng(1831);
  // 150 sprigs. Layering matters more than count: one pass reads as scattered
  // marks, overlapping passes at increasing depth read as a canopy.
  for (let k = 0; k < 150; k++) {
    const depth = 0.30 + (k / 150) * 0.55;
    sprig(s, rng(), rng(), rng() * Math.PI * 2,
      0.16 + rng() * 0.12, rng, PINE_PALETTE, depth);
  }

  // Large-scale light. Without it 150 sprigs at similar exposure average out to
  // an even fuzz; a real canopy has lit crowns and shadowed hollows a few
  // needle-lengths across, and that is most of what makes it read as painted.
  // The gain lands the opaque mean at 80,117,104 — see the note above on why
  // this is not darker still.
  const light = fbm(size, 3, 3, 1847);
  s.each((i) => {
    const m = 1.42 * (0.74 + 0.52 * light[i]);
    s.r[i] *= m; s.g[i] *= m; s.b[i] *= m;
    s.ao[i] *= 0.86 + 0.14 * light[i];
  });

  // Holes LAST, and only through the BACKGROUND. Punching before the sprigs are
  // laid down just gets filled back in (measured 98.4% coverage that way);
  // punching through the sprigs as well cuts smooth bites out of the needles
  // and the silhouette reads as a moth-eaten card. Needles that cross a gap
  // survive it, which is what leaves a ragged conifer edge.
  //
  // The threshold is a quantile of the field rather than a fixed value, so
  // coverage is the same whatever the fbm happens to be scaled to — that is
  // what keeps the 128px runtime tile and the 256px baked tile in agreement.
  //
  // It is tuned to leave 97.1% coverage against the 96.2% the old baked tile
  // measured, and the field is deliberately LOW frequency. An earlier pass
  // opened the canopy to 85% on the reasoning that a conifer wants a ragged
  // silhouette; the render showed why the old number was the right one. At 85%
  // you see the TRUNK through the canopy, and log_pine is untinted orange bark,
  // so every conifer came out flecked with orange. A high-frequency field is
  // just as bad at any coverage — it sprinkles pinholes evenly over the whole
  // face instead of opening two or three gaps, and every pinhole is another
  // speck of trunk.
  const sorted = Float32Array.from(gaps).sort();
  const cut = sorted[Math.floor(sorted.length * 0.20)];
  s.each((i) => { if (gaps[i] < cut && s.h[i] < 0.28) { s.a[i] = 0; s.h[i] = 0.08; } });
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
 * The look this is chasing is *stone splitting*, and there are three things it
 * gets wrong the moment you stop thinking about it. All three were in the
 * previous version and together they made it read, in the words of the report,
 * like a brush in MS Paint.
 *
 * **Cracks are not brush strokes.** The old path wandered by a small random
 * angle every single step, which is the recipe for a smooth curve — a stroke.
 * A real fracture runs dead straight until something deflects it and then kinks
 * hard, so this holds a heading for a few steps at a time and turns it sharply
 * when it does turn. The path is the same cost and reads as a completely
 * different material.
 *
 * **A crack is a hole, and a hole has a lit edge.** This is the big one. The
 * overlay mixes its own RGB into the block, so it can write light as easily as
 * dark: every fracture now lays a pale rim on one consistent side and a dark
 * core down the middle. That single asymmetry is what makes the eye read depth
 * instead of ink — with a symmetric dark line there is nothing to say the
 * surface is broken rather than drawn on.
 *
 * **Edges are crisp.** The old falloff faded over most of a pixel on a line
 * barely two wide, so every crack was mostly antialiasing. The core is solid
 * now and the fade is a third of a pixel.
 *
 * The last thing is spall: past the halfway point, chips of the surface break
 * away near the impact, which is what sells the final stages. Without them the
 * late frames are just the early frames with thicker lines.
 */
export function generateCrackAtlas(stages = 10, size = 64) {
  const data = new Uint8Array(size * size * 4 * stages);
  const rng = makeRng(9001);

  // Dark of the fracture, and the pale of the freshly exposed edge beside it.
  // The rim is deliberately not white: a bright outline on dark stone reads as
  // a cartoon stroke, which is the failure this whole rewrite is about.
  const CORE = [11, 10, 13];
  const RIM = [196, 190, 178];
  /** Which way the rim falls, so every crack is lit from the same direction. */
  const LIGHT = [-0.55, -0.84];

  // --- build the fracture network -------------------------------------------
  // A fracture is a chain of points plus the progress at which it starts to
  // open; branches inherit their parent's timing so the network spreads
  // outward rather than appearing all at once.
  const cracks = [];
  const ox = 0.5 + (rng() - 0.5) * 0.1, oy = 0.5 + (rng() - 0.5) * 0.1;

  /**
   * @param {number} bias how hard the fracture is steered back toward `outA`.
   *   Zero lets it wander, and wandering is what turned the first attempt into
   *   a root system growing out of the middle of the block with all four
   *   corners untouched. A fracture in a slab runs *away* from the blow, so the
   *   heading is pulled back after every kink: the kinks give it its angular
   *   character, the bias gives it somewhere to be going.
   * @param {number} outA the direction to be pulled back toward. It is the
   *   fracture's own launch angle and NOT the live bearing from the impact —
   *   that was the first version of this and it made the whole network lean to
   *   one side, because at the origin the bearing is atan2(0, 0), so every arm
   *   was yanked toward the same heading on its very first kink.
   */
  const grow = (x, y, a, len, step, wide, start, depth, bias, outA) => {
    const pts = [[x, y]];
    let hold = 0;
    for (let i = 0; i < len; i++) {
      // Run straight, then kink. `hold` is how many steps this heading has left.
      if (hold <= 0) {
        a += (rng() < 0.5 ? -1 : 1) * (0.26 + rng() * 0.42);
        hold = 2 + Math.floor(rng() * 3);
        if (bias > 0) {
          a += (((outA - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * bias;
        }
      }
      hold--;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
      if (x < -0.06 || x > 1.06 || y < -0.06 || y > 1.06) break;
      pts.push([x, y]);
      // throw a finer branch off the side
      if (depth < 2 && i > 1 && rng() < 0.22) {
        const ba = a + (rng() < 0.5 ? 1 : -1) * (0.6 + rng() * 0.7);
        grow(x, y, ba, Math.max(3, (len - i) * 0.6), step * 0.82, wide * 0.58,
          start + (i / len) * (1 - start) * 0.6, depth + 1, bias * 0.4, ba);
      }
    }
    if (pts.length > 1) cracks.push({ pts, start, wide });
  };

  // Main fractures radiate from a slightly off-centre impact, and are long
  // enough to reach the edges: a break that stops short of the block's own
  // boundary reads as a decal sitting on the face rather than the face itself
  // coming apart.
  const arms = 7;
  for (let k = 0; k < arms; k++) {
    const a = (k / arms) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    grow(ox, oy, a, 26 + rng() * 10, 0.055, 1.5, rng() * 0.16, 0, 0.5, a);
  }
  // Chords: fractures that run *between* the arms rather than out from the
  // centre, and start off-origin. Without them the middle distance is a fan of
  // near-parallel lines with nothing crossing it, which is the other half of
  // why the first attempt read as drawn rather than shattered.
  for (let k = 0; k < 5; k++) {
    const a = rng() * Math.PI * 2;
    const r = 0.16 + rng() * 0.22;
    const ca = a + Math.PI * 0.5 + (rng() - 0.5) * 0.8;
    grow(ox + Math.cos(a) * r, oy + Math.sin(a) * r, ca,
      14 + rng() * 10, 0.05, 1.0, 0.32 + rng() * 0.30, 1, 0.12, ca);
  }
  // a couple of late fractures so the last stages still change
  for (let k = 0; k < 3; k++) {
    const a = rng() * Math.PI * 2;
    grow(ox, oy, a, 18 + rng() * 8, 0.05, 1.1, 0.5 + rng() * 0.22, 1, 0.45, a);
  }

  // Chips that break clean out of the surface near the impact, each an angular
  // little polygon rather than a disc — a round hole in stone looks drilled.
  const chips = [];
  for (let k = 0; k < 7; k++) {
    const a = rng() * Math.PI * 2;
    const r = 0.03 + rng() * 0.20;
    const cx = ox + Math.cos(a) * r, cy = oy + Math.sin(a) * r;
    const n = 5 + Math.floor(rng() * 3);
    const rad = 0.028 + rng() * 0.030;
    const poly = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2 + rng() * 0.35;
      const rr = rad * (0.62 + rng() * 0.55);
      poly.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
    }
    chips.push({ poly, start: 0.5 + rng() * 0.38 });
  }

  // --- rasterise -------------------------------------------------------------
  // Core and rim accumulate into their own coverage buffers and are composited
  // once at the end. Painting them straight into the pixels in path order does
  // not work: a later crack's rim would wipe out an earlier crack's core where
  // the two touch, and the network crosses itself constantly.
  const coreA = new Float32Array(size * size);
  const rimA = new Float32Array(size * size);

  /** Anti-aliased segment with a width that tapers from w0 to w1. */
  const seg = (x0, y0, x1, y1, w0, w1) => {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const wMax = Math.max(w0, w1) + 2.2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - wMax));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + wMax));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - wMax));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + wMax));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let t = len2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t, py = y0 + dy * t;
        const ex = x - px, ey = y - py;
        const d = Math.hypot(ex, ey);
        const w = w0 + (w1 - w0) * t;
        const i = y * size + x;
        // Solid to the half-width, gone a third of a pixel later.
        const c = clamp((w - d) / 0.34 + 0.5, 0, 1);
        if (c > coreA[i]) coreA[i] = c;
        // The rim sits outside the core, and only on the lit side.
        //
        // It has to start *clear* of the core, not adjacent to it. The first
        // version began the band at the half-width, which is inside the core's
        // own antialiased falloff, so almost every rim texel also carried
        // partial core and the composite averaged the two into a mid grey — the
        // pale edge was in the data and invisible on screen. The gap below is
        // wider than the core's fade for exactly that reason.
        const side = (ex * LIGHT[0] + ey * LIGHT[1]) / Math.max(d, 1e-4);
        if (side > 0) {
          const band = clamp((d - w - 0.30) / 0.45, 0, 1) * clamp((w + 1.7 - d) / 0.8, 0, 1);
          const r = band * side * clamp(w * 0.9, 0.35, 1);
          if (r > rimA[i]) rimA[i] = r;
        }
      }
    }
  };

  /** Convex-ish chip: dark inside, pale along its lit edge. */
  const chip = (poly, open) => {
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const x0 = Math.max(0, Math.floor(minX * size) - 2);
    const x1 = Math.min(size - 1, Math.ceil(maxX * size) + 2);
    const y0 = Math.max(0, Math.floor(minY * size) - 2);
    const y1 = Math.min(size - 1, Math.ceil(maxY * size) + 2);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size;
        // Grow the chip out from its centre as the break progresses, so it
        // opens rather than popping in at full size.
        const pu = cx + (u - cx) / open, pv = cy + (v - cy) / open;
        let inside = false;
        for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
          const [ax, ay] = poly[a], [bx, by] = poly[b];
          if ((ay > pv) !== (by > pv)
            && pu < ((bx - ax) * (pv - ay)) / (by - ay) + ax) inside = !inside;
        }
        const i = y * size + x;
        if (inside) { if (coreA[i] < 0.94) coreA[i] = 0.94; continue; }
        // A hair of pale on the lit side of the hole's edge.
        const dx = u - cx, dy = v - cy;
        const dd = Math.hypot(dx, dy);
        const side = dd > 1e-5 ? -(dx * LIGHT[0] + dy * LIGHT[1]) / dd : 0;
        if (side > 0.25) {
          const near = clamp(1 - (dd * size) / (0.055 * size + 2.2), 0, 1);
          const r = near * side * 0.85;
          if (r > rimA[i]) rimA[i] = r;
        }
      }
    }
  };

  for (let st = 0; st < stages; st++) {
    const prog = (st + 1) / stages;
    coreA.fill(0); rimA.fill(0);
    for (const cr of cracks) {
      if (prog < cr.start) continue;
      const reach = clamp((prog - cr.start) / (1 - cr.start), 0, 1);
      const n = Math.max(2, Math.ceil(cr.pts.length * reach));
      for (let i = 1; i < n && i < cr.pts.length; i++) {
        const [ax, ay] = cr.pts[i - 1];
        const [bx, by] = cr.pts[i];
        // widen as the break progresses, taper toward the tip
        const t0 = (i - 1) / cr.pts.length, t1 = i / cr.pts.length;
        const open = 0.38 + prog * 0.70;
        seg(ax * size, ay * size, bx * size, by * size,
          cr.wide * (1 - t0 * 0.75) * open,
          cr.wide * (1 - t1 * 0.75) * open);
      }
    }
    for (const ch of chips) {
      if (prog < ch.start) continue;
      chip(ch.poly, 0.35 + 0.65 * clamp((prog - ch.start) / (1 - ch.start), 0, 1));
    }

    // composite
    const off = st * size * size;
    for (let i = 0; i < size * size; i++) {
      const c = coreA[i];
      const r = rimA[i] * (1 - c);          // rim never lightens the fracture itself
      const a = c + r;
      if (a <= 0.004) continue;
      const t = c / a;
      const o = (off + i) * 4;
      data[o] = Math.round(RIM[0] + (CORE[0] - RIM[0]) * t);
      data[o + 1] = Math.round(RIM[1] + (CORE[1] - RIM[1]) * t);
      data[o + 2] = Math.round(RIM[2] + (CORE[2] - RIM[2]) * t);
      data[o + 3] = Math.round(Math.min(1, a) * 238);
    }
  }
  return { data, size, layers: stages };
}
