// A test harness for driving the running game from the console.
//
// Nothing imports this, so it never reaches the bundle; load it on demand with
//   const H = (await import('/src/dev/Harness.js')).harness(window.game)
//
// It exists because measuring this game by hand kept producing confident,
// wrong answers. Every one of these was reported as a game bug before the
// probe turned out to be at fault:
//
//   - "harvesting wheat yields nothing" — the drops were on the ground two
//     cells away, outside the 1.85 pickup radius, and the probe read the
//     inventory.
//   - "the day cycle has frozen" — the player had died and the world stops
//     behind the death overlay; the probe restored `health` but never checked
//     `state`.
//   - "husks no longer chase" — the probe asked the spawner for a spot and got
//     one 48.5 cells away, well outside the 34-cell aggro range.
//
// The shape is always the same: the harness is broken in a way that looks like
// the game. So every helper here asserts its own preconditions and throws
// rather than returning a number that reads as a finding.

import { ITEMS, itemIdOf } from '../game/Items.js';
import { colParts, stepColumn, cellCenterPos, colNeighbor } from '../world/Sphere.js';
import { ID } from '../world/Blocks.js';
import { F } from '../world/Constants.js';

class HarnessError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function harness(game) {
  if (!game) throw new HarnessError('no game — pass window.game');
  return new Harness(game);
}

class Harness {
  constructor(game) {
    this.g = game;
  }

  // --- preconditions --------------------------------------------------------

  /** The column the player is standing in. */
  get baseCol() {
    const c = this.g.player.cell;
    return ((c.f * F + Math.floor(c.ci)) * F) + Math.floor(c.cj);
  }

  /** Ground level under a column. */
  surfaceOf(col = this.baseCol) {
    return this.g.planet.surfaceK(col);
  }

  /**
   * Check the column adjacency graph over the whole planet.
   *
   * This is not a sampled observation — it is every one of the 259,584 columns,
   * and it takes about a second. Worth running after anything that touches
   * Sphere.js, because the failures it catches are invisible in play: a body's
   * nine-sample footprint quietly sampling eight cells reads as "the collision
   * is a bit sticky near that ridge", if it is noticed at all.
   *
   * `cornersCollapsed` is expected to be non-zero and small. Only three cells
   * meet at each of the cube's eight corners, so the fourth diagonal genuinely
   * does not exist there and no implementation can conjure one.
   */
  topology() {
    const N = 6 * F * F;
    const r = { columns: N, notReciprocal: 0, duplicateNeighbours: 0, outOfRange: 0,
                footprintCollapsed: 0, cornersCollapsed: 0, offEdge: [] };
    for (let col = 0; col < N; col++) {
      const nb = [colNeighbor(col, 0), colNeighbor(col, 1), colNeighbor(col, 2), colNeighbor(col, 3)];
      if (nb.some((n) => n < 0 || n >= N)) r.outOfRange++;
      if (new Set(nb).size !== 4) r.duplicateNeighbours++;
      for (const n of nb) {
        if (n < 0 || n >= N) continue;
        const back = [colNeighbor(n, 0), colNeighbor(n, 1), colNeighbor(n, 2), colNeighbor(n, 3)];
        if (!back.includes(col)) r.notReciprocal++;
      }
      const nine = new Set();
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) nine.add(stepColumn(col, di, dj));
      if (nine.size === 9) continue;
      r.footprintCollapsed++;
      const p = colParts(col);
      const atCorner = (p.i === 0 || p.i === F - 1) && (p.j === 0 || p.j === F - 1);
      if (atCorner) r.cornersCollapsed++;
      else if (r.offEdge.length < 8) r.offEdge.push(`f${p.f} ${p.i},${p.j}`);
    }
    r.clean = r.notReciprocal === 0 && r.duplicateNeighbours === 0 && r.outOfRange === 0
      && r.footprintCollapsed === r.cornersCollapsed;
    return r;
  }

  /**
   * Get back into a playing state, or refuse to continue.
   *
   * The death overlay pauses everything, so a timed observation taken while
   * dead returns a flat line that looks exactly like "nothing happened".
   */
  async alive() {
    const g = this.g;
    if (g.state !== 'playing') {
      document.getElementById('dz-respawn')?.click();
      await sleep(3500);
    }
    if (g.state !== 'playing') {
      throw new HarnessError(`world is "${g.state}", not playing — cannot measure`);
    }
    g.player.health = g.player.maxHealth;
    g._hurtGuard = 0;
    return this;
  }

  /** Prove the simulation is actually running before trusting any timing. */
  async ticking(ms = 900) {
    const g = this.g;
    let calls = 0;
    const orig = g.mobs.update.bind(g.mobs);
    g.mobs.update = (dt, p, sky) => { calls++; return orig(dt, p, sky); };
    await sleep(ms);
    g.mobs.update = orig;
    if (calls === 0) {
      throw new HarnessError(`no mob ticks in ${ms}ms — the world is frozen (state "${g.state}")`);
    }
    return calls;
  }

  /**
   * Cheap mid-loop guard. `watch` checks this for you; a hand-rolled sweep has
   * to call it, because a player who dies halfway through turns every reading
   * after that point into a flat line taken from a stopped world — which is
   * exactly how "the day cycle froze" got reported as a bug.
   */
  check(what = 'measurement') {
    if (this.g.state !== 'playing') {
      throw new HarnessError(`${what} invalidated — world became "${this.g.state}" partway through`);
    }
    return this;
  }

  /**
   * Sleep, keeping the player alive and the clock pinned. For sweeps that care
   * about the world running but not about the player's survival.
   */
  async idle(ms, { survive = true } = {}) {
    const step = 250;
    for (let t = 0; t < ms; t += step) {
      await sleep(Math.min(step, ms - t));
      this._pin();
      if (survive) {
        this.g.player.health = this.g.player.maxHealth;
        this.g._hurtGuard = 0;
      } else {
        this.check('idle');
      }
    }
    return this;
  }

  /** Hold the clock at night (or day) for the duration of a measurement. */
  night(on = true) {
    this._pinDay = on ? 0 : 0.5;
    return this;
  }

  _pin() {
    if (this._pinDay !== undefined) this.g.dayT = this._pinDay;
  }

  // --- arranging the world --------------------------------------------------

  /**
   * A flat, walled-off arena centred on the player, so a measurement is not at
   * the mercy of whatever hillside they happened to spawn on.
   */
  async arena(radius = 8, { floor = ID.grass, clearHeight = 5 } = {}) {
    const g = this.g;
    const base = this.baseCol;
    const k = this.surfaceOf(base);
    const edits = [];
    for (let di = -radius; di <= radius; di++) {
      for (let dj = -radius; dj <= radius; dj++) {
        const col = stepColumn(base, di, dj);
        edits.push({ col, k, id: floor });
        for (let dk = 1; dk <= clearHeight; dk++) edits.push({ col, k: k + dk, id: 0 });
      }
    }
    g._applyEdits(edits);
    await sleep(900);
    const parts = colParts(base);
    const p = g.player;
    p.cell.f = parts.f; p.cell.ci = parts.i + 0.5; p.cell.cj = parts.j + 0.5;
    p.cell.ck = k + 1.05;
    p.vel.i = 0; p.vel.j = 0; p.vel.k = 0;
    p._sync();
    await sleep(400);
    return { col: base, k };
  }

  /** Remove every hostile, so a count starts from a known zero. */
  async clearHostiles() {
    for (const m of [...this.g.mobs.list]) {
      if (m.spec.hostile) this.g.mobs._die(m, []);
    }
    await sleep(500);
    return this;
  }

  /**
   * Put a mob a chosen distance from the player and *prove* it landed there.
   *
   * `spawn` returns null for ground it does not like, and a spot chosen from
   * the game's own spawner can be far outside aggro range. Either way you get
   * a mob that was never going to do the thing you are about to measure.
   */
  async spawnAt(type, cells, { dj = 0, requireAggro = true } = {}) {
    const g = this.g;
    const base = this.baseCol;
    const k = this.surfaceOf(base);
    let mob = null;
    for (let n = 0; n < 12 && !mob; n++) {
      mob = g.mobs.spawn(type, stepColumn(base, cells, dj + (n % 3) - 1), k);
    }
    if (!mob) throw new HarnessError(`could not place a ${type} ${cells} cells out`);
    await sleep(400);
    const d = mob.pos.distanceTo(g.player.position);
    const range = mob.spec.aggroRange ?? Infinity;
    if (requireAggro && mob.spec.hostile && d > range) {
      throw new HarnessError(
        `${type} landed ${d.toFixed(1)} away but only notices you within ${range} — it will never approach`,
      );
    }
    return mob;
  }

  // --- reading the world ----------------------------------------------------

  /**
   * How many of an item the player has *earned*, counting both the inventory
   * and anything still lying within pickup range.
   *
   * Reading the inventory alone is how "farming produces nothing" happened:
   * the wheat was on the ground the whole time.
   */
  itemsWon(name, { radius = 6 } = {}) {
    const g = this.g;
    const id = typeof name === 'number' ? name : itemIdOf(name);
    if (!id) throw new HarnessError(`no such item: ${name}`);
    let n = g.inventory.count(id);
    for (const d of g.drops.list) {
      if (d.item !== id) continue;
      if (d.pos.distanceTo(g.player.position) <= radius) n += d.count;
    }
    return n;
  }

  hostiles() {
    return this.g.mobs.list.filter((m) => m.spec.hostile && m.dying <= 0);
  }

  /** Distance to the nearest hostile, or null if there are none. */
  nearestHostile() {
    const p = this.g.player.position;
    let best = null;
    for (const m of this.hostiles()) {
      const d = m.pos.distanceTo(p);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  /**
   * Sample the world for a while, aborting the moment it stops being a valid
   * measurement rather than returning a flat line.
   *
   * @param {object} opts
   * @param {number} opts.seconds how long to watch
   * @param {number} opts.every sample period, ms
   * @param {boolean} opts.survive keep the player alive (for population tests)
   * @param {(h: Harness) => object} opts.sample what to record each tick
   */
  async watch({ seconds = 30, every = 500, survive = false, sample = null } = {}) {
    const g = this.g;
    await this.ticking(600);
    const rows = [];
    const startHp = g.player.health;
    let hits = 0, last = g.player.health;
    let ended = 'completed';
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await sleep(every);
      this._pin();
      if (survive) {
        g.player.health = g.player.maxHealth;
        g._hurtGuard = 0;
      } else if (g.state !== 'playing') { ended = 'player died'; break; }
      if (g.player.health < last) hits++;
      last = g.player.health;
      if (sample) rows.push({ t: +((Date.now() - t0) / 1000).toFixed(1), ...sample(this) });
    }
    return {
      ended,
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      hits,
      hpLost: survive ? null : +(startHp - Math.max(0, g.player.health)).toFixed(1),
      alive: g.state === 'playing',
      rows,
    };
  }

  /** Frame timing over a window, for anything that might cost performance. */
  async frames(seconds = 6) {
    const out = [];
    let last = performance.now(), stop = false;
    const loop = () => {
      const now = performance.now();
      out.push(now - last); last = now;
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) { await sleep(200); this._pin(); }
    stop = true;
    out.shift();
    const s = [...out].sort((a, b) => a - b);
    const at = (q) => +s[Math.floor(s.length * q)].toFixed(1);
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99),
      worst: +s[s.length - 1].toFixed(1), over33: out.filter((f) => f > 33).length };
  }
}

export { HarnessError };
