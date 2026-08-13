// Whirlpools: the third member of the sink family, and the only one that is
// not a block.
//
// "in water where you got sucked in and it's hard to get out". Quicksand and
// powder snow are ground that stops being ground; this is the same idea in the
// one place there was never any ground to start with — open ocean where the
// surface stops holding you up.
//
// **Nothing here is generated and nothing here is saved.** That is the one
// structural decision in the file and it is worth stating first. A whirlpool
// could have been a bowl carved into the seabed by `WorldGen`, and that is the
// obvious way to build it — but a whirlpool is not made of blocks, it is made
// of water moving, and there is nothing about it a voxel could hold. So the
// sites are a pure function of (seed, column) computed on the main thread, the
// generator writes nothing different, no save carries a byte of it, and the
// GEN_VERSION question that both blocks raise does not arise for this one at
// all. A world opened before this change and after it has the same terrain,
// with whirlpools in it.
//
// The other half of that decision is that it costs nothing to run. `centreNear`
// is the hot-spring lattice trick — see `_springNear` in WorldGen.js — so
// asking "is there one here" is arithmetic rather than a search, and only one
// candidate can ever be in range. What that candidate then costs is one hash
// and a walk down one column, and only on a frame where the player is in water.

import { F, D, R_MIN, R_SEA, cidx } from '../world/Constants.js';
import { colParts } from '../world/Sphere.js';

/**
 * Columns between candidate sites, and the residue a site sits at.
 *
 * The lattice does the same work here that it does for the springs and the
 * lakes: it turns "is there one near this column" into two modulos. It also
 * bounds the answer to ONE candidate, because the spacing is more than twice
 * the radius, which is what makes the whole thing O(1) rather than a search
 * over an ocean.
 *
 * 40 against a radius of 5 is a whirlpool roughly every kilometre and a half of
 * open water. Deliberately sparse: this is a place, not a weather condition,
 * and a sea with one every forty columns would be a minefield rather than an
 * ocean with something in it.
 */
export const WHIRL_LATTICE = 40;
const WHIRL_LI = 13;
const WHIRL_LJ = 29;
/**
 * How wide the funnel is, in columns, measured from the eye.
 *
 * This is the number the escape is proved against and it is small on purpose.
 * Swimming is 2.73 cells/s and the drag below is purely DOWNWARD — it takes
 * nothing off your horizontal speed — so crossing from the dead centre to open
 * water is 5 / 2.73 = 1.83 seconds. Against a nine-second breath that is the
 * whole safety argument, and it holds for a player with no equipment, no
 * skills and no air left when they started swimming.
 */
export const WHIRL_R = 5.0;
/**
 * How likely a lattice site with deep enough water under it actually is one.
 *
 * Under 1 so that a player who has learned where the lattice falls still
 * cannot predict them, which matters more than it sounds — the sites are
 * regular by construction and a regular hazard stops being a place.
 */
const WHIRL_CHANCE = 0.55;
/**
 * Blocks of water a site needs before it is a whirlpool.
 *
 * The only thing tying this to the terrain, and it does two jobs. It keeps
 * whirlpools out to sea, where a player has chosen to be, and off every lake,
 * tarn and plunge basin on the planet — the deepest of those is under half of
 * this. And it means the funnel can never reach the seabed, so there is no case
 * where the drag is holding a body against the floor.
 */
const WHIRL_MIN_DEPTH = 14;
/**
 * The strongest downward drag, at the eye, in cells per second squared.
 *
 * Set against the swim, which is the only number that matters here. Swimming up
 * adds 15/s², buoyancy-adjusted gravity takes 5.72/s², and the water damps at
 * 3.2/s — so a player holding Space with no whirlpool rises at (15 - 5.72)/3.2
 * = 2.9 cells/s.
 *
 * 13 is chosen to sit *past* the 9.28 that would hold them level: at the eye a
 * swimming player still goes down, at (15 - 5.72 - 13)/3.2 = 1.16 cells/s. Half
 * strength — which is where the falloff puts you 3.5 columns out — gives
 * +0.87 up. So the funnel has two zones and the player can feel where the line
 * is: near the rim you can climb out the way you came, and in the middle you
 * cannot, and the only thing that works is swimming sideways.
 *
 * That is the same sentence quicksand and powder snow are built on. **You get
 * out at the edge, never straight up.**
 */
const WHIRL_PULL = 13;
/**
 * How far below the surface the funnel reaches, in layers, and the whole of why
 * this cannot drown a player who does anything at all.
 *
 * A vortex is a surface feature; it has a throat and under the throat there is
 * only sea. The drag fades linearly to nothing at this depth, which bounds the
 * problem in the one direction that could otherwise be unbounded — without it a
 * body that held still would be taken to the seabed twenty-odd layers down, and
 * the swim back would be most of a breath before the horizontal escape had even
 * started.
 *
 * With it, the deepest a swimming player can be pushed is where the drag equals
 * the 9.28 that holds them level: 13 * (1 - d/12) = 9.28, i.e. **3.4 layers**.
 * They cannot surface in the middle, which is the hazard; they are also never
 * more than about a second and a half of swimming from air once they are out of
 * it, which is the promise. A player who holds still and does nothing sinks
 * further and drowns, and that is the one way this kills — by doing nothing,
 * with a breath meter on screen, a churning sound, and a patch of broken water
 * they swam into.
 */
const WHIRL_THROAT = 12;

/** The layer the sea's surface sits in. Matches `kWet1` in the cave carve. */
export const K_SEA = Math.floor(R_SEA - R_MIN - 0.5);
/**
 * How far off a whirlpool is seen and heard, in columns.
 *
 * Nearly four times the funnel's own radius, and that ratio is the point. A
 * hazard you find out about by being inside it is a bug report; this one has to
 * be a thing on the horizon you decide whether to swim towards. Nineteen
 * columns of open water is far enough that a swimmer at 2.73 cells/s has seven
 * seconds of looking at broken water before the drag can touch them.
 *
 * Capped below half the lattice spacing so the O(1) lookup stays sound — see
 * `centreWithin`.
 */
export const WHIRL_CUE = 19;

const _parts = { f: 0, i: 0, j: 0 };

/**
 * A hash of a column and the world seed, on 0..1.
 *
 * The same shape as `WorldGen.colRng`'s mixing and for the same reason: column
 * indices are consecutive, and a weak hash of consecutive integers gives sites
 * in visible diagonal stripes.
 */
function hash01(col, seed) {
  let s = Math.imul(col ^ 0x9e3779b9, 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13) ^ seed ^ 0x5f1c, 0xc2b2ae35);
  s ^= s >>> 16;
  return ((s >>> 0) % 100000) / 100000;
}

export class Whirlpools {
  /**
   * @param {import('../world/Planet.js').Planet} planet
   * @param {number} seed the world seed, so two planets differ
   */
  constructor(planet, seed = 0) {
    this.planet = planet;
    this.seed = seed | 0;
  }

  /** A new world: nothing is remembered between them, so this is a seed swap. */
  reset(seed) { this.seed = seed | 0; }

  /**
   * Is this column the eye of a whirlpool?
   *
   * Deliberately uncached, which is the opposite of what the hot springs do and
   * is right for the opposite reason. `_springCenter` caches because it reads
   * only global tables that are fixed before any voxel exists; this reads the
   * live block mirror, and a column in a region that has not streamed in yet
   * answers "no water at all". Caching that would make a whirlpool that
   * disappears for the rest of the session because the player once looked
   * towards it from far enough away. It is one modulo, one hash and a walk down
   * one column of at most 99 reads, on frames where a body is in water.
   */
  isCentre(col) {
    const p = colParts(col, _parts);
    if (p.i % WHIRL_LATTICE !== WHIRL_LI || p.j % WHIRL_LATTICE !== WHIRL_LJ) return false;
    // Kept whole on one cube face, the same rule the springs and the volcanoes
    // follow: a column across a seam has different face coordinates and would
    // never find this centre on the lattice, so half the funnel would be
    // missing from one side and present from the other.
    const edge = Math.ceil(WHIRL_R) + 1;
    if (p.i < edge || p.i >= F - edge || p.j < edge || p.j >= F - edge) return false;
    if (hash01(col, this.seed) > WHIRL_CHANCE) return false;
    return this.depthAt(col) >= WHIRL_MIN_DEPTH;
  }

  /**
   * Blocks of open sea standing over this column, or 0.
   *
   * Counted down from the sea's own layer rather than from whatever the topmost
   * liquid happens to be, which is what keeps a lake out of this even before
   * the depth test does: a tarn's surface is its own, well above or below
   * K_SEA, so the first read is already not water and the count is 0.
   */
  depthAt(col) {
    const pl = this.planet;
    if (!pl.liquidAt(col, K_SEA)) return 0;
    let n = 0;
    for (let k = K_SEA; k >= 0 && pl.liquidAt(col, k); k--) n++;
    return n;
  }

  /**
   * The eye covering this column, or -1.
   *
   * O(1): the lattice spacing is more than twice the radius, so at most one
   * congruent column is within reach on each axis. Straight out of
   * `WorldGen._springNear`, which is the same problem.
   */
  centreNear(col) { return this.centreWithin(col, WHIRL_R); }

  /**
   * The eye within `range` columns of this one, or -1.
   *
   * The range is a parameter because the two callers want different answers to
   * the same question. The drag wants WHIRL_R, which is where the funnel is;
   * the churn and the broken water want to reach much further, because the
   * whole of the legibility argument is that you see and hear one BEFORE you
   * swim into it.
   *
   * Still O(1) as long as `range` stays under half the lattice spacing, which
   * is the condition for at most one congruent column being in reach on each
   * axis. Beyond that this would silently return the nearer of two sites and
   * miss the other, so the caller's range is capped rather than trusted.
   */
  centreWithin(col, range) {
    const r = Math.min(range, WHIRL_LATTICE * 0.5 - 1);
    const p = colParts(col, _parts);
    const pi = p.i, pj = p.j, pf = p.f;
    const ri = ((pi - WHIRL_LI) % WHIRL_LATTICE + WHIRL_LATTICE) % WHIRL_LATTICE;
    const i0 = ri <= r ? pi - ri
      : (WHIRL_LATTICE - ri <= r ? pi + (WHIRL_LATTICE - ri) : -1);
    if (i0 < 0 || i0 >= F) return -1;
    const rj = ((pj - WHIRL_LJ) % WHIRL_LATTICE + WHIRL_LATTICE) % WHIRL_LATTICE;
    const j0 = rj <= r ? pj - rj
      : (WHIRL_LATTICE - rj <= r ? pj + (WHIRL_LATTICE - rj) : -1);
    if (j0 < 0 || j0 >= F) return -1;
    if (Math.hypot(pi - i0, pj - j0) > r) return -1;
    const c = cidx(pf, i0, j0);
    return this.isCentre(c) ? c : -1;
  }

  /**
   * How hard the water is pulling a body down here, in cells/s², and 0 almost
   * everywhere.
   *
   * Two falloffs multiplied, and they answer different questions. Across the
   * disc it is `1 - (d/R)²`, which is flat-topped near the eye and steep at the
   * rim: the middle should feel like one place rather than like a single lethal
   * column, and the edge should be a line you can feel yourself crossing.
   * Downward it is linear to nothing at the throat, which is what bounds how
   * deep a body can be taken — see WHIRL_THROAT.
   *
   * @param {number} col the column the body is in
   * @param {number} k its layer
   */
  pullAt(col, k) {
    const c = this.centreNear(col);
    if (c < 0) return 0;
    const a = colParts(col, _parts);
    const ai = a.i, aj = a.j;
    const b = colParts(c, _parts);
    const d2 = (ai - b.i) * (ai - b.i) + (aj - b.j) * (aj - b.j);
    const r2 = WHIRL_R * WHIRL_R;
    if (d2 >= r2) return 0;
    const below = K_SEA - k;
    if (below >= WHIRL_THROAT) return 0;
    const radial = 1 - d2 / r2;
    const depth = below <= 0 ? 1 : 1 - below / WHIRL_THROAT;
    return WHIRL_PULL * radial * depth;
  }
}
