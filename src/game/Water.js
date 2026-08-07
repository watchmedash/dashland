// Flowing water.
//
// The world has no fluid simulation: worldgen places water and it never moves,
// so digging a channel out of a lake bed leaves the lake hanging in the air.
//
// This is a bounded, Minecraft-style flow rather than real fluid dynamics, and
// the reason is the failure mode. Water without a decay limit spreads through
// every connected air cell it can reach — one dug block and the ocean drains
// across the whole planet. So each cell carries a level: a source is at LEVEL_MAX
// and every sideways step costs one, dying out a fixed distance from its origin.
// Falling water keeps its level, which is what lets a waterfall reach the bottom
// of a shaft and still spread there.
//
// Only cells adjacent to a change are ever examined. The active set is seeded by
// edits and drains to empty once the water settles, so a still lake costs nothing.

import { D } from '../world/Constants.js';
import { colNeighbor } from '../world/Sphere.js';
import { ID, RENDER_TYPE, R_LIQUID, IS_SOLID } from '../world/Blocks.js';

/** A full source block. Sideways flow loses one level per cell. */
const LEVEL_MAX = 7;
/** Seconds between flow ticks — water should visibly creep, not teleport. */
const TICK = 0.22;
/** Ceiling on cells processed per tick, so a huge breach can't stall a frame. */
const MAX_PER_TICK = 900;

export class Water {
  /**
   * @param {import('../world/Planet.js').Planet} planet
   * @param {(edits: Array<{col:number,k:number,id:number}>) => void} applyEdits
   */
  constructor(planet, applyEdits) {
    this.planet = planet;
    this.applyEdits = applyEdits;
    /** cell index -> flow level 1..7. Only ever holds *flowing* water. */
    this.level = new Map();
    /**
     * Cells that produce water: worldgen lakes and anything poured from a
     * bucket. Kept explicit rather than inferred from "has no level entry" —
     * that inference turned any flowing cell whose level was dropped into a
     * brand-new spring, so a puddle could quietly become a source and never
     * drain. A cell is a source only if it was deliberately made one.
     */
    this.sources = new Set();
    /** cells to re-examine next tick */
    this.active = new Set();
    this.timer = 0;
  }

  clear() { this.level.clear(); this.sources.clear(); this.active.clear(); }

  key(col, k) { return col * D + k; }

  /** Level of the water at a cell, or -1 if there is none. */
  levelAt(col, k) {
    if (RENDER_TYPE[this.planet.at(col, k)] !== R_LIQUID) return -1;
    const key = this.key(col, k);
    if (this.sources.has(key)) return LEVEL_MAX;
    const v = this.level.get(key);
    // Unmarked water is an *orphan*, not a spring. Every real source is
    // registered — worldgen's at load, the player's when poured — so a cell
    // with neither mark is a leftover from a flow whose bookkeeping got out of
    // step. Reading those as sources is what let puddles turn into springs.
    return v === undefined ? 0 : v;
  }

  /**
   * A liquid can move into air, and into a shallower pool of *its own kind*.
   *
   * The second half used to be "any liquid", and combined with `_place` always
   * writing `ID.water` it meant a disturbed lava flow spread as water and
   * converted the lava it came from. Nothing turns lava into water — that is a
   * property change no rule in this game licenses.
   *
   * @param {number} self the liquid doing the moving
   */
  _canEnter(col, k, level, self) {
    const id = this.planet.at(col, k);
    if (id === 0) return true;
    if (RENDER_TYPE[id] !== R_LIQUID) return false;
    if (id !== self) return false;
    return this.levelAt(col, k) < level - 1;
  }

  /** Mark a cell and everything touching it for re-examination. */
  touch(col, k) {
    if (k < 0 || k >= D) return;
    this.active.add(this.key(col, k));
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
      if (n >= 0) this.active.add(this.key(n, k));
    }
    if (k > 0) this.active.add(this.key(col, k - 1));
    if (k + 1 < D) this.active.add(this.key(col, k + 1));
  }

  /** Any edit near water can start or stop a flow. */
  onEdit(col, k) {
    this.touch(col, k);
    if (k + 1 < D) this.touch(col, k + 1);
    if (k > 0) this.touch(col, k - 1);
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0 || this.active.size === 0) return;
    this.timer = TICK;

    const p = this.planet;
    const todo = [...this.active].slice(0, MAX_PER_TICK);
    // anything not reached this tick stays queued for the next one
    if (this.active.size > MAX_PER_TICK) {
      const keep = [...this.active].slice(MAX_PER_TICK);
      this.active = new Set(keep);
    } else {
      this.active.clear();
    }

    const edits = [];
    for (const key of todo) {
      const k = key % D;
      const col = (key - k) / D;
      const here = this.levelAt(col, k);

      if (here < 0) { this._maybeDry(col, k, edits); continue; }

      // Whatever is in this cell is what spreads out of it. The simulation used
      // to place ID.water unconditionally, so any lava it touched became water.
      const self = this.planet.at(col, k);

      // --- fall straight down first; a liquid prefers a hole to a spread ---
      if (k > 0 && this._canEnter(col, k - 1, LEVEL_MAX + 1, self)) {
        this._place(col, k - 1, here === LEVEL_MAX ? LEVEL_MAX : here, edits, self);
        // a falling column feeds the cell below and stops spreading sideways
        continue;
      }

      // --- otherwise creep outward, losing height as it goes ---
      // Lava loses twice as much, so it crawls a couple of blocks from a breach
      // where water runs six. A lava flow that spread as far as water would
      // turn any breached chamber into a floor-to-wall hazard.
      const decay = self === ID.lava ? 2 : 1;
      const next = here - decay;
      if (next <= 0) continue;
      for (let d = 0; d < 4; d++) {
        const n = colNeighbor(col, d);
        if (n < 0) continue;
        if (this._canEnter(n, k, here, self)) this._place(n, k, next, edits, self);
      }
    }

    if (edits.length) this.applyEdits(edits);
  }

  _place(col, k, level, edits, id = ID.water) {
    const key = this.key(col, k);
    const had = this.level.get(key);
    this.level.set(key, level);
    // The level rides along as the edit's `facing` byte. That side-table is
    // already transferred to the meshing worker, and a cell is never both a
    // log and water, so the flow depth reaches the mesher for free — which is
    // what lets a thin flow be drawn shorter than a full block instead of as
    // a full-height slab, the "sheet of paper" look.
    const wasLiquid = RENDER_TYPE[this.planet.at(col, k)] === R_LIQUID;
    if (!wasLiquid || had !== level) edits.push({ col, k, id, facing: level });
    this.touch(col, k);
  }

  /**
   * Flowing water with nothing feeding it any more drains away. Sources — the
   * worldgen lakes and anything poured from a bucket — never do, so a shoreline
   * doesn't slowly evaporate.
   */
  _maybeDry(col, k, edits) {
    const key = this.key(col, k);
    if (this.sources.has(key)) return;
    if (RENDER_TYPE[this.planet.at(col, k)] !== R_LIQUID) { this.level.delete(key); return; }
    // An orphan (water, no source mark, no level) is swept away with the rest.
    if (!this.level.has(key)) {
      this.level.delete(key);
      edits.push({ col, k, id: 0 });
      this.touch(col, k);
      return;
    }
    if (RENDER_TYPE[this.planet.at(col, k)] !== R_LIQUID) { this.level.delete(key); return; }
    // Anything with a level entry is *flowing*, however strong. Exempting
    // full-strength cells here made falling water permanent: a waterfall kept
    // running after its source was gone, and every cell it filled behaved like
    // a spring. Only a true source — no entry at all — is exempt, which the
    // early return above already handles.
    const mine = this.level.get(key);

    let fed = false;
    if (k + 1 < D && RENDER_TYPE[this.planet.at(col, k + 1)] === R_LIQUID) fed = true;
    if (!fed) {
      for (let d = 0; d < 4 && !fed; d++) {
        const n = colNeighbor(col, d);
        if (n >= 0 && this.levelAt(n, k) > mine) fed = true;
      }
    }
    if (!fed) {
      this.level.delete(key);
      edits.push({ col, k, id: 0 });
      this.touch(col, k);
    }
  }

  /**
   * Register every existing water cell as a source. Called once the world is
   * ready: worldgen's oceans and lakes have no level entries and must not be
   * mistaken for stale flow, and doing it here means "unmarked" can safely mean
   * "orphaned" everywhere else.
   */
  seedSources(planet) {
    const p = planet || this.planet;
    const n = p.blocks.length;
    this.sources.clear();
    for (let i = 0; i < n; i++) {
      if (RENDER_TYPE[p.blocks[i]] === R_LIQUID && !this.level.has(i)) this.sources.add(i);
    }
  }

  /** Mark a cell as a spring — used when the player pours from a bucket. */
  addSource(col, k) {
    const key = this.key(col, k);
    this.sources.add(key);
    this.level.delete(key);
    this.touch(col, k);
  }

  toJSON() {
    return { lv: [...this.level].map(([i, v]) => [i, v]), src: [...this.sources] };
  }

  fromJSON(data) {
    this.level.clear();
    this.sources.clear();
    this.active.clear();
    if (!data) return;
    // Older saves stored a bare array of levels and had no source set.
    const lv = Array.isArray(data) ? data : (data.lv || []);
    for (const [i, v] of lv) this.level.set(i, v);
    for (const i of (data.src || [])) this.sources.add(i);
  }
}
