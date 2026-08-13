// Tilling, planting, watering and crop growth.
//
// Crops are ordinary blocks — the wheat stages are consecutive ids, so growing
// one is an increment. This module only tracks *which* cells are growing and
// how far along they are; the world itself remains the source of truth, so a
// crop broken by any means simply drops out of the set on its next tick.

import { D } from '../world/Constants.js';
import { colNeighbor } from '../world/Sphere.js';
import { ID, IS_REPLACEABLE, RENDER_TYPE, R_LIQUID } from '../world/Blocks.js';

/**
 * The crop families, each a run of four consecutive block ids.
 *
 * Growth is still "increment the id", which is what makes a crop an ordinary
 * block with no per-stage code. What changed is that there is now more than one
 * run: a single `CROP_MIN`..`CROP_MAX` pair could only ever describe one crop,
 * and with a second family inside the same range wheat's ripe stage would grow
 * into the next crop's seedling.
 *
 * Derived from the names rather than written out, so adding a crop means adding
 * its four blocks and this list, and nothing else here.
 */
export const CROP_FAMILIES = ['wheat', 'strawberry', 'squash', 'greenbean',
  'snowpea', 'hops', 'grape', 'watermelon']
  .map((n) => ({ name: n, first: ID[`${n}_0`], last: ID[`${n}_3`] }))
  .filter((f) => f.first !== undefined && f.last !== undefined);

/** The family this block id belongs to, or null. */
export function cropFamily(id) {
  for (let n = 0; n < CROP_FAMILIES.length; n++) {
    const f = CROP_FAMILIES[n];
    if (id >= f.first && id <= f.last) return f;
  }
  return null;
}

/** The seedling a given seed item sows, by crop name. */
export const cropFirstId = (name) => ID[`${name}_0`];

// Kept so nothing outside has to know the shape changed; wheat is still the
// crop the bare `seeds` item sows.
export const CROP_MIN = ID.wheat_0;
export const CROP_MAX = ID.wheat_3;

const STAGE_SECONDS = 46;      // dry farmland
const WET_MULTIPLIER = 2.1;
const WATER_RANGE = 3;         // columns

/**
 * Does a block sitting in the cell directly above soil shut the sky out of it?
 *
 * The one predicate behind the whole rule, deliberately: "you cannot till under
 * a block", "farmland built over goes back to dirt" and "a roofed crop stops
 * growing" are the same sentence read three times, and three separate tests
 * would let them disagree — soil you were allowed to till and that then
 * immediately reverted would read as the game eating a click.
 *
 * Three things are *not* a roof:
 *  - air, obviously;
 *  - a plant (`IS_REPLACEABLE` is exactly the crossed-quad plants, wheat
 *    included), because the crop standing on farmland is the entire point of
 *    the farmland and must not count as covering it;
 *  - a liquid, because rain and a poured bucket land on a field and irrigation
 *    is what the player wanted from them. Water over a crop drowning it is a
 *    different rule and this is not the place to invent it.
 *
 * Everything else roofs, a torch included. A torch is not a full block and
 * Minecraft would let it stand there, but the rule the player asked for is "no
 * block above", and a single test that answers for every id is worth more than
 * an exemption list that has to be maintained every time a block is added.
 */
export function roofsSoil(id) {
  return id !== 0 && !IS_REPLACEABLE[id] && RENDER_TYPE[id] !== R_LIQUID;
}

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

  /**
   * Can this block be turned into farmland, as far as the *soil* is concerned?
   *
   * Half the question. It takes an id rather than a cell because it is also the
   * "does a shovel want this cell at all" test — see `_hasUse` in main.js: a
   * shovel aimed at dirt claims the right button whether or not the sky is
   * open, so that a roofed field says why it refused instead of quietly letting
   * the offhand act instead.
   */
  canTill(blockId) {
    return blockId === ID.grass || blockId === ID.dirt || blockId === ID.dirt_path;
  }

  /** Is there farmland here with room for a seed on top? */
  canPlant(col, k) {
    const soil = this.planet.at(col, k);
    return (soil === ID.farmland || soil === ID.farmland_wet)
      && this.planet.at(col, k + 1) === 0;
  }

  /** Is the sky above this cell clear enough for farmland? */
  openAbove(col, k) {
    return k + 1 >= D || !roofsSoil(this.planet.at(col, k + 1));
  }

  /** Soil, with nothing built over it: the whole test. */
  tillable(col, k) {
    return this.canTill(this.planet.at(col, k)) && this.openAbove(col, k);
  }

  /**
   * Turn soil into farmland, wet if there's water nearby.
   *
   * Re-checks `tillable` rather than trusting the caller: this is the only way
   * farmland is ever made, so it is the right place for the rule to be true.
   * @returns {boolean} false if the cell refused
   */
  till(col, k) {
    if (!this.tillable(col, k)) return false;
    const soil = this.nearWater(col, k) ? ID.farmland_wet : ID.farmland;
    const above = this.planet.at(col, k + 1);
    const edits = [{ col, k, id: soil }];
    // clear whatever was growing on top, otherwise it floats. Only a plant can
    // be up there now — anything else is a roof and was refused above.
    if (above !== 0 && IS_REPLACEABLE[above]) edits.push({ col, k: k + 1, id: 0 });
    this.applyEdits(edits);
    return true;
  }

  /** Plant seeds on farmland. */
  plant(col, k, firstId = CROP_MIN) {
    if (!this.canPlant(col, k)) return false;
    if (!cropFamily(firstId)) return false;
    this.applyEdits([{ col, k: k + 1, id: firstId }]);
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
      const fam = cropFamily(cur);
      if (!fam) { this.crops.delete(key); continue; }
      // Ripe is the last rung of THIS family, not of the whole crop range.
      if (cur === fam.last) continue;

      const below = p.at(c.col, c.k - 1);
      const wet = below === ID.farmland_wet;
      if (below !== ID.farmland && !wet) { this.crops.delete(key); continue; }

      // Built over: the clock stops, and it stops without losing what the crop
      // has already earned. Roofing a field cannot destroy the crop here,
      // because the block goes into the crop's own cell and the loop above has
      // already dropped it — this is for the roof one cell higher, and for the
      // farmland a save or a chunk of worldgen handed us already covered. A
      // pause rather than a death: the player only has to take the roof off,
      // which is the same thing the refusal to till is telling them.
      if (!this.openAbove(c.col, c.k)) continue;

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
        const fb = cropFamily(b);
        if (fb && b < fb.last) this.crops.set(this.key(col, k), { col, k, t: 0 });
      }
    }
  }
}
