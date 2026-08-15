// The block light an *entity* stands in: a flood fill over the small volume
// around the player, on the main thread, in the same units and by the same
// rules as the world worker's `LightField`.
//
// ### Why this exists
//
// Terrain reads a per-vertex `blockLight` attribute baked by `LightField` in
// the world worker. That is a proper flood: it bends around corners, it carries
// fifteen levels, and every quad in the game is lit from it. An animal is not a
// chunk and a dropped pickaxe is not a chunk, so neither has such an attribute,
// and until now they were lit instead by a scan of the emitters within eight
// columns *of the player* — a straight line with a shadow ray on it, centred on
// the wrong body and reaching a little over half as far as the light it was
// approximating.
//
// Measured in a sealed room with one torch at one end of it, at noon, seed
// 4242, headless d3d11. Rendered luma off the frame, cows at six distances
// from the torch and the player seventeen columns down the room from it, which
// is what walking a mine looks like. The floor is read in its own frame with
// the herd hidden, because the animal is standing on the patch being read, and
// both are averaged over four camera azimuths, because an idling cow faces
// where it likes and one shot of it is worth about a third:
//
//   cells from torch       2      5      8     11     14     17
//   floor under it       120.5   94.4   51.6    9.9    4.5    3.8
//   cow, before           36.5   37.9   38.3   40.8   34.2   35.0
//   cow, after           183.5  158.3  102.8   45.0   43.6   39.4
//
// The floor falls off over eleven cells, which is the torch's own light level
// minus the distance, exactly as it should. Before, the cow did not fall off at
// all: 36.5 two cells from a flame and 35.0 seventeen cells from it, on floors
// that differ by thirty-two to one. That is the report — "mobs and item drops
// are black/dark in caves if a torch is not directly shining on them but blocks
// are different even if they are far or covered" — and no tuning of the old
// probe could have closed it, because the old probe cannot see a torch the
// player is not standing next to.
//
// After, the animal tracks the floor: mob-over-floor is 1.68, 1.68, 1.91 over
// the first eight cells where it was 0.30, 0.40, 0.74. The same six numbers
// come out of the run with the player standing on the torch, to within 0.3,
// which is the other half of the point — the answer no longer depends on where
// the person looking at it happens to be.
//
// What is left is not block light. Past eleven cells the floor is at 4/255 and
// the animal is at 40, because a body is lit by scene lights that have no idea
// there is a roof and the terrain is lit by a baked field that does. That is
// the sky half of the same report and it is not what this file is for.
//
// ### Why a second flood rather than shipping the first one over
//
// The worker's field is 127 885 824 cells across four channels and it is
// rebuilt region by region as the world streams. Posting a window of it to the
// main thread means a message per edit and a second copy to keep in step with
// a producer that does not know where the player is standing. This volume is
// 48x48x32 — the same box the moving flames' shadow volume already occupies,
// see the OCC_* block in VoxelMaterial.js — it is rebuilt from `planet.blocks`,
// which the main thread already holds, and it is rebuilt on exactly the two
// events that already rebuild that volume.
//
// The two floods agree because they are the same flood. ATTEN and SKY_ATTEN are
// imported from `Lighting.js` rather than restated, the seed is the same
// `LIGHT_EMIT * scale / 255` rounding, the step is the same six neighbours, and
// the vertical step is blocked by the same rule (a slab is a roof to light
// travelling up or down through it and no obstacle at all to light passing it
// in a wall). There is no second table here that can drift from the first.
//
// ### What it cannot do that the worker's field can
//
// It has edges. An emitter outside the box does not light anything inside it,
// where the real field would carry up to fifteen cells across that boundary.
// The box reaches twenty-four columns and sixteen layers from the player, so
// this only bites at the very rim, and the rim is handled twice over: the
// answer is faded out over the last few cells so nothing pops as the box moves,
// and beyond the box the caller falls back to the probe that was here before.
// Failing to the old behaviour is the whole contract — a mob that goes black
// because it wandered out of an invisible box is worse than the bug this fixes.

import { ATTEN, SKY_ATTEN, MAX_LIGHT } from './Lighting.js';
import { LIGHT_EMIT, LIGHT_R, LIGHT_G, LIGHT_B } from './Blocks.js';

/**
 * ATTEN for a step taken up or down rather than sideways.
 *
 * `Lighting.js` builds exactly this table and keeps it private, so it is
 * derived here from the two tables it does export rather than copied: the rule
 * is one line and restating the rule cannot drift the way restating 254 numbers
 * would. If that file's ATTEN_V ever stops being this expression, this is the
 * line that has to follow it.
 */
const ATTEN_V = new Uint8Array(ATTEN.length);
for (let i = 0; i < ATTEN.length; i++) ATTEN_V[i] = SKY_ATTEN[i] === 255 ? 255 : ATTEN[i];

/**
 * How many cells of the volume's rim the answer is faded out over.
 *
 * Not a safety margin — the sample itself is clamped inside the box — but a
 * seam killer. A torch sitting just outside the boundary lights nothing inside
 * it, so without the fade an animal walking across the rim would step from
 * "lit by the torch on this side" to "unlit" in one cell, and the rim moves
 * whenever the player does. Three cells out of twenty-four is a fade nobody
 * sees at a range where the animal is a few pixels tall.
 */
const FADE = 3;

export class EntityLightField {
  /**
   * @param {number} ni cells along the volume's i axis
   * @param {number} nj cells along j
   * @param {number} nk cells along k (radial)
   */
  constructor(ni, nj, nk) {
    this.ni = ni; this.nj = nj; this.nk = nk;
    this.plane = ni * nj;
    this.n = ni * nj * nk;
    this.r = new Uint8Array(this.n);
    this.g = new Uint8Array(this.n);
    this.b = new Uint8Array(this.n);
    /**
     * The BFS queue, four entries per cell.
     *
     * A cell is enqueued every time its level improves, so this is not a proof
     * against overflow and is not meant to be one; the flood drops an entry
     * rather than growing, which costs a level in a corner that the next
     * rebuild puts back. `LightField._flood` takes the same view and says so.
     * Four times the volume is a ceiling no channel can plausibly reach: a
     * single channel writes at most fifteen improvements to a cell and only
     * ever reaches cells within fifteen steps of an emitter, and the volume is
     * mostly rock.
     */
    this._q = new Int32Array(this.n * 4);
    /**
     * Where the emitters are, found once per build and shared by the three
     * channel floods. Grows if a volume ever holds more than this; a wall of
     * lava is the case that fills it, and 4 096 cells is a third of the whole
     * bottom layer of the box.
     */
    this._em = new Int32Array(4096);
    /** False until a build has run, so a caller can fail open before then. */
    this.ready = false;
  }

  /**
   * Light the volume from every emitter inside it.
   *
   * @param {Uint8Array} ids block id per cell, in the volume's own order
   *   (`(k * nj + j) * ni + i`, which is the occupancy texture's order)
   * @param {Uint8Array} occ the occupancy bytes for the same cells — nonzero is
   *   opaque. Passed separately rather than re-derived from `ids` because the
   *   rows below the bottom of the world have no block id and are solid, and
   *   because it is the array that already exists.
   * @returns {number} how many emitter cells were found, so the caller can tell
   *   an empty answer from an unbuilt one
   */
  build(ids, occ) {
    const { r, g, b, n } = this;
    r.fill(0); g.fill(0); b.fill(0);
    this.ready = true;

    // The sweep for emitters runs once and the three floods share its answer.
    // Doing it inside the channel loop was the first version and it is the
    // whole cost of a volume with nothing burning in it: three passes over
    // 73 728 cells to find nothing, 0.22 ms, on every recentre, above ground,
    // in daylight, forever. One pass is 0.08 ms and the common case is the one
    // that matters.
    //
    // Splitting the *floods* by channel is not the same kind of waste and stays.
    // It is what `LightField` does and it is not a nicety: a red lantern beside
    // a white torch carries two different distances in two different channels,
    // and a single flood of the maximum would paint the lantern's colour over
    // the torch's reach.
    let em = this._em;
    let found = 0;
    for (let i = 0; i < n; i++) {
      if (LIGHT_EMIT[ids[i]] <= 0) continue;
      if (found >= em.length) {
        const next = new Int32Array(em.length * 2);
        next.set(em);
        em = this._em = next;
      }
      em[found++] = i;
    }
    if (!found) return 0;

    const chans = [r, g, b];
    const scales = [LIGHT_R, LIGHT_G, LIGHT_B];
    for (let c = 0; c < 3; c++) {
      const chan = chans[c], scale = scales[c];
      const q = this._q;
      let tail = 0;
      for (let e = 0; e < found; e++) {
        const i = em[e], id = ids[i];
        // The seed is not `LIGHT_EMIT` itself: a torch is warm, so its blue
        // channel starts lower than its red one. Same rounding as the worker's,
        // so the two agree to the level rather than to within one.
        const v = Math.round(LIGHT_EMIT[id] * (scale[id] / 255));
        if (v > chan[i]) { chan[i] = v; q[tail++] = i; }
      }
      // An emitter whose own cell is opaque still seeds — glowstone is a solid
      // block that glows — because the cost of a step is charged on entering a
      // cell, not on leaving one. That is `LightField`'s rule and this is the
      // same rule, not a copy of its consequences.
      if (tail) this._flood(chan, ids, occ, tail);
    }
    return found;
  }

  _flood(field, ids, occ, tail) {
    const q = this._q;
    const cap = q.length;
    const { ni, nj, nk, plane } = this;
    let head = 0;
    while (head < tail) {
      const i = q[head++];
      const lv = field[i];
      // Nothing below 2 can light a neighbour: the cheapest step costs 1 and a
      // level of 0 is not light.
      if (lv <= 1) continue;
      const kk = (i / plane) | 0;
      const rem = i - kk * plane;
      const jj = (rem / ni) | 0;
      const ii = rem - jj * ni;
      for (let d = 0; d < 6; d++) {
        let ni2;
        if (d === 0) { if (ii + 1 >= ni) continue; ni2 = i + 1; }
        else if (d === 1) { if (ii === 0) continue; ni2 = i - 1; }
        else if (d === 2) { if (jj + 1 >= nj) continue; ni2 = i + ni; }
        else if (d === 3) { if (jj === 0) continue; ni2 = i - ni; }
        else if (d === 4) { if (kk + 1 >= nk) continue; ni2 = i + plane; }
        else { if (kk === 0) continue; ni2 = i - plane; }
        // Opaque is read off the occupancy bytes rather than off ATTEN, and the
        // two are the same test (ATTEN 255 is IS_OPAQUE) everywhere except
        // below layer zero, where there is no block id to read and the world is
        // solid. Reading occupancy covers both cases with one compare.
        let at;
        if (occ[ni2] !== 0) continue;
        at = d >= 4 ? ATTEN_V[ids[ni2]] : ATTEN[ids[ni2]];
        if (at === 255) continue;
        const nv = lv - at;
        if (nv > field[ni2]) {
          field[ni2] = nv;
          if (tail < cap) q[tail++] = ni2;
        }
      }
    }
  }

  /**
   * Sample the field at continuous volume-cell coordinates.
   *
   * Trilinear over the eight cells the point sits between, with opaque cells
   * left out of the average — which is `cornerLight` in the mesher, in as many
   * words, and is what makes an animal's light change as smoothly across a room
   * as the floor's does. Nearest-cell was the first version and it steps: a cow
   * grazing on a boundary flickers between two of the fifteen levels, and the
   * terrain under it does not, because the terrain interpolates.
   *
   * The rim fade is applied to the result rather than to the field, so it costs
   * nothing on the ninety-odd percent of samples that are nowhere near an edge.
   *
   * @param {number} x volume-local cell coordinates
   * @param {{r:number,g:number,b:number}} out written in place, 0..1, in the
   *   same units as the terrain's `blockLight` vertex attribute
   * @returns {boolean} false if the point is outside the volume, in which case
   *   `out` is untouched and the caller must fall back
   */
  sample(x, y, z, out, occ) {
    const { ni, nj, nk, plane } = this;
    if (!this.ready) return false;
    // Written positively so a NaN coordinate — which is what a stale volume on
    // the far side of the planet produces — takes the false branch with
    // everything else rather than sailing through a negated one.
    if (!(x >= 0 && x < ni && y >= 0 && y < nj && z >= 0 && z < nk)) return false;

    const fx = x - 0.5, fy = y - 0.5, fz = z - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let c = 0; c < 8; c++) {
      const ix = x0 + (c & 1), iy = y0 + ((c >> 1) & 1), iz = z0 + ((c >> 2) & 1);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= ni || iy >= nj || iz >= nk) continue;
      const idx = (iz * nj + iy) * ni + ix;
      // A solid cell holds no light and must not be averaged in, or a body
      // standing against a wall reads half of the rock's zero.
      if (occ[idx] !== 0) continue;
      const w = ((c & 1) ? tx : 1 - tx) * (((c >> 1) & 1) ? ty : 1 - ty)
        * (((c >> 2) & 1) ? tz : 1 - tz);
      if (w <= 0) continue;
      sr += this.r[idx] * w; sg += this.g[idx] * w; sb += this.b[idx] * w;
      sw += w;
    }
    if (sw <= 0) {
      // Every corner solid, which happens for a body clipped into a wall. The
      // cell it is actually standing in is the honest answer and it is zero.
      out.r = 0; out.g = 0; out.b = 0;
      return true;
    }

    // How far inside the box this is, in cells, along the tightest axis.
    const edge = Math.min(x, ni - x, y, nj - y, z, nk - z);
    const fade = edge >= FADE ? 1 : Math.max(0, edge / FADE);
    const s = fade / (sw * MAX_LIGHT);
    out.r = sr * s; out.g = sg * s; out.b = sb * s;
    return true;
  }
}
