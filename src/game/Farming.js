// Tilling, planting, watering and crop growth.
//
// Crops are ordinary blocks — the wheat stages are consecutive ids, so growing
// one is an increment. This module only tracks *which* cells are growing and
// how far along they are; the world itself remains the source of truth, so a
// crop broken by any means simply drops out of the set on its next tick.

import { D } from '../world/Constants.js';
import { colNeighbor } from '../world/Sphere.js';
import { ID } from '../world/Blocks.js';

export const CROP_MIN = ID.wheat_0;
export const CROP_MAX = ID.wheat_3;

const STAGE_SECONDS = 46;      // dry farmland
const WET_MULTIPLIER = 2.1;
const WATER_RANGE = 3;         // columns

export class Farming {
  constructor(planet, applyEdits) {
    this.planet = planet;
    this.applyEdits = applyEdits;
    this.crops = new Map();     // col*D+k -> { col, k, t }
    this.wetTimer = 0;
  }

  clear() { this.crops.clear(); }

  key(col, k) { return col * D + k; }

  // --- player actions -------------------------------------------------------

  /** Can this block be turned into farmland? */
  canTill(blockId) {
    return blockId === ID.grass || blockId === ID.dirt || blockId === ID.dirt_path;
  }

  /** Turn soil into farmland, wet if there's water nearby. */
  till(col, k) {
    const soil = this.nearWater(col, k) ? ID.farmland_wet : ID.farmland;
    const above = this.planet.at(col, k + 1);
    const edits = [{ col, k, id: soil }];
    // clear whatever was growing on top, otherwise it floats
    if (above !== 0 && !this.planet.solidAt(col, k + 1)) edits.push({ col, k: k + 1, id: 0 });
    this.applyEdits(edits);
    return true;
  }

  /** Plant seeds on farmland. */
  plant(col, k) {
    const soil = this.planet.at(col, k);
    if (soil !== ID.farmland && soil !== ID.farmland_wet) return false;
    if (this.planet.at(col, k + 1) !== 0) return false;
    this.applyEdits([{ col, k: k + 1, id: CROP_MIN }]);
    this.crops.set(this.key(col, k + 1), { col, k: k + 1, t: 0 });
    return true;
  }

  /** Is there water within a few columns at roughly this height? */
  nearWater(col, k) {
    const p = this.planet;
    const seen = new Set([col]);
    let frontier = [col];
    for (let step = 0; step < WATER_RANGE; step++) {
      const next = [];
      for (const c of frontier) {
        for (let d = 0; d < 4; d++) {
          const n = colNeighbor(c, d);
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
          for (let dk = -1; dk <= 1; dk++) {
            if (p.liquidAt(n, k + dk)) return true;
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  // --- simulation -----------------------------------------------------------

  /**
   * Grow everything on.
   * @param {number} season crop growth multiplier for the time of year — 1 in
   *   summer, and low enough in winter that a field is worth sowing *before* it
   *   rather than during. It scales time rather than gating growth, so a winter
   *   crop still finishes eventually and nobody loses a field to the calendar.
   */
  update(dt, season = 1) {
    const p = this.planet;

    for (const [key, c] of this.crops) {
      const cur = p.at(c.col, c.k);
      if (cur < CROP_MIN || cur > CROP_MAX) { this.crops.delete(key); continue; }
      if (cur === CROP_MAX) continue;

      const below = p.at(c.col, c.k - 1);
      const wet = below === ID.farmland_wet;
      if (below !== ID.farmland && !wet) { this.crops.delete(key); continue; }

      // Only the crop clock feels the season. Scaling the whole tick would have
      // slowed the irrigation refresh below with it, and how often the game
      // re-checks for a pond has nothing to do with the time of year.
      c.t += dt * (wet ? WET_MULTIPLIER : 1) * season;
      if (c.t >= STAGE_SECONDS) {
        c.t = 0;
        this.applyEdits([{ col: c.col, k: c.k, id: cur + 1 }]);
      }
    }

    // refresh farmland wetness now and then so irrigation reacts to edits
    this.wetTimer -= dt;
    if (this.wetTimer <= 0) {
      this.wetTimer = 5;
      for (const c of this.crops.values()) {
        const k = c.k - 1;
        const cur = p.at(c.col, k);
        if (cur !== ID.farmland && cur !== ID.farmland_wet) continue;
        const want = this.nearWater(c.col, k) ? ID.farmland_wet : ID.farmland;
        if (cur !== want) this.applyEdits([{ col: c.col, k, id: want }]);
      }
    }
  }

  toJSON() {
    return [...this.crops.values()].map((c) => [c.col, c.k, +c.t.toFixed(1)]);
  }

  fromJSON(arr) {
    this.crops.clear();
    for (const [col, k, t] of arr || []) this.crops.set(this.key(col, k), { col, k, t });
  }

  /** Re-discover crops after loading a world saved before this existed. */
  rescan() {
    const p = this.planet;
    for (let col = 0; col < p.colBiome.length; col++) {
      for (let k = 1; k < D; k++) {
        const b = p.at(col, k);
        if (b >= CROP_MIN && b < CROP_MAX) this.crops.set(this.key(col, k), { col, k, t: 0 });
      }
    }
  }
}
