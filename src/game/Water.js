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
// Falling water lands full, which is what lets a waterfall reach the bottom of a
// shaft and spread there as if it had come straight off a spring — and what lets
// a stepped slope carry a stream all the way down instead of charging it a level
// per step until it dies on ground that is still falling away in front of it.
// The cap is therefore six columns *per drop*, not six columns per breach.
//
// Lava runs through the same tick and differs in exactly two places: it loses
// two levels a step instead of one, so it crawls three columns from a breach
// where water runs six, and water quenches it — a lava source touched by water
// becomes obsidian, a flowing lava cell becomes cobblestone, and the water is
// untouched. See `_quench` for why the water surviving is what makes the
// reaction stop rather than eat a lava lake alive.
//
// Only cells adjacent to a change are ever examined. The active set is seeded by
// edits and drains to empty once the water settles, so a still lake costs
// nothing — and "drains to empty" is a property the tests check directly,
// because the ways it fails are silent.

import { D } from '../world/Constants.js';
import { colNeighbor, cellIdx } from '../world/Layout.js';

const _kd = { col: 0, k: 0 };

/** A cell key back into its column and layer. `col * D + k`, inverted. */
function cellDecode(key, out = _kd) {
  out.k = key % D;
  out.col = (key - out.k) / D;
  return out;
}
import { ID, RENDER_TYPE, R_LIQUID, DROWNS } from '../world/Blocks.js';

/**
 * A full source block. Sideways flow loses one level per cell.
 *
 * Exported because main.js seeds worldgen waterfalls at exactly this level --
 * see `_isFallingCell` -- and a second copy of the number in that file would be
 * a copy that could drift.
 */
export const LEVEL_MAX = 7;
/** Seconds between flow ticks — water should visibly creep, not teleport. */
const TICK = 0.22;
/** Ceiling on cells processed per tick, so a huge breach can't stall a frame. */
const MAX_PER_TICK = 900;
/**
 * Map offsets for `colNeighbor`'s four directions, in Grid's order: north,
 * south, west, east - i.e. y-1, y+1, x-1, x+1.
 *
 * The cube's table was in its own (+i, -i, +j, -j) order and does not survive
 * the move: the direction index means something different now, and reading the
 * old one would push every river ninety degrees off its channel.
 */
const DIR_X = [0, 0, -1, 1];
const DIR_Y = [-1, 1, 0, 0];
/** Scratch for flowAt — it is asked every frame and answers nothing worth keeping. */
const _flow = { i: 0, j: 0, k: 0, s: 0 };

/**
 * The trail a body drags through glowing water.
 *
 * This is render state and it lives here anyway, because what it describes is a
 * fact about water rather than about a material: something moved through it, and
 * for the next second and a half that patch of sea has been stirred. The shader
 * reads the result out of `voxelUniforms.uBioWake` and knows nothing about who
 * made it, so a mob or a boat could feed the same buffer later without the
 * water shader learning a second thing.
 *
 * Four slots, written round. That number is set by the shader -- see uBioWake --
 * and the trade it encodes is that four gaussians is what reads as a line at
 * swimming speed rather than as a string of beads. Positions are world space and
 * are copied out, not referenced: the player's own vector is mutated in place
 * every frame and holding it would have made all four slots the same point.
 */
export class BioWake {
  constructor() {
    /** xyz plus the strength this slot was born with. */
    this.slots = [];
    for (let i = 0; i < 4; i++) this.slots.push({ x: 0, y: 0, z: 0, s: 0, age: 1e9 });
    this.next = 0;
    this.timer = 0;
  }

  clear() {
    for (const s of this.slots) { s.s = 0; s.age = 1e9; }
    this.timer = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} pos world position of the swimmer
   * @param {number} speed tangential speed, cells/s (`player.moveAmount`)
   * @param {boolean} active in water and not a spectator
   * @param {Array} out four THREE.Vector4 uniform values to write
   */
  update(dt, pos, speed, active, out) {
    // 0.16 s between drops. Faster and the four slots cover a metre and the
    // trail is a blob; slower and they are visibly separate flashes. At the
    // 4.4 cells/s of an ordinary swim this lays one down every 0.7 cells,
    // which against the shader's ~4-cell blob is a continuous ribbon.
    const DROP = 0.16;
    /** How long a stirred patch keeps flashing. */
    const LIFE = 1.5;
    for (const s of this.slots) s.age += dt;
    this.timer -= dt;
    // A swimmer treading water leaves nothing. The threshold is the same 0.8
    // the stroke sound uses, so the wake and the splash are the same event.
    if (active && speed > 0.8 && this.timer <= 0) {
      this.timer = DROP;
      const s = this.slots[this.next];
      this.next = (this.next + 1) & 3;
      s.x = pos.x; s.y = pos.y; s.z = pos.z;
      // Saturating rather than linear: a sprint-swim is not four times the
      // light of a drift, it is a little more of it.
      s.s = Math.min(1, 0.45 + speed * 0.11);
      s.age = 0;
    }
    for (let i = 0; i < 4; i++) {
      const s = this.slots[i];
      const t = s.age / LIFE;
      // Squared fade, so the newest blob is much the brightest and the tail
      // thins away instead of switching off.
      const k = t >= 1 ? 0 : s.s * (1 - t) * (1 - t);
      out[i].set(s.x, s.y, s.z, k);
    }
  }
}

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
    /**
     * Cells turned to rock by `_quench` during the tick currently running.
     *
     * A tick reads `planet` but writes a *batch*, applied once at the end, so
     * for the rest of the tick a quenched cell still reads as the lava it was.
     * Without this the batch contradicted itself: cell 2 quenches to
     * cobblestone, cell 3 is examined a moment later, sees lava still standing
     * in cell 2, and appends a lava edit *after* the quench — so the lava came
     * straight back and the pair oscillated forever. Measured at a water/lava
     * boundary: 46 edits every tick, indefinitely, with the two fronts neither
     * advancing nor settling.
     */
    this._quenched = new Set();
    this.timer = 0;
  }

  clear() { this.level.clear(); this.sources.clear(); this.active.clear(); this._quenched.clear(); }

  key(col, k) { return cellIdx(col, k); }

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
   * Is this cell one the current can simply take? Air, or a plant it washes
   * away.
   *
   * **The rule: flowing liquid destroys any cross plant that is not
   * IS_SUBMERGED.** A tuft of grass, a daisy, a sapling, a fern, a stand of
   * wheat — a stem is not a dam, and having one stop a river dead was the most
   * visible way this world contradicted itself, because the very same tuft is
   * something you walk through without slowing down.
   *
   * The reef is exempt and the exemption is not a special case bolted on: coral,
   * kelp, sea grass, sponges, clams and the abyssal anemone are flagged
   * `submerged` precisely because water is the only place they can be, and the
   * sea they grow in is made of the liquid that would otherwise be washing them
   * out. A rule that mowed them would empty every reef the first time anything
   * disturbed the ocean nearby. Everything else on the planet that renders as a
   * cross goes, including all sixteen of the new land flora, because the test is
   * the render class and not a list of names.
   *
   * Washing is destruction, not a harvest: nothing is dropped. Drops are the
   * business of the two paths that break a block on the player's behalf, and
   * this sim has no route to them — the callback it is handed is `_applyEdits`,
   * which is deliberately the plumbing and nothing else.
   *
   * The test is `DROWNS`, which is the flag the block table already keeps for
   * exactly this sentence — "the liquid would destroy this" — and which
   * `main.js` already consults to refuse a *placement* into a liquid cell. This
   * used to be an open-coded `IS_REPLACEABLE && !IS_SUBMERGED`, which is the
   * same set minus torches, and the mismatch was visible: the game would not
   * let you stand a torch in water, yet a torch already standing there stopped
   * a river dead. One flag, read in both places, and a flame goes out when the
   * water reaches it.
   */
  _washes(id) {
    return DROWNS[id] === 1;
  }

  /**
   * A liquid can move into air or a washable plant, and into a shallower pool of
   * *its own kind*.
   *
   * The second half used to be "any liquid", and combined with `_place` always
   * writing `ID.water` it meant a disturbed lava flow spread as water and
   * converted the lava it came from. Nothing turns lava into water — that is a
   * property change no rule in this game licenses.
   *
   * `level` is **the level that would be written**, not the level of the cell
   * doing the writing, and the difference is the whole of a bug that kept the
   * sim awake forever. The test used to be `levelAt < level - 1` against the
   * *source* cell's level, which silently assumed a decay of exactly one. Lava
   * decays two, so a lava cell at 7 writing 5 asked "is my neighbour shallower
   * than 6?", the neighbour sat at 5, and the answer was yes — every tick,
   * forever. `_place` re-wrote the same 5, pushed no edit because nothing had
   * changed, and `touch`ed the cell anyway, so a lava pool that was disturbed
   * once never went idle again. Measured: a single lava source on flat ground
   * held 89 cells in the active set and 0 edits, indefinitely; water, whose
   * decay happens to be 1, settled to 0. Comparing against the level actually
   * being written is decay-agnostic and identical for water.
   *
   * @param {number} level the flow level about to be written into the cell
   * @param {number} self the liquid doing the moving
   */
  _canEnter(col, k, level, self) {
    // Already rock as far as this batch is concerned, whatever the array says.
    if (this._quenched.has(this.key(col, k))) return false;
    const id = this.planet.at(col, k);
    if (id === 0) return true;
    if (this._washes(id)) return true;
    if (RENDER_TYPE[id] !== R_LIQUID) return false;
    if (id !== self) return false;
    return this.levelAt(col, k) < level;
  }

  /**
   * Which way the liquid in a cell is running, or null if it is going nowhere.
   *
   * No direction is stored anywhere — the sim only ever knew a cell's *level* —
   * and it stays that way. A vector per cell would be eleven million of them
   * for a planet that is almost entirely still ocean, all to answer a question
   * asked about the two or three cells that happen to have a player or a drop
   * in them. It is derived here instead, from the same level gradient the tick
   * itself flows down, so what pushes you is by construction the direction the
   * water is actually going.
   *
   * The result is on the MAP's axes, plus a vertical part: `i` is map x, `j` is
   * map y, `k` is the layer. Map x is world X and map y is world Z, so a caller
   * in world space reads `i` as X and `j` as Z and there is nothing to rotate —
   * the cube's tangent frame is gone with the fold that needed it. The names
   * `i`/`j` are kept because the player and the drops read them by name and a
   * silent rename there is NaN velocity, not a compile error.
   *
   * Only cells with a level entry answer — that is, only water that is
   * genuinely flowing. Sources deliberately do not, and the ocean is all
   * sources, so the sea is not a treadmill. This is also why an air neighbour
   * can safely count as "downhill": a still lake never reaches this code, so
   * the only thing an open side means here is somewhere the flow is headed.
   *
   * @returns {{i:number,j:number,k:number,s:number}|null} unit horizontal
   *   direction, a k of 0 or -1, and strength s in 0..1.
   */
  flowAt(col, k, out = _flow) {
    const mine = this.level.get(this.key(col, k));
    if (mine === undefined) return null;
    const self = this.planet.at(col, k);
    if (RENDER_TYPE[self] !== R_LIQUID) return null;

    out.i = 0; out.j = 0; out.k = 0; out.s = 0;

    // Falling beats spreading, exactly as the tick below does it — a liquid
    // over a hole is going down, whatever its neighbours say.
    if (k > 0 && this._canEnter(col, k - 1, LEVEL_MAX, self)) {
      out.k = -1; out.s = 1;
      return out;
    }

    let gi = 0, gj = 0;
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
      if (n < 0) continue;
      const id = this.planet.at(n, k);
      let fall;
      // A plant the flow is about to wash away is an open side, not a wall: it
      // has to read the same way here as it does in `_canEnter`, or the push a
      // swimmer feels points somewhere the water is not actually going.
      if (id === 0 || this._washes(id)) fall = mine;    // open side: all of it
      else if (RENDER_TYPE[id] !== R_LIQUID) continue;  // a wall diverts, it doesn't pull
      else if (id !== self) continue;                   // water does not chase lava
      else {
        const nl = this.levelAt(n, k);
        if (nl >= mine) continue;
        fall = mine - nl;
      }
      gi += DIR_X[d] * fall;
      gj += DIR_Y[d] * fall;
    }
    // A cell with the same drop on opposite sides — the middle of a narrow
    // stream, both banks open — cancels to nothing, which is right: it is the
    // *difference* along the channel that moves you, not the fact of being wet.
    const m = Math.hypot(gi, gj);
    if (m < 1e-6) return null;
    out.i = gi / m; out.j = gj / m;
    // The gradient decides the direction and whether there is one at all; it
    // does NOT set the strength, and the first attempt here that used it was
    // badly wrong. A channel loses exactly one level per cell all the way down
    // its length, so every interior cell of every river measured a gradient of
    // 1 — a seventh of the 7 a cell beside a source scores — and the whole
    // planet's rivers pushed at a seventh strength while the one puddle next to
    // a breach shoved like a firehose. Depth is the honest scale: how much
    // water is going past you, not how fast the level happens to be falling.
    // Nothing drops below 0.6, because the far end of a long run is still a
    // moving river and should feel like one.
    out.s = 0.6 + 0.4 * (mine / LEVEL_MAX);
    return out;
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
    this._quenched.clear();
    for (const key of todo) {
      cellDecode(key, _kd);
      const col = _kd.col, k = _kd.k;
      const here = this.levelAt(col, k);

      // Not liquid any more: drop the stale bookkeeping and move on.
      //
      // The `sources` half of that is not tidiness, it is the flood. A spring
      // mark on a cell that no longer holds liquid is a spring waiting to
      // happen: clear the cell later and the first flow that runs into it gets
      // a `sources` entry, which reads as full strength, never drains, and
      // hands a bucket a free scoop. Freezing was the live route in — a lake
      // surface ices over by writing `ID.ice` straight across cells the sim has
      // registered as springs, and nothing unregistered them — but the test is
      // about the cell rather than about winter, so mining, a quench and
      // anything added later are covered by the same line.
      //
      // It is done here, off the settled voxel array, rather than in `onEdit`.
      // A batch may hold two edits for one cell (a cell that dries and is refed
      // in the same tick does), and reaping per-edit sees the intermediate air,
      // drops the level of a cell that ends the tick full, and leaves an orphan
      // the next tick sweeps — measured as a permanent build-and-drain
      // oscillation under every waterfall. `touch` has already queued the cell,
      // so the check simply happens one tick later against the truth.
      if (here < 0) { this.level.delete(key); this.sources.delete(key); continue; }

      // Cut off from everything that was feeding it? Then it goes.
      //
      // This used to sit behind the `here < 0` branch above, which meant it ran
      // only for cells that were *not* liquid — and the first thing it does is
      // return when the cell is not liquid. So every line of the starvation
      // test was unreachable and no flowing water ever drained: plug the spring
      // and the flood stayed exactly where it was, for good, with the active
      // set pinned at a few hundred cells so the sim never went idle either.
      if (this._maybeDry(col, k, edits)) continue;

      // Whatever is in this cell is what spreads out of it. The simulation used
      // to place ID.water unconditionally, so any lava it touched became water.
      const self = this.planet.at(col, k);

      // --- water quenches lava --------------------------------------------
      if (self === ID.lava && this._touchedByWater(col, k)) {
        this._quench(col, k, edits);
        continue;
      }

      // --- fall straight down first; a liquid prefers a hole to a spread ---
      //
      // What lands at the bottom is a FULL cell, whatever the level of the water
      // that went over the lip, and that one word is the whole of the reported
      // bug: "it stops flowing even though it can still go down".
      //
      // It used to carry `here` down with it, which sounds conservative and is
      // in fact a slow death sentence. Measured on a staircase — a source at the
      // top and forty columns of descent below it — water spent a level per
      // sideways step and never got any of it back at a drop, so it ran six
      // columns and stopped, on ground that fell away in front of it for
      // another thirty-four. Every step of a stepped slope was charged as if it
      // were flat. A single cliff showed the same thing in miniature: three
      // columns along the shelf, over the edge, and only three more at the foot
      // of a fall it had every right to arrive at full strength from.
      //
      // A drop is a fall, not a journey: the water at the bottom of one has as
      // much behind it as the water at the top, which is why Minecraft calls a
      // falling cell full and spreads seven from the base of any waterfall. This
      // is that rule. It does not uncap anything — a landed cell is still a
      // `level` entry and not a source, so it still dries the moment its feed is
      // cut, and it still spreads at most six columns before the next fall. The
      // reach of one breach is bounded by six columns per layer of descent, and
      // there are only D layers.
      if (k > 0 && this._canEnter(col, k - 1, LEVEL_MAX, self)) {
        this._place(col, k - 1, LEVEL_MAX, edits, self);
        // a falling column feeds the cell below and stops spreading sideways
        continue;
      }

      // --- a cell in the middle of a fall is still falling, and does not creep -
      //
      // This is the other half of landing full, and without it that change is a
      // flood. Once the shaft under a waterfall has filled, every cell of the
      // column is a full-strength flowing cell that can no longer go down — so
      // each of them starts creeping outward six columns of its own, and a
      // thirty-cell drop becomes a thirty-storey wall of water walking across
      // the floor. Measured before this line went in: a waterfall onto a plain
      // spread to ring 20 instead of the ring 10 the geometry allows, and it got
      // there by feeding the layer below from a fall the layer above had already
      // paid for.
      //
      // Minecraft has a whole separate *state* for this — a falling block, which
      // only ever flows downward — and the state is derivable here rather than
      // stored: liquid above me and liquid below me means I am the middle of a
      // column, not the head or the foot of one. The foot (something solid
      // underneath) is exactly the cell that should spread, and it does, at the
      // full strength it landed with. The head has air above it and spreads
      // normally.
      //
      // Sources are exempt and have to be: a lake is a solid block of them and
      // every interior cell has liquid on both sides, so reading this rule on a
      // source would stop a shoreline from ever flowing anywhere.
      if (!this.sources.has(key)
        && this.planet.at(col, k + 1) === self && this.planet.at(col, k - 1) === self) {
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
        if (this._canEnter(n, k, next, self)) this._place(n, k, next, edits, self);
      }
    }

    if (edits.length) this.applyEdits(edits);
  }

  /** Is any of this cell's six neighbours water? */
  _touchedByWater(col, k) {
    if (this.planet.at(col, k + 1) === ID.water) return true;
    if (k > 0 && this.planet.at(col, k - 1) === ID.water) return true;
    for (let d = 0; d < 4; d++) {
      const n = colNeighbor(col, d);
      if (n >= 0 && this.planet.at(n, k) === ID.water) return true;
    }
    return false;
  }

  /**
   * Lava that water has reached turns to rock.
   *
   * Before this, the two liquids were simply opaque to one another: `_canEnter`
   * refuses to let either enter the other, so a lava sheet and an aquifer met
   * along a line and then sat there, permanently, each one a wall to the other.
   * That is a hole in the world's physics rather than a rule — the one place on
   * the planet where two things touch and nothing at all happens — and it is
   * also the only remaining reason a player would think of lava as scenery.
   *
   * **The rule: the LAVA changes and the water does not.** A lava *source*
   * becomes obsidian, a flowing lava cell becomes cobblestone. That is
   * Minecraft's distinction and it is worth keeping for the reason Minecraft
   * has it: obsidian is the thing you cannot get any other way, so a bucket of
   * water carried down to the mantle is a tool and not just a fire blanket,
   * while a stray splash on a trickle gives you the cheap rock and no windfall.
   *
   * The water surviving is not a courtesy, it is what makes the reaction stop.
   * Consuming the water would leave a hole for the next lava cell to flow into
   * and be quenched in, and a lava lake beside the sea would chew its way
   * through itself one cell per tick. As written, the boundary lava turns to
   * rock, the rock is a wall the water cannot pass, and the reaction is over
   * after one layer however big the two bodies are.
   *
   * Neither product is a liquid, so both bookkeeping marks have to go with it:
   * a `sources` entry left on a cell that is now obsidian is a spring the sim
   * would honour the moment anything cleared that cell again, which is the one
   * failure this file exists to prevent.
   */
  _quench(col, k, edits) {
    const key = this.key(col, k);
    const id = this.sources.has(key) ? ID.obsidian : ID.cobblestone;
    this.sources.delete(key);
    this.level.delete(key);
    this._quenched.add(key);
    edits.push({ col, k, id });
    this.touch(col, k);
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
   *
   * One layer goes per tick, which is what makes it look like draining rather
   * than vanishing: the cells beside the spring lose their feed first, and
   * their neighbours only notice once they are gone.
   *
   * @returns {boolean} true if the cell was emptied, so the caller stops
   *   treating it as something that can still spread.
   */
  _maybeDry(col, k, edits) {
    const key = this.key(col, k);
    // A true source has no level entry at all, and never dries.
    if (this.sources.has(key)) return false;
    if (RENDER_TYPE[this.planet.at(col, k)] !== R_LIQUID) { this.level.delete(key); return false; }

    const mine = this.level.get(key);
    // An orphan (water, no source mark, no level) is swept away with the rest.
    if (mine === undefined) {
      edits.push({ col, k, id: 0 });
      this.touch(col, k);
      return true;
    }

    // Anything with a level entry is *flowing*, however strong. Exempting
    // full-strength cells here made falling water permanent: a waterfall kept
    // running after its source was gone, and every cell it filled behaved like
    // a spring. Only a true source — no entry at all — is exempt, which the
    // early return above already handles.
    // Fed *by its own kind*, and the qualifier is not pedantry. The test used to
    // accept any liquid, so a lava neighbour counted as a feed for a water cell
    // — and lava is very often a source, which reads as level 7 and therefore
    // outranks any flow. A stranded trickle beside a lava lake was immortal:
    // measured, an orphaned water cell next to a lava source was still there
    // after 200 ticks with nothing whatsoever behind it. Nothing that cannot
    // flow into this cell can be what is keeping it full, and `_canEnter`
    // already refuses to let one liquid enter the other.
    const self = this.planet.at(col, k);
    let fed = false;
    if (k + 1 < D && this.planet.at(col, k + 1) === self) fed = true;
    if (!fed) {
      for (let d = 0; d < 4 && !fed; d++) {
        const n = colNeighbor(col, d);
        if (n >= 0 && this.planet.at(n, k) === self && this.levelAt(n, k) > mine) fed = true;
      }
    }
    if (!fed) {
      this.level.delete(key);
      edits.push({ col, k, id: 0 });
      this.touch(col, k);
      return true;
    }
    return false;
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

  /**
   * Only the flowing cells. Sources are deliberately *not* written.
   *
   * They are fully derivable and enormous: a source is any liquid cell with no
   * level entry, which is the whole ocean — a hundred thousand entries against
   * the couple of hundred that are actually moving — and it is exactly the rule
   * the loader's per-region seed pass already applies. So recording which cells
   * flow is the entire content here; everything wet that is not in this list is
   * a spring, including a bucket poured into a hole, whose `addSource` drops its
   * level for precisely that reason.
   */
  toJSON() {
    return { lv: [...this.level].map(([i, v]) => [i, v]) };
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
